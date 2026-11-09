import { HttpError, readJson, send } from '../http.ts';
import { createScene, deleteScene, getScene, linkSeat, listScenes, resetScene, retireCanon, SceneError, scenesEnabled, seatOptions, setCanon, unlinkSeat, updateScene } from '../shared-scenes-policy.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const unavailable = () => new HttpError(403, 'Shared scenes are unavailable here.');
const strict = (body: unknown, allowed: string[], required: string[] = []): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object.');
  const keys = Object.keys(body);
  if (keys.some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(body, k))) throw new HttpError(400, 'Unknown or missing fields.');
  return body as Record<string, unknown>;
};
const sceneNumber = (value: string): number => /^[1-9]\d{0,8}$/.test(value) ? Number(value) : 0;

/** Explicit owner controls for R1B1-R1B3 shared scenes. These routes never create a turn, call a model or build tools. */
export function createSceneRoutes(ctx: RouteCtx): RouteHandler {
  return async (req, res, method, parts) => {
    if (parts[0] !== 'scenes' || parts.length > 4) return NEXT;
    if (!ctx.isAuthed(req)) throw new HttpError(401, 'Sign in first.');
    const app = ctx.app;
    // Owner/space/member/demo/off-record gate first, again after every awaited body read.
    const requireOwner = () => {
      if (!ctx.isAuthed(req)) throw new HttpError(401, 'Sign in first.');
      if (ctx.app !== app || ctx.opts.member || ctx.opts.demo || app.member || app.demo || app.offRecord || ctx.spaceId !== 'owner') throw unavailable();
    };
    requireOwner();
    res.setHeader('cache-control', 'no-store');
    const body = async (allowed: string[], required: string[] = []) => { const value = await readJson(req); requireOwner(); return strict(value, allowed, required); };
    if (parts.length === 2 && parts[1] === 'settings') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      const b = await body(['enabled'], ['enabled']);
      if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'Use only an enabled boolean for shared scenes.');
      // Only this key changes; continuity, commands and titles keep their own settings.
      const chats = app.settings.get().chats;
      const previous = chats?.scenes;
      app.settings.update({ chats: {
        ...(chats && typeof chats === 'object' && !Array.isArray(chats) ? chats : {}),
        scenes: { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), enabled: b.enabled },
      } });
      return send(res, 200, { enabled: scenesEnabled(app) });
    }
    const id = parts[1] === undefined ? 0 : sceneNumber(parts[1]);
    try {
      if (parts.length === 1) {
        if (method === 'GET') return send(res, 200, listScenes(app));
        if (method === 'POST') {
          const b = await body(['title', 'premise', 'adult'], ['title']);
          return send(res, 201, { scene: createScene(app, b as { title: unknown }) });
        }
        throw new HttpError(405, 'Method not allowed');
      }
      if (!id) throw new SceneError(404, 'Scene not found.');
      if (parts.length === 2) {
        if (method === 'GET') return send(res, 200, getScene(app, id));
        if (method === 'PATCH') {
          const b = await body(['expectedRevision', 'title', 'premise', 'adult', 'status'], ['expectedRevision']);
          if (Object.keys(b).length < 2) throw new HttpError(400, 'Nothing to change.');
          return send(res, 200, { scene: updateScene(app, id, b as { expectedRevision: unknown }) });
        }
        if (method === 'DELETE') { const b = await body(['expectedRevision'], ['expectedRevision']); return send(res, 200, deleteScene(app, id, b.expectedRevision)); }
        throw new HttpError(405, 'Method not allowed');
      }
      const [, , part, sub] = parts;
      if (part === 'seat-options' && parts.length === 3 && method === 'GET') return send(res, 200, seatOptions(app, id));
      if (part === 'seats' && parts.length === 3 && method === 'POST') {
        const b = await body(['conversationId', 'expectedRevision', 'confirmAudience', 'confirmRoomId'], ['conversationId', 'expectedRevision']);
        return send(res, 200, linkSeat(app, id, b as { conversationId: unknown; expectedRevision: unknown }));
      }
      if (part === 'seats' && parts.length === 4 && method === 'DELETE') { const b = await body(['expectedRevision'], ['expectedRevision']); return send(res, 200, unlinkSeat(app, id, decodeURIComponent(sub!), b.expectedRevision)); }
      if (part === 'canon' && parts.length === 3 && method === 'POST') {
        const b = await body(['expectedRevision', 'key', 'text', 'fromMessageId'], ['expectedRevision', 'key']);
        return send(res, 200, setCanon(app, id, b as { expectedRevision: unknown; key: unknown }));
      }
      if (part === 'canon' && parts.length === 4 && method === 'DELETE') { const b = await body(['expectedRevision'], ['expectedRevision']); return send(res, 200, retireCanon(app, id, decodeURIComponent(sub!), b.expectedRevision)); }
      if (part === 'reset' && parts.length === 3 && method === 'POST') { const b = await body(['expectedRevision'], ['expectedRevision']); return send(res, 200, resetScene(app, id, b.expectedRevision)); }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof SceneError) throw new HttpError(error.status, error.message);
      throw error;
    }
  };
}
