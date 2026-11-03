// The Signal plugin (comes with Sara; docs/design/BRIDGES3.md §4, docs/SIGNAL.md). It talks to the
// owner's own signal-cli JSON-RPC daemon (`daemon --tcp 127.0.0.1:7583 --receive-mode=manual`) over a
// socket Sara holds for it (permissions.connect; the plugin never opens a socket itself), turns
// envelopes into bridge messages (contract v1.2: message ids, sender ids, groups as rooms, keep-up
// lines, reactions, typing, edits) and sends her replies at a human pace. Sara decides who the owner
// is (linking with a code, his pinned safety number), what anyone may do, and every turn.
import { plugin } from './sara-plugin.mjs';
import { Rpc, isRateLimit, isUntrusted } from './rpc.mjs';
import { split, toSignal, TEXT_MAX } from './format.mjs';
import { pacing } from './pace.mjs';
const { Pacer } = pacing('signal');

const BRIDGE = 'signal';
const BACKOFF_S = [1, 5, 30, 60];
const DOWN_NOTIFY_MS = 10 * 60_000;
const DEDUP_MS = 24 * 3600_000;
const MAX_FILE = 20 * 1024 * 1024;
const EDIT_LIMIT = 9;
const GROUP_PREFIX = 'group.';

let sara;
let rpc;
let tries = 0;
let downSince = 0;
let notifiedDown = false;
let stopping = false;
let selfUuid = '';
let version = '';
const pacer = new Pacer();
const seen = new Map();
const groups = new Map();
const refs = new Map();
const outFiles = new Map();
const typingTimers = new Map();

const s = () => sara.settings;
const account = () => String(s().account ?? '').trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? ''));
const accountParam = () => (account() && !isUuid(account()) ? { account: account() } : {});
const isGroupChat = (chatId) => chatId.startsWith(GROUP_PREFIX);
const target = (chatId) => (isGroupChat(chatId) ? { groupId: chatId.slice(GROUP_PREFIX.length) } : { recipient: [chatId] });
const noteToSelf = () => (s().linkedMode === true ? { recipient: [account()] } : undefined);

// ------------------------------------------------------------------ the connection

async function connect() {
  if (stopping) return;
  if (!account()) {
    sara.status('error', 'Type her Signal number or account id in the settings.');
    return;
  }
  sara.status('connecting', `signal-cli at ${s().daemon}`);
  try {
    const sock = await sara.net.open('daemon');
    rpc = new Rpc(sock, { onNotify, onClose: () => retry('closed') });
    const v = await rpc.call('version').catch(() => ({}));
    version = String(v?.version ?? '');
    // Manual receive mode: messages wait on Signal's servers while Sara is down (§4.3).
    await rpc.call('subscribeReceive', accountParam()).catch(async (err) => {
      if (accountParam().account) await rpc.call('subscribeReceive', {});
      else throw err;
    });
    if (isUuid(account())) selfUuid = account().toLowerCase();
    tries = 0;
    downSince = 0;
    notifiedDown = false;
    sara.status('ok', version ? `signal-cli ${version}` : 'connected');
    void refreshGroups();
  } catch (err) {
    rpc = undefined;
    retry(err?.message ?? String(err));
  }
}

function retry(why) {
  rpc = undefined;
  if (stopping) return;
  if (/private local mode/i.test(why)) sara.status('paused', 'Nothing leaves this computer');
  else sara.status('connecting', `Can't reach signal-cli at ${s().daemon} (${String(why).slice(0, 120)})`);
  if (!downSince) downSince = Date.now();
  if (!notifiedDown && Date.now() - downSince > DOWN_NOTIFY_MS) {
    notifiedDown = true;
    void sara.notify(`Signal: I can't reach signal-cli at ${s().daemon}. Is the daemon running?`).catch(() => {});
  }
  const wait = BACKOFF_S[Math.min(tries++, BACKOFF_S.length - 1)] * 1000;
  setTimeout(() => void connect(), wait).unref?.();
}

async function refreshGroups() {
  if (!rpc) return;
  try {
    const list = await rpc.call('listGroups', accountParam());
    for (const g of Array.isArray(list) ? list : []) {
      const members = (g.members ?? []).map((m) => String(m.uuid ?? m.number ?? '').toLowerCase()).filter(Boolean);
      groups.set(String(g.id), { name: String(g.name ?? ''), members, at: Date.now() });
    }
  } catch {
    /* groups are optional */
  }
}

async function groupInfo(id) {
  const g = groups.get(id);
  if (!g || Date.now() - g.at > 5 * 60_000) await refreshGroups();
  return groups.get(id) ?? { name: '', members: [] };
}

/** His safety number as signal-cli shows it (Sara pins it at linking and compares it every time). */
async function identityOf(uuid) {
  // Asked every time (no cache): a changed safety number must pause his powers at his next message.
  let value;
  try {
    const list = await rpc.call('listIdentities', { ...accountParam(), number: uuid });
    const it = (Array.isArray(list) ? list : []).find((x) => String(x.uuid ?? x.number ?? '').toLowerCase() === uuid) ?? (Array.isArray(list) ? list[0] : undefined);
    value = it ? String(it.safetyNumber ?? it.fingerprint ?? '').trim() || undefined : undefined;
  } catch {
    value = undefined;
  }
  return value;
}

// ------------------------------------------------------------------ receiving

function onNotify(method, params) {
  if (method !== 'receive') return;
  const env = params?.envelope ?? params?.result?.envelope;
  if (!env || typeof env !== 'object') return;
  void handleEnvelope(env).catch((err) => sara.log(`an envelope failed: ${err?.message ?? err}`, 'warn'));
}

const marks = (dm) => [
  ...(dm.attachments ?? []).map((x) => (/^image\//.test(x.contentType ?? '') ? '[photo]' : /^audio\//.test(x.contentType ?? '') ? '[voice message]' : /^video\//.test(x.contentType ?? '') ? '[video]' : `[file: ${String(x.filename ?? 'file').slice(0, 80)}]`)),
  ...(dm.sticker ? ['[sticker]'] : []),
];

async function handleEnvelope(env) {
  const src = String(env.sourceUuid ?? (isUuid(env.source) ? env.source : '') ?? '').toLowerCase();
  const ts = Number(env.timestamp ?? env.dataMessage?.timestamp ?? 0);
  // Her own messages from her other devices (and, in linked mode, his Note to Self).
  const sent = env.syncMessage?.sentMessage;
  if (sent) {
    if (src) selfUuid ||= src;
    const toSelf = String(sent.destinationUuid ?? '').toLowerCase() === selfUuid || String(sent.destinationNumber ?? sent.destination ?? '') === account();
    if (s().linkedMode === true && toSelf && !sent.groupInfo) {
      if (String(sent.message ?? '').startsWith('🤖')) return; // her own reply
      return inbound({ uuid: selfUuid || src, name: env.sourceName, ts, dm: sent, linked: true });
    }
    if (sent.groupInfo?.groupId) logGroup({ chatId: GROUP_PREFIX + sent.groupInfo.groupId, messageId: `${src}:${ts}`, fromId: src, from: sara.herName || 'Sara', who: 'her', text: [sent.message ?? '', ...marks(sent)].filter(Boolean).join(' '), at: ts });
    return;
  }
  if (!src) return;
  // Linked mode: only his Note to Self, nobody else (she would be writing as him).
  if (s().linkedMode === true) {
    sara.skip('linked-mode', src);
    return;
  }
  if (env.editMessage?.dataMessage) {
    const g = env.editMessage.dataMessage.groupInfo?.groupId;
    if (g) logGroup({ chatId: GROUP_PREFIX + g, messageId: `${src}:${Number(env.editMessage.targetSentTimestamp ?? 0)}`, fromId: src, from: env.sourceName, text: String(env.editMessage.dataMessage.message ?? ''), edited: true });
    return;
  }
  const dm = env.dataMessage;
  if (!dm) return;
  if (dm.remoteDelete && dm.groupInfo?.groupId) return logGroup({ chatId: GROUP_PREFIX + dm.groupInfo.groupId, messageId: `${src}:${Number(dm.remoteDelete.timestamp ?? 0)}`, fromId: src, text: '', deleted: true });
  if (dm.reaction) return;
  return inbound({ uuid: src, name: env.sourceName, ts, dm });
}

function logGroup(l) {
  sara.bridgeLog({ bridge: BRIDGE, chatId: l.chatId, messageId: l.messageId, fromId: l.fromId, from: String(l.from ?? 'someone').slice(0, 60), who: l.who ?? 'person', text: String(l.text ?? '').slice(0, 2000), ...(l.replyTo ? { replyTo: l.replyTo } : {}), ...(l.at ? { at: new Date(l.at).toISOString() } : {}), ...(l.edited ? { edited: true } : {}), ...(l.deleted ? { deleted: true } : {}) });
}

async function inbound({ uuid, name, ts, dm, linked = false }) {
  const messageId = `${uuid}:${ts}`;
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > DEDUP_MS) seen.delete(k);
  if (seen.has(messageId)) return;
  seen.set(messageId, now);
  const groupId = dm.groupInfo?.groupId ? String(dm.groupInfo.groupId) : '';
  const chatId = groupId ? GROUP_PREFIX + groupId : linked ? account() : uuid;
  const text = String(dm.message ?? '').trim();
  if (dm.viewOnce) return reply(chatId, "I can't open view-once pictures.", false);
  const mentions = dm.mentions ?? [];
  const herIds = new Set([selfUuid, account().toLowerCase()].filter(Boolean));
  const isHer = (...ids) => ids.some((x) => x && herIds.has(String(x).toLowerCase()));
  const addressed = mentions.some((m) => isHer(m.uuid, m.number));
  const quoteAuthor = String(dm.quote?.authorUuid ?? dm.quote?.author ?? '').toLowerCase();
  const replyToHer = isHer(dm.quote?.authorUuid, dm.quote?.authorNumber, dm.quote?.author);
  const replyTo = dm.quote?.id ? `${quoteAuthor}:${Number(dm.quote.id)}` : undefined;
  let chat = { kind: 'dm' };
  if (groupId) {
    const g = await groupInfo(groupId);
    chat = { kind: 'group', title: g.name || String(dm.groupInfo.groupName ?? '') || 'Signal group', members: g.members.slice(0, 1000) };
    logGroup({ chatId, messageId, fromId: uuid, from: name, text: [text, ...marks(dm)].filter(Boolean).join(' '), replyTo, at: ts });
  }
  if (!text && !(dm.attachments ?? []).length) return;
  // In a group she only answers when called; every DM may be answered (Sara decides the rest).
  if (!groupId || addressed || replyToHer) pacer.heard(chatId);
  const identity = !groupId || addressed || replyToHer ? await identityOf(uuid) : undefined;
  const base = { bridge: BRIDGE, chatId, from: String(name ?? '').slice(0, 60) || 'someone', fromId: uuid, messageId, chat, addressed, replyToHer, ...(replyTo ? { replyTo } : {}), ...(identity ? { identity } : {}) };
  if (s().readReceipts === true && rpc && !groupId) void rpc.call('sendReceipt', { ...accountParam(), recipient: uuid, targetTimestamp: [ts], type: 'read' }).catch(() => {});
  const files = [];
  for (const a of (dm.attachments ?? []).slice(0, 4)) {
    if ((a.size ?? 0) > MAX_FILE) {
      await reply(chatId, 'That file is too big for me here (up to 20 MB).', groupId !== '');
      continue;
    }
    if (/^audio\//.test(a.contentType ?? '')) continue; // voice notes: not transcribed here yet (marked in keep-up)
    try {
      const b64 = await rpc.call('getAttachment', { ...accountParam(), id: a.id, ...(groupId ? { groupId } : { recipient: uuid }) });
      const data = Buffer.from(String(typeof b64 === 'string' ? b64 : b64?.data ?? ''), 'base64');
      if (data.length && data.length <= MAX_FILE) files.push({ name: String(a.filename ?? 'file').slice(0, 120), mime: String(a.contentType ?? ''), data });
    } catch (err) {
      sara.log(`an attachment couldn't be fetched: ${err?.message ?? err}`, 'warn');
    }
  }
  if (files.length) await sara.sendFile({ ...base, text, files });
  else if (text) await sara.bridgeInbound({ ...base, text });
  snapshot();
}

let snapTimer;
function snapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => void sara.kv.set('heard', pacer.snapshot()).catch(() => {}), 2000);
  snapTimer.unref?.();
}

// ------------------------------------------------------------------ sending

async function sendOne(chatId, text, extra = {}) {
  if (!rpc) throw new Error('not connected to signal-cli');
  const isGroup = isGroupChat(chatId);
  const where = noteToSelf() ?? target(chatId);
  const body = s().linkedMode === true ? `🤖 ${sara.herName || 'Sara'}: ${text}` : text;
  const { text: plain, styles } = toSignal(body);
  return pacer.send(chatId, isGroup, async () => {
    try {
      const r = await rpc.call('send', { ...accountParam(), ...where, message: plain, ...(styles.length ? { textStyle: styles } : {}), ...extra });
      return Number(r?.timestamp ?? 0);
    } catch (err) {
      if (isRateLimit(err)) {
        if (pacer.rateLimited(chatId)) void sara.notify('Signal is limiting her messages. Sends to that chat pause for an hour. If it keeps happening, solve the captcha with signal-cli submitRateLimitChallenge (docs/SIGNAL.md).').catch(() => {});
        sara.status('error', 'Signal rate limit: sends paused');
      } else if (isUntrusted(err)) sara.log('a send failed: the recipient\'s safety number is not trusted in signal-cli', 'warn');
      throw err;
    }
  });
}

async function reply(chatId, text, isGroupQuote, quote) {
  const parts = split(text, TEXT_MAX);
  let first = 0;
  for (const [i, p] of parts.entries()) {
    const extra = i === 0 && isGroupQuote && quote ? quote : {};
    const t = await sendOne(chatId, p, extra).catch((err) => {
      sara.log(`a reply wasn't sent: ${err?.message ?? err}`, err?.refused ? 'info' : 'warn');
      return 0;
    });
    if (i === 0) first = t;
  }
  return first;
}

const quoteOf = (messageId) => {
  const [author, ts] = String(messageId ?? '').split(':');
  return author && Number(ts) ? { quoteTimestamp: Number(ts), quoteAuthor: author } : undefined;
};

async function onSend(m) {
  const chatId = String(m.chatId);
  if (m.files?.length) {
    // Her pictures and files: the chunks follow as bridge.file; one send with data URIs when they're all in.
    outFiles.set(m.files.map((f) => f.fileId).join(','), { chatId, text: m.text ?? '', files: m.files.map((f) => ({ ...f, parts: [], done: false })), replyTo: m.replyTo });
    return;
  }
  const quote = isGroupChat(chatId) ? quoteOf(m.replyTo) : undefined;
  const ts = await reply(chatId, String(m.text ?? ''), Boolean(quote), quote);
  if (m.ref && ts) {
    refs.set(m.ref, { ts, edits: 0, chatId });
    sara.bridgeSent({ bridge: BRIDGE, ref: m.ref, messageId: `${selfUuid}:${ts}` });
  } else if (ts) sara.bridgeSent({ bridge: BRIDGE, messageId: `${selfUuid}:${ts}` });
}

async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    const attachments = out.files.map((x) => `data:${x.mime || 'application/octet-stream'};filename=${String(x.name).replace(/[;,]/g, '_')};base64,${Buffer.concat(x.parts).toString('base64')}`);
    const quote = isGroupChat(out.chatId) ? quoteOf(out.replyTo) : undefined;
    await sendOne(out.chatId, out.text.slice(0, TEXT_MAX), { attachments, ...(quote ?? {}) }).catch((err) => sara.log(`a file wasn't sent: ${err?.message ?? err}`, 'warn'));
    return;
  }
}

async function onEdit(m) {
  const r = refs.get(m.ref);
  if (!r || !rpc) return;
  // Signal allows 10 edits a message within 24 h; Sara's budget (editLimit 9) keeps one spare.
  if (r.edits >= EDIT_LIMIT - 1) return;
  r.edits++;
  await sendOne(r.chatId, String(m.text ?? ''), { editTimestamp: r.ts }).catch(() => {});
}

function onTyping(m) {
  const chatId = String(m.chatId);
  clearInterval(typingTimers.get(chatId));
  typingTimers.delete(chatId);
  if (!rpc || s().typing === false || s().linkedMode === true) return;
  const where = target(chatId);
  if (m.on) {
    const tick = () => void rpc?.call('sendTyping', { ...accountParam(), ...where }).catch(() => {});
    tick();
    const t = setInterval(tick, 10_000);
    t.unref?.();
    typingTimers.set(chatId, t);
  } else void rpc.call('sendTyping', { ...accountParam(), ...where, stop: true }).catch(() => {});
}

async function onReact(m) {
  const q = quoteOf(m.messageId);
  if (!rpc || !q) return;
  try {
    await rpc.call('sendReaction', { ...accountParam(), ...target(String(m.chatId)), emoji: String(m.emoji ?? '👀'), targetAuthor: q.quoteAuthor, targetTimestamp: q.quoteTimestamp });
  } catch {
    // The reaction failed: today's plugin line instead.
    await reply(String(m.chatId), "Got it, I'll use that at the next step.", false);
  }
}

async function onTrust(m) {
  if (!rpc) return;
  await rpc.call('trust', { ...accountParam(), recipient: String(m.chatId), trustAllKnownKeys: true }).catch((err) => sara.log(`trust failed: ${err?.message ?? err}`, 'warn'));
}

async function onLeave(m) {
  const chatId = String(m.chatId);
  if (!rpc || !isGroupChat(chatId)) return;
  await rpc.call('quitGroup', { ...accountParam(), groupId: chatId.slice(GROUP_PREFIX.length) }).catch((err) => sara.log(`leaving the group failed: ${err?.message ?? err}`, 'warn'));
}

/** The Test button: each step with a ✓ or the fix. Sends nothing to anyone. */
async function onTest() {
  const steps = [];
  const fix = (label, ok, f) => steps.push({ label, ok, ...(ok ? {} : { fix: f }) });
  fix('Her account is set', Boolean(account()), 'Type her Signal number (+ form) or account id in the settings.');
  if (!rpc) {
    fix(`signal-cli answers at ${s().daemon}`, false, `Start it: signal-cli -a ${account() || '+…'} daemon --tcp ${s().daemon} --receive-mode=manual`);
    return { steps };
  }
  fix(`signal-cli answers at ${s().daemon}`, true);
  let v = {};
  try {
    v = await rpc.call('version');
    fix(`signal-cli ${String(v?.version ?? '')}`.trim(), true);
  } catch (err) {
    fix('signal-cli says its version', false, String(err?.message ?? err).slice(0, 200));
  }
  try {
    await rpc.call('listIdentities', accountParam());
    fix('The account works in signal-cli', true);
  } catch (err) {
    fix('The account works in signal-cli', false, `Link or register it in signal-cli first (${String(err?.message ?? err).slice(0, 120)}).`);
  }
  fix(s().linkedMode === true ? 'Linked to your own Signal: Note to Self only' : 'She has a number of her own', true);
  return { steps };
}

sara = plugin({
  bridge: { files: true, edit: true, places: true, typing: true, react: true, log: true, link: true, editLimit: EDIT_LIMIT, editEveryMs: 15_000, textMax: TEXT_MAX, ack: 'react' },
  bridges: {
    [BRIDGE]: {
      send: (m) => onSend(m),
      edit: (m) => onEdit(m),
      file: (m) => onFile(m),
      typing: (m) => onTyping(m),
      react: (m) => onReact(m),
      trust: (m) => onTrust(m),
      leave: (m) => onLeave(m),
      test: () => onTest(),
    },
  },
  tools: [],
  init: async (api) => {
    sara = api;
    pacer.restore(await api.kv.get('heard').catch(() => ({})));
    setTimeout(() => void connect(), 0);
  },
});

process.on('SIGTERM', () => {
  stopping = true;
  void rpc?.close();
});
