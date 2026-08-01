import { getConfig, setConfig, DEFAULTS } from "../utils/config-usuario.js";
import { CONFIG_NEGOCIO, CAMPOS_EMISOR, EMISOR_BASE, guardarEmisor } from "../utils/config-negocio.js";
import { toastOk, toastError, animarVista, confirmar } from "../utils/ui.js";
import { listarServicios, crearServicio, actualizarServicio, borrarServicio } from "../utils/servicios.js";
import { listarCondiciones, crearCondicion, actualizarCondicion, borrarCondicion, GRUPOS_CONDICION } from "../utils/condiciones.js";
import { eur } from "../utils/format.js";
import { auth } from "../supabase.js";
import * as gcal from "../utils/gcal.js";

export async function renderConfiguracion(container) {
  // El "modo vista" (entrar sin contrasena) existe para ensenar la interfaz sin
  // datos. Configuracion muestra NIF, direccion e IBAN, asi que aqui se corta:
  // sin sesion no se pinta nada.
  if (!auth.isLoggedIn()) {
    container.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Configuracion</h3></div>
        <p class="muted">Esta pagina contiene datos fiscales y bancarios. Inicia sesion para verla.</p>
      </div>`;
    return;
  }
  const cfg = getConfig();
  const { data: servicios } = await listarServicios();
  const { data: condiciones } = await listarCondiciones();
  const emisor = CONFIG_NEGOCIO.emisor;

  container.innerHTML = `
    <div class="tabs cfg-tabs" id="cfg-tabs">
      <button data-tab="fiscal" class="active" type="button">Datos fiscales</button>
      <button data-tab="emisor" type="button">Emisor</button>
      <button data-tab="tarifas" type="button">Tarifas</button>
      <button data-tab="condiciones" type="button">Condiciones</button>
      <button data-tab="calendario" type="button">Calendario</button>
      <button data-tab="ia" type="button">IA</button>
    </div>

    <div data-panel="fiscal">
    <div class="grid grid-2" style="align-items:start; margin-bottom:16px;">
      <div class="card">
        <div class="card-head"><h3>Datos fiscales</h3><span class="help-tip" title="Estos valores cambian con el tiempo (p. ej. la cuota de autónomo reducida sube a partir del año que viene) — actualízalos aquí cuando toque, sin tener que tocar código.">i</span></div>
        <div class="field">
          <label>% Modelo 130 (pago fraccionado trimestral)</label>
          <input id="c-modelo130" type="number" step="0.5" value="${cfg.modelo130_pct}">
          <p class="hint" style="margin:6px 0 0;">Se aplica sobre (ingresos − gastos) de cada trimestre, sin acumular con trimestres anteriores. Estándar general: 20%. Tú estás ahora en cuota/situación reducida.</p>
        </div>
        <div class="field">
          <label>Cuota de autónomo mensual (€)</label>
          <input id="c-cuota-autonomo" type="number" step="0.01" value="${cfg.cuota_autonomo_importe}">
        </div>
        <div class="row">
          <div class="field"><label>Gestoría — importe mensual con IVA (€)</label><input id="c-gestoria" type="number" step="0.01" value="${cfg.gestoria_importe}"></div>
          <div class="field"><label>Gestoría — IVA soportado (€)</label><input id="c-gestoria-iva" type="number" step="0.01" value="${cfg.gestoria_iva_soportado}"></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" id="btn-guardar-fiscal">Guardar</button>
        </div>
      </div>

    </div>
    </div>

    <div data-panel="calendario" hidden>
      <div class="card">
        <div class="card-head"><h3>Google Calendar</h3><span class="help-tip" title="El calendario del Dashboard lee y escribe directamente en tu agenda de Google. No se guarda ninguna copia de tus eventos en la base de datos de la app.">i</span></div>
        <p class="hint" style="margin-top:0;">
          Se conecta sin servidor y sin coste. Solo hay que crear una vez un <strong>ID de cliente OAuth</strong> (gratis, sin tarjeta):<br>
          1. Entra en <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> y crea un proyecto (nombre: JML Studio).<br>
          2. En <em>APIs y servicios → Biblioteca</em>, busca <strong>Google Calendar API</strong> y pulsa Habilitar.<br>
          3. En <em>Pantalla de consentimiento</em>: tipo <strong>Externo</strong>, y añádete a ti mismo como usuario de prueba.<br>
          4. En <em>Credenciales → Crear credenciales → ID de cliente de OAuth</em>, tipo <strong>Aplicación web</strong>. En "Orígenes autorizados de JavaScript" pon exactamente:
          <code>https://josepml.github.io</code><br>
          5. Copia el ID que termina en <code>.apps.googleusercontent.com</code> y pégalo aquí.
        </p>
        <div class="field">
          <label>ID de cliente de OAuth</label>
          <input id="c-gcal-id" type="text" value="${escapeAttr(gcal.clientId())}" placeholder="1234567890-xxxx.apps.googleusercontent.com" autocomplete="off">
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" id="btn-guardar-gcal">Guardar</button>
          <button class="btn btn-sec" id="btn-probar-gcal">Conectar y probar</button>
        </div>
        <div id="gcal-resultado" class="hint-box" style="margin-top:12px;" hidden></div>
        <p class="hint-sm" style="margin-top:12px;">El ID no es un secreto (solo funciona desde josepml.github.io), pero se guarda igualmente en este navegador y nunca en el repositorio. Si usas la app desde el móvil, pégalo también allí.</p>
      </div>
    </div>

    <div data-panel="ia" hidden>
      <div class="card">
        <div class="card-head"><h3>IA (Mistral)</h3><span class="help-tip" title="Clave gratuita de Mistral para el chat del Asistente y el botón 'Mejorar con IA' de los presupuestos. Se guarda solo en este navegador, nunca en el repositorio.">i</span></div>
        <p class="hint" style="margin-top:0;">
          1. Entra en <a href="https://console.mistral.ai/api-keys" target="_blank" rel="noopener">console.mistral.ai/api-keys</a> y crea una cuenta (gratis, sin tarjeta; pide un móvil para verificar).<br>
          2. Elige el plan <strong>Experiment</strong>, que es el gratuito.<br>
          3. Crea una clave y pégala aquí.
        </p>
        <div class="field">
          <label>Clave de API de Mistral</label>
          <input id="c-ia-key" type="password" value="${escapeAttr(cfg.ia_api_key)}" placeholder="Pega aquí tu clave…" autocomplete="off">
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" id="btn-guardar-ia">Guardar</button>
          <button class="btn btn-sec" id="btn-probar-ia">Probar</button>
        </div>
        <div id="ia-resultado" class="hint-box" style="margin-top:12px;" hidden></div>
        <p class="hint-sm" style="margin-top:12px;">La clave se guarda solo en este dispositivo (localStorage del navegador). Si usas la app desde el móvil y el ordenador, pégala en los dos.</p>
        <div class="hint-box" style="margin-top:10px;">
          Antes esto usaba Google Gemini, pero Google no permite su capa gratuita a usuarios de España/UE y siempre devolvía error de cuota. Mistral es francesa: la capa gratuita funciona aquí y tus datos no salen de la UE. Va limitada a unas pocas peticiones por minuto, así que si preguntas muy seguido puede pedirte que esperes unos segundos.
        </div>
      </div>
    </div>

    <div data-panel="emisor" hidden>
    <div class="card">
      <div class="card-head">
        <h3>Datos de emisor (los que salen en tus facturas)</h3>
        <span class="help-tip" title="Estos datos estaban fijos en el código: cambiar de dirección o de banco obligaba a editar ficheros. Ahora se editan aquí y los PDFs los recogen al momento. Deja un campo vacío para volver al valor original.">i</span>
      </div>
      <div class="grid grid-3">
        ${CAMPOS_EMISOR.map(c => `
          <div class="field">
            <label>${c.label}</label>
            <input id="e-${c.clave}" value="${escapeAttr(emisor[c.clave] || "")}" placeholder="${escapeAttr(EMISOR_BASE[c.clave] || "")}">
          </div>`).join("")}
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="btn-guardar-emisor">Guardar datos de emisor</button>
        <button class="btn btn-ghost" id="btn-restaurar-emisor">Restaurar los originales</button>
      </div>
      <p class="hint-sm" style="margin-top:12px;">Se aplican a las facturas y presupuestos que generes a partir de ahora. Los PDFs ya descargados no cambian.</p>
    </div>
    </div>

    <div data-panel="tarifas" hidden>
    <div class="card">
      <div class="card-head">
        <h3>Tarifas de servicios</h3>
        <button class="btn btn-primary btn-sm" id="btn-nueva-tarifa" type="button">+ Nueva tarifa</button>
      </div>
      <p class="hint" style="margin-top:0;">Lo que aparece en el desplegable "Añadir servicio" al crear una factura o un presupuesto. Se guardan en tu base de datos, así que las tienes iguales en el móvil y en el ordenador. Los cambios se guardan solos al salir de cada campo.</p>
      <div id="form-tarifa" class="form-inline hidden">
        <div class="row">
          <div class="field" style="flex:2;"><label>Nombre del servicio</label><input id="t-nombre" placeholder="Ej. Grabación de concierto"></div>
          <div class="field"><label>Precio (€, sin IVA)</label><input id="t-precio" type="number" step="0.01" placeholder="0.00"></div>
          <div class="field"><label>Unidad</label><input id="t-unidad" placeholder="jornada, hora…"></div>
        </div>
        <div class="field"><label>Descripción (opcional, se copia a la línea del presupuesto)</label><textarea id="t-descripcion" rows="2"></textarea></div>
        <div class="form-inline-acciones">
          <button class="btn btn-primary" id="btn-crear-tarifa" type="button">Guardar tarifa</button>
          <button class="btn btn-ghost" id="btn-cancelar-tarifa" type="button">Cancelar</button>
        </div>
      </div>
      <div id="tarifas-lista"></div>
    </div>
    </div>

    <div data-panel="condiciones" hidden>
    <div class="card">
      <div class="card-head">
        <h3>Condiciones de presupuesto</h3>
        <button class="btn btn-primary btn-sm" id="btn-nueva-condicion" type="button">+ Nueva condición</button>
      </div>
      <p class="hint" style="margin-top:0;">Las <strong>generales fijas</strong> se añaden solas a cada presupuesto nuevo. Las fijas de <strong>rodaje</strong> y <strong>postproducción</strong> entran en bloque al pulsar su pack en el editor. Las opcionales se eligen una a una. Ninguna es obligatoria: en cada presupuesto puedes editarlas o quitarlas, y el PDF imprime solo lo que ese documento lleve.</p>
      <div id="form-condicion-cfg" class="form-inline hidden">
        <div class="field"><label>Texto de la condición</label><textarea id="k-texto" rows="3" placeholder="Ej. El uso de láseres durante el evento puede dañar los sensores de las cámaras."></textarea></div>
        <div class="row">
          <div class="field"><label>Grupo</label>
            <select id="k-grupo-nueva"><option value="generales">Generales (todos los presupuestos)</option><option value="rodaje">Rodaje / grabación</option><option value="postproduccion">Postproducción</option></select>
          </div>
          <div class="field"><label>¿Fija del grupo?</label>
            <select id="k-defecto"><option value="0">No, opcional: la elijo yo</option><option value="1">Sí, entra con el pack</option></select>
          </div>
        </div>
        <div class="form-inline-acciones">
          <button class="btn btn-primary" id="btn-crear-condicion-cfg" type="button">Guardar condición</button>
          <button class="btn btn-ghost" id="btn-cancelar-condicion-cfg" type="button">Cancelar</button>
        </div>
      </div>
      <div id="condiciones-lista-cfg"></div>
    </div>
    </div>`;

  // Cinco secciones muy distintas en una sola página obligaban a un scroll
  // larguísimo para llegar a las condiciones. Con pestañas, cada cosa está a
  // un clic y la página no crece.
  const $cfgTabs = container.querySelector("#cfg-tabs");
  $cfgTabs.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      $cfgTabs.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
      container.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== btn.dataset.tab; });
    });
  });

  container.querySelector("#btn-guardar-fiscal").addEventListener("click", () => {
    setConfig({
      modelo130_pct: Number(container.querySelector("#c-modelo130").value || DEFAULTS.modelo130_pct),
      cuota_autonomo_importe: Number(container.querySelector("#c-cuota-autonomo").value || DEFAULTS.cuota_autonomo_importe),
      gestoria_importe: Number(container.querySelector("#c-gestoria").value || DEFAULTS.gestoria_importe),
      gestoria_iva_soportado: Number(container.querySelector("#c-gestoria-iva").value || DEFAULTS.gestoria_iva_soportado),
    });
    toastOk("Datos fiscales guardados.");
  });

  container.querySelector("#btn-guardar-gcal").addEventListener("click", () => {
    gcal.guardarClientId(container.querySelector("#c-gcal-id").value);
    toastOk("ID de Google guardado en este dispositivo.");
  });

  // "Probar" hace el recorrido completo (consentimiento + listar calendarios)
  // para que el error salga aquí, con su mensaje, y no en el Dashboard.
  container.querySelector("#btn-probar-gcal").addEventListener("click", async () => {
    const $res = container.querySelector("#gcal-resultado");
    gcal.guardarClientId(container.querySelector("#c-gcal-id").value);
    $res.hidden = false;
    $res.textContent = "Conectando con Google…";
    try {
      const cals = await gcal.conectar({ silencioso: false }).then(() => gcal.listarCalendarios());
      $res.innerHTML = `Conectado. Calendarios con permiso de escritura: <strong>${cals.map(c => escapeHtml(c.nombre)).join(", ")}</strong>.`;
      toastOk("Google Calendar conectado.");
    } catch (e) {
      $res.textContent = e.message || "No se ha podido conectar.";
      toastError("No se ha podido conectar con Google.");
    }
  });

  container.querySelector("#btn-guardar-ia").addEventListener("click", () => {
    setConfig({ ia_api_key: container.querySelector("#c-ia-key").value.trim() });
    toastOk("Clave guardada en este dispositivo.");
  });

  // Una llamada real y mínima, para que sepa si la clave sirve sin tener que
  // irse a Presupuestos a probar el botón de IA.
  container.querySelector("#btn-probar-ia").addEventListener("click", async () => {
    const $res = container.querySelector("#ia-resultado");
    setConfig({ ia_api_key: container.querySelector("#c-ia-key").value.trim() });
    $res.hidden = false;
    $res.textContent = "Probando…";
    try {
      const { mejorarDescripcionConIA } = await import("../ai/mistral.js");
      const texto = await mejorarDescripcionConIA("Grabación", "prueba de conexión, 1 cámara");
      $res.textContent = `Funciona. Ejemplo devuelto: “${texto}”`;
      toastOk("La IA responde correctamente.");
    } catch (e) {
      $res.textContent = e.message || "No se ha podido conectar con la IA.";
      toastError("La IA no ha respondido.");
    }
  });

  container.querySelector("#btn-guardar-emisor").addEventListener("click", async () => {
    // Solo se guardan los campos con contenido: los vacíos se omiten para que
    // el valor original siga haciendo de respaldo (ver config-negocio.js).
    const nuevo = {};
    CAMPOS_EMISOR.forEach(c => {
      const v = container.querySelector(`#e-${c.clave}`).value.trim();
      if (v) nuevo[c.clave] = v;
    });
    setConfig({ emisor: {} });
    const { error } = await guardarEmisor(nuevo);
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    toastOk("Datos de emisor guardados. Se usarán en los próximos PDFs.");
  });

  container.querySelector("#btn-restaurar-emisor").addEventListener("click", () => {
    setConfig({ emisor: {} });
    toastOk("Datos de emisor restaurados a los originales.");
    renderConfiguracion(container);
  });

  // --- Tarifas de servicios ---
  // Edición en el sitio: cada campo guarda al perder el foco. Es un catálogo
  // corto que se retoca de vez en cuando; abrir un formulario por fila para
  // cambiar un precio sería más clics que valor.
  const $lista = container.querySelector("#tarifas-lista");
  function pintarTarifas() {
    if (!servicios.length) {
      $lista.innerHTML = `<div class="empty-state" style="padding:26px 10px;">Todavía no tienes tarifas. Crea la primera y aparecerá al hacer facturas y presupuestos.</div>`;
      return;
    }
    $lista.innerHTML = `
      <div class="tabla-scroll">
      <table class="tabla-lineas">
        <thead><tr>
          <th>Servicio y descripción</th><th class="col-num">Precio</th><th>Unidad</th><th>Se ofrece</th><th class="col-acc"></th>
        </tr></thead>
        <tbody>
        ${servicios.map(s => `
          <tr data-id="${s.id}">
            <td data-label="Servicio">
              <input class="t-nombre" value="${escapeAttr(s.nombre || "")}">
              <div class="linea-desc-wrap"><textarea class="t-desc" rows="2" placeholder="Descripción (opcional)">${escapeHtml(s.descripcion || "")}</textarea></div>
              <div class="k-acciones">
                <button class="btn btn-primary btn-sm t-guardar" type="button">Guardar cambios</button>
                <span class="k-aviso">Sin guardar</span>
              </div>
            </td>
            <td data-label="Precio" class="col-num"><input class="t-precio" type="number" step="0.01" value="${Number(s.precio || 0)}"></td>
            <td data-label="Unidad"><input class="t-unidad" value="${escapeAttr(s.unidad || "")}" placeholder="jornada…"></td>
            <td data-label="Se ofrece">
              <select class="t-activo">
                <option value="1" ${s.activo !== false ? "selected" : ""}>Sí</option>
                <option value="0" ${s.activo === false ? "selected" : ""}>Retirada</option>
              </select>
            </td>
            <td class="col-acc"><button class="icon-btn t-borrar" type="button" title="Eliminar tarifa">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
      </div>`;

    $lista.querySelectorAll("tr[data-id]").forEach(row => {
      const id = row.dataset.id;
      const s = servicios.find(x => x.id === id);
      // Igual que en las condiciones: nombre, precio, unidad y descripción son
      // datos que acaban en un presupuesto, así que nada se escribe hasta pulsar
      // Guardar. Solo "Se ofrece" guarda al instante: es un sí/no sin texto que
      // revisar y su efecto (aparecer o no en el desplegable) es reversible.
      const campos = {
        nombre:      { el: row.querySelector(".t-nombre"), leer: e => e.value.trim(),        actual: () => s.nombre || "" },
        precio:      { el: row.querySelector(".t-precio"), leer: e => Number(e.value || 0), actual: () => Number(s.precio || 0) },
        unidad:      { el: row.querySelector(".t-unidad"), leer: e => e.value.trim(),        actual: () => s.unidad || "" },
        descripcion: { el: row.querySelector(".t-desc"),   leer: e => e.value.trim(),        actual: () => s.descripcion || "" },
      };
      const $acciones = row.querySelector(".k-acciones");
      const $guardar = row.querySelector(".t-guardar");
      const hayCambios = () => Object.values(campos).some(c => String(c.leer(c.el)) !== String(c.actual()));
      const marcarSucio = () => $acciones.classList.toggle("sucio", hayCambios());
      Object.values(campos).forEach(c => c.el.addEventListener("input", marcarSucio));
      Object.values(campos).forEach(c => c.el.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $guardar.click(); }
        if (e.key === "Escape") { Object.values(campos).forEach(x => { x.el.value = x.actual(); }); marcarSucio(); }
      }));

      $guardar.addEventListener("click", async () => {
        const nombre = campos.nombre.leer(campos.nombre.el);
        if (!nombre) { toastError("La tarifa necesita un nombre."); campos.nombre.el.focus(); return; }
        const cambios = {
          nombre,
          precio: campos.precio.leer(campos.precio.el),
          unidad: campos.unidad.leer(campos.unidad.el) || null,
          descripcion: campos.descripcion.leer(campos.descripcion.el) || null,
        };
        $guardar.disabled = true;
        Object.assign(s, cambios);
        const { error } = await actualizarServicio(id, cambios);
        $guardar.disabled = false;
        if (error) { toastError("No se ha podido guardar: " + error); return; }
        marcarSucio();
        toastOk(`Tarifa "${nombre}" guardada.`);
      });

      row.querySelector(".t-activo").addEventListener("change", async e => {
        const activo = e.target.value === "1";
        s.activo = activo;
        const { error } = await actualizarServicio(id, { activo });
        if (error) { toastError("No se ha podido guardar: " + error); return; }
        toastOk(activo ? "La tarifa vuelve a ofrecerse." : "Tarifa retirada del desplegable.");
      });

      row.querySelector(".t-borrar").addEventListener("click", async () => {
        if (!await confirmar({
          titulo: "¿Eliminar la tarifa?",
          mensaje: `"${s.nombre}" desaparecerá del desplegable. Las facturas y presupuestos que ya la usaron no cambian: guardan su propia copia del concepto y del precio. Si solo quieres dejar de usarla, márcala como "Retirada".`,
          confirmar: "Eliminar", peligroso: true,
        })) return;
        const { error } = await borrarServicio(id);
        if (error) { toastError("No se ha podido eliminar: " + error); return; }
        servicios.splice(servicios.findIndex(x => x.id === id), 1);
        pintarTarifas();
        toastOk("Tarifa eliminada.");
      });
    });
  }
  pintarTarifas();

  const $formTarifa = container.querySelector("#form-tarifa");
  container.querySelector("#btn-nueva-tarifa").addEventListener("click", () => {
    $formTarifa.classList.remove("hidden");
    container.querySelector("#t-nombre").focus();
  });
  container.querySelector("#btn-cancelar-tarifa").addEventListener("click", () => $formTarifa.classList.add("hidden"));
  container.querySelector("#btn-crear-tarifa").addEventListener("click", async () => {
    const nombre = container.querySelector("#t-nombre").value.trim();
    if (!nombre) { toastError("Ponle un nombre a la tarifa."); return; }
    const { data, error } = await crearServicio({
      nombre,
      precio: Number(container.querySelector("#t-precio").value || 0),
      unidad: container.querySelector("#t-unidad").value,
      descripcion: container.querySelector("#t-descripcion").value,
      orden: servicios.length,
    });
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    servicios.push(Array.isArray(data) ? data[0] : data);
    ["#t-nombre", "#t-precio", "#t-unidad", "#t-descripcion"].forEach(sel => { container.querySelector(sel).value = ""; });
    $formTarifa.classList.add("hidden");
    pintarTarifas();
    toastOk(`Tarifa "${nombre}" guardada.`);
  });

  // --- Condiciones de presupuesto ---
  // Mismo patrón que las tarifas: se edita en el sitio y guarda al salir del
  // campo. Aquí se gestiona la PLANTILLA; cada presupuesto se queda con su
  // propia copia del texto, así que cambiar esto no reescribe documentos ya
  // hechos (ni borrarlo los deja sin condiciones).
  const $condLista = container.querySelector("#condiciones-lista-cfg");
  function pintarCondicionesCfg() {
    if (!condiciones.length) {
      $condLista.innerHTML = `<div class="empty-state" style="padding:26px 10px;">No tienes condiciones guardadas. Crea la primera y aparecerá al hacer presupuestos.</div>`;
      return;
    }
    $condLista.innerHTML = `
      <div class="tabla-scroll">
      <table class="tabla-lineas">
        <thead><tr><th>Texto</th><th>Grupo</th><th>Fija del grupo</th><th class="col-acc"></th></tr></thead>
        <tbody>
        ${condiciones.map(c => `
          <tr data-id="${c.id}">
            <td data-label="Texto">
              <textarea class="k-texto" rows="3">${escapeHtml(c.texto || "")}</textarea>
              <div class="k-acciones">
                <button class="btn btn-primary btn-sm k-guardar" type="button">Guardar cambios</button>
                <span class="k-aviso">Sin guardar</span>
              </div>
            </td>
            <td data-label="Grupo">
              <select class="k-grupo">
                ${Object.entries(GRUPOS_CONDICION).map(([k, v]) => `<option value="${k}" ${(c.grupo || "generales") === k ? "selected" : ""}>${v}</option>`).join("")}
              </select>
            </td>
            <td data-label="Fija del grupo">
              <select class="k-defecto">
                <option value="1" ${c.por_defecto ? "selected" : ""}>Sí</option>
                <option value="0" ${c.por_defecto ? "" : "selected"}>No</option>
              </select>
            </td>
            <td class="col-acc"><button class="icon-btn k-borrar" type="button" title="Borrar condición">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
      </div>`;

    $condLista.querySelectorAll("tr[data-id]").forEach(row => {
      const id = row.dataset.id;
      const c = condiciones.find(x => x.id === id);
      const guardar = async (cambios, etiqueta) => {
        Object.assign(c, cambios);
        const { error } = await actualizarCondicion(id, cambios);
        if (error) { toastError("No se ha podido guardar: " + error); return; }
        toastOk(etiqueta);
      };
      // El texto NO se guarda al salir del campo. Es lo que ve el cliente en el
      // presupuesto, así que un guardado silencioso no da confianza: aparece un
      // botón en cuanto el texto cambia y no se escribe nada hasta pulsarlo.
      const $texto = row.querySelector(".k-texto");
      const $acciones = row.querySelector(".k-acciones");
      const $guardar = row.querySelector(".k-guardar");
      const marcarSucio = () => $acciones.classList.toggle("sucio", $texto.value !== c.texto);
      $texto.addEventListener("input", marcarSucio);
      $guardar.addEventListener("click", async () => {
        const texto = $texto.value.trim();
        if (!texto) { toastError("La condición no puede quedarse vacía."); $texto.focus(); return; }
        $guardar.disabled = true;
        await guardar({ texto }, "Condición guardada.");
        $guardar.disabled = false;
        $texto.value = c.texto;
        marcarSucio();
      });
      // Ctrl+Enter guarda sin soltar el teclado; Escape descarta la edición.
      $texto.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $guardar.click(); }
        if (e.key === "Escape") { $texto.value = c.texto; marcarSucio(); }
      });
      row.querySelector(".k-grupo").addEventListener("change", e => guardar(
        { grupo: e.target.value },
        `Movida al grupo ${GRUPOS_CONDICION[e.target.value]}.`
      ));
      row.querySelector(".k-defecto").addEventListener("change", e => {
        const fija = e.target.value === "1";
        const g = c.grupo || "generales";
        guardar({ por_defecto: fija }, fija
          ? (g === "generales" ? "Se añadirá sola a los presupuestos nuevos." : `Entrará en el pack de ${GRUPOS_CONDICION[g].toLowerCase()}.`)
          : "Pasa a opcional: se elige una a una en el desplegable.");
      });
      row.querySelector(".k-borrar").addEventListener("click", async () => {
        if (!await confirmar({
          titulo: "¿Borrar la condición?",
          mensaje: "Dejará de ofrecerse al hacer presupuestos. Los presupuestos que ya la usan la conservan: guardan su propia copia del texto.",
          confirmar: "Borrar", peligroso: true,
        })) return;
        const { error } = await borrarCondicion(id);
        if (error) { toastError("No se ha podido borrar: " + error); return; }
        condiciones.splice(condiciones.findIndex(x => x.id === id), 1);
        pintarCondicionesCfg();
        toastOk("Condición borrada.");
      });
    });
  }
  pintarCondicionesCfg();

  const $formCond = container.querySelector("#form-condicion-cfg");
  container.querySelector("#btn-nueva-condicion").addEventListener("click", () => {
    $formCond.classList.remove("hidden");
    container.querySelector("#k-texto").focus();
  });
  container.querySelector("#btn-cancelar-condicion-cfg").addEventListener("click", () => $formCond.classList.add("hidden"));
  container.querySelector("#btn-crear-condicion-cfg").addEventListener("click", async () => {
    const texto = container.querySelector("#k-texto").value.trim();
    if (!texto) { toastError("Escribe el texto de la condición."); return; }
    const { data, error } = await crearCondicion({
      texto,
      grupo: container.querySelector("#k-grupo-nueva").value,
      por_defecto: container.querySelector("#k-defecto").value === "1",
      orden: condiciones.length,
    });
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    condiciones.push(Array.isArray(data) ? data[0] : data);
    container.querySelector("#k-texto").value = "";
    $formCond.classList.add("hidden");
    pintarCondicionesCfg();
    toastOk("Condición guardada.");
  });

  animarVista(container);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
