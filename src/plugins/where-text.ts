// V1.3 (docs/design/V1BRIDGES.md): "Where do you text?", the picker at the top of Connections → Apps and
// services. It adds no bridge: each choice opens the chat app's own Settings page (its guided setup
// card) with defaults filled, and once set up the picker shows that plugin's own checks as plain lines
// and can send one test message into the owner's linked chat. Owner only (the `plugins` route family).
//   GET  /api/plugins/where                         every choice: page, plugin, state, defaults
//   POST /api/plugins/where/pick       { app }      the page to open and its defaults (installs nothing)
//   POST /api/plugins/where/check      { app }      the plugin's Test lines + "Your chat is linked"
//   POST /api/plugins/where/send-test  { app }      one "Test from Sara" into his linked chat only
//   POST /api/plugins/where/probe      { app: 'imessage', address, onOtherMachine? }  BlueBubbles reachable?
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { AppContext } from '../chat.ts';
import { HttpError } from '../http.ts';
import { en } from '../i18n.ts';
import { isLanHost, isLoopbackHost, outboundAllowed, privateLocalOn } from '../net-guard.ts';
import type { PluginManager } from './manager.ts';

export interface WhereApp {
  id: string;
  name: string;
  page: string;
  /** The built-in plugin behind it (null: Telegram and Discord are part of Sara itself). */
  plugin: string | null;
}

/** In the picker's order (the web adds labels, needs and the phone fits). */
export const WHERE_APPS: readonly WhereApp[] = [
  { id: 'imessage', name: 'iMessage', page: 'co-imessage', plugin: 'imessage' },
  { id: 'whatsapp', name: 'WhatsApp', page: 'co-whatsapp', plugin: 'whatsapp' },
  { id: 'signal', name: 'Signal', page: 'co-signal', plugin: 'signal' },
  { id: 'telegram', name: 'Telegram', page: 'co-telegram', plugin: null },
  { id: 'discord', name: 'Discord', page: 'co-discord', plugin: null },
  { id: 'matrix', name: 'Matrix', page: 'co-matrix', plugin: 'matrix' },
  { id: 'slack', name: 'Slack', page: 'co-slack', plugin: 'slack' },
  { id: 'teams', name: 'Microsoft Teams', page: 'co-teams', plugin: 'teams' },
  { id: 'email', name: 'Email', page: 'co-email', plugin: 'email' },
];

/** Plugins whose check step `send-test` writes one line into a chat (WhatsApp since Phase 122). */
const SENDS_TEST = new Set(['matrix', 'imessage', 'whatsapp']);

const appOf = (id: unknown): WhereApp => {
  const a = WHERE_APPS.find((x) => x.id === String(id ?? ''));
  if (!a) throw new HttpError(400, en('Pick one of the chat apps.'));
  return a;
};

/** `Alex Rivera` → `alex` (letters and digits only, accents dropped; `me` when there is no name). */
const slug = (name: string): string =>
  (name.trim().split(/\s+/)[0] ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24) || 'me';

/** The values a page starts with. Plain suggestions; nothing is saved until he presses its button. */
export function whereDefaults(id: string, cur: { ownerName?: string; mxid?: string; server?: string; address?: string }): Record<string, string> {
  if (id === 'matrix') return { mxid: cur.mxid || `@sara-${slug(cur.ownerName ?? '')}:matrix.org` };
  if (id === 'imessage') return { server: cur.server || '127.0.0.1:1234' };
  if (id === 'signal') return { address: cur.address || '127.0.0.1:7583' };
  return {};
}

const companionOf = (app: AppContext) => String(app.companionId ?? 'main');

function rowOf(app: AppContext, pm: PluginManager, a: WhereApp, available: Set<string>) {
  const companion = companionOf(app);
  const installed = Boolean(a.plugin && pm.store.get(a.plugin));
  const settings = installed ? pm.settingsView(a.plugin!, companion) : undefined;
  const value = (k: string) => String(settings?.settings.find((s) => s.key === k)?.value ?? '');
  const on = installed && pm.enabledFor(a.plugin!, companion);
  const linked = Boolean(settings?.bridge?.ownerChats?.length);
  return {
    id: a.id,
    name: a.name,
    page: a.page,
    plugin: a.plugin,
    available: a.plugin ? available.has(a.plugin) : true,
    installed,
    on,
    running: on && pm.processOf(a.plugin!, companion)?.state === 'ready',
    linked,
    canSendTest: SENDS_TEST.has(a.id) && on && linked,
    defaults: whereDefaults(a.id, { ownerName: String(app.settings.get().ownerName ?? ''), mxid: value('mxid'), server: value('server'), address: value('address') }),
  };
}

export function whereState(app: AppContext, pm: PluginManager): { apps: ReturnType<typeof rowOf>[] } {
  const available = new Set(pm.builtinList().map((b) => b.id));
  return { apps: WHERE_APPS.map((a) => rowOf(app, pm, a, available)) };
}

export function wherePick(app: AppContext, pm: PluginManager, id: unknown): Record<string, unknown> {
  const a = appOf(id);
  const r = rowOf(app, pm, a, new Set(pm.builtinList().map((b) => b.id)));
  return { page: r.page, plugin: r.plugin, installed: r.installed, defaults: r.defaults };
}

/** Each plugin's own Test (read-only, sends nothing), as plain ✓/✕ lines. */
export async function whereCheck(app: AppContext, pm: PluginManager, id: unknown): Promise<{ ok: boolean; steps: { label: string; ok: boolean; fix?: string }[] }> {
  const a = appOf(id);
  if (!a.plugin) throw new HttpError(400, en('Check it on its own page.'));
  const companion = companionOf(app);
  if (!pm.store.get(a.plugin)) return { ok: false, steps: [{ label: en('Not added yet'), ok: false, fix: en('Press Set it up.') }] };
  if (privateLocalOn()) return { ok: false, steps: [{ label: en('Paused: "Nothing leaves this computer" is on.'), ok: false }] };
  const r = await pm.testBridge(a.plugin, companion);
  const linked = Boolean(pm.settingsView(a.plugin, companion).bridge?.ownerChats?.length);
  const steps = [...r.steps, { label: en('Your chat is linked'), ok: linked, ...(linked ? {} : { fix: en('Finish the link step on its page.') }) }];
  return { ok: steps.every((s) => s.ok), steps };
}

/** One short message into the owner's linked chat (the first one); never anyone else. */
export async function whereSendTest(app: AppContext, pm: PluginManager, id: unknown): Promise<Record<string, unknown>> {
  const a = appOf(id);
  if (!a.plugin || !SENDS_TEST.has(a.id)) return { ok: false, code: 'NO_TEST_MESSAGE' };
  const companion = companionOf(app);
  if (!pm.store.get(a.plugin) || !pm.enabledFor(a.plugin, companion)) return { ok: false, code: 'NOT_ON' };
  if (privateLocalOn()) return { ok: false, code: 'PRIVATE_LOCAL' };
  const chatId = pm.settingsView(a.plugin, companion).bridge?.ownerChats?.[0];
  if (!chatId) return { ok: false, code: 'NOT_LINKED' };
  const r = await pm.bridgeCheck(a.plugin, companion, { step: 'send-test', chatId, text: `Test from Sara: ${a.name} works. You can reply here.` });
  return r.ok ? { ok: true } : { ok: false, code: 'SEND_FAILED', ...(r.diagnosis ? { diagnosis: r.diagnosis } : {}) };
}

export type BBProbeCode = 'BAD_ADDRESS' | 'NOT_LOCAL' | 'DOWN' | 'SLOW' | 'NOT_BB';
export interface BBProbe {
  ok: boolean;
  address: string;
  code?: BBProbeCode;
  /** BlueBubbles answered and the password still has to be typed (step 4 checks it). */
  needsPassword?: boolean;
}

const LOCAL_NAME = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.(?:local|lan|home|internal|ts\.net)$/i;

/**
 * Is BlueBubbles reachable at this address? One `GET /api/v1/ping` without the password (nothing else
 * is sent), 3 s at most. Only this computer, or with the switch an address on the home network or
 * Tailscale: the same rule as the plugin's own network permission.
 */
export async function probeBlueBubbles(raw: unknown, o: { onOtherMachine?: boolean; timeoutMs?: number; lookup?: (h: string) => Promise<string[]> } = {}): Promise<BBProbe> {
  const given = String(raw ?? '').trim();
  const tls = /^https:\/\//i.test(given);
  const address = given.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const bad = (code: BBProbeCode): BBProbe => ({ ok: false, address, code });
  const m = /^(?:\[([^\]]+)\]|([^:\s/[\]]+))(?::(\d{1,5}))?$/.exec(address);
  if (!m) return bad('BAD_ADDRESS');
  const host = (m[1] ?? m[2]).toLowerCase();
  const port = Number(m[3] ?? 1234);
  if (!(port >= 1 && port <= 65535)) return bad('BAD_ADDRESS');
  const loop = (h: string) => isLoopbackHost(h);
  let ip = host === 'localhost' ? '127.0.0.1' : host;
  if (!loop(host)) {
    if (!o.onOtherMachine) return bad('NOT_LOCAL');
    if (!isIP(host)) {
      if (!LOCAL_NAME.test(host)) return bad('NOT_LOCAL');
      const found = await (o.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((x) => x.address)))(host).catch(() => [] as string[]);
      if (!found.length) return bad('DOWN');
      if (!found.every((x) => loop(x) || isLanHost(x))) return bad('NOT_LOCAL');
      ip = found[0];
    } else if (!isLanHost(host)) return bad('NOT_LOCAL');
  }
  const url = `${tls ? 'https' : 'http'}://${ip.includes(':') ? `[${ip}]` : ip}:${port}/api/v1/ping`;
  if (!outboundAllowed(url, o.onOtherMachine === true)) return bad('NOT_LOCAL');
  return new Promise<BBProbe>((resolve) => {
    let done = false;
    const finish = (r: BBProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    // A home BlueBubbles usually has a self-signed certificate. The probe sends no password and reads
    // nothing but the reply's shape, so it does not verify the certificate; the plugin itself does.
    const req = (tls ? httpsRequest : httpRequest)(url, { method: 'GET', headers: { 'user-agent': 'Sara-setup/1.0', host: `${host}:${port}` }, ...(tls ? { rejectUnauthorized: false, servername: isIP(host) ? undefined : host } : {}) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > 16 * 1024) finish(bad('NOT_BB'));
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body) as { status?: unknown; message?: unknown };
          const shaped = typeof j?.status === 'number' && typeof j.message === 'string';
          if (shaped && res.statusCode === 200) return finish({ ok: true, address });
          if (shaped && res.statusCode === 401) return finish({ ok: true, address, needsPassword: true });
        } catch {
          // not JSON: not BlueBubbles
        }
        finish(bad('NOT_BB'));
      });
    });
    const timer = setTimeout(() => finish(bad('SLOW')), o.timeoutMs ?? 3000);
    req.on('error', (err: NodeJS.ErrnoException) => finish(bad(err.code === 'ETIMEDOUT' ? 'SLOW' : 'DOWN')));
    req.end();
  });
}

/** The route (inside the `plugins` family, owner only). */
export async function whereRoute(app: AppContext, pm: PluginManager, method: string, op: string | undefined, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!op && method === 'GET') return whereState(app, pm);
  if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (op === 'pick') return wherePick(app, pm, body.app);
  if (op === 'check') return whereCheck(app, pm, body.app);
  if (op === 'send-test') return whereSendTest(app, pm, body.app);
  if (op === 'probe') {
    if (body.app !== 'imessage') throw new HttpError(400, en('Only iMessage has a reachability test here.'));
    return { ...(await probeBlueBubbles(body.address, { onOtherMachine: body.onOtherMachine === true })) };
  }
  throw new HttpError(404, 'Not found');
}
