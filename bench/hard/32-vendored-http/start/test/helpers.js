import { createApp } from '../src/app.js';
import { createClock, createRouter, send } from '../vendor/relay/index.js';

export const KEY = 'test-key';

/**
 * A fake pricing service. `script` lists what each call does in turn ({ sleep, status }); the last
 * entry repeats. Every call is recorded in `calls`.
 */
export function fakePricing(clock, script = []) {
  const calls = [];
  const router = createRouter().add('GET', '/prices/{sku}', async (req) => {
    calls.push({ sku: req.params.sku, qty: req.query.qty?.[0], at: clock.now() });
    const step = script[calls.length - 1] ?? script[script.length - 1] ?? {};
    if (step.sleep) await clock.sleep(step.sleep);
    if (step.status && step.status !== 200) return send(step.status, { error: 'pricing-says-no' });
    const qty = Number(req.query.qty?.[0] ?? 1);
    return send(200, { sku: req.params.sku, qty, unit: 250, total: 250 * qty });
  });
  return { router, calls };
}

/** An app over a fake pricing service and a virtual clock, with a call() helper. */
export function setup({ script, items } = {}) {
  const clock = createClock();
  const pricing = fakePricing(clock, script);
  const app = createApp({ pricing: pricing.router, clock, keys: [KEY], ...(items ? { items } : {}) });
  const call = (method, path, { body, headers = {}, key = KEY } = {}) =>
    app.dispatch({ method, path, body, headers: { ...(key ? { 'X-Api-Key': key } : {}), ...headers } });
  return { app, clock, calls: pricing.calls, call };
}
