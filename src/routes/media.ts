// U4.28 (docs/PICTURES.md "Editing pictures and short video"): the owner's picture editor and short
// video through the local ComfyUI. Owner only (not in MEMBER_ROUTES: members get 403); never the demo.
//   GET  /api/media                     {caps, jobs, prefs}   (?fresh=1 asks ComfyUI again)
//   PUT  /api/media/prefs               {checkpoint?, videoWorkflow?, seconds?} → {prefs}
//   GET  /api/media/workflows           {names}  workflows saved inside ComfyUI (for the video recipe)
//   GET  /api/media/items               {items}  Library pictures and clips, newest first
//   POST /api/media/edit                {libraryId, op, prompt?, strength?, mask? (PNG data URL), pad?, scale?} → {job}
//   POST /api/media/video               {prompt, libraryId?, seconds?} → {job}
//   GET  /api/media/jobs/:id            {job}
//   POST /api/media/jobs/:id/cancel     {job}
//   GET  /api/media/versions/:libraryId {versions}
//   GET  /api/media/file/:libraryId     the picture or clip itself (inline, for the editor and viewer)
import { HttpError, readJson, send } from '../http.ts';
import { en, trOwner } from '../i18n.ts';
import { listComfyWorkflows } from '../image-engines.ts';
import { measure } from '../documents/images.ts';
import { mediaFor } from '../media-studio.ts';
import { SECURITY_HEADERS } from '../http.ts';
import { ToolError } from '../tools/types.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const MAX_MASK = 24 * 1024 * 1024;

export function createMediaRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'media') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = mediaFor(app);
    if (!s) throw new HttpError(403, T('Only the owner of this server can use this.'));
    const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
      try {
        return await f();
      } catch (err) {
        if (err instanceof ToolError) throw new HttpError(400, T(err.message));
        throw err;
      }
    };
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
    if (!b && method === 'GET') return send(res, 200, { caps: await s.caps(q.get('fresh') === '1'), jobs: s.jobs(), prefs: s.prefs() });
    if (b === 'prefs' && !c && method === 'PUT') {
      const body = (await readJson(req)) as Record<string, unknown>;
      return send(res, 200, { prefs: s.setPrefs(body as never) });
    }
    if (b === 'workflows' && !c && method === 'GET') {
      if (!s.ready()) return send(res, 200, { names: [] });
      const names = await wrap(() => listComfyWorkflows({ tools: { get: (n) => app.tools.get(n), permission: (n) => app.tools.permission(n, app.settings.get().toolPermissions) } }, s.server()));
      return send(res, 200, { names });
    }
    if (b === 'items' && !c && method === 'GET') {
      const items = (app.library?.list() ?? [])
        .filter((x) => (x.kind === 'image' || x.kind === 'video') && x.status === 'ready')
        .slice(0, 120)
        .map((x) => ({ id: x.id, name: x.title || x.name, kind: x.kind, addedAt: x.addedAt }));
      return send(res, 200, { items });
    }
    if (b === 'edit' && !c && method === 'POST') {
      const body = (await readJson(req, MAX_MASK * 2)) as Record<string, unknown>;
      const m = typeof body.mask === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body.mask) : null;
      const mask = m ? Buffer.from(m[1], 'base64') : undefined;
      if (mask && (mask.length > MAX_MASK || measure(mask)?.mime !== 'image/png')) throw new HttpError(400, T(en('The mask must be a PNG.')));
      const job = await wrap(() => s.startEdit({ libraryId: num(body.libraryId) ?? 0, op: String(body.op) as never, prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 1000) : undefined, strength: body.strength === undefined ? undefined : Number(body.strength), mask, pad: body.pad && typeof body.pad === 'object' ? (body.pad as never) : undefined, scale: ['2x', '4x', '4k'].includes(String(body.scale)) ? (String(body.scale) as never) : undefined }));
      return send(res, 200, { job });
    }
    if (b === 'video' && !c && method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown>;
      const job = await wrap(() => s.startVideo({ prompt: String(body.prompt ?? ''), libraryId: num(body.libraryId), seconds: Number(body.seconds) || undefined }));
      return send(res, 200, { job });
    }
    if (b === 'jobs' && c && !d && method === 'GET') {
      const job = s.job(c);
      if (!job) throw new HttpError(404, 'Not found');
      return send(res, 200, { job });
    }
    if (b === 'jobs' && c && d === 'cancel' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const job = s.cancel(c);
      if (!job) throw new HttpError(404, 'Not found');
      return send(res, 200, { job });
    }
    if (b === 'versions' && num(c) && method === 'GET') return send(res, 200, { versions: s.versions(num(c)!) });
    if (b === 'file' && num(c) && method === 'GET') {
      const doc = app.library?.get(num(c)!);
      const bytes = doc && (doc.kind === 'image' || doc.kind === 'video') ? app.library!.file(doc) : undefined;
      const pic = bytes ? measure(bytes) : undefined;
      const webp = bytes && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
      const mp4 = bytes && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
      const webm = bytes && bytes.readUInt32BE(0) === 0x1a45dfa3;
      const type = pic?.mime ?? (webp ? 'image/webp' : mp4 ? 'video/mp4' : webm ? 'video/webm' : undefined);
      if (!bytes || !type) throw new HttpError(404, 'Not found');
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': String(bytes.length), 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' });
      res.end(bytes);
      return;
    }
    throw new HttpError(404, 'Not found');
  };
}
