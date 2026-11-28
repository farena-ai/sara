function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** 'a=1&a=2&b' -> { a: ['1', '2'], b: [''] }. Every value is an array of strings. */
export function parseQuery(qs) {
  const out = {};
  if (!qs) return Object.freeze(out);
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const key = decode(i < 0 ? part : part.slice(0, i));
    const value = i < 0 ? '' : decode(part.slice(i + 1));
    if (Object.hasOwn(out, key)) out[key].push(value);
    else Object.defineProperty(out, key, { value: [value], enumerable: true, writable: true, configurable: true });
  }
  for (const key of Object.keys(out)) Object.freeze(out[key]);
  return Object.freeze(out);
}

/** The request a middleware or handler receives. */
export class Request {
  constructor({ method, path, query, params, route, headers, text }) {
    this.method = method;
    this.path = path;
    this.query = query;
    this.params = params;
    this.route = route;
    this.headers = headers;
    this.text = text;
    this.state = {};
    Object.freeze(this);
  }

  /** The value of a header, matched without regard to case; repeated headers are joined with ", ". */
  header(name) {
    const wanted = String(name).toLowerCase();
    const values = this.headers.filter(([n]) => n.toLowerCase() === wanted).map(([, v]) => v);
    return values.length ? values.join(', ') : null;
  }

  /** Parses the body as JSON. Never throws: { ok: true, value } or { ok: false, error }. */
  json() {
    if (this.text.trim() === '') return { ok: false, error: 'empty' };
    try {
      return { ok: true, value: JSON.parse(this.text) };
    } catch {
      return { ok: false, error: 'invalid' };
    }
  }
}
