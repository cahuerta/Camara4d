// assist.js — Asistente de la toma: mapa de lo ya modelado, indicaciones en vivo y barra de detección.
// Solo lee el estado y dibuja ayudas; no cambia la captura.
// Crea sus propios elementos dentro de la caja del video y del contenedor de controles (index.html no cambia).

export const VERSION = '3';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Assist {
  constructor({ vidBox, controls }) {
    // Flecha grande hacia donde moverse
    this.arrow = document.createElement('div');
    this.arrow.className = 'as-arrow';
    this.arrow.hidden = true;
    vidBox.appendChild(this.arrow);

    // Mapa de cobertura (esquina superior derecha del video)
    this.map = document.createElement('canvas');
    this.map.className = 'as-map';
    this.map.hidden = true;
    vidBox.appendChild(this.map);
    this.mctx = this.map.getContext('2d');

    // Indicación en vivo (franja inferior del video)
    this.hint = document.createElement('div');
    this.hint.className = 'as-hint';
    this.hint.hidden = true;
    vidBox.appendChild(this.hint);

    // Barra de detección
    const wrap = document.createElement('div');
    wrap.className = 'as-det';
    wrap.innerHTML = '<span class="as-det-lbl">Detección</span><div class="as-det-bar"><div class="as-det-fill"></div></div><span class="as-det-val"></span>';
    controls.appendChild(wrap);
    this.detFill = wrap.querySelector('.as-det-fill');
    this.detVal = wrap.querySelector('.as-det-val');

    this.reset();
  }

  reset() {
    this.prevPos = null;
    this.speed = 0;
    this.stillSince = 0;
    this.lastMap = 0;
    this.lastHint = '';
    this.viewCov = 0;
    this.setDetection(0);
    this.map.hidden = true;
    this.hint.hidden = true;
    this.showArrow(null);
  }

  done() {
    this.hint.hidden = true;
    this.map.hidden = true;
    this.showArrow(null);
    this.setDetection(0);
  }

  setDetection(q) {
    const pct = Math.round(100 * clamp(q, 0, 1));
    this.detFill.style.width = pct + '%';
    this.detFill.style.background = q < 0.35 ? '#ff5d5d' : q < 0.65 ? '#f7c948' : '#3ddc84';
    this.detVal.textContent = pct + ' %';
  }

  showArrow(side) {
    const glyph = { izq: '⬅', der: '➡', arr: '⬆', aba: '⬇' }[side];
    if (!glyph) { this.arrow.hidden = true; this.arrowSide = null; return; }
    if (side === this.arrowSide) return;
    this.arrowSide = side;
    this.arrow.textContent = glyph;
    this.arrow.className = 'as-arrow ' + side;
    this.arrow.hidden = false;
  }

  showHint(text) {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.hint.textContent = text;
    this.hint.hidden = !text;
  }

  /*
   * Se llama en cada cuadro.
   * st: { img (ImageData), pts (puntos seguidos), state ('init' | 'track' | 'lost'), view (proyección del modelo en
   *       la vista actual: { w, h, factor, views } o null) }
   */
  update(st) {
    const now = performance.now();
    const { img, pts } = st;

    // --- Imagen: luz y nitidez (sobre una muestra de píxeles; nitidez en las partes con detalle) ---
    const d = img.data, W = img.width, H = img.height;
    let sum = 0, n = 0;
    const grads = [];
    for (let y = 4; y < H - 4; y += 6) for (let x = 4; x < W - 4; x += 6) {
      const o = (y * W + x) * 4, g = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      const o2 = o + 8, g2 = 0.299 * d[o2] + 0.587 * d[o2 + 1] + 0.114 * d[o2 + 2];
      const o3 = o + 8 * W, g3 = 0.299 * d[o3] + 0.587 * d[o3 + 1] + 0.114 * d[o3 + 2];
      sum += g; grads.push(Math.abs(g2 - g) + Math.abs(g3 - g)); n++;
    }
    grads.sort((a, b) => a - b);
    const bright = sum / n, sharp = grads[Math.floor(grads.length * 0.75)] || 0;

    // --- Velocidad: desplazamiento mediano de los puntos entre cuadros ---
    if (this.prevPos && pts.length) {
      const dist = [];
      for (const p of pts) { const q = this.prevPos.get(p); if (q) dist.push(Math.hypot(p.x - q[0], p.y - q[1])); }
      dist.sort((a, b) => a - b);
      const m = dist.length ? dist[dist.length >> 1] : 0;
      this.speed = 0.6 * this.speed + 0.4 * m;
    }
    this.prevPos = new Map(pts.map(p => [p, [p.x, p.y]]));
    if (this.speed < 0.6) { if (!this.stillSince) this.stillSince = now; } else this.stillSince = 0;

    // --- Barra de detección: puntos seguidos y textura ---
    const ptsQ = clamp(pts.length / 200, 0, 1), texQ = clamp((sharp - 4) / 16, 0, 1);
    this.setDetection(st.state === 'lost' ? 0 : Math.sqrt(ptsQ * texQ));

    // --- Mapa de lo ya modelado en esta vista (unas 3 veces por segundo) ---
    let cov = null;
    if (st.view && st.state === 'track') {
      cov = this.coverage(img, st.view);
      if (now - this.lastMap > 330) { this.drawMap(img, st.view, cov.zone); this.lastMap = now; }
    } else if (st.state !== 'track') this.map.hidden = true;

    const dec = this.decide(st, { bright, sharp, now, cov });
    this.showHint(dec.text);
    this.showArrow(dec.arrow || null);
  }

  // Zonas con detalle de la vista actual y cuánto de ellas ya está en el modelo (por lado)
  coverage(img, view) {
    const { w, h, factor, views } = view, d = img.data, W = img.width;
    const zone = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const px = x * factor, py = y * factor;
      if (px + factor >= W || py + factor >= img.height) continue;
      const o = (py * W + px) * 4, o2 = o + 4 * factor, o3 = o + 4 * factor * W;
      const g = d[o] + d[o + 1] + d[o + 2], g2 = d[o2] + d[o2 + 1] + d[o2 + 2], g3 = d[o3] + d[o3 + 1] + d[o3 + 2];
      if (Math.abs(g2 - g) + Math.abs(g3 - g) > 36) zone[y * w + x] = 1;
    }
    const reg = {
      izq: { side: 'izq', tot: 0, miss: 0, text: 'Falta la izquierda: muévete hacia la izquierda' },
      der: { side: 'der', tot: 0, miss: 0, text: 'Falta la derecha: muévete hacia la derecha' },
      arr: { side: 'arr', tot: 0, miss: 0, text: 'Falta arriba: sube el teléfono y apunta abajo' },
      aba: { side: 'aba', tot: 0, miss: 0, text: 'Falta abajo: baja el teléfono' }
    };
    let modeled = 0, tot = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (views[i] >= 1) modeled++;
      if (!zone[i]) continue;
      tot++;
      const miss = views[i] >= 2 ? 0 : 1;
      const r1 = x < w / 2 ? reg.izq : reg.der, r2 = y < h / 2 ? reg.arr : reg.aba;
      r1.tot++; r1.miss += miss; r2.tot++; r2.miss += miss;
    }
    let worst = null;
    for (const r of Object.values(reg)) { r.missing = r.tot ? r.miss / r.tot : 0; if (!worst || r.missing > worst.missing) worst = r; }
    this.viewCov = tot ? 1 - (reg.izq.miss + reg.der.miss) / Math.max(1, reg.izq.tot + reg.der.tot) : 0;
    return { zone, worst, objFrac: modeled / (w * h) };
  }

  decide(st, m) {
    if (st.state === 'lost') return { text: '🔎 Buscando el objeto: apunta a una parte ya capturada' };
    if (m.bright < 45) return { text: '💡 Falta luz' };
    if (m.sharp < 4) return { text: '✋ Borroso: quieto un momento' };
    if (this.speed > 9) return { text: '🐢 Más lento' };
    if (st.state === 'init') return { text: '↔ Muévete despacio de lado para empezar', arrow: 'der' };
    if (st.pts.length < 60) return { text: '🔍 Poca textura: apunta a más detalle' };
    const c = m.cov;
    if (c && c.objFrac > 0 && c.objFrac < 0.06) return { text: '⬆ Acércate' };
    if (this.stillSince && m.now - this.stillSince > 1500) return { text: '↻ Sigue girando alrededor del objeto', arrow: 'der' };
    if (c && c.worst && c.worst.missing > 0.4) return { text: c.worst.text, arrow: c.worst.side };
    return { text: '✔ Bien: sigue girando para sumar más caras' };
  }

  // Miniatura de la vista: verde = modelado (2+ vistas), amarillo = 1 vista, rojo = con detalle y sin modelar
  drawMap(img, view, zone) {
    const { w, h, factor, views } = view;
    if (this.map.width !== w || this.map.height !== h) { this.map.width = w; this.map.height = h; }
    const im = this.mctx.createImageData(w, h), o = im.data, d = img.data, W = img.width;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, px = Math.min(img.width - 1, x * factor), py = Math.min(img.height - 1, y * factor);
      const s = (py * W + px) * 4, gray = (0.299 * d[s] + 0.587 * d[s + 1] + 0.114 * d[s + 2]) * 0.5;
      let r = gray, g = gray, b = gray;
      if (views[i] >= 2) { r = gray * 0.4; g = gray * 0.4 + 150; b = gray * 0.4 + 60; }
      else if (views[i] === 1) { r = gray * 0.4 + 170; g = gray * 0.4 + 140; b = gray * 0.4; }
      else if (zone[i]) { r = gray * 0.5 + 120; g = gray * 0.5; b = gray * 0.5; }
      o[4 * i] = r; o[4 * i + 1] = g; o[4 * i + 2] = b; o[4 * i + 3] = 255;
    }
    this.mctx.putImageData(im, 0, 0);
    this.map.hidden = false;
  }
  }
    
