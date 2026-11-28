import { createRouter } from '../vendor/relay/index.js';
import { demoPricing } from './demo-pricing.js';
import { requireKey } from './middleware/auth.js';
import { requestIds } from './middleware/request-id.js';
import { createPricing } from './pricing.js';
import { healthRoutes } from './routes/health.js';
import { itemRoutes } from './routes/items.js';
import { quoteRoutes } from './routes/quotes.js';
import { reservationRoutes } from './routes/reservations.js';
import { createStore, SAMPLE_ITEMS } from './store.js';

/**
 * The Stockroom API as a relay router (see docs/API.md).
 *   items    the starting items (default: SAMPLE_ITEMS)
 *   pricing  the pricing service, a relay router (default: a demo one)
 *   clock    the relay clock used for pricing timeouts and retries (default: the system clock)
 *   keys     the accepted API keys
 */
export function createApp({ items = SAMPLE_ITEMS, pricing = demoPricing(), clock, keys = ['dev-key'] } = {}) {
  const store = createStore(items);
  const prices = createPricing(pricing, clock);
  const router = createRouter().use(requestIds()).use(requireKey(keys));
  healthRoutes(router, clock ? clock.now() : 0);
  itemRoutes(router, store);
  quoteRoutes(router, store, prices);
  reservationRoutes(router, store, prices);
  return router;
}
