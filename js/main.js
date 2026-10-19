// main.js — Conecta los módulos: cámara → seguimiento → pose → profundidad densa → fragmentos → visor.
// Todo el cálculo es propio (sin librerías externas). Los cálculos pesados van en segundo plano (worker.js)
// para que el seguimiento de la cámara nunca se detenga.
// La captura SUMA siempre: cuando el seguimiento se corta, el tramo se guarda como fragmento y se sigue
// desde donde esté la cámara. Nada se descarta; los fragmentos se unirán después (etapa 2).

import { Camera } from './camera.js';
import { Tracker, VERSION as TRACKER_VERSION } from './tracker.js';
import { reconstructTwoView, VERSION as GEOMETRY_VERSION } from './geometry.js';
import { denseDepth, depthToCloud, Accumulator, VERSION as DENSE_VERSION } from './dense.js';
import { Sensors } from './sensors.js';
import { Viewer } from './viewer.js';
import { exportJSON } from './export.js';
import { Assist, VERSION as ASSIST_VERSION } from './assist.js';
import { FragmentStore, VERSION as FRAGMENTS_VERSION } from './fragments.js';

const $ = id => document.getElementById(id);

const cam = new Camera($('video'), document.createElement('canvas'));
const sensors = new Sensors();
const viewer = new Viewer($('view'));
const tracker = new Tracker();
const ov = $('ov'), octx = ov.getContext('2d');
const vidBox = ov.parentElement;
const assist = new Assist({ vidBox, controls: $('controls') });
const store = new FragmentStore();

const FACTOR = 2;          // la profundidad se calcula a la mitad de la resolución de trabajo
const GOAL = 0.85;         // cobertura con la que un tramo se da por completo (se guarda y empieza otro)…
const MIN_FUSIONS = 8;     // …siempre que ya tenga al menos estas mediciones
const MIN_FRAG_PTS = 150;  // puntos mínimos para guardar un tramo como fragmento

let running = false, needRef = true;
let cloud = [], poses = [], frame = 0, lastLaunch = 0;
let lastMsg = '';

// Tramo actual: se acumula en la vista de su primera referencia (K0)
let capture = 0;           // número de tramo (para descartar resultados de un tramo anterior)
let acc = null;            // acumulador de profundidad del tramo
let k0Image = null;        // imagen K0 del tramo
let R0 = [1, 0, 0, 0, 1, 0, 0, 0, 1], t0 = [0, 0, 0];   // pose de la referencia actual respecto de K0
let keyframes = [];        // vistas del tramo con pose conocida respecto de K0 (para unir fragmentos en la etapa 2)
let lost = false, finished = false;
let shown = 0;             // fragmento que se muestra al terminar
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
const APP_VERSION = '11';
const showErr = m => (window.showAppError ? window.showAppError(m) : stat(m));
$('title').textContent = 'Cámara de registro · v' + APP_VERSION;
$('help').textContent = 'La imagen 3D se arma con la profundidad de cada píxel. Un dedo gira, el pellizco (o la rueda del mouse) acerca y aleja. ' +
  'w = intensidad de cada punto (oscuro −1, claro +1); con peso 0 ves la imagen 3D normal.';
stat('Pulsa «Iniciar cámara» y muévete alrededor del objeto. Todo se suma: si el seguimiento se corta, lo capturado se guarda y se sigue desde donde estés. Termina con «Terminar».');
{
  // Versión que debe tener cada módulo
  const bad = [];
  if (TRACKER_VERSION !== '5') bad.push('js/tracker.js');
  if (GEOMETRY_VERSION !== '5') bad.push('js/geometry.js');
  if (DENSE_VERSION !== '8') bad.push('js/dense.js');
  if (ASSIST_VERSION !== '2') bad.push('js/assist.js');
  if (FRAGMENTS_VERSION !== '1') bad.push('js/fragments.js');
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
      // Lo capturado se guarda como fragmento (con su focal) y se sigue con la focal corregida
      cutFragment('Focal de tu cámara ajustada a ' + FOVS[best] + '°.');
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
    store.clear();
    acc = null;
    viewer.setCloud(cloud);
    updateBrowser();
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
$('bEnd').onclick = () => finish();
$('bNew').onclick = async () => {
  $('bNew').disabled = true;
  if (!(await startCamera())) $('bNew').disabled = false;
};

function setProgress(c) {
  const pct = Math.round(100 * c);
  $('progBar').style.width = Math.min(100, Math.round(100 * c / GOAL)) + '%';
  $('progTxt').textContent = 'Tramo actual: ' + pct + ' %' + (acc ? ' · ' + acc.fusions + ' mediciones' : '') +
    ' · Fragmentos guardados: ' + store.count + (store.count ? ' (' + store.points + ' puntos)' : '');
}

/* ---------- Fragmentos ---------- */
// Guarda el tramo actual como fragmento (si tiene datos suficientes). Nunca descarta un tramo con datos.
function closeFragment() {
  if (!acc || acc.fusions < 2) { acc = null; return null; }
  const dm = acc.depthMap(true, cleanBg);
  const frag = dm.count >= MIN_FRAG_PTS
    ? store.add({ dm, image: k0Image, keyframes, fusions: acc.fusions, coverage: acc.coverage() })
    : null;
  acc = null;
  updateBrowser();
  return frag;
}

// Corta el tramo: se guarda y la captura sigue desde donde esté la cámara
function cutFragment(reason) {
  const frag = closeFragment();
  needRef = true;
  job = null;
  stat((reason ? reason + ' ' : '') + (frag ? 'Fragmento ' + frag.id + ' guardado (' + frag.dm.count + ' puntos). ' : '') +
    'Sigue capturando desde aquí.');
  setProgress(0);
}

// Navegador de fragmentos (lo crea el código; index.html no cambia). Se usa al terminar.
const browser = document.createElement('div');
browser.className = 'row';
browser.hidden = true;
browser.innerHTML = '<button id="fPrev">◀</button><span id="fLbl"></span><button id="fNext">▶</button>';
$('controls').appendChild(browser);
function showFragment(i) {
  if (!store.count) return;
  shown = (i + store.count) % store.count;
  const out = store.cloud(shown);
  if (out) { cloud = out; viewer.setCloud(cloud); }
  const f = store.list[shown];
  $('fLbl').textContent = 'Fragmento ' + f.id + ' de ' + store.count + ' · ' + f.dm.count + ' puntos';
  octx.clearRect(0, 0, ov.width, ov.height);
  if (finished && f.image && f.image.width === ov.width) octx.putImageData(f.image, 0, 0);
}
function updateBrowser() { browser.hidden = !(finished && store.count > 1); }
$('fPrev').onclick = () => showFragment(shown - 1);
$('fNext').onclick = () => showFragment(shown + 1);

// Fin de la captura («Terminar»): se guarda el tramo en curso y se muestran los fragmentos
function finish() {
  if (finished) return;
  closeFragment();
  finished = true;
  running = false;
  job = null;
  cam.stop();
  $('bEnd').disabled = true;
  $('bNew').disabled = false;
  $('bRoi').disabled = true;
  setMarking(false);
  assist.done(null);
  assist.map.hidden = true;   // el mapa de cobertura es del tramo en curso: al terminar ya no aplica
  setProgress(0);
  updateBrowser();
  if (!store.count) { stat('Captura terminada sin datos suficientes. Pulsa «Nueva captura» y muévete más lento, con buena luz.'); return; }
  // Se muestra el fragmento más grande
  let big = 0;
  store.list.forEach((f, i) => { if (f.dm.count > store.list[big].dm.count) big = i; });
  showFragment(big);
  stat('Captura terminada: ' + store.count + ' fragmento' + (store.count > 1 ? 's' : '') + ' con ' + store.points +
    ' puntos en total. ' + (store.count > 1 ? 'Recórrelos con ◀ ▶. Unirlos en un solo modelo es la etapa 2.' : 'Gíralo en el visor.'));
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
    cutFragment('Objeto marcado.');   // lo capturado se guarda; el tramo nuevo se enfoca en el objeto
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
  if (running) cutFragment('Recuadro borrado: se usa toda la imagen.');
};
$('bClean').onclick = () => {
  cleanBg = !cleanBg;
  $('bClean').classList.toggle('on', cleanBg);
  $('bClean').textContent = 'Limpiar fondo: ' + (cleanBg ? 'sí' : 'no');
  if (running) cutFragment('Limpiar fondo: ' + (cleanBg ? 'sí' : 'no') + '.');
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
  keyframes = [{ img, R: R0.slice(), t: t0.slice() }];
  lost = false;
  assist.reset();
  rejects = 0;
  poseFails = 0;
  setProgress(0);
  if (!store.count) stat('Capturando: muévete lentamente de lado alrededor del objeto.');
  return true;
}

function step() {
  if (finished) return;
  cam.grab();
  if (marking) { drawOverlay(); return; }
  const img = cam.ctx.getImageData(0, 0, cam.width, cam.height);
  stepCapture(img);
  // Asistente de la toma: mapa de cobertura, indicaciones y barra de detección
  if (!finished) assist.update({ img, tracker, acc, lost: false, capturing: !needRef && !!acc, roi, ghost: null });
}

function stepCapture(img) {
  if (needRef) {
    if (startCapture(img)) needRef = false;
    drawOverlay();
    return;
  }

  const s = tracker.track(img);
  frame++;
  if (s.nAlive < 30) {
    cutFragment('Seguimiento cortado.');
    drawOverlay();
    return;
  } else if (s.parallax < 12) {
    if (!acc.fusions) stat('Muévete de lado para ver el objeto desde otro ángulo (' + s.parallax.toFixed(0) + ' px).');
  } else {
    if (s.parallax >= 18) calibrateFocal();
    if (!job && performance.now() - lastLaunch > 700) launch(img);
  }
  drawOverlay();
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
      cutFragment('Seguimiento cortado.');
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
    if (tracker.setReference(img, null) < 30) { j.rekey = false; cutFragment('Seguimiento cortado.'); return; }
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
    // Vistas clave del tramo (con pose conocida): sirven para unir fragmentos en la etapa 2
    if (acc.fusions % 2 === 0 && keyframes.length < 8) keyframes.push({ img: j.img, R: Rc, t: tc });
    if (j.rekey) { R0 = Rc; t0 = tc; frame = 0; }
  } else if (j.rekey) {
    // Se cambió de referencia pero no se pudo ubicar: el tramo se guarda y se sigue desde aquí
    cutFragment('Seguimiento cortado.');
    return;
  }
  if (!ok) {
    if (!acc.fusions) { stat('Aún no hay suficiente detalle. Muévete un poco más de lado.'); return; }
    // Varias mediciones seguidas que no coinciden con el tramo: se guarda y se sigue con un tramo nuevo
    if (++rejects >= 4) { rejects = 0; cutFragment('Las vistas dejaron de coincidir.'); }
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
  // Tramo completo: se guarda y se sigue sumando zonas nuevas
  if (c >= GOAL && acc.fusions >= MIN_FUSIONS) { cutFragment('Tramo completo.'); return; }
  stat('Capturando: sigue moviéndote alrededor del objeto.' + (store.count ? ' Fragmentos guardados: ' + store.count + '.' : ''));
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
  focal.done = true;   // el usuario eligió la focal a mano
  try { localStorage.setItem('camara4d_fov', $('fov').value); } catch (e) { /* nada */ }
  if (running) cutFragment('Focal cambiada.');   // lo capturado se guarda con su focal; se sigue con la nueva
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
  size: { w: cam.width, h: cam.height },
  extra: { fragmentos: store.toJSON() }
});

setProgress(0);

// Señal para el panel de errores: el programa arrancó.
window.APP_READY = true;
