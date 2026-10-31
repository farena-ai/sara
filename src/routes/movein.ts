// Phase 104 (MI1, docs/design/MOVE_IN.md §7): Settings → Data & health → Move in from another agent.
// The owner's only (household.ts never lists "movein" as a member route), never in the demo.
//   GET    /api/movein                          the collector (hash, command), bundles, past move-ins
//   GET    /api/movein/collector                the collector file (download)
//   POST   /api/movein/code                     a six-word code for `sara-movein.py send` (30 minutes)
//   POST   /api/movein/uploads                  {name, size} → an upload (8 MB chunks, resumable)
//   PUT    /api/movein/uploads/:id?offset=N     one chunk
//   GET    /api/movein/uploads/:id              how much arrived
//   POST   /api/movein/uploads/:id/done         check + read the bundle in the background
//   GET    /api/movein/bundles/:id              its state, then the preview
//   POST   /api/movein/bundles/:id/preview      the preview for the owner's choices (held categories…)
//   GET    /api/movein/bundles/:id/section/:s   every item of one section
//   POST   /api/movein/bundles/:id/import       Import = one batch
//   POST   /api/movein/bundles/:id/stop         Stop (the batch is marked partial; Undo still works)
//   DELETE /api/movein/bundles/:id              Delete the bundle now
//   GET    /api/movein/batches/:id              a move-in and its report
//   GET    /api/movein/batches/:id/undo         what Undo removes (and imported notes you edited)
//   POST   /api/movein/batches/:id/undo         Undo this move-in
// Before sign-in, with the move-in code only (the collector's `send`):
//   POST /api/movein/send {code, name, size}; PUT/GET /api/movein/uploads/:id and POST …/done with
//   the header x-movein-code. Nothing else answers to the code.
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import { BundleError } from '../movein/bundle.ts';
import { COLLECTOR_PATH, MoveIn } from '../movein/index.ts';
import type { ImportChoices } from '../movein/batch.ts';
import { CATEGORIES, SECTIONS, type Section } from '../movein/types.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const bad = (err: unknown): never => {
  if (err instanceof HttpError) throw err;
  throw new HttpError(err instanceof BundleError ? 400 : 500, (err as Error).message);
};

function choicesOf(body: Record<string, unknown>): ImportChoices {
  const raw = (body.choices ?? body) as Record<string, unknown>;
  const sections: Partial<Record<Section, boolean>> = {};
  const rs = (raw.sections ?? {}) as Record<string, unknown>;
  for (const s of SECTIONS) if (typeof rs[s] === 'boolean') sections[s] = rs[s] as boolean;
  const sensitive: Record<string, boolean> = {};
  const rv = (raw.sensitive ?? {}) as Record<string, unknown>;
  for (const c of CATEGORIES) if (rv[c] === true) sensitive[c] = true;
  const p = (raw.persona ?? {}) as Record<string, unknown>;
  const age = Number(p.age);
  return {
    herPast: raw.herPast !== false,
    sections,
    sensitive,
    learn: raw.learn !== false,
    learnAll: raw.learnAll === true,
    persona: {
      ...(Number.isInteger(p.use) && Number(p.use) >= 0 ? { use: Number(p.use) } : {}),
      ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim().slice(0, 40) } : {}),
      ...(Number.isInteger(age) && age >= 18 && age <= 120 ? { age } : {}),
    },
  };
}

const offsetOf = (req: IncomingMessage) => Number(new URL(req.url ?? '/', 'http://x').searchParams.get('offset') ?? '0');

function command(origin: string, sha: string): string {
  // sha256sum on Linux, shasum on macOS (a Mac mini running Hermes Agent has no sha256sum).
  return `curl -fsSL ${origin}/movein/sara-movein.py -o sara-movein.py && echo "${sha}  sara-movein.py" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -) && python3 sara-movein.py`;
}

/** The public file: GET /movein/sara-movein.py (plain source; the page shows its hash). */
export function serveCollector(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/x-python; charset=utf-8', 'content-disposition': 'attachment; filename="sara-movein.py"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  createReadStream(COLLECTOR_PATH).on('error', () => res.end()).pipe(res);
}

/** Code-authenticated requests from the collector's `send`, before the sign-in check (NEXT otherwise). */
export function createMoveInPublic(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'movein' || opts.demo || opts.member) return NEXT;
    const header = String(req.headers['x-movein-code'] ?? '');
    if (b === 'send' && !c && method === 'POST') {
      const body = await readJson(req, 4096);
      const code = String(body.code ?? header);
      const mi = (app.moveIn ??= new MoveIn(() => app));
      if (!mi.checkCode(code)) throw new HttpError(401, 'That move-in code is wrong or has expired. Make a new one on the Move in page.');
      try {
        return send(res, 200, mi.startUpload(String(body.name ?? 'bundle.saramove'), Number(body.size), code));
      } catch (err) {
        return bad(err);
      }
    }
    if (b === 'uploads' && c && header) {
      const mi = (app.moveIn ??= new MoveIn(() => app));
      if (!mi.codeFits(c, header)) throw new HttpError(401, 'That move-in code doesn\'t fit this upload.');
      try {
        if (!d && method === 'PUT') return send(res, 200, await mi.putChunk(c, offsetOf(req), req));
        if (!d && method === 'GET') {
          const s = mi.session(c)!;
          return send(res, 200, { received: s.received, size: s.size, state: s.state });
        }
        if (d === 'done' && method === 'POST') {
          const s = mi.finish(c);
          return send(res, 200, { id: s.id, state: s.state });
        }
      } catch (err) {
        return bad(err);
      }
      throw new HttpError(404, 'Not found');
    }
    return NEXT;
  };
}

export function createMoveInRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'movein') return NEXT;
    if (opts.demo) throw new HttpError(403, 'Not in the demo.');
    const mi = (app.moveIn ??= new MoveIn(() => app));
    try {
      if (!b && method === 'GET') {
        const col = mi.collector();
        const host = String(req.headers.host ?? 'localhost');
        const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
        const origin = `${proto}://${host}`;
        return send(res, 200, { collector: col ? { ...col, url: `${origin}/movein/sara-movein.py`, command: command(origin, col.sha256) } : null, bundles: mi.list(), batches: mi.batches().map((x) => ({ ...x, report: undefined, hasReport: Boolean(x.report) })) });
      }
      if (b === 'collector' && !c && method === 'GET') return serveCollector(res);
      if (b === 'code' && !c && method === 'POST') return send(res, 200, mi.mintCode());
      if (b === 'uploads') {
        if (!c && method === 'POST') {
          const body = await readJson(req, 4096);
          return send(res, 200, mi.startUpload(String(body.name ?? ''), Number(body.size)));
        }
        const s = c ? mi.session(c) : undefined;
        if (!s) throw new HttpError(404, 'That upload is gone. Start it again.');
        if (!d && method === 'PUT') return send(res, 200, await mi.putChunk(c!, offsetOf(req), req));
        if (!d && method === 'GET') return send(res, 200, { received: s.received, size: s.size, state: s.state });
        if (d === 'done' && method === 'POST') {
          const x = mi.finish(c!);
          return send(res, 200, { id: x.id, state: x.state, line: x.line });
        }
      }
      if (b === 'bundles' && c) {
        if (!mi.session(c)) throw new HttpError(404, 'That bundle is gone.');
        if (!d && method === 'GET') return send(res, 200, mi.preview(c));
        if (d === 'preview' && method === 'POST') return send(res, 200, mi.preview(c, choicesOf(await readJson(req, 64 * 1024))));
        if (d === 'section' && e && method === 'GET') {
          if (!SECTIONS.includes(e as Section)) throw new HttpError(404, 'Not found');
          return send(res, 200, { items: mi.section(c, e as Section) });
        }
        if (d === 'import' && method === 'POST') {
          const s = await mi.start(c, choicesOf(await readJson(req, 64 * 1024)));
          return send(res, 202, { id: s.id, state: s.state, line: s.line });
        }
        if (d === 'stop' && method === 'POST') {
          mi.stop(c);
          return send(res, 200, { ok: true });
        }
        if (!d && method === 'DELETE') return send(res, 200, { deleted: mi.deleteBundle(c) });
      }
      if (b === 'batches' && c) {
        const x = mi.batch(c);
        if (!x) throw new HttpError(404, 'No such move-in.');
        if (!d && method === 'GET') return send(res, 200, x);
        if (d === 'undo' && method === 'GET') return send(res, 200, mi.undoPreview(c));
        if (d === 'undo' && method === 'POST') {
          const body = await readJson(req, 4096);
          return send(res, 200, { ...mi.undo(c, { keepEdited: body.keepEdited === true }), batch: mi.batch(c) });
        }
      }
    } catch (err) {
      return bad(err);
    }
    throw new HttpError(404, 'Not found');
  };
}
