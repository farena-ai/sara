// S9b (docs/SUPPORT_LINK.md): the support link's owner API, its peer endpoint and the redacted report.
// Owner only: household members, kid mode and the demo get 403 here and no peer endpoint at all.
//   GET    /api/support                       {given, held, proposals, log, peers, allow}
//   POST   /api/support/passes                {link, hours: 1|24|168, note?} → {pass}   give a help pass
//   DELETE /api/support/passes/:id            revoke it (the other side is told)
//   POST   /api/support/look                  {link} → {report, findings}   helper: read the other server
//   POST   /api/support/propose               {link, changes?: [{path, value}], note?} → {proposal}
//   POST   /api/support/proposals/:id         {approve} helped: OK or no (nothing changes without it)
// Peer: POST /msg/v1/support/{pass|revoke|look|propose|answer}, signed (src/support.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appInstallView, AppInstalls } from '../app-installs.ts';
import { audit } from '../audit-trail.ts';
import { vaultKeyFor } from '../chat.ts';
import { healthReport } from '../health.ts';
import { scrubText } from '../hub.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { categoryOf } from '../movein/text.ts';
import { runSelfTest } from '../self-test.ts';
import { cleanChange, SUPPORT_ALLOW, supportFindings, supportOf, SupportError, valueAt, type SupportChange } from '../support.ts';
import { callTrouble } from '../trouble.ts';
import { selfTestDepsOf } from './self-test.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const LOG_LINES = 80;

/**
 * The scrubber for everything that leaves: the redactor (vault secrets, key shapes), the diagnostics
 * scrubber (emails, tokens, paths, addresses), quoted text, and whole lines that may quote a chat or a
 * private message (any four words in a row from recent ones) or name a medical/intimate topic.
 */
export function supportScrubber(ctx: RouteCtx): { text: (s: string) => string; line: (s: string) => string } {
  const { app } = ctx;
  const shingles = new Set<string>();
  const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const addText = (s: string) => {
    const w = words(s);
    for (let i = 0; i + 4 <= w.length; i++) shingles.add(w.slice(i, i + 4).join(' '));
  };
  try {
    for (const r of app.store.db.prepare("SELECT content FROM messages WHERE role IN ('user', 'assistant', 'tool') ORDER BY id DESC LIMIT 400").all() as { content: string }[]) addText(String(r.content ?? '').slice(0, 4000));
  } catch {
    /* no store */
  }
  try {
    const m = app.messages;
    for (const c of m?.chats().slice(0, 30) ?? []) for (const x of m!.messages(c.id).slice(-50)) addText(x.text);
  } catch {
    /* no messages */
  }
  const dirs = [app.dataDir, ctx.rootDir].filter(Boolean) as string[];
  const text = (s: string) =>
    scrubText(String(s ?? ''), (x) => app.redactor.redact(x), { dirs })
      .replace(/"[^"\n]{12,}"|“[^”\n]{12,}”|'[^'\n]{16,}'/g, '[text]')
      .replace(/\b(?:Bearer|Basic)\s+\S+/g, '[REDACTED]');
  const quotes = (s: string) => {
    const w = words(s);
    for (let i = 0; i + 4 <= w.length; i++) if (shingles.has(w.slice(i, i + 4).join(' '))) return true;
    return false;
  };
  const line = (s: string) => {
    const raw = String(s ?? '');
    if (categoryOf(raw)) return '[line hidden: private topic]';
    if (quotes(raw)) return '[line hidden: may quote a chat or message]';
    const t = text(raw);
    return categoryOf(t) ? '[line hidden: private topic]' : t;
  };
  return { text, line };
}

function deep(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deep(x, f)]));
  return v;
}

/** The support report: read-only, cheap, redacted. Never chats, memories, files, mail, messages or medical. */
export async function supportReport(ctx: RouteCtx): Promise<Record<string, unknown>> {
  const { app } = ctx;
  const sc = supportScrubber(ctx);
  const s = app.settings.get();
  const version = ctx.info?.version ?? '';
  let health: Record<string, unknown> = {};
  try {
    const h = healthReport(app, ctx.info ?? { version: '', revision: null, startedAt: app.now().toISOString() });
    health = { ok: h.ok, uptimeSeconds: h.uptimeSeconds, databaseBytes: h.data.databaseBytes, disk: h.data.disk, backups: { auto: h.backups.auto, count: h.backups.count, last: h.backups.last?.createdAt ?? null }, pushDevices: h.pushDevices, checks: h.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail, ...(c.detailKey ? { detailKey: c.detailKey, params: c.params } : {}) })) };
  } catch (err) {
    health = { error: String((err as Error)?.message ?? err) };
  }
  let selfTest: unknown[] = [];
  try {
    // No consent flags: nothing is written (no draft, no event, no notification).
    selfTest = await Promise.race([runSelfTest(selfTestDepsOf(ctx), {}), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 25_000).unref())]);
    selfTest = (selfTest as Record<string, unknown>[]).map((l) => ({ id: l.id, area: l.area, status: l.status, text: l.text, ...(l.params ? { params: l.params } : {}), ...(l.fix ? { fix: l.fix } : {}) }));
  } catch {
    selfTest = [];
  }
  let update: Record<string, unknown> | null = null;
  try {
    const u = ctx.updater?.status(app.now());
    if (u) update = { state: u.state, message: u.message, latest: u.latest ?? null, behind: u.behind ?? null, required: u.required ?? false, security: u.security ?? false, at: u.at ?? null };
  } catch {
    update = null;
  }
  const db = app.store.db;
  const turns: unknown[] = [];
  const tools: unknown[] = [];
  try {
    for (const r of db.prepare("SELECT created_at AS at, meta FROM messages WHERE role = 'notice' AND content LIKE 'turnerror:%' ORDER BY id DESC LIMIT 20").all() as { at: string; meta: string | null }[]) {
      const m = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
      turns.push({ at: r.at, kind: String(m.errorClass ?? 'TurnError'), message: sc.line(String(m.error ?? '')) });
    }
    for (const r of db.prepare("SELECT created_at AS at, meta FROM messages WHERE role = 'tool' AND meta LIKE '%\"status\":\"error\"%' ORDER BY id DESC LIMIT 30").all() as { at: string; meta: string | null }[]) {
      const m = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
      tools.push({ at: r.at, tool: String(m.name ?? '?') });
    }
  } catch {
    /* an older database */
  }
  const providers = callTrouble(app).map((t) => ({ service: t.params.service ?? t.id, kind: t.kind, at: (t as { at?: string }).at ?? null, text: t.key, params: t.params }));
  const log = (app.log?.recent({ limit: LOG_LINES }) ?? []).reverse().map((l) => `${l.t} ${l.level.toUpperCase()} ${sc.line(l.msg)}`);
  const values: Record<string, unknown> = {};
  for (const k of Object.keys(SUPPORT_ALLOW)) values[k] = valueAt(s, k);
  const shape: Record<string, boolean | number> = {};
  for (const [k, v] of Object.entries(s).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z]\w{0,40}$/.test(k) || v === undefined || v === null) continue;
    shape[k] = typeof v === 'boolean' ? v : Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length > 0 : true;
  }
  // Keys hidden: only whether one is set (vault values never leave).
  const providerList = (s.providers ?? []).map((p) => ({ id: p.id, label: p.label, kind: p.kind, defaultModel: p.defaultModel ?? null, key: app.vault.has(vaultKeyFor(p.id)) }));
  let apps: unknown[] = [];
  try {
    apps = Object.entries(new AppInstalls(ctx.rootDir, () => app.now()).read().apps).map(([id, a]) => appInstallView(id, a, version)).map((a) => ({ kind: a.platform, version: a.version, os: a.os ?? null, state: a.state ?? null, latest: a.latest ?? null, behind: a.behind, seenAt: a.seenAt }));
  } catch {
    apps = [];
  }
  const report = {
    at: app.now().toISOString(),
    version: { server: version, revision: ctx.info?.revision ?? null, node: process.version, update },
    health,
    selfTest,
    errors: { turns, providers, tools },
    log,
    settings: { values, shape, providers: providerList },
    models: { default: { provider: s.defaultProviderId ?? null, model: s.defaultModel ?? null }, fallbacks: s.defaultFallbacks ?? [], fallbackAfterSec: s.fallbackAfterSec ?? 60, autoJobs: s.autoJobs ?? [], trouble: providers },
    apps,
  };
  // The last wall: every string in the report through the scrubber once more.
  return deep(report, sc.text) as Record<string, unknown>;
}

function http(err: unknown): never {
  if (err instanceof SupportError) throw new HttpError(err.status, err.message);
  throw err;
}

export function createSupportRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'support') return NEXT;
    const sp = ctx.opts.demo || ctx.opts.member ? undefined : supportOf(app);
    if (!sp) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 64 * 1024);
    const s = () => app.settings.get();
    try {
      if (!b && method === 'GET') return send(res, 200, { given: sp.passes('given'), held: sp.passes('held'), proposals: sp.proposals(s()), log: sp.logRows(100), peers: sp.peers(), allow: Object.keys(SUPPORT_ALLOW), hours: [1, 24, 168], providers: (s().providers ?? []).map((p) => ({ id: p.id, label: p.label })) });
      if (b === 'passes' && !c && method === 'POST') return send(res, 200, { pass: await sp.grant(String(body.link ?? ''), body.hours, body.note) });
      if (b === 'passes' && c && method === 'DELETE') return (await sp.revoke(c), send(res, 200, { ok: true }));
      if (b === 'look' && method === 'POST') {
        const link = String(body.link ?? '');
        const peer = sp.peer(link);
        if (!sp.activePass(link, 'held')) throw new SupportError(403, en('You need a valid help pass first.'));
        const r = await sp.call(link, 'look', {});
        sp.log(link, peer.name, 'helper', 'look');
        const report = (r.report ?? {}) as Record<string, unknown>;
        return send(res, 200, { peer: peer.name, report, findings: supportFindings(report) });
      }
      if (b === 'propose' && method === 'POST') {
        const link = String(body.link ?? '');
        sp.peer(link);
        // Checked here against the allowlist's shape; the helped side checks it again against its own settings.
        const changes = (Array.isArray(body.changes) ? body.changes : []).slice(0, 8).map((x) => shapeOnly(x));
        return send(res, 200, { proposal: await sp.propose(link, changes, body.note) });
      }
      if (b === 'proposals' && c && method === 'POST') return send(res, 200, { proposal: await sp.decide(c, body.approve === true, s(), (patch) => app.settings.update(patch)) });
    } catch (err) {
      http(err);
    }
    throw new HttpError(404, 'Not found');
  };
}

/** Helper-side check: the path must be on the allowlist and the value plain JSON (the values are checked by the helped side). */
function shapeOnly(x: unknown): SupportChange {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const path = String(o.path ?? '');
  if (!Object.hasOwn(SUPPORT_ALLOW, path)) throw new SupportError(400, en('That setting can’t be changed through a help pass.'));
  const rule = SUPPORT_ALLOW[path]!;
  const v = o.value;
  const okShape = rule.kind === 'bool' ? typeof v === 'boolean' : rule.kind === 'seconds' ? Number.isInteger(Number(v)) && Number(v) >= rule.min! && Number(v) <= rule.max! : rule.kind === 'fallbacks' || rule.kind === 'jobs' ? Array.isArray(v) : typeof v === 'string' && v.length <= 120;
  if (!okShape) throw new SupportError(400, en('That value is not valid for this setting.'));
  return { path, value: v };
}

/** POST /msg/v1/support/<op> from the other linked server (mounted in server.ts for the owner only). */
export async function handleSupportPeer(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const sp = supportOf(ctx.app);
  if (!sp) return reply(404, { error: 'not found' });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const op = path.slice('/msg/v1/support/'.length);
  if (!['pass', 'revoke', 'look', 'propose', 'answer'].includes(op)) return reply(404, { error: 'not found' });
  let raw = '';
  try {
    raw = await new Promise<string>((ok, fail) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 64 * 1024) {
          fail(new Error('too big'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });
  } catch {
    return reply(413, { error: 'too big' });
  }
  const who = (name: string) => `link:${name}`.slice(0, 80);
  try {
    const { linkId, name } = sp.verify(req.headers, op, raw);
    const b = JSON.parse(raw) as Record<string, unknown>;
    if (op === 'pass') return (sp.heldPass(linkId, name, b), reply(200, { ok: true }));
    if (op === 'revoke') return (sp.heldRevoked(linkId, name, b), reply(200, { ok: true }));
    if (op === 'answer') return (sp.answered(linkId, name, b), reply(200, { ok: true }));
    // look and propose need a valid pass that this owner gave on this link.
    if (!sp.activePass(linkId, 'given')) {
      audit({ action: `support.${op}`, who: who(name), role: 'system', channel: 'support-link', outcome: 'refused' });
      return reply(403, { error: 'no valid pass' });
    }
    if (op === 'look') {
      const report = await supportReport(ctx);
      sp.log(linkId, name, 'helped', 'look');
      audit({ action: 'support.look', who: who(name), role: 'system', channel: 'support-link', outcome: 'ok' });
      sp.onChange?.(linkId);
      return reply(200, { report });
    }
    const s = ctx.app.settings.get();
    const changes = (Array.isArray(b.changes) ? b.changes : []).slice(0, 8).map((x) => cleanChange(x, s));
    const note = String(b.note ?? '');
    if (!changes.length && !note.trim()) throw new SupportError(400, en('Add a change or a note.'));
    const p = sp.received(linkId, String(b.proposal ?? '').slice(0, 64), changes, note, s);
    audit({ action: 'support.propose', who: who(name), role: 'system', channel: 'support-link', outcome: 'pending', keys: changes.map((x) => x.path) });
    ctx.app.messages?.onNotify?.(name, en('Suggests a change to your Sara: open Messages to answer it.'), linkId);
    return reply(200, { id: p.id });
  } catch (err) {
    if (err instanceof SupportError) return reply(err.status, { error: err.message });
    return reply(400, { error: 'bad request' });
  }
}
