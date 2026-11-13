// red.js — Nuestra red neuronal: reconoce qué segmento del cuerpo ve la cámara (y de qué lado).
// La red se entrenó con imágenes generadas de los modelos 3D (hombre y mujer). Aquí se ejecuta con código propio,
// sin librerías: convoluciones simples sobre una imagen de 96 × 96.
// Pesos: img/red/red.json (estructura) + img/red/red.bin (números en float32).

export const VERSION = '1';

// Convolución normal (k × k) con relleno «same» y paso s. x en formato alto × ancho × canales.
function conv(x, H, W, C, w, b, k, s, F, relu) {
  const Ho = Math.ceil(H / s), Wo = Math.ceil(W / s);
  const pt = Math.floor(Math.max((Ho - 1) * s + k - H, 0) / 2), pl = Math.floor(Math.max((Wo - 1) * s + k - W, 0) / 2);
  const y = new Float32Array(Ho * Wo * F);
  for (let oy = 0; oy < Ho; oy++) for (let ox = 0; ox < Wo; ox++) {
    const o = (oy * Wo + ox) * F;
    for (let f = 0; f < F; f++) y[o + f] = b[f];
    for (let ky = 0; ky < k; ky++) {
      const iy = oy * s + ky - pt; if (iy < 0 || iy >= H) continue;
      for (let kx = 0; kx < k; kx++) {
        const ix = ox * s + kx - pl; if (ix < 0 || ix >= W) continue;
        const xi = (iy * W + ix) * C, wi = (ky * k + kx) * C * F;
        for (let c = 0; c < C; c++) {
          const v = x[xi + c]; if (v === 0) continue;
          const wc = wi + c * F;
          for (let f = 0; f < F; f++) y[o + f] += v * w[wc + f];
        }
      }
    }
    if (relu) for (let f = 0; f < F; f++) if (y[o + f] < 0) y[o + f] = 0;
  }
  return [y, Ho, Wo];
}
// Convolución por canal (3 × 3)
function dw(x, H, W, C, w, b, s) {
  const Ho = Math.ceil(H / s), Wo = Math.ceil(W / s);
  const pt = Math.floor(Math.max((Ho - 1) * s + 3 - H, 0) / 2), pl = Math.floor(Math.max((Wo - 1) * s + 3 - W, 0) / 2);
  const y = new Float32Array(Ho * Wo * C);
  for (let oy = 0; oy < Ho; oy++) for (let ox = 0; ox < Wo; ox++) {
    const o = (oy * Wo + ox) * C;
    for (let c = 0; c < C; c++) y[o + c] = b[c];
    for (let ky = 0; ky < 3; ky++) {
      const iy = oy * s + ky - pt; if (iy < 0 || iy >= H) continue;
      for (let kx = 0; kx < 3; kx++) {
        const ix = ox * s + kx - pl; if (ix < 0 || ix >= W) continue;
        const xi = (iy * W + ix) * C, wi = (ky * 3 + kx) * C;
        for (let c = 0; c < C; c++) y[o + c] += x[xi + c] * w[wi + c];
      }
    }
    for (let c = 0; c < C; c++) if (y[o + c] < 0) y[o + c] = 0;
  }
  return [y, Ho, Wo];
}

export class Red {
  constructor() { this.capas = null; this.nombres = []; this.N = 96; }
  async cargar(base) {
    const [info, buf] = await Promise.all([
      fetch(base + 'red.json').then(r => r.json()),
      fetch(base + 'red.bin').then(r => r.arrayBuffer())]);
    const f = new Float32Array(buf);
    this.capas = info.capas.map(c => ({ ...c, w: f.subarray(c.w[0], c.w[1]), b: f.subarray(c.b[0], c.b[1]) }));
    this.nombres = info.nombres; this.N = info.entrada;
    return this;
  }
  // img: ImageData de N × N. Devuelve las probabilidades de cada clase.
  predecir(img) {
    const N = this.N, d = img.data;
    let x = new Float32Array(N * N * 3), H = N, W = N, C = 3;
    for (let i = 0, j = 0; i < N * N; i++, j += 4) { x[i * 3] = d[j] / 255; x[i * 3 + 1] = d[j + 1] / 255; x[i * 3 + 2] = d[j + 2] / 255; }
    for (const c of this.capas) {
      if (c.tipo === 'conv') { [x, H, W] = conv(x, H, W, C, c.w, c.b, c.k, c.s, c.f, true); C = c.f; }
      else if (c.tipo === 'dw') { [x, H, W] = dw(x, H, W, C, c.w, c.b, c.s); }
      else if (c.tipo === 'pw') { [x, H, W] = conv(x, H, W, C, c.w, c.b, 1, 1, c.f, true); C = c.f; }
      else if (c.tipo === 'salida') {
        // Promedio de toda la imagen y capa final
        const g = new Float32Array(C);
        for (let p = 0; p < H * W; p++) for (let k = 0; k < C; k++) g[k] += x[p * C + k];
        for (let k = 0; k < C; k++) g[k] /= H * W;
        const z = new Float32Array(c.f);
        for (let o = 0; o < c.f; o++) { let s = c.b[o]; for (let k = 0; k < C; k++) s += g[k] * c.w[k * c.f + o]; z[o] = s; }
        const mx = Math.max(...z); let t = 0;
        for (let o = 0; o < c.f; o++) { z[o] = Math.exp(z[o] - mx); t += z[o]; }
        for (let o = 0; o < c.f; o++) z[o] /= t;
        return z;
      }
    }
  }
}
