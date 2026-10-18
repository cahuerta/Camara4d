// camera.js — Cámara de registro: abre la cámara trasera y entrega fotogramas a resolución de trabajo.
// No sabe nada de seguimiento ni de geometría.

export class Camera {
  constructor(video, procCanvas, procWidth = 480) {
    this.video = video;
    this.canvas = procCanvas;
    this.ctx = procCanvas.getContext('2d', { willReadFrequently: true });
    this.procWidth = procWidth;
    this.width = procWidth;
    this.height = Math.round(procWidth * 0.75);
    this.stream = null;
    this.zoomLocked = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    // play() puede quedar pendiente al reiniciar la cámara en algunos navegadores: no se espera su respuesta
    const p = this.video.play();
    if (p && p.catch) p.catch(() => {});
    // Espera a que el video tenga tamaño revisando periódicamente (no depende de un aviso que
    // puede haber llegado antes): así funciona también al reiniciar la cámara.
    const t0 = performance.now();
    while (!this.video.videoWidth) {
      if (performance.now() - t0 > 8000) throw new Error('la cámara no entregó imagen');
      await new Promise(r => setTimeout(r, 50));
    }
    this.width = this.procWidth;
    this.height = Math.round(this.procWidth * this.video.videoHeight / this.video.videoWidth);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    await this._lockZoom();
  }

  // El zoom óptico/digital del teléfono cambia la focal y estropea la geometría: se intenta dejar en el mínimo.
  async _lockZoom() {
    try {
      const track = this.stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.zoom) {
        await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] });
        this.zoomLocked = true;
      }
    } catch (e) { /* no todos los navegadores lo permiten */ }
  }

  // Dibuja el fotograma actual en el canvas de trabajo y lo devuelve.
  grab() {
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    return this.canvas;
  }

  // Focal en píxeles del canvas de trabajo, a partir del campo de visión del lado largo (grados).
  focalPx(fovDeg) {
    return (Math.max(this.width, this.height) / 2) / Math.tan(fovDeg * Math.PI / 360);
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;   // suelta la cámara del todo, para poder abrirla de nuevo
  }
}
