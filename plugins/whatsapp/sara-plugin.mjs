// sara-plugin.mjs: the optional helper for Sara plugins (the JSON channel, version 1). One file, no
// dependencies: copy it into your plugin's folder (a plugin may only read its own folder) and
//
//   import { plugin } from './sara-plugin.mjs';
//   plugin({
//     tools: [{ name: 'check', description: '…', parameters: { type: 'object', properties: {} }, run: async (args, sara) => 'text' }],
//     hooks: { 'turn.before': async (data, sara) => ({ note: '…' }), 'reply.after': async (data, sara) => ({ card: { title: '…', lines: ['…'] } }) },
//     schedules: { morning: async (sara) => { await sara.notify('Good morning'); } },
//     events: { planner: async (data, sara) => {} },
//     bridges: { line: { send: async ({ chatId, text, ref, files }, sara) => {}, edit: async ({ chatId, ref, text }) => {}, file: async ({ fileId, seq, last, data }) => {} } },
//     bridge: { files: true, edit: true },   // Phase 115: opt in (files also need permissions.bridgeFiles)
//     init: async (sara) => {},
//   });
//
// Contract v1.2 (Phase 117, opt in): `bridge` may also say places, typing, react, log, threads,
// oneMessage, link, editLimit, editEveryMs, textMax and ack ('react' | 'line' | 'none'); a bridge
// may handle typing({ chatId, on }), react({ chatId, messageId, emoji }), trust({ chatId }),
// leave({ chatId }) and test() (→ { steps: [{ label, ok, fix }] }). With permissions.connect,
// sara.net.open(endpoint, { port }) gives a socket Sara holds for it: { id, tls, greeting,
// write(bytes), close(), onData(fn), onClose(fn) }. One-way lines: sara.bridgeLog(line),
// sara.bridgeSent({ ref, messageId }), sara.status(state, detail), sara.skip(reason, from).
// sara.bridgeWho({ bridge, chatId, fromId, auth, subject }) asks Sara who a sender is before a
// message is read ('owner', 'partner', 'link' or 'none'; the email plugin uses it on headers alone).
// Phase 122 (opt in): `bridge.window: { hours }` (the platform's reply window), `bridge.buttons: n`
// (reply buttons; `send` then gets `buttons: [{ id, label }]`, a tap comes back as an inbound
// `action`), and with permissions.webhooks 'bridge' a bridge may handle webhook({ hook, body })
// (Meta's raw, already signature-checked body) and check({ step, … }) (the setup card).
// sara.failed({ chatId, code, title, reply }) tells Sara a send was refused.
//
// `sara` has: settings, secrets, lang, plugin, companion, fetch(url), tool(name, args), notify(text),
// card(card), model(prompt, { maxTokens }), kv.get(key) / kv.set(key, value), notes(),
// bridgeInbound({ bridge, chatId, from, text }), log(text, level). docs/PLUGINS.md has the details.
// Plugins may also speak the channel raw (newline-delimited JSON on stdin/stdout).

export function plugin(def = {}) {
  const pending = new Map();
  let seq = 0;
  const write = (msg) => process.stdout.write(`${JSON.stringify({ v: 1, ...msg })}\n`);
  const call = (op, fields = {}) =>
    new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      pending.set(id, { resolve, reject });
      write({ id, type: 'call', op, ...fields });
    });

  // Phase 117: the sockets Sara holds for this plugin (net.data / net.closed arrive by socket id).
  const sockets = new Map();
  const sara = {
    settings: {},
    secrets: {},
    lang: 'en',
    plugin: '',
    companion: '',
    herName: '',
    bridgeApi: 0,
    fetch: (url) => call('fetch', { url: String(url) }),
    tool: (name, args = {}) => call('tool', { name, args }),
    notify: (text) => call('notify', { text: String(text) }),
    card: (card) => call('card', { card }),
    model: (prompt, o = {}) => call('model', { prompt: String(prompt), ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) }).then((r) => r.text ?? ''),
    kv: {
      get: (key) => call('kv.get', { key }).then((r) => r.value ?? null),
      set: (key, value) => call('kv.set', { key, value }),
    },
    notes: () => call('memory.notes').then((r) => r.notes ?? []),
    bridgeInbound: (m) => call('bridge.inbound', m),
    bridgeWho: (m) => call('bridge.who', m),
    // Phase 115 (bridge contract v1.1, with permissions.bridgeFiles and `bridge.files` in the plugin):
    // a picture or file to Sara, in chunks of at most 512 KB, then the message that names it.
    // Phase 117: `files: [{ name, mime, data }]` for several, and any v1.2 inbound fields (fromId, messageId, chat …).
    sendFile: async ({ bridge, chatId, from, text, name, mime, data, files, ...more }) => {
      const ids = [];
      for (const f of files ?? [{ name, mime, data }]) {
        const bytes = Buffer.from(f.data);
        const fileId = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const n = Math.max(1, Math.ceil(bytes.length / (512 * 1024)));
        for (let i = 0; i < n; i++) await call('bridge.file', { bridge, chatId, fileId, name: f.name, mime: f.mime, size: bytes.length, seq: i, last: i === n - 1, data: bytes.subarray(i * 512 * 1024, (i + 1) * 512 * 1024).toString('base64') });
        ids.push({ fileId });
      }
      return call('bridge.inbound', { ...more, bridge, chatId, from, text: text ?? '', files: ids });
    },
    log: (text, level = 'info') => write({ type: 'log', level, text: String(text) }),
    // Phase 117 (contract v1.2): one-way lines (no answer).
    bridgeLog: (line) => write({ type: 'bridge.log', ...line }),
    bridgeSent: (m) => write({ type: 'bridge.sent', ...m }),
    status: (state, detail = '') => write({ type: 'bridge.status', state, detail: String(detail).slice(0, 200) }),
    skip: (reason, from = '') => write({ type: 'bridge.skip', reason, from: String(from).slice(0, 120) }),
    failed: (m) => write({ type: 'bridge.failed', ...m }),
    net: {
      open: async (endpoint, o = {}) => {
        const r = await call('net.open', { endpoint, ...(o.port ? { port: o.port } : {}) });
        // Bytes (or a close) can arrive just before the answer to net.open: keep them.
        const s = sockets.get(r.socket) ?? { data: [], closed: null };
        Object.assign(s, { id: r.socket, tls: r.tls ?? null, greeting: r.greeting ?? null, onData: null, onClose: null, opened: true });
        if (s.closed !== null) sockets.delete(r.socket);
        else sockets.set(r.socket, s);
        return {
          id: r.socket,
          tls: s.tls,
          greeting: s.greeting,
          write: (bytes) => call('net.write', { socket: r.socket, data: Buffer.from(bytes).toString('base64') }),
          close: () => call('net.close', { socket: r.socket }),
          onData: (fn) => {
            s.onData = fn;
            for (const b of s.data.splice(0)) fn(b);
          },
          onClose: (fn) => {
            s.onClose = fn;
            if (s.closed !== null) fn(s.closed);
          },
        };
      },
    },
  };

  const answer = async (id, fn) => {
    try {
      const r = (await fn()) ?? {};
      write({ id, type: 'result', ...(typeof r === 'string' ? { content: r } : r) });
    } catch (err) {
      write({ id, type: 'error', error: String(err?.message ?? err).slice(0, 500) });
    }
  };

  const handle = async (msg) => {
    if ((msg.type === 'result' || msg.type === 'error') && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.error ?? 'error'));
      else p.resolve(msg);
      return;
    }
    if (msg.type === 'init') {
      Object.assign(sara, { settings: msg.settings ?? {}, secrets: msg.secrets ?? {}, lang: msg.lang ?? 'en', plugin: msg.plugin ?? '', companion: msg.companion ?? '', herName: msg.herName ?? '', bridgeApi: msg.bridgeApi ?? 0 });
      try {
        await def.init?.(sara);
      } catch (err) {
        sara.log(`init failed: ${err?.message ?? err}`, 'error');
      }
      // Phase 115: a bridge plugin opts into files and edits (Sara only allows what its permissions say).
      const feats = new Set(msg.bridgeFeatures ?? []);
      const bridge = def.bridge && msg.bridgeApi >= 2 ? { files: def.bridge.files === true && feats.has('files'), edit: def.bridge.edit === true && feats.has('edit'), ...(def.bridge.maxBytes ? { maxBytes: def.bridge.maxBytes } : {}) } : undefined;
      // Phase 117: the v1.2 fields, only what Sara offers (bridgeApi 3).
      if (bridge && msg.bridgeApi >= 3) {
        for (const k of ['places', 'typing', 'react', 'log', 'threads', 'oneMessage', 'link']) if (def.bridge[k] === true && feats.has(k)) bridge[k] = true;
        for (const k of ['editLimit', 'editEveryMs', 'textMax']) if (Number.isInteger(def.bridge[k])) bridge[k] = def.bridge[k];
        if (def.bridge.ack) bridge.ack = def.bridge.ack;
        // Phase 122: the reply window and reply buttons (only when Sara offers them).
        if (def.bridge.window && feats.has('window')) bridge.window = def.bridge.window;
        if (Number.isInteger(def.bridge.buttons) && feats.has('buttons')) bridge.buttons = def.bridge.buttons;
      }
      write({ type: 'ready', tools: (def.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} }, permission: t.permission ?? 'ask' })), ...(bridge ? { bridge } : {}) });
      return;
    }
    if (msg.type === 'hook') return answer(msg.id, () => def.hooks?.[msg.hook]?.(msg.data ?? {}, sara));
    if (msg.type === 'tool') {
      const t = (def.tools ?? []).find((x) => x.name === msg.name);
      return answer(msg.id, async () => {
        if (!t) throw new Error(`no tool ${msg.name}`);
        const r = await t.run(msg.args ?? {}, sara);
        return typeof r === 'string' ? { content: r } : r;
      });
    }
    if (msg.type === 'schedule') return answer(msg.id, () => def.schedules?.[msg.schedule]?.(sara));
    if (msg.type === 'event') return answer(msg.id, () => def.events?.[msg.event]?.(msg.data ?? {}, sara));
    if (msg.type === 'bridge.send') {
      try {
        // Phase 115: `ref` (a progress message to edit later) and `files` (chunks follow as bridge.file).
        // Phase 117: replyTo (a message to quote), thread and subject (email).
        // Phase 122: buttons, a template (the paid nudge) and `started` (a message she starts, not a reply).
        await def.bridges?.[msg.bridge]?.send?.({ chatId: msg.chatId, text: msg.text, ...(msg.ref ? { ref: msg.ref } : {}), ...(msg.files ? { files: msg.files } : {}), ...(msg.replyTo ? { replyTo: msg.replyTo } : {}), ...(msg.thread ? { thread: msg.thread } : {}), ...(msg.subject ? { subject: msg.subject } : {}), ...(msg.buttons ? { buttons: msg.buttons } : {}), ...(msg.template ? { template: msg.template } : {}), ...(msg.started ? { started: true } : {}) }, sara);
      } catch (err) {
        sara.log(`bridge.send failed: ${err?.message ?? err}`, 'error');
      }
    }
    if (msg.type === 'bridge.edit') {
      try {
        await def.bridges?.[msg.bridge]?.edit?.({ chatId: msg.chatId, ref: msg.ref, text: msg.text }, sara);
      } catch (err) {
        sara.log(`bridge.edit failed: ${err?.message ?? err}`, 'error');
      }
    }
    // Phase 117 (contract v1.2): Sara → plugin bridge lines and the socket broker's data.
    for (const [type, fn] of [['bridge.typing', 'typing'], ['bridge.react', 'react'], ['bridge.trust', 'trust'], ['bridge.leave', 'leave']]) {
      if (msg.type !== type) continue;
      try {
        const { v, type: _t, bridge: _b, ...rest } = msg;
        await def.bridges?.[msg.bridge]?.[fn]?.(rest, sara);
      } catch (err) {
        sara.log(`${type} failed: ${err?.message ?? err}`, 'error');
      }
      return;
    }
    // Phase 122: a signed webhook body (Sara checked the signature) and the setup card's checks.
    if (msg.type === 'bridge.webhook' || msg.type === 'bridge.check') {
      const fn = msg.type === 'bridge.webhook' ? 'webhook' : 'check';
      const b = Object.values(def.bridges ?? {}).find((x) => x?.[fn]);
      const { v, id, type: _t, ...rest } = msg;
      return answer(id, async () => {
        if (!b) throw new Error(`no ${fn} handler`);
        return (await b[fn](rest, sara)) ?? { ok: true };
      });
    }
    if (msg.type === 'bridge.test') {
      const b = Object.values(def.bridges ?? {}).find((x) => x?.test);
      return answer(msg.id, async () => (b ? await b.test(sara) : { steps: [{ label: 'This plugin has no test', ok: true }] }));
    }
    if (msg.type === 'net.data') {
      if (!sockets.has(msg.socket) && sockets.size < 16) sockets.set(msg.socket, { data: [], closed: null, onData: null });
      const s = sockets.get(msg.socket);
      if (!s) return;
      const bytes = Buffer.from(String(msg.data ?? ''), 'base64');
      if (s.onData) s.onData(bytes);
      else s.data.push(bytes);
      return;
    }
    if (msg.type === 'net.closed') {
      if (!sockets.has(msg.socket) && sockets.size < 16) sockets.set(msg.socket, { data: [], closed: null, onData: null });
      const s = sockets.get(msg.socket);
      if (!s) return;
      if (s.opened) sockets.delete(msg.socket); // else net.open's answer is still on its way: it takes it
      s.closed = String(msg.reason ?? 'closed');
      s.onClose?.(s.closed);
      return;
    }
    if (msg.type === 'bridge.file') {
      // A chunk of one of her pictures or files (base64), in order; `last` on the final one.
      try {
        await def.bridges?.[msg.bridge]?.file?.({ chatId: msg.chatId, fileId: msg.fileId, seq: msg.seq, last: msg.last, data: msg.data }, sara);
      } catch (err) {
        sara.log(`bridge.file failed: ${err?.message ?? err}`, 'error');
      }
    }
  };

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return sara;
}
