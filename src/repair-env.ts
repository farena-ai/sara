// ROADMAP_T T1 (docs/SELF_REPAIR.md): the real server's side of the self-repair engine (src/repair.ts).
// Everything here reuses what exists: health (healthReport), gatherTrouble/callTrouble (models, sign-ins,
// add-ons), health history, turn/tool errors in the store, JobManager, Errands, the add-on manager, backups
// (createBackup), the apps' own updaters (AppInstalls.ask), skills (on trial) and automations.
// The engine itself never gets the vault: only `retry` below builds a provider the way the doctor does.
import { existsSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppInstalls, cannotAsk } from './app-installs.ts';
import { audit } from './audit-trail.ts';
import { backupName, BACKUPS_DIR, createBackup } from './backup.ts';
import type { AppContext } from './chat.ts';
import { vaultKeyFor } from './chat.ts';
import { healthReport } from './health.ts';
import { isOllamaDaemon } from './model-catalog.ts';
import { privateLocalOn } from './net-guard.ts';
import { onThisComputer } from './private-local.ts';
import { createProvider } from './providers/registry.ts';
import { Repair, type RepairEnv } from './repair.ts';
import { gatherTrouble, noteCall } from './trouble.ts';
import { trOwner } from './i18n.ts';

/** Her own caches she can make again (downloads, imports, throwaway copies). Only entries older than a day go. */
export const CACHE_DIRS = ['cache/plugin-imports', 'cache/skill-imports', 'cache/sandbox-runs', 'cache/branch-runs', 'cache/prereqs', 'cache/npm', 'cache/history-import', 'cache/companion-import', 'tmp'];
const DAY = 86_400_000;

function sizeOf(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return readdirSync(p).reduce((s: number, n: string) => s + sizeOf(join(p, n)), 0);
  } catch {
    return 0;
  }
}
function oldEntries(root: string, now: number): string[] {
  const out: string[] = [];
  for (const d of CACHE_DIRS) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) {
      try {
        if (now - statSync(join(dir, n)).mtimeMs > DAY) out.push(join(dir, n));
      } catch {
        /* gone */
      }
    }
  }
  return out;
}

export interface RepairExtras {
  version?: string;
  doctor?: RepairEnv['doctor'];
  selfTest?: RepairEnv['selfTest'];
}

export function repairEnvOf(app: AppContext, x: RepairExtras = {}): RepairEnv {
  const root = app.rootDir ?? app.dataDir;
  const db = app.store.db;
  const companion = app.companionId ?? 'main';
  const providerConf = (id: string) => app.settings.get().providers.find((p) => p.id === id);
  return {
    now: () => app.now(),
    settings: { get: () => app.settings.get() as unknown as Record<string, any>, update: (p) => app.settings.update(p as never) },
    audit: (r) => audit({ action: r.action, who: 'Sara', role: 'system', channel: 'self-repair', outcome: r.outcome, ...(r.target ? { target: r.target } : {}), ...(r.content ? { content: r.content } : {}) }),
    privateLocal: () => privateLocalOn(),
    health: () => healthReport(app, { version: x.version ?? '', revision: null, startedAt: app.now().toISOString() }).checks,
    ...(x.doctor ? { doctor: x.doctor } : {}),
    ...(x.selfTest ? { selfTest: x.selfTest } : {}),
    history: () => {
      const b = app.healthHistory?.history({ hours: 24 }).buckets ?? [];
      return { turns: b.reduce((s, x) => s + x.turns, 0), failed: b.reduce((s, x) => s + x.failed, 0) };
    },
    turnErrors: () =>
      (db.prepare("SELECT created_at AS at, meta FROM messages WHERE role = 'notice' AND content LIKE 'turnerror:%' ORDER BY id DESC LIMIT 60").all() as { at: string; meta: string | null }[]).map((r) => {
        const m = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
        return { at: r.at, kind: String(m.errorClass ?? 'TurnError').slice(0, 40), message: '' };
      }),
    toolErrors: () =>
      (db.prepare("SELECT created_at AS at, meta FROM messages WHERE role = 'tool' AND meta LIKE '%\"status\":\"error\"%' ORDER BY id DESC LIMIT 100").all() as { at: string; meta: string | null }[]).map((r) => ({ at: r.at, tool: String((r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}).name ?? '?').slice(0, 60) })),
    trouble: () => gatherTrouble(app).filter((t) => !t.id.startsWith('addon:')),
    models: {
      providers: () => app.settings.get().providers.map((p) => ({ id: p.id, label: p.label, local: onThisComputer(p), daemon: isOllamaDaemon(p) })),
      retry: async (id) => {
        const p = providerConf(id);
        if (!p) return false;
        try {
          await createProvider(p, app.vault.get(vaultKeyFor(p.id)), app.subscriptions).listModels(AbortSignal.timeout(20_000));
          noteCall(app, p);
          return true;
        } catch {
          return false;
        }
      },
      pull: async (id, model) => {
        const p = providerConf(id);
        const puller = app.modelPuller;
        if (!p || !puller || puller.running) return false;
        puller.start(p.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, ''), model);
        for (let i = 0; i < 600 && puller.running; i++) await new Promise((ok) => setTimeout(ok, 1000));
        return puller.status()?.state === 'done';
      },
      onThisComputer: (id, model) => {
        const p = providerConf(id);
        return Boolean(p && onThisComputer(p, model));
      },
    },
    ...(app.jobs ? { jobs: { running: () => app.jobs!.running().map((j) => ({ id: j.id, label: j.label, startedAt: j.startedAt })), stop: (id: number) => app.jobs!.stop(id) } } : {}),
    ...(app.errands
      ? {
          errands: {
            open: () => app.errands!.list({ open: true }).map((e) => ({ id: e.id, goal: e.goal, status: e.status, updatedAt: e.updatedAt })),
            nudge: () => void app.errands!.due(app.now()),
            updatedAt: (id: number) => app.errands!.get(id)?.updatedAt,
          },
        }
      : {}),
    ...(app.pluginManager
      ? {
          addons: {
            list: () => (app.pluginManager!.list() as { id: string; name?: string; version?: string; status?: string }[]).map((r) => ({ id: r.id, name: r.name ?? r.id, version: r.version ?? '', status: String(r.status ?? ''), enabled: app.pluginManager!.enabledFor(r.id, companion) })),
            restart: async (id: string) => {
              await app.pluginManager!.setEnabled(id, companion, false);
              await app.pluginManager!.setEnabled(id, companion, true);
            },
            setEnabled: (id: string, on: boolean) => app.pluginManager!.setEnabled(id, companion, on),
          },
        }
      : {}),
    db: {
      check: () => {
        const r = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
        return r.length === 1 && r[0]!.quick_check === 'ok' ? 'ok' : r.map((x) => x.quick_check).slice(0, 3).join('; ');
      },
      bloat: () => {
        const n = (q: string) => Number(Object.values(db.prepare(q).get() as Record<string, number>)[0] ?? 0);
        const size = n('PRAGMA page_size');
        return { freeBytes: n('PRAGMA freelist_count') * size, totalBytes: n('PRAGMA page_count') * size };
      },
      backup: () => {
        const name = backupName(app.now(), 'manual');
        createBackup(app.dataDir, join(root, BACKUPS_DIR, name), { saraVersion: x.version ?? '', now: app.now() });
        return name;
      },
      reindex: () => db.exec('REINDEX'),
      vacuum: () => db.exec('VACUUM'),
    },
    disk: {
      freeBytes: () => {
        try {
          const s = statfsSync(root);
          return s.bavail * s.bsize;
        } catch {
          return null;
        }
      },
      caches: () => ({ bytes: oldEntries(root, app.now().getTime()).reduce((s, p) => s + sizeOf(p), 0) }),
      clean: () => {
        let bytes = 0;
        let files = 0;
        for (const p of oldEntries(root, app.now().getTime())) {
          bytes += sizeOf(p);
          rmSync(p, { recursive: true, force: true });
          files++;
        }
        return { bytes, files };
      },
    },
    apps: {
      list: () => new AppInstalls(root, () => app.now()).list().map(([id, a]) => ({ id, label: a.label ?? a.platform, version: a.version, ...(a.state ? { state: a.state } : {}), canAsk: !cannotAsk(a) })),
      ask: (id) => new AppInstalls(root, () => app.now()).ask(id, 'Sara (self-repair)'),
    },
    ...(app.skills
      ? {
          grow: {
            skill: (d) => {
              const v = app.skills!.save('companion', { name: d.name, description: d.description, body: d.body, metadata: { 'sara-learned': 'self-repair' } }, { create: true, source: 'learned', why: 'self-repair: learned', origin: 'self-repair' });
              app.skills!.setLearned(v.scope, v.name, { status: 'trial', noAuto: false, checkState: null });
              return { name: v.name, scope: v.scope };
            },
            removeSkill: (scope, name) => void app.skills!.delete(scope, name),
            ...(app.automations
              ? {
                  automation: (d: Record<string, unknown>) => {
                    const a = app.automations!.create(d, { by: 'chat' });
                    return { id: a.id, name: a.name };
                  },
                  removeAutomation: (id: number) => void app.automations!.remove(id),
                }
              : {}),
          },
        }
      : {}),
    report: (text) => {
      const s = app.settings.get();
      void app.push?.sendAll({ title: trOwner('Self-repair', s), body: text, url: '/#view=settings:dh-health', tag: 'repair' }).catch(() => undefined);
      app.events?.publish({ type: 'repair' });
    },
  };
}

const cache = new WeakMap<object, Repair>();
/** The owner's repair engine (undefined for household members, kid mode and the demo). */
export function repairOf(app: AppContext, x: RepairExtras = {}): Repair | undefined {
  if (app.member) return undefined;
  let r = app.repair ?? cache.get(app.store);
  if (!r) cache.set(app.store, (r = new Repair(repairEnvOf(app, x), app.store.db)));
  // The routes bring the deep checks (the doctor and the self-test need the server's context).
  if (x.doctor && !r.env.doctor) r.env.doctor = x.doctor;
  if (x.selfTest && !r.env.selfTest) r.env.selfTest = x.selfTest;
  return r;
}
