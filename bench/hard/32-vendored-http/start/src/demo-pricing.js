import { createRouter, send } from '../vendor/relay/index.js';

const UNIT_PRICES = { 'BOLT-M6': 12, 'NUT-M6': 5, 'GLUE-50': 450 };

/** A stand-in for the pricing service (docs/PRICING.md), used by bin/stockroom.js. */
export function demoPricing() {
  return createRouter().add('GET', '/prices/{sku}', (req) => {
    const unit = UNIT_PRICES[req.params.sku];
    if (unit === undefined) return send(404, { error: 'unknown-sku' });
    const qty = Number(req.query.qty?.[0] ?? 1);
    return send(200, { sku: req.params.sku, qty, unit, total: unit * qty });
  });
}
