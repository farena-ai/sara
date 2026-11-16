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
//   GET    /api/meetings/:id/recording           the kept recording (?play=1: inline, with Range for seeking)
// S2 (docs/MEETINGS.md):
//   PUT    /api/meetings/prefs                   {remind, cloud} → {prefs}
//   POST   /api/meetings/upload                  {title, consent, keepAudio, name, parts, channels, startedAt, seconds} → {meeting}
//   POST   /api/meetings/:id/part?i=n            raw WAV (one part) → {received}
//   POST   /api/meetings/:id/speakers            {from, to} → {meeting} (rename a speaker)
//   POST   /api/meetings/:id/drafts/:i           {action: send|save|dismiss, to?, subject?, body?} → {draft, meeting}
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
        return send(res, 200, { meetings: m.list(), ready: !why, why, prefs: m.prefs(), limits: { fileMb: MEETINGS.maxFileBytes / 1024 / 1024, wholeMb: MEETINGS.wholeMaxBytes / 1024 / 1024, hours: MEETINGS.maxSec / 3600, replies: MEETINGS.maxReplies } });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { meeting: await wrap(() => m.start(body)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'prefs' && !c && method === 'PUT') {
      const body = await readJson(req);
      const cur = m.prefs();
      const next = { remind: typeof body.remind === 'boolean' ? body.remind : cur.remind, cloud: typeof body.cloud === 'boolean' ? body.cloud : cur.cloud };
      const s = app.settings.get() as { meetings?: object };
      app.settings.update({ meetings: { ...s.meetings, ...next } } as never);
      audit({ action: 'meeting.prefs', role: 'owner', channel: 'web', keys: Object.keys(next).filter((k) => next[k as keyof typeof next] !== cur[k as keyof typeof cur]) });
      return send(res, 200, { prefs: m.prefs() });
    }
    if (b === 'upload' && !c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { meeting: await wrap(() => m.upload(body)) });
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
    if (c === 'part' && method === 'POST') {
      const bytes = await readRaw(req, MEETINGS.partBytes);
      return send(res, 200, await wrap(() => m.part(id, Number(q.get('i')), bytes)));
    }
    if (c === 'recording' && method === 'GET') {
      const rec = m.recording(id);
      if (!rec) throw new HttpError(404, 'Not found');
      const play = q.get('play') === '1';
      // S2: played on the Meetings page (seeking asks for byte ranges); a download is audited.
      const range = play ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '')) : null;
      if (!play || !req.headers.range) audit({ action: 'meeting.recording', role: 'owner', channel: 'web', target: String(id), ...(play ? { keys: ['play'] } : {}) });
      const size = rec.bytes.length;
      const head = { 'content-type': rec.type, 'accept-ranges': 'bytes', 'content-disposition': play ? 'inline' : `attachment; filename="meeting-${id}.${rec.ext}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS };
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${size}`, ...SECURITY_HEADERS });
          res.end();
          return;
        }
        res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        res.end(rec.bytes.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { ...head, 'content-length': size });
      res.end(rec.bytes);
      return;
    }
    if (c === 'drafts' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const draft = await wrap(() => m.draft(id, Number(parts[3]), body));
      return send(res, 200, { draft, meeting: m.get(id) });
    }
    if (c === 'speakers' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      return send(res, 200, { meeting: await wrap(() => m.rename(id, body.from, body.to)) });
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
