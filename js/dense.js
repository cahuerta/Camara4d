// dense.js — Reconstrucción densa propia: un mapa de profundidad para CADA píxel (plane sweep + ZNCC).
// Con la pose relativa (R, t) entre la referencia y el fotograma actual, para cada píxel de la
// referencia se prueban muchas profundidades; se proyecta en la imagen actual y se compara la
// ventana de alrededor con correlación cruzada normalizada (ZNCC). Gana la profundidad que mejor calza.

export const VERSION = '8';

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
  const bg = new Uint8Array(N);   // píxeles descartados como fondo
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
      for (let i = 0; i < N; i++) if (clean[i] > 0 && Math.abs(clean[i] - med) > 0.35 * med) { clean[i] = 0; bg[i] = 1; }
    }
  }

  let count = 0;
  for (let i = 0; i < N; i++) if (clean[i] > 0) count++;
  return { w, h, f: fl, cx: cxl, cy: cyl, depth: clean, bg, rgb: A.rgb, count };
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

/*
* Acumulador: suma muchos mapas de profundidad en la vista de la PRIMERA referencia (K0).
 * Cada mapa nuevo viene de otra pareja de vistas, con su propia escala; se lleva a la vista K0
 * con la pose acumulada y se ajusta su escala para que coincida con lo ya medido.
 */
export class Accumulator {
  constructor(refImg, factor = 3, opts = {}) {
    const A = shrink(refImg, factor);
    this.F = factor;
    this.w = A.w; this.h = A.h; this.rgb = A.rgb; this.gray = A.gray;
    const N = this.w * this.h;
    this.sum = new Float32Array(N);      // suma de profundidades
    this.sum2 = new Float32Array(N);     // suma de cuadrados (para medir cuánto varía cada píxel)
    this.cnt = new Uint16Array(N);       // cuántas veces se midió cada píxel
    this.bg = new Uint16Array(N);        // cuántas veces se marcó como fondo
    this.fusions = 0;
    this.scale = 0;                      // escala del último mapa fusionado
    // Zona del objeto (recuadro, o el centro si no hay) y píxeles con textura suficiente
    const r = opts.roi ? {
      x0: opts.roi.x / factor, y0: opts.roi.y / factor, x1: (opts.roi.x + opts.roi.w) / factor, y1: (opts.roi.y + opts.roi.h) / factor
    } : { x0: this.w * 0.2, y0: this.h * 0.2, x1: this.w * 0.8, y1: this.h * 0.8 };
    // Centro de la zona del objeto (para limpiar el fondo del modelo)
    this.zc = { x0: r.x0 + (r.x1 - r.x0) * 0.3, x1: r.x0 + (r.x1 - r.x0) * 0.7, y0: r.y0 + (r.y1 - r.y0) * 0.3, y1: r.y0 + (r.y1 - r.y0) * 0.7 };
    if (!opts.roi) this.zc = { x0: this.w * 0.35, x1: this.w * 0.65, y0: this.h * 0.35, y1: this.h * 0.65 };
    this.zone = new Uint8Array(N);
    const rad = 3, n = (2 * rad + 1) ** 2, g = A.gray, minVar = 9 * n;
    for (let y = rad; y < this.h - rad; y++) for (let x = rad; x < this.w - rad; x++) {
      if (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1) continue;
      let s1 = 0, s2 = 0;
      for (let v = -rad; v <= rad; v++) for (let u = -rad; u <= rad; u++) { const q = g[(y + v) * this.w + x + u]; s1 += q; s2 += q * q; }
      if (s2 - s1 * s1 / n >= minVar) this.zone[y * this.w + x] = 1;
    }
  }

  mean(i) { return this.cnt[i] ? this.sum[i] / this.cnt[i] : 0; }

  // Lleva un mapa de profundidad (vista de la referencia actual) a la vista K0 con escala lam.
  // Pose de la referencia actual respecto de K0: X_ref = R0·X0 + t0 (unidades del acumulador).
  _warp(dm, R0, t0, lam) {
    const W = this.w, H = this.h, N = W * H, zbuf = new Float32Array(N), bgw = new Uint8Array(N), gsrc = new Float32Array(N);
    const fx = dm.f, cx = dm.cx, cy = dm.cy;
    for (let y = 0; y < dm.h; y++) for (let x = 0; x < dm.w; x++) {
      const i = y * dm.w + x, d = dm.depth[i], isBg = dm.bg[i];
      if (!(d > 0) && !isBg) continue;
      if (isBg) {
        // el fondo no tiene profundidad útil: se proyecta como si estuviera a la profundidad media
        if (!this.scale) continue;
      }
      const dd = (d > 0 ? d : 1 / lam) * lam;
      const Xr = [dd * (x - cx) / fx, dd * (y - cy) / fx, dd];
      const q = [Xr[0] - t0[0], Xr[1] - t0[1], Xr[2] - t0[2]];
      const X0 = [R0[0] * q[0] + R0[3] * q[1] + R0[6] * q[2], R0[1] * q[0] + R0[4] * q[1] + R0[7] * q[2], R0[2] * q[0] + R0[5] * q[1] + R0[8] * q[2]];
      if (X0[2] <= 1e-6) continue;
      const u = Math.round(fx * X0[0] / X0[2] + cx), v = Math.round(fx * X0[1] / X0[2] + cy);
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      const k = v * W + u;
      if (isBg && !(d > 0)) { bgw[k] = 1; continue; }
      if (!zbuf[k] || X0[2] < zbuf[k]) {
        zbuf[k] = X0[2];
        const c = 3 * i;
        gsrc[k] = 0.299 * dm.rgb[c] + 0.587 * dm.rgb[c + 1] + 0.114 * dm.rgb[c + 2];
      }
    }
    // Verificación de color: si el color que trae la medición no coincide con lo que se ve en K0
    // en ese píxel, la medición cayó en otro lugar (por ejemplo, el borde del objeto sobre el fondo) y se descarta
    for (let k = 0; k < N; k++) if (zbuf[k] > 0 && Math.abs(gsrc[k] - this.gray[k]) > 28) zbuf[k] = 0;
    return { zbuf, bgw };
  }

  // Suma un mapa. Devuelve false si no calza con lo ya medido.
  fuse(dm, R0, t0) {
    const N = this.w * this.h;
    let lam;
    if (!this.fusions) {
      // Primer mapa: define la escala (profundidad mediana = 1)
      const ds = [];
      for (let i = 0; i < dm.depth.length; i++) if (dm.depth[i] > 0) ds.push(dm.depth[i]);
      if (ds.length < 30) return false;
      ds.sort((a, b) => a - b);
      lam = 1 / ds[ds.length >> 1];
    } else {
      // Ajuste de escala: el mapa nuevo debe coincidir con lo ya medido donde se superponen
      lam = this.scale;
      for (let it = 0; it < 4; it++) {
        const { zbuf } = this._warp(dm, R0, t0, lam), ratios = [];
        for (let i = 0; i < N; i++) if (zbuf[i] > 0 && this.cnt[i]) ratios.push(this.mean(i) / zbuf[i]);
        if (ratios.length < 40) return false;
        ratios.sort((a, b) => a - b);
        const r = ratios[ratios.length >> 1];
        lam *= r;
        if (Math.abs(r - 1) < 0.002) break;
      }
    }
    const { zbuf, bgw } = this._warp(dm, R0, t0, lam);
    // Control de coherencia: donde se superpone con lo ya medido, la mayoría debe coincidir.
    // Si no, la pose de esta medición está mal (por ejemplo, un movimiento brusco) y se descarta entera.
    if (this.fusions) {
      let over = 0, agree = 0;
      for (let i = 0; i < N; i++) {
        if (!(zbuf[i] > 0) || !this.cnt[i]) continue;
        over++;
        if (Math.abs(zbuf[i] - this.mean(i)) < 0.08 * this.mean(i)) agree++;
      }
      if (over >= 40 && agree < 0.5 * over) return false;
    }
    let added = 0;
    for (let i = 0; i < N; i++) {
      if (bgw[i]) this.bg[i]++;
      const z = zbuf[i];
      if (!(z > 0)) continue;
      if (this.cnt[i] >= 2 && Math.abs(z - this.mean(i)) > 0.08 * this.mean(i)) continue;   // medición discordante
      this.sum[i] += z; this.sum2[i] += z * z; this.cnt[i]++; added++;
    }
    if (added < 20) return false;
    this.scale = lam;
    this.fusions++;
    return true;
  }

  // Cobertura: porcentaje de los píxeles con textura de la zona del objeto que ya se midieron 2+ veces
  coverage() {
    let tot = 0, ok = 0;
    for (let i = 0; i < this.zone.length; i++) {
      if (!this.zone[i]) continue;
      if (this.bg[i] > this.cnt[i]) continue;   // es fondo: no cuenta
      tot++;
      if (this.cnt[i] >= 2) ok++;
    }
    return tot ? ok / tot : 0;
  }

  // Mapa de profundidad para mostrar (vista K0). final=true: rellena huecos chicos y suaviza.
  // Solo se muestra lo confirmado: medido 2+ veces (3+ cuando ya hay 6 mediciones) y que no varíe mucho
  // entre mediciones (más de 3 %: es un píxel dudoso). Al comienzo, con menos de 3 mediciones, se muestra todo.
  depthMap(final = false, clean = false) {
    const W = this.w, H = this.h, N = W * H;
    const minCnt = this.fusions >= 6 ? 3 : final || this.fusions >= 3 ? 2 : 1;
    let d = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = this.cnt[i];
      if (c < minCnt) continue;
      const m = this.sum[i] / c;
      if (c >= 2) {
        const sd = Math.sqrt(Math.max(0, this.sum2[i] / c - m * m));
        if (sd > 0.03 * m) continue;
      }
      d[i] = m;
    }
    if (clean) {
      // Limpiar fondo sobre el modelo: profundidad típica de la zona del objeto (recuadro o centro) ± 35 %
      const ds = [];
      for (let y = Math.floor(this.zc.y0); y < this.zc.y1; y++) for (let x = Math.floor(this.zc.x0); x < this.zc.x1; x++) {
        const q = d[y * W + x]; if (q > 0) ds.push(q);
      }
      if (ds.length > 20) {
        ds.sort((a, b) => a - b);
        const med = ds[ds.length >> 1];
        for (let i = 0; i < N; i++) if (d[i] > 0 && Math.abs(d[i] - med) > 0.35 * med) d[i] = 0;
      }
    }
    // Quitar píxeles sueltos (menos de 3 vecinos con dato)
    {
      const out = d.slice();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!(d[i] > 0)) continue;
        let n = 0;
        for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
          const yy = y + v, xx = x + u;
          if ((u || v) && yy >= 0 && xx >= 0 && yy < H && xx < W && d[yy * W + xx] > 0) n++;
        }
        if (n < 3) out[i] = 0;
      }
      d = out;
    }
    if (clean) {
      // Continuidad: solo se conservan las zonas de superficie conectadas (sin saltos de profundidad)
      // que sean grandes respecto de la principal; las islas sueltas se descartan
      const lab = new Int32Array(N).fill(-1), sizes = [];
      for (let s0 = 0; s0 < N; s0++) {
        if (!(d[s0] > 0) || lab[s0] >= 0) continue;
        const id = sizes.length, st = [s0];
        lab[s0] = id;
        let n = 0;
        while (st.length) {
          const i = st.pop(), x = i % W, y = (i - x) / W;
          n++;
          for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
            const xx = x + u, yy = y + v;
            if ((!u && !v) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (lab[j] < 0 && d[j] > 0 && Math.abs(d[j] - d[i]) < 0.08 * d[i]) { lab[j] = id; st.push(j); }
          }
        }
        sizes.push(n);
      }
      const big = Math.max(0, ...sizes);
      for (let i = 0; i < N; i++) if (d[i] > 0 && sizes[lab[i]] < 0.12 * big) d[i] = 0;
    }
    if (final) {
      // Relleno de huecos chicos: un píxel vacío rodeado de vecinos medidos toma su promedio (6 pasadas)
      for (let pass = 0; pass < 6; pass++) {
        const out = d.slice();
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (d[i] > 0) continue;
          let s = 0, n = 0;
          for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) { const q = d[i + v * W + u]; if (q > 0) { s += q; n++; } }
          if (n >= 5) out[i] = s / n;
        }
        d = out;
      }
      // Suavizado que respeta bordes: promedio de vecinos con profundidad parecida
      const out = d.slice();
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, c = d[i];
        if (!(c > 0)) continue;
        let s = 0, n = 0;
        for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
          const q = d[i + v * W + u];
          if (q > 0 && Math.abs(q - c) < 0.03 * c) { s += q; n++; }
        }
        out[i] = s / n;
      }
      d = out;
    }
    const f = this.f0, cx = this.cx0, cy = this.cy0;
    let count = 0;
    for (let i = 0; i < N; i++) if (d[i] > 0) count++;
    return { w: W, h: H, f, cx, cy, depth: d, rgb: this.rgb, count };
  }

  setIntrinsics(f, cx, cy) { this.f0 = f / this.F; this.cx0 = cx / this.F; this.cy0 = cy / this.F; }
            }
