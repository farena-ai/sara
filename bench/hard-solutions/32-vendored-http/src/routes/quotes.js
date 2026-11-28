import { send } from '../../vendor/relay/index.js';
import { error } from '../errors.js';
import { first, wholeNumber } from '../query.js';

export function quoteRoutes(router, store, pricing) {
  router.add('GET', '/items/{id:int}/quote', async (req) => {
    const item = store.get(req.params.id);
    if (!item) return error(404, 'not-found');
    const rawQty = first(req.query, 'qty');
    const qty = rawQty === undefined ? 1 : wholeNumber(rawQty);
    if (!(qty >= 1 && qty <= 1000)) return error(400, 'bad-qty');
    const quote = await pricing.quote(item.sku, qty);
    if (!quote.ok) return quote.reason === 'missing' ? error(404, 'no-price') : error(503, 'pricing-unavailable');
    const { unit, total } = quote.price;
    return send(200, { id: item.id, sku: item.sku, qty, unit, total });
  });
}
