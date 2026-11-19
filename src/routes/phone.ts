// N5b: phone quick actions and Share to Sara (src/phone-actions.ts, docs/PHONE.md).
//   POST /api/phone/act    {action, reply?}  Authorization: Bearer sara_act.… (before sign-in: the
//                                             one-time token is the credential; no cookie needed)
//   POST /api/phone/share  multipart (title, text, url, files) from the PWA share target, the service
//                          worker or the Android share sheet: files into the Library, a new chat with a
//                          ready message. JSON ({conversationId, url, prefill, docs}) when asked for
//                          JSON, otherwise a 303 to the chat (a plain share-target navigation).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { audit } from '../audit-trail.ts';
import { HttpError, readJson, readRaw, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { SUPPORTED } from '../library/read.ts';
import { ACT_LINES, ACT_PREFIX, ActError, parseMultipart, phoneMayApprove, sharePrefill, SNOOZE_MS, type ActClaims } from '../phone-actions.ts';
import { badgeCount } from '../shortcuts.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export const SHARE_MAX_BYTES = 40 * 1024 * 1024;
export const SHARE_MAX_FILES = 10;
const REPLY_MAX = 4000;

const bearer = (req: IncomingMessage): string => {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
const wantsJson = (req: IncomingMessage) => /json/.test(String(req.headers.accept ?? ''));
const extOk = (name: string) => SUPPORTED.some((s) => s.exts.some((e) => name.toLowerCase().endsWith(e)));
const EXT_OF_TYPE: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html', 'text/markdown': '.md' };

export function createPhoneRoutes(ctx: RouteCtx): { publicRoutes: RouteHandler; routes: RouteHandler } {
  const { app, active, spaceId, isAuthed } = ctx;
  const who = () => (ctx.opts.member ? `member:${spaceId}` : 'owner');

  const fail = (err: unknown): never => {
    if (err instanceof ActError) throw new HttpError(err.status, err.key);
    throw err;
  };

  async function act(c: ActClaims, action: string, reply: string): Promise<{ ok: true; done: string }> {
    const push = app.push!;
    if (action === 'reply') {
      const text = reply.trim().slice(0, REPLY_MAX);
      if (!text) throw new HttpError(400, 'Write a reply first.');
      const conv = c.conv ? app.store.getConversation(c.conv) : undefined;
      if (!conv || conv.partner) throw new HttpError(404, ACT_LINES.nothing);
      if (active.has(conv.id)) throw new HttpError(409, 'Sara is still working on this conversation. Wait for her or press Stop.');
      push.actions.spend(c);
      void ctx.runBackground(conv.id, text, {}).catch(() => {});
      return { ok: true, done: 'reply' };
    }
    if (c.kind === 'approval') {
      // Only a card that is still waiting in this conversation, and only a plain one.
      let ev: Parameters<typeof phoneMayApprove>[0] | undefined;
      for (const [convId, t] of active) for (const a of t.approvals.values()) if (a.approvalId === c.id && convId === c.conv) ev = a;
      if (!ev) throw new HttpError(404, ACT_LINES.gone);
      if (!phoneMayApprove(ev)) throw new HttpError(403, ACT_LINES.pcOnly, { pcOnly: true });
      push.actions.spend(c);
      if (!app.approvals.decide(c.id, action === 'approve')) throw new HttpError(404, ACT_LINES.gone);
      return { ok: true, done: action };
    }
    if (c.kind === 'automation') {
      if (!app.automations) throw new HttpError(404, ACT_LINES.nothing);
      push.actions.spend(c);
      try {
        await app.automations.answer(Number(c.id), action === 'approve');
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      return { ok: true, done: action };
    }
    if (c.kind === 'reminder' && action === 'snooze') {
      const r = app.planner?.reminder(Number(c.id));
      if (!app.planner || !r) throw new HttpError(404, ACT_LINES.nothing);
      push.actions.spend(c);
      app.planner.addReminder({ text: r.text, dueAt: new Date(app.now().getTime() + SNOOZE_MS).toISOString(), conversationId: c.conv ?? r.conversationId ?? null });
      return { ok: true, done: 'snooze' };
    }
    // W5.4 (docs/design/W5KIDS.md): a kid's request (one more 15 minutes, a tool, something else).
    if (c.kind === 'kid' && (action === 'approve' || action === 'decline')) {
      if (!app.family) throw new HttpError(404, ACT_LINES.nothing);
      push.actions.spend(c);
      const { decideKidRequest } = await import('../kid-mode.ts');
      try {
        decideKidRequest(app.family, Number(c.id), action === 'approve');
      } catch (err) {
        throw new HttpError((err as { status?: number }).status ?? 409, (err as Error).message);
      }
      return { ok: true, done: action };
    }
    if (c.kind === 'inbox' && action === 'accept') {
      const inbox = app.inbox;
      const item = inbox?.list({ status: 'pending', limit: 500 }).find((x) => String(x.id) === c.id);
      if (!inbox || !item) throw new HttpError(404, ACT_LINES.nothing);
      push.actions.spend(c);
      await inbox.accept(item.id);
      return { ok: true, done: 'accept' };
    }
    throw new HttpError(400, ACT_LINES.notAllowed);
  }

  const publicRoutes: RouteHandler = async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'phone' || b !== 'act' || method !== 'POST') return NEXT;
    const token = bearer(req);
    if (!token.startsWith(ACT_PREFIX)) throw new HttpError(401, ACT_LINES.bad);
    if (!app.push || ctx.opts.demo) throw new HttpError(404, 'Not found');
    const body = await readJson(req);
    const action = String(body.action ?? '');
    let c: ActClaims;
    try {
      c = app.push.actions.check(token, { action, companion: app.companionId ?? 'main' });
    } catch (err) {
      audit({ action: 'phone.act', who: who(), role: ctx.opts.member ? 'member' : 'owner', channel: 'phone', outcome: 'refused', keys: [action.slice(0, 20)] });
      return fail(err);
    }
    try {
      const out = await act(c, action, String(body.reply ?? ''));
      audit({ action: 'phone.act', who: who(), role: ctx.opts.member ? 'member' : 'owner', channel: 'phone', outcome: 'ok', keys: [action], target: c.kind });
      return send(res, 200, out);
    } catch (err) {
      audit({ action: 'phone.act', who: who(), role: ctx.opts.member ? 'member' : 'owner', channel: 'phone', outcome: 'refused', keys: [action], target: c.kind });
      return fail(err);
    }
  };

  async function share(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const out = shareInto(app, await readShare(req), who(), ctx.opts.member ? 'member' : 'owner', 'phone');
    if (wantsJson(req)) return send(res, 201, out);
    res.writeHead(303, { location: out.url, 'cache-control': 'no-store' });
    return void res.end();
  }

  const routes: RouteHandler = async (req, res, method, parts) => {
    const [a, b] = parts;
    // R4: the installed web app's badge (navigator.setAppBadge): approvals and inbox cards waiting.
    if (a === 'phone' && b === 'badge' && method === 'GET') return send(res, 200, { count: ctx.opts.demo ? 0 : badgeCount(active, app) });
    if (a !== 'phone' || b !== 'share' || method !== 'POST') return NEXT;
    if (ctx.opts.demo) throw new HttpError(403, 'Not on the demo.');
    return share(req, res);
  };

  // A share-target navigation without a session: back to the sign-in page, not a JSON error.
  const sharePublic: RouteHandler = async (req, res, method, parts) => {
    if (parts[0] === 'phone' && parts[1] === 'share' && method === 'POST' && !isAuthed(req) && !wantsJson(req)) {
      res.writeHead(303, { location: '/#share=signin', 'cache-control': 'no-store' });
      return void res.end();
    }
    return publicRoutes(req, res, method, parts);
  };
  return { publicRoutes: sharePublic, routes };
}

export interface SharedInput {
  fields: { title?: string; text?: string; url?: string };
  files: { name: string; type: string; data: Buffer }[];
}
export interface ShareResult {
  conversationId: string;
  url: string;
  prefill: string;
  docs: { id: number; name: string }[];
  skipped: string[];
}

/**
 * Reads a share: a form (title, text, url, files) or JSON ({title, text, url, files: [{name, type,
 * data (base64)}]}; R4: Apple Shortcuts can send either).
 */
export async function readShare(req: IncomingMessage): Promise<SharedInput> {
  const type = String(req.headers['content-type'] ?? '');
  const raw = await readRaw(req, SHARE_MAX_BYTES);
  const fields: SharedInput['fields'] = {};
  const files: SharedInput['files'] = [];
  const keep = (name: string, v: string) => {
    if (name === 'title' || name === 'text' || name === 'url') fields[name] = v.slice(0, 4000).trim();
  };
  if (type.startsWith('multipart/form-data')) {
    let parts;
    try {
      parts = parseMultipart(raw, type);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    for (const p of parts) {
      if (p.filename !== undefined) {
        if (p.data.length) files.push({ name: p.filename || 'shared', type: p.type, data: p.data });
      } else keep(p.name, p.data.toString('utf8'));
    }
  } else if (type.startsWith('application/json')) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Send a form or JSON.');
    }
    for (const k of ['title', 'text', 'url'] as const) if (j[k] !== undefined && j[k] !== null) keep(k, String(j[k]));
    const list = Array.isArray(j.files) ? j.files : j.file ? [j.file] : [];
    for (const f of list as Record<string, unknown>[]) {
      const data = Buffer.from(String((f && typeof f === 'object' ? f.data : f) ?? '').replace(/^data:[^,]*,/, ''), 'base64');
      if (data.length) files.push({ name: String((f as { name?: unknown })?.name ?? 'shared'), type: String((f as { type?: unknown })?.type ?? ''), data });
    }
  } else throw new HttpError(415, 'Send a form or JSON.');
  if (files.length > SHARE_MAX_FILES) throw new HttpError(400, 'Share up to {n} files at a time.', { params: { n: SHARE_MAX_FILES } });
  if (!files.length && !fields.title && !fields.text && !fields.url) throw new HttpError(400, 'Nothing was shared.');
  return { fields, files };
}

/** Files into the Library (kept), a new chat "Shared with Sara" and the ready message for it. */
export function shareInto(app: RouteCtx['app'], input: SharedInput, who: string, role: 'owner' | 'member', channel: 'phone' | 'shortcuts'): ShareResult {
  const { fields, files } = input;
  const lib = app.library;
  const docs: { id: number; name: string }[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    let name = f.name.replace(/[\\/]/g, '_').slice(0, 120);
    if (!extOk(name) && EXT_OF_TYPE[f.type]) name += EXT_OF_TYPE[f.type];
    if (!lib || !extOk(name)) {
      skipped.push(name);
      continue;
    }
    try {
      const doc = lib.findKept(f.data) ?? lib.add({ name, bytes: f.data, keep: true, origin: 'library' });
      docs.push({ id: doc.id, name: doc.name });
    } catch {
      skipped.push(name);
    }
  }
  if (docs.length) {
    app.libraryNudge?.();
    for (const d of docs) app.events?.publish({ type: 'library', id: d.id });
  }
  const s = app.settings.get();
  const p = sharePrefill({ ...fields, files: files.filter((f) => !skipped.includes(f.name)).map((f) => ({ name: f.name, type: f.type })) });
  const prefill = trOwner(p.key, s, p.params);
  const title = trOwner('Shared with Sara', s);
  const conv = app.store.createConversation({ title });
  const url = `/#c=${conv.id}&draft=${encodeURIComponent(prefill)}${docs.length ? `&docs=${docs.map((d) => d.id).join(',')}` : ''}`;
  audit({ action: `${channel}.share`, who, role, channel, outcome: 'ok', keys: [String(files.length)] });
  return { conversationId: conv.id, url, prefill, docs, skipped };
}
