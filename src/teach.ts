// D1 (docs/design/D1TEACH.md): teach by showing. The browser extension's "Watch me do this" records the
// steps of a task you do once (extension/lib/teach.js); this file is Sara's side of it:
//   cleanTeaching    what the extension sent, checked again: web addresses without query or hash, the
//                    step kinds it knows, short target descriptions, and NO value for any field that is
//                    a password, payment card, one-time code or ID number (src/form-fill.ts fieldKind,
//                    the same rules as pc_fill_form and the extension's form filling) or that holds a
//                    long run of digits. Such steps say "the person types this" and nothing else.
//   TaughtStore      the recordings waiting for review, per space (<space>/taught.json, newest first).
//   skillDraftOf     a SKILL.md draft: what for, where it starts, the numbered steps in words with a
//                    hint where to find each control, and how to do it with her testing browser.
//   automationDraftOf an Automations entry (weekly, a task step that follows the skill), created
//                    switched off by the route so you set when it runs.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Draft as AutomationDraft } from './automations.ts';
import { writeFileAtomic } from './fs-util.ts';
import { fieldKind } from './form-fill.ts';
import { MAX_DESCRIPTION, slugify } from './skills.ts';

export const TEACH = { maxSteps: 60, keep: 20, value: 200, text: 80 } as const;

export type StepKind = 'go' | 'click' | 'type' | 'pick';
export interface StepTarget {
  tag: string;
  type?: string;
  role?: string;
  id?: string;
  name?: string;
  label?: string;
  text?: string;
  href?: string;
  path?: string;
}
export interface TaughtStep {
  kind: StepKind;
  url?: string;
  target?: StepTarget;
  value?: string;
  /** A password / card / code / ID field: the person types it; no value is ever kept. */
  secret?: boolean;
}
export interface Teaching {
  name: string;
  why: string;
  title: string;
  startUrl: string;
  steps: TaughtStep[];
}
export interface Taught extends Teaching {
  id: string;
  at: string;
  /** Saved as this skill already. */
  skillName?: string;
}

const KINDS = new Set<StepKind>(['go', 'click', 'type', 'pick']);
const LONG_DIGITS = /\d[\d ./-]{10,}\d/;
const flat = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A web address without its query or hash (they can hold sign-in tokens), or ''. */
export function pageAddress(v: unknown): string {
  try {
    const u = new URL(String(v ?? '').trim().slice(0, 2000));
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.origin}${u.pathname}`.slice(0, 300) : '';
  } catch {
    return '';
  }
}

function cleanTarget(v: unknown): StepTarget | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const tag = flat(o.tag, 20).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return undefined;
  const t: StepTarget = { tag };
  for (const k of ['type', 'role', 'id', 'name', 'label', 'text', 'path'] as const) {
    const s = flat(o[k], k === 'path' ? 160 : TEACH.text);
    if (s) t[k] = s;
  }
  const href = String(o.href ?? '').trim();
  if (href && !/^(javascript|data|vbscript):/i.test(href)) {
    const clean = flat(href.split(/[?#]/)[0], 200);
    if (clean) t.href = clean;
  }
  return t;
}

/** True when a typed step's field is one whose value is never kept. */
export function secretField(t: StepTarget | undefined): boolean {
  if (!t) return false;
  if (t.type === 'password' || t.type === 'hidden' || t.type === 'file') return true;
  const k = fieldKind({ name: t.label || t.text || '', aid: t.name || t.id, hint: t.label });
  return k === 'password' || k === 'card' || k === 'code' || k === 'id-number';
}

/** What the extension sent, checked again (see the top of this file). */
export function cleanTeaching(b: Record<string, unknown>): Teaching {
  const steps: TaughtStep[] = [];
  for (const raw of Array.isArray(b.steps) ? b.steps : []) {
    if (steps.length >= TEACH.maxSteps) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const kind = String(r.kind) as StepKind;
    if (!KINDS.has(kind)) continue;
    if (kind === 'go') {
      const url = pageAddress(r.url);
      if (url && steps.at(-1)?.url !== url) steps.push({ kind, url });
      continue;
    }
    const target = cleanTarget(r.target);
    if (!target) continue;
    if (kind === 'click') {
      steps.push({ kind, target });
      continue;
    }
    const value = flat(r.value, TEACH.value);
    if (r.secret === true || secretField(target) || LONG_DIGITS.test(value)) steps.push({ kind: 'type', target, secret: true });
    else steps.push({ kind, target, value });
  }
  const startUrl = steps.find((s) => s.kind === 'go')?.url ?? pageAddress(b.url);
  return { name: flat(b.name, 80), why: flat(b.why, 400), title: flat(b.title, 200), startUrl, steps };
}

// ------------------------------------------------------------------ the store
export class TaughtStore {
  readonly #file: string;
  readonly #now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.#file = join(dir, 'taught.json');
    this.#now = now;
  }
  list(): Taught[] {
    try {
      if (!existsSync(this.#file)) return [];
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as { taught?: Taught[] };
      return Array.isArray(raw.taught) ? raw.taught : [];
    } catch {
      return [];
    }
  }
  #write(list: Taught[]): void {
    writeFileAtomic(this.#file, `${JSON.stringify({ taught: list.slice(0, TEACH.keep) })}\n`, 0o600);
  }
  get(id: string): Taught | undefined {
    return this.list().find((t) => t.id === id);
  }
  add(t: Teaching, _device = ''): Taught {
    const item: Taught = { ...t, id: randomBytes(6).toString('base64url'), at: this.#now().toISOString() };
    this.#write([item, ...this.list()]);
    return item;
  }
  patch(id: string, p: Partial<Taught>): Taught | undefined {
    const list = this.list();
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return undefined;
    list[i] = { ...list[i]!, ...p, id };
    this.#write(list);
    return list[i];
  }
  remove(id: string): boolean {
    const list = this.list();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) return false;
    this.#write(next);
    return true;
  }
}

// ------------------------------------------------------------------ drafts
const what = (t?: StepTarget) => t?.label || t?.text || t?.name || t?.id || t?.tag || 'it';
const where = (t?: StepTarget) => {
  if (!t) return '';
  const hint = t.id ? `#${t.id}` : t.name ? `${t.tag}[name="${t.name}"]` : t.path || '';
  return hint ? ` (\`${hint}\`)` : '';
};

/** One step in words (also the line the review list shows). */
export function stepLine(s: TaughtStep): string {
  if (s.kind === 'go') return `Open ${s.url}`;
  if (s.kind === 'click') return `Click “${what(s.target)}”${s.target?.tag === 'a' && s.target.href ? ` (a link to ${s.target.href})` : ''}${where(s.target)}`;
  if (s.secret) return `“${what(s.target)}”: ask the person to type it themselves (a password, card, code or ID number is never recorded, never filled by you)${where(s.target)}`;
  if (s.kind === 'pick') return `Pick “${s.value ?? ''}” in “${what(s.target)}”${where(s.target)}`;
  return `Type “${s.value ?? ''}” into “${what(s.target)}”${where(s.target)}`;
}

export const titleOf = (t: Teaching): string => t.name || t.title || (t.startUrl ? new URL(t.startUrl).hostname : '') || 'A task shown in the browser';

/** A SKILL.md draft from the steps (name, description, body). */
export function skillDraftOf(t: Teaching): { name: string; description: string; body: string } {
  const title = titleOf(t);
  const name = slugify(title).slice(0, 60).replace(/-$/, '') || 'shown-task';
  let host = '';
  try {
    host = t.startUrl ? new URL(t.startUrl).hostname : '';
  } catch {
    /* no address */
  }
  const description = `${t.why ? `${t.why.replace(/[.!]?$/, '.')} ` : ''}How the owner does “${title}”${host ? ` on ${host}` : ''} in the browser, shown once step by step. Use when asked to do this again.`.slice(0, MAX_DESCRIPTION);
  const lines = [
    `# ${title}`,
    '',
    `The owner showed you this once in the browser${t.startUrl ? `, starting at ${t.startUrl}` : ''}.${t.why ? ` What it's for: ${t.why}` : ''}`,
    '',
    '## Steps',
    '',
    ...t.steps.map((s, i) => `${i + 1}. ${stepLine(s)}`),
    '',
    '## How to do it',
    '',
    '- Typed values are what the owner typed that time: ask whether to use them again or what to type instead.',
    '- With your testing browser: `browser_open` the address, then `browser_click` (the visible text, or the hint in brackets as a selector), `browser_type` and `browser_read` to check each page before the next step.',
    '- Never type a password, card number, code or ID number yourself: those steps are the owner\'s.',
    '- Stop and ask before anything that buys, sends, signs or deletes, and when a page no longer matches these steps.',
  ];
  return { name, description, body: `${lines.join('\n')}\n` };
}

/** An automation draft that follows the skill once a week (the route creates it switched off). */
export function automationDraftOf(t: Teaching, skillName: string): AutomationDraft {
  const title = titleOf(t);
  return {
    name: title.slice(0, 80),
    trigger: { kind: 'schedule', every: 'week', time: '09:00', days: [1] },
    actions: [{ kind: 'task', prompt: `Do “${title}” the way I showed you: follow your skill ${skillName} step by step. Ask me before anything that buys, sends, signs or deletes, and stop if a page no longer matches.`.slice(0, 2000) }],
  };
}
