// A stand-in IMAP + SMTP server for the email plugin's tests (Phase 117 part B). Written here from
// the RFCs, small and strict: implicit TLS on a self-signed test certificate (test/x509-test.ts),
// one mailbox, and every command recorded. Never a real mailbox.
//
// IMAP: CAPABILITY, LOGIN, AUTHENTICATE PLAIN (SASL-IR), SELECT, UID SEARCH, UID FETCH (FLAGS,
// RFC822.SIZE, BODY.PEEK[HEADER], BODY.PEEK[]) as literals, UID STORE, UID MOVE, NOOP, IDLE/DONE,
// LOGOUT. `idle: false` leaves IDLE out of the capabilities (the plugin polls). `uidvalidity` can
// change between sessions.
// SMTP: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA (dot-unstuffed), RSET, NOOP, QUIT. `reply` can
// answer a command with a scripted code (a 451 or a 550 for one mail).
//
// Also a small CLI for the live check (docs/EMAIL_BRIDGE.md, "Testing with a stand-in server"):
//   node test/mail-fake.ts --imap 7891 --smtp 7892 --control 7893 --dir <scratch>
// writes <scratch>/ca.pem, listens on loopback (`--host ::1` when "localhost" resolves to ::1 first), and takes new mail at POST http://127.0.0.1:7893/mail
// (the raw message) and lists what she sent at GET /sent.
import { createServer as tlsServer, type TLSSocket, type Server as TlsServer } from 'node:tls';
import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCert, type TestCert } from './x509-test.ts';

export interface FakeMail {
  uid: number;
  raw: Buffer;
  flags: string[];
}

export interface Sent {
  from: string;
  to: string[];
  data: string;
  at: number;
}

export function testCerts(host = 'mail.test'): { ca: TestCert; leaf: TestCert; key: string } {
  const now = Date.now();
  const ca = makeCert({ cn: 'Sara test mail CA', ca: true, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 7 * 86_400_000) });
  const leaf = makeCert({ cn: host, dns: [host, 'localhost'], issuer: ca, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 7 * 86_400_000) });
  return { ca, leaf, key: leaf.key.export({ type: 'pkcs8', format: 'pem' }) as string };
}

export class FakeMailServer {
  mails: FakeMail[] = [];
  moved: { uid: number; to: string }[] = [];
  uidvalidity = 1000;
  nextUid = 1;
  idle = true;
  user = 'sara@her.test';
  pass = 'app-pass-1234';
  /** Every IMAP command line (passwords masked) and SMTP line. */
  imapLog: string[] = [];
  smtpLog: string[] = [];
  sent: Sent[] = [];
  /** SMTP: answer the next matching command with this code once (e.g. { cmd: 'DATA-END', code: 451 }). */
  replies: { cmd: string; code: number; text?: string }[] = [];
  imapPort = 0;
  smtpPort = 0;
  readonly certs: ReturnType<typeof testCerts>;
  #imap?: TlsServer;
  #smtp?: TlsServer;
  #idlers = new Set<() => void>();
  #sockets = new Set<TLSSocket>();

  constructor(host = 'mail.test') {
    this.certs = testCerts(host);
  }

  get caPem(): string {
    return this.certs.ca.pem;
  }

  async start(o: { imapPort?: number; smtpPort?: number; host?: string } = {}): Promise<this> {
    const opts = { key: this.certs.key, cert: this.certs.leaf.pem };
    this.#imap = tlsServer(opts, (s) => this.#imapSession(s));
    this.#smtp = tlsServer(opts, (s) => this.#smtpSession(s));
    const host = o.host ?? '127.0.0.1';
    await new Promise<void>((r) => this.#imap!.listen(o.imapPort ?? 0, host, r));
    await new Promise<void>((r) => this.#smtp!.listen(o.smtpPort ?? 0, host, r));
    this.imapPort = (this.#imap.address() as AddressInfo).port;
    this.smtpPort = (this.#smtp.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await Promise.all([this.#imap, this.#smtp].map((srv) => new Promise<void>((r) => (srv ? srv.close(() => r()) : r()))));
  }

  /** Delivers a mail into the INBOX (wakes an IDLE session). */
  deliver(raw: string | Buffer): number {
    const uid = this.nextUid++;
    this.mails.push({ uid, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8'), flags: [] });
    for (const f of this.#idlers) f();
    return uid;
  }

  /** Drops every connection (the plugin reconnects). */
  kick(): void {
    for (const s of this.#sockets) s.destroy();
  }

  // ---------------------------------------------------------------- IMAP

  #imapSession(s: TLSSocket): void {
    this.#sockets.add(s);
    s.on('close', () => this.#sockets.delete(s));
    s.on('error', () => undefined);
    const caps = () => `IMAP4rev1 AUTH=PLAIN SASL-IR MOVE${this.idle ? ' IDLE' : ''}`;
    s.write(`* OK [CAPABILITY ${caps()}] fake IMAP ready\r\n`);
    let buf = '';
    let idling: { tag: string; wake: () => void; seen: number } | null = null;
    let authed = false;
    let reported = 0; // the EXISTS count this session was last told (RFC 3501 §7.3.1: a change is reported on the next response)
    const send = (l: string) => s.write(`${l}\r\n`);
    const news = () => {
      if (this.mails.length !== reported) send(`* ${(reported = this.mails.length)} EXISTS`);
    };
    const literal = (b: Buffer) => Buffer.concat([Buffer.from(`{${b.length}}\r\n`), b]);
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (idling) {
          if (line.trim().toUpperCase() === 'DONE') {
            this.imapLog.push('DONE');
            this.#idlers.delete(idling.wake);
            send(`${idling.tag} OK IDLE terminated`);
            idling = null;
          }
          continue;
        }
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) {
          send('* BAD what?');
          continue;
        }
        const [, tag, cmd0, rest = ''] = m;
        const cmd = cmd0.toUpperCase();
        this.imapLog.push(cmd === 'LOGIN' || cmd === 'AUTHENTICATE' ? `${cmd} ***` : `${cmd} ${rest}`.trim());
        if (cmd === 'CAPABILITY') {
          send(`* CAPABILITY ${caps()}`);
          send(`${tag} OK done`);
        } else if (cmd === 'AUTHENTICATE') {
          const b64 = rest.split(' ')[1] ?? '';
          const [, u, p] = Buffer.from(b64, 'base64').toString('utf8').split('\0');
          if (u === this.user && p === this.pass) {
            authed = true;
            send(`${tag} OK [CAPABILITY ${caps()}] signed in`);
          } else send(`${tag} NO [AUTHENTICATIONFAILED] wrong password`);
        } else if (cmd === 'LOGIN') {
          const q = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\(.)/g, '$1'));
          if (q[0] === this.user && q[1] === this.pass) {
            authed = true;
            send(`${tag} OK signed in`);
          } else send(`${tag} NO [AUTHENTICATIONFAILED] wrong password`);
        } else if (!authed && cmd !== 'LOGOUT' && cmd !== 'NOOP') send(`${tag} NO sign in first`);
        else if (cmd === 'SELECT') {
          send(`* ${(reported = this.mails.length)} EXISTS`);
          send(`* OK [UIDVALIDITY ${this.uidvalidity}] UIDs valid`);
          send(`* OK [UIDNEXT ${this.nextUid}] next`);
          send(`${tag} OK [READ-WRITE] selected`);
        } else if (cmd === 'NOOP') {
          if (authed) news();
          send(`${tag} OK nothing`);
        } else if (cmd === 'IDLE') {
          send('+ idling');
          news(); // mail that came since the last response (between a SEARCH and this IDLE) is told at once
          const wake = () => news();
          idling = { tag, wake, seen: this.mails.length };
          this.#idlers.add(wake);
        } else if (cmd === 'UID') {
          const [sub0, set = '', ...more] = rest.split(' ');
          const sub = sub0.toUpperCase();
          const uids = this.#uidSet(set === 'UID' ? more[0] ?? '' : set);
          if (sub === 'SEARCH') {
            news();
            send(`* SEARCH${uids.map((u) => ` ${u}`).join('')}`);
            send(`${tag} OK search done`);
          } else if (sub === 'FETCH') {
            const items = more.join(' ').toUpperCase();
            for (const u of uids) {
              const mail = this.mails.find((x) => x.uid === u);
              if (!mail) continue;
              const seq = this.mails.indexOf(mail) + 1;
              const parts: Buffer[] = [Buffer.from(`* ${seq} FETCH (UID ${u}`)];
              if (items.includes('FLAGS')) parts.push(Buffer.from(` FLAGS (${mail.flags.join(' ')})`));
              if (items.includes('RFC822.SIZE')) parts.push(Buffer.from(` RFC822.SIZE ${mail.raw.length}`));
              if (items.includes('BODY.PEEK[HEADER]')) {
                const end = mail.raw.indexOf('\r\n\r\n');
                parts.push(Buffer.from(' BODY[HEADER] '), literal(mail.raw.subarray(0, end < 0 ? mail.raw.length : end + 4)));
              } else if (items.includes('BODY.PEEK[]')) parts.push(Buffer.from(' BODY[] '), literal(mail.raw));
              parts.push(Buffer.from(')\r\n'));
              s.write(Buffer.concat(parts));
            }
            send(`${tag} OK fetch done`);
          } else if (sub === 'STORE') {
            for (const u of uids) {
              const mail = this.mails.find((x) => x.uid === u);
              if (mail && !mail.flags.includes('\\Seen')) mail.flags.push('\\Seen');
            }
            send(`${tag} OK stored`);
          } else if (sub === 'MOVE') {
            for (const u of uids) {
              this.moved.push({ uid: u, to: more.join(' ').replace(/^"|"$/g, '') });
              this.mails = this.mails.filter((x) => x.uid !== u);
            }
            send(`${tag} OK moved`);
          } else send(`${tag} BAD unknown UID command`);
        } else if (cmd === 'LOGOUT') {
          send('* BYE bye');
          send(`${tag} OK bye`);
          s.end();
        } else send(`${tag} BAD unknown command`);
      }
    });
  }

  #uidSet(set: string): number[] {
    const all = this.mails.map((m) => m.uid);
    const out = new Set<number>();
    for (const part of set.split(',')) {
      const [a, b] = part.split(':');
      const max = all.length ? Math.max(...all) : 0;
      const lo = a === '*' ? max : Number(a);
      const hi = b === undefined ? lo : b === '*' ? max : Number(b);
      // RFC 3501: "n:*" always includes the highest UID, even when it is below n.
      for (const u of all) if (u >= Math.min(lo, hi) && u <= Math.max(lo, hi)) out.add(u);
    }
    return [...out].sort((x, y) => x - y);
  }

  // ---------------------------------------------------------------- SMTP

  #smtpSession(s: TLSSocket): void {
    this.#sockets.add(s);
    s.on('close', () => this.#sockets.delete(s));
    s.on('error', () => undefined);
    s.write('220 fake.test ESMTP ready\r\n');
    let buf = '';
    let data: string[] | null = null;
    let from = '';
    let to: string[] = [];
    let authed = false;
    let login: string[] | null = null;
    const send = (l: string) => s.write(`${l}\r\n`);
    const scripted = (cmd: string): { code: number; text?: string } | undefined => {
      const i = this.replies.findIndex((r) => r.cmd === cmd);
      return i >= 0 ? this.replies.splice(i, 1)[0] : undefined;
    };
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (data) {
          if (line === '.') {
            const body = data.join('\r\n');
            data = null;
            const r = scripted('DATA-END');
            if (r) send(`${r.code} ${r.text ?? 'scripted'}`);
            else {
              this.sent.push({ from, to, data: Buffer.from(body, 'latin1').toString('utf8'), at: Date.now() });
              send('250 queued');
            }
            from = '';
            to = [];
          } else data.push(line.startsWith('.') ? line.slice(1) : line);
          continue;
        }
        if (login) {
          login.push(Buffer.from(line, 'base64').toString('utf8'));
          if (login.length === 1) send('334 UGFzc3dvcmQ6');
          else {
            authed = login[0] === this.user && login[1] === this.pass;
            send(authed ? '235 ok' : '535 wrong password');
            login = null;
          }
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        this.smtpLog.push(cmd === 'AUTH' ? 'AUTH ***' : line);
        const r = scripted(cmd);
        if (r) {
          send(`${r.code} ${r.text ?? 'scripted'}`);
          continue;
        }
        if (cmd === 'EHLO') send('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME');
        else if (cmd === 'AUTH') {
          const [, mech, b64] = line.split(' ');
          if (mech?.toUpperCase() === 'LOGIN') {
            login = [];
            send('334 VXNlcm5hbWU6');
            continue;
          }
          const [, u, p] = Buffer.from(b64 ?? '', 'base64').toString('utf8').split('\0');
          authed = u === this.user && p === this.pass;
          send(authed ? '235 ok' : '535 wrong password');
        } else if (cmd === 'MAIL') {
          if (!authed) send('530 sign in first');
          else {
            from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            send('250 ok');
          }
        } else if (cmd === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          send('250 ok');
        } else if (cmd === 'DATA') {
          data = [];
          send('354 go ahead');
        } else if (cmd === 'RSET' || cmd === 'NOOP') send('250 ok');
        else if (cmd === 'QUIT') {
          send('221 bye');
          s.end();
        } else send('500 unknown');
      }
    });
  }
}

// ------------------------------------------------------------------ building test mails

let mid = 0;
/** A plain test mail (headers in order: A-R first, as a receiving provider adds them on top). */
export function mail(o: { from: string; to?: string; subject?: string; body?: string; messageId?: string; inReplyTo?: string; references?: string[]; ar?: string[]; headers?: string[]; contentType?: string; raw?: string }): string {
  const id = o.messageId ?? `<m${++mid}.${Date.now()}@sender.test>`;
  const h = [
    ...(o.ar ?? []).map((x) => `Authentication-Results: ${x}`),
    `From: ${o.from}`,
    `To: ${o.to ?? 'Sara <sara@her.test>'}`,
    `Subject: ${o.subject ?? 'Hello'}`,
    `Date: Sun, 01 Nov 2026 10:42:00 +0000`,
    `Message-ID: ${id}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references?.length ? [`References: ${o.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    ...(o.headers ?? []),
    `Content-Type: ${o.contentType ?? 'text/plain; charset=utf-8'}`,
  ];
  return `${h.join('\r\n')}\r\n\r\n${(o.raw ?? o.body ?? 'Hi').replace(/\r?\n/g, '\r\n')}\r\n`;
}

/** An A-R header from his provider with a passing DMARC check for the From domain. */
export const passAr = (authserv: string, domain: string) => `${authserv}; dkim=pass header.d=${domain} header.s=s1; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=none) header.from=${domain}`;
export const failAr = (authserv: string, domain: string) => `${authserv}; dkim=none; spf=fail smtp.mailfrom=${domain}; dmarc=fail header.from=${domain}`;

// ------------------------------------------------------------------ the live-check CLI

if (process.argv[1] && /mail-fake\.ts$/.test(process.argv[1])) {
  const arg = (k: string, d: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const dir = arg('dir', '.');
  const fake = new FakeMailServer('localhost');
  fake.user = arg('user', 'sara@her.test');
  fake.pass = arg('pass', 'app-pass-1234');
  await fake.start({ imapPort: Number(arg('imap', '7891')), smtpPort: Number(arg('smtp', '7892')), host: arg('host', '127.0.0.1') });
  writeFileSync(join(dir, 'ca.pem'), fake.caPem);
  const control: HttpServer = httpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'POST' && req.url === '/mail') {
      const uid = fake.deliver(body);
      res.end(JSON.stringify({ uid }));
    } else if (req.url === '/sent') res.end(JSON.stringify(fake.sent, null, 1));
    else if (req.url === '/state') res.end(JSON.stringify({ mails: fake.mails.map((m) => ({ uid: m.uid, flags: m.flags })), imap: fake.imapLog.slice(-60), smtp: fake.smtpLog.slice(-60) }, null, 1));
    else res.end('{}');
  });
  await new Promise<void>((r) => control.listen(Number(arg('control', '7893')), '127.0.0.1', r));
  console.log(`fake mail: IMAP ${fake.imapPort}, SMTP ${fake.smtpPort}, control ${arg('control', '7893')}, CA ${join(dir, 'ca.pem')}`);
}
