// U3.12 (docs/LANGUAGES_TEXT.md): reading other people's text in six languages without a model.
// The language of a text is guessed from its small words and letters; each reader (promises,
// clause checklists, travel emails) then uses only that language's phrases, never a mix.
export const TEXT_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it'] as const;
export type TextLang = (typeof TEXT_LANGS)[number];

// Small words that are common in one language and rare in the others (weight 1), plus a few
// letters only one of them uses (weight 2). English wins ties and empty texts.
const WORDS: Record<TextLang, string[]> = {
  en: ['the', 'and', 'you', 'your', 'will', 'to', 'of', 'is', 'for', 'with', 'this', 'that', 'i', 'be', 'by', 'at', 'on', 'thanks', 'please', 'from', 'are', 'we'],
  es: ['el', 'los', 'las', 'y', 'del', 'que', 'por', 'para', 'con', 'una', 'su', 'es', 'te', 'mi', 'gracias', 'hola', 'usted', 'se', 'al', 'lo', 'voy', 'tu', 'muy', 'este', 'esta'],
  fr: ['le', 'les', 'et', 'des', 'du', 'vous', 'votre', 'est', 'une', 'pour', 'avec', 'je', 'nous', 'sur', 'au', 'aux', 'merci', 'bonjour', 'ce', 'cette', 'pas', 'ne', 'sont', 'qui'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'ein', 'eine', 'ich', 'sie', 'zu', 'den', 'dem', 'von', 'auf', 'wir', 'ihr', 'ihre', 'bitte', 'danke', 'dir', 'dich', 'ihnen', 'wird', 'bei', 'bis', 'im'],
  pt: ['o', 'os', 'as', 'do', 'da', 'dos', 'das', 'não', 'você', 'uma', 'com', 'em', 'no', 'na', 'é', 'seu', 'sua', 'obrigado', 'obrigada', 'eu', 'vou', 'pelo', 'pela', 'oi', 'até', 'ao'],
  it: ['il', 'gli', 'della', 'delle', 'del', 'di', 'che', 'è', 'per', 'con', 'non', 'sono', 'ti', 'io', 'ci', 'grazie', 'ciao', 'un', 'alla', 'al', 'dal', 'dalla', 'nel', 'nella', 'mi', 'si'],
};
const LETTERS: [TextLang, RegExp][] = [
  ['es', /[ñ¿¡]/g],
  ['pt', /[ãõ]|ção|ções/g],
  ['de', /[ßäöü]/g],
  ['fr', /[êœ]|(?<!\p{L})à(?=\s)|(?<!\p{L})[jlnmdtsq]['’](?=\p{L})/gu],
  ['it', /[ìòù](?!\p{L})/gu],
];
const SETS = Object.fromEntries(TEXT_LANGS.map((l) => [l, new Set(WORDS[l])])) as Record<TextLang, Set<string>>;

/** The language a piece of text is written in (English when unsure). */
export function detectLang(text: string): TextLang {
  return langScores(text).best;
}
/** The language only when the text clearly shows it (two or more signs and no tie), else undefined. */
export function clearLang(text: string): TextLang | undefined {
  const { best, score } = langScores(text);
  const top = score[best];
  return top >= 2 && TEXT_LANGS.every((l) => l === best || score[l] < top) ? best : undefined;
}
function langScores(text: string): { best: TextLang; score: Record<TextLang, number> } {
  const s = text.slice(0, 4000).toLowerCase();
  const score: Record<TextLang, number> = { en: 0.5, es: 0, fr: 0, de: 0, pt: 0, it: 0 };
  for (const w of s.match(/\p{L}+/gu) ?? []) for (const l of TEXT_LANGS) if (SETS[l].has(w)) score[l] += 1;
  for (const [l, re] of LETTERS) score[l] += 2 * (s.match(re)?.length ?? 0);
  let best: TextLang = 'en';
  for (const l of TEXT_LANGS) if (score[l] > score[best]) best = l;
  return { best, score };
}

/** A case-insensitive regex whose alternatives must stand as whole words (accents count as letters). */
export function words(src: string, flags = 'iu', tail = true): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${src})${tail ? '(?![\\p{L}\\p{N}_])' : ''}`, flags);
}

export const MONTH_NAMES: Record<TextLang, string[]> = {
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  de: ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
  pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
};
/** Sunday first. */
export const WEEKDAY_NAMES: Record<TextLang, string[][]> = {
  en: [['sunday'], ['monday'], ['tuesday'], ['wednesday'], ['thursday'], ['friday'], ['saturday']],
  es: [['domingo'], ['lunes'], ['martes'], ['miércoles', 'miercoles'], ['jueves'], ['viernes'], ['sábado', 'sabado']],
  fr: [['dimanche'], ['lundi'], ['mardi'], ['mercredi'], ['jeudi'], ['vendredi'], ['samedi']],
  de: [['sonntag'], ['montag'], ['dienstag'], ['mittwoch'], ['donnerstag'], ['freitag'], ['samstag', 'sonnabend']],
  pt: [['domingo'], ['segunda-feira', 'segunda'], ['terça-feira', 'terça', 'terca'], ['quarta-feira', 'quarta'], ['quinta-feira', 'quinta'], ['sexta-feira', 'sexta'], ['sábado', 'sabado']],
  it: [['domenica'], ['lunedì', 'lunedi'], ['martedì', 'martedi'], ['mercoledì', 'mercoledi'], ['giovedì', 'giovedi'], ['venerdì', 'venerdi'], ['sabato']],
};

/** Month names and their unique 3-4 letter short forms, longest first (for a regex alternation). */
export function monthAlternation(lang: TextLang): string {
  const full = MONTH_NAMES[lang];
  const all = new Set(full);
  for (const n of [3, 4]) {
    for (const m of full) {
      const p = m.slice(0, n);
      if (p.length === n && full.filter((x) => x.startsWith(p)).length === 1) all.add(p);
    }
  }
  return [...all].sort((a, b) => b.length - a.length).join('|');
}
/** 1-12 for a month name or short form in that language, else 0. */
export function monthNumber(word: string, lang: TextLang): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return 0;
  return MONTH_NAMES[lang].findIndex((m) => m.startsWith(w)) + 1;
}

/** "20 de noviembre de 2026", "20. November 2026", "1er janvier", "1º de janeiro" (day first). */
export function dayMonthRe(lang: TextLang): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})(?:\\.|º|°|ª|er)?\\s*(?:de\\s+)?(${monthAlternation(lang)})\\.?(?![\\p{L}])(?:,?\\s*(?:de\\s+)?(\\d{4})(?!\\d))?`, 'giu');
}

/** V4.4: the language a short line leans to (one real sign is enough, no tie), else undefined. */
export function leanLang(text: string): TextLang | undefined {
  const { best, score } = langScores(text);
  const top = score[best];
  return top >= 1 && TEXT_LANGS.every((l) => l === best || score[l] < top) ? best : undefined;
}
