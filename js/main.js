// main.js — Conecta los módulos: cámara → seguimiento → pose → profundidad densa → visor / exportación.
// Todo el cálculo es propio (sin librerías externas). Al iniciar la cámara, todo arranca solo.

import { Camera } from './camera.js';
import { Tracker, VERSION as TRACKER_VERSION } from './tracker.js';
import { reconstructTwoView, VERSION as GEOMETRY_VERSION } from './geometry.js';
import { denseDepth, depthToCloud, VERSION as DENSE_VERSION } from './dense.js';
import { Sensors } from './sensors.js';
import { Viewer } from './viewer.js';
import { exportJSON } from './export.js';

const $ = id => document.getElementById(id);

const cam = new Camera($('video'), document.createElement('canvas'));
const sensors = new Sensors();
const viewer = new Viewer($('view'));
const tracker = new Tracker();
const ov = $('ov'), octx = ov.getContext('2d');
const vidBox = ov.parentElement;

let running = false, needRef = true, busy = false;
let cloud = [], poses = [], frame = 0, lastDense = 0;
let shownCount = 0, shownAt = 0;   // calidad de la imagen 3D en pantalla (para no reemplazarla por una peor)
let lastMsg = '';

// Recuadro del objeto (en píxeles del canvas de trabajo) y limpieza de fondo
let roi = null;          // {x, y, w, h} confirmado
let roiDraft = null;     // recuadro mientras se dibuja
let marking = false;
let dragStart = null;
let cleanBg = true;

const stat = m => { if (m !== lastMsg) { $('status').textContent = m; lastMsg = m; } };

/* ---------- Versión ---------- */
const VERSION = '5';
const showErr = m => (window.showAppError ? window.showAppError(m) : stat(m));
{
  const bad = [];
  if (window.APP_VERSION !== VERSION) bad.push('index.html');
  if (TRACKER_VERSION !== VERSION) bad.push('js/tracker.js');
  if (GEOMETRY_VERSION !== VERSION) bad.push('js/geometry.js');
  if (DENSE_VERSION !== VERSION) bad.push('js/dense.js');
  if (bad.length) showErr('Archivos de otra versión: ' + bad.join(', ') + '. Súbelos de nuevo.');
}

/* ---------- Cámara: al iniciar, todo arranca solo ---------- */
$('bStart').onclick = async () => {
  $('bStart').disabled = true;
  await sensors.enable();
  try {
    await cam.start();
    ov.width = cam.width;
    ov.height = cam.height;
    running = true;
    needRef = true;
    $('bExp').disabled = false;
    $('bRoi').disabled = false;
    stat('Cámara lista. Apunta al objeto y muévete lentamente a su alrededor.');
    loop();
  } catch (err) {
    $('bStart').disabled = false;
    const msg = 'No pude abrir la cámara: ' + err.name + ' — ' + err.message +
      (err.name === 'NotAllowedError' ? '. Activa el permiso de cámara: toca el ícono junto a la dirección web → Permisos → Cámara.' : '.');
    stat(msg);
    showErr(msg);
  }
};

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
ov.addEventListener('pointerup', e => {
  if (!marking || !dragStart) return;
  const r = rectFrom(dragStart, toCanvas(e));
  if (r.w >= 20 && r.h >= 20) {
    roi = r;
    $('bRoiClr').disabled = false;
    setMarking(false);
    needRef = true;   // vuelve a empezar enfocado en el objeto
    shownCount = 0;
    stat('Objeto marcado. Muévete lentamente a su alrededor.');
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
  needRef = true;
  shownCount = 0;
  stat('Recuadro borrado: se usa toda la imagen.');
};
$('bClean').onclick = () => {
  cleanBg = !cleanBg;
  $('bClean').classList.toggle('on', cleanBg);
  $('bClean').textContent = 'Limpiar fondo: ' + (cleanBg ? 'sí' : 'no');
  lastDense = 0;   // recalcula con el próximo fotograma
  shownCount = 0;
};

/* ---------- Bucle ---------- */
function loop() {
  if (!running) return;
  const t0 = performance.now();
  try { step(); } catch (e) { showErr('Error: ' + e.message); }
  setTimeout(loop, Math.max(15, 70 - (performance.now() - t0)));
}

function step() {
  cam.grab();
  if (marking) { drawOverlay(); return; }
  const img = cam.ctx.getImageData(0, 0, cam.width, cam.height);

  // Referencia automática: al empezar, al marcar el objeto o cuando se pierden los puntos
  if (needRef || !tracker.tracking) {
    needRef = false;
    const n = tracker.setReference(img, roi);
    frame = 0;
    if (n < 30) {
      needRef = true;
      stat('Pocos detalles en la imagen (' + n + ' puntos). Apunta a un objeto con más textura o más luz.');
    } else if (!cloud.length) {
      stat('Siguiendo ' + n + ' puntos. Muévete lentamente de lado alrededor del objeto.');
    }
    drawOverlay();
    return;
  }

  const s = tracker.track(img);
  frame++;
  if (s.nAlive < Math.max(30, 0.35 * tracker.N0)) {
    needRef = true;   // se perdieron demasiados puntos: nueva referencia (la imagen 3D se mantiene)
  } else if (s.parallax < 12) {
    if (!cloud.length) stat('Muévete de lado para ver el objeto desde otro ángulo (' + s.parallax.toFixed(0) + ' px).');
  } else if (frame % 2 === 0 && performance.now() - lastDense > 1000) {
    reconstruct(img);
  }
  drawOverlay();
}

/* ---------- Reconstrucción: pose (puntos) → profundidad de cada píxel ---------- */
function reconstruct(img) {
  if (busy) return;
  busy = true;
  try {
    const fov = parseFloat($('fov').value);
    const f = cam.focalPx(fov), cx = cam.width / 2, cy = cam.height / 2;
    const ids = tracker.aliveIds();
    const res = reconstructTwoView(tracker.ref, tracker.cur, ids, f, cx, cy);
    if (!res || res.pts.length < 20) { stat('Calculando posición de la cámara… sigue moviéndote lentamente.'); return; }

    tracker.inl.fill(0);
    for (const p of res.pts) tracker.inl[p.id] = 1;

    // Rango de profundidades del objeto a partir de los puntos triangulados
    const ds = res.pts.map(p => -p.P[2]).sort((a, b) => a - b);
    const range = [ds[Math.floor(ds.length * 0.05)], ds[Math.floor(ds.length * 0.95)]];

    const t0 = performance.now();
    const dm = denseDepth(tracker.refImage, img, res.R, res.t, f, cx, cy, range, { roi, clean: cleanBg });
    const ms = performance.now() - t0;
    lastDense = performance.now();

    // Una imagen claramente peor no reemplaza a la actual (salvo que la actual ya tenga más de 5 s)
    if (cloud.length && dm.count < 0.6 * shownCount && performance.now() - shownAt < 5000) return;
    const out = depthToCloud(dm);
    if (!out) { if (!cloud.length) stat('Aún no hay suficiente detalle para la imagen 3D. Muévete un poco más de lado.'); return; }
    cloud = out;
    shownCount = dm.count;
    shownAt = performance.now();
    viewer.setCloud(cloud);
    poses.push({ t: Math.round(performance.now()), R: res.R, tvec: res.t, puntos: res.pts.length, pixeles: dm.count, parallax_px: +tracker.parallax.toFixed(1) });
    if (poses.length > 3000) poses.shift();
    stat('Imagen 3D: ' + dm.count + ' píxeles con profundidad (' + Math.round(ms) + ' ms). Sigue girando para mejorarla.');
  } finally {
    busy = false;
  }
}

function drawOverlay() {
  octx.clearRect(0, 0, ov.width, ov.height);
  const r = roiDraft || roi;
  if (r) {
    octx.lineWidth = 2;
    octx.strokeStyle = '#f7c948';
    octx.setLineDash(roiDraft ? [6, 4] : []);
    octx.strokeRect(r.x, r.y, r.w, r.h);
    octx.setLineDash([]);
  }
  if (!tracker.tracking || marking) return;
  for (let i = 0; i < tracker.N; i++) {
    if (!tracker.alive[i]) continue;
    octx.fillStyle = tracker.inl[i] ? '#4cc9f0' : '#3ddc84';
    octx.beginPath();
    octx.arc(tracker.cur[2 * i], tracker.cur[2 * i + 1], tracker.inl[i] ? 2.4 : 1.6, 0, 6.283);
    octx.fill();
  }
}

/* ---------- Controles ---------- */
$('fov').oninput = () => {
  $('fovV').textContent = $('fov').value;
  lastDense = 0;
  shownCount = 0;
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
