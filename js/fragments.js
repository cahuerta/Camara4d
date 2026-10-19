// fragments.js — MODELO ÚNICO de la captura (antes: fragmentos) y TOMAS.
//  · Modelo: todos los puntos medidos van a un mismo espacio 3D, dividido en cubitos (vóxeles). Cada cubito
//    promedia posición y color de todas las mediciones que caen en él y cuenta desde cuántas vistas se vio.
//    El modelo solo crece: nada se borra hasta que se pulsa «Nueva captura».
//  · Vistas guardadas: firmas de puntos con su posición 3D, para reconocer el objeto desde cualquier cara.
//  · Toma: el modelo + sus vistas, empaquetado para guardar en el teléfono y subir al servidor, que une tomas.

export const VERSION = '3';

const OFF = 32768, SH = 65536;
const keyOf = (ix, iy, iz) => ((ix + OFF) * SH + (iy + OFF)) * SH + (iz + OFF);

// Pose: p_cam = R·X + t. Centro de la cámara en el modelo: C = −Rᵀ·t
export function camCenter(R, t) {
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

const mv3 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const mul3 = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[3 * i + j] += A[3 * i + k] * B[3 * k + j]; return C; };
const tr3 = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const det3 = A => A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);

// Pose de cámara (p_cam = R·x + t) expresada en el espacio destino de la semejanza T (X = s·Rt·x + tt).
// La cámara queda en las unidades del destino: R' = R·Rtᵀ, t' = s·t − R'·tt
export function movePose(R, t, T) {
  const R2 = mul3(R, tr3(T.R)), q = mv3(R2, T.t);
  return { R: R2, t: [T.s * t[0] - q[0], T.s * t[1] - q[1], T.s * t[2] - q[2]] };
}

/* ---------- Limpieza del fondo (automática) ---------- */
function cleanCloud(base, obj, vox) {
  const P = base.map(v => [v.x / v.n, v.y / v.n, v.z / v.n]);
  let keep = new Uint8Array(P.length).fill(1);
  // 1. Superficies de apoyo: hasta 2 planos grandes que se extienden más allá del objeto
  const tol = 1.5 * vox;
  for (let pass = 0; pass < 2; pass++) {
    const idx = [];
    for (let i = 0; i < P.length; i++) if (keep[i]) idx.push(i);
    if (idx.length < 200) break;
    const samp = [];
    const stepS = Math.max(1, idx.length / 3000);
    for (let i = 0; i < idx.length; i += stepS) samp.push(P[idx[Math.floor(i)]]);
    let best = null, bestN = 0;
    for (let it = 0; it < 250; it++) {
      const a = samp[(Math.random() * samp.length) | 0], b = samp[(Math.random() * samp.length) | 0], c = samp[(Math.random() * samp.length) | 0];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], nn = Math.hypot(...n);
      if (nn < 1e-12) continue;
      n[0] /= nn; n[1] /= nn; n[2] /= nn;
      const d = -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
      let cnt = 0;
      for (const p of samp) if (Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + d) < tol) cnt++;
      if (cnt > bestN) { bestN = cnt; best = { n, d }; }
    }
    if (!best || bestN < 0.12 * samp.length) break;
    const { n, d } = best, dist = p => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + d;
    // ¿Es del objeto? Una cara plana del objeto queda dentro de su esfera; la mesa sigue más allá.
    let inPl = 0, outside = 0;
    for (const i of idx) if (Math.abs(dist(P[i])) < tol) { inPl++; if (obj && Math.hypot(P[i][0] - obj.c[0], P[i][1] - obj.c[1], P[i][2] - obj.c[2]) > obj.r) outside++; }
    if (obj) {
      if (outside < 0.3 * inPl) break;
      if (Math.abs(dist(obj.c)) < 3 * tol) break;   // el plano pasa por el centro del objeto: no es un apoyo
    }
    // Lado del objeto: el del centro (o el de la mayoría de los puntos)
    let side = obj ? Math.sign(dist(obj.c)) : 0;
    if (!side) { let pos = 0; for (const i of idx) if (dist(P[i]) > tol) pos++; side = pos > idx.length / 2 ? 1 : -1; }
    for (const i of idx) if (side * dist(P[i]) < 2 * tol) keep[i] = 0;
  }
  // 2. Esfera del objeto
  if (obj) for (let i = 0; i < P.length; i++) if (keep[i] && Math.hypot(P[i][0] - obj.c[0], P[i][1] - obj.c[1], P[i][2] - obj.c[2]) > obj.r) keep[i] = 0;
  // 3. Bloque conectado: celdas de 2 cubitos; se queda el grupo mayor y los que tengan al menos 1/4 de su tamaño
  const cell = 2 * vox, cells = new Map();
  for (let i = 0; i < P.length; i++) {
    if (!keep[i]) continue;
    const k = keyOf(Math.floor(P[i][0] / cell), Math.floor(P[i][1] / cell), Math.floor(P[i][2] / cell));
    let a = cells.get(k);
    if (!a) cells.set(k, a = { pts: [], comp: -1, ix: Math.floor(P[i][0] / cell), iy: Math.floor(P[i][1] / cell), iz: Math.floor(P[i][2] / cell) });
    a.pts.push(i);
  }
  const sizes = [];
  for (const c of cells.values()) {
    if (c.comp >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [c];
    c.comp = id;
    while (stack.length) {
      const q = stack.pop();
      size += q.pts.length;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
        const nb = cells.get(keyOf(q.ix + a, q.iy + b, q.iz + e));
        if (nb && nb.comp < 0) { nb.comp = id; stack.push(nb); }
      }
    }
    sizes.push(size);
  }
  const big = Math.max(0, ...sizes);
  const out = [];
  for (const c of cells.values()) if (sizes[c.comp] >= 0.25 * big) for (const i of c.pts) out.push(base[i]);
  return out;
}

/* ---------- Alinear dos modelos (tramos o tomas) con sus firmas de puntos ----------
   Devuelve T = { s, R, t } que lleva B al espacio de A (X_A = s·R·x_B + t), o null si no comparten una zona clara. */
function popcnt(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function svd3(M) {
  // Autovectores de MᵀM (Jacobi) → SVD 3×3
  const S = mul3(tr3(M), M), A = S.slice(), V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sw = 0; sw < 30; sw++) {
    let off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
    if (off < 1e-24) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[3 * p + q];
      if (Math.abs(apq) < 1e-30) continue;
      const th = (A[3 * q + q] - A[3 * p + p]) / (2 * apq), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const a = A[3 * k + p], b = A[3 * k + q]; A[3 * k + p] = c * a - s * b; A[3 * k + q] = s * a + c * b; }
      for (let k = 0; k < 3; k++) { const a = A[3 * p + k], b = A[3 * q + k]; A[3 * p + k] = c * a - s * b; A[3 * q + k] = s * a + c * b; }
      for (let k = 0; k < 3; k++) { const a = V[3 * k + p], b = V[3 * k + q]; V[3 * k + p] = c * a - s * b; V[3 * k + q] = s * a + c * b; }
    }
  }
  const ord = [0, 1, 2].sort((i, j) => A[4 * j] - A[4 * i]);
  const v = ord.map(o => [V[o], V[3 + o], V[6 + o]]), sv = ord.map(o => Math.sqrt(Math.max(A[4 * o], 0)));
  const u = v.map(vv => { const w = mv3(M, vv), n = Math.hypot(...w) || 1; return w.map(x => x / n); });
  if (sv[2] < 1e-9 * (sv[0] || 1)) u[2] = [u[0][1] * u[1][2] - u[0][2] * u[1][1], u[0][2] * u[1][0] - u[0][0] * u[1][2], u[0][0] * u[1][1] - u[0][1] * u[1][0]];
  return { U: [u[0][0], u[1][0], u[2][0], u[0][1], u[1][1], u[2][1], u[0][2], u[1][2], u[2][2]], S: sv, V: [v[0][0], v[1][0], v[2][0], v[0][1], v[1][1], v[2][1], v[0][2], v[1][2], v[2][2]] };
}
export function umeyama(A, B) {
  const n = A.length;
  if (n < 3) return null;
  const ma = [0, 0, 0], mb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { ma[k] += A[i][k] / n; mb[k] += B[i][k] / n; }
  const Sg = new Array(9).fill(0);
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const a = [A[i][0] - ma[0], A[i][1] - ma[1], A[i][2] - ma[2]], b = [B[i][0] - mb[0], B[i][1] - mb[1], B[i][2] - mb[2]];
    vb += (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) / n;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Sg[3 * r + c] += a[r] * b[c] / n;
  }
  if (vb < 1e-12) return null;
  const { U, S, V } = svd3(Sg);
  const D = [1, 1, det3(U) * det3(V) < 0 ? -1 : 1];
  const R = mul3([U[0] * D[0], U[1] * D[1], U[2] * D[2], U[3] * D[0], U[4] * D[1], U[5] * D[2], U[6] * D[0], U[7] * D[1], U[8] * D[2]], tr3(V));
  const s = (S[0] * D[0] + S[1] * D[1] + S[2] * D[2]) / vb, Rm = mv3(R, mb);
  return { s, R, t: [ma[0] - s * Rm[0], ma[1] - s * Rm[1], ma[2] - s * Rm[2]] };
}
const simApply = (T, p) => { const q = mv3(T.R, p); return [T.s * q[0] + T.t[0], T.s * q[1] + T.t[1], T.s * q[2] + T.t[2]]; };

function pool(m, max) {
  let total = 0;
  for (const k of m.kfs) total += k.n;
  const step = Math.max(1, total / max), desc = [], X = [];
  let acc = 0;
  for (const k of m.kfs) for (let i = 0; i < k.n; i++) {
    if ((acc += 1) < step) continue;
    acc -= step;
    desc.push(k.desc.subarray(8 * i, 8 * i + 8));
    X.push([k.X[3 * i], k.X[3 * i + 1], k.X[3 * i + 2]]);
  }
  return { desc, X };
}

export function alignModels(A, B, { max = 1500, minInl = 25 } = {}) {
  if (!A.kfs.length || !B.kfs.length) return null;
  const qa = pool(A, max), qb = pool(B, max), tau = 3 * A.voxel, sep2 = (4 * tau) ** 2;
  // Parejas de firmas (la segunda mejor se busca solo entre puntos de otro lugar)
  const pairs = [], dist = new Uint16Array(qa.desc.length);
  for (let i = 0; i < qb.desc.length; i++) {
    const db = qb.desc[i];
    let b1 = 999, j1 = -1;
    for (let j = 0; j < qa.desc.length; j++) {
      const da = qa.desc[j];
      let d = 0;
      for (let k = 0; k < 8; k++) d += popcnt(db[k] ^ da[k]);
      dist[j] = d;
      if (d < b1) { b1 = d; j1 = j; }
    }
    if (j1 < 0 || b1 > 64) continue;
    const X1 = qa.X[j1];
    let b2 = 999;
    for (let j = 0; j < qa.desc.length; j++) {
      if (dist[j] >= b2) continue;
      const Y = qa.X[j];
      if ((Y[0] - X1[0]) ** 2 + (Y[1] - X1[1]) ** 2 + (Y[2] - X1[2]) ** 2 > sep2) b2 = dist[j];
    }
    if (b1 < 0.8 * b2) pairs.push([qa.X[j1], qb.X[i], b1]);
  }
  if (pairs.length < minInl) return null;
  pairs.sort((a, b) => a[2] - b[2]);
  const dd = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  let best = null, bestInl = [];
  for (let it = 0; it < 6000; it++) {
    const poolN = Math.min(pairs.length, 30 + Math.floor(it / 20));
    const i0 = (Math.random() * poolN) | 0, i1 = (Math.random() * poolN) | 0, i2 = (Math.random() * poolN) | 0;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const S = [pairs[i0], pairs[i1], pairs[i2]];
    const a01 = dd(S[0][0], S[1][0]), a02 = dd(S[0][0], S[2][0]), a12 = dd(S[1][0], S[2][0]);
    if (a01 < 3 * tau || a02 < 3 * tau || a12 < 3 * tau) continue;
    const r01 = a01 / dd(S[0][1], S[1][1]), r02 = a02 / dd(S[0][1], S[2][1]), r12 = a12 / dd(S[1][1], S[2][1]);
    if (!(Math.max(r01, r02, r12) < 1.15 * Math.min(r01, r02, r12))) continue;
    const T = umeyama(S.map(p => p[0]), S.map(p => p[1]));
    if (!T || !(T.s > 0.05 && T.s < 20)) continue;
    const inl = [];
    for (let i = 0; i < pairs.length; i++) { const q = simApply(T, pairs[i][1]), a = pairs[i][0]; if ((q[0] - a[0]) ** 2 + (q[1] - a[1]) ** 2 + (q[2] - a[2]) ** 2 < tau * tau) inl.push(i); }
    if (inl.length > bestInl.length) { best = T; bestInl = inl; }
  }
  if (!best || bestInl.length < minInl || bestInl.length < 0.1 * pairs.length) return null;
  const T = umeyama(bestInl.map(i => pairs[i][0]), bestInl.map(i => pairs[i][1])) || best;
  return { ...T, inl: bestInl.length, pairs: pairs.length };
}

export class Model {
  constructor() { this.clear(); }

  clear() {
    this.vox = new Map();      // clave → { x, y, z, r, g, b (sumas), n (mediciones), v (vistas), last }
    this.kfs = [];             // vistas guardadas con firmas: { id, R, t, n, kp, desc, X, thumb }
    this.voxel = 0.006;        // tamaño del cubito (la escala del modelo: profundidad típica ≈ 1)
    this.obj = null;           // esfera del objeto { c, r } para limpiar el fondo
    this.depthMaps = 0;
    this.maps = [];            // mapas de profundidad guardados (para descartar lo que otra vista ve a través)
    this.dirty = true;
  }

  // ¿Esta vista ve a través del punto? (en su píxel mide una superficie claramente más lejos)
  static _seesThrough(m, X, Y, Z, s) {
    const R = m.R, t = m.t;
    const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (zc <= 0) return false;
    const u = Math.round(m.f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / zc + m.cx), v = Math.round(m.f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / zc + m.cy);
    if (u < 0 || v < 0 || u >= m.w || v >= m.h) return false;
    const d = m.depth[v * m.w + u];
    return d > 0 && d > zc + Math.max(0.05 * zc, 4 * s);
  }

  get voxels() { return this.vox.size; }

  // Suma un mapa de profundidad (vista con pose R,t) al modelo
  fuseDepth(dm, R, t, kfId) {
    const { w, h, f, cx, cy, depth, rgb } = dm, s = this.voxel;
    const map = { R: R.slice(), t: t.slice(), f, cx, cy, w, h, depth: Float32Array.from(depth) };
    // Lo ya medido que esta vista atraviesa (ve el fondo detrás): voto en contra
    for (const v of this.vox.values())
      if (Model._seesThrough(map, v.x / v.n, v.y / v.n, v.z / v.n, s)) v.m++;
    const fresh = [];
    let added = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, d = depth[i];
      if (!(d > 0)) continue;
      const a = d * (x - cx) / f - t[0], b = d * (y - cy) / f - t[1], c = d - t[2];
      const X = R[0] * a + R[3] * b + R[6] * c, Y = R[1] * a + R[4] * b + R[7] * c, Z = R[2] * a + R[5] * b + R[8] * c;
      const k = keyOf(Math.floor(X / s), Math.floor(Y / s), Math.floor(Z / s));
      let v = this.vox.get(k);
      if (!v) { v = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, n: 0, v: 0, m: 0, last: -1 }; this.vox.set(k, v); fresh.push(v); }
      v.x += X; v.y += Y; v.z += Z;
      v.r += rgb[3 * i]; v.g += rgb[3 * i + 1]; v.b += rgb[3 * i + 2];
      v.n++;
      if (v.last !== kfId) { v.v++; v.last = kfId; }
      added++;
    }
    // Lo nuevo, contra las vistas anteriores
    for (const v of fresh) {
      const X = v.x / v.n, Y = v.y / v.n, Z = v.z / v.n;
      for (const m of this.maps) if (Model._seesThrough(m, X, Y, Z, s)) v.m++;
    }
    this.maps.push(map);
    if (this.maps.length > 120) this.maps.shift();
    this.depthMaps++;
    this.dirty = true;
    return added;
  }

  // Esfera del objeto a partir de puntos 3D (los del recuadro o del centro de la imagen)
  setObject(points) {
    if (points.length < 30) return false;
    const med = a => { const q = a.slice().sort((x, y) => x - y); return q[q.length >> 1]; };
    const c = [med(points.map(p => p[0])), med(points.map(p => p[1])), med(points.map(p => p[2]))];
    const d = points.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).sort((a, b) => a - b);
    this.obj = { c, r: Math.max(d[Math.floor(d.length * 0.9)] * 2.2, 8 * this.voxel) };
    this.dirty = true;
    return true;
  }

  // Cubitos que se muestran: vistos desde 2+ vistas (cuando ya hay 3+ mapas) y que ninguna otra vista atraviesa.
  // Con «limpiar fondo», además (todo automático):
  //   1. se quita la superficie de apoyo (mesa, suelo, pared): planos grandes que siguen más allá del objeto,
  //      junto con lo que quede al otro lado de ellos;
  //   2. se deja solo lo que está dentro de la esfera del objeto;
  //   3. se deja solo el bloque de puntos conectado (los grupos sueltos e islas del fondo se van).
  _visible(clean, force = false) {
    const minV = this.depthMaps >= 3 ? 2 : 1, base = [];
    for (const v of this.vox.values()) if (v.v >= minV && !(v.m > v.v)) base.push(v);
    if (!clean || base.length < 50) return base;
    const key = this.vox.size + ':' + this.depthMaps + ':' + (this.obj ? this.obj.c.join(',') + ',' + this.obj.r : '-');
    const now = Date.now();
    if (this._clean && (this._clean.key === key || (!force && now - this._clean.at < 1500))) return this._clean.out;
    const out = cleanCloud(base, this.obj, this.voxel);
    this._clean = { key, at: now, out };
    return out;
  }

  // Nube para el visor: [x, y, z, w, r, g, b, tamaño], centrada y normalizada (y hacia arriba)
  cloud(clean, maxPts = 60000, force = false) {
    const vis = this._visible(clean, force);
    if (vis.length < 20) return null;
    const step = Math.max(1, Math.ceil(vis.length / maxPts));
    const P = [];
    for (let i = 0; i < vis.length; i += step) {
      const v = vis[i];
      P.push([v.x / v.n, v.y / v.n, v.z / v.n, v.r / v.n, v.g / v.n, v.b / v.n]);
    }
    const med = a => { const q = a.slice().sort((x, y) => x - y); return q[q.length >> 1]; };
    const c = this.obj && clean ? this.obj.c : [med(P.map(p => p[0])), med(P.map(p => p[1])), med(P.map(p => p[2]))];
    const sc = med(P.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))) || 1;
    const size = this.voxel * 1.6 / sc;
    return P.map(p => {
      const L = (0.299 * p[3] + 0.587 * p[4] + 0.114 * p[5]) / 255;
      return [(p[0] - c[0]) / sc, -(p[1] - c[1]) / sc, -(p[2] - c[2]) / sc, (L - 0.5) * 2, p[3], p[4], p[5], size];
    });
  }

  countVisible(clean) { return this._visible(clean).length; }

  /* ---------- Unir otro modelo (otro tramo de la misma captura) a este ----------
     T = { s, R, t } lleva puntos del otro modelo a este: X = s·R·x + t */
  absorb(B, T) {
    const sim = p => { const q = mv3(T.R, p); return [T.s * q[0] + T.t[0], T.s * q[1] + T.t[1], T.s * q[2] + T.t[2]]; };
    const s = this.voxel;
    for (const v of B.vox.values()) {
      const P = sim([v.x / v.n, v.y / v.n, v.z / v.n]);
      const k = keyOf(Math.floor(P[0] / s), Math.floor(P[1] / s), Math.floor(P[2] / s));
      let e = this.vox.get(k);
      if (!e) { e = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, n: 0, v: 0, m: 0, last: v.last }; this.vox.set(k, e); }
      e.x += P[0] * v.n; e.y += P[1] * v.n; e.z += P[2] * v.n;
      e.r += v.r; e.g += v.g; e.b += v.b; e.n += v.n;
      e.v += v.v; e.m += v.m || 0;
    }
    for (const m of B.maps) {
      const p = movePose(m.R, m.t, T);
      const depth = new Float32Array(m.depth.length);
      for (let i = 0; i < depth.length; i++) depth[i] = m.depth[i] * T.s;
      this.maps.push({ ...m, R: p.R, t: p.t, depth });
    }
    while (this.maps.length > 120) this.maps.shift();
    for (const k of B.kfs) {
      const p = movePose(k.R, k.t, T), X = new Float32Array(k.X.length);
      for (let i = 0; i < k.n; i++) { const q = sim([k.X[3 * i], k.X[3 * i + 1], k.X[3 * i + 2]]); X[3 * i] = q[0]; X[3 * i + 1] = q[1]; X[3 * i + 2] = q[2]; }
      this.kfs.push({ ...k, R: p.R, t: p.t, X });
    }
    if (!this.obj && B.obj) this.obj = { c: sim(B.obj.c), r: B.obj.r * T.s };
    this.depthMaps += B.depthMaps;
    this.dirty = true;
  }

  // Proyecta el modelo en una vista (a 1/factor de resolución): profundidad más cercana y vistas por píxel.
  // Sirve para dar posición 3D a puntos nuevos y para el mapa de cobertura del asistente.
  project(R, t, f, cx, cy, W, H, factor = 4) {
    const w = Math.ceil(W / factor), h = Math.ceil(H / factor);
    const depth = new Float32Array(w * h), views = new Uint8Array(w * h);
    const fl = f / factor, cxl = cx / factor, cyl = cy / factor;
    for (const v of this.vox.values()) {
      const X = v.x / v.n, Y = v.y / v.n, Z = v.z / v.n;
      const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (z <= 1e-3) continue;
      const u = Math.floor(fl * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / z + cxl);
      const q = Math.floor(fl * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / z + cyl);
      if (u < 0 || q < 0 || u >= w || q >= h) continue;
      const k = q * w + u;
      if (!depth[k] || z < depth[k]) { depth[k] = z; views[k] = Math.min(255, v.v); }
    }
    return { w, h, factor, depth, views };
  }

  // Posición 3D (en el modelo) del píxel (x, y) de una vista con pose R,t, usando una proyección del modelo
  static lookup(pr, R, t, f, cx, cy, x, y) {
    const u = Math.floor(x / pr.factor), q = Math.floor(y / pr.factor);
    let best = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const uu = u + a, qq = q + b;
      if (uu < 0 || qq < 0 || uu >= pr.w || qq >= pr.h) continue;
      const d = pr.depth[qq * pr.w + uu];
      if (d > 0 && (!best || d < best)) best = d;
    }
    if (!best) return null;
    return toWorld(R, t, best * (x - cx) / f, best * (y - cy) / f, best);
  }

  // Vista guardada (para reconocer): firmas de los puntos que tienen posición 3D
  addKeyframe(id, R, t, feats, X, thumb) {
    const keep = [];
    for (let i = 0; i < feats.n; i++) if (X[3 * i] === X[3 * i]) keep.push(i);   // sin NaN
    const n = keep.length;
    if (n < 15) return null;
    const kp = new Float32Array(2 * n), desc = new Uint32Array(8 * n), XX = new Float32Array(3 * n);
    keep.forEach((i, k) => {
      kp[2 * k] = feats.kp[2 * i]; kp[2 * k + 1] = feats.kp[2 * i + 1];
      desc.set(feats.desc.subarray(8 * i, 8 * i + 8), 8 * k);
      XX[3 * k] = X[3 * i]; XX[3 * k + 1] = X[3 * i + 1]; XX[3 * k + 2] = X[3 * i + 2];
    });
    const kf = { id, R: R.slice(), t: t.slice(), n, kp, desc, X: XX, thumb };
    this.kfs.push(kf);
    return kf;
  }

  /* ---------- Toma: empaquetar y desempaquetar ---------- */

  toToma(meta) {
    const all = [...this.vox.values()].filter(v => v.v >= 1 && !(v.m > v.v));
    const n = all.length, xyz = new Float32Array(3 * n), rgb = new Uint8Array(3 * n), vistas = new Uint8Array(n);
    all.forEach((v, i) => {
      xyz[3 * i] = v.x / v.n; xyz[3 * i + 1] = v.y / v.n; xyz[3 * i + 2] = v.z / v.n;
      rgb[3 * i] = v.r / v.n; rgb[3 * i + 1] = v.g / v.n; rgb[3 * i + 2] = v.b / v.n;
      vistas[i] = Math.min(255, v.v);
    });
    return {
      formato: 'camara4d-toma', version: 1,
      id: meta.id, nombre: meta.nombre, fecha: meta.fecha, origen: meta.origen || 'telefono',
      voxel: this.voxel, intr: meta.intr, objeto: this.obj, mapas: this.depthMaps,
      puntos: { n, xyz: b64(xyz), rgb: b64(rgb), vistas: b64(vistas) },
      vistas: this.kfs.map(k => ({ R: k.R, t: k.t, n: k.n, kp: b64(k.kp), desc: b64(k.desc), X: b64(k.X) }))
    };
  }

  // Carga una toma (propia o unida en el servidor) para verla en el visor
  static fromToma(T) {
    const m = new Model();
    m.voxel = T.voxel || 0.006;
    m.obj = T.objeto || null;
    m.depthMaps = Math.max(3, T.mapas || 3);
    const xyz = new Float32Array(unb64(T.puntos.xyz)), rgb = new Uint8Array(unb64(T.puntos.rgb)), vis = new Uint8Array(unb64(T.puntos.vistas));
    for (let i = 0; i < T.puntos.n; i++) {
      const X = xyz[3 * i], Y = xyz[3 * i + 1], Z = xyz[3 * i + 2], s = m.voxel;
      m.vox.set(keyOf(Math.floor(X / s), Math.floor(Y / s), Math.floor(Z / s)),
        { x: X, y: Y, z: Z, r: rgb[3 * i], g: rgb[3 * i + 1], b: rgb[3 * i + 2], n: 1, v: vis[i], last: -1 });
    }
    return m;
  }
}

export function toWorld(R, t, a0, b0, c0) {
  const a = a0 - t[0], b = b0 - t[1], c = c0 - t[2];
  return [R[0] * a + R[3] * b + R[6] * c, R[1] * a + R[4] * b + R[7] * c, R[2] * a + R[5] * b + R[8] * c];
}

/* ---------- Base64 de arreglos binarios ---------- */
export function b64(typed) {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

/* ---------- Tomas guardadas en el teléfono (IndexedDB: persisten aunque se cierre la página) ---------- */
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('camara4d', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tomas', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('tomas', mode), st = t.objectStore('tomas');
    const r = fn(st);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const localTomas = {
  save: T => tx('readwrite', st => st.put(T)),
  get: id => tx('readonly', st => st.get(id)),
  remove: id => tx('readwrite', st => st.delete(id)),
  async list() {
    const all = await tx('readonly', st => st.getAll());
    return (all || []).map(T => ({ id: T.id, nombre: T.nombre, fecha: T.fecha, puntos: T.puntos.n, vistas: T.vistas.length }))
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  }
};

/* ---------- Servidor que une tomas ---------- */
export function serverApi(base) {
  const url = p => base.replace(/\/+$/, '') + p;
  const j = async r => { if (!r.ok) throw new Error('servidor ' + r.status + ': ' + (await r.text()).slice(0, 120)); return r.json(); };
  return {
    health: () => fetch(url('/health')).then(j),
    list: () => fetch(url('/tomas')).then(j),
    has: id => fetch(url('/tomas/' + encodeURIComponent(id)), { method: 'HEAD' }).then(r => r.ok),
    get: id => fetch(url('/tomas/' + encodeURIComponent(id))).then(j),
    upload: T => fetch(url('/tomas'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(T) }).then(j),
    merge: ids => fetch(url('/unir'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(j)
  };
                                                                       }
  
