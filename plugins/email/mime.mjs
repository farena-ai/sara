// MIME and the message format, read and written from scratch (no dependencies). Checked against the
// official text of the RFCs (rfc-editor.org, read 2026-11-01):
//
// - RFC 5322 (Internet Message Format): §2.2.3 unfolding (a CRLF followed by WSP is removed), §3.4
//   addresses (display-name, angle-addr, groups, quoted strings, comments), §3.6.4 Message-ID,
//   In-Reply-To, References (msg-id = "<" id-left "@" id-right ">").
// - RFC 2045 (MIME part one): §5 Content-Type parameters, §6.7 quoted-printable (`=XX`, soft line
//   breaks `=` at the end of a line, encoded lines at most 76 characters), §6.8 base64.
// - RFC 2046 (media types): multipart boundaries (`--boundary`, the closing `--boundary--`),
//   message/rfc822.
// - RFC 2047 (encoded words): `=?charset?B|Q?text?=`, at most 75 characters each; §4.2 the Q form
//   ("_" is a space); §6.2 white space between two adjacent encoded words is ignored, and encoded
//   words are decoded only AFTER a structured field (an address) is parsed into tokens, so an encoded
//   "<" or "@" can never change who a mail is from.
// - RFC 2231 (parameter value continuations and charsets): `name*0=`, `name*1*=`, `name*=utf-8'en'%E2%82%AC`.
// - RFC 2183 (Content-Disposition): inline / attachment, `filename`.
//
// Limits (BRIDGES3 §5.4): multipart walked to a depth of 10 and at most 100 parts.

export const MAX_DEPTH = 10;
export const MAX_PARTS = 100;

const CRLF = '\r\n';

// ------------------------------------------------------------------ headers

/** Splits raw bytes into the header block and the body (at the first empty line). */
export function splitMessage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  let i = b.indexOf('\r\n\r\n');
  let skip = 4;
  const j = b.indexOf('\n\n');
  if (i < 0 || (j >= 0 && j < i)) {
    i = j;
    skip = 2;
  }
  if (i < 0) return { head: bytesToText(b), body: Buffer.alloc(0) };
  return { head: bytesToText(b.subarray(0, i)), body: b.subarray(i + skip) };
}

/** Header bytes: UTF-8 when valid (RFC 6532 allows it), otherwise Latin-1 (never lost). */
function bytesToText(b) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return b.toString('latin1');
  }
}

/**
 * Parses a header block. RFC 5322 §2.2.3: "unfolding is accomplished by simply removing any CRLF
 * that is immediately followed by WSP". Returns a list in order (the topmost first) with helpers.
 */
export function parseHeaders(text) {
  const list = [];
  const unfolded = String(text).replace(/\r?\n(?=[ \t])/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    list.push([name, line.slice(c + 1).trim()]);
    if (list.length >= 1000) break;
  }
  return headerSet(list);
}

function headerSet(list) {
  return {
    list,
    get: (n) => list.find((h) => h[0] === n)?.[1],
    all: (n) => list.filter((h) => h[0] === n).map((h) => h[1]),
    has: (n) => list.some((h) => h[0] === n),
  };
}

// ------------------------------------------------------------------ RFC 2047 encoded words

const WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/** Decodes encoded words in unstructured text (a subject, a display name already parsed out). */
export function decodeWords(s) {
  const str = String(s ?? '');
  if (!str.includes('=?')) return str;
  // §6.2: linear white space between two adjacent encoded words is ignored.
  const joined = str.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, '$1');
  return joined.replace(WORD, (all, cs, enc, txt) => {
    try {
      const charset = String(cs).split('*')[0]; // RFC 2231 §5: charset*language
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qWord(txt);
      return decodeCharset(bytes, charset).text;
    } catch {
      return all;
    }
  });
}

function qWord(txt) {
  // RFC 2047 §4.2: "_" is a space; "=XX" an octet.
  const out = [];
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (ch === '_') out.push(0x20);
    else if (ch === '=' && /^[0-9a-f]{2}$/i.test(txt.slice(i + 1, i + 3))) {
      out.push(parseInt(txt.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/** Bytes in a charset → text. An unknown charset falls back to UTF-8 and says so (`note`). */
export function decodeCharset(bytes, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '') || 'utf-8';
  const label = cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs === 'utf8' ? 'utf-8' : cs;
  try {
    return { text: new TextDecoder(label).decode(bytes) };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), note: `unknown charset ${cs.slice(0, 40)}` };
  }
}

// ------------------------------------------------------------------ parameters (RFC 2045 §5.1, RFC 2231)

/** `type/sub; a=b; c="d e"` → `{ value: 'type/sub', params: { a: 'b', c: 'd e' } }`, with RFC 2231. */
export function parseParams(v) {
  const s = String(v ?? '');
  const parts = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q && ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      continue;
    }
    if (ch === '"') {
      q = !q;
      cur += ch;
      continue;
    }
    if (ch === ';' && !q) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const value = stripComments(parts.shift() ?? '').trim().toLowerCase();
  const raw = {};
  for (const p of parts) {
    const e = p.indexOf('=');
    if (e <= 0) continue;
    const k = p.slice(0, e).trim().toLowerCase();
    let val = p.slice(e + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    if (k) raw[k] = val;
  }
  // RFC 2231 §3 continuations (name*0, name*1, …) and §4 charset'language'%XX values (name*, name*0*).
  const params = {};
  const groups = {};
  for (const [k, val] of Object.entries(raw)) {
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(k);
    if (!m) continue;
    const [, name, n, star] = m;
    if (n === undefined && !star) {
      params[name] ??= val;
      continue;
    }
    (groups[name] ??= []).push({ n: Number(n ?? 0), val, star: Boolean(star) });
  }
  for (const [name, segs] of Object.entries(groups)) {
    segs.sort((a, b) => a.n - b.n);
    let charset = 'utf-8';
    const bytes = [];
    for (const [i, seg] of segs.entries()) {
      let val = seg.val;
      if (seg.star) {
        if (i === 0) {
          const q1 = val.indexOf("'");
          const q2 = q1 >= 0 ? val.indexOf("'", q1 + 1) : -1;
          if (q2 > q1) {
            charset = val.slice(0, q1) || 'utf-8';
            val = val.slice(q2 + 1);
          }
        }
        bytes.push(Buffer.from(val.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'));
      } else bytes.push(Buffer.from(val, 'latin1'));
    }
    params[name] = decodeCharset(Buffer.concat(bytes), charset).text;
  }
  return { value, params };
}

function stripComments(s) {
  let out = '';
  let depth = 0;
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      if (!depth) out += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '"' && !depth) q = !q;
    if (!q && ch === '(') {
      depth++;
      continue;
    }
    if (!q && ch === ')' && depth) {
      depth--;
      continue;
    }
    if (!depth) out += ch;
  }
  return out;
}

// ------------------------------------------------------------------ addresses (RFC 5322 §3.4)

/**
 * `"Alex B." <alex@example.com>, bob@example.org, team: a@x.y, b@x.y;` → [{ name, address }].
 * Display names are decoded (RFC 2047) only after the list is split, so an encoded "<" or "," in a
 * name can't add or change an address (§6.2). Addresses are lower-cased; an address without an
 * "@" is dropped.
 */
export function parseAddresses(v) {
  const s = stripComments(String(v ?? '')).replace(/\r?\n/g, ' ');
  const out = [];
  let cur = '';
  let q = false;
  let angle = false;
  const push = () => {
    const t = cur.trim();
    cur = '';
    if (!t) return;
    const g = t.indexOf(':');
    const a = t.indexOf('<');
    const body = !t.startsWith('"') && g >= 0 && (a < 0 || g < a) ? t.slice(g + 1) : t; // a group's name
    const m = /^(.*?)<([^<>]*)>\s*$/.exec(body);
    let name = '';
    let addr = '';
    if (m) {
      name = m[1].trim();
      addr = m[2].trim();
    } else addr = body.trim();
    addr = addr.replace(/^mailto:/i, '').trim().toLowerCase();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/.test(addr)) return;
    out.push({ name: decodeWords(name).trim(), address: addr });
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && q && i + 1 < s.length) {
      cur += ch + s[++i];
      continue;
    }
    if (ch === '"') q = !q;
    else if (!q && ch === '<') angle = true;
    else if (!q && ch === '>') angle = false;
    if (!q && !angle && (ch === ',' || ch === ';')) {
      push();
      continue;
    }
    cur += ch;
    if (out.length >= 200) break;
  }
  push();
  return out;
}

/** The msg-ids in a header (RFC 5322 §3.6.4): `<a@b> <c@d>` → ['<a@b>', '<c@d>']. */
export function msgIds(v) {
  return [...stripComments(String(v ?? '')).matchAll(/<([^<>\s]{1,250})>/g)].map((m) => `<${m[1]}>`).slice(0, 100);
}

export const domainOf = (address) => String(address ?? '').split('@').pop().toLowerCase();

// ------------------------------------------------------------------ bodies

/** RFC 2045 §6.7: quoted-printable to bytes ("=" at a line's end is a soft line break). */
export function decodeQP(input) {
  const s = Buffer.isBuffer(input) ? input.toString('latin1') : String(input);
  const out = [];
  const lines = s.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].replace(/[ \t]+$/, ''); // rule 3: trailing white space is removed
    let soft = false;
    if (line.endsWith('=')) {
      soft = true;
      line = line.slice(0, -1);
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '=' && /^[0-9a-f]{2}$/i.test(line.slice(i + 1, i + 3))) {
        out.push(parseInt(line.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(line.charCodeAt(i) & 0xff);
    }
    if (!soft && li < lines.length - 1) out.push(0x0d, 0x0a);
  }
  return Buffer.from(out);
}

function decodeBody(body, cte) {
  const enc = String(cte ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQP(body);
  return body;
}

/**
 * One MIME entity → `{ headers, type, params, disposition, filename, contentId, body, parts, message }`.
 * `body` is the decoded bytes of a leaf; `parts` the children of a multipart; `message` the parsed
 * mail inside a message/rfc822 part (a forwarded mail).
 */
export function parseMime(raw, depth = 0, counter = { n: 0 }) {
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const ct = parseParams(headers.get('content-type') ?? 'text/plain; charset=us-ascii');
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(ct.value) ? ct.value : 'text/plain';
  const cd = parseParams(headers.get('content-disposition') ?? '');
  const filename = decodeWords(cd.params.filename ?? ct.params.name ?? '');
  const node = { headers, type, params: ct.params, disposition: cd.value || '', filename, contentId: headers.get('content-id') ?? '', body: Buffer.alloc(0), parts: [], message: null, size: body.length };
  counter.n++;
  if (type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    for (const chunk of splitMultipart(body, ct.params.boundary)) {
      if (counter.n >= MAX_PARTS) break;
      node.parts.push(parseMime(chunk, depth + 1, counter));
    }
    return node;
  }
  node.body = decodeBody(body, headers.get('content-transfer-encoding'));
  if (type === 'message/rfc822' && depth < MAX_DEPTH) node.message = parseMime(node.body, depth + 1, counter);
  return node;
}

/** RFC 2046 §5.1.1: the parts between `--boundary` lines, up to `--boundary--`. */
function splitMultipart(body, boundary) {
  const s = body.toString('latin1');
  const delim = `--${boundary}`;
  const out = [];
  let pos = s.startsWith(delim) ? 0 : s.indexOf(`\n${delim}`);
  if (pos < 0) return out;
  if (pos > 0) pos += 1;
  for (;;) {
    let start = pos + delim.length;
    if (s.startsWith('--', start)) break; // the close delimiter
    const eol = s.indexOf('\n', start);
    if (eol < 0) break;
    start = eol + 1;
    const next = s.indexOf(`\n${delim}`, start);
    const end = next < 0 ? s.length : next;
    let chunk = s.slice(start, end);
    if (chunk.endsWith('\r')) chunk = chunk.slice(0, -1);
    out.push(Buffer.from(chunk, 'latin1'));
    if (next < 0 || out.length >= MAX_PARTS) break;
    pos = next + 1;
  }
  return out;
}

/** The text of a leaf part in its charset. */
export function partText(node) {
  return decodeCharset(node.body, node.params.charset ?? 'utf-8');
}

/** Every leaf, depth first (message/rfc822 parts are leaves here; read them through `.message`). */
export function leaves(node, out = []) {
  if (node.parts.length) for (const p of node.parts) leaves(p, out);
  else out.push(node);
  return out;
}

// ------------------------------------------------------------------ writing

/** RFC 2047 B encoding for a header word that isn't plain ASCII (each word ≤ 75 characters). */
export function encodeWord(s) {
  const str = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  const words = [];
  let chunk = '';
  for (const ch of str) {
    const next = chunk + ch;
    if (Buffer.byteLength(next, 'utf8') > 45) {
      words.push(chunk);
      chunk = ch;
    } else chunk = next;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** RFC 2045 §6.7 quoted-printable for text (CRLF line breaks; encoded lines ≤ 76 characters). */
export function encodeQP(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let tok = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (tok === '.' && cur === '') tok = '=2E'; // a line never starts with "." (no dot-stuffing surprises)
      if (cur.length + tok.length > 75) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join(CRLF);
}

const b64Lines = (buf) => (Buffer.from(buf).toString('base64').match(/.{1,76}/g) ?? ['']).join(CRLF);

function fileParam(name) {
  const n = String(name || 'file').replace(/[\r\n"\\]/g, '_').slice(0, 120);
  if (/^[\x20-\x7e]*$/.test(n)) return `filename="${n}"`;
  return `filename*=utf-8''${encodeURIComponent(n).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * A plain-text mail (RFC 5322 + MIME): `{ from: {name, address}, to, subject, date, messageId,
 * inReplyTo?, references?, text, files?: [{name, mime, data}], headers?: [[name, value]] }` → bytes.
 * No HTML part (§5.8). With files: multipart/mixed, the text first.
 */
export function buildMessage(m) {
  const addr = (a) => (a.name ? `${/^[\w .'-]*$/.test(a.name) ? `"${a.name.replace(/"/g, '')}"` : encodeWord(a.name)} <${a.address}>` : `<${a.address}>`);
  const h = [
    ['From', addr(m.from)],
    ['To', addr(m.to)],
    ['Subject', encodeWord(m.subject ?? '')],
    ['Date', rfcDate(m.date ?? new Date())],
    ['Message-ID', m.messageId],
    ...(m.inReplyTo ? [['In-Reply-To', m.inReplyTo]] : []),
    ...(m.references?.length ? [['References', m.references.join(`${CRLF} `)]] : []),
    ['MIME-Version', '1.0'],
    ...(m.headers ?? []),
  ];
  const textPart = [['Content-Type', 'text/plain; charset=UTF-8'], ['Content-Transfer-Encoding', 'quoted-printable']];
  const head = (list) => list.map(([k, v]) => `${k}: ${v}`).join(CRLF);
  if (!m.files?.length) return Buffer.from(`${head([...h, ...textPart])}${CRLF}${CRLF}${encodeQP(m.text ?? '')}${CRLF}`, 'utf8');
  const boundary = `=_sara_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  let body = `${head([...h, ['Content-Type', `multipart/mixed; boundary="${boundary}"`]])}${CRLF}${CRLF}This is a multi-part message in MIME format.${CRLF}`;
  body += `--${boundary}${CRLF}${head(textPart)}${CRLF}${CRLF}${encodeQP(m.text ?? '')}${CRLF}`;
  for (const f of m.files) {
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(f.mime ?? '') ? f.mime : 'application/octet-stream';
    body += `--${boundary}${CRLF}Content-Type: ${mime}${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-Disposition: attachment; ${fileParam(f.name)}${CRLF}${CRLF}${b64Lines(f.data)}${CRLF}`;
  }
  body += `--${boundary}--${CRLF}`;
  return Buffer.from(body, 'utf8');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** RFC 5322 §3.3 date-time, in UTC (`Sun, 01 Nov 2026 16:42:00 +0000`). */
export function rfcDate(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[t.getUTCDay()]}, ${p(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())} +0000`;
}
