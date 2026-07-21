import { db } from "../supabase.js";

export async function renderClientes(container) {
  container.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:14px;">
      <button class="btn btn-primary" id="btn-nuevo-cliente">+ Nuevo cliente</button>
    </div>
    <div class="card"><div id="clientes-list">Cargando…</div></div>
    <div id="cliente-detalle"></div>
  `;

  container.querySelector("#btn-nuevo-cliente").addEventListener("click", () => abrirFicha(container, null));

  const { data, error } = await db.from("clientes").select("*").order("nombre").exec();
  const $list = container.querySelector("#clientes-list");
  if (error) { $list.innerHTML = `<p class="muted">Error cargando clientes: ${error}</p>`; return; }
  if (!data || !data.length) { $list.innerHTML = `<div class="empty-state">Todavía no tienes clientes. Pulsa "+ Nuevo cliente" o usa el Asistente IA para pegar los datos de uno.</div>`; return; }

  $list.innerHTML = `
    <table>
      <thead><tr><th>Nombre</th><th>Tipo</th><th>Email</th><th>Teléfono</th></tr></thead>
      <tbody>
        ${data.map(c => `
          <tr class="clickable" data-id="${c.id}">
            <td><strong>${escapeHtml(c.nombre)}</strong></td>
            <td>${c.tipo === "empresa" ? "Empresa" : "Particular"}</td>
            <td>${escapeHtml(c.email || "—")}</td>
            <td>${escapeHtml(c.telefono || "—")}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;

  $list.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", () => {
      const cliente = data.find(c => c.id === tr.dataset.id);
      abrirFicha(container, cliente);
    });
  });
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
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary" id="btn-guardar-cliente">Guardar</button>
        ${esNuevo ? "" : `<button class="btn btn-ghost" id="btn-borrar-cliente">Eliminar</button>`}
      </div>
      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;">
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
    if (!payload.nombre) { alert("El nombre es obligatorio."); return; }
    const { error } = esNuevo
      ? await db.from("clientes").insert(payload).exec()
      : await db.from("clientes").update(payload).eq("id", cliente.id).exec();
    if (error) { alert("Error guardando: " + error); return; }
    await renderClientes(container);
  });

  if (!esNuevo) {
    $detalle.querySelector("#btn-borrar-cliente").addEventListener("click", async () => {
      if (!confirm("¿Eliminar este cliente? Esta acción no se puede deshacer.")) return;
      const { error } = await db.from("clientes").delete().eq("id", cliente.id).exec();
      if (error) { alert("Error eliminando: " + error); return; }
      await renderClientes(container);
    });
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }
