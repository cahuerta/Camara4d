// main.js — Conecta los módulos: cámara → seguimiento → pose → profundidad densa → modelo acumulado → visor.
// Todo el cálculo es propio (sin librerías externas). Los cálculos pesados van en segundo plano (worker.js)
// para que el seguimiento de la cámara nunca se detenga.

import { Camera } from './camera.js';
import { Tracker, VERSION as TRACKER_VERSION } from './tracker.js';
import { reconstructTwoView, VERSION as GEOMETRY_VERSION } from './geometry.js';
import { denseDepth, depthToCloud, Accumulator, VERSION as DENSE_VERSION } from './dense.js';
import { Sensors } from './sensors.js';
import { Viewer } from './viewer.js';
import { exportJSON } from './export.js';
import { Assist, VERSION as ASSIST_VERSION } from './assist.js';

const $ = id => document.getElementById(id);

const cam = new Camera($('video'), document.createElement('canvas'));
const sensors = new Sensors();
const viewer = new Viewer($('view'));
const tracker = new Tracker();
const ov = $('ov'), octx = ov.getContext('2d');
const vidBox = ov.parentElement;
const assist = new Assist({ vidBox, controls: $('controls') });

const FACTOR = 2;          // la profundidad se calcula a la mitad de la resolución de trabajo
const GOAL = 0.85;         // cobertura con la que la captura termina sola…
const MIN_FUSIONS = 8;     // …siempre que ya tenga al menos estas mediciones
const LOW_COVERAGE = 0.3;  // bajo esto, «Terminar» pide confirmación

let running = false, needRef = true;
let cloud = [], poses = [], frame = 0, lastLaunch = 0;
let lastMsg = '';

// Captura: todo se acumula en la vista de la primera referencia (K0)
let capture = 0;           // número de captura (para descartar resultados de una captura anterior)
let acc = null;            // acumulador de profundidad
let k0Image = null;        // imagen de K0 (se muestra al terminar)
let R0 = [1, 0, 0, 0, 1, 0, 0, 0, 1], t0 = [0, 0, 0];   // pose de la referencia actual respecto de K0
let lastGood = null;       // última vista con pose conocida respecto de K0 (para recuperar el seguimiento)
let lost = false, finished = false, endArmedUntil = 0;
let job = null;            // cálculo de profundidad en curso
let rejects = 0;           // mediciones rechazadas seguidas (no coincidían con el modelo)
let poseFails = 0;         // intentos seguidos sin pose válida

// Recuadro del objeto (en píxeles del canvas de trabajo) y limpieza de fondo
let roi = null;
let roiDraft = null;
let marking = false;
let dragStart = null;
let cleanBg = true;

const stat = m => { if (m !== lastMsg) { $('status').textContent = m; lastMsg = m; } };

/* ---------- Versión y textos de la página ---------- */
// index.html es fijo: la versión, los textos y los controles nuevos los pone este archivo.
const APP_VERSION = '10';
const showErr = m => (window.showAppError ? window.showAppError(m) : stat(m));
$('title').textContent = 'Cámara de registro · v' + APP_VERSION;
$('help').textContent = 'La imagen 3D se arma con la profundidad de cada píxel. Un dedo gira, el pellizco (o la rueda del mouse) acerca y aleja. ' +
  'w = intensidad de cada punto (oscuro −1, claro +1); con peso 0 ves la imagen 3D normal.';
stat('Pulsa «Iniciar cámara» y muévete lentamente alrededor del objeto. Todo se va sumando; la captura termina sola al llegar a la meta, o con «Terminar».');
{
  // Versión que debe tener cada módulo
  const bad = [];
  if (TRACKER_VERSION !== '5') bad.push('js/tracker.js');
  if (GEOMETRY_VERSION !== '5') bad.push('js/geometry.js');
  if (DENSE_VERSION !== '8') bad.push('js/dense.js');
  if (ASSIST_VERSION !== '2') bad.push('js/assist.js');
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
    pending.clear();
    job = null;
    focal.busy = false;
  };
} catch (e) { worker = null; }

// Envía un cálculo al proceso en segundo plano (o lo hace aquí mismo si no hay)
function runJob(msg, transfer, cb) {
  if (worker) {
    msg.id = ++jobSeq;
    pending.set(msg.id, cb);
    worker.postMessage(msg, transfer);
    return;
  }
  if (msg.type === 'dense') {
    const dm = denseDepth(msg.ref, msg.cur, msg.R, msg.t, msg.f, msg.cx, msg.cy, msg.range, msg.opts);
    cb({ dm });
  } else cb({ errs: null });
}

/* ---------- Focal automática ---------- */
// Se prueba una serie de campos de visión y se elige el que mejor explica el movimiento (menor error).
// Entre focales cercanas la diferencia de error es mínima, así que solo se corrige si la focal actual está
// claramente equivocada (mejora de más del 25 %). Se recuerda en el teléfono para la próxima vez.
const FOVS = [50, 55, 60, 65, 70, 75, 80, 85];
let focal = { done: false, best: new Array(FOVS.length).fill(Infinity), n: 0, busy: false };
try {
  const saved = parseFloat(localStorage.getItem('camara4d_fov'));
  if (saved >= 35 && saved <= 120) { $('fov').value = saved; $('fovV').textContent = saved; focal.done = true; }
} catch (e) { /* sin almacenamiento */ }

function calibrateFocal() {
  if (focal.done || focal.busy || !worker) return;
  const ids = tracker.aliveIds();
  if (ids.length < 40) return;
  const p1 = new Float32Array(ids.length * 2), p2 = new Float32Array(ids.length * 2);
  ids.forEach((id, k) => { p1[2 * k] = tracker.ref[2 * id]; p1[2 * k + 1] = tracker.ref[2 * id + 1]; p2[2 * k] = tracker.cur[2 * id]; p2[2 * k + 1] = tracker.cur[2 * id + 1]; });
  focal.busy = true;
  const cap = capture;
  runJob({ type: 'focal', fovs: FOVS, n: ids.length, p1, p2, long: Math.max(cam.width, cam.height), cx: cam.width / 2, cy: cam.height / 2 }, [p1.buffer, p2.buffer], r => {
    focal.busy = false;
    if (!r.errs || cap !== capture || focal.done) return;
    if (r.errs.every(e => !isFinite(e))) return;
    // A veces el cálculo de la pose cae en una solución equivocada y da un error alto al azar:
    // por eso se guarda el mejor error de cada focal entre las muestras, no la suma
    r.errs.forEach((e, i) => { if (e < focal.best[i]) focal.best[i] = e; });
    if (++focal.n < 4) return;
    focal.done = true;
    let best = 0;
    for (let i = 1; i < FOVS.length; i++) if (focal.best[i] < focal.best[best]) best = i;
    const curFov = parseFloat($('fov').value);
    let curIdx = 0;
    for (let i = 1; i < FOVS.length; i++) if (Math.abs(FOVS[i] - curFov) < Math.abs(FOVS[curIdx] - curFov)) curIdx = i;
    if (best !== curIdx && focal.best[best] < 0.75 * focal.best[curIdx]) {
      $('fov').value = FOVS[best];
      $('fovV').textContent = FOVS[best];
      try { localStorage.setItem('camara4d_fov', String(FOVS[best])); } catch (e) { /* nada */ }
      needRef = true;   // la geometría cambia: se empieza de nuevo con la focal correcta
      stat('Focal de tu cámara ajustada a ' + FOVS[best] + '°. Empezando de nuevo: muévete lentamente.');
    } else {
      try { localStorage.setItem('camara4d_fov', String(curFov)); } catch (e) { /* nada */ }
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
$('bEnd').onclick = () => {
  // Con poca cobertura se pide confirmar (segundo toque), para no terminar con un modelo pobre por error
  const c = acc ? acc.coverage() : 0;
  if (c < LOW_COVERAGE && performance.now() > endArmedUntil) {
    endArmedUntil = performance.now() + 5000;
    stat('Cobertura baja (' + Math.round(100 * c) + ' %): el modelo saldrá incompleto. Sigue capturando, o toca «Terminar» otra vez para terminar igual.');
    return;
  }
  finish(false);
};
$('bNew').onclick = async () => {
  $('bNew').disabled = true;
  if (!(await startCamera())) $('bNew').disabled = false;
};

function setProgress(c) {
  const pct = Math.round(100 * c);
  $('progBar').style.width = Math.min(100, Math.round(100 * c / GOAL)) + '%';
  $('progTxt').textContent = 'Cobertura ' + pct + ' % (meta ' + Math.round(100 * GOAL) + ' %)' + (acc ? ' · ' + acc.fusions + ' mediciones' : '');
}

// Fin de la captura (automático al llegar a la meta, o con «Terminar»)
function finish(auto) {
  if (finished) return;
  finished = true;
  running = false;
  job = null;
  cam.stop();
  $('bEnd').disabled = true;
  $('bNew').disabled = false;
  $('bRoi').disabled = true;
  setMarking(false);
  assist.done(acc);
  // Muestra la imagen de partida en lugar del video detenido
  octx.clearRect(0, 0, ov.width, ov.height);
  if (k0Image) octx.putImageData(k0Image, 0, 0);
  if (!acc || acc.fusions < 2) { stat('Captura terminada sin datos suficientes. Pulsa «Nueva captura».'); return; }
  const dm = acc.depthMap(true, cleanBg);
  const out = depthToCloud(dm);
  if (out) { cloud = out; viewer.setCloud(cloud); }
  else { stat('Captura terminada, pero casi nada quedó confirmado. Prueba con más luz, más textura y más tiempo.'); return; }
  stat((auto ? 'Listo: se alcanzó la meta. ' : 'Captura terminada. ') + 'Modelo final con ' + dm.count +
    ' píxeles confirmados (cobertura ' + Math.round(100 * acc.coverage()) + ' %). Gíralo en el visor.');
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
  if (running) needRef = true;   // captura nueva con el nuevo criterio
};

/* ---------- Bucle ---------- */
function loop() {
  if (!running) return;
  const t0 = performance.now();
  try { step(); } catch (e) { showErr('Error: ' + e.message); }
  setTimeout(loop, Math.max(15, 66 - (performance.now() - t0)));
}

// Empieza una captura nueva: esta imagen pasa a ser K0
function startCapture(img) {
  const n = tracker.setReference(img, roi);
  frame = 0;
  if (n < 30) {
    stat('Pocos detalles en la imagen (' + n + ' puntos). Apunta a un objeto con más textura o más luz.');
    return false;
  }
  capture++;
  job = null;
  acc = new Accumulator(img, FACTOR, { roi });
  k0Image = img;
  R0 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  t0 = [0, 0, 0];
  lastGood = { img, R: R0.slice(), t: t0.slice() };
  lost = false;
  assist.reset();
  rejects = 0;
  poseFails = 0;
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
  stepCapture(img);
  // Asistente de la toma: mapa de cobertura, indicaciones y barra de detección
  if (!finished) assist.update({ img, tracker, acc, lost, capturing: !needRef && !!acc, roi, ghost: lastGood ? lastGood.img : null });
}

function stepCapture(img) {
  if (needRef) {
    if (startCapture(img)) needRef = false;
    drawOverlay();
    return;
  }

  if (lost) {
    // Sin modelo todavía: se vuelve a empezar solo. Con modelo: se intenta retomar desde la última vista buena.
    if (!acc.fusions) { needRef = true; return; }
    frame++;
    if (frame % 3 === 0 && !job) tryRecover(img);
    drawOverlay();
    return;
  }

  const s = tracker.track(img);
  frame++;
  if (s.nAlive < 30) {
    lost = true;
    frame = 0;
    if (acc.fusions) stat('Se perdió el seguimiento: vuelve lentamente hacia donde estabas; se retoma solo. Lo capturado se conserva.');
    else stat('Se perdió el seguimiento: empezando de nuevo. Muévete más lento.');
  } else if (s.parallax < 12) {
    if (!acc.fusions) stat('Muévete de lado para ver el objeto desde otro ángulo (' + s.parallax.toFixed(0) + ' px).');
  } else {
    if (s.parallax >= 18) calibrateFocal();
    if (!job && performance.now() - lastLaunch > 700) launch(img);
  }
  drawOverlay();
}

// Recuperar el seguimiento: se compara la imagen actual con la última vista buena (de pose conocida)
function tryRecover(img) {
  const n = tracker.setReference(lastGood.img, null);
  if (n < 30) return;
  const s = tracker.track(img);
  if (s && s.nAlive >= Math.max(30, 0.4 * tracker.N0)) {
    R0 = lastGood.R.slice();
    t0 = lastGood.t.slice();
    lost = false;
    frame = 0;
    stat('Seguimiento recuperado: sigue moviéndote lentamente.');
  } else {
    stat('Se perdió el seguimiento: vuelve lentamente hacia donde estabas; se retoma solo. Lo capturado se conserva.');
  }
}

/* ---------- Reconstrucción: pose → profundidad de cada píxel (en segundo plano) → se suma al modelo ---------- */
function launch(img) {
  const fov = parseFloat($('fov').value);
  const f = cam.focalPx(fov), cx = cam.width / 2, cy = cam.height / 2;
  const ids = tracker.aliveIds();
  const res = reconstructTwoView(tracker.ref, tracker.cur, ids, f, cx, cy);
  lastLaunch = performance.now();
  // Sin pose válida (o que explica menos de la mitad de los puntos: movimiento brusco) no se mide.
  // Si pasa varias veces seguidas, los puntos seguidos ya no sirven: se trata como seguimiento perdido.
  if (!res || res.pts.length < 20 || res.pts.length < 0.5 * ids.length) {
    if (++poseFails >= 3) {
      poseFails = 0;
      lost = true;
      frame = 0;
      stat(acc.fusions ? 'Se perdió el seguimiento: vuelve lentamente hacia donde estabas; se retoma solo.' : 'Se perdió el seguimiento: empezando de nuevo. Muévete más lento.');
    } else stat(res && res.pts.length >= 20 ? 'Movimiento muy brusco: muévete más lento.' : 'Calculando posición de la cámara… sigue moviéndote lentamente.');
    return;
  }
  poseFails = 0;

  tracker.inl.fill(0);
  for (const p of res.pts) tracker.inl[p.id] = 1;

  // Rango de profundidades a partir de los puntos triangulados
  const ds = res.pts.map(p => -p.P[2]).sort((a, b) => a - b);
  const range = [ds[Math.floor(ds.length * 0.05)], ds[Math.floor(ds.length * 0.95)]];

  // El recuadro solo vale mientras la referencia sea K0 (la imagen donde se marcó)
  const atK0 = t0[0] === 0 && t0[1] === 0 && t0[2] === 0;
  const refImg = tracker.refImage;
  const j = {
    capture, img, R: res.R, t: res.t, R0: R0.slice(), t0: t0.slice(), f, cx, cy, pts: res.pts.length,
    // Si quedan pocos puntos, esta vista pasa a ser la nueva referencia; su pose respecto de K0
    // se completa cuando llegue el resultado (hace falta la escala)
    rekey: tracker.nAlive < 0.6 * tracker.N0
  };
  job = j;
  if (j.rekey) {
    if (tracker.setReference(img, null) < 30) { j.rekey = false; lost = true; }
  }
  const copy = im => ({ data: new Uint8ClampedArray(im.data), width: im.width, height: im.height });
  const ref = copy(refImg), cur = copy(img);
  runJob({ type: 'dense', ref, cur, R: res.R, t: res.t, f, cx, cy, range, opts: { factor: FACTOR, roi: atK0 ? roi : null, clean: cleanBg } },
    [ref.data.buffer, cur.data.buffer], r => onDense(j, r));
}

function onDense(j, r) {
  if (job === j) job = null;
  if (finished || j.capture !== capture) return;   // resultado de una captura anterior
  if (r.error || !r.dm) { showErr('Cálculo de profundidad: ' + (r.error || 'sin resultado')); return; }
  acc.setIntrinsics(j.f, j.cx, j.cy);
  const ok = acc.fuse(r.dm, j.R0, j.t0);
  if (ok) {
    // Pose de esta vista respecto de K0: R·R0 y R·t0 + escala·t
    const lam = acc.scale, R = j.R, t = j.t;
    const Rc = [];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) Rc.push(R[3 * a] * j.R0[b] + R[3 * a + 1] * j.R0[3 + b] + R[3 * a + 2] * j.R0[6 + b]);
    const tc = [0, 1, 2].map(a => R[3 * a] * j.t0[0] + R[3 * a + 1] * j.t0[1] + R[3 * a + 2] * j.t0[2] + lam * t[a]);
    lastGood = { img: j.img, R: Rc, t: tc };
    if (j.rekey) { R0 = Rc; t0 = tc; frame = 0; }
  } else if (j.rekey) {
    // Se cambió de referencia pero no se pudo ubicar: se recupera desde la última vista buena
    lost = true;
  }
  if (!ok) {
    if (!acc.fusions) { stat('Aún no hay suficiente detalle. Muévete un poco más de lado.'); return; }
    // Varias mediciones seguidas que no coinciden: la base del modelo quedó mal (p. ej., un sacudón al comienzo)
    if (++rejects >= 4 && acc.fusions <= 3) {
      rejects = 0;
      needRef = true;
      stat('Las mediciones no coinciden entre sí: empezando de nuevo. Muévete lento y parejo.');
    }
    return;
  }
  rejects = 0;

  // Mostrar el modelo acumulado y la cobertura
  const out = depthToCloud(acc.depthMap(false, cleanBg));
  if (out) { cloud = out; viewer.setCloud(cloud); }
  const c = acc.coverage();
  setProgress(c);
  poses.push({ t: Math.round(performance.now()), R: j.R, tvec: j.t, escala: acc.scale, puntos: j.pts, pixeles: r.dm.count, ms: Math.round(r.dm.ms || 0) });
  if (poses.length > 3000) poses.shift();
  if (c >= GOAL && acc.fusions >= MIN_FUSIONS) { finish(true); return; }
  if (!lost) stat('Capturando: sigue moviéndote lentamente alrededor del objeto.');
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
  if (!tracker.tracking || marking || lost) return;
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
  focal.done = true;   // el usuario eligió la focal a mano
  try { localStorage.setItem('camara4d_fov', $('fov').value); } catch (e) { /* nada */ }
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
// Botón «Ver de frente» (lo crea el código; index.html no cambia)
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
  size: { w: cam.width, h: cam.height }
});

setProgress(0);

// Señal para el panel de errores: el programa arrancó.
window.APP_READY = true;
