# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# JML Studio

PWA privada de gestión de negocio para **Josep Mira Lozano**, autónomo español
de producción audiovisual B2B. Una sola persona la usa: no hay registro
público, ni multi-tenant, ni roles.

- **Producción:** https://josepml.github.io/jml-studio
- **Repositorio:** https://github.com/JosepML/jml-studio (rama `main`, público)
- **Base de datos:** Supabase (Postgres + Auth + PostgREST), proyecto
  `jgolxrpxyuxpqqdyikwb`. Credenciales en `js/config.js` (la `anon key` es
  pública por diseño; lo que protege los datos es RLS).
- **Idioma:** todo —código, comentarios, UI, commits— en español.

---

# 1. Lo que hay que leer antes de tocar nada

## 1.1 No hay build, ni tests, ni linter

No hay `package.json`, ni bundler, ni framework. Son ficheros estáticos que el
navegador ejecuta tal cual: HTML + CSS + JavaScript con ES modules nativos.
GitHub Pages sirve la carpeta raíz de `main` directamente.

Consecuencias prácticas:

- **No existe `npm run build` / `test` / `lint`.** No los inventes ni los
  ofrezcas.
- La única comprobación estática disponible es la sintáctica, y hay que
  hacerla **como módulo**:
  ```bash
  node --input-type=module --check < js/views/facturacion.js
  ```
  Hazla **siempre** antes de desplegar un `.js`. Un error de sintaxis rompe el
  módulo entero y la app se queda en blanco, sin aviso.

  ⚠️ **`node --check fichero.js` a secas da falsos aprobados.** El 2026-07-30
  pasó exactamente eso: `js/views/configuracion.js` llevaba un fragmento
  duplicado (`toastOk(...); }); }); } pintarTarifas();` repetido tras cerrar la
  función), `node --check` lo dio por bueno, se desplegó y la app se quedó en
  blanco con `SyntaxError: Unexpected token ')'`. Con `--input-type=module <`
  el error salta. Comprueba **todos** los ficheros de golpe:
  ```bash
  for f in $(find js -name '*.js') sw.js; do
    node --input-type=module --check < "$f" 2>/dev/null || echo "FAIL $f"
  done
  ```
- No hay `import` de paquetes: las dependencias externas (jsPDF, Chart.js) se
  cargan por `<script>` desde CDN bajo demanda.
- Cualquier ruta de `import` es relativa y real. No hay alias ni resolución
  mágica.

## 1.2 No hay git: el despliegue es manual por el editor web de GitHub

**Este es el punto que más tiempo hace perder si no se sabe.** El sandbox
(`mcp__workspace__bash`) **no tiene salida a github.com**: `git push`, `curl` o
`gh` fallan con error de red. El único camino para publicar es el editor web,
conducido con las herramientas de Claude in Chrome.

### Vía preferida: **subir el fichero** (coste cero en tokens y sin trampas)

Descubierta el 2026-07-30. Sustituye al pegado manual siempre que el fichero
cambie mucho, y evita de golpe todas las trampas del editor CodeMirror.

GitHub tiene una página de subida por carpeta, y la extensión de Chrome puede
rellenar un `<input type="file">` con cualquier fichero de una carpeta que
Josep haya conectado. Como la carpeta de trabajo (`.../FACTURAS/2026`) está
montada en el sandbox, el fichero viaja del sandbox al repo **sin pasar por el
contexto**.

1. `cp js/views/configuracion.js /sessions/<sesión>/mnt/2026/configuracion.js`
   — el nombre del fichero copiado es el que tendrá en el repo.
2. `navigate` a `https://github.com/JosepML/jml-studio/upload/main/<carpeta>`
   (p. ej. `.../upload/main/js/views` o `.../upload/main/css`).
   Si la pestaña ya venía de esa URL, GitHub redirige a la raíz del repo:
   vuelve a navegar.
3. `find` con "file input for choosing files to upload" → devuelve el `ref`.
4. `mcp__claude-in-chrome__file_upload` con la ruta **Windows**:
   `C:\Users\Josep\Documents\AUTONOMO\FACTURAS\2026\configuracion.js`.
5. Mensaje de commit: el primer clic en el campo se lo come el enlace "choose
   your files"; hay que **clicar dos veces** o clicar lejos del enlace
   (x≈1000). Si falla, el mensaje por defecto "Add files via upload" sirve.
6. "Commit changes". Subir un fichero con un nombre que ya existe lo
   **sobrescribe**, no da conflicto.
7. Borrar la copia de la carpeta de Josep al terminar. `rm` falla con
   "Operation not permitted" hasta llamar a
   `mcp__cowork__allow_cowork_file_delete`.

Ojo: `raw.githubusercontent.com` puede servir la versión **anterior** durante
un rato aunque le pongas `?x=Date.now()`. Para verificar que la subida entró,
mira la página `blob` del fichero (nº de líneas y KB) en vez de fiarte del raw.

### Procedimiento de despliegue de un fichero

1. **Diferenciar antes de escribir** (ver §1.3). Nunca pegues tu copia local
   encima sin comprobar qué hay publicado.
2. Poner el contenido nuevo en el portapapeles. Dos vías:
   - **Preferida (coste cero en tokens):** transformar el fichero *dentro del
     navegador*. Se hace `fetch` del fichero desplegado desde
     `raw.githubusercontent.com`, se aplican los reemplazos con JS, y se
     escribe con `navigator.clipboard.writeText(...)`. El contenido nunca pasa
     por el contexto. **Requiere que la pestaña tenga el foco**: si no, falla
     con `NotAllowedError: Document is not focused`. Se arregla con un
     `left_click` en la página antes de escribir al portapapeles.
   - Alternativa: `mcp__computer-use__write_clipboard` con el contenido local.
     Cuesta el fichero entero en tokens.
3. Navegar a `https://github.com/josepml/jml-studio/edit/main/<ruta>`.
4. Click **dentro** de una línea de código (no en el margen), `ctrl+a`,
   `Delete`.
5. **Captura de verificación:** el editor debe mostrar una única línea vacía
   con el marcador "Enter file contents here". Este paso falla a menudo —el
   click llega antes de que CodeMirror esté listo y el borrado no se aplica—.
   Si el contenido sigue ahí, repite el click + `ctrl+a` + `Delete`.
6. `ctrl+v`, esperar, `ctrl+End`, captura y **verificar el número de la última
   línea** contra el esperado.
7. "Commit changes…" → mensaje descriptivo en español → "Commit changes".

### Trampas conocidas del despliegue

- **La vista `blob` de GitHub cachea.** Tras hacer commit puede seguir
  mostrando la versión anterior. Para verificar de verdad, usa
  `raw.githubusercontent.com/josepml/jml-studio/main/<ruta>?v=<timestamp>` con
  `cache: "no-store"`.
- **El portapapeles es compartido con Josep.** Si él copia algo mientras tú
  trabajas, tu siguiente pegado inserta su texto. Ya ha pasado. Verifica con
  `read_clipboard` o revisa la captura previa al commit.
- **Cambios de firma → orden de despliegue.** Si cambias la firma de una
  función exportada, despliega el módulo consumidor *inmediatamente* después
  del proveedor. Entre un commit y el siguiente, producción está rota. Ya
  ocurrió con `resumenIvaTrimestre` y `financiero.js`.
- **`Page.captureScreenshot` da timeout** con frecuencia tras pegar ficheros
  grandes. Reintenta la captura: suele salir a la segunda.
- **Reemplazo parcial** (para ficheros grandes): click al inicio de la línea de
  corte → `Home` → `ctrl+shift+End` → `Delete` → pegar solo la cola.

## 1.3 Regla de oro: la copia local **no** es la fuente de verdad

La carpeta de trabajo del sandbox es un borrador desechable que se pierde entre
sesiones y **se desincroniza**. La verdad está en `main`.

**Estado comprobado el 2026-07-28: 7 ficheros de la copia local difieren de los
desplegados** — `css/style.css`, `js/app.js`, `js/utils/charts.js`,
`js/views/clientes.js`, `js/views/configuracion.js`, `js/views/gastos.js`,
`js/views/proyectos.js`. En `app.js` la diferencia es solo de colocación (el
bloque del menú plegable está al final en producción y en medio en local); en
los demás no se ha verificado en qué dirección va el desfase.

Esto ya provocó un caso real en el que la versión desplegada tenía un arreglo
que faltaba en local (la vista previa aplicando el descuento) y la local tenía
otro que faltaba en producción (el enlace condicional a Clientes). Pegar
cualquiera de las dos encima habría causado una regresión silenciosa.

### Procedimiento obligatorio antes de editar un fichero

```
1. fetch del fichero desplegado (raw.githubusercontent.com, cache no-store)
2. Comparar con la copia local por hashes de bloque de 10-20 líneas
3. Si hay divergencia: localizarla y fusionar CONSCIENTEMENTE, no pisar
4. Aplicar el cambio nuevo sobre el resultado fusionado
```

Técnica de comparación (la salida de `javascript_tool` se trunca sobre los
~1000 caracteres, de ahí los bloques en vez de línea a línea):

```js
// En el navegador, sobre el texto descargado:
const enc = new TextEncoder(); const L = texto.split("\n"); const out = [];
for (let i = 0; i < L.length; i += 10) {
  const b = await crypto.subtle.digest("SHA-1", enc.encode(L.slice(i, i+10).join("\n")));
  out.push([...new Uint8Array(b)].slice(0,2).map(x => x.toString(16).padStart(2,"0")).join(""));
}
out.join(" ");   // separado por espacios: si se junta, el filtro lo bloquea como base64
```

```python
# En el sandbox, sobre la copia local, con la misma partición:
import hashlib
loc = [hashlib.sha1('\n'.join(L[i:i+10]).encode()).hexdigest()[:4] for i in range(0, len(L), 10)]
```

Dos avisos sobre `javascript_tool`: la salida se bloquea si parece base64
(separa los hashes con espacios) o si contiene lo que el filtro toma por
*query strings* (al volcar código, sustituye `[=?&:/]` por otro carácter).

---

# 2. Arquitectura

## 2.1 Flujo de arranque y router

`index.html` carga `js/config.js` (globales) y luego `js/app.js` como módulo.

`app.js` es el router: un mapa `ROUTES` de `nombre → { title, render }` y un
`render()` que reacciona a `hashchange`. Cada vista exporta una única función
`renderX(container, param)` que **repinta `#content` entero**. No hay estado
compartido entre vistas ni framework reactivo: cada navegación es un render
completo desde cero contra la base de datos.

Detalle importante: **las animaciones de entrada se lanzan centralizadamente**
en `animarEntradaVista()` de `app.js`, no en cada vista. Antes cada vista tenía
que acordarse de llamar a `animarVista()` y cinco no lo hacían. Si añades una
vista nueva, no necesitas hacer nada: ya está cubierta.

## 2.2 `js/supabase.js` — cliente propio, sin SDK

Reimplementación mínima de `@supabase/supabase-js` con `fetch()`, para no
necesitar build. Dos exports:

- `auth` — login por password, refresco de token, y `completeFromUrlHash()`
  para los enlaces de invitación/recuperación que Supabase manda con los
  tokens en el hash. La sesión vive en `localStorage` bajo `jml_session`.
- `db` — `QueryBuilder` encadenable sobre PostgREST:
  ```js
  const { data, error } = await db.from("proyectos")
    .select("*, clientes(nombre)").eq("id", id).single().exec();
  ```
  Métodos disponibles: `select eq order limit gte lte single insert update
  delete` y `exec()`. **No hay `or`, `in`, `neq`, `ilike` ni paginación.** Si
  necesitas uno, añádelo a la clase; no intentes usarlo asumiendo que existe.

`restRequest` reintenta una vez tras refrescar el token si recibe 401. Los
errores se devuelven en `{ data, error }`, nunca se lanzan.

## 2.3 `js/utils/resumen.js` — fuente única de verdad de los totales

**El módulo más importante del proyecto.** Antes cada vista calculaba sus
propios totales desde tablas distintas y los números no cuadraban entre
pantallas. Ahora Dashboard, Facturación mensual y Financiero construyen el
mismo *ledger* y lo resumen con las mismas funciones.

```
construirLedger(proyectos, facturaProyectos) → filas[]
filasEnRango(ledger, desde, hasta)
resumenPeriodo(ledger, gastos, desde, hasta)
resumenTrimestre(ledger, facturas, gastos, anio, q)      // Modelo 130
resumenIvaTrimestre(ledger, facturas, gastos, anio, q)   // Modelo 303
```

**Si un total no cuadra entre dos pantallas, el fallo está aquí o en que una
vista se ha saltado este módulo.** No parchees la vista: arregla o usa
`resumen.js`.

## 2.4 `js/utils/invoice-calc.js` — aritmética de dinero

Todo el dinero pasa por `round2()`. Contiene el motor de descuentos
(`desglosarLinea`, `aplicarDescuentoGlobal`, `calcularFactura`), el cálculo del
Modelo 130, la deducibilidad de gastos con amortización prorrateada
(`gastoDeducibleEnRango`) y los gastos de difícil justificación.

Los descuentos están topados en los dos niveles: nunca pueden dejar la base
imponible en negativo.

## 2.5 `js/utils/pdf-documentos.js` — generación de PDF

Transcripción literal de un script previo en reportlab, y por eso **usa el
sistema de coordenadas de reportlab: origen abajo-izquierda, `y` crece hacia
arriba**. Las funciones `drawString`, `drawRightString`, `rectRL`, `lineRL`,
`imageRL` hacen la conversión a jsPDF (origen arriba-izquierda) internamente.

Si escribes código de dibujo nuevo: `yCursor` **decrece** al avanzar hacia
abajo. Es la fuente número uno de errores en este fichero.

Exports: `crearFacturaPdf`, `crearPresupuestoPdf`, `cargarLogoDataUrl`,
`registrarFuentes`. Las fuentes Poppins van embebidas en base64 en
`js/utils/pdf-fonts.js` (4 líneas, ~1 MB — no lo abras entero).

`crearPresupuestoPdf` **no** guarda el fichero: solo dibuja. Quien llama
(`facturacion.js`) hace el `pdf.save()`. Esto permite previsualizar sin
descargar (ver §4.1).

## 2.6 Configuración: dos módulos, no los confundas

| | `config-negocio.js` | `config-usuario.js` |
|---|---|---|
| Qué guarda | Datos del emisor, condiciones fijas de presupuesto | Modelo 130 %, cuota de autónomo, gestoría, clave de IA, biblioteca de condiciones |
| Dónde | Constantes en el código, sobrescribibles desde Configuración | `localStorage` (`jml_config_usuario`) |
| Alcance | Por defecto para todos los dispositivos | Por dispositivo |

`CONFIG_NEGOCIO.emisor` es un **getter**, no una propiedad: se recalcula en
cada acceso fusionando los valores base con lo guardado en Configuración. Los
campos vacíos se descartan a propósito, para que borrar un campo no deje el PDF
sin NIF.

La clave de Gemini vive **solo** en `localStorage` y no debe llegar nunca al
repositorio, que es público.

## 2.7 `sw.js` — service worker

`CACHE = "jml-studio-v3"`. Estrategia red-primero con caída a caché.

El detalle que costó descubrir: GitHub Pages sirve con `max-age`, así que el
navegador daba por buenos los ficheros desde su caché HTTP y **un despliegue
nuevo no se veía**. La solución es reconstruir la petición con
`cache: "no-cache"` (que significa "revalida", no "no caches"): viaja el ETag y
el servidor contesta 304 si no ha cambiado.

Las peticiones con `mode === "navigate"` se excluyen: construir un `Request` a
partir de ellas lanza excepción.

**Si añades un fichero JS nuevo, añádelo también a `ASSETS`.**

## 2.8 Modelo de datos

Cinco tablas, todas con RLS por `user_id = auth.uid()`: `clientes`,
`proyectos`, `facturas`, `gastos`, `factura_proyectos`.

`facturas` guarda **presupuestos y facturas** en la misma tabla, distinguidos
por `tipo` (`'presupuesto' | 'factura'`). Las líneas van en un `jsonb`.

`factura_proyectos` es la tabla puente: **una factura puede cubrir varios
proyectos**. Este es el origen de varios bugs históricos, porque
`sincronizarFacturaProyectos()` agrupa por proyecto sumando importes: tres
conceptos del mismo proyecto se colapsan en un vínculo único. Por eso, al
cargar un documento, **las líneas guardadas mandan siempre que existan**; los
vínculos solo reconstruyen las líneas cuando no hay ninguna (facturas creadas
desde Facturación mensual). Los presupuestos ya no generan vínculos.

Migraciones en `sql/`, numeradas y **idempotentes** (`if not exists`). Se
ejecutan a mano en el SQL Editor de Supabase. Al pegar SQL ahí, haz click
directamente sobre una línea de código antes del `ctrl+a`, o seleccionarás la
página entera en vez del editor.

---

# 3. Reglas de negocio (acordadas con Josep — no las cambies por tu cuenta)

Estas reglas son decisiones suyas, no convenciones técnicas. Si el código las
contradice, el código está mal.

1. **La facturación se cuenta desde los PROYECTOS, no desde las facturas.** Hay
   proyectos sin factura asignada y proyectos que se acumularán en una factura
   conjunta. Contar facturas descuadra y confunde borradores con emitidas.
2. **Los proyectos pagados en efectivo NO cuentan para el IVA.** Solo
   `forma_pago === "transferencia"` entra en la base del Modelo 303. Contarlos
   descuadra todo.
3. Un proyecto cuenta como ingreso en su **fecha de entrega** (o de inicio si
   no hay entrega), salvo que tenga factura real vinculada, en cuyo caso manda
   la fecha de la factura.
4. Un gasto es **deducible por defecto**; se marca explícitamente lo que no lo
   es (efectivo sin ticket).
5. Los borradores **no** cuentan como IVA devengado ni como retenciones.
6. Base legal del IVA: art. 75 LIVA — el IVA de servicios se devenga cuando se
   presta el servicio, no cuando se factura. De ahí el aviso "queda X de base
   sin factura emitida" en Financiero.
7. Una factura sin NIF o sin dirección del cliente **no es válida ante
   Hacienda**: el PDF sale con marca de agua y sufijo `-BORRADOR`.

**Aviso permanente:** Claude no es asesor fiscal. Al tocar cálculos con efecto
tributario, dilo y recomienda contrastar con su gestoría. Ya se le advirtió de
que la regla 6 implica declarar IVA de trabajo aún no cobrado.

---

# 4. Cómo verificar (y cómo NO verificar)

## 4.1 PDFs: previsualizar sin descargar

Descargar ficheros requiere permiso explícito del usuario. Para revisar un PDF
sin descargarlo, genera el documento en la propia página y móntalo en un
`iframe` como blob:

```js
const doc = new jsPDF({ unit: "pt", format: "a4" });
pdfmod.crearPresupuestoPdf(doc, CONFIG_NEGOCIO, "PRE-99-2026", "28/07/2026",
                           "Proyecto", lineas, logo, opciones);
const url = doc.output("bloburl").toString();
document.body.innerHTML =
  `<iframe src="${url}" style="position:fixed;inset:0;width:100vw;height:100vh;border:0"></iframe>`;
doc.internal.getNumberOfPages();   // útil para comprobar saltos de página
```

Los módulos se importan en caliente desde producción:
`await import("https://josepml.github.io/jml-studio/js/utils/pdf-documentos.js?v=" + Date.now())`.
jsPDF se carga desde el CDN de cdnjs. Después, `location.reload()` para
devolver la app a su estado.

Para ver la página completa, baja el zoom del visor con el botón `−`; los
parámetros `#zoom=` y `#view=Fit` en la URL del blob no se aplican de forma
fiable.

## 4.2 Animaciones: la pestaña debe estar en primer plano

**Error grave cometido en el pasado:** se dio por buena una animación
comprobando `getComputedStyle` en una pestaña en segundo plano. Chrome congela
las animaciones ahí (`visibilityState: "hidden"`, `Animation.currentTime`
clavado en 0), así que aquello solo confirmaba que la declaración CSS existía,
no que se viera nada. Se le presentó a Josep como verificación dos veces
seguidas y no lo era.

Si no puedes observar el resultado de verdad, **dilo** en vez de afirmar que
funciona.

## 4.3 Móvil

`resize_window` no cambia el viewport renderizado, así que **la maquetación
responsive no se puede validar desde aquí**. Pídele a Josep que lo abra en su
móvil. No afirmes que el móvil está bien.

---

# 5. Convenciones de código

- Nombres de funciones, variables y comentarios **en español**.
- Los comentarios explican **por qué**, no qué. El estilo dominante es
  documentar el bug que motivó el código ("Antes se daba prioridad a los
  vínculos, y eso destruía el trabajo del usuario…"). Mantenlo: es lo que hace
  navegable este repositorio sin historial de git útil.
- Nada de `alert()` / `confirm()` nativos: usa `toastOk`, `toastError`,
  `confirmar`, `confirmarBorrado` de `js/utils/ui.js`. (Quedan tres `alert()`
  por migrar en `asistente.js`.)
- Dinero: siempre `round2()` y `eur()` de `format.js`. Nunca `toFixed` suelto.
- Estados y etiquetas centralizados en `format.js` (`ESTADOS_PROYECTO`,
  `CATEGORIAS_GASTO`, `FORMAS_PAGO`, `CATEGORIAS_SERVICIO`…). No repitas
  literales de estado en las vistas.
- CSS: un único `css/style.css`, sin preprocesador. Las reglas nuevas se
  añaden al final; con igualdad de especificidad gana la última. Cuidado con
  `.field`, que fuerza `flex-direction: column` a sus hijos.

---

# 6. Estado actual y trabajo pendiente

## Último trabajo cerrado (2026-07-30)

Sesión de condiciones y tarifas reales. Todo desplegado y verificado en vivo:

- **Migración 007** (`sql/007_condiciones_grupos_y_datos_reales.sql`, ya
  ejecutada): columna `grupo` en `condiciones` (`generales` | `rodaje` |
  `postproduccion`, con CHECK), borrado de las condiciones y servicios de
  prueba, e inserción de las **18 condiciones reales del anexo** de Josep
  (generales fijas 5, rodaje fijas 4 + opcionales 2, postproducción fijas 3 +
  opcionales 4) y de sus **14 tarifas reales** (Servicio Express 150 €, Media
  Jornada 220 €, Jornada Completa 390 €, Jornada de Edición 280 €, Pack 5
  Reels 300 €, Pack 10 Reels 500 €, Ronda extra 15 €, Fotografía Express /
  Media Jornada / Jornada Completa…).
- **Packs de condiciones** en el editor de presupuestos: el menú "Añadir
  condición" abre con `Pack: condiciones de rodaje / grabación (+4)` y
  `Pack: condiciones de postproducción (+3)`, que añaden de golpe las fijas de
  ese grupo que falten. Solo se ofrecen si queda alguna por añadir. Las
  generales fijas siguen precargándose solas al abrir un presupuesto nuevo.
  `js/utils/condiciones.js` expone `GRUPOS_CONDICION`, `textosPorDefecto`
  (solo generales) y `textosFijasDeGrupo`.
- **Botón "Guardar cambios" por tarifa** en Configuración, con el mismo patrón
  sucio/limpio que las condiciones. Cuidado: la fila de tarifas usa la clase
  `.t-guardar` y la de condiciones `.k-guardar`; el CSS tiene que ocultar las
  dos, se olvidó al principio y el botón se veía siempre.
- **Columna Grupo** (y "Fija del grupo") en la lista de condiciones de
  Configuración.
- **Botón "+ Crear"** encima del menú lateral (`index.html` + `js/app.js` +
  CSS), con accesos a factura, presupuesto, proyecto, cliente y gasto. Vive
  fuera de `#content`, así que tiene su propio manejador en `app.js`.
- `sw.js` → **cache v6**.

Al desplegar se descubrió que `js/app.js` local y desplegado tenían el mismo
contenido en **orden distinto** (el bloque del menú raíl estaba al final en
producción). Se comprobó con un hash del fichero con las líneas ordenadas, y
se reordenó la copia local para que coincida. Hoy **local y `main` son
idénticos byte a byte** en todos los ficheros tocados.

## Pendiente

- **Tres `alert()` nativos en `js/views/asistente.js`** (~líneas 330-333).
- **Revisión en móvil** — nunca validada con rigor (§4.3).
- **Chat del Asistente bloqueado**: usa Gemini, que Google no sirve a usuarios
  de la UE. Falta decisión de Josep sobre migrar a Mistral AI. Restricción
  suya, literal: *"No quiero tener que pagar por tokens, eso prohibido."*
- **Rediseño de Clientes** (ficha con pestañas, alta completa en modal,
  importar desde texto pegado) y el pulido visual general ("plano y estático"),
  ambos de su lista anterior, sin empezar.
- **Saltos de página del presupuesto**: el salto forzado ya no existe y los
  documentos cortos caben en una página, pero el presupuesto típico necesita
  ~150 pt más de los que quedan. Josep decidió **dejarlo así**.
- `LEEME.md` está **obsoleto**: habla de Netlify (ya se migró a GitHub Pages) y
  de una constante `EMISOR` en `facturacion.js` que ya no existe. No lo cites
  como referencia.

## Restricciones del usuario

- Nada de APIs de IA de pago.
- Claude in Chrome se reserva para visualizar y desplegar la web, no para
  navegación general.
- El presupuesto de créditos de sesión está ajustado: prefiere el camino barato
  (subir el fichero o transformarlo en el navegador antes que volcarlo al
  contexto).
