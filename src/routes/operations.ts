import { DEVICE_TOKEN_PREFIX } from '../auth.ts';
import { HttpError, send } from '../http.ts';
import type { OperationsMonitor } from '../operations.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createOperationsRoutes(ctx: RouteCtx, monitor: OperationsMonitor): RouteHandler {
  return async (req, res, method, parts) => {
    if (parts[0] !== 'operations') return NEXT;
    if (ctx.opts.member || ctx.opts.demo || req.headers.authorization?.startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`)) {
      throw new HttpError(403, 'Owner operations access required');
    }
    if (method !== 'GET' || parts.length !== 1) throw new HttpError(404, 'Operations route not found');
    res.setHeader('cache-control', 'no-store');
    return send(res, 200, monitor.snapshot(ctx.app));
  };
}
