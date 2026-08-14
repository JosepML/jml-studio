// Estilo común de todas las gráficas de la app (Chart.js).
//
// Antes cada vista configuraba su gráfica a mano con colores planos, rejilla
// por defecto y el tooltip nativo de Chart.js. El resultado era correcto pero
// tenía aspecto de plantilla de 2018: barras macizas, líneas de rejilla
// oscuras y cajitas de tooltip grises.
//
// Aquí se centraliza el "look": barras estrechas con tapa redondeada, rejilla
// casi invisible, animación de entrada y un tooltip propio con el mismo
// lenguaje visual que el resto de la interfaz.

// Degradado vertical a partir de un color sólido. Necesita el contexto del
// canvas, así que se construye dentro de un callback (scriptable option) que
// Chart.js llama cuando ya conoce el área de dibujo.
export function degradado(color, opacidadArriba = 0.95, opacidadAbajo = 0.55) {
  return (ctx) => {
    const { chart } = ctx;
    const { ctx: canvas, chartArea } = chart;
    if (!chartArea) return color; // primer render: aún no hay área
    const g = canvas.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, aplicarAlfa(color, opacidadArriba));
    g.addColorStop(1, aplicarAlfa(color, opacidadAbajo));
    return g;
  };
}

function aplicarAlfa(hex, alfa) {
  const h = String(hex).replace("#", "");
  const n = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alfa})`;
}

// Tooltip en HTML propio, en vez del canvas por defecto de Chart.js. Permite
// usar la tipografía, los radios y las sombras del resto de la app.
function tooltipHtml(contexto, formatearValor) {
  const { chart, tooltip } = contexto;
  let $el = chart.canvas.parentNode.querySelector(".chart-tooltip");
  if (!$el) {
    $el = document.createElement("div");
    $el.className = "chart-tooltip";
    chart.canvas.parentNode.appendChild($el);
  }
  if (tooltip.opacity === 0) { $el.style.opacity = "0"; return; }

  const titulo = (tooltip.title || []).join(" ");
  const filas = (tooltip.dataPoints || []).map(p => {
    const color = p.dataset.backgroundColor;
    const muestra = typeof color === "string" ? color : (p.element?.options?.backgroundColor || "#3E6FE0");
    const valor = formatearValor ? formatearValor(p.parsed.y ?? p.parsed) : (p.parsed.y ?? p.parsed);
    const etiqueta = p.dataset.label && (tooltip.dataPoints.length > 1) ? p.dataset.label : "";
    return `<div class="chart-tooltip-row">
      <span class="chart-tooltip-dot" style="background:${typeof muestra === "string" ? muestra : "#3E6FE0"}"></span>
      ${etiqueta ? `<span class="chart-tooltip-label">${etiqueta}</span>` : ""}
      <strong>${valor}</strong>
    </div>`;
  }).join("");

  $el.innerHTML = `${titulo ? `<div class="chart-tooltip-title">${titulo}</div>` : ""}${filas}`;

  const { offsetLeft, offsetTop } = chart.canvas;
  $el.style.opacity = "1";
  $el.style.left = offsetLeft + tooltip.caretX + "px";
  $el.style.top = offsetTop + tooltip.caretY + "px";
}

const REDUCIR_MOVIMIENTO = typeof window !== "undefined"
  && window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Formato corto para los ejes: "3.500 €" en vez de "3500,00 €". Los céntimos
// en una escala vertical no aportan nada y llenan el eje de ruido; el detalle
// exacto se ve en el tooltip.
export function eurEje(v) {
  return (Number(v) || 0).toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " €";
}

// Opciones base compartidas. `formatearValor` suele ser la función eur().
export function opcionesBase(formatearValor) {
  return {
    maintainAspectRatio: false,
    animation: REDUCIR_MOVIMIENTO ? false : { duration: 700, easing: "easeOutQuart" },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle",
          padding: 16, font: { size: 11, family: "Inter", weight: "500" }, color: "#7A8399",
        },
      },
      tooltip: {
        enabled: false,
        external: (ctx) => tooltipHtml(ctx, formatearValor),
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: { font: { size: 11, family: "Inter" }, color: "#7A8399" },
      },
      y: {
        border: { display: false },
        // Rejilla discontinua y muy tenue: sirve de referencia sin competir
        // con las barras, que es lo que tiene que mandar en la lectura.
        grid: { color: "rgba(122,131,153,.10)", drawTicks: false, borderDash: [4, 4] },
        ticks: {
          font: { size: 11, family: "Inter" }, color: "#98A0B3", padding: 10,
          maxTicksLimit: 5,
          callback: eurEje,
        },
      },
    },
  };
}

// Opciones para doughnut: sin ejes, con hueco central amplio y separación
// entre porciones (el look "segmentado" en vez de la tarta maciza clásica).
export function opcionesDoughnut(formatearValor, { leyenda = "bottom" } = {}) {
  return {
    maintainAspectRatio: false,
    cutout: "68%",
    animation: REDUCIR_MOVIMIENTO ? false : { duration: 700, easing: "easeOutQuart" },
    plugins: {
      legend: {
        position: leyenda,
        labels: {
          boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle",
          padding: 12, font: { size: 11, family: "Inter", weight: "500" }, color: "#7A8399",
          // Cada etiqueta lleva su porcentaje al lado. Josep es daltónico
          // (§5.1) y en un donut el color es lo ÚNICO que une una porción con
          // su leyenda: con el porcentaje escrito puede emparejarlas mirando
          // el tamaño de la porción, sin depender del tono.
          generateLabels(chart) {
            // OJO: para donut/pie el generador por defecto NO es el genérico de
            // Chart.defaults, sino el de Chart.overrides[tipo]. Usando el genérico
            // las etiquetas salen como "undefined" (pasó, y se desplegó así).
            const tipo = chart.config.type;
            const generar = window.Chart.overrides?.[tipo]?.plugins?.legend?.labels?.generateLabels
              || window.Chart.defaults.plugins.legend.labels.generateLabels;
            const base = generar.call(chart, chart);
            const datos = chart.data.datasets?.[0]?.data || [];
            const total = datos.reduce((s, v) => s + (Number(v) || 0), 0);
            if (!total) return base;
            return base.map((etiqueta, i) => {
              const pct = Math.round((Number(datos[i]) || 0) / total * 100);
              return { ...etiqueta, text: `${etiqueta.text} · ${pct} %` };
            });
          },
        },
      },
      tooltip: { enabled: false, external: (ctx) => tooltipHtml(ctx, formatearValor) },
    },
  };
}

// Geometría común: barras más estrechas y con aire entre ellas. Antes ocupaban
// casi todo el ancho de su categoría y el conjunto se veía pesado.
const GEOMETRIA = {
  maxBarThickness: 34,
  categoryPercentage: 0.68,
  barPercentage: 0.85,
};

// Barra de serie única: degradado vertical suave y tapa redondeada.
export function barra(color, extra = {}) {
  return {
    backgroundColor: degradado(color),
    hoverBackgroundColor: aplicarAlfa(color, 1),
    borderRadius: { topLeft: 7, topRight: 7, bottomLeft: 0, bottomRight: 0 },
    borderSkipped: false,
    ...GEOMETRIA,
    ...extra,
  };
}

// Barra de serie APILADA. Dos diferencias importantes respecto a la de arriba,
// que son justo lo que hacía que la gráfica de facturación no encajara:
//
// 1. Color plano, no degradado. Si cada tramo se aclara hacia abajo, la
//    frontera entre "transferencia" y "efectivo" se difumina y la columna deja
//    de leerse como un único total apilado.
// 2. Las esquinas se redondean SOLO en el tramo que queda arriba del todo. Al
//    redondear todos los tramos aparecía una costura donde se tocaban: la tapa
//    redondeada del azul asomando bajo la base redondeada del amarillo.
//    Como cuál es el tramo superior cambia de mes a mes (hay meses sin
//    efectivo), se decide barra a barra con `encimaDe`: la lista de valores de
//    la serie que va por encima. Si ese mes vale 0, este tramo es el de arriba
//    y es el que lleva la tapa redondeada.
export function barraApilada(color, { encimaDe = null } = {}) {
  const tapa = { topLeft: 7, topRight: 7, bottomLeft: 0, bottomRight: 0 };
  return {
    backgroundColor: color,
    hoverBackgroundColor: aplicarAlfa(color, 0.85),
    borderRadius: encimaDe
      ? (ctx) => (Number(encimaDe[ctx.dataIndex]) > 0 ? 0 : tapa)
      : tapa,
    borderSkipped: false,
    ...GEOMETRIA,
  };
}
