// Phase 104 (MI1, docs/design/MOVE_IN.md §6.8): old cron jobs → scheduled tasks. A job that maps onto
// a planner repeat (daily, weekdays, weekly, monthly at a time) becomes a task with that repeat; a
// one-shot still in the future becomes a reminder; anything else is listed for the owner with its
// schedule in plain words. Imported tasks never act by themselves (a planner task only shows up in
// her lists), so a moved agent doesn't suddenly message people from a new place; scripts never run.
import { type Repeat, zonedParts, zonedToUtc } from '../planner.ts';
import type { ScheduleData } from './types.ts';

export interface OldJob {
  id: string;
  name: string;
  prompt: string;
  /** cron | interval | every | once | at */
  kind: string;
  expr?: string;
  everyMs?: number;
  at?: string;
  tz?: string;
  enabled: boolean;
  script?: string;
  skills?: string[];
  deliver?: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A 5-field cron expression in plain words ("at 09:00 on the 1st and 15th"). */
export function cronWords(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `on the schedule "${expr}"`;
  const [mi, h, dom, mon, dow] = f;
  const time = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `at ${pad(+h)}:${pad(+mi)}` : /^\d+$/.test(mi) && h === '*' ? `at minute ${mi} of every hour` : `at "${mi} ${h}"`;
  const ord = (n: string) => (/^\d+$/.test(n) ? `${n}${['th', 'st', 'nd', 'rd'][+n % 10 > 3 || [11, 12, 13].includes(+n % 100) ? 0 : +n % 10]}` : n);
  const parts = [time];
  if (dom !== '*') parts.push(`on the ${dom.split(',').map(ord).join(' and ')}`);
  if (mon !== '*') parts.push(`in month ${mon}`);
  if (dow !== '*') parts.push(dow === '1-5' ? 'on weekdays' : `on ${dow.split(',').map((d) => DAYS[+d % 7] ?? d).join(' and ')}`);
  if (dom === '*' && dow === '*' && mon === '*') parts.push('every day');
  return parts.join(' ');
}

/** The next time HH:MM (on weekday `wd` / day of month `dom` when given) in a zone, after `now`. */
function nextAt(now: Date, h: number, mi: number, tz: string | undefined, rule: { wd?: number; weekdays?: boolean; dom?: number }): string {
  const p = zonedParts(now, tz);
  for (let k = 0; k < 400; k++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + k));
    const wd = day.getUTCDay();
    if (rule.wd !== undefined && wd !== rule.wd) continue;
    if (rule.weekdays && (wd === 0 || wd === 6)) continue;
    if (rule.dom !== undefined && day.getUTCDate() !== rule.dom) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
    if (at.getTime() > now.getTime()) return at.toISOString();
  }
  return zonedToUtc(p.y, p.mo, p.d, h, mi, tz).toISOString();
}

/** Hermes `every 2h` / `30m`, OpenClaw everyMs → minutes. */
export function intervalMinutes(expr: string | undefined, everyMs?: number): number | undefined {
  if (everyMs && everyMs > 0) return Math.round(everyMs / 60_000);
  const m = /^(?:every\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(String(expr ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Math.round(/^h/i.test(m[2]) ? n * 60 : /^d/i.test(m[2]) ? n * 1440 : n);
}

/** A zone name Intl knows (IANA), else undefined. */
export function validZone(tz: string | undefined | null): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function mapJob(j: OldJob, now: Date, defaultTz: string | undefined, agentName: string): ScheduleData {
  const tz = validZone(j.tz) ?? validZone(defaultTz);
  const title = (j.name || j.prompt || 'Scheduled job').slice(0, 200);
  const extra: string[] = [];
  if (j.prompt) extra.push(`What ${agentName} did: ${j.prompt}`);
  if (j.deliver) extra.push(`It sent the result to ${j.deliver} (reconnect that channel in Settings → Connections; until then it stays in the app).`);
  if (j.skills?.length) extra.push(`Skills it used: ${j.skills.join(', ')}.`);
  if (j.script) extra.push(`It ran a script (${j.script}). Sara never runs imported scripts: check it before you rebuild it.`);
  if (!j.enabled) extra.push('It was paused on the old agent.');
  extra.push(`Moved in from ${agentName}.`);
  const notes = extra.join('\n');
  const kind = j.kind.toLowerCase();
  if (kind === 'once' || kind === 'at' || (!j.expr && j.at)) {
    const raw = j.at ?? j.expr ?? '';
    let at = new Date(raw);
    const mins = intervalMinutes(raw);
    if (Number.isNaN(at.getTime()) && mins) at = new Date(now.getTime() + mins * 60_000);
    if (Number.isNaN(at.getTime())) return { target: 'needs-you', title, notes, words: `once, at "${raw}"`, why: "I couldn't read when it was meant to happen." };
    const words = `once, on ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    if (at.getTime() <= now.getTime()) return { target: 'left', title, notes, words, why: 'already happened' };
    if (j.script) return { target: 'task', title, notes, dueAt: at.toISOString(), repeat: 'none', words, why: 'a script job: imported as a task, never run' };
    return { target: 'reminder', title: j.prompt?.slice(0, 300) || title, notes, dueAt: at.toISOString(), words };
  }
  if (kind === 'interval' || kind === 'every' || (!j.expr && j.everyMs)) {
    const mins = intervalMinutes(j.expr, j.everyMs);
    const words = mins ? (mins % 60 === 0 ? `every ${mins / 60} hour${mins === 60 ? '' : 's'}` : `every ${mins} minutes`) : `every "${j.expr}"`;
    return { target: 'needs-you', title, notes, words, why: mins && mins < 15 ? 'repeats more often than every 15 minutes' : 'Sara\'s planner repeats daily, weekdays, weekly or monthly; an interval needs a trigger you set up yourself' };
  }
  const expr = String(j.expr ?? '').trim();
  const f = expr.split(/\s+/);
  const words = cronWords(expr);
  if (f.length === 5 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f[3] === '*') {
    const mi = +f[0];
    const h = +f[1];
    let repeat: Repeat | undefined;
    let rule: { wd?: number; weekdays?: boolean; dom?: number } = {};
    if (f[2] === '*' && f[4] === '*') repeat = 'daily';
    else if (f[2] === '*' && /^(1-5|mon-fri)$/i.test(f[4])) (repeat = 'weekdays'), (rule = { weekdays: true });
    else if (f[2] === '*' && /^[0-7]$/.test(f[4])) (repeat = 'weekly'), (rule = { wd: +f[4] % 7 });
    else if (/^\d{1,2}$/.test(f[2]) && f[4] === '*') (repeat = 'monthly'), (rule = { dom: +f[2] });
    if (repeat && h < 24 && mi < 60) return { target: 'task', title, notes, repeat, dueAt: nextAt(now, h, mi, tz, rule), words, ...(j.script ? { why: 'a script job: imported as a task, never run' } : {}) };
  }
  return { target: 'needs-you', title, notes, words, why: "Sara's planner can't repeat on that schedule yet" };
}

/** Hermes cron/jobs.json ([H8]) or OpenClaw legacy jobs.json / automation rows ([O14][O15]) → OldJob. */
export function normalizeJob(raw: Record<string, unknown>, fallbackTz?: string): OldJob | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const sched = (typeof raw.schedule === 'string' ? safeJson(raw.schedule) ?? { expr: raw.schedule } : raw.schedule ?? {}) as Record<string, unknown>;
  const payload = (typeof raw.payload === 'string' ? safeJson(raw.payload) : raw.payload) as Record<string, unknown> | undefined;
  const prompt = String(raw.prompt ?? payload?.message ?? payload?.text ?? raw.message ?? '').slice(0, 4000);
  const expr = sched.expr ?? sched.cron ?? sched.expression ?? (typeof raw.cron === 'string' ? raw.cron : undefined);
  let kind = String(sched.kind ?? sched.type ?? (sched.everyMs ? 'every' : sched.at ? 'at' : 'cron'));
  if (kind === 'cron' && typeof expr === 'string' && !/\s/.test(expr.trim()) && intervalMinutes(expr)) kind = /^every/i.test(expr) ? 'interval' : 'once';
  return {
    id: String(raw.id ?? raw.name ?? ''),
    name: String(raw.name ?? raw.title ?? '').slice(0, 200),
    prompt,
    kind,
    ...(typeof expr === 'string' ? { expr } : {}),
    ...(Number(sched.everyMs) > 0 ? { everyMs: Number(sched.everyMs) } : {}),
    ...(typeof sched.at === 'string' ? { at: sched.at } : typeof sched.at === 'number' ? { at: new Date(Number(sched.at)).toISOString() } : {}),
    tz: String(sched.tz ?? sched.timezone ?? raw.timezone ?? fallbackTz ?? '') || undefined,
    enabled: raw.enabled !== false && raw.enabled !== 0 && raw.state !== 'paused',
    ...(typeof raw.script === 'string' && raw.script ? { script: raw.script } : {}),
    ...(Array.isArray(raw.skills) ? { skills: raw.skills.map(String) } : {}),
    ...(typeof raw.deliver === 'string' ? { deliver: raw.deliver } : {}),
  };
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Hermes kanban status → ST4 column role (§6.9). `archived` → undefined (not imported). */
export function boardRole(status: string): 'todo' | 'doing' | 'waiting' | 'done' | undefined {
  switch (status.toLowerCase()) {
    case 'triage':
    case 'todo':
    case 'ready':
    case 'backlog':
      return 'todo';
    case 'running':
    case 'doing':
    case 'in_progress':
      return 'doing';
    case 'blocked':
    case 'review':
    case 'waiting':
      return 'waiting';
    case 'done':
    case 'complete':
    case 'completed':
      return 'done';
    default:
      return status.toLowerCase() === 'archived' ? undefined : 'todo';
  }
}
