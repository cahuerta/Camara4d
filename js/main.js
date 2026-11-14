// main.js — Arranque de la página: una sola pantalla, la cámara que reconoce el segmento (cuerpo.js).
// El escáner 3D anterior (captura, resultado, tomas) quedó guardado en js/escaner.js y ya no se carga.
import { crearCuerpo, VERSION as CUERPO_VERSION } from './cuerpo.js';
import { VERSION as RED_VERSION } from './red.js';
import { VERSION as ATLAS_VERSION } from './atlas3d.js';

const APP_VERSION = '24';
const $ = id => document.getElementById(id);
const showErr = m => (window.showAppError ? window.showAppError(m) : console.error(m));

// index.html es fijo y todavía trae el esqueleto del escáner: se quita
document.querySelectorAll('body > .box').forEach(e => e.remove());
$('title').innerHTML = 'Cámara 4D <span>v' + APP_VERSION + '</span>';
{
  const bad = [];
  if (CUERPO_VERSION !== '4') bad.push('js/cuerpo.js');
  if (ATLAS_VERSION !== '1') bad.push('js/atlas3d.js');
  if (RED_VERSION !== '1') bad.push('js/red.js');
  if (bad.length) showErr('Archivos de otra versión: ' + bad.join(', ') + '. Recarga la página.');
}
const pantalla = crearCuerpo();
pantalla.page.style.padding = '0';
$('err').after(pantalla.page);
window.APP_READY = true;
