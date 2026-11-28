import { send } from '../../vendor/relay/index.js';
import { error } from '../errors.js';
import { isObject } from '../validate.js';

export function reservationRoutes(router, store, pricing) {
  const reservations = new Map();
  const replays = new Map();

  router.add('POST', '/items/{id:int}/reserve', async (req) => {
    const key = req.header('idempotency-key');
    if (key !== null && replays.has(key)) return send(200, replays.get(key), { 'x-idempotent-replay': 'true' });
    const item = store.get(req.params.id);
    if (!item) return error(404, 'not-found');
    const parsed = req.json();
    if (!parsed.ok) return error(400, 'invalid-json');
    const qty = isObject(parsed.value) ? parsed.value.qty : undefined;
    if (!Number.isInteger(qty) || qty < 1) return error(422, 'invalid', { field: 'qty' });
    const available = item.stock - item.reserved;
    if (qty > available) return error(409, 'insufficient-stock', { available });

    const updated = store.reserve(item.id, qty);
    const number = reservations.size + 1;
    const record = { reservation: number, itemId: item.id, qty, total: null };
    reservations.set(number, record);
    const quote = await pricing.quote(item.sku, qty);
    if (quote.ok) record.total = quote.price.total;
    const body = { ...record, available: updated.stock - updated.reserved };
    if (key !== null) replays.set(key, body);
    return send(201, body, { location: `/reservations/${number}`, 'x-price-status': quote.ok ? 'ok' : quote.reason });
  });

  router.add('GET', '/reservations/{number:int}', (req) => {
    const record = reservations.get(req.params.number);
    return record ? send(200, record) : error(404, 'not-found');
  });
}
