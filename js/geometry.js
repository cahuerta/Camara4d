// geometry.js — Geometría multivista pura (sin DOM ni OpenCV).
// Estima la pose relativa entre la referencia y el fotograma actual (matriz esencial, 8 puntos + RANSAC)
// y triangula los puntos. Convención: X2 = R·X1 + t, con t de norma 1 (escala relativa).

export const VERSION = '4';

export const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[3 * i + j] += A[3 * i + k] * B[3 * k + j];
  return C;
};
export const tr3 = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
export const mv3 = (A, v) => [
  A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
  A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
  A[6] * v[0] + A[7] * v[1] + A[8] * v[2]
];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const median = a => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

// Autovalores/autovectores de una matriz simétrica nxn (Jacobi). V[i*n+j] = componente i del autovector j.
export function jacobi(S, n) {
  const A = S.slice(), V = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sw = 0; sw < 40; sw++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i * n + j] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p * n + q];
      if (Math.abs(apq) < 1e-30) continue;
      const th = (A[q * n + q] - A[p * n + p]) / (2 * apq);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const a = A[k * n + p], b = A[k * n + q]; A[k * n + p] = c * a - s * b; A[k * n + q] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = A[p * n + k], b = A[q * n + k]; A[p * n + k] = c * a - s * b; A[q * n + k] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = V[k * n + p], b = V[k * n + q]; V[k * n + p] = c * a - s * b; V[k * n + q] = s * a + c * b; }
    }
  }
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(A[i * n + i]);
  return { vals, V };
}

// Algoritmo de 8 puntos: x2ᵀ E x1 = 0
export function eightPoint(idx, X1, X2) {
  const S = new Array(81).fill(0);
  for (const i of idx) {
    const [a, b] = X1[i], [c, d] = X2[i];
    const r = [c * a, c * b, c, d * a, d * b, d, a, b, 1];
    for (let p = 0; p < 9; p++) for (let q = 0; q < 9; q++) S[p * 9 + q] += r[p] * r[q];
  }
  const { vals, V } = jacobi(S, 9);
  let m = 0;
  for (let i = 1; i < 9; i++) if (vals[i] < vals[m]) m = i;
  const e = [];
  for (let i = 0; i < 9; i++) e.push(V[i * 9 + m]);
  return e;
}

// SVD de E vía autovalores de EᵀE; fuerza rango 2 y valores singulares (1,1,0).
export function svdE(E) {
  const { vals, V } = jacobi(mul3(tr3(E), E), 3);
  const ord = [0, 1, 2].sort((i, j) => vals[j] - vals[i]);
  const v0 = [V[ord[0]], V[3 + ord[0]], V[6 + ord[0]]];
  const v1 = [V[ord[1]], V[3 + ord[1]], V[6 + ord[1]]];
  const s0 = Math.sqrt(Math.max(vals[ord[0]], 1e-30)), s1 = Math.sqrt(Math.max(vals[ord[1]], 1e-30));
  const u0 = mv3(E, v0).map(x => x / s0), u1 = mv3(E, v1).map(x => x / s1);
  const v2 = cross(v0, v1), u2 = cross(u0, u1);
  const U = [u0[0], u1[0], u2[0], u0[1], u1[1], u2[1], u0[2], u1[2], u2[2]];
  const Vm = [v0[0], v1[0], v2[0], v0[1], v1[1], v2[1], v0[2], v1[2], v2[2]];
  const Ec = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Ec.push(u0[i] * v0[j] + u1[i] * v1[j]);
  return { E: Ec, U, V: Vm };
}

// Distancia de Sampson al cuadrado (en coordenadas normalizadas).
export function sampson2(E, x1, x2) {
  const a = [x1[0], x1[1], 1], b = [x2[0], x2[1], 1];
  const Ea = mv3(E, a), Etb = mv3(tr3(E), b);
  const num = dot(b, Ea) ** 2;
  const den = Ea[0] ** 2 + Ea[1] ** 2 + Etb[0] ** 2 + Etb[1] ** 2;
  return den > 1e-30 ? num / den : 1e9;
}

export function ransacE(X1, X2, f) {
  const N = X1.length;
  if (N < 14) return null;
  const th2 = (2.0 / f) ** 2;
  let best = null, bestN = 0;
  for (let it = 0; it < 250; it++) {
    const idx = new Set();
    while (idx.size < 8) idx.add((Math.random() * N) | 0);
    const s = svdE(eightPoint([...idx], X1, X2));
    let cnt = 0;
    for (let i = 0; i < N; i++) if (sampson2(s.E, X1[i], X2[i]) < th2) cnt++;
    if (cnt > bestN) { bestN = cnt; best = s; }
  }
  if (!best || bestN < 12) return null;
  let inl = [];
  for (let i = 0; i < N; i++) if (sampson2(best.E, X1[i], X2[i]) < th2) inl.push(i);
  for (let r = 0; r < 2; r++) { // refinar con todos los inliers
    const s = svdE(eightPoint(inl, X1, X2));
    best = s;
    const n2 = [];
    for (let i = 0; i < N; i++) if (sampson2(s.E, X1[i], X2[i]) < th2) n2.push(i);
    if (n2.length < 12) break;
    inl = n2;
  }
  return { ...best, inl };
}

// Triangulación: mínimos cuadrados de s1·R·x1 − s2·x2 = −t
export function tri(R, t, x1, x2) {
  const r = mv3(R, [x1[0], x1[1], 1]), b = [x2[0], x2[1], 1];
  const a11 = dot(r, r), a12 = -dot(r, b), a22 = dot(b, b), b1 = -dot(r, t), b2 = dot(b, t);
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-14) return null;
  const s1 = (b1 * a22 - a12 * b2) / det, s2 = (a11 * b2 - a12 * b1) / det;
  return { X: [s1 * x1[0], s1 * x1[1], s1], s1, s2 };
}

// Elige entre las 4 descomposiciones de E la que deja los puntos delante de ambas cámaras.
export function decompose(U, V, X1, X2, inl) {
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const R1 = mul3(mul3(U, W), tr3(V)), R2 = mul3(mul3(U, tr3(W)), tr3(V));
  const t0 = [U[2], U[5], U[8]];
  const cands = [[R1, t0], [R1, t0.map(x => -x)], [R2, t0], [R2, t0.map(x => -x)]];
  const sample = inl.length > 120 ? inl.filter((_, i) => i % Math.ceil(inl.length / 120) === 0) : inl;
  let best = null, bc = -1;
  for (const [R, t] of cands) {
    let c = 0;
    for (const i of sample) {
      const p = tri(R, t, X1[i], X2[i]);
      if (p && p.s1 > 0 && p.s2 > 0) c++;
    }
    if (c > bc) { bc = c; best = { R, t }; }
  }
  return best;
}

// Reconstrucción de dos vistas.
//  ref, cur: Float32Array planos [x0,y0,x1,y1,...] en píxeles; ids: índices de los puntos vivos;
//  f: focal en px; (cx,cy): centro óptico; maxErr: error máximo de reproyección en px.
// Devuelve {R, t, pts:[{id, P:[x,y,z]}]} con P en coordenadas de visualización (y arriba, giro de 180° en X).
export function reconstructTwoView(ref, cur, ids, f, cx, cy, maxErr = 3) {
  const X1 = ids.map(i => [(ref[2 * i] - cx) / f, (ref[2 * i + 1] - cy) / f]);
  const X2 = ids.map(i => [(cur[2 * i] - cx) / f, (cur[2 * i + 1] - cy) / f]);
  const res = ransacE(X1, X2, f);
  if (!res) return null;
  const pose = decompose(res.U, res.V, X1, X2, res.inl);
  if (!pose) return null;
  const pts = [];
  for (const k of res.inl) {
    const p = tri(pose.R, pose.t, X1[k], X2[k]);
    if (!p || p.s1 <= 0 || p.s2 <= 0) continue;
    const X2c = mv3(pose.R, p.X).map((v, j) => v + pose.t[j]);
    if (X2c[2] <= 0) continue;
    const e = f * Math.hypot(X2c[0] / X2c[2] - X2[k][0], X2c[1] / X2c[2] - X2[k][1]);
    if (e > maxErr) continue;
    pts.push({ id: ids[k], P: [p.X[0], -p.X[1], -p.X[2]] });
  }
  return { R: pose.R, t: pose.t, pts };
}

// Limpieza de fondo por profundidad: agrupa los puntos por cercanía en 3D y devuelve el grupo más grande.
// Dos puntos quedan unidos si están a menos de k veces la distancia típica al vecino más cercano.
export function largestCluster(pts, k = 3) {
  const n = pts.length;
  if (n < 15) return pts;
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const nn = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = d2(pts[i].P, pts[j].P);
    if (d < nn[i]) nn[i] = d;
    if (d < nn[j]) nn[j] = d;
  }
  const r = k * Math.sqrt(median(nn));
  if (!(r > 0)) return pts;
  const r2 = r * r;
  const label = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, cur = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] >= 0) continue;
    const stack = [s];
    label[s] = cur;
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      for (let j = 0; j < n; j++) {
        if (label[j] < 0 && d2(pts[i].P, pts[j].P) <= r2) { label[j] = cur; stack.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
    cur++;
  }
  return pts.filter((_, i) => label[i] === best);
}

// Centra la nube en la mediana, la escala para que la distancia mediana al centro sea 1 (escala auto ajustable)
// y descarta atípicos. Devuelve [[x,y,z,w,r,g,b],...] o null si quedan muy pocos puntos.
// w = intensidad del punto en [-1,1] (4ª coordenada).
export function normalizeCloud(pts, colors) {
  if (pts.length < 15) return null;
  const mx = median(pts.map(o => o.P[0])), my = median(pts.map(o => o.P[1])), mz = median(pts.map(o => o.P[2]));
  const ds = pts.map(o => Math.hypot(o.P[0] - mx, o.P[1] - my, o.P[2] - mz));
  const md = median(ds) || 1;
  const out = [];
  pts.forEach((o, i) => {
    if (ds[i] > 3 * md) return;
    const [r, g, b] = colors[o.id];
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    out.push([(o.P[0] - mx) / md, (o.P[1] - my) / md, (o.P[2] - mz) / md, (L - 0.5) * 2, r, g, b]);
  });
  return out.length >= 15 ? out : null;
                        }

                               
