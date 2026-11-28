// Labels of the text rendering, in English and German.

const LABELS = {
  en: {
    invoice: 'Invoice',
    creditNote: 'Credit note',
    creditFor: 'Credit for invoice',
    prices: 'Prices',
    exclusive: 'excluding tax',
    inclusive: 'including tax',
    rounding: 'rounding',
    line: 'per line',
    document: 'per document',
    id: 'Id',
    description: 'Description',
    qty: 'Qty',
    unit: 'Unit price',
    amount: 'Amount',
    discount: 'Discount',
    class: 'Tax class',
    tax: 'Tax',
    net: 'Net',
    gross: 'Gross',
    cashRounding: 'Cash rounding',
    payable: 'Payable',
  },
  de: {
    invoice: 'Rechnung',
    creditNote: 'Gutschrift',
    creditFor: 'Gutschrift zu Rechnung',
    prices: 'Preise',
    exclusive: 'netto',
    inclusive: 'brutto',
    rounding: 'Rundung',
    line: 'je Position',
    document: 'je Beleg',
    id: 'Pos',
    description: 'Beschreibung',
    qty: 'Menge',
    unit: 'Einzelpreis',
    amount: 'Betrag',
    discount: 'Rabatt',
    class: 'Steuerklasse',
    tax: 'Steuer',
    net: 'Netto',
    gross: 'Brutto',
    cashRounding: 'Rundungsdifferenz',
    payable: 'Zahlbetrag',
  },
};

export function label(key, lang = 'en') {
  const table = LABELS[lang] ?? LABELS.en;
  return table[key] ?? LABELS.en[key] ?? key;
}

export const LANGUAGES = Object.keys(LABELS);
