// EC19 (docs/ops/EC19_DESIGN.md): meeting rooms and meeting notes, the owner's only (his signed-in
// browsers and app devices). Household members, the demo and anyone else get 403. The meetings
// module writes the audit rows (start, join, file, end, notes, to-dos, delete); this file adds the
// recording download.
//   GET    /api/meetings                         {meetings, ready, why, limits}
//   POST   /api/meetings                         {title, consent, keepAudio} → {meeting} (a room)
//   POST   /api/meetings/file?title&consent=1&keep=1&name   raw audio → {meeting}
//   GET    /api/meetings/:id?since=n             {meeting} (lines after n)
//   DELETE /api/meetings/:id                     forget it (the Library notes stay)
//   POST   /api/meetings/:id/join                {device} → {meeting}
//   POST   /api/meetings/:id/audio?speaker       raw WAV → {line, reply}
//   POST   /api/meetings/:id/end                 → {meeting} (notes are written)
//   POST   /api/meetings/:id/notes               write the notes again → {meeting}
//   POST   /api/meetings/:id/todos               {items: [index]} → {added}
//   GET    /api/meetings/:id/recording           the kept recording
import { audit } from '../audit-trail.ts';
import { HttpError, readJson, readRaw, SECURITY_HEADERS, send } from '../http.ts';
import { LegalHoldError } from '../legal-hold.ts';
import { MEETINGS, MeetingError } from '../meetings.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMeetingRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof MeetingError || err instanceof LegalHoldError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'meetings') return NEXT;
    const drain = async () => {
      if (method !== 'GET') await readRaw(req, MEETINGS.maxFileBytes).catch(() => undefined);
    };
    if (ctx.opts.demo || ctx.opts.member || !app.meetings) {
      await drain();
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const m = app.meetings;
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (!b) {
      if (method === 'GET') {
        const why = m.refusal();
        return send(res, 200, { meetings: m.list(), ready: !why, why, limits: { fileMb: MEETINGS.maxFileBytes / 1024 / 1024, wholeMb: MEETINGS.wholeMaxBytes / 1024 / 1024, hours: MEETINGS.maxSec / 3600, replies: MEETINGS.maxReplies } });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { meeting: await wrap(() => m.start(body)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'file' && !c && method === 'POST') {
      const bytes = await readRaw(req, MEETINGS.maxFileBytes);
      const meeting = await wrap(() => m.fromFile({ title: q.get('title'), consent: q.get('consent') === '1', keepAudio: q.get('keep') === '1', name: q.get('name'), bytes }));
      return send(res, 200, { meeting });
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || !m.get(id)) {
      await drain();
      throw new HttpError(404, 'Not found');
    }
    if (!c) {
      if (method === 'GET') return send(res, 200, { meeting: m.get(id, Math.max(0, Number(q.get('since')) || 0)) });
      if (method === 'DELETE') return send(res, 200, { ok: await wrap(() => m.delete(id)) });
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'audio' && method === 'POST') {
      const audio = await readRaw(req, MEETINGS.maxAudioBytes);
      return send(res, 200, await wrap(() => m.hear(id, { speaker: q.get('speaker'), audio })));
    }
    if (c === 'recording' && method === 'GET') {
      const rec = m.recording(id);
      if (!rec) throw new HttpError(404, 'Not found');
      audit({ action: 'meeting.recording', role: 'owner', channel: 'web', target: String(id) });
      res.writeHead(200, { 'content-type': rec.type, 'content-length': rec.bytes.length, 'content-disposition': `attachment; filename="meeting-${id}.${rec.ext}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(rec.bytes);
      return;
    }
    if (method === 'POST' && (c === 'join' || c === 'end' || c === 'notes' || c === 'todos')) {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (c === 'join') return send(res, 200, { meeting: await wrap(() => m.join(id, body)) });
      if (c === 'end') return send(res, 200, { meeting: await wrap(() => m.end(id)) });
      if (c === 'notes') return send(res, 200, { meeting: await wrap(() => m.writeNotes(id)) });
      return send(res, 200, { added: await wrap(() => m.addTodos(id, body.items)), meeting: m.get(id) });
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
