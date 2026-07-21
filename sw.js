// Service worker mínimo: cachea el shell de la app para que abra al instante
// (incluso con mala cobertura) y funcione para consultar datos ya cargados
// sin conexión. Los datos en sí siempre se piden en vivo a Supabase.
const CACHE = "jml-studio-v1";
const ASSETS = [
  "./", "./index.html", "./manifest.json",
  "./css/style.css",
  "./js/config.js", "./js/app.js", "./js/supabase.js",
  "./js/utils/format.js", "./js/utils/invoice-calc.js", "./js/ai/parser.js",
  "./js/views/dashboard.js", "./js/views/clientes.js", "./js/views/proyectos.js",
  "./js/views/facturacion.js", "./js/views/financiero.js", "./js/views/asistente.js",
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
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
