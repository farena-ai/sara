// The email plugin (comes with Sara; docs/design/BRIDGES3.md §5, docs/EMAIL_BRIDGE.md). She gets a
// mailbox of her own: the owner writes to it (or forwards a mail to it) and she answers in the same
// thread. IMAP (IDLE, refreshed every 29 minutes, or polling) and SMTP run on sockets Sara holds for
// it (permissions.connect; Sara does TLS and STARTTLS and checks the certificate); the plugin never
// opens a socket itself. Headers come first: auto-replies, lists, bounces, her own mail, mail not
// addressed to her, and anyone Sara says isn't the owner or an allowed partner are decided before
// any body is downloaded, so a stranger's mail never reaches a model. Sara decides who is who (the
// linked address plus a passing sender check), what anyone may do, and every turn.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { plugin } from './sara-plugin.mjs';
import { Imap } from './imap.mjs';
import { Smtp } from './smtp.mjs';
import { Outbox } from './outbox.mjs';
import { htmlToText } from './html.mjs';
import { buildMessage, decodeWords, domainOf, leaves, msgIds, parseAddresses, parseHeaders, parseMime, partText, rfcDate, splitMessage } from './mime.mjs';
import { baseSubject, capText, commandText, headerSkip, isForwardSubject, loopKey, readAuth, replyReferences, replySubject, splitText, threadOf, toHer, wantsKeep } from './rules.mjs';

const BRIDGE = 'email';
const MAX_MAIL = 25 * 1024 * 1024;
const MAX_OUT_FILES = 20 * 1024 * 1024;
const INLINE_SKIP = 100 * 1024;
const BACKOFF_S = [1, 5, 30, 120];
const AUTH_RETRY_MS = 15 * 60_000;
const PER_SENDER_HOUR = 6;
// The owner gets a much higher ceiling (a busy back-and-forth with her is normal); loop muting still applies.
const OWNER_SENDER_HOUR = 40;
const OWNER_THREAD_DAY = 100;
const PER_THREAD_DAY = 20;
const PER_ADDRESS_HOUR = 6;
const LOOP_WINDOW_MS = 10 * 60_000;
const LOOP_MUTE_MS = 60 * 60_000;
const INDEX_MAX = 5000;
const MAILS_MAX = 600;
const WRITE_CHUNK = 192 * 1024;
const STATE_FILE = 'email-state.json';
const OUTBOX_FILE = 'email-outbox.json';

let sara;
let stopping = false;
let imap = null;
let connected = false;
let lastAuthFail = 0;
let tries = 0;
let wake = null;
let st = { uidvalidity: 0, last: 0, ids: [], mine: [], seen: [], mails: {}, heard: [], counts: {}, told: {} };
let index = new Map();
let outbox;
const outFiles = new Map();

const s = () => sara.settings;
const her = () => String(s().address ?? '').trim().toLowerCase();
const herDomain = () => domainOf(her()) || 'localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const now = () => Date.now();

// ------------------------------------------------------------------ the plugin's own files

function load() {
  try {
    if (existsSync(STATE_FILE)) st = { ...st, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    sara.log(`the saved position couldn't be read (${err.message}); starting from new mail`, 'warn');
  }
  index = new Map(st.ids);
}

function save() {
  st.ids = [...index].slice(-INDEX_MAX);
  st.mine = st.mine.slice(-INDEX_MAX);
  st.seen = st.seen.slice(-INDEX_MAX);
  st.heard = [...new Set(st.heard)].slice(-2000);
  const keys = Object.keys(st.mails);
  if (keys.length > MAILS_MAX) for (const k of keys.slice(0, keys.length - MAILS_MAX)) delete st.mails[k];
  writeJson(STATE_FILE, st);
}

function writeJson(file, v) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, file);
}

function readOutbox() {
  try {
    return existsSync(OUTBOX_FILE) ? JSON.parse(readFileSync(OUTBOX_FILE, 'utf8')) : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ counters (§5.9 rules 6, 7 and the sending caps)

const day = () => new Date().toISOString().slice(0, 10);
function within(key, ms) {
  const list = (st.counts[key] ?? []).filter((t) => now() - t < ms);
  st.counts[key] = list;
  return list;
}
function bump(key) {
  (st.counts[key] ??= []).push(now());
  if (Object.keys(st.counts).length > 3000) for (const k of Object.keys(st.counts).slice(0, 1000)) delete st.counts[k];
}
/** Tells the owner once per key and period. */
function tellOnce(key, text) {
  const k = `${key}:${day()}`;
  if (st.told[k]) return;
  st.told[k] = true;
  for (const old of Object.keys(st.told)) if (!old.endsWith(day())) delete st.told[old];
  void sara.notify(text).catch(() => {});
}

// ------------------------------------------------------------------ sockets (Sara's broker)

/** A broker socket with writes cut to ≤ 192 KB and a wait when the broker's write budget is used. */
async function openSock(endpoint, port) {
  const sock = await sara.net.open(endpoint, { port });
  return {
    greeting: sock.greeting,
    tls: sock.tls,
    onData: sock.onData,
    onClose: sock.onClose,
    close: () => sock.close().catch(() => {}),
    write: async (bytes) => {
      const b = Buffer.from(bytes);
      for (let i = 0; i < b.length; i += WRITE_CHUNK) {
        for (;;) {
          try {
            await sock.write(b.subarray(i, i + WRITE_CHUNK));
            break;
          } catch (err) {
            if (!/paused/i.test(err.message)) throw err;
            await sleep(61_000);
          }
        }
      }
    },
  };
}

// ------------------------------------------------------------------ IMAP: connect, wait, read

const imapPort = () => Number(s().imapPort ?? 993) || 993;
const smtpPort = () => Number(s().smtpPort ?? 465) || 465;

function missing() {
  if (!her()) return 'Type her email address in the settings.';
  if (!String(s().username ?? '').trim()) return 'Type the sign-in name in the settings.';
  if (!sara.secrets.password) return 'Type the app password in the settings.';
  if (!String(s().imapHost ?? '').trim()) return 'Type the IMAP server in the settings.';
  return '';
}

async function runImap() {
  while (!stopping) {
    const need = missing();
    if (need) {
      sara.status('error', need);
      return;
    }
    if (lastAuthFail && now() - lastAuthFail < AUTH_RETRY_MS) await sleep(AUTH_RETRY_MS - (now() - lastAuthFail));
    try {
      await session();
    } catch (err) {
      connected = false;
      imap = null;
      if (stopping) return;
      const msg = String(err?.message ?? err);
      if (err?.kind === 'auth') {
        lastAuthFail = now();
        sara.status('error', 'The mail server refused the password. Check the app password in Settings → Email.');
        continue;
      }
      if (/private local mode/i.test(msg)) sara.status('paused', 'Nothing leaves this computer');
      else sara.status('connecting', `Can't reach ${s().imapHost} (${msg.slice(0, 120)})`);
      const wait = BACKOFF_S[Math.min(tries++, BACKOFF_S.length - 1)] * 1000;
      await sleep(wait);
    }
  }
}

async function session() {
  sara.status('connecting', `${s().imapHost}:${imapPort()}`);
  const sock = await openSock('imap', imapPort());
  imap = new Imap(sock, { log: (t) => sara.log(t, 'warn'), greeting: sock.greeting });
  await imap.greetingPromise;
  if (sock.greeting) await imap.capability(); // after STARTTLS the capabilities are asked again
  await imap.login(String(s().username).trim(), sara.secrets.password);
  const box = await imap.select(String(s().folder || 'INBOX'));
  let uidnext = box.uidnext;
  if (!uidnext) {
    const all = await imap.newUids(0);
    uidnext = (all.at(-1) ?? 0) + 1;
  }
  // §5.3 step 3: the first run starts at UIDNEXT (old mail is never answered); a changed UIDVALIDITY
  // starts again at UIDNEXT (nothing answered twice, nothing old answered late).
  if (!st.uidvalidity || st.uidvalidity !== box.uidvalidity) {
    if (st.uidvalidity) sara.log(`the mailbox was rebuilt (UIDVALIDITY ${st.uidvalidity} → ${box.uidvalidity}); starting from new mail`, 'warn');
    st.uidvalidity = box.uidvalidity ?? 1;
    st.last = Math.max(0, uidnext - 1);
    save();
  }
  connected = true;
  tries = 0;
  lastAuthFail = 0;
  sara.status('ok', `${s().imapHost}${sock.tls?.protocol ? ` · ${sock.tls.protocol}` : ''}${imap.caps.has('IDLE') ? '' : ' · checks every few minutes'}`);
  await check();
  for (;;) {
    if (stopping) return;
    if (imap.caps.has('IDLE')) await imap.idle();
    else {
      await new Promise((r) => {
        wake = r;
        setTimeout(r, (Number(s().checkEvery) || 2) * 60_000).unref?.();
      });
      wake = null;
      await imap.noop();
    }
    await check();
  }
}

async function check() {
  const uids = await imap.newUids(st.last);
  for (const uid of uids) {
    try {
      await handle(uid);
    } catch (err) {
      if (err?.kind === 'closed' || err?.kind === 'timeout' || err?.kind === 'protocol') throw err;
      sara.log(`a mail (uid ${uid}) couldn't be handled: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
    }
    // Saved after the turn is queued: a crash re-reads at most one mail (and the Message-ID check catches it).
    st.last = Math.max(st.last, uid);
    save();
  }
}

async function finish(uid) {
  if (s().markRead !== false) await imap.markSeen(uid).catch(() => {});
  const to = String(s().moveTo ?? '').trim();
  if (to) await imap.move(uid, to).catch(() => {});
}

// ------------------------------------------------------------------ one mail

/** The readable text of a mail, its forwarded parts, attachments and marks (§5.4). */
function readBody(node) {
  const texts = [];
  const htmls = [];
  const forwarded = [];
  const files = [];
  const marks = [];
  let encrypted = false;
  const walk = (n, inAlt) => {
    if (n.type === 'multipart/encrypted' || n.type === 'application/pkcs7-mime' || n.type === 'application/x-pkcs7-mime') encrypted = true;
    if (n.type === 'multipart/alternative') {
      // The plain part when there is one; otherwise the HTML made plain.
      const plain = n.parts.find((p) => p.type === 'text/plain' && p.disposition !== 'attachment');
      const pick = plain ?? n.parts.find((p) => p.type === 'text/html') ?? n.parts.find((p) => p.type.startsWith('multipart/'));
      if (pick) walk(pick, true);
      return;
    }
    if (n.parts.length) return void n.parts.forEach((p) => walk(p, inAlt));
    if (n.type === 'message/rfc822' && n.message) {
      const inner = readBody(n.message);
      const h = n.message.headers;
      forwarded.push([`From: ${decodeWords(h.get('from') ?? '')}`, `Subject: ${decodeWords(h.get('subject') ?? '')}`, `Date: ${h.get('date') ?? ''}`, '', inner.text, ...inner.forwarded].join('\n'));
      return;
    }
    const attach = n.disposition === 'attachment' || (n.filename && n.disposition !== 'inline') || !/^text\/(plain|html)$/.test(n.type);
    if (n.type === 'text/calendar') return void marks.push('[calendar invite]');
    if (!attach) {
      const t = partText(n).text;
      if (n.type === 'text/html') htmls.push(htmlToText(t));
      else texts.push(t);
      return;
    }
    if (n.type === 'application/pgp-signature' || n.type === 'application/pkcs7-signature' || n.type === 'application/x-pkcs7-signature') return; // signed mail is read as plain mail
    // Inline pictures under 100 KB with a Content-ID are logos and signatures: skipped.
    if (n.contentId && n.type.startsWith('image/') && n.body.length < INLINE_SKIP && n.disposition !== 'attachment') return;
    if (!n.body.length) return;
    files.push({ name: (n.filename || `attachment.${n.type.split('/')[1] || 'bin'}`).replace(/[\\/\r\n]/g, '_').slice(0, 120), mime: n.type, data: n.body });
  };
  walk(node, false);
  const text = (texts.length ? texts : htmls).join('\n\n').trim();
  return { text: [text, ...marks].filter(Boolean).join('\n'), forwarded, files, encrypted };
}

async function handle(uid) {
  const hd = await imap.headers(uid);
  if (!hd?.header) return;
  const h = parseHeaders(splitMessage(hd.header).head || hd.header.toString('latin1'));
  const msgId = msgIds(h.get('message-id'))[0] ?? `<uid.${st.uidvalidity}.${uid}@${herDomain()}>`;
  const from = parseAddresses(h.get('from'));
  const addr = from[0]?.address ?? '';
  const skip = async (reason) => {
    if (reason) sara.skip(reason, addr);
    st.seen.push(msgId);
    await finish(uid);
  };
  // §5.9, all on the headers alone.
  if (st.seen.includes(msgId)) return skip('duplicate');
  if (from.length !== 1) return skip('other'); // no From, or more than one address
  if (st.mine.includes(msgId)) return skip('self');
  const why = headerSkip(h, her());
  if (why) return skip(why);
  if (!toHer(h, her())) return skip('not-to-her');
  const auth = readAuth(h, addr);
  const subject = decodeWords(h.get('subject') ?? '').replace(/[\r\n]+/g, ' ').trim();
  const who = await sara.bridgeWho({ bridge: BRIDGE, chatId: addr, fromId: addr, auth: { headers: auth }, subject: baseSubject(subject) }).catch((err) => ({ who: 'none', reason: err.message }));
  if (who.who === 'none') {
    // Sara counted it (a stranger, a failed check); a failed check on his address gets her daily notice.
    if (who.reason === 'unaligned') st.heard.push(addr);
    st.seen.push(msgId);
    return finish(uid);
  }
  st.heard.push(addr);
  const thread = threadOf(h, index) ?? msgId;
  // Rule 6: more than 6 mails from one sender in an hour, or 20 in a thread in a day (40 / 100 for the owner).
  const owner = who.who === 'owner';
  if (within(`from:${addr}`, 3600_000).length >= (owner ? OWNER_SENDER_HOUR : PER_SENDER_HOUR) || within(`thread:${thread}`, 86_400_000).length >= (owner ? OWNER_THREAD_DAY : PER_THREAD_DAY)) {
    tellOnce(`rate:${addr}`, `Email: ${addr} sent more than she answers in an hour (or a day in one thread), so the rest is ignored for now.`);
    return skip('rate');
  }
  if (within(`mute:${thread}`, LOOP_MUTE_MS).length) return skip('loop');
  if ((hd.size ?? 0) > MAX_MAIL) {
    if (who.who === 'owner') queueMail(addr, { text: 'That email is too big for me (up to 25 MB).', replyTo: msgId, ctx: mailRecord(h, msgId, addr, from[0].name, subject, thread, '') });
    return skip('size');
  }
  bump(`from:${addr}`);
  bump(`thread:${thread}`);
  const full = await imap.full(uid);
  if (!full?.body) return skip('other');
  const node = parseMime(full.body);
  const body = readBody(node);
  let { fresh, forwarded } = splitText(body.text);
  if (body.encrypted && !fresh) fresh = '';
  // A Fwd: subject with no forward line: the whole body is someone else's mail (§5.10).
  if (isForwardSubject(subject) && !forwarded && !body.forwarded.length) {
    forwarded = body.text;
    fresh = '';
  }
  const fwdAll = [...body.forwarded, forwarded].filter(Boolean).join('\n\n-----\n\n');
  // Rule 7, the loop breaker: 3 mails in a thread within 10 minutes with the same new part.
  const lk = `loop:${thread}:${loopKey(fresh || fwdAll)}`;
  if (within(lk, LOOP_WINDOW_MS).length >= 2) {
    bump(`mute:${thread}`);
    tellOnce(`loop:${thread}`, `Email: the thread "${baseSubject(subject).slice(0, 60)}" with ${addr} looked like a loop (the same mail three times in 10 minutes), so it's muted for an hour.`);
    return skip('loop');
  }
  bump(lk);
  const rec = mailRecord(h, msgId, addr, from[0].name, subject, thread, fresh);
  st.mails[msgId] = rec;
  index.set(msgId, thread);
  if (body.encrypted && !fresh && !fwdAll) {
    queueMail(addr, { text: "I can't read encrypted mail.", replyTo: msgId, ctx: rec });
    return skip(null);
  }
  const cmdText = commandText(subject, fresh, sara.herName);
  const capped = capText(cmdText);
  const files = body.files.slice(0, 5);
  // "keep this" (the owner only): the whole long mail goes to the library as a document (§12 Q12).
  if (who.who === 'owner' && wantsKeep(fresh) && body.text.length > 8000) files.push({ name: `${(baseSubject(subject) || 'email').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60) || 'email'}.txt`, mime: 'text/plain', data: Buffer.from(body.text, 'utf8') });
  const msg = {
    bridge: BRIDGE,
    chatId: addr,
    fromId: addr,
    from: (from[0].name || addr).slice(0, 60),
    messageId: msgId,
    thread: { id: thread, ...(baseSubject(subject) ? { subject: baseSubject(subject).slice(0, 200) } : {}) },
    auth: { headers: auth },
    chat: { kind: 'dm' },
    text: capped.text,
    ...(fwdAll ? { forwarded: capText(fwdAll).text } : {}),
  };
  const sent = files.length ? sara.sendFile({ ...msg, files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })) }) : sara.bridgeInbound(msg);
  // The turn runs in Sara; the next mail is read meanwhile (a reply in the same thread steers or waits there).
  void Promise.resolve(sent).catch((err) => sara.log(`Sara didn't take a mail: ${String(err?.message ?? err).slice(0, 200)}`, 'warn'));
  st.seen.push(msgId);
  await finish(uid);
}

function mailRecord(h, msgId, addr, name, subject, thread, fresh) {
  return { id: msgId, from: addr, name: String(name ?? '').slice(0, 80), subject: subject.slice(0, 200), refs: msgIds(h.get('references')).slice(-10), date: h.get('date') ?? '', thread, fresh: String(fresh ?? '').split('\n').slice(0, 30).join('\n').slice(0, 4000), at: now() };
}

// ------------------------------------------------------------------ her replies (§5.8)

/** The mail a send answers: the one Sara named, else the newest in that thread from them, else the newest from them. */
function contextFor(to, replyTo, thread) {
  if (replyTo && st.mails[replyTo]?.from === to) return st.mails[replyTo];
  const all = Object.values(st.mails).filter((m) => m.from === to).sort((a, b) => a.at - b.at);
  if (thread?.id) {
    const inThread = all.filter((m) => m.thread === thread.id);
    if (inThread.length) return inThread.at(-1);
  }
  return all.at(-1);
}

function quoteBlock(ctx) {
  if (s().quote === false || !ctx?.fresh) return '';
  let when = ctx.date;
  const d = new Date(ctx.date);
  if (!Number.isNaN(d.getTime())) when = d.toUTCString().replace(/ GMT$/, ' UTC');
  return `\n\nOn ${when}, ${ctx.name || ctx.from} wrote:\n${ctx.fresh.split('\n').slice(0, 30).map((l) => `> ${l}`).join('\n')}`;
}

/** Builds one reply and puts it in the outbox (the caps and "never first" are checked here). */
function queueMail(to, { text, files = [], replyTo, thread, ctx }) {
  const addr = String(to).toLowerCase();
  if (!st.heard.includes(addr)) {
    sara.log(`a mail to ${addr} wasn't sent: she only writes to people whose checked mail she has had`, 'warn');
    return;
  }
  const cap = Number(s().dailyCap) || 50;
  if (within('sent', 86_400_000).length >= cap) {
    tellOnce('cap', `Email: she has sent ${cap} emails today (Most emails she sends a day), so the rest waits in the app until tomorrow.`);
    sara.log(`a mail to ${addr} wasn't sent: the daily cap of ${cap} is reached`, 'warn');
    return;
  }
  if (within(`to:${addr}`, 3600_000).length >= PER_ADDRESS_HOUR) {
    tellOnce(`to:${addr}`, `Email: she has written to ${addr} ${PER_ADDRESS_HOUR} times this hour, so she waits before writing again.`);
    return;
  }
  const c = ctx ?? contextFor(addr, replyTo, thread);
  const id = `<sara.${Math.random().toString(36).slice(2, 12)}${now().toString(36)}@${herDomain()}>`;
  const subject = c ? replySubject(c.subject) : `From ${sara.herName || 'Sara'}: ${String(text).replace(/\s+/g, ' ').slice(0, 50)}`;
  // Total attachments ≤ 20 MB: the biggest stay in the app with a line.
  const keep = [];
  const left = [];
  let total = 0;
  for (const f of [...files].sort((a, b) => a.data.length - b.data.length)) {
    if (total + f.data.length <= MAX_OUT_FILES) {
      keep.push(f);
      total += f.data.length;
    } else left.push(f.name);
  }
  const extra = left.length ? `\n\n(${left.join(', ')} stayed in the app: too big for email.)` : '';
  const raw = buildMessage({
    from: { name: sara.herName || 'Sara', address: her() },
    to: { name: c?.name ?? '', address: addr },
    subject,
    date: new Date(),
    messageId: id,
    ...(c ? { inReplyTo: c.id, references: replyReferences(c.refs ?? [], c.id) } : {}),
    text: `${String(text ?? '').trim()}${extra}${quoteBlock(c)}`,
    files: keep,
    // RFC 3834 §5: her mail is an automatic response, so other responders don't answer it.
    headers: [['Auto-Submitted', 'auto-replied'], ['X-Auto-Response-Suppress', 'All']],
  });
  bump('sent');
  bump(`to:${addr}`);
  st.mine.push(id);
  index.set(id, c?.thread ?? id);
  save();
  outbox.add({ id, to: addr, raw: raw.toString('base64'), thread: c?.thread ?? id });
  sara.bridgeSent({ bridge: BRIDGE, messageId: id });
}

/** Sends the due mail over one SMTP connection. */
async function deliver(items) {
  const out = new Map();
  if (!String(s().smtpHost ?? '').trim()) {
    for (const it of items) out.set(it.id, Object.assign(new Error('there is no SMTP server in the settings'), { transient: true }));
    return out;
  }
  const sock = await openSock('smtp', smtpPort());
  const smtp = new Smtp(sock);
  try {
    await smtp.hello(herDomain(), String(s().username ?? '').trim(), sara.secrets.password ?? '', { greeted: Boolean(sock.greeting) });
    for (const it of items) {
      try {
        await smtp.send(her(), it.to, Buffer.from(it.raw, 'base64'));
        out.set(it.id, null);
        sara.log(`sent a reply to ${it.to}`);
      } catch (err) {
        out.set(it.id, err);
      }
    }
  } finally {
    await smtp.quit();
  }
  return out;
}

async function onSend(m) {
  const chatId = String(m.chatId ?? '').toLowerCase();
  if (m.files?.length) {
    // One mail with the files: the chunks follow as bridge.file; it is sent when they're all in.
    outFiles.set(m.files.map((f) => f.fileId).join(','), { chatId, text: m.text ?? '', replyTo: m.replyTo, thread: m.thread, files: m.files.map((f) => ({ ...f, parts: [], done: false })) });
    return;
  }
  if (!String(m.text ?? '').trim()) return;
  queueMail(chatId, { text: m.text, replyTo: m.replyTo, thread: m.thread });
}

async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    queueMail(out.chatId, { text: out.text, replyTo: out.replyTo, thread: out.thread, files: out.files.map((x) => ({ name: x.name, mime: x.mime, data: Buffer.concat(x.parts) })) });
    return;
  }
}

// ------------------------------------------------------------------ the Test button

async function onTest() {
  const steps = [];
  const step = (label, ok, fix) => steps.push({ label, ok, ...(ok ? {} : { fix }) });
  const need = missing();
  step('Her address, sign-in name, app password and IMAP server are set', !need, need);
  if (need) return { steps };
  step(`Signed in to ${s().imapHost}`, connected, lastAuthFail ? 'The mail server refused the password. Make a new app password and type it in again.' : "Sara couldn't reach the mail server yet. Check the server name and port.");
  if (connected) step(imap?.caps.has('IDLE') ? 'New mail arrives at once (IDLE)' : `New mail is checked every ${Number(s().checkEvery) || 2} minutes`, true);
  if (!String(s().smtpHost ?? '').trim()) step('An SMTP server is set', false, 'Type the SMTP server in the settings.');
  else {
    try {
      const sock = await openSock('smtp', smtpPort());
      const smtp = new Smtp(sock);
      await smtp.hello(herDomain(), String(s().username ?? '').trim(), sara.secrets.password ?? '', { greeted: Boolean(sock.greeting) });
      await smtp.quit();
      step(`Signed in to ${s().smtpHost} for sending (nothing was sent)`, true);
    } catch (err) {
      step(`Signed in to ${s().smtpHost} for sending`, false, String(err?.message ?? err).slice(0, 200));
    }
  }
  return { steps };
}

sara = plugin({
  bridge: { files: true, edit: false, threads: true, oneMessage: true, link: true, textMax: 8000, ack: 'none' },
  bridges: {
    [BRIDGE]: {
      send: (m) => onSend(m),
      file: (m) => onFile(m),
      test: () => onTest(),
    },
  },
  tools: [],
  init: async (api) => {
    sara = api;
    load();
    outbox = new Outbox({
      deliver,
      save: (items) => writeJson(OUTBOX_FILE, items),
      gaveUp: (it, why) => void sara.notify(`Email: I couldn't send my reply to ${it.to}: the server said ${why}`).catch(() => {}),
      items: readOutbox(),
    });
    setTimeout(() => {
      void runImap();
      void outbox.flush();
    }, 0);
  },
});

process.on('SIGTERM', () => {
  stopping = true;
  wake?.();
  outbox?.stop();
  void imap?.logout();
});
