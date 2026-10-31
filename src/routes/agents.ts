// Phase 100 (ST5, docs/design/STAPLES.md §8.5): Settings → Connections → Other agents (A2A). Every
// route is the owner's: `agents` is not a member route family (src/household.ts), so a household
// member gets 403 ownerOnly before reaching here; the demo refuses it (not in DEMO_READS/WRITES);
// an app signed in with a device code can't use it (DEVICE_TOKEN_DENIED in src/server.ts).
//   GET    /api/agents                 her switches, her public card, the peers (today's numbers), the last 20 requests
//   PUT    /api/agents                 { enabled?, showName?, operator?, lanInPrivate? }
//   POST   /api/agents/fetch-card      { url } → the review card of an agent she could ask (nothing stored)
//   POST   /api/agents                 { kind:'in', label, policy } → a key for an agent (shown once)
//                                      { kind:'out', url, sha, key?, label? } → add an agent she can ask
//   POST   /api/agents/:id/key         in: a new key (the old one stops working) · out: { key } (write-only)
//   PUT    /api/agents/:id/policy      { policy?, label? }
//   POST   /api/agents/:id/recheck     out: read its card again (changed → a new review)
//   POST   /api/agents/:id/card        out: { sha } accept the card that changed
//   GET    /api/agents/:id/tasks       its tasks (both directions)
//   DELETE /api/agents/:id             remove (its key stops working, its key in the vault goes)
import { cleanPolicy, publicCard, TERMINAL, type Peer } from '../a2a.ts';
import { HttpError, readJson, send } from '../http.ts';
import { isPrivateLocalError, privateLocalOn } from '../net-guard.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createAgentRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth } = ctx;
  const asHttp = (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    if (isPrivateLocalError(err)) throw new HttpError(403, 'Private local mode is on ("Nothing leaves this computer"): only agents on this computer can be reached.');
    throw new HttpError(400, (err as Error).message);
  };
  const view = (p: Peer & { today?: unknown; expiresAt?: string | null }) => {
    const c = p.card as Record<string, unknown> | null;
    return {
      id: p.id,
      label: p.label,
      direction: p.direction,
      policy: p.policy,
      createdAt: p.createdAt,
      lastSeen: p.lastSeen,
      today: p.today ?? null,
      expiresAt: p.expiresAt ?? null,
      hasKey: p.direction === 'in' ? Boolean(p.deviceId) : Boolean(app.a2aClient?.hasKey(p.id)),
      card: c ? { name: String(c.name ?? ''), description: String(c.description ?? ''), url: p.cardUrl, sha: (p.cardSha ?? '').slice(0, 12), checkedAt: p.cardCheckedAt, skills: (Array.isArray(c.skills) ? (c.skills as Record<string, unknown>[]) : []).slice(0, 20).map((s) => ({ id: String(s.id ?? ''), name: String(s.name ?? s.id ?? ''), description: String(s.description ?? '').slice(0, 200) })) } : null,
    };
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'agents') return NEXT;
    const srv = app.a2a;
    const cli = app.a2aClient;
    if (!srv || !cli || app.member || ctx.opts.demo) throw new HttpError(404, 'Other agents (A2A) are not available here.');

    if (!b && method === 'GET') {
      const o = srv.overview();
      const base = srv.baseOf(req);
      return send(res, 200, {
        settings: srv.settings(),
        cardUrl: `${base}/.well-known/agent-card.json`,
        card: srv.settings().enabled ? publicCard(srv.cardOpts(req)) : null,
        peers: o.peers.map(view),
        recent: o.recent,
        tools: ['web', 'todo'],
        skills: (app.skills?.effective() ?? []).filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description.slice(0, 200) })),
        privateLocal: privateLocalOn(),
        name: app.persona.name,
      });
    }
    if (!b && method === 'PUT') {
      const body = await readJson(req);
      const cur = app.settings.get().a2a ?? {};
      const next = { ...cur };
      if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
      if (typeof body.showName === 'boolean') next.showName = body.showName;
      if (typeof body.lanInPrivate === 'boolean') next.lanInPrivate = body.lanInPrivate;
      if (typeof body.operator === 'string') next.operator = body.operator.replace(/[\r\n<>]/g, ' ').trim().slice(0, 60);
      app.settings.update({ a2a: next });
      return send(res, 200, { settings: srv.settings() });
    }
    if (b === 'fetch-card' && !c && method === 'POST') {
      const body = await readJson(req);
      try {
        const r = await cli.fetchCard(String(body.url ?? ''));
        const known = srv.store.peers().find((p) => p.cardUrl === r.url);
        return send(res, 200, { review: { url: r.url, sha: r.sha, name: r.name, description: r.description, provider: r.provider, interfaces: r.interfaces, auth: r.auth, skills: r.skills, streaming: r.streaming, signature: r.signature, warnings: r.warnings, binding: r.iface.binding }, ...(known ? { known: known.id } : {}) });
      } catch (err) {
        return asHttp(err);
      }
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      if (body.kind === 'in') {
        const label = String(body.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!label) throw new HttpError(400, 'Name the agent (for example "Research Bot").');
        const days = Number(body.days) || 180;
        const key = auth.createAgentKey(label, days);
        const peer = srv.store.addPeer({ label, direction: 'in', deviceId: key.id, policy: cleanPolicy(body.policy) });
        return send(res, 200, { peer: view(peer), token: key.token, expiresAt: key.expiresAt });
      }
      if (body.kind === 'out') {
        try {
          const peer = await cli.add({ url: String(body.url ?? ''), sha: String(body.sha ?? ''), ...(typeof body.key === 'string' ? { key: body.key } : {}), ...(typeof body.label === 'string' ? { label: body.label } : {}), policy: cleanPolicy(body.policy) });
          return send(res, 200, { peer: view(peer) });
        } catch (err) {
          return asHttp(err);
        }
      }
      throw new HttpError(400, 'Say whether this agent may ask her (in) or she may ask it (out).');
    }
    const peer = b ? srv.store.peer(b) : undefined;
    if (!peer) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'No such agent.');
    }
    if (c === 'key' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (peer.direction === 'out') {
        if (typeof body.key !== 'string') throw new HttpError(400, 'Paste the key the agent gave you.');
        cli.setKey(peer.id, body.key);
        return send(res, 200, { ok: true, hasKey: cli.hasKey(peer.id) });
      }
      // A new key for an agent that asks her: the old one stops working at once.
      if (peer.deviceId) auth.signOut(peer.deviceId);
      const key = auth.createAgentKey(peer.label, Number(body.days) || 180);
      srv.store.updatePeer(peer.id, { deviceId: key.id });
      return send(res, 200, { token: key.token, expiresAt: key.expiresAt });
    }
    if (c === 'policy' && method === 'PUT') {
      const body = await readJson(req);
      const label = typeof body.label === 'string' ? body.label.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
      const p = srv.store.updatePeer(peer.id, { policy: cleanPolicy(body.policy, peer.policy), ...(label ? { label } : {}) });
      return send(res, 200, { peer: view(p!) });
    }
    if (c === 'recheck' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      if (peer.direction === 'in') throw new HttpError(400, 'This agent only asks her; it has no card here.');
      try {
        const r = await cli.recheck(peer);
        if (!r.changed) srv.store.updatePeer(peer.id, { card: peer.card });
        return send(res, 200, { changed: r.changed, review: { url: r.review.url, sha: r.review.sha, name: r.review.name, description: r.review.description, provider: r.review.provider, interfaces: r.review.interfaces, auth: r.review.auth, skills: r.review.skills, streaming: r.review.streaming, signature: r.review.signature, warnings: r.review.warnings, binding: r.review.iface.binding } });
      } catch (err) {
        return asHttp(err);
      }
    }
    if (c === 'card' && method === 'POST') {
      const body = await readJson(req);
      try {
        const r = await cli.fetchCard(peer.cardUrl ?? '');
        if (r.sha !== String(body.sha ?? '')) throw new HttpError(409, 'The agent card changed again. Look at it once more.');
        const p = srv.store.updatePeer(peer.id, { card: r.card, cardSha: r.sha });
        return send(res, 200, { peer: view(p!) });
      } catch (err) {
        return asHttp(err);
      }
    }
    if (c === 'tasks' && method === 'GET') {
      const rows = [...srv.store.listTasks(peer.id, 'in', { limit: 50 }).rows, ...srv.store.listTasks(peer.id, 'out', { limit: 50 }).rows].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
      return send(res, 200, { tasks: rows.map((t) => ({ id: t.id, direction: t.direction, state: t.state, open: !TERMINAL.has(t.state), contextId: t.contextId, conversationId: t.conversationId, cardTaskId: t.cardTaskId, at: t.updatedAt, text: (t.statusMessage?.parts[0]?.text ?? '').slice(0, 200) })) });
    }
    if (!c && method === 'DELETE') {
      if (peer.deviceId) auth.signOut(peer.deviceId);
      cli.forget(peer.id);
      srv.store.updatePeer(peer.id, { status: 'removed', deviceId: null });
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
