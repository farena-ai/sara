// C12 (docs/ops/C12_DESIGN.md): "How to work with you". A small model of how the owner likes to
// work, kept as beliefs: a claim (one of a fixed set of traits and values), where it holds
// (everywhere, one project, one channel), evidence for and against (message ids, never copied
// text), a confidence that fades unless seen again, and a status:
//   candidate → held (seen in 2+ sessions) → confirmed (he said so, or pressed Confirm)
//   contested (seen the other way: she asks once) · retired (faded, replaced, Not true).
// Learning: observe() is a cheap per-turn pattern pass over his own message (usually nothing; her
// replies, imported, private, partner, group, adult-channel and other apps' lines never count);
// the nightly pass (the reminder tick, quiet hours, like the overnight tidy) retires what has
// faded and notices his usual hours. Hard exclusions are enforced here, in code: nothing about
// health, religion, politics, sexuality, personality typing, credentials, or generalising about
// other people is ever learned. Use: held/confirmed beliefs become a short, capped "How to work
// with <name>" note at the provider boundary; a newly held one is announced once, briefly.
// Each space (household member, companion) has its own tables in its own store; work (EC26) and
// personal beliefs are kept apart by `side`.
//
// Tables (additive, the space's own store.db): working_traits, working_trait_evidence,
// working_style_seen (message id + time only, for usual hours), working_style_meta.
import type { DatabaseSync } from 'node:sqlite';
import { attributableClauses } from './attunement.ts';
import type { AppContext, TurnOptions } from './chat.ts';
import { HttpError } from './http.ts';
import { proactiveSettings, inQuiet } from './life.ts';
import { zonedParts } from './planner.ts';
import { policy } from './policy-profile.ts';
import { importedOther, type Conversation, type StoredMessage } from './store.ts';
import { spaceOf, type Space } from './work-profile.ts';

export const STYLE = { halfLifeDays: 45, heldAt: 0.5, fadeBelow: 0.35, retireBelow: 0.15, stated: 0.9, noteChars: 700, hoursMin: 20, hoursDays: 5, hoursShare: 0.6, seenKeepDays: 60 } as const;

export type TraitKey = 'reply-length' | 'options' | 'ask-first' | 'formality' | 'expertise' | 'hours' | 'feedback';
export type BeliefStatus = 'candidate' | 'held' | 'confirmed' | 'contested' | 'retired';
export type Scope = 'everywhere' | 'project' | 'channel';
export const TRAITS: Record<TraitKey, readonly string[]> = {
  'reply-length': ['short', 'long'],
  options: ['one', 'options'],
  'ask-first': ['ask', 'go'],
  formality: ['casual', 'formal'],
  expertise: ['new', 'expert'],
  hours: ['morning', 'afternoon', 'evening', 'night'],
  feedback: ['direct', 'gentle'],
};
export interface Observation { trait: TraitKey; value: string; domain: string; stated: boolean }
export interface Belief {
  id: number;
  side: Space;
  trait: TraitKey;
  value: string;
  domain: string;
  scope: Scope;
  scopeKey: string;
  status: BeliefStatus;
  stated: boolean;
  confidence: number;
  evidenceFor: number;
  evidenceAgainst: number;
  /** Distinct conversations (sessions) the supporting evidence came from. */
  sessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface RecordCtx { messageId: number; conversationId: string; side: Space; scope: Scope; scopeKey: string }

// ---------------------------------------------------------------- hard exclusions

export type Excluded = 'health' | 'religion' | 'politics' | 'sexuality' | 'personality' | 'credentials' | 'others';
const word = (src: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`, 'iu');
const EXCLUDE: [Excluded, RegExp][] = [
  ['health', word("health\\w*|sick\\w*|illness\\w*|disease\\w*|diagnos\\w*|symptom\\w*|medic\\w*|meds|pills?|therap\\w*|depress\\w*|anxiety|anxious|adhd|autis\\w*|bipolar|ptsd|ocd|cancer|tumou?r|diabet\\w*|insulin|pregnan\\w*|disabilit\\w*|disabled|chronic|migraine\\w*|surgery|doctor\\w*|hospital\\w*|clinic\\w*|mental|psychiatr\\w*|suicid\\w*|self-harm|eating disorder|allerg\\w*|injur\\w*|weight loss|dementia|alzheimer\\w*")],
  ['religion', word("relig\\w*|god|gods|church\\w*|pray\\w*|faith|bible|qur'?an|koran|torah|mosque\\w*|synagogue\\w*|temple\\w*|christ\\w*|catholic\\w*|protestant\\w*|muslim\\w*|islam\\w*|jews?|jewish|judaism|hindu\\w*|buddhis\\w*|atheis\\w*|agnostic\\w*|sikh\\w*|spiritual\\w*|mormon\\w*|evangelical\\w*")],
  ['politics', word("politic\\w*|election\\w*|vote|voting|voted|voter\\w*|democrat\\w*|republican\\w*|liberal\\w*|conservative\\w*|left-wing|right-wing|leftist\\w*|socialis\\w*|communis\\w*|fascis\\w*|parliament\\w*|congress\\w*|senator\\w*|president\\w*|trump|biden|maga|immigration|abortion|partisan")],
  ['sexuality', word('gay|lesbian\\w*|bisexual\\w*|queer|homosexual\\w*|heterosexual\\w*|asexual\\w*|pansexual\\w*|sexual\\w*|sex|orientation|transgender|trans|nonbinary|non-binary|kink\\w*|lgbt\\w*')],
  ['personality', word('mbti|myers-?briggs|enneagram|big five|introvert\\w*|extrovert\\w*|ambivert\\w*|[ie][ns][tf][jp]s?|personality types?|personality tests?|zodiac|astrolog\\w*|horoscope\\w*|star sign|narcissis\\w*|psychopath\\w*|sociopath\\w*|empath')],
  ['credentials', word('password\\w*|passcode\\w*|passphrase\\w*|pin code|pin number|api keys?|secret keys?|access tokens?|tokens?|2fa|otp|one-time code|social security|ssn|credit cards?|card numbers?|iban|account numbers?|login details|private keys?|seed phrase')],
  ['others', word("(?:women|men|girls|boys|guys|people|everyone|everybody|millennials|boomers|gen z|americans|europeans|foreigners|immigrants|old people|young people|kids these days|my (?:wife|husband|partner|girlfriend|boyfriend|boss|coworkers?|colleagues?|team|kids|children|mother|father|mom|mum|dad|parents|friends?|neighbou?rs?))\\s+(?:are|is|always|never|tend to|can'?t|don'?t|all)")],
];
const fold = (s: string) => s.replace(/[’‘]/g, "'").toLowerCase();

/** The excluded category the text touches (whole message, a domain, a claim), or null. */
export function excludedTopic(text: string): Excluded | null {
  const t = fold(text);
  for (const [cat, re] of EXCLUDE) if (re.test(t)) return cat;
  return null;
}

// ---------------------------------------------------------------- the per-turn extractor

type Rule = { trait: TraitKey; value: string; stated: boolean; re: RegExp };
const R = (trait: TraitKey, value: string, stated: boolean, src: string): Rule => ({ trait, value, stated, re: word(src) });
const RULES: Rule[] = [
  R('reply-length', 'short', true, "i (?:prefer|like|want) (?:short|shorter|brief|concise)(?: answers| replies)?|(?:please )?always keep (?:it|them|answers|replies|your answers) (?:short|brief)|from now on,? keep (?:it|them) (?:short|brief)|keep your (?:answers|replies) (?:short|brief)"),
  R('reply-length', 'short', false, "too long|tl;?dr|shorter please|(?:be )?more concise|keep it (?:short|brief)|cut it down|less detail|too much detail|too wordy|shorter,? please"),
  R('reply-length', 'long', true, 'i (?:prefer|like|want) (?:long|longer|detailed|in-depth|fuller) (?:answers|replies|explanations)'),
  R('reply-length', 'long', false, 'more detail|go deeper|elaborate|too short|explain more|in more depth|longer please'),
  R('options', 'one', true, 'i (?:prefer|want|like) (?:one|a single) (?:recommendation|answer|pick)|always (?:just )?(?:give me|pick) one'),
  R('options', 'one', false, 'just pick one|pick one for me|just tell me which|just recommend one|give me your (?:top |best )?pick'),
  R('options', 'options', true, 'i (?:prefer|like|want) (?:options|alternatives|choices)|always give me (?:options|alternatives|choices)'),
  R('options', 'options', false, 'give me (?:a few |some |more |the )?(?:options|alternatives|choices)|show me (?:some )?alternatives'),
  R('ask-first', 'ask', true, "always ask(?: me)? (?:first|before)|check with me (?:first|before)|don'?t (?:do|change|send|delete|touch) (?:anything|things|it)? ?without (?:asking|checking)"),
  R('ask-first', 'ask', false, "ask me (?:first|before)|you should have asked|should'?ve asked"),
  R('ask-first', 'go', true, "you (?:don'?t|do not) (?:need|have) to ask|stop asking (?:me )?(?:for permission|first)"),
  R('ask-first', 'go', false, "just do it|don'?t ask|go ahead without asking|no need to ask"),
  R('formality', 'casual', true, 'i prefer (?:a )?(?:casual|informal|relaxed)(?: tone)?'),
  R('formality', 'casual', false, 'no need to be (?:so )?formal|be (?:more )?casual|less formal|drop the formal\\w*'),
  R('formality', 'formal', true, 'i prefer (?:a )?(?:formal|professional)(?: tone)?'),
  R('formality', 'formal', false, 'be (?:more )?(?:formal|professional)|less casual|too casual'),
  R('feedback', 'direct', true, 'i (?:prefer|like|want) (?:blunt|direct|honest|straight) feedback'),
  R('feedback', 'direct', false, "be (?:blunt|direct|brutally honest|honest with me)|don'?t sugar-?coat|no sugar-?coating|tell me straight"),
  R('feedback', 'gentle', true, 'i (?:prefer|like|want) (?:gentle|kind|soft) feedback'),
  R('feedback', 'gentle', false, 'be (?:gentle|gentler|kinder|softer)|go easy on me|too harsh'),
];
const DOMAIN = "([a-z0-9+#][a-z0-9+#.\\-]*(?: [a-z0-9+#][a-z0-9+#.\\-]*){0,2}?)(?=\\s*(?:$|[.,;!:]|\\s(?:so|and|but|for|yet|though|now)\\b))";
const EXPERTISE: { value: 'new' | 'expert'; re: RegExp }[] = [
  { value: 'new', re: new RegExp(`(?:i'?m|i am) (?:new to|a beginner (?:at|in|with)|a novice (?:at|in|with)|just starting (?:out )?(?:with|in)|learning) ${DOMAIN}`, 'iu') },
  { value: 'new', re: new RegExp(`i (?:don'?t|do not) know much about ${DOMAIN}`, 'iu') },
  { value: 'expert', re: new RegExp(`(?:i'?m|i am) (?:an? )?(?:expert|pro|professional|senior|experienced|very experienced) (?:in|at|with|on) ${DOMAIN}`, 'iu') },
  { value: 'expert', re: new RegExp(`i(?:'ve| have) been (?:doing|using|working (?:in|with)) ${DOMAIN} for (?:\\d+|many|years|decades)`, 'iu') },
  { value: 'expert', re: new RegExp(`i know ${DOMAIN} (?:really |very )?well`, 'iu') },
];
const VAGUE = new Set(['it', 'this', 'that', 'things', 'everything', 'anything', 'here', 'you', 'all', 'stuff', 'them', 'the', 'a']);

/** His plain statements in one message (questions, hypotheticals, quotes, reported speech removed). */
export function observe(text: string): Observation[] {
  if (!text || text.length > 4000 || excludedTopic(text)) return [];
  const clauses = attributableClauses(text.replace(/[’‘]/g, "'")).map((c) => fold(c.text));
  if (!clauses.length) return [];
  const found = new Map<string, Observation>();
  for (const c of clauses) {
    for (const r of RULES) {
      if (!r.re.test(c)) continue;
      const k = `${r.trait}|${r.value}|`;
      const had = found.get(k);
      found.set(k, { trait: r.trait, value: r.value, domain: '', stated: r.stated || Boolean(had?.stated) });
    }
    for (const e of EXPERTISE) {
      const m = e.re.exec(c);
      const domain = m?.[1]?.trim().replace(/\.+$/, '');
      if (!domain || VAGUE.has(domain) || domain.length > 40 || excludedTopic(domain)) continue;
      found.set(`expertise|${e.value}|${domain}`, { trait: 'expertise', value: e.value, domain, stated: true });
    }
  }
  // "ask me first … just do it" in one message: no evidence either way.
  const out = [...found.values()];
  return out.filter((o) => !out.some((x) => x !== o && x.trait === o.trait && x.domain === o.domain && x.value !== o.value));
}

// ---------------------------------------------------------------- words for the model

const LINE: Record<string, (d: string, who: string) => string> = {
  'reply-length:short': () => 'Keep replies short.',
  'reply-length:long': (_d, who) => `${who} likes fuller, detailed replies.`,
  'options:one': () => 'Give one clear recommendation rather than a list of options.',
  'options:options': () => 'Offer a few options with their trade-offs.',
  'ask-first:ask': () => 'Ask before you act (changing, sending or deleting anything).',
  'ask-first:go': (_d, who) => `${who} is fine with you going ahead on routine steps without asking (approvals still apply).`,
  'formality:casual': () => 'Keep the tone casual.',
  'formality:formal': () => 'Keep the tone formal and professional.',
  'feedback:direct': () => 'Be direct: say plainly what is wrong.',
  'feedback:gentle': () => 'Give feedback gently.',
  'expertise:new': (d, who) => `${who} is new to ${d}: explain terms.`,
  'expertise:expert': (d, who) => `${who} knows ${d} well: skip the basics.`,
  'hours:morning': (_d, who) => `${who} usually writes in the morning (local time).`,
  'hours:afternoon': (_d, who) => `${who} usually writes in the afternoon (local time).`,
  'hours:evening': (_d, who) => `${who} usually writes in the evening (local time).`,
  'hours:night': (_d, who) => `${who} usually writes late at night (local time).`,
};
const NOTICED: Record<string, (d: string) => string> = {
  'reply-length:short': () => "I've noticed you prefer short answers; I'll keep them short. Say if not.",
  'reply-length:long': () => "I've noticed you like fuller answers; I'll go into more detail. Say if not.",
  'options:one': () => "I've noticed you like one clear pick; I'll give you my recommendation. Say if not.",
  'options:options': () => "I've noticed you like a few options; I'll lay them out. Say if not.",
  'ask-first:ask': () => "I've noticed you like me to ask before I act here; I'll check first. Say if not.",
  'ask-first:go': () => "I've noticed you'd rather I just get on with routine steps; I'll ask less. Say if not.",
  'formality:casual': () => "I've noticed you prefer it casual; I'll keep it relaxed. Say if not.",
  'formality:formal': () => "I've noticed you prefer a formal tone; I'll keep it professional. Say if not.",
  'feedback:direct': () => "I've noticed you like it straight; I'll be direct. Say if not.",
  'feedback:gentle': () => "I've noticed you prefer gentle feedback; I'll go easy. Say if not.",
  'expertise:new': (d) => `I've noticed you're new to ${d}; I'll explain the terms. Say if not.`,
  'expertise:expert': (d) => `I've noticed you know ${d} well; I'll skip the basics. Say if not.`,
  'hours:morning': () => "I've noticed you usually write in the morning. Say if that's wrong.",
  'hours:afternoon': () => "I've noticed you usually write in the afternoon. Say if that's wrong.",
  'hours:evening': () => "I've noticed you usually write in the evening. Say if that's wrong.",
  'hours:night': () => "I've noticed you usually write late at night. Say if that's wrong.",
};
const SHORT: Record<string, (d: string) => string> = {
  'reply-length:short': () => 'short answers', 'reply-length:long': () => 'more detail',
  'options:one': () => 'one recommendation', 'options:options': () => 'a few options',
  'ask-first:ask': () => 'being asked first', 'ask-first:go': () => 'you going ahead without asking',
  'formality:casual': () => 'a casual tone', 'formality:formal': () => 'a formal tone',
  'feedback:direct': () => 'blunt feedback', 'feedback:gentle': () => 'gentle feedback',
  'expertise:new': (d) => `explanations of ${d} basics`, 'expertise:expert': (d) => `skipping the ${d} basics`,
  'hours:morning': () => 'mornings', 'hours:afternoon': () => 'afternoons', 'hours:evening': () => 'evenings', 'hours:night': () => 'late nights',
};

// ---------------------------------------------------------------- the store

type Row = Record<string, unknown>;
const DENIED = ['externalApp', 'outside', 'clientHistory', 'clientNote', 'group', 'untrusted', 'roomNote', 'roomNow', 'roomId', 'roomCrisis', 'replay', 'recorder', 'voiceRoom', 'persist'] as const;
// His own direct chats (the owner-evidence channels; shared work channels and adult channels never).
const CHANNEL = /^(?:web|telegram|discord|plugin-[a-z0-9-]+)$/;
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export class WorkingStyle {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`
CREATE TABLE IF NOT EXISTS working_traits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  side TEXT NOT NULL,
  trait TEXT NOT NULL,
  value TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'everywhere',
  scope_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  stated INTEGER NOT NULL DEFAULT 0,
  why TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  announced_at TEXT,
  asked_at TEXT,
  UNIQUE (side, trait, domain, scope, scope_key, value)
);
CREATE TABLE IF NOT EXISTS working_trait_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trait_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  dir INTEGER NOT NULL,
  stated INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  UNIQUE (trait_id, message_id)
);
CREATE INDEX IF NOT EXISTS working_trait_evidence_trait ON working_trait_evidence(trait_id);
CREATE TABLE IF NOT EXISTS working_style_seen (message_id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, side TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS working_style_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
  }

  // ---- settings

  pinnedOff(): boolean {
    return policy().pins.workingStyle === false;
  }

  settings(): { on: boolean } {
    return { on: (this.#app.settings.get() as { workingStyle?: { on?: boolean } }).workingStyle?.on !== false };
  }

  setSettings(body: { on?: unknown }): { on: boolean } {
    const on = body.on === undefined ? this.settings().on : body.on === true;
    if (on && this.pinnedOff()) throw new HttpError(403, 'Learning how you like to work is turned off by your admin.');
    this.#app.settings.update({ workingStyle: { on } } as never);
    return { on };
  }

  /** Learning and use are on: his switch, the admin's pin, memory itself. */
  active(): boolean {
    return this.settings().on && !this.pinnedOff() && this.#app.settings.get().memory?.enabled !== false && !this.#app.demo && !this.#app.offRecord;
  }

  // ---- gates

  #conversationOk(conv: Conversation, turn: Partial<TurnOptions>, learning: boolean): boolean {
    if (!this.active() || DENIED.some((k) => Object.hasOwn(turn, k))) return false;
    if (conv.partner || !['chat', 'coding'].includes(conv.mode) || !CHANNEL.test(conv.channel)) return false;
    if (conv.channelKey?.startsWith('room:') || (conv.channel.startsWith('telegram') && conv.channelKey?.startsWith('-'))) return false;
    if (learning && (conv.private || conv.archivedAt || importedOther(conv))) return false;
    return true;
  }

  #scopeFor(trait: TraitKey, conv: Conversation): { scope: Scope; scopeKey: string } {
    if (trait === 'ask-first' && conv.projectId) return { scope: 'project', scopeKey: String(conv.projectId) };
    if (trait === 'formality' && conv.channel !== 'web') return { scope: 'channel', scopeKey: conv.channel };
    return { scope: 'everywhere', scopeKey: '' };
  }

  /** The per-turn pass over one of his own messages. Returns the beliefs it touched. */
  learnFrom(conv: Conversation, msg: StoredMessage, turn: Partial<TurnOptions>): Belief[] {
    if (msg.role !== 'user' || msg.conversationId !== conv.id || !this.#conversationOk(conv, turn, true)) return [];
    const meta = msg.meta ?? {};
    if (meta.importedFrom !== undefined || meta.untrusted === true || meta.herPast === true) return [];
    const side = spaceOf(this.#app, conv);
    this.#db.prepare('INSERT OR IGNORE INTO working_style_seen (message_id, conversation_id, side, at) VALUES (?, ?, ?, ?)').run(msg.id, conv.id, side, this.#app.now().toISOString());
    const out: Belief[] = [];
    for (const o of observe(msg.content)) {
      const b = this.record(o, { messageId: msg.id, conversationId: conv.id, side, ...this.#scopeFor(o.trait, conv) });
      if (b) out.push(b);
    }
    return out;
  }

  /** One observation as evidence. Refuses anything outside the fixed traits or touching an excluded topic. */
  record(o: Observation, ctx: RecordCtx): Belief | null {
    if (!(o.trait in TRAITS) || !TRAITS[o.trait].includes(o.value)) throw new Error(`This is not learned: ${String(o.trait)}.`);
    const domain = o.trait === 'expertise' ? o.domain.trim().toLowerCase().slice(0, 40) : '';
    if ((o.trait === 'expertise' && !domain) || excludedTopic(domain)) throw new Error('This is not learned: an excluded topic.');
    const now = this.#app.now().toISOString();
    const db = this.#db;
    db.prepare("INSERT OR IGNORE INTO working_traits (side, trait, value, domain, scope, scope_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?)").run(ctx.side, o.trait, o.value, domain, ctx.scope, ctx.scopeKey, now, now);
    const row = db.prepare('SELECT * FROM working_traits WHERE side = ? AND trait = ? AND domain = ? AND scope = ? AND scope_key = ? AND value = ?').get(ctx.side, o.trait, domain, ctx.scope, ctx.scopeKey, o.value) as Row;
    const id = Number(row.id);
    // Not true: never learned again from what she notices (only if he says it himself).
    if (row.status === 'retired' && row.why === 'denied' && !o.stated) return null;
    if (row.status === 'retired') db.prepare("UPDATE working_traits SET status = 'candidate', why = NULL WHERE id = ?").run(id);
    db.prepare('INSERT OR IGNORE INTO working_trait_evidence (trait_id, message_id, conversation_id, dir, stated, at) VALUES (?, ?, ?, 1, ?, ?)').run(id, ctx.messageId, ctx.conversationId, o.stated ? 1 : 0, now);
    if (o.stated) db.prepare("UPDATE working_traits SET status = 'confirmed', stated = 1, why = NULL, announced_at = COALESCE(announced_at, ?), updated_at = ? WHERE id = ?").run(now, now, id);
    // The other values of the same trait here: evidence against; a held one becomes contested.
    for (const other of db.prepare("SELECT * FROM working_traits WHERE side = ? AND trait = ? AND domain = ? AND scope = ? AND scope_key = ? AND value <> ? AND status <> 'retired'").all(ctx.side, o.trait, domain, ctx.scope, ctx.scopeKey, o.value) as Row[]) {
      db.prepare('INSERT OR IGNORE INTO working_trait_evidence (trait_id, message_id, conversation_id, dir, stated, at) VALUES (?, ?, ?, -1, ?, ?)').run(Number(other.id), ctx.messageId, ctx.conversationId, o.stated ? 1 : 0, now);
      if (o.stated) db.prepare("UPDATE working_traits SET status = 'retired', why = 'replaced', updated_at = ? WHERE id = ?").run(now, Number(other.id));
      else if (other.status === 'held' || (other.status === 'confirmed' && Number(other.stated) === 0)) db.prepare("UPDATE working_traits SET status = 'contested', asked_at = NULL, updated_at = ? WHERE id = ?").run(now, Number(other.id));
    }
    const b = this.#refresh(id);
    // The challenger became held: the contested one is replaced.
    if (b && (b.status === 'held' || b.status === 'confirmed')) db.prepare("UPDATE working_traits SET status = 'retired', why = 'replaced', updated_at = ? WHERE side = ? AND trait = ? AND domain = ? AND scope = ? AND scope_key = ? AND value <> ? AND status = 'contested'").run(now, ctx.side, o.trait, domain, ctx.scope, ctx.scopeKey, o.value);
    return b ?? null;
  }

  /** Recomputes confidence and the candidate/held status (fading) of one belief. */
  #refresh(id: number, at: Date = this.#app.now()): Belief | undefined {
    const row = this.#db.prepare('SELECT * FROM working_traits WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const ev = this.#db.prepare('SELECT dir, conversation_id, at FROM working_trait_evidence WHERE trait_id = ?').all(id) as Row[];
    const weight = (iso: unknown) => 0.5 ** (Math.max(0, at.getTime() - Date.parse(String(iso))) / DAY / STYLE.halfLifeDays);
    let support = 0;
    let against = 0;
    const sessions = new Set<string>();
    let first = String(row.created_at);
    let last = String(row.created_at);
    for (const e of ev) {
      if (Number(e.dir) > 0) {
        support += weight(e.at);
        sessions.add(String(e.conversation_id));
        if (String(e.at) > last) last = String(e.at);
        if (String(e.at) < first) first = String(e.at);
      } else against += weight(e.at);
    }
    const stated = Number(row.stated) === 1;
    let status = String(row.status) as BeliefStatus;
    const seen = support / (support + against + 1);
    const confidence = round2(status === 'confirmed' && !stated ? 1 : stated && status !== 'retired' ? Math.max(STYLE.stated, seen) : seen);
    if (status === 'candidate' || status === 'held') {
      const next: BeliefStatus = sessions.size >= 2 && confidence >= STYLE.heldAt ? 'held' : status === 'held' && confidence >= STYLE.fadeBelow ? 'held' : 'candidate';
      if (next !== status) {
        this.#db.prepare('UPDATE working_traits SET status = ?, updated_at = ? WHERE id = ?').run(next, at.toISOString(), id);
        status = next;
      }
    }
    return {
      id, side: String(row.side) as Space, trait: String(row.trait) as TraitKey, value: String(row.value), domain: String(row.domain),
      scope: String(row.scope) as Scope, scopeKey: String(row.scope_key), status, stated, confidence,
      evidenceFor: ev.filter((e) => Number(e.dir) > 0).length, evidenceAgainst: ev.filter((e) => Number(e.dir) < 0).length,
      sessions: sessions.size, firstSeenAt: first, lastSeenAt: last,
    };
  }

  list(): Belief[] {
    const ids = (this.#db.prepare('SELECT id FROM working_traits ORDER BY id').all() as Row[]).map((r) => Number(r.id));
    return ids.map((id) => this.#refresh(id)).filter((b): b is Belief => Boolean(b));
  }

  /** Confirm (he says it's right: never fades) or Not true (retired, never re-learned from what she notices). */
  decide(id: number, how: 'confirm' | 'deny'): Belief {
    const row = this.#db.prepare('SELECT id FROM working_traits WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Not found');
    const now = this.#app.now().toISOString();
    if (how === 'confirm') this.#db.prepare("UPDATE working_traits SET status = 'confirmed', why = NULL, announced_at = COALESCE(announced_at, ?), updated_at = ? WHERE id = ?").run(now, now, id);
    else this.#db.prepare("UPDATE working_traits SET status = 'retired', why = 'denied', stated = 0, updated_at = ? WHERE id = ?").run(now, id);
    return this.#refresh(id)!;
  }

  /** Forget: the belief and all its evidence are deleted. */
  forget(id: number): void {
    this.#db.prepare('DELETE FROM working_trait_evidence WHERE trait_id = ?').run(id);
    if (!this.#db.prepare('DELETE FROM working_traits WHERE id = ?').run(id).changes) throw new HttpError(404, 'Not found');
  }

  // ---- use

  /** The capped "How to work with <name>" note for this turn (marks the one-time announcement or question). */
  note(conv: Conversation, turn: Partial<TurnOptions>): string | undefined {
    if (!this.#conversationOk(conv, turn, false)) return undefined;
    const side = spaceOf(this.#app, conv);
    const who = this.#app.settings.get().ownerName?.trim().slice(0, 40) || 'the owner';
    const here = (b: Belief) => b.side === side && (b.scope === 'everywhere' || (b.scope === 'project' && conv.projectId !== null && b.scopeKey === String(conv.projectId)) || (b.scope === 'channel' && b.scopeKey === conv.channel));
    const all = this.list().filter((b) => here(b) && !excludedTopic(b.domain));
    const use = all.filter((b) => b.status === 'held' || b.status === 'confirmed').sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed') || b.confidence - a.confidence);
    const now = this.#app.now().toISOString();
    const extra: string[] = [];
    const fresh = use.find((b) => b.status === 'held' && !b.stated && this.#flag(b.id, 'announced_at') === null);
    if (fresh) {
      extra.push(`Newly noticed. Say once, briefly, near the start of your reply, in your own words and language: "${NOTICED[`${fresh.trait}:${fresh.value}`](fresh.domain)}"`);
      this.#db.prepare('UPDATE working_traits SET announced_at = ? WHERE id = ?').run(now, fresh.id);
    }
    const contested = all.find((b) => b.status === 'contested' && this.#flag(b.id, 'asked_at') === null);
    if (contested) {
      const rival = all.find((b) => b.trait === contested.trait && b.domain === contested.domain && b.scope === contested.scope && b.scopeKey === contested.scopeKey && b.value !== contested.value);
      const was = SHORT[`${contested.trait}:${contested.value}`](contested.domain);
      const now2 = rival ? SHORT[`${rival.trait}:${rival.value}`](rival.domain) : 'something else';
      extra.push(`You have seen both ways lately: ${who} used to want ${was}, and recently ${now2}. Ask once, briefly, which ${who} prefers now.`);
      this.#db.prepare('UPDATE working_traits SET asked_at = ? WHERE id = ?').run(now, contested.id);
    }
    if (!use.length && !extra.length) return undefined;
    let out = `How to work with ${who} (learned from ${who}'s own messages; follow it unless ${who} asks otherwise right now):`;
    const reserve = extra.reduce((n, e) => n + e.length + 1, 0);
    for (const b of use) {
      const line = `\n- ${LINE[`${b.trait}:${b.value}`](b.domain, who)}${b.scope === 'project' ? ' (in this project)' : b.scope === 'channel' ? ' (on this channel)' : ''}`;
      if (out.length + line.length + reserve > STYLE.noteChars) break;
      out += line;
    }
    for (const e of extra) if (out.length + e.length + 1 <= STYLE.noteChars) out += `\n${e}`;
    return out;
  }

  #flag(id: number, col: 'announced_at' | 'asked_at'): string | null {
    const r = this.#db.prepare(`SELECT ${col} AS v FROM working_traits WHERE id = ?`).get(id) as { v: string | null } | undefined;
    return r?.v ?? null;
  }

  // ---- the nightly pass

  /** Retires what has faded and notices his usual hours. Code only, no model. */
  nightly(now: Date = this.#app.now()): { retired: number; hours: number } {
    let retired = 0;
    let hours = 0;
    for (const b of this.list()) {
      if (b.status === 'retired' || b.status === 'confirmed' || b.stated) continue;
      if (b.confidence < STYLE.retireBelow) {
        this.#db.prepare("UPDATE working_traits SET status = 'retired', why = 'faded', updated_at = ? WHERE id = ?").run(now.toISOString(), b.id);
        retired++;
      }
    }
    if (this.active()) {
      const tz = this.#app.settings.get().timeZone;
      const since = new Date(now.getTime() - 30 * DAY).toISOString();
      for (const side of ['personal', 'work'] as const) {
        const rows = this.#db.prepare('SELECT message_id, conversation_id, at FROM working_style_seen WHERE side = ? AND at >= ? ORDER BY at').all(side, since) as Row[];
        if (rows.length < STYLE.hoursMin) continue;
        const bands = new Map<string, Row[]>();
        const days = new Set<string>();
        for (const r of rows) {
          const p = zonedParts(new Date(String(r.at)), tz);
          days.add(`${p.y}-${p.mo}-${p.d}`);
          const band = p.h >= 5 && p.h < 12 ? 'morning' : p.h >= 12 && p.h < 17 ? 'afternoon' : p.h >= 17 && p.h < 23 ? 'evening' : 'night';
          bands.set(band, [...(bands.get(band) ?? []), r]);
        }
        if (days.size < STYLE.hoursDays) continue;
        const [band, list] = [...bands.entries()].sort((a, b) => b[1].length - a[1].length)[0];
        if (list.length / rows.length < STYLE.hoursShare) continue;
        const latest = list.at(-1)!;
        this.record({ trait: 'hours', value: band, domain: '', stated: false }, { messageId: Number(latest.message_id), conversationId: String(latest.conversation_id), side, scope: 'everywhere', scopeKey: '' });
        hours++;
      }
    }
    this.#db.prepare('DELETE FROM working_style_seen WHERE at < ?').run(new Date(now.getTime() - STYLE.seenKeepDays * DAY).toISOString());
    return { retired, hours };
  }

  /** Called from ReminderScheduler.tick(): once a night, in his quiet hours (the overnight tidy's slot). */
  due(now: Date = this.#app.now()): number {
    const tz = this.#app.settings.get().timeZone;
    const p = proactiveSettings(this.#app);
    if (!inQuiet(zonedParts(now, tz).h, p.quietStart, p.quietEnd)) return 0;
    const n = zonedParts(new Date(now.getTime() - 12 * 3600_000), tz);
    const night = `${n.y}-${n.mo}-${n.d}`;
    const had = this.#db.prepare("SELECT value FROM working_style_meta WHERE key = 'night'").get() as { value: string } | undefined;
    if (had?.value === night) return 0;
    this.#db.prepare("INSERT INTO working_style_meta (key, value) VALUES ('night', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(night);
    this.nightly(now);
    return 1;
  }
}

/** The note for one turn (undefined when nothing applies or learning is off). */
export function workingStyleNote(app: AppContext, conv: Conversation, turn: Partial<TurnOptions>): string | undefined {
  return app.workingStyle?.note(conv, turn);
}
