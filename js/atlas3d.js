// atlas3d.js — Atlas anatómico 3D (huesos y músculos) puesto sobre el segmento que ve la cámara.
// · Datos: img/atlas3d/<segmento>.json + .bin (BodyParts3D © DBCLS, CC BY-SA 2.1 JP), lado derecho, en metros.
//   El lado izquierdo es el mismo modelo en espejo.
// · Posición: puntos 3D de MediaPipe (en metros) + puntos en la imagen. La escala sale del largo real
//   del segmento de cada persona (sin medir a mano).
// · Mano: cada falange se mueve con su dedo. Antebrazo, brazo, muslo, pierna y pie: un bloque rígido
//   con su giro (pronación, rotación de la pierna) sacado de la mano o del pie.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.module.js';

export const VERSION = '2';
const BASE = 'img/atlas3d/';

const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
const ESPEJO = new THREE.Matrix4().makeScale(-1, 1, 1);

// Base ortonormal: u a lo largo del eje a→b, v hacia la referencia r (sin la parte a lo largo de u)
function base(a, b, r) {
  const u = b.clone().sub(a).normalize();
  const v = r.clone().addScaledVector(u, -r.dot(u));
  if (v.lengthSq() < 1e-10) return null;
  v.normalize();
  const w = new THREE.Vector3().crossVectors(u, v);
  return new THREE.Matrix4().makeBasis(u, v, w);
}
// Matriz que lleva el punto «a» del atlas (en espejo si es el lado izquierdo) al punto «p» de la cámara,
// con giro R (de base del atlas a base de la cámara) y escala s
function colocar(p, R, s, a, izq) {
  const m = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
  m.multiply(R).multiply(new THREE.Matrix4().makeScale(s, s, s)).multiply(new THREE.Matrix4().makeTranslation(-a.x, -a.y, -a.z));
  if (izq) m.multiply(ESPEJO);
  return m;
}
const espejo = (p, izq) => (izq ? new THREE.Vector3(-p.x, p.y, p.z) : p.clone());

export class Atlas3D {
  constructor(lienzo) {
    this.lienzo = lienzo;
    this.r = new THREE.WebGLRenderer({ canvas: lienzo, alpha: true, antialias: true, preserveDrawingBuffer: false });
    this.r.setClearColor(0, 0);
    this.r.outputEncoding = THREE.sRGBEncoding;
    this.escena = new THREE.Scene();
    this.escena.add(new THREE.HemisphereLight(0xffffff, 0x404050, 0.7));
    const luz = new THREE.DirectionalLight(0xffffff, 0.8); luz.position.set(0.3, 0.6, 1); this.escena.add(luz);
    this.cam = new THREE.PerspectiveCamera(50, 1, 0.01, 20);
    this.segs = {};          // segmento → { grupo, mallas, info }
    this.capa = 'musculo';
    this.matHueso = new THREE.MeshStandardMaterial({ color: 0xeee4cc, roughness: 0.7 });
    this.matMus = new THREE.MeshStandardMaterial({ color: 0xb03a30, roughness: 0.55, transparent: true, opacity: 0.88 });
    this.ray = new THREE.Raycaster();
  }
  // La cámara del teléfono: distancia focal aproximada (≈ 63° en el lado largo)
  tamano(W, H) {
    this.W = W; this.H = H; this.f = 0.82 * Math.max(W, H);
    this.r.setSize(W, H, false);
    this.cam.aspect = W / H; this.cam.fov = 2 * Math.atan(H / 2 / this.f) * 180 / Math.PI; this.cam.updateProjectionMatrix();
  }
  async cargar(seg) {
    if (this.segs[seg]) return this.segs[seg];
    const [info, buf] = await Promise.all([fetch(BASE + seg + '.json').then(r => r.json()), fetch(BASE + seg + '.bin').then(r => r.arrayBuffer())]);
    const pos = new Float32Array(buf, 0, info.nPos), idx = new Uint16Array(buf, info.nPos * 4, info.nIdx);
    const grupo = new THREE.Group(); grupo.visible = false; this.escena.add(grupo);
    const piezas = {};
    const mallas = info.partes.map((p, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(p.v[0] * 3, (p.v[0] + p.v[1]) * 3), 3));
      g.setIndex(new THREE.BufferAttribute(idx.slice(p.f[0], p.f[0] + p.f[1]), 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, p.tipo === 'hueso' ? this.matHueso : this.matMus);
      m.matrixAutoUpdate = false; m.userData = { parte: i };
      if (p.tipo === 'hueso') m.renderOrder = 1; else m.renderOrder = 2;
      grupo.add(m);
      (piezas[p.pieza] = piezas[p.pieza] || []).push(m);
      return m;
    });
    const art = {}; for (const k in info.art) art[k] = v3(info.art[k]);
    return (this.segs[seg] = { grupo, mallas, piezas, info, art });
  }
  ponerCapa(c) { this.capa = c; for (const s of Object.values(this.segs)) this.capaDe(s); }
  capaDe(s) { s.mallas.forEach((m, i) => { m.visible = this.capa === 'musculo' || s.info.partes[i].tipo === 'hueso'; }); }

  // Puntos de MediaPipe → espacio de la cámara 3D (x derecha, y arriba, z hacia la persona que mira)
  // mundo: puntos 3D en metros; img: puntos en la imagen (0..1). ancla: índices para fijar la profundidad.
  aCamara(mundo, img, ancla) {
    const W = this.W, H = this.H, f = this.f;
    const Wc = mundo.map(p => new THREE.Vector3(p.x, -p.y, -p.z));
    const px = img.map(p => [p.x * W, p.y * H]);
    let num = 0, den = 0;
    for (const i of ancla) for (const j of ancla) if (i < j) {
      num += Math.hypot(Wc[i].x - Wc[j].x, Wc[i].y - Wc[j].y);
      den += Math.hypot(px[i][0] - px[j][0], px[i][1] - px[j][1]);
    }
    if (den < 1) return null;
    const Z = Math.min(5, Math.max(0.12, f * num / den));
    // Cada punto cae exactamente sobre su lugar en la imagen; MediaPipe 3D solo aporta la profundidad relativa
    const z0 = Wc[ancla[0]].z;
    return Wc.map((w, i) => { const D = Math.max(0.05, Z - (w.z - z0)); return new THREE.Vector3((px[i][0] - W / 2) / f * D, -(px[i][1] - H / 2) / f * D, -D); });
  }

  ocultar() { for (const s of Object.values(this.segs)) s.grupo.visible = false; this.actual = null; this.r.clear(); }

  // Mano: 21 puntos de MediaPipe Hand
  mano(mundo, img) {
    const s = this.segs.mano; this.solo(s);
    const C = this.aCamara(mundo, img, [0, 5, 9, 13, 17]);
    if (!C) return null;
    const A = s.art, h = k => A['h' + k];
    // ¿Derecha o izquierda? Por la quiralidad 3D: (índice, meñique) respecto a la muñeca, comparado con el pulgar
    const quir = (p0, p5, p17, p2) => Math.sign(p5.clone().sub(p0).cross(p17.clone().sub(p0)).dot(p2.clone().sub(p0)));
    const izq = quir(C[0], C[5], C[17], C[2]) !== quir(h(0), h(5), h(17), h(2));
    const M = k => espejo(h(k), izq);
    const s0 = C[9].distanceTo(C[0]) / h(9).distanceTo(h(0));
    // Palma
    const Fa = base(M(0), M(9), M(5).sub(M(17))), Fv = base(C[0], C[9], C[5].clone().sub(C[17]));
    if (!Fa || !Fv) return null;
    const Rp = Fv.clone().multiply(Fa.clone().transpose());
    for (const m of s.piezas.palma || []) m.matrix.copy(colocar(C[0], Rp, s0, M(0), izq));
    // Cada falange (y el metacarpiano del pulgar) entre dos puntos de MediaPipe
    const q = new THREE.Quaternion(), Rq = new THREE.Matrix4();
    for (const pz in s.piezas) {
      if (pz === 'palma') continue;
      const [i, j] = pz.slice(1).split('-').map(Number);
      const ejeA = M(j).sub(M(i)).applyMatrix4(new THREE.Matrix4().extractRotation(Rp)).normalize();
      const ejeV = C[j].clone().sub(C[i]).normalize();
      q.setFromUnitVectors(ejeA, ejeV); Rq.makeRotationFromQuaternion(q).multiply(Rp);
      // Cada falange con el largo que tiene en la imagen (llega justo a la articulación siguiente)
      const sk = Math.min(2 * s0, Math.max(0.5 * s0, C[j].distanceTo(C[i]) / M(j).distanceTo(M(i))));
      const mt = colocar(C[i], Rq, sk, M(i), izq);
      for (const m of s.piezas[pz]) m.matrix.copy(mt);
    }
    this.actual = { seg: 'mano', izq };
    this.pintar();
    return { izq, palma: this.palma(C, izq) };
  }
  // ¿Se ve la palma? La normal de la palma (hacia palmar) apunta a la cámara
  palma(C, izq) {
    const n = C[5].clone().sub(C[0]).cross(C[17].clone().sub(C[0]));
    if (izq) n.negate();
    const hacia = C[0].clone().negate();   // de la mano a la cámara
    return n.dot(hacia) < 0;
  }

  // Otros segmentos: pa, pb = extremos en la cámara; r = referencia de giro en la cámara;
  // refAtlas(E) = la misma referencia en el atlas, calculada con E(nombre) (ya en espejo si es el lado izquierdo)
  segmento(seg, izq, pa, pb, r, refAtlas, aName, bName) {
    const s = this.segs[seg]; this.solo(s);
    const E = n => espejo(s.art[n], izq);
    const A = E(aName), B = E(bName);
    const Fa = base(A, B, refAtlas(E)), Fv = base(pa, pb, r);
    if (!Fa || !Fv) return false;
    const R = Fv.multiply(Fa.transpose());
    const k = pa.distanceTo(pb) / A.distanceTo(B);
    const mt = colocar(pa, R, k, A, izq);
    for (const m of s.mallas) m.matrix.copy(mt);
    this.actual = { seg, izq };
    this.pintar();
    return true;
  }
  // Ancho del segmento visto de frente (lado a lado), en el atlas: para ajustar la escala a la silueta
  anchoDe(seg, aName, bName) {
    const s = this.segs[seg];
    if (s.ancho) return s.ancho;
    const A = s.art[aName], B = s.art[bName], F = base(A, B, new THREE.Vector3(0, 0, 1));
    const u = new THREE.Vector3(), v = new THREE.Vector3(), w = new THREE.Vector3(); F.extractBasis(u, v, w);
    const L = A.distanceTo(B), xs = [], p = new THREE.Vector3();
    s.mallas.forEach((m, i) => {
      if (s.info.partes[i].tipo !== 'musculo') return;
      const pos = m.geometry.attributes.position;
      for (let k = 0; k < pos.count; k += 3) {
        p.fromBufferAttribute(pos, k).sub(A);
        const t = p.dot(u) / L; if (t < 0.2 || t > 0.8) continue;
        xs.push(p.dot(w));
      }
    });
    xs.sort((a, b) => a - b);
    s.ancho = xs.length ? xs[Math.floor(xs.length * 0.95)] - xs[Math.floor(xs.length * 0.05)] : L * 0.3;
    return s.ancho;
  }
  // De cerca, sin puntos del cuerpo: el segmento se pone sobre la silueta de la piel (centro, dirección y ancho en píxeles).
  // Se supone visto de frente; la escala sale del ancho de la silueta.
  silueta(seg, izq, centro, dir, anchoPx, aName, bName) {
    const s = this.segs[seg]; this.solo(s);
    const Z = 0.6, f = this.f;
    const E = n => espejo(s.art[n], izq);
    const A = E(aName), B = E(bName);
    const Fa = base(A, B, new THREE.Vector3(0, 0, 1));
    const u = new THREE.Vector3(dir[0], -dir[1], 0).normalize();
    const Fv = base(new THREE.Vector3(), u, new THREE.Vector3(0, 0, 1));
    if (!Fa || !Fv) return false;
    const R = Fv.multiply(Fa.transpose());
    const k = (anchoPx * Z / f) / this.anchoDe(seg, aName, bName);
    const pc = new THREE.Vector3((centro[0] - this.W / 2) / f * Z, -(centro[1] - this.H / 2) / f * Z, -Z);
    const mt = colocar(pc, R, k, A.clone().add(B).multiplyScalar(0.5), izq);
    for (const m of s.mallas) m.matrix.copy(mt);
    this.actual = { seg, izq };
    this.pintar();
    return true;
  }
  solo(s) { for (const o of Object.values(this.segs)) o.grupo.visible = o === s; this.capaDe(s); }
  pintar() { this.r.render(this.escena, this.cam); }

  // Qué estructura hay bajo un punto de la imagen (x, y en píxeles del video)
  tocar(x, y) {
    if (!this.actual) return null;
    const s = this.segs[this.actual.seg];
    s.mallas.forEach(m => m.updateMatrixWorld(true));
    this.ray.setFromCamera(new THREE.Vector2(x / this.W * 2 - 1, -(y / this.H) * 2 + 1), this.cam);
    const hit = this.ray.intersectObjects(s.mallas.filter(m => m.visible), false)[0];
    if (!hit) return null;
    const p = s.info.partes[hit.object.userData.parte];
    return { nombre: p.nombre, hueso: p.tipo === 'hueso' };
  }
  partesDe(seg) {
    const s = this.segs[seg]; if (!s) return { huesos: [], musculos: [] };
    const h = new Set(), m = new Set();
    for (const p of s.info.partes) (p.tipo === 'hueso' ? h : m).add(p.nombre);
    return { huesos: [...h], musculos: [...m] };
  }
}

export { THREE };
