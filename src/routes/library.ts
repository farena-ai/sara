// Document library, chat-history imports and data export/import.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { CompanionImporter, type ConfirmInput } from '../companion-import/session.ts';
import { MAX_FILE_BYTES, MAX_ZIP_BYTES, PICKABLE_SOURCES } from '../companion-import/types.ts';
import { embedTarget } from '../embeddings.ts';
import { exportAll, importAll } from '../export.ts';
import { HistoryImporter, MAX_HISTORY_BYTES, saveUpload } from '../history-import/index.ts';
import { isHistorySource, SOURCE_NAME } from '../history-import/types.ts';
import { as400, HttpError, MAX_IMPORT, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { en } from '../i18n.ts';
import { answerOcr, cancelJob, isPdfDoc, jobView, pauseJob, resumeJob } from '../library/bigread.ts';
import { detectKind, SUPPORTED } from '../library/read.ts';
import { cleanLibraryLimits, type LibraryDoc, libraryLimits, MAX_DOC_BYTES, sha256File } from '../library/store.ts';
import { bodyToFile, CHUNK_BYTES, diskHasRoom, LibraryUploadError as LibUploadError, LibraryUploads } from '../library/uploads.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createLibraryRoutes(ctx: RouteCtx): RouteHandler {
  const { active, app, me, offStore, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a === 'export' && !b && method === 'GET') {
      // Phase 78: `?runs=1` adds the run history (left out by default; backups always have it).
      const withRuns = new URL(req.url ?? '/', 'http://x').searchParams.get('runs') === '1';
      const body = JSON.stringify(exportAll(app, { runs: withRuns }), null, 1);
      const name = `sara-export-${app.now().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end(body);
    }
    if (a === 'import' && !b && method === 'POST') {
      if (active.size) throw new HttpError(409, me('Wait until Sara finishes what she is doing, then import.'), { errorKey: 'Wait until Sara finishes what she is doing, then import.' });
      const body = await readJson(req, MAX_IMPORT);
      try {
        return send(res, 200, importAll(app, body));
      } catch (err) {
        throw as400(err);
      }
    }
    // Phase 51: bring your history (a ChatGPT or Claude export): preview, import, learn, undo.
    if (a === 'history-import') {
      const hi = (app.historyImport ??= new HistoryImporter(() => app));
      if (!b && method === 'GET') return send(res, 200, hi.status());
      if (b === 'preview' && method === 'POST') {
        if (Number(req.headers['content-length'] ?? 0) > MAX_HISTORY_BYTES) throw new HttpError(413, 'That file is bigger than 500 MB.');
        // Security review (L3): one upload at a time; the export is read once and kept for run.
        let path: string;
        try {
          path = hi.uploadPath();
        } catch (err) {
          res.setHeader('connection', 'close');
          res.once('finish', () => req.socket.destroy());
          throw new HttpError(409, (err as Error).message);
        }
        try {
          try {
            const size = await saveUpload(req, path, MAX_HISTORY_BYTES);
            if (!size) throw new HttpError(400, 'That file is empty.');
          } catch (err) {
            if ((err as { code?: string }).code === 'TOO_BIG') throw new HttpError(413, 'That file is bigger than 500 MB.');
            throw err;
          }
          try {
            return send(res, 200, hi.preview(path));
          } catch (err) {
            throw as400(err);
          }
        } finally {
          hi.uploadDone(path);
        }
      }
      if (b === 'run' && method === 'POST') {
        const body = await readJson(req);
        const o = (body.options ?? {}) as Record<string, unknown>;
        try {
          return send(res, 200, await hi.run(String(body.id ?? ''), { learn: o.learn !== false, oldestFirst: o.oldestFirst !== false }));
        } catch (err) {
          throw as400(err);
        }
      }
      if (b === 'pause' && method === 'POST') return send(res, 200, hi.pause());
      if (b === 'resume' && method === 'POST') return send(res, 200, hi.resume());
      if (b === 'cancel' && method === 'POST') return send(res, 200, hi.cancel());
      if (b === 'learn' && method === 'POST') {
        try {
          return send(res, 200, hi.learnRest());
        } catch (err) {
          throw as400(err);
        }
      }
      if (!b && method === 'DELETE') {
        const src = new URL(req.url ?? '/', 'http://x').searchParams.get('source');
        const r = hi.remove(isHistorySource(src) ? src : undefined);
        app.uploads?.prune(app.store.imagesInUse());
        return send(res, 200, { ...r, status: hi.status() });
      }
      throw new HttpError(404, 'Not found');
    }
    // Phase 65: bring her from another app: read a chat file, preview, estimate, read it with the
    // background model, review, confirm. Owner only; never in the demo. Nothing is saved before confirm.
    if (a === 'import') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const ci = (app.companionImport ??= new CompanionImporter(() => app));
      const fail = (err: unknown): never => {
        if (err instanceof HttpError) throw err;
        throw as400(err);
      };
      if (!b && method === 'GET') return send(res, 200, { sources: PICKABLE_SOURCES.map((id) => ({ id, name: SOURCE_NAME[id] })), maxZipBytes: MAX_ZIP_BYTES, maxFileBytes: MAX_FILE_BYTES });
      if (b === 'preview' && method === 'POST') {
        const name = String(new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'chat.txt').slice(0, 200);
        const max = CompanionImporter.maxBytes(name);
        const tooBig = max === MAX_ZIP_BYTES ? en('That file is bigger than 200 MB.') : en('That file is bigger than 50 MB. If it came in a zip, upload the zip (up to 200 MB).');
        if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, tooBig);
        let path: string;
        try {
          path = ci.uploadPath();
        } catch (err) {
          res.setHeader('connection', 'close');
          res.once('finish', () => req.socket.destroy());
          throw new HttpError(409, (err as Error).message);
        }
        try {
          try {
            if (!(await saveUpload(req, path, max))) throw new HttpError(400, 'That file is empty.');
          } catch (err) {
            if ((err as { code?: string }).code === 'TOO_BIG') throw new HttpError(413, tooBig);
            throw err;
          }
          try {
            return send(res, 200, ci.preview(path, name));
          } catch (err) {
            return fail(err);
          }
        } finally {
          ci.uploadDone(path);
        }
      }
      if (b && b !== 'preview') {
        try {
          if (!c && method === 'GET') return send(res, 200, ci.status(b));
          if (!c && method === 'DELETE') {
            ci.discard(b);
            return send(res, 200, { ok: true });
          }
          if (method === 'POST' && (c === 'estimate' || c === 'start' || c === 'cancel' || c === 'confirm')) {
            const body = await readJson(req);
            const choice = { conversations: body.conversations, roles: body.roles, source: body.source, localOnly: body.localOnly !== false };
            if (c === 'estimate') return send(res, 200, ci.estimate(b, choice));
            if (c === 'start') return send(res, 200, ci.start(b, { ...choice, useModel: body.useModel !== false }));
            if (c === 'cancel') return send(res, 200, ci.cancel(b));
            return send(res, 200, ci.confirm(b, body as ConfirmInput));
          }
        } catch (err) {
          return fail(err);
        }
      }
      throw new HttpError(404, 'Not found');
    }
    // Phase 44: her library (documents she keeps, or reads once for one conversation).
    if (a === 'library') {
      const lib = app.library;
      if (!lib) throw new HttpError(404, 'The library is not available');
      // E5: `revision` (the first 12 of the sha) lets Read together say which version it shares.
      const docView = (d: LibraryDoc) => ({ ...d, sha: undefined, revision: d.sha.slice(0, 12), facts: d.facts, job: jobView(app, lib, d) });
      // Phase 74: the largest document here (a household member's limit is the owner's member limit).
      const lim = libraryLimits(app.settings.get());
      const maxBytes = (opts.member ? Math.min(lim.maxMb, lim.memberMaxMb) : lim.maxMb) * 1024 * 1024;
      const uploads = new LibraryUploads(lib.dir);
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const d = parts[3];
      const checkConversation = (conversationId: string | null) => {
        if (!conversationId) return;
        if (offStore.getConversation(conversationId)) throw new HttpError(400, "Off-the-record chats don't save files, so documents can't be shared here.");
        const conv = app.store.getConversation(conversationId);
        if (!conv || conv.partner) throw new HttpError(404, 'Conversation not found');
      };
      /** A file that arrived on disk: checked, then moved into her library (never read whole unless small). */
      const takeFile = async (path: string, m: { name: string; keep: boolean; conversationId: string | null; learn: boolean }) => {
        try {
          const size = statSync(path).size;
          if (!size) throw new HttpError(400, 'That file is empty.');
          const fd = openSync(path, 'r');
          const head = Buffer.alloc(Math.min(size, 4096));
          try {
            readSync(fd, head, 0, head.length, 0);
          } finally {
            closeSync(fd);
          }
          const isPdf = head.subarray(0, 1024).toString('latin1').includes('%PDF-');
          if (!isPdf && size > MAX_DOC_BYTES) throw new HttpError(413, 'Files over {mb} MB need to be PDFs (other kinds are read whole, in memory). Save it as a PDF and add it again.', { params: { mb: MAX_DOC_BYTES / 1048576 } });
          if (!isPdf && !detectKind(m.name, readFileSync(path))) throw new HttpError(415, 'She can\'t read that kind of file. She reads {kinds}.', { params: { kinds: SUPPORTED.map((k) => k.label).join(', ') } });
          const sha = await sha256File(path);
          if (m.keep) {
            const had = lib.findKeptSha(sha);
            if (had) {
              rmSync(path, { force: true });
              return { status: 200, body: { doc: docView(had), already: true } };
            }
          }
          const doc = lib.addFile({ name: m.name, path, sha, keep: m.keep, conversationId: m.keep ? null : m.conversationId, origin: m.keep && !m.conversationId ? 'library' : 'chat', learn: m.learn });
          app.libraryNudge?.();
          app.events?.publish({ type: 'library', id: doc.id });
          return { status: 201, body: { doc: docView(doc) } };
        } finally {
          if (existsSync(path)) rmSync(path, { force: true });
        }
      };
      const uploadError = (err: unknown): never => {
        if (err instanceof LibUploadError) throw new HttpError(err.status, err.message, err.extra);
        throw err;
      };
      // Phase 110 (CH4, §7.9): the Archives (rooms → weeks), its search and one collection's documents.
      // The owner's only: members' spaces have no rooms, and the demo none.
      const archivesAllowed = () => {
        if (opts.demo || opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      };
      if (b === 'archives' && !c && method === 'GET') {
        archivesAllowed();
        const text = q.get('q')?.trim() ?? '';
        const roomId = q.get('room') ? Number(q.get('room')) : undefined;
        if (text) {
          const hits = await lib.find(text, { limit: 12, timeoutMs: 4000, in: 'archives', ...(roomId !== undefined && Number.isInteger(roomId) ? { roomId } : {}) });
          return send(res, 200, { hits: hits.map((h) => ({ docId: h.doc.id, name: h.doc.name, collection: h.doc.collection, period: h.doc.period, place: h.passage.place, heading: h.passage.heading, text: h.passage.text, ord: h.passage.ord })) });
        }
        const docs = lib.archives(roomId !== undefined && Number.isInteger(roomId) ? roomId : undefined);
        const rooms = new Map<string, { collection: string; roomId: number | null; weeks: ReturnType<typeof docView>[] }>();
        for (const d of docs) {
          const k = d.collection ?? d.name;
          if (!rooms.has(k)) rooms.set(k, { collection: k, roomId: d.roomId, weeks: [] });
          rooms.get(k)!.weeks.push(docView(d));
        }
        return send(res, 200, { rooms: [...rooms.values()], counts: lib.archiveCounts() });
      }
      if (b === 'archives' && c === 'rename' && method === 'POST') {
        archivesAllowed();
        const body = await readJson(req);
        const from = String(body.from ?? '');
        const to = String(body.to ?? '').trim();
        if (!from || !to) throw new HttpError(400, 'Bad request');
        return send(res, 200, { renamed: lib.renameCollection(from, to) });
      }
      if (!b && method === 'GET' && q.get('collection')) {
        archivesAllowed();
        return send(res, 200, { docs: lib.list({ collection: q.get('collection')! }).map(docView) });
      }
      if (!b && method === 'GET') {
        const t = embedTarget(app);
        const counts = lib.counts();
        return send(res, 200, {
          docs: lib.list().map(docView),
          counts,
          meaning: t ? { model: t.model, indexed: lib.vectorCount(t.model), total: counts.passages, error: lib.vectorError ?? null } : null,
          shared: app.settings.get().companionLibrary === 'shared',
          maxBytes,
          chunkBytes: CHUNK_BYTES,
          supported: SUPPORTED,
        });
      }
      // Upload in one request: the file's bytes as the body (streamed to disk); name, keep and conversation in the query.
      if (!b && method === 'POST') {
        const name = q.get('name') ?? 'document';
        const keep = q.get('keep') !== '0';
        const conversationId = q.get('conversation') || null;
        checkConversation(conversationId);
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > maxBytes) throw new HttpError(413, 'Documents can be up to {mb} MB here.', { params: { mb: Math.round(maxBytes / 1048576) } });
        if (declared && !diskHasRoom(lib.dir, declared * 2)) throw new HttpError(507, 'There is not enough free disk space on the server for this file.');
        const tmp = uploads.tempPath();
        try {
          await bodyToFile(req, tmp, maxBytes);
        } catch (err) {
          rmSync(tmp, { force: true });
          if (err instanceof LibUploadError && err.status === 413) throw new HttpError(413, 'Documents can be up to {mb} MB here.', { params: { mb: Math.round(maxBytes / 1048576) } });
          uploadError(err);
        }
        const r = await takeFile(tmp, { name, keep, conversationId, learn: q.get('learn') !== '0' });
        return send(res, r.status, r.body);
      }
      // Phase 74: resumable uploads in pieces (big files, proxies with a request-size limit).
      if (b === 'uploads') {
        if (!c && method === 'POST') {
          const body = await readJson(req);
          const conversationId = typeof body.conversation === 'string' && body.conversation ? body.conversation : null;
          checkConversation(conversationId);
          const keep = body.keep !== false && body.keep !== '0';
          try {
            const u = uploads.start({ name: String(body.name ?? 'document').slice(0, 300), size: Number(body.size), keep, conversationId: keep ? null : conversationId, learn: body.learn !== false }, maxBytes);
            return send(res, 201, { id: u.id, received: u.received, size: u.size, chunkBytes: u.chunkBytes });
          } catch (err) {
            return uploadError(err);
          }
        }
        const u = c ? uploads.get(c) : undefined;
        if (!u) {
          if (method === 'PUT') for await (const _ of req as AsyncIterable<Buffer>) void _;
          throw new HttpError(404, 'That upload is not here any more. Add the file again.');
        }
        if (!d && method === 'GET') return send(res, 200, { id: u.id, received: u.received, size: u.size });
        if (!d && method === 'PUT') {
          try {
            const received = await uploads.append(u.id, Number(q.get('offset') ?? -1), req);
            return send(res, 200, { id: u.id, received, size: u.size });
          } catch (err) {
            // Read what's left of the body before answering (the connection stays usable).
            if (!req.readableEnded) for await (const _ of req as AsyncIterable<Buffer>) void _;
            return uploadError(err);
          }
        }
        if (!d && method === 'DELETE') return send(res, 200, { ok: uploads.abort(u.id) });
        if (d === 'done' && method === 'POST') {
          let fin;
          try {
            fin = uploads.finish(u.id);
          } catch (err) {
            return uploadError(err);
          }
          const r = await takeFile(fin.path, fin.meta);
          return send(res, r.status, r.body);
        }
        throw new HttpError(404, 'Not found');
      }
      if (b === 'search' && method === 'GET') {
        const text = q.get('q')?.trim() ?? '';
        if (!text) return send(res, 200, { hits: [] });
        const where = q.get('in') === 'archives' || q.get('in') === 'all' ? (q.get('in') as 'archives' | 'all') : 'library';
        if (where !== 'library') archivesAllowed();
        const roomQ = q.get('room') ? Number(q.get('room')) : undefined;
        const hits = await lib.find(text, { target: embedTarget(app), limit: 10, timeoutMs: 4000, in: where, ...(roomQ !== undefined && Number.isInteger(roomQ) ? { roomId: roomQ } : {}) });
        return send(res, 200, { hits: hits.map((h) => ({ docId: h.doc.id, name: h.doc.name, collection: h.doc.collection, place: h.passage.place, page: h.passage.page, heading: h.passage.heading, text: h.passage.text, ord: h.passage.ord, by: h.by })) });
      }
      if (b === 'settings' && !c) {
        const view = () => ({ shared: app.settings.get().companionLibrary === 'shared', ...libraryLimits(app.settings.get()), owner: !opts.member, maxBytes });
        if (method === 'GET') return send(res, 200, view());
        if (method === 'PUT') {
          const body = await readJson(req);
          const limitKeys = ['maxMb', 'memberMaxMb', 'ocr', 'speed'].filter((k) => body[k] !== undefined);
          if (limitKeys.length) {
            // The size limits and background reading are the owner's (members follow them).
            if (opts.member || opts.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
            try {
              app.settings.update({ libraryLimits: cleanLibraryLimits(body, libraryLimits(app.settings.get())) });
            } catch (err) {
              throw as400(err);
            }
          }
          if (body.shared !== undefined) app.settings.update({ companionLibrary: body.shared ? 'shared' : 'separate' });
          return send(res, 200, { ...view(), restart: body.shared !== undefined && (app.companions?.all().length ?? 1) > 1 });
        }
      }
      const id = Number(b);
      const doc = Number.isInteger(id) ? lib.get(id) : undefined;
      if (b && !doc) throw new HttpError(404, 'Not found');
      if (doc) {
        if (!c && method === 'GET') {
          const facts = app.memory?.fromDoc(doc.id).filter((m) => m.supersededBy === null) ?? [];
          return send(res, 200, { doc: docView(doc), facts: facts.map((m) => ({ id: m.id, content: m.content, evidence: m.evidence })), sections: lib.sections(doc.id), passages: lib.passages(doc.id, { limit: 40 }) });
        }
        if (c === 'passages' && method === 'GET') {
          if (q.get('page')) return send(res, 200, { passages: lib.passagesAt(doc.id, Math.max(1, Number(q.get('page')) || 1), Math.min(200, Number(q.get('limit') ?? 40) || 40)) });
          return send(res, 200, { passages: lib.passages(doc.id, { from: Number(q.get('from') ?? 0) || 0, limit: Math.min(200, Number(q.get('limit') ?? 40) || 40) }) });
        }
        if (c === 'file' && method === 'GET') {
          // Streamed from disk (a 1 GB book isn't read into memory). ?inline=1 opens a PDF in the
          // browser's own viewer (the citations link to #page=N); byte ranges let it load pages as needed.
          const path = lib.filePath(doc);
          if (!path) throw new HttpError(404, 'The original file is missing');
          const size = statSync(path).size;
          const inline = q.get('inline') === '1' && isPdfDoc(lib, doc);
          const ascii = doc.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
          const headers: Record<string, string | number> = { 'content-type': inline ? 'application/pdf' : 'application/octet-stream', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...SECURITY_HEADERS };
          const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
          if (range && (range[1] || range[2])) {
            const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
            const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
            if (start >= size || start > end) {
              res.writeHead(416, { 'content-range': `bytes */${size}`, ...SECURITY_HEADERS });
              return void res.end();
            }
            res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
            return void createReadStream(path, { start, end }).pipe(res);
          }
          res.writeHead(200, { ...headers, 'content-length': size });
          return void createReadStream(path).pipe(res);
        }
        // Phase 110: a room archive is read-only: no rename, no re-read, no learning (delete per week stays).
        if (doc.readOnly && ((!c && method === 'PATCH') || c === 'reread' || c === 'learn' || c === 'ocr')) {
          for await (const _ of req as AsyncIterable<Buffer>) void _;
          throw new HttpError(409, 'This is a read-only archive.', { errorKey: 'This is a read-only archive.' });
        }
        if (!c && method === 'PATCH') {
          const body = await readJson(req);
          if (typeof body.name === 'string' && body.name.trim()) lib.rename(doc.id, body.name);
          if (body.keep === true && !doc.keep) lib.keep(doc.id, body.learn !== false);
          app.libraryNudge?.();
          return send(res, 200, { doc: docView(lib.get(doc.id)!) });
        }
        if (c === 'reread' && method === 'POST') {
          lib.setStatus(doc.id, 'waiting');
          if (doc.keep) lib.setLearn(doc.id, 'waiting');
          app.libraryNudge?.();
          return send(res, 200, { doc: docView(lib.get(doc.id)!) });
        }
        if (c === 'learn' && method === 'POST') {
          if (!doc.keep) throw new HttpError(400, 'Keep it in her library first.');
          lib.setLearn(doc.id, 'waiting');
          app.libraryNudge?.();
          return send(res, 200, { doc: docView(lib.get(doc.id)!) });
        }
        // Phase 74: the owner's controls for a long document being read.
        if ((c === 'pause' || c === 'resume' || c === 'cancel' || c === 'ocr') && method === 'POST') {
          const body = await readJson(req);
          if (!lib.job(doc.id)) throw new HttpError(409, 'This document is not being read now.');
          if (c === 'pause') pauseJob(lib, doc.id);
          else if (c === 'resume') resumeJob(lib, doc.id);
          else if (c === 'cancel') cancelJob(app, lib, doc.id);
          else answerOcr(lib, doc.id, body.approve === true);
          app.libraryNudge?.();
          app.events?.publish({ type: 'library', id: doc.id });
          return send(res, 200, { doc: docView(lib.get(doc.id)!) });
        }
        if (!c && method === 'DELETE') {
          // What she learned from it is forgotten too, if the owner asks.
          // Only the notes learned from this document go: not chat messages that mention the same
          // things (that is what forgetting something said in a conversation does).
          let forgotten = 0;
          if (q.get('forget') === '1' && app.memory) {
            for (const m of app.memory.fromDoc(doc.id)) {
              if (app.memory.delete(m.id)) forgotten++;
              app.vectors?.forget(m.id);
            }
            app.events?.publish({ type: 'memory', conversationId: '' });
          }
          if (lib.job(doc.id)) cancelJob(app, lib, doc.id);
          lib.delete(doc.id);
          app.events?.publish({ type: 'library', id: doc.id });
          return send(res, 200, { ok: true, forgotten });
        }
      }
    }
    return NEXT;
  };
}
