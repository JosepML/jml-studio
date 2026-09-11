// Lectura local de justificantes para el importador de gastos.
// Los PDF se procesan primero con texto local; solo los escaneados pasan a
// visión. Así reducimos peticiones y mantenemos el flujo compatible con el
// router gratuito de OpenRouter.

const MAX_IMAGEN = 1600;
const MAX_PAGINAS = 6;
const MAX_ARCHIVO = 12 * 1024 * 1024;
const PDF_JS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let pdfJsPromesa = null;

function cargarScript(src) {
  return new Promise((resolve, reject) => {
    const existente = document.querySelector(`script[data-jml-src="${src}"]`);
    if (existente) {
      if (window.pdfjsLib) resolve(window.pdfjsLib);
      else existente.addEventListener("load", () => resolve(window.pdfjsLib), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.jmlSrc = src;
    script.onload = () => window.pdfjsLib ? resolve(window.pdfjsLib) : reject(new Error("No se ha podido cargar el lector PDF."));
    script.onerror = () => reject(new Error("No se ha podido cargar el lector PDF. Comprueba la conexión e inténtalo de nuevo."));
    document.head.appendChild(script);
  });
}

async function obtenerPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!pdfJsPromesa) pdfJsPromesa = cargarScript(PDF_JS);
  const pdfjs = await pdfJsPromesa;
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  return pdfjs;
}

function leerDataUrl(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result));
    lector.onerror = () => reject(new Error("No se ha podido leer el archivo."));
    lector.readAsDataURL(file);
  });
}

function cargarImagen(dataUrl) {
  return new Promise((resolve, reject) => {
    const imagen = new Image();
    imagen.onload = () => resolve(imagen);
    imagen.onerror = () => reject(new Error("La imagen no se puede leer. Prueba con JPG, PNG o WebP."));
    imagen.src = dataUrl;
  });
}

async function comprimirImagen(dataUrl, calidad = 0.82) {
  const imagen = await cargarImagen(dataUrl);
  const escala = Math.min(1, MAX_IMAGEN / Math.max(imagen.naturalWidth || imagen.width, imagen.naturalHeight || imagen.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((imagen.naturalWidth || imagen.width) * escala));
  canvas.height = Math.max(1, Math.round((imagen.naturalHeight || imagen.height) * escala));
  canvas.getContext("2d").drawImage(imagen, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", calidad);
}

async function renderizarPagina(pdf, numero) {
  const pagina = await pdf.getPage(numero);
  const base = pagina.getViewport({ scale: 1 });
  const escala = Math.min(2, MAX_IMAGEN / Math.max(base.width, base.height));
  const viewport = pagina.getViewport({ scale: escala });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await pagina.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.78);
}

async function leerPdf(file, actualizar) {
  actualizar("Abriendo el PDF…");
  const pdfjs = await obtenerPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const paginas = Math.min(pdf.numPages, MAX_PAGINAS);
  const textos = [];
  for (let i = 1; i <= paginas; i++) {
    actualizar(`Leyendo página ${i} de ${paginas}…`);
    const pagina = await pdf.getPage(i);
    const contenido = await pagina.getTextContent();
    textos.push(contenido.items.map(item => item.str).join(" "));
  }
  const texto = textos.join("\n").replace(/\s+/g, " ").trim();
  // Un PDF escaneado suele no tener texto útil. En ese caso enviamos sus
  // páginas como imágenes al modelo de visión, con un límite prudente.
  if (texto.length >= 80) return { texto, imagenes: [], paginas, esPdf: true };
  const imagenes = [];
  for (let i = 1; i <= paginas; i++) {
    actualizar(`Preparando página ${i} de ${paginas} para lectura visual…`);
    imagenes.push(await renderizarPagina(pdf, i));
  }
  return { texto: "", imagenes, paginas, esPdf: true };
}

export async function prepararJustificante(file, actualizar = () => {}) {
  if (!file) throw new Error("Selecciona una imagen o un PDF.");
  if (file.size > MAX_ARCHIVO) throw new Error("El archivo ocupa más de 12 MB. Redúcelo o haz una foto más cercana.");
  const tipo = file.type || "";
  if (tipo === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return leerPdf(file, actualizar);
  }
  if (!tipo.startsWith("image/")) throw new Error("Formato no compatible. Usa JPG, PNG, WebP o PDF.");
  actualizar("Optimizando la imagen…");
  return { texto: "", imagenes: [await comprimirImagen(await leerDataUrl(file))], paginas: 1, esPdf: false };
}

export const LIMITES_JUSTIFICANTE = { MAX_ARCHIVO, MAX_PAGINAS };
