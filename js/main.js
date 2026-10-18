// main.js — Conecta los módulos: cámara → seguimiento → geometría → visor / exportación.

import { Camera } from './camera.js';
import { loadOpenCV, Tracker } from './tracker.js';
import { reconstructTwoView, normalizeCloud } from './geometry.js';
import { Sensors } from './sensors.js';
import { Viewer } from './viewer.js';
import { exportJSON } from './export.js';

const $ = id => document.getElementById(id);

const cam = new Camera($('video'), document.createElement('canvas'));
const sensors = new Sensors();
const viewer = new Viewer($('view'));
const ov = $('ov'), octx = ov.getContext('2d');

let tracker = null;
let running = false, wantRef = false;
let cloud = [], poses = [], frame = 0, nInl = 0;
let lastMsg = '';

const stat = m => { if (m !== lastMsg) { $('status').textContent = m; lastMsg = m; } };

/* ---------- OpenCV ---------- */
loadOpenCV()
  .then(cv => { tracker = new Tracker(cv); })
  .catch(e => stat('Error: ' + e.message));

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
    stat('Cámara lista' + (cam.zoomLocked ? ' (zoom bloqueado)' : '') + '. Apunta a un objeto con textura y pulsa «Fijar referencia».');
    loop();
  } catch (err) {
    $('bStart').disabled = false;
    stat('No pude abrir la cámara: ' + err.message + ' (se necesita HTTPS y permiso de cámara).');
  }
};
$('bRef').onclick = () => { wantRef = true; };

/* ---------- Bucle ---------- */
function loop() {
  if (!running) return;
  try { step(); } catch (e) { stat('Error: ' + e.message); }
  setTimeout(loop, 90);
}

function step() {
  if (!tracker) { stat('Cargando OpenCV.js…'); return; }
  const canvas = cam.grab();

  if (wantRef) {
    wantRef = false;
    const n = tracker.setReference(canvas);
    cloud = []; poses = []; frame = 0; nInl = 0;
    viewer.setCloud(cloud);
    stat(n < 30
      ? 'Pocos puntos detectados (' + n + '). Busca un objeto con más textura y vuelve a fijar.'
      : 'Referencia fijada con ' + n + ' puntos. Mueve el teléfono alrededor del objeto.');
  } else if (tracker.tracking) {
    const s = tracker.track(canvas);
    frame++;
    if (s.nAlive < 30) {
      stat('Quedan pocos puntos (' + s.nAlive + '). Pulsa «Fijar referencia».');
    } else if (s.parallax < 10) {
      stat('Puntos: ' + s.nAlive + '. Mueve el teléfono de lado para generar paralaje (' + s.parallax.toFixed(0) + ' px).');
    } else {
      if (frame % 3 === 0) reconstruct();
      stat('Puntos vivos ' + s.nAlive + ' · inliers ' + nInl + ' · paralaje ' + s.parallax.toFixed(0) +
        ' px · nube ' + cloud.length + ' pts' + (sensors.gMag ? ' · |a| ' + sensors.gMag.toFixed(2) + ' m/s²' : ''));
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

  tracker.inl.fill(0);
  for (const p of res.pts) tracker.inl[p.id] = 1;
  nInl = res.pts.length;

  const out = normalizeCloud(res.pts, tracker.col);
  if (!out) return;
  cloud = out;
  viewer.setCloud(cloud);

  poses.push({ t: Math.round(performance.now()), R: res.R, tvec: res.t, inliers: nInl, parallax_px: +tracker.parallax.toFixed(1) });
  if (poses.length > 3000) poses.shift();
}

function drawOverlay() {
  octx.clearRect(0, 0, ov.width, ov.height);
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
  
