import { db } from "../supabase.js";
import { ESTADOS_FACTURA, ESTADOS_COBRO, FORMAS_PAGO, CATEGORIAS_SERVICIO, eur, dateEs, todayIso } from "../utils/format.js";
import { construirLedger, conIva, estadoEfectivo, rangoAnio, resumenPeriodo } from "../utils/resumen.js";
import { round2 } from "../utils/invoice-calc.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

export async function renderProyectos(container, param) {
  container.innerHTML = `<div class="empty-state">Cargando proyectos…</div>`;

  const [{ data: clientes }, { data: proyectos, error }, { data: facturaProyectos }, { data: gastos }] = await Promise.all([
    db.from("clientes").select("id,nombre").order("nombre").exec(),
    db.from("proyectos").select("*").order("created_at", { ascending: false }).exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("gastos").select("id,proyecto_id").exec(),
  ]);
  if (error) { container.innerHTML = `<p class="muted">Error cargando proyectos: ${error}</p>`; return; }

  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  const ledger = construirLedger(proyectos, facturaProyectos);
  const ledgerPorProyecto = Object.fromEntries(ledger.map(f => [f.proyecto.id, f]));
  const anioActual = new Date().getFullYear();
  const { desde, hasta } = rangoAnio(anioActual);
  const resumenAnual = resumenPeriodo(ledger, gastos, desde, hasta);

  container.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="card kpi"><div class="label">Proyectos totales</div><div class="value">${(proyectos||[]).length}</div></div>
      <div class="card kpi"><div class="label">Sin cobrar</div><div class="value" style="color:var(--amber-fg,#8A6A10)">${ledger.filter(f=>estadoEfectivo(f)!=="pagada").length}</div></div>
      <div class="card kpi"><div class="label">Cobrado ${anioActual}</div><div class="value" style="color:var(--green-fg)">${eur(resumenAnual.transferenciaPagada + resumenAnual.efectivoPagada)}</div></div>
      <div class="card kpi dark"><div class="label">Facturado ${anioActual}</div><div class="value">${eur(resumenAnual.totalBase)}</div></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3>Qué es lo que más hago</h3>
        <p class="muted" style="font-size:12px; margin-top:-4px;">Por tipo de servicio, todos los proyectos.</p>
        <div id="categoria-chips" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
      </div>
      <div class="card">
        <h3>Clientes más habituales</h3>
        <div id="top-clientes"></div>
      </div>
    </div>

    <div style="display:flex; justify-content:space-between; gap:10px; margin-bottom:14px; flex-wrap:wrap; align-items:center;">
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input id="filtro-buscar" placeholder="Buscar proyecto o cliente…" style="width:220px;">
        <select id="filtro-cliente" style="width:auto;">
          <option value="">Todos los clientes</option>
          ${(clientes||[]).map(c=>`<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join("")}
        </select>
      </div>
      <button class="btn btn-primary" id="btn-nuevo-proyecto">+ Nuevo proyecto</button>
    </div>
    <div id="filtro-chips" style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;"></div>

    <div class="card" style="padding:0; overflow-x:auto;">
      <table>
        <thead><tr>
          <th style="padding-left:18px;">Proyecto</th><th>Cliente</th><th>Categoría</th><th>Fecha</th><th>Importe c/IVA</th>
          <th>Forma de pago</th><th>Estado</th><th style="padding-right:18px;"></th>
        </tr></thead>
        <tbody id="tbl-proyectos"></tbody>
      </table>
    </div>
    <div id="proyecto-detalle"></div>
  `;

  let filtroCategoria = "";
  function pintarAnalitica() {
    // --- "Qué es lo que más hago" (por categoría de servicio) ---
    const porCategoriaServicio = {};
    (proyectos||[]).forEach(p => {
      const k = p.categoria_servicio || "otros";
      (porCategoriaServicio[k] ||= { count: 0, total: 0 }).count++;
      const f = ledgerPorProyecto[p.id];
      porCategoriaServicio[k].total = round2(porCategoriaServicio[k].total + conIva(f ? f.importeBase : (p.precio_acordado||0)));
    });
    const entradas = Object.entries(porCategoriaServicio).sort((a,b)=>b[1].count-a[1].count);
    const $catChips = container.querySelector("#categoria-chips");
    $catChips.innerHTML = `
      <button class="chip-cat" data-cat="" style="background:${filtroCategoria===""?"var(--navy)":"var(--light)"}; color:${filtroCategoria===""?"#fff":"var(--text)"};">Todas · ${(proyectos||[]).length}</button>
      ${entradas.map(([k,v]) => {
        const cat = CATEGORIAS_SERVICIO[k] || CATEGORIAS_SERVICIO.otros;
        const activo = filtroCategoria === k;
        return `<button class="chip-cat" data-cat="${k}" style="background:${activo?cat.fg:cat.bg}; color:${activo?"#fff":cat.fg};">${cat.label} · ${v.count} <span style="opacity:.7">(${eur(v.total)})</span></button>`;
      }).join("")}
    `;
    $catChips.querySelectorAll(".chip-cat").forEach(btn => {
      btn.addEventListener("click", () => { filtroCategoria = btn.dataset.cat; pintarAnalitica(); pintarTabla(); });
    });

    // --- Clientes más habituales ---
    const porCliente = {};
    (proyectos||[]).forEach(p => {
      if (!p.cliente_id) return;
      (porCliente[p.cliente_id] ||= { count: 0, total: 0 }).count++;
      const f = ledgerPorProyecto[p.id];
      porCliente[p.cliente_id].total = round2(porCliente[p.cliente_id].total + conIva(f ? f.importeBase : (p.precio_acordado||0)));
    });
    const topClientes = Object.entries(porCliente).sort((a,b)=>b[1].count-a[1].count).slice(0,5);
    container.querySelector("#top-clientes").innerHTML = topClientes.length ? `
      <table style="margin:0;">
        <tbody>
          ${topClientes.map(([id,v],i) => `<tr>
            <td style="font-weight:${i===0?700:400};">${escapeHtml(clientesMap[id]||"—")}${i===0?` <span class="badge" style="background:var(--green-bg,#E3F1EA); color:var(--green-fg,#2E7D53); margin-left:4px;">Principal</span>`:""}</td>
            <td class="muted">${v.count} proyecto${v.count===1?"":"s"}</td>
            <td style="text-align:right; font-weight:600;">${eur(v.total)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    ` : `<p class="muted" style="font-size:13px;">Sin clientes asignados todavía.</p>`;
  }
  pintarAnalitica();

  container.querySelector("#btn-nuevo-proyecto").addEventListener("click", () => abrirFicha(container, null, clientes || [], recargarYPintar));

  let filtroEstado = "";
  const $chips = container.querySelector("#filtro-chips");
  function pintarChips() {
    const opciones = [["", "Todos"], ...Object.entries(ESTADOS_COBRO).map(([k,v])=>[k,v.label])];
    $chips.innerHTML = opciones.map(([k,label]) => {
      const activo = filtroEstado === k;
      const cat = k ? ESTADOS_COBRO[k] : { bg: "var(--navy)", fg: "#fff" };
      return `<button class="chip-cat" data-estado="${k}" style="background:${activo?(k?cat.fg:"var(--navy)"):"var(--light)"}; color:${activo?"#fff":"var(--text)"};">${label}</button>`;
    }).join("");
    $chips.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => { filtroEstado = btn.dataset.estado; pintarChips(); pintarTabla(); }));
  }
  pintarChips();

  const $buscar = container.querySelector("#filtro-buscar");
  const $filtroCliente = container.querySelector("#filtro-cliente");
  $buscar.addEventListener("input", pintarTabla);
  $filtroCliente.addEventListener("change", pintarTabla);

  function pintarTabla() {
    const q = $buscar.value.trim().toLowerCase();
    const clienteId = $filtroCliente.value;
    let lista = (proyectos || []).slice();
    if (q) lista = lista.filter(p => (p.nombre||"").toLowerCase().includes(q) || (clientesMap[p.cliente_id]||"").toLowerCase().includes(q));
    if (clienteId) lista = lista.filter(p => p.cliente_id === clienteId);
    if (filtroEstado) lista = lista.filter(p => { const f = ledgerPorProyecto[p.id]; return f && estadoEfectivo(f) === filtroEstado; });
    if (filtroCategoria) lista = lista.filter(p => (p.categoria_servicio||"otros") === filtroCategoria);
    lista.sort((a,b) => (b.fecha_entrega||b.fecha_inicio||"").localeCompare(a.fecha_entrega||a.fecha_inicio||""));

    const $tbl = container.querySelector("#tbl-proyectos");
    if (!lista.length) { $tbl.innerHTML = `<tr><td colspan="8" class="muted" style="padding:20px; text-align:center;">Sin proyectos con ese filtro.</td></tr>`; return; }

    $tbl.innerHTML = lista.map(p => {
      const f = ledgerPorProyecto[p.id];
      const estado = f ? estadoEfectivo(f) : "pendiente";
      const cat = ESTADOS_COBRO[estado];
      const catServicio = CATEGORIAS_SERVICIO[p.categoria_servicio] || CATEGORIAS_SERVICIO.otros;
      const importeConIva = f ? conIva(f.importeBase) : conIva(p.precio_acordado);
      const nGastos = (gastos||[]).filter(g => g.proyecto_id === p.id).length;
      return `<tr>
        <td class="link-proyecto" data-id="${p.id}" style="padding-left:18px; cursor:pointer; color:var(--blue); font-weight:600;">${escapeHtml(p.nombre)}${nGastos?` <span class="muted" style="font-weight:400; font-size:11px;">· ${nGastos} gasto${nGastos===1?"":"s"}</span>`:""}</td>
        <td>${escapeHtml(clientesMap[p.cliente_id] || "Sin cliente")}</td>
        <td><span class="badge" style="background:${catServicio.bg}; color:${catServicio.fg};">${catServicio.label}</span></td>
        <td class="muted">${dateEs(p.fecha_entrega || p.fecha_inicio)}</td>
        <td>${eur(importeConIva)}</td>
        <td>
          <select class="sel-forma" data-id="${p.id}">
            <option value="transferencia" ${p.forma_pago!=="efectivo"?"selected":""}>Transferencia</option>
            <option value="efectivo" ${p.forma_pago==="efectivo"?"selected":""}>Efectivo</option>
          </select>
        </td>
        <td>
          <select class="sel-estado" data-id="${p.id}" data-factura-id="${f?.facturaId||""}" style="background:${cat.bg}; color:${cat.fg}; border:none; font-weight:600;">
            ${Object.entries(ESTADOS_COBRO).map(([k,v])=>`<option value="${k}" ${k===estado?"selected":""}>${v.label}</option>`).join("")}
          </select>
        </td>
        <td style="padding-right:18px; text-align:right;"><button class="btn btn-ghost btn-editar" data-id="${p.id}" style="font-size:12px; padding:4px 10px;">Editar</button></td>
      </tr>`;
    }).join("");

    $tbl.querySelectorAll(".link-proyecto, .btn-editar").forEach(el => {
      el.addEventListener("click", () => {
        const p = proyectos.find(x => x.id === el.dataset.id);
        abrirFicha(container, p, clientes || [], recargarYPintar);
      });
    });
    $tbl.querySelectorAll(".sel-forma").forEach(sel => {
      sel.addEventListener("change", async () => {
        await db.from("proyectos").update({ forma_pago: sel.value }).eq("id", sel.dataset.id).exec();
        const p = proyectos.find(x => x.id === sel.dataset.id);
        if (p) p.forma_pago = sel.value;
      });
    });
    $tbl.querySelectorAll(".sel-estado").forEach(sel => {
      sel.addEventListener("change", async () => {
        const nuevo = sel.value;
        const facturaId = sel.dataset.facturaId;
        if (facturaId) {
          const mapa = { pendiente: "borrador", emitida: "emitida", pagada: "pagada" };
          await db.from("facturas").update({ estado: mapa[nuevo] }).eq("id", facturaId).exec();
          (facturaProyectos || []).forEach(fp => { if (fp.factura_id === facturaId && fp.facturas) fp.facturas.estado = mapa[nuevo]; });
        } else {
          await db.from("proyectos").update({ estado_facturacion: nuevo }).eq("id", sel.dataset.id).exec();
          const p = proyectos.find(x => x.id === sel.dataset.id);
          if (p) p.estado_facturacion = nuevo;
        }
        await recargarYPintar();
      });
    });
  }

  async function recargarYPintar() {
    const [{ data: p2 }, { data: fp2 }, { data: g2 }] = await Promise.all([
      db.from("proyectos").select("*").order("created_at", { ascending: false }).exec(),
      db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
      db.from("gastos").select("id,proyecto_id").exec(),
    ]);
    proyectos.length = 0; proyectos.push(...(p2 || []));
    facturaProyectos.length = 0; facturaProyectos.push(...(fp2 || []));
    gastos.length = 0; gastos.push(...(g2 || []));
    const ledger2 = construirLedger(proyectos, facturaProyectos);
    Object.keys(ledgerPorProyecto).forEach(k => delete ledgerPorProyecto[k]);
    ledger2.forEach(f => { ledgerPorProyecto[f.proyecto.id] = f; });
    pintarAnalitica();
    pintarTabla();
  }

  pintarTabla();

  if (param && proyectos) {
    const p = proyectos.find(x => x.id === param);
    if (p) abrirFicha(container, p, clientes || [], recargarYPintar);
  }
}

async function abrirFicha(container, proyecto, clientes, onGuardado) {
  const esNuevo = !proyecto;
  proyecto = proyecto || { nombre: "", cliente_id: clientes[0]?.id || "", estado: "en_curso", fecha_inicio: todayIso(), fecha_entrega: "", horas_invertidas: 0, coste_asociado: 0, precio_acordado: 0, entregables: [], forma_pago: "transferencia", estado_facturacion: "pendiente", categoria_servicio: "otros", notas: "" };
  const $detalle = container.querySelector("#proyecto-detalle");

  let gastos = [], facturasVinculadas = [];
  if (!esNuevo) {
    const [g, fp] = await Promise.all([
      db.from("gastos").select("*").eq("proyecto_id", proyecto.id).order("fecha", { ascending: false }).exec(),
      db.from("factura_proyectos").select("importe,factura_id,facturas(numero,tipo,total,estado,fecha)").eq("proyecto_id", proyecto.id).exec(),
    ]);
    gastos = g.data || [];
    facturasVinculadas = fp.data || [];
  }
  const margen = Number(proyecto.precio_acordado || 0) - Number(proyecto.coste_asociado || 0);

  $detalle.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <h3>${esNuevo ? "Nuevo proyecto" : escapeHtml(proyecto.nombre)}</h3>
        <div style="display:flex; gap:8px;">
          ${esNuevo ? "" : `<button class="btn btn-dark" id="btn-generar-factura">Generar factura</button>`}
          <button class="btn btn-ghost" id="btn-cerrar-ficha" type="button">Cerrar</button>
        </div>
      </div>

      <div class="row">
        <div class="field"><label>Nombre del proyecto</label><input id="f-nombre" value="${escapeAttr(proyecto.nombre)}"></div>
        <div class="field"><label>Cliente</label>
          <select id="f-cliente">
            <option value="">— Sin cliente —</option>
            ${clientes.map(c => `<option value="${c.id}" ${c.id === proyecto.cliente_id ? "selected" : ""}>${escapeHtml(c.nombre)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Estado de cobro</label>
          <select id="f-estado-cobro">
            ${Object.entries(ESTADOS_COBRO).map(([k, v]) => `<option value="${k}" ${k === (proyecto.estado_facturacion||"pendiente") ? "selected" : ""}>${v.label}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Tipo de servicio</label>
          <select id="f-categoria-servicio">
            ${Object.entries(CATEGORIAS_SERVICIO).map(([k, v]) => `<option value="${k}" ${k === (proyecto.categoria_servicio||"otros") ? "selected" : ""}>${v.label}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Fecha inicio</label><input type="date" id="f-inicio" value="${proyecto.fecha_inicio || ""}"></div>
        <div class="field"><label>Fecha entrega</label><input type="date" id="f-entrega" value="${proyecto.fecha_entrega || ""}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Horas invertidas</label><input type="number" step="0.5" id="f-horas" value="${proyecto.horas_invertidas || 0}"></div>
        <div class="field"><label>Coste asociado (€)</label><input type="number" step="0.01" id="f-coste" value="${proyecto.coste_asociado || 0}"></div>
        <div class="field"><label>Precio acordado (€, sin IVA)</label><input type="number" step="0.01" id="f-precio" value="${proyecto.precio_acordado || 0}"></div>
        <div class="field"><label>Forma de pago</label>
          <select id="f-forma-pago">
            ${Object.entries(FORMAS_PAGO).map(([k,v]) => `<option value="${k}" ${k===(proyecto.forma_pago||"transferencia")?"selected":""}>${v.label}</option>`).join("")}
          </select>
        </div>
      </div>
      ${esNuevo ? "" : `<p class="muted">Margen estimado: <strong style="color:var(--green-fg)">${eur(margen)}</strong></p>`}
      <div class="field"><label>Entregables (uno por línea)</label><textarea id="f-entregables" rows="3">${(Array.isArray(proyecto.entregables) ? proyecto.entregables : []).join("\n")}</textarea></div>
      <div class="field"><label>Notas</label><textarea id="f-notas" rows="2">${escapeHtml(proyecto.notas || "")}</textarea></div>

      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary" id="btn-guardar-proyecto">Guardar</button>
        ${esNuevo ? "" : `<button class="btn btn-ghost" id="btn-borrar-proyecto">Eliminar</button>`}
      </div>

      ${esNuevo ? "" : `
      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Gastos del proyecto</h3>
        <button class="btn btn-ghost" id="btn-add-gasto" type="button">+ Añadir gasto</button>
      </div>
      <div id="gasto-form-wrap"></div>
      <table><thead><tr><th>Concepto</th><th>Importe</th><th>Tipo</th><th>Fecha</th></tr></thead>
      <tbody>${gastos.map(g => `<tr><td>${escapeHtml(g.concepto)}</td><td>${eur(g.importe)}</td><td>${g.tipo}</td><td>${dateEs(g.fecha)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Sin gastos registrados</td></tr>`}</tbody></table>

      <h3 style="margin-top:20px;">Facturas y presupuestos vinculados</h3>
      <p class="muted" style="font-size:12px; margin-top:-6px;">Una factura puede cubrir varios proyectos: aquí solo se muestra la parte (importe) que corresponde a este proyecto.</p>
      <table><thead><tr><th>Nº</th><th>Tipo</th><th>Importe de este proyecto</th><th>Total factura</th><th>Estado</th></tr></thead>
      <tbody>${facturasVinculadas.map(fp => { const f = fp.facturas; if (!f) return ""; return `<tr class="clickable" data-factura-id="${fp.factura_id}"><td>${escapeHtml(f.numero)}</td><td>${f.tipo}</td><td>${eur(fp.importe)}</td><td>${eur(f.total)}</td><td><span class="badge" style="background:${ESTADOS_FACTURA[f.estado].bg}; color:${ESTADOS_FACTURA[f.estado].fg}">${ESTADOS_FACTURA[f.estado].label}</span></td></tr>`; }).join("") || `<tr><td colspan="5" class="muted">Sin facturas todavía</td></tr>`}</tbody></table>
      `}
    </div>`;

  $detalle.scrollIntoView({ behavior: "smooth", block: "start" });

  $detalle.querySelector("#btn-cerrar-ficha").addEventListener("click", () => { $detalle.innerHTML = ""; });

  $detalle.querySelector("#btn-guardar-proyecto").addEventListener("click", async () => {
    const payload = {
      nombre: $detalle.querySelector("#f-nombre").value.trim(),
      cliente_id: $detalle.querySelector("#f-cliente").value || null,
      fecha_inicio: $detalle.querySelector("#f-inicio").value || null,
      fecha_entrega: $detalle.querySelector("#f-entrega").value || null,
      horas_invertidas: Number($detalle.querySelector("#f-horas").value || 0),
      coste_asociado: Number($detalle.querySelector("#f-coste").value || 0),
      precio_acordado: Number($detalle.querySelector("#f-precio").value || 0),
      forma_pago: $detalle.querySelector("#f-forma-pago").value,
      estado_facturacion: $detalle.querySelector("#f-estado-cobro").value,
      categoria_servicio: $detalle.querySelector("#f-categoria-servicio").value,
      entregables: $detalle.querySelector("#f-entregables").value.split("\n").map(s => s.trim()).filter(Boolean),
      notas: $detalle.querySelector("#f-notas").value.trim(),
    };
    if (!payload.nombre) { alert("El nombre del proyecto es obligatorio."); return; }
    const { error } = esNuevo
      ? await db.from("proyectos").insert(payload).exec()
      : await db.from("proyectos").update(payload).eq("id", proyecto.id).exec();
    if (error) { alert("Error guardando: " + error); return; }
    $detalle.innerHTML = "";
    await onGuardado();
  });

  if (!esNuevo) {
    $detalle.querySelector("#btn-borrar-proyecto").addEventListener("click", async () => {
      if (!confirm("¿Eliminar este proyecto?")) return;
      const { error } = await db.from("proyectos").delete().eq("id", proyecto.id).exec();
      if (error) { alert("Error eliminando: " + error); return; }
      $detalle.innerHTML = "";
      await onGuardado();
    });

    $detalle.querySelector("#btn-generar-factura").addEventListener("click", () => {
      location.hash = `#/facturacion/nuevo-desde-proyecto:${proyecto.id}`;
    });

    $detalle.querySelectorAll("tr[data-factura-id]").forEach(tr => {
      tr.addEventListener("click", () => { location.hash = `#/facturacion/${tr.dataset.facturaId}`; });
    });

    $detalle.querySelector("#btn-add-gasto").addEventListener("click", () => {
      const $wrap = $detalle.querySelector("#gasto-form-wrap");
      $wrap.innerHTML = `
        <div class="row" style="margin:10px 0; align-items:flex-end;">
          <div class="field"><label>Concepto</label><input id="g-concepto"></div>
          <div class="field"><label>Importe (€)</label><input id="g-importe" type="number" step="0.01"></div>
          <div class="field"><label>Tipo</label><select id="g-tipo"><option value="variable">Variable</option><option value="fijo">Fijo</option></select></div>
          <div class="field"><label>Fecha</label><input id="g-fecha" type="date" value="${todayIso()}"></div>
          <div class="field" style="flex:0"><button class="btn btn-primary" id="btn-guardar-gasto" type="button">Guardar</button></div>
        </div>`;
      $wrap.querySelector("#btn-guardar-gasto").addEventListener("click", async () => {
        const payload = {
          proyecto_id: proyecto.id,
          concepto: $wrap.querySelector("#g-concepto").value.trim(),
          importe: Number($wrap.querySelector("#g-importe").value || 0),
          tipo: $wrap.querySelector("#g-tipo").value,
          fecha: $wrap.querySelector("#g-fecha").value || todayIso(),
        };
        if (!payload.concepto) { alert("Falta el concepto del gasto."); return; }
        const { error } = await db.from("gastos").insert(payload).exec();
        if (error) { alert("Error guardando el gasto: " + error); return; }
        await abrirFicha(container, proyecto, clientes, onGuardado);
      });
    });
  }
}
