// Phase 6: health page data (Settings → Health and `sara status`). Read-only and cheap.
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { DEFAULT_BACKUP, listBackups } from './backup.ts';
import { en, fill } from './i18n.ts';

export interface AppInfo {
  version: string;
  revision: string | null;
  startedAt: string;
}

export function appInfo(root: string, startedAt = new Date()): AppInfo {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const revFile = join(root, 'REVISION');
  return { version: pkg.version, revision: existsSync(revFile) ? readFileSync(revFile, 'utf8').trim() || null : null, startedAt: startedAt.toISOString() };
}

const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);

export function healthReport(app: AppContext, info: AppInfo) {
  const now = app.now();
  const root = app.rootDir ?? app.dataDir;
  const db = join(app.dataDir, 'sara.db');
  let disk: { freeBytes: number; totalBytes: number } | null = null;
  try {
    const s = statfsSync(root);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    /* not supported here */
  }
  const backups = listBackups(root);
  const backupCfg = { ...DEFAULT_BACKUP, ...app.settings.get().backup };
  const memErrors = app.memory ? app.memory.failing() : [];
  const offsite = { kind: 'off', ...app.settings.get().offsite } as { kind: string; last?: { ok: boolean; at: string }; lastTest?: { ok: boolean; at: string; error?: string; detail?: string } };
  const s = app.settings.get();
  // UX 19: `items` (optional) carries the same facts as `detail` as data, for the app to word them in the owner's language.
  // Phase 61: so do `detailKey` (the English template of `detail`) and `params`; check names are fixed English words.
  type Detail = string | [template: string, params: Record<string, unknown>];
  const checks: { name: string; ok: boolean; detail: string; detailKey?: string; params?: Record<string, unknown>; items?: unknown[] }[] = [];
  const add = (name: string, ok: boolean, detail: Detail, items?: unknown[]) => {
    const [key, params] = typeof detail === 'string' ? [detail, undefined] : detail;
    checks.push({ name, ok, detail: fill(key, params), ...(params ? { detailKey: key, params } : {}), ...(items ? { items } : {}) });
  };
  add(en('Model'), Boolean(s.providers.length && s.defaultModel), s.providers.length ? (s.defaultModel ?? en('no default model')) : en('No model provider set up'));
  add(en('Disk space'), !disk || disk.freeBytes > 1e9, disk ? [en('{gb} GB free'), { gb: (disk.freeBytes / 1e9).toFixed(1) }] : en('unknown'));
  const last = backups[0];
  const backupAgeH = last ? (now.getTime() - Date.parse(last.createdAt)) / 3600_000 : Infinity;
  add(
    en('Backups'),
    backupCfg.auto ? backupAgeH < 48 : Boolean(last),
    last ? (backupAgeH < 1 ? [en('last {name} (under an hour ago)'), { name: last.name }] : [en('last {name} ({h} h ago)'), { name: last.name, h: Math.round(backupAgeH) }]) : backupCfg.auto ? en('first automatic backup runs within the hour') : en('automatic backups are off'),
  );
  if (offsite.kind !== 'off') {
    const t = offsite.lastTest;
    const ageD = t ? (now.getTime() - Date.parse(t.at)) / 86_400_000 : Infinity;
    add(en('Off-server test restore'), Boolean(t?.ok && ageD < 8) || (!t && !offsite.last?.ok), !t ? (offsite.last?.ok ? en('first test restore runs within the hour') : en('waiting for the first off-server copy')) : t.ok ? [en('ok {n} day(s) ago ({detail})'), { n: Math.max(0, Math.round(ageD)), detail: t.detail ?? '' }] : [en('failed: {error}'), { error: t.error ?? 'unknown' }]);
  }
  add(en('Memory'), memErrors.length === 0, memErrors.length ? [en('{n} conversation(s) could not be summarized: {error}'), { n: memErrors.length, error: memErrors[0] }] : en('ok'));
  // Phase 34: stays in character (when the check is on): last 7 days.
  if ((s.persona?.inCharacter ?? 'off') !== 'off' && app.drift) {
    const w = app.drift.stats(new Date(now.getTime() - 7 * 86_400_000).toISOString());
    const share = w.checks ? w.drifted / w.checks : 0;
    add(en('Stays in character'), !w.checks || (Number(w.average) >= 6.5 && share <= 0.2), w.checks ? [en('{average}/10 over {checks} checked replies this week; {drifted} drifted (each got a gentle nudge)'), { average: w.average, checks: w.checks, drifted: w.drifted }] : en('no replies checked yet this week'));
  }
  // Approval prompts govern permission; they do not isolate command execution.
  const unasked = app.tools.list().filter((t) => t.runsCommands && app.tools.permission(t.spec.name, s.toolPermissions) === 'auto').map((t) => t.spec.name);
  add(en('Tool sandbox'), app.sandbox.mode !== 'none', app.sandbox.mode !== 'none' ? `${app.sandbox.mode} (${app.sandbox.detail})` : en('No execution isolation. Commands run directly on this computer.'));
  add(en('Command approvals'), !unasked.length, unasked.length ? [en('{tools} run without asking (Settings → Coding → Tools and approvals)'), { tools: unasked.join(', ') }] : en('Command tools ask for approval or are blocked. Approval does not provide execution isolation.'));
  // Phase 56: retired models still chosen somewhere, and switches made for them lately.
  if (app.modelCatalog) {
    // Hardening L1: a list that suddenly shrank (kept, nothing retired) is a warning too.
    const stuck = [...app.modelCatalog.retiredInUse(), ...app.modelCatalog.warnings()];
    const moved = app.modelCatalog.notices(14).slice(0, 5);
    if (stuck.length) add(en('Model lists'), false, stuck.map((x) => x.text).join(' '), stuck);
    if (moved.length) add(en('Model changes'), true, moved.map((n) => n.text).join(' '), moved);
  }
  // Phase 78: how much room the run snapshots take (risk 11).
  if (app.runs) {
    const st = app.runs.stats();
    add(en('Run history'), true, [en('Runs: {n}, {mb} MB'), { n: st.runs, mb: (st.bytes / 1048576).toFixed(st.bytes < 104_858 ? 2 : 1) }]);
  }
  const tg = app.bridges?.telegram?.status();
  if (s.telegram?.enabled) add('Telegram', Boolean(tg?.running), tg?.running ? (tg.linked ? `@${tg.bot}` : [en('{bot} (not linked yet)'), { bot: `@${tg.bot}` }]) : (tg?.error ?? en('not running')));
  const dc = app.bridges?.discord?.status();
  if (s.discord?.enabled) add('Discord', Boolean(dc?.running), dc?.running ? (dc.linked ? `${dc.bot}` : [en('{bot} (not linked yet)'), { bot: `${dc.bot}` }]) : (dc?.error ?? en('not running')));
  for (const c of s.mcpServers ?? []) {
    if (!c.enabled) continue;
    const conn = app.mcp?.get(c.name);
    add(`MCP ${c.name}`, conn?.status === 'ready', conn ? `${conn.status}${conn.error ? `: ${conn.error}` : ''}` : en('not started'));
  }
  return {
    ok: checks.every((c) => c.ok),
    version: info.version,
    revision: info.revision,
    node: process.version,
    startedAt: info.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    data: { dir: root, databaseBytes: size(db) + size(`${db}-wal`), disk },
    voice: app.voice ? app.voice.available : { stt: false, tts: false },
    pushDevices: app.push?.list().length ?? 0,
    backups: { ...backupCfg, count: backups.length, last: last ?? null },
    checks,
  };
}
