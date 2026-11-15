// R9 (docs/WHAT_SARA_KNOWS.md "Documents in other languages"): the N6 document rules (src/facts.ts)
// in Spanish, French, German, Brazilian Portuguese and Italian. Rules only, no model:
// - the document's language from common short words (stopwords), English when unsure;
// - date labels (renewal, expiry, due, lease end, warranty) and amount labels (deductible, premium,
//   rent, deposit) in each language, mapped to the same English label keys the UI already translates;
// - dates in day-month order outside English (03/04/2027 = 3 April), month names, "1er", "1.";
// - money as written in the document (1.234,56 €, R$ 2.450,00, 1 024,50 €).
import type { DateKind } from './facts.ts';

export const DOC_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it'] as const;
export type DocLang = (typeof DOC_LANGS)[number];

const STOP: Record<DocLang, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'your', 'this', 'for', 'with', 'on', 'be', 'by', 'will', 'must', 'per', 'each'],
  es: ['el', 'los', 'las', 'del', 'y', 'por', 'para', 'con', 'su', 'usted', 'es', 'se', 'debe', 'antes', 'una', 'cada'],
  fr: ['le', 'les', 'des', 'du', 'et', 'est', 'pour', 'votre', 'vous', 'une', 'au', 'aux', 'par', 'avant', 'sur', 'prend'],
  de: ['der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'ihr', 'ihres', 'ihren', 'ein', 'eine', 'den', 'dem', 'nicht', 'bis', 'auf', 'am', 'jedes', 'beträgt'],
  pt: ['os', 'do', 'da', 'dos', 'das', 'não', 'seu', 'sua', 'com', 'você', 'até', 'em', 'ao', 'pelo', 'uma', 'cada'],
  it: ['il', 'gli', 'della', 'di', 'che', 'per', 'è', 'sua', 'suo', 'una', 'sono', 'al', 'fino', 'entro', 'ogni', 'nel'],
};
// Words that only one language uses (a strong hint even in a short document).
const MARK: Record<Exclude<DocLang, 'en'>, RegExp> = {
  es: /(?<!\p{L})(?:póliza|arrendamiento|arrendatario|vencimiento|renovación|franquicia|fianza|alquiler|recibo)(?!\p{L})/iu,
  fr: /(?<!\p{L})(?:assurance|bail|locataire|bailleur|loyer|cotisation|échéance|renouvellement|franchise|sinistre)(?!\p{L})/iu,
  de: /(?<!\p{L})(?:versicherung|mietvertrag|mietverhältnis|kaution|miete|kaltmiete|rechnung|fällig|zahlbar|gültig)(?!\p{L})/iu,
  pt: /(?<!\p{L})(?:apólice|seguro|vigência|franquia|prêmio|aluguel|boleto|locatário|vencimento)(?!\p{L})/iu,
  it: /(?<!\p{L})(?:polizza|garanzia|scadenza|locazione|canone|affitto|franchigia|rinnovo|lavatrice)(?!\p{L})/iu,
};

/** The document's language from its stopwords (cheap); 'en' when unsure. */
export function detectDocLang(text: string): DocLang {
  const words = text.slice(0, 8000).toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 3) return 'en';
  const score = Object.fromEntries(DOC_LANGS.map((l) => [l, 0])) as Record<DocLang, number>;
  const sets = Object.fromEntries(DOC_LANGS.map((l) => [l, new Set(STOP[l])])) as Record<DocLang, Set<string>>;
  for (const w of words) for (const l of DOC_LANGS) if (sets[l].has(w)) score[l] += 1;
  for (const l of Object.keys(MARK) as Exclude<DocLang, 'en'>[]) {
    const n = (text.slice(0, 8000).match(new RegExp(MARK[l].source, 'giu')) ?? []).length;
    score[l] += n * 2;
  }
  let best: DocLang = 'en';
  for (const l of DOC_LANGS) if (score[l] > score[best]) best = l;
  return best !== 'en' && score[best] >= 3 ? best : 'en';
}

// ------------------------------------------------------------------ dates

const MONTHS: Record<Exclude<DocLang, 'en'>, string[][]> = {
  es: [['enero'], ['febrero'], ['marzo'], ['abril'], ['mayo'], ['junio'], ['julio'], ['agosto'], ['septiembre', 'setiembre'], ['octubre'], ['noviembre'], ['diciembre']],
  fr: [['janvier'], ['février', 'fevrier'], ['mars'], ['avril'], ['mai'], ['juin'], ['juillet'], ['août', 'aout'], ['septembre'], ['octobre'], ['novembre'], ['décembre', 'decembre']],
  de: [['januar', 'jänner'], ['februar'], ['märz', 'maerz'], ['april'], ['mai'], ['juni'], ['juli'], ['august'], ['september'], ['oktober'], ['november'], ['dezember']],
  pt: [['janeiro'], ['fevereiro'], ['março', 'marco'], ['abril'], ['maio'], ['junho'], ['julho'], ['agosto'], ['setembro'], ['outubro'], ['novembro'], ['dezembro']],
  it: [['gennaio'], ['febbraio'], ['marzo'], ['aprile'], ['maggio'], ['giugno'], ['luglio'], ['agosto'], ['settembre'], ['ottobre'], ['novembre'], ['dicembre']],
};

const monthAlt = (l: Exclude<DocLang, 'en'>) => MONTHS[l].flat().sort((a, b) => b.length - a.length).join('|');
const DATE_RES = new Map<DocLang, RegExp>();
/** Dates as written in a document of this language (numeric day-month-year, ISO, day + month name + year). */
export function dateReIn(lang: Exclude<DocLang, 'en'>): RegExp {
  let re = DATE_RES.get(lang);
  if (!re) {
    re = new RegExp(`(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}(?:er|º|°|\\.)?\\s+(?:de\\s+)?(?:${monthAlt(lang)})\\.?(?:\\s+de)?\\s+\\d{4})(?!\\p{L})`, 'giu');
    DATE_RES.set(lang, re);
  }
  return new RegExp(re.source, re.flags);
}

const valid = (y: number, m: number, d: number): string | null => {
  if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1900 && y <= 2200)) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** A date as written in a document of this language → YYYY-MM-DD (day-month order outside English). */
export function isoDateIn(s: string, lang: DocLang, usOrder?: (s: string) => string | null): string | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) return valid(Number(r[1]), Number(r[2]), Number(r[3]));
  if (lang === 'en') {
    if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return valid(Number(r[3]), Number(r[1]), Number(r[2]));
    return usOrder ? usOrder(s) : null;
  }
  if ((r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t))) return valid(Number(r[3]), Number(r[2]), Number(r[1]));
  if ((r = /^(\d{1,2})(?:er|º|°|\.)?\s+(?:de\s+)?(\p{L}+)\.?(?:\s+de)?\s+(\d{4})$/u.exec(t))) {
    const m = MONTHS[lang].findIndex((names) => names.includes(r![2]));
    return m < 0 ? null : valid(Number(r[3]), m + 1, Number(r[1]));
  }
  return null;
}

// ------------------------------------------------------------------ labels

const words = (alts: string[]) => new RegExp(`(?<!\\p{L})(?:${alts.join('|')})(?!\\p{L})`, 'iu');

/** Date labels per language, the most specific first (a due phrase before a generic "vencimiento"). */
export const DATE_LABELS_IN: Record<Exclude<DocLang, 'en'>, [RegExp, DateKind | 'by-type'][]> = {
  es: [
    [words(['fecha límite de pago', 'fecha de pago', 'debe pagarse antes del?', 'pagar antes del?', 'a pagar antes del?', 'pagadero el', 'importe a pagar']), 'due'],
    [words(['fecha de renovación', 'renovación', 'se renueva(?: el)?', 'renovará']), 'renewal'],
    [words(['la garantía (?:vence|finaliza|termina|es válida hasta)', 'garantía válida hasta', 'fin de la garantía']), 'warranty_end'],
    [words(['fin del contrato', 'finaliza(?: el)?', 'termina(?: el)?', 'fecha de terminación', 'vigente hasta']), 'by-type'],
    [words(['fecha de vencimiento', 'vencimiento', 'vence(?: el)?', 'fecha de caducidad', 'caduca(?: el)?', 'válid[oa] hasta']), 'by-type'],
  ],
  fr: [
    [words(['date limite de paiement', 'à payer avant le', 'a payer avant le', 'payable avant le', 'date d[’\']échéance', 'à régler avant le']), 'due'],
    [words(['date de renouvellement', 'renouvellement', 'renouvelé le', 'se renouvelle le', 'échéance annuelle']), 'renewal'],
    [words(['garantie valable jusqu[’\']au', 'fin de garantie', 'la garantie (?:expire|prend fin)(?: le)?']), 'warranty_end'],
    [words(['fin du bail', 'le bail prend fin le', 'prend fin le', 'se termine le', 'date de fin']), 'by-type'],
    [words(['date d[’\']expiration', 'expire le', 'valable jusqu[’\']au', 'date de validité', 'échéance']), 'by-type'],
  ],
  de: [
    [words(['zahlbar bis(?: zum)?', 'fällig am', 'fällig bis', 'zahlungsfrist', 'fälligkeit(?:sdatum)?', 'zu zahlen bis']), 'due'],
    [words(['verlängert sich(?: am| zum)?', 'verlängerung(?: am| zum)?', 'erneuerung(?: am| zum)?', 'hauptfälligkeit']), 'renewal'],
    [words(['garantie (?:gültig bis|endet am|endet|läuft ab am)', 'garantie[^.]{0,40}gültig bis', 'gewährleistung bis', 'garantieende']), 'warranty_end'],
    [words(['mietverhältnis endet am', 'mietende', 'vertragsende', 'endet am', 'läuft bis']), 'by-type'],
    [words(['gültig bis', 'ablaufdatum', 'läuft ab am', 'ablauf am', 'gültigkeit bis']), 'by-type'],
  ],
  pt: [
    [words(['data de vencimento', 'vencimento', 'pagar até', 'pagável até', 'vence em']), 'due'],
    [words(['data de renovação', 'renovação(?: em)?', 'renova-se em']), 'renewal'],
    [words(['garantia válida até', 'fim da garantia', 'a garantia (?:termina|expira|vence) em']), 'warranty_end'],
    [words(['término do contrato', 'fim do contrato', 'termina em', 'encerra-se em']), 'by-type'],
    [words(['vigência até', 'válid[oa] até', 'data de validade', 'validade', 'expira em']), 'by-type'],
  ],
  it: [
    [words(['da pagare entro(?: il)?', 'pagamento entro(?: il)?', 'scadenza (?:del )?pagamento', 'data di pagamento', 'pagabile entro(?: il)?']), 'due'],
    [words(['data di rinnovo', 'rinnovo(?: il)?', 'si rinnova(?: il)?']), 'renewal'],
    [words(['la garanzia è valida fino al', 'garanzia valida fino al', 'fine garanzia', 'la garanzia scade il']), 'warranty_end'],
    [words(['fine (?:della )?locazione', 'cessazione del contratto', 'termina il', 'il contratto scade il']), 'by-type'],
    [words(['data di scadenza', 'scadenza', 'scade il', 'valid[oa] fino al']), 'by-type'],
  ],
};

/** Amount labels per language → the English label keys (Deductible, Premium, Rent, Security deposit). */
export const AMOUNT_LABELS_IN: Record<Exclude<DocLang, 'en'>, [RegExp, string][]> = {
  es: [[words(['franquicia', 'deducible']), 'Deductible'], [words(['prima(?: anual| total| mensual)?']), 'Premium'], [words(['fianza', 'depósito de garantía']), 'Security deposit'], [words(['renta(?: mensual)?', 'alquiler(?: mensual)?']), 'Rent']],
  fr: [[words(['franchise']), 'Deductible'], [words(['cotisation(?: annuelle| mensuelle)?', 'prime(?: annuelle)?']), 'Premium'], [words(['dépôt de garantie', 'caution']), 'Security deposit'], [words(['loyer(?: mensuel)?']), 'Rent']],
  de: [[words(['selbstbeteiligung', 'selbstbehalt']), 'Deductible'], [words(['jahresbeitrag', 'beitrag', 'prämie', 'versicherungsprämie']), 'Premium'], [words(['kaution', 'mietkaution']), 'Security deposit'], [words(['kaltmiete', 'warmmiete', 'miete', 'monatsmiete']), 'Rent']],
  pt: [[words(['franquia']), 'Deductible'], [words(['prêmio(?: total| anual)?']), 'Premium'], [words(['caução', 'depósito caução']), 'Security deposit'], [words(['aluguel(?: mensal)?', 'aluguer(?: mensal)?', 'renda mensal']), 'Rent']],
  it: [[words(['franchigia']), 'Deductible'], [words(['premio(?: annuo| annuale| totale)?']), 'Premium'], [words(['deposito cauzionale', 'cauzione']), 'Security deposit'], [words(['canone(?: mensile| di locazione)?', 'affitto(?: mensile)?']), 'Rent']],
};

/** Number labels in the five languages (last 4 only, as in English). */
export const NUMBER_LABELS_IN: [RegExp, string][] = [
  [words(['n(?:úmero|umero|°|º|o\\.?)\\s*(?:de|da|di)?\\s*(?:póliza|police|apólice|polizza)', 'versicherungsnummer', 'policennummer', 'vertragsnummer']), 'Policy number'],
  [words(['n(?:úmero|umero|°|º|o\\.?)\\s*(?:de|da|di)?\\s*(?:cuenta|compte|conta|conto)', 'kontonummer']), 'Account number'],
  [words(['n(?:úmero|umero|°|º|o\\.?)\\s*(?:de|da|di)?\\s*(?:serie|série)', 'seriennummer']), 'Serial number'],
];

/** Name labels (a lease's tenant and landlord, a policy's insured). */
export const NAME_LABELS_IN: [RegExp, string, 'people' | 'home'][] = [
  [/(?<!\p{L})(?:arrendatario|inquilino|locataire|mieter(?:in)?|locatário|inquilino|conduttore)\s*:/iu, 'Tenant', 'people'],
  [/(?<!\p{L})(?:arrendador|propietario|bailleur|propriétaire|vermieter(?:in)?|locador|locatore)\s*:/iu, 'Landlord', 'home'],
  [/(?<!\p{L})(?:asegurado|tomador|assuré|versicherungsnehmer(?:in)?|segurado|assicurato|contraente)\s*:/iu, 'Insured', 'people'],
];

/** The document type words in the five languages (only asked when the English rules found none). */
export function docTypeIn(text: string): 'lease' | 'auto' | 'health' | 'home-insurance' | 'insurance' | 'warranty' | 'passport' | 'other' {
  const s = text.slice(0, 6000);
  if (words(['pasaporte', 'passeport', 'reisepass', 'passaporte', 'passaporto']).test(s)) return 'passport';
  if (words(['seguro (?:médico|de salud)', 'mutuelle', 'assurance santé', 'krankenversicherung', 'plano de saúde', 'assicurazione sanitaria']).test(s)) return 'health';
  if (words(['seguro de (?:auto|automóvil|coche)', 'assurance auto(?:mobile)?', 'kfz-versicherung', 'autoversicherung', 'seguro auto(?:móvel)?', 'assicurazione auto', 'rc auto']).test(s)) return 'auto';
  if (words(['seguro de hogar', 'assurance habitation', 'hausratversicherung', 'wohngebäudeversicherung', 'seguro residencial', 'assicurazione casa']).test(s)) return 'home-insurance';
  if (words(['arrendamiento', 'arrendatario', 'bail', 'locataire', 'mietvertrag', 'mietverhältnis', 'mieter', 'locação', 'locatário', 'locazione', 'conduttore']).test(s)) return 'lease';
  if (words(['garantía', 'garantie', 'garantia', 'garanzia', 'gewährleistung']).test(s)) return 'warranty';
  if (words(['póliza', 'seguro', 'assurance', 'versicherung', 'apólice', 'polizza', 'assicurazione']).test(s)) return 'insurance';
  return 'other';
}

// ------------------------------------------------------------------ money

const NUM = String.raw`\d{1,3}(?:[.\u00a0\u202f ]\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?`;
const MONEY_RE = new RegExp(String.raw`(?:R\$|€|EUR|CHF|£|US\$)\s?(?:${NUM})(?![\d,])|(?:${NUM})\s?(?:€|EUR|CHF|R\$|£)(?!\p{L})`, 'u');

/** The first money amount in a line as written (1.234,56 €), or null. */
export function moneyIn(line: string): string | null {
  const m = MONEY_RE.exec(line);
  return m ? m[0].replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim() : null;
}
/** Where the first money amount starts (for the "close to the label" rule), or -1. */
export function moneyAt(line: string): number {
  const m = MONEY_RE.exec(line);
  return m ? m.index : -1;
}
