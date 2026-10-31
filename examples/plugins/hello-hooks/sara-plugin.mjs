// sara-plugin.mjs: the optional helper for Sara plugins (the JSON channel, version 1). One file, no
// dependencies: copy it into your plugin's folder (a plugin may only read its own folder) and
//
//   import { plugin } from './sara-plugin.mjs';
//   plugin({
//     tools: [{ name: 'check', description: '…', parameters: { type: 'object', properties: {} }, run: async (args, sara) => 'text' }],
//     hooks: { 'turn.before': async (data, sara) => ({ note: '…' }), 'reply.after': async (data, sara) => ({ card: { title: '…', lines: ['…'] } }) },
//     schedules: { morning: async (sara) => { await sara.notify('Good morning'); } },
//     events: { planner: async (data, sara) => {} },
//     bridges: { line: { send: async ({ chatId, text }, sara) => {} } },
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
      write({ type: 'ready', tools: (def.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} }, permission: t.permission ?? 'ask' })) });
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
        await def.bridges?.[msg.bridge]?.send?.({ chatId: msg.chatId, text: msg.text }, sara);
      } catch (err) {
        sara.log(`bridge.send failed: ${err?.message ?? err}`, 'error');
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
