// main.js — Conecta los módulos: cámara → seguimiento → geometría → visor / exportación.

import { Camera } from './camera.js';
import { loadOpenCV, Tracker, VERSION as TRACKER_VERSION } from './tracker.js';
import { reconstructTwoView, normalizeCloud, largestCluster, VERSION as GEOMETRY_VERSION } from './geometry.js';
import { Sensors } from './sensors.js';
import { Viewer } from './viewer.js';
import { exportJSON } from './export.js';

const $ = id => document.getElementById(id);

const cam = new Camera($('video'), document.createElement('canvas'));
const sensors = new Sensors();
const viewer = new Viewer($('view'));
const ov = $('ov'), octx = ov.getContext('2d');
const vidBox = ov.parentElement;

let tracker = null;
let cvError = null;   // mensaje si OpenCV.js no pudo cargar
let running = false, wantRef = false;
let cloud = [], poses = [], frame = 0, nInl = 0, nObj = 0;
let lastMsg = '';

// Recuadro del objeto (en píxeles del canvas de trabajo) y limpieza de fondo
let roi = null;          // {x, y, w, h} confirmado
let roiDraft = null;     // recuadro mientras se dibuja
let marking = false;
let dragStart = null;
let cleanBg = true;

const stat = m => { if (m !== lastMsg) { $('status').textContent = m; lastMsg = m; } };

/* ---------- Versión ---------- */
const VERSION = '4';
const showErr = m => (window.showAppError ? window.showAppError(m) : stat(m));
{
  const bad = [];
  if (window.APP_VERSION !== VERSION) bad.push('index.html');
  if (TRACKER_VERSION !== VERSION) bad.push('js/tracker.js');
  if (GEOMETRY_VERSION !== VERSION) bad.push('js/geometry.js');
  if (bad.length) showErr('Archivos de otra versión: ' + bad.join(', ') + '. Súbelos de nuevo.');
}

/* ---------- OpenCV (se carga después de abrir la cámara) ---------- */
let cvStarted = false;
function startOpenCV() {
  if (cvStarted) return;
  cvStarted = true;
  loadOpenCV()
    .then(cv => { tracker = new Tracker(cv); })
    .catch(e => { cvError = e.message; showErr('OpenCV: ' + e.message + '. Revisa la conexión y recarga la página.'); });
}

/* ---------- Cámara ---------- */
$('bStart').onclick = async () => {
  $('bStart').disabled = true;
  await sensors.enable();
  try {
    await cam.start();
    ov.width = cam.width;
    ov.height = cam.height;
    running = true;
    $('bRef').disabled = false;
    $('bExp').disabled = false;
    $('bRoi').disabled = false;
    stat('Cámara lista' + (cam.zoomLocked ? ' (zoom bloqueado)' : '') + '. Pulsa «Marcar objeto» y dibuja un recuadro sobre él, luego «Fijar referencia».');
    loop();
    startOpenCV();
  } catch (err) {
    $('bStart').disabled = false;
    const msg = 'No pude abrir la cámara: ' + err.name + ' — ' + err.message +
      (err.name === 'NotAllowedError' ? '. Activa el permiso de cámara: toca el ícono junto a la dirección web → Permisos → Cámara.' : '.');
    stat(msg);
    showErr(msg);
  }
};
$('bRef').onclick = () => { if (marking) setMarking(false); wantRef = true; };

/* ---------- Recuadro del objeto ---------- */
function setMarking(on) {
  marking = on;
  roiDraft = null;
  dragStart = null;
  vidBox.classList.toggle('marking', on);
  $('bRoi').classList.toggle('on', on);
  if (on) stat('Arrastra el dedo sobre el video para encerrar el objeto.');
}

// Coordenadas del dedo → píxeles del canvas de trabajo
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
const endDrag = e => {
  if (!marking || !dragStart) return;
  const r = rectFrom(dragStart, toCanvas(e));
  if (r.w >= 20 && r.h >= 20) {
    roi = r;
    $('bRoiClr').disabled = false;
    setMarking(false);
    stat('Objeto marcado. Pulsa «Fijar referencia» y mueve el teléfono alrededor.');
  } else {
    dragStart = null;
    roiDraft = null;
    stat('Recuadro muy pequeño. Vuelve a arrastrar sobre el objeto.');
  }
};
ov.addEventListener('pointerup', endDrag);
ov.addEventListener('pointercancel', () => { dragStart = null; roiDraft = null; });

$('bRoi').onclick = () => setMarking(!marking);
$('bRoiClr').onclick = () => {
  roi = null;
  $('bRoiClr').disabled = true;
  setMarking(false);
  stat('Recuadro borrado: se usará toda la imagen.');
};
$('bClean').onclick = () => {
  cleanBg = !cleanBg;
  $('bClean').classList.toggle('on', cleanBg);
  $('bClean').textContent = 'Limpiar fondo: ' + (cleanBg ? 'sí' : 'no');
  if (tracker && tracker.tracking && tracker.nAlive >= 30 && tracker.parallax >= 10) reconstruct();
};

/* ---------- Bucle ---------- */
function loop() {
  if (!running) return;
  try { step(); } catch (e) { stat('Error: ' + e.message); }
  setTimeout(loop, 90);
}

function step() {
  if (!tracker) {
    if (cvError) stat('Error: ' + cvError + '. Revisa la conexión y recarga la página.');
    else if (wantRef) stat('Cargando OpenCV.js (puede tardar unos segundos)… la referencia se fijará al terminar.');
    drawOverlay();
    return;
  }
  const canvas = cam.grab();

  if (wantRef) {
    wantRef = false;
    const n = tracker.setReference(canvas, roi);
    cloud = []; poses = []; frame = 0; nInl = 0; nObj = 0;
    viewer.setCloud(cloud);
    stat(n < 30
      ? 'Pocos puntos detectados (' + n + '). ' + (roi ? 'Agranda el recuadro o busca' : 'Busca') + ' un objeto con más textura y vuelve a fijar.'
      : 'Referencia fijada con ' + n + ' puntos' + (roi ? ' dentro del recuadro' : '') + '. Mueve el teléfono alrededor del objeto.');
  } else if (tracker.tracking && !marking) {
    const s = tracker.track(canvas);
    frame++;
    if (s.nAlive < 30) {
      stat('Quedan pocos puntos (' + s.nAlive + '). Pulsa «Fijar referencia».');
    } else if (s.parallax < 10) {
      stat('Puntos: ' + s.nAlive + '. Mueve el teléfono de lado para generar paralaje (' + s.parallax.toFixed(0) + ' px).');
    } else {
      if (frame % 3 === 0) reconstruct();
      stat('Puntos vivos ' + s.nAlive + ' · inliers ' + nInl + (cleanBg ? ' · objeto ' + nObj : '') +
        ' · paralaje ' + s.parallax.toFixed(0) + ' px · nube ' + cloud.length + ' pts' +
        (sensors.gMag ? ' · |a| ' + sensors.gMag.toFixed(2) + ' m/s²' : ''));
    }
  }
  drawOverlay();
}

/* ---------- Reconstrucción ---------- */
function reconstruct() {
  const fov = parseFloat($('fov').value);
  const f = cam.focalPx(fov);
  const ids = tracker.aliveIds();
  const res = reconstructTwoView(tracker.ref, tracker.cur, ids, f, cam.width / 2, cam.height / 2);
  if (!res) return;
  nInl = res.pts.length;

  // Limpieza de fondo: quedarse con el grupo de puntos más grande (el objeto)
  const pts = cleanBg ? largestCluster(res.pts) : res.pts;
  nObj = pts.length;

  tracker.inl.fill(0);
  for (const p of pts) tracker.inl[p.id] = 1;

  const out = normalizeCloud(pts, tracker.col);
  if (!out) return;
  cloud = out;
  viewer.setCloud(cloud);

  poses.push({ t: Math.round(performance.now()), R: res.R, tvec: res.t, inliers: nInl, objeto: nObj, parallax_px: +tracker.parallax.toFixed(1) });
  if (poses.length > 3000) poses.shift();
}

function drawOverlay() {
  octx.clearRect(0, 0, ov.width, ov.height);

  // Recuadro (confirmado o en dibujo)
  const r = roiDraft || roi;
  if (r) {
    octx.lineWidth = 2;
    octx.strokeStyle = '#f7c948';
    octx.setLineDash(roiDraft ? [6, 4] : []);
    octx.strokeRect(r.x, r.y, r.w, r.h);
    octx.setLineDash([]);
  }

  if (!tracker || !tracker.tracking) return;
  for (let i = 0; i < tracker.N; i++) {
    if (!tracker.alive[i]) continue;
    octx.fillStyle = tracker.inl[i] ? '#4cc9f0' : '#3ddc84';
    octx.beginPath();
    octx.arc(tracker.cur[2 * i], tracker.cur[2 * i + 1], tracker.inl[i] ? 2.6 : 1.8, 0, 6.283);
    octx.fill();
  }
}

/* ---------- Controles ---------- */
$('fov').oninput = () => {
  $('fovV').textContent = $('fov').value;
  if (tracker && tracker.tracking && tracker.nAlive >= 30 && tracker.parallax >= 10) reconstruct();
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

$('bExp').onclick = () => exportJSON({
  cloud, poses, imu: sensors.samples,
  fov: parseFloat($('fov').value),
  size: { w: cam.width, h: cam.height }
});

// Señal para el panel de errores: el programa arrancó.
window.APP_READY = true;
