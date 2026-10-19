// volumen.js — CAPAS sobre la hoja: forma → relieve → color.
//  1. FORMA: se parte de un bloque sobre la zona libre de la hoja y se talla con cada vista: si en un píxel se ve
//     la hoja (su textura conocida), todo lo que hay entre la cámara y ese punto de la hoja está vacío.
//     Queda un volumen cerrado parecido al objeto (aunque falten huecos y detalles).
//  2. RELIEVE: los mapas de profundidad tallan lo que la forma no puede ver (hundimientos): lo que está claramente
//     delante de la superficie medida por varias vistas también está vacío.
//  3. COLOR: cada cubito de la superficie toma el color de las vistas que lo ven de frente y sin nada delante.
// Todo en el espacio de la hoja (metros, Z hacia arriba).

import { sheetTone, HOJA } from './hoja.js';

export const VERSION = '1';

/* ---------- Imagen de la hoja (tono 0–1 cada 0,5 mm) para comparar con lo que ve la cámara ---------- */
let RASTER = null;
const RS = 0.5;   // mm por celda
function raster() {
  if (RASTER) return RASTER;
  const w = Math.ceil(HOJA.w / RS) + 1, h = Math.ceil(HOJA.h / RS) + 1, a = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const t = sheetTone(-HOJA.w / 2 + i * RS, -HOJA.h / 2 + j * RS);
    a[j * w + i] = t === null ? 1 : t;
  }
  RASTER = { w, h, a };
  return RASTER;
}
function toneAt(xmm, ymm) {
  const R = raster(), fx = (xmm + HOJA.w / 2) / RS, fy = (ymm + HOJA.h / 2) / RS;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= R.w - 1 || j >= R.h - 1) return -1;
  const u = fx - i, v = fy - j, a = R.a, o = j * R.w + i;
  return (a[o] * (1 - u) + a[o + 1] * u) * (1 - v) + (a[o + R.w] * (1 - u) + a[o + R.w + 1] * u) * v;
}

/* ---------- ¿Dónde se ve la hoja? ----------
   Para cada píxel: 0 = sin información (fuera del papel), 1 = se ve la hoja, 2 = algo la tapa.
   Se compara la textura que debería verse (la hoja impresa, vista desde esa cámara) con la que se ve, en ventanas
   de 7×7 (correlación normalizada: no le afectan la luz ni las sombras suaves). */
export function sheetMask(img, R, t, f, cx, cy) {
  const W = img.width, H = img.height, d = img.data, N = W * H;
  const P = new Float32Array(N), O = new Float32Array(N), info = new Uint8Array(N);
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, a = (x - cx) / f, b = (y - cy) / f;
    O[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
    const dz = R[2] * a + R[5] * b + R[8];
    if (dz >= -1e-6) continue;
    const s = -C[2] / dz, X = C[0] + s * (R[0] * a + R[3] * b + R[6]), Y = C[1] + s * (R[1] * a + R[4] * b + R[7]);
    const tone = toneAt(X * 1000, Y * 1000);
    if (tone < 0) continue;
    P[i] = tone;
    info[i] = 1;
  }
  // Imágenes integrales para medias, varianzas y covarianza en ventanas
  const W1 = W + 1, sP = new Float64Array(W1 * (H + 1)), sO = new Float64Array(W1 * (H + 1)), sPP = new Float64Array(W1 * (H + 1)), sOO = new Float64Array(W1 * (H + 1)), sPO = new Float64Array(W1 * (H + 1)), sI = new Float64Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let a = 0, b = 0, c = 0, e = 0, g = 0, k = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = P[i], o = O[i], m = info[i];
      a += p * m; b += o * m; c += p * p * m; e += o * o * m; g += p * o * m; k += m;
      const q = (y + 1) * W1 + x + 1, u = y * W1 + x + 1;
      sP[q] = sP[u] + a; sO[q] = sO[u] + b; sPP[q] = sPP[u] + c; sOO[q] = sOO[u] + e; sPO[q] = sPO[u] + g; sI[q] = sI[u] + k;
    }
  }
  const box = (S, x0, y0, x1, y1) => S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
  const mask = new Uint8Array(N), r = 3, rg = 12, full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!info[i]) continue;
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    const n = box(sI, x0, y0, x1, y1);
    if (n < full) continue;   // ventana incompleta (borde del papel): sin información
    const mp = box(sP, x0, y0, x1, y1) / n, mo = box(sO, x0, y0, x1, y1) / n;
    const vp = box(sPP, x0, y0, x1, y1) / n - mp * mp, vo = box(sOO, x0, y0, x1, y1) / n - mo * mo, cpo = box(sPO, x0, y0, x1, y1) / n - mp * mo;
    if (vp > 0.004) {
      // Con textura: correlación (no le afectan la luz ni las sombras suaves)
      const ncc = cpo / Math.sqrt(vp * Math.max(vo, 1e-6));
      mask[i] = ncc > 0.55 ? 1 : 2;
    } else {
      // Papel liso: el tono debe calzar con la relación tono impreso → tono visto de los alrededores
      const X0 = Math.max(0, x - rg), X1 = Math.min(W, x + rg + 1), Y0 = Math.max(0, y - rg), Y1 = Math.min(H, y + rg + 1);
      const nn = box(sI, X0, Y0, X1, Y1);
      if (nn < 100) continue;
      const MP = box(sP, X0, Y0, X1, Y1) / nn, MO = box(sO, X0, Y0, X1, Y1) / nn;
      const VP = box(sPP, X0, Y0, X1, Y1) / nn - MP * MP, CPO = box(sPO, X0, Y0, X1, Y1) / nn - MP * MO;
      let pred;
      if (VP > 0.01) { const g = CPO / VP; pred = MO + g * (P[i] - MP); }
      else pred = MO / Math.max(0.05, MP) * P[i];
      mask[i] = Math.abs(mo - pred) < 0.12 * Math.abs(pred) + 10 && vo < 80 ? 1 : 2;
    }
  }
  return mask;
}

/* ---------- Volumen tallado ---------- */
export class Volume {
  constructor(zona, vox = 0.002, hmax = 0.16) {
    this.vox = vox;
    this.x0 = zona.x0; this.y0 = zona.y0; this.z0 = 0;
    this.nx = Math.ceil((zona.x1 - zona.x0) / vox); this.ny = Math.ceil((zona.y1 - zona.y0) / vox); this.nz = Math.ceil(hmax / vox);
    const n = this.nx * this.ny * this.nz;
    this.empty = new Uint8Array(n);    // vistas que ven a través (vacío)
    this.seen = new Uint8Array(n);     // vistas en que algo tapa la hoja en ese punto
    this.free = new Uint8Array(n);     // votos de vacío por profundidad (relieve)
    this.col = new Float32Array(4 * n);  // color acumulado (r, g, b, peso)
    this.lum = new Float32Array(3 * n);  // luminosidad: suma, suma de cuadrados y número de vistas (¿colores coherentes?)
    this.views = 0;
  }
  center(i) {
    const nxy = this.nx * this.ny, iz = Math.floor(i / nxy), r = i - iz * nxy, iy = Math.floor(r / this.nx), ix = r - iy * this.nx;
    return [this.x0 + (ix + 0.5) * this.vox, this.y0 + (iy + 0.5) * this.vox, this.z0 + (iz + 0.5) * this.vox];
  }
  // ¿Lleno? (forma + relieve)
  filled(i) {
    const e = this.empty[i], s = this.seen[i];
    // Lleno solo si varias vistas lo ven tapando la hoja y casi ninguna ve la hoja a través de él
    if (s < 3) return false;
    if (e > Math.max(1, 0.1 * (e + s))) return false;
    if (this.free[i] >= 2 && this.free[i] * 3 > s) return false;
    return true;
  }

  // 1. FORMA: tallar con una vista
  carve(img, R, t, f, cx, cy) {
    const mask = sheetMask(img, R, t, f, cx, cy), W = img.width, H = img.height;
    const { nx, ny, nz, vox, x0, y0 } = this;
    for (let iz = 0; iz < nz; iz++) {
      const Z = (iz + 0.5) * vox;
      for (let iy = 0; iy < ny; iy++) {
        const Y = y0 + (iy + 0.5) * vox;
        const bx = R[1] * Y + R[2] * Z + t[0], by = R[4] * Y + R[5] * Z + t[1], bz = R[7] * Y + R[8] * Z + t[2];
        let i = (iz * ny + iy) * nx;
        for (let ix = 0; ix < nx; ix++, i++) {
          const X = x0 + (ix + 0.5) * vox, z = R[6] * X + bz;
          if (z <= 0.01) continue;
          const u = Math.round(f * (R[0] * X + bx) / z + cx), v = Math.round(f * (R[3] * X + by) / z + cy);
          if (u < 0 || v < 0 || u >= W || v >= H) continue;
          const m = mask[v * W + u];
          if (m === 1) { if (this.empty[i] < 255) this.empty[i]++; }
          else if (m === 2) { if (this.seen[i] < 255) this.seen[i]++; }
        }
      }
    }
    this.views++;
    return mask;
  }

  // 2. RELIEVE: un mapa de profundidad (vista R,t; a 1/factor de resolución) vacía lo que está claramente delante
  relief(dm, R, t) {
    const { w, h, f, cx, cy, depth } = dm, { nx, ny, nz, vox, x0, y0 } = this;
    for (let iz = 0; iz < nz; iz++) {
      const Z = (iz + 0.5) * vox;
      for (let iy = 0; iy < ny; iy++) {
        const Y = y0 + (iy + 0.5) * vox;
        const bx = R[1] * Y + R[2] * Z + t[0], by = R[4] * Y + R[5] * Z + t[1], bz = R[7] * Y + R[8] * Z + t[2];
        let i = (iz * ny + iy) * nx;
        for (let ix = 0; ix < nx; ix++, i++) {
          if (!this.seen[i]) continue;
          const X = x0 + (ix + 0.5) * vox, z = R[6] * X + bz;
          if (z <= 0.01) continue;
          const u = Math.round(f * (R[0] * X + bx) / z + cx), v = Math.round(f * (R[3] * X + by) / z + cy);
          if (u < 1 || v < 1 || u >= w - 1 || v >= h - 1) continue;
          // La superficie medida (mínimo de la vecindad, para no vaciar en bordes) está claramente detrás
          let dmin = Infinity;
          for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const dd = depth[(v + b) * w + u + a]; if (!(dd > 0)) { dmin = 0; break; } if (dd < dmin) dmin = dd; }
          if (dmin > z + Math.max(3 * vox, 0.02 * z) && this.free[i] < 255) this.free[i]++;
        }
      }
    }
  }

  // La piel del objeto: cubitos llenos que tocan el vacío de AFUERA (los huecos cerrados por dentro se rellenan)
  surface() {
    const { nx, ny, nz } = this, nxy = nx * ny, n = nxy * nz, F = new Uint8Array(n);
    for (let i = 0; i < n; i++) F[i] = this.filled(i) ? 1 : 0;
    // Vacío exterior: se recorre desde los bordes y desde arriba (el piso es la hoja)
    const out = new Uint8Array(n), stack = [];
    const push = i => { if (!F[i] && !out[i]) { out[i] = 1; stack.push(i); } };
    for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++)
      if (ix === 0 || iy === 0 || ix === nx - 1 || iy === ny - 1 || iz === nz - 1) push(iz * nxy + iy * nx + ix);
    while (stack.length) {
      const i = stack.pop(), iz = Math.floor(i / nxy), r = i - iz * nxy, iy = Math.floor(r / nx), ix = r - iy * nx;
      if (ix > 0) push(i - 1); if (ix < nx - 1) push(i + 1);
      if (iy > 0) push(i - nx); if (iy < ny - 1) push(i + nx);
      if (iz > 0) push(i - nxy); if (iz < nz - 1) push(i + nxy);
    }
    for (let i = 0; i < n; i++) if (!F[i] && !out[i]) F[i] = 1;   // huecos interiores → llenos
    const idx = [];
    for (let iz = 1; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nxy + iy * nx + ix;
      if (!F[i]) continue;
      const touch = ix === 0 || iy === 0 || ix === nx - 1 || iy === ny - 1 || iz === nz - 1 ||
        out[i - 1] || out[i + 1] || out[i - nx] || out[i + nx] || out[i - nxy] || out[i + nxy];
      if (touch) idx.push(i);   // el piso (iz = 0) es la hoja: no es piel visible
    }
    return { F, idx };
  }

  // 3. COLOR: se pinta la piel con una vista (solo lo que esa vista ve primero, sin nada delante)
  paint(img, R, t, f, cx, cy, surf, s = 2) {
    const W = img.width, H = img.height, d = img.data, w2 = Math.ceil(W / s), h2 = Math.ceil(H / s);
    const zb = new Float32Array(w2 * h2).fill(Infinity), who = new Int32Array(w2 * h2).fill(-1);
    const proj = [];
    for (const i of surf.idx) {
      const P = this.center(i), z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
      if (z <= 0.01) continue;
      const u = f * (R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0]) / z + cx, v = f * (R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1]) / z + cy;
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      // Cada cubito tapa un pequeño cuadrado de píxeles
      const rad = Math.max(1, Math.round(0.6 * f * this.vox / z / s));
      const cu = Math.floor(u / s), cv = Math.floor(v / s);
      for (let b = -rad; b <= rad; b++) for (let a = -rad; a <= rad; a++) {
        const uu = cu + a, vv = cv + b;
        if (uu < 0 || vv < 0 || uu >= w2 || vv >= h2) continue;
        const k = vv * w2 + uu;
        if (z < zb[k]) { zb[k] = z; who[k] = i; }
      }
      proj.push([i, u, v, z]);
    }
    for (const [i, u, v, z] of proj) {
      const k = Math.floor(v / s) * w2 + Math.floor(u / s);
      if (zb[k] < z - 2.5 * this.vox) continue;   // algo más cerca lo tapa
      const o = 4 * (Math.round(v) * W + Math.round(u)), wgt = 1 / (z * z);
      this.col[4 * i] += d[o] * wgt; this.col[4 * i + 1] += d[o + 1] * wgt; this.col[4 * i + 2] += d[o + 2] * wgt; this.col[4 * i + 3] += wgt;
      const L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      this.lum[3 * i] += L; this.lum[3 * i + 1] += L * L; this.lum[3 * i + 2]++;
    }
  }

  // Puntos de la piel con color (los que ninguna vista vio toman el color de sus vecinos, en varias pasadas)
  points() {
    const surf = this.surface(), { nx, ny } = this, nxy = nx * ny, out = [];
    const C = new Map();
    // Un cubito real se ve del mismo color desde todas las vistas; si cada vista ve algo distinto, no es superficie
    const bad = new Set();
    for (const i of surf.idx) {
      const n = this.lum[3 * i + 2];
      if (n >= 3) { const m = this.lum[3 * i] / n, sd = Math.sqrt(Math.max(0, this.lum[3 * i + 1] / n - m * m)); if (sd > 38) bad.add(i); }
    }
    // (se conserva la forma, pero su color se toma de los vecinos coherentes)
    for (const i of surf.idx) { const w = this.col[4 * i + 3]; if (w && !bad.has(i)) C.set(i, [this.col[4 * i] / w, this.col[4 * i + 1] / w, this.col[4 * i + 2] / w]); }
    const pending = surf.idx.filter(i => !C.has(i));
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const add = [];
      for (let k = pending.length - 1; k >= 0; k--) {
        const i = pending[k];
        let r = 0, g = 0, b = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const c = C.get(i + dx + dy * nx + dz * nxy);
          if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
        }
        if (n) { add.push([i, [r / n, g / n, b / n]]); pending.splice(k, 1); }
      }
      for (const [i, c] of add) C.set(i, c);
    }
    for (const i of surf.idx) {
      const P = this.center(i), c = C.get(i) || [150, 150, 150];
      out.push([P[0], P[1], P[2], c[0], c[1], c[2]]);
    }
    return out;
  }
}

// Nube para el visor ([x, y, z, w, r, g, b, tamaño], centrada; Z de la hoja hacia arriba en pantalla)
export function viewerCloud(pts, vox, colored = true) {
  if (pts.length < 20) return null;
  const c = [0, 1, 2].map(k => { let a = Infinity, b = -Infinity; for (const p of pts) { if (p[k] < a) a = p[k]; if (p[k] > b) b = p[k]; } return (a + b) / 2; });
  const rs = pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).sort((a, b) => a - b);
  const sc = rs[rs.length >> 1] || 1, size = vox * 1.3 / sc;
  let zmin = Infinity, zmax = -Infinity;
  for (const p of pts) { if (p[2] < zmin) zmin = p[2]; if (p[2] > zmax) zmax = p[2]; }
  return pts.map(p => {
    // Sin color todavía (bosquejo): gris azulado más claro arriba
    const h = (p[2] - zmin) / Math.max(1e-6, zmax - zmin);
    const r = colored ? p[3] : 90 + 80 * h, g = colored ? p[4] : 110 + 80 * h, b = colored ? p[5] : 140 + 80 * h;
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return [(p[0] - c[0]) / sc, (p[2] - c[2]) / sc, -(p[1] - c[1]) / sc, (L - 0.5) * 2, r, g, b, size];
  });
}

// Medidas del objeto (mm)
export function sizeOf(pts) {
  if (!pts.length) return null;
  return [0, 1, 2].map(k => { let a = Infinity, b = -Infinity; for (const p of pts) { if (p[k] < a) a = p[k]; if (p[k] > b) b = p[k]; } return Math.round(1000 * (b - a)); });
}
