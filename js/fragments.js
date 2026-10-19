// fragments.js — Fragmentos de la captura. Cada vez que el seguimiento se corta (o un tramo se completa),
// lo capturado se guarda completo como un fragmento y la captura sigue desde donde esté la cámara.
// Nada se descarta: en la etapa 2 el software unirá los fragmentos que compartan alguna zona.

import { depthToCloud } from './dense.js';

export const VERSION = '1';

export class FragmentStore {
  constructor() { this.list = []; }

  clear() { this.list = []; }

  get count() { return this.list.length; }

  // Total de puntos guardados en todos los fragmentos
  get points() { return this.list.reduce((s, f) => s + f.dm.count, 0); }

  /*
   * Guarda un fragmento a partir del acumulador del tramo.
   *  dm: mapa de profundidad final del tramo (vista K0 del tramo, con colores e intrínsecos)
   *  image: imagen K0 del tramo · keyframes: vistas con pose conocida respecto de K0 (para unir en la etapa 2)
   */
  add({ dm, image, keyframes, fusions, coverage }) {
    const frag = { id: this.list.length + 1, dm, image, keyframes: keyframes || [], fusions, coverage, time: Date.now() };
    this.list.push(frag);
    return frag;
  }

  // Nube para el visor de un fragmento
  cloud(i) {
    const f = this.list[i];
    return f ? depthToCloud(f.dm) : null;
  }

  // Puntos 3D del fragmento en coordenadas de su cámara K0 (x, y, z con y hacia abajo) y su color
  points3D(i) {
    const f = this.list[i];
    if (!f) return null;
    const { w, h, f: fl, cx, cy, depth, rgb } = f.dm;
    const xyz = [], col = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x, d = depth[k];
      if (!(d > 0)) continue;
      xyz.push(d * (x - cx) / fl, d * (y - cy) / fl, d);
      col.push(rgb[3 * k], rgb[3 * k + 1], rgb[3 * k + 2]);
    }
    return { xyz: new Float32Array(xyz), rgb: new Uint8Array(col) };
  }

  // Resumen para exportar (puntos 3D por fragmento)
  toJSON() {
    return this.list.map((f, i) => {
      const p = this.points3D(i);
      return {
        id: f.id, mediciones: f.fusions, cobertura: +f.coverage.toFixed(3), puntos: f.dm.count,
        intrinsecos: { w: f.dm.w, h: f.dm.h, f: f.dm.f, cx: f.dm.cx, cy: f.dm.cy },
        vistas_clave: f.keyframes.map(k => ({ R: k.R, t: k.t })),
        xyz: Array.from(p.xyz, v => +v.toFixed(4)), rgb: Array.from(p.rgb)
      };
    });
  }
}
