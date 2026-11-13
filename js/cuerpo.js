// cuerpo.js — La pantalla de la cámara: reconoce el segmento que ve y le pone encima músculo o hueso.
// · Solo la cámara de atrás.
// · Mano: MediaPipe Hand (21 puntos, sigue los dedos). Otros segmentos: MediaPipe Pose.
//   Los dos son gratis (Apache 2.0), corren en el teléfono y no envían imágenes.
// · Atlas: BodyParts3D © DBCLS, CC BY-SA 2.1 JP (imágenes ya preparadas en img/cuerpo/).
// · Nuestra red (red.js) corre al lado y aprende: «Correcto / Incorrecto» guarda fotos reales para reentrenarla.
// · Sin medidas por ahora.

import { Red } from './red.js';

export const VERSION = '3';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MOD_POSE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MOD_MANO = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const BASE = 'img/cuerpo/';

// Segmentos (salvo la mano): puntos de MediaPipe Pose (derecho, izquierdo) y articulaciones del atlas
const LM = { hombro: [12, 11], codo: [14, 13], muneca: [16, 15], cadera: [24, 23], rodilla: [26, 25], tobillo: [28, 27], dedo: [32, 31] };
const SEG = {
  mano: { nombre: 'Mano', fem: true, art: ['muneca', 'nudillos'] },
  antebrazo: { nombre: 'Antebrazo', a: 'codo', b: 'muneca', art: ['codo', 'muneca'] },
  brazo: { nombre: 'Brazo', a: 'hombro', b: 'codo', art: ['hombro', 'codo'] },
  muslo: { nombre: 'Muslo', a: 'cadera', b: 'rodilla', art: ['cadera', 'rodilla'] },
  pierna: { nombre: 'Pierna', fem: true, a: 'rodilla', b: 'tobillo', art: ['rodilla', 'tobillo'] },
  pie: { nombre: 'Pie', a: 'tobillo', b: 'dedo', art: ['tobillo', 'dedo_pie'] },
};
const ARTIC = { hombro: 'hombro', codo: 'codo', muneca: 'muñeca', nudillos: 'nudillos (metacarpofalángicas)',
  cadera: 'cadera', rodilla: 'rodilla', tobillo: 'tobillo', dedo_pie: 'dedos del pie' };
// Pares izquierdo/derecho de MediaPipe Pose (para corregir cuando confunde frente y espalda)
const PAR = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];

const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = v => Math.hypot(v[0], v[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const cruz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Afín que lleva 3 puntos (p) a 3 puntos (q): [a, b, c, d, e, f] para ctx.setTransform
function afin3(p, q) {
  const [x1, y1] = p[0], [x2, y2] = p[1], [x3, y3] = p[2];
  const det = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2);
  if (Math.abs(det) < 1e-6) return null;
  const sol = k => {
    const [u1, u2, u3] = [q[0][k], q[1][k], q[2][k]];
    return [(u1 * (y2 - y3) + u2 * (y3 - y1) + u3 * (y1 - y2)) / det,
      (u1 * (x3 - x2) + u2 * (x1 - x3) + u3 * (x2 - x1)) / det,
      (u1 * (x2 * y3 - x3 * y2) + u2 * (x3 * y1 - x1 * y3) + u3 * (x1 * y2 - x2 * y1)) / det];
  };
  const X = sol(0), Y = sol(1);
  return [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
}
// Afín de un segmento: el eje A→B de la imagen va al eje a→b del video; el ancho se escala con s2
function afinSeg(A, B, a, b, s2) {
  const ua = sub(B, A), la = len(ua), ub = sub(b, a), lb = len(ub);
  if (la < 1 || lb < 1) return null;
  const u = [ua[0] / la, ua[1] / la], n = [-u[1], u[0]], v = [ub[0] / lb, ub[1] / lb], m = [-v[1], v[0]];
  const s1 = lb / la;
  const M00 = s1 * v[0] * u[0] + s2 * m[0] * n[0], M01 = s1 * v[0] * u[1] + s2 * m[0] * n[1];
  const M10 = s1 * v[1] * u[0] + s2 * m[1] * n[0], M11 = s1 * v[1] * u[1] + s2 * m[1] * n[1];
  return [M00, M10, M01, M11, a[0] - (M00 * A[0] + M01 * A[1]), a[1] - (M10 * A[0] + M11 * A[1])];
}
const conEspejo = (T, W) => T && [-T[0], -T[1], T[2], T[3], T[0] * W + T[4], T[1] * W + T[5]];   // la imagen se voltea (x → W − x) antes de T
const espejo = (p, W) => [W - p[0], p[1]];
const invierte = (T, x, y) => {
  const [a, b, c, d, e, f] = T, det = a * d - b * c; if (!det) return null;
  const X = x - e, Y = y - f; return [(d * X - c * Y) / det, (-b * X + a * Y) / det];
};

/* ---------- Fotos reales para reentrenar nuestra red (se guardan en el teléfono) ---------- */
const BD = { db: null };
function abrirBD() {
  if (BD.db) return Promise.resolve(BD.db);
  return new Promise((ok, mal) => {
    let r; try { r = indexedDB.open('camara4d_fotos', 1); } catch (e) { mal(e); return; }
    r.onupgradeneeded = () => r.result.createObjectStore('fotos', { autoIncrement: true });
    r.onsuccess = () => { BD.db = r.result; ok(BD.db); };
    r.onerror = () => mal(r.error);
  });
}
async function bd(modo, fn) {
  const db = await abrirBD();
  return new Promise((ok, mal) => { const t = db.transaction('fotos', modo); const q = fn(t.objectStore('fotos')); t.oncomplete = () => ok(q && q.result); t.onerror = () => mal(t.error); });
}

export function crearCuerpo() {
  const page = el('section', 'page');
  const box = el('div', 'box');
  const vid = el('div', 'vid cu-vid');
  const video = el('video'); video.playsInline = true; video.muted = true;
  const ov = el('canvas'); const ctx = ov.getContext('2d');
  vid.append(video, ov);
  const bIni = el('button', 'pri big', 'Iniciar cámara');
  const bCapa = el('button', 'on', 'Capa: músculo');
  const bVista = el('button', '', 'Vista: automática');
  const bPausa = el('button', '', '⏸ Pausar');
  const r1 = el('div', 'row cap-main'); r1.append(bIni);
  const r2 = el('div', 'row cap-sec'); r2.append(bCapa, bVista, bPausa);
  const res = el('div', 'cu-res'); const resN = el('div', 'cu-n', '—'), resO = el('div', 'cu-o', ''); res.append(resN, resO);
  const det = el('div', 'cu-det'); det.hidden = true;
  // Enseñar a nuestra red
  const ens = el('div', 'cu-ens');
  const bOk = el('button', '', '✔ Correcto'), bMal = el('button', '', '✘ Incorrecto');
  const sel = el('select'); sel.hidden = true;
  const bGuardar = el('button', '', 'Guardar'); bGuardar.hidden = true;
  const nFotos = el('span', 'cu-o', '');
  const bBajar = el('button', '', '⬇ Descargar fotos');
  const r3 = el('div', 'row'); r3.append(bOk, bMal, sel, bGuardar);
  const r4 = el('div', 'row'); r4.append(nFotos, bBajar);
  ens.append(el('div', 'cu-t', 'Enseñar a nuestra red'), r3, r4);
  const msg = el('div', 'cu-msg', 'Pulsa «Iniciar cámara» y apunta a una mano, un brazo o una pierna. Toca una parte para ver qué estructura es.');
  const cred = el('small', '', 'Reconocimiento: MediaPipe (en el teléfono, gratis). Atlas: BodyParts3D © DBCLS, CC BY-SA 2.1 JP. Sin medidas por ahora.');
  box.append(vid, r1, r2, res, msg, det, ens, cred);
  page.appendChild(box);

  let atlas = null, pose = null, mano = null, stream = null, activo = false, pausa = false;
  let capa = 'musculo', manoVista = 'frente', fijaVista = null, dib = [], lastT = -1, actual = null, vistaPrev = 'frente', cuadro = 0;
  const red = new Red(); let redOk = false, redProb = null;
  const peq = document.createElement('canvas'); const pctx = peq.getContext('2d', { willReadFrequently: true });

  async function cargarAtlas() {
    if (atlas) return;
    const idx = await (await fetch(BASE + 'cuerpo.json')).json();
    const img = src => new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error('no cargó ' + src)); i.src = src; });
    const ims = {};
    await Promise.all(Object.keys(idx.segmentos).flatMap(seg => ['frente', 'espalda'].flatMap(v => ['musculo', 'hueso'].map(async c => {
      const k = `${seg}-${v}-${c}`, info = idx.segmentos[seg][v + '-' + c];
      const [col, id] = await Promise.all([img(BASE + k + '.webp'), img(BASE + k + '-id.png')]);
      const cv = document.createElement('canvas'); cv.width = info.W; cv.height = info.H;
      const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(id, 0, 0);
      ims[k] = { col, id: cx.getImageData(0, 0, info.W, info.H).data, ...info };
    }))));
    atlas = { idx, ims, detalle: {} };
  }
  function partesDe(seg) {
    if (atlas.detalle[seg]) return atlas.detalle[seg];
    const h = new Set(), m = new Set();
    for (const c of ['musculo', 'hueso']) for (const v of ['frente', 'espalda']) {
      const d = atlas.ims[`${seg}-${v}-${c}`].id;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i + 2] > 200) {
        const p = atlas.idx.partes[d[i] + (d[i + 1] << 8) - 1];
        if (p) (p[1] ? h : m).add(p[0]);
      }
    }
    return (atlas.detalle[seg] = { huesos: [...h], musculos: [...m] });
  }
  async function cargarModelos() {
    if (pose && mano) return;
    msg.textContent = 'Cargando el reconocimiento (la primera vez descarga unos 14 MB)…';
    const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import(MP + '/vision_bundle.mjs');
    const fs = await FilesetResolver.forVisionTasks(MP + '/wasm');
    const crea = async (Cls, url, extra) => {
      const o = d => ({ baseOptions: { modelAssetPath: url, delegate: d }, runningMode: 'VIDEO', ...extra });
      try { return await Cls.createFromOptions(fs, o('GPU')); } catch (e) { return Cls.createFromOptions(fs, o('CPU')); }
    };
    [pose, mano] = await Promise.all([
      crea(PoseLandmarker, MOD_POSE, { numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 }),
      crea(HandLandmarker, MOD_MANO, { numHands: 1, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 })]);
  }

  async function iniciar() {
    bIni.disabled = true;
    try {
      await Promise.all([cargarAtlas(), cargarModelos(), redOk ? null : red.cargar('img/red/').then(() => { redOk = true; peq.width = peq.height = red.N; }).catch(() => {})]);
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      const p = video.play(); if (p && p.catch) p.catch(() => {});
      const t0 = performance.now();
      while (!video.videoWidth) { if (performance.now() - t0 > 8000) throw new Error('la cámara no entregó imagen'); await new Promise(r => setTimeout(r, 50)); }
      ov.width = video.videoWidth; ov.height = video.videoHeight;
      activo = true; pausa = false; lastT = -1; actual = null;
      bIni.textContent = '⏹ Detener'; bIni.classList.add('stop'); bIni.disabled = false;
      msg.textContent = '';
      requestAnimationFrame(bucle);
    } catch (e) {
      bIni.disabled = false;
      msg.textContent = 'No pude iniciar: ' + (e.name === 'NotAllowedError' ? 'activa el permiso de cámara.' : e.message);
    }
  }
  function detener() {
    activo = false;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    bIni.textContent = 'Iniciar cámara'; bIni.classList.remove('stop');
    ctx.clearRect(0, 0, ov.width, ov.height);
  }

  function bucle() {
    if (!activo) return;
    if (!pausa && video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      try { reconocer(); } catch (e) { msg.textContent = 'Error del reconocimiento: ' + e.message; }
      // Nuestra red: uno de cada tres cuadros, sobre el cuadrado del centro
      if (redOk && ++cuadro % 3 === 0) {
        const W = video.videoWidth, H = video.videoHeight, L = Math.min(W, H);
        pctx.drawImage(video, (W - L) / 2, (H - L) / 2, L, L, 0, 0, red.N, red.N);
        const p = red.predecir(pctx.getImageData(0, 0, red.N, red.N));
        redProb = redProb ? redProb.map((v, i) => 0.6 * v + 0.4 * p[i]) : Array.from(p);
      }
      dibujar(); mostrarResultado();
    }
    requestAnimationFrame(bucle);
  }

  /* ---------- Reconocer el segmento ---------- */
  function reconocer() {
    const W = ov.width, H = ov.height, t = performance.now();
    // 1) Mano (de cerca)
    const rm = mano.detectForVideo(video, t);
    if (rm.landmarks && rm.landmarks.length) {
      const L = rm.landmarks[0].map(p => [p.x * W, p.y * H]);
      const cat = rm.handedness && rm.handedness[0] && rm.handedness[0][0];
      // MediaPipe supone imagen de espejo (selfie); con la cámara de atrás el lado se invierte
      const lado = cat ? (cat.categoryName === 'Left' ? 0 : 1) : 0;
      actual = { seg: 'mano', lado, pts: { muneca: L[0], mcp2: L[5], mcp5: L[17] }, conf: cat ? cat.score : 1 };
      return;
    }
    // 2) Otros segmentos: se elige el más grande que se vea entero (sus dos extremos dentro de la imagen)
    const rp = pose.detectForVideo(video, t);
    const L0 = rp.landmarks && rp.landmarks[0];
    if (!L0) { actual = null; return; }
    let L = L0.map(p => [p.x * W, p.y * H, p.visibility == null ? 1 : p.visibility, p.x, p.y]);
    let vista = vistaPrev;
    const ve = i => L[i][2] > 0.65 && L[i][3] > 0.01 && L[i][3] < 0.99 && L[i][4] > 0.01 && L[i][4] < 0.99;
    // ¿De frente o de espalda? Con un par de articulaciones visibles: de frente, la izquierda de la persona queda a la derecha de la imagen
    for (const [d, i] of [[12, 11], [24, 23], [26, 25], [28, 27]]) if (ve(d) && ve(i)) { vista = L[i][0] > L[d][0] ? 'frente' : 'espalda'; break; }
    if (fijaVista && fijaVista !== vista) { const C = L.slice(); for (const [a, b] of PAR) { C[a] = L[b]; C[b] = L[a]; } L = C; vista = fijaVista; }
    vistaPrev = vista;
    const ve2 = i => L[i][2] > 0.65 && L[i][3] > 0.01 && L[i][3] < 0.99 && L[i][4] > 0.01 && L[i][4] < 0.99;
    let mejor = null;
    for (const seg of ['antebrazo', 'brazo', 'muslo', 'pierna', 'pie']) for (const lado of [0, 1]) {
      const ia = LM[SEG[seg].a][lado], ib = LM[SEG[seg].b][lado];
      if (!(ve2(ia) && ve2(ib))) continue;
      const l = len(sub(L[ib], L[ia]));
      if (l < 0.12 * Math.min(W, H)) continue;   // muy chico: no es «el segmento» que se está mirando
      if (!mejor || l > mejor.l) mejor = { seg, lado, l, a: L[ia].slice(0, 2), b: L[ib].slice(0, 2) };
    }
    actual = mejor ? { ...mejor, vista } : null;
  }

  /* ---------- Dibujar el atlas sobre el segmento ---------- */
  function dibujar() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ov.width, ov.height);
    dib = [];
    if (!actual) return;
    const S = SEG[actual.seg];
    let d = null;
    if (actual.seg === 'mano') {
      // Eje muñeca → nudillos, con la proporción del atlas. El ancho se achica si la mano se ve de lado.
      // La orientación (muñeca, nudillo del índice, del meñique) dice si se ve la palma o el dorso.
      const P = actual.pts, b = mid(P.mcp2, P.mcp5), eje = len(sub(b, P.muneca));
      const cv = cruz(P.muneca, P.mcp2, P.mcp5);
      const im0 = atlas.ims[`mano-frente-${capa}`];
      let sa = Math.sign(cruz(im0.art.muneca, im0.art.mcp2, im0.art.mcp5)); if (actual.lado) sa = -sa;
      if (Math.abs(cv) > 0.12 * eje * eje) manoVista = Math.sign(cv) === sa ? 'frente' : 'espalda';   // de lado se mantiene la última
      const im = atlas.ims[`mano-${manoVista}-${capa}`], W = im.W;
      let A = im.art.muneca, B = im.art.nudillos, ancho = len(sub(im.art.mcp2, im.art.mcp5));
      if (actual.lado) { A = espejo(A, W); B = espejo(B, W); }
      const s1 = eje / len(sub(B, A));
      const s2 = s1 * Math.min(1, Math.max(0.4, len(sub(P.mcp2, P.mcp5)) / (ancho * s1)));
      let T = afinSeg(A, B, P.muneca, b, s2);
      if (actual.lado) T = conEspejo(T, W);
      if (T) d = { seg: 'mano', lado: actual.lado, vista: manoVista === 'frente' ? 'palma' : 'dorso', im, T };
    } else {
      const im = atlas.ims[`${actual.seg}-${actual.vista}-${capa}`];
      const A = im.art[S.art[0]], B = im.art[S.art[1]];
      const s = len(sub(actual.b, actual.a)) / len(sub(B, A));   // mantiene la proporción del atlas
      let T;
      if (actual.lado === 0) T = afinSeg(A, B, actual.a, actual.b, s);
      else T = conEspejo(afinSeg(espejo(A, im.W), espejo(B, im.W), actual.a, actual.b, s), im.W);
      if (T) d = { seg: actual.seg, lado: actual.lado, vista: actual.vista, im, T };
    }
    if (!d) return;
    dib.push(d);
    ctx.globalAlpha = 0.85; ctx.setTransform(...d.T); ctx.drawImage(d.im.col, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    if (marca) punto();
  }
  const nombreDe = (seg, lado) => SEG[seg].nombre + ' ' + (lado ? (SEG[seg].fem ? 'izquierda' : 'izquierdo') : (SEG[seg].fem ? 'derecha' : 'derecho'));
  function mostrarResultado() {
    if (actual) {
      const d = dib[0];
      resN.textContent = nombreDe(actual.seg, actual.lado) + (d ? ' · ' + (d.vista === 'frente' ? 'vista de frente' : d.vista === 'espalda' ? 'vista de espalda' : d.vista) : '');
    } else resN.textContent = 'Buscando un segmento…';
    if (redProb) {
      const i = redProb.indexOf(Math.max(...redProb));
      resO.textContent = 'Nuestra red (aprendiendo): ' + red.nombres[i] + ' ' + Math.round(redProb[i] * 100) + '%';
    }
  }

  /* ---------- Tocar: qué estructura hay bajo el dedo ---------- */
  let marca = null;
  const punto = () => { ctx.fillStyle = '#f7c948'; ctx.beginPath(); ctx.arc(marca[0], marca[1], ov.width / 90, 0, 6.283); ctx.fill(); };
  ov.addEventListener('pointerdown', e => {
    if (!atlas || !dib.length) return;
    const r = ov.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * ov.width, y = (e.clientY - r.top) / r.height * ov.height;
    const d = dib[0], q = invierte(d.T, x, y);
    if (!q) return;
    const qx = Math.round(q[0]), qy = Math.round(q[1]);
    let parte = null;
    if (qx >= 0 && qy >= 0 && qx < d.im.W && qy < d.im.H) {
      const o = (qy * d.im.W + qx) * 4, id = d.im.id;
      if (id[o + 3] > 200 && id[o + 2] > 200) parte = atlas.idx.partes[id[o] + (id[o + 1] << 8) - 1];
    }
    marca = [x, y];
    detalle(d, parte);
    if (pausa) dibujar();
  });
  function detalle(d, parte) {
    const { huesos, musculos } = partesDe(d.seg);
    det.hidden = false; det.innerHTML = '';
    det.append(el('div', 'cu-t', nombreDe(d.seg, d.lado)));
    det.append(el('div', 'cu-p', parte ? 'Tocaste: ' + parte[0] + (parte[1] ? ' (hueso)' : ' (músculo)') : 'Toca sobre el dibujo para ver la estructura.'));
    det.append(el('div', 'cu-l', 'Articulaciones: ' + SEG[d.seg].art.map(a => ARTIC[a]).join(' → ')));
    det.append(el('div', 'cu-l', 'Huesos: ' + (huesos.join(', ') || '—')));
    det.append(el('div', 'cu-l', 'Músculos: ' + (musculos.join(', ') || '—')));
  }

  /* ---------- Enseñar a nuestra red ---------- */
  async function contar() { try { nFotos.textContent = 'Fotos guardadas: ' + (await bd('readonly', s => s.count())); } catch (e) { nFotos.textContent = 'No se pueden guardar fotos en este navegador.'; } }
  function foto() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const W = video.videoWidth, H = video.videoHeight, L = Math.min(W, H);
    c.getContext('2d').drawImage(video, (W - L) / 2, (H - L) / 2, L, L, 0, 0, 128, 128);
    return c.toDataURL('image/jpeg', 0.9);
  }
  async function guardar(etiqueta) {
    if (!activo) { msg.textContent = 'Primero inicia la cámara.'; return; }
    try { await bd('readwrite', s => s.add({ etiqueta, foto: foto(), fecha: Date.now() })); msg.textContent = 'Foto guardada como «' + etiqueta + '».'; contar(); }
    catch (e) { msg.textContent = 'No pude guardar la foto: ' + e.message; }
  }
  bOk.onclick = () => {
    if (!actual) { msg.textContent = 'No hay segmento reconocido: usa «Incorrecto» y elige cuál es.'; return; }
    guardar(nombreDe(actual.seg, actual.lado));
  };
  bMal.onclick = async () => {
    if (!sel.options.length) {
      if (!redOk) { try { await red.cargar('img/red/'); redOk = true; peq.width = peq.height = red.N; } catch (e) { /* nada */ } }
      for (const n of red.nombres) { const o = el('option', '', n); o.value = n; sel.appendChild(o); }
    }
    sel.hidden = bGuardar.hidden = false;
  };
  bGuardar.onclick = () => { guardar(sel.value); sel.hidden = bGuardar.hidden = true; };
  bBajar.onclick = async () => {
    try {
      const fotos = await bd('readonly', s => s.getAll());
      if (!fotos || !fotos.length) { msg.textContent = 'Todavía no hay fotos guardadas.'; return; }
      const a = el('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(fotos)], { type: 'application/json' }));
      a.download = 'camara4d_fotos_' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
      msg.textContent = 'Descargadas ' + fotos.length + ' fotos. Mándame ese archivo para reentrenar la red.';
    } catch (e) { msg.textContent = 'No pude descargar: ' + e.message; }
  };
  contar();

  /* ---------- Botones ---------- */
  bIni.onclick = () => (activo ? detener() : iniciar());
  bCapa.onclick = () => {
    capa = capa === 'musculo' ? 'hueso' : 'musculo';
    bCapa.textContent = 'Capa: ' + (capa === 'musculo' ? 'músculo' : 'hueso');
    if (pausa) dibujar();
  };
  bVista.onclick = () => {
    fijaVista = fijaVista === null ? 'frente' : fijaVista === 'frente' ? 'espalda' : null;
    bVista.textContent = 'Vista: ' + (fijaVista || 'automática'); bVista.classList.toggle('on', !!fijaVista);
  };
  bPausa.onclick = () => {
    pausa = !pausa; bPausa.textContent = pausa ? '▶ Seguir' : '⏸ Pausar';
    if (pausa) { video.pause(); msg.textContent = 'En pausa: toca una parte para ver qué estructura es.'; }
    else { marca = null; msg.textContent = ''; const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  };

  return { page, detener, get activo() { return activo; } };
}
