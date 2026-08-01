// Calendario mensual sincronizado con Google Calendar.
//
// Lee y escribe de verdad contra la agenda de Google: lo que se crea aquí
// aparece en el móvil, y lo que se apunta en el móvil aparece aquí. No hay
// copia local de los eventos en Supabase a propósito — dos copias de la misma
// agenda acaban siempre descuadradas.

import * as gcal from "../utils/gcal.js";
import { escapeHtml, escapeAttr } from "./clientes.js";
import { toastOk, toastError } from "../utils/ui.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DIAS = ["L","M","X","J","V","S","D"];

/** Lunes de la semana en la que cae la fecha. */
function lunesDe(fecha) {
  const d = new Date(fecha);
  const desplaza = (d.getDay() + 6) % 7;   // domingo = 6, no 0
  d.setDate(d.getDate() - desplaza);
  d.setHours(0, 0, 0, 0);
  return d;
}

function mismoDia(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Pinta el calendario dentro de `host` (una .card vacía).
 */
export function montarCalendario(host) {
  let mes = new Date();
  mes.setDate(1);
  mes.setHours(0, 0, 0, 0);

  let calendarios = [];
  let eventos = [];
  let cargando = false;

  host.innerHTML = `
    <div class="cal-head">
      <div class="cal-titulo">
        <span class="cal-icono">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><line x1="16" y1="2.5" x2="16" y2="6.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </span>
        <div>
          <h3>Calendario</h3>
          <small class="muted">Sincronizado con tu Google Calendar</small>
        </div>
      </div>
      <div class="cal-acciones">
        <button class="btn btn-sec cal-icon-btn" type="button" data-ir="-1" title="Mes anterior">‹</button>
        <button class="btn btn-sec" type="button" data-ir="0">Hoy</button>
        <button class="btn btn-sec cal-icon-btn" type="button" data-ir="1" title="Mes siguiente">›</button>
        <button class="btn btn-sec cal-icon-btn" type="button" data-recargar title="Recargar desde Google">⟳</button>
      </div>
    </div>
    <div class="cal-estado" data-estado hidden></div>
    <div class="cal-mes" data-mes></div>
    <div class="cal-semana">${DIAS.map(d => `<span>${d}</span>`).join("")}</div>
    <div class="cal-rejilla" data-rejilla></div>
  `;

  const $estado = host.querySelector("[data-estado]");
  const $mes = host.querySelector("[data-mes]");
  const $rejilla = host.querySelector("[data-rejilla]");

  function estado(html) {
    $estado.hidden = !html;
    $estado.innerHTML = html || "";
  }

  /* ------------------------------------------------------------ pintado */

  function pintar() {
    $mes.textContent = `${MESES[mes.getMonth()]} de ${mes.getFullYear()}`;
    const hoy = new Date();
    const inicio = lunesDe(mes);
    const celdas = [];

    for (let i = 0; i < 42; i++) {
      const dia = new Date(inicio);
      dia.setDate(inicio.getDate() + i);
      const fuera = dia.getMonth() !== mes.getMonth();
      const esHoy = mismoDia(dia, hoy);

      const delDia = eventos.filter(e => {
        // Un evento de varios días ocupa todas sus casillas.
        const desde = new Date(e.inicio); desde.setHours(0,0,0,0);
        const hasta = new Date(e.fin);
        if (e.todoElDia) hasta.setDate(hasta.getDate() - 1);   // el fin es exclusivo
        hasta.setHours(23,59,59,999);
        return dia >= desde && dia <= hasta;
      });

      const chips = delDia.slice(0, 3).map(e => `
        <button class="cal-ev" type="button" data-ev="${escapeAttr(e.id)}" data-cal="${escapeAttr(e.calendarId)}"
                title="${escapeAttr((e.todoElDia ? "" : gcal.hhmm(e.inicio) + " ") + e.titulo)}">
          <i style="background:${escapeAttr(e.color)}"></i>
          <span>${e.todoElDia ? "" : `<b>${gcal.hhmm(e.inicio)}</b> `}${escapeHtml(e.titulo)}</span>
        </button>`).join("");

      const mas = delDia.length > 3 ? `<span class="cal-mas">+${delDia.length - 3} más</span>` : "";

      celdas.push(`
        <div class="cal-dia${fuera ? " fuera" : ""}${esHoy ? " hoy" : ""}" data-dia="${gcal.iso(dia)}">
          <div class="cal-dia-cab">
            <span class="cal-num">${dia.getDate()}</span>
            ${esHoy ? `<span class="cal-hoy">HOY</span>` : ""}
          </div>
          <div class="cal-evs">${chips}${mas}</div>
        </div>`);
    }
    $rejilla.innerHTML = celdas.join("");
  }

  /* ------------------------------------------------------------- carga */

  async function cargar({ silencioso = true } = {}) {
    if (cargando) return;
    if (!gcal.clientId()) {
      estado(`Para ver aquí tu agenda hace falta conectar Google una sola vez.
              <a href="#/configuracion">Ir a Configuración → Calendario</a>.`);
      pintar();
      return;
    }
    cargando = true;
    try {
      if (!gcal.estaConectado()) await gcal.conectar({ silencioso });
      if (!calendarios.length) calendarios = await gcal.listarCalendarios();
      const desde = lunesDe(mes);
      const hasta = new Date(desde);
      hasta.setDate(hasta.getDate() + 42);
      eventos = await gcal.listarEventos(desde, hasta, calendarios);
      estado("");
    } catch (e) {
      eventos = [];
      estado(`No se ha podido leer la agenda. <button class="btn btn-sec" type="button" data-conectar>Conectar con Google</button>
              <small class="muted" style="display:block; margin-top:6px;">${escapeHtml(e.message || "")}</small>`);
    } finally {
      cargando = false;
      pintar();
    }
  }

  /* ------------------------------------------------------------ eventos */

  host.addEventListener("click", async (ev) => {
    const ir = ev.target.closest("[data-ir]");
    if (ir) {
      const paso = Number(ir.dataset.ir);
      if (paso === 0) { mes = new Date(); mes.setDate(1); mes.setHours(0,0,0,0); }
      else mes.setMonth(mes.getMonth() + paso);
      pintar();
      cargar();
      return;
    }
    if (ev.target.closest("[data-recargar]")) { calendarios = []; cargar(); return; }
    if (ev.target.closest("[data-conectar]")) { cargar({ silencioso: false }); return; }

    const chip = ev.target.closest("[data-ev]");
    if (chip) {
      ev.stopPropagation();
      const e = eventos.find(x => x.id === chip.dataset.ev && x.calendarId === chip.dataset.cal);
      if (e) abrirEvento(e);
      return;
    }

    const dia = ev.target.closest("[data-dia]");
    if (dia) abrirEvento(null, dia.dataset.dia);
  });

  /* -------------------------------------------------------- formulario */

  function abrirEvento(evento, fechaSuelta) {
    if (!gcal.clientId()) { toastError("Conecta Google en Configuración → Calendario."); return; }

    const nuevo = !evento;
    const fechaIni = nuevo ? fechaSuelta : gcal.iso(evento.inicio);
    const finReal = nuevo ? null : (() => {
      const f = new Date(evento.fin);
      if (evento.todoElDia) f.setDate(f.getDate() - 1);
      return f;
    })();
    const todoElDia = nuevo ? false : evento.todoElDia;

    const $fondo = document.createElement("div");
    $fondo.className = "modal-backdrop";
    $fondo.innerHTML = `
      <div class="modal ancho">
        <h3>${nuevo ? "Nuevo evento" : "Editar evento"}</h3>
        <p>Se guarda directamente en tu Google Calendar.</p>
        <div class="field"><label>Título</label>
          <input id="ev-titulo" type="text" value="${nuevo ? "" : escapeAttr(evento.titulo)}" placeholder="Rodaje, reunión, entrega…"></div>
        <label class="toggle-box"><input id="ev-dia" type="checkbox" ${todoElDia ? "checked" : ""}> <span>Todo el día</span></label>
        <div class="grid grid-2">
          <div class="field"><label>Empieza</label>
            <div class="cal-fila-fecha">
              <input id="ev-fini" type="date" value="${fechaIni}">
              <input id="ev-hini" type="time" value="${nuevo || todoElDia ? "09:00" : gcal.hhmm(evento.inicio)}" ${todoElDia ? "hidden" : ""}>
            </div></div>
          <div class="field"><label>Termina</label>
            <div class="cal-fila-fecha">
              <input id="ev-ffin" type="date" value="${nuevo ? fechaIni : gcal.iso(finReal)}">
              <input id="ev-hfin" type="time" value="${nuevo || todoElDia ? "10:00" : gcal.hhmm(evento.fin)}" ${todoElDia ? "hidden" : ""}>
            </div></div>
        </div>
        <div class="field"><label>Lugar</label>
          <input id="ev-lugar" type="text" value="${nuevo ? "" : escapeAttr(evento.lugar)}"></div>
        <div class="field"><label>Notas</label>
          <textarea id="ev-desc" rows="2">${nuevo ? "" : escapeHtml(evento.descripcion)}</textarea></div>
        ${nuevo ? `<div class="field"><label>Calendario</label>
          <select id="ev-cal">${calendarios.map(c => `<option value="${escapeAttr(c.id)}"${c.principal ? " selected" : ""}>${escapeHtml(c.nombre)}</option>`).join("")}</select></div>` : ""}
        <div class="form-actions">
          ${nuevo ? "" : `<button class="btn btn-danger" type="button" data-borrar>Borrar</button>`}
          <button class="btn btn-sec" type="button" data-cerrar>Cancelar</button>
          <button class="btn btn-primary" type="button" data-guardar>Guardar</button>
        </div>
      </div>`;
    document.body.appendChild($fondo);

    const $ = (id) => $fondo.querySelector(id);
    const cerrar = () => { $fondo.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") cerrar(); };
    document.addEventListener("keydown", esc);
    $fondo.addEventListener("click", (e) => { if (e.target === $fondo) cerrar(); });
    $("[data-cerrar]").addEventListener("click", cerrar);
    $("#ev-titulo").focus();

    $("#ev-dia").addEventListener("change", (e) => {
      const oculto = e.target.checked;
      $("#ev-hini").hidden = oculto;
      $("#ev-hfin").hidden = oculto;
    });

    $("[data-guardar]").addEventListener("click", async () => {
      const titulo = $("#ev-titulo").value.trim();
      if (!titulo) { toastError("El evento necesita un título."); return; }
      const cuerpo = gcal.cuerpoEvento({
        titulo,
        todoElDia: $("#ev-dia").checked,
        fechaIni: $("#ev-fini").value,
        horaIni: $("#ev-hini").value,
        fechaFin: $("#ev-ffin").value || $("#ev-fini").value,
        horaFin: $("#ev-hfin").value,
        lugar: $("#ev-lugar").value.trim(),
        descripcion: $("#ev-desc").value.trim(),
      });
      try {
        if (nuevo) await gcal.crearEvento($("#ev-cal").value, cuerpo);
        else await gcal.actualizarEvento(evento.calendarId, evento.id, cuerpo);
        cerrar();
        toastOk(nuevo ? "Evento creado en Google Calendar." : "Evento actualizado.");
        cargar();
      } catch (e) { toastError(e.message || "No se ha podido guardar el evento."); }
    });

    if (!nuevo) {
      $("[data-borrar]").addEventListener("click", async () => {
        try {
          await gcal.borrarEvento(evento.calendarId, evento.id);
          cerrar();
          toastOk("Evento borrado.");
          cargar();
        } catch (e) { toastError(e.message || "No se ha podido borrar el evento."); }
      });
    }
  }

  pintar();
  cargar();
}
