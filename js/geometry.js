// geometry.js — Geometría multivista pura (sin DOM ni OpenCV).
// Estima la pose relativa entre la referencia y el fotograma actual (matriz esencial, 8 puntos + RANSAC)
// y triangula los puntos. Convención: X2 = R·X1 + t, con t de norma 1 (escala relativa).

export const VERSION = '6';

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

// Matriz de rotación desde un vector de rotación ω (Rodrigues).
export function rodrigues(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = [w[0] / th, w[1] / th, w[2] / th], c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v
  ];
}
// Vector de rotación desde una matriz de rotación.
export function logR(R) {
  const c = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)), th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  const s = 2 * Math.sin(th);
  return [(R[7] - R[5]) / s * th, (R[2] - R[6]) / s * th, (R[3] - R[1]) / s * th];
}

// Para una rotación dada, la traslación (dirección) sale de forma lineal: tᵀ·((R·x1) × x2) = 0.
// Devuelve {t, cost, res} donde res son los residuos por punto.
function bestT(R, X1, X2, idx, tPrev) {
  const S = new Array(9).fill(0), rows = [];
  for (const i of idx) {
    const a = mv3(R, [X1[i][0], X1[i][1], 1]), b = [X2[i][0], X2[i][1], 1];
    const r = cross(a, b);
    rows.push(r);
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) S[3 * p + q] += r[p] * r[q];
  }
  const { vals, V } = jacobi(S, 3);
  let m = 0;
  for (let i = 1; i < 3; i++) if (vals[i] < vals[m]) m = i;
  let t = [V[m], V[3 + m], V[6 + m]];
  if (tPrev && dot(t, tPrev) < 0) t = t.map(x => -x);
  const res = rows.map(r => dot(r, t));
  return { t, res, cost: res.reduce((a, b) => a + b * b, 0) };
}

// Residuos de Sampson (distancia geométrica, en coordenadas normalizadas) para una pose (R, t).
function sampsonRes(R, t, X1, X2, idx, sigma = 0) {
  const E = essentialFrom(R, t), out = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], a = [X1[i][0], X1[i][1], 1], b = [X2[i][0], X2[i][1], 1];
    const Ea = mv3(E, a), Etb = mv3(tr3(E), b);
    const den = Math.sqrt(Ea[0] ** 2 + Ea[1] ** 2 + Etb[0] ** 2 + Etb[1] ** 2) || 1e-12;
    const r = dot(b, Ea) / den;
    // Con sigma > 0: pérdida robusta de Cauchy (los pares erróneos pesan poco)
    out[k] = sigma > 0 ? Math.sign(r) * sigma * Math.sqrt(Math.log1p((r / sigma) ** 2)) : r;
  }
  return out;
}

// Base tangente a la esfera unitaria en t
function tangent(t) {
  const a = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = cross(t, a), n1 = Math.hypot(...e1);
  const u = e1.map(x => x / n1), v = cross(t, u);
  return [u, v];
}

// Afinamiento de la pose (Levenberg-Marquardt) sobre 5 parámetros: rotación (3) y dirección de t (2),
// minimizando la distancia de Sampson de todos los pares. Funciona también con escenas casi planas.
export function refinePose(X1, X2, idx, w0, t0 = null, iters = 40, sigma = 0) {
  let w = w0.slice();
  let t = t0 ? t0.slice() : bestT(rodrigues(w), X1, X2, idx, null).t;
  const nt = Math.hypot(...t); t = t.map(x => x / nt);
  let res = sampsonRes(rodrigues(w), t, X1, X2, idx, sigma);
  let cost = res.reduce((a, b) => a + b * b, 0), lambda = 1e-3;
  const apply = (wb, tb, d, B) => {
    const wn = [wb[0] + d[0], wb[1] + d[1], wb[2] + d[2]];
    const tn = tb.map((x, k) => x + d[3] * B[0][k] + d[4] * B[1][k]);
    const n = Math.hypot(...tn);
    return [wn, tn.map(x => x / n)];
  };
  for (let it = 0; it < iters; it++) {
    const B = tangent(t), h = 1e-7, J = [];
    for (let k = 0; k < 5; k++) {
      const d = [0, 0, 0, 0, 0]; d[k] = h;
      const [wk, tk] = apply(w, t, d, B);
      const rk = sampsonRes(rodrigues(wk), tk, X1, X2, idx, sigma);
      J.push(Array.from(rk, (v, i) => (v - res[i]) / h));
    }
    const A = new Array(25).fill(0), g = [0, 0, 0, 0, 0];
    for (let i = 0; i < res.length; i++) for (let p = 0; p < 5; p++) {
      g[p] += J[p][i] * res[i];
      for (let q = 0; q < 5; q++) A[5 * p + q] += J[p][i] * J[q][i];
    }
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const M = A.slice();
      for (let p = 0; p < 5; p++) M[6 * p] += lambda * (A[6 * p] + 1e-15);
      const d = solveN(M, g.map(x => -x), 5);
      if (!d) { lambda *= 10; continue; }
      const [wn, tn] = apply(w, t, d, B);
      const rn = sampsonRes(rodrigues(wn), tn, X1, X2, idx, sigma);
      const cn = rn.reduce((a, b) => a + b * b, 0);
      if (cn < cost) {
        const rel = (cost - cn) / cost;
        w = wn; t = tn; res = rn; cost = cn; lambda = Math.max(1e-9, lambda / 4); improved = true;
        if (rel < 1e-9) it = iters;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { w, R: rodrigues(w), t, cost };
}

// Resuelve M·x = b (n×n) por eliminación de Gauss con pivoteo.
function solveN(M, b, n) {
  const A = [];
  for (let i = 0; i < n; i++) A.push([...M.slice(n * i, n * i + n), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-30) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = A[r][n];
    for (let j = r + 1; j < n; j++) v -= A[r][j] * x[j];
    x[r] = v / A[r][r];
  }
  return x;
}

// Pose robusta entre dos vistas: inliers por RANSAC (8 puntos) y luego afinamiento partiendo de
// "sin rotación" y de las soluciones de 8 puntos; gana la que mejor explica los datos.
export function estimatePose(X1, X2, f) {
  const N = X1.length;
  if (N < 14) return null;
  const all = Array.from({ length: N }, (_, i) => i);
  const sigma = 1.5 / f, th2 = (2.5 / f) ** 2;
  // Puntos de partida: sin giro (lo normal con la mano) y las soluciones del método de 8 puntos
  const starts = [{ w: [0, 0, 0], t: null }];
  const r = ransacE(X1, X2, f);
  if (r) {
    const W = [0, -1, 0, 1, 0, 0, 0, 0, 1], tE = [r.U[2], r.U[5], r.U[8]];
    for (const Rc of [mul3(mul3(r.U, W), tr3(r.V)), mul3(mul3(r.U, tr3(W)), tr3(r.V))]) {
      const w = logR(Rc);
      if (Math.hypot(w[0], w[1], w[2]) < 0.8) starts.push({ w, t: tE });
    }
  }
  let best = null;
  for (const st of starts) {
    // 1) ajuste robusto con todos los puntos  2) inliers  3) ajuste fino solo con inliers
    let sol = refinePose(X1, X2, all, st.w, st.t, 40, sigma);
    const E = essentialFrom(sol.R, sol.t);
    const inl = [];
    for (let i = 0; i < N; i++) if (sampson2(E, X1[i], X2[i]) < th2) inl.push(i);
    if (inl.length < 12) continue;
    sol = { ...refinePose(X1, X2, inl, sol.w, sol.t), inl };
    sol.err = sol.cost / inl.length;
    if (!best || inl.length > best.inl.length * 1.05 ||
        (inl.length >= best.inl.length * 0.95 && sol.err < best.err)) best = sol;
  }
  if (!best) return null;
  // Signo de t: la mayoría de los puntos debe quedar delante de ambas cámaras
  let front = 0;
  for (const i of best.inl) { const p = tri(best.R, best.t, X1[i], X2[i]); if (p && p.s1 > 0 && p.s2 > 0) front++; }
  if (front < best.inl.length / 2) best.t = best.t.map(x => -x);
  return { R: best.R, t: best.t, inl: best.inl };
}

export function essentialFrom(R, t) {
  const T = [0, -t[2], t[1], t[2], 0, -t[0], -t[1], t[0], 0];
  return mul3(T, R);
}

// Reconstrucción de dos vistas.
//  ref, cur: Float32Array planos [x0,y0,x1,y1,...] en píxeles; ids: índices de los puntos vivos;
//  f: focal en px; (cx,cy): centro óptico; maxErr: error máximo de reproyección en px.
// Devuelve {R, t, pts:[{id, P:[x,y,z]}]} con P en coordenadas de visualización (y arriba, giro de 180° en X).
export function reconstructTwoView(ref, cur, ids, f, cx, cy, maxErr = 3) {
  const X1 = ids.map(i => [(ref[2 * i] - cx) / f, (ref[2 * i + 1] - cy) / f]);
  const X2 = ids.map(i => [(cur[2 * i] - cx) / f, (cur[2 * i + 1] - cy) / f]);
  const pose = estimatePose(X1, X2, f);
  if (!pose) return null;
  const pts = [];
  for (const k of pose.inl) {
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

/* ---------- Posición de la cámara respecto del modelo (PnP) ---------- */
// Convención: p_cam = R·X + t (X en coordenadas del modelo). Proyección u = f·x/z + cx, v = f·y/z + cy.

// Error de proyección (px) de cada punto para una pose
export function reprojErrors(X, uv, f, cx, cy, R, t) {
  const e = new Float64Array(X.length);
  for (let i = 0; i < X.length; i++) {
    const P = X[i];
    const x = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0];
    const y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1];
    const z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
    e[i] = z > 1e-6 ? Math.hypot(f * x / z + cx - uv[i][0], f * y / z + cy - uv[i][1]) : 1e6;
  }
  return e;
}

// Afinamiento de la pose (Levenberg-Marquardt con pérdida robusta de Cauchy) partiendo de (R0, t0).
// Devuelve { R, t, inl (índices con error < thr px), err (error mediano de los inliers) }.
export function pnpRefine(X, uv, f, cx, cy, R0, t0, { iters = 12, sigma = 2.5, thr = 4 } = {}) {
  let R = R0.slice(), t = t0.slice();
  const n = X.length, s2 = sigma * sigma;
  const robustCost = (R, t) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const P = X[i];
      const z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
      if (z <= 1e-6) { c += 50; continue; }
      const ru = f * (R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0]) / z + cx - uv[i][0];
      const rv = f * (R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1]) / z + cy - uv[i][1];
      c += Math.log1p((ru * ru + rv * rv) / s2);
    }
    return c;
  };
  let cost = robustCost(R, t), lambda = 1e-3;
  const H = new Float64Array(36), g = new Float64Array(6), Ju = new Float64Array(6), Jv = new Float64Array(6);
  for (let it = 0; it < iters; it++) {
    H.fill(0); g.fill(0);
    for (let i = 0; i < n; i++) {
      const P = X[i];
      const px = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0];
      const py = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1];
      const pz = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
      if (pz <= 1e-6) continue;
      const iz = 1 / pz;
      const ru = f * px * iz + cx - uv[i][0], rv = f * py * iz + cy - uv[i][1];
      const w = 1 / (1 + (ru * ru + rv * rv) / s2);
      // d(u,v)/dp · [ -[p]x | I ]   (perturbación a la izquierda: R ← exp(δw)·R, t ← exp(δw)·t + δt)
      const a0 = f * iz, a2 = -f * px * iz * iz, b1 = f * iz, b2 = -f * py * iz * iz;
      Ju[0] = a2 * py; Ju[1] = a0 * pz - a2 * px; Ju[2] = -a0 * py; Ju[3] = a0; Ju[4] = 0; Ju[5] = a2;
      Jv[0] = -b1 * pz + b2 * py; Jv[1] = -b2 * px; Jv[2] = b1 * px; Jv[3] = 0; Jv[4] = b1; Jv[5] = b2;
      for (let a = 0; a < 6; a++) {
        const wa = w * Ju[a], wb = w * Jv[a];
        g[a] += wa * ru + wb * rv;
        for (let b = a; b < 6; b++) H[6 * a + b] += wa * Ju[b] + wb * Jv[b];
      }
    }
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H[6 * a + b] = H[6 * b + a];
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = Array.from(H);
      for (let a = 0; a < 6; a++) M[7 * a] += lambda * (H[7 * a] + 1e-9);
      const d = solveN(M, Array.from(g, v => -v), 6);
      if (!d) { lambda *= 10; continue; }
      const dR = rodrigues([d[0], d[1], d[2]]);
      const Rn = mul3(dR, R), tn = mv3(dR, t).map((v, k) => v + d[3 + k]);
      const cn = robustCost(Rn, tn);
      if (cn < cost) {
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        R = Rn; t = tn; cost = cn; lambda = Math.max(1e-9, lambda / 4); improved = true;
        if (rel < 1e-6) it = iters;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const e = reprojErrors(X, uv, f, cx, cy, R, t);
  const inl = [];
  for (let i = 0; i < n; i++) if (e[i] < thr) inl.push(i);
  const ei = inl.map(i => e[i]).sort((a, b) => a - b);
  return { R, t, inl, err: ei.length ? ei[ei.length >> 1] : Infinity, errors: e };
}

// Pose sin posición previa (al reconocer el objeto): se prueban varios puntos de partida y se queda la mejor.
//  X: puntos 3D del modelo · uv: su posición en el cuadro actual · uvKf: su posición en la vista guardada
//  kf: { R, t } pose de esa vista guardada · extra: poses de partida adicionales (p. ej., la última conocida)
export function pnpRelocalize(X, uv, uvKf, kf, f, cx, cy, extra = []) {
  const n = X.length;
  if (n < 12) return null;
  const starts = [{ R: kf.R, t: kf.t }, ...extra];
  // Partida a partir del movimiento entre la vista guardada y el cuadro actual (8 puntos + escala)
  const X1 = uvKf.map(p => [(p[0] - cx) / f, (p[1] - cy) / f]);
  const X2 = uv.map(p => [(p[0] - cx) / f, (p[1] - cy) / f]);
  const rel = estimatePose(X1, X2, f);
  if (rel) {
    const ss = [];
    for (const i of rel.inl) {
      const P = X[i];
      const a0 = mv3(kf.R, P).map((v, k) => v + kf.t[k]);   // punto en la cámara de la vista guardada
      const a = mv3(rel.R, a0), b = rel.t;
      const xo = X2[i][0], yo = X2[i][1];
      const dx = b[0] - xo * b[2], dy = b[1] - yo * b[2];
      if (Math.abs(dx) > 1e-6) ss.push((xo * a[2] - a[0]) / dx);
      if (Math.abs(dy) > 1e-6) ss.push((yo * a[2] - a[1]) / dy);
    }
    if (ss.length >= 6) {
      const s = median(ss);
      if (isFinite(s)) {
        const Rc = mul3(rel.R, kf.R), tc = mv3(rel.R, kf.t).map((v, k) => v + s * rel.t[k]);
        starts.push({ R: Rc, t: tc });
      }
    }
  }
  let best = null;
  const consider = r => { if (!best || r.inl.length > best.inl.length || (r.inl.length === best.inl.length && r.err < best.err)) best = r; };
  for (const st of starts) consider(pnpRefine(X, uv, f, cx, cy, st.R, st.t, { iters: 25, sigma: 3, thr: 5 }));
  // Muestreo aleatorio (RANSAC): con muchas coincidencias falsas, se ajusta con grupos chicos al azar
  // y se queda la pose que explica más puntos
  if (best.inl.length < 0.6 * n) {
    for (let it = 0; it < 40; it++) {
      const idx = new Set();
      while (idx.size < 6) idx.add((Math.random() * n) | 0);
      const ii = [...idx];
      for (const st of starts) {
        const r0 = pnpRefine(ii.map(i => X[i]), ii.map(i => uv[i]), f, cx, cy, st.R, st.t, { iters: 15, sigma: 3, thr: 5 });
        if (r0.inl.length < 5) continue;
        const e = reprojErrors(X, uv, f, cx, cy, r0.R, r0.t), inl = [];
        for (let i = 0; i < n; i++) if (e[i] < 5) inl.push(i);
        if (!best || inl.length > best.inl.length) best = { R: r0.R, t: r0.t, inl, err: 0 };
      }
      if (best.inl.length >= 0.6 * n) break;
    }
  }
  if (!best || best.inl.length < 12) return null;
  // Afinamiento final solo con los puntos que calzan
  const Xi = best.inl.map(i => X[i]), ui = best.inl.map(i => uv[i]);
  const fin = pnpRefine(Xi, ui, f, cx, cy, best.R, best.t, { iters: 15, sigma: 2, thr: 4 });
  const e = reprojErrors(X, uv, f, cx, cy, fin.R, fin.t);
  const inl = [];
  for (let i = 0; i < n; i++) if (e[i] < 4) inl.push(i);
  return { R: fin.R, t: fin.t, inl, err: fin.err };
}

    
