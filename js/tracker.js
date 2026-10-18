// tracker.js — Seguimiento de puntos característicos con OpenCV.js (flujo óptico Lucas-Kanade).
// Mantiene la correspondencia entre los puntos del fotograma de referencia y los del fotograma actual.

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
let cvPromise = null;

export function loadOpenCV(timeoutMs = 90000) {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    let done = false;
    const finish = m => {
      if (done) return;
      done = true;
      // El Module de OpenCV.js es "thenable" (tiene .then). Resolver una Promise con él
      // provoca un bucle infinito que congela la página. Se le quita el .then antes.
      if (m && typeof m.then === 'function') {
        try { delete m.then; } catch (e) { /* nada */ }
        if (typeof m.then === 'function') m.then = undefined;
      }
      window.cv = m;
      resolve(m);
    };
    const fail = err => { if (!done) { done = true; reject(err); } };
    const t0 = Date.now();
    const check = () => {
      if (done) return;
      const c = window.cv;
      if (Date.now() - t0 > timeoutMs) { fail(new Error('OpenCV.js no terminó de cargar')); return; }
      if (!c) { setTimeout(check, 150); return; }
      if (c instanceof Promise) { c.then(finish, fail); return; }
      if (c.Mat) { finish(c); return; }
      c.onRuntimeInitialized = () => finish(c);
      setTimeout(check, 150);
    };
    const s = document.createElement('script');
    s.async = true;
    s.src = OPENCV_URL;
    s.onerror = () => fail(new Error('No se pudo cargar OpenCV.js'));
    document.head.appendChild(s);
    check();
  });
  return cvPromise;
}

export class Tracker {
  constructor(cv, { maxPoints = 500, minDist = 7 } = {}) {
    this.cv = cv;
    this.maxPoints = maxPoints;
    this.minDist = minDist;
    this.prevGray = null;
    this.reset();
  }

  reset() {
    this.tracking = false;
    this.N = 0;
    this.ref = new Float32Array(0);   // posiciones en la referencia [x0,y0,x1,y1,...]
    this.cur = new Float32Array(0);   // posiciones actuales
    this.alive = new Uint8Array(0);   // 1 si el punto sigue siendo seguido
    this.inl = new Uint8Array(0);     // 1 si fue inlier de la última reconstrucción
    this.col = [];                    // color [r,g,b] de cada punto en la referencia
    this.nAlive = 0;
    this.parallax = 0;
  }

  _gray(canvas) {
    const cv = this.cv;
    const rgba = cv.imread(canvas);
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();
    return gray;
  }

  _swap(gray) {
    if (this.prevGray) this.prevGray.delete();
    this.prevGray = gray;
  }

  // Fija el fotograma actual como referencia y detecta los puntos a seguir.
  setReference(canvas) {
    const cv = this.cv;
    const gray = this._gray(canvas);
    const corners = new cv.Mat();
    const mask = new cv.Mat();
    cv.goodFeaturesToTrack(gray, corners, this.maxPoints, 0.01, this.minDist, mask, 7);
    mask.delete();

    this.N = corners.rows;
    this.ref = new Float32Array(this.N * 2);
    this.ref.set(corners.data32F.subarray(0, this.N * 2));
    corners.delete();
    this.cur = this.ref.slice();
    this.alive = new Uint8Array(this.N).fill(1);
    this.inl = new Uint8Array(this.N);

    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    this.col = [];
    for (let i = 0; i < this.N; i++) {
      const x = Math.min(w - 1, Math.max(0, Math.round(this.ref[2 * i])));
      const y = Math.min(h - 1, Math.max(0, Math.round(this.ref[2 * i + 1])));
      const o = (y * w + x) * 4;
      this.col.push([d[o], d[o + 1], d[o + 2]]);
    }
    this.nAlive = this.N;
    this.parallax = 0;
    this.tracking = true;
    this._swap(gray);
    return this.N;
  }

  aliveIds() {
    const ids = [];
    for (let i = 0; i < this.N; i++) if (this.alive[i]) ids.push(i);
    return ids;
  }

  // Sigue los puntos vivos del fotograma anterior al actual. Devuelve {nAlive, parallax} (paralaje mediano en px).
  track(canvas) {
    if (!this.tracking) return null;
    const cv = this.cv;
    const gray = this._gray(canvas);
    try {
      const ids = this.aliveIds();
      if (ids.length < 8) { this.nAlive = ids.length; return { nAlive: ids.length, parallax: this.parallax }; }

      const flat = new Array(ids.length * 2);
      ids.forEach((id, k) => { flat[2 * k] = this.cur[2 * id]; flat[2 * k + 1] = this.cur[2 * id + 1]; });
      const p0 = cv.matFromArray(ids.length, 1, cv.CV_32FC2, flat);
      const p1 = new cv.Mat(), st = new cv.Mat(), er = new cv.Mat();
      cv.calcOpticalFlowPyrLK(this.prevGray, gray, p0, p1, st, er, new cv.Size(21, 21), 3,
        new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01));
      const q = p1.data32F;
      const w = canvas.width, h = canvas.height;
      ids.forEach((id, k) => {
        const x = q[2 * k], y = q[2 * k + 1];
        if (st.data[k] === 1 && x >= 0 && y >= 0 && x < w && y < h) {
          this.cur[2 * id] = x; this.cur[2 * id + 1] = y;
        } else {
          this.alive[id] = 0;
        }
      });
      p0.delete(); p1.delete(); st.delete(); er.delete();

      const dist = [];
      for (let i = 0; i < this.N; i++) {
        if (this.alive[i]) dist.push(Math.hypot(this.cur[2 * i] - this.ref[2 * i], this.cur[2 * i + 1] - this.ref[2 * i + 1]));
      }
      dist.sort((a, b) => a - b);
      this.nAlive = dist.length;
      this.parallax = dist.length ? dist[dist.length >> 1] : 0;
      return { nAlive: this.nAlive, parallax: this.parallax };
    } finally {
      this._swap(gray);
    }
  }

  dispose() {
    if (this.prevGray) { this.prevGray.delete(); this.prevGray = null; }
  }
}
