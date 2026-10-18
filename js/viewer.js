// viewer.js — Visor de la nube 4D: (x,y,z,w) con rotaciones en los 6 planos y proyección 4D→3D→2D.
// Un dedo gira, el pellizco (o la rueda del mouse) acerca y aleja.

export class Viewer {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.ang = { xy: 0, xz: -0.4, yz: 0.25, xw: 0, yw: 0, zw: 0 };
    this.mode = '3d';
    this.auto = false;
    this.zoom = 1;
    this.wScale = 1;
    this.cloud = [];
    this._ptr = new Map();
    this._pinch = 0;
    this._last = performance.now();
    this._bind();
    window.addEventListener('resize', () => this.fit());
    this.fit();
    requestAnimationFrame(t => this._render(t));
  }

  setCloud(c) { this.cloud = c || []; }
  setWScale(v) { this.wScale = v; }
  setMode(m) { this.mode = m; }
  setAuto(a) { this.auto = a; }
  zoomBy(k) { this.zoom = Math.min(8, Math.max(0.25, this.zoom * k)); }
  resetView() {
    this.zoom = 1;
    this.ang = { xy: 0, xz: -0.4, yz: 0.25, xw: 0, yw: 0, zw: 0 };
  }

  fit() {
    const r = this.c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, r.width * d);
    this.c.height = Math.max(1, r.height * d);
  }

  _bind() {
    const c = this.c;
    c.addEventListener('pointerdown', e => {
      this._ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (this._ptr.size === 2) this._pinch = this._pinchDist();
    });
    const up = e => { this._ptr.delete(e.pointerId); this._pinch = 0; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointermove', e => {
      const prev = this._ptr.get(e.pointerId);
      if (!prev) return;
      const dx = (e.clientX - prev.x) * 0.01, dy = (e.clientY - prev.y) * 0.01;
      this._ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._ptr.size === 1) {
        if (this.mode === '3d') { this.ang.xz += dx; this.ang.yz += dy; }
        else { this.ang.xw += dx; this.ang.yw += dy; }
      } else if (this._ptr.size === 2) {
        const d = this._pinchDist();
        if (this._pinch > 0 && d > 0) this.zoomBy(d / this._pinch);
        this._pinch = d;
      }
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.001));
    }, { passive: false });
  }

  _pinchDist() {
    const p = [...this._ptr.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }

  _rot(p, i, j, t) {
    const c = Math.cos(t), s = Math.sin(t), a = p[i], b = p[j];
    p[i] = c * a - s * b;
    p[j] = s * a + c * b;
  }

  _xform(p) {
    const a = this.ang;
    this._rot(p, 0, 2, a.xz); this._rot(p, 1, 2, a.yz); this._rot(p, 0, 1, a.xy);
    this._rot(p, 0, 3, a.xw); this._rot(p, 1, 3, a.yw); this._rot(p, 2, 3, a.zw);
    return p;
  }

  // 4D → 3D (perspectiva por w) → 2D (perspectiva por z)
  _proj(p) {
    const D4 = 6, D3 = 8;
    const k4 = D4 / Math.max(0.5, D4 - p[3] * this.wScale);
    const x = p[0] * k4, y = p[1] * k4, z = p[2] * k4;
    const k3 = D3 / Math.max(0.5, D3 - z);
    return [x * k3, -y * k3, z, k3];
  }

  _render(now) {
    const dt = (now - this._last) / 1000;
    this._last = now;
    if (this.auto) { this.ang.xw += 0.4 * dt; this.ang.zw += 0.25 * dt; this.ang.xy += 0.1 * dt; }

    const ctx = this.ctx, W = this.c.width, H = this.c.height, d = window.devicePixelRatio || 1;
    const sc = Math.min(W, H) * 0.17 * this.zoom;
    ctx.clearRect(0, 0, W, H);

    // Ejes: X rojo, Y verde, Z azul, W blanco
    const axes = [[1, 0, 0, 0, '#ff5d5d'], [0, 1, 0, 0, '#5dff7a'], [0, 0, 1, 0, '#5d9bff'], [0, 0, 0, 1, '#ffffff']];
    const o = this._proj([0, 0, 0, 0]);
    ctx.lineWidth = 2 * d;
    ctx.globalAlpha = 0.7;
    for (const a of axes) {
      const wsc = Math.max(this.wScale, 0.0001);
      const p = this._xform([a[0] * 1.6, a[1] * 1.6, a[2] * 1.6, a[3] * 1.6 / wsc]);
      const q = this._proj(p);
      ctx.strokeStyle = a[4];
      ctx.beginPath();
      ctx.moveTo(W / 2 + o[0] * sc, H / 2 + o[1] * sc);
      ctx.lineTo(W / 2 + q[0] * sc, H / 2 + q[1] * sc);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!this.cloud.length) {
      ctx.fillStyle = '#8b93a7';
      ctx.font = (14 * d) + 'px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('La nube aparecerá aquí', W / 2, H - 16 * d);
    } else {
      const arr = this.cloud.map(c => ({ q: this._proj(this._xform([c[0], c[1], c[2], c[3]])), c }));
      arr.sort((a, b) => a.q[2] - b.q[2]);
      for (const it of arr) {
        const s = Math.max(1.5, 3 * it.q[3]) * d;
        ctx.fillStyle = 'rgb(' + it.c[4] + ',' + it.c[5] + ',' + it.c[6] + ')';
        ctx.fillRect(W / 2 + it.q[0] * sc - s / 2, H / 2 + it.q[1] * sc - s / 2, s, s);
      }
    }
    requestAnimationFrame(t => this._render(t));
  }
}
