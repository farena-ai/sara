// W5.5 (docs/design/W5WHY.md): "Why did you do this?" for every action timeline row.
//
// The cause (what started the action: the person's message, an automation, a trigger, a webhook, a
// repeat, a goal, a worker, an errand or a Handle it step, another app or an outside request, or the
// person's own click) and the rule that let it run without a card are stored WITH the row when the
// action happens (src/timeline.ts `why` column). Nothing is worked out later, so the answer is never
// a guess: rows from before this was recorded say exactly that. The same lines feed the web row and
// the chat answer to "why did you do that?" (whyLines). Kept free of server imports so chat.ts can
// check a message cheaply.
import { en } from './i18n.ts';

export const CAUSE_KINDS = ['message', 'automation', 'trigger', 'webhook', 'loop', 'goal', 'worker', 'team', 'errand', 'handle', 'app', 'outside', 'click'] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

export interface ActionCause {
  kind: CauseKind;
  /** The automation / trigger / goal / errand / app name (clipped). */
  label?: string;
  /** Handle it plan step or errand step (clipped). */
  step?: string;
  /** How an automation was started: 'schedule' | 'email' | 'webhook' | 'calendar' | 'live' | … */
  how?: string;
  /** The chat turn: the stored message that started it, its time and (for the person's own words) its text. */
  messageId?: number;
  at?: string;
  text?: string;
  /** Where the person wrote it (telegram, discord, …); 'web' is left out. */
  channel?: string;
}

/** Why no card was shown ('card' = there was one and the person said yes). */
export const RULES = ['card', 'always-allow', 'allow-once', 'task', 'tool-on', 'auto-tool', 'click'] as const;
export type ActionRule = (typeof RULES)[number];

export interface ActionWhy {
  cause: ActionCause;
  rule?: ActionRule;
}

const clip = (s: unknown, n: number): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const v = s.replace(/\s+/g, ' ').trim();
  return v ? (v.length > n ? `${v.slice(0, n - 1)}…` : v) : undefined;
};

/** A stored why, cleaned (unknown kinds dropped, texts clipped). Undefined = nothing usable. */
export function cleanWhy(w: unknown): ActionWhy | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const c = (w as { cause?: Record<string, unknown> }).cause;
  if (!c || !(CAUSE_KINDS as readonly string[]).includes(String(c.kind))) return undefined;
  const cause: ActionCause = { kind: c.kind as CauseKind };
  const label = clip(c.label, 80);
  const step = clip(c.step, 120);
  const how = clip(c.how, 20);
  const text = clip(c.text, 160);
  const at = typeof c.at === 'string' && !Number.isNaN(Date.parse(c.at)) ? c.at : undefined;
  const mid = Number(c.messageId);
  const channel = clip(c.channel, 30);
  if (label) cause.label = label;
  if (step) cause.step = step;
  if (how) cause.how = how;
  if (Number.isInteger(mid) && mid > 0) cause.messageId = mid;
  if (at) cause.at = at;
  if (text) cause.text = text;
  if (channel && channel !== 'web') cause.channel = channel;
  const rule = (w as { rule?: unknown }).rule;
  return { cause, ...((RULES as readonly string[]).includes(String(rule)) ? { rule: rule as ActionRule } : {}) };
}

/** The rule, in a fixed order: a card the person answered beats every standing OK. */
export function ruleOf(f: { approved: boolean; allowAll: boolean; ahead: boolean; task: boolean; set: string; ownerSet: boolean }): ActionRule {
  if (f.approved) return 'card';
  if (f.allowAll) return 'always-allow';
  if (f.ahead) return 'allow-once';
  if (f.task) return 'task';
  if (f.set === 'auto' && f.ownerSet) return 'tool-on';
  return 'auto-tool';
}

export const OLD_ROW = en('From before this was recorded.');

const CAUSE_LINE: Record<CauseKind, string> = {
  message: en('You asked at {time}: “{text}”'),
  automation: en('Your automation “{name}” started it.'),
  trigger: en('The trigger “{name}” started it.'),
  webhook: en('The webhook “{name}” started it.'),
  loop: en('The repeat you set in this chat started it: “{name}”.'),
  goal: en('It was a round of your goal “{name}”.'),
  worker: en('Your worker was doing the job “{name}”.'),
  team: en('A team helper was working on “{name}”.'),
  errand: en('It was a step of your errand “{name}”.'),
  handle: en('It was the step “{step}” of the Handle it plan for “{name}”.'),
  app: en('The app “{name}” asked for it.'),
  outside: en('An outside request from {name} asked for it.'),
  click: en('You did this yourself in the app.'),
};
const HOW_LINE: Record<string, string> = {
  schedule: en('It ran on its schedule.'),
  email: en('An email that matched it came in.'),
  calendar: en('An event on your calendar was coming up.'),
  webhook: en('A webhook call came in.'),
};
const RULE_LINE: Record<ActionRule, string> = {
  card: en('You said yes on its card.'),
  'always-allow': en('No card was shown because Always allow everything was on.'),
  'allow-once': en('No card was shown because you allowed it once ahead.'),
  task: en('No card was shown because you allowed it for this task.'),
  'tool-on': en('No card was shown because you set this tool to run on its own.'),
  'auto-tool': en('No card was shown because this tool runs on its own (it does not ask first).'),
  click: en('You clicked it yourself, so no card was needed.'),
};

/** One line the web or chat shows: an en() key, its params, and `at` for a {time} the reader formats. */
export interface WhyLine {
  key: string;
  params?: Record<string, string>;
  at?: string;
  /** 'cause' | 'how' | 'rule' | 'old' (for styling). */
  part: 'cause' | 'how' | 'rule' | 'old';
}

/** What a row's why says, in order. An old row (no why) gets the one plain line. */
export function whyLines(w: ActionWhy | undefined): WhyLine[] {
  if (!w) return [{ key: OLD_ROW, part: 'old' }];
  const c = w.cause;
  const out: WhyLine[] = [];
  if (c.kind === 'message') {
    out.push(c.text ? { key: CAUSE_LINE.message, params: { text: c.text }, ...(c.at ? { at: c.at } : {}), part: 'cause' } : { key: en('Your message in this chat started it.'), part: 'cause' });
  } else {
    out.push({ key: CAUSE_LINE[c.kind], params: { name: c.label ?? '', step: c.step ?? '' }, part: 'cause' });
  }
  if (c.how && HOW_LINE[c.how]) out.push({ key: HOW_LINE[c.how], part: 'how' });
  if (w.rule) out.push({ key: RULE_LINE[w.rule], part: 'rule' });
  return out;
}

// ---------- "why did you do that?" in six languages ----------

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/[¿¡?!.,;:…"“”«»()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ASKS: readonly RegExp[] = [
  // English
  /^(but |so |and |ok |hey )?why (did|would) you (do|change|send|make|add|delete|move|run|try) (that|this|it)( just now)?$/,
  /^why (that|this)$/,
  /^what made you do (that|this)$/,
  // Spanish
  /^(y )?por ?que (hiciste|cambiaste|enviaste|has hecho) (eso|esto)$/,
  /^por ?que lo hiciste$/,
  // French
  /^pourquoi (tu as|as-tu|avez-vous|vous avez) fait (ca|cela)$/,
  /^pourquoi (tu l'as|l'as-tu|vous l'avez) fait$/,
  // German
  /^warum hast du (das|dies) (gemacht|getan|geandert)$/,
  /^wieso hast du das (gemacht|getan)$/,
  // Portuguese
  /^por ?que (voce|tu) (fez|fizeste|mudou) (isso|isto)$/,
  /^por ?que fez isso$/,
  // Italian
  /^perche (hai fatto|l'hai fatto|hai cambiato) ?(questo|quello|cio)?$/,
];

/** True when the whole message asks why she just did something (an optional "Sara," around it). */
export function asksWhyThat(text: string, name?: string): boolean {
  if (typeof text !== 'string' || text.length > 60) return false;
  let s = fold(text);
  const n = name ? fold(name) : '';
  if (n && s.startsWith(`${n} `)) s = s.slice(n.length + 1).trim();
  if (n && s.endsWith(` ${n}`)) s = s.slice(0, -n.length - 1).trim();
  return ASKS.some((r) => r.test(s));
}
