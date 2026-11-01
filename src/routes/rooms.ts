// Phase 110 (CH4, docs/design/CHATS.md §7.13): the Rooms cards' routes. Owner only (the `rooms`
// family is not in household.ts MEMBER_ROUTES, so a member's space answers 403 ownerOnly) and
// never in the demo. Reading a room never starts a turn or a tool; these routes only read and
// change the keep-up rows, run the platform check and the opt-in backfill, and forget a room.
import type { IncomingMessage } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import { ledgerOf } from '../cheap.ts';
import { crisisPending, forgetPlan, forgetRoom, keepRoom, lineCount, listRooms, recentLines, roomMemory, roomName, roomPeople, roomPlan, setRoom, summaryCap, summaryState, type KeepRoom, type RoomModel } from '../bridges/keepup.ts';
import { nowBlock } from '../bridges/now.ts';
import { privateLocalOn } from '../net-guard.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  return String(req.headers['content-type'] ?? '').startsWith('application/json') ? readJson(req) : {};
}

/** The fix steps the card shows when she can't see every message (§7.12). */
export const TELEGRAM_FIX = 'To read every message, turn privacy mode off in @BotFather (/setprivacy → Disable), then remove her from the group and add her again — or make her a group admin.';
export const DISCORD_NOTE = "Reading every message uses Discord's Message Content Intent, which Sara already needs. It's a switch in the Developer Portal for bots in fewer than 100 servers; bigger, verified bots need Discord's approval.";

export function createRoomRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'rooms' && !(a === 'people' && parts[2] === 'rooms')) return NEXT;
    if (opts.demo || opts.member) {
      for await (const _ of req as AsyncIterable<Buffer>) void _;
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    // PUT /api/people/:id/rooms/:roomId {useInOwn, shareRooms} (§7.8): his two switches on a card's room link.
    if (a === 'people') {
      if (method !== 'PUT' || !app.people) throw new HttpError(404, 'Not found');
      const body = await bodyOf(req);
      const pid = Number(b);
      const rid = Number(parts[3]);
      if (!app.people.get(pid) || !app.people.rooms(pid).some((x) => x.roomId === rid)) throw new HttpError(404, 'Not found');
      const link = app.people.setRoomSwitches(pid, rid, { ...(typeof body.useInOwn === 'boolean' ? { useInOwn: body.useInOwn } : {}), ...(typeof body.shareRooms === 'boolean' ? { shareRooms: body.shareRooms } : {}) });
      app.events?.publish({ type: 'people', what: 'rooms' });
      return send(res, 200, { link });
    }
    const view = (r: KeepRoom) => ({
      id: r.id,
      bridge: r.bridge,
      // Phase 115: the room's chat key (its own Look at pictures here / Progress here choices).
      key: r.key,
      name: roomName(r),
      title: r.title,
      parentTitle: r.parentTitle,
      keepUp: r.keepUp,
      keepUpSince: r.keepUpSince,
      pausedReason: r.pausedReason,
      seesAll: r.seesAll,
      checkedAt: r.checkedAt,
      lastActivity: recentLines(app, r.id, 1)[0]?.at ?? r.updatedAt,
      model: r.model,
      summaryEvery: r.summaryEvery,
      summaryMinutes: r.summaryMinutes,
      dailyTokens: r.dailyTokens,
      summariesPerDay: summaryCap(r).runs,
      readLastDay: r.readLastDay,
      adult: r.adult,
      left: r.pausedReason === 'left',
    });
    if (!b && method === 'GET') {
      const bridge = new URL(req.url ?? '/', 'http://x').searchParams.get('bridge');
      return send(res, 200, { rooms: listRooms(app).filter((r) => !bridge || r.bridge === bridge).map(view), privateLocal: privateLocalOn(), notes: { telegram: TELEGRAM_FIX, discord: DISCORD_NOTE } });
    }
    const room = keepRoom(app, Number(b));
    if (!room || room.kind !== 'room') {
      for await (const _ of req as AsyncIterable<Buffer>) void _;
      throw new HttpError(404, 'Room not found');
    }
    const detail = (r: KeepRoom) => {
      const today = (() => {
        try {
          return ledgerOf(app).get(`room:${r.id}`);
        } catch {
          return { runs: 0, tokens: 0 };
        }
      })();
      return { room: view(r), plan: roomPlan(app, r), lines: lineCount(app, r.id), summary: summaryState(app, r.id), today, crisis: crisisPending(app, r.id), forget: forgetPlan(app, r.id), notes: { telegram: TELEGRAM_FIX, discord: DISCORD_NOTE } };
    };
    if (!c && method === 'GET') return send(res, 200, detail(room));
    if (!c && method === 'PUT') {
      const body = await bodyOf(req);
      const wantOn = body.keepUp === true && !room.keepUp;
      // The plan card's answer: nothing runs until he confirms it (§7.12).
      if (wantOn && body.confirmed !== true) throw new HttpError(400, 'Confirm the plan card first.', { errorKey: 'Confirm the plan card first.' });
      const model = body.model === 'local' || body.model === 'quick' || body.model === 'off' ? (body.model as RoomModel) : undefined;
      let check: { seesAll: string; history?: boolean; reason?: string } | undefined;
      if (wantOn) {
        if (privateLocalOn()) throw new HttpError(409, 'Paused in private local mode.', { errorKey: 'Paused in private local mode.' });
        // §7.2: the real platform state, checked before keep-up starts. Telegram without privacy off or admin: refused, with the fix.
        if (room.bridge === 'telegram') {
          const tg = app.bridges?.telegram;
          check = tg ? await tg.checkRoom(Number(room.key)) : { seesAll: 'no:Telegram is not connected' };
          if (check.seesAll.startsWith('no:')) throw new HttpError(409, TELEGRAM_FIX, { errorKey: TELEGRAM_FIX, seesAll: check.seesAll });
        } else if (room.bridge === 'discord') {
          const dc = app.bridges?.discord;
          check = dc ? await dc.checkRoom(room.key) : { seesAll: 'no:Discord is not connected', history: false };
          if (check.seesAll.startsWith('no:')) throw new HttpError(409, 'Discord is not connected.', { errorKey: 'Discord is not connected.' });
        }
      }
      const next = setRoom(app, room.id, {
        ...(typeof body.keepUp === 'boolean' ? { keepUp: body.keepUp } : {}),
        ...(body.summaryEvery !== undefined ? { summaryEvery: Number(body.summaryEvery) } : {}),
        ...(body.summaryMinutes !== undefined ? { summaryMinutes: Number(body.summaryMinutes) } : {}),
        ...(body.dailyTokens !== undefined ? { dailyTokens: Number(body.dailyTokens) } : {}),
        ...(model ? { model } : {}),
        ...(typeof body.readLastDay === 'boolean' ? { readLastDay: body.readLastDay } : {}),
      })!;
      // Discord: the last day at opt-in (default on; skipped with the reason without Read Message History).
      let backfill: { read: number; skipped?: string } | undefined;
      if (wantOn && next.bridge === 'discord' && next.readLastDay) backfill = check?.history === false ? { read: 0, skipped: check.reason ?? 'Read Message History is off for her in this channel' } : await app.bridges!.discord!.backfill(next.key).catch((err: Error) => ({ read: 0, skipped: err.message }));
      if (wantOn && next.bridge === 'telegram') backfill = { read: 0, skipped: "Telegram doesn't let bots read history: the log starts now." };
      return send(res, 200, { ...detail(keepRoom(app, room.id)!), ...(check ? { check } : {}), ...(backfill ? { backfill } : {}) });
    }
    if (c === 'check' && method === 'POST') {
      for await (const _ of req as AsyncIterable<Buffer>) void _;
      const check = room.bridge === 'telegram' ? await app.bridges?.telegram?.checkRoom(Number(room.key)) : room.bridge === 'discord' ? await app.bridges?.discord?.checkRoom(room.key) : undefined;
      return send(res, 200, { ...detail(keepRoom(app, room.id)!), check: check ?? { seesAll: 'no:not connected' } });
    }
    // "What she knows right now": exactly the block she'd get if called now (no turn, no model call).
    if (c === 'now' && method === 'GET') {
      const block = nowBlock(app, room);
      return send(res, 200, { text: room.keepUp ? block.text : '', topic: block.topic, fromSummary: block.fromSummary, stale: block.stale, active: block.active, sinceLines: block.sinceLines, sinceAgo: block.sinceAgo, keepUp: room.keepUp });
    }
    if (c === 'memory' && method === 'GET') {
      const people = roomPeople(app, room.id).map((p) => ({ ...p, card: p.personId && app.people?.get(p.personId) ? { id: p.personId, name: app.people.get(p.personId)!.name, status: app.people.get(p.personId)!.status } : null }));
      return send(res, 200, { weeks: roomMemory(app, room.id), people, archives: (app.library?.archives(room.id) ?? []).map((d) => ({ id: d.id, name: d.name, period: d.period, passages: d.passages, size: d.size })) });
    }
    if (c === 'forget' && method === 'GET') return send(res, 200, { plan: forgetPlan(app, room.id) });
    if (c === 'forget' && method === 'POST') {
      const body = await bodyOf(req);
      const r = forgetRoom(app, room.id, { sessions: body.sessions === true });
      app.events?.publish({ type: 'people', what: 'rooms' });
      return send(res, 200, { forgot: r, ...detail(keepRoom(app, room.id)!) });
    }
    throw new HttpError(404, 'Not found');
  };
}
