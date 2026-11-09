// EC28 (docs/ops/EC1828_DESIGN.md): is this install ready for real use? One page of areas, each
// ready / needs attention / not ready with one fix. Two halves: `gatherReadiness` collects plain
// facts from what already exists (health, the safety check-up, backups, operations queues, the
// audit trail, metrics settings, the last restore drill); `readinessReport` is a pure rule
// function over those facts. The server sends codes and numbers; the page words them (t()).
// Safety-backed rows pass the check-up's own line through (already in the owner's language).
import { statfsSync } from 'node:fs';
import { createProvider } from './providers/registry.ts';
import { vaultKeyFor, type AppContext } from './chat.ts';
import { DEFAULT_BACKUP, listBackups } from './backup.ts';
import { auditTrail } from './audit-trail.ts';
import { telemetrySettings } from './telemetry/config.ts';
import type { CheckStatus, SafetyDeps } from './safety-check.ts';
import { runSafetyCheck } from './safety-check.ts';
import type { OperationsMonitor } from './operations.ts';
import type { DrillRecord } from './restore-drill.ts';

export type AreaStatus = 'ready' | 'attention' | 'not-ready';
export type AreaFix = { open: string } | { command: string } | { action: 'drill' | 'probe' | 'recovery' };
export interface Area {
  id: string;
  status: AreaStatus;
  /** Why, as a code the page words (e.g. "old", "never"); "safety" means `line` holds the words. */
  reason: string;
  params?: Record<string, unknown>;
  line?: string;
  fix?: AreaFix;
}
export interface ReadinessReport {
  verdict: AreaStatus;
  counts: Record<AreaStatus, number>;
  areas: Area[];
}

/** A restore drill counts as recent proof for this many days. */
export const DRILL_FRESH_DAYS = 30;
/** The newest backup should be younger than this. */
export const BACKUP_FRESH_HOURS = 48;
export const DISK_LOW_BYTES = 1e9;
export const DISK_TIGHT_BYTES = 5e9;

type SafetyRow = { status: CheckStatus; line: string; accepted?: boolean; fixes: ({ open?: string; command?: string })[] };
export interface ReadinessFacts {
  backups: { count: number; newestAt: string | null; newestName: string | null; auto: boolean };
  drill: DrillRecord | undefined;
  offsiteTest: { at: string; ok: boolean } | undefined;
  diskFreeBytes: number | null;
  model: { configured: boolean; probe?: { at: string; ok: boolean; error?: string } };
  bridges: { name: string; page: string; running: boolean; error?: string }[];
  paused: { jobs: number; teams: number; deliveries: number };
  safety: Record<string, SafetyRow>;
  audit: { present: boolean; ok: boolean };
  metrics: boolean;
}

const RANK: Record<AreaStatus, number> = { ready: 0, attention: 1, 'not-ready': 2 };
const fromSafety = (row: SafetyRow): AreaStatus => (row.status === 'red' ? 'not-ready' : row.status === 'amber' && !row.accepted ? 'attention' : 'ready');

/** Several check-up rows as one area: the worst one speaks; its first fix, or the area's page. */
function safetyArea(id: string, rows: (SafetyRow | undefined)[], page: string, none?: string): Area {
  const present = rows.filter((r): r is SafetyRow => Boolean(r));
  if (!present.length) return { id, status: 'ready', reason: none ?? 'unknown', fix: { open: page } };
  const worst = present.reduce((a, b) => (RANK[fromSafety(b)] > RANK[fromSafety(a)] ? b : a));
  const status = fromSafety(worst);
  const f = worst.fixes.find((x) => x.open || x.command);
  const fix: AreaFix = f?.open ? { open: f.open } : f?.command ? { command: f.command } : { open: page };
  return { id, status, reason: 'safety', line: worst.line, fix };
}

export function readinessReport(f: ReadinessFacts, now: Date): ReadinessReport {
  const t = now.getTime();
  const areas: Area[] = [];
  // Backups on this computer.
  {
    const b = f.backups;
    const hours = b.newestAt ? Math.round((t - Date.parse(b.newestAt)) / 3600_000) : null;
    const fix = { open: 'settings:dh-backups' };
    if (!b.count || hours === null) areas.push({ id: 'backups', status: 'not-ready', reason: 'none', fix });
    else if (!b.auto) areas.push({ id: 'backups', status: 'attention', reason: 'auto-off', params: { hours, n: b.count }, fix });
    else if (hours >= BACKUP_FRESH_HOURS) areas.push({ id: 'backups', status: 'attention', reason: 'old', params: { hours, n: b.count }, fix });
    else areas.push({ id: 'backups', status: 'ready', reason: 'ok', params: { hours, n: b.count }, fix });
  }
  // The last proven restore.
  {
    const d = f.drill;
    const offsiteOk = f.offsiteTest?.ok === true;
    const fix = { action: 'drill' as const };
    if (!d) areas.push({ id: 'drill', status: 'not-ready', reason: 'never', params: { offsiteOk }, fix });
    else {
      const days = Math.floor((t - Date.parse(d.at)) / 86_400_000);
      const params = { days, seconds: Math.round((d.totalMs ?? 0) / 100) / 10, lossHours: d.dataLossHours ?? null, offsiteOk };
      if (!d.ok) areas.push({ id: 'drill', status: 'not-ready', reason: 'failed', params: { ...params, error: d.error ?? '' }, fix });
      else if (days > DRILL_FRESH_DAYS) areas.push({ id: 'drill', status: 'attention', reason: 'stale', params, fix });
      else areas.push({ id: 'drill', status: 'ready', reason: 'ok', params, fix });
    }
  }
  areas.push(safetyArea('offsite', [f.safety.offsite], 'settings:dh-backups'));
  // Disk space where her data lives.
  {
    const free = f.diskFreeBytes;
    const fix = { open: 'settings:dh-health' };
    if (free === null || !Number.isFinite(free)) areas.push({ id: 'disk', status: 'attention', reason: 'unknown', fix });
    else {
      const gb = (free / 1e9).toFixed(1);
      areas.push({ id: 'disk', status: free < DISK_LOW_BYTES ? 'not-ready' : free < DISK_TIGHT_BYTES ? 'attention' : 'ready', reason: free < DISK_TIGHT_BYTES ? 'low' : 'ok', params: { gb }, fix });
    }
  }
  // The model: set up, and answering.
  {
    const m = f.model;
    if (!m.configured) areas.push({ id: 'model', status: 'not-ready', reason: 'none', fix: { open: 'settings:models-providers' } });
    else if (!m.probe) areas.push({ id: 'model', status: 'attention', reason: 'unprobed', fix: { action: 'probe' } });
    else if (!m.probe.ok) areas.push({ id: 'model', status: 'not-ready', reason: 'unreachable', params: { error: m.probe.error ?? '' }, fix: { action: 'probe' } });
    else areas.push({ id: 'model', status: 'ready', reason: 'ok', fix: { action: 'probe' } });
  }
  // Chat apps that are switched on are connected.
  {
    const down = f.bridges.filter((b) => !b.running);
    if (!f.bridges.length) areas.push({ id: 'bridges', status: 'ready', reason: 'none' });
    else if (down.length) areas.push({ id: 'bridges', status: 'attention', reason: 'down', params: { names: down.map((b) => b.name).join(', '), n: down.length, total: f.bridges.length }, fix: { open: `settings:${down[0].page}` } });
    else areas.push({ id: 'bridges', status: 'ready', reason: 'ok', params: { names: f.bridges.map((b) => b.name).join(', '), n: 0, total: f.bridges.length } });
  }
  // Paused or uncertain work (reviewed in the Recovery list on the same page).
  {
    const p = f.paused;
    const any = p.jobs + p.teams + p.deliveries > 0;
    areas.push({ id: 'paused', status: any ? 'attention' : 'ready', reason: any ? 'some' : 'none', params: { ...p }, ...(any ? { fix: { action: 'recovery' as const } } : {}) });
  }
  areas.push(safetyArea('updates', [f.safety.version], 'settings:dh-updates'));
  areas.push(safetyArea('https', [f.safety['open-door'], f.safety.bind, f.safety.https], 'settings:co-phone'));
  areas.push(safetyArea('signin', [f.safety['two-step'], f.safety.token, f.safety.devices], 'settings:dh-devices'));
  areas.push(safetyArea('policy', [f.safety.policy], 'settings:dh-policy', 'none'));
  // Monitoring and the audit trail.
  if (!f.audit.present || !f.audit.ok) areas.push({ id: 'monitoring', status: 'not-ready', reason: f.audit.present ? 'audit-broken' : 'audit-missing', fix: { open: 'settings:dh-audit' } });
  else if (!f.metrics) areas.push({ id: 'monitoring', status: 'attention', reason: 'metrics-off', fix: { open: 'settings:dh-operations' } });
  else areas.push({ id: 'monitoring', status: 'ready', reason: 'ok', fix: { open: 'settings:dh-operations' } });

  const counts: Record<AreaStatus, number> = { ready: 0, attention: 0, 'not-ready': 0 };
  for (const a of areas) counts[a.status]++;
  const verdict: AreaStatus = counts['not-ready'] ? 'not-ready' : counts.attention ? 'attention' : 'ready';
  return { verdict, counts, areas };
}

// ---- gathering the facts from a running server -------------------------------------------

export interface ReadinessDeps {
  app: AppContext;
  /** The server's data root (backups live in <root>/backups). */
  rootDir: string;
  safety: SafetyDeps;
  operations?: OperationsMonitor;
  /** Plugin bridges switched on for the main companion: name, settings page, process running. */
  pluginBridges?: () => { name: string; page: string; running: boolean }[];
}

type Probe = { at: string; ok: boolean; error?: string };
const probes = new WeakMap<AppContext, Probe>();
/** How long a model probe result is reused. */
export const PROBE_CACHE_MS = 60_000;

/** Lists the default provider's models (free, 8 s cap) to prove it answers. Cached for a minute. */
export async function probeModel(app: AppContext, o: { force?: boolean } = {}): Promise<Probe | undefined> {
  const s = app.settings.get();
  const cfg = s.providers.find((p) => p.id === s.defaultProviderId) ?? s.providers[0];
  if (!cfg) return undefined;
  const cached = probes.get(app);
  if (!o.force && cached && app.now().getTime() - Date.parse(cached.at) < PROBE_CACHE_MS) return cached;
  const at = app.now().toISOString();
  let r: Probe;
  try {
    const provider = (app.providerFactory ?? createProvider)(cfg, app.vault.get(vaultKeyFor(cfg.id)), app.subscriptions);
    await provider.listModels(AbortSignal.timeout(8000));
    r = { at, ok: true };
  } catch (err) {
    r = { at, ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
  }
  probes.set(app, r);
  return r;
}
/** The cached probe, without probing. */
export const lastProbe = (app: AppContext): Probe | undefined => probes.get(app);

export async function gatherReadiness(d: ReadinessDeps, o: { probe?: boolean } = {}): Promise<ReadinessFacts> {
  const { app } = d;
  const s = app.settings.get();
  let backups: ReadinessFacts['backups'] = { count: 0, newestAt: null, newestName: null, auto: true };
  try {
    const list = listBackups(d.rootDir);
    backups = { count: list.length, newestAt: list[0]?.createdAt ?? null, newestName: list[0]?.name ?? null, auto: { ...DEFAULT_BACKUP, ...s.backup }.auto };
  } catch {
    /* no backup evidence */
  }
  let diskFreeBytes: number | null = null;
  try {
    const st = statfsSync(d.rootDir);
    diskFreeBytes = Number(st.bavail) * Number(st.bsize);
  } catch {
    /* unsupported here */
  }
  const configured = Boolean(s.providers.length && (s.defaultModel || s.providers.some((p) => p.defaultModel)));
  const probe = configured ? (o.probe === false ? lastProbe(app) : await probeModel(app)) : undefined;
  const bridges: ReadinessFacts['bridges'] = [];
  for (const [key, name, page] of [['telegram', 'Telegram', 'co-telegram'], ['discord', 'Discord', 'co-discord']] as const) {
    if (!s[key]?.enabled) continue;
    let st: { running: boolean; error?: string | null } | undefined;
    try {
      st = app.bridges?.[key]?.status();
    } catch {
      st = undefined;
    }
    bridges.push({ name, page, running: Boolean(st?.running), ...(st?.error ? { error: st.error } : {}) });
  }
  try {
    bridges.push(...(d.pluginBridges?.() ?? []));
  } catch {
    /* plugin evidence unavailable */
  }
  const paused = { jobs: 0, teams: 0, deliveries: 0 };
  if (d.operations) {
    try {
      const q = d.operations.snapshot(app).queues;
      paused.jobs = (q.jobs.states.interrupted ?? 0) + (q.jobs.states.budget ?? 0);
      paused.teams = q.teams.states.interrupted ?? 0;
      paused.deliveries = (q.deliveries.states.outcome_unknown ?? 0) + (q.deliveries.states.queued ?? 0);
    } catch {
      /* no queue evidence */
    }
  }
  const safety: Record<string, SafetyRow> = {};
  try {
    const r = await runSafetyCheck(d.safety, 'page', { log: false });
    for (const c of r.checks) safety[c.id] = { status: c.status, line: c.line, accepted: Boolean(c.accepted), fixes: c.fixes.map((x) => ({ ...(x.open ? { open: x.open } : {}), ...(x.command ? { command: x.command } : {}) })) };
  } catch {
    /* the check-up failed: the safety-backed areas say unknown */
  }
  const trail = auditTrail();
  let audit = { present: Boolean(trail), ok: false };
  try {
    audit = { present: Boolean(trail), ok: trail ? trail.verify().ok : false };
  } catch {
    /* unreadable trail */
  }
  const drill = (s as { readiness?: { drill?: DrillRecord } }).readiness?.drill;
  const lt = s.offsite?.kind && s.offsite.kind !== 'off' ? s.offsite.lastTest : undefined;
  return {
    backups,
    drill,
    offsiteTest: lt ? { at: lt.at, ok: lt.ok } : undefined,
    diskFreeBytes,
    model: { configured, ...(probe ? { probe } : {}) },
    bridges,
    paused,
    safety,
    audit,
    metrics: telemetrySettings(s).metrics.enabled,
  };
}
