// A small IMAP4rev1 client, from scratch, over a socket Sara holds (BRIDGES3 §5.3). Checked against
// the official text (rfc-editor.org, read 2026-11-01):
//
// - RFC 3501 (IMAP4rev1) and RFC 9051 (IMAP4rev2): tagged commands and untagged "*" responses;
//   §4.3 strings: a literal is "{" number "}" CRLF followed by exactly that many octets (from the
//   server "the CRLF is immediately followed by the octet data"), a quoted string is 7-bit with
//   "\" escaping `"` and `\`; §2.3.1.1 UIDs ascend strictly and "Any change of unique identifiers
//   between sessions MUST be detectable using the UIDVALIDITY mechanism"; §6.4.4 UID SEARCH and
//   "n:*" (which always includes the highest UID, so results are filtered here); §6.4.5 BODY.PEEK
//   doesn't set \Seen; §6.4.6 STORE +FLAGS.SILENT; §5.1.3 mailbox names in modified UTF-7 ("&"
//   shifts to modified BASE64 with "," for "/", "-" shifts back, "&-" is "&").
// - RFC 2177 (IDLE): "clients using IDLE are advised to terminate the IDLE and re-issue it at least
//   every 29 minutes to avoid being logged off." The client sends DONE to end it.
// - RFC 6851 (MOVE): `UID MOVE` when the server lists MOVE.
// - RFC 4616 (SASL PLAIN) and RFC 4959 (SASL-IR) for AUTHENTICATE PLAIN.
//
// The broker guarantees TLS before this code sees the socket (implicit TLS on 993, or STARTTLS done
// by Sara on 143), so a password is never written to a plain connection. A response this parser
// doesn't understand ends the session with a reason (and a reconnect by the caller), never a guess.

export const IDLE_REFRESH_MS = 29 * 60_000;
const LINE_MAX = 64 * 1024;
const LITERAL_MAX = 30 * 1024 * 1024;

export class ImapError extends Error {
  constructor(message, kind = 'protocol') {
    super(message);
    this.kind = kind;
  }
}

/** RFC 3501 §5.1.3 modified UTF-7 for a mailbox name. */
export function mutf7(name) {
  let out = '';
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const b = Buffer.from(buf, 'utf16le');
    // UTF-16 big endian, as UTF-7 wants.
    for (let i = 0; i < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]];
    out += `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    buf = '';
  };
  for (const ch of String(name)) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else buf += ch;
  }
  flush();
  return out;
}

/** A quoted string (RFC 3501 §4.3), or null when it needs a literal (8-bit or CR/LF). */
export function quote(s) {
  const v = String(s);
  if (/[\r\n\0]/.test(v) || /[^\x01-\x7f]/.test(v)) return null;
  return `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/**
 * Tokenises one response (its text with literals already cut out and given as Buffers) into
 * atoms, strings, Buffers, NIL (null) and nested lists.
 */
export function tokenize(segments) {
  const root = [];
  const stack = [root];
  for (const seg of segments) {
    if (Buffer.isBuffer(seg)) {
      stack.at(-1).push(seg);
      continue;
    }
    const s = seg;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ') {
        i++;
        continue;
      }
      if (ch === '(') {
        const l = [];
        stack.at(-1).push(l);
        stack.push(l);
        i++;
        continue;
      }
      if (ch === ')') {
        if (stack.length === 1) throw new ImapError('an unmatched ")" from the server');
        stack.pop();
        i++;
        continue;
      }
      if (ch === '"') {
        let v = '';
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) i++;
          v += s[i++];
        }
        if (s[i] !== '"') throw new ImapError('an unterminated quoted string from the server');
        i++;
        stack.at(-1).push(v);
        continue;
      }
      // An atom; a section in brackets ("BODY[HEADER]", "[UIDVALIDITY 3]") is kept whole.
      let v = '';
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (depth <= 0 && (c === ' ' || c === '(' || c === ')')) break;
        v += c;
        i++;
      }
      stack.at(-1).push(v.toUpperCase() === 'NIL' ? null : v);
    }
  }
  if (stack.length !== 1) throw new ImapError('an unclosed "(" from the server');
  return root;
}

/** `FETCH (UID 5 FLAGS (\Seen) RFC822.SIZE 9 BODY[HEADER] <bytes>)` → { uid, flags, size, header, body }. */
export function fetchData(list) {
  const out = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = String(list[i] ?? '').toUpperCase();
    const v = list[i + 1];
    if (k === 'UID') out.uid = Number(v);
    else if (k === 'FLAGS') out.flags = Array.isArray(v) ? v.map(String) : [];
    else if (k === 'RFC822.SIZE') out.size = Number(v);
    else if (k.startsWith('BODY[HEADER')) out.header = Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'latin1');
    else if (k === 'BODY[]' || k.startsWith('BODY[]<')) out.body = Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'latin1');
  }
  return out;
}

/** The IMAP session on one socket. `clock` is injectable (tests drive IDLE's 29 minutes with a fake one). */
export class Imap {
  /** `greeting`: Sara already read it while doing STARTTLS (port 143); CAPABILITY must be asked again (RFC 3501 §6.2.1). */
  constructor(sock, { clock = { setTimeout, clearTimeout }, log = () => {}, greeting = null } = {}) {
    this.sock = sock;
    this.clock = clock;
    this.log = log;
    this.buf = Buffer.alloc(0);
    this.segments = [];
    this.need = 0;
    this.seq = 0;
    this.waiting = null; // { tag, untagged, resolve, reject }
    this.onContinue = null;
    this.onUntagged = null;
    this.greeting = null;
    this.greeted = null;
    this.caps = new Set();
    this.closed = null;
    this.mailbox = {};
    this.idling = null;
    this.greetingPromise = new Promise((res, rej) => (this.greeted = { res, rej }));
    if (greeting) {
      this.greeting = String(greeting);
      this.greeted.res(this.greeting);
    }
    sock.onData((b) => this.#data(b));
    sock.onClose((why) => this.#close(why));
  }

  #close(why) {
    if (this.closed) return;
    this.closed = String(why ?? 'closed');
    const err = new ImapError(`the connection closed (${this.closed})`, 'closed');
    this.greeted?.rej(err);
    this.waiting?.reject(err);
    this.waiting = null;
    this.idling?.end?.(err);
  }

  #fail(why) {
    this.log(`IMAP: ${why}; reconnecting`);
    void this.sock.close().catch?.(() => {});
    this.#close(why);
  }

  #data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    try {
      for (;;) {
        if (this.need > 0) {
          if (this.buf.length < this.need) return;
          this.segments.push(this.buf.subarray(0, this.need));
          this.buf = this.buf.subarray(this.need);
          this.need = 0;
          continue;
        }
        const nl = this.buf.indexOf('\r\n');
        if (nl < 0) {
          if (this.buf.length > LINE_MAX) throw new ImapError('a line from the server is too long');
          return;
        }
        const line = this.buf.subarray(0, nl).toString('latin1');
        this.buf = this.buf.subarray(nl + 2);
        const lit = /\{(\d{1,10})\+?\}$/.exec(line);
        if (lit) {
          const n = Number(lit[1]);
          if (n > LITERAL_MAX) throw new ImapError('a literal over 30 MB from the server');
          this.segments.push(line.slice(0, lit.index));
          this.need = n;
          if (n === 0) this.segments.push(Buffer.alloc(0));
          continue;
        }
        this.segments.push(line);
        const segs = this.segments;
        this.segments = [];
        this.#response(segs);
      }
    } catch (err) {
      this.#fail(err.message);
    }
  }

  #response(segs) {
    const first = typeof segs[0] === 'string' ? segs[0] : '';
    if (first.startsWith('+')) {
      const fn = this.onContinue;
      this.onContinue = null;
      fn?.(first.slice(1).trim());
      return;
    }
    if (first.startsWith('* ')) {
      const text = segs.filter((x) => typeof x === 'string').join(' ');
      const u = { text, segs };
      if (!this.greeting) {
        this.greeting = first;
        if (/^\* (OK|PREAUTH)\b/i.test(first)) this.greeted.res(first);
        else this.greeted.rej(new ImapError(`the server refused the connection (${first.slice(0, 120)})`, 'refused'));
        this.#caps(first);
        return;
      }
      if (/^\* BYE\b/i.test(first)) this.log(`IMAP: the server said ${first.slice(0, 160)}`);
      this.#caps(first);
      this.#mailboxInfo(first);
      if (this.waiting) this.waiting.untagged.push(u);
      this.onUntagged?.(u);
      return;
    }
    const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/i.exec(first);
    if (!m) throw new ImapError(`a response this client doesn't understand (${first.slice(0, 80)})`);
    const w = this.waiting;
    if (!w || w.tag !== m[1]) throw new ImapError(`a reply to a command that wasn't sent (${m[1].slice(0, 20)})`);
    this.waiting = null;
    this.#caps(first);
    w.resolve({ status: m[2].toUpperCase(), text: m[3], untagged: w.untagged });
  }

  #caps(line) {
    const m = /\[CAPABILITY ([^\]]*)\]/i.exec(line) ?? /^\* CAPABILITY (.*)$/i.exec(line);
    if (m) this.caps = new Set(m[1].toUpperCase().split(/\s+/).filter(Boolean));
  }

  #mailboxInfo(line) {
    let m;
    if ((m = /\[UIDVALIDITY (\d+)\]/i.exec(line))) this.mailbox.uidvalidity = Number(m[1]);
    if ((m = /\[UIDNEXT (\d+)\]/i.exec(line))) this.mailbox.uidnext = Number(m[1]);
    if ((m = /^\* (\d+) EXISTS/i.exec(line))) this.mailbox.exists = Number(m[1]);
  }

  /** Sends one command and waits for its tagged reply (60 s, or `ms`). NO and BAD reject. */
  async command(text, { ms = 60_000, allowNo = false } = {}) {
    if (this.closed) throw new ImapError(`the connection is closed (${this.closed})`, 'closed');
    if (this.waiting) throw new ImapError('a command is already running');
    const tag = `s${++this.seq}`;
    const done = new Promise((resolve, reject) => (this.waiting = { tag, untagged: [], resolve, reject }));
    await this.sock.write(Buffer.from(`${tag} ${text}\r\n`, 'latin1'));
    let timer;
    const r = await Promise.race([
      done,
      new Promise((_, rej) => (timer = this.clock.setTimeout(() => rej(new ImapError(`no answer to ${text.split(' ')[0]} within ${Math.round(ms / 1000)} s`, 'timeout')), ms))),
    ]).finally(() => this.clock.clearTimeout(timer));
    if (r.status !== 'OK' && !allowNo) throw new ImapError(`${text.split(' ')[0]} failed: ${r.text.slice(0, 200)}`, r.status === 'NO' ? 'no' : 'bad');
    return r;
  }

  async capability() {
    await this.command('CAPABILITY');
    return this.caps;
  }

  /** AUTHENTICATE PLAIN (SASL-IR when offered), else LOGIN. Throws kind 'auth' when refused. */
  async login(user, pass) {
    if (!this.caps.size || !this.caps.has('IMAP4REV1')) await this.capability().catch(() => this.caps);
    const plain = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
    let r;
    if (this.caps.has('AUTH=PLAIN')) {
      if (this.caps.has('SASL-IR')) r = await this.command(`AUTHENTICATE PLAIN ${plain}`, { allowNo: true });
      else {
        const cont = new Promise((res) => (this.onContinue = res));
        const tag = `s${this.seq + 1}`;
        const p = this.command('AUTHENTICATE PLAIN', { allowNo: true });
        await cont;
        await this.sock.write(Buffer.from(`${plain}\r\n`, 'latin1'));
        r = await p;
        void tag;
      }
    } else if (!this.caps.has('LOGINDISABLED')) {
      const u = quote(user);
      const pw = quote(pass);
      if (!u || !pw) throw new ImapError('the sign-in name or password has characters only AUTHENTICATE can carry, and the server lacks it', 'auth');
      r = await this.command(`LOGIN ${u} ${pw}`, { allowNo: true });
    } else throw new ImapError('the server offers no sign-in this client can use', 'auth');
    if (r.status !== 'OK') throw new ImapError(`the mail server refused the password (${r.text.slice(0, 120)})`, 'auth');
    // Capabilities often change after signing in.
    if (!/\[CAPABILITY /i.test(r.text)) await this.capability().catch(() => {});
  }

  async select(folder) {
    this.mailbox = {};
    await this.command(`SELECT ${quote(mutf7(folder || 'INBOX')) ?? '"INBOX"'}`);
    return { ...this.mailbox };
  }

  /** UIDs above `last` (RFC 3501 §6.4.4: "n:*" also returns the highest UID, so filtered). */
  async newUids(last) {
    const r = await this.command(`UID SEARCH UID ${last + 1}:*`);
    const out = [];
    for (const u of r.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(u.text);
      if (m) for (const n of m[1].trim().split(/\s+/).filter(Boolean)) if (Number(n) > last) out.push(Number(n));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  async #fetchOne(uid, items) {
    const r = await this.command(`UID FETCH ${uid} (${items})`, { ms: 180_000 });
    for (const u of r.untagged) {
      if (!/^\* \d+ FETCH /i.test(typeof u.segs[0] === 'string' ? u.segs[0] : '')) continue;
      const toks = tokenize(u.segs);
      const list = toks.find((t) => Array.isArray(t));
      if (!list) continue;
      const d = fetchData(list);
      if (d.uid === uid || (d.uid === undefined && r.untagged.length === 1)) return d;
    }
    return null;
  }

  /** Headers first (§5.3 step 4): flags, size and the header block, without setting \Seen. */
  headers(uid) {
    return this.#fetchOne(uid, 'UID FLAGS RFC822.SIZE BODY.PEEK[HEADER]');
  }

  /** The whole message, without setting \Seen. */
  full(uid) {
    return this.#fetchOne(uid, 'UID BODY.PEEK[]');
  }

  async markSeen(uid) {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`, { allowNo: true });
  }

  async move(uid, folder) {
    if (!this.caps.has('MOVE') || !folder) return false;
    const r = await this.command(`UID MOVE ${uid} ${quote(mutf7(folder)) ?? '"INBOX"'}`, { allowNo: true });
    return r.status === 'OK';
  }

  async noop() {
    await this.command('NOOP');
  }

  /**
   * IDLE until new mail (`* n EXISTS`) or `refreshMs` (29 minutes, RFC 2177), then DONE. Resolves
   * 'mail' or 'refresh'. Needs the IDLE capability.
   */
  idle(refreshMs = IDLE_REFRESH_MS) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer;
      let sentDone = false;
      const before = this.mailbox.exists ?? 0;
      let why = 'refresh';
      const stop = () => {
        if (sentDone) return;
        sentDone = true;
        this.clock.clearTimeout(timer);
        void this.sock.write(Buffer.from('DONE\r\n', 'latin1')).catch(() => {});
      };
      this.idling = {
        end: (err) => {
          if (finished) return;
          finished = true;
          this.clock.clearTimeout(timer);
          this.idling = null;
          this.onUntagged = null;
          reject(err);
        },
      };
      this.onUntagged = (u) => {
        if (/^\* \d+ (EXISTS|RECENT)\b/i.test(u.text) && (this.mailbox.exists ?? 0) >= before) {
          why = 'mail';
          stop();
        }
      };
      const p = this.command('IDLE', { ms: refreshMs + 120_000 });
      timer = this.clock.setTimeout(() => {
        why = 'refresh';
        stop();
      }, refreshMs);
      p.then(
        () => {
          if (finished) return;
          finished = true;
          this.idling = null;
          this.onUntagged = null;
          resolve(why);
        },
        (err) => this.idling?.end(err),
      );
    });
  }

  async logout() {
    await this.command('LOGOUT', { ms: 5000, allowNo: true }).catch(() => {});
  }
}
