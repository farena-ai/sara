// HANDSFREE (docs/desktop.md → Hands-free): "Let her finish this task". Once the person says so (clear
// words like "just do it" in the message that starts the task, the first computer-use card's "Let her
// finish this task" button, or Settings → Computer use → "Never ask except the hard limits"), her
// computer-use actions in this conversation stop asking on every site, host and app, until the task
// ends: the time runs out (15 minutes, 1 hour or "until I stop her", capped at 8 hours), the person
// presses Stop, takes over (moves the mouse or types on that computer), or a new task starts.
//
// The hard limits never change (src/computer-policy.ts): passwords and one-time codes are never typed
// (she hands those over with "your turn"), payments and purchases ask every time, password, 2FA and
// recovery settings ask every time, banking and password managers stay blocked, administrator prompts
// are the person's click, nothing happens on a locked computer, and installing software asks. On the
// person's own computer the Sara app confirms hands-free once on its own card (a phone can't relax it).
//
// Pure state, no timers: expiry is checked when asked. One HandsFree lives on the HandsHub.

export const HANDS_FREE_FOR = ['15m', '1h', 'stop'] as const;
export type HandsFreeFor = (typeof HANDS_FREE_FOR)[number];
export const handsFreeFor = (v: unknown): HandsFreeFor => (v === '15m' || v === 'stop' ? v : '1h');
/** "Until I stop her" still ends after 8 hours (and with the PC-in-use pause, Stop, or a new task). */
export const HANDS_FREE_MAX_MS = 8 * 3600_000;
export const handsFreeMs = (v: unknown): number => (handsFreeFor(v) === '15m' ? 15 * 60_000 : handsFreeFor(v) === 'stop' ? HANDS_FREE_MAX_MS : 3600_000);

/**
 * The person's words say "do it, don't ask me" (six languages). Only clear go-ahead phrases count:
 * "set up my calendar" alone is a request, "set it up for me, just do it" is the go-ahead.
 */
const GO = [
  /\bjust (?:do it|go|go ahead|handle it|finish it|take care of it)\b/i,
  /\b(?:do|finish|handle) (?:it|everything|the whole thing|it all) (?:for me|yourself|without asking)\b/i,
  /\bwithout (?:asking|checking with) me\b/i,
  /\b(?:don'?t|do not|no need to) (?:ask|check with) me\b/i,
  /\bhands[- ]?free\b/i,
  /\b(?:go ahead and|feel free to) (?:do|set|finish|handle)\b/i,
  /\byou have my (?:ok|okay|permission|go-ahead)\b/i,
  /\b(?:sólo|solo) hazlo\b|\bhazlo (?:tú|tu|por m[ií]|sin preguntar)\b|\bsin preguntarme\b/iu,
  /\bfais[- ]le (?:pour moi|toi[- ]même|sans demander)\b|\bsans me demander\b|\bvas-y\b/iu,
  /\bmach (?:es |das )?einfach\b|\bohne (?:mich )?zu fragen\b|\bohne nachzufragen\b/iu,
  /\bpode fazer\b|\bfaz (?:isso )?(?:por mim|sem perguntar)\b|\bsem me perguntar\b/iu,
  /\bfallo (?:tu|per me|senza chiedere)\b|\bsenza chiedermi\b|\bvai pure\b/iu,
];
const NOT_GO = /\b(?:don'?t|do not|never) (?:just )?do it\b|\bask me (?:first|before|each|every)\b|\bcheck with me first\b/i;
export function saysGoAhead(text: string): boolean {
  const s = String(text ?? '');
  return !NOT_GO.test(s) && GO.some((re) => re.test(s));
}

export type HandsFreeWhy = 'you' | 'time' | 'takeover' | 'task' | 'limit';
export interface HandsFreeStep {
  at: number;
  what: string;
  where?: string;
}
export interface HandsFreeState {
  conversationId: string;
  /** This stretch's key (the computers keep their one hands-free grant under it). */
  task: string;
  since: number;
  until: number;
  by: 'words' | 'card' | 'setting';
  steps: HandsFreeStep[];
  ended?: { at: number; why: HandsFreeWhy };
}
export interface HandsFreeView {
  active: boolean;
  since?: string;
  until?: string;
  by?: HandsFreeState['by'];
  steps: { at: string; what: string; where?: string }[];
  ended?: { at: string; why: HandsFreeWhy };
}

export class HandsFree {
  readonly #m = new Map<string, HandsFreeState>();
  now = (): number => Date.now();
  /** Called when a hands-free stretch ends (the hub tells the computers to drop their grants). */
  onEnd?: (s: HandsFreeState) => void;
  /** Called when a stretch starts or is renewed (the chat shows its banner). */
  onStart?: (s: HandsFreeState) => void;

  start(conversationId: string, o: { ms: number; by: HandsFreeState['by'] }): HandsFreeState {
    const now = this.now();
    const was = this.active(conversationId);
    const since = was?.since ?? now;
    const s: HandsFreeState = { conversationId, task: was?.task ?? `hf:${conversationId}:${since.toString(36)}`, since, until: now + Math.max(60_000, Math.min(HANDS_FREE_MAX_MS, o.ms)), by: was?.by ?? o.by, steps: was?.steps ?? [] };
    this.#m.set(conversationId, s);
    try {
      this.onStart?.(s);
    } catch {
      /* the banner shows on the next poll */
    }
    return s;
  }

  /**
   * The live stretch for this conversation. Follow-up messages in the same chat ("I signed in, go on")
   * keep it: a setup takes several turns. It ends with the time, Stop, a takeover or end().
   */
  active(conversationId: string): HandsFreeState | undefined {
    const s = this.#m.get(conversationId);
    if (!s || s.ended) return undefined;
    if (this.now() >= s.until) return void this.stop(conversationId, 'time');
    return s;
  }

  stop(conversationId: string, why: HandsFreeWhy): boolean {
    const s = this.#m.get(conversationId);
    if (!s || s.ended) return false;
    s.ended = { at: this.now(), why };
    try {
      this.onEnd?.(s);
    } catch {
      /* the computers drop their grants on their own when the time runs out */
    }
    return true;
  }

  /** Every live stretch that used these conversations ends (the person took over that computer). */
  stopWhere(pred: (conversationId: string) => boolean, why: HandsFreeWhy): number {
    let n = 0;
    for (const id of this.#m.keys()) if (pred(id) && this.stop(id, why)) n++;
    return n;
  }

  /** One line for the step log shown after (and during) a hands-free stretch. */
  step(conversationId: string, what: string, where?: string): void {
    const s = this.#m.get(conversationId);
    if (!s || s.ended) return;
    s.steps.push({ at: this.now(), what: what.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160), ...(where ? { where: where.slice(0, 120) } : {}) });
    if (s.steps.length > 200) s.steps.splice(0, s.steps.length - 200);
  }

  view(conversationId: string): HandsFreeView {
    const s = this.#m.get(conversationId);
    if (s && !s.ended) this.active(conversationId);
    if (!s) return { active: false, steps: [] };
    const iso = (n: number) => new Date(n).toISOString();
    return { active: !s.ended, since: iso(s.since), until: iso(s.until), by: s.by, steps: s.steps.map((x) => ({ at: iso(x.at), what: x.what, ...(x.where ? { where: x.where } : {}) })), ...(s.ended ? { ended: { at: iso(s.ended.at), why: s.ended.why } } : {}) };
  }
}
