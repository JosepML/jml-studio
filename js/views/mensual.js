import { db } from "../supabase.js";
import { eur, FORMAS_PAGO, todayIso } from "../utils/format.js";
import { round2 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, rangoAnio, rangoMes, conIva, estadoEfectivo } from "../utils/resumen.js";
import { escapeHtml } from "./clientes.js";
import { nextNumero } from "./facturacion.js";
import { toastOk, toastError, skeletonPagina } from "../utils/ui.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

export async function renderMensual(container) {
  container.innerHTML = skeletonPagina({ kpis: 4, filas: 8 });

  const [{ data: proyectos, error: e1 }, { data: clientes }, { data: facturaProyectos, error: e2 }, { data: gastos }, { data: facturas }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("clientes").select("id,nombre").order("nombre").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("gastos").select("*").exec(),
    db.from("facturas").select("id,numero,estado,tipo").order("numero").exec(),
  ]);
  if (e1 || e2) { container.innerHTML = `<p class="muted">Error cargando datos: ${e1 || e2}</p>`; return; }

  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  const anioActual = new Date().getFullYear();
  let ledger = construirLedger(proyectos, facturaProyectos);
  let facturasReales = (facturas || []).filter(f => f.tipo === "factura");
  // proyecto_id -> factura_id ya vinculado (si lo hay), para preseleccionar el desplegable.
  const vinculoPorProyecto = {};
  (facturaProyectos || []).forEach(fp => { if (fp.facturas && fp.facturas.tipo === "factura") vinculoPorProyecto[fp.proyecto_id] = fp.factura_id; });

  const anios = Array.from(new Set([...ledger.map(f => f.fecha ? new Date(f.fecha).getFullYear() : anioActual), anioActual])).sort((a,b)=>b-a);

  // Sin <h2> propio: la barra superior de la app ya muestra "Facturación
  // mensual" y repetirlo aquí era un título duplicado en la misma pantalla.
  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters toolbar-action">
        <label>Año</label>
        <select id="sel-anio">${anios.map(a => `<option value="${a}" ${a===anioActual?"selected":""}>${a}</option>`).join("")}</select>
      </div>
    </div>
    <div id="resumen-anual" class="grid grid-4" style="margin-bottom:20px;"></div>
    <div id="meses-body"></div>
  `;

  // Qué meses están desplegados. Se recalcula el HTML entero cada vez que se
  // edita algo (checkbox, desplegable, etc.), así que sin esto cada edición
  // volvería a colapsar el panel del mes — dando la sensación de que el clic
  // en la casilla "cierra" el mes en vez de marcar la casilla.
  const mesesAbiertos = new Set([new Date().getMonth()]);

  container.querySelector("#sel-anio").addEventListener("change", e => pintar(Number(e.target.value)));
  pintar(anioActual);

  async function recargarDatos() {
    const [{ data: p2 }, { data: fp2 }, { data: f2 }] = await Promise.all([
      db.from("proyectos").select("*").exec(),
      db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
      db.from("facturas").select("id,numero,estado,tipo").order("numero").exec(),
    ]);
    proyectos.length = 0; proyectos.push(...(p2 || []));
    facturaProyectos.length = 0; facturaProyectos.push(...(fp2 || []));
    facturas.length = 0; facturas.push(...(f2 || []));
    ledger = construirLedger(proyectos, facturaProyectos);
    facturasReales = (facturas || []).filter(f => f.tipo === "factura");
    Object.keys(vinculoPorProyecto).forEach(k => delete vinculoPorProyecto[k]);
    (facturaProyectos || []).forEach(fp => { if (fp.facturas && fp.facturas.tipo === "factura") vinculoPorProyecto[fp.proyecto_id] = fp.factura_id; });
  }

  // Al renumerar o desasignar, la factura antigua puede quedarse sin ningún
  // proyecto detrás. Si además es un borrador sin importe, es basura: ocupa un
  // número que Josep quiere reutilizar y aparece en el listado de Facturas
  // como una fila fantasma a 0 €. Solo se borran las que cumplen las TRES
  // condiciones (borrador + sin importe + sin proyectos), nunca una emitida.
  async function limpiarFacturasHuerfanas() {
    const { data: fpTodos } = await db.from("factura_proyectos").select("factura_id").exec();
    const usadas = new Set((fpTodos || []).map(x => x.factura_id));
    const { data: todas } = await db.from("facturas").select("*").exec();
    const huerfanas = (todas || []).filter(f =>
      f.tipo === "factura" &&
      f.estado === "borrador" &&
      Number(f.total || 0) === 0 &&
      !usadas.has(f.id)
    );
    for (const f of huerfanas) {
      await db.from("facturas").delete().eq("id", f.id).exec();
    }
    return huerfanas.map(f => f.numero);
  }

  function pintar(anio) {
    const { desde, hasta } = rangoAnio(anio);
    const r = resumenPeriodo(ledger, gastos, desde, hasta);
    const filasAnio = r.filas;

    container.querySelector("#resumen-anual").innerHTML = `
      <div class="card kpi"><div class="label">Total facturado ${anio}</div><div class="value">${eur(r.totalBase)}</div><div class="stat-note">${eur(r.totalConIva)} con IVA</div></div>
      <div class="card kpi"><div class="label">Por transferencia</div><div class="value" style="color:${FORMAS_PAGO.transferencia.fg}">${eur(r.transferencia)}</div><div class="stat-note">lo que se declara a Hacienda</div></div>
      <div class="card kpi"><div class="label">En efectivo</div><div class="value" style="color:${FORMAS_PAGO.efectivo.fg}">${eur(r.efectivo)}</div><div class="stat-note">fuera del balance fiscal</div></div>
      <div class="card kpi dark"><div class="label">Gastos deducibles ${anio}</div><div class="value">${eur(r.gastosDeducibles)}</div><div class="stat-note">amortizaciones ya prorrateadas</div></div>
    `;

    const $body = container.querySelector("#meses-body");
    $body.innerHTML = MESES.map((nombreMes, idx) => {
      const filasMes = filasAnio.filter(f => new Date(f.fecha).getMonth() === idx)
        .sort((a,b) => (a.proyecto.nombre||"").localeCompare(b.proyecto.nombre||""));
      const totalMes = round2(filasMes.reduce((s,f)=>s+f.importeBase,0));
      // Nombre e importe en columnas de ancho fijo y la acción anclada a la
      // derecha: así los 12 meses quedan alineados entre sí (antes cada fila
      // colocaba el botón en una posición distinta, ver comentario en el CSS).
      const cabecera = `
        <summary>
          <span class="mes-nombre">${nombreMes}</span>
          <span class="mes-total">${eur(totalMes)}</span>
          <span class="mes-meta">${filasMes.length ? `${filasMes.length} proyecto${filasMes.length===1?"":"s"}` : "sin proyectos"}</span>
          <span class="mes-accion">
            <button class="btn btn-ghost btn-sm btn-add-mes" data-mes="${idx}" onclick="event.preventDefault(); event.stopPropagation();">+ Añadir proyecto</button>
          </span>
        </summary>`;
      const abierto = mesesAbiertos.has(idx) ? "open" : "";
      if (!filasMes.length) {
        return `<details class="card" data-mes="${idx}" style="margin-bottom:10px;" ${abierto}>${cabecera}<div class="add-proyecto-mes" data-mes="${idx}"></div><p class="muted" style="margin-top:10px;">Sin proyectos este mes.</p></details>`;
      }
      return `
      <details class="card" data-mes="${idx}" style="margin-bottom:10px;" ${abierto}>
        ${cabecera}
        <div class="add-proyecto-mes" data-mes="${idx}"></div>
        <table style="margin-top:10px;">
          <thead><tr><th>Proyecto</th><th>Cliente</th><th>Nº factura</th><th class="money">Importe</th><th class="money">Importe c/IVA</th><th>Forma de pago</th><th style="text-align:center;">Emitida</th><th style="text-align:center;">Pagada</th></tr></thead>
          <tbody>
            ${filasMes.map((f, i) => {
              const fp = FORMAS_PAGO[f.proyecto.forma_pago || "transferencia"];
              // El efectivo no repercute IVA, así que mostrar un "importe c/IVA"
              // calculado inducía a error al cuadrar el 303.
              const esEfectivo = (f.proyecto.forma_pago || "transferencia") !== "transferencia";
              const estado = estadoEfectivo(f);
              const emitida = estado === "emitida" || estado === "pagada";
              const pagada = estado === "pagada";
              const facturaSeleccionada = vinculoPorProyecto[f.proyecto.id] || "";
              return `<tr data-row="${idx}-${i}">
                <td class="link-proyecto" data-proyecto-id="${f.proyecto.id}" style="cursor:pointer; color:var(--blue);">${escapeHtml(f.proyecto.nombre)}</td>
                <td>
                  <select class="sel-cliente cell-select" data-proyecto-id="${f.proyecto.id}" style="min-width:130px;">
                    <option value="">— Sin cliente —</option>
                    ${(clientes||[]).map(c => `<option value="${c.id}" ${c.id===f.proyecto.cliente_id?"selected":""}>${escapeHtml(c.nombre)}</option>`).join("")}
                    <option value="__nuevo__">+ Nuevo cliente…</option>
                  </select>
                </td>
                <td>
                  <select class="sel-factura cell-select" data-proyecto-id="${f.proyecto.id}" style="min-width:120px;">
                    <option value="">— Sin factura —</option>
                    ${(() => {
                      // Una opción por NÚMERO. Si por un fallo antiguo hubiera
                      // dos facturas con el mismo número, salían dos opciones
                      // idénticas e imposibles de distinguir; se queda la que
                      // este proyecto tiene vinculada, o la primera.
                      const vistos = new Map();
                      facturasReales.forEach(fa => {
                        const k = fa.numero.trim().toLowerCase();
                        if (!vistos.has(k) || fa.id === facturaSeleccionada) vistos.set(k, fa);
                      });
                      return [...vistos.values()]
                        .map(fa => `<option value="${fa.id}" ${fa.id===facturaSeleccionada?"selected":""}>${escapeHtml(fa.numero)}</option>`)
                        .join("");
                    })()}
                    <option value="__nueva__">+ Generar nueva…</option>
                  </select>
                </td>
                <td class="money">${eur(f.importeBase)}</td>
                ${esEfectivo
                  ? `<td class="money muted" title="Los cobros en efectivo no llevan IVA repercutido: no entran en el Modelo 303."><span style="text-decoration:line-through; opacity:.5;">${eur(conIva(f.importeBase))}</span> <span style="font-size:10.5px;">sin IVA</span></td>`
                  : `<td class="money muted">${eur(conIva(f.importeBase))}</td>`}
                <td>
                  <select class="sel-forma cell-select" data-proyecto-id="${f.proyecto.id}">
                    <option value="transferencia" ${f.proyecto.forma_pago!=="efectivo"?"selected":""}>Transferencia</option>
                    <option value="efectivo" ${f.proyecto.forma_pago==="efectivo"?"selected":""}>Efectivo</option>
                  </select>
                </td>
                <td style="text-align:center;"><input type="checkbox" class="chk-emitida" data-proyecto-id="${f.proyecto.id}" data-factura-id="${f.facturaId||""}" ${emitida?"checked":""}></td>
                <td style="text-align:center;"><input type="checkbox" class="chk-pagada" data-proyecto-id="${f.proyecto.id}" data-factura-id="${f.facturaId||""}" ${pagada?"checked":""}></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </details>`;
    }).join("");

    // Recuerda qué meses abre/cierra el usuario a mano, para que sobrevivan a
    // los repintados tras cada edición inline (ver comentario en mesesAbiertos).
    $body.querySelectorAll("details[data-mes]").forEach(det => {
      det.addEventListener("toggle", () => {
        const mes = Number(det.dataset.mes);
        if (det.open) mesesAbiertos.add(mes); else mesesAbiertos.delete(mes);
      });
    });

    $body.querySelectorAll(".link-proyecto").forEach(td => {
      td.addEventListener("click", () => { location.hash = `#/proyectos/${td.dataset.proyectoId}`; });
    });

    // --- Botón "+ Añadir proyecto" por mes: abre un mini-formulario inline ---
    $body.querySelectorAll(".btn-add-mes").forEach(btn => {
      btn.addEventListener("click", () => {
        const mes = Number(btn.dataset.mes);
        // El botón vive dentro del <summary> del <details> del mes. Un <details>
        // cerrado oculta con CSS nativo todo lo que no sea el <summary> (incluido
        // este formulario), así que si el mes está colapsado hay que abrirlo a
        // mano — el toggle nativo del navegador no siempre se dispara cuando el
        // clic viene de un elemento interactivo anidado (este botón) dentro del
        // summary, sobre todo tras el stopPropagation() del onclick inline.
        const $details = $body.querySelector(`details[data-mes="${mes}"]`);
        // Se fuerza en un tick posterior (setTimeout 0): el navegador procesa el
        // toggle nativo del <summary> justo después de que termine de repartir
        // este evento de clic, así que si lo hacemos aquí mismo (síncrono) el
        // toggle nativo lo pisa a continuación y el mes se queda cerrado.
        setTimeout(() => { if ($details && !$details.open) { $details.open = true; mesesAbiertos.add(mes); } }, 0);
        const $slot = $body.querySelector(`.add-proyecto-mes[data-mes="${mes}"]`);
        if ($slot.innerHTML) { $slot.innerHTML = ""; return; }
        // Se limita el selector de fecha al propio mes (min/max) para que no
        // se pueda elegir por error un día de otro mes — p. ej. si el
        // calendario nativo abre mostrando el mes en curso en vez del mes
        // elegido. Así "añadir proyecto" desde un mes concreto siempre
        // respeta ese mes, tanto en el desplegable como al guardar.
        const { desde: minFecha, hasta: maxFecha } = rangoMes(anio, mes);
        $slot.innerHTML = `
          <div class="card" style="background:var(--light); margin:10px 0; padding:14px;">
            <div class="row">
              <div class="field" style="flex:2"><label>Nombre del proyecto</label><input id="np-nombre" placeholder="Ej. Vídeo evento..."></div>
              <div class="field"><label>Cliente</label>
                <select id="np-cliente">
                  <option value="">— Sin cliente —</option>
                  ${(clientes||[]).map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join("")}
                </select>
              </div>
            </div>
            <div class="row">
              <div class="field"><label>Importe (€, sin IVA)</label><input id="np-importe" type="number" step="0.01" value="0"></div>
              <div class="field"><label>Forma de pago</label>
                <select id="np-forma"><option value="transferencia">Transferencia</option><option value="efectivo">Efectivo</option></select>
              </div>
              <div class="field"><label>Fecha (${nombreMesDe(mes)})</label><input id="np-fecha" type="date" value="${rangoDelMes(anio, mes)}" min="${minFecha}" max="${maxFecha}"></div>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-primary" id="np-guardar">Guardar proyecto</button>
              <button class="btn btn-ghost" id="np-cancelar">Cancelar</button>
            </div>
          </div>`;
        $slot.querySelector("#np-cancelar").addEventListener("click", () => { $slot.innerHTML = ""; });
        $slot.querySelector("#np-guardar").addEventListener("click", async () => {
          const nombre = $slot.querySelector("#np-nombre").value.trim();
          if (!nombre) { toastError("Ponle un nombre al proyecto."); $slot.querySelector("#np-nombre").focus(); return; }
          let fecha = $slot.querySelector("#np-fecha").value || rangoDelMes(anio, mes);
          // Red de seguridad: si por lo que sea la fecha se sale del mes
          // elegido (pegado manual, autocompletado del navegador...), se
          // fuerza de vuelta al mes correcto en vez de dejar que el proyecto
          // "salte" a otro mes silenciosamente.
          if (fecha < minFecha || fecha > maxFecha) fecha = rangoDelMes(anio, mes);
          const payload = {
            cliente_id: $slot.querySelector("#np-cliente").value || null,
            nombre,
            estado: "en_curso",
            fecha_inicio: fecha,
            fecha_entrega: fecha,
            precio_acordado: Number($slot.querySelector("#np-importe").value || 0),
            forma_pago: $slot.querySelector("#np-forma").value,
            estado_facturacion: "pendiente",
            entregables: [],
          };
          const { error } = await db.from("proyectos").insert(payload).exec();
          if (error) { toastError("No se ha podido crear el proyecto: " + error); return; }
          toastOk(`"${nombre}" añadido a ${nombreMesDe(mes)}.`);
          await recargarDatos();
          pintar(anio);
        });
      });
    });

    // --- Desplegables inline: cliente, factura, forma de pago ---
    $body.querySelectorAll(".sel-cliente").forEach(sel => {
      sel.addEventListener("change", async () => {
        if (sel.value === "__nuevo__") { location.hash = "#/clientes/nuevo"; return; }
        await db.from("proyectos").update({ cliente_id: sel.value || null }).eq("id", sel.dataset.proyectoId).exec();
        const p = proyectos.find(x => x.id === sel.dataset.proyectoId);
        if (p) p.cliente_id = sel.value || null;
      });
    });
    $body.querySelectorAll(".sel-forma").forEach(sel => {
      sel.addEventListener("change", async () => {
        await db.from("proyectos").update({ forma_pago: sel.value }).eq("id", sel.dataset.proyectoId).exec();
        const p = proyectos.find(x => x.id === sel.dataset.proyectoId);
        if (p) p.forma_pago = sel.value;
        ledger = construirLedger(proyectos, facturaProyectos);
        pintar(anio);
      });
    });
    $body.querySelectorAll(".sel-factura").forEach(sel => {
      sel.addEventListener("change", async () => {
        const proyectoId = sel.dataset.proyectoId;
        if (sel.value === "__nueva__") {
          // Asigna un número de factura nuevo sin salir de Facturación mensual:
          // sustituye el desplegable por un campo inline para elegir/confirmar
          // el número. La factura se crea "vacía" (sin líneas propias); cuando
          // el usuario la abra para emitirla, el editor construye las líneas a
          // partir de TODOS los proyectos vinculados a este mismo número (ver
          // facturacion.js renderEditor), así que basta con repetir el mismo
          // número en varios proyectos para agruparlos en un solo documento.
          const sugerido = await nextNumero();
          const $celda = sel.closest("td");
          $celda.innerHTML = `
            <div style="display:flex; gap:4px; align-items:center;">
              <input class="np-numero-factura" type="text" value="${escapeHtml(sugerido)}" style="width:90px;">
              <button class="btn btn-primary btn-confirmar-numero" type="button" style="padding:4px 8px; font-size:12px;">OK</button>
              <button class="btn btn-ghost btn-cancelar-numero" type="button" style="padding:4px 8px; font-size:12px;">✕</button>
            </div>`;
          const $input = $celda.querySelector(".np-numero-factura");
          $input.focus();
          $input.select();
          $celda.querySelector(".btn-cancelar-numero").addEventListener("click", () => pintar(anio));
          const confirmar = async () => {
            const numero = $input.value.trim();
            if (!numero) { pintar(anio); return; }
            const p = proyectos.find(x => x.id === proyectoId);

            // Si ese número YA existe, se reutiliza esa factura en vez de crear
            // otra igual. Antes se insertaba siempre, así que teclear un número
            // ya usado creaba una segunda factura con el mismo número: en el
            // desplegable salían dos opciones idénticas, el proyecto quedaba
            // colgado de una y el listado de Facturas mostraba la otra.
            // Reutilizar es además el comportamiento que hace falta para
            // agrupar varios proyectos en una misma factura.
            const yaExiste = facturasReales.find(
              fa => fa.numero.trim().toLowerCase() === numero.toLowerCase()
            );

            let facturaId = yaExiste?.id;
            if (!facturaId) {
              const { data, error } = await db.from("facturas").insert({
                numero,
                cliente_id: p?.cliente_id || null,
                tipo: "factura",
                fecha: p?.fecha_entrega || p?.fecha_inicio || todayIso(),
              }).exec();
              if (error) { toastError("No se ha podido crear la factura: " + error); pintar(anio); return; }
              facturaId = Array.isArray(data) ? data[0]?.id : data?.id;
            }

            await db.from("factura_proyectos").delete().eq("proyecto_id", proyectoId).exec();
            await db.from("factura_proyectos").insert({ factura_id: facturaId, proyecto_id: proyectoId, importe: Number(p?.precio_acordado || 0) }).exec();
            await limpiarFacturasHuerfanas();
            toastOk(yaExiste
              ? `Proyecto añadido a la factura ${numero}.`
              : `Factura ${numero} creada y vinculada.`);
            await recargarDatos();
            pintar(anio);
          };
          $celda.querySelector(".btn-confirmar-numero").addEventListener("click", confirmar);
          $input.addEventListener("keydown", e => { if (e.key === "Enter") confirmar(); if (e.key === "Escape") pintar(anio); });
          return;
        }
        // Quita cualquier vínculo anterior de este proyecto con una factura real.
        await db.from("factura_proyectos").delete().eq("proyecto_id", proyectoId).exec();
        if (sel.value) {
          const p = proyectos.find(x => x.id === proyectoId);
          await db.from("factura_proyectos").insert({ factura_id: sel.value, proyecto_id: proyectoId, importe: Number(p?.precio_acordado || 0) }).exec();
        }
        await limpiarFacturasHuerfanas();
        await recargarDatos();
        pintar(anio);
      });
    });

    // --- Casillas emitida/pagada: se pueden marcar y desmarcar libremente ---
    async function setEstadoProyecto(proyectoId, nuevoEstado) {
      await db.from("proyectos").update({ estado_facturacion: nuevoEstado }).eq("id", proyectoId).exec();
      const p = proyectos.find(x => x.id === proyectoId);
      if (p) p.estado_facturacion = nuevoEstado;
      ledger = construirLedger(proyectos, facturaProyectos);
      pintar(anio);
    }
    async function setEstadoFactura(facturaId, nuevoEstado) {
      await db.from("facturas").update({ estado: nuevoEstado }).eq("id", facturaId).exec();
      (facturaProyectos || []).forEach(fp => { if (fp.factura_id === facturaId && fp.facturas) fp.facturas.estado = nuevoEstado; });
      ledger = construirLedger(proyectos, facturaProyectos);
      pintar(anio);
    }

    $body.querySelectorAll(".chk-emitida").forEach(chk => {
      chk.addEventListener("click", async (e) => {
        e.preventDefault();
        // El navegador ya ha cambiado chk.checked al nuevo valor antes de disparar
        // este evento "click" (aunque luego preventDefault() lo revierta visualmente),
        // así que chk.checked YA es la intención del usuario: no hay que negarlo.
        const marcando = chk.checked;
        const facturaId = chk.dataset.facturaId;
        if (facturaId) {
          await setEstadoFactura(facturaId, marcando ? "emitida" : "borrador");
        } else {
          await setEstadoProyecto(chk.dataset.proyectoId, marcando ? "emitida" : "pendiente");
        }
      });
    });
    $body.querySelectorAll(".chk-pagada").forEach(chk => {
      chk.addEventListener("click", async (e) => {
        e.preventDefault();
        const marcando = chk.checked;
        const facturaId = chk.dataset.facturaId;
        if (facturaId) {
          await setEstadoFactura(facturaId, marcando ? "pagada" : "emitida");
        } else {
          await setEstadoProyecto(chk.dataset.proyectoId, marcando ? "pagada" : "emitida");
        }
      });
    });
  }
}

function rangoDelMes(anio, mesIdx) {
  const hoy = new Date();
  const dia = (anio === hoy.getFullYear() && mesIdx === hoy.getMonth()) ? hoy.getDate() : 1;
  return `${anio}-${String(mesIdx+1).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
}
function nombreMesDe(mesIdx) {
  return MESES[mesIdx];
}
