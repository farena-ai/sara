// Memory: memories, scrapbook, moments, photos, uploads, find.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { createReadStream } from 'node:fs';
import { vaultKeyFor } from '../chat.ts';
import { findEverything } from '../find.ts';
import { as400, fromPhoneApp, HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { forgetMemory, localDate, type MemorySettings, memorySettings } from '../memory-worker.ts';
import { clampDecay, decayPolicy, explainPolicy, FADE_PRESETS, type FadePreset } from '../memory-rank.ts';
import { type Memory, MEMORY_KINDS, type MemoryKind, parseOnDate } from '../memory.ts';
import { captionModel, deletePhotoEverywhere, handEligible, type Moment, MOMENTS_MODES, type MomentsMode, momentsSettings } from '../moments.ts';
import { DEFAULT_IMAGE_MODEL, PHOTO_KEY_VAULT, photoSettings } from '../photos.ts';
import { adultModeOn } from '../settings.ts';
import { importedOther, movedFrom } from '../store.ts';
import { RECALL_MODES, type RecallMode, recallMode, TRIGGER_KINDS, type TriggerKind } from '../triggers.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMemoryRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a === 'memories' || a === 'memory') {
      const mem = app.memory;
      if (!mem) throw new HttpError(404, 'Memory is not available');
      if (a === 'memory' && b === 'settings') {
        // Phase 76: the decay policy in numbers (`decay`) and in words (`decayText`).
        const withDecay = (m: MemorySettings) => {
          const p = decayPolicy(m);
          return { ...m, recall: recallMode(m), fade: p.preset, decay: { halfLifeDays: p.halfLifeDays, reuseWeight: p.reuseWeight, minStanding: p.minStanding }, policyId: p.id, decayText: explainPolicy(p) };
        };
        if (method === 'GET') return send(res, 200, { ...withDecay(memorySettings(app)), sharing: app.settings.get().memorySharing ?? 'own' });
        if (method === 'PUT') {
          const body = await readJson(req);
          const cur = memorySettings(app);
          const next: MemorySettings = {
            enabled: body.enabled === undefined ? cur.enabled : Boolean(body.enabled),
            quietMinutes: body.quietMinutes === undefined ? cur.quietMinutes : Math.min(1440, Math.max(1, Math.round(Number(body.quietMinutes) || cur.quietMinutes))),
            injectBudgetChars: body.injectBudgetChars === undefined ? cur.injectBudgetChars : Math.min(6000, Math.max(200, Math.round(Number(body.injectBudgetChars) || cur.injectBudgetChars))),
            fade: FADE_PRESETS.includes(body.fade as FadePreset) ? (body.fade as FadePreset) : (cur.fade ?? 'never'),
            // Phase 76: clamped (half-life 0 or 7–3650 days, reuse 0–0.3, min standing 0–1).
            decay: body.decay && typeof body.decay === 'object' ? clampDecay(body.decay, clampDecay(cur.decay)) : cur.decay,
            // Phase 85: Recall on her own.
            recall: RECALL_MODES.includes(body.recall as RecallMode) ? (body.recall as RecallMode) : recallMode(cur),
          };
          if (!next.decay) delete next.decay;
          app.settings.update({ memory: { ...next, budgetMoved: true } as MemorySettings, ...(body.sharing === 'shared' || body.sharing === 'own' ? { memorySharing: body.sharing } : {}) });
          return send(res, 200, { ...withDecay(next), sharing: app.settings.get().memorySharing ?? 'own' });
        }
      }
      // Phase 85 (harness M10): "Not useful" on a "Remembered on her own" chip halves that trigger's
      // weight (recorded); GET shows how much the index holds and the latest feedback.
      if (a === 'memory' && b === 'recall') {
        const idx = app.recall;
        if (!idx) throw new HttpError(404, 'Memory is not available');
        if (method === 'GET' && !c) return send(res, 200, { mode: recallMode(memorySettings(app)), signatures: idx.count(), lessons: idx.lessons(500).length, feedback: idx.feedbackRows(20) });
        if (method === 'POST' && c === 'feedback') {
          const body = await readJson(req);
          const kind = String(body.kind ?? '') as TriggerKind;
          const ref = String(body.ref ?? '');
          if (!TRIGGER_KINDS.includes(kind) || !/^(lesson|note|sig):[\w-]{1,40}$/.test(ref)) throw new HttpError(400, 'Bad request');
          const messageId = Number(body.messageId);
          const msg = Number.isInteger(messageId) && messageId > 0 ? app.store.messageById(messageId) : undefined;
          const r = idx.feedback(kind, ref, 'not-useful', { conversationId: msg?.conversationId ?? null, runId: typeof msg?.meta?.runId === 'number' ? (msg.meta.runId as number) : null, messageId: msg?.id ?? null });
          // The chip remembers it was marked (on the reply that carried it).
          if (msg && Array.isArray(msg.meta?.recall)) app.store.updateMessageMeta(msg.id, { recall: (msg.meta.recall as { kind?: string; ref?: string }[]).map((x) => (x?.kind === kind && x?.ref === ref ? { ...x, feedback: 'not-useful' } : x)) });
          return send(res, 200, { ok: true, weight: r.after, before: r.before });
        }
      }
      if (a === 'memories') {
        const view = (m: Memory) => {
          const conv = m.conversationId ? app.store.getConversation(m.conversationId) : undefined;
          // Phase 51: notes learned from imported history say so ("from your ChatGPT history").
          return { ...m, source: conv ? { conversationId: conv.id, title: conv.title, messageId: m.sourceMessageId, fromId: m.sourceFromId } : null, importedFrom: importedOther(conv) ?? null, movedFrom: movedFrom(conv) ?? null };
        };
        if (!b && method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://x');
          // Phase 75: the presence panel's "She remembered": just the notes used in one reply
          // (`?ids=3,7,12`, up to 50), in the order asked; ids that are gone are left out.
          const ids = url.searchParams.get('ids');
          if (ids !== null) {
            const want = [...new Set(ids.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
            return send(res, 200, want.map((id) => mem.get(id)).filter((m): m is Memory => Boolean(m)).map(view));
          }
          const kind = url.searchParams.get('kind');
          return send(res, 200, mem.list({ kind: MEMORY_KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : undefined, q: url.searchParams.get('q') ?? undefined, pinned: url.searchParams.get('pinned') === '1' }).map(view));
        }
        // Phase 12: tell her something to remember, or a date that matters, yourself.
        if (!b && method === 'POST') {
          const body = await readJson(req);
          const kind: MemoryKind = body.kind === 'date' || body.kind === 'decision' || body.kind === 'promise' || body.kind === 'milestone' ? body.kind : 'fact';
          const content = String(body.content ?? '').trim();
          if (content.length < 3 || content.length > 500) throw new HttpError(400, 'Write 3 to 500 characters.');
          const onDate = kind === 'date' ? String(body.onDate ?? '') : null;
          if (kind === 'date' && !parseOnDate(onDate)) throw new HttpError(400, 'Pick a real date.');
          const s2 = app.settings.get();
          const m = mem.add({ kind, content, onDate, conversationId: null, sourceMessageId: null, happenedOn: localDate(app.now().toISOString(), s2.timeZone), evidence: 'You added this.' });
          // Phase 101 (ST6): "My sister Ana is a nurse" goes on Ana's card (proposed if she's new).
          if (app.people) {
            const about = app.people.aboutFromText(content);
            if (about.length && app.people.linkMemory(m, about).personIds.length) app.events?.publish({ type: 'people', what: 'facts' });
          }
          return send(res, 201, view(m));
        }
        if (b === 'upcoming' && method === 'GET') {
          const today = localDate(app.now().toISOString(), app.settings.get().timeZone);
          return send(res, 200, mem.upcoming(today, 60).map((u) => ({ ...view(u.memory), inDays: u.inDays, date: u.date, years: u.years })));
        }
        if (b === 'reflect' && method === 'POST') {
          if (!app.weekly) throw new HttpError(404, 'Not available');
          const result = await app.weekly.reflect(true);
          return send(res, 200, { result });
        }
        const id = Number(b);
        if (!Number.isInteger(id)) throw new HttpError(404, 'Not found');
        if (!c && method === 'PATCH') {
          const body = await readJson(req);
          const cur = mem.get(id);
          if (!cur) throw new HttpError(404, 'Memory not found');
          // "Use it again" for a fact the weekly look-back marked as replaced.
          if (body.supersededBy === null) mem.supersede(id, null);
          // Phase 76: pin (never fades, always a candidate) or unpin.
          if (body.pinned !== undefined) {
            if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'Pin must be on or off.');
            mem.setPinned(id, body.pinned);
          }
          // Phase 32: mark a promise kept (or open again).
          if (body.resolved !== undefined && cur.kind === 'promise') mem.resolve(id, body.resolved ? app.now().toISOString() : (null as unknown as string));
          const content = body.content === undefined ? cur.content : String(body.content ?? '').trim();
          if (!content || content.length > 2000) throw new HttpError(400, 'Memory text must be 1-2000 characters');
          let onDate: string | undefined;
          if (body.onDate !== undefined && cur.kind === 'date') {
            onDate = String(body.onDate);
            if (!parseOnDate(onDate)) throw new HttpError(400, 'Pick a real date.');
          }
          const m = (body.content === undefined && onDate === undefined ? mem.get(id) : mem.update(id, content, onDate)) ?? cur;
          return send(res, 200, view(m));
        }
        if (!c && method === 'DELETE') {
          if (!mem.delete(id)) throw new HttpError(404, 'Memory not found');
          // Phase 101: its meaning vector goes too (forgetting really deletes); people facts follow by trigger.
          app.vectors?.forget(id);
          return send(res, 200, { ok: true });
        }
        if (c === 'forget' && method === 'POST') {
          const r = forgetMemory(app, mem, id);
          if (!r) throw new HttpError(404, 'Memory not found');
          for (const x of r.removed) app.vectors?.forget(x);
          return send(res, 200, r);
        }
      }
    }
    if (a === 'scrapbook') {
      const book = app.scrapbook;
      if (!book) throw new HttpError(404, 'Scrapbook is not available');
      if (!b && method === 'GET') {
        const convs = new Map(app.store.listConversations().map((c) => [c.id, c.title]));
        return send(res, 200, { entries: book.list().map((e) => ({ ...e, conversation: e.conversationId ? (convs.get(e.conversationId) ?? null) : null })), photos: book.photos(app.store), hiddenPhotos: book.photos(app.store, 200, 'only') });
      }
      // Photos: "Remove from scrapbook" (hide; the message keeps it), bring back, or delete everywhere
      // (asks first in the app: out of every message, the scrapbook and the album; the file goes).
      if (b === 'photos' && (c === 'hide' || c === 'unhide' || c === 'delete') && !parts[3] && method === 'POST') {
        const body = await readJson(req);
        const image = String(body.image ?? '');
        if (!book.isPhotoName(image)) throw new HttpError(400, 'Not a photo');
        if (c === 'unhide') return send(res, 200, { ok: true, changed: book.unhidePhoto(image) });
        if (!book.photos(app.store, 5000, 'all').some((x) => x.image === image)) throw new HttpError(404, 'Not found');
        if (c === 'hide') return send(res, 200, { ok: true, changed: book.hidePhoto(image) });
        if (body.confirm !== true) throw new HttpError(400, 'Confirm first: this deletes the photo from your conversations too.');
        if (!app.moments) throw new HttpError(404, 'Our moments is not available here.');
        const out = deletePhotoEverywhere(app, app.moments, image);
        book.unhidePhoto(image);
        void app.momentsWorker?.nudge();
        return send(res, 200, { ok: true, ...out });
      }
      if (!b && method === 'POST') {
        const body = await readJson(req);
        const messageId = body.messageId !== undefined ? Number(body.messageId) : null;
        let text = String(body.text ?? '');
        let conversationId: string | null = null;
        if (messageId !== null) {
          const m = app.store.messageById(messageId);
          if (!m) throw new HttpError(404, 'Message not found');
          if (app.store.getConversation(m.conversationId)?.partner) throw new HttpError(400, "Messages from other people's chats can't go in the scrapbook.");
          text ||= m.content;
          conversationId = m.conversationId;
        }
        if (!text.trim()) throw new HttpError(400, 'Nothing to save.');
        const kind = body.kind === 'joke' ? 'joke' : 'moment';
        const entry = book.add({ kind, text, note: String(body.note ?? ''), conversationId, messageId, addedBy: 'owner' });
        // Phase 70: a pinned moment enters "Our moments" (with its photo, if it has one).
        if (kind === 'moment') void app.momentsWorker?.nudge();
        return send(res, 201, entry);
      }
      if (b && method === 'PATCH') {
        const body = await readJson(req);
        const e = book.update(Number(b), { ...(body.note !== undefined ? { note: String(body.note) } : {}), ...(body.text !== undefined ? { text: String(body.text) } : {}) });
        if (!e) throw new HttpError(404, 'Not found');
        return send(res, 200, e);
      }
      if (b && method === 'DELETE') {
        if (!book.delete(Number(b))) throw new HttpError(404, 'Not found');
        return send(res, 200, { ok: true });
      }
    }
    // Phase 70: "Our moments": the album, its captions and albums (owner only; never the demo, MCP or /v1).
    if (a === 'moments') {
      const book = app.moments;
      if (!book) throw new HttpError(404, 'Our moments is not available here.');
      const d = parts[3];
      const adultOk = adultModeOn(app.settings.get()) && !fromPhoneApp(req);
      const nudge = () => void app.momentsWorker?.nudge();
      const convs = new Map(app.store.listConversations().map((x) => [x.id, x]));
      const view = (m: Moment) => {
        const cv = m.conversationId ? (convs.get(m.conversationId) ?? app.store.getConversation(m.conversationId)) : undefined;
        return { ...m, conversation: cv ? cv.title : null, private: Boolean(cv?.private), albums: book.albumsOf(m.id) };
      };
      if (!b && method === 'GET') {
        book.prune();
        const album = new URL(req.url ?? '/', 'http://x').searchParams.get('album') ?? undefined;
        const items = book.list({ adultOk, ...(album ? { album } : {}) });
        const otd = book.onThisDay(app.now(), app.settings.get().timeZone, { adultOk });
        return send(res, 200, {
          settings: momentsSettings(app.settings),
          items: items.map(view),
          albums: book.albums({ adultOk }),
          onThisDay: otd ? { kind: otd.kind, ...(otd.years ? { years: otd.years } : {}), ids: otd.items.map((m) => m.id) } : null,
          pending: book.pendingCount(),
          waiting: book.waitingCount(),
          hiddenAdult: book.count({ adultOk: true }) - book.count({ adultOk }),
          phoneApp: fromPhoneApp(req),
          captioner: captionModel(app),
        });
      }
      if (b === 'settings' && method === 'PUT') {
        const body = await readJson(req);
        const mode = String(body.mode ?? '') as MomentsMode;
        if (!MOMENTS_MODES.includes(mode)) throw new HttpError(400, 'Pick all photos, only kept moments, or off.');
        app.settings.update({ moments: { ...app.settings.get().moments, mode } });
        nudge();
        return send(res, 200, momentsSettings(app.settings));
      }
      if (b === 'captions' && !c && method === 'POST') {
        await readJson(req);
        const n = book.requestMore();
        nudge();
        return send(res, 200, { queued: n });
      }
      if (b === 'albums') {
        if (!c && method === 'POST') {
          const body = await readJson(req);
          try {
            return send(res, 201, book.createAlbum(String(body.name ?? '')));
          } catch (err) {
            throw as400(err);
          }
        }
        if (c && !d && method === 'PATCH') {
          const body = await readJson(req);
          try {
            book.updateAlbum(c, { ...(body.name !== undefined ? { name: String(body.name) } : {}), ...(body.cover !== undefined ? { cover: body.cover === null ? null : Number(body.cover) } : {}) });
          } catch (err) {
            throw new HttpError(/not found/i.test((err as Error).message) ? 404 : 400, (err as Error).message);
          }
          return send(res, 200, { albums: book.albums({ adultOk }) });
        }
        if (c && !d && method === 'DELETE') {
          try {
            book.deleteAlbum(c);
          } catch (err) {
            throw new HttpError(/not found/i.test((err as Error).message) ? 404 : 400, (err as Error).message);
          }
          return send(res, 200, { ok: true });
        }
        if (c && d === 'items' && method === 'POST') {
          const body = await readJson(req);
          const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter((x: number) => Number.isInteger(x));
          try {
            return send(res, 200, { added: book.addToAlbum(c, ids) });
          } catch (err) {
            throw new HttpError(404, (err as Error).message);
          }
        }
        if (c && d === 'items' && parts[4] && method === 'DELETE') {
          try {
            if (!book.removeFromAlbum(c, Number(parts[4]))) throw new HttpError(404, 'Not in that album');
          } catch (err) {
            if (err instanceof HttpError) throw err;
            throw new HttpError(404, (err as Error).message);
          }
          return send(res, 200, { ok: true });
        }
      }
      if (!b && method === 'POST') {
        // Add a message's photo by hand (e.g. from a private conversation or a group chat).
        const body = await readJson(req);
        const m = app.store.messageById(Number(body.messageId));
        if (!m) throw new HttpError(404, 'Message not found');
        if (!handEligible(app.store.getConversation(m.conversationId))) throw new HttpError(400, "Photos from other people's chats or other apps can't go in your moments.");
        try {
          const added = book.addByHand(app.store, m.id, body.image ? String(body.image) : undefined);
          nudge();
          return send(res, 201, { items: added.map(view) });
        } catch (err) {
          throw as400(err);
        }
      }
      if (b && /^\d+$/.test(b)) {
        const id = Number(b);
        if (!c && method === 'PATCH') {
          const body = await readJson(req);
          if (!book.get(id)) throw new HttpError(404, 'Not found');
          try {
            return send(res, 200, view(book.setCaption(id, String(body.caption ?? ''))!));
          } catch (err) {
            throw as400(err);
          }
        }
        if (c === 'caption' && method === 'POST') {
          await readJson(req);
          const m = book.requestCaption(id);
          if (!m) throw new HttpError(404, 'Not found');
          nudge();
          return send(res, 200, view(m));
        }
        // "Remove from moments": the message and its photo stay.
        if (!c && method === 'DELETE') {
          if (!book.remove(id)) throw new HttpError(404, 'Not found');
          return send(res, 200, { ok: true });
        }
        // "Delete photo everywhere" (the app asks first): out of every message, the scrapbook and the album; the file goes.
        if (c === 'delete-everywhere' && method === 'POST') {
          const body = await readJson(req);
          if (body.confirm !== true) throw new HttpError(400, 'Confirm first: this deletes the photo from your conversations too.');
          const m = book.get(id, { hidden: true });
          if (!m?.image) throw new HttpError(404, 'Not found');
          return send(res, 200, deletePhotoEverywhere(app, book, m.image));
        }
      }
    }
    if (a === 'photos' && !b) {
      const view = () => {
        const p = photoSettings(app.settings);
        const xai = app.settings.get().providers.find((x) => /api\.x\.ai/.test(x.baseUrl));
        return { mode: p.mode, model: p.model || DEFAULT_IMAGE_MODEL, hasKey: app.vault.has(PHOTO_KEY_VAULT), grokSubscription: app.subscriptions?.grokStatus().signedIn ?? false, providerKey: Boolean(xai && app.vault.get(vaultKeyFor(xai.id))), taken: (p.taken ?? []).slice(0, 12) };
      };
      if (method === 'GET') return send(res, 200, await view());
      if (method === 'PUT') {
        const body = await readJson(req);
        const cur = photoSettings(app.settings);
        const mode = body.mode === 'off' || body.mode === 'set' || body.mode === 'new' ? body.mode : cur.mode;
        const model = body.model !== undefined ? String(body.model).trim().slice(0, 80) || undefined : cur.model;
        if (typeof body.key === 'string' && body.key.trim()) app.vault.set(PHOTO_KEY_VAULT, body.key.trim());
        if (body.key === null) app.vault.delete(PHOTO_KEY_VAULT);
        app.settings.update({ photos: { ...cur, mode, model } });
        return send(res, 200, await view());
      }
    }
    if (a === 'uploads' && b && !c && method === 'GET') {
      const f = app.uploads?.get(b);
      if (!f) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'content-type': f.mime, 'cache-control': 'private, max-age=31536000, immutable', ...SECURITY_HEADERS });
      return void createReadStream(f.path).pipe(res);
    }
    if (a === 'find' && method === 'GET') {
      const sp = new URL(req.url ?? '/', 'http://x').searchParams;
      const q = (sp.get('q') ?? '').trim().slice(0, 200);
      // Phase 22: ?all=1 searches everything, grouped (conversations, memories, notes, to-dos,
      // scrapbook, workspace files). Without it: conversations only (older clients).
      if (sp.get('all') === '1') return send(res, 200, findEverything(app, q, { files: !opts.demo }));
      return send(res, 200, q ? app.store.search(q) : []);
    }
    return NEXT;
  };
}
