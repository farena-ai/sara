// Phase 101 (ST6, docs/design/STAPLES.md §9.7, docs/PEOPLE.md): the People page's routes, for the
// owner and household members, each in their own space (the companion's own database). Never
// reached by /v1, MCP or A2A keys (those have their own routes and never these).
import type { IncomingMessage } from 'node:http';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { forgetMemory } from '../memory-worker.ts';
import { backfillDone, startBackfill } from '../people-backfill.ts';
import { CIRCLES, FACT_CATEGORIES, type FactCategory, type Person, type PersonFact, validBirthday } from '../people.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const PHOTO_MAX = 3 * 1024 * 1024;

async function bodyOf(req: IncomingMessage, max?: number): Promise<Record<string, unknown>> {
  return String(req.headers['content-type'] ?? '').startsWith('application/json') ? readJson(req, max) : {};
}

export function createPeopleRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (!(a === 'people' || a === 'person-facts')) return NEXT;
    const people = app.people;
    if (!people || !app.memory) throw new HttpError(404, 'People cards are not available here.');
    const mem = app.memory;
    const changed = (what: string) => app.events?.publish({ type: 'people', what });
    const title = (id: string | null) => (id ? (app.store.getConversation(id)?.title ?? null) : null);
    const factView = (f: PersonFact) => ({ ...f, source: f.conversationId && app.store.getConversation(f.conversationId) ? { conversationId: f.conversationId, title: title(f.conversationId), messageId: f.messageId } : null, memoryKind: f.memoryId ? (mem.get(f.memoryId)?.kind ?? null) : null });
    const brief = (p: Person) => {
      const facts = people.facts(p.id);
      return { ...p, factCount: facts.length, sensitiveCount: facts.filter((f) => f.category).length, conversations: people.conversationsMentioning(p.id), preview: facts.filter((f) => !f.category && !f.pending).slice(0, 3).map(factView) };
    };
    // Sensitive facts (health, intimate, money, legal) come as a count until the card's folded group
    // is opened (`?sensitive=1`), like the "She remembered" privacy rule.
    const full = (p: Person, sensitive = false) => ({
      person: p,
      facts: people.facts(p.id, { all: true }).map((f) => (f.category && !sensitive ? { ...factView(f), content: '', evidence: null, folded: true } : factView(f))),
      links: people.links(p.id).map((l) => ({ id: l.person.id, name: l.person.name, relation: l.relation, status: l.person.status })),
      mentions: people.recentMentions(p.id, 6).map((m) => ({ ...m, title: title(m.conversationId) })),
      conversations: people.conversationsMentioning(p.id),
    });
    const person = (raw: string | undefined) => {
      const id = Number(raw);
      const p = Number.isInteger(id) && id > 0 ? people.get(id) : undefined;
      if (!p || p.status === 'merged' || p.status === 'rejected' || p.status === 'forgotten') throw new HttpError(404, 'Person not found');
      return p;
    };

    if (a === 'person-facts') {
      const id = Number(b);
      const f = Number.isInteger(id) && id > 0 ? people.fact(id) : undefined;
      if (!f || c) throw new HttpError(404, 'Fact not found');
      if (method === 'PUT') {
        const body = await readJson(req);
        let category: FactCategory | null | undefined;
        if (body.category !== undefined) {
          if (body.category !== null && !(FACT_CATEGORIES as readonly string[]).includes(String(body.category))) throw new HttpError(400, 'Bad request');
          category = body.category === null ? null : (String(body.category) as FactCategory);
        }
        if (body.content !== undefined) {
          const content = String(body.content ?? '').trim();
          if (content.length < 3 || content.length > 2000) throw new HttpError(400, 'Write 3 to 2000 characters.');
          // Memories are the source of truth: the memory changes, and the fact follows it.
          if (f.memoryId && mem.get(f.memoryId)) mem.update(f.memoryId, content);
          people.updateFact(id, { content });
        }
        people.updateFact(id, { ...(category !== undefined ? { category } : {}), ...(body.private !== undefined ? { private: Boolean(body.private) } : {}) });
        if (body.resolve === true) people.resolvePending(id);
        changed('facts');
        return send(res, 200, factView(people.fact(id)!));
      }
      if (method === 'DELETE') {
        const body = await bodyOf(req);
        const url = new URL(req.url ?? '/', 'http://x');
        const forgetToo = body.memory === true || url.searchParams.get('memory') === '1';
        people.deleteFact(id);
        let forgotten: number[] = [];
        if (forgetToo && f.memoryId && mem.get(f.memoryId)) {
          forgotten = forgetMemory(app, mem, f.memoryId)?.removed ?? [];
          for (const m of forgotten) app.vectors?.forget(m);
          people.purgeIndexes();
        }
        changed('facts');
        return send(res, 200, { ok: true, forgotten: forgotten.length });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // ---- /api/people
    if (!b && method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x');
      const status = url.searchParams.get('status');
      const list = people.list({ q: url.searchParams.get('q') ?? undefined, circle: url.searchParams.get('circle') ?? undefined, status: status === 'proposed' || status === 'active' ? status : 'all' });
      const notes = mem.listAll().filter((m) => (m.kind === 'fact' || m.kind === 'date') && m.supersededBy === null).length;
      return send(res, 200, { people: list.map(brief), counts: people.counts(), backfill: people.backfillStatus(), notes });
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 80) throw new HttpError(400, 'Give a name (up to 80 characters).');
      if (body.birthday && !validBirthday(body.birthday)) throw new HttpError(400, 'Pick a real birthday (month and day).');
      const circle = (CIRCLES as readonly string[]).includes(String(body.circle)) ? (String(body.circle) as Person['circle']) : undefined;
      const p = people.create({ name, relation: String(body.relation ?? ''), ...(circle ? { circle } : {}), birthday: validBirthday(body.birthday) ?? null, notes: String(body.notes ?? ''), status: 'active', origin: 'owner' });
      changed('added');
      return send(res, 201, full(p));
    }
    if (a === 'people' && b === 'backfill' && !c) {
      if (method === 'GET') return send(res, 200, people.backfillStatus());
      if (method === 'POST') {
        const body = await bodyOf(req);
        const st = startBackfill(app, { ...(body.model === false ? { useModel: false } : {}) });
        // Tests (and a tiny memory) finish at once; otherwise the page follows the status.
        if (body.wait === true) {
          const done = await backfillDone(app);
          return send(res, 200, done ?? people.backfillStatus());
        }
        return send(res, 202, st);
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const p = person(b);
    if (!c && method === 'GET') return send(res, 200, full(p, new URL(req.url ?? '/', 'http://x').searchParams.get('sensitive') === '1'));
    if (!c && method === 'PUT') {
      const body = await readJson(req);
      if (body.birthday && !validBirthday(body.birthday)) throw new HttpError(400, 'Pick a real birthday (month and day).');
      try {
        people.update(p.id, {
          ...(body.name !== undefined ? { name: String(body.name) } : {}),
          ...(body.fullName !== undefined ? { fullName: body.fullName === null ? null : String(body.fullName) } : {}),
          ...(Array.isArray(body.aliases) ? { aliases: body.aliases.map(String) } : {}),
          ...(body.relation !== undefined ? { relation: String(body.relation ?? '') } : {}),
          ...(body.circle !== undefined ? { circle: String(body.circle) } : {}),
          ...(body.birthday !== undefined ? { birthday: body.birthday ? String(body.birthday) : null } : {}),
          ...(body.notes !== undefined ? { notes: String(body.notes ?? '') } : {}),
          ...(body.private !== undefined ? { private: Boolean(body.private) } : {}),
        });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      // People linked to this one ("Lea is Jeff's wife"): add and remove.
      if (Array.isArray(body.links)) {
        for (const l of body.links as { id?: unknown; relation?: unknown }[]) {
          const other = Number(l?.id);
          const rel = String(l?.relation ?? '').trim();
          if (Number.isInteger(other) && rel && people.get(other)?.status !== 'merged') people.addLink(p.id, other, rel.slice(0, 80));
        }
      }
      if (Array.isArray(body.unlink)) for (const other of body.unlink) if (Number.isInteger(Number(other))) people.removeLink(p.id, Number(other));
      changed('edited');
      return send(res, 200, full(people.get(p.id)!));
    }
    if (!c && method === 'DELETE') {
      // "Forget this person": the card, its facts, links and mentions; with `memories` also the
      // memories they came from (forgotten the usual way: their messages hidden, vectors dropped).
      const body = await bodyOf(req);
      const withMemories = body.memories === true || new URL(req.url ?? '/', 'http://x').searchParams.get('memories') === '1';
      const r = people.forget(p.id);
      let forgotten = 0;
      if (r && withMemories) {
        const gone = new Set<number>();
        for (const id of r.memoryIds) {
          if (!mem.get(id)) continue;
          for (const x of forgetMemory(app, mem, id)?.removed ?? []) gone.add(x);
        }
        for (const id of gone) app.vectors?.forget(id);
        forgotten = gone.size;
        people.purgeIndexes();
      }
      changed('forgotten');
      return send(res, 200, { ok: true, memories: forgotten });
    }
    if (c === 'accept' && method === 'POST') {
      const done = people.accept(p.id);
      changed('accepted');
      return send(res, 200, full(done ?? p));
    }
    if (c === 'reject' && method === 'POST') {
      people.reject(p.id);
      changed('rejected');
      return send(res, 200, { ok: true });
    }
    if (c === 'merge' && method === 'POST') {
      const body = await readJson(req);
      const into = person(String(body.into ?? ''));
      const r = people.merge(p.id, into.id);
      if (!r) throw new HttpError(400, 'These two cards can\'t be merged.');
      changed('merged');
      return send(res, 200, full(r));
    }
    if (c === 'split' && method === 'POST') {
      const body = await readJson(req);
      const ids = Array.isArray(body.factIds) ? body.factIds.map(Number).filter((n) => Number.isInteger(n)) : [];
      const r = people.split(p.id, ids, typeof body.name === 'string' ? body.name : undefined);
      if (!r) throw new HttpError(400, 'Pick the facts that belong to the other person.');
      changed('split');
      return send(res, 201, full(r));
    }
    if (c === 'photo') {
      if (method === 'GET') {
        const ph = people.photo(p.id);
        if (!ph) throw new HttpError(404, 'No photo');
        res.writeHead(200, { 'content-type': ph.type, 'cache-control': 'private, no-cache', ...SECURITY_HEADERS });
        res.end(ph.data);
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req, PHOTO_MAX * 1.4);
        const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data ?? ''));
        if (!m) throw new HttpError(400, 'Pick a JPEG, PNG or WebP picture.');
        const data = Buffer.from(m[2], 'base64');
        if (!data.length || data.length > PHOTO_MAX) throw new HttpError(413, 'That picture is too large (3 MB at most).');
        const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
        const sig = ext === 'png' ? data[0] === 0x89 && data[1] === 0x50 : ext === 'jpg' ? data[0] === 0xff && data[1] === 0xd8 : data.subarray(8, 12).toString('latin1') === 'WEBP';
        if (!sig) throw new HttpError(400, 'Pick a JPEG, PNG or WebP picture.');
        people.setPhoto(p.id, new Uint8Array(data), ext);
        changed('photo');
        return send(res, 200, full(people.get(p.id)!));
      }
      if (method === 'DELETE') {
        people.setPhoto(p.id, null);
        changed('photo');
        return send(res, 200, full(people.get(p.id)!));
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
