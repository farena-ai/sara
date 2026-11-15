// R9 fixture documents in five more languages (invented content, fake numbers): a lease, an insurance
// policy, a bill and a warranty, written the way such papers usually read in each language.
export const R9_DOCS = {
  es: {
    name: 'contrato alquiler.pdf',
    pages: [
      'CONTRATO DE ARRENDAMIENTO DE VIVIENDA\nArrendador: Inmobiliaria Sol S.L.\nArrendatario: Lucía Gómez\nEl contrato comienza el 1 de junio de 2026 y finaliza el 31 de mayo de 2027.\nRenta mensual: 1.250,00 € pagaderos el día 1 de cada mes.\nFianza: 2.500,00 EUR depositada en el organismo competente.',
    ],
  },
  esPolicy: {
    name: 'póliza hogar.pdf',
    pages: ['Seguro de hogar - Condiciones particulares\nNúmero de póliza: HG-5521-90877\nFecha de renovación: 03/04/2027\nPrima anual: 312,40 €\nFranquicia: 150 € por siniestro.\nEl recibo debe pagarse antes del 15/12/2026.'],
  },
  fr: {
    name: 'assurance auto.pdf',
    pages: ['Assurance auto - Conditions particulières de votre contrat\nN° de police : AU-778-12345\nDate de renouvellement : 1er mars 2027\nFranchise : 300,00 € par sinistre.\nCotisation annuelle : 1 024,50 €\nÀ payer avant le 05/01/2027.'],
  },
  frLease: {
    name: 'bail appartement.pdf',
    pages: ['CONTRAT DE BAIL\nLe locataire et le bailleur conviennent que le bail prend fin le 30 septembre 2027.\nLoyer mensuel : 980,00 € charges comprises.\nDépôt de garantie : 980 € versé à la signature.'],
  },
  de: {
    name: 'Mietvertrag Wohnung.pdf',
    pages: ['MIETVERTRAG für die Wohnung in der Lindenstraße\nDas Mietverhältnis endet am 31.08.2027.\nDie Kaltmiete beträgt 1.120,00 EUR monatlich und ist fällig am 3. jedes Monats.\nKaution: 3.360,00 € auf ein Mietkautionskonto.'],
  },
  deBill: {
    name: 'Rechnung Strom.pdf',
    pages: ['Rechnung für Ihren Stromvertrag\nRechnungsbetrag: 84,20 €\nZahlbar bis 12.12.2026 auf das unten genannte Konto.\nDie Garantie Ihres Zählers ist gültig bis 1. März 2029.'],
  },
  pt: {
    name: 'apólice seguro auto.pdf',
    pages: ['Seguro auto - apólice do seu veículo\nNúmero da apólice: SA-3349-11870\nVigência até 10/02/2027, com renovação automática.\nFranquia: R$ 2.450,00 por sinistro.\nPrêmio total: R$ 1.980,35\nData de vencimento: 05/12/2026 (boleto).'],
  },
  it: {
    name: 'garanzia lavatrice.pdf',
    pages: ['Certificato di garanzia della sua lavatrice\nNumero di serie: LV-90081234\nLa garanzia è valida fino al 15 marzo 2028.\nPer il contratto di assistenza il canone annuo è 89,90 € da pagare entro il 20/01/2027.'],
  },
} as const;
