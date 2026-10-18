// main.js — Conecta los módulos: cámara → seguimiento → pose → profundidad densa → visor / exportación.
// Todo el cálculo es propio (sin librerías externas). Al iniciar la cámara, todo arranca solo.

import { Camera } from './camera.js';
import { Tracker, VERSION as TRACKER_VERSION } from './tracker.js';
import { reconstructTwoView, VERSION as GEOMETRY_VERSION } from './geometry.js';
import { denseDepth, depthToCloud, Accumulator, VERSION as DENSE_VERSION } from './dense.js';
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
let lastMsg = '';

// Captura: todo se acumula en la vista de la primera referencia (K0)
const GOAL = 0.85;       // cobertura con la que la captura termina sola
let acc = null;          // acumulador de profundidad
let k0Image = null;      // imagen de K0 (se muestra al terminar)
let R0 = [1, 0, 0, 0, 1, 0, 0, 0, 1], t0 = [0, 0, 0];   // pose de la referencia actual respecto de K0
let lost = false, finished = false;

// Recuadro del objeto (en píxeles del canvas de trabajo) y limpieza de fondo
let roi = null;          // {x, y, w, h} confirmado
let roiDraft = null;     // recuadro mientras se dibuja
let marking = false;
let dragStart = null;
let cleanBg = true;

const stat = m => { if (m !== lastMsg) { $('status').textContent = m; lastMsg = m; } };

/* ---------- Versión ---------- */
const VERSION = '6';
const showErr = m => (window.showAppError ? window.showAppError(m) : stat(m));
{
  // Versión que debe tener cada archivo
  const bad = [];
  if (window.APP_VERSION !== '6') bad.push('index.html');
  if (TRACKER_VERSION !== '5') bad.push('js/tracker.js');
  if (GEOMETRY_VERSION !== '5') bad.push('js/geometry.js');
  if (DENSE_VERSION !== '6') bad.push('js/dense.js');
  if (bad.length) showErr('Archivos de otra versión: ' + bad.join(', ') + '. Súbelos de nuevo.');
}

/* ---------- Cámara: al iniciar, todo arranca solo ---------- */
async function startCamera() {
  try {
    await cam.start();
    ov.width = cam.width;
    ov.height = cam.height;
    running = true;
    finished = false;
    needRef = true;
    cloud = []; poses = [];
    viewer.setCloud(cloud);
    setProgress(0);
    $('bExp').disabled = false;
    $('bRoi').disabled = false;
    $('bEnd').disabled = false;
    $('bNew').disabled = true;
    stat('Cámara lista. Apunta al objeto y muévete lentamente a su alrededor.');
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

$('bStart').onclick = async () => {
  $('bStart').disabled = true;
  await sensors.enable();
  if (!(await startCamera())) $('bStart').disabled = false;
};
$('bEnd').onclick = () => finish(false);
$('bNew').onclick = async () => {
  $('bNew').disabled = true;
  if (!(await startCamera())) $('bNew').disabled = false;
};

function setProgress(c) {
  const pct = Math.round(100 * c);
  $('progBar').style.width = Math.min(100, Math.round(100 * c / GOAL)) + '%';
  $('progTxt').textContent = 'Cobertura ' + pct + ' % (meta ' + Math.round(100 * GOAL) + ' %)';
}

// Fin de la captura (automático al llegar a la meta, o con «Terminar»)
function finish(auto) {
  if (finished) return;
  finished = true;
  running = false;
  cam.stop();
  $('bEnd').disabled = true;
  $('bNew').disabled = false;
  $('bRoi').disabled = true;
  setMarking(false);
  // Muestra la imagen de partida en lugar del video detenido
  octx.clearRect(0, 0, ov.width, ov.height);
  if (k0Image) octx.putImageData(k0Image, 0, 0);
  if (!acc || !acc.fusions) { stat('Captura terminada sin datos suficientes. Pulsa «Nueva captura».'); return; }
  const dm = acc.depthMap(true, cleanBg);
  const out = depthToCloud(dm);
  if (out) { cloud = out; viewer.setCloud(cloud); }
  stat((auto ? 'Listo: se alcanzó la meta. ' : 'Captura terminada. ') + 'Modelo final con ' + dm.count +
    ' píxeles (cobertura ' + Math.round(100 * acc.coverage()) + ' %). Gíralo en el visor.');
}


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
    needRef = true;   // captura nueva enfocada en el objeto
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
  stat('Recuadro borrado: se usa toda la imagen.');
};
$('bClean').onclick = () => {
  cleanBg = !cleanBg;
  $('bClean').classList.toggle('on', cleanBg);
  $('bClean').textContent = 'Limpiar fondo: ' + (cleanBg ? 'sí' : 'no');
  needRef = true;   // captura nueva con el nuevo criterio
};

/* ---------- Bucle ---------- */
function loop() {
  if (!running) return;
  const t0 = performance.now();
  try { step(); } catch (e) { showErr('Error: ' + e.message); }
  setTimeout(loop, Math.max(15, 70 - (performance.now() - t0)));
}

// Empieza una captura nueva: esta imagen pasa a ser K0
function startCapture(img) {
  const n = tracker.setReference(img, roi);
  frame = 0;
  if (n < 30) {
    stat('Pocos detalles en la imagen (' + n + ' puntos). Apunta a un objeto con más textura o más luz.');
    return false;
  }
  acc = new Accumulator(img, 3, { roi });
  k0Image = img;
  R0 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  t0 = [0, 0, 0];
  lost = false;
  cloud = []; poses = [];
  viewer.setCloud(cloud);
  setProgress(0);
  stat('Capturando: muévete lentamente de lado alrededor del objeto.');
  return true;
}

function step() {
  if (finished) return;
  cam.grab();
  if (marking) { drawOverlay(); return; }
  const img = cam.ctx.getImageData(0, 0, cam.width, cam.height);

  if (needRef) {
    if (startCapture(img)) needRef = false;
    drawOverlay();
    return;
  }
  if (lost) { drawOverlay(); return; }

  const s = tracker.track(img);
  frame++;
  if (s.nAlive < 30) {
    lost = true;
    stat('Se perdió el seguimiento (movimiento muy rápido o poca textura). Pulsa «Terminar» para quedarte con lo capturado, o «Marcar objeto» para empezar de nuevo.');
  } else if (s.parallax < 12) {
    if (!acc.fusions) stat('Muévete de lado para ver el objeto desde otro ángulo (' + s.parallax.toFixed(0) + ' px).');
  } else if (frame % 2 === 0 && performance.now() - lastDense > 1000) {
    reconstruct(img);
    if (finished) return;   // terminó en esta medición: se deja la imagen de partida en pantalla
  }
  drawOverlay();
}

/* ---------- Reconstrucción: pose → profundidad de cada píxel → se suma al modelo ---------- */
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

    // Rango de profundidades a partir de los puntos triangulados
    const ds = res.pts.map(p => -p.P[2]).sort((a, b) => a - b);
    const range = [ds[Math.floor(ds.length * 0.05)], ds[Math.floor(ds.length * 0.95)]];

    // El recuadro solo vale mientras la referencia sea K0 (la imagen donde se marcó)
    const atK0 = acc.fusions === 0 || (t0[0] === 0 && t0[1] === 0 && t0[2] === 0);
    const dm = denseDepth(tracker.refImage, img, res.R, res.t, f, cx, cy, range, { roi: atK0 ? roi : null, clean: cleanBg });
    lastDense = performance.now();

    acc.setIntrinsics(f, cx, cy);
    if (!acc.fuse(dm, R0, t0)) {
      if (!acc.fusions) stat('Aún no hay suficiente detalle. Muévete un poco más de lado.');
      return;
    }

    // Mostrar el modelo acumulado y la cobertura
    const out = depthToCloud(acc.depthMap(false, cleanBg));
    if (out) { cloud = out; viewer.setCloud(cloud); }
    const c = acc.coverage();
    setProgress(c);
    poses.push({ t: Math.round(performance.now()), R: res.R, tvec: res.t, escala: acc.scale, puntos: res.pts.length, pixeles: dm.count });
    if (poses.length > 3000) poses.shift();
    if (c >= GOAL && acc.fusions >= 3) { finish(true); return; }
    stat('Capturando: ' + acc.fusions + ' mediciones sumadas. Sigue moviéndote para completar.');

    // Si quedan pocos puntos, esta vista pasa a ser la nueva referencia (con su pose conocida respecto de K0)
    if (tracker.nAlive < 0.5 * tracker.N0) {
      const lam = acc.scale, R = res.R, t = res.t;
      const Rt0 = [R[0] * t0[0] + R[1] * t0[1] + R[2] * t0[2], R[3] * t0[0] + R[4] * t0[1] + R[5] * t0[2], R[6] * t0[0] + R[7] * t0[1] + R[8] * t0[2]];
      const R0n = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R0n.push(R[3 * i] * R0[j] + R[3 * i + 1] * R0[3 + j] + R[3 * i + 2] * R0[6 + j]);
      const n = tracker.setReference(img, null);
      if (n >= 30) {
        R0 = R0n;
        t0 = [Rt0[0] + lam * t[0], Rt0[1] + lam * t[1], Rt0[2] + lam * t[2]];
        frame = 0;
      } else {
        lost = true;
        stat('Se perdió el seguimiento. Pulsa «Terminar» para quedarte con lo capturado.');
      }
    }
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
  if (running) needRef = true;   // la focal cambia toda la geometría: captura nueva
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
  
