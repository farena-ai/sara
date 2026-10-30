// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §3, §3.5, §9): the hands channel and its
// routes. The WebSocket /api/hands takes only a `hands` token in an Authorization header: cookies
// (and any Origin header, which a web page always sends) are refused, so no page, preview or site
// can open it. Making the token (POST /api/hands/pair, a fresh confirmation) lives in src/server.ts
// next to the other sign-in routes that confirm it's you.
//
//   GET    /api/hands                       the computers (connected or not), the member switch, the app link
//   DELETE /api/hands/<id>                  sign that computer out (its connection closes now)
//   POST   /api/hands/<id>/op               the owner tries one op on it (Settings → Try it, the conformance script)
//   POST   /api/hands/<id>/stop             stop everything running on it
//   GET    /api/computer                    the server-wide choices; PUT changes them (owner only)
//   GET    /api/computer/frame/<id>?after=n the live view: the newest frame after n (long-poll, memory only)
//   GET    /api/computer/thumb/<sha>        a step thumbnail from the run record
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { APPS_PAGE } from '../cards.ts';
import { ACT_LEVELS, actLevel, type ActLevel } from '../computer-policy.ts';
import { HandsError } from '../hands.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { acceptWebSocket, refuseUpgrade } from '../ws.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const OWNER_ONLY = { ownerOnly: true };

/** The upgrade to /api/hands (true when this handled it). */
export function createHandsUpgrade(ctx: RouteCtx): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const { app, auth, opts } = ctx;
  return (req, socket, head) => {
    const hub = app.hands;
    if (opts.demo || !hub) return refuseUpgrade(socket, 404, 'Not Found');
    // §3.3: never a browser: cookies and Origin headers are refused, the token is required.
    if (req.headers.cookie || req.headers.origin) return refuseUpgrade(socket, 403, 'Forbidden');
    const h = String(req.headers.authorization ?? '');
    const id = h.startsWith('Bearer ') ? auth.handsTokenId(h.slice(7).trim()) : undefined;
    if (!id) return refuseUpgrade(socket, 401, 'Unauthorized');
    if (!hub.allowed()) return refuseUpgrade(socket, 403, 'Forbidden');
    if (opts.member && opts.member.record()?.status !== 'active') return refuseUpgrade(socket, 403, 'Forbidden');
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    // Phase 88: the app renews its token over this connection (it holds a valid one right now).
    hub.attach(id, auth.deviceLabelOf(id) ?? "Sara's hands", ws, { renew: () => auth.renewHandsId(id) });
  };
}

export function createHandsRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'hands' && a !== 'computer') return NEXT;
    if (opts.demo) throw new HttpError(404, 'Not found');
    const hub = app.hands;
    if (!hub) throw new HttpError(404, 'Computer use is not available here.');
    // Members: only with the owner's switch on, and the server-wide choices stay the owner's.
    if (opts.member && (!hub.allowed() || (a === 'computer' && !b && method !== 'GET'))) throw new HttpError(403, 'Only the owner of this server can use this.', OWNER_ONLY);
    const settingsView = () => {
      const cu = app.settings.get().computerUse ?? {};
      return { members: cu.members === true, level: actLevel(cu.level), always: (cu.always ?? []).map((x) => ({ site: x.site, kind: x.kind, at: x.at })), alwaysWarned: cu.alwaysWarned === true };
    };

    if (a === 'computer') {
      if (!b && method === 'GET') return send(res, 200, { ...settingsView(), allowed: hub.allowed(), role: opts.member ? 'member' : 'owner' });
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        if (body.members !== undefined && typeof body.members !== 'boolean') throw new HttpError(400, 'members must be true or false.');
        if (body.level !== undefined && !ACT_LEVELS.includes(body.level as never)) throw new HttpError(400, 'level: ask, task or always.');
        const cu = { ...(app.settings.get().computerUse ?? {}) };
        if (typeof body.members === 'boolean') cu.members = body.members;
        // Phase 88: "Always allowed" shows its warning once (the page asks before sending this).
        if (body.level !== undefined) {
          if (body.level === 'always' && body.warned !== true && cu.alwaysWarned !== true) throw new HttpError(400, 'Always allowed needs the warning first.');
          cu.level = body.level as ActLevel;
          if (body.level === 'always') cu.alwaysWarned = true;
        }
        if (body.alwaysWarned === true) cu.alwaysWarned = true;
        // Remove one "always allowed" site + kind (or all of them).
        if (body.removeAlways !== undefined) {
          const rm = body.removeAlways as { site?: unknown; kind?: unknown } | 'all';
          cu.always = rm === 'all' ? [] : (cu.always ?? []).filter((x) => !(typeof rm === 'object' && rm && x.site === rm.site && x.kind === rm.kind));
        }
        app.settings.update({ computerUse: cu });
        return send(res, 200, settingsView());
      }
      if (b === 'frame' && c && !d && method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://x');
        const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
        const wait = url.searchParams.get('wait') === '1';
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const f = wait ? await hub.waitFrame(c, after, 25_000, ac.signal) : hub.frame(c, after);
        if (!f) return send(res, 200, { n: after, image: null, usedBy: hub.usedBy(c) ?? null });
        return send(res, 200, { n: f.n, at: f.at, w: f.w ?? null, h: f.h ?? null, image: `data:${f.mime};base64,${f.data.toString('base64')}`, usedBy: hub.usedBy(c) ?? null });
      }
      if (b === 'thumb' && c && !d && method === 'GET') {
        const t = app.runs?.thumb(c);
        if (!t) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': t.mime, 'cache-control': 'private, max-age=86400, immutable', ...SECURITY_HEADERS });
        return void res.end(t.data);
      }
      throw new HttpError(404, 'Not found');
    }

    // ---- /api/hands ----
    if (!b && method === 'GET') return send(res, 200, { devices: hub.devices(), ...settingsView(), allowed: hub.allowed(), role: opts.member ? 'member' : 'owner', downloadUrl: APPS_PAGE });
    if (b === 'pair' || b === 'renew') return NEXT; // src/server.ts (needs the confirmation helpers)
    if (!b) throw new HttpError(404, 'Not found');
    const known = hub.devices().find((x) => x.id === b);
    if (!known) throw new HttpError(404, 'No such computer.');
    if (!c && method === 'DELETE') {
      auth.signOut(b);
      hub.disconnect(b);
      return send(res, 200, { ok: true, devices: hub.devices() });
    }
    if (c === 'stop' && !d && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { ok: true, cancelled: hub.cancelAll(b) });
    }
    if (c === 'op' && !d && method === 'POST') {
      // The owner's own test of a computer (\"Try it\" in Settings, scripts/hands-conformance.ts). The
      // device still runs only its own command set; anything else comes back refused.
      const body = await readJson(req, 32 * 1024);
      const op = String(body.op ?? '');
      if (!/^[a-z]\.[A-Za-z]{1,30}$/.test(op)) throw new HttpError(400, 'op: like "b.open".');
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
      const ac = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      try {
        const r = await hub.request(b, op, args, { signal: ac.signal, ...(typeof body.id === 'string' && /^[\w-]{4,64}$/.test(body.id) ? { id: body.id } : {}), ...(Number(body.deadlineMs) > 0 ? { deadlineMs: Number(body.deadlineMs) } : {}) });
        return send(res, 200, { ok: true, result: r.result, images: r.images.map((i) => ({ kind: i.kind, mime: i.mime, w: i.w ?? null, h: i.h ?? null, bytes: i.data.length, data: `data:${i.mime};base64,${i.data.toString('base64')}` })) });
      } catch (err) {
        if (err instanceof HandsError) return send(res, 200, { ok: false, error: { code: err.code, message: err.message } });
        throw err;
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
