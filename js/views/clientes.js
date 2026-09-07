import { db } from "../supabase.js";
import { eur, dateEs, ESTADOS_FACTURA, ESTADOS_PRESUPUESTO } from "../utils/format.js";
import { construirLedger } from "../utils/resumen.js";
import { round2 } from "../utils/invoice-calc.js";
import { toastOk, toastError, confirmarBorrado, animarVista, skeletonTabla } from "../utils/ui.js";
import { opcionesBase, barra, eurEje } from "../utils/charts.js";
import { parseClienteDesdeTexto } from "../ai/parser.js";

let chartClientes = null;
const CLIENTE_VACIO = { nombre: "", tipo: "empresa", nif: "", email: "", telefono: "", direccion: "", notas: "" };

function inicialesCliente(nombre) {
  return String(nombre || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join("").toUpperCase();
}

export async function renderClientes(container, param) {
  container.innerHTML = `
    <div class="grid grid-side" style="margin-bottom:20px;">
      <div class="card">
        <div class="clientes-list-head">
          <h3>Todos los clientes</h3>
          <div class="clientes-list-actions">
            <input id="buscar-clientes" type="search" placeholder="Buscar cliente…" aria-label="Buscar cliente">
            <button class="btn btn-primary" id="btn-nuevo-cliente">+ Nuevo cliente</button>
          </div>
        </div>
        <div id="clientes-list">${skeletonTabla(8)}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Clientes por valor</h3><span class="help-tip" title="Total facturado real por cliente (transferencia + efectivo, incluyendo proyectos aún sin factura formal), de más a menos.">i</span></div>
        <div id="clientes-chart-wrap" class="clientes-chart-wrap"><canvas id="chart-clientes" role="img" aria-label="Facturación por cliente"></canvas></div>
      </div>
    </div>
  `;

  container.querySelector("#btn-nuevo-cliente").addEventListener("click", () => abrirModalNuevoCliente(() => renderClientes(container)));

  const [{ data, error }, { data: proyectos }, { data: facturaProyectos }] = await Promise.all([
    db.from("clientes").select("*").order("nombre").exec(),
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
  ]);
  const $list = container.querySelector("#clientes-list");
  // La navegación es asíncrona: si se cambia de sección mientras llegan los
  // datos, esta vista puede haber sido desmontada y no debe tocar nodos viejos.
  if (!$list?.isConnected || container !== document.getElementById("content")) return;
  if (error) { $list.innerHTML = `<p class="muted">Error cargando clientes: ${error}</p>`; return; }

  // Ojo: el arranque pinta la vista dos veces (la segunda al llegar los datos
  // del emisor), así que sin esta guarda el diálogo se abría por duplicado.
  if (param === "nuevo" && !document.querySelector(".modal-backdrop")) abrirModalNuevoCliente(() => renderClientes(container));

  if (!data || !data.length) {
    const $chartWrap = container.querySelector("#clientes-chart-wrap");
    if ($chartWrap) $chartWrap.innerHTML = `<p class="muted" style="padding-top:20px;">Sin datos todavía.</p>`;
    $list.innerHTML = `<div class="empty-state">Todavía no tienes clientes. Pulsa "+ Nuevo cliente": puedes pegar sus datos de un email y se rellenan solos.</div>`;
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
      container.querySelector("#clientes-chart-wrap").innerHTML = `<p class="muted" style="padding-top:20px;">Todavía no hay proyectos facturados a ningún cliente.</p>`;
    } else {
      chartClientes = new window.Chart(ctx, {
        type: "bar",
        data: {
          labels: top.map(r => r.cliente.nombre),
          datasets: [{ label: "Facturado", data: top.map(r => r.total), ...barra("#3E6FE0", { maxBarThickness: 24 }), borderRadius: 7 }],
        },
        options: (() => {
          const o = opcionesBase(eur);
          o.indexAxis = "y";
          o.plugins.legend.display = false;
          o.scales.x.grid = { color: "rgba(122,131,153,.10)", drawTicks: false, borderDash: [4, 4] };
          o.scales.x.ticks.callback = eurEje;
          o.scales.y.grid.display = false;
          o.scales.y.ticks = { font: { size: 11, family: "Inter" }, color: "#7A8399", autoSkip: false };
          return o;
        })(),
      });
    }
  }

  const totalPorRankingId = Object.fromEntries(ranking.map(r => [r.cliente.id, r.total]));
  let pagina = 1;
  const porPagina = 8;
  function pintarListaClientes() {
    const q = (container.querySelector("#buscar-clientes")?.value || "").trim().toLowerCase();
    const filtrados = data.filter(c => `${c.nombre} ${c.email || ""} ${c.telefono || ""}`.toLowerCase().includes(q));
    const totalPaginas = Math.max(1, Math.ceil(filtrados.length / porPagina));
    pagina = Math.min(pagina, totalPaginas);
    const visibles = filtrados.slice((pagina - 1) * porPagina, pagina * porPagina);
    $list.innerHTML = `<div class="clientes-lista">
    ${visibles.map(c => {
      const incompleto = !c.nif || !c.direccion;
      const contacto = c.email || c.telefono || "Sin datos de contacto";
      return `<div class="cliente-fila clickable" data-id="${c.id}">
        <div class="cliente-avatar" aria-hidden="true">${escapeHtml(inicialesCliente(c.nombre))}</div>
        <div class="cliente-identidad">
          <strong>${escapeHtml(c.nombre)}</strong>
          <span>${c.tipo === "empresa" ? "Empresa" : "Particular"} · ${escapeHtml(contacto)}</span>
        </div>
        <div class="cliente-estado ${incompleto ? "incompleto" : "completo"}">${incompleto ? "Datos pendientes" : "Listo para facturar"}</div>
        <div class="cliente-facturado"><span>Facturado</span><strong>${eur(totalPorRankingId[c.id] || 0)}</strong></div>
        <span class="cliente-flecha" aria-hidden="true">→</span>
      </div>`;
    }).join("")}
  </div>
  ${!visibles.length ? `<div class="clientes-sin-resultados">No hay clientes que coincidan.</div>` : ""}
  <div class="clientes-pie">
    <span>${filtrados.length} cliente${filtrados.length === 1 ? "" : "s"}${q ? " encontrados" : ""}</span>
    ${totalPaginas > 1 ? `<div class="clientes-paginacion"><button class="icon-btn" data-pagina="anterior" type="button" ${pagina === 1 ? "disabled" : ""} aria-label="Página anterior">←</button><strong>${pagina} / ${totalPaginas}</strong><button class="icon-btn" data-pagina="siguiente" type="button" ${pagina === totalPaginas ? "disabled" : ""} aria-label="Página siguiente">→</button></div>` : ""}
  </div>`;

  $list.querySelectorAll(".cliente-fila[data-id]").forEach(fila => {
    fila.addEventListener("click", () => {
      const cliente = data.find(c => c.id === fila.dataset.id);
      abrirFicha(container, cliente);
    });
  });
  $list.querySelectorAll("[data-pagina]").forEach(btn => btn.addEventListener("click", () => {
    pagina += btn.dataset.pagina === "siguiente" ? 1 : -1;
    pintarListaClientes();
  }));
  }
  container.querySelector("#buscar-clientes").addEventListener("input", () => { pagina = 1; pintarListaClientes(); });
  pintarListaClientes();

  // Enlace directo: #/clientes/<id> abre la ficha de ese cliente.
  if (param && param !== "nuevo") {
    const cliente = data.find(c => c.id === param);
    if (cliente) { abrirFicha(container, cliente); return; }
  }

  animarVista(container);
}

// ---------------------------------------------------------------------------
// Formulario compartido (modal de alta y pestaña de datos de la ficha)
// ---------------------------------------------------------------------------

function camposHtml(cliente, prefijo) {
  return `
    <div class="row">
      <div class="field" style="flex:2;"><label>Nombre</label><input id="${prefijo}-nombre" value="${escapeAttr(cliente.nombre || "")}"></div>
      <div class="field"><label>NIF / CIF</label><input id="${prefijo}-nif" value="${escapeAttr(cliente.nif || "")}"></div>
      <div class="field"><label>Tipo</label>
        <select id="${prefijo}-tipo">
          <option value="empresa" ${cliente.tipo === "empresa" ? "selected" : ""}>Empresa</option>
          <option value="particular" ${cliente.tipo === "particular" ? "selected" : ""}>Particular</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div class="field"><label>Email</label><input id="${prefijo}-email" value="${escapeAttr(cliente.email || "")}"></div>
      <div class="field"><label>Teléfono</label><input id="${prefijo}-telefono" value="${escapeAttr(cliente.telefono || "")}"></div>
    </div>
    <div class="field"><label>Dirección fiscal</label><input id="${prefijo}-direccion" value="${escapeAttr(cliente.direccion || "")}"></div>
    <div class="field"><label>Notas</label><textarea id="${prefijo}-notas" rows="2">${escapeHtml(cliente.notas || "")}</textarea></div>`;
}

function leerCampos($raiz, prefijo) {
  const val = clave => ($raiz.querySelector(`#${prefijo}-${clave}`)?.value || "").trim();
  return {
    nombre: val("nombre"),
    tipo: $raiz.querySelector(`#${prefijo}-tipo`)?.value || "empresa",
    nif: val("nif"),
    email: val("email"),
    telefono: val("telefono"),
    direccion: val("direccion"),
    notas: val("notas"),
  };
}

// ---------------------------------------------------------------------------
// Alta en modal, con pegado de texto
// ---------------------------------------------------------------------------

// Exportado: el editor de facturas y presupuestos lo abre encima de la página
// para dar de alta un cliente sin salir del documento que estás haciendo.
// `alCrear` recibe el cliente recién creado.
export function abrirModalNuevoCliente(alCrear) {
  const $backdrop = document.createElement("div");
  $backdrop.className = "modal-backdrop";
  $backdrop.innerHTML = `
    <div class="modal ancho" role="dialog" aria-modal="true">
      <h3>Nuevo cliente</h3>
      <p>Pega sus datos de un email, un WhatsApp o una firma y se rellenan solos. También puedes escribirlos a mano.</p>
      <div class="field">
        <textarea id="nc-pegado" rows="4" placeholder="Pega aquí el texto con los datos del cliente…"></textarea>
      </div>
      <div class="form-inline-acciones" style="margin-bottom:16px; align-items:center;">
        <button class="btn btn-ghost" id="nc-analizar" type="button">Rellenar desde el texto</button>
        <span class="muted" id="nc-resultado" style="font-size:12px;"></span>
      </div>
      <hr style="border:none; border-top:1px solid var(--border); margin:0 0 16px;">
      ${camposHtml(CLIENTE_VACIO, "nc")}
      <div class="form-actions">
        <button class="btn btn-ghost" id="nc-cancelar" type="button">Cancelar</button>
        <button class="btn btn-primary" id="nc-guardar" type="button">Crear cliente</button>
      </div>
    </div>`;
  document.body.appendChild($backdrop);

  const alPulsar = e => { if (e.key === "Escape") cerrar(); };
  function cerrar() { $backdrop.remove(); document.removeEventListener("keydown", alPulsar); }
  document.addEventListener("keydown", alPulsar);
  $backdrop.addEventListener("mousedown", e => { if (e.target === $backdrop) cerrar(); });
  $backdrop.querySelector("#nc-cancelar").addEventListener("click", cerrar);

  // El parser es el mismo del Flujo A del Asistente: reglas, sin API de pago.
  // Los campos que rellena se marcan para que se revisen antes de guardar.
  $backdrop.querySelector("#nc-analizar").addEventListener("click", () => {
    const texto = $backdrop.querySelector("#nc-pegado").value;
    if (!texto.trim()) { toastError("Pega primero el texto con los datos."); return; }
    const campos = parseClienteDesdeTexto(texto);
    const puestos = [];
    Object.entries(campos).forEach(([clave, info]) => {
      const $campo = $backdrop.querySelector(`#nc-${clave}`);
      if (!$campo) return;
      $campo.value = info.valor;
      $campo.classList.add("campo-detectado");
      puestos.push(clave);
    });
    $backdrop.querySelector("#nc-resultado").textContent = puestos.length
      ? `Rellenados: ${puestos.join(", ")}. Revísalos antes de guardar.`
      : "No he reconocido ningún dato en ese texto.";
  });

  $backdrop.querySelector("#nc-guardar").addEventListener("click", async () => {
    const payload = leerCampos($backdrop, "nc");
    if (!payload.nombre) { toastError("El nombre es obligatorio."); $backdrop.querySelector("#nc-nombre").focus(); return; }
    const { data, error } = await db.from("clientes").insert(payload).exec();
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    const creado = Array.isArray(data) ? data[0] : data;
    cerrar();
    toastOk(`Cliente "${payload.nombre}" creado.`);
    if (alCrear) await alCrear(creado || payload);
  });

  $backdrop.querySelector("#nc-pegado").focus();
}

// ---------------------------------------------------------------------------
// Ficha con pestañas
// ---------------------------------------------------------------------------

async function abrirFicha(container, cliente) {
  const [{ data: proyectos }, { data: documentos }] = await Promise.all([
    db.from("proyectos").select("id,nombre,estado,precio_acordado,fecha_inicio").eq("cliente_id", cliente.id).order("fecha_inicio").exec(),
    db.from("facturas").select("id,numero,tipo,fecha,total,estado").eq("cliente_id", cliente.id).order("fecha").exec(),
  ]);
  // Lo más reciente arriba, que es como se busca.
  const listaProyectos = (proyectos || []).slice().reverse();
  const listaDocumentos = (documentos || []).slice().reverse();
  const totalFacturado = listaDocumentos.filter(d => d.tipo === "factura").reduce((s, d) => s + Number(d.total || 0), 0);
  const faltan = [!cliente.nif && "el NIF/CIF", !cliente.direccion && "la dirección fiscal"].filter(Boolean);

  container.innerHTML = `
    <div class="editor-top">
      <a class="back-link" href="#/clientes" id="volver-clientes">← Volver a Clientes</a>
      <span class="doc-badge">${cliente.tipo === "empresa" ? "Empresa" : "Particular"}</span>
    </div>

    <div class="card">
      <div class="card-head"><h3>${escapeHtml(cliente.nombre)}</h3></div>
      <div class="cli-resumen">
        <div><span class="cli-resumen-label">Facturado</span><strong>${eur(totalFacturado)}</strong></div>
        <div><span class="cli-resumen-label">Proyectos</span><strong>${listaProyectos.length}</strong></div>
        <div><span class="cli-resumen-label">Documentos</span><strong>${listaDocumentos.length}</strong></div>
      </div>
      ${faltan.length ? `<div class="ai-banner" style="margin-top:14px;">Le falta ${faltan.join(" y ")}. Sin esos datos no puedes emitirle una factura válida.</div>` : ""}

      <div class="tabs" id="cli-tabs" style="margin-top:18px;">
        <button data-tab="datos" class="active" type="button">Datos</button>
        <button data-tab="proyectos" type="button">Proyectos (${listaProyectos.length})</button>
        <button data-tab="documentos" type="button">Facturas y presupuestos (${listaDocumentos.length})</button>
      </div>

      <div data-panel="datos">
        ${camposHtml(cliente, "fc")}
        <div class="form-actions" style="justify-content:flex-start;">
          <button class="btn btn-primary" id="btn-guardar-cliente" type="button">Guardar cambios</button>
          <button class="btn btn-ghost" id="btn-borrar-cliente" type="button" style="border-color:var(--red-fg,#B4453A); color:var(--red-fg,#B4453A);">Eliminar</button>
        </div>
      </div>

      <div data-panel="proyectos" hidden>
        ${listaProyectos.length ? `
        <table>
          <thead><tr><th>Proyecto</th><th>Estado</th><th>Inicio</th><th class="money">Precio acordado</th></tr></thead>
          <tbody>
            ${listaProyectos.map(p => `
              <tr class="clickable" data-proyecto="${p.id}">
                <td><strong>${escapeHtml(p.nombre)}</strong></td>
                <td>${escapeHtml(String(p.estado || "").replace(/_/g, " "))}</td>
                <td>${p.fecha_inicio ? dateEs(p.fecha_inicio) : "—"}</td>
                <td class="money">${eur(Number(p.precio_acordado || 0))}</td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<div class="empty-state">Este cliente todavía no tiene proyectos.</div>`}
      </div>

      <div data-panel="documentos" hidden>
        ${listaDocumentos.length ? `
        <table>
          <thead><tr><th>Nº</th><th>Tipo</th><th>Fecha</th><th class="money">Total</th><th>Estado</th></tr></thead>
          <tbody>
            ${listaDocumentos.map(d => {
              const estados = d.tipo === "presupuesto" ? ESTADOS_PRESUPUESTO : ESTADOS_FACTURA;
              const e = estados[d.estado] || {};
              return `
              <tr class="clickable" data-doc="${d.id}" data-tipo="${d.tipo}">
                <td><strong>${escapeHtml(d.numero)}</strong></td>
                <td>${d.tipo === "presupuesto" ? "Presupuesto" : "Factura"}</td>
                <td>${dateEs(d.fecha)}</td>
                <td class="money">${eur(Number(d.total || 0))}</td>
                <td><span class="badge" style="background:${e.bg || "#F0F1F4"};color:${e.fg || "#5B6478"}">${e.label || d.estado}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>` : `<div class="empty-state">Todavía no le has emitido ninguna factura ni presupuesto.</div>`}
      </div>
    </div>`;

  const $tabs = container.querySelector("#cli-tabs");
  $tabs.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      $tabs.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
      container.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== btn.dataset.tab; });
    });
  });

  container.querySelector("#volver-clientes").addEventListener("click", (e) => {
    e.preventDefault();
    renderClientes(container);
  });

  container.querySelectorAll("[data-proyecto]").forEach(tr => {
    tr.addEventListener("click", () => { location.hash = `#/proyectos/${tr.dataset.proyecto}`; });
  });
  container.querySelectorAll("[data-doc]").forEach(tr => {
    tr.addEventListener("click", () => {
      const base = tr.dataset.tipo === "presupuesto" ? "#/presupuestos" : "#/facturacion";
      location.hash = `${base}/${tr.dataset.doc}`;
    });
  });

  container.querySelector("#btn-guardar-cliente").addEventListener("click", async () => {
    const payload = leerCampos(container, "fc");
    if (!payload.nombre) { toastError("El nombre es obligatorio."); container.querySelector("#fc-nombre").focus(); return; }
    const { error } = await db.from("clientes").update(payload).eq("id", cliente.id).exec();
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    toastOk("Cliente actualizado.");
    await renderClientes(container);
  });

  container.querySelector("#btn-borrar-cliente").addEventListener("click", async () => {
    if (!await confirmarBorrado(`el cliente "${cliente.nombre}"`)) return;
    const { error } = await db.from("clientes").delete().eq("id", cliente.id).exec();
    if (error) { toastError("No se ha podido eliminar: " + error); return; }
    toastOk("Cliente eliminado.");
    await renderClientes(container);
  });

  animarVista(container);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }
