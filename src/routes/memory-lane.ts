// W4.2 Memory lane routes, inside Your story's family (`/api/story/lane...`, src/routes/planner.ts),
// so members get their own (each space's own sealed book) with no new route group.
//   GET    /api/story/lane                    → {stories, years, trips, model, voice, running, error}
//   POST   /api/story/lane {kind:'year', year} | {kind:'trip', key} → 202 {running}
//   GET    /api/story/lane/:id                → story
//   PATCH  /api/story/lane/:id {drop: n, title?} (drop picked photo n, 1-based)
//   DELETE /api/story/lane/:id
//   GET    /api/story/lane/:id/photo/:n       → the picked photo
//   POST   /api/story/lane/:id/audio          → narrate with the voice on this computer
//   GET    /api/story/lane/:id/audio          → audio/wav
//   GET    /api/story/lane/:id/pdf            → application/pdf (download)
// Share links: POST /api/shares {lane: id} (src/routes/share.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../chat.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { LaneError, laneOf, laneOptions, lanePdf, lanePhotoBytes, laneState, makeLaneAudio, requestLane, type LaneRequest } from '../memory-lane.ts';
import { VoiceError } from '../voice.ts';

const wrap = (err: unknown): never => {
  if (err instanceof LaneError) throw new HttpError(err.status, err.message);
  if (err instanceof VoiceError) throw new HttpError(409, err.message, { noVoice: true });
  throw err;
};

export async function memoryLaneRoute(app: AppContext, req: IncomingMessage, res: ServerResponse, method: string, c: string | undefined, d: string | undefined, e: string | undefined): Promise<void> {
  const book = laneOf(app);
  if (!c && method === 'GET') return send(res, 200, { stories: book.list(), ...laneOptions(app), ...laneState(app) });
  if (!c && method === 'POST') {
    const body = await readJson(req);
    const r: LaneRequest = body.kind === 'trip' ? { kind: 'trip', key: String(body.key ?? '') } : { kind: 'year', year: Number(body.year) };
    try {
      void requestLane(app, r).catch((err: Error) => console.warn(`memory lane: ${err.message}`));
    } catch (err) {
      wrap(err);
    }
    return send(res, 202, { running: true });
  }
  const id = Number(c);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  const story = book.get(id);
  if (!story) throw new HttpError(404, 'Story not found');
  if (!d) {
    if (method === 'GET') return send(res, 200, story);
    if (method === 'DELETE') {
      book.remove(id);
      return send(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      let photos = story.photos;
      if (body.drop !== undefined) {
        const n = Number(body.drop);
        if (!Number.isInteger(n) || n < 1 || n > photos.length) throw new HttpError(400, 'Pick a photo of this story.');
        photos = photos.filter((_, i) => i !== n - 1);
      }
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : story.title;
      return send(res, 200, book.update(id, { photos, title }));
    }
  }
  if (d === 'photo' && e && method === 'GET') {
    const p = story.photos[Number(e) - 1];
    const b = p && lanePhotoBytes(app, p);
    if (!b) throw new HttpError(404, 'Photo not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': b.mime, 'content-length': b.data.length, 'cache-control': 'private, max-age=300' });
    return void res.end(b.data);
  }
  if (d === 'audio' && method === 'POST') {
    try {
      return send(res, 200, await makeLaneAudio(app, id));
    } catch (err) {
      wrap(err);
    }
  }
  if (d === 'audio' && method === 'GET') {
    const a = book.audio(id);
    if (!a) throw new HttpError(404, 'No narration yet');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'audio/wav', 'content-length': a.length, 'cache-control': 'private, no-store' });
    return void res.end(a);
  }
  if (d === 'pdf' && method === 'GET') {
    let pdf: Buffer;
    try {
      pdf = lanePdf(app, id);
    } catch (err) {
      return wrap(err);
    }
    const name = story.title.replace(/[^\p{L}\p{N} ,.-]+/gu, '').trim() || 'Story';
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/pdf', 'content-length': pdf.length, 'content-disposition': `attachment; filename="story.pdf"; filename*=UTF-8''${encodeURIComponent(name)}.pdf`, 'cache-control': 'private, no-store' });
    return void res.end(pdf);
  }
  throw new HttpError(404, 'Not found');
}
