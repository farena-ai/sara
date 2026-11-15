// R3 (docs/ERRANDS.md): errands, start to finish. "Get this charge refunded", "book an oil change
// this week", "find and book a plumber": a goal, a plan of steps, and a runner that moves one step at
// a time through her normal tools, with the person's OK at every step that commits or costs money.
//
// Steps: research (a read-only tool, or a normal turn in the errand's chat), message (an email; sent
// only with the person's OK, or with "send without asking" that the person turned on for that errand),
// form (pc_fill_form, which stops before Submit), browser (a normal turn; a final confirm needs the OK),
// call (R5: her own phone call after its card when phone calls are set up and on, else a call script
// and the number), purchase (never automatic: "here's the
// page, you pay"), wait (a reply in the thread advances it; a follow-up is drafted after N days) and
// decide (compare, then the person's choice).
//
// Nothing new ticks: the reminder scheduler's tick calls due() (src/reminders.ts) and the inbox helper
// hands every new mail to observeMail() (src/inbox/helper.ts). Tool permissions still apply: a tool
// set to never fails its step. Each step's result carries evidence: the tool's N1 read-back line
// (src/verify-action.ts), the reply's mail id, or "your word" for what the person did themselves.
//
// Table (additive, the space's own store.db, so each household member has their own): errands.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext, ChatEvent } from './chat.ts';
import type { InboxMail } from './inbox/classify.ts';
import { en, trOwner } from './i18n.ts';
import { quietNow } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { ERRAND_SENT } from './receipts.ts';
import type { Permission, ToolContext } from './tools/types.ts';
import { verifyAction, verifyState, VERIFIED, VERIFY_TOOLS } from './verify-action.ts';

export const ERRAND = { max: 30, keepLog: 80, followUpDays: 5, maxFollowUps: 2, maxSteps: 12, taskTokens: 30_000, taskMinutes: 10 } as const;
export const ERRAND_STATUSES = ['planning', 'working', 'waiting_you', 'waiting_others', 'done', 'stopped'] as const;
export type ErrandStatus = (typeof ERRAND_STATUSES)[number];
export const STEP_KINDS = ['research', 'message', 'form', 'browser', 'call', 'purchase', 'wait', 'decide'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export type StepStatus = 'todo' | 'waiting_you' | 'waiting_others' | 'done' | 'skipped';
/** What a waiting step needs from the person. */
type Pending = 'send' | 'address' | 'follow_up' | 'form' | 'call' | 'purchase' | 'decide' | 'confirm' | 'browser' | 'tool' | 'retry';
type Fact = 'amount' | 'date' | 'order' | 'merchant' | 'email' | 'emails' | 'phone' | 'url' | 'list';

export interface Evidence {
  /** tool: a tool's own read-back; mail: a reply in the mailbox; you: the person said so; turn: her turn in the errand's chat. */
  kind: 'tool' | 'mail' | 'you' | 'turn';
  tool?: string;
  verified: 'verified' | 'unverified' | 'read';
  line?: string;
  /** A mail id or the errand's conversation id. */
  ref?: string;
  at: string;
}
export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}
export interface Found {
  name: string;
  email?: string;
  phone?: string;
  url?: string;
}
export interface Step {
  text: string;
  kind: StepKind;
  status: StepStatus;
  result?: string;
  evidence?: Evidence;
  tool?: string;
  args?: Record<string, unknown>;
  collect?: Fact[];
  /** message: templates with {facts}; the filled draft waits for the OK. */
  to?: string;
  subject?: string;
  body?: string;
  draft?: EmailDraft;
  sentAt?: string;
  options?: string[];
  choice?: string;
  phone?: string;
  url?: string;
  script?: string;
  /** R5: the phone call she placed for this step (PhoneCalls record id). */
  callId?: number;
  amount?: number;
  followUpDays?: number;
  followUps?: number;
  since?: string;
  waitFor?: 'any' | 'all';
  /** browser: a step that commits (a final confirm) asks first. */
  needsOk?: boolean;
  ask?: string;
  pending?: Pending;
}
export interface Contact {
  name?: string;
  email?: string;
  phone?: string;
  replied?: boolean;
}
export interface Reply {
  from: string;
  summary: string;
  id: string;
  at: string;
}
export interface Errand {
  id: number;
  goal: string;
  template: string | null;
  status: ErrandStatus;
  steps: Step[];
  contacts: Contact[];
  facts: Record<string, string>;
  found: Found[];
  replies: Reply[];
  deadline: string | null;
  budget: number | null;
  spent: number;
  sendWithoutAsking: boolean;
  owner: 'owner' | 'member';
  conversationId: string | null;
  needs: string | null;
  summary: string | null;
  log: { at: string; text: string }[];
  createdAt: string;
  updatedAt: string;
}
export interface StepDraft {
  text?: string;
  kind?: string;
  tool?: string;
  args?: Record<string, unknown>;
  to?: string;
  subject?: string;
  body?: string;
  options?: string[];
  phone?: string;
  url?: string;
  script?: string;
  amount?: number;
  followUpDays?: number;
  needsOk?: boolean;
}
export interface ErrandDraft {
  goal: string;
  template?: string;
  steps?: StepDraft[];
  facts?: Record<string, unknown>;
  deadline?: string;
  budget?: number;
}

export class ErrandError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ERRAND_LINES = [en('Errand not found.'), en('Say what the errand is.'), en('You have the most open errands this keeps.'), en('Errands can’t be started from a private chat.'), en('Nothing is waiting for your OK on this errand.'), en('Pick one first.'), en('This errand is over.'), en('Add an email address first.')];

// ------------------------------------------------------------------ templates

interface Template {
  id: string;
  name: string;
  pitch: string;
  words: RegExp;
  steps: StepDraft[];
}
const W = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})`, 'iu');

/** Plain letters for the person's mail; she adjusts them when asked. */
const LETTER = {
  refund: 'Hello {merchant|} support,\n\nI am writing about a charge{amount| of {amount}}{date| on {date}}{order| (order #{order})}. I would like to ask for a refund of this charge.\n\nCould you let me know when it is refunded, or what else you need from me?\n\nThank you,\n{owner}',
  book: 'Hello,\n\nI would like to book {service|an appointment}{when| {when}}. Could you tell me which times you have open and the price?\n\nThank you,\n{owner}',
  dispute: 'Hello {merchant|},\n\nI am writing to make a formal complaint about {about|my recent experience}{order| (order #{order})}{amount|, for {amount}}. {details|}\n\nI would like this put right. Please reply within 14 days with how you will resolve it.\n\nThank you,\n{owner}',
  quotes: 'Hello,\n\nI am looking for a quote for {service|a job}{place| in {place}}. {details|}Could you send me a price and when you could do it?\n\nThank you,\n{owner}',
  follow: 'Hello,\n\nI am following up on my email “{subject}” from {sent}. Could you let me know where this stands?\n\nThank you,\n{owner}',
};
const CALL_SCRIPT = 'Hi, this is {owner}. I’m calling about: {goal}. {ask|Could you help me with that, and what are the next steps?}';

export const TEMPLATES: Template[] = [
  {
    id: 'refund',
    name: en('Get a charge refunded'),
    pitch: en('Finds the receipt in your mail, finds their support address, drafts a polite refund request and follows up in 5 days.'),
    words: W('refund|money back|chargeback|reembols|devoluci[oó]n del (?:dinero|cobro)|rembours|erstatt|r[uü]ckerstattung|geld zur[uü]ck|estorno|rimbors'),
    steps: [
      { text: en('Find the receipt in your mail'), kind: 'research', tool: 'mail_search', args: { query: '{merchant}' } },
      { text: en('Find their support address'), kind: 'research', tool: 'web_search', args: { query: '{merchant} customer support email refund' } },
      { text: en('Write to them and ask for the refund'), kind: 'message', to: '{email}', subject: 'Refund request: {merchant|my charge} {amount|}', body: LETTER.refund },
      { text: en('Wait for their answer (follow up after 5 days)'), kind: 'wait', followUpDays: 5 },
    ],
  },
  {
    id: 'cancel',
    name: en('Cancel a subscription'),
    pitch: en('Finds the cancel page, fills it for you and stops before the final confirm unless you say yes.'),
    words: W('cancel(?:l?ing)? (?:my |the |a )?(?:subscription|membership|plan|account)|unsubscribe me from|cancelar (?:mi |la )?(?:suscripci[oó]n|membres[ií]a|assinatura|plano)|r[ée]silier|annuler (?:mon |l.)?abonnement|k[uü]ndig|abo k[uü]ndigen|disdire|annullare (?:l.|il mio )?abbonamento|disdetta'),
    steps: [
      { text: en('Find how to cancel'), kind: 'research', tool: 'web_search', args: { query: 'how to cancel {merchant} subscription' } },
      { text: en('Open the cancel page and fill it (she stops before the final confirm)'), kind: 'form' },
      { text: en('Press the final confirm (only with your OK)'), kind: 'browser', needsOk: true },
    ],
  },
  {
    id: 'quotes',
    name: en('Get quotes from 3 contractors'),
    pitch: en('Finds three nearby contractors, asks each for a quote, follows up and lines the answers up for you to pick.'),
    words: W('quotes?|estimates? from|presupuestos?|cotizaci[oó]n|devis|kostenvoranschl[aä]g|angebote? (?:von|einholen)|or[cç]amentos?|preventiv'),
    steps: [
      { text: en('Find three contractors near you'), kind: 'research', tool: 'stores_near', args: { kind: '{service}' } },
      { text: en('Find how to reach each one'), kind: 'research' },
      { text: en('Ask each for a quote'), kind: 'message', to: '{emails}', subject: 'Quote request: {service|a job}', body: LETTER.quotes },
      { text: en('Wait for their quotes (follow up after 5 days)'), kind: 'wait', followUpDays: 5 },
      { text: en('Compare the quotes and pick one'), kind: 'decide' },
    ],
  },
  {
    id: 'book',
    name: en('Book a service'),
    pitch: en('Finds three nearby providers, compares their hours and ratings, and asks for a booking or fills their booking form (stopping before Submit).'),
    words: W('book|schedule an? (?:appointment|service)|make an appointment|find (?:me )?(?:a|an|someone to)|oil change|plumber|electrician|dentist|haircut|reservar|agendar|pedir (?:una )?cita|prendre (?:un )?rendez-vous|r[ée]server|termin (?:machen|vereinbaren|buchen)|buchen|marcar (?:uma )?consulta|prenotar|fissare un appuntamento'),
    steps: [
      { text: en('Find places near you'), kind: 'research', tool: 'stores_near', args: { kind: '{service}' } },
      { text: en('Compare their hours and ratings from their websites'), kind: 'research' },
      { text: en('Pick the one you want'), kind: 'decide' },
      { text: en('Ask them for a booking'), kind: 'message', to: '{email}', subject: 'Booking request: {service|an appointment}', body: LETTER.book },
      { text: en('Wait for their answer (follow up after 2 days)'), kind: 'wait', followUpDays: 2 },
    ],
  },
  {
    id: 'dispute',
    name: en('Write a dispute or complaint letter'),
    pitch: en('Finds the order in your mail, finds where complaints go, drafts a firm, polite letter and follows up in 7 days.'),
    words: W('dispute|complain|complaint|queja|reclamaci[oó]n|reclamation|r[ée]clamation|plainte|beschwerde|reklamation|reclama[cç][aã]o|queixa|reclamo|lamentela'),
    steps: [
      { text: en('Find the order in your mail'), kind: 'research', tool: 'mail_search', args: { query: '{merchant}' } },
      { text: en('Find where complaints go'), kind: 'research', tool: 'web_search', args: { query: '{merchant} complaints email address' } },
      { text: en('Send the complaint letter'), kind: 'message', to: '{email}', subject: 'Complaint: {merchant|my order}{order| #{order}}', body: LETTER.dispute },
      { text: en('Wait for their answer (follow up after 7 days)'), kind: 'wait', followUpDays: 7 },
    ],
  },
];
/** What each template's steps collect from what they read. */
const COLLECT: Record<string, Fact[][]> = {
  refund: [['amount', 'date', 'order', 'merchant'], ['email', 'phone', 'url']],
  cancel: [['url', 'email', 'phone']],
  quotes: [['list'], ['emails', 'list']],
  book: [['list'], []],
  dispute: [['amount', 'date', 'order', 'merchant'], ['email', 'phone', 'url']],
};

/** The template whose words match the goal (in six languages); the first that matches wins. */
export function templateFor(goal: string): Template | undefined {
  const g = goal.normalize('NFC');
  // Ordered so the specific asks win over the general "book / find someone to".
  return ['refund', 'cancel', 'quotes', 'dispute', 'book'].map((id) => TEMPLATES.find((t) => t.id === id)!).find((t) => t.words.test(g));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const line = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);

function cleanStep(d: StepDraft, collect?: Fact[]): Step | undefined {
  const kind = STEP_KINDS.find((k) => k === d.kind);
  if (!kind) return undefined;
  const s: Step = { text: line(d.text, 200) || kind, kind, status: 'todo' };
  if (d.tool && typeof d.tool === 'string') s.tool = line(d.tool, 60);
  if (d.args && typeof d.args === 'object') s.args = Object.fromEntries(Object.entries(d.args).slice(0, 12).map(([k, v]) => [line(k, 40), typeof v === 'number' || typeof v === 'boolean' ? v : line(v, 400)]));
  if (collect?.length) s.collect = collect;
  for (const k of ['to', 'subject', 'phone', 'url', 'script'] as const) if (d[k]) s[k] = line(d[k], k === 'script' ? 1000 : 300);
  if (d.body) s.body = String(d.body).replace(/\u0000/g, '').slice(0, 4000);
  if (Array.isArray(d.options)) s.options = d.options.map((o) => line(o, 80)).filter(Boolean).slice(0, 6);
  if (typeof d.amount === 'number' && Number.isFinite(d.amount) && d.amount >= 0) s.amount = Math.round(d.amount * 100) / 100;
  if (typeof d.followUpDays === 'number' && d.followUpDays > 0) s.followUpDays = Math.min(30, Math.round(d.followUpDays));
  if (d.needsOk === true) s.needsOk = true;
  return s;
}

/** A plan for a goal: the model's own steps, else the template's (picked by name or by the goal's words). */
export function planFor(goal: string, o: { template?: string; steps?: StepDraft[]; facts?: Record<string, unknown> } = {}): { template: string | null; steps: Step[] } {
  if (Array.isArray(o.steps) && o.steps.length) {
    const steps = o.steps.slice(0, ERRAND.maxSteps).map((d) => cleanStep(d)).filter((s): s is Step => Boolean(s));
    if (steps.length) return { template: null, steps };
  }
  const t = TEMPLATES.find((x) => x.id === o.template) ?? templateFor(goal);
  if (!t) return { template: null, steps: [cleanStep({ text: goal, kind: 'research' })!] };
  const steps = t.steps.map((d, i) => cleanStep(d, COLLECT[t.id]?.[i])!);
  // Quotes: the wait counts every contractor's answer.
  if (t.id === 'quotes') for (const s of steps) if (s.kind === 'wait') s.waitFor = 'all';
  return { template: t.id, steps };
}

/** {key} and {key|fallback} (the fallback may hold {key} too) from the errand's facts. */
export function fillIn(s: string, facts: Record<string, string>): string {
  return s
    .replace(/\{(\w+)\|([^{}]*(?:\{\w+\}[^{}]*)*)\}/g, (_m, k: string, alt: string) => (facts[k] ? (alt.includes(`{${k}}`) ? alt.replace(new RegExp(`\\{${k}\\}`, 'g'), facts[k]!) : facts[k]!) : alt.includes(`{${k}}`) ? '' : alt))
    .replace(/\{(\w+)\}/g, (_m, k: string) => facts[k] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.)])/g, '$1')
    .trim();
}

// ------------------------------------------------------------------ reading results

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const URL = /https?:\/\/[^\s)>\]"'|]+/;
const AMOUNT = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP))/;
const ORDER = /(?:#|order(?: number| no\.?)?:?\s+)([A-Z0-9][A-Z0-9-]{2,})/i;
const MON = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2} ${MON} \\d{4}\\b|\\b${MON} \\d{1,2}, \\d{4}\\b`);
/** The mail tools' warning line before other people's words (kept out of results and summaries). */
const UNTRUSTED_LINE = /^\((?:Email|Page) content below[^\n]*\)\s*/;
const FROM = /From:\s*([^<\n·]+?)\s*</;

/** Lines like "- Name (kind) 1.2 mi, address, +1 512…, https://…" (stores_near, research lists). */
export function foundIn(text: string, own: string[] = []): Found[] {
  const out: Found[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const rest = m[1]!;
    const name = line(rest.split(/\s+\(|,|\s+[–—-]\s+|:/)[0], 80);
    if (!name || name.length < 2) continue;
    const email = (rest.match(EMAIL) ?? []).find((e) => !own.includes(e.toLowerCase()));
    const phone = PHONE.exec(rest)?.[0];
    const url = URL.exec(rest)?.[0];
    out.push({ name, ...(email ? { email } : {}), ...(phone ? { phone: phone.trim() } : {}), ...(url ? { url } : {}) });
    if (out.length >= 8) break;
  }
  return out;
}

/** A reply's own words: no quoted part, no signature line, two sentences at most. */
export function replySummary(text: string): string {
  const cut = text.split(/\n\s*(?:On .{3,200}wrote:|-{2,}\s*Original Message\s*-{2,}|From: .+\n)/i)[0] ?? text;
  const own = cut
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = own.split(/(?<=[.!?])\s+/);
  return clip(sentences.slice(0, 3).join(' ').trim() || own, 300);
}

const normSubject = (s: string) => s.replace(/^\s*(?:(?:re|fwd?|aw|wg|sv|antw|r)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const addressOf = (from: string): string => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

// ------------------------------------------------------------------ the store and runner

export interface ErrandOptions {
  /** Tests: a fake turn in the errand's chat (default: app.runTracked). */
  runTask?: (r: { errand: Errand; conversationId: string; content: string }) => Promise<{ reply: string; error?: string; declined?: boolean }>;
  /** Tests: catch notifications (default: app.push.notifyOwner). */
  notify?: (title: string, body: string, conversationId: string, tag: string) => Promise<void>;
  quiet?: () => boolean;
  /** The person's own mail addresses (never a contact). Default: the connected mailboxes. */
  ownAddresses?: () => string[];
}

type Row = Record<string, string | number | null>;
interface Data {
  steps: Step[];
  contacts: Contact[];
  facts: Record<string, string>;
  found: Found[];
  replies: Reply[];
  log: { at: string; text: string }[];
}

export class Errands {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: ErrandOptions;
  readonly #running = new Set<number>();
  readonly #work = new Set<Promise<unknown>>();

  constructor(app: AppContext, db: DatabaseSync = app.store.db, o: ErrandOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(`
CREATE TABLE IF NOT EXISTS errands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  template TEXT,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  deadline TEXT,
  budget REAL,
  spent REAL NOT NULL DEFAULT 0,
  send_auto INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT 'owner',
  conversation_id TEXT,
  needs TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
  }

  #now(): Date {
    return this.#app.now();
  }
  #T(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#app.settings.get(), params);
  }
  #own(): string[] {
    try {
      return (this.#o.ownAddresses ? this.#o.ownAddresses() : (this.#app.mailAccounts?.list() ?? []).map((a) => a.address)).map((a) => a.toLowerCase());
    } catch {
      return [];
    }
  }

  #row(r: Row): Errand {
    const d = JSON.parse(String(r.data_json)) as Data;
    return {
      id: Number(r.id),
      goal: String(r.goal),
      template: r.template ? String(r.template) : null,
      status: String(r.status) as ErrandStatus,
      steps: d.steps,
      contacts: d.contacts ?? [],
      facts: d.facts ?? {},
      found: d.found ?? [],
      replies: d.replies ?? [],
      log: d.log ?? [],
      deadline: r.deadline ? String(r.deadline) : null,
      budget: r.budget === null || r.budget === undefined ? null : Number(r.budget),
      spent: Number(r.spent ?? 0),
      sendWithoutAsking: Number(r.send_auto) === 1,
      owner: r.owner === 'member' ? 'member' : 'owner',
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      needs: r.needs ? String(r.needs) : null,
      summary: r.summary ? String(r.summary) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  list(o: { open?: boolean } = {}): Errand[] {
    const rows = this.#db.prepare(`SELECT * FROM errands ${o.open ? "WHERE status NOT IN ('done', 'stopped')" : ''} ORDER BY id DESC`).all() as Row[];
    return rows.map((r) => this.#row(r));
  }
  get(id: number): Errand | undefined {
    const r = this.#db.prepare('SELECT * FROM errands WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#row(r) : undefined;
  }
  #must(id: number): Errand {
    const e = this.get(id);
    if (!e) throw new ErrandError(404, en('Errand not found.'));
    return e;
  }
  #save(e: Errand): Errand {
    const data: Data = { steps: e.steps, contacts: e.contacts, facts: e.facts, found: e.found, replies: e.replies, log: e.log.slice(-ERRAND.keepLog) };
    const cur = e.steps.find((s) => s.status === 'waiting_you');
    e.needs = e.status === 'waiting_you' ? (cur?.ask ?? null) : null;
    this.#db
      .prepare('UPDATE errands SET goal = ?, template = ?, status = ?, data_json = ?, deadline = ?, budget = ?, spent = ?, send_auto = ?, conversation_id = ?, needs = ?, summary = ?, updated_at = ? WHERE id = ?')
      .run(e.goal, e.template, e.status, JSON.stringify(data), e.deadline, e.budget, e.spent, e.sendWithoutAsking ? 1 : 0, e.conversationId, e.needs, e.summary, this.#now().toISOString(), e.id);
    this.#app.events?.publish({ type: 'today', part: 'errands' });
    return this.get(e.id)!;
  }
  #log(e: Errand, text: string): void {
    e.log.push({ at: this.#now().toISOString(), text: clip(text, 400) });
  }

  // ------------------------------------------------------------ plan and start

  /** A checked plan (no row): what the Allow card and the page's preview show. */
  plan(draft: ErrandDraft): { goal: string; template: string | null; steps: Step[]; facts: Record<string, string>; deadline: string | null; budget: number | null } {
    const goal = line(draft.goal, 300);
    if (!goal) throw new ErrandError(400, en('Say what the errand is.'));
    const facts: Record<string, string> = {};
    if (draft.facts && typeof draft.facts === 'object') for (const [k, v] of Object.entries(draft.facts).slice(0, 20)) if (/^\w{1,30}$/.test(k) && v !== undefined && v !== null && String(v).trim()) facts[k] = line(v, 300);
    const p = planFor(goal, { ...(draft.template ? { template: draft.template } : {}), ...(draft.steps ? { steps: draft.steps } : {}), facts });
    // Template step texts in the person's language, with what is already known filled in.
    if (p.template) for (const s of p.steps) s.text = this.#T(s.text);
    const deadline = draft.deadline && !Number.isNaN(Date.parse(String(draft.deadline))) ? line(draft.deadline, 40) : null;
    const budget = typeof draft.budget === 'number' && Number.isFinite(draft.budget) && draft.budget >= 0 ? Math.round(draft.budget * 100) / 100 : null;
    return { goal, template: p.template, steps: p.steps, facts, deadline, budget };
  }
  /** The plan in plain words (the Allow card): each step and which ones ask first. */
  planText(draft: ErrandDraft): string {
    const p = this.plan(draft);
    const T = (s: string, x?: Record<string, unknown>) => this.#T(s, x);
    const asks = (s: Step) => (s.kind === 'message' || s.kind === 'form' || s.kind === 'purchase' || s.kind === 'decide' || s.kind === 'call' || (s.kind === 'browser' && s.needsOk) ? ` (${T(en('asks you before'))})` : '');
    return [
      `“${p.goal}”`,
      ...p.steps.map((s, i) => `${i + 1}. ${s.text}${asks(s)}`),
      ...(p.deadline ? [T(en('Deadline: {when}'), { when: p.deadline })] : []),
      ...(p.budget !== null ? [T(en('Budget: {amount}'), { amount: `$${p.budget}` })] : []),
      T(en('Emails are sent only with your OK; payments are always yours to make.')),
    ].join('\n');
  }
  /** Starts an errand: from chat (after its one Allow) it works at once; from the page it waits for Start. */
  start(draft: ErrandDraft, o: { by?: 'chat' | 'page'; conversationId?: string | null } = {}): Errand {
    if (o.conversationId && this.#app.store.getConversation(o.conversationId)?.private) throw new ErrandError(403, en('Errands can’t be started from a private chat.'));
    if (this.list({ open: true }).length >= ERRAND.max) throw new ErrandError(409, en('You have the most open errands this keeps.'));
    const p = this.plan(draft);
    const iso = this.#now().toISOString();
    const data: Data = { steps: p.steps, contacts: [], facts: p.facts, found: [], replies: [], log: [{ at: iso, text: o.by === 'page' ? 'Planned on the Errands page.' : 'Started from the chat (you allowed the plan).' }] };
    const id = Number(
      this.#db
        .prepare('INSERT INTO errands (goal, template, status, data_json, deadline, budget, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.goal, p.template, o.by === 'page' ? 'planning' : 'working', JSON.stringify(data), p.deadline, p.budget, this.#app.member ? 'member' : 'owner', iso, iso).lastInsertRowid,
    );
    // Its own chat is made when she first has something to say there.
    this.#app.events?.publish({ type: 'today', part: 'errands' });
    return this.get(id)!;
  }
  /** Start (planning → working). */
  confirm(id: number): Errand {
    const e = this.#must(id);
    if (e.status !== 'planning') return e;
    e.status = 'working';
    this.#log(e, 'You started it.');
    return this.#save(e);
  }
  #conversation(e: Errand): string {
    if (e.conversationId && this.#app.store.getConversation(e.conversationId)) return e.conversationId;
    return this.#app.store.createConversation({ title: clip(`Errand: ${e.goal}`, 60), channel: 'errand', channelKey: String(e.id) }).id;
  }
  #say(e: Errand, text: string): void {
    try {
      if (!e.conversationId || !this.#app.store.getConversation(e.conversationId)) {
        e.conversationId = this.#conversation(e);
        this.#db.prepare('UPDATE errands SET conversation_id = ? WHERE id = ?').run(e.conversationId, e.id);
      }
      const msg = this.#app.store.addMessage(e.conversationId, 'assistant', text, { errand: { id: e.id } });
      this.#app.events?.publish({ type: 'message', conversationId: e.conversationId, message: msg, reason: 'reminder' });
    } catch {
      /* the chat was deleted */
    }
  }
  async #push(e: Errand, title: string, body: string): Promise<void> {
    if ((this.#o.quiet ? this.#o.quiet() : quietNow(this.#app)) || privateLocalOn()) return;
    const n = this.#o.notify ?? ((a: string, b: string, c: string, d: string) => this.#app.push?.notifyOwner(a, b, c, d) ?? Promise.resolve());
    await n(title, body, e.conversationId ?? '', `errand-${e.id}`).catch(() => undefined);
  }

  // ------------------------------------------------------------ change, stop, remove

  update(id: number, patch: { note?: string; deadline?: string | null; budget?: number | null; addStep?: StepDraft; removeStep?: number; sendWithoutAsking?: boolean; facts?: Record<string, unknown>; goal?: string }, o: { by: 'model' | 'person' }): Errand {
    const e = this.#must(id);
    if (patch.note) this.#log(e, `${o.by === 'person' ? 'You' : 'Sara'}: ${line(patch.note, 300)}`);
    if (patch.goal && line(patch.goal, 300)) e.goal = line(patch.goal, 300);
    if (patch.deadline !== undefined) e.deadline = patch.deadline && !Number.isNaN(Date.parse(patch.deadline)) ? line(patch.deadline, 40) : null;
    if (patch.budget !== undefined) e.budget = typeof patch.budget === 'number' && patch.budget >= 0 ? Math.round(patch.budget * 100) / 100 : null;
    if (patch.facts && typeof patch.facts === 'object') for (const [k, v] of Object.entries(patch.facts).slice(0, 20)) if (/^\w{1,30}$/.test(k)) e.facts[k] = line(v, 300);
    if (patch.addStep && e.steps.length < ERRAND.maxSteps) {
      const s = cleanStep(patch.addStep);
      if (s) {
        e.steps.push(s);
        this.#log(e, `Added a step: ${s.text}`);
        if (e.status === 'done') e.status = 'working';
      }
    }
    if (typeof patch.removeStep === 'number') {
      const s = e.steps[patch.removeStep];
      if (s && s.status === 'todo') {
        e.steps.splice(patch.removeStep, 1);
        this.#log(e, `Removed a step: ${s.text}`);
      }
    }
    // Only the person turns on sending without asking, for this errand (never purchases or payments).
    if (patch.sendWithoutAsking !== undefined && o.by === 'person') {
      e.sendWithoutAsking = patch.sendWithoutAsking === true;
      this.#log(e, e.sendWithoutAsking ? 'You turned on sending without asking for this errand.' : 'Emails ask you again before they go.');
    }
    return this.#save(e);
  }
  stop(id: number, why?: string): Errand {
    const e = this.#must(id);
    if (e.status === 'done' || e.status === 'stopped') return e;
    return this.#end(e, 'stopped', why ?? this.#T(en('You stopped it.')));
  }
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM errands WHERE id = ?').run(id).changes > 0;
  }
  /** What was done, what came back and what's left, in a few lines. */
  summaryOf(e: Errand, why?: string): string {
    const T = (s: string, x?: Record<string, unknown>) => this.#T(s, x);
    // What came back matters for emails, answers, choices, calls and payments; look-ups just say they were done.
    const done = e.steps.filter((s) => s.status === 'done').map((s) => (s.kind === 'research' || s.kind === 'browser' || !s.result ? s.text : `${s.text}: ${clip(s.result.replace(/\s+/g, ' '), 200)}`));
    const left = e.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped').map((s) => s.text);
    return [why ?? '', done.length ? `${T(en('Done:'))} ${done.join(' · ')}` : T(en('Nothing was done yet.')), left.length ? `${T(en('Not done:'))} ${left.join(' · ')}` : '', e.spent ? T(en('You paid {amount}.'), { amount: `$${e.spent}` }) : ''].filter(Boolean).join('\n');
  }
  #end(e: Errand, status: 'done' | 'stopped', why?: string): Errand {
    e.status = status;
    for (const s of e.steps) if (s.status === 'waiting_you' || s.status === 'waiting_others') {
      s.status = status === 'done' ? 'skipped' : 'todo';
      delete s.pending;
    }
    e.summary = this.summaryOf(e, why);
    this.#log(e, status === 'done' ? 'Done.' : `Stopped: ${why ?? ''}`);
    const saved = this.#save(e);
    const title = status === 'done' ? this.#T(en('Errand done: {goal}'), { goal: clip(e.goal, 60) }) : this.#T(en('Errand stopped: {goal}'), { goal: clip(e.goal, 60) });
    this.#say(saved, `${title}\n${saved.summary}`);
    void this.#push(saved, title, clip(saved.summary ?? '', 300));
    return saved;
  }

  // ------------------------------------------------------------ approvals (never bypassed)

  #permission(name: string): Permission {
    const app = this.#app;
    const over = app.settings.get().toolPermissions;
    if (app.tools.get(name)) return app.tools.permission(name, over);
    return (over?.[name] as Permission | undefined) ?? 'ask';
  }
  #tool(name: string): import('./tools/types.ts').Tool | undefined {
    const t = this.#app.tools.get(name);
    return t && t.isAvailable?.() !== false ? t : undefined;
  }
  #ctx(e: Errand): ToolContext {
    return { workspaceDir: this.#app.dataDir, signal: AbortSignal.timeout(120_000), sandbox: this.#app.sandbox, ...(e.conversationId ? { conversationId: e.conversationId } : {}) } as ToolContext;
  }
  async #evidence(name: string, args: Record<string, unknown>, out: string): Promise<Evidence> {
    const at = this.#now().toISOString();
    if (!VERIFY_TOOLS.has(name) && name !== 'pc_fill_form') return { kind: 'tool', tool: name, verified: 'read', line: this.#T(en('Read only: nothing was changed.')), at };
    let state = verifyState(out);
    let found = out.split('\n').find((l) => /^(?:Verified|Could not verify):/.test(l));
    if (!state) {
      const extra = await verifyAction(name, args, out, { wsDir: this.#app.dataDir }).catch(() => undefined);
      if (extra) {
        found = extra;
        state = verifyState(extra);
      }
    }
    return { kind: 'tool', tool: name, verified: state ?? 'unverified', line: found ?? `Could not verify: ${name} gave no read-back.`, at };
  }
  #wait(e: Errand, s: Step, pending: Pending, ask: string): void {
    s.status = 'waiting_you';
    s.pending = pending;
    s.ask = clip(ask, 1200);
    e.status = 'waiting_you';
    this.#log(e, `Needs you: ${ask}`);
  }
  async #needsYou(e: Errand): Promise<void> {
    const s = e.steps.find((x) => x.status === 'waiting_you');
    if (!s?.ask) return;
    const title = this.#T(en('Errand needs you: {goal}'), { goal: clip(e.goal, 60) });
    this.#say(e, `${title}\n${s.ask}`);
    await this.#push(e, title, clip(s.ask, 300));
  }
  #done(e: Errand, s: Step, result: string, evidence: Evidence): void {
    s.status = 'done';
    s.result = clip(result, 1500);
    s.evidence = evidence;
    delete s.pending;
    delete s.ask;
    if (e.status !== 'stopped') e.status = 'working';
    this.#log(e, `${s.text}: ${clip(result, 200)}`);
  }
  #you(note?: string): Evidence {
    return { kind: 'you', verified: 'read', line: this.#T(en('Your word: you marked it done.')) + (note ? ` (${clip(note, 120)})` : ''), at: this.#now().toISOString() };
  }

  /** The person's OK on the step that waits for them (with a choice, an address, an amount or a note). */
  async approve(id: number, body: { choice?: string; to?: string; note?: string; amount?: number } = {}): Promise<Errand> {
    const e = this.#must(id);
    const i = e.steps.findIndex((s) => s.status === 'waiting_you');
    const s = e.steps[i];
    if (e.status === 'done' || e.status === 'stopped') throw new ErrandError(409, en('This errand is over.'));
    if (!s || this.#running.has(id)) throw new ErrandError(409, en('Nothing is waiting for your OK on this errand.'));
    this.#running.add(id);
    try {
      const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
      const note = line(body.note, 300) || undefined;
      switch (s.pending) {
        case 'send':
          await this.#send(e, s, s.draft!);
          break;
        case 'follow_up':
          await this.#send(e, s, s.draft!, true);
          break;
        case 'address': {
          const to = line(body.to, 300);
          if (!/@/.test(to)) throw new ErrandError(400, en('Add an email address first.'));
          s.to = to;
          s.status = 'todo';
          delete s.pending;
          e.status = 'working';
          await this.#step(e, i);
          break;
        }
        case 'decide': {
          const choice = line(body.choice, 120);
          if (!choice) throw new ErrandError(400, en('Pick one first.'));
          s.choice = choice;
          const f = e.found.find((x) => x.name.toLowerCase() === choice.toLowerCase());
          if (f) {
            for (const k of ['email', 'phone', 'url'] as const) {
              if (f[k]) e.facts[k] = f[k]!;
              else delete e.facts[k];
            }
            e.contacts = [{ name: f.name, ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}) }];
          }
          e.facts.choice = choice;
          this.#done(e, s, T(en('You chose {choice}.'), { choice }), this.#you());
          break;
        }
        case 'form': {
          const tool = this.#tool('pc_fill_form');
          const url = s.url ?? e.facts.url ?? '';
          if (!tool || this.#permission('pc_fill_form') === 'never') {
            this.#done(e, s, note ?? T(en('You filled it yourself.')), this.#you(note));
            break;
          }
          const args = { window: url.replace(/^https?:\/\/(?:www\.)?/, '').split(/[/?#]/)[0] ?? url, values: {} };
          try {
            const out = await tool.run(args, this.#ctx(e));
            this.#done(e, s, `${clip(out.split('\n')[0] ?? out, 300)} ${T(en('She stopped before Submit: press Submit yourself.'))}`, await this.#evidence('pc_fill_form', args, out));
          } catch (err) {
            this.#wait(e, s, 'confirm', T(en('She couldn’t fill it: {why}. Open {url}, fill it yourself and tap Done.'), { why: clip((err as Error).message, 160), url }));
          }
          break;
        }
        case 'browser':
          s.needsOk = false;
          s.status = 'todo';
          delete s.pending;
          e.status = 'working';
          await this.#step(e, i, true);
          break;
        case 'tool':
          s.status = 'todo';
          delete s.pending;
          e.status = 'working';
          await this.#step(e, i, true);
          break;
        case 'retry':
          s.status = 'todo';
          delete s.pending;
          e.status = 'working';
          await this.#step(e, i);
          break;
        case 'purchase': {
          const amount = typeof body.amount === 'number' && body.amount >= 0 ? body.amount : (s.amount ?? 0);
          e.spent = Math.round((e.spent + amount) * 100) / 100;
          this.#done(e, s, note ?? (amount ? T(en('You paid {amount}.'), { amount: `$${amount}` }) : T(en('You paid.'))), this.#you(note));
          break;
        }
        case 'call': {
          // R5: with phone calls ready (and no note saying the person called), she places the call.
          const calls = this.#app.phoneCalls;
          if (!note && calls?.ready() && s.phone) {
            const call = await calls.place({ to: s.phone, name: e.facts.merchant ?? e.contacts[0]?.name ?? '', script: s.script ?? '', errandId: e.id, conversationId: e.conversationId }).catch((err: Error) => {
              throw new ErrandError(409, err.message);
            });
            s.status = 'waiting_others';
            s.callId = call.id;
            delete s.pending;
            delete s.ask;
            e.status = 'waiting_others';
            this.#log(e, `Calling ${call.number} (call ${call.id}).`);
            break;
          }
          this.#done(e, s, note ?? T(en('You did this yourself.')), this.#you(note));
          break;
        }
        default:
          // confirm (hand-overs): the person did it.
          this.#done(e, s, note ?? T(en('You did this yourself.')), this.#you(note));
      }
      const saved = this.#save(e);
      if (saved.status === 'waiting_you') await this.#needsYou(saved);
      else if (!saved.steps.some((x) => x.status === 'todo' || x.status === 'waiting_others' || x.status === 'waiting_you') && saved.status === 'working') return this.#end(saved, 'done');
      return this.get(id)!;
    } finally {
      this.#running.delete(id);
    }
  }
  /** Skip the step that waits for the person (a follow-up skipped: no more follow-ups, the wait goes on). */
  skip(id: number): Errand {
    const e = this.#must(id);
    const s = e.steps.find((x) => x.status === 'waiting_you') ?? e.steps.find((x) => x.status === 'todo');
    if (!s) throw new ErrandError(409, en('Nothing is waiting for your OK on this errand.'));
    if (s.pending === 'follow_up') {
      s.status = 'waiting_others';
      s.followUps = ERRAND.maxFollowUps;
      delete s.pending;
      delete s.ask;
      delete s.draft;
      e.status = 'waiting_others';
      this.#log(e, 'You skipped the follow-up.');
    } else {
      s.status = 'skipped';
      s.result = this.#T(en('You skipped this step.'));
      delete s.pending;
      delete s.ask;
      e.status = 'working';
      this.#log(e, `Skipped: ${s.text}`);
    }
    return this.#save(e);
  }

  /**
   * R5: a call she placed for a step ended (src/phone-calls.ts). Answered: the step is done with the
   * summary and the provider's call id as evidence, the transcript goes to the errand's chat. No
   * answer or a failed call: the step waits for the person again (try again, or call yourself).
   */
  async callDone(id: number, call: { id: number; providerId: string | null; status: string; number: string; summary: string | null; transcript: { who: string; text: string }[]; seconds: number | null }): Promise<Errand | undefined> {
    const e = this.get(id);
    if (!e) return undefined;
    const s = e.steps.find((x) => x.kind === 'call' && x.callId === call.id);
    if (!s || e.status === 'done' || e.status === 'stopped') return e;
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const talked = call.status === 'done' && call.transcript.some((l) => l.who === 'them');
    if (!talked) {
      delete s.callId;
      this.#wait(e, s, 'call', `${call.status === 'failed' ? T(en('The call didn’t go through.')) : T(en('No answer at {number}.'), { number: call.number })} ${T(en('Approve to try again, or call yourself and tap Done.'))}`);
    } else {
      const mins = call.seconds ? `${Math.floor(call.seconds / 60)}:${String(call.seconds % 60).padStart(2, '0')}` : '';
      this.#done(e, s, call.summary ?? T(en('The call ended.')), { kind: 'tool', tool: 'phone_call', verified: 'verified', line: `Verified: the call to ${call.number} connected${mins ? ` and lasted ${mins}` : ''}${call.providerId ? ` (provider call ${call.providerId})` : ''}.`, ref: String(call.id), at: this.#now().toISOString() });
      const lines = call.transcript.map((l) => `${l.who === 'her' ? this.#app.persona.name || 'Sara' : T(en('Them'))}: ${l.text}`).join('\n');
      this.#say(e, `${T(en('Phone call with {who}'), { who: call.number })}\n${call.summary ?? ''}\n\n${T(en('Transcript:'))}\n${clip(lines, 3000)}`);
    }
    const saved = this.#save(e);
    if (saved.status === 'waiting_you') await this.#needsYou(saved);
    else if (!saved.steps.some((x) => x.status === 'todo' || x.status === 'waiting_others' || x.status === 'waiting_you') && saved.status === 'working') return this.#end(saved, 'done');
    return this.get(id);
  }

  // ------------------------------------------------------------ the runner

  /** The reminder tick: working errands take their next step; waits check follow-ups; deadlines end them. */
  due(now: Date = this.#now()): number {
    if (privateLocalOn()) return 0;
    let started = 0;
    let open: Errand[];
    try {
      open = this.list({ open: true });
    } catch {
      return 0;
    }
    for (const e of open) {
      if (this.#running.has(e.id) || e.status === 'planning') continue;
      if (e.deadline && this.#deadlinePassed(e.deadline, now)) {
        this.#end(e, 'stopped', this.#T(en('The deadline passed ({when}).'), { when: e.deadline }));
        continue;
      }
      if (e.status === 'working' || e.status === 'waiting_others') {
        const p = this.advance(e.id).catch((err: Error) => console.warn(`errand ${e.id}: ${err.message}`));
        this.#work.add(p);
        void p.finally(() => this.#work.delete(p));
        started++;
      }
    }
    return started;
  }
  #deadlinePassed(deadline: string, now: Date): boolean {
    // A date alone means the end of that day.
    const t = /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? Date.parse(`${deadline}T23:59:59Z`) : Date.parse(deadline);
    return Number.isFinite(t) && now.getTime() > t;
  }
  /** Waits for every background step (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  /** One step forward (the tick, or Next on the page). */
  async advance(id: number): Promise<Errand> {
    if (this.#running.has(id)) return this.#must(id);
    this.#running.add(id);
    try {
      const e = this.#must(id);
      if (e.status !== 'working' && e.status !== 'waiting_others') return e;
      const i = e.steps.findIndex((s) => s.status === 'todo' || s.status === 'waiting_others');
      if (i < 0) return this.#end(e, 'done');
      await this.#step(e, i);
      if ((e.status as ErrandStatus) === 'stopped' || (e.status as ErrandStatus) === 'done') return this.get(id)!;
      const saved = this.#save(e);
      if (saved.status === 'waiting_you') await this.#needsYou(saved);
      return saved;
    } finally {
      this.#running.delete(id);
    }
  }

  async #step(e: Errand, i: number, allowed = false): Promise<void> {
    const s = e.steps[i]!;
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const facts = { ...e.facts, owner: this.#app.settings.get().ownerName ?? '', goal: e.goal };
    switch (s.kind) {
      case 'research':
        return this.#research(e, s, facts, allowed);
      case 'browser':
        if (s.needsOk && !allowed) return this.#wait(e, s, 'browser', T(en('She does this in your browser only with your OK: {step}'), { step: s.text }));
        return this.#task(e, s, `${s.text}${e.facts.url ? ` (${e.facts.url})` : ''}`);
      case 'message':
        return this.#message(e, s, facts);
      case 'form': {
        const url = s.url ?? e.facts.url;
        if (!url) return this.#wait(e, s, 'confirm', T(en('There’s no page for this yet. Do it yourself and tap Done, or tell her the page.')));
        s.url = url;
        if (!this.#tool('pc_fill_form')) return this.#wait(e, s, 'confirm', T(en('Open {url} and fill it in (your saved details are in My details); tap Done when it’s sent.'), { url }));
        return this.#wait(e, s, 'form', T(en('Fill the form at {url} from My details? She stops before Submit.'), { url }));
      }
      case 'call': {
        // R5: a call she placed is under way: its end (PhoneCalls → callDone) moves the step on.
        if (s.status === 'waiting_others' && s.callId) {
          const c = this.#app.phoneCalls?.get(s.callId);
          if (c && (c.status === 'ringing' || c.status === 'live')) return;
          // The call ended without reaching this errand (a restart): ask again.
          delete s.callId;
          return this.#wait(e, s, 'call', T(en('Approve to try again, or call yourself and tap Done.')));
        }
        const phone = s.phone ?? e.facts.phone ?? '';
        const script = s.script ? fillIn(s.script, facts) : fillIn(CALL_SCRIPT, facts);
        s.phone = phone;
        s.script = script;
        const calls = this.#app.phoneCalls;
        // Phone calls set up and on: her own call, after its card (number, script, length, cost).
        if (calls?.ready() && phone) return this.#wait(e, s, 'call', `${T(en('Should she call now?'))}\n${calls.card({ to: phone, name: e.facts.merchant ?? e.contacts[0]?.name ?? '', script })}`);
        const why = calls && !calls.status().on ? '' : calls ? ` (${calls.missingText()})` : '';
        return this.#wait(e, s, 'call', `${T(en('Calling is not switched on; here’s the number and what to say:'))} ${phone || T(en('(no number found yet)'))}\n${script}${why}`);
      }
      case 'purchase': {
        const amount = s.amount ?? 0;
        if (e.budget !== null && e.spent + amount > e.budget) {
          this.#end(e, 'stopped', T(en('This would go over your budget of {budget} ({amount} more), so she stopped.'), { budget: `$${e.budget}`, amount: `$${amount}` }));
          return;
        }
        const url = s.url ?? e.facts.url ?? '';
        return this.#wait(e, s, 'purchase', `${T(en('Here’s the page, you pay: {url}'), { url: url || '—' })}${amount ? ` (${T(en('about {amount}'), { amount: `$${amount}` })})` : ''}`);
      }
      case 'decide':
        return this.#decide(e, s);
      case 'wait':
        return this.#waitStep(e, i);
    }
  }

  #collect(e: Errand, s: Step, out: string): void {
    const want = s.collect ?? [];
    const own = this.#own();
    const set = (k: string, v: string | undefined) => {
      if (v && !e.facts[k]) e.facts[k] = line(v, 300);
    };
    if (want.includes('amount')) set('amount', AMOUNT.exec(out)?.[0]?.replace(/\s/g, ''));
    if (want.includes('order')) set('order', ORDER.exec(out)?.[1]);
    if (want.includes('date')) set('date', DATE.exec(out)?.[0]);
    if (want.includes('merchant')) set('merchant', FROM.exec(out)?.[1]);
    const emails = [...new Set((out.match(EMAIL) ?? []).map((x) => x.toLowerCase()))].filter((x) => !own.includes(x));
    if (want.includes('email')) set('email', emails[0]);
    if (want.includes('emails') && emails.length) e.facts.emails = emails.slice(0, 3).join(', ');
    if (want.includes('phone')) set('phone', PHONE.exec(out)?.[0]);
    if (want.includes('url')) set('url', URL.exec(out)?.[0]);
    if (want.includes('list')) {
      const f = foundIn(out, own);
      if (f.length) e.found = f.slice(0, 3);
      const fe = e.found.map((x) => x.email).filter(Boolean);
      if (fe.length && !e.facts.emails) e.facts.emails = fe.join(', ');
    }
  }

  async #research(e: Errand, s: Step, facts: Record<string, string>, allowed: boolean): Promise<void> {
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    if (!s.tool) {
      const list = e.found.length ? `\n${e.found.map((f) => `- ${f.name}${f.url ? ` ${f.url}` : ''}${f.phone ? ` ${f.phone}` : ''}`).join('\n')}` : '';
      return this.#task(e, s, `${s.text}${list}`);
    }
    const tool = this.#tool(s.tool);
    const args = Object.fromEntries(Object.entries(s.args ?? {}).map(([k, v]) => [k, typeof v === 'string' ? fillIn(v, facts) : v]).filter(([, v]) => v !== ''));
    if (!tool) {
      // The tool isn't here (no mailbox connected, a computer tool on a server): a normal turn instead.
      return this.#task(e, s, s.text);
    }
    const perm = this.#permission(s.tool);
    if (perm === 'never') {
      s.status = 'skipped';
      s.result = T(en('{tool} is turned off (set to never), so she skipped this step.'), { tool: s.tool });
      return;
    }
    if (perm === 'ask' && !allowed) return this.#wait(e, s, 'tool', T(en('Let her use {tool} for “{step}”?'), { tool: s.tool, step: s.text }));
    try {
      const out = await tool.run(args, this.#ctx(e));
      this.#collect(e, s, out);
      let shown = out.replace(UNTRUSTED_LINE, '');
      // A receipt search shows snippets: read the first email for the amount and date (read only).
      const read = this.#tool('mail_read');
      const first = /\[([^\]\s]+)\]/.exec(out)?.[1];
      if (s.tool === 'mail_search' && s.collect?.includes('amount') && !e.facts.amount && first && read && this.#permission('mail_read') === 'auto') {
        const full = await read.run({ id: first, ...(args.account ? { account: args.account } : {}) }, this.#ctx(e)).catch(() => '');
        if (full) {
          this.#collect(e, s, full);
          shown += `\n${this.#T(en('Read the first email:'))} ${clip(full.replace(UNTRUSTED_LINE, '').replace(/\s+/g, ' '), 400)}`;
        }
      }
      this.#done(e, s, shown, await this.#evidence(s.tool, args, out));
    } catch (err) {
      this.#wait(e, s, 'retry', T(en('This step didn’t work: {why}. Try again or skip it.'), { why: clip((err as Error).message, 200) }));
    }
  }

  async #task(e: Errand, s: Step, what: string): Promise<void> {
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const conversationId = this.#conversation(e);
    e.conversationId = conversationId;
    const content = `${what}\n\n(This is one step of my errand “${e.goal}”. What we know: ${JSON.stringify(e.facts)}. Do only this step; anything that changes something still needs my OK.)`;
    const res = await (this.#o.runTask ?? ((r) => this.#defaultTask(r)))({ errand: e, conversationId, content });
    if (res.declined) {
      s.status = 'skipped';
      s.result = T(en('You declined her step, so she skipped it.'));
      return;
    }
    if (res.error) return this.#wait(e, s, 'retry', T(en('This step didn’t work: {why}. Try again or skip it.'), { why: clip(res.error, 200) }));
    this.#collect(e, s, res.reply);
    res.reply = res.reply.replace(UNTRUSTED_LINE, '');
    this.#done(e, s, res.reply || T(en('She did this step.')), { kind: 'turn', verified: 'read', line: this.#T(en('Her turn in the errand’s chat (its own approvals).')), ref: conversationId, at: this.#now().toISOString() });
  }

  async #defaultTask(r: { errand: Errand; conversationId: string; content: string }): Promise<{ reply: string; error?: string; declined?: boolean }> {
    const app = this.#app;
    if (!app.runTracked) return { reply: '', error: 'this server cannot run turns in the background' };
    if (app.isBusy?.(r.conversationId)) return { reply: '', error: 'she is still working in its chat' };
    let step = '';
    let replaced: string | undefined;
    let error = '';
    let asked = false;
    let declined = false;
    try {
      await app.runTracked(
        r.conversationId,
        r.content,
        (ev: ChatEvent) => {
          if (ev.type === 'token') step += ev.text;
          else if (ev.type === 'tool_call') step = '';
          else if (ev.type === 'replace') replaced = ev.text;
          else if (ev.type === 'error') error = ev.message;
          else if (ev.type === 'approval') asked = true;
          else if (ev.type === 'tool_result' && asked && ev.status === 'denied') declined = true;
        },
        { budget: { tokens: ERRAND.taskTokens, minutes: ERRAND.taskMinutes } },
      );
    } catch (err) {
      error = (err as Error).message;
    }
    return { reply: clip((replaced ?? step).replace(/\s+/g, ' ').trim(), 1200), ...(error ? { error: clip(error, 200) } : {}), ...(declined ? { declined } : {}) };
  }

  async #message(e: Errand, s: Step, facts: Record<string, string>): Promise<void> {
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const to = fillIn(s.to ?? '{email}', facts)
      .split(/[,;\s]+/)
      .filter((x) => /@/.test(x))
      .slice(0, 3)
      .join(', ');
    if (!to) {
      // No address: their booking page (a form), else their number (a call), else ask the person.
      if (e.facts.url && !e.facts.email) {
        s.kind = 'form';
        s.url = e.facts.url;
        s.text = `${s.text} (${T(en('their booking page'))})`;
        return this.#step(e, e.steps.indexOf(s));
      }
      if (e.facts.phone) {
        s.kind = 'call';
        s.phone = e.facts.phone;
        return this.#step(e, e.steps.indexOf(s));
      }
      return this.#wait(e, s, 'address', T(en('Who should this go to? Add their email address.')));
    }
    s.draft = { to, subject: clip(fillIn(s.subject ?? e.goal, facts), 200), body: fillIn(s.body ?? e.goal, facts) };
    if (e.sendWithoutAsking && this.#tool('mail_send') && this.#permission('mail_send') !== 'never') return this.#send(e, s, s.draft);
    this.#wait(e, s, 'send', `${T(en('Send this email to {to}: “{subject}”?'), { to, subject: s.draft.subject })}\n\n${s.draft.body}`);
  }

  /** Sends through mail_send (each recipient on their own), with the N1 read-back as evidence. */
  async #send(e: Errand, s: Step, draft: EmailDraft, followUp = false): Promise<void> {
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const tool = this.#tool('mail_send');
    if (!tool) return this.#wait(e, s, 'confirm', T(en('No mailbox is connected. Connect one in Settings, or send it yourself and tap Done.')));
    if (this.#permission('mail_send') === 'never') return this.#wait(e, s, 'confirm', T(en('Sending email is turned off (mail_send is set to never). Turn it on, or send it yourself and tap Done.')));
    const lines: string[] = [];
    let worst: Evidence | undefined;
    for (const to of draft.to.split(/,\s*/).filter(Boolean)) {
      const args = { to, subject: draft.subject, body: draft.body };
      let out: string;
      try {
        out = await tool.run(args, this.#ctx(e));
      } catch (err) {
        return this.#wait(e, s, followUp ? 'follow_up' : 'send', T(en('Sending didn’t work: {why}. Try again, or skip it.'), { why: clip((err as Error).message, 200) }));
      }
      const ev = await this.#evidence('mail_send', args, out);
      if (!worst || ev.verified === 'unverified') worst = ev;
      lines.push(T(en('Sent to {to}: “{subject}”'), { to, subject: draft.subject }));
      if (!e.contacts.some((c) => c.email?.toLowerCase() === to.toLowerCase())) e.contacts.push({ email: to });
    }
    e.facts.subject = draft.subject;
    e.facts.sent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(this.#app.settings.get().timeZone ? { timeZone: this.#app.settings.get().timeZone } : {}) }).format(this.#now());
    if (followUp) {
      s.followUps = (s.followUps ?? 0) + 1;
      s.since = this.#now().toISOString();
      s.status = 'waiting_others';
      s.result = `${s.result ? `${s.result}\n` : ''}${T(en('Followed up.'))} ${lines.join(' · ')}`;
      delete s.pending;
      delete s.ask;
      delete s.draft;
      e.status = 'waiting_others';
      this.#log(e, lines.join(' · '));
      return;
    }
    s.sentAt = this.#now().toISOString();
    this.#done(e, s, lines.join(' · '), worst!);
  }

  async #decide(e: Errand, s: Step): Promise<void> {
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const fromReplies = e.replies.map((r) => r.from);
    const options = s.options?.length ? s.options : e.found.length ? e.found.map((f) => f.name) : fromReplies;
    s.options = options.slice(0, 6);
    const tool = this.#tool('compare');
    if (tool && options.length >= 2) {
      const items = options.map((name) => {
        const f = e.found.find((x) => x.name === name);
        const r = e.replies.find((x) => x.from === name);
        return { name, values: { ...(f?.phone ? { Phone: f.phone } : {}), ...(f?.url ? { Page: f.url } : {}), ...(f?.email ? { Email: f.email } : {}), ...(r ? { Answer: r.summary } : {}) } };
      });
      try {
        s.result = clip(await tool.run({ title: e.goal, items }, this.#ctx(e)), 1500);
      } catch {
        /* the list alone is enough to choose from */
      }
    }
    this.#wait(e, s, 'decide', options.length ? T(en('Pick one: {options}'), { options: options.join(' · ') }) : T(en('What do you choose? Say it in your own words.')));
  }

  #waitStep(e: Errand, i: number): void {
    const s = e.steps[i]!;
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const sent = e.steps.slice(0, i).some((x) => x.kind === 'message' && x.sentAt);
    if (!sent) {
      s.status = 'skipped';
      s.result = T(en('Nothing was sent, so there is nothing to wait for.'));
      e.status = 'working';
      return;
    }
    if (s.status !== 'waiting_others') {
      s.status = 'waiting_others';
      s.since = this.#now().toISOString();
      e.status = 'waiting_others';
      this.#log(e, 'Waiting for their answer.');
      return;
    }
    e.status = 'waiting_others';
    const days = s.followUpDays ?? ERRAND.followUpDays;
    if ((s.followUps ?? 0) >= ERRAND.maxFollowUps || this.#now().getTime() - Date.parse(s.since ?? e.updatedAt) < days * 86_400_000) return;
    const to = e.contacts.filter((c) => c.email && !c.replied).map((c) => c.email!).join(', ');
    if (!to) return;
    const facts = { ...e.facts, owner: this.#app.settings.get().ownerName ?? '', goal: e.goal };
    s.draft = { to, subject: `Re: ${e.facts.subject ?? e.goal}`, body: fillIn(LETTER.follow, facts) };
    if (e.sendWithoutAsking && this.#tool('mail_send') && this.#permission('mail_send') !== 'never') {
      void this.#send(e, s, s.draft, true);
      return;
    }
    this.#wait(e, s, 'follow_up', `${T(en('No reply in {n} days. Send this follow-up to {to}?'), { n: days, to })}\n\n${s.draft.body}`);
  }

  // ------------------------------------------------------------ replies

  /** A new mail (the inbox helper's scan): a reply from a contact, or in the thread, advances a waiting step. Never throws. */
  observeMail(m: InboxMail): number[] {
    const out: number[] = [];
    try {
      const from = addressOf(m.from);
      if (this.#own().includes(from)) return out;
      const subj = normSubject(m.subject ?? '');
      for (const e of this.list({ open: true })) {
        const s = e.steps.find((x) => x.kind === 'wait' && (x.status === 'waiting_others' || (x.status === 'waiting_you' && x.pending === 'follow_up')));
        if (!s) continue;
        const contact = e.contacts.find((c) => c.email?.toLowerCase() === from);
        const inThread = Boolean(e.facts.subject && subj && subj === normSubject(e.facts.subject));
        if (!contact && !inThread) continue;
        if (e.replies.some((r) => r.id === m.id)) continue;
        const summary = replySummary(m.text ?? '');
        const who = contact?.name ?? m.from.replace(/\s*<[^>]+>/, '').trim() ?? from;
        if (contact) contact.replied = true;
        e.replies.push({ from: who || from, summary, id: m.id, at: this.#now().toISOString() });
        const text = this.#T(en('Reply from {from}: {summary}'), { from: who || from, summary });
        const waitingOn = e.contacts.filter((c) => c.email && !c.replied);
        if (s.waitFor === 'all' && waitingOn.length) {
          s.result = `${s.result ? `${s.result}\n` : ''}${text}`;
          this.#log(e, text);
        } else {
          delete s.draft;
          this.#done(e, s, `${s.result ? `${s.result}\n` : ''}${text}`, { kind: 'mail', verified: 'verified', line: `${VERIFIED} ${this.#T(en('the reply is in your mailbox ({account}, email {id}).'), { account: m.account, id: m.id })}`, ref: m.id, at: this.#now().toISOString() });
        }
        const saved = this.#save(e);
        const title = this.#T(en('Errand: {from} answered'), { from: who || from });
        this.#say(saved, `${title}\n${summary}`);
        void this.#push(saved, title, summary);
        out.push(e.id);
      }
    } catch (err) {
      console.warn(`errands: ${(err as Error).message}`);
    }
    return out;
  }

  // ------------------------------------------------------------ words and the Today tile

  /** One errand in plain words, with each step's evidence (her errand_status). */
  statusText(e: Errand): string {
    const mark: Record<StepStatus, string> = { todo: ' ', waiting_you: '!', waiting_others: '…', done: 'x', skipped: '-' };
    const lines = [`Errand #${e.id} “${e.goal}” · ${e.status.replace('_', ' ')}${e.deadline ? ` · deadline ${e.deadline}` : ''}${e.budget !== null ? ` · budget $${e.budget} (paid $${e.spent})` : ''}${e.sendWithoutAsking ? ' · sends without asking' : ''}`];
    e.steps.forEach((s, i) => {
      lines.push(`${i + 1}. [${mark[s.status]}] ${s.kind}: ${s.text}${s.result ? ` → ${clip(s.result.replace(/\s+/g, ' '), 300)}` : ''}`);
      if (s.evidence?.line) lines.push(`   ${s.kind === 'message' && s.sentAt && s.evidence.verified === 'verified' ? ERRAND_SENT : 'Evidence: '}${s.evidence.line}`);
    });
    if (e.needs) lines.push(`Needs ${this.#app.settings.get().ownerName || 'you'}: ${clip(e.needs, 600)}`);
    if (e.summary) lines.push(`Summary: ${e.summary}`);
    return lines.join('\n');
  }
  /** Today: a tile only when an errand is open; the ones waiting on the person first. */
  todayTile(): { needYou: number; items: { id: number; goal: string; status: ErrandStatus; needs: string | null; next: string | null; done: number; total: number }[] } | undefined {
    const open = this.list({ open: true });
    if (!open.length) return undefined;
    const rank: Record<string, number> = { waiting_you: 0, planning: 1, working: 2, waiting_others: 3 };
    const items = open
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.id - a.id)
      .slice(0, 5)
      .map((e) => ({ id: e.id, goal: e.goal, status: e.status, needs: e.needs ? clip(e.needs.split('\n')[0]!, 160) : null, next: e.steps.find((s) => s.status !== 'done' && s.status !== 'skipped')?.text ?? null, done: e.steps.filter((s) => s.status === 'done').length, total: e.steps.length }));
    return { needYou: open.filter((e) => e.status === 'waiting_you').length, items };
  }
}

/** This space's errands (made on first use; members get their own in their own store). */
export function errandsFor(app: AppContext): Errands {
  app.errands ??= new Errands(app, app.store.db);
  return app.errands;
}
