import { deliveryFor, DeliveryError, type DeliveryState, type DeliveryResolution } from '../delivery.ts';
import { HttpError, readJson, send } from '../http.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createDeliveryRoutes(ctx: RouteCtx): RouteHandler {
  return async (req, res, method, parts) => {
    const [area, id, action, extra] = parts;
    if (area !== 'deliveries') return NEXT;
    if (ctx.opts.member || ctx.opts.demo) throw new HttpError(403, 'Owner recovery access required');
    const store = deliveryFor(ctx.app);
    try {
      if (id === 'archive' && !action && !extra) {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
        if (method === 'GET') {
          if ([...query.keys()].some(key => key !== 'before') || query.getAll('before').length !== 1) {
            throw new DeliveryError(400, 'Invalid archive query');
          }
          return send(res, 200, store.archivePreview(query.get('before')!));
        }
        if (method === 'POST') {
          if (query.size) throw new DeliveryError(400, 'Invalid archive query');
          const body = await readJson(req);
          if (Object.keys(body).some(key => key !== 'before' && key !== 'limit') || typeof body.before !== 'string' ||
            ('limit' in body && (typeof body.limit !== 'number' || !Number.isSafeInteger(body.limit)))) {
            throw new DeliveryError(400, 'Invalid archive body');
          }
          return send(res, 200, store.archive(body.before, body.limit as number | undefined));
        }
      }
      if (method === 'GET' && !id) {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const page = store.page({
          filter: (query.get('filter') ?? 'unresolved') as 'unresolved' | 'all' | 'archived',
          ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
          ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}),
        });
        return send(res, 200, { ...page, coverage: 'native-message-creation' });
      }
      if (method === 'POST' && id && !extra) {
        if (action === 'review') return send(res, 200, store.review(id));
        if (action === 'resolve') {
          const body = await readJson(req);
          store.resolve(id, body.expectedState as DeliveryState, body.decision as DeliveryResolution);
          return send(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, 'Delivery route not found');
    } catch (err) {
      if (err instanceof DeliveryError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
}
