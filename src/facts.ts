// N6 (docs/WHAT_SARA_KNOWS.md): "What Sara knows", the person's world in one place. Built from two
// sources, never copied twice:
// - her memory (facts and dates she learned in chats, or read in a document while learning it), read
//   through an adapter: editing, deleting or "not true" here changes the memory itself;
// - facts found in the person's Library documents by rules (no model): renewal, expiry and due dates,
//   policy/account numbers (last 4 only), deductibles and premiums, names on a lease or a policy. Each
//   keeps the exact line it came from (numbers masked) and its page.
// Dates found in documents become suggestion cards ("From your documents"); Accept adds a planner
// reminder N days before (30 for renewals and expiry, 3 for due dates). Nothing is added by itself.
// Full card numbers and SSNs are never kept; health facts are only what the person said or what a
// health document states (never inferred) and are marked private. Each space (household member) has
// its own tables in its own store.db. My details (src/my-details.ts) stays the typed-in form data;
// facts can propose adding to it, never write it.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { verifyQuotes } from './biz/contracts.ts';
import { type LibraryDoc, type LibraryStore } from './library/store.ts';
import { forgetMemory, localDate } from './memory-worker.ts';
import type { Memory } from './memory.ts';
import { queryWords, stem } from './memory-rank.ts';
import { looksLikeCard, looksLikeSsn, luhn } from './my-details.ts';
import { zonedToUtc } from './planner.ts';
import { embedTarget } from './embeddings.ts';
import { AMOUNT_LABELS_IN, DATE_LABELS_IN, dateReIn, detectDocLang, docTypeIn, isoDateIn, moneyAt, moneyIn, NAME_LABELS_IN, NUMBER_LABELS_IN } from './facts-lang.ts';

export const FACT_GROUPS = ['people', 'home', 'vehicles', 'health', 'work', 'money', 'dates', 'other'] as const;
export type FactGroup = (typeof FACT_GROUPS)[number];
export const DATE_KINDS = ['renewal', 'expiry', 'due', 'lease_end', 'warranty_end', 'passport_expiry', 'license_expiry'] as const;
export type DateKind = (typeof DATE_KINDS)[number];
/** Days before the date a reminder lands by default. */
export const DAYS_BEFORE: Record<DateKind, number> = { renewal: 30, expiry: 30, due: 3, lease_end: 30, warranty_end: 30, passport_expiry: 30, license_expiry: 30 };

export interface FactSource {
  kind: 'chat' | 'document' | 'you';
  conversationId?: string | null;
  messageId?: number | null;
  title?: string | null;
  docId?: number | null;
  name?: string | null;
  page?: number | null;
}

export interface WorldFact {
  /** 'm12' (a memory) or 'd7' (found in a document). */
  id: string;
  group: FactGroup;
  /** Label key for document facts ('Policy number'); null for memory facts. */
  label: string | null;
  /** The value (masked numbers, a money amount, a name, an ISO date). */
  value: string | null;
  text: string;
  source: FactSource;
  /** The exact words it came from (numbers masked). */
  quote: string | null;
  learnedOn: string;
  /** said = the person said it; read = read in a document. */
  confidence: 'said' | 'read';
  private: boolean;
  date: string | null;
  dateKind: DateKind | null;
  /** Can be added to My details (the person types the full value there). */
  detail: 'insurance' | 'vehicle' | null;
  edited: boolean;
}

export interface DateSuggestion {
  id: number;
  docId: number;
  name: string;
  page: number | null;
  label: string;
  date: string;
  dateKind: DateKind;
  daysBefore: number;
  quote: string;
  status: 'pending' | 'accepted' | 'dismissed';
  reminderId: number | null;
}

// ------------------------------------------------------------------ masking

/** "••••1234": only the last 4 letters/digits of a number are kept. */
export function maskNumber(v: string): string {
  const al = v.replace(/[^A-Za-z0-9]/g, '');
  return `\u2022\u2022\u2022\u2022${al.slice(-4)}`;
}

const DATE_SHAPE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})$/;

/**
 * Masks every long number in a text: card numbers and SSNs never stay whole, nor do account, policy,
 * passport or serial numbers (6+ digits): only their last 4. Dates and money amounts stay.
 */
export function maskSensitive(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-(\d{4})\b/g, '\u2022\u2022\u2022-\u2022\u2022-$1')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => maskNumber(m))
    .replace(/(?<![$€£.,])\b[A-Za-z0-9][A-Za-z0-9-]{4,}[A-Za-z0-9]\b/g, (m) => ((m.match(/\d/g) ?? []).length < 6 || DATE_SHAPE.test(m) ? m : maskNumber(m)));
}

/** For memory facts from chats: a card number or SSN never stays whole (the rest is the person's words). */
export function maskCardsAndSsn(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-(\d{4})\b/g, '\u2022\u2022\u2022-\u2022\u2022-$1')
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? maskNumber(m) : m));
}

// ------------------------------------------------------------------ dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
export const DATE_RE = new RegExp(`(?:${MON}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\.?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4})`, 'gi');

/** A date as written in a document → YYYY-MM-DD (US order for 03/04/2027), or null. */
export function isoDate(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\bof\s+/, '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) [y, m, d] = [Number(r[3]), Number(r[1]), Number(r[2])];
  else if ((r = /^([a-z]+) (\d{1,2}) (\d{4})$/.exec(t))) [y, m, d] = [Number(r[3]), MONTHS.indexOf(r[1].slice(0, 3)) + 1, Number(r[2])];
  else if ((r = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(t))) [y, m, d] = [Number(r[3]), MONTHS.indexOf(r[2].slice(0, 3)) + 1, Number(r[1])];
  else return null;
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ extraction (rules, no model)

type DocType = 'lease' | 'auto' | 'health' | 'home-insurance' | 'insurance' | 'warranty' | 'passport' | 'license' | 'other';

export function docTypeOf(name: string, text: string): DocType {
  const s = `${name}\n${text.slice(0, 6000)}`;
  if (/\bpassport\b/i.test(s)) return 'passport';
  if (/\bdriver'?s?\s+licen[cs]e\b/i.test(s) && !/\binsurance\b/i.test(s)) return 'license';
  if (/\b(?:health|medical|dental|vision)\s+(?:insurance|plan|coverage)\b|\bmember id\b/i.test(s)) return 'health';
  if (/\b(?:auto|car|vehicle|motor)\s+(?:insurance|policy)\b|\bVIN\b/i.test(s) && /\b(?:insur|policy)/i.test(s)) return 'auto';
  if (/\b(?:homeowners?|renters?|dwelling|home)\s+(?:insurance|policy)\b/i.test(s)) return 'home-insurance';
  if (/\blease\b|\btenant\b|\blandlord\b/i.test(s)) return 'lease';
  if (/\bwarranty\b|\bguarantee\b/i.test(s)) return 'warranty';
  if (/\binsur(?:ance|ed|er)\b|\bpolicy (?:number|period)\b|\bpremium\b/i.test(s)) return 'insurance';
  return 'other';
}

const NUMBER_LABELS: [RegExp, string][] = [
  [/\bpolicy\s*(?:number|no\.?|num\.?|#)/i, 'Policy number'],
  [/\b(?:account|acct\.?)\s*(?:number|no\.?|num\.?|#)/i, 'Account number'],
  [/\bmember\s*(?:id|number|no\.?|#)/i, 'Member ID'],
  [/\bgroup\s*(?:number|no\.?|#)/i, 'Group number'],
  [/\bpassport\s*(?:number|no\.?|#)/i, 'Passport number'],
  [/\b(?:driver'?s?\s+)?licen[cs]e\s*(?:number|no\.?|#)/i, 'License number'],
  [/\bloan\s*(?:number|no\.?|#)/i, 'Loan number'],
  [/\bcontract\s*(?:number|no\.?|#)/i, 'Contract number'],
  [/\bserial\s*(?:number|no\.?|#)/i, 'Serial number'],
  [/\bVIN\b:?/, 'VIN'],
];

const AMOUNT_LABELS: [RegExp, string][] = [
  [/\b(?:collision|comprehensive|annual|policy|medical|plan)?\s*deductible\b/i, 'Deductible'],
  [/\bout[- ]of[- ]pocket (?:maximum|max)\b/i, 'Out-of-pocket maximum'],
  [/\b(?:six[- ]month|monthly|annual|yearly|total)?\s*premium\b/i, 'Premium'],
  [/\bco-?pay\b/i, 'Copay'],
  [/\bsecurity deposit\b/i, 'Security deposit'],
  [/\b(?:monthly )?rent\b/i, 'Rent'],
  [/\bcoverage limit\b/i, 'Coverage limit'],
];

const NAME_LABELS: [RegExp, string, FactGroup][] = [
  [/\b(?:named insured|policyholder|policy holder|insured)\s*:/i, 'Insured', 'people'],
  [/\b(?:tenants?|lessee)\s*:/i, 'Tenant', 'people'],
  [/\b(?:landlord|lessor|property manager)\s*:/i, 'Landlord', 'home'],
  [/\b(?:agent|insurer|insurance company|carrier)\s*:/i, 'Insurer or agent', 'money'],
];

const DATE_LABELS: [RegExp, DateKind | 'by-type'][] = [
  [/\b(?:renewal date|renews on|renewal|will renew)\b/i, 'renewal'],
  [/\b(?:payment due|due date|due on|is due|due by|pay by|amount due)\b/i, 'due'],
  [/\b(?:date of expiry|expiry date|expiration date|expiration|expires on|expires|expiry|valid until|valid through|valid thru|good through)\b/i, 'by-type'],
  [/\b(?:lease (?:ends|end date|terminates|expires)|term (?:of this lease )?(?:ends|will end)|and ends on|ends on|end date|ending on)\b/i, 'by-type'],
  [/\bwarranty (?:ends|period ends|expires|is valid until)\b/i, 'warranty_end'],
  [/\bpolicy (?:period|term)\b/i, 'renewal'],
];

const DATE_LABEL_TEXT: Record<DateKind, string> = {
  renewal: 'Renewal date',
  expiry: 'Expires',
  due: 'Due date',
  lease_end: 'Lease ends',
  warranty_end: 'Warranty ends',
  passport_expiry: 'Passport expires',
  license_expiry: 'License expires',
};

function byType(kind: DateKind | 'by-type', type: DocType): DateKind {
  if (kind !== 'by-type') return kind === 'expiry' && type === 'warranty' ? 'warranty_end' : kind;
  if (type === 'lease') return 'lease_end';
  if (type === 'warranty') return 'warranty_end';
  if (type === 'passport') return 'passport_expiry';
  if (type === 'license') return 'license_expiry';
  if (type === 'auto' || type === 'insurance' || type === 'home-insurance' || type === 'health') return 'renewal';
  return 'expiry';
}

function groupFor(type: DocType): FactGroup {
  return type === 'lease' || type === 'home-insurance' || type === 'warranty' ? 'home' : type === 'auto' || type === 'license' ? 'vehicles' : type === 'health' ? 'health' : type === 'passport' ? 'people' : 'money';
}

export interface Extracted {
  group: FactGroup;
  label: string;
  value: string;
  quote: string;
  page: number | null;
  place: string;
  date: string | null;
  dateKind: DateKind | null;
  private: boolean;
  detail: 'insurance' | 'vehicle' | null;
}

const pageOfPlace = (place: string): number | null => {
  const m = /^page\s+(\d+)/i.exec(place);
  return m ? Number(m[1]) : null;
};

/** The lines of a passage (a line is split into sentences when it is long). */
function linesOf(text: string): string[] {
  const out: string[] = [];
  // A line that wrapped mid-sentence (a PDF's layout) joins the next one when that starts in lower case.
  const joined: string[] = [];
  for (const raw of text.split(/\n+/)) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    const prev = joined[joined.length - 1];
    if (prev && !/[.:;!?]$/.test(prev) && /^[a-z(]/.test(l)) joined[joined.length - 1] = `${prev} ${l}`;
    else joined.push(l);
  }
  for (const line of joined) {
    if (!line) continue;
    for (const s of line.length > 160 ? line.split(/(?<=[.;!?])\s+(?=[A-Z(])/) : [line]) if (s.trim().length > 3) out.push(s.trim());
  }
  return out;
}

/**
 * Facts found in one document's passages by rules (no model). Each comes with the exact line it was
 * read from (long numbers masked) and its page. Card numbers and SSNs are never extracted.
 */
export function extractFacts(doc: { name: string }, passages: { text: string; page: number | null; place: string }[]): Extracted[] {
  const all = passages.map((p) => p.text).join('\n');
  // R9: the document's language (stopwords); other languages add their own labels, day-month dates
  // and money as written (src/facts-lang.ts). English reads exactly as before.
  const lang = detectDocLang(all);
  const other = lang !== 'en' ? lang : null;
  let type = docTypeOf(doc.name, all);
  if (type === 'other' && other) type = docTypeIn(`${doc.name}\n${all}`);
  const dateLabels = other ? [...DATE_LABELS_IN[other], ...DATE_LABELS] : DATE_LABELS;
  const numberLabels = other ? [...NUMBER_LABELS_IN, ...NUMBER_LABELS] : NUMBER_LABELS;
  const amountLabels = other ? [...AMOUNT_LABELS_IN[other], ...AMOUNT_LABELS] : AMOUNT_LABELS;
  const toIso = (d: string) => (other ? isoDateIn(d, other) : isoDate(d));
  const base = groupFor(type);
  const priv = type === 'health' || type === 'passport';
  const out: Extracted[] = [];
  const seen = new Set<string>();
  const push = (e: Omit<Extracted, 'private' | 'detail'> & { detail?: Extracted['detail'] }) => {
    const key = `${e.label}|${e.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...e, private: priv || e.group === 'health', detail: e.detail ?? null });
  };
  for (const p of passages) {
    const page = p.page ?? pageOfPlace(p.place);
    for (const line of linesOf(p.text)) {
      const quote = maskSensitive(line).slice(0, 240);
      // Dates: a label, then the first date after it (a period "A to B": the end).
      for (const [re, k] of dateLabels) {
        const lm = re.exec(line);
        if (!lm) continue;
        const after = line.slice(lm.index);
        const dates = [...after.matchAll(other ? dateReIn(other) : DATE_RE)].map((m) => ({ s: m[0], at: m.index ?? 0 }));
        if (!dates.length) continue;
        const pick = /\bpolicy (?:period|term)\b/i.test(lm[0]) || /\bbegins?\b.*\bends?\b/i.test(after) ? dates[dates.length - 1] : dates[0];
        if (pick.at > 90) continue;
        const iso = toIso(pick.s);
        if (!iso) continue;
        const kind = byType(k, type);
        push({ group: 'dates', label: DATE_LABEL_TEXT[kind], value: iso, quote, page, place: p.place, date: iso, dateKind: kind });
        break;
      }
      // Numbers: last 4 only, never a card number or an SSN.
      for (const [re, label] of numberLabels) {
        const lm = re.exec(line);
        if (!lm) continue;
        const rest = line.slice(lm.index + lm[0].length).replace(/^\s*[:#.]?\s*/, '');
        const nm = /^([A-Z0-9][A-Z0-9-]{3,24}[A-Z0-9])\b/i.exec(rest);
        if (!nm) continue;
        const v = nm[1];
        if ((v.match(/\d/g) ?? []).length < 4) continue;
        if (looksLikeSsn(v, true)) continue;
        const group: FactGroup = label === 'VIN' ? 'vehicles' : label === 'Passport number' ? 'people' : label === 'Member ID' || label === 'Group number' ? (type === 'health' ? 'health' : 'money') : base === 'dates' ? 'money' : label === 'Policy number' && (type === 'auto' || type === 'home-insurance' || type === 'insurance') ? 'money' : base;
        push({ group, label, value: maskNumber(v), quote, page, place: p.place, date: null, dateKind: null, detail: label === 'Policy number' ? 'insurance' : label === 'VIN' ? 'vehicle' : null });
      }
      // Money amounts (deductible, premium, rent, deposit).
      for (const [re, label] of amountLabels) {
        const lm = re.exec(line);
        if (!lm) continue;
        if (other) {
          // As written in the document (1.234,56 €), next to its label.
          const at = moneyAt(line.slice(lm.index));
          const money = at >= 0 && at <= 60 ? moneyIn(line.slice(lm.index)) : null;
          if (!money) continue;
          push({ group: type === 'health' ? 'health' : 'money', label, value: money, quote, page, place: p.place, date: null, dateKind: null });
          break;
        }
        const am = /[$€£]\s?\d[\d,]*(?:\.\d{2})?/.exec(line.slice(lm.index));
        if (!am || (am.index ?? 0) > 60) continue;
        const what = lm[0].trim().replace(/\s+/g, ' ');
        const value = `${am[0].replace(/\s/g, '')}${what.toLowerCase() !== label.toLowerCase() ? ` (${what.toLowerCase()})` : ''}`;
        push({ group: type === 'health' ? 'health' : 'money', label, value, quote, page, place: p.place, date: null, dateKind: null });
        break;
      }
      // Names on a lease or a policy.
      for (const [re, label, group] of NAME_LABELS) {
        const lm = re.exec(line);
        if (!lm) continue;
        const nm = /^\s*([A-Z][\w'.&-]*(?:\s+(?:[A-Z][\w'.&-]*|&|and|of)){0,5})/.exec(line.slice(lm.index + lm[0].length));
        if (!nm) continue;
        const name = nm[1].replace(/\s+(?:and|&|of)$/, '').trim();
        if (name.length < 3 || /\d{3}/.test(name)) continue;
        push({ group: type === 'health' ? 'health' : group, label, value: name, quote, page, place: p.place, date: null, dateKind: null });
      }
      if (other) {
        for (const [re, label, group] of NAME_LABELS_IN) {
          const lm = re.exec(line);
          if (!lm) continue;
          const nm = /^\s*(\p{Lu}[\p{L}'.&-]*(?:\s+(?:\p{Lu}[\p{L}'.&-]*|&|y|et|und|e|de|da|di)){0,5})/u.exec(line.slice(lm.index + lm[0].length));
          if (!nm) continue;
          const name = nm[1].replace(/\s+(?:&|y|et|und|e|de|da|di)$/, '').trim();
          if (name.length < 3 || /\d{3}/.test(name)) continue;
          push({ group: type === 'health' ? 'health' : group, label, value: name, quote, page, place: p.place, date: null, dateKind: null });
        }
      }
    }
  }
  return out.filter((e) => !looksLikeCard(e.value) && !looksLikeSsn(e.value, true));
}

// ------------------------------------------------------------------ grouping memory facts

const HEALTH = /\b(?:doctor|dr\.|dentist|allerg\w*|medication|medicine|prescri\w*|diagnos\w*|therap\w*|surgery|blood (?:type|pressure)|diabet\w*|asthma|pregnan\w*|health|hospital|clinic|symptom\w*|physio\w*|vaccin\w*|insulin|migraine|cholesterol)\b/i;
const VEHICLES = /\b(?:car|cars|truck|van|suv|vehicle|motorcycle|motorbike|scooter|honda|toyota|ford|tesla|subaru|bmw|audi|kia|hyundai|chevy|chevrolet|nissan|mazda|volkswagen|vw|jeep|license plate|vin|oil change|tires?)\b/i;
const MONEY = /\b(?:bank|account|policy|insurance|insurer|mortgage|loan|credit|salary|budget|deductible|premium|tax(?:es)?|401k|ira|savings|pension|invest\w*|stocks?|bills?|subscription)\b/i;
const HOME = /\b(?:house|home|apartment|flat|condo|lease|rent|landlord|address|kitchen|garden|yard|roof|furnace|hvac|neighbou?rs?|plumber|dishwasher|fridge|washer|dryer|moved? to)\b/i;
const WORK = /\b(?:work|works|job|boss|manager|office|company|employer|client|clients|colleague|coworker|co-worker|career|promotion|shift|team lead|startup|business)\b/i;
const PEOPLE = /\b(?:wife|husband|partner|spouse|son|daughter|mom|mother|dad|father|brother|sister|kids?|child(?:ren)?|friend|family|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|baby|niece|nephew|girlfriend|boyfriend|fianc[eé]e?|dog|cat|pet|puppy|kitten)\b/i;

export function groupOfText(text: string, kind: Memory['kind']): FactGroup {
  if (HEALTH.test(text)) return 'health';
  if (kind === 'date') return 'dates';
  if (VEHICLES.test(text)) return 'vehicles';
  if (MONEY.test(text)) return 'money';
  if (HOME.test(text)) return 'home';
  if (WORK.test(text)) return 'work';
  if (PEOPLE.test(text)) return 'people';
  return 'other';
}

const norm = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ the store

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_doc_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  page INTEGER,
  place TEXT,
  grp TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  quote TEXT NOT NULL,
  on_date TEXT,
  date_kind TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  edited TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  suggest TEXT,
  days_before INTEGER,
  reminder_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS world_doc_facts_doc ON world_doc_facts(doc_id);
CREATE TABLE IF NOT EXISTS world_doc_scans (doc_id INTEGER PRIMARY KEY, read_at TEXT, facts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS world_rejected (norm TEXT PRIMARY KEY, at TEXT NOT NULL);
`;

type Row = Record<string, string | number | null>;

export class FactsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class WorldFacts {
  readonly db: DatabaseSync;
  #app: AppContext;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.db = db;
    db.exec(SCHEMA);
  }

  #now(): Date {
    return this.#app.now?.() ?? new Date();
  }
  #today(): string {
    return localDate(this.#now(), this.#app.settings.get().timeZone);
  }
  #lib(): LibraryStore | undefined {
    return this.#app.library;
  }

  /** Reads Library documents not read for facts yet (or read again since). Cheap: new documents only. */
  scanDocs(): number {
    const lib = this.#lib();
    if (!lib) return 0;
    let added = 0;
    const docs = lib.list().filter((d) => d.keep && d.status === 'ready' && !d.readOnly);
    const scans = new Map((this.db.prepare('SELECT doc_id, read_at FROM world_doc_scans').all() as Row[]).map((r) => [Number(r.doc_id), r.read_at as string | null]));
    for (const d of docs) {
      if (scans.has(d.id) && scans.get(d.id) === (d.readAt ?? null)) continue;
      added += this.#scanDoc(lib, d);
    }
    // Documents deleted from the Library take their facts with them.
    const alive = new Set(docs.map((d) => d.id));
    for (const id of scans.keys()) {
      if (alive.has(id) || lib.get(id)) continue;
      this.db.prepare('DELETE FROM world_doc_facts WHERE doc_id = ?').run(id);
      this.db.prepare('DELETE FROM world_doc_scans WHERE doc_id = ?').run(id);
    }
    return added;
  }

  #scanDoc(lib: LibraryStore, d: LibraryDoc): number {
    const passages = lib.passages(d.id, { limit: 4000 }).map((p) => ({ text: p.text, page: p.page, place: p.place }));
    const found = extractFacts(d, passages);
    const rejected = new Set((this.db.prepare('SELECT norm FROM world_rejected').all() as Row[]).map((r) => String(r.norm)));
    const today = this.#today();
    // Facts the person deleted or marked not true stay that way when the document is read again.
    const gone = new Set((this.db.prepare("SELECT label, value FROM world_doc_facts WHERE doc_id = ? AND status <> 'active'").all(d.id) as Row[]).map((r) => `${r.label}|${r.value}`));
    const kept = new Map((this.db.prepare("SELECT id, label, value FROM world_doc_facts WHERE doc_id = ? AND status = 'active'").all(d.id) as Row[]).map((r) => [`${r.label}|${r.value}`, Number(r.id)]));
    const ins = this.db.prepare('INSERT INTO world_doc_facts (doc_id, page, place, grp, label, value, quote, on_date, date_kind, private, detail, suggest, days_before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let n = 0;
    for (const e of found) {
      const key = `${e.label}|${e.value}`;
      if (gone.has(key) || kept.has(key) || rejected.has(norm(`${e.label}: ${e.value}`))) continue;
      const suggest = e.date && e.dateKind && e.date > today ? 'pending' : null;
      ins.run(d.id, e.page, e.place, e.group, e.label, e.value, e.quote, e.date, e.dateKind, e.private ? 1 : 0, e.detail, suggest, e.dateKind ? DAYS_BEFORE[e.dateKind] : null, this.#now().toISOString());
      n++;
    }
    this.db.prepare('INSERT INTO world_doc_scans (doc_id, read_at, facts) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET read_at = excluded.read_at, facts = excluded.facts').run(d.id, d.readAt ?? null, n + kept.size);
    return n;
  }

  #docFact(r: Row, names: Map<number, LibraryDoc | undefined>): WorldFact | undefined {
    const docId = Number(r.doc_id);
    if (!names.has(docId)) names.set(docId, this.#lib()?.get(docId));
    const doc = names.get(docId);
    if (!doc) return undefined;
    const label = String(r.label);
    const value = String(r.value);
    return {
      id: `d${r.id}`,
      group: (FACT_GROUPS as readonly string[]).includes(String(r.grp)) ? (r.grp as FactGroup) : 'other',
      label,
      value,
      text: (r.edited as string | null) ?? `${label}: ${value}`,
      source: { kind: 'document', docId, name: doc.title && doc.title.length < 80 ? doc.title : doc.name, page: r.page === null ? null : Number(r.page) },
      quote: String(r.quote),
      learnedOn: String(r.created_at).slice(0, 10),
      confidence: 'read',
      private: Boolean(r.private),
      date: (r.on_date as string | null) ?? null,
      dateKind: (r.date_kind as DateKind | null) ?? null,
      detail: r.detail === 'insurance' || r.detail === 'vehicle' ? r.detail : null,
      edited: r.edited !== null,
    };
  }

  #memFact(m: Memory, privateConv: (id: string) => boolean, titles: (id: string) => string | null): WorldFact {
    const group = groupOfText(m.content, m.kind);
    const said = !m.sourceDocId;
    const doc = m.sourceDocId ? this.#lib()?.get(m.sourceDocId) : undefined;
    const page = m.sourceDocId && doc ? (this.#lib()?.pageOf(m.sourceDocId, m.evidence) ?? null) : null;
    return {
      id: `m${m.id}`,
      group,
      label: null,
      value: null,
      text: maskCardsAndSsn(m.content),
      source: m.sourceDocId ? { kind: 'document', docId: m.sourceDocId, name: doc ? (doc.title && doc.title.length < 80 ? doc.title : doc.name) : null, page } : m.conversationId ? { kind: 'chat', conversationId: m.conversationId, messageId: m.sourceMessageId, title: titles(m.conversationId) } : { kind: 'you' },
      quote: m.evidence && m.evidence !== 'You added this.' ? maskCardsAndSsn(m.evidence).slice(0, 240) : null,
      learnedOn: m.happenedOn,
      confidence: said ? 'said' : 'read',
      private: group === 'health' || (m.conversationId ? privateConv(m.conversationId) : false),
      date: m.kind === 'date' ? m.onDate : null,
      dateKind: null,
      detail: null,
      edited: m.edited,
    };
  }

  /** Every fact, grouped order (people, home, vehicles, health, work, money, dates, other), newest first in each. */
  list(o: { includePrivate?: boolean } = {}): WorldFact[] {
    this.scanDocs();
    const out: WorldFact[] = [];
    const mem = this.#app.memory;
    if (mem) {
      const convs = new Map<string, { private: boolean; title: string | null }>();
      const conv = (id: string) => {
        if (!convs.has(id)) {
          const c = this.#app.store.getConversation(id);
          convs.set(id, { private: Boolean(c?.private), title: c?.title ?? null });
        }
        return convs.get(id)!;
      };
      for (const m of mem.listAll()) {
        if ((m.kind !== 'fact' && m.kind !== 'date') || m.supersededBy !== null || m.archived) continue;
        if (m.space === 'work') continue;
        out.push(this.#memFact(m, (id) => conv(id).private, (id) => conv(id).title));
      }
    }
    const names = new Map<number, LibraryDoc | undefined>();
    for (const r of this.db.prepare("SELECT * FROM world_doc_facts WHERE status = 'active' ORDER BY id DESC").all() as Row[]) {
      const f = this.#docFact(r, names);
      if (f) out.push(f);
    }
    const rank = (g: FactGroup) => FACT_GROUPS.indexOf(g);
    return out.filter((f) => o.includePrivate !== false || !f.private).sort((a, b) => rank(a.group) - rank(b.group) || b.learnedOn.localeCompare(a.learnedOn));
  }

  get(id: string): WorldFact | undefined {
    return this.list().find((f) => f.id === id);
  }

  #parse(id: string): { kind: 'm' | 'd'; n: number } {
    const m = /^([md])(\d+)$/.exec(String(id));
    if (!m) throw new FactsError(404, 'Fact not found');
    return { kind: m[1] as 'm' | 'd', n: Number(m[2]) };
  }

  /** Edits a fact's words: a memory fact edits the memory itself. */
  edit(id: string, text: string): WorldFact {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 500) throw new FactsError(400, 'A fact is 1 to 500 characters.');
    if (looksLikeCard(t) || looksLikeSsn(t)) throw new FactsError(400, 'Card numbers and Social Security numbers are never kept. Keep only the last 4 digits.');
    const { kind, n } = this.#parse(id);
    if (kind === 'm') {
      const mem = this.#app.memory;
      if (!mem?.get(n)) throw new FactsError(404, 'Fact not found');
      mem.update(n, t);
    } else {
      if (!Number(this.db.prepare("UPDATE world_doc_facts SET edited = ? WHERE id = ? AND status = 'active'").run(t, n).changes)) throw new FactsError(404, 'Fact not found');
    }
    return this.get(id)!;
  }

  /** Deletes a fact (a memory fact: the memory and its meaning vector go too). */
  remove(id: string): void {
    const { kind, n } = this.#parse(id);
    if (kind === 'm') {
      const mem = this.#app.memory;
      if (!mem?.delete(n)) throw new FactsError(404, 'Fact not found');
      this.#app.vectors?.forget(n);
    } else if (!Number(this.db.prepare("UPDATE world_doc_facts SET status = 'deleted', suggest = CASE WHEN suggest = 'pending' THEN 'dismissed' ELSE suggest END WHERE id = ? AND status = 'active'").run(n).changes)) throw new FactsError(404, 'Fact not found');
  }

  /**
   * "Not true": the fact is forgotten (a memory: forgotten like Forget on the Memory page, so its
   * source message is hidden from her too) and never learned again from the same words.
   */
  notTrue(id: string): void {
    const f = this.get(id);
    if (!f) throw new FactsError(404, 'Fact not found');
    const { kind, n } = this.#parse(id);
    this.db.prepare('INSERT INTO world_rejected (norm, at) VALUES (?, ?) ON CONFLICT(norm) DO NOTHING').run(norm(f.label ? `${f.label}: ${f.value}` : f.text), this.#now().toISOString());
    if (kind === 'm') {
      const mem = this.#app.memory!;
      const r = forgetMemory(this.#app, mem, n);
      for (const x of r?.removed ?? [n]) this.#app.vectors?.forget(x);
      if (mem.get(n)) mem.delete(n);
    } else this.db.prepare("UPDATE world_doc_facts SET status = 'not_true', suggest = CASE WHEN suggest = 'pending' THEN 'dismissed' ELSE suggest END WHERE id = ?").run(n);
  }

  /** True when a memory fact was marked "not true" (the memory worker skips it). */
  rejected(text: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM world_rejected WHERE norm = ?').get(norm(text)));
  }

  /** "Forget X": facts whose words match, forgotten (memory facts) or deleted (document facts). */
  forget(what: string): WorldFact[] {
    const words = queryWords(what).map(stem);
    if (!words.length) return [];
    const hits = this.list().filter((f) => {
      const have = new Set(queryWords(`${f.text} ${f.value ?? ''}`).map(stem));
      return words.every((w) => have.has(w));
    });
    for (const f of hits) {
      const { kind, n } = this.#parse(f.id);
      if (kind === 'm') {
        const r = forgetMemory(this.#app, this.#app.memory!, n);
        for (const x of r?.removed ?? [n]) this.#app.vectors?.forget(x);
        if (this.#app.memory!.get(n)) this.#app.memory!.delete(n);
      } else this.remove(f.id);
    }
    return hits;
  }

  // ---------------------------------------------------------------- dates → reminders

  suggestions(o: { status?: DateSuggestion['status'] | 'all'; limit?: number } = {}): DateSuggestion[] {
    this.scanDocs();
    const st = o.status ?? 'pending';
    const today = this.#today();
    const rows = this.db.prepare(`SELECT * FROM world_doc_facts WHERE status = 'active' AND suggest IS NOT NULL ${st === 'all' ? '' : 'AND suggest = ?'} ORDER BY on_date, id LIMIT ?`).all(...(st === 'all' ? [o.limit ?? 50] : [st, o.limit ?? 50])) as Row[];
    const out: DateSuggestion[] = [];
    for (const r of rows) {
      const doc = this.#lib()?.get(Number(r.doc_id));
      if (!doc) continue;
      if (st === 'pending' && String(r.on_date) <= today) continue;
      out.push({ id: Number(r.id), docId: doc.id, name: doc.title && doc.title.length < 80 ? doc.title : doc.name, page: r.page === null ? null : Number(r.page), label: String(r.label), date: String(r.on_date), dateKind: r.date_kind as DateKind, daysBefore: Number(r.days_before ?? 30), quote: String(r.quote), status: r.suggest as DateSuggestion['status'], reminderId: r.reminder_id === null ? null : Number(r.reminder_id) });
    }
    return out;
  }

  /** Accept: a planner reminder `daysBefore` days before the date at 9:00 (tomorrow 9:00 if that has passed). */
  accept(id: number, daysBefore?: number): { suggestion: DateSuggestion; reminder: { id: number; text: string; dueAt: string } } {
    const planner = this.#app.planner;
    if (!planner) throw new FactsError(404, 'Reminders are not available here.');
    const s = this.suggestions({ status: 'all', limit: 500 }).find((x) => x.id === id);
    if (!s) throw new FactsError(404, 'Suggestion not found');
    if (s.status === 'accepted' && s.reminderId) {
      const r = planner.reminder(s.reminderId);
      if (r) return { suggestion: s, reminder: { id: r.id, text: r.text, dueAt: r.dueAt } };
    }
    const days = Math.max(0, Math.min(365, Math.round(Number(daysBefore ?? s.daysBefore))));
    const tz = this.#app.settings.get().timeZone;
    const [y, m, d] = s.date.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d) - days * 86_400_000);
    let due = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 9, 0, tz);
    if (due.getTime() <= this.#now().getTime()) {
      const t = new Date(this.#now().getTime() + 86_400_000);
      const [ty, tm, td] = localDate(t, tz).split('-').map(Number);
      due = zonedToUtc(ty, tm, td, 9, 0, tz);
    }
    const when = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${s.date}T12:00:00Z`));
    const text = `${s.label}: ${when} (${s.name}${s.page ? `, page ${s.page}` : ''})`;
    const r = planner.addReminder({ text, dueAt: due.toISOString() });
    this.db.prepare("UPDATE world_doc_facts SET suggest = 'accepted', reminder_id = ?, days_before = ? WHERE id = ?").run(r.id, days, id);
    return { suggestion: { ...s, status: 'accepted', reminderId: r.id, daysBefore: days }, reminder: { id: r.id, text: r.text, dueAt: r.dueAt } };
  }

  dismiss(id: number): void {
    if (!Number(this.db.prepare("UPDATE world_doc_facts SET suggest = 'dismissed' WHERE id = ? AND suggest = 'pending'").run(id).changes)) throw new FactsError(404, 'Suggestion not found');
  }

  /** Lines for her prompt and the facts tool: "- Lease ends: 2027-05-31 (from Lease.pdf, page 1)". */
  lines(o: { includePrivate?: boolean; query?: string; limit?: number } = {}): string[] {
    let facts = this.list({ includePrivate: o.includePrivate });
    if (o.query) {
      const words = queryWords(o.query).map(stem);
      if (words.length) facts = facts.filter((f) => queryWords(`${f.text} ${f.group} ${f.source.name ?? ''}`).map(stem).some((w) => words.includes(w)));
    }
    return facts.slice(0, o.limit ?? 60).map((f) => `- [${f.group}] ${f.text}${f.private ? ' (private)' : ''} (${sourceText(f)})`);
  }
}

export function sourceText(f: WorldFact): string {
  const s = f.source;
  if (s.kind === 'document') return `read in "${s.name ?? 'a document'}"${s.page ? `, page ${s.page}, cite: [p. ${s.page}](/#view=library:${s.docId}:${s.page})` : ''}`;
  if (s.kind === 'chat') return `you said it${s.title ? ` in "${s.title}"` : ''} on ${f.learnedOn}`;
  return `you added it on ${f.learnedOn}`;
}

const stores = new WeakMap<DatabaseSync, WorldFacts>();
/** Each space's own facts (its own store.db). */
export function factsFor(app: AppContext): WorldFacts {
  let s = stores.get(app.store.db);
  if (!s) {
    s = new WorldFacts(app, app.store.db);
    stores.set(app.store.db, s);
  }
  return s;
}

// ------------------------------------------------------------------ ask your documents

export interface DocAnswer {
  found: boolean;
  quotes: { docId: number; name: string; page: number | null; place: string; quote: string; cite: string | null }[];
}

const DATE_Q = /^\s*(?:when|what date|which date|until when|how long)\b/i;
const MONEY_Q = /\b(?:how much|cost|price|deductible|premium|rent|deposit|copay|fee|amount)\b/i;

/**
 * "What's my deductible?": searches every Library document (words and meaning), picks the sentences
 * that answer, keeps only quotes found word for word in the document (the E6 contract check), with
 * the file and page. found: false means it is not in the documents: say so instead of guessing.
 */
export async function askDocuments(app: AppContext, question: string, o: { conversationId?: string; limit?: number } = {}): Promise<DocAnswer> {
  const lib = app.library;
  const q = String(question ?? '').trim();
  if (!lib || !q) return { found: false, quotes: [] };
  const qWords = queryWords(q).filter((w) => !/^(?:my|mine|document|documents|file|files|library|say|says)$/.test(w)).map(stem);
  if (!qWords.length) return { found: false, quotes: [] };
  const hits = await lib.find(q, { target: embedTarget(app), conversationId: o.conversationId, limit: 8, timeoutMs: 4000 }).catch(() => []);
  const wantDate = DATE_Q.test(q);
  const wantMoney = MONEY_Q.test(q);
  const cands: { score: number; hit: (typeof hits)[number]; sentence: string }[] = [];
  for (const h of hits) {
    for (const s of linesOf(h.passage.text)) {
      const have = new Set(queryWords(s).map(stem));
      const prefix = [...have];
      const matched = qWords.filter((w) => have.has(w) || prefix.some((x) => x.length >= 3 && (x.startsWith(w) || w.startsWith(x)))).length;
      if (!matched) continue;
      let score = matched / qWords.length;
      if (wantDate && new RegExp(DATE_RE.source, 'i').test(s)) score += 0.6;
      if (wantMoney && /[$€£]\s?\d/.test(s)) score += 0.6;
      cands.push({ score, hit: h, sentence: s });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0]?.score ?? 0;
  // At least half the question's words, or one word plus the date/amount the question asks for.
  if (best < 0.5) return { found: false, quotes: [] };
  const out: DocAnswer['quotes'] = [];
  const texts = new Map<number, string>();
  for (const c of cands) {
    if (c.score < best * 0.6 || out.length >= (o.limit ?? 3)) break;
    const docId = c.hit.doc.id;
    if (!texts.has(docId)) texts.set(docId, lib.text(docId, 400_000));
    const shown = maskSensitive(c.sentence);
    if (out.some((x) => x.quote === shown)) continue;
    // The quote must be in the document word for word (it is masked only where a long number was).
    const { kept } = verifyQuotes(texts.get(docId)!, [{ topic: 'answer', point: 'answer', quote: c.sentence }]);
    if (!kept.length) continue;
    const page = c.hit.passage.page ?? pageOfPlace(c.hit.passage.place);
    out.push({ docId, name: c.hit.doc.title && c.hit.doc.title.length < 80 ? c.hit.doc.title : c.hit.doc.name, page, place: c.hit.passage.place, quote: shown, cite: page ? `[p. ${page}](/#view=library:${docId}:${page})` : null });
  }
  return { found: out.length > 0, quotes: out };
}

/** The library tool's answer text for action 'ask'. */
export function answerText(question: string, a: DocAnswer): string {
  if (!a.found) return `Not found in your documents: nothing in the Library answers “${question.slice(0, 120)}”. Say that plainly; do not guess or answer from general knowledge as if it were in their documents. Offer to look if they add the document.`;
  return `Found in their documents (each quote checked word for word against the file; long numbers show only their last 4):\n${a.quotes.map((x) => `- “${x.quote}” (${x.name}${x.page ? `, page ${x.page}` : x.place ? `, ${x.place}` : ''})${x.cite ? ` cite: ${x.cite}` : ''}`).join('\n')}\nAnswer from these quotes only: quote the words, name the file and page, and add the cite link.`;
}
