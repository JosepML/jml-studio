import { auth } from "./supabase.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderClientes } from "./views/clientes.js";
import { renderProyectos } from "./views/proyectos.js";
import { renderFacturacion } from "./views/facturacion.js";
import { renderFinanciero } from "./views/financiero.js";
import { renderGastos } from "./views/gastos.js";
import { renderMensual } from "./views/mensual.js";
import { renderAsistente } from "./views/asistente.js";
import { asegurarGastosFijosMensuales } from "./utils/gastos-recurrentes.js";

const ROUTES = {
  dashboard: { title: "Dashboard", render: renderDashboard },
  mensual: { title: "Facturación mensual", render: renderMensual },
  proyectos: { title: "Proyectos", render: renderProyectos },
  clientes: { title: "Clientes", render: renderClientes },
  facturacion: { title: "Facturación", render: renderFacturacion },
  gastos: { title: "Gastos", render: renderGastos },
  financiero: { title: "Financiero", render: renderFinanciero },
  asistente: { title: "Asistente", render: renderAsistente },
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

let previewMode = false;

function showApp() {
  $loginScreen.classList.add("hidden");
  $setpassScreen.classList.add("hidden");
  $app.classList.remove("hidden");
  $userEmail.textContent = previewMode ? "Modo vista (sin datos)" : (auth.currentUser()?.email || "");
  // Da de alta solos, si faltan, los gastos fijos recurrentes del mes (cuota
  // de autónomo, gestoría) — así Josep no tiene que añadirlos a mano. No se
  // hace en modo vista, que no tiene datos reales que tocar.
  if (!previewMode) asegurarGastosFijosMensuales().catch(err => console.error(err));
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
    if (result.error) { showLogin(); alert(result.error); return; }
    if (result.needsPassword) { showSetPassword(); return; }
    showApp();
    return;
  }
  if (auth.isLoggedIn()) showApp(); else showLogin();
})();
