// hoja.js — MODO HOJA: una hoja impresa bajo el objeto da, en cada cuadro, la posición exacta de la cámara,
// las medidas reales (milímetros) y el fondo conocido (lo que tapa la hoja es el objeto).
// Todo es código propio: diseño de la hoja, marcadores, detección y cálculo de la posición.
//
// La hoja (tamaño carta, 215,9 × 279,4 mm) tiene:
//   · 18 marcadores cuadrados alrededor del borde (6×6 celdas: borde negro + 16 bits que dicen cuál es);
//   · al centro, un área libre con una textura suave y conocida (para saber dónde la tapa el objeto);
//   · una regla de 100 mm para comprobar que se imprimió al 100 %.
// Espacio de la hoja: origen al centro, X a la derecha, Y hacia arriba de la hoja, Z hacia arriba (fuera del papel).
// Unidades: metros.

export const VERSION = '1';

export const HOJA = { w: 215.9, h: 279.4, marker: 30, margin: 12 };   // mm

/* ---------- Diccionario de marcadores (16 bits, distintos aunque se giren) ---------- */
const rot16 = c => {   // giro de 90° de la grilla 4×4 (bit fila r, columna k → bit k, 3−r)
  let o = 0;
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) if (c >> (4 * r + k) & 1) o |= 1 << (4 * k + (3 - r));
  return o;
};
const pop = v => { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; };
export const CODES = (() => {
  const out = [], all = [];
  let s = 12345;
  for (let tries = 0; tries < 200000 && out.length < 24; tries++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const c = (s >>> 8) & 0xffff, b = pop(c);
    if (b < 6 || b > 10) continue;
    const rots = [c, rot16(c), rot16(rot16(c)), rot16(rot16(rot16(c)))];
    if (pop(rots[0] ^ rots[1]) < 5 || pop(rots[0] ^ rots[2]) < 5 || pop(rots[0] ^ rots[3]) < 5) continue;
    if (all.some(o => rots.some(r => pop(r ^ o) < 5))) continue;
    out.push(c);
    all.push(...rots);
  }
  return out;
})();

/* ---------- Disposición de los marcadores (centros en mm, espacio de la hoja) ---------- */
export const MARKERS = (() => {
  const { w, h, marker, margin } = HOJA, half = marker / 2, list = [];
  const yTop = h / 2 - margin - half, xSide = w / 2 - margin - half;
  const xs = [-1, -0.5, 0, 0.5, 1].map(k => k * xSide);
  xs.forEach(x => list.push([x, yTop]));
  [-0.6, -0.2, 0.2, 0.6].forEach(k => list.push([xSide, -k * yTop]));
  xs.slice().reverse().forEach(x => list.push([x, -yTop]));
  [-0.6, -0.2, 0.2, 0.6].forEach(k => list.push([-xSide, k * yTop]));
  return list.map((c, id) => ({ id, c, code: CODES[id] }));
})();

// Zona libre del centro (donde va el objeto), en mm
export const ZONA = (() => {
  const { w, h, marker, margin } = HOJA, e = margin + marker + 6;
  return { x0: -w / 2 + e, x1: w / 2 - e, y0: -h / 2 + e, y1: h / 2 - e };
})();

// Esquinas de un marcador en la hoja (metros): sup-izq, sup-der, inf-der, inf-izq (vistas desde arriba)
export function markerCorners(m) {
  const h = HOJA.marker / 2, [x, y] = m.c;
  return [[x - h, y + h], [x + h, y + h], [x + h, y - h], [x - h, y - h]].map(([a, b]) => [a / 1000, b / 1000, 0]);
}

// Bit (fila r, columna k) de la grilla 6×6 de un marcador: 0 negro, 1 blanco
function cell(m, r, k) {
  if (r === 0 || k === 0 || r === 5 || k === 5) return 0;
  return (m.code >> (4 * (r - 1) + (k - 1))) & 1;
}

/* ---------- Textura conocida del centro: manchas suaves en gris (sirve para ver qué tapa el objeto) ---------- */
const hash2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function blobs(xmm, ymm) {
  // Celdas de 9 mm con una mancha redonda de radio y tono variables
  const cs = 9, ix = Math.floor(xmm / cs), iy = Math.floor(ymm / cs);
  let v = 1;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const cx = (ix + a + 0.2 + 0.6 * hash2(ix + a, iy + b)) * cs, cy = (iy + b + 0.2 + 0.6 * hash2(iy + b + 7.3, ix + a - 3.1)) * cs;
    const r = 1.6 + 2.2 * hash2(ix + a + 11.7, iy + b + 5.9), d = Math.hypot(xmm - cx, ymm - cy);
    if (d < r) v = Math.min(v, 0.55 + 0.3 * hash2(ix + a + 2.2, iy + b + 9.4));
  }
  return v;
}

// Tono de la hoja impresa en un punto (mm): 0 negro … 1 blanco. null fuera del papel.
export function sheetTone(xmm, ymm) {
  const { w, h, marker } = HOJA;
  if (Math.abs(xmm) > w / 2 || Math.abs(ymm) > h / 2) return null;
  const half = marker / 2;
  for (const m of MARKERS) {
    const u = xmm - (m.c[0] - half), v = (m.c[1] + half) - ymm;
    if (u >= 0 && v >= 0 && u < marker && v < marker) return cell(m, Math.floor(v / (marker / 6)), Math.floor(u / (marker / 6)));
  }
  if (xmm > ZONA.x0 && xmm < ZONA.x1 && ymm > ZONA.y0 && ymm < ZONA.y1) return blobs(xmm, ymm);
  return 1;
}

/* ---------- Hoja para imprimir (SVG en milímetros reales) ---------- */
export function sheetSVG() {
  const { w, h, marker } = HOJA, cs = marker / 6, half = marker / 2;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${-w / 2} ${-h / 2} ${w} ${h}">`;
  s += `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="#fff"/>`;
  // Textura del centro (círculos grises, los más oscuros encima), recortada a la zona libre; en el SVG la Y crece hacia abajo
  const z = ZONA, g = [];
  for (let ix = Math.floor(z.x0 / 9) - 1; ix <= Math.ceil(z.x1 / 9) + 1; ix++) for (let iy = Math.floor(z.y0 / 9) - 1; iy <= Math.ceil(z.y1 / 9) + 1; iy++) {
    const cx = (ix + 0.2 + 0.6 * hash2(ix, iy)) * 9, cy = (iy + 0.2 + 0.6 * hash2(iy + 7.3, ix - 3.1)) * 9;
    const r = 1.6 + 2.2 * hash2(ix + 11.7, iy + 5.9), tone = 0.55 + 0.3 * hash2(ix + 2.2, iy + 9.4);
    g.push([tone, `<circle cx="${cx.toFixed(2)}" cy="${(-cy).toFixed(2)}" r="${r.toFixed(2)}" fill="rgb(${Math.round(255 * tone)},${Math.round(255 * tone)},${Math.round(255 * tone)})"/>`]);
  }
  g.sort((a, b) => b[0] - a[0]);
  s += `<defs><clipPath id="zona"><rect x="${z.x0}" y="${-z.y1}" width="${z.x1 - z.x0}" height="${z.y1 - z.y0}"/></clipPath></defs><g clip-path="url(#zona)">` + g.map(e => e[1]).join('') + '</g>';
  // Marcadores
  for (const m of MARKERS) {
    const x0 = m.c[0] - half, y0 = -(m.c[1] + half);
    // Cuadrado negro entero y encima las celdas blancas (sin líneas finas entre celdas negras)
    s += `<rect x="${x0}" y="${y0}" width="${marker}" height="${marker}" fill="#000"/>`;
    for (let r = 0; r < 6; r++) for (let k = 0; k < 6; k++) if (cell(m, r, k)) s += `<rect x="${(x0 + k * cs).toFixed(3)}" y="${(y0 + r * cs).toFixed(3)}" width="${cs.toFixed(3)}" height="${cs.toFixed(3)}" fill="#fff" shape-rendering="crispEdges"/>`;
  }
  // Regla de 100 mm y texto
  const ry = h / 2 - 5;
  s += `<line x1="-50" y1="${ry}" x2="50" y2="${ry}" stroke="#000" stroke-width="0.4"/>`;
  for (let k = 0; k <= 10; k++) s += `<line x1="${-50 + 10 * k}" y1="${ry - (k % 5 ? 1.2 : 2)}" x2="${-50 + 10 * k}" y2="${ry}" stroke="#000" stroke-width="0.3"/>`;
  s += `<text x="0" y="${ry - 2.8}" font-size="2.6" text-anchor="middle" font-family="sans-serif">Cámara 4D · hoja de referencia · imprimir al 100 % (tamaño real, sin ajustar) · esta línea debe medir 100 mm</text>`;
  s += `<text x="0" y="${-h / 2 + 6}" font-size="3" text-anchor="middle" font-family="sans-serif">Pon el objeto al centro · la hoja debe quedar plana</text>`;
  return s + '</svg>';
}

export function openPrintable() {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Hoja Cámara 4D</title><style>@page{size:letter;margin:0}html,body{margin:0;padding:0}svg{display:block}</style></head><body>' + sheetSVG() + '<script>setTimeout(()=>print(),400)<\/script></body></html>');
  win.document.close();
  return true;
}

/* ---------- Detección de marcadores en una imagen ---------- */
function grayOf(img) {
  const { width: w, height: h, data: d } = img, g = new Float32Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) g[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  return g;
}

// Homografía de 4 puntos (cuadrado unitario → imagen)
function homUnit(q) {
  // Proyectiva que lleva (0,0),(1,0),(1,1),(0,1) a q0..q3
  const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den, hh = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}
const hApply = (H, u, v) => { const w = H[6] * u + H[7] * v + H[8]; return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w]; };

export function detectMarkers(img) {
  const W = img.width, Hh = img.height, g = grayOf(img);
  // Umbral local (media de una ventana) con imagen integral
  const I = new Float64Array((W + 1) * (Hh + 1));
  for (let y = 0; y < Hh; y++) { let row = 0; for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const r = Math.max(6, Math.round(W / 40)), dark = new Uint8Array(W * Hh);
  for (let y = 0; y < Hh; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(Hh, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      if (g[y * W + x] < s / ((x1 - x0) * (y1 - y0)) - 7) dark[y * W + x] = 1;
    }
  }
  // Grupos de píxeles oscuros conectados
  const lab = new Int32Array(W * Hh).fill(-1), stack = new Int32Array(W * Hh);
  const out = [];
  for (let start = 0; start < W * Hh; start++) {
    if (!dark[start] || lab[start] >= 0) continue;
    let sp = 0, n = 0, minx = W, maxx = 0, miny = Hh, maxy = 0, touch = false;
    const border = [];
    stack[sp++] = start; lab[start] = start;
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p - x) / W;
      n++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === Hh - 1) { touch = true; continue; }
      let edge = false;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (dark[q]) { if (lab[q] < 0) { lab[q] = start; stack[sp++] = q; } } else edge = true;
      }
      if (edge) border.push(x, y);
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (touch || n < 40 || bw < 9 || bh < 9 || bw > W * 0.5 || bh > Hh * 0.5 || bw > 4 * bh || bh > 4 * bw) continue;
    const q = quadOf(border);
    if (!q) continue;
    const dec = decode(g, W, Hh, q);
    if (dec) out.push(dec);
  }
  // Un mismo marcador no puede aparecer dos veces: se deja el de mayor contraste
  const best = new Map();
  for (const d of out) { const o = best.get(d.id); if (!o || d.contrast > o.contrast) best.set(d.id, d); }
  return [...best.values()];
}

// Cuadrilátero que encierra los puntos del borde (cubierta convexa → 4 esquinas → lados ajustados)
function quadOf(b) {
  const P = [];
  for (let i = 0; i < b.length; i += 2) P.push([b[i], b[i + 1]]);
  if (P.length < 16) return null;
  P.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  const cr = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  if (hull.length < 4) return null;
  let area = 0;
  for (let i = 0; i < hull.length; i++) { const a = hull[i], c = hull[(i + 1) % hull.length]; area += a[0] * c[1] - c[0] * a[1]; }
  area = Math.abs(area) / 2;
  // 4 esquinas: el par más alejado y, a cada lado de esa diagonal, el más lejano
  let i1 = 0, i2 = 0, bd = -1;
  for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) {
    const d = (hull[i][0] - hull[j][0]) ** 2 + (hull[i][1] - hull[j][1]) ** 2;
    if (d > bd) { bd = d; i1 = i; i2 = j; }
  }
  const A = hull[i1], C = hull[i2];
  let B = null, D = null, bb = 0, dd = 0;
  for (const p of hull) {
    const s = cr(A, C, p);
    if (s > bb) { bb = s; B = p; }
    if (-s > dd) { dd = -s; D = p; }
  }
  if (!B || !D) return null;
  let q = [A, B, C, D];
  const qa = Math.abs(cr(A, B, C) + cr(A, C, D)) / 2;
  if (qa < 0.88 * area || qa < 60) return null;
  // Orden horario en la imagen (y hacia abajo)
  if (cr(q[0], q[1], q[2]) < 0) q = [q[0], q[3], q[2], q[1]];
  // Lados ajustados con los puntos del borde cercanos a cada lado (recta por mínimos cuadrados)
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], c = q[(s + 1) % 4], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 6) return null;
    const ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L;
    let sx = 0, sy = 0, n = 0;
    const pts = [];
    for (const p of P) {
      const t = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy, dist = Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
      if (t > 0.12 * L && t < 0.88 * L && dist < 2) { pts.push(p); sx += p[0]; sy += p[1]; n++; }
    }
    if (n < 4) { lines.push({ px: (a[0] + c[0]) / 2, py: (a[1] + c[1]) / 2, dx: ux, dy: uy }); continue; }
    const mx = sx / n, my = sy / n;
    let xx = 0, xy = 0, yy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * xy, xx - yy);
    let dx = Math.cos(th), dy = Math.sin(th);
    if (dx * ux + dy * uy < 0) { dx = -dx; dy = -dy; }
    // El borde real queda medio píxel hacia afuera del último píxel oscuro
    const nx = dy, ny = -dx;   // normal hacia afuera en orden horario (y hacia abajo)
    lines.push({ px: mx + 0.5 * nx, py: my + 0.5 * ny, dx, dy });
  }
  const corners = [];
  for (let s = 0; s < 4; s++) {
    const L1 = lines[(s + 3) % 4], L2 = lines[s];
    const den = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / den;
    corners.push([L1.px + t * L1.dx, L1.py + t * L1.dy]);
  }
  for (let s = 0; s < 4; s++) if (Math.hypot(corners[s][0] - q[s][0], corners[s][1] - q[s][1]) > 4) return null;
  return corners;
}

// Lee la grilla 6×6 dentro del cuadrilátero y busca el marcador (en los 4 giros posibles)
function decode(g, W, H, q) {
  const sample = (Hm, r, k) => {
    let s = 0, n = 0;
    for (const [a, b] of [[0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65], [0.5, 0.5]]) {
      const [x, y] = hApply(Hm, (k + a) / 6, (r + b) / 6);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) return NaN;
      s += g[yi * W + xi]; n++;
    }
    return s / n;
  };
  const Hm = homUnit(q);
  if (!Hm) return null;
  const v = [];
  for (let r = 0; r < 6; r++) for (let k = 0; k < 6; k++) { const s = sample(Hm, r, k); if (s !== s) return null; v.push(s); }
  // Umbral: entre el borde (negro) y lo más claro del interior
  let bsum = 0, bn = 0, hi = 0;
  for (let r = 0; r < 6; r++) for (let k = 0; k < 6; k++) {
    const x = v[6 * r + k];
    if (r === 0 || k === 0 || r === 5 || k === 5) { bsum += x; bn++; } else if (x > hi) hi = x;
  }
  const lo = bsum / bn, contrast = hi - lo;
  if (contrast < 25) return null;
  const thr = (lo + hi) / 2;
  let badBorder = 0;
  for (let r = 0; r < 6; r++) for (let k = 0; k < 6; k++) if ((r === 0 || k === 0 || r === 5 || k === 5) && v[6 * r + k] > thr) badBorder++;
  if (badBorder > 2) return null;
  // Bits del interior leídos tomando como esquina superior izquierda cada una de las 4 esquinas
  for (let rot = 0; rot < 4; rot++) {
    const qq = [0, 1, 2, 3].map(k => q[(k + rot) % 4]), Hr = homUnit(qq);
    if (!Hr) continue;
    let code = 0;
    for (let r = 1; r <= 4; r++) for (let k = 1; k <= 4; k++) {
      const x = sample(Hr, r, k);
      if (x !== x) { code = -1; break; }
      if (x > thr) code |= 1 << (4 * (r - 1) + (k - 1));
    }
    if (code < 0) continue;
    for (const m of MARKERS) if (pop(code ^ m.code) <= 1) return { id: m.id, corners: qq, contrast };
  }
  return null;
}

/* ---------- Posición de la cámara respecto de la hoja ---------- */
// Correspondencias 3D (hoja) ↔ 2D (imagen) de los marcadores detectados
export function correspondences(dets) {
  const X = [], uv = [];
  for (const d of dets) {
    const C = markerCorners(MARKERS[d.id]);
    for (let s = 0; s < 4; s++) { X.push(C[s]); uv.push(d.corners[s]); }
  }
  return { X, uv };
}

// Homografía hoja (X,Y) → imagen normalizada, por mínimos cuadrados (h33 = 1)
function homography(src, dst) {
  const n = src.length, A = new Float64Array(64), b = new Float64Array(8);
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    const r1 = [x, y, 1, 0, 0, 0, -u * x, -u * y], r2 = [0, 0, 0, x, y, 1, -v * x, -v * y];
    for (let a = 0; a < 8; a++) { b[a] += r1[a] * u + r2[a] * v; for (let c = 0; c < 8; c++) A[8 * a + c] += r1[a] * r1[c] + r2[a] * r2[c]; }
  }
  // Gauss con pivote
  const M = [];
  for (let a = 0; a < 8; a++) M.push([...A.slice(8 * a, 8 * a + 8), b[a]]);
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-15) return null;
    for (let r = c + 1; r < 8; r++) { const k = M[r][c] / M[c][c]; for (let j = c; j < 9; j++) M[r][j] -= k * M[c][j]; }
  }
  const h = new Array(8);
  for (let r = 7; r >= 0; r--) { let s = M[r][8]; for (let j = r + 1; j < 8; j++) s -= M[r][j] * h[j]; h[r] = s / M[r][r]; }
  return [...h, 1];
}

// Pose inicial desde la homografía (cámara: p_cam = R·X + t)
export function poseFromHomography(X, uv, f, cx, cy) {
  const H = homography(X.map(p => [p[0], p[1]]), uv.map(p => [(p[0] - cx) / f, (p[1] - cy) / f]));
  if (!H) return null;
  const h1 = [H[0], H[3], H[6]], h2 = [H[1], H[4], H[7]], h3 = [H[2], H[5], H[8]];
  const l = 2 / (Math.hypot(...h1) + Math.hypot(...h2));
  let r1 = h1.map(v => v * l), r2 = h2.map(v => v * l), t = h3.map(v => v * l);
  if (t[2] < 0) { r1 = r1.map(v => -v); r2 = r2.map(v => -v); t = t.map(v => -v); }
  // Ortonormalizar (Gram-Schmidt simétrico)
  const n1 = Math.hypot(...r1);
  r1 = r1.map(v => v / n1);
  const d = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = r2.map((v, i) => v - d * r1[i]);
  const n2 = Math.hypot(...r2);
  r2 = r2.map(v => v / n2);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  return { R: [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]], t };
}

// Error medio de reproyección (píxeles)
export function reprojError(X, uv, f, cx, cy, R, t) {
  let s = 0;
  for (let i = 0; i < X.length; i++) {
    const P = X[i], z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
    if (z <= 0) return Infinity;
    const u = f * (R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0]) / z + cx, v = f * (R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1]) / z + cy;
    s += Math.hypot(u - uv[i][0], v - uv[i][1]);
  }
  return s / X.length;
}

/* ---------- Calibración de la focal con la hoja ----------
   La hoja es plana y de medidas conocidas: con vistas inclinadas se puede saber la focal real de la cámara
   (la que hace calzar mejor todas las esquinas). Se juntan cuadros y se busca la focal de menor error. */
export class FocalCal {
  constructor(long) { this.long = long; this.frames = []; this.done = false; this.fov = null; }
  add(X, uv, cx, cy, refine) {
    if (this.done || X.length < 12) return;
    // Solo vistas distintas (inclinación o giro) aportan
    this.frames.push({ X, uv, cx, cy });
    if (this.frames.length > 14) this.frames.splice(1, 1);
    if (this.frames.length < 8) return;
    const err = fov => {
      const f = (this.long / 2) / Math.tan(fov * Math.PI / 360);
      let s = 0;
      for (const fr of this.frames) {
        const p0 = poseFromHomography(fr.X, fr.uv, f, fr.cx, fr.cy);
        if (!p0) return Infinity;
        const p = refine(fr.X, fr.uv, f, fr.cx, fr.cy, p0.R, p0.t);
        s += reprojError(fr.X, fr.uv, f, fr.cx, fr.cy, p.R, p.t);
      }
      return s / this.frames.length;
    };
    let best = 65, be = Infinity;
    for (let fov = 40; fov <= 100; fov += 2) { const e = err(fov); if (e < be) { be = e; best = fov; } }
    for (let fov = best - 2; fov <= best + 2; fov += 0.25) { const e = err(fov); if (e < be) { be = e; best = fov; } }
    // Se acepta si calza bien; si la hoja no está del todo plana el error no baja tanto: tras 3 intentos se
    // acepta el mejor (y se avisa), para no quedar calibrando para siempre
    this.tries = (this.tries || 0) + 1;
    if (!this.bestTry || be < this.bestTry.err) this.bestTry = { fov: best, err: be };
    if (be < 1.5 || this.tries >= 3) { this.fov = this.bestTry.fov; this.err = this.bestTry.err; this.done = true; }
    else this.frames.splice(0, 4);   // sin acuerdo: se renuevan las vistas
  }
}
