// S4 (docs/PEOPLE.md "Keeping in touch"): relationship memory on top of the People cards.
//
// Per card it keeps only derived rows, computed from sources that already exist:
// - the last contact on each channel: mail received/sent (headers of the combined mailboxes),
//   chat rooms she keeps up with (room_lines, never adult rooms), calendar meetings (attendees);
// - "waiting for your reply": their latest mail is newer than anything the owner sent them;
// - promises found in the owner's own sent mail and room lines ("I'll send it Friday"): only the
//   promise sentence is kept, proposed until the owner confirms it;
// - dates (birthday on the card, anniversaries he enters) and a keep-in-touch cadence.
// No message bodies are copied. Nudges are sorted by "needs attention" for the People page, Today
// and the people_due tool. Off the record and with the switch off nothing is read; private chats
// are never read (rooms only, not conversations); private cards stay out of normal views; forget
// wipes every row here (PeopleStore.onWipe) and merge moves them (onMerge). Each person's space has
// its own database, so household members never see each other's.
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { dayMonthRe, detectLang, monthNumber, WEEKDAY_NAMES, words, type TextLang } from './lang-text.ts';
import { allEvents, calendarSources } from './mail/calendars.ts';
import type { SearchTerms } from './mail/search.ts';
import { localDate } from './memory-worker.ts';
import { privateLocalOn } from './net-guard.ts';
import { fold, type Person } from './people.ts';
import type { Tool } from './tools/types.ts';
import { ToolError } from './tools/types.ts';

const DAY = 86_400_000;
export const SCAN_EVERY = 30 * 60_000;
export const FIRST_SCAN_DAYS = 90;
export const WAIT_DAYS = 3;
export const PROMISE_TEXT = 160;
const TEXT_PER_SCAN = 15;

export interface MailHead {
  id: string;
  threadId?: string;
  account: string;
  from: string;
  to: string;
  cc?: string;
  date: string;
  subject: string;
  /** In the Sent folder (the owner's own). */
  sent: boolean;
  /** A list / newsletter / automatic mail. */
  bulk?: boolean;
}
export interface TieSources {
  /** Mail headers since `since` (both directions); `text` reads one of the owner's own sent mails. */
  mail?: (since: Date, signal: AbortSignal) => Promise<{ heads: MailHead[]; text: (h: MailHead) => Promise<string> }>;
  events?: (from: Date, to: Date, signal: AbortSignal) => Promise<{ start: string; title: string; attendees?: string[] }[]>;
}
export interface TieDate { label: string; date: string }
export interface Tie { personId: number; emails: string[]; keepDays: number | null; keepSince: string | null; dates: TieDate[]; touchedAt: string | null }
export type Channel = 'mail' | 'chat' | 'meeting';
export type Dir = 'in' | 'out' | 'met' | 'next';
export interface Contact { personId: number; channel: Channel; dir: Dir; at: string; ref: string | null; label: string | null }
export type PromiseStatus = 'proposed' | 'open' | 'done' | 'dismissed';
export interface Promise_ { id: number; personId: number; text: string; due: string | null; source: 'mail' | 'chat' | 'owner'; ref: string | null; status: PromiseStatus; createdAt: string }
export type NudgeKind = 'waiting' | 'promise' | 'promise-check' | 'birthday' | 'date' | 'keep';
export interface Nudge {
  key: string;
  kind: NudgeKind;
  personId: number;
  name: string;
  /** An en() key; the web shows t(text, params). */
  text: string;
  params: Record<string, string | number>;
  score: number;
  promiseId?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS person_ties (
  person_id INTEGER PRIMARY KEY, emails TEXT NOT NULL DEFAULT '[]', keep_days INTEGER, keep_since TEXT,
  dates TEXT NOT NULL DEFAULT '[]', touched_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_contact (
  person_id INTEGER NOT NULL, channel TEXT NOT NULL, dir TEXT NOT NULL, at TEXT NOT NULL, ref TEXT, label TEXT,
  PRIMARY KEY (person_id, channel, dir)
);
CREATE TABLE IF NOT EXISTS person_promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, text TEXT NOT NULL, due TEXT,
  source TEXT NOT NULL, ref TEXT, status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL, decided_at TEXT,
  UNIQUE (person_id, source, ref, text)
);
CREATE INDEX IF NOT EXISTS person_promises_person ON person_promises(person_id);
CREATE TABLE IF NOT EXISTS memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// ------------------------------------------------------------------------------------ promises

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const VERBS = 'send|share|get|call|ring|email|e-mail|text|write|forward|finish|review|check|look|bring|pay|book|follow up|reply|draft|prepare|deliver|update|return|drop|pick|sort|fix|confirm|introduce|set up|schedule|circle back';
const PROMISE_RE = new RegExp(`\\b(?:i['’]ll|i will|i['’]m going to|i am going to|i promise to|i can|let me)\\s+(?:also\\s+|just\\s+|definitely\\s+|try to\\s+|make sure to\\s+)?(?:${VERBS})\\b`, 'i');
const NOT_RE = /\b(?:never|not|won['’]t|can['’]t|cannot|unless|if you|maybe|might)\b/i;

const addDays = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (ymd: string): number => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** The due day a promise names, relative to the day it was written (in the owner's time zone). */
function dueOf(s: string, today: string): string | null {
  const t = s.toLowerCase();
  if (/\b(today|tonight|this evening|eod|end of (?:the )?day)\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\b(end of (?:the |this )?week|this week)\b/.test(t)) return addDays(today, (5 - weekday(today) + 7) % 7);
  if (/\bnext week\b/.test(t)) return addDays(today, 7);
  const inN = /\bin (\d{1,2}|a couple of|two|three) days\b/.exec(t);
  if (inN) return addDays(today, ({ 'a couple of': 2, two: 2, three: 3 } as Record<string, number>)[inN[1]] ?? Number(inN[1]));
  const wd = new RegExp(`\\b(next\\s+)?(${WEEKDAYS.join('|')})\\b`).exec(t);
  if (wd) {
    let d = (WEEKDAYS.indexOf(wd[2]) - weekday(today) + 7) % 7;
    if (wd[1] && d === 0) d = 7;
    return addDays(today, d);
  }
  const md = new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  if (md) {
    const mi = MONTHS.findIndex((m) => m.startsWith(md[1].slice(0, 3)));
    const y = Number(today.slice(0, 4));
    let at = `${y}-${String(mi + 1).padStart(2, '0')}-${String(Number(md[2])).padStart(2, '0')}`;
    if (at < today) at = `${y + 1}${at.slice(4)}`;
    return Number.isNaN(Date.parse(at)) ? null : at;
  }
  return null;
}

// U3.12: promises in Spanish, French, German, Brazilian Portuguese and Italian. Each language has its
// own first-person "I will" phrases, its no-promise words and its day words; a text uses only the
// phrases of the language it is written in.
type Other = Exclude<TextLang, 'en'>;
interface PromiseWords { re: RegExp; not: RegExp; today: RegExp; after: RegExp; tomorrow: RegExp; week: RegExp; nextWeek: RegExp; inDays: RegExp; next: RegExp; reply: RegExp }
const NUM_WORDS: Record<string, number> = { dos: 2, deux: 2, zwei: 2, dois: 2, due: 2, tres: 3, trois: 3, drei: 3, três: 3, tre: 3 };
const PROMISE_WORDS: Record<Other, PromiseWords> = {
  es: {
    re: words('(?:te|le|les|os)\\s+(?:lo\\s+|la\\s+|los\\s+|las\\s+)?(?:envío|envio|mando|paso|llamo|escribo|confirmo|aviso|reenvío|devuelvo|preparo)|voy\\s+a\\s+(?:enviar|mandar|llamar|escribir|revisar|confirmar|preparar|pagar|reservar|terminar|reenviar|mirar|comprobar)\\p{L}*|(?:enviaré|mandaré|llamaré|escribiré|revisaré|confirmaré|prepararé|pagaré|reservaré|terminaré|reenviaré|comprobaré)|me\\s+encargo\\s+de|prometo\\s+\\p{L}+|yo\\s+(?:envío|mando|llamo|reviso|preparo)'),
    not: words('no|nunca|jamás|si|quizás|quizá|tal\\s+vez|a\\s+lo\\s+mejor|puede\\s+que'),
    today: words('hoy|esta\\s+(?:tarde|noche|mañana)'),
    after: words('pasado\\s+mañana'),
    tomorrow: words('mañana'),
    week: words('esta\\s+semana|antes\\s+del?\\s+fin(?:al)?\\s+de\\s+(?:la\\s+)?semana'),
    nextWeek: words('la\\s+semana\\s+que\\s+viene|la\\s+próxima\\s+semana|la\\s+semana\\s+próxima'),
    inDays: words('en\\s+(\\d{1,2}|dos|tres)\\s+días'),
    next: words('próximo|que\\s+viene'),
    reply: /\n(?:El .{5,160}escribió:|-{2,} ?Mensaje original ?-{2,}|De: .+\n(?:Enviado|Fecha): )/,
  },
  fr: {
    re: words("je\\s+(?:vous\\s+|te\\s+|t['’]|lui\\s+|leur\\s+)?(?:l['’]|le\\s+|la\\s+|les\\s+)?(?:enverrai|envoie|envoierai|appellerai|appelle|rappelle|rappellerai|écrirai|transmettrai|transmets|vérifierai|confirmerai|préparerai|paierai|réserverai|finirai|ferai\\s+suivre|relirai|occupe)|je\\s+vais\\s+(?:vous\\s+|te\\s+|t['’]|lui\\s+)?(?:l['’]|le\\s+|la\\s+|les\\s+)?(?:envoyer|appeler|rappeler|écrire|transmettre|vérifier|confirmer|préparer|payer|réserver|finir|relire|faire\\s+suivre|regarder)|je\\s+m['’]en\\s+occupe|je\\s+promets\\s+de"),
    not: words("ne|n['’]|pas|jamais|si|peut-être|peut\\s+être"),
    today: words("aujourd['’]hui|ce\\s+soir|cet\\s+après-midi|ce\\s+matin"),
    after: words('après-demain'),
    tomorrow: words('demain'),
    week: words('cette\\s+semaine|(?:d[\'’]ici\\s+la|avant\\s+la)\\s+fin\\s+de\\s+(?:la\\s+)?semaine'),
    nextWeek: words('la\\s+semaine\\s+prochaine'),
    inDays: words('dans\\s+(\\d{1,2}|deux|trois)\\s+jours'),
    next: words('prochain'),
    reply: /\n(?:Le .{5,160}a écrit ?:|-{2,} ?Message d'origine ?-{2,}|De ?: .+\n(?:Envoyé|Date) ?: )/,
  },
  de: {
    re: words('ich\\s+(?:schicke|sende|rufe|schreibe|melde|kümmere|prüfe|bestätige|bezahle|überweise|buche|leite|bringe|erledige|kläre|reiche)|ich\\s+werde(?=[^.!?]{0,80}?(?<![\\p{L}])(?:schicken|senden|zuschicken|anrufen|zurückrufen|schreiben|melden|prüfen|bestätigen|bezahlen|überweisen|buchen|weiterleiten|vorbereiten|fertigstellen|kümmern|erledigen|mitbringen|klären|nachreichen)(?![\\p{L}]))|ich\\s+verspreche'),
    not: words('nicht|nichts|nie|niemals|kein\\p{L}*|wenn|falls|vielleicht|eventuell'),
    today: words('heute(?:\\s+(?:abend|nachmittag|morgen))?'),
    after: words('übermorgen'),
    tomorrow: words('morgen'),
    week: words('diese\\s+woche|bis\\s+ende\\s+der\\s+woche'),
    nextWeek: words('nächste\\s+woche|kommende\\s+woche'),
    inDays: words('in\\s+(\\d{1,2}|zwei|drei)\\s+tagen'),
    next: words('nächsten?'),
    reply: /\n(?:Am .{5,160}schrieb.{0,80}:|-{2,} ?Ursprüngliche Nachricht ?-{2,}|Von: .+\n(?:Gesendet|Datum): )/,
  },
  pt: {
    re: words('vou\\s+(?:te\\s+|lhe\\s+|lhes\\s+)?(?:enviar|mandar|ligar|escrever|encaminhar|revisar|confirmar|preparar|pagar|reservar|terminar|verificar|passar)|(?:eu\\s+)?(?:te|lhe|lhes)\\s+(?:envio|mando|ligo|escrevo|passo|encaminho|confirmo|aviso)|eu\\s+(?:envio|mando|ligo|escrevo|reviso|preparo|pago|confirmo|verifico|encaminho)|(?:enviarei|mandarei|ligarei|escreverei|revisarei|confirmarei|prepararei|pagarei|reservarei|terminarei|encaminharei)|deixa\\s+comigo|prometo\\s+\\p{L}+'),
    not: words('não|nunca|jamais|se|talvez|quem\\s+sabe'),
    today: words('hoje(?:\\s+à\\s+(?:noite|tarde))?'),
    after: words('depois\\s+de\\s+amanhã'),
    tomorrow: words('amanhã'),
    week: words('esta\\s+semana|essa\\s+semana|até\\s+o\\s+fim\\s+da\\s+semana'),
    nextWeek: words('semana\\s+que\\s+vem|próxima\\s+semana'),
    inDays: words('em\\s+(\\d{1,2}|dois|duas|três)\\s+dias'),
    next: words('próxim[ao]|que\\s+vem'),
    reply: /\n(?:Em .{5,160}escreveu:|-{2,} ?Mensagem original ?-{2,}|De: .+\n(?:Enviado|Data): )/,
  },
  it: {
    re: words("(?:te\\s+lo|te\\s+la|ti|le|gli|vi)\\s+(?:mando|invio|chiamo|scrivo|giro|richiamo|confermo|preparo|inoltro)|(?:manderò|invierò|chiamerò|richiamerò|scriverò|controllerò|confermerò|preparerò|pagherò|prenoterò|finirò|girerò|inoltrerò|farò\\s+sapere)|ci\\s+penso\\s+io|me\\s+ne\\s+occupo\\s+io|prometto\\s+di|io\\s+(?:mando|invio|chiamo|preparo|controllo)"),
    not: words('non|mai|se|forse|magari'),
    today: words('oggi|stasera|stamattina|oggi\\s+pomeriggio'),
    after: words('dopodomani'),
    tomorrow: words('domani'),
    week: words('questa\\s+settimana|entro\\s+(?:la\\s+)?fine\\s+settimana'),
    nextWeek: words('la\\s+settimana\\s+prossima|la\\s+prossima\\s+settimana'),
    inDays: words('(?:tra|fra)\\s+(\\d{1,2}|due|tre)\\s+giorni'),
    next: words('prossim[oa]'),
    reply: /\n(?:Il giorno .{5,160}ha scritto:|-{2,} ?Messaggio originale ?-{2,}|Da: .+\n(?:Inviato|Data): )/,
  },
};

/** The due day in another language (day words, weekdays, "3 de diciembre", 03/12). */
function dueOfIn(s: string, today: string, lang: Other): string | null {
  const w = PROMISE_WORDS[lang];
  if (w.today.test(s)) return today;
  if (w.after.test(s)) return addDays(today, 2);
  // "esta mañana" is this morning (today); "por la mañana" alone is no day.
  if (w.tomorrow.test(s.replace(words('(?:por|de|a)\\s+la\\s+mañana|heute\\s+morgen|morgen\\s+früh', 'giu'), (x) => (/früh/i.test(x) ? 'morgen' : '')))) return addDays(today, 1);
  if (w.week.test(s)) return addDays(today, (5 - weekday(today) + 7) % 7);
  if (w.nextWeek.test(s)) return addDays(today, 7);
  const inN = w.inDays.exec(s);
  if (inN) return addDays(today, NUM_WORDS[inN[1]!.toLowerCase()] ?? Number(inN[1]));
  const names = WEEKDAY_NAMES[lang];
  const wd = words(names.flat().join('|')).exec(s);
  if (wd) {
    const idx = names.findIndex((n) => n.includes(wd[0].toLowerCase()));
    let d = (idx - weekday(today) + 7) % 7;
    if (d === 0 && w.next.test(s)) d = 7;
    return addDays(today, d);
  }
  const y = Number(today.slice(0, 4));
  const ymd = (mo: number, d: number): string | null => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    let at = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (at < today) at = `${y + 1}${at.slice(4)}`;
    return Number.isNaN(Date.parse(at)) ? null : at;
  };
  const dm = dayMonthRe(lang);
  const md = dm.exec(s);
  if (md) return ymd(monthNumber(md[2]!, lang), Number(md[1]));
  const num = /(?<![\d./])(\d{1,2})[./](\d{1,2})(?![\d]|[./]\d)/.exec(s);
  if (num) return ymd(Number(num[2]), Number(num[1]));
  return null;
}

/** The owner's own words only: quoted replies and signatures go first. */
function ownPart(text: string, lang: TextLang = 'en'): string {
  const head = text.split(lang === 'en' ? /\n(?:On .{5,160}wrote:|-{2,} ?Original Message ?-{2,}|From: .+\n(?:Sent|Date): )/ : PROMISE_WORDS[lang].reply)[0];
  return head
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

/** "I'll send you the slides by Friday." → a promise with its due day (null when none is named). */
export function findPromises(text: string, at: string, timeZone?: string): { text: string; due: string | null }[] {
  const today = localDate(at, timeZone);
  const out: { text: string; due: string | null }[] = [];
  const lang = detectLang(text.slice(0, 2000));
  // "bis zum 3. Dezember": a day number's dot ends no sentence (other languages).
  for (const raw of ownPart(text, lang).split(lang === 'en' ? /(?<=[.!?])\s+|\n+/ : /(?<=[.!?])(?<!(?<![\d.])\d{1,2}\.)\s+|\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 8 || /\?\s*$/.test(s) || /^¿/.test(s)) continue;
    if (lang !== 'en') {
      // U3.12: the language's own phrases; a no-promise word before or just after makes it none.
      const w = PROMISE_WORDS[lang];
      const m = w.re.exec(s);
      if (!m || w.not.test(s.slice(0, m.index + m[0].length + 24))) continue;
      const said = s.slice(m.index).replace(/[.!\s]+$/, '');
      out.push({ text: said.length > PROMISE_TEXT ? `${said.slice(0, PROMISE_TEXT - 1)}…` : said, due: dueOfIn(said, today, lang) ?? dueOfIn(s, today, lang) });
      continue;
    }
    const m = PROMISE_RE.exec(s);
    if (!m) continue;
    // A "won't"/"never"/"if you" before or in the promise makes it no promise.
    if (NOT_RE.test(s.slice(0, m.index + m[0].length + 12))) continue;
    // "I'll send you the slides by Friday." → "send you the slides by Friday" (reads after "You promised Ana:").
    const said = s
      .slice(m.index)
      .replace(/^(?:i['’]ll|i will|i['’]m going to|i am going to|i promise to|i can|let me)\s+(?:also\s+|just\s+|definitely\s+)?/i, '')
      .replace(/[.!\s]+$/, '');
    out.push({ text: said.length > PROMISE_TEXT ? `${said.slice(0, PROMISE_TEXT - 1)}…` : said, due: dueOf(said, today) });
  }
  return out;
}

// ------------------------------------------------------------------------------------ the store

type Row = Record<string, string | number | null>;
const addressOf = (s: string): string => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();
const nameOf = (s: string): string => s.replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
const listOf = (s: string | undefined): string[] => (s ?? '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean);
const validEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

export interface TieOptions {
  sources?: TieSources;
}

export class PeopleTies {
  readonly #app: AppContext;
  readonly #sources: TieSources;
  #running: Promise<void> | undefined;
  #lastScan = 0;

  constructor(app: AppContext, opts: TieOptions = {}) {
    this.#app = app;
    this.#sources = opts.sources ?? defaultSources(app);
    this.db.exec(SCHEMA);
    const people = app.people;
    if (people) {
      people.onWipe = (id) => this.forget(id);
      people.onMerge = (id, into) => this.merge(id, into);
    }
  }

  get db(): AppContext['store']['db'] {
    return this.#app.store.db;
  }
  #now(): Date {
    return this.#app.now();
  }
  #tz(): string | undefined {
    return this.#app.settings.get().timeZone;
  }
  #kv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined;
  }
  #kvSet(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM memory_kv WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO memory_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------------------------------------------------------------- switch

  /** "Keep track of contact and promises" (on by default; per person's space). */
  on(): boolean {
    return this.#kv('ties:on') !== '0';
  }
  setOn(on: boolean): void {
    this.#kvSet('ties:on', on ? '1' : '0');
  }

  // ---------------------------------------------------------------- per card

  tie(personId: number): Tie {
    const r = this.db.prepare('SELECT * FROM person_ties WHERE person_id = ?').get(personId) as Row | undefined;
    const arr = <T>(v: unknown): T[] => {
      try {
        const x = JSON.parse(String(v ?? '[]'));
        return Array.isArray(x) ? (x as T[]) : [];
      } catch {
        return [];
      }
    };
    return { personId, emails: arr<string>(r?.emails), keepDays: r?.keep_days ? Number(r.keep_days) : null, keepSince: (r?.keep_since as string | null) ?? null, dates: arr<TieDate>(r?.dates), touchedAt: (r?.touched_at as string | null) ?? null };
  }

  setTie(personId: number, patch: { emails?: string[]; keepDays?: number | null; dates?: TieDate[] }): Tie {
    const cur = this.tie(personId);
    const emails = patch.emails ? [...new Set(patch.emails.map((e) => e.trim().toLowerCase()).filter(validEmail))].slice(0, 10) : cur.emails;
    const keepDays = patch.keepDays === undefined ? cur.keepDays : patch.keepDays && patch.keepDays > 0 ? Math.min(730, Math.round(patch.keepDays)) : null;
    const keepSince = keepDays ? (cur.keepDays === keepDays && cur.keepSince ? cur.keepSince : this.#now().toISOString()) : null;
    const dates = patch.dates ? patch.dates.filter((d) => d && typeof d.label === 'string' && /^(\d{4}|-)-?\d{2}-\d{2}$|^\d{4}-\d{2}-\d{2}$/.test(String(d.date))).map((d) => ({ label: d.label.trim().slice(0, 60) || 'Anniversary', date: String(d.date) })).slice(0, 8) : cur.dates;
    this.db
      .prepare('INSERT INTO person_ties (person_id, emails, keep_days, keep_since, dates, touched_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET emails = excluded.emails, keep_days = excluded.keep_days, keep_since = excluded.keep_since, dates = excluded.dates, updated_at = excluded.updated_at')
      .run(personId, JSON.stringify(emails), keepDays, keepSince, JSON.stringify(dates), cur.touchedAt, this.#now().toISOString());
    return this.tie(personId);
  }

  contacts(personId: number): Contact[] {
    return (this.db.prepare('SELECT * FROM person_contact WHERE person_id = ? ORDER BY at DESC').all(personId) as Row[]).map((r) => ({ personId, channel: String(r.channel) as Channel, dir: String(r.dir) as Dir, at: String(r.at), ref: (r.ref as string | null) ?? null, label: (r.label as string | null) ?? null }));
  }

  /** The newest contact of any kind (sent, received, met), or when he marked it done. */
  lastContact(personId: number): string | null {
    const r = this.db.prepare("SELECT MAX(at) AS at FROM person_contact WHERE person_id = ? AND dir != 'next'").get(personId) as Row | undefined;
    return [r?.at as string | null, this.tie(personId).touchedAt].filter(Boolean).sort().at(-1) ?? null;
  }

  #contact(personId: number, channel: Channel, dir: Dir, at: string, ref: string | null, label: string | null = null): void {
    // 'next' keeps the soonest upcoming meeting; the others keep the newest.
    const cmp = dir === 'next' ? 'excluded.at < person_contact.at OR person_contact.at < ?' : 'excluded.at > person_contact.at';
    const args = dir === 'next' ? [this.#now().toISOString()] : [];
    this.db.prepare(`INSERT INTO person_contact (person_id, channel, dir, at, ref, label) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(person_id, channel, dir) DO UPDATE SET at = excluded.at, ref = excluded.ref, label = excluded.label WHERE ${cmp}`).run(personId, channel, dir, at, ref, label ? label.slice(0, 80) : null, ...args);
  }

  // ---------------------------------------------------------------- promises

  promises(opts: { status?: PromiseStatus | 'all' | 'active'; personId?: number } = {}): Promise_[] {
    const st = opts.status ?? 'active';
    const where = [st === 'all' ? '1' : st === 'active' ? "status IN ('proposed','open')" : 'status = ?', opts.personId ? 'person_id = ?' : '1'].join(' AND ');
    const args = [...(st === 'all' || st === 'active' ? [] : [st]), ...(opts.personId ? [opts.personId] : [])];
    return (this.db.prepare(`SELECT * FROM person_promises WHERE ${where} ORDER BY COALESCE(due, '9999') , id`).all(...args) as Row[]).map((r) => ({ id: Number(r.id), personId: Number(r.person_id), text: String(r.text), due: (r.due as string | null) ?? null, source: String(r.source) as Promise_['source'], ref: (r.ref as string | null) ?? null, status: String(r.status) as PromiseStatus, createdAt: String(r.created_at) }));
  }

  addPromise(personId: number, p: { text: string; due?: string | null }): Promise_ | undefined {
    const text = p.text.replace(/\s+/g, ' ').trim().slice(0, PROMISE_TEXT);
    if (text.length < 3) return undefined;
    const due = p.due && /^\d{4}-\d{2}-\d{2}$/.test(p.due) ? p.due : null;
    const r = this.db.prepare("INSERT INTO person_promises (person_id, text, due, source, ref, status, created_at) VALUES (?, ?, ?, 'owner', ?, 'open', ?)").run(personId, text, due, `o${Date.now()}${Math.random()}`, this.#now().toISOString());
    return this.promises({ status: 'all' }).find((x) => x.id === Number(r.lastInsertRowid));
  }

  #propose(personId: number, text: string, due: string | null, source: 'mail' | 'chat', ref: string): void {
    this.db.prepare("INSERT OR IGNORE INTO person_promises (person_id, text, due, source, ref, status, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)").run(personId, text, due, source, ref, this.#now().toISOString());
  }

  /** confirm (proposed → open), done, dismiss (not a promise / no longer), or a new due day. */
  decidePromise(id: number, action: 'confirm' | 'done' | 'dismiss' | 'reopen', due?: string | null): Promise_ | undefined {
    const status = action === 'confirm' || action === 'reopen' ? 'open' : action === 'done' ? 'done' : 'dismissed';
    const r = this.db.prepare('UPDATE person_promises SET status = ?, decided_at = ? WHERE id = ?').run(status, this.#now().toISOString(), id);
    if (!r.changes) return undefined;
    if (due !== undefined) this.db.prepare('UPDATE person_promises SET due = ? WHERE id = ?').run(due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null, id);
    return this.promises({ status: 'all' }).find((x) => x.id === id);
  }

  // ---------------------------------------------------------------- forget / merge

  forget(personId: number): void {
    this.db.prepare('DELETE FROM person_ties WHERE person_id = ?').run(personId);
    this.db.prepare('DELETE FROM person_contact WHERE person_id = ?').run(personId);
    this.db.prepare('DELETE FROM person_promises WHERE person_id = ?').run(personId);
    this.db.prepare('DELETE FROM memory_kv WHERE key LIKE ?').run(`ties:snooze:%:${personId}:%`);
  }

  merge(id: number, into: number): void {
    const a = this.tie(id);
    const b = this.tie(into);
    if (a.emails.length || a.dates.length || a.keepDays) this.setTie(into, { emails: [...b.emails, ...a.emails], dates: [...b.dates, ...a.dates], keepDays: b.keepDays ?? a.keepDays });
    for (const c of this.contacts(id)) this.#contact(into, c.channel, c.dir, c.at, c.ref, c.label);
    this.db.prepare('UPDATE OR IGNORE person_promises SET person_id = ? WHERE person_id = ?').run(into, id);
    this.forget(id);
  }

  // ---------------------------------------------------------------- scanning

  /** The reminder tick: a scan at most every 30 minutes, in the background, one at a time. */
  due(now: Date): Promise<void> {
    if (this.#running || now.getTime() - this.#lastScan < SCAN_EVERY) return this.#running ?? Promise.resolve();
    this.#lastScan = now.getTime();
    return this.scan().catch((err: Error) => console.warn(`people ties: ${err.message}`));
  }

  /** Reads the sources since the last scan (90 days the first time) and updates the derived rows. */
  scan(signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#scan(signal).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #scan(signal: AbortSignal): Promise<void> {
    const app = this.#app;
    if (app.offRecord || app.demo || !this.on() || !app.people) return;
    const now = this.#now();
    const last = this.#kv('ties:scanned');
    const since = new Date(last ? Date.parse(last) - DAY : now.getTime() - FIRST_SCAN_DAYS * DAY);
    const people = app.people.all().filter((p) => p.status === 'active');
    if (!people.length) return;
    const byEmail = new Map<string, number>();
    for (const p of people) for (const e of this.tie(p.id).emails) byEmail.set(e, p.id);
    // A header name equal to a card's full name (or a two-word name) teaches the card its address.
    const byName = new Map<string, number>();
    for (const p of people) for (const n of [p.fullName ?? '', p.name.includes(' ') ? p.name : '']) if (n.trim().includes(' ')) byName.set(fold(n.trim()), p.id);
    const who = (raw: string): number | undefined => {
      const a = addressOf(raw);
      if (!validEmail(a)) return undefined;
      const hit = byEmail.get(a);
      if (hit) return hit;
      const n = byName.get(fold(nameOf(raw)));
      if (n === undefined) return undefined;
      byEmail.set(a, n);
      this.setTie(n, { emails: [...this.tie(n).emails, a] });
      return n;
    };
    const offServer = privateLocalOn();
    if (this.#sources.mail && !offServer) {
      try {
        const { heads, text } = await this.#sources.mail(since, signal);
        let reads = 0;
        for (const h of [...heads].sort((x, y) => Date.parse(x.date) - Date.parse(y.date))) {
          const at = new Date(h.date);
          if (Number.isNaN(at.getTime())) continue;
          const iso = at.toISOString();
          if (h.sent) {
            const to = [...listOf(h.to), ...listOf(h.cc)].map(who).filter((x): x is number => x !== undefined);
            for (const pid of new Set(to)) this.#contact(pid, 'mail', 'out', iso, h.threadId ?? h.id);
            // Promises: only to someone on a card, only the newest few per scan.
            const first = listOf(h.to).map(who).find((x) => x !== undefined);
            if (first !== undefined && reads < TEXT_PER_SCAN) {
              reads++;
              const body = await text(h).catch(() => '');
              for (const p of findPromises(body, iso, this.#tz())) this.#propose(first, p.text, p.due, 'mail', h.id);
            }
          } else if (!h.bulk) {
            const pid = who(h.from);
            if (pid !== undefined) this.#contact(pid, 'mail', 'in', iso, h.threadId ?? h.id, h.subject);
          }
        }
      } catch (err) {
        console.warn(`people ties mail: ${(err as Error).message}`);
      }
    }
    if (this.#sources.events && !offServer) {
      try {
        const evs = await this.#sources.events(new Date(now.getTime() - 60 * DAY), new Date(now.getTime() + 30 * DAY), signal);
        for (const e of evs) {
          const at = /^\d{4}-\d{2}-\d{2}$/.test(e.start) ? `${e.start}T12:00:00.000Z` : new Date(e.start).toISOString();
          for (const pid of new Set((e.attendees ?? []).map(who).filter((x): x is number => x !== undefined))) this.#contact(pid, 'meeting', at <= now.toISOString() ? 'met' : 'next', at, null, e.title);
        }
      } catch (err) {
        console.warn(`people ties calendar: ${(err as Error).message}`);
      }
    }
    this.#scanRooms(since);
    this.#kvSet('ties:scanned', now.toISOString());
  }

  /** Chat rooms she keeps up with (not adult ones): lines by a linked person; the owner's replies to them. */
  #scanRooms(since: Date): void {
    let rows: Row[];
    try {
      rows = this.db
        .prepare(
          `SELECT l.room_id, l.platform_id, l.author_id, l.who, l.text, l.reply_to, l.at FROM room_lines l JOIN rooms r ON r.id = l.room_id
           WHERE r.adult = 0 AND l.at >= ? AND l.who IN ('person','owner') AND (l.flags IS NULL OR l.flags NOT LIKE '%removed%') ORDER BY l.at`,
        )
        .all(since.toISOString()) as Row[];
    } catch {
      return; // no rooms here
    }
    if (!rows.length) return;
    const link = new Map<string, number>();
    for (const r of this.db.prepare('SELECT person_id, room_id, platform_user_id FROM people_rooms').all() as Row[]) link.set(`${r.room_id}:${r.platform_user_id}`, Number(r.person_id));
    try {
      for (const r of this.db.prepare('SELECT person_id, room_id, platform_user_id FROM room_people WHERE person_id IS NOT NULL').all() as Row[]) if (!link.has(`${r.room_id}:${r.platform_user_id}`)) link.set(`${r.room_id}:${r.platform_user_id}`, Number(r.person_id));
    } catch {
      /* older databases */
    }
    const active = new Set((this.#app.people?.all() ?? []).filter((p) => p.status === 'active').map((p) => p.id));
    const authorOf = new Map<string, number>();
    for (const l of rows) {
      const at = new Date(String(l.at)).toISOString();
      if (l.who === 'person') {
        const pid = link.get(`${l.room_id}:${l.author_id}`);
        if (pid === undefined || !active.has(pid)) continue;
        if (l.platform_id) authorOf.set(`${l.room_id}:${l.platform_id}`, pid);
        this.#contact(pid, 'chat', 'in', at, `room:${l.room_id}`);
        continue;
      }
      // The owner's line: a reply to a linked person's line is a contact (and may hold a promise).
      const pid = l.reply_to ? authorOf.get(`${l.room_id}:${l.reply_to}`) : undefined;
      if (pid === undefined) continue;
      this.#contact(pid, 'chat', 'out', at, `room:${l.room_id}`);
      for (const p of findPromises(String(l.text), at, this.#tz())) this.#propose(pid, p.text, p.due, 'chat', `room:${l.room_id}:${l.platform_id ?? at}`);
    }
  }

  // ---------------------------------------------------------------- needs attention

  #snoozed(key: string): boolean {
    const v = this.#kv(`ties:snooze:${key}`);
    return Boolean(v && (v === 'forever' || v > this.#now().toISOString()));
  }

  /** "Done" (keep in touch: touched today), "later" (a week), "dismiss" (this one for good). */
  act(key: string, action: 'done' | 'later' | 'dismiss'): boolean {
    const m = /^(\w[\w-]*):(\d+):?(.*)$/.exec(key);
    if (!m) return false;
    const pid = Number(m[2]);
    if (action === 'done' && m[1] === 'keep') {
      this.tie(pid);
      this.db.prepare('INSERT INTO person_ties (person_id, touched_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET touched_at = excluded.touched_at, updated_at = excluded.updated_at').run(pid, this.#now().toISOString(), this.#now().toISOString());
      return true;
    }
    this.#kvSet(`ties:snooze:${key}`, action === 'later' ? new Date(this.#now().getTime() + 7 * DAY).toISOString() : 'forever');
    return true;
  }

  /** Everything that needs the owner, most urgent first. Private cards only when `private`. */
  attention(opts: { private?: boolean; personId?: number } = {}): Nudge[] {
    const people = (this.#app.people?.all() ?? []).filter((p) => p.status === 'active' && (opts.private || !p.private) && (!opts.personId || p.id === opts.personId));
    if (!people.length) return [];
    const now = this.#now();
    const today = localDate(now, this.#tz());
    const out: Nudge[] = [];
    const push = (n: Omit<Nudge, 'name'>, p: Person) => {
      if (!this.#snoozed(n.key)) out.push({ ...n, name: p.name });
    };
    const daysTo = (ymd: string) => Math.round((Date.parse(`${ymd}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);
    const nextOf = (mmdd: string): { ymd: string; n: number } => {
      const y = Number(today.slice(0, 4));
      for (const yr of [y, y + 1]) {
        const ymd = `${yr}-${mmdd}`;
        const n = daysTo(ymd);
        if (n >= 0) return { ymd, n };
      }
      return { ymd: `${y + 1}-${mmdd}`, n: 400 };
    };
    for (const p of people) {
      const c = this.contacts(p.id);
      const tie = this.tie(p.id);
      // Waiting for your reply: their mail is newer than anything you sent them.
      const inn = c.find((x) => x.channel === 'mail' && x.dir === 'in');
      const out_ = c.find((x) => x.channel === 'mail' && x.dir === 'out');
      if (inn && (!out_ || out_.at < inn.at)) {
        const days = Math.floor((now.getTime() - Date.parse(inn.at)) / DAY);
        if (days >= WAIT_DAYS) {
          const weeks = Math.floor(days / 7);
          push({ key: `wait:${p.id}:${inn.ref ?? inn.at}`, kind: 'waiting', personId: p.id, text: weeks >= 2 ? en('{name} has waited {n} weeks for your reply') : en('{name} has waited {n} days for your reply'), params: { name: p.name, n: weeks >= 2 ? weeks : days, subject: inn.label ?? '' }, score: 40 + days }, p);
        }
      }
      // Birthday (from the card) and his dates (anniversaries), a week ahead.
      if (p.birthday) {
        const md = /(\d{2})-(\d{2})$/.exec(p.birthday);
        if (md) {
          const { ymd, n } = nextOf(`${md[1]}-${md[2]}`);
          if (n <= 7) push({ key: `bday:${p.id}:${ymd}`, kind: 'birthday', personId: p.id, text: n === 0 ? en("{name}'s birthday is today") : en("{name}'s birthday is in {n} days"), params: { name: p.name, n, date: ymd }, score: 60 - n * 5 }, p);
        }
      }
      for (const d of tie.dates) {
        const md = /(\d{2})-(\d{2})$/.exec(d.date);
        if (!md) continue;
        const { ymd, n } = nextOf(`${md[1]}-${md[2]}`);
        if (n <= 7) push({ key: `date:${p.id}:${d.label}:${ymd}`, kind: 'date', personId: p.id, text: n === 0 ? en('{name}: {label} today') : en('{name}: {label} in {n} days'), params: { name: p.name, label: d.label, n, date: ymd }, score: 55 - n * 5 }, p);
      }
      // Keep in touch: the cadence passed since the last contact (or since he set it).
      if (tie.keepDays) {
        const last = this.lastContact(p.id);
        const base = last ?? tie.keepSince;
        const gap = base ? Math.floor((now.getTime() - Date.parse(base)) / DAY) : 0;
        if (gap >= tie.keepDays) {
          const months = Math.floor(gap / 30);
          const text = !last ? en('Time to get in touch with {name}') : months >= 2 ? en("You haven't been in touch with {name} for {n} months") : en("You haven't been in touch with {name} for {n} weeks");
          push({ key: `keep:${p.id}`, kind: 'keep', personId: p.id, text, params: { name: p.name, n: months >= 2 ? months : Math.max(1, Math.floor(gap / 7)) }, score: 20 + Math.min(30, Math.round((gap / tie.keepDays) * 10)) }, p);
        }
      }
    }
    // Promises: to confirm first, then due soon or overdue.
    const ids = new Map(people.map((p) => [p.id, p]));
    for (const pr of this.promises({ status: 'active' })) {
      const p = ids.get(pr.personId);
      if (!p) continue;
      if (pr.status === 'proposed') {
        push({ key: `pcheck:${p.id}:${pr.id}`, kind: 'promise-check', personId: p.id, promiseId: pr.id, text: en('Did you promise {name}: {what}?'), params: { name: p.name, what: pr.text, date: pr.due ?? '' }, score: 45 }, p);
        continue;
      }
      const n = pr.due ? daysTo(pr.due) : null;
      if (n !== null && n > 7) continue;
      const text = n === null ? en('You promised {name}: {what}') : n < 0 ? en('You promised {name}: {what} (overdue since {date})') : en('You promised {name}: {what} (by {date})');
      push({ key: `promise:${p.id}:${pr.id}`, kind: 'promise', personId: p.id, promiseId: pr.id, text, params: { name: p.name, what: pr.text, date: pr.due ?? '' }, score: n === null ? 25 : n < 0 ? 90 - n : 70 - n * 5 }, p);
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Today's tile: the top few (birthdays stay on the Dates tile). No tile when nothing needs him. */
  todayTile(): { items: (Nudge & { kind: NudgeKind })[]; more: number } | undefined {
    if (this.#app.offRecord) return undefined;
    const all = this.attention().filter((n) => n.kind !== 'birthday');
    if (!all.length) return undefined;
    return { items: all.slice(0, 5), more: Math.max(0, all.length - 5) };
  }

  /** The People page's per-card summary. */
  summary(personId: number): { tie: Tie; contacts: Contact[]; promises: Promise_[]; last: string | null } {
    return { tie: this.tie(personId), contacts: this.contacts(personId), promises: this.promises({ status: 'all', personId }).filter((p) => p.status !== 'dismissed').slice(0, 20), last: this.lastContact(personId) };
  }
}

/** Fills a nudge's English template (tools and notifications; the web translates with t()). */
export function nudgeLine(n: Pick<Nudge, 'text' | 'params'>): string {
  return n.text.replace(/\{(\w+)\}/g, (_, k: string) => String(n.params[k] ?? ''));
}

// ------------------------------------------------------------------------------------ real sources

type Accts = NonNullable<AppContext['mailAccounts']>;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
interface GPart { headers?: { name: string; value: string }[] }

/** The person's own combined mailboxes and calendars (headers; a sent mail's text only when asked). */
export function defaultSources(app: AppContext): TieSources {
  return {
    async mail(since, signal) {
      const accts = app.mailAccounts as (Accts & Partial<Pick<Accts, 'combined' | 'googleOf'>>) | undefined;
      if (!accts) return { heads: [], text: async () => '' };
      const boxes = typeof accts.combined === 'function' ? accts.combined() : accts.list().filter((a) => !a.problem);
      const heads: MailHead[] = [];
      const readers = new Map<string, (id: string) => Promise<string>>();
      for (const a of boxes) {
        try {
          if (a.kind === 'google') {
            const g = accts.googleOf?.(a.id);
            if (!g) continue;
            const { messageText } = await import('./google.ts');
            const after = Math.floor(since.getTime() / 1000);
            for (const [q, sent] of [[`in:sent after:${after}`, true], [`in:inbox category:primary after:${after}`, false]] as const) {
              const list = (await g.api(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: '100' })}`, { signal })) as { messages?: { id: string }[] };
              for (const m of list.messages ?? []) {
                const x = (await g.api(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence`, { signal })) as { id: string; threadId?: string; internalDate?: string; payload?: GPart };
                const h = (n: string) => x.payload?.headers?.find((y) => y.name.toLowerCase() === n.toLowerCase())?.value ?? '';
                heads.push({ id: `${a.id}:${x.id}`, threadId: x.threadId, account: a.id, from: h('From'), to: h('To'), cc: h('Cc'), date: x.internalDate ? new Date(Number(x.internalDate)).toISOString() : h('Date'), subject: h('Subject').slice(0, 120), sent, bulk: Boolean(h('List-Unsubscribe')) || /bulk|list|junk/i.test(h('Precedence')) });
              }
            }
            readers.set(a.id, async (id) => messageText(((await g.api(`${GMAIL}/messages/${id}?format=full`, { signal })) as { payload: Parameters<typeof messageText>[0] }).payload));
            continue;
          }
          const prov = accts.provider(a.id);
          const terms = (folder: string): SearchTerms => ({ from: [], to: [], subject: [], words: [], notFrom: [], notWords: [], folder, after: since.getTime() });
          for (const [folder, sent] of [['sent', true], ['inbox', false]] as const) {
            const { ids } = await prov.searchIds(terms(folder), 100, signal);
            if (!ids.length) continue;
            for (const m of await prov.list(ids, signal)) {
              const bulk = Boolean(m.headers['list-unsubscribe']) || /bulk|list|junk/i.test(m.headers.precedence ?? '') || /auto-/i.test(m.headers['auto-submitted'] ?? '') || /\b(no-?reply|donotreply|notifications?|mailer-daemon|newsletter)@/i.test(m.from);
              heads.push({ id: `${a.id}:${m.id}`, threadId: m.threadId, account: a.id, from: m.from, to: m.to, cc: m.cc, date: m.date, subject: m.subject.slice(0, 120), sent: sent || addressOf(m.from) === a.address.toLowerCase(), bulk });
            }
          }
          readers.set(a.id, async (id) => {
            const m = await prov.get(id, signal);
            return m.text ?? m.snippet;
          });
        } catch (err) {
          console.warn(`people ties: ${a.address}: ${(err as Error).message.slice(0, 160)}`);
        }
      }
      return { heads, text: async (h) => readers.get(h.account)?.(h.id.slice(h.account.length + 1)) ?? '' };
    },
    async events(from, to, signal) {
      const sources = calendarSources(app);
      if (!sources.length) return [];
      return (await allEvents(sources, from, to, 250, signal)).events.map((e) => ({ start: e.start, title: e.title, attendees: e.attendees }));
    },
  };
}

// ------------------------------------------------------------------------------------ tools

export function createPeopleTiesTools(app: () => AppContext): Tool[] {
  const isPrivate = (id?: string) => Boolean(id && app().store.getConversation(id)?.private);
  const nameOfId = (id: number) => app().people?.get(id)?.name ?? `#${id}`;
  return [
    {
      spec: {
        name: 'people_due',
        description: "Who in the owner's life needs attention now: people waiting for the owner's reply, promises the owner made (due or overdue, or found and still to confirm), birthdays and anniversaries this week, and keep-in-touch people not contacted for a while. Most urgent first. Built from mail headers, calendars and chat rooms; no message text.",
        parameters: { type: 'object', properties: { person: { type: 'string', description: 'Only this person (a name on a card).' } } },
      },
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: () => Boolean(app().peopleTies && !app().offRecord),
      summarize: (a) => `Who needs you${a.person ? `: ${String(a.person).slice(0, 40)}` : ''}`,
      async run(args, ctx) {
        const ties = app().peopleTies;
        if (!ties) throw new ToolError('Keeping in touch is not available here.');
        const who = typeof args.person === 'string' && args.person.trim() ? app().people?.find(args.person.trim()).found[0] : undefined;
        if (typeof args.person === 'string' && args.person.trim() && !who) return `No people card for "${args.person}".`;
        const list = ties.attention({ private: isPrivate(ctx.conversationId), ...(who ? { personId: who.id } : {}) });
        if (!list.length) return who ? `Nothing needs the owner about ${who.name} right now.` : 'Nobody needs the owner right now.';
        return list.slice(0, 15).map((n) => `- ${nudgeLine(n)}${n.kind === 'promise-check' ? ' (found in their own message; ask them to confirm it on the People page)' : ''}`).join('\n');
      },
    },
    {
      spec: {
        name: 'promise_list',
        description: "The promises the owner made to people (\"I'll send it Friday\"): open ones with due days, and ones found in the owner's sent mail or chats that still wait for the owner to confirm.",
        parameters: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'open', 'proposed', 'done', 'all'] }, person: { type: 'string' } } },
      },
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: () => Boolean(app().peopleTies && !app().offRecord),
      summarize: () => 'Looking at your promises',
      async run(args, ctx) {
        const ties = app().peopleTies;
        if (!ties) throw new ToolError('Keeping in touch is not available here.');
        const st = ['active', 'open', 'proposed', 'done', 'all'].includes(String(args.status)) ? (String(args.status) as 'active') : 'active';
        const who = typeof args.person === 'string' && args.person.trim() ? app().people?.find(args.person.trim()).found[0] : undefined;
        const priv = isPrivate(ctx.conversationId);
        const shown = ties.promises({ status: st, ...(who ? { personId: who.id } : {}) }).filter((p) => priv || !app().people?.get(p.personId)?.private);
        if (!shown.length) return 'No promises like that.';
        return shown.slice(0, 30).map((p) => `- To ${nameOfId(p.personId)}: ${p.text}${p.due ? ` (due ${p.due})` : ''} [${p.status === 'proposed' ? 'to confirm' : p.status}]`).join('\n');
      },
    },
  ];
}
