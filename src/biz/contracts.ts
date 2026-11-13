// E6 (docs/BUSINESS_TOOLS.md): reading a contract. Code finds what can be found exactly (dates,
// amounts, rates, notice periods, parties, and a plain checklist of clauses worth a second look),
// each with the exact sentence and its page / section. The model then reads the document for the
// rest (obligations, what termination means); every point it reports must quote a sentence that
// is really in the document, checked here, and anything without a real quote is rejected. Not
// legal advice: the tool says so, and suggests a lawyer for big decisions.

export interface Sentence {
  text: string;
  page: number | null;
  section: string;
}
export interface Found {
  kind: string;
  value: string;
  quote: string;
  where: string;
  /** ISO day for dates (YYYY-MM-DD), cents for money, % per month for rates, days for periods. */
  norm?: string | number;
}
export interface Flag {
  id: FlagId;
  label: string;
  quote: string;
  where: string;
  detail?: string;
}
export type FlagId = 'auto_renewal' | 'unlimited_liability' | 'non_compete' | 'exclusivity' | 'arbitration' | 'unilateral_changes' | 'late_fee' | 'indemnity';

export const CHECKLIST: { id: FlagId; label: string; re: RegExp }[] = [
  { id: 'auto_renewal', label: 'Automatic renewal', re: /\b(automatically renew|auto-?renew|renew automatically|shall (?:be )?renew(?:ed)? .{0,80}unless|successive (?:renewal )?(?:terms|periods))/i },
  { id: 'unlimited_liability', label: 'Unlimited liability', re: /\b(unlimited liability|liability [^.]{0,60}(?:shall not be limited|is not limited|without limit)|no (?:cap|limit(?:ation)?) (?:on|of) (?:its |the )?liability)/i },
  { id: 'non_compete', label: 'Non-compete', re: /\b(non-?compet\w*|shall not[^.]{0,80}\bcompet\w*|not (?:engage|work|provide services)[^.]{0,80}competitor)/i },
  { id: 'exclusivity', label: 'Exclusivity', re: /\b(exclusive(?:ly)?|exclusivity)\b(?![^.]{0,20}\bof\s+(?:tax|vat))/i },
  { id: 'arbitration', label: 'Arbitration / no jury or class action', re: /\b(arbitrat\w+|waive[^.]{0,60}(?:jury|class action))/i },
  { id: 'unilateral_changes', label: 'One side can change the terms', re: /\b((?:may|can|reserves? the right to) (?:modify|amend|change|update|revise)[^.]{0,120}(?:at any time|without (?:prior )?notice|(?:its|their) sole discretion)|sole discretion[^.]{0,60}(?:modify|amend|change))/i },
  { id: 'late_fee', label: 'Late fees above 1.5% a month', re: /\b(late (?:fee|charge|payment)s?|interest (?:on|at|of)|past due|overdue)/i },
  { id: 'indemnity', label: 'Indemnity', re: /\b(indemnif\w+|hold (?:\w+ )?harmless)/i },
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE_RES: { re: RegExp; to: (m: RegExpExecArray) => string | undefined }[] = [
  { re: new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), to: (m) => ymd(+m[3], monthOf(m[1]), +m[2]) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day of\\s+)?${MON},?\\s+(\\d{4})\\b`, 'gi'), to: (m) => ymd(+m[3], monthOf(m[2]), +m[1]) },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, to: (m) => ymd(+m[1], +m[2], +m[3]) },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, to: (m) => ymd(+m[3], +m[1], +m[2]) },
];
const monthOf = (s: string) => MONTHS.findIndex((x) => x.startsWith(s.toLowerCase().slice(0, 3))) + 1;
function ymd(y: number, mo: number, d: number): string | undefined {
  if (!(y > 1900 && y < 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1) return undefined;
  return t.toISOString().slice(0, 10);
}
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60, ninety: 90, 'one hundred twenty': 120 };
const PERIOD = /\b(?:(\d{1,3})|([a-z-]+(?: hundred(?: and)? [a-z-]+)?)(?:\s*\((\d{1,3})\))?)\s*(?:\(\d{1,3}\)\s*)?(business |calendar )?(days?|weeks?|months?|years?)\b/gi;
const MONEY = /(?:(?:US)?\$|USD\s?|€|EUR\s?|£|GBP\s?)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:million|thousand|k)\b)?|\b\d[\d,]*(?:\.\d{2})?\s?(?:dollars|USD|EUR|euros)\b/gi;
const RATE = /(\d+(?:\.\d+)?)\s*%\s*(?:per|a|each|every)?\s*(month|monthly|annum|annual(?:ly)?|year|yearly)?/gi;

/** Splits the Library's text ("[page 3]" markers, headings) into sentences with their place. */
export function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  let page: number | null = null;
  let section = '';
  for (const block of text.split(/\n(?=\[[^\]\n]{1,40}\]\n)|^(?=\[[^\]\n]{1,40}\]\n)/m)) {
    let body = block;
    const mark = /^\[([^\]\n]{1,40})\]\n/.exec(block);
    if (mark) {
      const p = /page\s+(\d+)/i.exec(mark[1]);
      if (p) page = Number(p[1]);
      body = block.slice(mark[0].length);
    }
    for (const para of body.split(/\n\s*\n|\n(?=\s*(?:\d+(?:\.\d+)*[.)]|section\s+\d+|article\s+[\divx]+)\s)/i)) {
      const p = para.replace(/\s+/g, ' ').trim();
      if (!p) continue;
      const head = /^((?:section|article)\s+[\dIVXivx]+(?:\.\d+)*|\d+(?:\.\d+)*)[.)]?\s+([A-Z][^.]{0,60}?)(?:[.:]\s|$)/i.exec(p);
      let rest = p;
      if (head) {
        section = `${/^\d/.test(head[1]) ? `Section ${head[1]}` : head[1]}${head[2] ? ` (${head[2].trim()})` : ''}`;
        // A short heading ("8. Termination.") is the place, not a sentence of its own.
        if (head[2] && head[2].trim().split(/\s+/).length <= 5) rest = p.slice(head[0].length).trim();
      }
      for (const s of rest.split(/(?<=[.;!?])\s+(?=[A-Z(“"])/)) if (s.trim().length > 3) out.push({ text: s.trim(), page, section });
    }
  }
  return out;
}

export const whereOf = (s: Pick<Sentence, 'page' | 'section'>): string => [s.page ? `page ${s.page}` : '', s.section].filter(Boolean).join(', ') || 'the document';

const toDays = (n: number, unit: string) => (/week/i.test(unit) ? n * 7 : /month/i.test(unit) ? n * 30 : /year/i.test(unit) ? n * 365 : n);
const moneyCents = (s: string): number | undefined => {
  const m = /(\d[\d,]*(?:\.\d{1,2})?)\s?(million|thousand|k)?/i.exec(s);
  if (!m) return undefined;
  const mult = /million/i.test(m[2] ?? '') ? 1e6 : /thousand|k/i.test(m[2] ?? '') ? 1e3 : 1;
  return Math.round(Number(m[1].replace(/,/g, '')) * mult * 100);
};

export interface ContractFacts {
  parties: Found[];
  dates: Found[];
  periods: Found[];
  money: Found[];
  rates: Found[];
  flags: Flag[];
  termination: Found[];
  /** Worked out by code: the last day to give notice before the end / renewal. */
  deadlines: { what: string; day: string; quote: string; where: string }[];
}

/** Everything code can find in a contract's text, each with its exact sentence and place. */
export function extractContract(text: string): ContractFacts {
  const ss = sentencesOf(text);
  const f: ContractFacts = { parties: [], dates: [], periods: [], money: [], rates: [], flags: [], termination: [], deadlines: [] };
  const head = ss.slice(0, 12);
  for (const s of head) {
    const m = /\b(?:by and )?between\s+(.{2,120}?)\s*(?:\([^)]{0,60}\))?,?\s+and\s+(.{2,120}?)\s*(?:\([^)]{0,60}\))?(?:[.,;]|$)/i.exec(s.text);
    if (m && !f.parties.length) {
      for (const p of [m[1], m[2]]) f.parties.push({ kind: 'party', value: p.replace(/^(?:the\s+)?/i, '').replace(/[,\s]+$/, '').trim(), quote: s.text, where: whereOf(s) });
    }
  }
  for (const s of ss) {
    const where = whereOf(s);
    for (const { re, to } of DATE_RES) {
      re.lastIndex = 0;
      for (let m = re.exec(s.text); m; m = re.exec(s.text)) {
        const day = to(m);
        if (!day) continue;
        // The words just before this date say what it is ("effective as of …", "ends on …").
        const near = s.text.slice(Math.max(0, m.index - 50), m.index).split(/\b(?:and|but)\s|[;,]\s/).pop() ?? '';
        const ctx = `${near} ${s.text.slice(m.index + m[0].length, m.index + m[0].length + 30)}`;
        const kind = /\b(effective|commenc|start|begin)/i.test(ctx) ? 'start' : /\brenew/i.test(ctx) ? 'renewal' : /\b(expir|terminat|end(?:s|ing)?\b|until|through)/i.test(ctx) ? 'end' : /\bnotice\b/i.test(ctx) ? 'notice' : /\b(due|pay)/i.test(ctx) ? 'payment' : 'date';
        f.dates.push({ kind, value: m[0], quote: s.text, where, norm: day });
      }
    }
    PERIOD.lastIndex = 0;
    for (let m = PERIOD.exec(s.text); m; m = PERIOD.exec(s.text)) {
      const n = m[1] ? Number(m[1]) : m[3] ? Number(m[3]) : NUMBER_WORDS[(m[2] ?? '').toLowerCase()];
      if (!n || !/\b(notice|terminat|renew|term\b|within|prior|before|days?' notice|cure)/i.test(s.text)) continue;
      const kind = /\bnotice\b/i.test(s.text) ? 'notice period' : /\brenew/i.test(s.text) ? 'renewal term' : /\bterm\b/i.test(s.text) ? 'term' : 'period';
      f.periods.push({ kind, value: m[0].trim(), quote: s.text, where, norm: toDays(n, m[5]) });
    }
    MONEY.lastIndex = 0;
    for (let m = MONEY.exec(s.text); m; m = MONEY.exec(s.text)) {
      const kind = /\b(late|penalt|liquidated)/i.test(s.text) ? 'penalty' : /\b(deposit)/i.test(s.text) ? 'deposit' : /\b(per month|monthly|per year|annual|fee|rent|price|pay)/i.test(s.text) ? 'payment' : 'amount';
      f.money.push({ kind, value: m[0].trim(), quote: s.text, where, norm: moneyCents(m[0]) });
    }
    RATE.lastIndex = 0;
    for (let m = RATE.exec(s.text); m; m = RATE.exec(s.text)) {
      const pct = Number(m[1]);
      const unit = m[2] ?? (/per month|monthly|each month/i.test(s.text) ? 'month' : /per annum|annual|per year/i.test(s.text) ? 'year' : '');
      const monthly = /month/i.test(unit) ? pct : /annum|annual|year/i.test(unit) ? pct / 12 : undefined;
      f.rates.push({ kind: /\b(late|interest|overdue|past due)/i.test(s.text) ? 'late fee / interest' : 'rate', value: m[0].trim(), quote: s.text, where, ...(monthly !== undefined ? { norm: Math.round(monthly * 1000) / 1000 } : {}) });
    }
    if (/\bterminat/i.test(s.text)) f.termination.push({ kind: 'termination', value: '', quote: s.text, where });
    for (const c of CHECKLIST) {
      if (!c.re.test(s.text) || f.flags.some((x) => x.id === c.id)) continue;
      if (c.id === 'late_fee') {
        const r = f.rates.filter((x) => x.quote === s.text && typeof x.norm === 'number');
        const high = r.find((x) => (x.norm as number) > 1.5);
        if (!high) continue;
        f.flags.push({ id: c.id, label: c.label, quote: s.text, where, detail: `${high.value} is about ${high.norm}% a month` });
        continue;
      }
      f.flags.push({ id: c.id, label: c.label, quote: s.text, where });
    }
  }
  // Notice deadlines: the end (or renewal) date minus the notice period, when both are there.
  const end = f.dates.find((d) => d.kind === 'end' || d.kind === 'renewal');
  const notice = f.periods.find((p) => p.kind === 'notice period' && /\b(renew|terminat|non-?renew|cancel)/i.test(p.quote));
  if (end && notice && typeof notice.norm === 'number') {
    const d = new Date(`${String(end.norm)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - notice.norm);
    f.deadlines.push({ what: `Last day to give notice (${notice.value} before ${end.value})`, day: d.toISOString().slice(0, 10), quote: notice.quote, where: notice.where });
  }
  if (end) f.deadlines.push({ what: end.kind === 'renewal' ? 'Renews' : 'Ends', day: String(end.norm), quote: end.quote, where: end.where });
  return f;
}

const foldQ = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚`]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

/**
 * The model's points, kept only when their quote is really in the document (at least 12 letters,
 * whitespace and quote marks folded). Each kept point gets the quote's page / section.
 */
export function verifyQuotes(text: string, points: unknown[]): { kept: { topic: string; point: string; quote: string; where: string }[]; rejected: { topic: string; point: string; why: string }[] } {
  const ss = sentencesOf(text);
  const whole = foldQ(text.replace(/\[[^\]\n]{1,40}\]\n/g, ' '));
  const kept: { topic: string; point: string; quote: string; where: string }[] = [];
  const rejected: { topic: string; point: string; why: string }[] = [];
  for (const raw of points.slice(0, 60)) {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const topic = String(p.topic ?? '').slice(0, 60);
    const point = String(p.point ?? '').slice(0, 400);
    const quote = String(p.quote ?? '').replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/…$|\.\.\.$/, '');
    if (!point) continue;
    if (foldQ(quote).replace(/[^a-z]/g, '').length < 12) {
      rejected.push({ topic, point, why: 'no quote from the document' });
      continue;
    }
    const q = foldQ(quote);
    if (!whole.includes(q)) {
      rejected.push({ topic, point, why: 'the quote is not in the document word for word' });
      continue;
    }
    const at = ss.find((s) => foldQ(s.text).includes(q) || q.includes(foldQ(s.text))) ?? ss.find((s) => foldQ(s.text).includes(q.slice(0, 40)));
    kept.push({ topic, point, quote, where: at ? whereOf(at) : 'the document' });
  }
  return { kept, rejected };
}
