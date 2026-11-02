// Phase 119 (docs/design/RECALL.md §4.12, §5.12): "when it comes up" reminders and picking a chat up
// in another app.
//
//   GET    /api/mentions · PUT /api/mentions               Settings → Memory → When it comes up
//   GET    /api/reminders?kind=mention                     Planner → Reminders → When it comes up (+ Done, 30 days)
//   POST   /api/reminders (body.mention)                   a new one (src/routes/planner.ts hands it here)
//   PATCH  /api/reminders/:id                              change words, person, once / every time, end; {state:'armed'}
//   POST   /api/reminders/check                            the live preview (code only)
//   POST   /api/reminders/fires/:id                        the chip: {answer: done | again | forget}
//   GET    /api/people/:id/reminders                       the person's card: "When Dan comes up"
//   GET    /api/pickup?conversationId=                     the offer banner (owner only)
//   GET    /api/pickup/settings · PUT                      Settings → Chats → Carry our last conversation between apps
//   POST   /api/pickup/:id/decline                         Not now / No
//   GET|POST|DELETE /api/conversations/:id/pickup         Show · Continue here · Undo
//
// Members reach only their own planner (their own app); part B is the owner's (401 for members).
// None of this is offered to /v1, MCP, A2A or plugins.
import { HttpError, readJson, send } from '../http.ts';
import { answerFire, cardOf, keysFor, MENTION_CHOICES, mentionOf, mentionSettings, mergeMentionSettings, remindersAbout, setMention, stemsOf, tooCommon, type MentionData } from '../mentions.ts';
import { mergePickupSettings, PICKUP_CHOICES, pickupSettings, pickupsFor, placeName } from '../pickup.ts';
import type { Reminder } from '../planner.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const DONE_DAYS = 30;

export function createRecallRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const view = (r: Reminder) => {
    const c = cardOf(app, r);
    const fires = app.planner?.fires(r.id) ?? [];
    return { ...c, status: r.status, ended: r.ended, fired: r.fired, createdAt: r.createdAt, lastCameUp: fires.at(-1)?.at ?? null, conversationId: r.conversationId };
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    const pickupPath = a === 'pickup' || (a === 'conversations' && b && c === 'pickup');
    const mine = a === 'mentions' || (a === 'reminders' && (method === 'GET' || method === 'PATCH' || b === 'check' || b === 'fires')) || (a === 'people' && b && c === 'reminders');
    if (!pickupPath && !mine) return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }

    // ---------------------------------------------------------------- part A (everyone, own planner)
    if (mine) {
      const pl = app.planner;
      if (!pl) throw new HttpError(404, 'Planner is not available');
      if (a === 'mentions' && !b) {
        if (method === 'PUT') mergeMentionSettings(app, await readJson(req));
        else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
        return send(res, 200, { settings: mentionSettings(app), choices: MENTION_CHOICES });
      }
      if (a === 'people' && method === 'GET') return send(res, 200, { reminders: remindersAbout(app, Number(b)).map(view) });
      if (a === 'reminders' && !b && method === 'GET') {
        const cutoff = app.now().getTime() - DONE_DAYS * 86_400_000;
        const all = pl.mentionReminders({ status: 'all' });
        return send(res, 200, { reminders: all.filter((r) => r.status === 'pending').map(view), done: all.filter((r) => r.status !== 'pending' && Date.parse(r.sentAt ?? r.createdAt) > cutoff).reverse().map(view), settings: mentionSettings(app) });
      }
      if (a === 'reminders' && b === 'check' && method === 'POST') {
        const body = await readJson(req);
        const k = keysFor(app, { ...(body.topic ? { topic: String(body.topic) } : {}), ...(body.personId !== undefined && body.personId !== null && body.personId !== '' ? { personId: Number(body.personId) } : {}), also: Array.isArray(body.also) ? body.also.map(String) : [] });
        if ('reason' in k) return send(res, 200, { ok: false, reason: k.reason, message: k.message, ...(k.labels ? { labels: k.labels } : {}) });
        const common = tooCommon(app, k);
        // "Would have come up n times in the last 30 days" (his own messages; code only).
        const since = new Date(app.now().getTime() - 30 * 86_400_000).toISOString();
        const rows = app.store.db.prepare("SELECT id, content FROM messages WHERE role = 'user' AND created_at >= ? ORDER BY id DESC LIMIT 2000").all(since) as { id: number; content: string }[];
        const words = k.entries.filter((e) => e.every((t) => t.kind !== 'person'));
        const personHits = k.personIds.length ? Number((app.store.db.prepare(`SELECT COUNT(DISTINCT message_id) AS n FROM person_mentions WHERE at >= ? AND person_id IN (${k.personIds.map(() => '?').join(',')})`).get(since, ...k.personIds) as { n: number } | undefined)?.n ?? 0) : 0;
        let n = personHits;
        for (const r of rows) {
          const st = stemsOf(r.content);
          if (words.some((e) => e.every((t) => (t.kind === 'word' ? st.includes(t.stem) : t.kind === 'phrase' ? t.stems.every((x) => st.includes(x)) : false)))) n++;
        }
        const person = k.personIds[0] !== undefined ? app.people?.get(k.personIds[0]) : undefined;
        return send(res, 200, { ok: !common, entries: k.entries, ...(person ? { person: { id: person.id, name: person.name } } : {}), last30: n, ...(common ? { tooCommon: true, message: common.message } : {}) });
      }
      if (a === 'reminders' && b === 'fires' && c && method === 'POST') {
        const body = await readJson(req);
        const answer = String(body.answer ?? '');
        if (!['done', 'again', 'forget'].includes(answer)) throw new HttpError(400, 'answer must be done, again or forget');
        const r = answerFire(app, Number(c), answer as 'done' | 'again' | 'forget');
        if (!r.ok) throw new HttpError(404, 'Not found');
        return send(res, 200, { ok: true, reminder: r.reminder ? view(r.reminder) : null });
      }
      if (a === 'reminders' && b && method === 'PATCH') {
        const id = Number(b);
        const r = pl.reminder(id);
        const d = r ? mentionOf(r) : undefined;
        if (!r || !d) throw new HttpError(404, 'Not found');
        const body = await readJson(req);
        if (body.state === 'armed') pl.rearmMention(id, app.now());
        const wordsChanged = body.topic !== undefined || body.personId !== undefined || body.also !== undefined;
        let mention: string | undefined;
        if (wordsChanged) {
          const k = keysFor(app, { topic: body.topic !== undefined ? String(body.topic) : d.topic, ...(body.personId !== undefined && body.personId !== null && body.personId !== '' ? { personId: Number(body.personId) } : d.personIds[0] !== undefined && body.personId === undefined ? { personId: d.personIds[0] } : {}), also: Array.isArray(body.also) ? body.also.map(String) : d.also });
          if ('reason' in k) throw new HttpError(400, k.message, { reason: k.reason });
          const common = tooCommon(app, k);
          if (common) throw new HttpError(400, common.message, { reason: common.reason });
          mention = JSON.stringify({ ...d, ...k } satisfies MentionData);
        }
        const st = mentionSettings(app);
        const days = body.expiresDays === undefined ? undefined : Number(body.expiresDays);
        const expiresAt = days === undefined || !(MENTION_CHOICES.expiresDays as readonly number[]).includes(days) ? undefined : days === 0 && st.expiresDays !== 0 ? undefined : days ? new Date(Date.parse(r.createdAt) + Math.min(days, st.expiresDays || days) * 86_400_000).toISOString() : null;
        const text = body.text === undefined ? undefined : String(body.text).trim();
        if (text !== undefined && (!text || text.length > 500)) throw new HttpError(400, 'Reminder text must be 1-500 characters');
        const next = pl.updateMention(id, { ...(text !== undefined ? { text } : {}), ...(mention ? { mention } : {}), ...(body.each !== undefined ? { each: body.each === true } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) });
        app.events?.publish({ type: 'planner', what: 'reminders' });
        return send(res, 200, view(next!));
      }
      throw new HttpError(404, 'Not found');
    }

    // ---------------------------------------------------------------- part B (the owner's own chats)
    if (ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(401, 'Only the owner of this server can use this.');
    }
    const pk = pickupsFor(app);
    if (!pk) throw new HttpError(404, 'Not found');
    if (a === 'pickup' && b === 'settings') {
      if (method === 'PUT') mergePickupSettings(app, await readJson(req));
      else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const linked = [...new Set(app.store.listConversations().filter((x) => !x.partner && /^(telegram|discord|plugin-[\w-]+)$/.test(x.channel)).map((x) => x.channel))].map((x) => ({ app: x, place: placeName(x) }));
      return send(res, 200, { settings: pickupSettings(app), choices: PICKUP_CHOICES, apps: linked });
    }
    if (a === 'pickup' && !b && method === 'GET') {
      const id = new URL(req.url ?? '/', 'http://x').searchParams.get('conversationId') ?? '';
      if (!id || ctx.ctxOf(id) !== app) return send(res, 200, {});
      const o = pk.active(id) ? undefined : pk.offer(id);
      return send(res, 200, o ? { id: o.id, from: o.from, place: o.place, title: o.title, ago: o.ago, agoMin: o.agoMin, preview: o.preview } : {});
    }
    if (a === 'pickup' && b && c === 'decline' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const p = pk.decline(b);
      if (!p) throw new HttpError(404, 'Not found');
      return send(res, 200, { ok: true });
    }
    if (a === 'conversations' && b) {
      if (ctx.ctxOf(b) !== app || !app.store.getConversation(b)) {
        if (method !== 'GET') await readJson(req).catch(() => undefined);
        throw new HttpError(404, 'Not found');
      }
      if (method === 'GET') {
        const p = pk.live(b);
        return send(res, 200, p ? { pickup: pk.view(p), note: pk.note(b, { owner: app.settings.get().ownerName?.trim() || 'the owner', count: false }) ?? '' } : { pickup: null });
      }
      if (method === 'DELETE') {
        const p = pk.undo(b);
        return send(res, 200, { ok: Boolean(p) });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const offerId = body.offerId ? String(body.offerId) : undefined;
        const sourceId = body.sourceId ? String(body.sourceId) : offerId ? pk.get(offerId)?.sourceId : pk.candidates(b)[0]?.sourceId;
        if (!sourceId) throw new HttpError(404, "There's nothing recent in your other chats to pick up.");
        const r = pk.make(b, sourceId, offerId ? 'offer' : 'command', offerId);
        if ('error' in r) throw new HttpError(400, r.error);
        return send(res, 201, { pickup: pk.view(r.pickup), notice: r.notice });
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
