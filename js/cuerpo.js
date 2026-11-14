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

export const VERSION = '4';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MOD_POSE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
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
const ARTIC = { hombro: 'hombro', codo: 'codo', muneca: 'muñeca', nudillos: 'nudillos (metacarpofalángicas)',
  cadera: 'cadera', rodilla: 'rodilla', tobillo: 'tobillo', dedo_pie: 'dedos del pie' };

const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = v => Math.hypot(v[0], v[1]);

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
  const r1 = el('div', 'row cap-main'); r1.append(bIni);
  const r2 = el('div', 'row cap-sec'); r2.append(bCapa, bPausa);
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
  const red = new Red(); let redOk = false, redProb = null;
  const peq = document.createElement('canvas'); const pctx = peq.getContext('2d', { willReadFrequently: true });

  async function cargarAtlas() {
    if (atlas) return;
    const a = new Atlas3D(ov);
    await Promise.all(Object.keys(SEG).map(s => a.cargar(s)));
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
      try { reconocer(); } catch (e) { msg.textContent = 'Error del reconocimiento: ' + e.message; }
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
      actual = r ? { seg: 'mano', lado: r.izq ? 1 : 0, vista: r.palma ? 'palma' : 'dorso' } : null;
      if (!r) atlas.ocultar();
      return;
    }
    // 2) Otros segmentos: el más grande que se vea entero (sus dos extremos dentro de la imagen)
    const rp = pose.detectForVideo(video, t);
    if (!(rp.landmarks && rp.landmarks[0] && rp.worldLandmarks && rp.worldLandmarks[0])) { actual = null; suave = null; atlas.ocultar(); return; }
    const [m, L] = suavizar('pose', rp.worldLandmarks[0], rp.landmarks[0]);
    const ve = i => (L[i].visibility == null || L[i].visibility > 0.65) && L[i].x > 0.01 && L[i].x < 0.99 && L[i].y > 0.01 && L[i].y < 0.99;
    let mejor = null;
    for (const seg of ['antebrazo', 'brazo', 'muslo', 'pierna', 'pie']) for (const lado of [0, 1]) {
      const ia = LM[SEG[seg].a][lado], ib = LM[SEG[seg].b][lado];
      if (!(ve(ia) && ve(ib))) continue;
      const l = len([(L[ib].x - L[ia].x) * W, (L[ib].y - L[ia].y) * H]);
      if (l < 0.12 * Math.min(W, H)) continue;   // muy chico: no es el segmento que se está mirando
      if (!mejor || l > mejor.l) mejor = { seg, lado, l, ia, ib };
    }
    if (!mejor) { actual = null; atlas.ocultar(); return; }
    const C = atlas.aCamara(m, L, [mejor.ia, mejor.ib]);
    if (!C) { actual = null; atlas.ocultar(); return; }
    const { seg, lado } = mejor, P = k => C[LM[k][lado]], S = SEG[seg];
    // Referencia de giro de cada segmento (en la cámara) y la misma en el atlas
    let r, ra;
    if (seg === 'antebrazo') {            // pronación: la palma
      r = P('indice').clone().sub(P('muneca')).cross(P('menique').clone().sub(P('muneca')));
      ra = E => E('mcp2').sub(E('muneca')).cross(E('mcp5').sub(E('muneca')));
    } else if (seg === 'brazo') {         // con el codo doblado: el antebrazo; estirado: hacia adelante del tronco
      const ab = P('codo').clone().sub(P('hombro')).normalize(), fa = P('muneca').clone().sub(P('codo')).normalize();
      if (ab.angleTo(fa) > 0.45) r = fa;
      else {
        const arriba = C[11].clone().add(C[12]).sub(C[23]).sub(C[24]), der = C[12].clone().sub(C[11]);
        r = arriba.cross(der);
      }
      ra = () => THREE_V(0, 0, 1);
    } else if (seg === 'muslo' || seg === 'pierna') {   // rotación: hacia dónde apunta el pie
      r = P('dedo').clone().sub(P('talon'));
      ra = E => E('dedo_pie').sub(E('talon'));
    } else {                               // pie: el eje de la pierna
      r = P('rodilla').clone().sub(P('tobillo'));
      ra = E => E('rodilla').sub(E('tobillo'));
    }
    const ok = atlas.segmento(seg, !!lado, P(S.a), P(S.b), r, ra, S.art[0], S.art[1]);
    actual = ok ? { seg, lado } : null;
    if (!ok) atlas.ocultar();
  }

  const nombreDe = (seg, lado) => SEG[seg].nombre + ' ' + (lado ? (SEG[seg].fem ? 'izquierda' : 'izquierdo') : (SEG[seg].fem ? 'derecha' : 'derecho'));
  function mostrarResultado() {
    resN.textContent = actual ? nombreDe(actual.seg, actual.lado) + (actual.vista ? ' · ' + actual.vista : '') : 'Buscando un segmento…';
    if (redProb) {
      const i = redProb.indexOf(Math.max(...redProb));
      resO.textContent = 'Nuestra red (aprendiendo): ' + red.nombres[i] + ' ' + Math.round(redProb[i] * 100) + '%';
    }
  }

  /* ---------- Tocar: qué estructura hay bajo el dedo ---------- */
  ov.addEventListener('pointerdown', e => {
    if (!atlas || !actual) return;
    const r = ov.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * atlas.W, y = (e.clientY - r.top) / r.height * atlas.H;
    const parte = atlas.tocar(x, y);
    const { huesos, musculos } = atlas.partesDe(actual.seg);
    det.hidden = false; det.innerHTML = '';
    det.append(el('div', 'cu-t', nombreDe(actual.seg, actual.lado)));
    det.append(el('div', 'cu-p', parte ? 'Tocaste: ' + parte.nombre + (parte.hueso ? ' (hueso)' : ' (músculo)') : 'Toca sobre el dibujo para ver la estructura.'));
    det.append(el('div', 'cu-l', 'Articulaciones: ' + SEG[actual.seg].art.map(a => ARTIC[a]).join(' → ')));
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
    if (atlas) { atlas.ponerCapa(capa); if (actual) atlas.pintar(); }
  };
  bPausa.onclick = () => {
    pausa = !pausa; bPausa.textContent = pausa ? '▶ Seguir' : '⏸ Pausar';
    if (pausa) { video.pause(); msg.textContent = 'En pausa: toca una parte para ver qué estructura es.'; }
    else { msg.textContent = ''; const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  };

  return { page, detener, get activo() { return activo; } };
}
