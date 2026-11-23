// W0.6 (docs/design/W0TIME.md): she always knows what time it is and how long ago things were.
// One place that turns stored timestamps into the owner's local time and "how long ago", computed in
// code (never guessed by the model): compact labels for her prompt, words in six languages for her
// replies, and a claim check that corrects "yesterday" / "earlier today" / "X minutes ago" in a reply
// when the real time of what she's talking about is known (the receipts.ts pattern: code checks words).
import { detectLang, type TextLang } from './lang-text.ts';

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;
const WEEK = 7 * D;
const MONTH = 30.44 * D;
const YEAR = 365.25 * D;

export type AgeLang = TextLang | 'pt-BR';
const L = (lang?: string): TextLang => (lang === 'pt-BR' ? 'pt' : (['en', 'es', 'fr', 'de', 'pt', 'it'] as string[]).includes(lang ?? '') ? (lang as TextLang) : 'en');

type Unit = 's' | 'min' | 'h' | 'd' | 'w' | 'mo' | 'y';
/** The amount and unit people would use for this span (floored, so "5 weeks", not "6"). */
function amount(ms: number): { n: number; u: Unit } | null {
  if (ms < 10 * S) return null;
  if (ms < MIN) return { n: Math.floor(ms / S), u: 's' };
  if (ms < H) return { n: Math.round(ms / MIN), u: 'min' };
  if (ms < D) return { n: Math.round(ms / H), u: 'h' };
  if (ms < 14 * D) return { n: Math.floor(ms / D), u: 'd' };
  if (ms < 8 * WEEK) return { n: Math.floor(ms / WEEK), u: 'w' };
  if (ms < 2 * YEAR) return { n: Math.max(2, Math.floor(ms / MONTH)), u: 'mo' };
  return { n: Math.floor(ms / YEAR), u: 'y' };
}

/** Compact span for her prompt: "40 s", "12 min", "3 h 20 min", "9 h", "2 days", "3 weeks". */
export function spanShort(ms: number): string {
  const m = Math.round(Math.max(0, ms) / MIN);
  if (ms < MIN) return `${Math.floor(Math.max(0, ms) / S)} s`;
  if (m < 60) return `${m} min`;
  if (ms < 12 * H) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
  if (ms < D) return `${Math.floor(ms / H)} h`;
  const a = amount(ms)!;
  const word = { d: 'day', w: 'week', mo: 'month', y: 'year' }[a.u as 'd'];
  return `${a.n} ${word}${a.n === 1 ? '' : 's'}`;
}

/** Compact "how long ago" for her prompt ("just now", "40 s ago", "3 h 20 min ago", "2 days ago"). */
export function ageShort(ms: number): string {
  return ms < 10 * S ? 'just now' : `${spanShort(ms)} ago`;
}

const WORDS: Record<TextLang, { now: string; fmt: (n: number, u: Unit) => string }> = {
  en: { now: 'just now', fmt: (n, u) => `${n} ${{ s: 'second', min: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' }[u]}${n === 1 ? '' : 's'} ago` },
  es: { now: 'justo ahora', fmt: (n, u) => `hace ${n} ${n === 1 ? { s: 'segundo', min: 'minuto', h: 'hora', d: 'día', w: 'semana', mo: 'mes', y: 'año' }[u] : { s: 'segundos', min: 'minutos', h: 'horas', d: 'días', w: 'semanas', mo: 'meses', y: 'años' }[u]}` },
  fr: { now: "à l'instant", fmt: (n, u) => `il y a ${n} ${n === 1 ? { s: 'seconde', min: 'minute', h: 'heure', d: 'jour', w: 'semaine', mo: 'mois', y: 'an' }[u] : { s: 'secondes', min: 'minutes', h: 'heures', d: 'jours', w: 'semaines', mo: 'mois', y: 'ans' }[u]}` },
  de: { now: 'gerade eben', fmt: (n, u) => `vor ${n} ${n === 1 ? { s: 'Sekunde', min: 'Minute', h: 'Stunde', d: 'Tag', w: 'Woche', mo: 'Monat', y: 'Jahr' }[u] : { s: 'Sekunden', min: 'Minuten', h: 'Stunden', d: 'Tagen', w: 'Wochen', mo: 'Monaten', y: 'Jahren' }[u]}` },
  pt: { now: 'agora mesmo', fmt: (n, u) => `há ${n} ${n === 1 ? { s: 'segundo', min: 'minuto', h: 'hora', d: 'dia', w: 'semana', mo: 'mês', y: 'ano' }[u] : { s: 'segundos', min: 'minutos', h: 'horas', d: 'dias', w: 'semanas', mo: 'meses', y: 'anos' }[u]}` },
  it: { now: 'proprio ora', fmt: (n, u) => `${n} ${n === 1 ? { s: 'secondo', min: 'minuto', h: 'ora', d: 'giorno', w: 'settimana', mo: 'mese', y: 'anno' }[u] : { s: 'secondi', min: 'minuti', h: 'ore', d: 'giorni', w: 'settimane', mo: 'mesi', y: 'anni' }[u]} fa` },
};
const YESTERDAY: Record<TextLang, string> = { en: 'yesterday', es: 'ayer', fr: 'hier', de: 'gestern', pt: 'ontem', it: 'ieri' };
const EARLIER_TODAY: Record<TextLang, string> = { en: 'earlier today', es: 'hoy más temprano', fr: "plus tôt aujourd'hui", de: 'heute früher', pt: 'hoje mais cedo', it: 'oggi più presto' };

/** "How long ago" in words, in one of the six languages ("12 minutes ago", "hace 12 minutos", "vor 2 Tagen"). */
export function ageWords(ms: number, lang?: string): string {
  const w = WORDS[L(lang)];
  const a = amount(ms);
  return a ? w.fmt(a.n, a.u) : w.now;
}

/** A calendar day's age from the owner's today (both YYYY-MM-DD): "today", "yesterday", "3 days ago". */
export function dayAge(date: string, today: string): string {
  const a = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return '';
  const days = Math.round((b - a) / D);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return ageWords(days * D);
}

/** Until a time or since it ("in 2 h 5 min", "40 min ago"), for reminders and due dates. */
export function untilShort(at: string | Date, now: Date): string {
  const ms = (typeof at === 'string' ? Date.parse(at) : at.getTime()) - now.getTime();
  if (!Number.isFinite(ms)) return '';
  return ms >= 0 ? (ms < 10 * S ? 'now' : `in ${spanShort(ms)}`) : ageShort(-ms);
}

/** A pause worth saying (30 min or more): "8 h since the last message". */
export function gapNote(ms: number): string | undefined {
  return ms >= 30 * MIN ? `${spanShort(ms)} since the last message` : undefined;
}

/** The owner's local calendar day (YYYY-MM-DD) of an instant. */
export function localDay(at: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
function localHour(at: Date, timeZone?: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, hour: 'numeric', hourCycle: 'h23' }).format(at));
  } catch {
    return at.getUTCHours();
  }
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / D);

/** Local clock for a label: "2:07 PM" today, "Tue 2:17 PM" this week, "Oct 10 2:17 PM", "Oct 10 2025 2:17 PM". */
export function clockLabel(at: Date, now: Date, timeZone?: string): string {
  const tz = timeZone || undefined;
  try {
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
    const days = dayDiff(localDay(at, tz), localDay(now, tz));
    if (days === 0) return time;
    if (days > 0 && days < 7) return `${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at)} ${time}`;
    const sameYear = localDay(at, tz).slice(0, 4) === localDay(now, tz).slice(0, 4);
    return `${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(at).replace(',', '')} ${time}`;
  } catch {
    return at.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** The label on an earlier message: "[2:07 PM, 10 min ago]"; none for the last half minute or a future clock. */
export function stampLabel(at: string | Date, now: Date, timeZone?: string, extra?: string): string | undefined {
  const d = typeof at === 'string' ? new Date(at) : at;
  const ms = now.getTime() - d.getTime();
  if (!Number.isFinite(ms) || ms < 30 * S) return undefined;
  return `[${clockLabel(d, now, timeZone)}, ${ageShort(ms)}${extra ? `, ${extra}` : ''}]`;
}

/** The zone's short name ("CST") and id, for the restated time. */
function zoneOf(now: Date, timeZone?: string): { abbr: string; id: string } {
  try {
    const id = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const abbr = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return { abbr, id };
  } catch {
    return { abbr: 'UTC', id: 'UTC' };
  }
}

/** The system prompt's "It is …": full date, time and the zone's short name. */
export function nowSentence(now: Date, timeZone?: string): string {
  try {
    const day = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(now);
    const { abbr } = zoneOf(now, timeZone);
    return abbr ? `${day} ${abbr}` : day;
  } catch {
    return now.toISOString();
  }
}

/**
 * The time restated at the end of her prompt every turn (compact): the owner's local date, time and
 * zone, the pause before this message when there was one, and how to read the labels.
 */
export function nowLine(now: Date, timeZone?: string, gapMs?: number | null): string {
  const { abbr, id } = zoneOf(now, timeZone);
  let when: string;
  try {
    when = new Intl.DateTimeFormat('en-US', { timeZone: id, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  } catch {
    when = now.toISOString();
  }
  const gap = gapMs ? gapNote(gapMs) : undefined;
  return `[Now: ${when} ${abbr} (${id}).${gap ? ` ${gap[0].toUpperCase()}${gap.slice(1)}.` : ''} Earlier messages are labeled with when they were sent and how long ago; unlabeled ones are from just now. Say how long ago from those labels, never guess.]`;
}

// ---------------------------------------------------------------------------------------------
// The time-claim check (claim-checker style)
// ---------------------------------------------------------------------------------------------

/** Something whose time is known: a message in this chat (or the last one), a memory, a reminder. */
export type TimeEvent = { at: string; role: 'user' | 'assistant' | 'memory'; text: string };
export type TimeFix = { said: string; real: string; at: string; how: 'rewrite' };

type Claim = { kind: 'yesterday' | 'lastNight' | 'today' | 'morning' | 'lastWeek' } | { kind: 'ago'; lo: number; hi: number; u: number };

const NB = '(?<![\\p{L}\\p{N}])';
const NA = '(?![\\p{L}])';
const UNITS: Record<TextLang, [RegExp, number][]> = {
  en: [[/^seconds?$/, S], [/^minutes?$|^mins?$/, MIN], [/^hours?$/, H], [/^days?$/, D], [/^weeks?$/, WEEK]],
  es: [[/^segundos?$/, S], [/^minutos?$/, MIN], [/^horas?$/, H], [/^d[ií]as?$/, D], [/^semanas?$/, WEEK]],
  fr: [[/^secondes?$/, S], [/^minutes?$/, MIN], [/^heures?$/, H], [/^jours?$/, D], [/^semaines?$/, WEEK]],
  de: [[/^sekunden?$/, S], [/^minuten?$/, MIN], [/^stunden?$/, H], [/^tag(en)?$/, D], [/^wochen?$/, WEEK]],
  pt: [[/^segundos?$/, S], [/^minutos?$/, MIN], [/^horas?$/, H], [/^dias?$/, D], [/^semanas?$/, WEEK]],
  it: [[/^second[oi]$/, S], [/^minut[oi]$/, MIN], [/^or[ae]$/, H], [/^giorn[oi]$/, D], [/^settiman[ae]$/, WEEK]],
};
const ONE = /^(a|an|one|un|una|uno|une|ein|eine|einer|einem|um|uma)$/i;
const FEW = /^(a few|a couple of|a couple|few|several|unos|unas|unos pocos|unas pocas|algunos|algunas|un par de|quelques|ein paar|einigen|wenigen|uns|umas|alguns|algumas|poucos|poucas|qualche|alcuni|alcune|pochi|poche)$/i;
const NUM = '(\\d{1,3}|a few|a couple of|a couple|an|a|one|few|several|unos pocos|unas pocas|unos|unas|algunos|algunas|un par de|una|uno|un|une|quelques|ein paar|einigen|wenigen|einer|einem|eine|ein|umas|uns|uma|um|alguns|algumas|poucos|poucas|qualche|alcuni|alcune|pochi|poche)';
const UNIT_WORDS = '(\\p{L}+)';
const SOFT = '(?:about |around |roughly |like |unos |unas |environ |etwa |cerca de |circa |quasi )?';

/** The time phrases of each language, longest first (so "hier soir" wins over "hier"). */
const PHRASES: Record<TextLang, { re: RegExp; claim: (m: RegExpExecArray) => Claim | null }[]> = (() => {
  const day = (kind: 'yesterday' | 'lastNight' | 'today' | 'morning' | 'lastWeek', words: string) => ({ re: new RegExp(`${NB}(?:${words})${NA}`, 'giu'), claim: () => ({ kind }) as Claim });
  const ago = (lang: TextLang, pattern: string) => ({
    re: new RegExp(pattern, 'giu'),
    claim: (m: RegExpExecArray): Claim | null => {
      const q = (m.groups?.n ?? '').toLowerCase();
      const unitWord = (m.groups?.u ?? '').toLowerCase();
      const u = UNITS[lang].find(([re]) => re.test(unitWord))?.[1];
      if (!u) return null;
      if (/^\d+$/.test(q)) {
        const n = Number(q);
        const slack = Math.max(1, n * 0.4);
        return { kind: 'ago', lo: Math.max(0, n - slack) * u, hi: (n + slack) * u, u };
      }
      if (ONE.test(q)) return { kind: 'ago', lo: 0.5 * u, hi: 2 * u, u };
      if (FEW.test(q)) return { kind: 'ago', lo: 0.5 * u, hi: 12 * u, u };
      return null;
    },
  });
  return {
    en: [day('lastNight', 'last night'), day('today', 'earlier today|earlier this (?:afternoon|evening)'), day('morning', 'this morning'), day('lastWeek', 'last week'), day('yesterday', 'yesterday'), ago('en', `${NB}${SOFT}(?<n>${NUM}) (?<u>${UNIT_WORDS}) ago${NA}`)],
    es: [day('lastNight', 'anoche|ayer por la noche'), day('today', 'hoy más temprano|más temprano hoy|hoy temprano|esta tarde'), day('morning', 'esta mañana'), day('lastWeek', 'la semana pasada'), day('yesterday', 'ayer'), ago('es', `${NB}hace ${SOFT}(?<n>${NUM}) (?<u>${UNIT_WORDS})${NA}`)],
    fr: [day('lastNight', 'hier soir|la nuit dernière'), day('today', "plus tôt aujourd'hui|plus tôt dans la journée|cet après-midi"), day('morning', 'ce matin'), day('lastWeek', 'la semaine dernière'), day('yesterday', 'hier'), ago('fr', `${NB}il y a ${SOFT}(?<n>${NUM}) (?<u>${UNIT_WORDS})${NA}`)],
    de: [day('lastNight', 'gestern abend|gestern nacht|letzte nacht'), day('today', 'heute früher|früher heute|heute nachmittag|vorhin heute'), day('morning', 'heute morgen|heute vormittag|heute früh'), day('lastWeek', 'letzte woche|vergangene woche'), day('yesterday', 'gestern'), ago('de', `${NB}vor ${SOFT}(?<n>${NUM}) (?<u>${UNIT_WORDS})${NA}`)],
    pt: [day('lastNight', 'ontem à noite|ontem a noite'), day('today', 'hoje mais cedo|mais cedo hoje|hoje à tarde|hoje cedo'), day('morning', 'hoje de manhã|esta manhã|nesta manhã'), day('lastWeek', 'semana passada'), day('yesterday', 'ontem'), ago('pt', `${NB}há ${SOFT}(?<n>${NUM}) (?<u>${UNIT_WORDS})${NA}`), ago('pt', `${NB}(?<n>${NUM}) (?<u>${UNIT_WORDS}) atrás${NA}`)],
    it: [day('lastNight', 'ieri sera|ieri notte|stanotte'), day('today', 'oggi più presto|prima oggi|oggi pomeriggio|questo pomeriggio'), day('morning', 'stamattina|stamani|questa mattina'), day('lastWeek', 'la settimana scorsa|settimana scorsa'), day('yesterday', 'ieri'), ago('it', `${NB}${SOFT}(?<n>${NUM}) (?<u>${UNIT_WORDS}) fa${NA}`)],
  };
})();

/** "You said / we talked / me dijiste / hast du gesagt …": the sentence is about something said before. */
const CUE: Record<TextLang, RegExp> = {
  en: /\b(?:you|we|i)\b[^.!?\n]{0,30}?\b(?:said|told|mentioned|asked|wrote|talked|spoke|chatted|discussed|brought (?:it )?up|were telling|sent)\b/i,
  es: /(?<!\p{L})(?:dijiste|mencionaste|contaste|comentaste|preguntaste|escribiste|hablamos|platicamos|conversamos|dije|comenté|te conté|me contaste)(?!\p{L})/iu,
  fr: /(?<!\p{L})(?:tu|vous|on|nous|je)(?!\p{L})[^.!?\n]{0,30}?(?<!\p{L})(?:dit|parlé|raconté|mentionné|écrit|demandé|discuté)(?!\p{L})/iu,
  de: /(?<!\p{L})(?:gesagt|erzählt|erwähnt|geschrieben|gesprochen|geredet|gefragt|besprochen|sagtest|erzähltest|meintest)(?!\p{L})/iu,
  pt: /(?<!\p{L})(?:disse|falou|mencionou|contou|escreveu|perguntou|conversamos|falamos|comentou|disseste)(?!\p{L})/iu,
  it: /(?<!\p{L})(?:detto|parlato|raccontato|menzionato|scritto|chiesto|discusso)(?!\p{L})/iu,
};
const STOP = new Set(['about', 'there', 'their', 'which', 'would', 'could', 'should', 'think', 'really', 'today', 'thing', 'things', 'something', 'because', 'again', 'still', 'other', 'where', 'while', 'these', 'those', 'dass', 'nicht', 'heute', 'porque', 'sobre', 'cette', 'comme', 'quando', 'quand', 'cuando', 'sempre', 'siempre', 'toujours', 'immer', 'tell', 'telling', 'ahora', 'agora', 'adesso', 'maintenant', 'jetzt', 'minutes', 'minutos', 'minuti', 'hours', 'heures', 'horas', 'stunden']);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const stems = (s: string) => new Set((fold(s).match(/\p{L}{5,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));

function fits(c: Claim, at: Date, now: Date, tz?: string): boolean {
  const age = now.getTime() - at.getTime();
  if (age < -MIN) return false;
  const days = dayDiff(localDay(at, tz), localDay(now, tz));
  const hour = localHour(at, tz);
  switch (c.kind) {
    case 'yesterday': return days === 1;
    case 'lastNight': return (days === 1 && hour >= 15) || (days === 0 && hour < 6);
    case 'today': return days === 0;
    case 'morning': return days === 0 && hour < 13;
    case 'lastWeek': return age >= 3 * D && age <= 16 * D;
    case 'ago': return age >= c.lo - MIN && age <= c.hi + MIN;
  }
}

/** The real age in the phrase's own language ("10 minutes ago", "yesterday", "hace 3 días"). */
function realPhrase(at: Date, now: Date, tz: string | undefined, lang: TextLang): string {
  const age = now.getTime() - at.getTime();
  const days = dayDiff(localDay(at, tz), localDay(now, tz));
  if (days === 1 && age >= 8 * H) return YESTERDAY[lang];
  if (days === 0 && age >= 6 * H) return EARLIER_TODAY[lang];
  return ageWords(age, lang);
}

const COPIED_LABEL = /^\s*\[(?:[A-Z][a-z]{2} )?(?:[A-Z][a-z]{2} \d{1,2}(?: \d{4})? )?\d{1,2}:\d{2} [AP]M, [^\]]{0,40}(?:ago|just now)[^\]]{0,40}\]\s*/;

/**
 * Checks what a reply says about WHEN something was said against the real times. A sentence that
 * refers back ("you told me", "hablamos", "hast du gesagt") with a time phrase ("yesterday", "2 hours
 * ago", "la semaine dernière") is matched to the event it talks about (shared words, else the owner's
 * last message before this one); when no known event fits the phrase, the phrase is rewritten to the
 * real age in the same language. A label the model copied from her history is taken off the front.
 * `events` are oldest first; the last owner message is this turn's own.
 */
export function checkTimeClaims(reply: string, events: TimeEvent[], now: Date, timeZone?: string): { text: string; fixes: TimeFix[] } {
  let text = reply.replace(COPIED_LABEL, '');
  const fixes: TimeFix[] = [];
  const known = events.filter((e) => Number.isFinite(Date.parse(e.at)));
  if (!known.length || !text.trim()) return { text: text || reply, fixes };
  const lang = detectLang(text);
  const lastUser = known.findLastIndex((e) => e.role === 'user');
  const before = known.filter((e, i) => i !== lastUser);
  const fallback = before.findLast((e) => e.role === 'user');
  // Each sentence on its own (with its offset, so a rewrite lands in place).
  const edits: { at: number; len: number; by: string }[] = [];
  for (const sm of text.matchAll(/[^.!?…\n]+[.!?…]*/g)) {
    const sentence = sm[0];
    if (!CUE[lang].test(sentence)) continue;
    for (const p of PHRASES[lang]) {
      p.re.lastIndex = 0;
      const m = p.re.exec(sentence);
      if (!m) continue;
      const claim = p.claim(m);
      if (!claim) continue;
      const words = stems(sentence.slice(0, m.index) + ' ' + sentence.slice(m.index + m[0].length));
      const scored = before.map((e) => ({ e, score: [...stems(e.text)].filter((w) => words.has(w)).length })).filter((x) => x.score > 0);
      const top = Math.max(0, ...scored.map((x) => x.score));
      const topical = scored.filter((x) => x.score === top).map((x) => x.e);
      // Something really said at that time backs the phrase (one of the best matches or, with no
      // topic match, anything in the chat at all).
      const pool = topical.length ? topical : known;
      if (pool.some((e) => fits(claim, new Date(e.at), now, timeZone))) break;
      const ref = topical.at(-1) ?? fallback;
      if (!ref) break;
      const real = realPhrase(new Date(ref.at), now, timeZone, lang);
      const said = m[0];
      edits.push({ at: (sm.index ?? 0) + m.index, len: said.length, by: /^\p{Lu}/u.test(said) ? real.charAt(0).toUpperCase() + real.slice(1) : real });
      fixes.push({ said: said.trim(), real, at: ref.at, how: 'rewrite' });
      break;
    }
  }
  for (const e of edits.reverse()) text = text.slice(0, e.at) + e.by + text.slice(e.at + e.len);
  return { text, fixes };
}

// ---------------------------------------------------------------------------------------------
// X1: where the clock line goes on the wire
// ---------------------------------------------------------------------------------------------
const NOW_TAIL = /\n\n(\[Now: [^\n]*\])$/;

/**
 * The clock line ends her instructions (nowLine above) and changes every minute. A model reuses
 * what it has already read only up to the first changed byte, so with the line inside the first
 * message everything after it (the whole conversation) was read again each time the minute turned.
 * The Anthropic adapter calls this just before sending: the line leaves the instructions and follows
 * the conversation as its own note. Nothing else moves; without the line nothing changes. The
 * OpenAI-style adapters do not: a system line as the last message is not safe with every local
 * chat template, and that needs real-model runs first (BACKLOG).
 */
export function moveClockToEnd<T extends { role: string; content: string }>(messages: T[]): T[] {
  const lead = messages.findIndex((m) => m.role !== 'system');
  const end = lead < 0 ? messages.length : lead;
  let tail: string | undefined;
  const out = messages.map((m, i) => {
    if (i >= end || tail !== undefined || typeof m.content !== 'string') return m;
    const hit = NOW_TAIL.exec(m.content);
    if (!hit) return m;
    tail = hit[1]!;
    return { ...m, content: m.content.slice(0, hit.index) };
  });
  if (tail === undefined || lead < 0) return messages;
  return [...out, { role: 'system', content: tail } as T];
}
