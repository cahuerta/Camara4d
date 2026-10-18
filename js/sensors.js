// sensors.js — Acelerómetro y giroscopio del teléfono. Guarda las muestras con su tiempo
// para calcular después la escala absoluta con la gravedad (g ≈ 9,81 m/s²).

export class Sensors {
  constructor(maxSamples = 60000) {
    this.maxSamples = maxSamples;
    this.samples = [];   // [t_ms, ax, ay, az (con gravedad, m/s²), alpha, beta, gamma (°/s)]
    this.gMag = 0;       // módulo promedio de la aceleración (debería rondar 9,8 en reposo)
    this.enabled = false;
    this._onMotion = this._onMotion.bind(this);
  }

  async enable() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
        const r = await DeviceMotionEvent.requestPermission();   // iOS: debe venir de un toque del usuario
        if (r !== 'granted') return false;
      }
      window.addEventListener('devicemotion', this._onMotion);
      this.enabled = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  _onMotion(e) {
    const a = e.accelerationIncludingGravity, g = e.rotationRate;
    if (!a || a.x == null) return;
    if (this.samples.length < this.maxSamples) {
      this.samples.push([Math.round(performance.now()), a.x, a.y, a.z, g ? g.alpha : null, g ? g.beta : null, g ? g.gamma : null]);
    }
    const m = Math.hypot(a.x, a.y, a.z);
    this.gMag = this.gMag ? this.gMag * 0.98 + m * 0.02 : m;
  }

  clear() { this.samples = []; }
}
