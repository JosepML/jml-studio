import { db } from "../supabase.js";
import { parseClienteDesdeTexto } from "../ai/parser.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

export async function renderAsistente(container) {
  container.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Flujo A — Pegar datos de un cliente nuevo</h3>
        <p class="muted">Pega aquí cualquier texto (un email, un WhatsApp, una nota) con los datos de un cliente. El motor de reglas detecta NIF/CIF, email, teléfono, IBAN y dirección — sin usar ninguna IA de pago.</p>
        <div class="field"><textarea id="texto-cliente" rows="8" placeholder="Ej: JUNO Media SL&#10;CIF B12345678&#10;contacto@junomedia.es&#10;Tel 612 345 678&#10;C/ Ejemplo 12, 03500 Benidorm"></textarea></div>
        <button class="btn btn-primary" id="btn-analizar">Analizar texto</button>
        <div id="resultado-analisis" style="margin-top:18px;"></div>
      </div>
      <div class="card">
        <h3>Flujo B — Factura desde un proyecto</h3>
        <p class="muted">Este flujo se activa desde la ficha de cada proyecto: abre un proyecto y pulsa "Generar factura". La app cruza automáticamente los datos del cliente vinculado con el precio acordado del proyecto y prepara un borrador de factura listo para revisar.</p>
        <a href="#/proyectos" class="btn btn-dark" style="text-decoration:none; display:inline-block;">Ir a Proyectos</a>
        <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;">
        <p class="muted" style="font-size:12px;">Ambos flujos son gratuitos: usan un motor de reglas propio. Ninguno guarda nada automáticamente — siempre revisas y confirmas antes de guardar.</p>
      </div>
    </div>`;

  container.querySelector("#btn-analizar").addEventListener("click", () => {
    const texto = container.querySelector("#texto-cliente").value;
    const campos = parseClienteDesdeTexto(texto);
    pintarResultado(container, campos);
  });
}

function pintarResultado(container, campos) {
  const $res = container.querySelector("#resultado-analisis");
  if (!Object.keys(campos).length) {
    $res.innerHTML = `<p class="muted">No se ha detectado ningún dato. Prueba a pegar más contexto (nombre, email, teléfono...).</p>`;
    return;
  }
  const get = k => campos[k]?.valor || "";
  const origen = k => campos[k] ? `<span class="badge" style="background:var(--purple-bg); color:var(--purple-fg); margin-left:6px;">${campos[k].origen}</span>` : "";

  $res.innerHTML = `
    <div class="field"><label>Nombre ${origen("nombre")}</label><input id="a-nombre" value="${escapeAttr(get("nombre"))}"></div>
    <div class="row">
      <div class="field"><label>Tipo ${origen("tipo")}</label>
        <select id="a-tipo"><option value="empresa" ${get("tipo")==="empresa"?"selected":""}>Empresa</option><option value="particular" ${get("tipo")==="particular"?"selected":""}>Particular</option></select>
      </div>
      <div class="field"><label>NIF/CIF ${origen("nif")}</label><input id="a-nif" value="${escapeAttr(get("nif"))}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Email ${origen("email")}</label><input id="a-email" value="${escapeAttr(get("email"))}"></div>
      <div class="field"><label>Teléfono ${origen("telefono")}</label><input id="a-telefono" value="${escapeAttr(get("telefono"))}"></div>
    </div>
    <div class="field"><label>Dirección ${origen("direccion")}</label><input id="a-direccion" value="${escapeAttr(get("direccion"))}"></div>
    <div class="field"><label>Notas ${origen("notas")}</label><textarea id="a-notas" rows="2">${escapeHtml(get("notas"))}</textarea></div>
    <button class="btn btn-primary" id="btn-guardar-cliente-ia">Confirmar y guardar cliente</button>
  `;

  $res.querySelector("#btn-guardar-cliente-ia").addEventListener("click", async () => {
    const payload = {
      nombre: $res.querySelector("#a-nombre").value.trim(),
      tipo: $res.querySelector("#a-tipo").value,
      nif: $res.querySelector("#a-nif").value.trim(),
      email: $res.querySelector("#a-email").value.trim(),
      telefono: $res.querySelector("#a-telefono").value.trim(),
      direccion: $res.querySelector("#a-direccion").value.trim(),
      notas: $res.querySelector("#a-notas").value.trim(),
    };
    if (!payload.nombre) { alert("Falta el nombre del cliente."); return; }
    const { error } = await db.from("clientes").insert(payload).exec();
    if (error) { alert("Error guardando: " + error); return; }
    alert("Cliente guardado. Puedes verlo en la sección Clientes.");
    container.querySelector("#texto-cliente").value = "";
    $res.innerHTML = "";
  });
}
