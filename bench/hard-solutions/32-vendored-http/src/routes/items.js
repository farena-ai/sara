import { send } from '../../vendor/relay/index.js';
import { error } from '../errors.js';
import { first, wholeNumber } from '../query.js';
import { checkNewItem } from '../validate.js';

export function itemRoutes(router, store) {
  router.add('GET', '/items', (req) => {
    const tags = req.query.tag ?? [];
    const q = (first(req.query, 'q') ?? '').toLowerCase();
    const rawLimit = first(req.query, 'limit');
    const limit = rawLimit === undefined ? 20 : wholeNumber(rawLimit);
    if (!(limit >= 1 && limit <= 100)) return error(400, 'bad-limit');
    let items = store.list();
    if (tags.length) items = items.filter((i) => i.tags.some((t) => tags.includes(t)));
    if (q) items = items.filter((i) => i.name.toLowerCase().includes(q));
    items = items.slice(0, limit);
    return send(200, { items, count: items.length });
  });

  router.add('GET', '/items/{id:int}', (req) => {
    const item = store.get(req.params.id);
    return item ? send(200, item) : error(404, 'not-found');
  });

  router.add('POST', '/items', (req) => {
    const parsed = req.json();
    if (!parsed.ok) return error(400, 'invalid-json');
    const body = parsed.value;
    const problem = checkNewItem(body);
    if (problem) return error(422, 'invalid', { field: problem });
    if (store.bySku(body.sku)) return error(409, 'duplicate-sku');
    const item = store.add(body);
    return send(201, item, { location: `/items/${item.id}` });
  });

  router.add('DELETE', '/items/{id:int}', (req) => {
    const item = store.get(req.params.id);
    if (!item) return error(404, 'not-found');
    if (item.reserved > 0) return error(409, 'has-reservations');
    store.remove(item.id);
    return send(204);
  });
}
