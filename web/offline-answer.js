// V5.6 (docs/design/V5_PHONE_MODEL.md): short answers from a small model on the phone while the
// server is away. The Android app lends `SaraPhone.localModel(op, json)` (android/.../LocalModel.java)
// and answers through `window.saraLocalModel(id, json)`. The answer is kept with its outbox item
// (web/offline-store.js) and sent with it (web/offline-sync.js); the server stores both, marked
// "Offline answer" (src/offline-answer.ts). No DOM here except offlineAnswerChip (for web/app.js).

export const OFFLINE_ANSWER_LIMITS = { history: 6, promptChars: 3000, tokens: 220, text: 4000, timeoutMs: 120_000 };

// The model's brief is English (a small model follows it best); only the answer's language changes.
const LANGS = Object.fromEntries('en English|es Spanish|fr French|de German|pt Portuguese|it Italian'.split('|').map((x) => x.split(' ')));

/**
 * The phone's model, or null outside the Android app (or an older app without it).
 * status(): { engine, state: 'none'|'downloading'|'ready'|'error', on, name, size, got, error }.
 */
export function phoneModel(win = globalThis) {
  const bridge = win?.SaraPhone;
  if (!bridge || typeof bridge.localModel !== 'function') return null;
  const waiting = (win.__saraLocalWaiting ??= new Map());
  win.saraLocalModel ??= (id, json) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    let r = {};
    try {
      r = JSON.parse(json);
    } catch {
      r = { error: 'bad answer' };
    }
    if (r.error || typeof r.text !== 'string') w.reject(new Error(String(r.error ?? 'no answer')));
    else w.resolve({ text: r.text });
  };
  const op = (name, data = {}) => {
    try {
      return bridge.localModel(name, JSON.stringify(data));
    } catch {
      return '';
    }
  };
  const status = () => {
    try {
      return { engine: false, state: 'none', on: false, ...JSON.parse(op('status') || '{}') };
    } catch {
      return { engine: false, state: 'none', on: false };
    }
  };
  let n = 0;
  return {
    status,
    usable() {
      const s = status();
      return Boolean(s.engine && s.on && s.state === 'ready');
    },
    /** messages = [{ role, content }] → { text } (rejects when the model can't answer). */
    ask(messages, { timeoutMs = OFFLINE_ANSWER_LIMITS.timeoutMs } = {}) {
      const id = `la-${Date.now().toString(36)}-${++n}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          op('cancel', { id });
          reject(new Error('timeout'));
        }, timeoutMs);
        const done = (f) => (v) => {
          clearTimeout(timer);
          f(v);
        };
        waiting.set(id, { resolve: done(resolve), reject: done(reject) });
        if (op('ask', { id, messages, maxTokens: OFFLINE_ANSWER_LIMITS.tokens }) !== 'ok') {
          waiting.delete(id);
          clearTimeout(timer);
          reject(new Error('busy'));
        }
      });
    },
    /** Settings: switch it on/off, download the model, remove it. */
    set: (on) => op('on', { on: Boolean(on) }),
    download: () => op('download'),
    remove: () => op('remove'),
  };
}

/** The small model's prompt: a short brief, the newest kept messages, then the question. */
export function offlinePrompt({ messages = [], question, her = 'Sara', lang = 'en' }) {
  const language = LANGS[String(lang).slice(0, 2)] ?? 'English';
  const system = `You are ${her}'s offline stand-in on this phone, a small model with no tools, no internet and no memory beyond this chat. ${her}'s server can't be reached right now. Answer briefly and kindly in ${language}: at most three short sentences. If the question needs her tools, the internet, files, mail or anything you don't know, say so in one sentence and that ${her} will answer properly when the server is back online. Never make up facts.`;
  const budget = OFFLINE_ANSWER_LIMITS.promptChars - system.length - String(question).length;
  const kept = [];
  let used = 0;
  for (const m of messages.filter((x) => x && (x.role === 'user' || x.role === 'assistant') && x.content).slice(-OFFLINE_ANSWER_LIMITS.history).reverse()) {
    const content = String(m.content).slice(0, 600);
    if (used + content.length > budget) break;
    used += content.length;
    kept.unshift({ role: m.role, content });
  }
  return [{ role: 'system', content: system }, ...kept, { role: 'user', content: String(question) }];
}

/**
 * Asks the phone's model about an outbox item (a chat message) and keeps the answer with it.
 * Returns { text, model, at }, or null (no model, off, it failed): the message just waits as before.
 */
export async function answerOffline({ copy, item, model, her, lang, now = () => new Date() }) {
  if (!model || !item || item.kind !== 'chat' || !model.usable()) return null;
  try {
    const chat = await copy.chat?.(item.conversationId);
    const before = (chat?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    const { text } = await model.ask(offlinePrompt({ messages: before, question: item.text, her, lang }));
    const clean = String(text ?? '').trim().slice(0, OFFLINE_ANSWER_LIMITS.text);
    if (!clean) return null;
    const answer = { text: clean, model: String(model.status().name || 'phone').slice(0, 80), at: now().toISOString() };
    // Edited or sent meanwhile: the answer is for other words (or too late), drop it.
    const cur = (await copy.outbox()).find((x) => x.id === item.id);
    if (!cur || cur.text !== item.text || cur.tried) return null;
    await copy.mark(item.id, { offlineAnswer: answer });
    return answer;
  } catch {
    return null;
  }
}

/** In the chat: the "Offline answer" line under a synced answer, with Ask Sara again on the newest. */
export function offlineAnswerChip(m, { t = (s) => s, her = 'Sara', last = false, again } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'offans-chip muted small';
  const label = document.createElement('span');
  label.textContent = `${t('Offline answer')} · ${t('from the small model on your phone ({model})', { model: m.meta?.offlineAnswer?.model ?? '' })}`;
  wrap.append(label);
  if (last && again) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small offans-again';
    b.textContent = t('Ask {name} again', { name: her });
    b.addEventListener('click', () => again());
    wrap.append(b);
  }
  return wrap;
}
