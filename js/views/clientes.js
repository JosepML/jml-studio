import { db } from "../supabase.js";
import { eur } from "../utils/format.js";
import { construirLedger } from "../utils/resumen.js";
import { round2 } from "../utils/invoice-calc.js";
import { toastOk, toastError, confirmarBorrado, animarVista } from "../utils/ui.js";
import { opcionesDoughnut } from "../utils/charts.js";

let chartClientes = null;
const PALETA_CLIENTES = ["#3E6FE0","#F2B84B","#6B3FA0","#4CAF82","#E8985B","#B4453A","#5B8DEE","#8B5CF6"];

export async function renderClientes(container, param) {
  container.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-primary toolbar-action" id="btn-nuevo-cliente">+ Nuevo cliente</button>
    </div>
    <div class="grid grid-side" style="margin-bottom:20px; align-items:start;">
      <div class="card"><div id="clientes-list">Cargando…</div></div>
      <div class="card">
        <div class="card-head"><h3>Clientes por valor</h3><span class="help-tip" title="Total facturado real por cliente (transferencia + efectivo, incluyendo proyectos aún sin factura formal), de más a menos.">i</span></div>
        <div id="clientes-chart-wrap" style="position:relative; height:260px;"><canvas id="chart-clientes"></canvas></div>
      </div>
    </div>
    <div id="cliente-detalle"></div>
  `;

  container.querySelector("#btn-nuevo-cliente").addEventListener("click", () => abrirFicha(container, null));
  if (param === "nuevo") abrirFicha(container, null);

  const [{ data, error }, { data: proyectos }, { data: facturaProyectos }] = await Promise.all([
    db.from("clientes").select("*").order("nombre").exec(),
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
  ]);
  const $list = container.querySelector("#clientes-list");
  if (error) { $list.innerHTML = `<p class="muted">Error cargando clientes: ${error}</p>`; return; }
  if (!data || !data.length) {
    container.querySelector("#clientes-chart-wrap").innerHTML = `<p class="hint" style="padding-top:20px;">Sin datos todavía.</p>`;
    $list.innerHTML = `<div class="empty-state">Todavía no tienes clientes. Pulsa "+ Nuevo cliente" o usa el Asistente IA para pegar los datos de uno.</div>`;
    return;
  }

  // Valor real por cliente: se usa el ledger (proyectos + facturas reales),
  // no solo las facturas emitidas, para que un trabajo ya acordado pero
  // todavía sin factura formal también cuente en la comparativa.
  const ledger = construirLedger(proyectos, facturaProyectos);
  const totalPorCliente = {};
  ledger.forEach(f => {
    const id = f.proyecto?.cliente_id;
    if (!id) return;
    totalPorCliente[id] = round2((totalPorCliente[id] || 0) + f.importeBase);
  });
  const clientesMap = Object.fromEntries(data.map(c => [c.id, c]));
  const ranking = Object.entries(totalPorCliente)
    .map(([id, total]) => ({ cliente: clientesMap[id], total }))
    .filter(r => r.cliente)
    .sort((a, b) => b.total - a.total);

  const ctx = container.querySelector("#chart-clientes");
  if (ctx && window.Chart) {
    if (chartClientes) { chartClientes.destroy(); chartClientes = null; }
    const top = ranking.slice(0, 8);
    if (!top.length) {
      container.querySelector("#clientes-chart-wrap").innerHTML = `<p class="hint" style="padding-top:20px;">Todavía no hay proyectos facturados a ningún cliente.</p>`;
    } else {
      const colores = top.map((_, i) => PALETA_CLIENTES[i % PALETA_CLIENTES.length]);
      chartClientes = new window.Chart(ctx, {
        type: "doughnut",
        data: {
          labels: top.map(r => r.cliente.nombre),
          datasets: [{ data: top.map(r => r.total), backgroundColor: colores, borderWidth: 0, spacing: 3, hoverOffset: 8 }],
        },
        options: opcionesDoughnut(eur),
      });
    }
  }

  const totalPorRankingId = Object.fromEntries(ranking.map(r => [r.cliente.id, r.total]));
  $list.innerHTML = `
    <table>
      <thead><tr><th>Nombre</th><th>Tipo</th><th>Email</th><th>Teléfono</th><th class="money">Facturado</th></tr></thead>
      <tbody>
        ${data.map(c => `
          <tr class="clickable" data-id="${c.id}">
            <td><strong>${escapeHtml(c.nombre)}</strong></td>
            <td>${c.tipo === "empresa" ? "Empresa" : "Particular"}</td>
            <td>${escapeHtml(c.email || "—")}</td>
            <td>${escapeHtml(c.telefono || "—")}</td>
            <td class="money" style="font-weight:600;">${eur(totalPorRankingId[c.id] || 0)}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;

  $list.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", () => {
      const cliente = data.find(c => c.id === tr.dataset.id);
      abrirFicha(container, cliente);
    });
  });

  animarVista(container);
}

async function abrirFicha(container, cliente) {
  const $detalle = container.querySelector("#cliente-detalle");
  const esNuevo = !cliente;
  cliente = cliente || { nombre: "", tipo: "empresa", nif: "", email: "", telefono: "", direccion: "", notas: "" };

  let historialHtml = `<p class="muted">Guarda el cliente para ver su historial de proyectos y facturas.</p>`;
  if (!esNuevo) {
    const [{ data: proyectos }, { data: facturas }] = await Promise.all([
      db.from("proyectos").select("id,nombre,estado").eq("cliente_id", cliente.id).exec(),
      db.from("facturas").select("id,numero,total,estado").eq("cliente_id", cliente.id).exec(),
    ]);
    const totalFacturado = (facturas || []).reduce((s, f) => s + Number(f.total || 0), 0);
    historialHtml = `
      <p><strong>${(proyectos || []).length}</strong> proyectos · <strong>${(facturas || []).length}</strong> facturas · <strong>${totalFacturado.toLocaleString("es-ES", { style: "currency", currency: "EUR" })}</strong> facturados</p>
      <ul style="padding-left:18px; font-size:13px;">
        ${(proyectos || []).map(p => `<li>${escapeHtml(p.nombre)} — ${p.estado}</li>`).join("") || "<li class='muted'>Sin proyectos todavía</li>"}
      </ul>`;
  }

  $detalle.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <h3>${esNuevo ? "Nuevo cliente" : "Editar cliente"}</h3>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="f-nombre" value="${escapeAttr(cliente.nombre)}"></div>
        <div class="field"><label>Tipo</label>
          <select id="f-tipo">
            <option value="empresa" ${cliente.tipo === "empresa" ? "selected" : ""}>Empresa</option>
            <option value="particular" ${cliente.tipo === "particular" ? "selected" : ""}>Particular</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>NIF / CIF</label><input id="f-nif" value="${escapeAttr(cliente.nif)}"></div>
        <div class="field"><label>Email</label><input id="f-email" value="${escapeAttr(cliente.email)}"></div>
        <div class="field"><label>Teléfono</label><input id="f-telefono" value="${escapeAttr(cliente.telefono)}"></div>
      </div>
      <div class="field"><label>Dirección fiscal</label><input id="f-direccion" value="${escapeAttr(cliente.direccion)}"></div>
      <div class="field"><label>Notas</label><textarea id="f-notas" rows="3">${escapeHtml(cliente.notas || "")}</textarea></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="btn-guardar-cliente">Guardar</button>
        ${esNuevo ? "" : `<button class="btn btn-danger" id="btn-borrar-cliente" style="margin-left:auto;">Eliminar</button>`}
      </div>
      <hr class="divider">
      <h3>Historial</h3>
      ${historialHtml}
    </div>`;

  $detalle.querySelector("#btn-guardar-cliente").addEventListener("click", async () => {
    const payload = {
      nombre: $detalle.querySelector("#f-nombre").value.trim(),
      tipo: $detalle.querySelector("#f-tipo").value,
      nif: $detalle.querySelector("#f-nif").value.trim(),
      email: $detalle.querySelector("#f-email").value.trim(),
      telefono: $detalle.querySelector("#f-telefono").value.trim(),
      direccion: $detalle.querySelector("#f-direccion").value.trim(),
      notas: $detalle.querySelector("#f-notas").value.trim(),
    };
    if (!payload.nombre) { toastError("El nombre es obligatorio."); $detalle.querySelector("#f-nombre").focus(); return; }
    const { error } = esNuevo
      ? await db.from("clientes").insert(payload).exec()
      : await db.from("clientes").update(payload).eq("id", cliente.id).exec();
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    toastOk(esNuevo ? `Cliente "${payload.nombre}" creado.` : "Cliente actualizado.");
    await renderClientes(container);
  });

  if (!esNuevo) {
    $detalle.querySelector("#btn-borrar-cliente").addEventListener("click", async () => {
      if (!await confirmarBorrado(`el cliente "${cliente.nombre}"`)) return;
      const { error } = await db.from("clientes").delete().eq("id", cliente.id).exec();
      if (error) { toastError("No se ha podido eliminar: " + error); return; }
      toastOk("Cliente eliminado.");
      await renderClientes(container);
    });
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }
