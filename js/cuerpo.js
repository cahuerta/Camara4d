// cuerpo.js — Pantalla «Cuerpo»: nuestra red reconoce qué segmento del cuerpo ve la cámara (y de qué lado).
// · Solo la cámara de atrás.
// · Se analiza el cuadrado del centro de la imagen (se dibuja en pantalla).
// · Primero el segmento; las capas (músculo, hueso) vienen después.
// Este módulo arma su propia pantalla; main.js solo la agrega al menú.

import { Red } from './red.js';

export const VERSION = '2';

const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

export function crearCuerpo({ ocupado }) {
  const page = el('section', 'page');
  const box = el('div', 'box');
  const vid = el('div', 'vid cu-vid');
  const video = el('video'); video.playsInline = true; video.muted = true;
  const ov = el('canvas'); const ctx = ov.getContext('2d');
  vid.append(video, ov);
  const bIni = el('button', 'pri big', 'Reconocer segmento');
  const r1 = el('div', 'row cap-main'); r1.append(bIni);
  const res = el('div', 'cu-res');
  const resN = el('div', 'cu-n', '—'), resO = el('div', 'cu-o', '');
  res.append(resN, resO); res.hidden = true;
  const msg = el('div', 'cu-msg', 'Pulsa «Reconocer segmento» y apunta con la cámara de atrás a una parte del cuerpo, dentro del cuadrado.');
  const cred = el('small', '', 'Red propia, entrenada con imágenes generadas de modelos 3D (MakeHuman, CC0). Funciona en el teléfono, sin enviar imágenes.');
  box.append(vid, r1, res, msg, cred);
  page.appendChild(box);

  const red = new Red();
  let cargada = false, stream = null, activo = false, prom = null, ms = 0;
  const peq = document.createElement('canvas');
  const pctx = peq.getContext('2d', { willReadFrequently: true });

  async function iniciar() {
    if (ocupado && ocupado()) { msg.textContent = 'Primero termina la captura en la pantalla 📷 Captura.'; return; }
    bIni.disabled = true;
    try {
      if (!cargada) { msg.textContent = 'Cargando la red…'; await red.cargar('img/red/'); cargada = true; }
      peq.width = peq.height = red.N;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      const p = video.play(); if (p && p.catch) p.catch(() => {});
      const t0 = performance.now();
      while (!video.videoWidth) { if (performance.now() - t0 > 8000) throw new Error('la cámara no entregó imagen'); await new Promise(r => setTimeout(r, 50)); }
      ov.width = video.videoWidth; ov.height = video.videoHeight;
      activo = true; prom = null;
      bIni.textContent = '⏹ Detener'; bIni.classList.add('stop'); bIni.disabled = false;
      res.hidden = false; msg.textContent = '';
      bucle();
    } catch (e) {
      bIni.disabled = false;
      msg.textContent = 'No pude iniciar: ' + (e.name === 'NotAllowedError' ? 'activa el permiso de cámara.' : e.message);
    }
  }
  function detener() {
    activo = false;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    bIni.textContent = 'Reconocer segmento'; bIni.classList.remove('stop');
    ctx.clearRect(0, 0, ov.width, ov.height);
  }

  function bucle() {
    if (!activo) return;
    const t0 = performance.now();
    if (video.readyState >= 2) {
      // Cuadrado del centro → imagen de 96 × 96 para la red
      const W = video.videoWidth, H = video.videoHeight, L = Math.min(W, H), x0 = (W - L) / 2, y0 = (H - L) / 2;
      pctx.drawImage(video, x0, y0, L, L, 0, 0, red.N, red.N);
      const p = red.predecir(pctx.getImageData(0, 0, red.N, red.N));
      // Promedio de los últimos cuadros para que el resultado no salte
      prom = prom ? prom.map((v, i) => 0.6 * v + 0.4 * p[i]) : Array.from(p);
      ms = 0.8 * ms + 0.2 * (performance.now() - t0);
      mostrar(x0, y0, L);
    }
    setTimeout(bucle, Math.max(30, 120 - (performance.now() - t0)));
  }

  function mostrar(x0, y0, L) {
    // Segmento: suma de sus dos lados. El lado se muestra aparte (es lo más difícil para la red).
    const segs = [];
    for (let i = 0; i < 20; i += 2) segs.push({ n: red.nombres[i].split(' ')[0], p: prom[i] + prom[i + 1], lado: prom[i] >= prom[i + 1] ? 0 : 1, pl: Math.max(prom[i], prom[i + 1]) / (prom[i] + prom[i + 1] || 1), fem: /a$/.test(red.nombres[i]) });
    segs.push({ n: 'Tronco', p: prom[20] }, { n: 'Cabeza o cuello', p: prom[21] }, { n: 'Nada', p: prom[22] });
    segs.sort((a, b) => b.p - a.p);
    const s1 = segs[0];
    let txt, ok = false;
    if (s1.n === 'Nada') txt = 'No veo una parte del cuerpo';
    else if (s1.p < 0.45) txt = 'No estoy seguro…';
    else {
      ok = true; txt = s1.n + ' · ' + Math.round(s1.p * 100) + '%';
      if (s1.lado != null) txt += s1.pl >= 0.7 ? ' · ' + (s1.lado ? (s1.fem ? 'izquierda' : 'izquierdo') : (s1.fem ? 'derecha' : 'derecho')) + ' (' + Math.round(s1.pl * 100) + '%)' : ' · lado no seguro';
    }
    resN.textContent = txt;
    resO.textContent = 'Otras: ' + segs.slice(1, 3).map(s => s.n + ' ' + Math.round(s.p * 100) + '%').join(' · ') + ' · ' + Math.round(ms) + ' ms';
    // Cuadrado que se analiza
    ctx.clearRect(0, 0, ov.width, ov.height);
    ctx.lineWidth = Math.max(3, ov.width / 200);
    ctx.strokeStyle = ok ? '#3ddc84' : '#f7c948';
    ctx.strokeRect(x0 + 2, y0 + 2, L - 4, L - 4);
  }

  bIni.onclick = () => (activo ? detener() : iniciar());

  return { page, detener, get activo() { return activo; } };
}
