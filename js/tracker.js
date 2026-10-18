// tracker.js — Seguimiento de puntos programado por nosotros (sin librerías externas).
//  · Detección de esquinas Shi-Tomasi (mínimo autovalor del tensor de estructura).
//  · Seguimiento Lucas-Kanade piramidal (3 niveles) entre fotogramas consecutivos.
// Mantiene la correspondencia entre los puntos del fotograma de referencia y los del fotograma actual.

export const VERSION = '5';

/* ---------- Imagen en escala de grises e imagen piramidal ---------- */

// Convierte ImageData RGBA a gris (Float32Array, 0..255).
export function toGray(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}

function downsample(img) {
  const w = (img.w >> 1), h = (img.h >> 1);
  const out = new Float32Array(w * h), s = img.data, W = img.w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (2 * y) * W + 2 * x;
    out[y * w + x] = 0.25 * (s[i] + s[i + 1] + s[i + W] + s[i + W + 1]);
  }
  return { data: out, w, h };
}

function gradients(img) {
  const { data: s, w, h } = img;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = 0.5 * (s[i + 1] - s[i - 1]);
    gy[i] = 0.5 * (s[i + w] - s[i - w]);
  }
  return { gx, gy };
}

function buildPyramid(gray, w, h, levels) {
  const pyr = [{ data: gray, w, h }];
  for (let l = 1; l < levels; l++) pyr.push(downsample(pyr[l - 1]));
  for (const lv of pyr) Object.assign(lv, gradients(lv));
  return pyr;
}

// Muestreo bilineal (x, y dentro de la imagen)
function bil(s, w, x, y) {
  const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
  return (s[i] * (1 - ax) + s[i + 1] * ax) * (1 - ay) + (s[i + w] * (1 - ax) + s[i + w + 1] * ax) * ay;
}

/* ---------- Detección de esquinas (Shi-Tomasi) ---------- */

// mask: Uint8Array w*h (1 = permitido) o null. Devuelve Float32Array [x0,y0,x1,y1,...]
function detectCorners(img, maxPoints, minDist, mask, quality = 0.01) {
  const { w, h, gx, gy } = img;
  const r = 2, score = new Float32Array(w * h);
  let maxS = 0;
  const b = Math.max(r + 1, 8);
  for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) {
    if (mask && !mask[y * w + x]) continue;
    let a = 0, c = 0, d = 0;
    for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) {
      const i = (y + v) * w + x + u, X = gx[i], Y = gy[i];
      a += X * X; c += Y * Y; d += X * Y;
    }
    const s = 0.5 * (a + c - Math.sqrt((a - c) * (a - c) + 4 * d * d));
    score[y * w + x] = s;
    if (s > maxS) maxS = s;
  }
  const th = maxS * quality;
  if (!(th > 0)) return new Float32Array(0);
  // Un candidato por celda (minDist), el de mayor puntaje
  const cs = Math.max(2, Math.round(minDist));
  const cols = Math.ceil(w / cs), rows = Math.ceil(h / cs);
  const best = new Float32Array(cols * rows), bx = new Int32Array(cols * rows).fill(-1), by = new Int32Array(cols * rows);
  for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) {
    const s = score[y * w + x];
    if (s < th) continue;
    const k = ((y / cs) | 0) * cols + ((x / cs) | 0);
    if (s > best[k]) { best[k] = s; bx[k] = x; by[k] = y; }
  }
  const cand = [];
  for (let k = 0; k < bx.length; k++) if (bx[k] >= 0) cand.push(k);
  cand.sort((p, q) => best[q] - best[p]);
  const n = Math.min(maxPoints, cand.length), out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { out[2 * i] = bx[cand[i]]; out[2 * i + 1] = by[cand[i]]; }
  return out;
}

/* ---------- Lucas-Kanade piramidal ---------- */

function lkPoint(P0, P1, x0, y0, guessX, guessY, r, iters) {
  const L = P0.length;
  let dx = guessX / (1 << (L - 1)) - x0 / (1 << (L - 1));
  let dy = guessY / (1 << (L - 1)) - y0 / (1 << (L - 1));
  let err = 0;
  for (let l = L - 1; l >= 0; l--) {
    const A = P0[l], B = P1[l], w = A.w, h = A.h, sc = 1 / (1 << l);
    const px = x0 * sc, py = y0 * sc;
    if (px - r < 1 || py - r < 1 || px + r >= w - 2 || py + r >= h - 2) return null;
    // Tensor de estructura de la ventana en la imagen de referencia
    let gxx = 0, gyy = 0, gxy = 0;
    const n = (2 * r + 1) * (2 * r + 1);
    const Ix = new Float32Array(n), Iy = new Float32Array(n), I0 = new Float32Array(n);
    let k = 0;
    for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++, k++) {
      const X = bil(A.gx, w, px + u, py + v), Y = bil(A.gy, w, px + u, py + v);
      Ix[k] = X; Iy[k] = Y; I0[k] = bil(A.data, w, px + u, py + v);
      gxx += X * X; gyy += Y * Y; gxy += X * Y;
    }
    const det = gxx * gyy - gxy * gxy;
    const minEig = 0.5 * (gxx + gyy - Math.sqrt((gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy)) / n;
    if (det < 1e-6 || minEig < 1e-3) return null;
    for (let it = 0; it < iters; it++) {
      const qx = px + dx, qy = py + dy;
      if (qx - r < 1 || qy - r < 1 || qx + r >= w - 2 || qy + r >= h - 2) return null;
      let bx = 0, by = 0;
      err = 0;
      k = 0;
      for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++, k++) {
        const diff = I0[k] - bil(B.data, w, qx + u, qy + v);
        bx += diff * Ix[k]; by += diff * Iy[k];
        err += Math.abs(diff);
      }
      const ux = (gyy * bx - gxy * by) / det, uy = (gxx * by - gxy * bx) / det;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < 0.0009) break;
    }
    err /= n;
    if (l > 0) { dx *= 2; dy *= 2; }
  }
  return { x: x0 + dx, y: y0 + dy, err };
}

/* ---------- Seguidor ---------- */

export class Tracker {
  constructor({ maxPoints = 500, minDist = 8, levels = 3, win = 7 } = {}) {
    this.maxPoints = maxPoints;
    this.minDist = minDist;
    this.levels = levels;
    this.win = win;
    this.prevPyr = null;
    this.reset();
  }

  reset() {
    this.tracking = false;
    this.N = 0;
    this.N0 = 0;                        // puntos al fijar la referencia
    this.ref = new Float32Array(0);     // posiciones en la referencia [x0,y0,...]
    this.cur = new Float32Array(0);     // posiciones actuales
    this.alive = new Uint8Array(0);     // 1 si el punto sigue siendo seguido
    this.inl = new Uint8Array(0);       // 1 si fue parte del objeto en la última reconstrucción
    this.col = [];                      // color [r,g,b] de cada punto en la referencia
    this.refImage = null;               // ImageData de la referencia (para la reconstrucción densa)
    this.nAlive = 0;
    this.parallax = 0;
  }

  _pyr(imageData) {
    const g = toGray(imageData.data, imageData.width, imageData.height);
    return buildPyramid(g, imageData.width, imageData.height, this.levels);
  }

  // Fija el fotograma como referencia. roi opcional {x,y,w,h} en píxeles: solo se detectan puntos dentro.
  setReference(imageData, roi = null) {
    const pyr = this._pyr(imageData);
    const w = imageData.width, h = imageData.height;
    let mask = null;
    if (roi) {
      mask = new Uint8Array(w * h);
      const x0 = Math.max(0, roi.x | 0), y0 = Math.max(0, roi.y | 0);
      const x1 = Math.min(w, Math.ceil(roi.x + roi.w)), y1 = Math.min(h, Math.ceil(roi.y + roi.h));
      for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
    }
    this.ref = detectCorners(pyr[0], this.maxPoints, this.minDist, mask);
    this.N = this.N0 = this.ref.length / 2;
    this.cur = this.ref.slice();
    this.alive = new Uint8Array(this.N).fill(1);
    this.inl = new Uint8Array(this.N);
    const d = imageData.data;
    this.col = [];
    for (let i = 0; i < this.N; i++) {
      const o = ((this.ref[2 * i + 1] | 0) * w + (this.ref[2 * i] | 0)) * 4;
      this.col.push([d[o], d[o + 1], d[o + 2]]);
    }
    this.refImage = imageData;
    this.nAlive = this.N;
    this.parallax = 0;
    this.tracking = true;
    this.prevPyr = pyr;
    return this.N;
  }

  aliveIds() {
    const ids = [];
    for (let i = 0; i < this.N; i++) if (this.alive[i]) ids.push(i);
    return ids;
  }

  // Sigue los puntos vivos del fotograma anterior al actual. Devuelve {nAlive, parallax}.
  track(imageData) {
    if (!this.tracking) return null;
    const pyr = this._pyr(imageData);
    const w = imageData.width, h = imageData.height;
    for (let i = 0; i < this.N; i++) {
      if (!this.alive[i]) continue;
      const x = this.cur[2 * i], y = this.cur[2 * i + 1];
      const p = lkPoint(this.prevPyr, pyr, x, y, x, y, this.win, 12);
      if (!p || p.err > 18 || p.x < 2 || p.y < 2 || p.x >= w - 3 || p.y >= h - 3) { this.alive[i] = 0; continue; }
      this.cur[2 * i] = p.x; this.cur[2 * i + 1] = p.y;
    }
    this.prevPyr = pyr;
    const dist = [];
    for (let i = 0; i < this.N; i++) {
      if (this.alive[i]) dist.push(Math.hypot(this.cur[2 * i] - this.ref[2 * i], this.cur[2 * i + 1] - this.ref[2 * i + 1]));
    }
    dist.sort((a, b) => a - b);
    this.nAlive = dist.length;
    this.parallax = dist.length ? dist[dist.length >> 1] : 0;
    return { nAlive: this.nAlive, parallax: this.parallax };
  }
    }
