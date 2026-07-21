// Tablas de amortización simplificadas para autónomos (estimación directa
// simplificada, coeficiente lineal máximo de la tabla de Hacienda). Orientativo:
// confírmalo con tu gestor/a para bienes que no encajen bien en estas 3 categorías.

export const TABLA_AMORTIZACION = {
  equipo_audiovisual_informatico: {
    label: "Equipos audiovisuales / informáticos",
    coeficienteAnual: 25,
    meses: 48, // 25%/año → 4 años
  },
  mobiliario: {
    label: "Mobiliario y enseres",
    coeficienteAnual: 10,
    meses: 120, // 10%/año → 10 años
  },
  otros_amortizables: {
    label: "Otros bienes amortizables",
    coeficienteAnual: 20,
    meses: 60, // 20%/año → 5 años (orientativo)
  },
};

export function mesesPorTipoBien(tipoBien) {
  return TABLA_AMORTIZACION[tipoBien]?.meses || 60;
}

export const UMBRAL_AMORTIZACION = 300; // €. Por debajo, Hacienda permite deducir de golpe.
