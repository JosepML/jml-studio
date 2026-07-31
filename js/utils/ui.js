// Avisos y diálogos propios de la app, en sustitución de alert() y confirm()
// del navegador. Los nativos funcionan, pero son lo que más delata un
// prototipo: tipografía del sistema, el nombre del dominio en la cabecera
// ("josepml.github.io dice…") y bloqueo total de la página.
//
// API:
//   toast("Guardado")            → aviso neutro
//   toastOk("Factura creada")    → aviso de éxito (verde)
//   toastError("No se ha podido…") → aviso de error (rojo, no se auto-cierra)
//   await confirmar({...})       → true/false, con diálogo propio

const DURACION_DEFECTO = 3200;

function contenedorToasts() {
  let $wrap = document.querySelector(".toast-wrap");
  if (!$wrap) {
    $wrap = document.createElement("div");
    $wrap.className = "toast-wrap";
    document.body.appendChild($wrap);
  }
  return $wrap;
}

export function toast(mensaje, { tipo = "", duracion = DURACION_DEFECTO } = {}) {
  const $wrap = contenedorToasts();
  const $t = document.createElement("div");
  $t.className = `toast${tipo ? " " + tipo : ""}`;
  $t.setAttribute("role", tipo === "err" ? "alert" : "status");
  const $texto = document.createElement("span");
  $texto.textContent = mensaje;
  $t.appendChild($texto);

  const $cerrar = document.createElement("button");
  $cerrar.className = "toast-close";
  $cerrar.type = "button";
  $cerrar.setAttribute("aria-label", "Cerrar aviso");
  $cerrar.textContent = "✕";
  const quitar = () => { $t.remove(); if (!$wrap.children.length) $wrap.remove(); };
  $cerrar.addEventListener("click", quitar);
  $t.appendChild($cerrar);

  $wrap.appendChild($t);
  // Los errores no se van solos: si algo ha fallado, Josep tiene que poder
  // leerlo con calma aunque estuviera mirando otra parte de la pantalla.
  if (duracion) setTimeout(quitar, duracion);
  return quitar;
}

export function toastOk(mensaje) { return toast(mensaje, { tipo: "ok" }); }
export function toastError(mensaje) { return toast(mensaje, { tipo: "err", duracion: 0 }); }

// Diálogo de confirmación. Devuelve una promesa que resuelve a true/false.
// Se cierra con Escape, con clic fuera o con los botones. El foco entra
// directamente en el botón de confirmar para poder responder con Enter.
export function confirmar({
  titulo = "¿Seguro?",
  mensaje = "",
  confirmar: textoConfirmar = "Sí, continuar",
  cancelar: textoCancelar = "Cancelar",
  peligroso = false,
} = {}) {
  return new Promise(resolve => {
    const $backdrop = document.createElement("div");
    $backdrop.className = "modal-backdrop";
    $backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-titulo">
        <h3 id="modal-titulo"></h3>
        ${mensaje ? "<p></p>" : ""}
        <div class="form-actions">
          <button class="btn btn-ghost" data-accion="cancelar" type="button"></button>
          <button class="btn ${peligroso ? "btn-danger" : "btn-primary"}" data-accion="ok" type="button"></button>
        </div>
      </div>`;

    // Texto por asignación (no interpolado en el HTML) para no tener que
    // escapar nada de lo que venga de datos del usuario.
    $backdrop.querySelector("#modal-titulo").textContent = titulo;
    if (mensaje) $backdrop.querySelector(".modal p").textContent = mensaje;
    const $ok = $backdrop.querySelector('[data-accion="ok"]');
    const $cancelar = $backdrop.querySelector('[data-accion="cancelar"]');
    $ok.textContent = textoConfirmar;
    $cancelar.textContent = textoCancelar;

    const focoPrevio = document.activeElement;
    const cerrar = (valor) => {
      document.removeEventListener("keydown", onKey);
      $backdrop.remove();
      if (focoPrevio && focoPrevio.focus) focoPrevio.focus();
      resolve(valor);
    };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); cerrar(false); }
      if (e.key === "Enter" && document.activeElement === $ok) { e.preventDefault(); cerrar(true); }
    }

    $ok.addEventListener("click", () => cerrar(true));
    $cancelar.addEventListener("click", () => cerrar(false));
    $backdrop.addEventListener("mousedown", e => { if (e.target === $backdrop) cerrar(false); });
    document.addEventListener("keydown", onKey);

    document.body.appendChild($backdrop);
    $ok.focus();
  });
}

// Atajo para el caso más repetido en la app: borrar algo sin vuelta atrás.
export function confirmarBorrado(queCosa) {
  return confirmar({
    titulo: `¿Eliminar ${queCosa}?`,
    mensaje: "Esta acción no se puede deshacer.",
    confirmar: "Eliminar",
    peligroso: true,
  });
}

// Esqueletos de carga: sustituyen al "Cargando…" en texto plano.
export function skeletonKpis(n = 4) {
  return `<div class="grid grid-4" style="margin-bottom:20px;">${
    Array.from({ length: n }, () => `<div class="skeleton sk-kpi"></div>`).join("")
  }</div>`;
}
export function skeletonTabla(filas = 6) {
  return `<div class="card">${
    `<div class="skeleton sk-line" style="width:38%; height:14px; margin-bottom:16px;"></div>` +
    Array.from({ length: filas }, () => `<div class="skeleton sk-line"></div>`).join("")
  }</div>`;
}
export function skeletonPagina({ kpis = 4, filas = 6 } = {}) {
  return skeletonKpis(kpis) + skeletonTabla(filas);
}

// ---------- Movimiento ----------

// Cuenta desde 0 hasta el valor final de cada KPI. El formato (euros, número
// suelto, porcentaje) se deduce del texto ya renderizado, así que las vistas no
// tienen que cambiar nada: basta con llamar a animarValores(container) al
// terminar de pintar.
//
// Aquí tampoco se sale si el sistema pide menos movimiento: Josep tiene ese
// ajuste activado en Windows y ha pedido expresamente conservar el contador,
// que además no desplaza nada (solo cambia una cifra), así que no es el tipo
// de animación que ese ajuste busca evitar.
export function animarValores(container, { duracion = 650 } = {}) {
  const $valores = container.querySelectorAll(".kpi .value, .stat-value");
  $valores.forEach($v => {
    if ($v.dataset.animado) return;
    const textoFinal = $v.textContent.trim();
    // Se extrae el número respetando el formato español (1.234,56).
    const match = textoFinal.match(/-?[\d.]+,?\d*/);
    if (!match) return;
    const destino = Number(match[0].replace(/\./g, "").replace(",", "."));
    if (!isFinite(destino) || destino === 0) return;
    const decimales = (match[0].split(",")[1] || "").length;
    const prefijo = textoFinal.slice(0, match.index);
    const sufijo = textoFinal.slice(match.index + match[0].length);
    $v.dataset.animado = "1";

    const inicio = performance.now();
    const paso = (ahora) => {
      const t = Math.min((ahora - inicio) / duracion, 1);
      // easeOutExpo: arranca rápido y frena al final, que es lo que hace que
      // el número parezca "aterrizar" en su sitio en vez de subir plano.
      const p = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      const valor = destino * p;
      $v.textContent = prefijo + valor.toLocaleString("es-ES", {
        minimumFractionDigits: decimales, maximumFractionDigits: decimales,
      }) + sufijo;
      if (t < 1) requestAnimationFrame(paso);
      else $v.textContent = textoFinal; // se restituye el texto exacto original
    };
    requestAnimationFrame(paso);
  });
}

// Entrada escalonada: cada tarjeta aparece un instante después que la anterior,
// de arriba abajo. Se aplica por CSS (.stagger-in) con un retardo calculado.
// Ojo: aquí NO se sale si el sistema pide menos movimiento. La cascada es lo
// que hace que la página parezca desplegarse en vez de parpadear, y se puede
// conservar sin movimiento: el CSS la convierte en un fundido escalonado (sin
// desplazamiento) cuando prefers-reduced-motion está activo. Salir aquí dejaba
// solo el fundido plano del bloque entero, que se sentía brusco.
export function entradaEscalonada(container, selector = ".card", { paso = 55, max = 14 } = {}) {
  const elementos = container.querySelectorAll(selector);
  elementos.forEach(($el, i) => {
    if ($el.dataset.entrada) return;
    $el.dataset.entrada = "1";
    $el.style.animationDelay = `${Math.min(i, max) * paso}ms`;
    $el.classList.add("stagger-in");
  });
}

// Atajo para el final de cada vista: números que cuentan + tarjetas que entran.
export function animarVista(container) {
  entradaEscalonada(container);
  animarValores(container);
}
