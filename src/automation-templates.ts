// R9 (docs/AUTOMATIONS.md "Templates"): shareable automation templates. An automation is exported as
// plain JSON without personal data: no ids (the automation's, a document's, a watch's, a webhook's, a
// chat's), no email addresses, no keys or tokens, no file ids, no phone numbers. Each one becomes a
// placeholder ({{email_1}}) that the person who imports it fills in. Import reads a file or pasted
// text, checks it and scrubs it again (a template is never trusted), and always goes through the
// normal preview; the route makes it only with Allow (allow: true). A small gallery of ready-made
// templates ships with Sara. Nothing here runs anything: the filled draft goes through
// Automations.clean/preview/create like any other.
import { ACTION_KINDS, TRIGGER_KINDS, type Automation, type Draft } from './automations.ts';
import { en } from './i18n.ts';

export const TEMPLATE_FORMAT = 'automation-template';
export const TEMPLATE_VERSION = 1;
export const TEMPLATE_MAX = 40_000;

export type PlaceholderKind = 'email' | 'phone' | 'token' | 'file' | 'webhook' | 'watch' | 'document' | 'text';
export interface Placeholder {
  key: string;
  kind: PlaceholderKind;
  /** English; the UI translates it. */
  label: string;
}
export interface AutomationTemplate {
  sara: typeof TEMPLATE_FORMAT;
  version: typeof TEMPLATE_VERSION;
  name: string;
  description?: string;
  trigger: Record<string, unknown>;
  condition?: { words?: string } | null;
  actions: Record<string, unknown>[];
  placeholders: Placeholder[];
}

export class TemplateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const TEMPLATE_LINES = [
  en('This isn’t an automation template.'),
  en('This template is too big.'),
  en('This template has nothing to do.'),
  en('Fill in every blank first.'),
  en('That isn’t an email address.'),
  en('Pick the watch by its number.'),
  en('Template not found.'),
  en('Look at the preview, then tap Allow.'),
];

const KIND_LABEL: Record<PlaceholderKind, string> = {
  email: en('An email address'),
  phone: en('A phone number'),
  token: en('A key or token'),
  file: en('A file id'),
  webhook: en('Which webhook'),
  watch: en('Which watch (its number)'),
  document: en('Which document to fill'),
  text: en('Text'),
};

// ------------------------------------------------------------------ scrubbing

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TOKEN = /(?<![\w-])(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|AIza|ya29|glpat|Bearer\s+)[-_A-Za-z0-9.]{8,}/g;
const LONG_ID = /(?<![\w-])(?=[A-Za-z0-9_-]{20,}(?![\w-]))(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}(?![\w-])/g;
const PHONE = /(?<![\w])\+?\d[\d ().-]{7,}\d(?![\w])/g;
/** Keys that are never copied into a template (ids and personal bookkeeping). */
const DROP = new Set(['id', 'docId', 'ref', 'hookId', 'conversationId', 'createdAt', 'updatedAt', 'nextAt', 'fails', 'pausedReason', 'owner', 'createdBy', 'enabled', 'label', 'sendWithoutAsking', 'watch']);
/** Fields that are a fixed word, never personal (kept as they are). */
const FIXED = new Set(['kind', 'every', 'time', 'how', 'week', 'source']);

class Scrubber {
  placeholders: Placeholder[] = [];
  #seen = new Map<string, string>();
  #n: Partial<Record<PlaceholderKind, number>> = {};
  constructor(keep: Placeholder[] = []) {
    for (const p of keep) this.placeholders.push(p);
  }
  add(kind: PlaceholderKind, raw: string | null, label?: string, key?: string): string {
    const seenKey = raw === null ? null : `${kind}:${raw.toLowerCase()}`;
    if (seenKey && this.#seen.has(seenKey)) return `{{${this.#seen.get(seenKey)}}}`;
    let k = key;
    if (!k) {
      const n = (this.#n[kind] ?? 0) + 1;
      this.#n[kind] = n;
      k = `${kind}_${n}`;
      while (this.placeholders.some((p) => p.key === k)) k = `${kind}_${(this.#n[kind] = (this.#n[kind] ?? 0) + 1)}`;
    }
    if (!this.placeholders.some((p) => p.key === k)) this.placeholders.push({ key: k, kind, label: label ?? KIND_LABEL[kind] });
    if (seenKey) this.#seen.set(seenKey, k);
    return `{{${k}}}`;
  }
  text(s: string): string {
    return s
      .replace(/\u0000/g, '')
      .replace(EMAIL, (m) => this.add('email', m))
      .replace(TOKEN, (m) => this.add('token', m))
      .replace(LONG_ID, (m) => this.add('file', m))
      .replace(PHONE, (m) => ((m.match(/\d/g) ?? []).length >= 9 && !/^\d{4}-\d{2}-\d{2}$/.test(m) ? this.add('phone', m) : m));
  }
  value(v: unknown, key = '', depth = 0): unknown {
    if (depth > 6) return undefined;
    if (typeof v === 'string') return FIXED.has(key) ? v.slice(0, 40) : this.text(v.slice(0, 4000));
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => this.value(x, '', depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
        if (DROP.has(k)) continue;
        const y = this.value(x, k, depth + 1);
        if (y !== undefined) out[k.slice(0, 80)] = y;
      }
      return out;
    }
    return undefined;
  }
}

/** The structure a filled template needs (a webhook to pick, a watch to pick, a document). */
function structural(sc: Scrubber, trigger: Record<string, unknown>, actions: Record<string, unknown>[]) {
  if (trigger.kind === 'webhook') trigger.hookId = sc.add('webhook', null, undefined, 'webhook');
  if (trigger.kind === 'live' || trigger.kind === 'product' || trigger.kind === 'file') trigger.ref = sc.add('watch', null, undefined, 'watch');
  for (const a of actions) {
    if (a.kind === 'draft_email' && !(typeof a.to === 'string' && a.to.includes('{{'))) a.to = sc.add('email', null, en('Who the email goes to'), 'email_to');
    if (a.kind === 'fill' && !(typeof a.document === 'string' && a.document.trim())) a.document = sc.add('document', null, undefined, 'document');
  }
}

/** An automation → a shareable template (no personal data; placeholders for it). */
export function exportTemplate(a: Pick<Automation, 'name' | 'trigger' | 'condition' | 'actions'>): AutomationTemplate {
  const sc = new Scrubber();
  const trigger = sc.value(a.trigger) as Record<string, unknown>;
  const actions = (sc.value(a.actions) as Record<string, unknown>[]) ?? [];
  const condition = a.condition ? (sc.value(a.condition) as { words?: string }) : null;
  structural(sc, trigger, actions);
  const name = sc.text(a.name).slice(0, 80);
  return { sara: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, name, trigger, ...(condition ? { condition } : {}), actions, placeholders: used(sc.placeholders, { trigger, actions, condition, name }) };
}

const used = (list: Placeholder[], body: unknown): Placeholder[] => {
  const s = JSON.stringify(body);
  return list.filter((p, i) => s.includes(`{{${p.key}}}`) && list.findIndex((q) => q.key === p.key) === i);
};

/** A file's or pasted text's template, checked and scrubbed again. */
export function parseTemplate(text: string | unknown): AutomationTemplate {
  let raw: unknown = text;
  if (typeof text === 'string') {
    if (text.length > TEMPLATE_MAX) throw new TemplateError(400, en('This template is too big.'));
    try {
      raw = JSON.parse(text.trim().replace(/^\uFEFF/, ''));
    } catch {
      throw new TemplateError(400, en('This isn’t an automation template.'));
    }
  } else if (JSON.stringify(raw ?? null).length > TEMPLATE_MAX) throw new TemplateError(400, en('This template is too big.'));
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!t || t.sara !== TEMPLATE_FORMAT || Number(t.version) !== TEMPLATE_VERSION || typeof t.name !== 'string' || !t.name.trim()) throw new TemplateError(400, en('This isn’t an automation template.'));
  const tr = t.trigger && typeof t.trigger === 'object' ? (t.trigger as Record<string, unknown>) : null;
  if (!tr || !TRIGGER_KINDS.includes(tr.kind as never)) throw new TemplateError(400, en('This isn’t an automation template.'));
  const acts = Array.isArray(t.actions) ? t.actions.filter((x) => x && typeof x === 'object' && ACTION_KINDS.includes((x as { kind: never }).kind)) : [];
  if (!acts.length) throw new TemplateError(400, en('This template has nothing to do.'));
  const declared: Placeholder[] = (Array.isArray(t.placeholders) ? t.placeholders : [])
    .slice(0, 30)
    .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
    .filter((p) => typeof p.key === 'string' && /^[a-z][a-z0-9_]{0,30}$/.test(p.key))
    .map((p) => ({ key: String(p.key), kind: (Object.keys(KIND_LABEL).includes(String(p.kind)) ? p.kind : 'text') as PlaceholderKind, label: typeof p.label === 'string' && p.label.trim() ? p.label.replace(EMAIL, '').slice(0, 120) : KIND_LABEL.text }));
  const sc = new Scrubber(declared);
  const trigger = sc.value(tr) as Record<string, unknown>;
  const actions = sc.value(acts.slice(0, 6)) as Record<string, unknown>[];
  const condition = t.condition && typeof t.condition === 'object' ? (sc.value(t.condition) as { words?: string }) : null;
  structural(sc, trigger, actions);
  const name = sc.text(t.name).slice(0, 80);
  const description = typeof t.description === 'string' ? sc.text(t.description).slice(0, 300) : undefined;
  return { sara: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, name, ...(description ? { description } : {}), trigger, ...(condition ? { condition } : {}), actions, placeholders: used(sc.placeholders, { trigger, actions, condition, name, description }) };
}

/** A template + the person's answers → a draft for the normal preview / create. */
export function fillTemplate(tpl: AutomationTemplate, values: Record<string, unknown> = {}): Draft {
  const got = new Map<string, string>();
  for (const p of tpl.placeholders) {
    const v = String(values[p.key] ?? '').replace(/\{\{|\}\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!v) throw new TemplateError(400, en('Fill in every blank first.'));
    if (p.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new TemplateError(400, en('That isn’t an email address.'));
    if (p.kind === 'watch' && !/^\d+$/.test(v)) throw new TemplateError(400, en('Pick the watch by its number.'));
    got.set(p.key, v);
  }
  const fill = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      const whole = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(v);
      if (whole && key === 'ref') return Number(got.get(whole[1]));
      return v.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (m, k: string) => got.get(k) ?? '');
    }
    if (Array.isArray(v)) return v.map((x) => fill(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fill(x, k)]));
    return v;
  };
  return fill({ name: tpl.name, trigger: tpl.trigger, condition: tpl.condition ?? null, actions: tpl.actions }) as Draft;
}

// ------------------------------------------------------------------ the gallery

const tpl = (name: string, trigger: Record<string, unknown>, actions: Record<string, unknown>[], placeholders: Placeholder[] = []): AutomationTemplate => ({ sara: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, name, trigger, actions, placeholders });

/** Ten ready-made templates (names and pitches are translated; the instructions are hers to read). */
export const GALLERY: { id: string; name: string; pitch: string; template: AutomationTemplate }[] = [
  {
    id: 'timesheet',
    name: en('Weekly time sheet'),
    pitch: en('Every Friday at 3 PM: fills your time sheet template from the week’s work events and sends you the copy to check.'),
    template: tpl('Weekly time sheet', { kind: 'schedule', every: 'week', days: [5], time: '15:00' }, [
      { kind: 'fill', document: '{{document}}', timesheet: { week: 'this', lunchMinutes: 0, regularHours: 8 } },
      { kind: 'notify', text: 'Your time sheet for the week of {week} is filled: {files}. Check it, then send it on.', how: 'phone' },
    ], [{ key: 'document', kind: 'document', label: en('Your time sheet template (its name in the Library)') }]),
  },
  {
    id: 'bills',
    name: en('Bill reminders'),
    pitch: en('On the 1st of each month at 9 AM: lists the bills due this month with their dates and amounts.'),
    template: tpl('Bill reminders', { kind: 'schedule', every: 'month', day: 1, time: '09:00' }, [{ kind: 'task', prompt: 'List my bills due this month with their due dates and amounts, soonest first. Tell me which ones are not on autopay.' }]),
  },
  {
    id: 'packages',
    name: en('Package alerts'),
    pitch: en('When an email says a package shipped or is out for delivery: tells you what is coming and when.'),
    template: tpl('Package alerts', { kind: 'email', words: 'shipped' }, [{ kind: 'task', prompt: 'This email is about a package. Tell me in one line what is coming, from whom and the expected delivery day. Do not open links.' }]),
  },
  {
    id: 'portfolio',
    name: en('Morning portfolio'),
    pitch: en('Weekdays at 7:30 AM: a short summary of the stocks and funds you watch.'),
    template: tpl('Morning portfolio', { kind: 'schedule', every: 'weekdays', time: '07:30' }, [{ kind: 'task', prompt: 'Give me a short morning summary of my portfolio watchlist: yesterday’s close, the change, and anything unusual. No advice, just the facts.' }]),
  },
  {
    id: 'games',
    name: en('Team game alerts'),
    pitch: en('An hour before a calendar event with “game” in it: reminds you, with what to bring.'),
    template: tpl('Team game alerts', { kind: 'calendar', minutes: 60, words: 'game' }, [{ kind: 'notify', text: 'Game in an hour: {detail}. Bring the water bottles and the uniform.', how: 'phone' }]),
  },
  {
    id: 'invoice-hours',
    name: en('Friday invoice hours'),
    pitch: en('Fridays at 4 PM: totals the hours you tracked this week per client and drafts the invoices for you to check.'),
    template: tpl('Friday invoice hours', { kind: 'schedule', every: 'week', days: [5], time: '16:00' }, [{ kind: 'task', prompt: 'Total the hours I tracked this week per client and draft an invoice for each one. Show me the drafts; do not send anything.' }]),
  },
  {
    id: 'school',
    name: en('School newsletters to calendar'),
    pitch: en('When the school’s newsletter arrives: finds the dates in it and suggests calendar events (you approve each one).'),
    template: tpl('School newsletters to calendar', { kind: 'email', from: '{{school_email}}', words: 'newsletter' }, [{ kind: 'task', prompt: 'Read this school newsletter. List every date in it (events, days off, deadlines) and offer to add each one to my calendar. Ask before adding anything.' }], [{ key: 'school_email', kind: 'email', label: en('The school’s email address') }]),
  },
  {
    id: 'grocery',
    name: en('Grocery reorder reminder'),
    pitch: en('Sundays at 10 AM: reminds you to check the pantry and adds what you say to the shopping list.'),
    template: tpl('Grocery reorder reminder', { kind: 'schedule', every: 'week', days: [0], time: '10:00' }, [{ kind: 'notify', text: 'Time to check the pantry. Tell me what is running low and I’ll add it to the shopping list.', how: 'phone' }]),
  },
  {
    id: 'birthdays',
    name: en('Birthday reminders'),
    pitch: en('Every morning at 8 AM: tells you whose birthday is in the next 7 days.'),
    template: tpl('Birthday reminders', { kind: 'schedule', every: 'day', time: '08:00' }, [{ kind: 'task', prompt: 'Check my contacts, memories and reminders for birthdays in the next 7 days. If there are any, tell me whose and when, and suggest a card or a message. If none, say nothing.' }]),
  },
  {
    id: 'weekly-review',
    name: en('Weekly review'),
    pitch: en('Sundays at 5 PM: what got done, what slipped and the three things that matter next week.'),
    template: tpl('Weekly review', { kind: 'schedule', every: 'week', days: [0], time: '17:00' }, [{ kind: 'task', prompt: 'Do my weekly review: what I finished this week, what slipped, what is waiting on other people, and the three things that matter most next week.' }]),
  },
];

export const PLACEHOLDER_LABELS = Object.values(KIND_LABEL);
