// When to try an event again, and when to give up on it.
import { fnv1a } from '../util/hash.js';

/** How long to wait before the next attempt. `failures` is how many attempts have failed so far (1 after the first). */
export function backoffDelay(failures, config, id = '') {
  if (!Number.isInteger(failures) || failures < 1) throw new RangeError(`failures must be at least 1 (got ${failures})`);
  const exponential = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** (failures - 1));
  const jitter = config.jitterMs > 0 ? fnv1a(`${id}:${failures}`) % (config.jitterMs + 1) : 0;
  return exponential + jitter;
}

/** What happens to an event after a failed attempt: another try later, or the dead-letter list. */
export function afterFailure(entry, now, config) {
  const attempts = entry.attempts + 1;
  if (attempts >= config.maxAttempts) return { kind: 'dead', attempts };
  return { kind: 'retry', attempts, dueAt: now + backoffDelay(attempts, config, entry.id) };
}
