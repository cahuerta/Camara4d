// cuerpo.js — Pantalla «Cuerpo»: reconoce el cuerpo con la cámara y le superpone el atlas anatómico por segmento.
// · Reconocimiento: MediaPipe Pose (gratis, Apache 2.0, corre en el teléfono, sin cuenta ni clave).
// · Atlas: BodyParts3D © DBCLS, CC BY-SA 2.1 JP (imágenes ya preparadas en img/cuerpo/).
// · Por ahora sin medidas: solo se reconoce cada segmento y se muestra su detalle (huesos, músculos, articulaciones).
// Este módulo arma su propia pantalla; main.js solo la agrega al menú.

export const VERSION = '1';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODELO = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const BASE = 'img/cuerpo/';

// Segmentos de las extremidades: puntos de MediaPipe (derecho, izquierdo) y articulaciones del atlas
const LM = { hombro: [12, 11], codo: [14, 13], muneca: [16, 15], menique: [18, 17], indice: [20, 19],
  cadera: [24, 23], rodilla: [26, 25], tobillo: [28, 27], dedo: [32, 31] };
const SEG = {
  brazo: { nombre: 'Brazo', a: 'hombro', b: 'codo', art: ['hombro', 'codo'] },
  antebrazo: { nombre: 'Antebrazo', a: 'codo', b: 'muneca', art: ['codo', 'muneca'] },
  mano: { nombre: 'Mano', a: 'muneca', b: 'nudillos', art: ['muneca', 'nudillos'] },
  muslo: { nombre: 'Muslo', a: 'cadera', b: 'rodilla', art: ['cadera', 'rodilla'] },
  pierna: { nombre: 'Pierna', a: 'rodilla', b: 'tobillo', art: ['rodilla', 'tobillo'] },
  pie: { nombre: 'Pie', a: 'tobillo', b: 'dedo', art: ['tobillo', 'dedo_pie'] },
};
const ARTIC = { hombro: 'hombro', codo: 'codo', muneca: 'muñeca', nudillos: 'nudillos (metacarpofalángicas)',
  cadera: 'cadera', rodilla: 'rodilla', tobillo: 'tobillo', dedo_pie: 'dedos del pie' };
const ORDEN = ['tronco', 'muslo', 'pierna', 'pie', 'brazo', 'antebrazo', 'mano'];   // de atrás hacia adelante

const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = v => Math.hypot(v[0], v[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Afín que lleva 3 puntos (p) a 3 puntos (q): devuelve [a, b, c, d, e, f] para ctx.setTransform
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
// Afín de un segmento: el eje A→B de la imagen va al eje a→b del video; el ancho se escala con el tamaño del cuerpo (s2)
function afinSeg(A, B, a, b, s2) {
  const ua = sub(B, A), la = len(ua), ub = sub(b, a), lb = len(ub);
  if (la < 1 || lb < 1) return null;
  const u = [ua[0] / la, ua[1] / la], n = [-u[1], u[0]], v = [ub[0] / lb, ub[1] / lb], m = [-v[1], v[0]];
  const s1 = lb / la;
  // M = s1·v·uᵀ + s2·m·nᵀ
  const M00 = s1 * v[0] * u[0] + s2 * m[0] * n[0], M01 = s1 * v[0] * u[1] + s2 * m[0] * n[1];
  const M10 = s1 * v[1] * u[0] + s2 * m[1] * n[0], M11 = s1 * v[1] * u[1] + s2 * m[1] * n[1];
  return [M00, M10, M01, M11, a[0] - (M00 * A[0] + M01 * A[1]), a[1] - (M10 * A[0] + M11 * A[1])];
}
const conEspejo = (T, W) => T && [-T[0], -T[1], T[2], T[3], T[0] * W + T[4], T[1] * W + T[5]];   // la imagen se voltea (x → W − x) antes de T
const invierte = (T, x, y) => {
  const [a, b, c, d, e, f] = T, det = a * d - b * c; if (!det) return null;
  const X = x - e, Y = y - f; return [(d * X - c * Y) / det, (-b * X + a * Y) / det];
};

export function crearCuerpo({ ocupado }) {
  const page = el('section', 'page');
  const box = el('div', 'box');
  const vid = el('div', 'vid cu-vid');
  const video = el('video'); video.playsInline = true; video.muted = true;
  const ov = el('canvas'); const ctx = ov.getContext('2d');
  vid.append(video, ov);
  const bIni = el('button', 'pri big', 'Reconocer cuerpo');
  const bPausa = el('button', '', '⏸ Pausar'); bPausa.disabled = true;
  const bCam = el('button', '', '🔄 Cambiar cámara');
  const bCapa = el('button', 'on', 'Capa: músculo');
  const bVista = el('button', '', 'Vista: automática');
  const lAlfa = el('label'); lAlfa.textContent = 'Transparencia';
  const alfa = el('input'); alfa.type = 'range'; alfa.min = '0.2'; alfa.max = '1'; alfa.step = '0.05'; alfa.value = '0.8'; lAlfa.appendChild(alfa);
  const r1 = el('div', 'row cap-main'); r1.append(bIni);
  const r2 = el('div', 'row cap-sec'); r2.append(bPausa, bCam, bCapa, bVista);
  const r3 = el('div', 'row'); r3.append(lAlfa);
  const msg = el('div', 'cu-msg', 'Pulsa «Reconocer cuerpo» y enfoca a la persona entera, de frente o de espalda. Toca una parte para ver su detalle.');
  const det = el('div', 'cu-det'); det.hidden = true;
  const cred = el('small', '', 'Reconocimiento: MediaPipe Pose (en el teléfono). Atlas: BodyParts3D © DBCLS, CC BY-SA 2.1 JP. Sin medidas por ahora.');
  box.append(vid, r1, r2, r3, msg, det, cred);
  page.appendChild(box);

  let atlas = null, pose = null, stream = null, activo = false, pausa = false, frente = false;   // frente = cámara frontal (selfie)
  let capa = 'musculo', lms = null, dib = [], lastT = -1, fijaVista = null;   // fijaVista: null (automática) | 'frente' | 'espalda'

  async function cargarAtlas() {
    if (atlas) return atlas;
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
    return atlas;
  }
  // Las partes de cada segmento se sacan del mapa de identificación (lo que de verdad se ve en la imagen)
  function partesDe(seg) {
    if (atlas.detalle[seg]) return atlas.detalle[seg];
    const h = new Set(), m = new Set();
    for (const c of ['musculo', 'hueso']) for (const v of ['frente', 'espalda']) {
      const d = atlas.ims[`${seg}-${v}-${c}`].id;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i + 2] > 200) {
        const n = d[i] + (d[i + 1] << 8) - 1, p = atlas.idx.partes[n];
        if (p) (p[1] ? h : m).add(p[0]);
      }
    }
    return (atlas.detalle[seg] = { huesos: [...h], musculos: [...m] });
  }

  async function cargarPose() {
    if (pose) return pose;
    msg.textContent = 'Cargando el reconocimiento del cuerpo (la primera vez descarga unos 6 MB)…';
    const { FilesetResolver, PoseLandmarker } = await import(MP + '/vision_bundle.mjs');
    const fs = await FilesetResolver.forVisionTasks(MP + '/wasm');
    const opc = d => ({ baseOptions: { modelAssetPath: MODELO, delegate: d }, runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { pose = await PoseLandmarker.createFromOptions(fs, opc('GPU')); }
    catch (e) { pose = await PoseLandmarker.createFromOptions(fs, opc('CPU')); }
    return pose;
  }

  async function abrirCamara() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: frente ? 'user' : 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
    const t0 = performance.now();
    while (!video.videoWidth) { if (performance.now() - t0 > 8000) throw new Error('la cámara no entregó imagen'); await new Promise(r => setTimeout(r, 50)); }
    ov.width = video.videoWidth; ov.height = video.videoHeight;
    vid.classList.toggle('espejo', frente);   // la cámara frontal se ve como espejo (imagen y dibujo juntos)
  }

  async function iniciar() {
    if (ocupado && ocupado()) { msg.textContent = 'Primero termina la captura en la pantalla 📷 Captura.'; return; }
    bIni.disabled = true;
    try {
      await Promise.all([cargarAtlas(), cargarPose()]);
      await abrirCamara();
      activo = true; pausa = false; lms = null; lastT = -1;
      bIni.textContent = '⏹ Detener'; bIni.classList.add('stop'); bIni.disabled = false; bPausa.disabled = false; bPausa.textContent = '⏸ Pausar';
      msg.textContent = 'Buscando el cuerpo… Enfoca a la persona entera.';
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
    bIni.textContent = 'Reconocer cuerpo'; bIni.classList.remove('stop'); bPausa.disabled = true;
    ctx.clearRect(0, 0, ov.width, ov.height);
  }

  function bucle() {
    if (!activo) return;
    if (!pausa && video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      try {
        const r = pose.detectForVideo(video, performance.now());
        const L = r.landmarks && r.landmarks[0];
        if (L) {
          const W = ov.width, H = ov.height;
          const nuevo = L.map(p => [p.x * W, p.y * H, p.visibility == null ? 1 : p.visibility]);
          // suavizado para que el dibujo no tiemble
          lms = lms ? nuevo.map((p, i) => [0.55 * p[0] + 0.45 * lms[i][0], 0.55 * p[1] + 0.45 * lms[i][1], p[2]]) : nuevo;
        } else lms = null;
      } catch (e) { msg.textContent = 'Error del reconocimiento: ' + e.message; }
      dibujar();
    }
    requestAnimationFrame(bucle);
  }

  // ¿Se ve de frente o de espalda? De frente, el hombro izquierdo de la persona queda a la derecha de la imagen.
  // De espalda el reconocimiento a veces cree que la persona mira a la cámara y cambia derecha por izquierda:
  // si se fija la vista a mano y no coincide, se intercambian los lados.
  const PAR = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
  function vistaDe(L) {
    const auto = L[11][0] > L[12][0] ? 'frente' : 'espalda';
    if (!fijaVista || fijaVista === auto) return [L, auto];
    const C = L.slice(); for (const [a, b] of PAR) { C[a] = L[b]; C[b] = L[a]; }
    return [C, fijaVista];
  }

  function dibujar() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ov.width, ov.height);
    dib = [];
    if (!lms) { if (!pausa) msg.textContent = 'Buscando el cuerpo… Enfoca a la persona entera.'; return; }
    const [L, vista] = vistaDe(lms), ve = i => L[i][2] > 0.5, P = i => [L[i][0], L[i][1]];
    const tr = atlas.ims[`tronco-${vista}-${capa}`];
    // Escala del cuerpo: largo del tronco en el video / en el atlas (todas las imágenes tienen la misma escala)
    let s2 = null;
    if ([11, 12, 23, 24].every(i => L[i][2] > 0.3)) {   // de espalda la confianza del tronco es menor
      const ta = len(sub(mid(tr.art.hombro, tr.art.hombro_i), mid(tr.art.cadera, tr.art.cadera_i)));
      s2 = len(sub(mid(P(11), P(12)), mid(P(23), P(24)))) / ta;
    }
    const A = +alfa.value;
    for (const seg of ORDEN) {
      if (seg === 'tronco') {
        if (!s2) continue;
        // Hombro derecho, hombro izquierdo y centro de las caderas
        const T = afin3([tr.art.hombro, tr.art.hombro_i, mid(tr.art.cadera, tr.art.cadera_i)], [P(12), P(11), mid(P(24), P(23))]);
        // Control: el tronco no puede quedar volteado ni aplastado (si pasa, el reconocimiento falló en este cuadro)
        const ancho = len(sub(P(11), P(12))), largo = s2 * len(sub(mid(tr.art.hombro, tr.art.hombro_i), mid(tr.art.cadera, tr.art.cadera_i)));
        if (T && T[0] * T[3] - T[1] * T[2] > 0 && largo > 0.6 * ancho) dib.push({ seg, lado: null, im: tr, T, vista });
        continue;
      }
      const S = SEG[seg];
      for (const lado of [0, 1]) {   // 0 = derecho, 1 = izquierdo
        let a, b;
        if (S.b === 'nudillos') {
          const ia = LM.muneca[lado], i1 = LM.menique[lado], i2 = LM.indice[lado];
          if (!(ve(ia) && ve(i1) && ve(i2))) continue;
          a = P(ia); b = mid(P(i1), P(i2));
        } else {
          const ia = LM[S.a][lado], ib = LM[S.b][lado];
          if (!(ve(ia) && ve(ib))) continue;
          a = P(ia); b = P(ib);
        }
        const im = atlas.ims[`${seg}-${vista}-${capa}`];
        const la = len(sub(im.art[S.art[1]], im.art[S.art[0]]));
        // Control: un segmento más largo que 1,5 veces el del atlas (a la escala del cuerpo) es un error del reconocimiento
        if (s2 && len(sub(b, a)) > 1.5 * s2 * la) continue;
        const sp = s2 || len(sub(b, a)) / la;
        let T;
        if (lado === 0) T = afinSeg(im.art[S.art[0]], im.art[S.art[1]], a, b, sp);
        else {   // lado izquierdo: la misma imagen volteada
          const Am = [im.W - im.art[S.art[0]][0], im.art[S.art[0]][1]], Bm = [im.W - im.art[S.art[1]][0], im.art[S.art[1]][1]];
          T = conEspejo(afinSeg(Am, Bm, a, b, sp), im.W);
        }
        if (T) dib.push({ seg, lado, im, T, vista });
      }
    }
    ctx.globalAlpha = A;
    for (const d of dib) { ctx.setTransform(...d.T); ctx.drawImage(d.im.col, 0, 0); }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    // Nombre de cada segmento
    ctx.font = `600 ${Math.round(ov.width / 45)}px system-ui,sans-serif`; ctx.textAlign = 'center';
    for (const d of dib) {
      if (d.seg === 'tronco') continue;
      const c = [d.im.W / 2, d.im.H / 2], p = [d.T[0] * c[0] + d.T[2] * c[1] + d.T[4], d.T[1] * c[0] + d.T[3] * c[1] + d.T[5]];
      etiqueta(SEG[d.seg].nombre + (d.lado ? ' izq.' : ' der.'), p);
    }
    if (!pausa) msg.textContent = 'Cuerpo reconocido · vista de ' + vista + ' · ' + dib.length + ' segmentos. Toca una parte (o «Pausar» para tocar con calma).';
  }
  function etiqueta(t, p) {
    const w = ctx.measureText(t).width + 10, h = ov.width / 32;
    p = [Math.min(ov.width - w / 2 - 2, Math.max(w / 2 + 2, p[0])), Math.min(ov.height - h / 2 - 2, Math.max(h / 2 + 2, p[1]))];   // dentro de la imagen
    ctx.save();
    if (frente) { ctx.translate(p[0], p[1]); ctx.scale(-1, 1); ctx.translate(-p[0], -p[1]); }   // que el texto no salga al revés en espejo
    ctx.fillStyle = 'rgba(5,7,11,.7)'; ctx.fillRect(p[0] - w / 2, p[1] - h / 2, w, h);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(t, p[0], p[1]);
    ctx.restore();
  }

  // Toque: se busca de adelante hacia atrás qué segmento y qué estructura hay bajo el dedo
  ov.addEventListener('pointerdown', e => {
    if (!atlas || !dib.length) return;
    const r = ov.getBoundingClientRect();
    let fx = (e.clientX - r.left) / r.width; if (frente) fx = 1 - fx;
    const x = fx * ov.width, y = (e.clientY - r.top) / r.height * ov.height;
    for (let k = dib.length - 1; k >= 0; k--) {
      const d = dib[k], q = invierte(d.T, x, y);
      if (!q) continue;
      const qx = Math.round(q[0]), qy = Math.round(q[1]);
      if (qx < 0 || qy < 0 || qx >= d.im.W || qy >= d.im.H) continue;
      const o = (qy * d.im.W + qx) * 4, id = d.im.id;
      if (id[o + 3] < 200 || id[o + 2] < 200) continue;
      const parte = atlas.idx.partes[id[o] + (id[o + 1] << 8) - 1];
      let lado = d.lado;
      if (d.seg === 'tronco') lado = (d.vista === 'frente' ? qx < d.im.midX : qx > d.im.midX) ? 0 : 1;
      mostrar(d.seg, lado, d.vista, parte);
      marca = [x, y]; if (pausa) { dibujar(); punto(); }
      return;
    }
  });
  let marca = null;
  const punto = () => { if (!marca) return; ctx.fillStyle = '#f7c948'; ctx.beginPath(); ctx.arc(marca[0], marca[1], ov.width / 90, 0, 6.283); ctx.fill(); };

  function mostrar(seg, lado, vista, parte) {
    const nombre = seg === 'tronco' ? 'Tronco' : SEG[seg].nombre;
    const ladoTxt = lado == null ? '' : lado ? ' izquierdo' : ' derecho';
    const { huesos, musculos } = partesDe(seg);
    det.hidden = false; det.innerHTML = '';
    det.append(el('div', 'cu-t', nombre + ladoTxt + ' · vista de ' + vista));
    if (parte) det.append(el('div', 'cu-p', 'Tocaste: ' + parte[0] + (parte[1] ? ' (hueso)' : ' (músculo)')));
    if (seg !== 'tronco') det.append(el('div', 'cu-l', 'Articulaciones: ' + SEG[seg].art.map(a => ARTIC[a]).join(' → ')));
    det.append(el('div', 'cu-l', 'Huesos: ' + (huesos.join(', ') || '—')));
    det.append(el('div', 'cu-l', 'Músculos: ' + (musculos.join(', ') || '—')));
  }

  bIni.onclick = () => (activo ? detener() : iniciar());
  bPausa.onclick = () => {
    pausa = !pausa;
    bPausa.textContent = pausa ? '▶ Seguir' : '⏸ Pausar';
    if (pausa) { video.pause(); msg.textContent = 'En pausa: toca una parte para ver su detalle.'; }
    else { marca = null; const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  };
  bCam.onclick = async () => { frente = !frente; if (activo) { try { await abrirCamara(); lms = null; } catch (e) { msg.textContent = 'No pude cambiar de cámara: ' + e.message; } } };
  bCapa.onclick = () => {
    capa = capa === 'musculo' ? 'hueso' : 'musculo';
    bCapa.textContent = 'Capa: ' + (capa === 'musculo' ? 'músculo' : 'hueso');
    if (lms) { dibujar(); punto(); }
  };
  bVista.onclick = () => {
    fijaVista = fijaVista === null ? 'frente' : fijaVista === 'frente' ? 'espalda' : null;
    bVista.textContent = 'Vista: ' + (fijaVista || 'automática');
    bVista.classList.toggle('on', !!fijaVista);
    if (lms) { dibujar(); punto(); }
  };
  alfa.oninput = () => { if (lms) { dibujar(); punto(); } };

  return { page, detener, get activo() { return activo; } };
}
