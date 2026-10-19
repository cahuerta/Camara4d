// tracker.js — Seguimiento y reconocimiento de puntos programado por nosotros (sin librerías externas).
//  · Detección de esquinas Shi-Tomasi (mínimo autovalor del tensor de estructura).
//  · Seguimiento Lucas-Kanade piramidal (3 niveles) cuadro a cuadro.
//  · Cada punto puede llevar su posición 3D en el modelo (para calcular dónde está la cámara).
//  · Firmas binarias de puntos (tipo ORB, hechas aquí) para RECONOCER el objeto cuando se pierde el seguimiento.

export const VERSION = '6';

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
// Las esquinas se reparten por toda la imagen: cada zona (grilla de 8×5) tiene su propio umbral y se toman por
// turnos, para que una zona de mucho contraste (p. ej., el fondo) no se quede con todas y el objeto también tenga.
function detectCorners(img, maxPoints, minDist, mask, quality = 0.01) {
  const { w, h, gx, gy } = img;
  const r = 2, score = new Float32Array(w * h);
  const b = Math.max(r + 1, 8);
  const BX = 8, BY = 5, bw = w / BX, bh = h / BY, bmax = new Float32Array(BX * BY);
  let maxS = 0;
  for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) {
    if (mask && !mask[y * w + x]) continue;
    let a = 0, c = 0, d = 0;
    for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) {
      const i = (y + v) * w + x + u, X = gx[i], Y = gy[i];
      a += X * X; c += Y * Y; d += X * Y;
    }
    const sc = 0.5 * (a + c - Math.sqrt((a - c) * (a - c) + 4 * d * d));
    score[y * w + x] = sc;
    if (sc > maxS) maxS = sc;
    const k = Math.min(BY - 1, (y / bh) | 0) * BX + Math.min(BX - 1, (x / bw) | 0);
    if (sc > bmax[k]) bmax[k] = sc;
  }
  if (!(maxS > 0)) return new Float32Array(0);
  // Umbral por zona (relativo a su máximo) con un mínimo absoluto para no tomar ruido de zonas lisas
  const floor = maxS * 0.002;
  const cs = Math.max(2, Math.round(minDist));
  const cols = Math.ceil(w / cs), rows = Math.ceil(h / cs);
  const best = new Float32Array(cols * rows), bx = new Int32Array(cols * rows).fill(-1), by = new Int32Array(cols * rows);
  for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) {
    const sc = score[y * w + x];
    const k = Math.min(BY - 1, (y / bh) | 0) * BX + Math.min(BX - 1, (x / bw) | 0);
    if (sc < Math.max(floor, bmax[k] * quality * 5)) continue;
    const c = ((y / cs) | 0) * cols + ((x / cs) | 0);
    if (sc > best[c]) { best[c] = sc; bx[c] = x; by[c] = y; }
  }
  // Candidatos agrupados por zona, cada grupo ordenado por puntaje; se toman por turnos
  const groups = [...Array(BX * BY)].map(() => []);
  for (let c = 0; c < bx.length; c++) if (bx[c] >= 0) {
    const k = Math.min(BY - 1, (by[c] / bh) | 0) * BX + Math.min(BX - 1, (bx[c] / bw) | 0);
    groups[k].push(c);
  }
  for (const g of groups) g.sort((p, q) => best[q] - best[p]);
  const out = [];
  for (let round = 0; out.length < 2 * maxPoints; round++) {
    let any = false;
    for (const g of groups) {
      if (round >= g.length) continue;
      any = true;
      const c = g[round];
      out.push(bx[c], by[c]);
      if (out.length >= 2 * maxPoints) break;
    }
    if (!any) break;
  }
  return new Float32Array(out);
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

/* ---------- Seguidor de puntos ---------- */
// Cada punto: { x, y (posición actual), X (posición 3D en el modelo, o null), fid, ox, oy (cuadro y píxel de origen) }.
// Los puntos sin 3D la reciben después, cuando llega la profundidad del cuadro donde nacieron.

export class Tracker {
  constructor({ maxPoints = 400, minDist = 10, levels = 3, win = 7 } = {}) {
    this.maxPoints = maxPoints;
    this.minDist = minDist;
    this.levels = levels;
    this.win = win;
    this.reset();
  }

  reset() {
    this.pts = [];
    this.prevPyr = null;
    this.w = 0; this.h = 0;
  }

  _pyr(imageData) {
    const g = toGray(imageData.data, imageData.width, imageData.height);
    this.w = imageData.width; this.h = imageData.height;
    return buildPyramid(g, imageData.width, imageData.height, this.levels);
  }

  // Primer cuadro (o cuadro desde donde se retoma): solo prepara la imagen
  start(imageData) { this.prevPyr = this._pyr(imageData); }

  get count() { return this.pts.length; }
  get count3D() { let n = 0; for (const p of this.pts) if (p.X) n++; return n; }

  // Sigue todos los puntos del cuadro anterior al actual. Elimina los que se pierden.
  track(imageData) {
    const pyr = this._pyr(imageData);
    if (!this.prevPyr) { this.prevPyr = pyr; return this.count; }
    const w = this.w, h = this.h, out = [];
    for (const p of this.pts) {
      const q = lkPoint(this.prevPyr, pyr, p.x, p.y, p.x, p.y, this.win, 12);
      if (!q || q.err > 18 || q.x < 3 || q.y < 3 || q.x >= w - 4 || q.y >= h - 4) continue;
      p.x = q.x; p.y = q.y;
      out.push(p);
    }
    this.pts = out;
    this.prevPyr = pyr;
    return out.length;
  }

  // Agrega esquinas nuevas en el cuadro actual, lejos de las que ya se siguen.
  // lookup3D(x, y) → [X,Y,Z] o null: posición 3D si el modelo ya cubre ese píxel.
  addCorners(fid, lookup3D, roi = null) {
    if (!this.prevPyr) return 0;
    const lv = this.prevPyr[0], w = lv.w, h = lv.h;
    const room = this.maxPoints - this.pts.length;
    if (room < 20) return 0;
    const mask = new Uint8Array(w * h).fill(1);
    const r = this.minDist;
    for (const p of this.pts) {
      const x0 = Math.max(0, (p.x - r) | 0), x1 = Math.min(w, (p.x + r) | 0), y0 = Math.max(0, (p.y - r) | 0), y1 = Math.min(h, (p.y + r) | 0);
      for (let y = y0; y < y1; y++) mask.fill(0, y * w + x0, y * w + x1);
    }
    if (roi) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
        if (x < roi.x || x >= roi.x + roi.w || y < roi.y || y >= roi.y + roi.h) mask[y * w + x] = 0;
    }
    const c = detectCorners(lv, room, this.minDist, mask);
    const n = c.length / 2;
    for (let i = 0; i < n; i++) {
      const x = c[2 * i], y = c[2 * i + 1];
      this.pts.push({ x, y, ox: x, oy: y, fid, X: lookup3D ? lookup3D(x, y) : null });
    }
    return n;
  }

  // Reemplaza los puntos (al retomar después de reconocer el objeto)
  setPoints(list, imageData) {
    this.start(imageData);
    this.pts = list.map(p => ({ x: p.x, y: p.y, ox: p.x, oy: p.y, fid: -1, X: p.X }));
  }

  // Asigna la posición 3D a los puntos que nacieron en el cuadro fid, usando su mapa de profundidad
  fill3D(fid, depthLookup) {
    let n = 0;
    for (const p of this.pts) {
      if (p.X || p.fid !== fid) continue;
      const X = depthLookup(p.ox, p.oy);
      if (X) { p.X = X; n++; }
    }
    return n;
  }

  // Quita puntos por índice (los que no calzan con la posición calculada)
  removeIdx(set) { this.pts = this.pts.filter((_, i) => !set.has(i)); }
}

/* ---------- Firmas de puntos (para reconocer el objeto) ---------- */
// Firma binaria de 256 bits por punto (tipo ORB): se comparan 256 pares de píxeles alrededor del punto,
// girados según la orientación del punto, sobre la imagen suavizada. Dos firmas se comparan contando
// bits distintos (distancia de Hamming).

const PATTERN = (() => {
  // Pares fijos dentro de un círculo de radio 13 (siempre los mismos: generador con semilla)
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const gauss = () => { let a = 0; for (let i = 0; i < 6; i++) a += rnd(); return (a - 3) * 1.1; };
  const p = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    for (let k = 0; k < 2; k++) {
      let x, y;
      do { x = gauss() * 5; y = gauss() * 5; } while (x * x + y * y > 169);
      p[4 * i + 2 * k] = x; p[4 * i + 2 * k + 1] = y;
    }
  }
  return p;
})();

// Suavizado 5x5 (caja) con imagen integral
function blur5(g, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - 2), x1 = Math.min(w, x + 3), y0 = Math.max(0, y - 2), y1 = Math.min(h, y + 3);
    out[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

function describeLevel(lv, maxPts, scale, kps, descs) {
  const { data: g, w, h } = lv;
  const sm = blur5(g, w, h);
  const B = 18;
  const mask = new Uint8Array(w * h);
  for (let y = B; y < h - B; y++) mask.fill(1, y * w + B, y * w + w - B);
  const c = detectCorners(lv, maxPts, 6, mask, 0.02);
  const n = c.length / 2;
  for (let i = 0; i < n; i++) {
    const x = Math.round(c[2 * i]), y = Math.round(c[2 * i + 1]);
    // Orientación: centroide de intensidad en un círculo de radio 12
    let m10 = 0, m01 = 0;
    for (let v = -12; v <= 12; v++) for (let u = -12; u <= 12; u++) {
      if (u * u + v * v > 144) continue;
      const val = g[(y + v) * w + x + u];
      m10 += u * val; m01 += v * val;
    }
    const a = Math.atan2(m01, m10), ca = Math.cos(a), sa = Math.sin(a);
    const d = new Uint32Array(8);
    for (let k = 0; k < 256; k++) {
      const px = PATTERN[4 * k], py = PATTERN[4 * k + 1], qx = PATTERN[4 * k + 2], qy = PATTERN[4 * k + 3];
      const ax = Math.round(x + ca * px - sa * py), ay = Math.round(y + sa * px + ca * py);
      const bx = Math.round(x + ca * qx - sa * qy), by = Math.round(y + sa * qx + ca * qy);
      if (sm[ay * w + ax] < sm[by * w + bx]) d[k >> 5] |= (1 << (k & 31));
    }
    kps.push(x * scale, y * scale);
    descs.push(d);
  }
}

// Firmas del cuadro: en tamaño completo y a la mitad (para reconocer también de más cerca o más lejos)
export function computeFeatures(imageData, maxPts = 400) {
  const pyr = buildPyramid(toGray(imageData.data, imageData.width, imageData.height), imageData.width, imageData.height, 2);
  const kps = [], descs = [];
  describeLevel(pyr[0], Math.round(maxPts * 0.7), 1, kps, descs);
  describeLevel(pyr[1], Math.round(maxPts * 0.3), 2, kps, descs);
  const n = descs.length, desc = new Uint32Array(n * 8);
  descs.forEach((d, i) => desc.set(d, 8 * i));
  return { n, kp: new Float32Array(kps), desc };
}

function popcnt(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Empareja firmas: para cada firma de A, la más parecida de B (si es claramente mejor que la segunda)
export function matchFeatures(dA, nA, dB, nB, maxDist = 64, ratio = 0.8) {
  const out = [];
  for (let i = 0; i < nA; i++) {
    let b1 = 999, b2 = 999, j1 = -1;
    const o = 8 * i;
    for (let j = 0; j < nB; j++) {
      const p = 8 * j;
      let d = 0;
      for (let k = 0; k < 8 && d < b2; k++) d += popcnt(dA[o + k] ^ dB[p + k]);
      if (d < b1) { b2 = b1; b1 = d; j1 = j; } else if (d < b2) b2 = d;
    }
    if (j1 >= 0 && b1 <= maxDist && b1 < ratio * b2) out.push([i, j1, b1]);
  }
  return out;
}

// Miniatura de la imagen (para elegir rápido con qué vistas guardadas comparar)
export function thumbnail(imageData, tw = 32, th = 18) {
  const { data, width: W, height: H } = imageData, out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let s = 0, n = 0;
    const x0 = Math.floor(x * W / tw), x1 = Math.floor((x + 1) * W / tw), y0 = Math.floor(y * H / th), y1 = Math.floor((y + 1) * H / th);
    for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {
      const o = (yy * W + xx) * 4; s += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]; n++;
    }
    out[y * tw + x] = s / n;
  }
  let m = 0; for (const v of out) m += v; m /= out.length;
  let sd = 0; for (const v of out) sd += (v - m) ** 2; sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
  return out;
          }
                                              
