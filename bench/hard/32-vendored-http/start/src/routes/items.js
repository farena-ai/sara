import { send } from '../../vendor/relay/index.js';
import { error } from '../errors.js';
import { checkNewItem } from '../validate.js';

export function itemRoutes(router, store) {
  router.add('GET', '/items', (req) => {
    const tag = req.query.tag;
    const q = String(req.query.q ?? '').toLowerCase();
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(400, 'bad-limit');
    let items = store.list();
    if (tag) items = items.filter((i) => i.tags.includes(tag));
    if (q) items = items.filter((i) => i.name.toLowerCase().includes(q));
    items = items.slice(0, limit);
    return send(200, { items, count: items.length });
  });

  router.add('GET', '/items/{id}', (req) => {
    const item = store.get(req.params.id);
    return item ? send(200, item) : error(404, 'not-found');
  });

  router.add('POST', '/items', (req) => {
    let body;
    try {
      body = req.json();
    } catch {
      return error(400, 'invalid-json');
    }
    const problem = checkNewItem(body);
    if (problem) return error(422, 'invalid', { field: problem });
    if (store.bySku(body.sku)) return error(409, 'duplicate-sku');
    const item = store.add(body);
    return send(201, item, { location: `/items/${item.id}` });
  });

  router.add('DELETE', '/items/{id}', (req) => {
    if (!store.get(req.params.id)) return error(404, 'not-found');
    store.remove(req.params.id);
    return send(204, {});
  });
}
