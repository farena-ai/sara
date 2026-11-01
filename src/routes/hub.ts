// Phase 113 (docs/SUPPORT.md, docs/PRIVACY.md): the anonymous daily check-in's settings (the
// owner's) and Report a problem / Suggest something / My reports (everyone's own, in their own
// space). Never on the demo (not in DEMO_READS / DEMO_WRITES; refused here too). Sara talks to the
// hub from the server, through the network guard; the page never does.
//   GET  /api/hub                         the switch, the first-run notice, a hub notice, when it last checked in
//   PUT  /api/hub                         { on }                                    (owner)
//   POST /api/hub/first-run               { action: 'shown' | 'dismiss' | 'off' }   (owner)
//   GET  /api/hub/preview                 the exact JSON a check-in would send now   (owner)
//   POST /api/hub/reset-id                a new install id                          (owner)
//   POST /api/hub/notice                  { id } a hub notice was shown: never again (owner)
//   POST /api/hub/diagnostics             { error?, conversationId? } the parts, built and scrubbed here
//   GET  /api/hub/tickets                 My reports (what this space sent; no hub call)
//   POST /api/hub/tickets                 { kind, title, body, contact?, diagnostics? } send a report
//   POST /api/hub/tickets/refresh         ask the hub about each report (only when My reports opens)
//   POST /api/hub/tickets/:ticket/reply   { text } answer the team
import { en } from '../i18n.ts';
import { HttpError, readJson, send } from '../http.ts';
import { buildDiagnostics, buildPing, fileTicket, hubRequest, isTicketId, ticketBlocked, type DiagStep, type FileResult, type HubSpace } from '../hub.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** What the page shows when a report can't go (the app translates these by their English text). */
export function ticketError(code: Extract<FileResult, { ok: false }>['code']): HttpError {
  if (code === 'demo') return new HttpError(403, en('Not available in the demo.'));
  if (code === 'private') return new HttpError(409, en("Reports can't be sent while “Nothing leaves this computer” is on."));
  if (code === 'email') return new HttpError(400, en("That email address doesn't look right."));
  if (code === 'title') return new HttpError(400, en('Write a short title first.'));
  if (code === 'limit') return new HttpError(429, en('Too many reports today. Try again tomorrow.'));
  return new HttpError(502, en("The support desk didn't answer. Try again later."));
}

const OWNER_ONLY = () => new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });

export function createHubRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'hub') return NEXT;
    const hub = app.hub;
    if (!hub || ctx.opts.demo || hub.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, en('Reports are not available here.'));
    }
    const owner = !hub.member && !ctx.opts.member;
    const view = () => {
      const st = hub.state.get();
      if (!owner) return { member: true, tickets: hub.tickets.list().length };
      return {
        member: false,
        on: st.on,
        blocked: hub.blocked() ?? null,
        firstRun: !st.noticeDismissedAt,
        banner: st.banner,
        lastSentAt: st.lastSentAt,
        lastError: st.lastError,
        nextAt: st.on ? st.nextAt : null,
        installId: st.id,
        tickets: hub.tickets.list().length,
      };
    };

    if (!b && method === 'GET') return send(res, 200, view());
    if (!b && method === 'PUT') {
      if (!owner) throw OWNER_ONLY();
      const body = await readJson(req);
      if (typeof body.on === 'boolean') hub.state.update({ on: body.on });
      return send(res, 200, view());
    }
    if (b === 'first-run' && method === 'POST') {
      if (!owner) throw OWNER_ONLY();
      const body = await readJson(req);
      const now = new Date().toISOString();
      const st = hub.state.get();
      if (body.action === 'shown' && !st.noticeShownAt) hub.state.update({ noticeShownAt: now });
      if (body.action === 'dismiss' || body.action === 'off') hub.state.update({ noticeShownAt: st.noticeShownAt ?? now, noticeDismissedAt: now, ...(body.action === 'off' ? { on: false } : {}) });
      return send(res, 200, view());
    }
    if (b === 'preview' && method === 'GET') {
      if (!owner) throw OWNER_ONLY();
      return send(res, 200, { payload: buildPing(hub.state.get().id, hub.facts()), blocked: hub.blocked() ?? null, url: `${hub.base}/v1/ping` });
    }
    if (b === 'reset-id' && method === 'POST') {
      if (!owner) throw OWNER_ONLY();
      await readJson(req).catch(() => undefined);
      hub.state.resetId();
      return send(res, 200, view());
    }
    if (b === 'notice' && method === 'POST') {
      if (!owner) throw OWNER_ONLY();
      const body = await readJson(req);
      hub.state.noticeSeen(String(body.id ?? '').slice(0, 64));
      return send(res, 200, view());
    }

    if (b === 'diagnostics' && method === 'POST') {
      const body = await readJson(req);
      const conv = typeof body.conversationId === 'string' && /^[0-9a-f-]{36}$/.test(body.conversationId) ? body.conversationId : undefined;
      let steps: DiagStep[] = [];
      if (conv && app.runs) {
        // The failing turn: the newest run of that conversation (tool names and statuses only).
        const run = app.runs.list({ conversationId: conv, limit: 1 })[0];
        if (run) steps = app.runs.steps(run.id).flatMap((s) => s.tools.map((t) => ({ tool: t.name, status: t.status })));
      }
      const diagnostics = buildDiagnostics(hub, { error: typeof body.error === 'string' ? body.error.slice(0, 16_000) : undefined, settings: app.settings.get() as unknown as Record<string, unknown>, steps });
      return send(res, 200, { diagnostics });
    }

    if (b === 'tickets' && !c && method === 'GET') return send(res, 200, { tickets: hub.tickets.list() });
    if (b === 'tickets' && !c && method === 'POST') {
      const body = await readJson(req, 600 * 1024);
      const r = await fileTicket(hub, body);
      if (!r.ok) throw ticketError(r.code);
      return send(res, 201, { ticket: r.ticket, tickets: hub.tickets.list() });
    }
    if (b === 'tickets' && c === 'refresh' && !d && method === 'POST') {
      await readJson(req).catch(() => undefined);
      if (!ticketBlocked(hub)) {
        for (const row of hub.tickets.list().slice(0, 30)) {
          const full = hub.tickets.get(row.ticket);
          if (!full) continue;
          try {
            const r = await hubRequest(hub.base, `/v1/tickets/${encodeURIComponent(row.ticket)}?token=${encodeURIComponent(full.token)}`, { send: hub.send, timeoutMs: 10_000 });
            if (r.status === 200 && r.json.ok !== false) hub.tickets.refresh(row.ticket, r.json, new Date().toISOString());
          } catch {
            /* shown as last checked */
          }
        }
      }
      return send(res, 200, { tickets: hub.tickets.list(), offline: Boolean(ticketBlocked(hub)) });
    }
    if (b === 'tickets' && c && d === 'reply' && method === 'POST') {
      const body = await readJson(req);
      const row = isTicketId(c) ? hub.tickets.get(c) : undefined;
      if (!row) throw new HttpError(404, en("That report isn't on this server."));
      const text = String(body.text ?? '').trim().slice(0, 4000);
      if (!text) throw new HttpError(400, en('Write a reply first.'));
      if (ticketBlocked(hub)) throw ticketError('private');
      let r;
      try {
        r = await hubRequest(hub.base, `/v1/tickets/${encodeURIComponent(c)}/reply`, { body: { token: row.token, text: hub.scrub(text) }, send: hub.send });
      } catch {
        throw new HttpError(502, en("The support desk didn't answer. Try again later."));
      }
      if (r.status === 429) throw new HttpError(429, en('Too many reports today. Try again tomorrow.'));
      if (r.status >= 300) throw new HttpError(502, en("The support desk didn't answer. Try again later."));
      try {
        const g = await hubRequest(hub.base, `/v1/tickets/${encodeURIComponent(c)}?token=${encodeURIComponent(row.token)}`, { send: hub.send, timeoutMs: 10_000 });
        if (g.status === 200) hub.tickets.refresh(c, g.json, new Date().toISOString());
      } catch {
        /* the list shows the last answer */
      }
      return send(res, 200, { tickets: hub.tickets.list() });
    }
    throw new HttpError(404, en('Not found'));
  };
}

/** For tests and main.ts: the hub space type (re-exported for the route's users). */
export type { HubSpace };
