import { auth } from "./supabase.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderClientes } from "./views/clientes.js";
import { renderProyectos } from "./views/proyectos.js";
import { renderFacturacion, renderPresupuestos } from "./views/facturacion.js";
import { renderFinanciero } from "./views/financiero.js";
import { renderGastos } from "./views/gastos.js";
import { renderMensual } from "./views/mensual.js";
import { renderAsistente } from "./views/asistente.js";
import { renderConfiguracion } from "./views/configuracion.js";
import { montarChatFlotante, olvidarChat } from "./views/chat-flotante.js";
import { asegurarGastosFijosMensuales } from "./utils/gastos-recurrentes.js";
import { animarVista, toastError } from "./utils/ui.js";
import { cargarEmisor, olvidarEmisor } from "./utils/config-negocio.js";

const ROUTES = {
  dashboard: { title: "Dashboard", render: renderDashboard },
  mensual: { title: "Facturación mensual", render: renderMensual },
  proyectos: { title: "Proyectos", render: renderProyectos },
  clientes: { title: "Clientes", render: renderClientes },
  facturacion: { title: "Facturas", render: renderFacturacion },
  presupuestos: { title: "Presupuestos", render: renderPresupuestos },
  gastos: { title: "Gastos", render: renderGastos },
  financiero: { title: "Financiero", render: renderFinanciero },
  asistente: { title: "Asistente", render: renderAsistente },
  configuracion: { title: "Configuración", render: renderConfiguracion },
};

const $loginScreen = document.getElementById("login-screen");
const $setpassScreen = document.getElementById("setpass-screen");
const $app = document.getElementById("app");
const $content = document.getElementById("content");
const $pageTitle = document.getElementById("page-title");
const $userEmail = document.getElementById("user-email");

function currentRoute() {
  const raw = location.hash.replace(/^#\//, "") || "dashboard";
  const [routeName, param] = raw.split("/");
  return { routeName: ROUTES[routeName] ? routeName : "dashboard", param };
}

async function render() {
  const { routeName, param } = currentRoute();
  const route = ROUTES[routeName];
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === routeName));
  $pageTitle.textContent = route.title;
  $content.innerHTML = `<div class="empty-state">Cargando…</div>`;
  closeSidebar();
  try {
    await route.render($content, param);
  } catch (err) {
    console.error(err);
    $content.innerHTML = `<div class="card"><strong>Ha ocurrido un error cargando esta sección.</strong><p class="muted">${(err && err.message) || err}</p></div>`;
  }
  animarEntradaVista();
}

// Relanza la animación de despliegue del contenido en cada cambio de sección.
// Hay que quitar la clase, forzar un reflow y volver a ponerla: si solo se
// añadiera, el navegador vería que ya estaba puesta y no reiniciaría la
// animación, así que solo se vería la primera vez que se entra en la app.
// Se llama DESPUÉS de que la vista haya pintado, no antes, para que el
// despliegue acompañe al contenido real y no al esqueleto de carga.
function animarEntradaVista() {
  $content.classList.remove("vista-entra");
  void $content.offsetWidth; // fuerza el reflow
  $content.classList.add("vista-entra");

  // La cascada de tarjetas y el contador de los importes se lanzan AQUÍ, en el
  // router, y no en cada vista. Antes cada vista tenía que acordarse de llamar
  // a animarVista() y cinco no lo hacían (Facturación mensual, Proyectos,
  // Facturas, Presupuestos y Asistente), así que en esas páginas no se veía
  // nada. Centralizándolo, ninguna vista puede volver a olvidarse.
  // Llamarlo dos veces no molesta: animarVista() marca cada elemento que ya ha
  // animado (dataset.entrada / dataset.animado), así que en las vistas que ya
  // lo invocan por su cuenta esta segunda llamada no hace nada.
  animarVista($content);
}

// --- Menú móvil (sidebar deslizante) ---
const $sidebar = document.getElementById("sidebar");
const $sidebarOverlay = document.getElementById("sidebar-overlay");
const $menuToggle = document.getElementById("menu-toggle");
function openSidebar() { $sidebar.classList.add("open"); $sidebarOverlay.classList.add("open"); }
function closeSidebar() { $sidebar.classList.remove("open"); $sidebarOverlay.classList.remove("open"); }
$menuToggle.addEventListener("click", () => {
  $sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
});
$sidebarOverlay.addEventListener("click", closeSidebar);

// --- Botón "+ Crear" del menú lateral ---
// Comparte el aspecto de los desplegables del editor pero con su propio manejo,
// porque vive fuera de #content y no se repinta en cada navegación.
const $menuCrear = document.getElementById("menu-crear");
if ($menuCrear) {
  const $btn = $menuCrear.querySelector("[data-menu-btn]");
  $btn.addEventListener("click", (e) => {
    e.stopPropagation();
    $menuCrear.classList.toggle("abierto");
  });
  // Al elegir una opción se cierra solo; el router se encarga del resto.
  $menuCrear.querySelectorAll(".menu-item").forEach(a => {
    a.addEventListener("click", () => $menuCrear.classList.remove("abierto"));
  });
  document.addEventListener("click", () => $menuCrear.classList.remove("abierto"));
  document.addEventListener("keydown", e => { if (e.key === "Escape") $menuCrear.classList.remove("abierto"); });
}

let previewMode = false;

function showApp() {
  $loginScreen.classList.add("hidden");
  $setpassScreen.classList.add("hidden");
  $app.classList.remove("hidden");
  $userEmail.textContent = previewMode ? "Modo vista (sin datos)" : (auth.currentUser()?.email || "");
  // Da de alta solos, si faltan, los gastos fijos recurrentes del mes (cuota
  // de autónomo, gestoría) — así Josep no tiene que añadirlos a mano. No se
  // hace en modo vista, que no tiene datos reales que tocar.
  if (!previewMode) {
    // El chat vive colgado del <body>, fuera de #content, para que no se
    // destruya al navegar de una sección a otra.
    montarChatFlotante();
    asegurarGastosFijosMensuales().catch(err => console.error(err));
    // Datos de emisor: viven en Supabase (migración 008), no en el código.
    // Al llegar, repinta: la vista puede haberse dibujado antes de tenerlos.
    cargarEmisor().then(render).catch(err => console.error(err));
  }
  render();
}
function showLogin() {
  $app.classList.add("hidden");
  $setpassScreen.classList.add("hidden");
  $loginScreen.classList.remove("hidden");
}
function showSetPassword() {
  $app.classList.add("hidden");
  $loginScreen.classList.add("hidden");
  $setpassScreen.classList.remove("hidden");
}

window.addEventListener("hashchange", () => { if (auth.isLoggedIn() || previewMode) render(); });

document.getElementById("preview-mode-link").addEventListener("click", (e) => {
  e.preventDefault();
  previewMode = true;
  showApp();
});

document.getElementById("login-btn").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const $err = document.getElementById("login-error");
  $err.classList.add("hidden");
  const { error } = await auth.signIn(email, password);
  if (error) { $err.textContent = typeof error === "string" ? error : "No se ha podido iniciar sesión."; $err.classList.remove("hidden"); return; }
  showApp();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  auth.signOut();
  olvidarEmisor();
  olvidarChat();
  previewMode = false;
  showLogin();
});

document.getElementById("setpass-btn").addEventListener("click", async () => {
  const p1 = document.getElementById("setpass-password").value;
  const p2 = document.getElementById("setpass-password2").value;
  const $err = document.getElementById("setpass-error");
  $err.classList.add("hidden");
  if (p1.length < 6) { $err.textContent = "La contraseña debe tener al menos 6 caracteres."; $err.classList.remove("hidden"); return; }
  if (p1 !== p2) { $err.textContent = "Las dos contraseñas no coinciden."; $err.classList.remove("hidden"); return; }
  const { error } = await auth.setPassword(p1);
  if (error) { $err.textContent = typeof error === "string" ? error : "No se ha podido guardar la contraseña."; $err.classList.remove("hidden"); return; }
  showApp();
});

// Arranque: primero comprueba si venimos de un enlace de invitación/recuperación
// de Supabase (trae los tokens en el hash de la URL).
(async function boot() {
  const result = await auth.completeFromUrlHash();
  if (result.handled) {
    if (result.error) { showLogin(); toastError(result.error); return; }
    if (result.needsPassword) { showSetPassword(); return; }
    showApp();
    return;
  }
  if (auth.isLoggedIn()) showApp(); else showLogin();
})();

// --- Menú plegable en escritorio (modo raíl) ---
// El logo "JM" contrae el menú a solo iconos. La preferencia se guarda en este
// dispositivo, así que si Josep lo deja plegado sigue plegado la próxima vez.
const $railToggle = document.getElementById("rail-toggle");
const LS_RAIL = "jml_menu_plegado";
function aplicarRail(plegado) {
  $sidebar.classList.toggle("rail", plegado);
  if ($railToggle) {
    $railToggle.setAttribute("aria-expanded", String(!plegado));
    $railToggle.title = plegado ? "Mostrar los nombres del menú" : "Ocultar los nombres del menú";
  }
}
if ($railToggle) {
  aplicarRail(localStorage.getItem(LS_RAIL) === "1");
  $railToggle.addEventListener("click", () => {
    // En móvil el menú es un cajón que se abre y se cierra con el botón de
    // hamburguesa; ahí el logo no debe plegar nada.
    if (window.matchMedia("(max-width:860px)").matches) return;
    const plegado = !$sidebar.classList.contains("rail");
    aplicarRail(plegado);
    localStorage.setItem(LS_RAIL, plegado ? "1" : "0");
  });
}
