// Service worker mínimo: cachea el shell de la app para que abra al instante
// (incluso con mala cobertura) y funcione para consultar datos ya cargados
// sin conexión. Los datos en sí siempre se piden en vivo a Supabase.
const CACHE = "jml-studio-v8";
const ASSETS = [
  "./", "./index.html", "./manifest.json",
  "./css/style.css",
  "./js/config.js", "./js/app.js", "./js/supabase.js",
  "./js/utils/format.js", "./js/utils/invoice-calc.js", "./js/utils/resumen.js",
  "./js/utils/config-usuario.js", "./js/utils/config-negocio.js", "./js/utils/amortizacion.js",
  "./js/utils/ui.js", "./js/utils/charts.js", "./js/utils/servicios.js", "./js/utils/condiciones.js",
  "./js/utils/gastos-recurrentes.js", "./js/utils/gcal.js", "./js/utils/pdf-documentos.js", "./js/utils/pdf-fonts.js",
  "./js/ai/parser.js", "./js/ai/mistral.js",
  "./js/views/dashboard.js", "./js/views/clientes.js", "./js/views/proyectos.js",
  "./js/views/facturacion.js", "./js/views/financiero.js", "./js/views/asistente.js",
  "./js/views/gastos.js", "./js/views/mensual.js", "./js/views/configuracion.js",
  "./js/views/calendario.js",
  "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Nunca cachear llamadas a Supabase: siempre datos en vivo.
  if (url.hostname.endsWith("supabase.co")) return;
  // Ni a Google: los tokens y los eventos del calendario siempre en vivo.
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("google.com")) return;
  // Los ficheros propios de la app se piden SIEMPRE revalidando contra el
  // servidor. Sin esto no bastaba con "red primero": GitHub Pages los sirve
  // con max-age, así que el navegador los daba por buenos desde su propia
  // caché HTTP durante minutos y un despliegue nuevo no se veía hasta pasado
  // un rato o forzando la recarga con Ctrl+Shift+R.
  // Ojo: "no-cache" no significa "sin caché", significa "no lo des por bueno
  // sin preguntar": la petición viaja con el ETag y el servidor contesta 304
  // si no ha cambiado, así que sigue siendo barato.
  // Las peticiones de navegación se dejan intactas porque construir un
  // Request a partir de una con mode "navigate" lanza excepción.
  let peticion = event.request;
  if (url.origin === self.location.origin && event.request.mode !== "navigate") {
    try { peticion = new Request(event.request, { cache: "no-cache" }); }
    catch { /* si no se puede, se usa la original */ }
  }

  // Red primero (para que cada despliegue nuevo se vea al instante); si no
  // hay conexión, cae a lo último que quedó en caché.
  event.respondWith(
    fetch(peticion)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
