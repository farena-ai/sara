// The Slack plugin (comes with Sara; docs/ops/EC1_DESIGN.md, docs/SLACK.md). A Slack app he creates
// from the manifest on the setup card talks with him in its DMs and, when mentioned, in the channels he
// switched on. Socket Mode: Sara's socket broker holds an outbound WebSocket to Slack (no public
// address); events, button presses and /sara commands arrive as envelopes, each acknowledged at once.
// Messages go out with the Web API (chat.postMessage, chat.update, the external file upload). Sara
// decides who the owner is (linking with a code), what anyone may do and every turn; her requests for
// his OK come as Allow / Deny buttons that only he can answer (Sara checks it, not the plugin).
import { plugin } from './sara-plugin.mjs';
import { Api, ENDPOINT, SlackError } from './api.mjs';
import { WebSocketClient } from './ws.mjs';
import { fromSlack, split, toMrkdwn } from './mrkdwn.mjs';
import { codeOf, diagnose } from './diagnose.mjs';
import { pacing } from './pace.mjs';
const { Pacer, CapError } = pacing('slack');

const BRIDGE = 'slack';
const TEXT_MAX = 12_000;
const SECTION_MAX = 2_900;
const OWNER_FILE_MAX = 20 * 1024 * 1024;
const SEEN_MAX = 2_000;
const PING_MS = 30_000;
const WATCHDOG_MS = 90_000;
const BACKOFF_MAX_MS = 60_000;
const EMOJI = { '👀': 'eyes', '✅': 'white_check_mark', '👍': '+1', '❤️': 'heart', '🙂': 'slightly_smiling_face' };
const SKIP_SUBTYPES = new Set(['message_changed', 'message_deleted', 'bot_message', 'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'pinned_item', 'ekm_access_denied', 'me_message']);

let sara;
let api;
let ws;
let running = false;
let helloSeen = false;
let refreshed = false;
let connectedSince = 0;
let tokenGone = '';
const me = { user: '', bot: '', team: '', url: '' };
const pacer = new Pacer();
const seen = new Set();
const users = new Map();
const channels = new Map();
const threadOf = new Map();
const refs = new Map();
const asks = new Map();
const outFiles = new Map();
let capNoticeDay = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const remember = (map, k, v, max = 500) => {
  map.set(k, v);
  if (map.size > max) map.delete(map.keys().next().value);
};
const isoOf = (ts) => {
  const n = Number(String(ts).split('.')[0]) * 1000;
  return Number.isFinite(n) && n > 0 ? new Date(Math.min(n, Date.now())).toISOString() : undefined;
};

// ------------------------------------------------------------------ connecting (Socket Mode)

async function start() {
  if (!api.bot || !api.app) return sara.status('error', diagnose('NOT_SET').title);
  try {
    await whoami();
  } catch (err) {
    return fail(err);
  }
  running = true;
  sara.status('connecting', me.team);
  void loop();
}

async function whoami() {
  const a = await api.call('auth.test');
  Object.assign(me, { user: String(a.user_id ?? ''), bot: String(a.bot_id ?? ''), team: String(a.team ?? ''), url: String(a.url ?? '') });
  return a;
}

function fail(err) {
  const code = codeOf(err);
  if (code === 'TOKEN_GONE' || code === 'TOKEN_WRONG') return gone(code);
  if (code === 'PRIVATE_LOCAL') return sara.status('paused', diagnose('PRIVATE_LOCAL').title);
  sara.status('error', diagnose(code, err?.message).title);
}

/** Her token stopped working: the loop stops and he is told once (never a reconnect loop). */
function gone(code) {
  running = false;
  tokenGone = code;
  sara.status('error', diagnose(code).title);
  void ws?.close();
  void (async () => {
    const tail = `${api.bot.slice(-6)}${api.app.slice(-6)}`;
    if ((await sara.kv.get('tokenGoneTold').catch(() => null)) === tail) return;
    await sara.kv.set('tokenGoneTold', tail).catch(() => {});
    await sara.notify(`Slack: ${diagnose(code).title} Paste new tokens in Settings → Slack.`).catch(() => {});
  })();
}

async function loop() {
  let attempt = 0;
  while (running) {
    let wait;
    try {
      const r = await api.call('apps.connections.open', {}, { app: true });
      await session(String(r.url ?? ''));
      attempt = helloSeen ? 0 : attempt + 1;
    } catch (err) {
      if (!running) return;
      const code = codeOf(err);
      if (code === 'TOKEN_GONE' || code === 'TOKEN_WRONG') return gone(code);
      if (code === 'PRIVATE_LOCAL') sara.status('paused', diagnose('PRIVATE_LOCAL').title);
      else if (code !== 'RATE_LIMITED') sara.status('error', diagnose(code, err?.message).title);
      wait = err instanceof SlackError ? err.retryMs : undefined;
      attempt++;
    }
    if (!running) return;
    // Slack's own refresh (`disconnect`) reconnects at once; anything else backs off 1, 2, 4 … 60 s.
    if (refreshed) wait = 0;
    else wait ??= Math.round(Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, attempt - 1)) * (0.8 + Math.random() * 0.4));
    refreshed = false;
    if (wait) await sleep(wait);
  }
}

/** One WebSocket: resolves when it closes (a drop, Slack's disconnect, a silent link). */
async function session(url) {
  helloSeen = false;
  const c = new WebSocketClient(sara, ENDPOINT);
  ws = c;
  const closed = new Promise((resolve) => c.onClose(resolve));
  c.onMessage((t) => void onFrame(c, t).catch((err) => sara.log(`an envelope failed: ${err?.message ?? err}`, 'warn')));
  await c.connect(url);
  const timer = setInterval(() => {
    if (Date.now() - c.lastFrameAt > WATCHDOG_MS) void c.close(1001);
    else void c.ping();
  }, PING_MS);
  timer.unref?.();
  const why = await closed;
  clearInterval(timer);
  if (running && helloSeen) {
    sara.status('connecting', me.team);
    sara.log(`Socket Mode closed (${why}); connecting again`);
  }
}

async function onFrame(c, raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === 'hello') {
    helloSeen = true;
    connectedSince = Date.now();
    tokenGone = '';
    sara.status('ok', me.team);
    return;
  }
  if (m.type === 'disconnect') {
    refreshed = true;
    return void c.close(1000);
  }
  if (!m.envelope_id) return;
  // Acknowledged first (Slack resends after 3 s), then handled.
  await c.send(JSON.stringify({ envelope_id: m.envelope_id }));
  const p = m.payload ?? {};
  if (m.type === 'events_api') return onEvent(p.event ?? {});
  if (m.type === 'interactive' && p.type === 'block_actions') return onAction(p);
  if (m.type === 'slash_commands') return onSlash(p);
}

// ------------------------------------------------------------------ who and where

async function userName(id) {
  if (users.has(id)) return users.get(id);
  let name = id;
  try {
    const u = (await api.call('users.info', { user: id })).user ?? {};
    name = String(u.profile?.display_name || u.real_name || u.name || id).slice(0, 60);
  } catch {
    /* the id is enough */
  }
  remember(users, id, name);
  return name;
}

async function channelName(id) {
  if (channels.get(id)?.name) return channels.get(id).name;
  let name = '';
  try {
    name = String((await api.call('conversations.info', { channel: id })).channel?.name ?? '');
  } catch {
    /* unnamed */
  }
  remember(channels, id, { name });
  return name;
}

const isDm = (channel) => String(channel).startsWith('D');

async function baseOf(channel, user, ts) {
  const dm = isDm(channel);
  const title = dm ? '' : `#${(await channelName(channel)) || channel}`;
  return { bridge: BRIDGE, chatId: channel, fromId: String(user).toLowerCase(), from: await userName(user), ...(ts ? { messageId: String(ts), at: isoOf(ts) } : {}), chat: dm ? { kind: 'dm' } : { kind: 'group', title, ownerIn: false } };
}

// ------------------------------------------------------------------ messages in

async function onEvent(ev) {
  if (ev.type !== 'message' && ev.type !== 'app_mention') return;
  // His DMs come as message.im; app_mention covers channels (a DM mention is the same message again).
  if (ev.type === 'message' && ev.channel_type !== 'im') return;
  if (ev.type === 'app_mention' && isDm(ev.channel)) return;
  if (ev.bot_id || !ev.user || ev.user === me.user || SKIP_SUBTYPES.has(ev.subtype)) return;
  const key = `${ev.channel}:${ev.ts}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  const dm = isDm(ev.channel);
  remember(threadOf, String(ev.ts), String(ev.thread_ts ?? ev.ts));
  const base = await baseOf(ev.channel, ev.user, ev.ts);
  if (dm && ev.thread_ts && ev.thread_ts !== ev.ts) base.thread = { id: String(ev.thread_ts) };
  if (!dm) base.addressed = true;
  const text = fromSlack(ev.text, me.user);
  if (Array.isArray(ev.files) && ev.files.length) return onFiles(ev.files, base, text);
  if (!text) return;
  return sara.bridgeInbound({ ...base, text });
}

async function onFiles(files, base, text) {
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId: base.chatId, fromId: base.fromId }).catch(() => ({ who: 'none' }))).who;
  const pics = files.filter((f) => /^image\//.test(f.mimetype ?? ''));
  const mark = pics.length === files.length ? '[photo]' : '[file]';
  // Strangers' files are never downloaded; partners' only pictures (the Matrix rule).
  const take = who === 'owner' ? files : who === 'partner' ? pics : [];
  if (!take.length) return sara.bridgeInbound({ ...base, text: text || mark });
  const got = [];
  for (const f of take.slice(0, 5)) {
    if (Number(f.size) > OWNER_FILE_MAX) {
      sara.failed({ bridge: BRIDGE, chatId: base.chatId, code: 'FILE_TOO_BIG', title: diagnose('FILE_TOO_BIG').title, reply: false });
      continue;
    }
    try {
      const r = await api.download(f.url_private_download ?? f.url_private, OWNER_FILE_MAX);
      got.push({ name: String(f.name ?? 'file').slice(0, 120), mime: f.mimetype || r.type, data: r.bytes });
    } catch (err) {
      sara.log(`a file couldn't be downloaded: ${err?.message ?? err}`, 'warn');
    }
  }
  if (!got.length) return sara.bridgeInbound({ ...base, text: text || mark });
  return sara.sendFile({ ...base, text, files: got });
}

/** A button press: Allow / Deny (Sara decides), ⏹ on the progress message, or a reply button's words. */
async function onAction(p) {
  const action = (p.actions ?? [])[0] ?? {};
  const id = String(action.action_id ?? '');
  const user = String(p.user?.id ?? '');
  const channel = String(p.channel?.id ?? p.container?.channel_id ?? '');
  const ts = String(p.container?.message_ts ?? p.message?.ts ?? '');
  if (!user || !channel) return;
  const base = await baseOf(channel, user);
  const ap = /^ap:([\w-]{1,80}):([01])$/.exec(id);
  if (ap) {
    const r = await sara.bridgeInbound({ ...base, text: '', action: 'decide', approval: ap[1], allow: ap[2] === '1' }).catch((err) => ({ decided: 'refused', line: String(err?.message ?? '') }));
    const line = String(r.line ?? '');
    if (r.decided === 'allowed' || r.decided === 'denied') {
      const was = asks.get(ts) ?? '';
      asks.delete(ts);
      const text = was ? `${was}\n${line}` : line;
      await pace(channel, () => api.call('chat.update', { channel, ts, text, blocks: [section(text)] })).catch((err) => sara.log(`an update failed: ${err?.message ?? err}`, 'warn'));
    } else if (line) await api.call('chat.postEphemeral', { channel, user, text: line }).catch(() => undefined);
    return;
  }
  if (id.startsWith('st:')) return sara.bridgeInbound({ ...base, text: '', action: 'stop', ref: id.slice(3) });
  const words = String(action.text?.text ?? action.value ?? '').slice(0, 200);
  if (words) return sara.bridgeInbound({ ...base, text: words });
}

/** `/sara new` → the shared `/new`; `/sara` alone → `/help`; `/sara link 123456` links. */
async function onSlash(p) {
  const user = String(p.user_id ?? '');
  const channel = String(p.channel_id ?? '');
  if (!user || !channel) return;
  const words = String(p.text ?? '').trim().replace(/^\//, '');
  const base = await baseOf(channel, user);
  if (!isDm(channel)) base.addressed = true;
  return sara.bridgeInbound({ ...base, text: words ? `/${words}` : '/help' });
}

// ------------------------------------------------------------------ sending

const retryOf = (err) => (err instanceof SlackError ? err.retryMs : undefined);
const pace = (channel, fn) => pacer.send(channel, fn, retryOf);
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX - 1)}…` : text || ' ' } });
const button = (b) => ({ type: 'button', text: { type: 'plain_text', text: String(b.label ?? b.id).slice(0, 75), emoji: true }, action_id: String(b.id).slice(0, 255), value: String(b.id).slice(0, 2000), ...(String(b.id).endsWith(':1') && String(b.id).startsWith('ap:') ? { style: 'primary' } : String(b.id).startsWith('ap:') ? { style: 'danger' } : {}) });

function refused(chatId, err, started) {
  if (err instanceof CapError) {
    const day = new Date().toISOString().slice(0, 10);
    if (capNoticeDay !== day) {
      capNoticeDay = day;
      void sara.notify(`Slack: she reached the ${err.cap} cap of messages, so the rest stays in the app.`).catch(() => {});
    }
    return;
  }
  const code = codeOf(err);
  sara.log(`a send was refused: ${err?.message ?? err}`, 'warn');
  if (code === 'TOKEN_GONE' || code === 'TOKEN_WRONG') gone(code);
  sara.failed({ bridge: BRIDGE, chatId, code, title: diagnose(code, '', err?.needed ? { scope: err.needed } : {}).title, reply: !started });
}

function threadFor(m) {
  if (m.thread && typeof m.thread === 'object' && m.thread.id) return String(m.thread.id);
  if (typeof m.thread === 'string' && m.thread) return m.thread;
  if (m.replyTo && !isDm(m.chatId)) return threadOf.get(String(m.replyTo)) ?? String(m.replyTo);
  return undefined;
}

async function onSend(m) {
  const channel = String(m.chatId);
  const started = m.started === true;
  const thread = threadFor(m);
  try {
    if (m.files?.length) {
      outFiles.set(m.files.map((f) => f.fileId).join(','), { channel, thread, text: String(m.text ?? ''), files: m.files.map((f) => ({ ...f, parts: [], done: false })), started });
      return;
    }
    const text = String(m.text ?? '');
    if (!text.trim()) return;
    const mrk = toMrkdwn(text);
    const extra = m.buttons?.length || m.ref ? { blocks: [section(mrk), { type: 'actions', elements: m.ref ? [button({ id: `st:${m.ref}`, label: '⏹' })] : m.buttons.slice(0, 5).map(button) }] } : {};
    let first = '';
    const parts = extra.blocks ? [mrk] : split(mrk, TEXT_MAX);
    for (const [i, part] of parts.entries()) {
      const r = await pace(channel, () => api.call('chat.postMessage', { channel, text: part, ...extra, ...(thread ? { thread_ts: thread } : {}), unfurl_links: false, unfurl_media: false }));
      if (i === 0) first = String(r.ts ?? '');
    }
    if (first && m.buttons?.some((b) => String(b.id).startsWith('ap:'))) remember(asks, first, mrk, 200);
    if (m.ref && first) remember(refs, m.ref, { channel, ts: first }, 200);
    if (first) sara.bridgeSent({ bridge: BRIDGE, ...(m.ref ? { ref: m.ref } : {}), messageId: first });
  } catch (err) {
    refused(channel, err, started);
  }
}

/** The progress message: chat.update, keeping the ⏹ until the ✅ summary. */
async function onEdit(m) {
  const target = refs.get(m.ref);
  if (!target) return;
  const mrk = toMrkdwn(String(m.text ?? ''));
  const done = /^✅/.test(String(m.text ?? '').trim());
  await pace(target.channel, () => api.call('chat.update', { channel: target.channel, ts: target.ts, text: mrk, blocks: done ? [section(mrk)] : [section(mrk), { type: 'actions', elements: [button({ id: `st:${m.ref}`, label: '⏹' })] }] })).catch((err) => sara.log(`an edit failed: ${err?.message ?? err}`, 'warn'));
}

/** Her pictures and files: the external upload (each within 20 MB), her words as the first file's comment. */
async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    let comment = out.text ? toMrkdwn(out.text) : '';
    try {
      for (const x of out.files) {
        const data = Buffer.concat(x.parts);
        if (data.length > OWNER_FILE_MAX) {
          sara.failed({ bridge: BRIDGE, chatId: out.channel, code: 'FILE_TOO_BIG', title: diagnose('FILE_TOO_BIG').title, reply: !out.started });
          continue;
        }
        await pace(out.channel, () => api.upload(out.channel, { name: x.name, mime: x.mime, data }, { thread: out.thread, comment }));
        comment = '';
      }
      if (comment) await pace(out.channel, () => api.call('chat.postMessage', { channel: out.channel, text: comment, ...(out.thread ? { thread_ts: out.thread } : {}) }));
    } catch (err) {
      refused(out.channel, err, out.started);
    }
    return;
  }
}

async function onReact(m) {
  await api.call('reactions.add', { channel: String(m.chatId), timestamp: String(m.messageId), name: EMOJI[m.emoji] ?? 'eyes' }).catch(() => undefined);
}

function onLeave(m) {
  channels.delete(String(m.chatId));
}

// ------------------------------------------------------------------ the setup card's checks

async function onCheck(m) {
  const step = String(m.step ?? '');
  const fail2 = (code, detail, params) => ({ ok: false, diagnosis: diagnose(code, detail, params) });
  const g = (err, which) => ({ ...fail2(codeOf(err), err?.message, err?.needed ? { scope: err.needed } : {}), which });
  if (step === 'auth') {
    if (!api.bot || !api.app) return fail2('NOT_SET');
    let a;
    try {
      a = await whoami();
    } catch (err) {
      return g(err, 'bot');
    }
    try {
      await api.call('apps.connections.open', {}, { app: true });
    } catch (err) {
      return g(err, 'app');
    }
    return { ok: true, team: String(a.team ?? ''), teamUrl: String(a.url ?? ''), userId: me.user, botId: me.bot };
  }
  if (step === 'status') {
    return { ok: true, connected: Boolean(ws?.open && helloSeen), since: connectedSince ? new Date(connectedSince).toISOString() : null, team: me.team, teamUrl: me.url, me: me.user, ended: tokenGone, running };
  }
  if (step === 'channels') {
    try {
      const r = await api.call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 });
      const list = (r.channels ?? []).slice(0, 200).map((c) => ({ id: String(c.id), name: String(c.name ?? ''), private: c.is_private === true }));
      for (const c of list) remember(channels, c.id, { name: c.name });
      return { ok: true, channels: list };
    } catch (err) {
      return g(err);
    }
  }
  if (step === 'logout') {
    running = false;
    await ws?.close();
    // A real revoke of the bot token at Slack; the app-level token is revoked on Slack's page.
    const r = await api.call('auth.revoke').catch((err) => ({ ok: false, error: err?.error }));
    return { ok: r.ok === true };
  }
  return fail2('UNKNOWN', `no check called ${step.slice(0, 40)}`);
}

/** The Test button: read-only calls, sends nothing to anyone. */
async function onTest() {
  const steps = [];
  const add = (label, ok, fix) => steps.push({ label, ok, ...(ok ? {} : { fix }) });
  add('Both Slack tokens are set', Boolean(api.bot && api.app), 'Step 2: paste both tokens.');
  if (!api.bot || !api.app) return { steps };
  let a;
  try {
    a = await api.call('auth.test');
  } catch (err) {
    a = { error: err };
  }
  add(a.error ? 'The bot token works' : `The bot token works (${a.team})`, !a.error, diagnose(codeOf(a.error)).title);
  let o;
  try {
    o = await api.call('apps.connections.open', {}, { app: true });
  } catch (err) {
    o = { error: err };
  }
  add('Socket Mode answers (the app-level token)', !o.error, diagnose(codeOf(o.error)).title);
  add('Connected to Slack now', Boolean(ws?.open && helloSeen), 'Wait a moment, or paste the tokens again.');
  return { steps };
}

sara = plugin({
  bridge: { files: true, edit: true, places: true, react: true, threads: true, link: true, editEveryMs: 3000, textMax: TEXT_MAX, ack: 'react', buttons: 3, maxBytes: OWNER_FILE_MAX },
  bridges: {
    [BRIDGE]: {
      send: (m) => onSend(m),
      edit: (m) => onEdit(m),
      file: (m) => onFile(m),
      react: (m) => onReact(m),
      leave: (m) => onLeave(m),
      check: (m) => onCheck(m),
      test: () => onTest(),
    },
  },
  tools: [],
  init: async (api0) => {
    sara = api0;
    api = new Api(sara);
    setTimeout(() => void start(), 0);
  },
});

process.on('SIGTERM', () => {
  running = false;
  void ws?.close();
  void api?.close();
});
