// assist.js — Asistente de la toma: mapa de cobertura, indicaciones en vivo y barra de detección.
// Solo lee el estado (imagen, seguimiento, modelo acumulado) y dibuja ayudas; no cambia la captura.
// Crea sus propios elementos dentro de la caja del video y del contenedor de controles (index.html no cambia).

export const VERSION = '1';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Assist {
  constructor({ vidBox, controls }) {
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
    this.prevPts = null;       // posiciones de los puntos en el cuadro anterior (para la velocidad)
    this.prevN = -1;
    this.speed = 0;            // desplazamiento mediano por cuadro (px), suavizado
    this.stillSince = 0;       // desde cuándo la cámara está casi quieta
    this.lastMap = 0;
    this.lastHint = '';
    this.setDetection(0);
    this.map.hidden = true;
    this.hint.hidden = true;
  }

  // Al terminar: se deja el mapa final y se oculta la indicación
  done(acc) {
    this.hint.hidden = true;
    if (acc) this.drawMap(acc);
    this.setDetection(0);
  }

  setDetection(q) {
    const pct = Math.round(100 * clamp(q, 0, 1));
    this.detFill.style.width = pct + '%';
    this.detFill.style.background = q < 0.35 ? '#ff5d5d' : q < 0.65 ? '#f7c948' : '#3ddc84';
    this.detVal.textContent = pct + ' %';
  }

  showHint(text) {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.hint.textContent = text;
    this.hint.hidden = !text;
  }

  /*
   * Se llama en cada cuadro.
   * st: { img (ImageData), tracker, acc, lost, capturing, roi }
   */
  update(st) {
    const now = performance.now();
    const { img, tracker, acc } = st;

    // --- Imagen: luz y nitidez (sobre una muestra de píxeles) ---
    const d = img.data, W = img.width, H = img.height;
    // La nitidez se mide en las partes con detalle (percentil 75), para que una zona lisa grande
    // (una mesa blanca, una pared) no haga parecer borrosa una imagen nítida
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

    // --- Velocidad: cuánto se mueven los puntos entre cuadros ---
    const ids = tracker.tracking ? tracker.aliveIds() : [];
    if (tracker.N !== this.prevN || !this.prevPts) {
      this.prevPts = tracker.cur ? tracker.cur.slice() : null;
      this.prevN = tracker.N;
    } else {
      const dist = [];
      for (const i of ids) dist.push(Math.hypot(tracker.cur[2 * i] - this.prevPts[2 * i], tracker.cur[2 * i + 1] - this.prevPts[2 * i + 1]));
      dist.sort((a, b) => a - b);
      const m = dist.length ? dist[dist.length >> 1] : 0;
      this.speed = 0.6 * this.speed + 0.4 * m;
      this.prevPts = tracker.cur.slice();
    }
    if (this.speed < 0.6) { if (!this.stillSince) this.stillSince = now; } else this.stillSince = 0;

    // --- Barra de detección: puntos seguidos y textura ---
    const ptsQ = clamp(ids.length / 200, 0, 1);
    const texQ = clamp((sharp - 4) / 16, 0, 1);
    this.setDetection(st.lost ? 0 : Math.sqrt(ptsQ * texQ));

    // --- Mapa de cobertura (unas 3 veces por segundo) ---
    if (acc && acc.fusions && now - this.lastMap > 330) { this.drawMap(acc); this.lastMap = now; }

    if (!st.capturing) { this.showHint(''); return; }
    this.showHint(this.decide(st, { bright, sharp, ids, now }));
  }

  // Elige la indicación más importante del momento
  decide(st, m) {
    const { acc, tracker } = st;
    if (st.lost) return '↩ Vuelve hacia donde estabas';
    if (m.bright < 45) return '💡 Falta luz';
    if (m.sharp < 4) return '✋ Borroso: quieto un momento';
    if (this.speed > 9) return '🐢 Más lento';
    if (tracker.tracking && m.ids.length < 60) return '🔍 Poca textura: apunta a más detalle';

    const cov = acc ? this.regions(acc) : null;
    if (cov && acc.fusions >= 1 && cov.objFrac < 0.1) return '⬆ Acércate';
    if (cov && acc.fusions >= 1 && cov.objFrac > 0.85) return '⬇ Aléjate un poco';
    if (this.stillSince && m.now - this.stillSince > 1500) return '↔ Muévete de lado';
    if (cov && acc.fusions >= 2) {
      const r = cov.worst;
      if (r && r.missing > 0.3) return r.text;
    }
    if (acc && acc.fusions) return '✔ Bien, sigue así';
    return '↔ Muévete despacio de lado';
  }

  // Cobertura por zonas del objeto: qué parte falta más y qué tan grande se ve el objeto
  regions(acc) {
    const W = acc.w, H = acc.h;
    let x0 = W, x1 = 0, y0 = H, y1 = 0, anyZone = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!acc.zone[i] || acc.bg[i] > acc.cnt[i]) continue;
      anyZone++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!anyZone) return null;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const reg = {
      izq: { tot: 0, miss: 0, text: '← Falta la izquierda: ve a la izquierda' },
      der: { tot: 0, miss: 0, text: '→ Falta la derecha: ve a la derecha' },
      arr: { tot: 0, miss: 0, text: '↑ Falta arriba: sube y apunta abajo' },
      aba: { tot: 0, miss: 0, text: '↓ Falta abajo: baja el teléfono' }
    };
    let measured = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (acc.cnt[i] >= 1) measured++;
      if (!acc.zone[i] || acc.bg[i] > acc.cnt[i]) continue;
      const miss = acc.cnt[i] < 2 ? 1 : 0;
      const k1 = x < cx ? reg.izq : reg.der, k2 = y < cy ? reg.arr : reg.aba;
      k1.tot++; k1.miss += miss; k2.tot++; k2.miss += miss;
    }
    let worst = null;
    for (const r of Object.values(reg)) {
      r.missing = r.tot ? r.miss / r.tot : 0;
      if (!worst || r.missing > worst.missing) worst = r;
    }
    // Tamaño aparente del objeto: fracción de la imagen con profundidad medida
    let withDepth = 0;
    for (let i = 0; i < acc.cnt.length; i++) if (acc.cnt[i] >= 1) withDepth++;
    return { worst, objFrac: withDepth / acc.cnt.length };
  }

  // Miniatura de la imagen de partida: verde = confirmado, amarillo = medido una vez, rojo = falta
  drawMap(acc) {
    const W = acc.w, H = acc.h;
    if (this.map.width !== W || this.map.height !== H) { this.map.width = W; this.map.height = H; }
    const im = this.mctx.createImageData(W, H), o = im.data;
    for (let i = 0; i < W * H; i++) {
      let r = acc.rgb[3 * i], g = acc.rgb[3 * i + 1], b = acc.rgb[3 * i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = gray * 0.55;   // fondo apagado para que se lean los colores
      if (acc.cnt[i] >= 2) { r = r * 0.4; g = g * 0.4 + 150; b = b * 0.4 + 60; }
      else if (acc.cnt[i] === 1) { r = r * 0.4 + 170; g = g * 0.4 + 140; b = b * 0.4; }
      else if (acc.zone[i] && !(acc.bg[i] > acc.cnt[i])) { r = r * 0.5 + 120; g = g * 0.5; b = b * 0.5; }
      o[4 * i] = r; o[4 * i + 1] = g; o[4 * i + 2] = b; o[4 * i + 3] = 255;
    }
    this.mctx.putImageData(im, 0, 0);
    this.map.hidden = false;
  }
}
