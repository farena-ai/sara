// U5.34 (docs/DASHBOARD.md): the server dashboard (Settings → Privacy & system → Health). One card per
// server, made from the same report-shaped object for this server and for a linked server: the S9b
// support report (src/routes/support.ts `supportReport`), which a friend's server sends only while it
// gave this owner an active help pass. Pure: no I/O here (the route gathers, this turns it into rows).
import { en } from './i18n.ts';

export type DashState = 'ok' | 'warn' | 'bad' | 'unknown';
export type DashKey = 'health' | 'versions' | 'disk' | 'memory' | 'cpu' | 'backups' | 'errors' | 'repair' | 'updates';
export interface DashRow {
  key: DashKey;
  state: DashState;
  /** An English key with {params}; the page translates it. */
  text: string;
  params?: Record<string, string | number>;
  /** This server: the Settings page with the details. */
  page?: string;
  /** A linked server: the place to open (its Messages chat has the help-pass report). */
  view?: string;
}
export interface DashCard {
  name: string;
  self: boolean;
  /** A linked server's S9a link id. */
  link?: string;
  state: DashState;
  checkedAt: string;
  error?: string;
  rows: DashRow[];
  apps: { kind: string; version: string; behind: boolean }[];
}

const WEEK = 7 * 86_400_000;
const RANK: Record<DashState, number> = { unknown: 0, ok: 1, warn: 2, bad: 3 };
/** Where each row's details live on this server. */
const PAGE: Record<DashKey, string> = { health: 'dh-health', versions: 'dh-updates', disk: 'dh-health', memory: 'dh-health', cpu: 'dh-health', backups: 'dh-backups', errors: 'dh-health', repair: 'dh-health', updates: 'dh-updates' };
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const gb = (b: number) => (b / 1e9).toFixed(1);
type Rep = Record<string, any>;

function ageText(ms: number): { text: string; params: Record<string, number> } {
  const h = Math.max(0, Math.round(ms / 3600_000));
  if (h < 1) return { text: en('Less than an hour ago'), params: {} };
  if (h < 48) return { text: en('{n} hours ago'), params: { n: h } };
  return { text: en('{n} days ago'), params: { n: Math.round(h / 24) } };
}

/** One server's card. `rep` undefined (with `error`): the server could not be read. */
export function serverCard(rep: Rep | undefined, o: { name: string; self: boolean; link?: string; now: Date; error?: string }): DashCard {
  const checkedAt = typeof rep?.at === 'string' && Number.isFinite(Date.parse(rep.at)) ? rep.at : o.now.toISOString();
  const base = { name: o.name, self: o.self, ...(o.link ? { link: o.link } : {}), checkedAt };
  if (!rep) return { ...base, state: 'unknown', error: o.error ?? en('Could not be read.'), rows: [], apps: [] };
  const rows: DashRow[] = [];
  const add = (key: DashKey, state: DashState, text: string, params?: Record<string, string | number>) => rows.push({ key, state, text, ...(params ? { params } : {}), ...(o.self ? { page: PAGE[key] } : { view: 'msgs' }) });
  const now = o.now.getTime();
  const h = (rep.health ?? {}) as Rep;

  // Health checks.
  const checks: Rep[] = Array.isArray(h.checks) ? h.checks : [];
  const failing = checks.filter((c) => c && c.ok === false).length;
  if (!rep.health || h.error) add('health', 'unknown', en('Could not be read.'));
  else if (failing) add('health', 'bad', en('{n} check(s) failing'), { n: failing, first: String(checks.find((c) => c?.ok === false)?.name ?? '') });
  else add('health', 'ok', en('All checks pass'));

  // Versions: the server and each app install.
  const version = String(rep.version?.server ?? '');
  const apps = (Array.isArray(rep.apps) ? rep.apps : []).map((a: Rep) => ({ kind: String(a?.kind ?? '?'), version: String(a?.version ?? '?'), behind: a?.behind === true }));
  const behind = apps.filter((a: { behind: boolean }) => a.behind).length;
  if (behind) add('versions', 'warn', en('Server {version}; {n} app install(s) older'), { version, n: behind });
  else add('versions', version ? 'ok' : 'unknown', apps.length ? en('Server {version}; {n} app install(s) up to date') : en('Server {version}'), { version, n: apps.length });

  // Disk space.
  const free = num(h.disk?.freeBytes);
  const total = num(h.disk?.totalBytes);
  if (free === undefined || !total) add('disk', 'unknown', en('Not reported here'));
  else add('disk', free < 1e9 || free / total < 0.02 ? 'bad' : free < 5e9 || free / total < 0.1 ? 'warn' : 'ok', en('{free} GB free of {total} GB'), { free: gb(free), total: gb(total) });

  // Memory and processor load, from the operating system.
  const sys = (rep.system ?? {}) as Rep;
  const mt = num(sys.memTotal);
  const mf = num(sys.memFree);
  if (!mt || mf === undefined) add('memory', 'unknown', en('Not reported here'));
  else {
    const pct = Math.round(((mt - mf) / mt) * 100);
    add('memory', pct > 95 ? 'bad' : pct > 90 ? 'warn' : 'ok', en('{pct}% used ({free} GB free)'), { pct, free: gb(mf) });
  }
  const load = Array.isArray(sys.load) ? num(sys.load[0]) : undefined;
  const cpus = num(sys.cpus);
  if (load === undefined || !cpus) add('cpu', 'unknown', en('Not reported on this system'));
  else {
    const per = load / cpus;
    add('cpu', per > 1.5 ? 'bad' : per > 1 ? 'warn' : 'ok', en('{load} on {n} cores'), { load: load.toFixed(2), n: cpus });
  }

  // Backups.
  const last = typeof h.backups?.last === 'string' ? Date.parse(h.backups.last) : NaN;
  if (!rep.health) add('backups', 'unknown', en('Could not be read.'));
  else if (!Number.isFinite(last)) add('backups', 'bad', en('None yet'));
  else {
    const a = ageText(now - last);
    add('backups', now - last > WEEK ? 'bad' : now - last > 3 * 86_400_000 ? 'warn' : 'ok', a.text, a.params);
  }

  // Recent errors (the last week).
  const recent = (l: unknown) => (Array.isArray(l) ? l : []).filter((x: Rep) => !x?.at || now - Date.parse(x.at) <= WEEK);
  const turns = recent(rep.errors?.turns).length;
  const tools = recent(rep.errors?.tools).length;
  const providers = recent(rep.errors?.providers).length;
  const errs = turns + tools + providers;
  if (!rep.errors) add('errors', 'unknown', en('Could not be read.'));
  else add('errors', turns >= 3 || providers > 0 ? 'bad' : errs ? 'warn' : 'ok', errs ? en('{n} in the last week') : en('None in the last week'), { n: errs });

  // Self-repair problems open.
  const open = num(rep.repair?.open);
  if (open === undefined) add('repair', 'unknown', en('Not reported'));
  else add('repair', open ? 'warn' : 'ok', open ? en('{n} problem(s) open') : en('No problems open'), { n: open });

  // Updates pending.
  const u = (rep.version?.update ?? null) as Rep | null;
  if (!u) add('updates', 'unknown', en('Not reported'));
  else if (u.state === 'failed' || u.state === 'rolledback') add('updates', 'bad', en('The last update did not finish'));
  else if (u.state === 'available' || u.required) add('updates', u.required || u.security ? 'bad' : 'warn', u.security ? en('Security update {latest} waiting') : en('{latest} waiting'), { latest: String(u.latest ?? '') });
  else add('updates', 'ok', en('None waiting'));

  const state = rows.reduce<DashState>((w, r) => (RANK[r.state] > RANK[w] ? r.state : w), 'unknown');
  return { ...base, state: state === 'unknown' && rows.some((r) => r.state === 'ok') ? 'ok' : state, rows, apps };
}
