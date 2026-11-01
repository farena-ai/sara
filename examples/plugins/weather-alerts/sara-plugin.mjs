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

  const sara = {
    settings: {},
    secrets: {},
    lang: 'en',
    plugin: '',
    companion: '',
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
    // Phase 115 (bridge contract v1.1, with permissions.bridgeFiles and `bridge.files` in the plugin):
    // a picture or file to Sara, in chunks of at most 512 KB, then the message that names it.
    sendFile: async ({ bridge, chatId, from, text, name, mime, data }) => {
      const bytes = Buffer.from(data);
      const fileId = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const n = Math.max(1, Math.ceil(bytes.length / (512 * 1024)));
      for (let i = 0; i < n; i++) await call('bridge.file', { bridge, chatId, fileId, name, mime, size: bytes.length, seq: i, last: i === n - 1, data: bytes.subarray(i * 512 * 1024, (i + 1) * 512 * 1024).toString('base64') });
      return call('bridge.inbound', { bridge, chatId, from, text: text ?? '', files: [{ fileId }] });
    },
    log: (text, level = 'info') => write({ type: 'log', level, text: String(text) }),
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
      Object.assign(sara, { settings: msg.settings ?? {}, secrets: msg.secrets ?? {}, lang: msg.lang ?? 'en', plugin: msg.plugin ?? '', companion: msg.companion ?? '' });
      try {
        await def.init?.(sara);
      } catch (err) {
        sara.log(`init failed: ${err?.message ?? err}`, 'error');
      }
      // Phase 115: a bridge plugin opts into files and edits (Sara only allows what its permissions say).
      const feats = new Set(msg.bridgeFeatures ?? []);
      const bridge = def.bridge && msg.bridgeApi >= 2 ? { files: def.bridge.files === true && feats.has('files'), edit: def.bridge.edit === true && feats.has('edit'), ...(def.bridge.maxBytes ? { maxBytes: def.bridge.maxBytes } : {}) } : undefined;
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
        await def.bridges?.[msg.bridge]?.send?.({ chatId: msg.chatId, text: msg.text, ...(msg.ref ? { ref: msg.ref } : {}), ...(msg.files ? { files: msg.files } : {}) }, sara);
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
