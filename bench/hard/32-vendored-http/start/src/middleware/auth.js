import { error } from '../errors.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Writes need a valid X-Api-Key header; reads are open. */
export function requireKey(keys) {
  return async (req, next) => {
    if (!WRITES.has(req.method)) return next();
    const key = req.headers['x-api-key'];
    if (!key || !keys.includes(key)) return error(401, 'unauthorized');
    next();
  };
}
