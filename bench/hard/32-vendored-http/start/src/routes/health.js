import { send } from '../../vendor/relay/index.js';

export function healthRoutes(router, startedAt) {
  router.add('GET', '/health', () => send(200, { ok: true, since: startedAt }));
}
