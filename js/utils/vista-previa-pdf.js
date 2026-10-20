// Vista previa de un PDF ya generado, dibujado página a página en <canvas>.
//
// Por qué canvas y no un <iframe> con el blob: Chrome en Android y Safari en
// iOS no muestran PDF dentro de un iframe (enseñan un botón de "abrir" o una
// página en blanco), y Josep usa la app también desde el móvil. PDF.js pinta
// igual en todos los navegadores, y ya se carga para el importador de gastos.

import { obtenerPdfJs } from "./justificantes.js";

// Pinta todas las páginas de `datos` (ArrayBuffer del PDF) dentro de $destino.
// `esVigente` permite abandonar un pintado que ya no interesa (el usuario ha
// cambiado algo y hay otra vista previa en marcha): si devuelve false, no se
// toca el destino y la función devuelve false. Con `soloPrimera` solo se
// dibuja la página 1 (miniatura).
export async function pintarPaginasPdf(datos, $destino, { esVigente = () => true, soloPrimera = false } = {}) {
  const pdfjs = await obtenerPdfJs();
  const documento = await pdfjs.getDocument({ data: datos }).promise;
  try {
    // El ancho se mide en el momento: el mismo código sirve para la tarjeta
    // del paso de confirmación y para el modal, que tienen anchos distintos.
    const ancho = Math.max(260, Math.floor($destino.clientWidth || 600));
    // Se dibuja a la densidad de la pantalla (con tope) para que el texto
    // pequeño del pie y de las condiciones se lea nítido en pantallas retina.
    const densidad = Math.min(window.devicePixelRatio || 1, 2);
    const total = soloPrimera ? 1 : documento.numPages;
    const lienzos = [];
    for (let n = 1; n <= total; n++) {
      const pagina = await documento.getPage(n);
      const escala = ancho / pagina.getViewport({ scale: 1 }).width;
      const vista = pagina.getViewport({ scale: escala * densidad });
      const canvas = document.createElement("canvas");
      canvas.className = "vp-pagina";
      canvas.width = Math.floor(vista.width);
      canvas.height = Math.floor(vista.height);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Página ${n} de ${total}`);
      await pagina.render({ canvasContext: canvas.getContext("2d"), viewport: vista }).promise;
      if (!esVigente()) return false;
      lienzos.push(canvas);
    }
    // Se sustituye todo de golpe al final: si se fuera añadiendo página a
    // página, la vista anterior desaparecería y la tarjeta daría un salto.
    $destino.replaceChildren(...lienzos);
    return true;
  } finally {
    documento.destroy();
  }
}
