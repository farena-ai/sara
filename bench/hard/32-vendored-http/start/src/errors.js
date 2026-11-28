import { send } from '../vendor/relay/index.js';

/** An error response: { error: code, ...extra }. */
export function error(status, code, extra = {}) {
  return send(status, { error: code, ...extra });
}
