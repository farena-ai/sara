import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { adultModeOn } from '../settings.ts';
import { clearSessionHandoffs, continuityEnabled, continuityParallel, inspectSessionHandoffs, SessionContinuityError } from '../session-continuity.ts';
import { PARALLEL_MAX } from '../session-step-gate.ts';
import { policy } from '../policy-profile.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const unavailable = () => new HttpError(403, en('Session continuity is unavailable in this context.'));

/** Explicit owner controls. These routes neither create a turn nor construct owner tools. */
export function createSessionContinuityRoutes(ctx: RouteCtx): RouteHandler {
  return async (req, res, method, parts) => {
    const settings = parts.length === 2 && parts[0] === 'chats' && parts[1] === 'continuity';
    const targetId = parts.length === 3 && parts[0] === 'conversations' && parts[2] === 'continuity' ? parts[1] : undefined;
    if (!settings && targetId === undefined) return NEXT;
    if (!ctx.isAuthed(req)) throw new HttpError(401, 'Sign in first.');
    const app = ctx.app;
    const requireOwner = () => {
      if (!ctx.isAuthed(req)) throw new HttpError(401, 'Sign in first.');
      if (ctx.app !== app || ctx.opts.member || ctx.opts.demo || app.member || app.demo || app.offRecord || ctx.spaceId !== 'owner') throw unavailable();
    };
    requireOwner();
    res.setHeader('cache-control', 'no-store');
    if (settings) {
      if (method === 'PUT') {
        const body = await readJson(req);
        requireOwner();
        const keys = body && !Array.isArray(body) && typeof body === 'object' ? Object.keys(body) : [];
        if (!keys.length || keys.some(k => k !== 'enabled' && k !== 'parallel') || (Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean')) throw new HttpError(400, en('Use only an enabled boolean for session continuity.'));
        if (Object.hasOwn(body, 'parallel') && (typeof body.parallel !== 'number' || !Number.isInteger(body.parallel) || body.parallel < 1 || body.parallel > PARALLEL_MAX)) throw new HttpError(400, en('Replies at the same time must be a whole number from 1 to 8.'));
        // mnt2: the policy pin is a ceiling; asking for more is refused, never silently lowered.
        const pin = policy().pins.parallelReplies;
        const parallel = Object.hasOwn(body, 'parallel') ? body.parallel as number : undefined;
        const enabled = Object.hasOwn(body, 'enabled') ? body.enabled as boolean : continuityEnabled(app);
        if (parallel !== undefined && pin && parallel > pin) throw policy().refusal('parallelReplies');
        const chats = app.settings.get().chats;
        const previous = chats?.continuity;
        const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
        app.settings.update({ chats: {
          ...(chats && typeof chats === 'object' && !Array.isArray(chats) ? chats : {}),
          continuity: { ...base, enabled, ...(parallel !== undefined ? { parallel } : {}) },
        } });
      } else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { enabled: continuityEnabled(app), parallel: continuityParallel(app), parallelMax: policy().pins.parallelReplies ?? PARALLEL_MAX });
    }
    if (!targetId) throw unavailable();
    // Refuse another store and obvious forbidden audiences before invoking the continuity service.
    // The service then revalidates all persisted timestamps, epochs and source identities itself.
    const resolveStore = () => {
      requireOwner();
      if (ctx.ctxOf(targetId) !== app) throw unavailable();
      return app.store;
    };
    const store = resolveStore();
    const database = store.db;
    const requireTarget = () => {
      if (resolveStore() !== store || store.db !== database) throw unavailable();
      const target = store.getConversation(targetId);
      if (!target || target.private || target.partner || target.archivedAt || target.endedAt || !['chat', 'coding'].includes(target.mode)) throw unavailable();
      if (!/^(web|telegram(?:-nsfw)?|discord(?:-nsfw)?|plugin-[a-z0-9-]+)$/.test(target.channel)) throw unavailable();
      if (target.channelKey && (/(?:^|:)room:/.test(target.channelKey) || (target.channel.startsWith('telegram') && target.channelKey.startsWith('-')))) throw unavailable();
      if (target.channel.endsWith('-nsfw') && !adultModeOn(app.settings.get())) throw unavailable();
    };
    requireTarget();
    try {
      if (method === 'GET') {
        const result = inspectSessionHandoffs(app, targetId);
        return send(res, 200, { ...result, handoffs: result.handoffs.map(record => ({ ...record, sourceTitle: (app.store.getConversation(record.sourceConversationId)?.title ?? '').slice(0, 160) })) });
      }
      if (method === 'DELETE') {
        const body = await readJson(req);
        requireTarget();
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'expectedId') || typeof body.expectedId !== 'number' || !Number.isSafeInteger(body.expectedId) || body.expectedId < 0) throw new HttpError(400, en('Use only a nonnegative integer expectedId to clear saved session context.'));
        return send(res, 200, clearSessionHandoffs(app, targetId, body.expectedId));
      }
      throw new HttpError(405, 'Method not allowed');
    } catch (error) {
      if (error instanceof SessionContinuityError) throw new HttpError(error.status, error.message);
      throw error;
    }
  };
}
