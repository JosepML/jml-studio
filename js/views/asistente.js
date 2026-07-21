import { db } from "../supabase.js";
import { parseClienteDesdeTexto } from "../ai/parser.js";
import { eur, dateEs, todayIso } from "../utils/format.js";
import { calcularModelo130 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, rangoMes, rangoAnio, conIva, estadoEfectivo } from "../utils/resumen.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

const CLIENTE_GENERICO = "por clasificar";

export async function renderAsistente(container) {
  container.innerHTML = `<div class="empty-state">Analizando tu negocio…</div>`;

  const [{ data: proyectos }, { data: facturaProyectos }, { data: facturas }, { data: gastos }, { data: clientes }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("facturas").select("*").exec(),
    db.from("gastos").select("*").exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);

  const clientesMap = Object.fromEntries((clientes||[]).map(c=>[c.id,c.nombre]));
  const ledger = construirLedger(proyectos, facturaProyectos);
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const qActual = Math.floor(hoy.getMonth()/3) + 1;
  const hoyIso = todayIso();

  const rMes = rangoMes(anio, hoy.getMonth());
  const resumenMes = resumenPeriodo(ledger, gastos, rMes.desde, rMes.hasta);
  const resumenAnual = resumenPeriodo(ledger, gastos, rangoAnio(anio).desde, rangoAnio(anio).hasta);

  let acumulado = 0;
  for (let q = 1; q < qActual; q++) {
    const t = resumenTrimestre(ledger, facturas, gastos, anio, q);
    const r = calcularModelo130({ ingresosBaseTrimestre: t.transferencia, gastosTrimestre: t.gastosDeducibles, retencionesSoportadasTrimestre: t.retenciones, pagosPreviosAnio: acumulado });
    acumulado += r.aIngresar;
  }
  const tActual = resumenTrimestre(ledger, facturas, gastos, anio, qActual);
  const provision = calcularModelo130({ ingresosBaseTrimestre: tActual.transferencia, gastosTrimestre: tActual.gastosDeducibles, retencionesSoportadasTrimestre: tActual.retenciones, pagosPreviosAnio: acumulado });

  // --- Alertas accionables ---
  const alertas = [];

  const diasDesde = (iso) => Math.floor((new Date(hoyIso) - new Date(iso)) / 86400000);

  ledger.filter(f => estadoEfectivo(f) === "emitida" && f.fecha && diasDesde(f.fecha) > 30)
    .sort((a,b)=>diasDesde(b.fecha)-diasDesde(a.fecha))
    .forEach(f => alertas.push({
      tipo: "cobro",
      texto: `"${f.proyecto.nombre}" (${clientesMap[f.proyecto.cliente_id]||"—"}) lleva ${diasDesde(f.fecha)} días emitido sin marcarse como pagado — ${eur(conIva(f.importeBase))}.`,
      href: "#/mensual",
    }));

  (proyectos||[]).filter(p => (clientesMap[p.cliente_id]||"").toLowerCase().includes(CLIENTE_GENERICO))
    .forEach(p => alertas.push({
      tipo: "cliente",
      texto: `"${p.nombre}" está bajo un cliente genérico ("${clientesMap[p.cliente_id]}") — créale una ficha propia si quieres tener sus datos.`,
      href: `#/proyectos/${p.id}`,
    }));

  (gastos||[]).filter(g => g.categoria === "combustible" && Number(g.iva_soportado||0) === 0 && g.deducible !== false)
    .forEach(g => alertas.push({
      tipo: "gasto",
      texto: `Gasto de combustible "${g.concepto}" (${dateEs(g.fecha)}) no tiene el IVA soportado desglosado — revísalo para no perder deducción.`,
      href: "#/gastos",
    }));

  (gastos||[]).filter(g => g.es_amortizable && g.meses_amortizacion && g.fecha_inicio_amortizacion).forEach(g => {
    const inicio = new Date(g.fecha_inicio_amortizacion + "T00:00:00");
    const fin = new Date(inicio.getFullYear(), inicio.getMonth() + g.meses_amortizacion, inicio.getDate());
    const diasHastaFin = Math.floor((fin - hoy) / 86400000);
    if (diasHastaFin > 0 && diasHastaFin <= 60) {
      alertas.push({
        tipo: "amortizacion",
        texto: `El bien "${g.concepto}" termina de amortizarse el ${dateEs(fin.toISOString().slice(0,10))}.`,
        href: "#/gastos",
      });
    }
  });

  const resumenTexto = `
    En ${MES_LARGO(hoy.getMonth())} de ${anio} llevas facturado <strong>${eur(resumenMes.transferencia + resumenMes.efectivo)}</strong>
    (${eur(resumenMes.transferencia)} por transferencia, ${eur(resumenMes.efectivo)} en efectivo).
    En lo que va de ${anio}, tu beneficio fiscal (transferencia − gastos deducibles) es de
    <strong style="color:var(--green-fg)">${eur(resumenAnual.beneficioFiscal)}</strong>
    y tu beneficio real (contando también el efectivo y los gastos personales) es de
    <strong style="color:var(--green-fg)">${eur(resumenAnual.beneficioReal)}</strong>.
    El próximo pago estimado del Modelo 130 (T${qActual}) es de <strong>${eur(provision.aIngresar)}</strong>.
  `;

  container.innerHTML = `
    <div class="card ai-banner" style="margin-bottom:20px;">
      <strong>Resumen del negocio</strong>
      <p style="margin:8px 0 0; line-height:1.6;">${resumenTexto}</p>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3>Alertas y pendientes ${alertas.length ? `<span class="badge" style="background:var(--orange-bg); color:var(--orange-fg);">${alertas.length}</span>` : ""}</h3>
        ${alertas.length ? `<div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
          ${alertas.slice(0,10).map(a => `<a href="${a.href}" style="display:block; padding:10px 12px; border-radius:8px; background:var(--light); color:var(--text); text-decoration:none; font-size:13px;">${escapeHtml(a.texto)}</a>`).join("")}
        </div>` : `<p class="muted" style="margin-top:10px;">Todo en orden — no hay pendientes que requieran tu atención ahora mismo. 🎉</p>`}
      </div>

      <div class="card">
        <h3>Flujo B — Factura desde un proyecto</h3>
        <p class="muted">Abre un proyecto y pulsa "Generar factura": la app cruza los datos del cliente vinculado con el precio acordado y prepara un borrador listo para revisar.</p>
        <a href="#/proyectos" class="btn btn-dark" style="text-decoration:none; display:inline-block;">Ir a Proyectos</a>
        <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;">
        <p class="muted" style="font-size:12px;">Este asistente usa un motor de reglas propio, gratuito, sobre tus propios datos. Nunca guarda nada automáticamente: siempre revisas y confirmas antes.</p>
      </div>
    </div>

    <div class="card">
      <h3>Flujo A — Pegar datos de un cliente nuevo</h3>
      <p class="muted">Pega aquí cualquier texto (un email, un WhatsApp, una nota) con los datos de un cliente. Detecta NIF/CIF, email, teléfono, IBAN y dirección.</p>
      <div class="field"><textarea id="texto-cliente" rows="6" placeholder="Ej: JUNO Media SL&#10;CIF B12345678&#10;contacto@junomedia.es&#10;Tel 612 345 678&#10;C/ Ejemplo 12, 03500 Benidorm"></textarea></div>
      <button class="btn btn-primary" id="btn-analizar">Analizar texto</button>
      <div id="resultado-analisis" style="margin-top:18px;"></div>
    </div>`;

  container.querySelector("#btn-analizar").addEventListener("click", () => {
    const texto = container.querySelector("#texto-cliente").value;
    const campos = parseClienteDesdeTexto(texto);
    pintarResultado(container, campos);
  });
}

function MES_LARGO(idx) {
  return ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][idx];
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
