// worker.js — Proceso en segundo plano: hace los cálculos pesados (profundidad de cada píxel y
// calibración de la focal) sin detener la página, para que el seguimiento de la cámara nunca se corte.

import { denseDepth } from './dense.js';
import { estimatePose, essentialFrom, sampson2 } from './geometry.js';
import { sheetMask } from './volumen.js';

export const VERSION = '8';

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'dense') {
      const t0 = performance.now();
      const dm = denseDepth(m.ref, m.cur, m.R, m.t, m.f, m.cx, m.cy, m.range, m.opts);
      dm.ms = performance.now() - t0;
      self.postMessage({ type: 'dense', id: m.id, dm }, [dm.depth.buffer, dm.bg.buffer, dm.rgb.buffer]);
    } else if (m.type === 'mask') {
      // Modo hoja: dónde se ve la hoja y dónde algo la tapa (para tallar la forma)
      const mask = sheetMask(m.img, m.R, m.t, m.f, m.cx, m.cy);
      self.postMessage({ type: 'mask', id: m.id, mask }, [mask.buffer]);
    } else if (m.type === 'focal') {
      // Para cada campo de visión candidato: error mediano (en píxeles) con que la pose explica los pares de puntos
      const errs = m.fovs.map(fov => {
        const f = (m.long / 2) / Math.tan(fov * Math.PI / 360);
        const X1 = [], X2 = [];
        for (let k = 0; k < m.n; k++) {
          X1.push([(m.p1[2 * k] - m.cx) / f, (m.p1[2 * k + 1] - m.cy) / f]);
          X2.push([(m.p2[2 * k] - m.cx) / f, (m.p2[2 * k + 1] - m.cy) / f]);
        }
        const p = estimatePose(X1, X2, f);
        if (!p || p.inl.length < 0.5 * m.n) return Infinity;
        const E = essentialFrom(p.R, p.t);
        const e = p.inl.map(i => Math.sqrt(sampson2(E, X1[i], X2[i])) * f).sort((a, b) => a - b);
        return e[e.length >> 1];
      });
      self.postMessage({ type: 'focal', id: m.id, errs });
    }
  } catch (err) {
    self.postMessage({ type: m.type, id: m.id, error: err.message });
  }
};
