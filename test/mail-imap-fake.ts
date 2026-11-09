// A stand-in IMAP server with folders for the M1 inbox tests (the email bridge's test/mail-fake.ts
// has one mailbox). Implicit TLS on a test certificate, loopback only, written from RFC 3501 /
// 6154 (special-use) / 6851 (MOVE) / 7888 (LITERAL+): CAPABILITY, LOGIN, AUTHENTICATE PLAIN, LIST,
// SELECT, EXAMINE, STATUS, UID SEARCH (ALL FROM TO SUBJECT TEXT SEEN UNSEEN FLAGGED UNFLAGGED
// KEYWORD UNKEYWORD SINCE BEFORE LARGER HEADER NOT OR, CHARSET), UID FETCH, UID STORE, UID MOVE,
// APPEND, NOOP, LOGOUT. No EXPUNGE at all: a test fails if Sara ever asks for one.
import { createServer as tlsServer, type Server, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { testCerts } from './mail-fake.ts';

export interface Box {
  name: string;
  special?: string;
  validity: number;
  next: number;
  mails: { uid: number; raw: Buffer; flags: string[]; date: Date }[];
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const imapDay = (s: string) => {
  const [d, m, y] = s.split('-');
  return Date.UTC(Number(y), MON.indexOf(m.toLowerCase()), Number(d));
};

export class FakeImapBoxes {
  user = 'me@mail.test';
  pass = 'app-pass-5678';
  boxes = new Map<string, Box>();
  log: string[] = [];
  port = 0;
  caps = 'IMAP4rev1 AUTH=PLAIN SASL-IR MOVE UIDPLUS LITERAL+';
  readonly certs = testCerts('mail.test');
  #srv?: Server;
  #socks = new Set<TLSSocket>();

  constructor() {
    for (const [name, special] of [['INBOX'], ['Archive', '\\Archive'], ['Trash', '\\Trash'], ['Bulk Mail', '\\Junk'], ['Sent', '\\Sent'], ['Drafts', '\\Drafts'], ['Receipts']] as [string, string?][]) this.boxes.set(name, { name, ...(special ? { special } : {}), validity: 7, next: 1, mails: [] });
  }

  deliver(folder: string, o: { from: string; to?: string; subject: string; body?: string; messageId?: string; references?: string; inReplyTo?: string; date?: Date; flags?: string[]; headers?: string[] }): number {
    const b = this.boxes.get(folder)!;
    const date = o.date ?? new Date();
    const raw = [`From: ${o.from}`, `To: ${o.to ?? this.user}`, `Subject: ${o.subject}`, `Date: ${date.toUTCString()}`, `Message-ID: ${o.messageId ?? `<m${b.next}.${folder.length}@x.test>`}`, ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []), ...(o.references ? [`References: ${o.references}`] : []), ...(o.headers ?? []), 'Content-Type: text/plain; charset=utf-8', '', o.body ?? 'Hello?', ''].join('\r\n');
    const uid = b.next++;
    b.mails.push({ uid, raw: Buffer.from(raw), flags: o.flags ?? [], date });
    return uid;
  }

  async start(): Promise<this> {
    this.#srv = tlsServer({ key: this.certs.key, cert: this.certs.leaf.pem }, (s) => this.#session(s));
    await new Promise<void>((r) => this.#srv!.listen(0, '127.0.0.1', r));
    this.port = (this.#srv.address() as AddressInfo).port;
    return this;
  }
  stop(): Promise<void> {
    for (const s of this.#socks) s.destroy();
    return new Promise((r) => (this.#srv ? this.#srv.close(() => r()) : r()));
  }
  find(subject: string): { box: Box; uid: number; flags: string[] } | undefined {
    for (const box of this.boxes.values()) for (const m of box.mails) if (m.raw.toString().includes(`Subject: ${subject}\r\n`)) return { box, uid: m.uid, flags: m.flags };
    return undefined;
  }

  #session(s: TLSSocket): void {
    this.#socks.add(s);
    s.on('close', () => this.#socks.delete(s));
    s.on('error', () => undefined);
    s.write(`* OK [CAPABILITY ${this.caps}] fake ready\r\n`);
    let buf = Buffer.alloc(0);
    let cmd: (string | Buffer)[] = [];
    let need = 0;
    let authed = false;
    let sel: Box | undefined;
    const send = (l: string) => s.write(`${l}\r\n`);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (need) {
          if (buf.length < need) return;
          cmd.push(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          cmd.push(line.slice(0, lit.index));
          need = Number(lit[1]);
          if (!lit[2]) send('+ go ahead');
          continue;
        }
        cmd.push(line);
        const parts = cmd;
        cmd = [];
        try {
          handle(parts);
        } catch (err) {
          send(`* BAD ${(err as Error).message}`);
        }
      }
    });
    const handle = (parts: (string | Buffer)[]) => {
      const first = String(parts[0]);
      const m = /^(\S+) (\S+)(?: (.*))?$/s.exec(first);
      if (!m) return send('* BAD what?');
      const [, tag, c0] = m;
      const c = c0.toUpperCase();
      const text = parts.map((p) => (Buffer.isBuffer(p) ? `"${p.toString('utf8')}"` : p)).join('').slice(tag.length + c0.length + 2);
      this.log.push(c === 'LOGIN' || c === 'AUTHENTICATE' ? `${c} ***` : `${c} ${text}`.slice(0, 300));
      const str = (re: RegExp) => [...text.matchAll(re)];
      if (c === 'CAPABILITY') return send(`* CAPABILITY ${this.caps}`), send(`${tag} OK`);
      if (c === 'LOGOUT') return send('* BYE'), send(`${tag} OK`), void s.end();
      if (c === 'NOOP') return send(`${tag} OK`);
      if (c === 'AUTHENTICATE') {
        const [, u, p] = Buffer.from(text.split(' ')[1] ?? '', 'base64').toString('utf8').split('\0');
        authed = u === this.user && p === this.pass;
        return send(authed ? `${tag} OK [CAPABILITY ${this.caps}] in` : `${tag} NO [AUTHENTICATIONFAILED] wrong`);
      }
      if (c === 'LOGIN') {
        const q = str(/"((?:[^"\\]|\\.)*)"/g).map((x) => x[1]);
        authed = q[0] === this.user && q[1] === this.pass;
        return send(authed ? `${tag} OK in` : `${tag} NO [AUTHENTICATIONFAILED] wrong`);
      }
      if (!authed) return send(`${tag} NO sign in first`);
      const boxArg = (t: string) => {
        const q = /^"((?:[^"\\]|\\.)*)"|^(\S+)/.exec(t.trim());
        return (q?.[1] ?? q?.[2] ?? '').replace(/\\(.)/g, '$1');
      };
      if (c === 'LIST') {
        for (const b of this.boxes.values()) send(`* LIST (\\HasNoChildren${b.special ? ` ${b.special}` : ''}) "/" "${b.name}"`);
        return send(`${tag} OK`);
      }
      if (c === 'STATUS') {
        const b = this.boxes.get(boxArg(text));
        if (!b) return send(`${tag} NO no such box`);
        send(`* STATUS "${b.name}" (MESSAGES ${b.mails.length} UNSEEN ${b.mails.filter((x) => !x.flags.includes('\\Seen')).length})`);
        return send(`${tag} OK`);
      }
      if (c === 'SELECT' || c === 'EXAMINE') {
        sel = this.boxes.get(boxArg(text));
        if (!sel) return send(`${tag} NO no such box`);
        send('* FLAGS (\\Seen \\Flagged \\Deleted \\Draft Work)');
        send(`* ${sel.mails.length} EXISTS`);
        send(`* OK [UIDVALIDITY ${sel.validity}] ok`);
        return send(`${tag} OK [${c === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}]`);
      }
      if (c === 'APPEND') {
        const b = this.boxes.get(boxArg(text));
        const raw = parts.find((p) => Buffer.isBuffer(p)) as Buffer;
        if (!b || !raw) return send(`${tag} NO`);
        const flags = (/\(([^)]*)\)/.exec(String(parts[0]))?.[1] ?? '').split(' ').filter(Boolean);
        b.mails.push({ uid: b.next++, raw, flags, date: new Date() });
        return send(`${tag} OK [APPENDUID ${b.validity} ${b.next - 1}] appended`);
      }
      if (c === 'EXPUNGE') return send(`${tag} NO this fake never expunges`);
      if (c !== 'UID' || !sel) return send(`${tag} BAD unknown`);
      const [sub0, ...rest] = text.split(' ');
      const sub = sub0.toUpperCase();
      const box = sel;
      if (sub === 'SEARCH') {
        const hits = this.#search(box, parts, text.slice(sub0.length + 1));
        send(`* SEARCH${hits.map((u) => ` ${u}`).join('')}`);
        return send(`${tag} OK`);
      }
      const uids = new Set(rest[0].split(',').map(Number));
      const list = box.mails.filter((x) => uids.has(x.uid));
      if (sub === 'FETCH') {
        const items = rest.slice(1).join(' ').toUpperCase();
        for (const x of list) {
          const out: Buffer[] = [Buffer.from(`* ${box.mails.indexOf(x) + 1} FETCH (UID ${x.uid} FLAGS (${x.flags.join(' ')}) INTERNALDATE "${x.date.toUTCString()}"`)];
          const lit = (b: Buffer) => Buffer.concat([Buffer.from(`{${b.length}}\r\n`), b]);
          const hf = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/.exec(items);
          if (hf) {
            const want = hf[1].split(' ');
            const head = x.raw.toString().split('\r\n\r\n')[0].split('\r\n').filter((l) => want.includes(l.split(':')[0].toUpperCase())).join('\r\n');
            out.push(Buffer.from(` BODY[HEADER.FIELDS (${hf[1]})] `), lit(Buffer.from(`${head}\r\n\r\n`)));
          } else if (items.includes('BODY.PEEK[]')) out.push(Buffer.from(' BODY[] '), lit(x.raw));
          out.push(Buffer.from(')\r\n'));
          s.write(Buffer.concat(out));
        }
        return send(`${tag} OK`);
      }
      if (sub === 'STORE') {
        const op = rest[1];
        const fl = (/\(([^)]*)\)/.exec(text)?.[1] ?? '').split(' ').filter(Boolean);
        for (const x of list) {
          if (op.startsWith('+')) for (const f of fl) if (!x.flags.includes(f)) x.flags.push(f);
          if (op.startsWith('-')) x.flags = x.flags.filter((f) => !fl.includes(f));
        }
        return send(`${tag} OK`);
      }
      if (sub === 'MOVE') {
        const to = this.boxes.get(boxArg(rest.slice(1).join(' ')));
        if (!to) return send(`${tag} NO [TRYCREATE] no such box`);
        for (const x of list) {
          box.mails = box.mails.filter((y) => y !== x);
          to.mails.push({ ...x, uid: to.next++ });
        }
        return send(`${tag} OK moved`);
      }
      return send(`${tag} BAD unknown UID command`);
    };
  }

  #search(box: Box, parts: (string | Buffer)[], text: string): number[] {
    // Tokens: atoms, "quoted", and literals (Buffers in parts, in order).
    const lits = parts.filter((p) => Buffer.isBuffer(p)).map((b) => (b as Buffer).toString('utf8'));
    const toks: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|\{\d+\+?\}|(\S+)/g;
    let mm: RegExpExecArray | null;
    let li = 0;
    const src = parts.filter((p) => !Buffer.isBuffer(p)).join(' ').replace(/^\S+ UID SEARCH /i, '');
    void text;
    while ((mm = re.exec(src))) toks.push(mm[1] !== undefined ? mm[1].replace(/\\(.)/g, '$1') : mm[2] ?? '');
    // Literal markers were cut by the reader: a criterion with no value takes the next literal.
    const NEEDS = new Set(['FROM', 'TO', 'SUBJECT', 'TEXT', 'KEYWORD', 'UNKEYWORD', 'SINCE', 'BEFORE', 'LARGER']);
    const fixed: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      fixed.push(toks[i]);
      if (NEEDS.has(toks[i].toUpperCase()) && (i + 1 >= toks.length || NEEDS.has(toks[i + 1].toUpperCase()) || ['NOT', 'OR', 'UNSEEN', 'SEEN'].includes(toks[i + 1].toUpperCase()))) fixed.push(lits[li++] ?? '');
    }
    if (fixed[0]?.toUpperCase() === 'CHARSET') fixed.splice(0, 2);
    let i = 0;
    const head = (raw: Buffer, n: string) => new RegExp(`^${n}: (.*)$`, 'im').exec(raw.toString().split('\r\n\r\n')[0])?.[1] ?? '';
    type M = Box['mails'][number];
    const one = (): ((x: M) => boolean) => {
      const k = (fixed[i++] ?? '').toUpperCase();
      const v = () => fixed[i++] ?? '';
      const low = (s: string) => s.toLowerCase();
      switch (k) {
        case 'ALL': return () => true;
        case 'SEEN': return (x) => x.flags.includes('\\Seen');
        case 'UNSEEN': return (x) => !x.flags.includes('\\Seen');
        case 'FLAGGED': return (x) => x.flags.includes('\\Flagged');
        case 'UNFLAGGED': return (x) => !x.flags.includes('\\Flagged');
        case 'FROM': { const a = low(v()); return (x) => low(head(x.raw, 'From')).includes(a); }
        case 'TO': { const a = low(v()); return (x) => low(head(x.raw, 'To')).includes(a); }
        case 'SUBJECT': { const a = low(v()); return (x) => low(head(x.raw, 'Subject')).includes(a); }
        case 'TEXT': { const a = low(v()); return (x) => low(x.raw.toString()).includes(a); }
        case 'KEYWORD': { const a = v(); return (x) => x.flags.includes(a); }
        case 'UNKEYWORD': { const a = v(); return (x) => !x.flags.includes(a); }
        case 'SINCE': { const d = imapDay(v()); return (x) => x.date.getTime() >= d; }
        case 'BEFORE': { const d = imapDay(v()); return (x) => x.date.getTime() < d; }
        case 'LARGER': { const n = Number(v()); return (x) => x.raw.length > n; }
        case 'HEADER': { const n = v(); const a = low(v()); return (x) => low(head(x.raw, n)).includes(a); }
        case 'NOT': { const f = one(); return (x) => !f(x); }
        case 'OR': { const f = one(); const g = one(); return (x) => f(x) || g(x); }
        default: throw new Error(`unknown search key ${k}`);
      }
    };
    const fs: ((x: M) => boolean)[] = [];
    while (i < fixed.length) fs.push(one());
    return box.mails.filter((x) => fs.every((f) => f(x))).map((x) => x.uid);
  }
}
