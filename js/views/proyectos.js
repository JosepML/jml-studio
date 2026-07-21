import { db } from "../supabase.js";
import { ESTADOS_PROYECTO, ESTADOS_FACTURA, FORMAS_PAGO, eur, dateEs, todayIso } from "../utils/format.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

export async function renderProyectos(container, param) {
  const { data: clientes } = await db.from("clientes").select("id,nombre").order("nombre").exec();
  const { data: proyectos, error } = await db.from("proyectos").select("*").order("created_at", { ascending: false }).exec();

  container.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:14px;">
      <button class="btn btn-primary" id="btn-nuevo-proyecto">+ Nuevo proyecto</button>
    </div>
    <div id="kanban-wrap"></div>
    <div id="proyecto-detalle"></div>
  `;

  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  const $kanban = container.querySelector("#kanban-wrap");

  if (error) { $kanban.innerHTML = `<p class="muted">Error: ${error}</p>`; }
  else {
    const cols = Object.keys(ESTADOS_PROYECTO);
    $kanban.innerHTML = `<div class="kanban">
      ${cols.map(estado => `
        <div class="kanban-col">
          <h4>${ESTADOS_PROYECTO[estado].label}</h4>
          ${(proyectos || []).filter(p => p.estado === estado).map(p => `
            <div class="kanban-card" data-id="${p.id}">
              <div class="name">${escapeHtml(p.nombre)}</div>
              <div class="client">${escapeHtml(clientesMap[p.cliente_id] || "Sin cliente")}</div>
            </div>`).join("") || `<p class="muted" style="font-size:12px;">Vacío</p>`}
        </div>`).join("")}
    </div>`;

    $kanban.querySelectorAll(".kanban-card").forEach(card => {
      card.addEventListener("click", () => {
        const p = proyectos.find(x => x.id === card.dataset.id);
        abrirFicha(container, p, clientes || []);
      });
    });
  }

  container.querySelector("#btn-nuevo-proyecto").addEventListener("click", () => abrirFicha(container, null, clientes || []));

  if (param && proyectos) {
    const p = proyectos.find(x => x.id === param);
    if (p) abrirFicha(container, p, clientes || []);
  }
}

async function abrirFicha(container, proyecto, clientes) {
  const esNuevo = !proyecto;
  proyecto = proyecto || { nombre: "", cliente_id: clientes[0]?.id || "", estado: "presupuestado", fecha_inicio: todayIso(), fecha_entrega: "", horas_invertidas: 0, coste_asociado: 0, precio_acordado: 0, entregables: [], forma_pago: "transferencia", notas: "" };
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
        ${esNuevo ? "" : `<button class="btn btn-dark" id="btn-generar-factura">Generar factura</button>`}
      </div>

      <div class="row">
        <div class="field"><label>Nombre del proyecto</label><input id="f-nombre" value="${escapeAttr(proyecto.nombre)}"></div>
        <div class="field"><label>Cliente</label>
          <select id="f-cliente">
            ${clientes.map(c => `<option value="${c.id}" ${c.id === proyecto.cliente_id ? "selected" : ""}>${escapeHtml(c.nombre)}</option>`).join("") || `<option value="">Crea antes un cliente</option>`}
          </select>
        </div>
        <div class="field"><label>Estado</label>
          <select id="f-estado">
            ${Object.entries(ESTADOS_PROYECTO).map(([k, v]) => `<option value="${k}" ${k === proyecto.estado ? "selected" : ""}>${v.label}</option>`).join("")}
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
        <div class="field"><label>Precio acordado (€)</label><input type="number" step="0.01" id="f-precio" value="${proyecto.precio_acordado || 0}"></div>
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

  $detalle.querySelector("#btn-guardar-proyecto").addEventListener("click", async () => {
    const payload = {
      nombre: $detalle.querySelector("#f-nombre").value.trim(),
      cliente_id: $detalle.querySelector("#f-cliente").value || null,
      estado: $detalle.querySelector("#f-estado").value,
      fecha_inicio: $detalle.querySelector("#f-inicio").value || null,
      fecha_entrega: $detalle.querySelector("#f-entrega").value || null,
      horas_invertidas: Number($detalle.querySelector("#f-horas").value || 0),
      coste_asociado: Number($detalle.querySelector("#f-coste").value || 0),
      precio_acordado: Number($detalle.querySelector("#f-precio").value || 0),
      forma_pago: $detalle.querySelector("#f-forma-pago").value,
      entregables: $detalle.querySelector("#f-entregables").value.split("\n").map(s => s.trim()).filter(Boolean),
      notas: $detalle.querySelector("#f-notas").value.trim(),
    };
    if (!payload.nombre) { alert("El nombre del proyecto es obligatorio."); return; }
    const { error } = esNuevo
      ? await db.from("proyectos").insert(payload).exec()
      : await db.from("proyectos").update(payload).eq("id", proyecto.id).exec();
    if (error) { alert("Error guardando: " + error); return; }
    await renderProyectos(container);
  });

  if (!esNuevo) {
    $detalle.querySelector("#btn-borrar-proyecto").addEventListener("click", async () => {
      if (!confirm("¿Eliminar este proyecto?")) return;
      const { error } = await db.from("proyectos").delete().eq("id", proyecto.id).exec();
      if (error) { alert("Error eliminando: " + error); return; }
      await renderProyectos(container);
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
        await abrirFicha(container, proyecto, clientes);
      });
    });
  }
}
