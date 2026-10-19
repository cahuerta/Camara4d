// main.js — Conecta los módulos: cámara → seguimiento → posición de la cámara → profundidad → MODELO ÚNICO → visor.
// Todo el cálculo es propio (sin librerías externas). Los cálculos pesados van en segundo plano (worker.js).
//
// Reglas de la captura:
//  · El modelo es uno solo y SOLO SUMA. Nada se borra hasta pulsar «Nueva captura».
//  · Si la cámara pierde el objeto, no se reinicia ni se suma nada: queda «Buscando el objeto» hasta reconocerlo
//    desde cualquier cara ya capturada, y desde ahí sigue sumando.
//  · Solo «Terminar» detiene la captura. Al terminar, la toma se guarda en el teléfono y se sube al servidor,
//    que puede unir tomas hechas en momentos distintos o con otros teléfonos.

import { Camera } from './camera.js';
import { Tracker, computeFeatures, matchFeatures, thumbnail, VERSION as TRACKER_VERSION } from './tracker.js';
import { reconstructTwoView, pnpRefine, pnpRelocalize, reprojErrors, mul3, tr3, mv3, VERSION as GEOMETRY_VERSION } from './geometry.js';
import { denseDepth, VERSION as DENSE_VERSION } from './dense.js';
import { Sensors } from './sensors.js';
import { Volume, viewerCloud, sizeOf, sheetMask, VERSION as VOL_VERSION } from './volumen.js';
import { detectMarkers, correspondences, poseFromHomography, reprojError, FocalCal, openPrintable, ZONA, VERSION as HOJA_VERSION } from './hoja.js';
import { Viewer } from './viewer.js';
import { exportJSON } from './export.js';
import { Assist, VERSION as ASSIST_VERSION } from './assist.js';
import { Model, camCenter, toWorld, localTomas, serverApi, alignModels, movePose, b64, unb64, VERSION as MODEL_VERSION } from './fragments.js';

const $ = id => document.getElementById(id);

const cam = new Camera($('video'), document.createElement('canvas'));
const sensors = new Sensors();
const viewer = new Viewer($('view'));
const tracker = new Tracker();
let model = new Model();             // tramo activo de la captura (todo se suma aquí)
const ov = $('ov'), octx = ov.getContext('2d');
const vidBox = ov.parentElement;
const assist = new Assist({ vidBox, controls: $('controls') });

/* ---------- Grabación de prueba (automática) ----------
   Mientras se captura se guardan cuadros de la cámara (1 de cada 3, en JPEG). Al terminar se pueden bajar desde
   «Resultado» como un archivo para revisar o reproducir exactamente lo que vio la cámara. */
const rec = {
  frames: [], on: false, busy: 0, intr: null,
  start() { this.frames = []; this.on = true; this.busy = 0; },
  frame(no) {
    if (!this.on || no % 3 || this.frames.length >= 600 || this.busy > 2) return;
    this.busy++;
    const t = Math.round(performance.now());
    cam.ctx.canvas.toBlob(b => { this.busy--; if (b && this.on) this.frames.push({ t, b }); }, 'image/jpeg', 0.75);
  },
  stop(intr) { this.on = false; this.intr = intr; },
  async download() {
    if (!this.frames.length) return;
    const parts = ['{"formato":"camara4d-grabacion","version":1,"app":"' + APP_VERSION + '","fov":' + (this.intr ? this.intr.fov : parseFloat($('fov').value)) +
      ',"w":' + cam.width + ',"h":' + cam.height + ',"cuadros":['];
    for (let i = 0; i < this.frames.length; i++) {
      const u8 = new Uint8Array(await this.frames[i].b.arrayBuffer());
      parts.push((i ? ',' : '') + '{"t":' + this.frames[i].t + ',"jpg":"' + b64(u8) + '"}');
    }
    parts.push(']}');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
    a.download = 'camara4d-grabacion-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
};

const FACTOR = 2;                    // la profundidad se calcula a la mitad de la resolución de trabajo
const KF_BASE = 0.10;                // nueva vista guardada al moverse ~10 % de la distancia al objeto…
const KF_ROT = 10 * Math.PI / 180;   // …o al girar 10°
const MAX_KF_IMAGES = 40;            // vistas cuya imagen se conserva (memoria del teléfono)
const API_DEFAULT = 'https://camara4d-backend.onrender.com';

let running = false;
let state = 'idle';                  // 'idle' | 'init' | 'track' | 'lost' | 'finishing' | 'done'
let capNo = 0;                       // número de captura (descarta resultados de una captura anterior)
let intr = null;                     // { f, cx, cy, w, h } de esta captura
let pose = null;                     // pose actual de la cámara { R, t } (p_cam = R·X + t)
let fails = 0;                       // cuadros seguidos sin poder ubicar la cámara
let kfSeq = 0, kfList = [], lastKf = null, kf0 = null;
let jobs = [], jobBusy = false;
let relocAt = 0, viewAt = 0, viewProj = null, cloudAt = 0;
let poses = [], cloud = [], frameNo = 0;
let lastMsg = '';
// Tramos: si se pierde el objeto, la captura NO se detiene: empieza un tramo nuevo al tiro y sigue grabando.
// Cuando el tramo nuevo reconoce una parte ya capturada, se une solo al modelo anterior. Los que no se alcancen
// a unir en el teléfono se unen al terminar, o en el servidor.
let parts = [];                      // tramos anteriores sin unir: { model, kfList, roiObject }

// MODO HOJA: la hoja impresa da la posición exacta de la cámara y las medidas reales (metros)
let sheetMode = true;
try { sheetMode = localStorage.getItem('camara4d_modo') !== 'libre'; } catch (e) { /* nada */ }
let sheetCal = null, sheetDets = [], sheetSeen = 0;
let vol = null, volPts = null, volAt = 0;   // capas: forma → relieve → color
let sectors = new Set();                    // lados ya vistos alrededor de la hoja (12 de 30°)
let linkAt = 0, linkKfs = 0, curJob = null;
const simApply = (T, p) => { const q = mv3(T.R, p); return [T.s * q[0] + T.t[0], T.s * q[1] + T.t[1], T.s * q[2] + T.t[2]]; };

// Recuadro del objeto (en píxeles del canvas de trabajo) y limpieza de fondo
let roi = null, roiDraft = null, marking = false, dragStart = null, cleanBg = true;

const stat = m => { if (m !== lastMsg) { $('status').textContent = m; lastMsg = m; } };
const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
const med = a => { if (!a.length) return 0; const q = a.slice().sort((x, y) => x - y); return q[q.length >> 1]; };

/* ---------- Versión y textos de la página ---------- */
// index.html es fijo: la versión, los textos y los controles nuevos los pone este archivo.
const APP_VERSION = '19';
const showErr = m => (window.showAppError ? window.showAppError(m) : stat(m));
$('title').innerHTML = 'Cámara 4D <span>v' + APP_VERSION + '</span>';
$('help').textContent = 'El modelo 3D se arma con la profundidad de cada píxel y crece con cada vista. Un dedo gira, el pellizco (o la rueda del mouse) acerca y aleja. ' +
  'w = intensidad de cada punto (oscuro −1, claro +1); con peso 0 ves el modelo normal.';
stat('Pulsa «Iniciar cámara» y gira alrededor del objeto. Todo se suma a un solo modelo; si se pierde el seguimiento, la grabación sigue sola y lo nuevo se une después. Solo «Terminar» detiene la captura.');
{
  const bad = [];
  if (TRACKER_VERSION !== '6') bad.push('js/tracker.js');
  if (GEOMETRY_VERSION !== '6') bad.push('js/geometry.js');
  if (DENSE_VERSION !== '8') bad.push('js/dense.js');
  if (ASSIST_VERSION !== '4') bad.push('js/assist.js');
  if (MODEL_VERSION !== '5') bad.push('js/fragments.js');
  if (HOJA_VERSION !== '1') bad.push('js/hoja.js');
  if (VOL_VERSION !== '1') bad.push('js/volumen.js');
  if (bad.length) showErr('Archivos de otra versión: ' + bad.join(', ') + '. Súbelos de nuevo.');
}

/* ---------- Proceso en segundo plano ---------- */
let worker = null, jobSeq = 0;
const pending = new Map();
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const cb = pending.get(e.data.id);
    if (!cb) return;
    pending.delete(e.data.id);
    cb(e.data);
  };
  worker.onerror = e => {
    showErr('Proceso en segundo plano: ' + (e.message || 'error') + '. Revisa que js/worker.js esté subido. Sigo sin él (más lento).');
    worker = null;
    for (const cb of pending.values()) cb({ error: 'proceso detenido' });
    pending.clear();
  };
} catch (e) { worker = null; }

function runJob(msg, transfer, cb) {
  if (worker) {
    msg.id = ++jobSeq;
    pending.set(msg.id, cb);
    worker.postMessage(msg, transfer);
    return;
  }
  if (msg.type === 'dense') {
    try { cb({ dm: denseDepth(msg.ref, msg.cur, msg.R, msg.t, msg.f, msg.cx, msg.cy, msg.range, msg.opts) }); }
    catch (e) { cb({ error: e.message }); }
  } else cb({ errs: null });
}

/* ---------- Segundo proceso en segundo plano: máscaras de la hoja (capa forma) ---------- */
// Va aparte del de profundidad para que ninguno espere al otro
let volWorker = null, volSeq = 0, volBusy = 0;
const volPending = new Map();
try {
  volWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  volWorker.onmessage = e => { const cb = volPending.get(e.data.id); if (cb) { volPending.delete(e.data.id); cb(e.data); } };
  volWorker.onerror = () => { volWorker = null; for (const cb of volPending.values()) cb({ error: 'proceso detenido' }); volPending.clear(); };
} catch (e) { volWorker = null; }

// Tallar el volumen con una vista: la máscara se calcula en segundo plano y el tallado al recibirla
function carveView(kf) {
  const v = vol, cap = capNo, I = intr, img = kf.img;
  const done = mask => {
    if (vol === v && capNo === cap && mask) { v.carveMask(mask, img.width, img.height, kf.R, kf.t, I.f, I.cx, I.cy); kf.carved = true; }
    if (mask && ses && capNo === cap) sesSendView(kf, img, mask, I);
  };
  if (!volWorker) { done(sheetMask(img, kf.R, kf.t, I.f, I.cx, I.cy)); return; }
  const copy = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const id = ++volSeq;
  volBusy++;
  volPending.set(id, r => { volBusy--; done(r.mask || null); });
  volWorker.postMessage({ type: 'mask', id, img: copy, R: kf.R, t: kf.t, f: I.f, cx: I.cx, cy: I.cy }, [copy.data.buffer]);
}

/* ---------- Focal automática ---------- */
// Se mide al comienzo de la captura y, si la focal actual está claramente equivocada, se corrige para la
// PRÓXIMA captura (cambiarla a mitad de una captura desarmaría el modelo).
const FOVS = [50, 55, 60, 65, 70, 75, 80, 85];
let focal = { done: false, best: new Array(FOVS.length).fill(Infinity), n: 0, busy: false };
try {
  const saved = parseFloat(localStorage.getItem('camara4d_fov'));
  if (saved >= 35 && saved <= 120) { $('fov').value = saved; $('fovV').textContent = saved; focal.done = true; }
} catch (e) { /* sin almacenamiento */ }

function calibrateFocal(pts) {
  if (focal.done || focal.busy || !worker || pts.length < 40) return;
  const p1 = new Float32Array(pts.length * 2), p2 = new Float32Array(pts.length * 2);
  pts.forEach((p, k) => { p1[2 * k] = p.ox; p1[2 * k + 1] = p.oy; p2[2 * k] = p.x; p2[2 * k + 1] = p.y; });
  focal.busy = true;
  runJob({ type: 'focal', fovs: FOVS, n: pts.length, p1, p2, long: Math.max(cam.width, cam.height), cx: cam.width / 2, cy: cam.height / 2 }, [p1.buffer, p2.buffer], r => {
    focal.busy = false;
    if (!r.errs || focal.done || r.errs.every(e => !isFinite(e))) return;
    r.errs.forEach((e, i) => { if (e < focal.best[i]) focal.best[i] = e; });
    if (++focal.n < 4) return;
    focal.done = true;
    let best = 0;
    for (let i = 1; i < FOVS.length; i++) if (focal.best[i] < focal.best[best]) best = i;
    const curFov = parseFloat($('fov').value);
    let curIdx = 0;
    for (let i = 1; i < FOVS.length; i++) if (Math.abs(FOVS[i] - curFov) < Math.abs(FOVS[curIdx] - curFov)) curIdx = i;
    const fov = best !== curIdx && focal.best[best] < 0.75 * focal.best[curIdx] ? FOVS[best] : curFov;
    try { localStorage.setItem('camara4d_fov', String(fov)); } catch (e) { /* nada */ }
    if (fov !== curFov) {
      $('fov').value = fov; $('fovV').textContent = fov;
      showNote('La focal de tu cámara es ' + fov + '°: se usará desde la próxima captura.');
    }
  });
}

/* ---------- Cámara ---------- */
async function startCamera() {
  try {
    await cam.start();
    ov.width = cam.width;
    ov.height = cam.height;
    running = true;
    model = new Model();
    parts = [];
    rec.start();
    startSheet();
    resetCapture();
    viewer.setCloud([]);
    updateProgress();
    $('bExp').disabled = false;
    $('bRoi').disabled = false;
    $('bEnd').disabled = false;
    $('bNew').disabled = true;
    stat('Cámara lista. Apunta al objeto y muévete despacio de lado para empezar.');
    loop();
    return true;
  } catch (err) {
    const msg = 'No pude abrir la cámara: ' + err.name + ' — ' + err.message +
      (err.name === 'NotAllowedError' ? '. Activa el permiso de cámara: toca el ícono junto a la dirección web → Permisos → Cámara.' : '.');
    stat(msg);
    showErr(msg);
    return false;
  }
}

function resetCapture() {
  capNo++;
  state = 'idle';
  pose = null; fails = 0;
  kfSeq = 0; kfList = []; lastKf = null; kf0 = null;
  jobs = []; jobBusy = false; curJob = null; linkAt = 0; linkKfs = 0;
  poses = []; cloud = []; frameNo = 0; viewProj = null;
  tracker.reset();
  assist.reset();
  roiObject = false;
}

$('bStart').onclick = async () => {
  $('bStart').disabled = true;
  await sensors.enable();
  if (!(await startCamera())) $('bStart').disabled = false;
};
$('bEnd').onclick = () => finish();
// «Nueva captura»: borra el modelo y empieza otra
$('bNew').onclick = async () => {
  $('bNew').disabled = true;
  if (!(await startCamera())) $('bNew').disabled = false;
};

/* ---------- Bucle ---------- */
function loop() {
  if (!running) return;
  const t0 = performance.now();
  try { step(); } catch (e) { showErr('Error: ' + e.message); }
  setTimeout(loop, Math.max(15, 66 - (performance.now() - t0)));
}

function step() {
  cam.grab();
  if (marking) { drawOverlay(); return; }
  const img = cam.ctx.getImageData(0, 0, cam.width, cam.height);
  frameNo++;
  rec.frame(frameNo);
  if (sheetMode) {
    stepSheet(img);
    if (state === 'track' && pose && performance.now() - viewAt > 300) {
      viewProj = model.project(pose.R, pose.t, intr.f, intr.cx, intr.cy, intr.w, intr.h, 4);
      viewAt = performance.now();
    }
    if (running) assist.update({ img, pts: [], state: state === 'track' ? 'track' : 'init', view: state === 'track' ? viewProj : null,
      det: Math.min(1, sheetDets.length / 10), msg: sheetMsg });
    drawOverlay();
    return;
  }
  if (state === 'idle') startInit(img);
  else if (state === 'init') stepInit(img);
  else if (state === 'track') stepTrack(img);
  // Tramo nuevo que aún no arranca: se intenta reconocer lo ya capturado para volver al mismo modelo
  if ((state === 'idle' || state === 'init') && parts.length) tryResume(img);
  // Tramo activo con datos: se intenta unir con los tramos anteriores
  if (state === 'track' && parts.length) tryLink();
  if (state === 'track' && pose && performance.now() - viewAt > 300) {
    viewProj = model.project(pose.R, pose.t, intr.f, intr.cx, intr.cy, intr.w, intr.h, 4);
    viewAt = performance.now();
  }
  if (running) assist.update({ img, pts: tracker.pts, state: state === 'idle' ? 'init' : state, view: state === 'track' ? viewProj : null });
  drawOverlay();
}

/* ---------- MODO HOJA ---------- */
let sheetMsg = '';
function startSheet() {
  sheetDets = []; sheetSeen = 0; sheetMsg = ''; intr = null;
  sheetCal = new FocalCal(Math.max(cam.width, cam.height));
  // Focal ya medida con la hoja en este teléfono: no hace falta volver a calibrar
  try {
    const fov = parseFloat(localStorage.getItem('camara4d_fov_hoja'));
    if (fov >= 35 && fov <= 110) { sheetCal.done = true; sheetCal.fov = fov; }
  } catch (e) { /* nada */ }
  vol = null; volPts = null; volAt = 0; sectors = new Set();
  if (sheetMode) {
    model.hoja = { x0: ZONA.x0 / 1000, x1: ZONA.x1 / 1000, y0: ZONA.y0 / 1000, y1: ZONA.y1 / 1000 };
    model.obj = { c: [0, 0, 0.05], r: 0.2 };
    vol = new Volume(model.hoja, 0.002, 0.16);
  }
}

const refineSheet = (X, uv, f, cx, cy, R, t) => pnpRefine(X, uv, f, cx, cy, R, t, { iters: 8, sigma: 1.5, thr: 3 });

function stepSheet(img) {
  sheetDets = detectMarkers(img);
  const { X, uv } = correspondences(sheetDets);
  if (!intr) {
    const fov = sheetCal.done ? sheetCal.fov : parseFloat($('fov').value);
    intr = { f: cam.focalPx(fov), cx: cam.width / 2, cy: cam.height / 2, w: cam.width, h: cam.height, fov };
  }
  if (X.length < 8) {
    sheetMsg = sheetDets.length ? '📄 Se ve poco de la hoja: aléjate un poco para que entren más cuadros negros' : '📄 Apunta a la hoja (con el objeto al centro)';
    stat(sheetSeen ? 'No veo la hoja: apúntala de nuevo. Lo capturado se conserva.' : 'Apunta a la hoja impresa con el objeto encima. ¿No la tienes? «Imprimir hoja».');
    if (state === 'track') state = 'init';
    return;
  }
  sheetSeen++;
  // Focal: se mide con la hoja la primera vez (necesita vistas inclinadas)
  if (!sheetCal.done) {
    if (frameNo % 3 === 0) sheetCal.add(X, uv, intr.cx, intr.cy, refineSheet);
    if (!sheetCal.done) {
      sheetMsg = '📐 Calibrando la cámara: muévete alrededor e inclina el teléfono (' + Math.min(8, sheetCal.frames.length) + '/8)';
      stat('Calibrando la cámara con la hoja: muévete despacio alrededor e inclina el teléfono.');
      return;
    }
    // Solo se guarda para las próximas veces si calzó bien (hoja plana)
    if (sheetCal.err < 2) try { localStorage.setItem('camara4d_fov_hoja', String(sheetCal.fov)); } catch (e) { /* nada */ }
    if (sheetCal.err >= 2) showNote('Aviso: la hoja no parece estar plana (error ' + sheetCal.err.toFixed(1) + ' px). Ponla sobre una mesa o un cartón para mejor resultado.');
    intr = { f: cam.focalPx(sheetCal.fov), cx: cam.width / 2, cy: cam.height / 2, w: cam.width, h: cam.height, fov: sheetCal.fov };
    $('fov').value = Math.round(sheetCal.fov); $('fovV').textContent = Math.round(sheetCal.fov);
  }
  // Posición de la cámara
  let p0 = pose && state === 'track' ? pose : poseFromHomography(X, uv, intr.f, intr.cx, intr.cy);
  if (!p0) return;
  let p = refineSheet(X, uv, intr.f, intr.cx, intr.cy, p0.R, p0.t);
  let err = reprojError(X, uv, intr.f, intr.cx, intr.cy, p.R, p.t);
  // Error aceptable: más holgado si la hoja no está del todo plana (según la calibración)
  const maxErr = Math.max(3, 2 * (sheetCal.err || 1.5));
  if (err > maxErr && p0 === pose) {
    const ph = poseFromHomography(X, uv, intr.f, intr.cx, intr.cy);
    if (ph) { p = refineSheet(X, uv, intr.f, intr.cx, intr.cy, ph.R, ph.t); err = reprojError(X, uv, intr.f, intr.cx, intr.cy, p.R, p.t); }
  }
  if (err > maxErr) { sheetMsg = '✋ Imagen movida: más despacio'; return; }
  pose = { R: p.R, t: p.t };
  state = 'track';
  sheetMsg = '';
  // Guía: hay que dar la vuelta completa (o girar la hoja con el objeto encima)
  if (sectors.size < 12 && vol && vol.views >= 2) {
    const C = camCenter(pose.R, pose.t), cur = Math.floor(((Math.atan2(C[1], C[0]) * 180 / Math.PI) + 360) % 360 / 30);
    sheetMsg = '↻ Vuelta: ' + sectors.size + ' de 12 lados. ' + (sectors.has(cur) ? 'Sigue girando alrededor (o gira la hoja con el objeto encima)' : 'Bien: lado nuevo');
  }
  // Vistas guardadas: al moverse o girar lo suficiente
  if (!lastKf) { createKf(img); return; }
  if (jobs.length + (jobBusy ? 1 : 0) <= 1 && volBusy <= 1) {
    const C = camCenter(pose.R, pose.t), Ck = camCenter(lastKf.R, lastKf.t);
    const depth = Math.hypot(C[0], C[1], C[2]) || 0.3;
    const base = Math.hypot(C[0] - Ck[0], C[1] - Ck[1], C[2] - Ck[2]) / depth;
    const Rd = mul3(pose.R, tr3(lastKf.R));
    const rot = Math.acos(Math.max(-1, Math.min(1, (Rd[0] + Rd[4] + Rd[8] - 1) / 2)));
    if (base >= KF_BASE || rot >= KF_ROT) createKf(img);
  }
  if (frameNo % 4 === 0) poses.push({ t: Math.round(performance.now()), R: pose.R, tvec: pose.t, marcadores: sheetDets.length });
  if (poses.length > 3000) poses.shift();
  if (frameNo % 20 === 0) stat('Capturando con la hoja: gira alrededor del objeto, a distintas alturas. Medidas reales en milímetros.');
}

// Imagen a la mitad de resolución (para el color, se guarda de todas las vistas)
function halfImage(img) {
  const W = img.width, H = img.height, w = W >> 1, h = H >> 1, s = img.data, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, a = (2 * y * W + 2 * x) * 4;
    for (let c = 0; c < 3; c++) d[o + c] = (s[a + c] + s[a + 4 + c] + s[a + 4 * W + c] + s[a + 4 * W + 4 + c]) >> 2;
    d[o + 3] = 255;
  }
  return { width: w, height: h, data: d };
}

// Capas en el visor: durante la captura la forma (bosquejo, sin color); al terminar, con color
function showVolume(colored) {
  if (!vol || vol.views < 3) return false;
  if (colored) {
    const surf = vol.surface();
    for (const k of kfList) if (k.small) vol.paint(k.small, k.R, k.t, intr.f / 2, intr.cx / 2, intr.cy / 2, surf, 1);
  }
  volPts = vol.points();
  const c = viewerCloud(volPts, vol.vox, colored);
  if (!c) return false;
  cloud = c;
  viewer.setCloud(cloud);
  return true;
}

/* ---------- Comienzo: las dos primeras vistas fijan el espacio y la escala del modelo ---------- */
function startInit(img) {
  const fov = parseFloat($('fov').value);
  intr = { f: cam.focalPx(fov), cx: cam.width / 2, cy: cam.height / 2, w: cam.width, h: cam.height, fov };
  tracker.reset();
  tracker.start(img);
  kf0 = { id: ++kfSeq, img, R: I3(), t: [0, 0, 0], sc: 1 };
  const n = tracker.addCorners(kf0.id, null, roi);
  for (const p of tracker.pts) { p.oR = I3(); p.ot = [0, 0, 0]; }
  if (n < 40) { stat('Pocos detalles en la imagen (' + n + ' puntos). Apunta a un objeto con más textura o más luz.'); return; }
  kfList = [kf0];
  state = 'init';
}

function stepInit(img) {
  const n = tracker.track(img);
  const pts = tracker.pts;
  if (n < 30) { state = 'idle'; return; }   // todavía no hay nada capturado: se vuelve a tomar la primera vista
  const par = med(pts.map(p => Math.hypot(p.x - p.ox, p.y - p.oy)));
  if (par >= 18 && frameNo % 6 === 0) calibrateFocal(pts);
  if (par < 20) { stat('Muévete despacio de lado para empezar (' + par.toFixed(0) + ' px).'); return; }
  const ref = new Float32Array(2 * n), cur = new Float32Array(2 * n), ids = [];
  pts.forEach((p, i) => { ref[2 * i] = p.ox; ref[2 * i + 1] = p.oy; cur[2 * i] = p.x; cur[2 * i + 1] = p.y; ids.push(i); });
  const res = reconstructTwoView(ref, cur, ids, intr.f, intr.cx, intr.cy);
  if (!res || res.pts.length < Math.max(30, 0.5 * n)) {
    if (par > 70) state = 'idle';
    stat('Calculando… sigue moviéndote despacio de lado.');
    return;
  }
  // Escala del modelo: la profundidad típica de esta primera vista vale 1
  const s = 1 / med(res.pts.map(p => -p.P[2]));
  for (const p of res.pts) { pts[p.id].X = [p.P[0] * s, -p.P[1] * s, -p.P[2] * s]; pts[p.id].ver = true; }
  const kf1 = { id: ++kfSeq, img, R: res.R, t: res.t.map(v => v * s), sc: 1 };
  kfList.push(kf1);
  pose = { R: kf1.R, t: kf1.t };
  lastKf = kf1;
  queueDense(kf0, kf1);
  queueDense(kf1, kf0);
  tracker.addCorners(kf1.id, null);
  stampOrigin();
  state = 'track';
  fails = 0;
  stat('Capturando: gira despacio alrededor del objeto.');
}

/* ---------- Seguimiento: ubicar la cámara respecto del modelo en cada cuadro ---------- */
function stepTrack(img) {
  tracker.track(img);
  // La pose se calcula con los puntos confirmados (vistos desde dos lugares). Los que tomaron su 3D de un mapa de
  // profundidad o del modelo quedan "a prueba" hasta confirmarse con el movimiento; solo se usan si faltan confirmados.
  let P3 = tracker.pts.filter(p => p.X && p.ver);
  if (P3.length < 30) P3 = tracker.pts.filter(p => p.X);
  let ok = false;
  if (P3.length >= 8) {
    // La pose se calcula con hasta 160 puntos repartidos (más es lento y no mejora)
    const step = Math.max(1, P3.length / 160), S = [];
    for (let i = 0; i < P3.length; i += step) S.push(P3[Math.floor(i)]);
    const r = pnpRefine(S.map(p => p.X), S.map(p => [p.x, p.y]), intr.f, intr.cx, intr.cy, pose.R, pose.t, { iters: 6, sigma: 2.5, thr: 4 });
    ok = r.inl.length >= Math.max(10, 0.4 * S.length) && r.err < 3;
    if (ok) {
      pose = { R: r.R, t: r.t };
      // Los puntos que no calzan con la pose se dejan de seguir (incluye los del borde del objeto, que se corren)
      const e = reprojErrors(P3.map(p => p.X), P3.map(p => [p.x, p.y]), intr.f, intr.cx, intr.cy, pose.R, pose.t);
      const bad = new Set(P3.filter((_, i) => e[i] > 4));
      if (bad.size) tracker.pts = tracker.pts.filter(p => !bad.has(p));
      // Puntos a prueba que no calzan con la pose: pierden su 3D y esperan triangularse
      const T = tracker.pts.filter(p => p.X && !p.ver);
      if (T.length) {
        const eT = reprojErrors(T.map(p => p.X), T.map(p => [p.x, p.y]), intr.f, intr.cx, intr.cy, pose.R, pose.t);
        T.forEach((p, i) => {
          if (eT[i] > 3) { p.X = null; p.tri = 0; }
          else if (p.tri && frameNo - p.tri >= 5) p.ver = true;   // triangulado y sigue calzando: confirmado
        });
      }
    }
  }
  if (ok) fails = 0; else fails++;
  if (fails >= 4 || tracker.count < 12) { newSegment(); return; }
  if (!ok) return;

  // Puntos sin posición 3D: se triangulan con el movimiento de la cámara desde donde nacieron
  triangulateNew();

  // Más puntos cuando quedan pocos: los nuevos toman su posición 3D del modelo, si ya cubre esa zona
  if (tracker.count < 250 && frameNo % 5 === 0) addCornersFromModel(-1);

  // Nueva vista guardada al moverse o girar lo suficiente
  if (jobs.length + (jobBusy ? 1 : 0) <= 1) {
    const zs = [];
    for (const p of tracker.pts) if (p.X) zs.push(R3z(pose, p.X));
    const depth = med(zs) || 1;
    const C = camCenter(pose.R, pose.t), Ck = camCenter(lastKf.R, lastKf.t);
    const base = Math.hypot(C[0] - Ck[0], C[1] - Ck[1], C[2] - Ck[2]) / depth;
    const Rd = mul3(pose.R, tr3(lastKf.R));
    const rot = Math.acos(Math.max(-1, Math.min(1, (Rd[0] + Rd[4] + Rd[8] - 1) / 2)));
    if (base >= KF_BASE || rot >= KF_ROT || (tracker.count3D < 60 && base >= 0.05)) createKf(img);
  }
  if (frameNo % 4 === 0) poses.push({ t: Math.round(performance.now()), R: pose.R, tvec: pose.t, puntos: tracker.count3D });
  if (poses.length > 3000) poses.shift();
  const msg = 'Capturando: gira despacio alrededor del objeto para sumar más caras.';
  if (!lastMsg.startsWith('Objeto reconocido') || frameNo % 40 === 0) stat(msg);
}

const R3z = (ps, X) => ps.R[6] * X[0] + ps.R[7] * X[1] + ps.R[8] * X[2] + ps.t[2];

// Triangulación de dos rayos: el del píxel de origen (con la pose de entonces) y el actual (pose actual).
// Se acepta si los rayos se cruzan con ángulo suficiente y el punto calza en ambas vistas.
function triangulateNew() {
  const f = intr.f, cx = intr.cx, cy = intr.cy;
  const C2 = camCenter(pose.R, pose.t);
  for (const p of tracker.pts) {
    if ((p.X && (p.ver || p.tri)) || !p.oR) continue;
    const C1 = camCenter(p.oR, p.ot);
    const r1c = [(p.ox - cx) / f, (p.oy - cy) / f, 1], r2c = [(p.x - cx) / f, (p.y - cy) / f, 1];
    const d1 = mv3(tr3(p.oR), r1c), d2 = mv3(tr3(pose.R), r2c);
    const n1 = Math.hypot(...d1), n2 = Math.hypot(...d2);
    const cosA = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (n1 * n2);
    if (cosA > 0.9986) continue;   // menos de ~3° entre rayos: todavía no
    // Punto medio entre los dos rayos más cercanos
    const w0 = [C1[0] - C2[0], C1[1] - C2[1], C1[2] - C2[2]];
    const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2], b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2], c = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
    const d = d1[0] * w0[0] + d1[1] * w0[1] + d1[2] * w0[2], e = d2[0] * w0[0] + d2[1] * w0[1] + d2[2] * w0[2];
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-12) continue;
    const s1 = (b * e - c * d) / den, s2 = (a * e - b * d) / den;
    if (s1 <= 0 || s2 <= 0) continue;
    const X = [(C1[0] + s1 * d1[0] + C2[0] + s2 * d2[0]) / 2, (C1[1] + s1 * d1[1] + C2[1] + s2 * d2[1]) / 2, (C1[2] + s1 * d1[2] + C2[2] + s2 * d2[2]) / 2];
    const e1 = reprojErrors([X], [[p.ox, p.oy]], f, cx, cy, p.oR, p.ot)[0], e2 = reprojErrors([X], [[p.x, p.y]], f, cx, cy, pose.R, pose.t)[0];
    if (e1 < 1.5 && e2 < 1.5) { p.X = X; p.tri = frameNo; }   // a prueba unos cuadros antes de usarlo
  }
}

function addCornersFromModel(fid) {
  const pr = model.project(pose.R, pose.t, intr.f, intr.cx, intr.cy, intr.w, intr.h, 4);
  const R = pose.R, t = pose.t;
  tracker.addCorners(fid, (x, y) => Model.lookup(pr, R, t, intr.f, intr.cx, intr.cy, x, y));
  stampOrigin();   // los que no tienen 3D se triangularán con el movimiento
}

// Pose de la cámara en el cuadro donde nació cada punto (para triangularlo después)
function stampOrigin() {
  for (const p of tracker.pts) if (!p.oR) { p.oR = pose.R.slice(); p.ot = pose.t.slice(); }
}

function createKf(img) {
  const kf = { id: ++kfSeq, img, R: pose.R.slice(), t: pose.t.slice(), sc: 1 };
  if (sheetMode && vol) {
    // CAPA 1 · forma: cada vista talla el bloque (lo que deja ver la hoja está vacío)
    carveView(kf);
    kf.small = halfImage(img);   // para pintar al final (capa 3)
    const C = camCenter(kf.R, kf.t);
    sectors.add(Math.floor(((Math.atan2(C[1], C[0]) * 180 / Math.PI) + 360) % 360 / 30));
  }
  let pair = lastKf && lastKf.img ? lastKf : null;
  if (!pair) {
    const C = camCenter(kf.R, kf.t);
    let bd = Infinity;
    for (const k of kfList) {
      if (!k.img) continue;
      const Ck = camCenter(k.R, k.t), d = Math.hypot(C[0] - Ck[0], C[1] - Ck[1], C[2] - Ck[2]);
      if (d < bd) { bd = d; pair = k; }
    }
  }
  kfList.push(kf);
  lastKf = kf;
  if (pair) queueDense(kf, pair);
  if (!sheetMode) { tracker.addCorners(kf.id, null); stampOrigin(); }
  // Memoria: solo se conservan las imágenes de las últimas vistas (las firmas se conservan todas)
  const withImg = kfList.filter(k => k.img);
  for (let i = 0; i < withImg.length - MAX_KF_IMAGES; i++) if (withImg[i] !== pair) withImg[i].img = null;
}

/* ---------- Profundidad de cada vista guardada (en segundo plano) → se suma al modelo ---------- */
function queueDense(refKf, otherKf) {
  const Rr = mul3(otherKf.R, tr3(refKf.R));
  const tr = mv3(Rr, refKf.t).map((v, k) => otherKf.t[k] - v);
  const zs = [];
  if (sheetMode) {
    // Con la hoja se sabe dónde está todo: desde lo más alto del objeto (hasta 20 cm) hasta la hoja
    for (const x of [ZONA.x0, 0, ZONA.x1]) for (const y of [ZONA.y0, 0, ZONA.y1]) for (const z of [0, 0.2]) zs.push(R3z(refKf, [x / 1000, y / 1000, z]));
  } else for (const p of tracker.pts) if (p.X) zs.push(R3z(refKf, p.X));
  const valid = zs.filter(z => z > 0).sort((a, b) => a - b);
  const range = sheetMode ? [Math.max(0.03, 0.9 * valid[0]), 1.08 * valid[valid.length - 1]]
    : valid.length >= 10 ? [valid[Math.floor(valid.length * 0.05)], valid[Math.floor(valid.length * 0.95)]] : [0.6, 1.6];
  jobs.push({ cap: capNo, ref: refKf, other: otherKf, R: Rr, t: tr, range, sc0: refKf.sc, mdl: model, list: kfList });
  pump();
}

function pump() {
  if (jobBusy || !jobs.length) return;
  const j = jobs.shift();
  if (!j.ref.img || !j.other.img) { pump(); return; }
  jobBusy = true;
  curJob = j;
  const copy = im => ({ data: new Uint8ClampedArray(im.data), width: im.width, height: im.height });
  const ref = copy(j.ref.img), cur = copy(j.other.img);
  runJob({ type: 'dense', ref, cur, R: j.R, t: j.t, f: intr.f, cx: intr.cx, cy: intr.cy, range: j.range, opts: { factor: FACTOR, roi: null, clean: false } },
    [ref.data.buffer, cur.data.buffer], r => {
      jobBusy = false;
      curJob = null;
      if (j.cap === capNo && !r.error && r.dm) {
        // Si el tramo se unió a otro mientras se calculaba, la profundidad se lleva a las unidades nuevas
        const k = j.ref.sc / j.sc0;
        if (k !== 1) for (let i = 0; i < r.dm.depth.length; i++) r.dm.depth[i] *= k;
        onDepth(j.ref, r.dm, j.mdl, j.list);
      }
      else if (r.error) showErr('Cálculo de profundidad: ' + r.error);
      pump();
    });
}

function onDepth(kf, dm, M = model, L = kfList) {
  const active = M === model;
  // Tamaño del cubito: según la distancia al objeto (centro de la imagen o recuadro) en la primera vista,
  // para que el detalle del objeto no dependa de lo lejos que esté el fondo
  if (!M.depthMaps) {
    const r = roi || { x: intr.w * 0.3, y: intr.h * 0.3, w: intr.w * 0.4, h: intr.h * 0.4 };
    const ds = [];
    for (let y = Math.floor(r.y / FACTOR); y < (r.y + r.h) / FACTOR; y++) for (let x = Math.floor(r.x / FACTOR); x < (r.x + r.w) / FACTOR; x++) {
      const d = dm.depth[y * dm.w + x];
      if (d > 0) ds.push(d);
    }
    if (ds.length > 30) M.voxel = med(ds) * 2.5 / dm.f;
  }
  M.fuseDepth(dm, kf.R, kf.t, kf.id);
  // CAPA 2 · relieve: la profundidad medida vacía lo que está claramente delante de la superficie
  if (sheetMode && vol && M === model) vol.relief(dm, kf.R, kf.t);
  if (ses && sheetMode && M === model) sesSendDepth(kf, dm);
  kf.hasDepth = true;
  const F = FACTOR, f = intr.f, cx = intr.cx, cy = intr.cy;
  // Posición 3D de un píxel de esta vista según su mapa de profundidad
  const look = (x, y) => {
    const u = Math.round(x / F), v = Math.round(y / F), ds = [];
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const uu = u + a, vv = v + b;
      if (uu < 0 || vv < 0 || uu >= dm.w || vv >= dm.h) continue;
      const d = dm.depth[vv * dm.w + uu];
      if (d > 0) ds.push(d);
    }
    if (ds.length < 3) return null;
    const d = med(ds);
    return toWorld(kf.R, kf.t, d * (x - cx) / f, d * (y - cy) / f, d);
  };
  // Distancia de la cámara a la superficie en el centro de la imagen (para el tamaño del objeto)
  {
    const C = camCenter(kf.R, kf.t), ds = [];
    for (let y = intr.cy - intr.h * 0.08; y <= intr.cy + intr.h * 0.08; y += 4)
      for (let x = intr.cx - intr.w * 0.06; x <= intr.cx + intr.w * 0.06; x += 4) {
        const P = look(x, y); if (P) ds.push(Math.hypot(P[0] - C[0], P[1] - C[1], P[2] - C[2]));
      }
    kf.dc = ds.length > 5 ? med(ds) : 0;
  }
  // Esfera del objeto (para limpiar el fondo)
  if (!M.hoja && !(active && roiObject)) updateObject(kf, look, M, L);
  // Los puntos que nacieron en esta vista reciben su posición 3D
  if (active && !sheetMode) tracker.fill3D(kf.id, look);
  // Firmas de esta vista, para reconocer el objeto si se pierde
  const feats = computeFeatures(kf.img, 400);
  const X = new Float32Array(3 * feats.n).fill(NaN);
  for (let i = 0; i < feats.n; i++) {
    const P = look(feats.kp[2 * i], feats.kp[2 * i + 1]);
    if (P) { X[3 * i] = P[0]; X[3 * i + 1] = P[1]; X[3 * i + 2] = P[2]; }
  }
  M.addKeyframe(kf.id, kf.R, kf.t, feats, X, thumbnail(kf.img));
  if (active) refreshCloud(true);
}

/* ---------- Dónde está el objeto ---------- */
// Al girar alrededor del objeto, todas las vistas apuntan hacia él: su centro es el punto más cercano a todos los
// ejes de las cámaras. El radio se toma como una fracción de la distancia de las cámaras al centro (un objeto
// encuadrado ocupa la parte central de la imagen). Si las vistas son casi paralelas (de frente), se usa la
// profundidad del centro de la primera imagen.
let roiObject = false;
function updateObject(kf, look, M = model, L = kfList) {
  const views = L.filter(k => k.hasDepth);
  if (views.length >= 3) {
    const A = new Array(9).fill(0), b = [0, 0, 0], dirs = [];
    for (const k of views) {
      const C = camCenter(k.R, k.t), d = [k.R[6], k.R[7], k.R[8]];   // eje óptico en el modelo
      dirs.push(d);
      // (I − d·dᵀ)·X = (I − d·dᵀ)·C
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - d[i] * d[j];
        A[3 * i + j] += m; b[i] += m * C[j];
      }
    }
    let spread = 0;
    for (const d of dirs) spread = Math.max(spread, Math.acos(Math.min(1, d[0] * dirs[0][0] + d[1] * dirs[0][1] + d[2] * dirs[0][2])));
    if (spread > 15 * Math.PI / 180) {
      const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
      if (Math.abs(det) > 1e-9) {
        const inv = [A[4] * A[8] - A[5] * A[7], A[2] * A[7] - A[1] * A[8], A[1] * A[5] - A[2] * A[4], A[5] * A[6] - A[3] * A[8], A[0] * A[8] - A[2] * A[6], A[2] * A[3] - A[0] * A[5], A[3] * A[7] - A[4] * A[6], A[1] * A[6] - A[0] * A[7], A[0] * A[4] - A[1] * A[3]];
        const c = [0, 1, 2].map(r => (inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) / det);
        const D = med(views.map(k => { const C = camCenter(k.R, k.t); return Math.hypot(C[0] - c[0], C[1] - c[1], C[2] - c[2]); }));
        // Radio: lo que va del centro a la superficie que se ve en el centro de cada imagen, con margen
        const rs = views.filter(k => k.dc > 0).map(k => { const C = camCenter(k.R, k.t); return Math.hypot(C[0] - c[0], C[1] - c[1], C[2] - c[2]) - k.dc; }).filter(r => r > 0);
        const r = rs.length >= 3 ? Math.min(0.6 * D, 1.5 * med(rs)) : 0.45 * D;
        // El centro debe estar delante de las cámaras
        if (views.every(k => R3z(k, c) > 0)) { M.obj = { c, r }; M.dirty = true; return; }
      }
    }
  }
  if (!M.obj) {
    // De frente: zona central de la primera imagen
    const r = { x: intr.w * 0.35, y: intr.h * 0.35, w: intr.w * 0.3, h: intr.h * 0.3 };
    const P = [];
    for (let y = r.y; y < r.y + r.h; y += 3) for (let x = r.x; x < r.x + r.w; x += 3) { const X = look(x, y); if (X) P.push(X); }
    M.setObject(P);
  }
}

/* ---------- Objeto perdido: la captura sigue con un tramo nuevo ---------- */
function newSegment() {
  // El tramo actual se guarda (si tiene algo) y se empieza otro al tiro, sin esperar
  if (model.kfs.length || model.depthMaps) parts.push({ model, kfList, roiObject });
  model = new Model();
  kfList = []; lastKf = null; kf0 = null; pose = null; fails = 0;
  tracker.reset();
  roiObject = false;
  state = 'idle';
  relocAt = 0;
  stat('Se perdió el seguimiento: sigo grabando en un tramo nuevo. Se une solo con lo anterior cuando lo reconozca.');
}

// Mientras el tramo nuevo arranca: si la cámara ve una parte ya capturada, se vuelve a ese mismo modelo
function tryResume(img) {
  const now = performance.now();
  if (now - relocAt < 350) return;
  relocAt = now;
  const cur = computeFeatures(img, 400);
  if (cur.n < 20) return;
  const th = thumbnail(img);
  let best = null;
  for (const P of parts.slice().reverse()) {
    const M = P.model;
    if (!M.kfs.length) continue;
    const scored = M.kfs.map(k => {
      let s = 0;
      for (let i = 0; i < th.length; i++) s += th[i] * k.thumb[i];
      return { k, s };
    }).sort((a, b) => b.s - a.s);
    const cands = scored.slice(0, 3).map(o => o.k);
    for (const k of M.kfs.slice(-2)) if (!cands.includes(k)) cands.push(k);
    for (const k of cands) {
      const m = matchFeatures(cur.desc, cur.n, k.desc, k.n, 64, 0.8);
      if (m.length < 15) continue;
      const X = m.map(([, j]) => [k.X[3 * j], k.X[3 * j + 1], k.X[3 * j + 2]]);
      const uv = m.map(([i]) => [cur.kp[2 * i], cur.kp[2 * i + 1]]);
      const uvk = m.map(([, j]) => [k.kp[2 * j], k.kp[2 * j + 1]]);
      const r = pnpRelocalize(X, uv, uvk, k, intr.f, intr.cx, intr.cy, []);
      if (r && r.inl.length >= Math.max(15, 0.3 * m.length) && (!best || r.inl.length > best.r.inl.length)) best = { r, k, X, uv, P };
    }
    if (best) break;
  }
  if (!best) return;
  // Reconocido: se vuelve a ese tramo (el tramo nuevo aún no tenía nada)
  parts.splice(parts.indexOf(best.P), 1);
  model = best.P.model; kfList = best.P.kfList; roiObject = best.P.roiObject;
  pose = { R: best.r.R, t: best.r.t };
  tracker.setPoints(best.r.inl.map(i => ({ x: best.uv[i][0], y: best.uv[i][1], X: best.X[i] })), img);
  for (const p of tracker.pts) { p.oR = pose.R.slice(); p.ot = pose.t.slice(); p.ver = true; }
  addCornersFromModel(-1);
  const C = camCenter(pose.R, pose.t);
  let bd = Infinity;
  lastKf = null;
  for (const k of kfList) {
    if (!k.img) continue;
    const Ck = camCenter(k.R, k.t), d = Math.hypot(C[0] - Ck[0], C[1] - Ck[1], C[2] - Ck[2]);
    if (d < bd) { bd = d; lastKf = k; }
  }
  if (!lastKf) lastKf = { id: ++kfSeq, img: null, R: pose.R.slice(), t: pose.t.slice(), sc: 1 };
  state = 'track';
  fails = 0;
  stat('Reconocí lo ya capturado: sigo sumando al mismo modelo.');
  refreshCloud(true);
}

// Tramo activo ya con vistas: se busca una zona en común con un tramo anterior (firmas de puntos con 3D) y,
// si la hay, todo el tramo activo se lleva al espacio del anterior y se suman en un solo modelo
function tryLink() {
  const now = performance.now();
  if (model.kfs.length < 2 || model.kfs.length === linkKfs || now - linkAt < 1500) return;
  linkAt = now;
  linkKfs = model.kfs.length;
  for (const P of parts.slice().reverse()) {
    if (!P.model.kfs.length) continue;
    const T = alignModels(P.model, model);
    if (!T) continue;
    linkInto(P, T);
    stat('Tramo unido al modelo (' + T.inl + ' puntos en común). Sigo sumando.');
    refreshCloud(true);
    return;
  }
}

function linkInto(P, T) {
  const old = model;
  P.model.absorb(old, T);
  for (const k of kfList) {
    const q = movePose(k.R, k.t, T);
    k.R = q.R; k.t = q.t; k.sc = (k.sc || 1) * T.s;
    if (k.dc) k.dc *= T.s;
  }
  if (pose) pose = movePose(pose.R, pose.t, T);
  for (const p of tracker.pts) {
    if (p.X) p.X = simApply(T, p.X);
    if (p.oR) { const q = movePose(p.oR, p.ot, T); p.oR = q.R; p.ot = q.t; }
  }
  model = P.model;
  kfList = P.kfList.concat(kfList);
  roiObject = roiObject || P.roiObject;
  parts.splice(parts.indexOf(P), 1);
  // Lo que se esté calculando para el tramo viejo va ahora al modelo unido
  for (const j of jobs.concat(curJob ? [curJob] : [])) if (j.mdl === old) { j.mdl = model; j.list = kfList; }
}

/* ---------- Modelo en el visor ---------- */
function refreshCloud(force) {
  const now = performance.now();
  if (!force && now - cloudAt < 500) return;
  cloudAt = now;
  if (ses && sesPts) { updateProgress(); return; }   // en sesión se muestra el modelo del servidor
  if (sheetMode && vol && cleanBg) {
    if (now - volAt > 3000 || (force && state === 'done')) { volAt = now; showVolume(state === 'done'); }
    updateProgress();
    return;
  }
  const c = shownModel().cloud(cleanBg);
  if (c) { cloud = c; viewer.setCloud(cloud); }
  updateProgress();
}

// En el visor: el tramo activo, salvo que un tramo anterior tenga claramente más
function shownModel() {
  let m = model, n = model.countVisible(false);
  for (const P of parts) { const k = P.model.countVisible(false); if (k > 2 * n) { m = P.model; n = k; } }
  return m;
}

function updateProgress() {
  if (sheetMode) {
    const pct = Math.round(100 * sectors.size / 12);
    $('progBar').style.width = pct + '%';
    $('progTxt').textContent = 'Vuelta alrededor: ' + sectors.size + ' de 12 lados · ' + (vol ? vol.views : 0) + ' vistas talladas' + (sheetCal && sheetCal.done ? ' · cámara calibrada ' + Math.round(sheetCal.fov) + '°' : '');
    return;
  }
  const pct = Math.round(100 * (assist.viewCov || 0));
  $('progBar').style.width = (state === 'track' ? pct : 0) + '%';
  $('progTxt').textContent = 'Modelo: ' + model.countVisible(cleanBg).toLocaleString('es-CL') + ' puntos · ' + model.kfs.length + ' vistas' +
    (parts.length ? ' · ' + (parts.length + 1) + ' tramos' : '') +
    (state === 'track' ? ' · esta vista modelada: ' + pct + ' %' : running && state !== 'track' ? ' · arrancando tramo' : '');
}
setInterval(() => { if (running) updateProgress(); }, 700);

/* ---------- Terminar: solo el usuario detiene la captura ---------- */
async function finish() {
  if (!running || state === 'finishing') return;
  state = 'finishing';
  running = false;
  $('bEnd').disabled = true;
  $('bRoi').disabled = true;
  setMarking(false);
  assist.done();
  cam.stop();
  rec.stop(intr);
  stat('Terminando: procesando las últimas vistas…');
  // Se esperan las vistas que aún se están procesando (hasta 6 s)
  const t0 = performance.now();
  while ((jobBusy || jobs.length || volBusy) && performance.now() - t0 < 8000) await new Promise(r => setTimeout(r, 100));
  // Tramos: se intenta unir todo en el teléfono (el mayor recibe a los demás)
  let all = [model, ...parts.map(P => P.model)].filter(m => m.countVisible(false) >= 50);
  all.sort((a, b) => b.countVisible(false) - a.countVisible(false));
  if (all.length > 1) {
    stat('Terminando: uniendo ' + all.length + ' tramos…');
    await new Promise(r => setTimeout(r, 30));
    let changed = true;
    while (changed && all.length > 1) {
      changed = false;
      for (let i = 1; i < all.length; i++) {
        const T = alignModels(all[0], all[i], { max: 2500 });
        if (T) { all[0].absorb(all[i], T); all.splice(i, 1); changed = true; break; }
      }
    }
  }
  model = all[0] || model;
  parts = all.slice(1).map(m => ({ model: m, kfList: [], roiObject: false }));
  state = 'done';
  $('bNew').disabled = false;
  refreshCloud(true);
  model.cloud(cleanBg, 60000, true);
  refreshCloud(true);
  showTab('res');
  octx.clearRect(0, 0, ov.width, ov.height);
  if (kf0 && kf0.img) octx.putImageData(kf0.img, 0, 0);
  // En sesión: el resultado es el modelo común del servidor (se espera a que lleguen las últimas vistas)
  if (ses) {
    stat('Terminando: enviando las últimas vistas a la sesión…');
    const t1 = performance.now();
    while ((sesQueue.length || sesSending) && performance.now() - t1 < 20000) await sleep(200);
    try {
      const M = await api().sesionModelo(ses.codigo, -1);
      if (M.n) {
        const xyz = new Float32Array(unb64(M.xyz)), rgb = new Uint8Array(unb64(M.rgb)), P = [];
        for (let i = 0; i < M.n; i++) P.push([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2], rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]]);
        sesPts = { P, voxel: M.voxel, medidas: M.medidas_mm, vistas: M.vistas };
        ses.version = M.version;
        const c = viewerCloud(P, M.voxel, true);
        if (c) { cloud = c; viewer.setCloud(cloud); }
      }
    } catch (e) { /* se usa lo local */ }
  }
  const usaSesion = !!(ses && sesPts && sesPts.P.length >= 50);
  if (usaSesion) { volPts = sesPts.P; }
  const usaCapas = sheetMode && ((vol && volPts && volPts.length >= 50) || usaSesion);
  const n = usaCapas ? volPts.length : model.countVisible(cleanBg);
  if (n < 50) { stat('Captura terminada sin datos suficientes. Pulsa «Nueva captura» y muévete más lento, con buena luz.'); return; }
  // Cada tramo que quedó sin unir se guarda como parte; el servidor las une después, solo
  const fecha = new Date(), base = 'toma-' + fecha.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const nombre = 'Toma ' + fecha.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const tomas = all.map((m, i) => m.toToma({
    id: all.length > 1 ? base + '-p' + (i + 1) : base,
    nombre: all.length > 1 ? nombre + ' · parte ' + (i + 1) + ' de ' + all.length : nombre,
    fecha: fecha.toISOString(), intr, voxel: usaCapas && i === 0 ? (usaSesion ? sesPts.voxel : vol.vox) : undefined
  }, usaCapas && i === 0 ? volPts : null));
  lastToma = tomas[0];
  let msg = 'Captura terminada: ' + n.toLocaleString('es-CL') + ' puntos desde ' + model.kfs.length + ' vistas' + (all.length > 1 ? ' (quedaron ' + all.length + ' partes sin unir en el teléfono)' : '') + '.';
  if (usaCapas) {
    const sz = sizeOf(volPts);
    msg = usaSesion ? 'Modelo común de la sesión ' + ses.codigo + ' (todas las cámaras): ' + n.toLocaleString('es-CL') + ' cubitos de ' + (sesPts.voxel * 1000).toFixed(1) + ' mm desde ' + sesPts.vistas + ' vistas. Medidas: ' + sz.join(' × ') + ' mm (ancho × fondo × alto).'
      : 'Objeto listo (forma + relieve + color): ' + n.toLocaleString('es-CL') + ' cubitos de 2 mm desde ' + vol.views + ' vistas. Medidas: ' + sz.join(' × ') + ' mm (ancho × fondo × alto).';
  }
  stat(msg + ' Guardando…');
  try { for (const T of tomas) await localTomas.save(T); msg += ' Guardada en el teléfono'; } catch (e) { msg += ' No se pudo guardar en el teléfono (' + e.message + ')'; }
  stat(msg + '; subiendo al servidor…');
  try {
    const res = await serverMerge(tomas.map(T => T.id), tomas);
    msg += ' y en el servidor.';
    if (res) {
      const U = res.toma;
      await localTomas.save(U).catch(() => {});
      const unidas = res.detalle.filter(d => d.unida).length;
      if (unidas > 1) {
        const m = Model.fromToma(U), c = m.cloud(cleanBg, 60000, true);
        if (c) { cloud = c; viewer.setCloud(cloud); viewer.frontView(); }
        lastToma = U;
      }
      msg += ' Servidor: ' + res.informe;
    }
  } catch (e) { msg += '; no se pudo subir al servidor (' + e.message + '). Se puede subir después desde «Tomas».'; }
  stat(msg);
  resNote.textContent = msg;
  if (tab === 'tomas') renderTomas();
}

/* ---------- VARIAS CÁMARAS: sesión en el servidor ----------
   Una sesión es lo que queremos reconocer. Un teléfono la crea (con un nombre) y recibe un código de 4 letras;
   los demás se unen con ese código. Todos capturan con la misma hoja, así que sus vistas ya comparten espacio.
   Cada vista (imagen, posición, máscara de la hoja y profundidad) se envía al servidor, que arma un solo modelo
   con las vistas de todas las cámaras. Cada teléfono ve ese modelo común en «Resultado». */
let ses = null, sesPts = null, sesQueue = [], sesSending = false, sesInfo = null, paintModeBtn = () => {};
const sesBtn = document.createElement('button');
sesBtn.textContent = '👥 Varias cámaras';
const sesLine = document.createElement('div');
sesLine.className = 'ses-line';
sesLine.hidden = true;

function packMask(m) {
  const o = new Uint8Array(Math.ceil(m.length / 4));
  for (let i = 0; i < m.length; i++) o[i >> 2] |= m[i] << (2 * (i & 3));
  return b64(o);
}
const jpegCanvas = document.createElement('canvas');
async function jpegB64(img) {
  jpegCanvas.width = img.width; jpegCanvas.height = img.height;
  jpegCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await new Promise(r => jpegCanvas.toBlob(r, 'image/jpeg', 0.85));
  return b64(new Uint8Array(await blob.arrayBuffer()));
}

function sesSendView(kf, img, mask, I) {
  const s = ses;
  sesQueue.push(async () => {
    if (ses !== s) return;
    const r = await api().sesionPost('/sesiones/' + s.codigo + '/vistas', {
      camara: s.camara, id: capNo + '-' + kf.id, R: kf.R, t: kf.t, f: I.f, cx: I.cx, cy: I.cy, w: img.width, h: img.height,
      jpg: await jpegB64(img), mask: packMask(mask)
    });
    kf.sesVista = r.vista;
  });
  sesPump();
}
function sesSendDepth(kf, dm) {
  const s = ses, mm = new Uint16Array(dm.depth.length);
  for (let i = 0; i < mm.length; i++) mm[i] = dm.depth[i] > 0 ? Math.min(65535, Math.round(dm.depth[i] * 10000)) : 0;
  let tries = 0;
  const job = async () => {
    if (ses !== s) return;
    // La profundidad va después de su vista (si la vista aún no se envía, se espera)
    if (!kf.sesVista) { if (++tries < 40) { await sleep(500); sesQueue.push(job); } return; }
    await api().sesionPost('/sesiones/' + s.codigo + '/vistas/' + kf.sesVista + '/profundidad', { w: dm.w, h: dm.h, f: dm.f, cx: dm.cx, cy: dm.cy, mm10: b64(mm) });
  };
  sesQueue.push(job);
  sesPump();
}
// Envío con 2 a la vez (la red del teléfono rinde más así)
let sesActive = 0;
function sesPump() {
  while (sesActive < 2 && sesQueue.length) {
    const job = sesQueue.shift();
    sesActive++;
    sesSending = true;
    job().catch(async e => { showNote('Sesión: no se pudo enviar una vista (' + e.message + ').'); await sleep(1000); })
      .finally(() => { sesActive--; sesSending = sesActive > 0; sesPump(); });
  }
}

async function sesStart() {
  if (running) { alert('Únete o crea la sesión antes de iniciar la cámara.'); return; }
  const op = prompt('Varias cámaras:\n· Escribe el CÓDIGO de 4 letras para unirte a una sesión\n· O escribe "nueva" para crear una', 'nueva');
  if (!op) return;
  try {
    let codigo = op.trim().toUpperCase();
    if (codigo === 'NUEVA') {
      const nombre = prompt('¿Qué quieres reconocer? (ej.: rodilla, taza)', 'objeto');
      if (nombre === null) return;
      job.start('Creando la sesión…');
      job.set(0.3, 'Creando la sesión (si el servidor dormía, puede tardar hasta 1 minuto)…', true);
      codigo = (await api().sesionCrear(nombre)).codigo;
    } else job.start('Uniéndome a la sesión ' + codigo + '…');
    const nombreCam = (navigator.userAgent.match(/\(([^;)]+)/) || [, 'Teléfono'])[1].slice(0, 30);
    const r = await api().sesionUnir(codigo, nombreCam);
    ses = { codigo: r.codigo, camara: r.camara, nombre: r.nombre, version: -1 };
    sesPts = null;
    job.end(true, 'En la sesión ' + r.codigo + ' «' + r.nombre + '». Comparte el código con los otros teléfonos.');
    if (!sheetMode) { sheetMode = true; try { localStorage.setItem('camara4d_modo', 'hoja'); } catch (e) { /* nada */ } paintModeBtn(); }
    sesPaint(r);
  } catch (e) { job.end(false, 'Sesión: ' + e.message); }
}
function sesLeave() {
  ses = null; sesPts = null; sesQueue = [];
  sesLine.hidden = true;
  sesBtn.textContent = '👥 Varias cámaras';
}
function sesPaint(info) {
  sesInfo = info;
  sesLine.hidden = false;
  const cams = info.camaras || [];
  sesLine.innerHTML = '';
  const t = document.createElement('span');
  t.textContent = '👥 Sesión ' + info.codigo + ' «' + info.nombre + '» · ' + cams.length + ' cámara' + (cams.length === 1 ? '' : 's') + ' · ' + info.vistas + ' vistas en el servidor' + (sesQueue.length ? ' · enviando ' + sesQueue.length : '');
  const b = document.createElement('button');
  b.textContent = 'Salir';
  b.onclick = () => { if (confirm('¿Salir de la sesión? (el modelo común queda en el servidor)')) sesLeave(); };
  sesLine.append(t, b);
  sesBtn.textContent = '👥 Sesión ' + info.codigo;
}
// Estado de la sesión y modelo común (cada 2,5 s)
setInterval(async () => {
  if (!ses) return;
  const s = ses;
  try {
    const info = await api().sesion(s.codigo);
    if (ses !== s) return;
    sesPaint(info);
    if (info.version !== s.version && (tab === 'res' || !running || performance.now() - (s.modelAt || 0) > 6000)) {
      s.modelAt = performance.now();
      const M = await api().sesionModelo(s.codigo, s.version);
      if (ses !== s || M.sin_cambios || !M.n) { if (M.version !== undefined) s.version = M.version; return; }
      s.version = M.version;
      const xyz = new Float32Array(unb64(M.xyz)), rgb = new Uint8Array(unb64(M.rgb)), P = [];
      for (let i = 0; i < M.n; i++) P.push([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2], rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]]);
      sesPts = { P, voxel: M.voxel, medidas: M.medidas_mm, vistas: M.vistas };
      const c = viewerCloud(P, M.voxel, true);
      if (c) { cloud = c; viewer.setCloud(cloud); }
      resNote.textContent = 'Modelo común de la sesión ' + s.codigo + ' «' + info.nombre + '»: ' + M.n.toLocaleString('es-CL') + ' cubitos de ' + (M.voxel * 1000).toFixed(1) + ' mm desde ' + M.vistas + ' vistas de ' + (info.camaras || []).length + ' cámara(s). Medidas: ' + M.medidas_mm.join(' × ') + ' mm.';
    }
  } catch (e) { sesLine.title = e.message; }
}, 2500);

/* ---------- Barra de avance (subir y unir en el servidor) ---------- */
// Queda fija bajo el menú, así se ve desde cualquier pantalla.
const job = (() => {
  const el = document.createElement('div');
  el.className = 'jobbar';
  el.hidden = true;
  el.innerHTML = '<div class="jb-txt"><span class="jb-lbl"></span><span class="jb-pct"></span></div><div class="jb-bar"><div class="jb-fill"></div></div>';
  const lbl = el.querySelector('.jb-lbl'), pct = el.querySelector('.jb-pct'), fill = el.querySelector('.jb-fill');
  let t0 = 0, frac = 0, hideT = null, tick = null;
  const paint = () => { pct.textContent = Math.round(100 * frac) + ' % · ' + Math.round((performance.now() - t0) / 1000) + ' s'; };
  return {
    el,
    start(text) {
      clearTimeout(hideT); clearInterval(tick);
      t0 = performance.now(); frac = 0;
      el.hidden = false; el.className = 'jobbar';
      tick = setInterval(paint, 500);
      this.set(0, text);
    },
    set(f, text, busy = false) {
      frac = Math.max(frac, Math.min(1, f));
      fill.style.width = (100 * frac).toFixed(1) + '%';
      if (text) lbl.textContent = text;
      el.classList.toggle('busy', busy);
      paint();
    },
    end(ok, text) {
      clearInterval(tick);
      if (ok) this.set(1, text); else lbl.textContent = text;
      el.classList.remove('busy');
      el.classList.add(ok ? 'ok' : 'bad');
      paint();
      hideT = setTimeout(() => { el.hidden = true; }, ok ? 8000 : 15000);
    }
  };
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sube las tomas que falten y une ids en el servidor, mostrando el avance real del servidor
async function serverMerge(ids, uploads) {
  const A = api();
  job.start('Conectando con el servidor…');
  try {
    // 1. Servidor despierto (en Render gratis duerme y tarda hasta ~1 minuto en despertar)
    job.set(0.02, 'Conectando con el servidor…', true);
    const tw = setTimeout(() => job.set(0.02, 'Despertando el servidor (puede tardar hasta 1 minuto)…', true), 3000);
    try { await A.health(); } finally { clearTimeout(tw); }
    // 2. Subir lo que falte
    for (let i = 0; i < uploads.length; i++) {
      job.set(0.05 + 0.15 * i / uploads.length, 'Subiendo toma ' + (i + 1) + ' de ' + uploads.length + '…');
      await A.upload(uploads[i]);
    }
    if (ids.length < 2) { job.end(true, 'Listo: toma subida al servidor.'); return null; }
    // 3. Unir (con avance real si el servidor lo permite)
    job.set(0.2, 'Uniendo en el servidor…');
    let res;
    let trabajo = null;
    try { trabajo = (await A.start(ids)).trabajo; }
    catch (e) { if (!/servidor (404|405)/.test(e.message)) throw e; }
    if (trabajo) {
      for (;;) {
        await sleep(700);
        const st = await A.status(trabajo);
        if (st.estado === 'error') throw new Error(st.error || 'error al unir');
        job.set(0.2 + 0.72 * (st.avance || 0) / 100, 'Servidor: ' + (st.etapa || st.estado), st.estado === 'en cola');
        if (st.estado === 'listo') { res = st.resultado; break; }
      }
      job.set(0.93, 'Bajando el resultado…');
      res = { toma: await A.get(res.id), informe: res.informe, detalle: res.detalle };
    } else {
      job.set(0.2, 'Uniendo en el servidor…', true);
      res = await A.merge(ids);
    }
    const unidas = res.detalle.filter(d => d.unida).length;
    job.end(unidas > 1, unidas > 1 ? 'Listo: ' + unidas + ' de ' + ids.length + ' tomas unidas.' : 'No se pudieron unir: no comparten una zona clara.');
    return res;
  } catch (e) {
    job.end(false, 'Error: ' + e.message);
    throw e;
  }
}

/* ---------- Tomas: ver, subir y unir (servidor) ---------- */
let lastToma = null;
const apiBase = () => { try { return localStorage.getItem('camara4d_api') || API_DEFAULT; } catch (e) { return API_DEFAULT; } };
const api = () => serverApi(apiBase());

const tomasPanel = document.createElement('div');
tomasPanel.className = 'tomas';

async function renderTomas() {
  tomasPanel.innerHTML = '<div class="tm-head">Cargando tomas…</div>';
  let local = [], server = [], srvErr = '';
  try { local = await localTomas.list(); } catch (e) { /* sin almacenamiento */ }
  srvLine.textContent = '☁ Servidor: ' + apiBase().replace(/^https?:\/\//, '') + ' · conectando… (si estaba dormido puede tardar hasta 1 minuto)';
  srvLine.className = 'srv wait';
  try { server = await api().list(); srvLine.textContent = '☁ Servidor conectado: ' + apiBase().replace(/^https?:\/\//, ''); srvLine.className = 'srv ok'; }
  catch (e) { srvErr = e.message; srvLine.textContent = '☁ Servidor sin respuesta (' + apiBase().replace(/^https?:\/\//, '') + '): ' + e.message + '. Las tomas siguen guardadas en el teléfono.'; srvLine.className = 'srv bad'; }
  const inServer = new Set(server.map(t => t.id));
  const rows = new Map();
  for (const t of local) rows.set(t.id, { ...t, local: true, server: inServer.has(t.id) });
  for (const t of server) if (!rows.has(t.id)) rows.set(t.id, { ...t, local: false, server: true });
  const list = [...rows.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  tomasPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'tm-head';
  head.textContent = 'Marca 2 o más tomas del mismo objeto (de este u otro teléfono) y pulsa «Unir». 📱 = en el teléfono · ☁ = en el servidor.';
  tomasPanel.appendChild(head);
  if (!list.length) { const e = document.createElement('div'); e.className = 'tm-row'; e.textContent = 'Aún no hay tomas.'; tomasPanel.appendChild(e); }
  for (const t of list) {
    const r = document.createElement('div');
    r.className = 'tm-row';
    const where = (t.local ? '📱' : '') + (t.server ? '☁' : '');
    r.innerHTML = '<label><input type="checkbox"> <b></b> <small></small></label><span class="tm-btns"></span>';
    r.querySelector('input').value = t.id;
    r.querySelector('b').textContent = t.nombre || t.id;
    r.querySelector('small').textContent = where + ' ' + (t.puntos || 0).toLocaleString('es-CL') + ' pts · ' + (t.vistas || 0) + ' vistas' + (t.origen && t.origen !== 'telefono' ? ' · ' + t.origen : '');
    const btns = r.querySelector('.tm-btns');
    const mk = (txt, fn) => { const b = document.createElement('button'); b.textContent = txt; b.onclick = fn; btns.appendChild(b); };
    mk('Ver', () => showToma(t));
    if (srvErr && t.local && !t.server) r.classList.add('pend');
    if (t.local && !t.server) mk('Subir', async () => { try { await api().upload(await localTomas.get(t.id)); renderTomas(); } catch (e) { alert('No se pudo subir: ' + e.message); } });
    if (t.local) mk('Borrar', async () => { if (confirm('¿Borrar «' + (t.nombre || t.id) + '» del teléfono?')) { await localTomas.remove(t.id); renderTomas(); } });
    tomasPanel.appendChild(r);
  }
  const foot = document.createElement('div');
  foot.className = 'row';
  const bUnir = document.createElement('button');
  bUnir.className = 'pri';
  bUnir.textContent = 'Unir seleccionadas';
  bUnir.onclick = () => mergeSelected(list);
  const bSrv = document.createElement('button');
  bSrv.textContent = 'Servidor…';
  bSrv.onclick = () => {
    const v = prompt('Dirección del servidor que une las tomas:', apiBase());
    if (v) { try { localStorage.setItem('camara4d_api', v.trim()); } catch (e) { /* nada */ } renderTomas(); }
  };
  foot.append(bUnir, bSrv);
  tomasPanel.appendChild(foot);
}

async function showToma(t) {
  try {
    const T = t.local ? await localTomas.get(t.id) : await api().get(t.id);
    const m = Model.fromToma(T);
    const c = m.cloud(cleanBg);
    if (c) { cloud = c; viewer.setCloud(cloud); viewer.frontView(); }
    lastToma = T;
    showTab('res');
    stat('Mostrando «' + (T.nombre || T.id) + '»: ' + T.puntos.n.toLocaleString('es-CL') + ' puntos.');
  } catch (e) { stat('No se pudo abrir la toma: ' + e.message); }
}

async function mergeSelected(list) {
  const ids = [...tomasPanel.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
  if (ids.length < 2) { alert('Marca al menos 2 tomas.'); return; }
  stat('Uniendo ' + ids.length + ' tomas en el servidor…');
  try {
    // Las tomas que están solo en el teléfono se suben primero
    const uploads = [];
    for (const id of ids) {
      const t = list.find(x => x.id === id);
      if (t && t.local && !t.server) uploads.push(await localTomas.get(id));
    }
    const res = await serverMerge(ids, uploads);
    const T = res.toma;
    await localTomas.save(T).catch(() => {});
    if (res.detalle.filter(d => d.unida).length > 1) {
      const m = Model.fromToma(T);
      const c = m.cloud(cleanBg, 60000, true);
      if (c) { cloud = c; viewer.setCloud(cloud); viewer.frontView(); }
      lastToma = T;
      resNote.textContent = 'Unión: ' + res.informe;
      showTab('res');
    }
    stat('Tomas unidas: ' + res.informe);
    renderTomas();
  } catch (e) { stat('No se pudieron unir: ' + e.message); }
}

function showNote(m) { stat(m); }

/* ---------- Recuadro del objeto ---------- */
function setMarking(on) {
  marking = on;
  roiDraft = null;
  dragStart = null;
  vidBox.classList.toggle('marking', on);
  $('bRoi').classList.toggle('on', on);
  if (on) stat('Arrastra el dedo sobre el video para encerrar el objeto.');
}

function toCanvas(e) {
  const r = ov.getBoundingClientRect();
  return {
    x: Math.min(ov.width, Math.max(0, (e.clientX - r.left) * ov.width / r.width)),
    y: Math.min(ov.height, Math.max(0, (e.clientY - r.top) * ov.height / r.height))
  };
}
function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// El recuadro define el objeto: si ya hay modelo, la esfera del objeto se recalcula con lo que se ve dentro
function applyRoi() {
  if (state === 'track' && pose && model.voxels) {
    const pr = model.project(pose.R, pose.t, intr.f, intr.cx, intr.cy, intr.w, intr.h, 4);
    const P = [];
    for (let y = roi.y; y < roi.y + roi.h; y += 4) for (let x = roi.x; x < roi.x + roi.w; x += 4) {
      const X = Model.lookup(pr, pose.R, pose.t, intr.f, intr.cx, intr.cy, x, y);
      if (X) P.push(X);
    }
    if (model.setObject(P)) { roiObject = true; refreshCloud(true); stat('Objeto marcado: el fondo fuera de él no se muestra.'); return; }
  }
  if (state === 'init' || state === 'idle') { state = 'idle'; model.obj = null; roiObject = false; }
  stat('Objeto marcado. Sigue girando a su alrededor.');
}

ov.addEventListener('pointerdown', e => {
  if (!marking) return;
  e.preventDefault();
  ov.setPointerCapture(e.pointerId);
  dragStart = toCanvas(e);
  roiDraft = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
});
ov.addEventListener('pointermove', e => {
  if (!marking || !dragStart) return;
  roiDraft = rectFrom(dragStart, toCanvas(e));
});
ov.addEventListener('pointerup', e => {
  if (!marking || !dragStart) return;
  const r = rectFrom(dragStart, toCanvas(e));
  if (r.w >= 20 && r.h >= 20) {
    roi = r;
    $('bRoiClr').disabled = false;
    setMarking(false);
    applyRoi();
  } else {
    dragStart = null;
    roiDraft = null;
    stat('Recuadro muy pequeño. Vuelve a arrastrar sobre el objeto.');
  }
});
ov.addEventListener('pointercancel', () => { dragStart = null; roiDraft = null; });

$('bRoi').onclick = () => setMarking(!marking);
$('bRoiClr').onclick = () => {
  roi = null;
  $('bRoiClr').disabled = true;
  setMarking(false);
  stat('Recuadro borrado.');
};
$('bClean').onclick = () => {
  cleanBg = !cleanBg;
  $('bClean').classList.toggle('on', cleanBg);
  $('bClean').textContent = 'Limpiar fondo: ' + (cleanBg ? 'sí' : 'no');
  // Solo cambia lo que se muestra: el modelo guarda todo
  if (lastToma && state === 'done') { const m = Model.fromToma(lastToma); const c = m.cloud(cleanBg); if (c) { cloud = c; viewer.setCloud(cloud); } }
  else refreshCloud(true);
};

function drawOverlay() {
  if (!running) return;
  octx.clearRect(0, 0, ov.width, ov.height);
  const r = roiDraft || roi;
  if (r) {
    octx.lineWidth = 2;
    octx.strokeStyle = '#f7c948';
    octx.setLineDash(roiDraft ? [6, 4] : []);
    octx.strokeRect(r.x, r.y, r.w, r.h);
    octx.setLineDash([]);
  }
  if (marking || state === 'lost') return;
  if (sheetMode) {
    octx.lineWidth = 2;
    octx.strokeStyle = state === 'track' ? '#3ddc84' : '#f7c948';
    for (const d of sheetDets) {
      octx.beginPath();
      d.corners.forEach((c, i) => (i ? octx.lineTo(c[0], c[1]) : octx.moveTo(c[0], c[1])));
      octx.closePath();
      octx.stroke();
    }
    return;
  }
  for (const p of tracker.pts) {
    octx.fillStyle = p.X ? '#4cc9f0' : '#3ddc84';
    octx.beginPath();
    octx.arc(p.x, p.y, p.X ? 2.4 : 1.6, 0, 6.283);
    octx.fill();
  }
}

/* ---------- Controles ---------- */
$('fov').oninput = () => {
  $('fovV').textContent = $('fov').value;
  focal.done = true;   // el usuario eligió la focal a mano
  try { localStorage.setItem('camara4d_fov', $('fov').value); } catch (e) { /* nada */ }
  if (running && state !== 'idle' && state !== 'init') stat('La focal nueva se usará desde la próxima captura.');
  else if (running) state = 'idle';
};
$('ws').oninput = () => {
  const v = parseFloat($('ws').value);
  $('wsV').textContent = v.toFixed(1);
  viewer.setWScale(v);
};

const setMode = m => {
  viewer.setMode(m);
  $('m3').classList.toggle('on', m === '3d');
  $('m4').classList.toggle('on', m === '4d');
};
$('m3').onclick = () => setMode('3d');
$('m4').onclick = () => setMode('4d');
$('bAuto').onclick = () => {
  viewer.setAuto(!viewer.auto);
  $('bAuto').classList.toggle('on', viewer.auto);
};
$('zIn').onclick = () => viewer.zoomBy(1.25);
$('zOut').onclick = () => viewer.zoomBy(0.8);
$('zReset').onclick = () => viewer.resetView();
{
  const b = document.createElement('button');
  b.id = 'bFront';
  b.textContent = 'Ver de frente';
  b.onclick = () => viewer.frontView();
  $('zReset').after(b);
}

$('bExp').onclick = () => exportJSON({
  cloud, poses, imu: sensors.samples,
  fov: parseFloat($('fov').value),
  size: { w: cam.width, h: cam.height },
  extra: { toma: lastToma || (model.voxels ? model.toToma({ id: 'sin-guardar', nombre: 'Captura en curso', fecha: new Date().toISOString(), intr }) : null) }
});

/* ---------- Pantalla tipo app: menú arriba con 3 pantallas ---------- */
// index.html no cambia: aquí se reordenan sus partes en pestañas.
//   📷 Captura  → cámara, botón grande Iniciar / Terminar, asistente y avance
//   🧊 Resultado → el modelo 3D a pantalla completa, sus controles y exportar
//   ☁ Tomas     → tomas guardadas (teléfono y servidor), subir y unir
let tab = 'cap';
const srvLine = document.createElement('div');
const resNote = document.createElement('div');
resNote.className = 'res-note';
const showTab = (() => {
  const boxes = document.querySelectorAll('body > .box');
  const capBox = boxes[0], resBox = boxes[1];
  document.body.classList.add('app');

  // Barra superior: título + menú
  const top = document.createElement('header');
  top.className = 'top';
  const nav = document.createElement('nav');
  nav.className = 'tabs';
  const tabs = [['cap', '📷', 'Captura'], ['res', '🧊', 'Resultado'], ['tomas', '☁', 'Tomas']];
  const btn = {};
  for (const [id, ic, txt] of tabs) {
    const b = document.createElement('button');
    b.innerHTML = '<i>' + ic + '</i><span>' + txt + '</span>';
    b.onclick = () => show(id);
    nav.appendChild(b);
    btn[id] = b;
  }
  $('title').before(top);
  top.append($('title'), nav, job.el);

  // Pantalla Captura
  const pCap = document.createElement('section');
  pCap.className = 'page';
  capBox.before(pCap);
  pCap.appendChild(capBox);
  const main = $('bStart').parentElement;
  main.classList.add('cap-main');
  $('bStart').classList.add('big');
  $('bEnd').classList.add('big', 'stop');
  $('bNew').classList.add('big');
  $('bRoi').parentElement.classList.add('cap-sec');
  const bMode = document.createElement('button'), bPrint = document.createElement('button');
  sesBtn.onclick = () => { if (ses) { if (confirm('¿Salir de la sesión ' + ses.codigo + '?')) sesLeave(); } else sesStart(); };
  bPrint.textContent = '🖨 Imprimir hoja';
  bPrint.onclick = () => { if (!openPrintable()) alert('El navegador bloqueó la ventana: permite ventanas emergentes para imprimir la hoja.'); };
  const paintMode = () => {
    bMode.textContent = sheetMode ? '📄 Con hoja (medidas reales)' : '🔓 Sin hoja';
    bMode.classList.toggle('on', sheetMode);
    $('bRoi').hidden = $('bRoiClr').hidden = sheetMode;
    bPrint.hidden = !sheetMode;
  };
  paintModeBtn = paintMode;
  bMode.onclick = () => {
    if (running) { alert('Cambia el modo antes de iniciar la captura (o pulsa «Terminar»).'); return; }
    if (ses && sheetMode) { alert('En una sesión con varias cámaras se usa la hoja (es la referencia común).'); return; }
    sheetMode = !sheetMode;
    try { localStorage.setItem('camara4d_modo', sheetMode ? 'hoja' : 'libre'); } catch (e) { /* nada */ }
    paintMode();
  };
  $('bRoi').parentElement.prepend(bMode, bPrint, sesBtn);
  $('bRoi').parentElement.after(sesLine);
  paintMode();
  $('fov').parentElement.parentElement.classList.add('cap-adv');

  // Pantalla Resultado
  const pRes = document.createElement('section');
  pRes.className = 'page';
  resBox.before(pRes);
  pRes.appendChild(resBox);
  resBox.prepend(resNote);
  const rRow = document.createElement('div');
  rRow.className = 'row';
  const bRec = document.createElement('button');
  bRec.textContent = 'Bajar grabación de prueba';
  bRec.onclick = async () => { bRec.disabled = true; bRec.textContent = 'Preparando…'; try { await rec.download(); } finally { bRec.disabled = false; bRec.textContent = 'Bajar grabación de prueba'; } };
  setInterval(() => { bRec.hidden = rec.on || !rec.frames.length; }, 1000);
  rRow.append($('bClean'), $('bExp'), bRec);
  $('help').before(rRow);
  const wLbl = $('ws').parentElement;
  const wRow = document.createElement('div');
  wRow.className = 'row';
  wRow.appendChild(wLbl);
  $('help').before(wRow);

  // Pantalla Tomas
  const pTom = document.createElement('section');
  pTom.className = 'page';
  const tBox = document.createElement('div');
  tBox.className = 'box';
  srvLine.className = 'srv';
  tBox.append(srvLine, tomasPanel);
  pTom.appendChild(tBox);
  pRes.after(pTom);

  // Lo que quedó en la caja de captura y no se usa ahí (exportar ya está en Resultado)
  const pages = { cap: pCap, res: pRes, tomas: pTom };
  function show(id) {
    tab = id;
    for (const k in pages) { pages[k].hidden = k !== id; btn[k].classList.toggle('on', k === id); }
    tomasPanel.open = id === 'tomas';
    if (id === 'res') requestAnimationFrame(() => viewer.fit());
    if (id === 'tomas') renderTomas();
    window.scrollTo(0, 0);
  }
  // Marca de «capturando» en el menú
  setInterval(() => btn.cap.classList.toggle('rec', running), 500);
  show('cap');
  return show;
})();

updateProgress();

// Señal para el panel de errores: el programa arrancó.
window.APP_READY = true;
