// R4 (docs/IPHONE.md): Apple Shortcuts on an iPhone, with a per-device token
// (`Authorization: Bearer sara_sc.…`, never in the address; OwnerAuth.createShortcutToken).
//   POST /api/shortcuts/share   form (file/files, text, url, title) or JSON (files: [{name, type,
//                               data base64}]) -> the Library + a chat "Shared with Sara" (like the
//                               PWA share); answers a short sentence (text) or JSON {say, url, …}
//   POST /api/shortcuts/ask     {text} (JSON, a form or plain text) -> a turn in this iPhone's "Siri"
//                               chat: at most two sentences (text) or JSON {say, url, later?}
//   GET  /api/shortcuts/widget  plain lines: next reminder, watches, what waits for you
// Signed in (Settings → Connections → Phone and notifications → iPhone Shortcuts): GET /api/shortcuts, POST /api/shortcuts/tokens
// {label, scopes}, DELETE /api/shortcuts/tokens/<id>, PUT /api/shortcuts/links (owner: iCloud links).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { audit } from '../audit-trail.ts';
import { SHORTCUT_SCOPES, SHORTCUT_TOKEN_PREFIX, type ShortcutScope, LoginLimiter } from '../auth.ts';
import { clientIp, HttpError, readJson, readRaw, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { privateLocalOn } from '../net-guard.ts';
import { externalTurn } from '../other-apps.ts';
import { qrSvg } from '../qr.ts';
import { browserOrigin } from '../reach.ts';
import { SC_LINES, ShortcutLimiter, ShortcutLinksFile, shortAnswer, waitingCount, widgetLines } from '../shortcuts.ts';
import { phoneWidgetExtras } from './her.ts';
import { readShare, shareInto, type SharedInput } from './phone.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** How long Ask Sara waits for her answer before saying "I'm on it" (Shortcuts give up after about a minute). */
export const ASK_BUDGET_MS = 20_000;
export const SHORTCUTS_CHANNEL = 'shortcuts';
const ASK_MAX = 2000;

const bearer = (req: IncomingMessage): string => {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
const wantsJson = (req: IncomingMessage) => /json/.test(String(req.headers.accept ?? ''));

/**
 * A Shortcut's Form field of type File turns a shared link or a bit of text into a small text file:
 * one short plain-text file with nothing else becomes the link (or the text) again.
 */
export function linkFromFile(input: SharedInput): SharedInput {
  const [f] = input.files;
  if (input.files.length !== 1 || input.fields.text || input.fields.url || !f || f.data.length > 4000) return input;
  if (!/^text\/plain\b/.test(f.type) && !/^[^.]*$|\.txt$/i.test(f.name)) return input;
  const words = f.data.toString('utf8').trim();
  if (!words || /\uFFFD|\u0000/.test(words)) return input;
  return /^https?:\/\/\S+$/i.test(words) ? { fields: { ...input.fields, url: words }, files: [] } : { fields: { ...input.fields, text: words }, files: [] };
}

/** This iPhone's own "Siri" conversation (one per token). */
export function siriConversation(app: RouteCtx['app'], tokenId: string): string {
  const found = app.store.findChannelConversation(SHORTCUTS_CHANNEL, tokenId);
  if (found) return found.id;
  return app.store.createConversation({ title: 'Siri', channel: SHORTCUTS_CHANNEL, channelKey: tokenId }).id;
}

export function createShortcutRoutes(ctx: RouteCtx & { askBudgetMs?: number; linksDir?: string }): { publicRoutes: RouteHandler; routes: RouteHandler } {
  const { app, auth, active, spaceId } = ctx;
  const limiter = new ShortcutLimiter();
  const wrong = new LoginLimiter(20, 15 * 60_000);
  const links = new ShortcutLinksFile(ctx.linksDir ?? ctx.rootDir);
  const role = () => (ctx.opts.member ? 'member' : 'owner') as 'member' | 'owner';
  const who = () => (ctx.opts.member ? `member:${spaceId}` : 'owner');
  const tr = (key: string, params?: Record<string, unknown>) => trOwner(key, app.settings.get(), params);
  // The address the iPhone used (its links come back to it; loopback is fine for a test on this computer).
  const origin = (req: IncomingMessage): string => {
    const host = String(req.headers.host ?? '');
    if (!/^[\w.:[\]-]+$/.test(host)) return browserOrigin(req as never) ?? '';
    const fwd = ctx.opts.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() : '';
    const https = fwd ? fwd === 'https' : Boolean((req.socket as { encrypted?: boolean }).encrypted);
    return `${https ? 'https' : 'http'}://${host}`;
  };

  /** Plain text for Shortcuts (Show Result / Speak Text), JSON when asked for. */
  function answer(req: IncomingMessage, res: ServerResponse, status: number, say: string, extra: Record<string, unknown> = {}): void {
    if (wantsJson(req)) return send(res, status, { say, ...extra });
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...(typeof extra.url === 'string' ? { 'x-sara-url': extra.url } : {}) });
    res.end(say);
  }

  function check(req: IncomingMessage, route: 'share' | 'ask' | 'widget'): { id: string; label: string; scopes: ShortcutScope[] } {
    const ip = clientIp(req, ctx.opts.trustProxy);
    if (wrong.blocked(ip)) throw new HttpError(429, SC_LINES.slow);
    const tok = auth.shortcutToken(bearer(req));
    if (!tok || ctx.opts.demo) {
      wrong.fail(ip);
      audit({ action: `shortcuts.${route}`, who: who(), role: role(), channel: SHORTCUTS_CHANNEL, outcome: 'refused', keys: ['token'] });
      throw new HttpError(401, SC_LINES.bad);
    }
    // The widget only reads this person's own lines: any of the two scopes may show it.
    if (route !== 'widget' && !tok.scopes.includes(route)) throw new HttpError(403, SC_LINES.scope);
    // Private local mode: nothing reaches Sara from other devices while it is on.
    if (privateLocalOn()) throw new HttpError(403, SC_LINES.privateLocal);
    if (!limiter.take(tok.id, route)) throw new HttpError(429, SC_LINES.slow);
    return tok;
  }

  async function readAsk(req: IncomingMessage): Promise<string> {
    const type = String(req.headers['content-type'] ?? '');
    if (type.startsWith('application/json')) return String((await readJson(req, 16_384)).text ?? '');
    const raw = (await readRaw(req, 16_384)).toString('utf8');
    if (type.startsWith('application/x-www-form-urlencoded')) return new URLSearchParams(raw).get('text') ?? '';
    if (type.startsWith('multipart/form-data')) {
      const { parseMultipart } = await import('../phone-actions.ts');
      return parseMultipart(Buffer.from(raw), type).find((p) => p.name === 'text')?.data.toString('utf8') ?? '';
    }
    return raw;
  }

  async function ask(req: IncomingMessage, res: ServerResponse, tok: { id: string }): Promise<void> {
    const text = (await readAsk(req)).trim().slice(0, ASK_MAX);
    if (!text) return answer(req, res, 400, tr(SC_LINES.empty));
    const convId = siriConversation(app, tok.id);
    const url = `${origin(req)}/#c=${convId}`;
    const started = Date.now();
    let late = false;
    const turn = externalTurn(app, convId, text, { siri: true }, { stopOnApproval: true }).then((r) => {
      // Handed off: when the answer is ready, the phone gets a notification that opens this chat
      // (the server sends its own "Sara finished" for turns of a minute or more).
      if (late && !r.busy && !r.waiting && r.text.trim() && Date.now() - started < 60_000) void app.push?.notifyOwner(tr('Sara finished'), shortAnswer(r.text), convId, `done-${convId}`).catch(() => {});
      return r;
    });
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ctx.askBudgetMs ?? ASK_BUDGET_MS)));
    const r = await Promise.race([turn, budget]);
    clearTimeout(timer);
    audit({ action: 'shortcuts.ask', who: who(), role: role(), channel: SHORTCUTS_CHANNEL, outcome: 'ok', keys: [r ? 'answered' : 'later'] });
    if (!r) {
      late = true;
      const canPush = (app.push?.list().length ?? 0) > 0;
      return answer(req, res, 202, tr(canPush ? SC_LINES.later : SC_LINES.laterNoPush), { url, later: true });
    }
    if (r.busy) return answer(req, res, 409, tr(SC_LINES.busy), { url });
    if (r.waiting) return answer(req, res, 200, tr(SC_LINES.waiting, { what: shortAnswer(r.waiting, 1, 160) }), { url, waiting: true });
    if (r.error && !r.text.trim()) return answer(req, res, 502, tr(SC_LINES.failed), { url });
    const notices = r.notices.map((n) => shortAnswer(n, 1, 200)).join(' ');
    return answer(req, res, 200, [notices, shortAnswer(r.text)].filter(Boolean).join(' '), { url });
  }

  const publicRoutes: RouteHandler = async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'shortcuts' || parts.length !== 2) return NEXT;
    // Only a Shortcuts token here; a signed-in page uses the routes below.
    if (!bearer(req).startsWith(SHORTCUT_TOKEN_PREFIX)) return NEXT;
    if (b === 'share' && method === 'POST') {
      check(req, 'share');
      const out = shareInto(app, linkFromFile(await readShare(req)), who(), role(), SHORTCUTS_CHANNEL);
      const url = `${origin(req)}${out.url}`;
      const say = [out.docs.length ? tr(SC_LINES.saved, { names: out.docs.map((d) => d.name).join(', ') }) : tr(SC_LINES.savedText), out.skipped.length ? tr(SC_LINES.skipped, { names: out.skipped.join(', ') }) : ''].filter(Boolean).join(' ');
      return answer(req, res, 201, say, { ...out, url });
    }
    if (b === 'ask' && method === 'POST') return ask(req, res, check(req, 'ask'));
    if (b === 'widget' && method === 'GET') {
      check(req, 'widget');
      const lines = widgetLines(app, phoneWidgetExtras(app), waitingCount(active, app));
      if (wantsJson(req)) return send(res, 200, { lines, url: `${origin(req)}/` });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(lines.join('\n'));
    }
    return NEXT;
  };

  // Signed in: this person's tokens (each household member makes their own), the ready links.
  const routes: RouteHandler = async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'shortcuts') return NEXT;
    if (ctx.opts.demo) throw new HttpError(403, 'Not on the demo.');
    const view = (r: IncomingMessage) => ({ server: origin(r), tokens: auth.shortcutTokens(), links: links.get(), owner: !ctx.opts.member, privateLocal: privateLocalOn() });
    if (!b && method === 'GET') return send(res, 200, view(req));
    if (b === 'tokens' && !c && method === 'POST') {
      // A token made by an app that signed in with its own token could outlive that app's sign-in: the web page only.
      if (String(req.headers.authorization ?? '').startsWith('Bearer ')) throw new HttpError(403, 'Make Shortcuts tokens in the Sara web app.');
      const body = await readJson(req, 4096);
      const scopes = Array.isArray(body.scopes) ? SHORTCUT_SCOPES.filter((x) => (body.scopes as unknown[]).includes(x)) : [...SHORTCUT_SCOPES];
      let made;
      try {
        made = auth.createShortcutToken(String(body.label ?? ''), scopes);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      audit({ action: 'shortcuts.token', who: who(), role: role(), channel: 'web', outcome: 'ok', keys: made.scopes });
      const qr = `data:image/svg+xml;base64,${Buffer.from(qrSvg(made.token)).toString('base64')}`;
      return send(res, 201, { ...made, qr, ...view(req) });
    }
    if (b === 'tokens' && c && method === 'DELETE') {
      if (!auth.shortcutTokens().some((x) => x.id === c)) throw new HttpError(404, 'Not found');
      auth.signOut(c);
      audit({ action: 'shortcuts.revoke', who: who(), role: role(), channel: 'web', outcome: 'ok' });
      return send(res, 200, view(req));
    }
    if (b === 'links' && method === 'PUT') {
      if (ctx.opts.member) throw new HttpError(403, 'Only the owner of this server can use this.');
      const body = await readJson(req, 4096);
      try {
        links.set(body);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return send(res, 200, view(req));
    }
    return NEXT;
  };
  return { publicRoutes, routes };
}
