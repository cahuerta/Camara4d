// cuerpo.js — La pantalla de la cámara: reconoce el segmento que ve y le pone encima músculo o hueso en 3D.
// · Solo la cámara de atrás.
// · Mano: MediaPipe Hand (21 puntos 3D, sigue cada dedo). Otros segmentos: MediaPipe Pose (puntos 3D).
//   Los dos son gratis (Apache 2.0), corren en el teléfono y no envían imágenes.
// · Atlas 3D (atlas3d.js): BodyParts3D © DBCLS, CC BY-SA 2.1 JP. Sigue el movimiento y el giro;
//   la escala sale del largo real de cada segmento de la persona.
// · Nuestra red (red.js) corre al lado y aprende: «Correcto / Incorrecto» guarda fotos reales para reentrenarla.

import { Red } from './red.js';
import { Atlas3D, THREE } from './atlas3d.js';
const THREE_V = (x, y, z) => new THREE.Vector3(x, y, z);

export const VERSION = '6';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MOD_POSE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MOD_SEG = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const MOD_MANO = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Segmentos (salvo la mano): puntos de MediaPipe Pose (derecho, izquierdo) y articulaciones del atlas
const LM = { hombro: [12, 11], codo: [14, 13], muneca: [16, 15], menique: [18, 17], indice: [20, 19],
  cadera: [24, 23], rodilla: [26, 25], tobillo: [28, 27], talon: [30, 29], dedo: [32, 31] };
const SEG = {
  mano: { nombre: 'Mano', fem: true, art: ['muneca', 'nudillos'] },
  antebrazo: { nombre: 'Antebrazo', a: 'codo', b: 'muneca', art: ['codo', 'muneca'] },
  brazo: { nombre: 'Brazo', a: 'hombro', b: 'codo', art: ['hombro', 'codo'] },
  muslo: { nombre: 'Muslo', a: 'cadera', b: 'rodilla', art: ['cadera', 'rodilla'] },
  pierna: { nombre: 'Pierna', fem: true, a: 'rodilla', b: 'tobillo', art: ['rodilla', 'tobillo'] },
  pie: { nombre: 'Pie', a: 'tobillo', b: 'dedo', art: ['tobillo', 'dedo_pie'] },
};
// Articulaciones: se dibujan las dos piezas que se juntan ahí, cada una con su movimiento
const ART = {
  hombro: { nombre: 'Hombro', piezas: ['hombro', 'brazo'] },
  codo: { nombre: 'Codo', piezas: ['brazo', 'antebrazo'] },
  cadera: { nombre: 'Cadera', fem: true, piezas: ['cadera', 'muslo'] },
  rodilla: { nombre: 'Rodilla', fem: true, piezas: ['muslo', 'pierna'] },
  tobillo: { nombre: 'Tobillo', piezas: ['pierna', 'pie'] },
};
const ZONA = k => SEG[k] || ART[k];
const ARTIC = { hombro: 'hombro', codo: 'codo', muneca: 'muñeca', nudillos: 'nudillos (metacarpofalángicas)',
  cadera: 'cadera', rodilla: 'rodilla', tobillo: 'tobillo', dedo_pie: 'dedos del pie' };

const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = v => Math.hypot(v[0], v[1]);

// Silueta de la piel (máscara w × h) → eje del segmento en píxeles del video (W × H).
// Centro y dirección por componentes principales; el extremo más ancho se toma como proximal
// (muslo, pierna, brazo, antebrazo; en el pie es al revés). Devuelve null si hay poca piel.
export function ajustarSilueta(mask, w, h, W, H, esPiel) {
  const sx = W / w, sy = H / h;
  let n = 0, mx = 0, my = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (esPiel(mask[y * w + x])) { n++; mx += x; my += y; }
  if (n < 0.04 * w * h) return null;
  mx = mx / n * sx; my = my / n * sy;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (esPiel(mask[y * w + x])) {
    const dx = x * sx - mx, dy = y * sy - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy), u = [Math.cos(ang), Math.sin(ang)], v = [-u[1], u[0]];
  // Largo y ancho: percentiles a lo largo y a lo ancho del eje
  const ts = [], ss = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (esPiel(mask[y * w + x])) {
    const dx = x * sx - mx, dy = y * sy - my; ts.push(dx * u[0] + dy * u[1]); ss.push([dx * u[0] + dy * u[1], dx * v[0] + dy * v[1]]);
  }
  const ord = ts.slice().sort((a, b) => a - b), t0 = ord[Math.floor(n * 0.05)], t1 = ord[Math.floor(n * 0.95)];
  const anchoEn = (ta, tb) => { const xs = ss.filter(p => p[0] >= ta && p[0] <= tb).map(p => p[1]).sort((a, b) => a - b); return xs.length > 20 ? xs[Math.floor(xs.length * 0.95)] - xs[Math.floor(xs.length * 0.05)] : 0; };
  const L = t1 - t0, ancho = anchoEn(t0 + 0.3 * L, t0 + 0.7 * L);
  const wa = anchoEn(t0, t0 + 0.2 * L), wb = anchoEn(t1 - 0.2 * L, t1);
  return { centro: [mx, my], u, ancho, anchoInicio: wa, anchoFin: wb };
}

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
  const ov = el('canvas');
  vid.append(video, ov);
  const bIni = el('button', 'pri big', 'Iniciar cámara');
  const bCapa = el('button', 'on', 'Capa: músculo');
  const bPausa = el('button', '', '⏸ Pausar');
  const bSeg = el('button', '', 'De cerca: automático');
  const r1 = el('div', 'row cap-main'); r1.append(bIni);
  const r2 = el('div', 'row cap-sec'); r2.append(bCapa, bSeg, bPausa);
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
  const cred = el('small', '', 'Reconocimiento: MediaPipe (en el teléfono, gratis). Atlas 3D: BodyParts3D © DBCLS, CC BY-SA 2.1 JP. La escala se ajusta sola a cada persona; aún sin medidas.');
  box.append(vid, r1, r2, res, msg, det, ens, cred);
  page.appendChild(box);

  let atlas = null, pose = null, mano = null, stream = null, activo = false, pausa = false;
  let capa = 'musculo', lastT = -1, actual = null, cuadro = 0, suave = null;
  let segm = null, segmCargando = false, eleccion = null;   // de cerca: silueta de la piel; eleccion = segmento elegido a mano
  const red = new Red(); let redOk = false, redProb = null;
  const peq = document.createElement('canvas'); const pctx = peq.getContext('2d', { willReadFrequently: true });

  async function cargarAtlas() {
    if (atlas) return;
    const a = new Atlas3D(ov);
    await Promise.all(Object.keys(SEG).concat(['hombro', 'cadera']).map(s => a.cargar(s)));
    a.ponerCapa(capa);
    atlas = a;
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

  // El modelo de silueta se carga aparte, sin hacer esperar (solo se usa de cerca)
  async function cargarSilueta() {
    if (segm || segmCargando) return;
    segmCargando = true;
    try {
      const { FilesetResolver, ImageSegmenter } = await import(MP + '/vision_bundle.mjs');
      const fs = await FilesetResolver.forVisionTasks(MP + '/wasm');
      const o = d => ({ baseOptions: { modelAssetPath: MOD_SEG, delegate: d }, runningMode: 'VIDEO', outputCategoryMask: true, outputConfidenceMasks: false });
      try { segm = await ImageSegmenter.createFromOptions(fs, o('GPU')); } catch (e) { segm = await ImageSegmenter.createFromOptions(fs, o('CPU')); }
    } catch (e) { msg.textContent = 'No se pudo cargar el reconocimiento de cerca: ' + e.message; }
    segmCargando = false;
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
      atlas.tamano(video.videoWidth, video.videoHeight);
      activo = true; pausa = false; lastT = -1; actual = null;
      bIni.textContent = '⏹ Detener'; bIni.classList.add('stop'); bIni.disabled = false;
      msg.textContent = '';
      cargarSilueta();
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
    if (atlas) atlas.ocultar();
  }

  function bucle() {
    if (!activo) return;
    if (!pausa && video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      atlas.empezar();
      try { reconocer(); } catch (e) { msg.textContent = 'Error del reconocimiento: ' + e.message; }
      atlas.pintar();
      // Nuestra red: uno de cada tres cuadros, sobre el cuadrado del centro
      if (redOk && ++cuadro % 3 === 0) {
        const W = video.videoWidth, H = video.videoHeight, L = Math.min(W, H);
        pctx.drawImage(video, (W - L) / 2, (H - L) / 2, L, L, 0, 0, red.N, red.N);
        const p = red.predecir(pctx.getImageData(0, 0, red.N, red.N));
        redProb = redProb ? redProb.map((v, i) => 0.6 * v + 0.4 * p[i]) : Array.from(p);
      }
      mostrarResultado();
    }
    requestAnimationFrame(bucle);
  }

  /* ---------- Reconocer el segmento y poner el atlas 3D ---------- */
  // Suavizado de los puntos entre cuadros (para que no tiemble)
  function suavizar(tipo, mundo, img) {
    const m = mundo.map(p => ({ x: p.x, y: p.y, z: p.z })), i = img.map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }));
    if (suave && suave.tipo === tipo) {
      const k = 0.5;
      for (let j = 0; j < m.length; j++) for (const c of ['x', 'y', 'z']) { m[j][c] = k * m[j][c] + (1 - k) * suave.m[j][c]; i[j][c] = k * i[j][c] + (1 - k) * suave.i[j][c]; }
    }
    suave = { tipo, m, i };
    return [m, i];
  }
  function reconocer() {
    const W = video.videoWidth, H = video.videoHeight, t = performance.now();
    // 1) Mano (de cerca): cada falange sigue su dedo
    const rm = mano.detectForVideo(video, t);
    if (rm.landmarks && rm.landmarks.length && rm.worldLandmarks && rm.worldLandmarks.length) {
      const [m, i] = suavizar('mano', rm.worldLandmarks[0], rm.landmarks[0]);
      const r = atlas.mano(m, i);
      actual = r ? { zona: 'mano', lado: r.izq ? 1 : 0, piezas: ['mano'], vista: r.palma ? 'palma' : 'dorso' } : null;
      return;
    }
    // 2) Con el cuerpo a la vista (MediaPipe Pose): lo que está al centro de la imagen, segmento o articulación
    const rp = pose.detectForVideo(video, t);
    if (!(rp.landmarks && rp.landmarks[0] && rp.worldLandmarks && rp.worldLandmarks[0])) { suave = null; deCerca(t); return; }
    const [m, L] = suavizar('pose', rp.worldLandmarks[0], rp.landmarks[0]);
    const dentro = i => L[i].x > 0.01 && L[i].x < 0.99 && L[i].y > 0.01 && L[i].y < 0.99;
    const ve = i => (L[i].visibility == null || L[i].visibility > 0.6) && dentro(i);
    const px = i => [L[i].x * W, L[i].y * H], c = [W / 2, H / 2], D = Math.min(W, H);
    const dSeg = (p, a, b) => { const ab = sub(b, a), t2 = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1))); return len(sub(p, [a[0] + t2 * ab[0], a[1] + t2 * ab[1]])); };
    // Piezas que se pueden dibujar (sus dos extremos a la vista)
    const puede = (pz, lado) => {
      if (pz === 'hombro') return [11, 12].every(i => L[i].visibility > 0.5) && ve(LM.hombro[lado]);
      if (pz === 'cadera') return [23, 24].every(i => L[i].visibility > 0.5) && ve(LM.cadera[lado]);
      const S = SEG[pz]; return ve(LM[S.a][lado]) && ve(LM[S.b][lado]) && len(sub(px(LM[S.b][lado]), px(LM[S.a][lado]))) > 0.08 * D;
    };
    let foco = null;
    // Articulación cerca del centro
    for (const k in ART) for (const lado of [0, 1]) {
      const i = LM[k][lado]; if (!ve(i)) continue;
      const d = len(sub(px(i), c)); if (d > 0.15 * D) continue;
      const piezas = ART[k].piezas.filter(pz => puede(pz, lado));
      if (piezas.length && (!foco || d < foco.d)) foco = { zona: k, lado, d, piezas };
    }
    // Si no, el segmento más cercano al centro
    if (!foco) for (const seg of ['antebrazo', 'brazo', 'muslo', 'pierna', 'pie']) for (const lado of [0, 1]) {
      if (!puede(seg, lado)) continue;
      const d = dSeg(c, px(LM[SEG[seg].a][lado]), px(LM[SEG[seg].b][lado]));
      if (!foco || d < foco.d) foco = { zona: seg, lado, d, piezas: [seg] };
    }
    if (!foco) { deCerca(t); return; }
    // Profundidad con los extremos de las piezas que se dibujan
    const ancla = new Set();
    for (const pz of foco.piezas) {
      if (pz === 'hombro') [11, 12].forEach(i => ancla.add(i));
      else if (pz === 'cadera') [23, 24].forEach(i => ancla.add(i));
      else { ancla.add(LM[SEG[pz].a][foco.lado]); ancla.add(LM[SEG[pz].b][foco.lado]); }
    }
    const C = atlas.aCamara(m, L, [...ancla]);
    if (!C) { actual = null; return; }
    const hechas = foco.piezas.filter(pz => colocarPieza(pz, foco.lado, C, L));
    actual = hechas.length ? { zona: foco.zona, lado: foco.lado, piezas: hechas } : null;
  }

  // Pone una pieza con su giro. C: puntos en la cámara; L: puntos en la imagen (para saber qué se ve)
  function colocarPieza(pz, lado, C, L) {
    const P = k => C[LM[k][lado]];
    const ejeTronco = () => {
      const caderasOk = L[23].visibility > 0.3 && L[24].visibility > 0.3, hombrosOk = L[11].visibility > 0.3 && L[12].visibility > 0.3;
      return caderasOk && hombrosOk ? C[11].clone().add(C[12]).sub(C[23]).sub(C[24]) : THREE_V(0, 1, 0);
    };
    if (pz === 'hombro' || pz === 'cadera') {
      const [i, d] = pz === 'hombro' ? [11, 12] : [23, 24];
      const arriba = ejeTronco(), der = C[d].clone().sub(C[i]);
      return atlas.tronco(pz, !!lado, P(pz), arriba, arriba.clone().cross(der), C[d].distanceTo(C[i]), pz);
    }
    const S = SEG[pz];
    let r, ra;
    if (pz === 'antebrazo') {            // pronación: la palma
      r = P('indice').clone().sub(P('muneca')).cross(P('menique').clone().sub(P('muneca')));
      ra = E => E('mcp2').sub(E('muneca')).cross(E('mcp5').sub(E('muneca')));
    } else if (pz === 'brazo') {         // con el codo doblado: el antebrazo; estirado: hacia adelante del tronco
      const ab = P('codo').clone().sub(P('hombro')).normalize(), fa = P('muneca').clone().sub(P('codo')).normalize();
      r = ab.angleTo(fa) > 0.45 ? fa : ejeTronco().cross(C[12].clone().sub(C[11]));
      ra = () => THREE_V(0, 0, 1);
    } else if (pz === 'muslo' || pz === 'pierna') {   // rotación: hacia dónde apunta el pie
      r = P('dedo').clone().sub(P('talon'));
      ra = E => E('dedo_pie').sub(E('talon'));
    } else {                               // pie: el eje de la pierna
      r = P('rodilla').clone().sub(P('tobillo'));
      ra = E => E('rodilla').sub(E('tobillo'));
    }
    return atlas.segmento(pz, !!lado, P(S.a), P(S.b), r, ra, S.art[0], S.art[1]);
  }

  // De cerca (no se ve el cuerpo): silueta de la piel + zona elegida a mano o la que dice nuestra red
  const RED_ZONA = { antebrazo: 'Antebrazo', brazo: 'Brazo', muslo: 'Muslo', pierna: 'Pierna', pie: 'Pie', codo: 'Codo', rodilla: 'Rodilla', tobillo: 'Tobillo' };
  function zonaDeLaRed() {
    if (!redProb) return null;
    let mejor = null;
    for (const z in RED_ZONA) for (const lado of [0, 1]) {
      const i = red.nombres.findIndex(n => n.startsWith(RED_ZONA[z] + ' ') && (lado ? /izquierd/.test(n) : /derech/.test(n)));
      if (i >= 0 && (!mejor || redProb[i] > mejor.p)) mejor = { zona: z, lado, p: redProb[i] };
    }
    return mejor && mejor.p > 0.5 ? mejor : null;
  }
  function deCerca(t) {
    const elegido = eleccion ? { zona: eleccion, lado: null } : zonaDeLaRed();
    if (!elegido) { actual = { sinZona: true }; return; }
    if (!segm && !window.__mascaraPrueba) { actual = null; return; }
    let fit = null;
    const W = video.videoWidth, H = video.videoHeight;
    const prueba = window.__mascaraPrueba;   // solo para pruebas automáticas
    const usar = (arr, w, h) => {
      // 2 = piel del cuerpo; si casi no hay piel (con ropa), también la ropa (4)
      let piel = 0; for (let i = 0; i < arr.length; i++) if (arr[i] === 2) piel++;
      const esPiel = piel > 0.04 * arr.length ? c => c === 2 : c => c === 2 || c === 4;
      fit = ajustarSilueta(arr, w, h, W, H, esPiel);
    };
    if (prueba) { const m = prueba(); usar(m.arr, m.w, m.h); }
    else segm.segmentForVideo(video, t, r => { const m = r.categoryMask; if (m) usar(m.getAsUint8Array(), m.width, m.height); });
    if (!fit) { actual = null; return; }
    // El extremo más ancho es el proximal (en el pie, el más angosto: el tobillo)
    let u = fit.u, cerca = fit.anchoInicio >= fit.anchoFin;
    if (elegido.zona === 'pie') cerca = !cerca;
    if (!cerca) u = [-u[0], -u[1]];
    const izq = elegido.lado === 1;
    let ok, piezas;
    if (SEG[elegido.zona]) {
      const S = SEG[elegido.zona]; piezas = [elegido.zona];
      ok = atlas.silueta(piezas, izq, fit.centro, u, fit.ancho, S.art[0], S.art[1]);
    } else {
      // Articulación de cerca: sus dos piezas, estiradas, con la articulación al centro de la silueta
      piezas = ART[elegido.zona].piezas;
      const a = SEG[piezas[0]].art[0], b = SEG[piezas[1]].art[1], j = elegido.zona;
      const A = atlas.segs[piezas[0]].art, tj = A[a].distanceTo(A[j]) / A[a].distanceTo(A[b]);
      ok = atlas.silueta(piezas, izq, fit.centro, u, fit.ancho, a, b, j, tj - 0.1, tj + 0.1);
    }
    actual = ok ? { zona: elegido.zona, lado: elegido.lado, piezas, deCerca: true } : null;
  }

  const nombreDe = (zona, lado) => { const Z = ZONA(zona); return Z.nombre + (lado == null ? '' : ' ' + (lado ? (Z.fem ? 'izquierda' : 'izquierdo') : (Z.fem ? 'derecha' : 'derecho'))); };
  function mostrarResultado() {
    if (actual && actual.sinZona) resN.textContent = 'De cerca: elige qué es con el botón «De cerca»';
    else resN.textContent = actual ? nombreDe(actual.zona, actual.lado) + (actual.vista ? ' · ' + actual.vista : '') + (actual.deCerca ? ' · de cerca (vista de frente)' : '') : 'Buscando un segmento…';
    if (redProb) {
      const i = redProb.indexOf(Math.max(...redProb));
      resO.textContent = 'Nuestra red (aprendiendo): ' + red.nombres[i] + ' ' + Math.round(redProb[i] * 100) + '%';
    }
  }

  /* ---------- Tocar: qué estructura hay bajo el dedo ---------- */
  ov.addEventListener('pointerdown', e => {
    if (!atlas || !actual || !actual.piezas) return;
    const r = ov.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * atlas.W, y = (e.clientY - r.top) / r.height * atlas.H;
    const parte = atlas.tocar(x, y);
    const { huesos, musculos } = atlas.partesDe(actual.piezas);
    det.hidden = false; det.innerHTML = '';
    det.append(el('div', 'cu-t', nombreDe(actual.zona, actual.lado)));
    det.append(el('div', 'cu-p', parte ? 'Tocaste: ' + parte.nombre + (parte.hueso ? ' (hueso)' : ' (músculo)') : 'Toca sobre el dibujo para ver la estructura.'));
    if (SEG[actual.zona]) det.append(el('div', 'cu-l', 'Articulaciones: ' + SEG[actual.zona].art.map(a => ARTIC[a]).join(' → ')));
    det.append(el('div', 'cu-l', 'Huesos: ' + (huesos.join(', ') || '—')));
    det.append(el('div', 'cu-l', 'Músculos: ' + (musculos.join(', ') || '—')));
  });

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
    if (!actual || !actual.zona) { msg.textContent = 'No hay segmento reconocido: usa «Incorrecto» y elige cuál es.'; return; }
    if (actual.lado == null) { msg.textContent = 'No sé el lado: usa «Incorrecto» y elige el segmento con su lado.'; return; }
    guardar(nombreDe(actual.zona, actual.lado));
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
    if (atlas) { atlas.ponerCapa(capa); if (actual) atlas.pintar(); }
  };
  const ORDEN_SEG = [null, 'brazo', 'codo', 'antebrazo', 'muslo', 'rodilla', 'pierna', 'tobillo', 'pie'];
  bSeg.onclick = () => {
    eleccion = ORDEN_SEG[(ORDEN_SEG.indexOf(eleccion) + 1) % ORDEN_SEG.length];
    bSeg.textContent = 'De cerca: ' + (eleccion ? ZONA(eleccion).nombre.toLowerCase() : 'automático');
    bSeg.classList.toggle('on', !!eleccion);
  };
  bPausa.onclick = () => {
    pausa = !pausa; bPausa.textContent = pausa ? '▶ Seguir' : '⏸ Pausar';
    if (pausa) { video.pause(); msg.textContent = 'En pausa: toca una parte para ver qué estructura es.'; }
    else { msg.textContent = ''; const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  };

  return { page, detener, get activo() { return activo; } };
}
