import { systemClock } from './clock.js';
import { fail, RelayError } from './errors.js';
import { normalizeHeaders } from './response.js';

const CLIENT_KEYS = ['headers', 'timeout', 'retry', 'clock'];
const CALL_KEYS = ['method', 'path', 'body', 'headers', 'timeout', 'retry'];
const RETRY_KEYS = ['attempts', 'delay', 'statuses'];
const DEFAULT_RETRY = Object.freeze({ attempts: 1, delay: 0, statuses: Object.freeze([]) });

function checkKeys(obj, allowed, what) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail('bad-option', `${what} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail('bad-option', `unknown ${what} "${k}"; known: ${allowed.join(', ')}`);
}

function checkTimeout(t) {
  if (typeof t !== 'number' || !(t >= 0) || t === Infinity) fail('bad-option', `timeout is a number of seconds >= 0 (0 = no timeout), got ${JSON.stringify(t)}`);
  return t;
}

function checkRetry(retry, base) {
  checkKeys(retry, RETRY_KEYS, 'retry option');
  const out = { ...base, ...retry };
  if (!Number.isInteger(out.attempts) || out.attempts < 1) fail('bad-option', `retry.attempts is the total number of attempts (an integer >= 1), got ${JSON.stringify(out.attempts)}`);
  if (typeof out.delay !== 'number' || !(out.delay >= 0) || out.delay === Infinity) fail('bad-option', `retry.delay is a number of seconds >= 0, got ${JSON.stringify(out.delay)}`);
  if (!Array.isArray(out.statuses) || !out.statuses.every((s) => Number.isInteger(s))) fail('bad-option', 'retry.statuses must be an array of status codes');
  return Object.freeze({ attempts: out.attempts, delay: out.delay, statuses: Object.freeze([...out.statuses]) });
}

export class Client {
  #target;
  #headers;
  #timeout;
  #retry;
  #clock;

  constructor(target, options = {}) {
    if (!target || typeof target.dispatch !== 'function') fail('bad-option', 'createClient() needs a target with a dispatch() method (a router)');
    checkKeys(options, CLIENT_KEYS, 'client option');
    this.#target = target;
    this.#headers = normalizeHeaders(options.headers ?? {});
    this.#timeout = checkTimeout(options.timeout ?? 30);
    this.#retry = options.retry === undefined ? DEFAULT_RETRY : checkRetry(options.retry, DEFAULT_RETRY);
    this.#clock = options.clock ?? systemClock;
    if (typeof this.#clock.timer !== 'function' || typeof this.#clock.sleep !== 'function') fail('bad-option', 'clock must be a relay clock (createClock() or systemClock)');
  }

  async #attempt(request, timeout) {
    const pending = Promise.resolve().then(() => this.#target.dispatch(request));
    const settled = pending.then(
      (res) => ({ res }),
      (e) => ({ error: new RelayError('failed', String(e?.message ?? e)) }),
    );
    if (timeout === 0) {
      const r = await settled;
      return r.error ? [r.error, null] : [null, r.res];
    }
    const t = this.#clock.timer(timeout);
    const r = await Promise.race([settled, t.promise.then(() => ({ timedOut: true }))]);
    t.cancel();
    if (r.timedOut) return [new RelayError('timeout', `no response within ${timeout} s`), null];
    return r.error ? [r.error, null] : [null, r.res];
  }

  /**
   * Sends a request: { method, path, body, headers, timeout, retry }. Resolves to [error, response]:
   * error is a RelayError ('timeout' or 'failed') when the last attempt got no response; any
   * response, whatever its status, comes back as [null, response].
   */
  async request(spec) {
    checkKeys(spec, CALL_KEYS, 'request option');
    const timeout = spec.timeout === undefined ? this.#timeout : checkTimeout(spec.timeout);
    const retry = spec.retry === undefined ? this.#retry : checkRetry(spec.retry, this.#retry);
    const request = {
      method: String(spec.method ?? 'GET').toUpperCase(),
      path: spec.path ?? '/',
      headers: { ...this.#headers, ...normalizeHeaders(spec.headers ?? {}) },
      body: spec.body,
    };
    for (let attempt = 1; ; attempt++) {
      const [error, res] = await this.#attempt(request, timeout);
      const again = error ? true : retry.statuses.includes(res.status);
      if (!again || attempt >= retry.attempts) return [error, res];
      if (retry.delay > 0) await this.#clock.sleep(retry.delay);
    }
  }

  get(path, options = {}) {
    return this.request({ ...options, method: 'GET', path });
  }

  delete(path, options = {}) {
    return this.request({ ...options, method: 'DELETE', path });
  }

  post(path, body, options = {}) {
    return this.request({ ...options, method: 'POST', path, body });
  }

  put(path, body, options = {}) {
    return this.request({ ...options, method: 'PUT', path, body });
  }

  patch(path, body, options = {}) {
    return this.request({ ...options, method: 'PATCH', path, body });
  }
}

export function createClient(target, options) {
  return new Client(target, options);
}
