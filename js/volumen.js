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
function maskAt(img, R, t, f, cx, cy, S, blur, r, erode, search = 0) {
  const W0 = img.width, H0 = img.height, d = img.data, W = Math.floor(W0 / S), H = Math.floor(H0 / S), N = W * H;
  const P0 = new Float32Array(N), O0 = new Float32Array(N), info = new Uint8Array(N);
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let o = 0;
    for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) { const q = 4 * ((y * S + b) * W0 + x * S + a); o += 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2]; }
    O0[i] = o / (S * S);
    let p = 0, ok = true;
    for (let b = 0; b < S && ok; b++) for (let a = 0; a < S; a++) {
      const u = (x * S + a + 0.5 - 0.5 - cx) / f, v = (y * S + b + 0.5 - 0.5 - cy) / f;
      const dz = R[2] * u + R[5] * v + R[8];
      if (dz >= -1e-6) { ok = false; break; }
      const s = -C[2] / dz, X = C[0] + s * (R[0] * u + R[3] * v + R[6]), Y = C[1] + s * (R[1] * u + R[4] * v + R[7]);
      const tone = toneAt(X * 1000, Y * 1000);
      if (tone < 0) { ok = false; break; }
      p += tone;
    }
    if (!ok) continue;
    P0[i] = p / (S * S);
    info[i] = 1;
  }
  // Suavizado 3×3 de ambas (solo con píxeles con información)
  const P = blur ? new Float32Array(N) : P0, O = blur ? new Float32Array(N) : O0;
  if (blur) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!info[i]) continue;
    let sp = 0, so = 0, n = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const xx = x + a, yy = y + b;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (!info[j]) continue;
      sp += P0[j]; so += O0[j]; n++;
    }
    P[i] = sp / n; O[i] = so / n;
  }
  // Correlación en ventanas con imágenes integrales. Con «search» se prueba además la hoja desplazada unos
  // píxeles y se queda la mejor: tolera papel no del todo plano y pequeños errores de posición.
  const W1 = W + 1, M = W1 * (H + 1);
  const sO = new Float64Array(M), sOO = new Float64Array(M);
  for (let y = 0; y < H; y++) {
    let b = 0, e = 0;
    for (let x = 0; x < W; x++) { const o = O[y * W + x]; b += o; e += o * o; const q = (y + 1) * W1 + x + 1, u = y * W1 + x + 1; sO[q] = sO[u] + b; sOO[q] = sOO[u] + e; }
  }
  const box = (Sx, x0, y0, x1, y1) => Sx[y1 * W1 + x1] - Sx[y0 * W1 + x1] - Sx[y1 * W1 + x0] + Sx[y0 * W1 + x0];
  const best = new Float32Array(N).fill(-2), tex = new Uint8Array(N), full = (2 * r + 1) * (2 * r + 1);
  const sP = new Float64Array(M), sPP = new Float64Array(M), sPO = new Float64Array(M), sI = new Float64Array(M);
  for (let dy = -search; dy <= search; dy++) for (let dx = -search; dx <= search; dx++) {
    for (let y = 0; y < H; y++) {
      let a = 0, c = 0, g = 0, k = 0;
      const ys = y + dy;
      for (let x = 0; x < W; x++) {
        const xs = x + dx;
        if (ys >= 0 && ys < H && xs >= 0 && xs < W) {
          const j = ys * W + xs;
          if (info[j] && info[y * W + x]) { const p = P[j]; a += p; c += p * p; g += p * O[y * W + x]; k++; }
        }
        const q = (y + 1) * W1 + x + 1, u = y * W1 + x + 1;
        sP[q] = sP[u] + a; sPP[q] = sPP[u] + c; sPO[q] = sPO[u] + g; sI[q] = sI[u] + k;
      }
    }
    for (let y = r; y < H - r; y++) for (let x = r; x < W - r; x++) {
      const i = y * W + x;
      if (!info[i]) continue;
      const x0 = x - r, x1 = x + r + 1, y0 = y - r, y1 = y + r + 1;
      if (box(sI, x0, y0, x1, y1) < full) continue;   // ventana incompleta (borde del papel)
      const n = full, mp = box(sP, x0, y0, x1, y1) / n, mo = box(sO, x0, y0, x1, y1) / n;
      const vp = box(sPP, x0, y0, x1, y1) / n - mp * mp;
      if (vp <= 0.003) continue;   // papel liso: no se decide (una cara lisa del objeto se vería igual)
      const vo = box(sOO, x0, y0, x1, y1) / n - mo * mo, cpo = box(sPO, x0, y0, x1, y1) / n - mp * mo;
      const ncc = cpo / Math.sqrt(vp * Math.max(vo, 1e-6));
      tex[i] = 1;
      if (ncc > best[i]) best[i] = ncc;
    }
  }
  const half = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (tex[i]) half[i] = best[i] > 0.5 ? 1 : 2;
  // Prudencia en los bordes del objeto: «se ve la hoja» solo si los vecinos también la ven (la ventana de
  // comparación mezcla papel y objeto en el borde y podría tallar un poco del objeto)
  const er = new Uint8Array(half);
  for (let y = erode; y < H - erode; y++) for (let x = erode; x < W - erode; x++) {
    const i = y * W + x;
    if (half[i] !== 1) continue;
    let ok = true;
    for (let b = -erode; b <= erode && ok; b++) for (let a = -erode; a <= erode; a++) if (half[i + b * W + a] === 2) { ok = false; break; }
    if (!ok) er[i] = 0;
  }
  half.set(er);
  // De vuelta a resolución completa
  const mask = new Uint8Array(W0 * H0);
  for (let y = 0; y < H0; y++) { const yy = Math.min(H - 1, Math.floor(y / S)); for (let x = 0; x < W0; x++) mask[y * W0 + x] = half[yy * W + Math.min(W - 1, Math.floor(x / S))]; }
  return mask;
}

// Dos comparaciones: fina (resolución completa, detalle exacto) y gruesa (media resolución suavizada, tolera que
// la hoja real no calce perfecto: papel no del todo plano, pequeños errores de posición, foco, impresión).
// Se ve la hoja si cualquiera de las dos lo asegura; algo la tapa si ninguna la ve.
export function sheetMask(img, R, t, f, cx, cy) {
  const fine = maskAt(img, R, t, f, cx, cy, 1, false, 3, 1), coarse = maskAt(img, R, t, f, cx, cy, 2, true, 4, 2, 2);
  for (let i = 0; i < fine.length; i++) {
    if (fine[i] === 1 || coarse[i] === 1) fine[i] = 1;
    else if (fine[i] === 2 || coarse[i] === 2) fine[i] = 2;
  }
  return fine;
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
    const mask = sheetMask(img, R, t, f, cx, cy);
    this.carveMask(mask, img.width, img.height, R, t, f, cx, cy);
    return mask;
  }

  // Tallar con una máscara ya calculada (la máscara se calcula en segundo plano, en el worker)
  carveMask(mask, W, H, R, t, f, cx, cy) {
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
      const o = 4 * (Math.min(H - 1, Math.round(v)) * W + Math.min(W - 1, Math.round(u))), wgt = 1 / (z * z);
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
    // Grupos sueltos (motas flotando): se deja el bloque mayor y los que tengan al menos 1/6 de su tamaño
    const inS = new Set(surf.idx), comp = new Map(), sizes = [];
    for (const i0 of surf.idx) {
      if (comp.has(i0)) continue;
      const id = sizes.length, st = [i0];
      comp.set(i0, id);
      let n = 0;
      while (st.length) {
        const i = st.pop();
        n++;
        for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const j = i + dx + dy * nx + dz * nxy;
          if (inS.has(j) && !comp.has(j)) { comp.set(j, id); st.push(j); }
        }
      }
      sizes.push(n);
    }
    const big = Math.max(0, ...sizes);
    for (const i of surf.idx) {
      if (sizes[comp.get(i)] < big / 6) continue;
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
