// relay: in-process HTTP-style routing and a client with timeouts and retries. No sockets: a
// request is a plain object dispatched to a router in the same process.
// See README.md for an overview and docs/API.md for the reference.
export { createClient, Client } from './src/client.js';
export { createClock, systemClock } from './src/clock.js';
export { RelayError } from './src/errors.js';
export { parseQuery, Request } from './src/request.js';
export { Response, send } from './src/response.js';
export { createRouter, Router } from './src/router.js';

export const VERSION = '4.1.0';
