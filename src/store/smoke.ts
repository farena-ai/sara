// Phase 125 (2.58.0, SARA_STORE.md §9.3, K4): the fenced smoke test of a plugin. It starts the plugin
// the way Sara does (spawnSpec, under the strongest fence this computer has: bubblewrap or Seatbelt;
// on Windows Node's permissions only, and the report says so), but with a FAKE channel instead of a
// companion: init with empty settings and fake secrets, then ≤ 5 s for `ready`, whose tools must
// equal the manifest's; one call of each declared hook and schedule with harmless data; every
// `fetch` answered with a canned 503 (no network, ever), every `tool` call with "denied in the smoke
// test", `model` with a fixed "ok". Calls outside the manifest's permissions are findings. No real
// data folder, no vault, no model, no network.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePackage, type PackageFile } from '../packages.ts';
import type { PluginManifest } from '../plugins/manifest.ts';
import { PluginProcess, spawnSpec, type Fence, type InMessage } from '../plugins/runtime.ts';

export const SMOKE_READY_MS = 5000;
export const SMOKE_WATCH_MS = 10_000;
export interface SmokeResult {
  id: 'smoke';
  ok: boolean;
  warnings: string[];
  problems: string[];
  /** What fenced it: bwrap, seatbelt, or node-only (Node's permissions only). */
  fence: Fence;
  calls: string[];
}

/** Harmless sample data for one hook (the shapes Sara sends, with nothing real in them). */
function hookData(hook: string): { type: string; body: Record<string, unknown> } {
  if (hook === 'turn.before') return { type: 'hook', body: { hook, data: { text: 'Hello', channel: 'web', companion: 'smoke', time: new Date(0).toISOString() } } };
  if (hook === 'tool.before' || hook === 'tool.after') return { type: 'hook', body: { hook, data: { tool: 'web_search', args: { query: 'weather' }, ...(hook === 'tool.after' ? { result: 'ok' } : {}) } } };
  if (hook === 'reply.after') return { type: 'hook', body: { hook, data: { text: 'Hello there.', channel: 'web', companion: 'smoke' } } };
  if (hook === 'event:webhook') return { type: 'event', body: { event: 'webhook', data: { hook: 'smoke', name: 'Smoke test', event: 'ping', payload: { ok: true } } } };
  return { type: 'event', body: { event: hook.slice('event:'.length), data: {} } };
}

/**
 * Runs the smoke test. `scratch` is a folder of the checker's own (never /tmp on the server: the
 * checker passes its job folder); it is removed afterwards.
 */
export async function smokeTest(files: readonly PackageFile[], m: PluginManifest, o: { fence: Fence; scratch?: string; readyMs?: number; watchMs?: number; hookMs?: number; execPath?: string } = { fence: 'node-only' }): Promise<SmokeResult> {
  if (o.scratch) mkdirSync(o.scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(o.scratch ?? tmpdir(), 'sara-smoke-'));
  const pluginDir = join(root, 'plugin');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writePackage([...files], pluginDir);
  const problems: string[] = [];
  const warnings: string[] = o.fence === 'node-only' ? ['Ran with Node’s permissions only (no OS fence on this computer).'] : [];
  const calls: string[] = [];
  const p = m.permissions;
  let ready: InMessage | undefined;
  let crashed = '';
  let resolveReady: (() => void) | undefined;
  const readyP = new Promise<void>((r) => (resolveReady = r));
  const outside = (what: string) => {
    if (!problems.includes(what)) problems.push(what);
    throw new Error('denied in the smoke test');
  };
  const proc = new PluginProcess(
    `smoke:${m.id}`,
    () => spawnSpec({ fence: o.fence, pluginDir, dataDir, main: m.main, ...(o.execPath ? { execPath: o.execPath } : {}) }),
    {
      onReady: (msg) => {
        ready = msg;
        resolveReady?.();
      },
      onCall: async (op, msg) => {
        calls.push(op);
        switch (op) {
          case 'fetch': {
            let host = '';
            try {
              host = new URL(String(msg.url ?? '')).hostname;
            } catch {
              /* a bad address */
            }
            if (!host || !p.network.some((h) => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))))) outside(`It tried to reach ${host || 'a bad address'}, which isn't in its permissions.`);
            // A canned answer: the smoke test never opens a socket.
            return { status: 503, contentType: 'text/plain', body: 'The smoke test has no network.', truncated: false };
          }
          case 'tool':
            if (!p.callTools.includes(String(msg.name ?? ''))) outside(`It asked for Sara's tool “${String(msg.name ?? '').slice(0, 60)}”, which isn't in its callTools.`);
            return { ok: false, content: 'denied in the smoke test' };
          case 'model':
            if (!p.model.callsPerDay) outside('It asked her model a question without the model permission.');
            return { ok: true, text: 'ok' };
          case 'card':
            if (!p.cards) outside('It sent a card without the cards permission.');
            return { ok: true };
          case 'memory.notes':
            if (p.memory !== 'shared-notes') outside('It asked for shared notes without the memory permission.');
            return { notes: [] };
          case 'notify':
          case 'kv.get':
          case 'kv.set':
            return op === 'kv.get' ? { value: null } : { ok: true };
          default:
            if (op.startsWith('net.') && !p.connect.length) outside('It opened a connection without the connect permission.');
            if (op.startsWith('bridge.') && !p.bridges.length) outside('It used a chat-app call without the bridges permission.');
            throw new Error('denied in the smoke test');
        }
      },
      onLog: (kind, text) => {
        if (kind === 'crash') crashed = text;
        else if (kind === 'denied' && /longer than 1 MB/.test(text)) problems.push('It wrote a line longer than 1 MB.');
      },
      onGaveUp: (why) => {
        crashed = why;
      },
    },
  );
  const secrets = Object.fromEntries(m.settings.filter((s) => s.type === 'secret').map((s) => [s.key, 'test-secret']));
  try {
    proc.start({ settings: {}, secrets, lang: 'en', plugin: m.id, companion: 'smoke', sara: { channel: 1 } });
    const readyMs = o.readyMs ?? SMOKE_READY_MS;
    await Promise.race([readyP, new Promise((r) => setTimeout(r, readyMs).unref?.())]);
    if (!ready) {
      problems.push(crashed ? `It crashed before it was ready: ${crashed.slice(0, 200)}` : `It didn't say it was ready within ${Math.round(readyMs / 1000)} seconds, so it was stopped.`);
      return { id: 'smoke', ok: false, warnings, problems, fence: o.fence, calls };
    }
    const got = (Array.isArray(ready.tools) ? (ready.tools as { name?: unknown }[]) : []).map((t) => String(t?.name ?? '')).sort();
    const want = [...p.tools].sort();
    if (got.join(',') !== want.join(',')) problems.push(`Its tools (${got.join(', ') || 'none'}) don't match its permissions (${want.join(', ') || 'none'}).`);
    const hookMs = o.hookMs ?? 3000;
    for (const h of p.hooks.filter((x) => x !== 'schedule')) {
      const { type, body } = hookData(h);
      const r = await proc.request(type, body, hookMs);
      if (!r && proc.state !== 'ready') problems.push(`It stopped while answering ${h}.`);
    }
    for (const s of m.schedules) await proc.request('schedule', { schedule: s.id }, hookMs);
    // Watch a while for crashes and calls outside its permissions.
    const until = Date.now() + (o.watchMs ?? SMOKE_WATCH_MS);
    while (Date.now() < until && !crashed) await new Promise((r) => setTimeout(r, 100));
    if (crashed) problems.push(`It crashed: ${crashed.slice(0, 200)}`);
    return { id: 'smoke', ok: problems.length === 0, warnings, problems, fence: o.fence, calls };
  } finally {
    await proc.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
