// M1: one IMAP + SMTP mailbox (Yahoo, AOL, iCloud, Fastmail, Zoho, GMX, WEB.DE, Proton Mail Bridge,
// or servers the owner typed), signed in with an app password from the vault. The protocol code is
// the email bridge's own (plugins/email/imap.mjs, smtp.mjs, mime.mjs, html.mjs; no new dependency);
// this file adds what an inbox needs on top: LIST with special-use folders (RFC 6154), SEARCH,
// flags, MOVE (RFC 6851; COPY + \Deleted + UID EXPUNGE of exactly those UIDs when the server has no
// MOVE but has UIDPLUS, refused otherwise), APPEND to Drafts and Sent, and SMTP to send.
//
// Never a permanent delete: trash is a MOVE to the \Trash folder, and the only EXPUNGE is the MOVE
// fallback's, limited to the UIDs just copied (UID EXPUNGE, RFC 4315).
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rawEmail } from '../google.ts';
import { imapDate, imapString, keyword, toImap, type SearchTerms } from './search.ts';
import { openMailSocket, type OpenOpts, type WireSocket } from './socket.ts';
import type { ApplyResult, Before, Draft, Folder, MailAction, MailMessage, MailProvider } from './types.ts';

// ---------- the email bridge's modules (plain .mjs), typed here ----------

interface Untagged {
  text: string;
  segs: (string | Buffer)[];
}
interface ImapClient {
  caps: Set<string>;
  mailbox: { exists?: number; uidvalidity?: number; uidnext?: number };
  greetingPromise: Promise<string>;
  onContinue: ((text: string) => void) | null;
  command(text: string, opts?: { ms?: number; allowNo?: boolean }): Promise<{ status: string; text: string; untagged: Untagged[] }>;
  login(user: string, pass: string): Promise<void>;
  logout(): Promise<void>;
}
interface SmtpClient {
  caps: Set<string>;
  hello(name: string, user: string, pass: string, o?: { greeted?: boolean }): Promise<void>;
  send(from: string, to: string, raw: Buffer): Promise<void>;
  quit(): Promise<void>;
}
type Tree = unknown[];
interface MimeNode {
  headers: { get(n: string): string | undefined };
  type: string;
  params: Record<string, string>;
  disposition: string;
  filename: string;
  body: Buffer;
  parts: MimeNode[];
}
interface Lib {
  Imap: new (sock: WireSocket, o?: { greeting?: string | null }) => ImapClient;
  tokenize(segs: (string | Buffer)[]): Tree;
  mutf7(name: string): string;
  Smtp: new (sock: WireSocket) => SmtpClient;
  parseHeaders(text: string): { get(n: string): string | undefined };
  decodeWords(s: string): string;
  parseMime(raw: Buffer): MimeNode;
  leaves(n: MimeNode): MimeNode[];
  partText(n: MimeNode): { text: string; note?: string };
  htmlToText(html: string): string;
  rfcDate(d: Date): string;
}
const BRIDGE = resolve(import.meta.dirname, '..', '..', 'plugins', 'email');
let libP: Promise<Lib> | undefined;
export function mailLib(): Promise<Lib> {
  const load = (f: string) => import(pathToFileURL(join(BRIDGE, f)).href) as Promise<Record<string, unknown>>;
  libP ??= Promise.all([load('imap.mjs'), load('smtp.mjs'), load('mime.mjs'), load('html.mjs')]).then(([i, s, m, h]) => ({ ...i, ...s, ...m, ...h }) as unknown as Lib);
  return libP;
}

/** RFC 3501 §5.1.3: modified UTF-7 → text. */
export function fromMutf7(s: string): string {
  return s.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (!b64) return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    for (let i = 0; i + 1 < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
    return bytes.toString('utf16le');
  });
}

// ---------- ids ----------

/** A message id Sara hands out: the folder, its UIDVALIDITY and the UID. */
export const imapId = (folder: string, validity: number, uid: number): string => `i.${Buffer.from(folder).toString('base64url')}.${validity}.${uid}`;
export function parseImapId(id: string): { folder: string; validity: number; uid: number } | undefined {
  const m = /^i\.([\w-]*)\.(\d+)\.(\d+)$/.exec(id);
  return m ? { folder: Buffer.from(m[1], 'base64url').toString('utf8'), validity: Number(m[2]), uid: Number(m[3]) } : undefined;
}
export const IMAP_ID_RE = /^i\.[\w-]*\.\d+\.\d+$/;

export interface ImapConfig {
  address: string;
  user: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  copySent: boolean;
  loopback?: boolean;
  fingerprint?: string;
}

const ROLE_NAMES: Record<string, RegExp> = {
  archive: /^(archive|archives|all mail)$/i,
  trash: /^(trash|deleted|deleted items|deleted messages|bin|papierkorb|corbeille|papelera|lixeira|cestino)$/i,
  junk: /^(junk|spam|bulk|bulk mail|junk e-?mail|spamverdacht)$/i,
  sent: /^(sent|sent items|sent messages|sent mail|gesendet|envoyés|enviados|inviata)$/i,
  drafts: /^(drafts|draft|entwürfe|brouillons|borradores|rascunhos|bozze)$/i,
};
const SPECIAL: Record<string, string> = { '\\ARCHIVE': 'archive', '\\TRASH': 'trash', '\\JUNK': 'junk', '\\SENT': 'sent', '\\DRAFTS': 'drafts', '\\ALL': 'all' };
const HEADER_FIELDS = 'FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST PRECEDENCE AUTO-SUBMITTED CONTENT-TYPE';

/** One session: connect, sign in, work, log out. Calls on one account run one at a time. */
class Session {
  readonly imap: ImapClient;
  readonly lib: Lib;
  readonly sock: WireSocket;
  folder = '';
  validity = 0;
  /** The keywords and flags the selected folder knows (its FLAGS answer). */
  flags: string[] = [];
  writable = false;
  constructor(lib: Lib, imap: ImapClient, sock: WireSocket) {
    this.lib = lib;
    this.imap = imap;
    this.sock = sock;
  }
  q(name: string): string {
    return imapString(this.lib.mutf7(name));
  }
  async select(folder: string, write = true): Promise<number> {
    if (this.folder === folder && (this.writable || !write)) return this.validity;
    this.writable = write;
    this.imap.mailbox = {};
    const r = await this.imap.command(`${write ? 'SELECT' : 'EXAMINE'} ${this.q(folder)}`);
    this.flags = (/^\* FLAGS \(([^)]*)\)/im.exec(r.untagged.map((u) => u.text).join('\n'))?.[1] ?? '').split(/\s+/).filter(Boolean);
    this.folder = folder;
    this.validity = this.imap.mailbox.uidvalidity ?? 0;
    return this.validity;
  }
  async search(criteria: string, utf8: boolean): Promise<number[]> {
    if (utf8 && !this.imap.caps.has('LITERAL+') && !this.imap.caps.has('LITERAL-')) throw new Error("This mail server can't search for letters outside English in one go. Search with plain letters (or the sender's address).");
    const r = await this.imap.command(`UID SEARCH ${utf8 ? 'CHARSET UTF-8 ' : ''}${criteria}`, { ms: 120_000 });
    const out: number[] = [];
    for (const u of r.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(u.text);
      if (m) for (const n of m[1].trim().split(/\s+/).filter(Boolean)) out.push(Number(n));
    }
    return [...new Set(out)].sort((a, b) => b - a);
  }
  /** UID FETCH over a set; each FETCH answer as key → value. */
  async fetchUids(uids: number[], items: string): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < uids.length; i += 200) {
      const r = await this.imap.command(`UID FETCH ${uids.slice(i, i + 200).join(',')} (${items})`, { ms: 180_000 });
      for (const u of r.untagged) {
        if (!/^\* \d+ FETCH /i.test(typeof u.segs[0] === 'string' ? u.segs[0] : '')) continue;
        const list = this.lib.tokenize(u.segs).find((x) => Array.isArray(x)) as unknown[] | undefined;
        if (!list) continue;
        const d: Record<string, unknown> = {};
        for (let k = 0; k + 1 < list.length; k += 2) {
          const key = String(list[k] ?? '').toUpperCase();
          d[key.startsWith('BODY[HEADER') ? 'HEADER' : key.startsWith('BODY[]') ? 'BODY' : key] = list[k + 1];
        }
        if (d.UID !== undefined) out.set(Number(d.UID), d);
      }
    }
    return out;
  }
  async append(folder: string, flags: string, raw: Buffer): Promise<void> {
    const lit = this.imap.caps.has('LITERAL+') ? `{${raw.length}+}` : `{${raw.length}}`;
    if (lit.endsWith('+}')) {
      await this.imap.command(`APPEND ${this.q(folder)} (${flags}) ${lit}\r\n${raw.toString('latin1')}`);
      return;
    }
    this.imap.onContinue = () => void this.sock.write(Buffer.concat([raw, Buffer.from('\r\n')]));
    await this.imap.command(`APPEND ${this.q(folder)} (${flags}) ${lit}`);
  }
}

export interface ImapOpts extends Pick<OpenOpts, 'ca' | 'lookup' | 'testLoopback'> {
  /** The certificate fingerprint was learned (Proton Mail Bridge, first use). */
  onFingerprint?: (fp: string) => void;
  timeZone?: () => string | undefined;
}

export class ImapMail implements MailProvider {
  readonly kind = 'imap' as const;
  readonly #cfg: ImapConfig;
  readonly #password: () => string | undefined;
  readonly #o: ImapOpts;
  #queue: Promise<unknown> = Promise.resolve();
  #roles?: Map<string, string>;

  constructor(cfg: ImapConfig, password: () => string | undefined, opts: ImapOpts = {}) {
    this.#cfg = cfg;
    this.#password = password;
    this.#o = opts;
  }
  get address(): string {
    return this.#cfg.address;
  }

  async #open(): Promise<Session> {
    const pass = this.#password();
    if (!pass) throw new Error('The app password for this mailbox is missing. Add the account again in Settings → Email and calendar.');
    const lib = await mailLib();
    const o = await openMailSocket(this.#cfg.imap.host, this.#cfg.imap.port, { ...(this.#cfg.loopback ? { loopback: true } : {}), ...(this.#cfg.fingerprint ? { fingerprint: this.#cfg.fingerprint } : {}), ...(this.#o.ca ? { ca: this.#o.ca } : {}), ...(this.#o.lookup ? { lookup: this.#o.lookup } : {}), ...(this.#o.testLoopback ? { testLoopback: true } : {}) });
    if (o.fingerprint && !this.#cfg.fingerprint) {
      this.#cfg.fingerprint = o.fingerprint;
      this.#o.onFingerprint?.(o.fingerprint);
    }
    const imap = new lib.Imap(o.sock, { greeting: o.greeting ?? null });
    try {
      await imap.greetingPromise;
      await imap.login(this.#cfg.user, pass);
    } catch (err) {
      await o.sock.close().catch(() => undefined);
      throw err;
    }
    return new Session(lib, imap, o.sock);
  }

  /** Runs work in one signed-in session (one at a time per account). */
  #with<T>(work: (s: Session) => Promise<T>): Promise<T> {
    const run = async () => {
      const s = await this.#open();
      try {
        return await work(s);
      } finally {
        await s.imap.logout().catch(() => undefined);
        await s.sock.close().catch(() => undefined);
      }
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  async #folderRoles(s: Session): Promise<Map<string, string>> {
    if (this.#roles) return this.#roles;
    const r = await s.imap.command('LIST "" "*"');
    const roles = new Map<string, string>();
    const names: string[] = [];
    for (const u of r.untagged) {
      if (!/^\* LIST /i.test(u.text)) continue;
      const toks = s.lib.tokenize(u.segs) as unknown[];
      const flags = (Array.isArray(toks[2]) ? toks[2] : []).map((f) => String(f).toUpperCase());
      const raw = toks[4];
      const name = fromMutf7(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? ''));
      if (!name || flags.includes('\\NOSELECT') || flags.includes('\\NONEXISTENT')) continue;
      names.push(name);
      for (const f of flags) if (SPECIAL[f] && !roles.has(SPECIAL[f])) roles.set(SPECIAL[f], name);
    }
    roles.set('inbox', 'INBOX');
    for (const [role, re] of Object.entries(ROLE_NAMES)) {
      if (roles.has(role)) continue;
      const hit = names.find((n) => re.test(n.split(/[/.]/).pop() ?? n));
      if (hit) roles.set(role, hit);
    }
    roles.set('*names', JSON.stringify(names));
    this.#roles = roles;
    return roles;
  }
  async #folderFor(s: Session, f: string): Promise<string> {
    const roles = await this.#folderRoles(s);
    const role = f === 'spam' ? 'junk' : f;
    const hit = roles.get(role);
    if (hit) return hit;
    if (['archive', 'trash', 'junk', 'sent', 'drafts'].includes(role)) throw new Error(`This mailbox has no ${role === 'junk' ? 'spam' : role} folder.`);
    const names = JSON.parse(roles.get('*names') ?? '[]') as string[];
    const named = names.find((n) => n.toLowerCase() === f.toLowerCase());
    if (!named) throw new Error(`There is no folder called "${f}". Folders: ${names.join(', ')}`);
    return named;
  }

  #msg(s: Session, folder: string, d: Record<string, unknown>): MailMessage {
    const hb = d.HEADER;
    const h = s.lib.parseHeaders(Buffer.isBuffer(hb) ? hb.toString('utf8') : String(hb ?? ''));
    const dec = (n: string) => s.lib.decodeWords(h.get(n) ?? '');
    const flags = (Array.isArray(d.FLAGS) ? d.FLAGS : []).map((f) => String(f).toUpperCase());
    const headers: Record<string, string> = {};
    for (const n of ['message-id', 'references', 'in-reply-to', 'list-unsubscribe', 'list-unsubscribe-post', 'precedence', 'auto-submitted', 'content-type']) if (h.get(n)) headers[n] = h.get(n)!;
    const date = Date.parse(String(d.INTERNALDATE ?? '')) || Date.parse(h.get('date') ?? '') || 0;
    const id = imapId(folder, s.validity, Number(d.UID));
    return { id, threadId: id, from: dec('from'), to: dec('to'), ...(h.get('cc') ? { cc: dec('cc') } : {}), subject: dec('subject'), date: date ? new Date(date).toISOString() : '', snippet: '', unread: !flags.includes('\\SEEN'), flagged: flags.includes('\\FLAGGED'), folder, headers };
  }

  async #headers(s: Session, folder: string, uids: number[]): Promise<MailMessage[]> {
    if (!uids.length) return [];
    await s.select(folder, false);
    const got = await s.fetchUids(uids, `UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`);
    return uids.filter((u) => got.has(u)).map((u) => this.#msg(s, folder, got.get(u)!));
  }

  /** Searched folders: the one asked for, else the inbox and the archive (Gmail's "all mail" minus trash and spam). */
  async #searchIn(s: Session, terms: SearchTerms): Promise<{ folder: string; uids: number[] }[]> {
    const tz = this.#o.timeZone?.();
    const caps = s.imap.caps;
    const q = toImap(terms, tz, true);
    void caps;
    const folders = q.folder ? [await this.#folderFor(s, q.folder)] : [...new Set(['INBOX', (await this.#folderRoles(s)).get('archive')].filter((x): x is string => Boolean(x)))];
    const out: { folder: string; uids: number[] }[] = [];
    for (const f of folders) {
      await s.select(f, false);
      out.push({ folder: f, uids: await s.search(q.criteria, q.utf8) });
    }
    return out;
  }

  searchIds(terms: SearchTerms, cap: number): Promise<{ ids: string[]; capped: boolean }> {
    return this.#with(async (s) => {
      const ids: string[] = [];
      for (const { folder, uids } of await this.#searchIn(s, terms)) {
        await s.select(folder, false);
        for (const u of uids) {
          if (ids.length >= cap) return { ids, capped: true };
          ids.push(imapId(folder, s.validity, u));
        }
      }
      return { ids, capped: false };
    });
  }

  #group(ids: string[]): Map<string, number[]> {
    const by = new Map<string, number[]>();
    for (const id of ids) {
      const p = parseImapId(id);
      if (!p) continue;
      by.set(p.folder, [...(by.get(p.folder) ?? []), p.uid]);
    }
    return by;
  }

  list(ids: string[]): Promise<MailMessage[]> {
    return this.#with(async (s) => {
      const out: MailMessage[] = [];
      for (const [folder, uids] of this.#group(ids)) out.push(...(await this.#headers(s, folder, uids)));
      const order = new Map(ids.map((x, k) => [x, k]));
      return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    });
  }

  async #full(s: Session, id: string): Promise<MailMessage> {
    const p = parseImapId(id);
    if (!p) throw new Error('That is not an email id from this mailbox.');
    const v = await s.select(p.folder, false);
    if (v !== p.validity) throw new Error('That mailbox folder changed since; search again for the email.');
    const got = (await s.fetchUids([p.uid], 'UID FLAGS INTERNALDATE BODY.PEEK[]')).get(p.uid);
    if (!got) throw new Error('That email is not there any more (moved or deleted).');
    const raw = Buffer.isBuffer(got.BODY) ? got.BODY : Buffer.from(String(got.BODY ?? ''), 'latin1');
    const node = s.lib.parseMime(raw);
    const head = raw.subarray(0, Math.max(0, raw.indexOf('\r\n\r\n')) || raw.length);
    const m = this.#msg(s, p.folder, { ...got, HEADER: head });
    const leaves = s.lib.leaves(node);
    const plain = leaves.find((l) => l.type === 'text/plain' && !/attachment/i.test(l.disposition));
    const html = leaves.find((l) => l.type === 'text/html' && !/attachment/i.test(l.disposition));
    m.text = String(plain ? s.lib.partText(plain).text : html ? s.lib.htmlToText(s.lib.partText(html).text) : '').replace(/\r\n/g, '\n').trim();
    m.snippet = m.text.replace(/\s+/g, ' ').slice(0, 200);
    const files = leaves.map((l) => l.filename).filter(Boolean);
    if (files.length) m.attachments = files;
    return m;
  }

  get(id: string): Promise<MailMessage> {
    return this.#with((s) => this.#full(s, id));
  }

  thread(id: string): Promise<MailMessage[]> {
    return this.#with(async (s) => {
      const first = await this.#full(s, id);
      const refs = `${first.headers.references ?? ''} ${first.headers['in-reply-to'] ?? ''}`.match(/<[^>]+>/g) ?? [];
      const root = refs[0] ?? first.headers['message-id'];
      if (!root) return [first];
      const roles = await this.#folderRoles(s);
      const seen = new Set<string>();
      const all: MailMessage[] = [];
      for (const f of [...new Set(['INBOX', roles.get('sent'), roles.get('archive')].filter((x): x is string => Boolean(x)))]) {
        await s.select(f, false);
        const uids = (await s.search(`OR HEADER Message-ID ${imapString(root)} HEADER References ${imapString(root)}`, false)).slice(0, 30);
        for (const u of uids) {
          const mid = imapId(f, s.validity, u);
          if (seen.has(mid)) continue;
          seen.add(mid);
          all.push(await this.#full(s, mid));
        }
      }
      if (!all.some((m) => m.id === first.id)) all.push(first);
      // The same mail in two folders (Sent and Archive) counts once.
      const byMid = new Map<string, MailMessage>();
      for (const m of all) byMid.set(m.headers['message-id'] ?? m.id, m);
      return [...byMid.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-25);
    });
  }

  recentInbox(days: number, max: number): Promise<{ latest: MailMessage; count: number }[]> {
    return this.#with(async (s) => {
      const tz = this.#o.timeZone?.();
      await s.select('INBOX', false);
      const uids = (await s.search(`SINCE ${imapDate(Date.now() - days * 86_400_000, tz)}`, false)).slice(0, Math.min(150, max * 4));
      const msgs = (await this.#headers(s, 'INBOX', uids)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      const groups = new Map<string, { latest: MailMessage; count: number }>();
      for (const m of msgs) {
        const root = (`${m.headers.references ?? ''}`.match(/<[^>]+>/) ?? [m.headers['message-id'] ?? m.id])[0];
        const g = groups.get(root);
        if (g) g.count++;
        else groups.set(root, { latest: m, count: 1 });
      }
      const sent = (await this.#folderRoles(s)).get('sent');
      const out: { latest: MailMessage; count: number }[] = [];
      for (const g of groups.values()) {
        const mid = g.latest.headers['message-id'];
        // Answered from here or another app: a reply to it is in Sent.
        if (sent && mid) {
          await s.select(sent, false);
          const reply = await s.search(`HEADER In-Reply-To ${imapString(mid)}`, false).catch(() => [] as number[]);
          if (reply.length) {
            out.push({ latest: { ...g.latest, from: this.#cfg.address, headers: { ...g.latest.headers, sent: '1' } }, count: g.count + 1 });
            continue;
          }
        }
        out.push({ latest: await this.#full(s, g.latest.id).catch(() => g.latest), count: g.count });
        if (out.length >= max) break;
      }
      return out;
    });
  }

  async #compose(d: Draft, s?: Session): Promise<{ raw: Buffer; to: string[] }> {
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (d.replyTo && s) {
      const o = await this.#full(s, d.replyTo);
      inReplyTo = o.headers['message-id'];
      references = [o.headers.references, inReplyTo].filter(Boolean).join(' ') || undefined;
    }
    const lib = await mailLib();
    const body = Buffer.from(rawEmail({ to: d.to, ...(d.cc ? { cc: d.cc } : {}), subject: d.subject, body: d.body, ...(inReplyTo ? { inReplyTo, ...(references ? { references } : {}) } : {}) }), 'base64url');
    const domain = this.#cfg.address.split('@')[1] ?? 'sara.localdomain';
    const head = [`From: <${this.#cfg.address}>`, `Date: ${lib.rfcDate(new Date())}`, `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`].join('\r\n');
    const to = `${d.to},${d.cc ?? ''}`.split(/[,;]/).map((x) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim()).filter((x) => /^[^\s@<>]+@[^\s@<>]+$/.test(x));
    return { raw: Buffer.concat([Buffer.from(`${head}\r\n`), body]), to };
  }

  draft(d: Draft): Promise<string> {
    return this.#with(async (s) => {
      const { raw } = await this.#compose(d, s);
      await s.append(await this.#folderFor(s, 'drafts'), '\\Draft \\Seen', raw);
      return 'Drafts';
    });
  }

  send(d: Draft): Promise<string> {
    return this.#with(async (s) => {
      const { raw, to } = await this.#compose(d, s);
      if (!to.length) throw new Error('Who is it to? (an email address)');
      const lib = await mailLib();
      const o = await openMailSocket(this.#cfg.smtp.host, this.#cfg.smtp.port, { ...(this.#cfg.loopback ? { loopback: true } : {}), ...(this.#o.ca ? { ca: this.#o.ca } : {}), ...(this.#o.lookup ? { lookup: this.#o.lookup } : {}), ...(this.#o.testLoopback ? { testLoopback: true } : {}) });
      const smtp = new lib.Smtp(o.sock);
      try {
        await smtp.hello(this.#cfg.address.split('@')[1] ?? 'sara.localdomain', this.#cfg.user, this.#password() ?? '', { greeted: o.greeting !== undefined });
        // One envelope per recipient (the email bridge's SMTP client sends to one at a time); the To and Cc lines are the same in each.
        for (const rcpt of to) await smtp.send(this.#cfg.address, rcpt, raw);
      } finally {
        await smtp.quit();
      }
      if (this.#cfg.copySent) {
        const sent = (await this.#folderRoles(s)).get('sent');
        if (sent) await s.append(sent, '\\Seen', raw).catch(() => undefined);
      }
      return to.join(', ');
    });
  }

  folders(): Promise<Folder[]> {
    return this.#with(async (s) => {
      const roles = await this.#folderRoles(s);
      const byName = new Map<string, string>();
      for (const [role, name] of roles) if (!role.startsWith('*')) byName.set(name, role);
      const names = JSON.parse(roles.get('*names') ?? '[]') as string[];
      const out: Folder[] = [];
      for (const n of names) {
        const st = await s.imap.command(`STATUS ${s.q(n)} (MESSAGES UNSEEN)`, { allowNo: true }).catch(() => undefined);
        const m = /MESSAGES (\d+).*UNSEEN (\d+)|UNSEEN (\d+).*MESSAGES (\d+)/i.exec(st?.untagged.map((u) => u.text).join(' ') ?? '');
        out.push({ id: n, name: n, ...(byName.get(n) && byName.get(n) !== 'all' ? { role: byName.get(n)! } : {}), ...(m ? { total: Number(m[1] ?? m[4]), unread: Number(m[2] ?? m[3]) } : {}) });
      }
      return out;
    });
  }

  labels(): Promise<string[]> {
    return this.#with(async (s) => {
      await s.select('INBOX', false);
      // Keywords already in use (FLAGS of the inbox), without the system flags.
      return s.flags.filter((f) => !f.startsWith('\\') && !f.startsWith('$'));
    });
  }

  /** Moves exact UIDs (MOVE, or COPY + \Deleted + UID EXPUNGE of only those with UIDPLUS). Returns the new UIDs when the server tells (COPYUID). */
  async #moveUids(s: Session, from: string, uids: number[], to: string): Promise<void> {
    await s.select(from);
    const set = uids.join(',');
    if (s.imap.caps.has('MOVE')) {
      await s.imap.command(`UID MOVE ${set} ${s.q(to)}`, { ms: 300_000 });
      return;
    }
    if (!s.imap.caps.has('UIDPLUS')) throw new Error("This mail server can't move mail safely (no MOVE or UIDPLUS), so nothing was changed.");
    await s.imap.command(`UID COPY ${set} ${s.q(to)}`, { ms: 300_000 });
    await s.imap.command(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
    await s.imap.command(`UID EXPUNGE ${set}`);
  }

  apply(action: MailAction, ids: string[], opts: { target?: string; createLabel?: boolean; signal?: AbortSignal; progress?: (n: number) => void }): Promise<ApplyResult & { target?: string }> {
    return this.#with(async (s) => {
      const done: Before[] = [];
      let failed = 0;
      let error: string | undefined;
      const flag: Partial<Record<MailAction, string>> = { read: '+FLAGS.SILENT (\\Seen)', unread: '-FLAGS.SILENT (\\Seen)', star: '+FLAGS.SILENT (\\Flagged)', unstar: '-FLAGS.SILENT (\\Flagged)' };
      if (action === 'important' || action === 'not_important') throw new Error('IMAP mailboxes have no "important" mark. Use star (flag) instead.');
      const kw = action === 'label' || action === 'unlabel' ? keyword(opts.target ?? '') : '';
      const dest = ['archive', 'trash', 'spam', 'move'].includes(action) ? await this.#folderFor(s, action === 'move' ? (opts.target ?? '') : action) : action === 'untrash' || action === 'not_spam' ? 'INBOX' : '';
      for (const [folder, uids] of this.#group(ids)) {
        if (opts.signal?.aborted) break;
        try {
          if (dest) {
            await s.select(folder, false);
            const meta = await s.fetchUids(uids, 'UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]');
            if (dest === folder) continue;
            await this.#moveUids(s, folder, uids, dest);
            for (const u of uids) {
              const h = meta.get(u)?.HEADER;
              const mid = /<[^>]+>/.exec(Buffer.isBuffer(h) ? h.toString('latin1') : String(h ?? ''))?.[0];
              done.push({ id: imapId(folder, s.validity, u), folder, ...(mid ? { messageId: mid } : {}) });
            }
          } else {
            await s.select(folder);
            const what = flag[action] ?? `${action === 'label' ? '+' : '-'}FLAGS.SILENT (${kw})`;
            await s.imap.command(`UID STORE ${uids.join(',')} ${what}`, { ms: 300_000 });
            for (const u of uids) done.push({ id: imapId(folder, s.validity, u), folder });
          }
        } catch (err) {
          failed += uids.length;
          error ??= (err as Error).message;
        }
        opts.progress?.(done.length + failed);
      }
      return { done, failed, ...(error ? { error } : {}), ...(dest ? { target: dest } : kw ? { target: kw } : {}) };
    });
  }

  revert(action: MailAction, done: Before[], opts: { target?: string; signal?: AbortSignal; progress?: (n: number) => void }): Promise<ApplyResult> {
    const back: Partial<Record<MailAction, MailAction>> = { read: 'unread', unread: 'read', star: 'unstar', unstar: 'star', label: 'unlabel', unlabel: 'label' };
    const rev = back[action];
    if (rev) return this.apply(rev, done.map((d) => d.id), { ...(opts.target ? { target: opts.target } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.progress ? { progress: opts.progress } : {}) });
    // A move: find each message again by its Message-ID where it went, and move it back.
    return this.#with(async (s) => {
      const target = opts.target ?? '';
      const out: Before[] = [];
      let failed = 0;
      let error: string | undefined;
      const byFolder = new Map<string, Before[]>();
      for (const d of done) byFolder.set(d.folder ?? 'INBOX', [...(byFolder.get(d.folder ?? 'INBOX') ?? []), d]);
      for (const [home, list] of byFolder) {
        try {
          await s.select(target, false);
          const uids: number[] = [];
          for (const d of list) {
            if (!d.messageId) {
              failed++;
              continue;
            }
            const hit = await s.search(`HEADER Message-ID ${imapString(d.messageId)}`, false);
            if (hit.length) uids.push(hit[0]);
            else failed++;
          }
          if (uids.length) {
            await this.#moveUids(s, target, uids, home);
            out.push(...list.filter((d) => d.messageId).slice(0, uids.length));
          }
        } catch (err) {
          failed += list.length;
          error ??= (err as Error).message;
        }
        opts.progress?.(out.length + failed);
      }
      return { done: out, failed, ...(error ? { error } : {}) };
    });
  }

  inboxCounts(): Promise<{ total: number; unread: number }> {
    return this.#with(async (s) => {
      const r = await s.imap.command('STATUS "INBOX" (MESSAGES UNSEEN)');
      const t = r.untagged.map((u) => u.text).join(' ');
      return { total: Number(/MESSAGES (\d+)/i.exec(t)?.[1] ?? 0), unread: Number(/UNSEEN (\d+)/i.exec(t)?.[1] ?? 0) };
    });
  }

  important(max: number): Promise<MailMessage[]> {
    return this.#with(async (s) => {
      await s.select('INBOX', false);
      const uids = (await s.search(`UNSEEN SINCE ${imapDate(Date.now() - 3 * 86_400_000, this.#o.timeZone?.())}`, false)).slice(0, 40);
      const msgs = await this.#headers(s, 'INBOX', uids);
      // No "important" mark in IMAP: flagged mail first, then mail from people (no list or bulk headers).
      return msgs
        .filter((m) => m.flagged || (!m.headers['list-unsubscribe'] && !/bulk|list|junk/i.test(m.headers.precedence ?? '') && !/auto-/i.test(m.headers['auto-submitted'] ?? '') && !/\b(no-?reply|donotreply|notifications?|newsletter|mailer-daemon)@/i.test(m.from)))
        .sort((a, b) => Number(b.flagged) - Number(a.flagged) || Date.parse(b.date) - Date.parse(a.date))
        .slice(0, max);
    });
  }

  async test(): Promise<string> {
    const c = await this.inboxCounts();
    return `Signed in as ${this.#cfg.address}: ${c.total.toLocaleString('en-US')} emails in the inbox, ${c.unread.toLocaleString('en-US')} unread.`;
  }

  /** Checks SMTP too (sign-in only, nothing sent): the Test button. */
  async testSmtp(): Promise<void> {
    const lib = await mailLib();
    const o = await openMailSocket(this.#cfg.smtp.host, this.#cfg.smtp.port, { ...(this.#cfg.loopback ? { loopback: true } : {}), ...(this.#o.ca ? { ca: this.#o.ca } : {}), ...(this.#o.lookup ? { lookup: this.#o.lookup } : {}), ...(this.#o.testLoopback ? { testLoopback: true } : {}) });
    const smtp = new lib.Smtp(o.sock);
    try {
      await smtp.hello(this.#cfg.address.split('@')[1] ?? 'sara.localdomain', this.#cfg.user, this.#password() ?? '', { greeted: o.greeting !== undefined });
    } finally {
      await smtp.quit();
    }
  }
}
