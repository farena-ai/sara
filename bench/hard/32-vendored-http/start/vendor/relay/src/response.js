import { fail } from './errors.js';

/** Lower-cases header names and checks values (strings, or numbers turned into strings). */
export function normalizeHeaders(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) fail('bad-headers', 'headers must be an object of name -> value');
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' && typeof value !== 'number') fail('bad-headers', `header "${name}" must be a string or a number`);
    out[name.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * A finished response. Immutable: withHeaders() returns a new one. `body` is the value as it would
 * arrive on the other side: parsed JSON for JSON bodies, the string for text, undefined for none.
 */
export class Response {
  #status;
  #body;
  #text;
  #headers;

  /** @internal Use send(). */
  constructor(status, body, text, headers) {
    this.#status = status;
    this.#body = body;
    this.#text = text;
    this.#headers = Object.freeze({ ...headers });
    Object.freeze(this);
  }

  get status() {
    return this.#status;
  }

  get body() {
    return this.#body;
  }

  /** The body as sent on the wire ('' when there is none). */
  get text() {
    return this.#text;
  }

  get headers() {
    return this.#headers;
  }

  header(name) {
    return this.#headers[String(name).toLowerCase()] ?? null;
  }

  get ok() {
    return this.#status >= 200 && this.#status < 300;
  }

  withHeaders(extra) {
    return new Response(this.#status, this.#body, this.#text, { ...this.#headers, ...normalizeHeaders(extra) });
  }

  toJSON() {
    return { status: this.#status, headers: this.#headers, body: this.#body };
  }
}

/** Builds a response: send(status, body?, headers?). */
export function send(status, body, headers = {}) {
  if (!Number.isInteger(status) || status < 100 || status > 599) fail('bad-status', `status must be an integer from 100 to 599, got ${JSON.stringify(status)}`);
  const h = normalizeHeaders(headers);
  if (body === undefined) return new Response(status, undefined, '', h);
  if (status === 204 || status === 304) fail('bad-body', `a ${status} response cannot have a body`);
  if (typeof body === 'string') {
    h['content-type'] ??= 'text/plain; charset=utf-8';
    return new Response(status, body, body, h);
  }
  let text;
  try {
    text = JSON.stringify(body);
  } catch (e) {
    fail('bad-body', `the body cannot be sent as JSON: ${e.message}`);
  }
  if (text === undefined) fail('bad-body', 'the body cannot be sent as JSON');
  h['content-type'] ??= 'application/json';
  return new Response(status, JSON.parse(text), text, h);
}
