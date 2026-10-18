// dense.js — Reconstrucción densa propia: un mapa de profundidad para CADA píxel (plane sweep + ZNCC).
// Con la pose relativa (R, t) entre la referencia y el fotograma actual, para cada píxel de la
// referencia se prueban muchas profundidades; se proyecta en la imagen actual y se compara la
// ventana de alrededor con correlación cruzada normalizada (ZNCC). Gana la profundidad que mejor calza.

export const VERSION = '5';

// Reduce un ImageData por un factor entero (promedio). Devuelve {gray, rgb, w, h}
function shrink(img, f) {
  const W = img.width, H = img.height, w = Math.floor(W / f), h = Math.floor(H / f), d = img.data;
  const rgb = new Uint8ClampedArray(w * h * 3), gray = new Float32Array(w * h), n = f * f;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let v = 0; v < f; v++) for (let u = 0; u < f; u++) {
      const o = ((y * f + v) * W + x * f + u) * 4;
      r += d[o]; g += d[o + 1]; b += d[o + 2];
    }
    const k = y * w + x;
    rgb[3 * k] = r / n; rgb[3 * k + 1] = g / n; rgb[3 * k + 2] = b / n;
    gray[k] = (0.299 * r + 0.587 * g + 0.114 * b) / n;
  }
  return { gray, rgb, w, h };
}

// Suma en ventana (2r+1)² con filtro de caja separable. tmp: buffer auxiliar del mismo tamaño.
function boxSum(src, w, h, r, out, tmp) {
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/*
 * refImg, curImg: ImageData a resolución de trabajo. R, t: X_cur = R·X_ref + t (cámara de referencia).
 * f, cx, cy: intrínsecos a resolución de trabajo. depthRange: [dmin, dmax] de los puntos triangulados.
 * opts: {factor (reducción, 3), steps (profundidades a probar, 64), r (radio de ventana, 3),
 *        minZncc (0.55), minStd (desv. mínima de textura, 3), roi {x,y,w,h} en px de trabajo, clean (bool)}
 * Devuelve {w, h, f, cx, cy, depth: Float32Array (0 = sin dato), rgb, valid}
 */
export function denseDepth(refImg, curImg, R, t, f, cx, cy, depthRange, opts = {}) {
  const F = opts.factor || 3, steps = opts.steps || 64, r = opts.r || 3;
  const minZncc = opts.minZncc ?? 0.55, minStd = opts.minStd ?? 3;
  const A = shrink(refImg, F), B = shrink(curImg, F);
  const w = A.w, h = A.h, N = w * h, n = (2 * r + 1) * (2 * r + 1);
  const fl = f / F, cxl = cx / F, cyl = cy / F;

  // Zona válida (recuadro del objeto)
  const inRoi = new Uint8Array(N).fill(1);
  if (opts.roi) {
    inRoi.fill(0);
    const x0 = Math.max(0, Math.floor(opts.roi.x / F)), y0 = Math.max(0, Math.floor(opts.roi.y / F));
    const x1 = Math.min(w, Math.ceil((opts.roi.x + opts.roi.w) / F)), y1 = Math.min(h, Math.ceil((opts.roi.y + opts.roi.h) / F));
    for (let y = y0; y < y1; y++) inRoi.fill(1, y * w + x0, y * w + x1);
  }

  // Estadísticas de la ventana en la referencia
  const I = A.gray, I2 = new Float32Array(N);
  for (let i = 0; i < N; i++) I2[i] = I[i] * I[i];
  const tmp = new Float32Array(N), Si = new Float32Array(N), Sii = new Float32Array(N);
  boxSum(I, w, h, r, Si, tmp);
  boxSum(I2, w, h, r, Sii, tmp);
  const varI = new Float32Array(N);
  for (let i = 0; i < N; i++) varI[i] = Math.max(0, Sii[i] - Si[i] * Si[i] / n);

  // Rayos de la cámara de referencia rotados: R·K⁻¹·[u,v,1]
  const rx = new Float32Array(N), ry = new Float32Array(N), rz = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (x - cxl) / fl, b = (y - cyl) / fl, i = y * w + x;
    rx[i] = R[0] * a + R[1] * b + R[2];
    ry[i] = R[3] * a + R[4] * b + R[5];
    rz[i] = R[6] * a + R[7] * b + R[8];
  }

  // Profundidades a probar, uniformes en profundidad inversa
  const dmin = Math.max(1e-3, depthRange[0] * 0.6), dmax = depthRange[1] * 1.6;
  const invA = 1 / dmax, invB = 1 / dmin;
  const invs = new Float32Array(steps);
  for (let s = 0; s < steps; s++) invs[s] = invA + (invB - invA) * s / (steps - 1);

  const best = new Float32Array(N).fill(-2), bestS = new Int32Array(N).fill(-1);
  const seen = new Uint16Array(N);   // en cuántas profundidades el píxel es visible en la otra imagen
  const scores = new Float32Array(N * steps);
  const Wd = new Float32Array(N), Vd = new Float32Array(N), WI = new Float32Array(N), W2 = new Float32Array(N);
  const Sw = new Float32Array(N), Sww = new Float32Array(N), Siw = new Float32Array(N), Sv = new Float32Array(N);
  const Bg = B.gray;

  for (let s = 0; s < steps; s++) {
    const d = 1 / invs[s];
    // Imagen actual "deformada" hacia la referencia para esta profundidad
    for (let i = 0; i < N; i++) {
      const X = d * rx[i] + t[0], Y = d * ry[i] + t[1], Z = d * rz[i] + t[2];
      let ok = 0, val = 0;
      if (Z > 1e-6) {
        const u = fl * X / Z + cxl, v = fl * Y / Z + cyl;
        if (u >= 0 && v >= 0 && u < w - 1 && v < h - 1) {
          const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0, k = y0 * w + x0;
          val = (Bg[k] * (1 - ax) + Bg[k + 1] * ax) * (1 - ay) + (Bg[k + w] * (1 - ax) + Bg[k + w + 1] * ax) * ay;
          ok = 1;
        }
      }
      Wd[i] = val; Vd[i] = ok; WI[i] = val * I[i]; W2[i] = val * val;
    }
    boxSum(Wd, w, h, r, Sw, tmp);
    boxSum(W2, w, h, r, Sww, tmp);
    boxSum(WI, w, h, r, Siw, tmp);
    boxSum(Vd, w, h, r, Sv, tmp);
    const base = s * N;
    for (let i = 0; i < N; i++) {
      let z = -1;
      if (Sv[i] >= n - 0.5) {
        const vw = Sww[i] - Sw[i] * Sw[i] / n;
        const cov = Siw[i] - Si[i] * Sw[i] / n;
        const den = Math.sqrt(varI[i] * vw);
        if (den > 1e-6) z = cov / den;
      }
      scores[base + i] = z;
      if (z > -1) seen[i]++;
      if (z > best[i]) { best[i] = z; bestS[i] = s; }
    }
  }

  // Profundidad con ajuste subpíxel (parábola) y filtros de confianza
  const depth = new Float32Array(N), valid = new Uint8Array(N);
  const minVar = minStd * minStd * n;
  for (let i = 0; i < N; i++) {
    const s = bestS[i];
    // Se descartan píxeles que la otra vista no ve bien (bordes, zonas tapadas) o sin textura
    if (!inRoi[i] || s <= 0 || s >= steps - 1 || best[i] < minZncc || varI[i] < minVar || seen[i] < 0.8 * steps) continue;
    const a = scores[(s - 1) * N + i], b = scores[s * N + i], c = scores[(s + 1) * N + i];
    const den = a - 2 * b + c;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    const inv = invs[s] + off * (invs[1] - invs[0]);
    depth[i] = 1 / inv;
    valid[i] = 1;
  }

  // Quita manchas: cada píxel debe parecerse a la mediana de sus vecinos válidos
  const clean = new Float32Array(N);
  const nb = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!valid[i]) continue;
    nb.length = 0;
    for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) { const j = i + v * w + u; if (valid[j]) nb.push(depth[j]); }
    if (nb.length < 5) continue;
    nb.sort((p, q) => p - q);
    const med = nb[nb.length >> 1];
    if (Math.abs(depth[i] - med) < 0.04 * med) clean[i] = med;
  }

  // Limpiar fondo: el objeto es lo que está en el recuadro (o, sin recuadro, en el centro de la imagen).
  // Se toma la profundidad típica de esa zona y se descarta lo que esté mucho más cerca o más lejos.
  if (opts.clean) {
    const ds = [];
    let zx0 = Math.floor(w * 0.35), zx1 = Math.ceil(w * 0.65), zy0 = Math.floor(h * 0.35), zy1 = Math.ceil(h * 0.65);
    if (opts.roi) {
      const rx0 = opts.roi.x / F, ry0 = opts.roi.y / F, rw = opts.roi.w / F, rh = opts.roi.h / F;
      zx0 = Math.floor(rx0 + rw * 0.3); zx1 = Math.ceil(rx0 + rw * 0.7);
      zy0 = Math.floor(ry0 + rh * 0.3); zy1 = Math.ceil(ry0 + rh * 0.7);
    }
    for (let y = Math.max(0, zy0); y < Math.min(h, zy1); y++)
      for (let x = Math.max(0, zx0); x < Math.min(w, zx1); x++) { const d = clean[y * w + x]; if (d > 0) ds.push(d); }
    if (ds.length > 20) {
      ds.sort((p, q) => p - q);
      const med = ds[ds.length >> 1];
      for (let i = 0; i < N; i++) if (clean[i] > 0 && Math.abs(clean[i] - med) > 0.35 * med) clean[i] = 0;
    }
  }

  let count = 0;
  for (let i = 0; i < N; i++) if (clean[i] > 0) count++;
  return { w, h, f: fl, cx: cxl, cy: cyl, depth: clean, rgb: A.rgb, count };
}

// Convierte el mapa de profundidad en la nube del visor: [x,y,z,w,r,g,b,tamaño] normalizada
// (centro en la mediana, distancia mediana = 1). Cada punto lleva el tamaño de su píxel para cubrir la superficie.
export function depthToCloud(dm) {
  const pts = [];
  const { w, h, f, cx, cy, depth, rgb } = dm;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = depth[i];
    if (!(d > 0)) continue;
    pts.push([d * (x - cx) / f, -d * (y - cy) / f, -d, i, d]);
  }
  if (pts.length < 30) return null;
  const med = arr => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const mx = med(pts.map(p => p[0])), my = med(pts.map(p => p[1])), mz = med(pts.map(p => p[2]));
  const md = med(pts.map(p => Math.hypot(p[0] - mx, p[1] - my, p[2] - mz))) || 1;
  return pts.map(p => {
    const i = p[3], r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return [(p[0] - mx) / md, (p[1] - my) / md, (p[2] - mz) / md, (L - 0.5) * 2, r, g, b, 1.25 * p[4] / f / md];
  });
}
