// Datos reales del negocio de Josep Mira Lozano, usados para generar
// facturas/presupuestos en PDF con el mismo formato que sus documentos
// oficiales (ver skill "facturas-presupuestos-mira" / config_negocio.json).
export const CONFIG_NEGOCIO = {
  emisor: {
    nombre: "Josep Mira Lozano",
    actividad: "Servicios de Producción Audiovisual",
    nif: "48759346J",
    direccion_linea1: "Carrer Vall de Ceta, 13 A",
    direccion_linea2: "03530 La Nucia",
    email: "josep.mira@gmail.com",
    telefono: "618 86 71 15",
    iban: "ES9500492397262194031221",
    bic: "BSCHESMM",
    logo: "assets/logo.png",
  },
  fiscal: { iva_pct: 21, retencion_pct: 0 },
  presupuesto_condiciones: [
    "Los importes expresados en este presupuesto corresponden a la Base Imponible. Se aplicarán los impuestos correspondientes (IVA / IRPF) en el momento de la emisión de la factura oficial.",
    "El presupuesto incluye todo el material de captación de vídeo y audio especificado para el correcto desarrollo de la jornada de grabación, así como la postproducción del episodio.",
    "Cualquier modificación sustancial sobre la estructura o el número de revisiones en postproducción posterior a la aceptación de este documento podría suponer un reajuste en los costes.",
  ],
};
