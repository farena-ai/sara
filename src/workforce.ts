// V3.3 (docs/design/V3WORKFORCE.md): the weekly workforce report. One row per worker (C10,
// src/workers.ts) over a window: jobs done and failed (by when they ended), jobs waiting now, tokens,
// dollars (the usage rows of each job's team task), a few failures with their reason and a few things
// it made. Once a week (his chosen day and hour, his time zone, default Monday 9 AM) it goes where
// the "Workforce report" feed points (src/destinations.ts: its own chat by default, or a project, a
// chat, Telegram, Discord), only when a worker did something. Driven by Workers.tick (no timer).
// Prefs in <dataDir>/workforce.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { describeDest, postAlert } from './destinations.ts';
import { appLanguage, en, trOwner } from './i18n.ts';
import type { WorkerJob } from './workers.ts';

export interface WorkforcePrefs {
  on: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  hour: number;
}
export interface WorkforceRow {
  id: number;
  name: string;
  state: 'on' | 'paused';
  conversationId: string;
  done: number;
  failed: number;
  waiting: number;
  tokens: number;
  usd: number;
  unpriced: number;
  failures: { id: number; title: string; error: string; at: string }[];
  outputs: { id: number; title: string; text: string; at: string }[];
}
export interface WorkforceReport {
  from: string;
  to: string;
  workers: WorkforceRow[];
  total: { done: number; failed: number; waiting: number; tokens: number; usd: number; unpriced: number };
}

const DEFAULT: WorkforcePrefs = { on: true, day: 1, hour: 9 };
const file = (app: AppContext) => join(app.dataDir, 'workforce.json');
type State = Partial<WorkforcePrefs> & { lastWeek?: string };
function readState(app: AppContext): State {
  try {
    return existsSync(file(app)) ? (JSON.parse(readFileSync(file(app), 'utf8')) as State) : {};
  } catch {
    return {};
  }
}
function writeState(app: AppContext, s: State): void {
  writeFileSync(file(app), JSON.stringify(s, null, 1));
}

export function workforcePrefs(app: AppContext): WorkforcePrefs {
  const s = readState(app);
  return { on: s.on ?? DEFAULT.on, day: s.day ?? DEFAULT.day, hour: s.hour ?? DEFAULT.hour };
}

export class WorkforceError extends Error {
  readonly status = 400;
}

export function setWorkforcePrefs(app: AppContext, body: Record<string, unknown>): WorkforcePrefs {
  const cur = readState(app);
  const next: State = { ...cur };
  if (body.on !== undefined) next.on = body.on === true;
  if (body.day !== undefined) {
    const d = Number(body.day);
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new WorkforceError(en('Pick a day of the week.'));
    next.day = d;
  }
  if (body.hour !== undefined) {
    const h = Number(body.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new WorkforceError(en('Pick an hour from 0 to 23.'));
    next.hour = h;
  }
  writeState(app, next);
  return workforcePrefs(app);
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** The report over the last `days` days (default 7), up to now. */
export function workforceReport(app: AppContext, o: { days?: number; now?: Date } = {}): WorkforceReport {
  const now = o.now ?? app.now();
  const days = Math.max(1, Math.min(31, Math.round(o.days ?? 7)));
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const to = now.toISOString();
  const wk = app.workers;
  const total = { done: 0, failed: 0, waiting: 0, tokens: 0, usd: 0, unpriced: 0 };
  if (!wk) return { from, to, workers: [], total };
  const ended = wk.jobsEnded(from, to);
  const workers = wk.list().map((w): WorkforceRow => {
    const mine = ended.filter((j) => j.workerId === w.id);
    const done = mine.filter((j) => j.status === 'done');
    const failed = mine.filter((j) => j.status === 'failed');
    let usd = 0;
    let unpriced = 0;
    for (const j of mine) {
      if (!j.teamTaskId || !app.usage) continue;
      const u = app.usage.forTeam(j.teamTaskId);
      usd += u.usd;
      unpriced += u.unpriced;
    }
    const newest = (a: WorkerJob, b: WorkerJob) => String(b.endedAt).localeCompare(String(a.endedAt)) || b.id - a.id;
    return {
      id: w.id,
      name: w.name,
      state: w.state,
      conversationId: w.conversationId,
      done: done.length,
      failed: failed.length,
      waiting: wk.queuedCount(w.id),
      tokens: mine.reduce((n, j) => n + j.tokens, 0),
      usd: Math.round(usd * 1e6) / 1e6,
      unpriced,
      failures: [...failed].sort(newest).slice(0, 3).map((j) => ({ id: j.id, title: j.title, error: clip(j.error ?? '', 160), at: j.endedAt ?? '' })),
      outputs: [...done].sort(newest).slice(0, 3).map((j) => ({ id: j.id, title: j.title, text: clip(j.result ?? '', 140), at: j.endedAt ?? '' })),
    };
  });
  for (const r of workers) {
    total.done += r.done;
    total.failed += r.failed;
    total.waiting += r.waiting;
    total.tokens += r.tokens;
    total.usd += r.usd;
    total.unpriced += r.unpriced;
  }
  total.usd = Math.round(total.usd * 1e6) / 1e6;
  return { from, to, workers, total };
}

const T = (app: AppContext, s: string, p?: Record<string, unknown>) => trOwner(s, app.settings.get(), p);

function money(app: AppContext, usd: number, unpriced: number): string {
  if (usd <= 0) return unpriced ? T(app, en('cost unknown')) : '';
  return usd < 0.01 ? T(app, en('less than $0.01')) : T(app, en('about {usd}'), { usd: `$${usd.toFixed(2)}` });
}

/** The report as plain chat lines in his language. */
export function workforceText(app: AppContext, r: WorkforceReport): string {
  const s = app.settings.get();
  const lang = appLanguage(s);
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang, { month: 'short', day: 'numeric', timeZone: s.timeZone || 'UTC' });
  const nf = new Intl.NumberFormat(lang);
  const lines = [T(app, en('Your workers this week ({from} to {to})'), { from: day(r.from), to: day(r.to) }), ''];
  for (const [i, w] of r.workers.entries()) {
    if (i) lines.push('');
    if (!w.done && !w.failed && !w.waiting) {
      lines.push(T(app, en('{name}: nothing this week.'), { name: w.name }));
      continue;
    }
    const bits = [T(app, en('{done} done, {failed} failed, {waiting} waiting'), { done: w.done, failed: w.failed, waiting: w.waiting })];
    if (w.tokens) bits.push(T(app, en('{n} tokens'), { n: nf.format(w.tokens) }));
    const cost = money(app, w.usd, w.unpriced);
    if (cost) bits.push(cost);
    lines.push(`**${w.name}**: ${bits.join(' · ')}`);
    if (w.outputs.length) lines.push(`- ${T(app, en('Made: {items}'), { items: w.outputs.map((o) => (o.text ? `${o.title} (${o.text})` : o.title)).join('; ') })}`);
    if (w.failures.length) lines.push(`- ${T(app, en('Failed: {items}'), { items: w.failures.map((f) => (f.error ? `${f.title} (${f.error})` : f.title)).join('; ') })}`);
  }
  if (!r.workers.length) lines.push(T(app, en('You have no workers yet.')));
  else {
    const bits = [T(app, en('{done} done, {failed} failed, {waiting} waiting'), { done: r.total.done, failed: r.total.failed, waiting: r.total.waiting })];
    const cost = money(app, r.total.usd, r.total.unpriced);
    if (cost) bits.push(cost);
    lines.push('', T(app, en('All workers: {line}. Failed jobs can be replayed in Team → Workers that stay.'), { line: bits.join(' · ') }));
  }
  return lines.join('\n');
}

/** Where the weekly report goes now, as a short line. */
export function workforcePostsTo(app: AppContext): string {
  return describeDest(app, 'workforce');
}

/** Sends the report now (the button, or the weekly tick). Returns the chat id here, if any. */
export function sendWorkforceReport(app: AppContext, now: Date = app.now()): string | undefined {
  const r = workforceReport(app, { now });
  const content = workforceText(app, r);
  return postAlert(app, 'workforce', { role: 'assistant', reason: 'proactive', content, meta: { workforce: { from: r.from, to: r.to } } });
}

const localParts = (now: Date, tz: string | undefined) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday)), hour: Number(p.hour) };
};

/**
 * The weekly send. The week's slot is the latest chosen day at or before today (today counts from the
 * chosen hour); each slot is sent once. The first look only records the slot, so turning Sara on (or
 * the report) mid-week never sends an old week at once. Idle weeks send nothing.
 */
export function workforceTick(app: AppContext, now: Date = app.now()): boolean {
  if (!app.workers || app.member) return false;
  const prefs = workforcePrefs(app);
  const l = localParts(now, app.settings.get().timeZone);
  let back = (l.weekday - prefs.day + 7) % 7;
  if (back === 0 && l.hour < prefs.hour) back = 7;
  const d = new Date(`${l.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  const slot = d.toISOString().slice(0, 10);
  const st = readState(app);
  if (st.lastWeek === slot) return false;
  writeState(app, { ...st, lastWeek: slot });
  if (!st.lastWeek || !prefs.on) return false;
  const r = workforceReport(app, { now });
  if (!r.total.done && !r.total.failed) return false;
  postAlert(app, 'workforce', { role: 'assistant', reason: 'proactive', content: workforceText(app, r), meta: { workforce: { from: r.from, to: r.to } } });
  return true;
}
