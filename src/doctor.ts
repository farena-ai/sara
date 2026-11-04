// Phase 8: `sara doctor`, deeper checks than the Health page: database integrity, every model
// provider actually answers, data folder permissions, off-server copies, Node and optional installs.
// Used by the CLI (`node src/main.ts --doctor`, `sara doctor`) and Settings → Data & health.
import { isOllamaDaemon } from './model-catalog.ts';
import { isCloudModelName } from './model-names.ts';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listBackups } from './backup.ts';
import { vaultKeyFor } from './chat.ts';
import { DEFAULT_OFFSITE, OFFSITE_PASS_VAULT } from './offsite.ts';
import { createProvider } from './providers/registry.ts';
import type { SettingsStore } from './settings.ts';
import type { Subscriptions } from './subscriptions/index.ts';
import type { Vault } from './vault.ts';
import { localVoiceMissing, localVoiceSupported } from './platform.ts';
import { type SandboxInfo } from './tools/sandbox.ts';
import type { ToolRegistry } from './tools/registry.ts';
import { findBrowser, type BrowserInfo } from './browser.ts';
import { en } from './i18n.ts';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  detailKey?: string;
  params?: Record<string, unknown>;
}

export interface DoctorDeps {
  dataDir: string;
  settings: SettingsStore;
  vault: Vault;
  subscriptions?: Subscriptions;
  now?: Date;
  /** Seconds to wait for each provider. */
  providerTimeoutS?: number;
  /** Phase 46: how shell commands run (the CLI and the server pass theirs). */
  sandbox?: SandboxInfo;
  /** The owner's tool choices are checked against it (shell without a sandbox and without asking). */
  tools?: ToolRegistry;
  platform?: NodeJS.Platform;
  /** Finds the optional browser used to test web previews. */
  browser?: () => BrowserInfo;
}

export async function runDoctor(d: DoctorDeps): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], detail: string) => out.push({ name, status, detail });
  const now = d.now ?? new Date();
  const s = d.settings.get();

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 24 ? 'ok' : 'fail', `${process.version}${major >= 24 ? '' : ' (Sara needs 24 or newer)'}`);

  const browser = d.browser?.() ?? findBrowser(d.platform);
  add('Testing browser', browser.found ? 'ok' : 'warn', browser.found ? `${browser.name ?? 'Browser'} found at ${browser.path ?? 'configured path'}` : `not found. ${browser.how}`);

  // Data folder: exists, private, room to grow.
  try {
    const st = statSync(d.dataDir);
    const open = process.platform !== 'win32' && (st.mode & 0o077) !== 0;
    add('Data folder', open ? 'warn' : 'ok', `${d.dataDir}${open ? ` is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 700 ${d.dataDir}` : ''}`);
  } catch (err) {
    add('Data folder', 'fail', (err as Error).message);
  }
  try {
    const f = statfsSync(d.dataDir);
    const free = f.bavail * f.bsize;
    add('Disk space', free > 2e9 ? 'ok' : free > 5e8 ? 'warn' : 'fail', `${(free / 1e9).toFixed(1)} GB free`);
  } catch {
    /* not supported */
  }

  // Database integrity (read-only connection; safe while Sara runs).
  const dbFile = join(d.dataDir, 'sara.db');
  if (existsSync(dbFile)) {
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const r = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      const conv = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
      db.close();
      const ok = r.length === 1 && r[0].quick_check === 'ok';
      add('Database', ok ? 'ok' : 'fail', ok ? `intact (${conv} conversations)` : `problems: ${r.map((x) => x.quick_check).slice(0, 3).join('; ')}. Restore a backup.`);
    } catch (err) {
      add('Database', 'fail', (err as Error).message);
    }
  } else add('Database', 'warn', 'not created yet (first start)');

  // Every provider actually answers.
  if (!s.providers.length) add('Models', 'fail', 'No model provider set up (Settings → Models).');
  await Promise.all(
    s.providers.map(async (p) => {
      const t = Date.now();
      try {
        const provider = createProvider(p, d.vault.get(vaultKeyFor(p.id)), d.subscriptions);
        const models = await provider.listModels(AbortSignal.timeout((d.providerTimeoutS ?? 20) * 1000));
        const usedHere = [s.defaultProviderId === p.id ? s.defaultModel : undefined, ...Object.values(s.routes ?? {}).filter((r) => r?.providerId === p.id).map((r) => r!.model)].filter(Boolean) as string[];
        // An Ollama Cloud model that isn't pulled yet is fine: Sara pulls it on first use (Phase 56).
        const missing = usedHere.filter((m) => models.length && !models.includes(m) && !models.some((x) => x.startsWith(`${m}:`)) && !(isOllamaDaemon(p) && isCloudModelName(m)));
        add(`Provider: ${p.label}`, missing.length ? 'warn' : 'ok', `${models.length} models, answered in ${Date.now() - t} ms${missing.length ? `; not in its list: ${missing.join(', ')}` : ''}`);
      } catch (err) {
        add(`Provider: ${p.label}`, p.id === s.defaultProviderId ? 'fail' : 'warn', (err as Error).message.slice(0, 200));
      }
    }),
  );

  // Backups and the off-server copy.
  const last = listBackups(d.dataDir)[0];
  const ageH = last ? (now.getTime() - Date.parse(last.createdAt)) / 3600_000 : Infinity;
  add('Backups', ageH < 48 ? 'ok' : 'warn', last ? `newest ${last.name} (${Math.round(ageH)} h old)` : 'no backups yet');
  const off = { ...DEFAULT_OFFSITE, ...s.offsite };
  if (off.kind === 'off') add('Off-server copy', 'warn', 'off: if this server is lost, so are its backups (Settings → Data & health)');
  else if (!d.vault.has(OFFSITE_PASS_VAULT)) add('Off-server copy', 'fail', 'no passphrase set');
  else if (!off.last) add('Off-server copy', 'warn', 'set up; no copy made yet');
  else add('Off-server copy', off.last.ok ? 'ok' : 'fail', off.last.ok ? `last ${off.last.name} at ${off.last.at}` : `last attempt failed: ${off.last.error}`);

  // Isolation and permission are independent checks.
  const platform = d.platform ?? process.platform;
  if (d.sandbox) {
    add('Tool sandbox', d.sandbox.mode !== 'none' ? 'ok' : 'warn', d.sandbox.mode !== 'none' ? `${d.sandbox.mode}: ${d.sandbox.detail}` : en('No execution isolation. Commands run directly on this computer.'));
    const unasked = d.tools ? d.tools.list().filter((t) => t.runsCommands && d.tools!.permission(t.spec.name, s.toolPermissions) === 'auto').map((t) => t.spec.name) : [];
    add(en('Command approvals'), !d.tools || unasked.length ? 'warn' : 'ok', !d.tools ? en('Command approval policy is unavailable.') : unasked.length ? `${unasked.join(', ')} run without asking (Settings → Coding → Tools and approvals)` : en('Command tools ask for approval or are blocked. Approval does not provide execution isolation.'));
    if (unasked.length) Object.assign(out.at(-1)!, { detailKey: en('{tools} run without asking (Settings → Coding → Tools and approvals)'), params: { tools: unasked.join(', ') } });
  }

  // Optional installs.
  if (localVoiceSupported(platform)) {
    const voiceDir = process.env.SARA_VOICE_DIR ?? '/opt/sara-voice';
    add('Voice (optional)', existsSync(voiceDir) ? 'ok' : 'warn', existsSync(voiceDir) ? voiceDir : localVoiceMissing(platform));
  } else add('Voice (optional)', 'ok', `${localVoiceMissing(platform)}.`);
  if (d.subscriptions) {
    for (const kind of ['claude', 'grok'] as const) {
      if (d.subscriptions.installed(kind)) add(`${kind === 'claude' ? 'Claude Code' : 'Grok'} (optional)`, 'ok', 'installed');
    }
  }
  if (!s.timeZone) add('Time zone', 'warn', 'not set: reminders and briefings use the server clock (Settings → You)');
  return out;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' } as const;
  return checks.map((c) => `${icon[c.status]} ${c.name.padEnd(28)} ${c.detail}`).join('\n');
}
