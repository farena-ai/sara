// V4.1 Photo library search (docs/PHOTO_LIBRARY.md): `/api/moments/folder…`, the owner's photo
// folder on this computer. Owner only (a household member must never index the owner's disk); the
// page never sees file paths inside the folder, only photo ids, and a photo is served only from the
// chosen folder.
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { describeAll, madeAlbums, PhotoError, photoLibraryOf, photoReader } from '../photo-library.ts';
import type { RouteCtx } from './context.ts';

export async function photoFolderRoute(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<void> {
  const { app, opts } = ctx;
  if (opts.demo || app.demo || app.member || opts.member) throw new HttpError(403, 'Only the owner of this server can index a photo folder.', { ownerOnly: true });
  const lib = photoLibraryOf(app);
  const [, , c, d] = parts;
  const status = () => {
    const r = photoReader(app);
    return { ...lib.status(r ? { label: r.label, model: r.model } : null), people: lib.people(), places: lib.namedPlaces() };
  };
  try {
    if (!c) {
      if (method === 'GET') return send(res, 200, status());
      if (method === 'PUT') {
        const body = await readJson(req);
        lib.setFolder(String(body.folder ?? ''));
        return send(res, 200, status());
      }
      if (method === 'DELETE') {
        lib.forget();
        return send(res, 200, status());
      }
    }
    if (c === 'scan' && method === 'POST') {
      const r = await lib.scan();
      describeAll(app);
      return send(res, 200, { ...r, status: status() });
    }
    if (c === 'describe' && method === 'POST') {
      const body = await readJson(req);
      if (body.retry) lib.retryFailed();
      return send(res, 200, { started: describeAll(app), status: status() });
    }
    if (c === 'search' && method === 'GET') {
      const sp = new URL(req.url ?? '/', 'http://x').searchParams;
      const album = sp.get('album');
      if (album) {
        const a = madeAlbums(lib, app.settings.get().timeZone).find((x) => x.id === album);
        return send(res, 200, { items: (a?.ids ?? []).map((id) => lib.get(id)).filter(Boolean) });
      }
      return send(res, 200, { items: lib.search((sp.get('q') ?? '').slice(0, 200), 300) });
    }
    if (c === 'albums' && method === 'GET') return send(res, 200, { albums: madeAlbums(lib, app.settings.get().timeZone) });
    if (c === 'photo' && d && method === 'GET') {
      const f = /^\d+$/.test(d) ? lib.filePath(Number(d)) : undefined;
      if (!f) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'content-type': f.mime, 'cache-control': 'private, max-age=3600', ...SECURITY_HEADERS });
      return void createReadStream(f.path).pipe(res);
    }
    if (c === 'people' && d === 'rename' && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { changed: lib.renamePerson(String(body.from ?? ''), String(body.to ?? '')), people: lib.people() });
    }
    if (c === 'places' && method === 'POST') {
      const body = await readJson(req);
      let lat = Number(body.lat);
      let lon = Number(body.lon);
      // "Name this place" from a photo: its own GPS.
      if (body.photo !== undefined) {
        const row = lib.db.prepare('SELECT lat, lon FROM photos WHERE id = ?').get(Number(body.photo)) as { lat: number | null; lon: number | null } | undefined;
        if (!row || row.lat === null || row.lon === null) throw new HttpError(400, 'That photo has no position saved in it.');
        lat = row.lat;
        lon = row.lon;
      }
      lib.addPlace({ name: String(body.name ?? ''), lat, lon, radiusKm: Number(body.radiusKm ?? 0.5) });
      return send(res, 200, status());
    }
    if (c === 'places' && d && method === 'DELETE') {
      lib.removePlace(decodeURIComponent(d));
      return send(res, 200, status());
    }
    if (c && /^\d+$/.test(c) && d === 'people' && method === 'PUT') {
      const body = await readJson(req);
      const names = Array.isArray(body.people) ? body.people.map(String) : String(body.people ?? '').split(',');
      return send(res, 200, lib.setPeople(Number(c), names));
    }
  } catch (err) {
    if (err instanceof PhotoError) throw new HttpError(400, err.message);
    throw err;
  }
  throw new HttpError(404, 'Not found');
}
