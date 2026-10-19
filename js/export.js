// export.js — Exporta la nube, las poses y los datos de sensores a un archivo JSON.

export function exportJSON({ cloud, poses, imu, fov, size, extra }) {
  const data = {
    version: 2,
    nota: 'Nube con escala relativa (mediana de distancia al centro = 1). imu = [t_ms, ax, ay, az (con gravedad, m/s²), alpha, beta, gamma (°/s)]; poses.t usa el mismo reloj (ms).',
    fov_lado_largo_deg: fov,
    imagen: { ancho: size.w, alto: size.h },
    nube: cloud.map(c => ({
      x: +c[0].toFixed(4), y: +c[1].toFixed(4), z: +c[2].toFixed(4),
      w: +c[3].toFixed(3), rgb: [c[4], c[5], c[6]]
    })),
    poses,
    imu,
    ...(extra || {})   // datos adicionales (p. ej., los fragmentos de la captura)
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'camara4d_' + Date.now() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
