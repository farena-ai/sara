import { createClient } from '../vendor/relay/index.js';

/**
 * The pricing service client (docs/API.md, "Pricing"). quote() resolves to
 * { ok: true, price: { sku, qty, unit, total } } or { ok: false, reason: 'missing' | 'unavailable' }.
 */
export function createPricing(upstream, clock) {
  const client = createClient(upstream, { clock, timeout: 2000, retry: { attempts: 2, delay: 500 } });
  return {
    async quote(sku, qty) {
      const [err, res] = await client.get(`/prices/${encodeURIComponent(sku)}?qty=${qty}`);
      if (err) return { ok: false, reason: 'unavailable' };
      if (res.status === 200) return { ok: true, price: res.body };
      if (res.status === 404) return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unavailable' };
    },
  };
}
