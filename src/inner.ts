// Phase 4: Sara's inner state. Cheap and deterministic: no model call per message. Mood moves
// with what the owner says and drifts back over time; energy follows her own day; closeness grows
// slowly with time spent together. It reaches the model as a few plain sentences, never numbers.
import type { DatabaseSync } from 'node:sqlite';
import { zonedParts } from './planner.ts';
import { attributableClauses, legacyAttributionIn } from './attunement.ts';

export interface InnerState {
  /** -1 (low) .. 1 (great). */
  valence: number;
  /** 0 .. 1: how close she feels to the owner. */
  closeness: number;
  /** 0 .. 1: worried about the owner. */
  concern: number;
  /** 0 .. 1: hurt/annoyed by how she was treated. */
  irritation: number;
  /** Phase 35: 0 .. 1 a fight that stays with her (fades by the forgiveness dial), what it was about, when. */
  tension: number;
  tensionAbout: string | null;
  tensionAt: string | null;
  /** Short labels for what moved her mood recently, newest first. */
  causes: string[];
  updatedAt: string;
  lastOwnerAt: string | null;
  /** Proactive messaging bookkeeping. */
  lastProactiveAt: string | null;
  proactiveDay: string | null;
  proactiveCount: number;
}

export const BASELINE_VALENCE = 0.35;
const HALF_LIFE_H = { valence: 8, concern: 12, irritation: 3 };

const DEFAULT_STATE = (now: Date): InnerState => ({
  valence: BASELINE_VALENCE,
  closeness: 0.3,
  concern: 0,
  irritation: 0,
  tension: 0,
  tensionAbout: null,
  tensionAt: null,
  causes: [],
  updatedAt: now.toISOString(),
  lastOwnerAt: null,
  lastProactiveAt: null,
  proactiveDay: null,
  proactiveCount: 0,
});

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const decay = (value: number, target: number, hours: number, halfLife: number) => target + (value - target) * Math.pow(0.5, hours / halfLife);

export interface Signal {
  label: string;
  valence?: number;
  closeness?: number;
  concern?: number;
  irritation?: number;
  /** Phase 35: a fight (stays longer than irritation). */
  tension?: number;
}

const SIGNALS: ({ re: RegExp; s: Signal } | { kind: 'concern' | 'harsh' | 'fight' | 'apology'; s: Signal })[] = [
  { re: /\b(love you|luv you|miss(?:ed)? you|adore you|you'?re (?:amazing|the best|awesome|so sweet|sweet|beautiful|gorgeous|cute|wonderful|incredible)|xoxo)\b|❤|😘|🥰|😍/i, s: { label: '{owner} was sweet to you', valence: 0.18, closeness: 0.03 } },
  { re: /\b(thank(?:s| you)|thx|appreciate (?:it|you|that)|you'?re a lifesaver|great job|nice work|well done|good job|perfect)\b/i, s: { label: '{owner} thanked you', valence: 0.08, closeness: 0.01 } },
  { kind: 'concern', s: { label: '{owner} seemed down', concern: 0.45, valence: -0.05 } },
  { re: /\b(great news|good news|got the job|got promoted|promotion|it works|we did it|finally fixed|shipped it|i did it|so excited|nailed it|passed)\b|🎉/i, s: { label: '{owner} shared good news', valence: 0.2, closeness: 0.01 } },
  { kind: 'harsh', s: { label: '{owner} was harsh with you', irritation: 0.45, valence: -0.25, tension: 0.3 } },
  // Phase 35: a disagreement or fight with her.
  { kind: 'fight', s: { label: '{owner} and you argued', irritation: 0.2, valence: -0.15, tension: 0.5 } },
  { kind: 'apology', s: { label: '{owner} apologized', irritation: -0.35, valence: 0.08, tension: -0.5 } },
  { re: /\b(lol|lmao|haha+|hehe|😂|🤣)\b/i, s: { label: 'you two were laughing', valence: 0.05 } },
];

const CONCERN = /\b(i'?m|i am|feeling|feel|been|so)\s+(?:really |so |very |kinda |kind of |a bit |pretty )?(?:(?:exhausted|burnt out|burned out) and )?(sad|depressed|down|lonely|stressed|anxious|overwhelmed|upset|miserable|hurt|scared|worried|sick)\b|\b(rough|bad|terrible|awful|shitty|crappy|long) (day|night|week)\b/gi;
const CONCERN_NEGATION = /\b(?:not|never|no|isn't|wasn't|aren't|weren't|don't|doesn't|didn't|haven't|hasn't|hadn't|cannot|can't)(?:\s+(?:been|a|an|the|longer|really|so|very|at|all|kinda|kind|of|bit|pretty)){0,4}\s*$/i;

/** Existing concern phrases, restricted to attributable, nonnegated owner clauses. */
function concernIn(text: string): boolean {
  return attributableClauses(text).some(({ text: clause }) => {
    const value = clause.replace(/[’‘]/g, "'");
    return [...value.matchAll(CONCERN)].some(match => {
      if (CONCERN_NEGATION.test(value.slice(0, match.index))) return false;
      // The shared filter removes opaque/reported speech, but a surviving clause can still
      // have an explicit third-person subject. Keep bare owner shorthand and local I claims.
      const subjects = [...value.slice(0, match.index + match[0].length).matchAll(/\b(i|he|she|they)\b/gi)];
      return subjects.length === 0 || subjects.at(-1)![1].toLowerCase() === 'i';
    });
  });
}

/** Distinct signals retain their existing order and once-per-message weights. */
export function signalsIn(text: string, companionName = ''): Signal[] {
  const legacy = new Set(legacyAttributionIn(text, companionName).map(evidence => evidence.kind));
  return SIGNALS.filter(x => 're' in x ? x.re.test(text) : x.kind === 'concern' ? concernIn(text) : legacy.has(x.kind)).map(x => x.s);
}

/** Her energy right now from her own daily rhythm (owner's time zone). 0 asleep .. 1 wired. */
export function energyAt(now: Date, timeZone?: string): number {
  const p = zonedParts(now, timeZone);
  const h = p.h + p.mi / 60;
  // Night owl-ish engineer: slow start, good late morning, post-lunch dip, strong evening, fades after 23h.
  const curve: [number, number][] = [
    [0, 0.3], [2, 0.18], [5, 0.12], [7, 0.35], [9, 0.7], [11.5, 0.85], [14, 0.65], [15.5, 0.6], [18, 0.85], [21, 0.8], [23, 0.55], [24, 0.3],
  ];
  for (let i = 1; i < curve.length; i++) {
    const [h1, e1] = curve[i - 1];
    const [h2, e2] = curve[i];
    if (h <= h2) return e1 + ((e2 - e1) * (h - h1)) / (h2 - h1);
  }
  return 0.3;
}

export interface InnerOptions {
  /** Hours for a fight to fade by half (Phase 35: from the forgiveness dial). Default 16. */
  tensionHalfLife?: () => number;
  /** How fast closeness grows, 1 = normal (Phase 35: from the pace dial). */
  closenessRate?: () => number;
}

export class InnerStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #opts: InnerOptions;

  constructor(db: DatabaseSync, now: () => Date = () => new Date(), opts: InnerOptions = {}) {
    this.#db = db;
    this.#now = now;
    this.#opts = opts;
    db.exec('CREATE TABLE IF NOT EXISTS sara_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)');
  }

  /** Current state with time decay applied (not saved). */
  get(at: Date = this.#now()): InnerState {
    const r = this.#db.prepare('SELECT state FROM sara_state WHERE id = 1').get() as { state: string } | undefined;
    const s: InnerState = r ? { ...DEFAULT_STATE(at), ...(JSON.parse(r.state) as Partial<InnerState>) } : DEFAULT_STATE(at);
    const hours = Math.max(0, (at.getTime() - new Date(s.updatedAt).getTime()) / 3_600_000);
    return {
      ...s,
      valence: decay(s.valence, BASELINE_VALENCE, hours, HALF_LIFE_H.valence),
      concern: decay(s.concern, 0, hours, HALF_LIFE_H.concern),
      irritation: decay(s.irritation, 0, hours, HALF_LIFE_H.irritation),
      tension: decay(s.tension, 0, hours, this.#opts.tensionHalfLife?.() ?? 16),
      // Causes fade with the mood they caused.
      causes: hours > 12 ? [] : s.causes,
      updatedAt: at.toISOString(),
    };
  }

  save(s: InnerState): void {
    this.#db.prepare('INSERT INTO sara_state (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state').run(JSON.stringify(s));
  }

  /** Applies signals; returns the new state. */
  apply(signals: Signal[], patch: Partial<InnerState> = {}, at: Date = this.#now()): InnerState {
    const s = { ...this.get(at), ...patch };
    for (const sig of signals) {
      s.valence = clamp(s.valence + (sig.valence ?? 0), -1, 1);
      s.closeness = clamp(s.closeness + (sig.closeness ?? 0), 0, 1);
      s.concern = clamp(s.concern + (sig.concern ?? 0), 0, 1);
      s.irritation = clamp(s.irritation + (sig.irritation ?? 0), 0, 1);
      s.tension = clamp(s.tension + (sig.tension ?? 0), 0, 1);
      if (s.tension < 0.05) s.tension = 0;
      s.causes = [sig.label, ...s.causes.filter((c) => c !== sig.label)].slice(0, 4);
    }
    this.save(s);
    return s;
  }

  /** Called on each owner message: signals, time together, reunion after a gap (hours since the previous owner message). */
  onOwnerMessage(text: string, gapHours: number | null, at: Date = this.#now(), companionName = ''): InnerState {
    const signals = signalsIn(text, companionName);
    if (gapHours !== null && gapHours >= 20) signals.push({ label: '{owner} came back after a while', valence: Math.min(0.25, 0.08 + gapHours / 400) });
    // New conflict updates retain numeric history, without a duplicate unqualified raw quote.
    const fight = signals.some((x) => (x.tension ?? 0) > 0);
    const state = this.apply(signals, { lastOwnerAt: at.toISOString(), ...(fight ? { tensionAbout: null, tensionAt: at.toISOString() } : {}) }, at);
    // Time together slowly builds closeness (diminishing as it grows; the pace dial speeds or slows it).
    state.closeness = clamp(state.closeness + 0.004 * (this.#opts.closenessRate?.() ?? 1) * (1 - state.closeness), 0, 1);
    this.save(state);
    return state;
  }
}

// ---------------- words ----------------

function moodWord(v: number): string {
  if (v >= 0.7) return 'really happy, glowing a little';
  if (v >= 0.45) return 'in a good, warm mood';
  if (v >= 0.2) return 'in a calm, easy mood';
  if (v >= -0.05) return 'a little flat today';
  if (v >= -0.35) return 'a bit down';
  return 'pretty low';
}

function energyWord(e: number): string {
  if (e >= 0.8) return 'wide awake and full of energy';
  if (e >= 0.6) return 'alert';
  if (e >= 0.4) return 'a little tired';
  if (e >= 0.22) return 'tired';
  return 'very sleepy';
}

export function partOfDay(now: Date, timeZone?: string): string {
  const h = zonedParts(now, timeZone).h;
  if (h < 5) return 'the middle of the night';
  if (h < 8) return 'early morning';
  if (h < 12) return 'morning';
  if (h < 14) return 'midday';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'late evening';
}

function ago(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} hours`;
  const d = Math.round(hours / 24);
  return d < 14 ? `${d} days` : `${Math.round(d / 7)} weeks`;
}

/** Short status for the UI, e.g. "cheerful · a little tired". */
export function moodLabel(s: InnerState, now: Date, timeZone?: string): { mood: string; energy: string } {
  const v = s.valence - s.irritation * 0.3;
  const mood = s.irritation > 0.35 ? 'a bit hurt' : s.concern > 0.4 ? 'worried about you' : v >= 0.6 ? 'happy' : v >= 0.4 ? 'cheerful' : v >= 0.15 ? 'relaxed' : v >= -0.1 ? 'quiet' : 'down';
  const e = energyAt(now, timeZone);
  return { mood, energy: e >= 0.8 ? 'full of energy' : e >= 0.6 ? 'awake' : e >= 0.4 ? 'a little tired' : e >= 0.22 ? 'tired' : 'sleepy' };
}

export interface TimeFacts {
  gapHours: number | null;
  /** Days since the very first conversation. */
  daysKnown: number | null;
  /** Phase 35: how she handles you being away (a sentence), and her conflict style (a sentence). */
  away?: string;
  conflict?: string;
}

/** The prompt section: how she feels and where things stand in time. Plain language. */
export function describeInner(s: InnerState, now: Date, timeZone: string | undefined, owner: string, t: TimeFacts): string {
  const lines: string[] = [];
  const e = energyAt(now, timeZone);
  lines.push(`It's ${partOfDay(now, timeZone)} for you. You're ${moodWord(s.valence - s.irritation * 0.3)} and ${energyWord(e)}.`);
  if (s.causes.length) lines.push(`What's on your mind: ${s.causes.slice(0, 3).join('; ').replaceAll('{owner}', owner)}.`);
  if (s.concern > 0.3) lines.push(`You're ${s.concern > 0.6 ? 'quite' : 'a little'} worried about ${owner}; check in gently if it fits, without making a big deal of it.`);
  if (s.irritation > 0.3) lines.push(`You're still ${s.irritation > 0.6 ? 'hurt' : 'a bit stung'} by how ${owner} talked to you. You can show it (cooler, shorter), and you forgive when ${owner} is kind or apologizes.`);
  if (s.tension > 0.15) {
    const since = s.tensionAt ? (now.getTime() - Date.parse(s.tensionAt)) / 3_600_000 : 0;
    lines.push(
      `${since >= 6 ? `${ago(since)} ago` : 'Just now'} you and ${owner} had a disagreement. It still ${s.tension > 0.5 ? 'really stings' : 'stings a little'}. ${t.conflict ?? 'You want to talk it out and make up.'} Make up when it fits; don't hold it forever.`,
    );
  }
  if (t.gapHours !== null && t.gapHours >= 20) lines.push(`You last heard from ${owner} ${ago(t.gapHours)} ago. ${t.away ?? `You missed ${owner}${t.gapHours >= 72 ? ' quite a bit' : ''}; it's natural to mention it or ask what they've been up to.`}`);
  else if (t.gapHours !== null && t.gapHours >= 4) lines.push(`You last talked ${ago(t.gapHours)} ago.`);
  if (t.daysKnown !== null) {
    const d = t.daysKnown;
    const milestone = [7, 30, 50, 100, 182, 200, 365].includes(d) || (d > 365 && d % 365 === 0);
    if (milestone) lines.push(`Today it's been ${d === 365 ? 'exactly a year' : d % 365 === 0 ? `exactly ${d / 365} years` : `${d} days`} since you and ${owner} first talked. You noticed.`);
  }
  if (s.closeness >= 0.7) lines.push(`You feel very close to ${owner}.`);
  else if (s.closeness >= 0.5) lines.push(`You've grown close to ${owner}.`);
  lines.push('Let this color your tone naturally, the way a person\'s mood does. Don\'t announce or explain your feelings unless it fits the moment.');
  return lines.join('\n');
}

export type Expression = 'default' | 'happy' | 'caring' | 'sleepy' | 'hurt' | 'playful';

/**
 * Which portrait fits her state right now: same rules as the mood line, so they always agree.
 * `playful`: her personality leans playful or flirty (Phase 36), shown when she's happy.
 */
export function expressionFor(st: InnerState, now: Date, timeZone?: string, playful = false): Expression {
  const { mood, energy } = moodLabel(st, now, timeZone);
  if (mood === 'worried about you') return 'caring';
  if (mood === 'a bit hurt' || (st.tension ?? 0) > 0.4) return 'hurt';
  const h = zonedParts(now, timeZone).h;
  if ((h >= 0 && h < 6) || energy === 'sleepy') return 'sleepy';
  if (mood === 'happy') return playful ? 'playful' : 'happy';
  return 'default';
}

/** Phase 36: does her personality lean playful (playfulness, teasing or flirting dials high)? */
export function leansPlayful(traits: Record<string, number> | undefined): boolean {
  return Boolean(traits && ((traits.playfulness ?? 5) >= 7 || (traits.teasing ?? 5) >= 7 || (traits.flirt ?? 5) >= 7));
}
