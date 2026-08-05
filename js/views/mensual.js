import { db } from "../supabase.js";
import { abrirFichaProyecto } from "./proyectos.js";
import { eur, FORMAS_PAGO, todayIso } from "../utils/format.js";
import { round2 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, rangoAnio, rangoMes, conIva, estadoEfectivo, conIvaSegunPago } from "../utils/resumen.js";
import { escapeHtml } from "./clientes.js";
import { nextNumero } from "./facturacion.js";
import { toastOk, toastError, skeletonPagina, engancharArrastre } from "../utils/ui.js";

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

  // Reasigna (o desasigna) un proyecto manteniendo la factura ENTERA en
  // sincronía, no solo la tabla de vínculos.
  //
  // El bug que arregla: una factura guarda sus conceptos en `facturas.lineas`
  // (jsonb) además del vínculo en `factura_proyectos`. Al quitarle aquí la
  // factura a un proyecto solo se borraba el vínculo, así que al abrir esa
  // factura desde Facturas el proyecto seguía dentro — y si se guardaba,
  // sincronizarFacturaProyectos volvía a crear el vínculo y el proyecto
  // quedaba reasignado sin que Josep hubiera hecho nada. Pasaba lo mismo al
  // revés: asignar un proyecto a una factura que ya tenía líneas guardadas no
  // añadía su línea, y al guardar la factura el vínculo desaparecía.
  //
  // Ojo: solo se tocan las líneas de las facturas que DEJAN de tener este
  // proyecto. Si vuelve a asignarse a la misma factura, se deja como estaba.
  async function reasignarFactura(proyectoId, nuevaFacturaId) {
    const { data: previos } = await db.from("factura_proyectos")
      .select("factura_id").eq("proyecto_id", proyectoId).exec();

    await db.from("factura_proyectos").delete().eq("proyecto_id", proyectoId).exec();

    const proyecto = proyectos.find(x => x.id === proyectoId);
    if (nuevaFacturaId) {
      await db.from("factura_proyectos").insert({
        factura_id: nuevaFacturaId,
        proyecto_id: proyectoId,
        importe: Number(proyecto?.precio_acordado || 0),
      }).exec();
    }

    const antiguas = [...new Set((previos || []).map(v => v.factura_id))]
      .filter(id => id && id !== nuevaFacturaId);
    for (const id of antiguas) await quitarLineasDeProyecto(id, proyectoId);
    if (nuevaFacturaId) await anadirLineaDeProyecto(nuevaFacturaId, proyecto);
  }

  // Saca del jsonb las líneas que apuntan a este proyecto. Las que no tienen
  // proyecto asignado se quedan: son conceptos que él ha escrito a mano y no
  // hay forma de saber que fueran de este proyecto.
  async function quitarLineasDeProyecto(facturaId, proyectoId) {
    const { data: f } = await db.from("facturas").select("lineas").eq("id", facturaId).single().exec();
    if (!f || !Array.isArray(f.lineas) || !f.lineas.length) return;
    const quedan = f.lineas.filter(l => String(l.proyecto_id || "") !== String(proyectoId));
    if (quedan.length !== f.lineas.length) {
      await db.from("facturas").update({ lineas: quedan }).eq("id", facturaId).exec();
    }
  }

  // Solo si la factura YA tiene líneas propias. Las que nacen aquí se quedan
  // vacías a propósito: el editor las reconstruye desde los vínculos, y así
  // varios proyectos con el mismo número se agrupan en un único documento.
  async function anadirLineaDeProyecto(facturaId, proyecto) {
    if (!proyecto) return;
    const { data: f } = await db.from("facturas").select("lineas").eq("id", facturaId).single().exec();
    if (!f || !Array.isArray(f.lineas) || !f.lineas.length) return;
    if (f.lineas.some(l => String(l.proyecto_id || "") === String(proyecto.id))) return;
    const lineas = [...f.lineas, {
      concepto: proyecto.nombre || "Proyecto",
      cantidad: 1,
      precio: Number(proyecto.precio_acordado || 0),
      proyecto_id: proyecto.id,
      descripcion: "",
      descuento_tipo: "porcentaje",
      descuento_valor: 0,
    }];
    await db.from("facturas").update({ lineas }).eq("id", facturaId).exec();
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

    // Totales de los 12 meses primero, para no recalcularlos en cada vuelta.
    const totalPorMes = MESES.map((_, i) =>
      round2(filasAnio.filter(f => new Date(f.fecha).getMonth() === i).reduce((s, f) => s + f.importeBase, 0)));
    const mesActual = (anio === new Date().getFullYear()) ? new Date().getMonth() : -1;

    const $body = container.querySelector("#meses-body");
    $body.innerHTML = MESES.map((nombreMes, idx) => {
      // El orden lo manda la columna `orden` del proyecto, que Josep coloca
      // arrastrando las filas. Los que aún no se han ordenado a mano van
      // detrás y entre ellos por nombre, como se hacía antes.
      const filasMes = filasAnio.filter(f => new Date(f.fecha).getMonth() === idx)
        .sort((a, b) => {
          const oa = a.proyecto.orden, ob = b.proyecto.orden;
          if (oa != null && ob != null) return oa - ob;
          if (oa != null) return -1;
          if (ob != null) return 1;
          return (a.proyecto.nombre || "").localeCompare(b.proyecto.nombre || "");
        });
      const totalMes = totalPorMes[idx];
      const totalConIvaMes = round2(filasMes.reduce((s, f) => s + conIvaSegunPago(f.importeBase, f.proyecto.forma_pago), 0));
      const cobradoMes = round2(filasMes.filter(f => estadoEfectivo(f) === "pagada").reduce((s, f) => s + f.importeBase, 0));
      const pendienteMes = round2(totalMes - cobradoMes);
      const nCobrados = filasMes.filter(f => estadoEfectivo(f) === "pagada").length;
      const pctCobrado = totalMes ? Math.round(cobradoMes / totalMes * 100) : 0;
      // Nombre e importe en columnas de ancho fijo y la acción anclada a la
      // derecha: así los 12 meses quedan alineados entre sí (antes cada fila
      // colocaba el botón en una posición distinta, ver comentario en el CSS).
      // La barra dice qué parte del mes está ya cobrada: verde lo cobrado,
      // ámbar lo que falta. Antes comparaba el mes con el mejor del año, un
      // dato que no casaba con el texto de al lado y confundía más que ayudaba.
      const cabecera = `
        <summary>
          <span class="mes-nombre">${nombreMes}${idx === mesActual ? `<span class="mes-hoy">actual</span>` : ""}</span>
          <span class="mes-total">${eur(totalMes)}</span>
          <span class="mes-barra${totalMes ? "" : " vacia"}" title="${totalMes ? `Cobrado ${eur(cobradoMes)} de ${eur(totalMes)} (${pctCobrado}%)` : "sin facturación"}"><i style="width:${pctCobrado}%"></i></span>
          <span class="mes-meta">${
            filasMes.length
              ? `${filasMes.length} proyecto${filasMes.length === 1 ? "" : "s"}` +
                (pendienteMes > 0
                  ? ` · <span class="mes-pend">${eur(pendienteMes)} por cobrar</span>`
                  : ` · <span class="mes-ok">todo cobrado</span>`)
              : "sin proyectos"
          }</span>
          <span class="mes-accion">
            <button class="btn btn-ghost btn-sm btn-add-mes" data-mes="${idx}" onclick="event.preventDefault(); event.stopPropagation();">+ Añadir proyecto</button>
          </span>
        </summary>`;
      const abierto = mesesAbiertos.has(idx) ? "open" : "";
      if (!filasMes.length) {
        return `<details class="card mes-vacio" data-mes="${idx}" style="margin-bottom:10px;" ${abierto}>${cabecera}<div class="add-proyecto-mes" data-mes="${idx}"></div><p class="muted" style="margin-top:10px;">Sin proyectos este mes.</p></details>`;
      }
      return `
      <details class="card${idx === mesActual ? " mes-actual" : ""}" data-mes="${idx}" style="margin-bottom:10px;" ${abierto}>
        ${cabecera}
        <div class="add-proyecto-mes" data-mes="${idx}"></div>
        <table style="margin-top:10px;">
          <thead><tr><th class="col-mover"></th><th>Proyecto</th><th>Cliente</th><th>Nº factura</th><th class="money">Importe</th><th class="money">Importe c/IVA</th><th>Forma de pago</th><th style="text-align:center;">Emitida</th><th style="text-align:center;">Pagada</th></tr></thead>
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
              // Estado de la fila. IMPORTANTE: Josep es daltónico, así que el
              // color NUNCA puede ser la única pista. Lo que distingue los tres
              // estados es la FORMA de la línea del margen izquierdo:
              //   sin facturar → sin línea
              //   emitida      → línea a trazos
              //   cobrada      → línea continua (y el nombre en gris)
              // El color solo refuerza, y el tooltip lo dice con palabras.
              const claseEstado = pagada ? "cobrada" : (emitida ? "emitida" : "sinfacturar");
              const tituloEstado = pagada ? "Cobrada" : (emitida ? "Emitida, pendiente de cobro" : "Sin facturar");
              return `<tr class="fila-${claseEstado}" data-row="${idx}-${i}" data-idx="${i}" data-mes-fila="${idx}">
                <td class="col-mover"><span class="mover-tirador" title="Arrastra para cambiar el orden">⠿</span></td>
                <td class="link-proyecto" data-proyecto-id="${f.proyecto.id}" title="${tituloEstado}" style="cursor:pointer;"><span class="nombre-proyecto">${escapeHtml(f.proyecto.nombre)}</span></td>
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
          <tfoot>
            <tr class="fila-total-mes">
              <td colspan="4">Total ${nombreMes}${nCobrados ? ` · ${nCobrados} de ${filasMes.length} cobrado${nCobrados === 1 ? "" : "s"}` : ""}</td>
              <td class="money">${eur(totalMes)}</td>
              <td class="money">${eur(totalConIvaMes)}</td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
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

    // --- Reordenar proyectos arrastrando, mes a mes ---
    // El orden se guarda en la columna `orden` del proyecto (migración 010).
    // Se renumera el mes entero de 1 a N en vez de tocar solo las dos filas
    // movidas: así el orden queda siempre compacto y sin empates, aunque haya
    // proyectos que nunca se hubieran ordenado a mano.
    $body.querySelectorAll("details[data-mes] table tbody").forEach(tbody => {
      const mesIdx = Number(tbody.closest("details[data-mes]").dataset.mes);
      engancharArrastre(tbody, "tr[data-idx]", ".mover-tirador", async (desde, hasta) => {
        if (desde === hasta || Number.isNaN(desde) || Number.isNaN(hasta)) return;
        const delMes = filasAnio
          .filter(f => new Date(f.fecha).getMonth() === mesIdx)
          .sort((a, b) => {
            const oa = a.proyecto.orden, ob = b.proyecto.orden;
            if (oa != null && ob != null) return oa - ob;
            if (oa != null) return -1;
            if (ob != null) return 1;
            return (a.proyecto.nombre || "").localeCompare(b.proyecto.nombre || "");
          });
        const [movida] = delMes.splice(desde, 1);
        if (!movida) return;
        delMes.splice(hasta, 0, movida);

        // Se pinta ya con el orden nuevo y se guarda después: si Supabase
        // falla, el aviso lo dice y el siguiente repintado devuelve la verdad.
        delMes.forEach((f, i) => { f.proyecto.orden = i + 1; });
        pintar(anio);
        try {
          await Promise.all(delMes.map(f =>
            db.from("proyectos").update({ orden: f.proyecto.orden }).eq("id", f.proyecto.id).exec()
          ));
        } catch (e) {
          toastError("No se ha podido guardar el orden.");
        }
      });
    });

    $body.querySelectorAll(".link-proyecto").forEach(td => {
      // Antes saltaba a la sección Proyectos y perdías el mes que estabas
      // revisando. Ahora se edita en el mismo diálogo, aquí mismo.
      td.addEventListener("click", async () => {
        const { data } = await db.from("proyectos").select("*").eq("id", td.dataset.proyectoId).single().exec();
        if (!data) { location.hash = `#/proyectos/${td.dataset.proyectoId}`; return; }
        abrirFichaProyecto(data, null, () => renderMensual(container));
      });
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

            await reasignarFactura(proyectoId, facturaId);
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
        await reasignarFactura(proyectoId, sel.value || null);
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
