// fragments.js — MODELO ÚNICO de la captura (antes: fragmentos) y TOMAS.
//  · Modelo: todos los puntos medidos van a un mismo espacio 3D, dividido en cubitos (vóxeles). Cada cubito
//    promedia posición y color de todas las mediciones que caen en él y cuenta desde cuántas vistas se vio.
//    El modelo solo crece: nada se borra hasta que se pulsa «Nueva captura».
//  · Vistas guardadas: firmas de puntos con su posición 3D, para reconocer el objeto desde cualquier cara.
//  · Toma: el modelo + sus vistas, empaquetado para guardar en el teléfono y subir al servidor, que une tomas.

export const VERSION = '2';

const OFF = 32768, SH = 65536;
const keyOf = (ix, iy, iz) => ((ix + OFF) * SH + (iy + OFF)) * SH + (iz + OFF);

// Pose: p_cam = R·X + t. Centro de la cámara en el modelo: C = −Rᵀ·t
export function camCenter(R, t) {
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
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

  // Cubitos que se muestran: vistos desde 2+ vistas (cuando ya hay 3+ mapas) y, si se limpia el fondo, dentro del objeto
  _visible(clean) {
    const minV = this.depthMaps >= 3 ? 2 : 1, out = [], o = this.obj;
    for (const v of this.vox.values()) {
      if (v.v < minV || v.m > v.v) continue;   // pocas vistas, o más vistas lo atraviesan que las que lo ven
      const x = v.x / v.n, y = v.y / v.n, z = v.z / v.n;
      if (clean && o && Math.hypot(x - o.c[0], y - o.c[1], z - o.c[2]) > o.r) continue;
      out.push(v);
    }
    return out;
  }

  // Nube para el visor: [x, y, z, w, r, g, b, tamaño], centrada y normalizada (y hacia arriba)
  cloud(clean, maxPts = 60000) {
    const vis = this._visible(clean);
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
  
