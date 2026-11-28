import { fail } from './errors.js';
import { compilePattern, compareRank, matchPattern, segments } from './pattern.js';
import { parseQuery, Request } from './request.js';
import { Response, send } from './response.js';

const METHOD = /^[A-Z]+$/;

function headerPairs(headers) {
  if (headers === undefined || headers === null) return [];
  if (Array.isArray(headers)) return headers.map(([n, v]) => Object.freeze([String(n), String(v)]));
  if (typeof headers === 'object') return Object.entries(headers).map(([n, v]) => Object.freeze([n, String(v)]));
  fail('bad-headers', 'request headers must be an object or an array of [name, value] pairs');
}

async function call(fn, ...args) {
  try {
    const res = await fn(...args);
    if (res instanceof Response) return res;
    return send(500, { error: 'no-response', message: `expected a Response (made with send()), got ${res === undefined ? 'undefined' : typeof res}` });
  } catch (e) {
    return send(500, { error: 'internal', message: String(e?.message ?? e) });
  }
}

export class Router {
  #routes = [];
  #middleware = [];

  /** Adds a middleware: fn(req, next) -> Response; next() -> Promise<Response>. */
  use(fn) {
    if (typeof fn !== 'function') fail('bad-route', 'use() needs a function (req, next) => Response');
    this.#middleware.push(fn);
    return this;
  }

  /** Adds a route: add('GET', '/items/{id:int}', req => send(200, ...)). */
  add(method, pattern, handler) {
    const m = String(method).toUpperCase();
    if (!METHOD.test(m)) fail('bad-route', `bad method ${JSON.stringify(method)}`);
    if (typeof handler !== 'function') fail('bad-route', `the handler for ${m} ${pattern} must be a function`);
    const compiled = compilePattern(pattern);
    if (this.#routes.some((r) => r.method === m && r.compiled.pattern === compiled.pattern)) fail('bad-route', `${m} ${pattern} is already defined`);
    this.#routes.push({ method: m, compiled, handler, order: this.#routes.length });
    return this;
  }

  routes() {
    return this.#routes.map((r) => `${r.method} ${r.compiled.pattern}`);
  }

  #find(method, segs) {
    const hits = [];
    for (const r of this.#routes) {
      const params = matchPattern(r.compiled, segs);
      if (params) hits.push({ route: r, params });
    }
    hits.sort((a, b) => compareRank(a.route.compiled, b.route.compiled) || a.route.order - b.route.order);
    const hit = hits.find((h) => h.route.method === method);
    if (hit) return { hit };
    if (hits.length) return { allow: [...new Set(hits.map((h) => h.route.method))].sort() };
    return {};
  }

  /** Runs one request through the middleware and the matching route. Never rejects. */
  async dispatch(input = {}) {
    const method = String(input.method ?? 'GET').toUpperCase();
    const raw = String(input.path ?? '/');
    const qi = raw.indexOf('?');
    const path = qi < 0 ? raw : raw.slice(0, qi);
    const headers = headerPairs(input.headers);
    let text = '';
    if (typeof input.body === 'string') text = input.body;
    else if (input.body !== undefined) {
      text = JSON.stringify(input.body);
      if (!headers.some(([n]) => n.toLowerCase() === 'content-type')) headers.push(Object.freeze(['content-type', 'application/json']));
    }
    const found = this.#find(method, segments(path));
    const req = new Request({
      method,
      path,
      query: parseQuery(qi < 0 ? '' : raw.slice(qi + 1)),
      params: found.hit ? found.hit.params : Object.freeze({}),
      route: found.hit ? found.hit.route.compiled.pattern : null,
      headers: Object.freeze(headers),
      text,
    });
    const end = () => {
      if (found.hit) return call(found.hit.route.handler, req);
      if (found.allow) return Promise.resolve(send(405, { error: 'method-not-allowed' }, { allow: found.allow.join(', ') }));
      return Promise.resolve(send(404, { error: 'no-route' }));
    };
    const step = (i) => {
      if (i >= this.#middleware.length) return end();
      let downstream = null;
      const next = () => (downstream ??= step(i + 1));
      return call(this.#middleware[i], req, next);
    };
    return step(0);
  }
}

export function createRouter() {
  return new Router();
}
