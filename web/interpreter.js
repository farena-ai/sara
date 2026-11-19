// V4.2 (docs/design/INTERPRETER.md): the live interpreter inside Talk with Sara. The talk loop
// (web/talk.js on web/voice.js Call) hears each turn; here it goes to /api/talk/interpret/turn
// (translated by a local model first) and the translation is spoken in the other language. The talk
// screen becomes a big two-sided screen: on a phone the far half is upside down, so the person across
// the table reads their own language. Settings → Sara → Voice → Interpreter keeps the two languages,
// the cloud switch and the saved transcripts.
// InterpreterSession has no DOM use (unit-tested in Node with fakes); the rest wires the page.
import { t } from './naming.js';

/** One line's words per language: what was said in its own language, the translation in the other. */
export function sideTexts(line, a, b) {
  const other = line.from === a ? b : a;
  return { [line.from]: line.said, [other]: line.text || '' };
}

/**
 * One interpreter session, without the page. o: { a, b, id?, turn(body) → { line, why? },
 * speak(text, lang), onLines(lines) }.
 */
export class InterpreterSession {
  constructor(o) {
    this.o = { onLines: () => {}, ...o };
    this.a = o.a;
    this.b = o.b;
    this.id = o.id ?? '';
    /** { from, to, said, text, why? } */
    this.lines = [];
    this.hint = null;
  }

  /** "My turn" on one half: the next words are taken as that side's language when unclear. */
  myTurn(side) {
    this.hint = side === 'b' ? this.b : this.a;
  }

  /** Words came back from hearing: translate and speak them. Goodbye is translated too (End stops). */
  async heard(text) {
    const said = String(text ?? '').trim();
    if (!said) return 'sent';
    const hint = this.hint;
    this.hint = null;
    const r = await this.o.turn({ id: this.id, text: said, ...(hint ? { hint } : {}) });
    const line = { ...(r?.line ?? { from: hint ?? this.a, to: hint === this.b ? this.a : this.b, said, text: '' }), ...(r?.why ? { why: r.why } : {}) };
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    this.o.onLines(this.lines);
    if (line.text) this.o.speak(line.text, line.to);
    return 'sent';
  }
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

let ctx = null;
let session = null;
let langs = ['en', 'es'];
const $ = (s) => globalThis.document?.querySelector(s);
const uiLang = () => globalThis.document?.documentElement?.lang || 'en';

/** A language's name in the page's language (Intl, so no translation keys). */
export function langLabel(code, inLang = uiLang()) {
  try {
    const n = new Intl.DisplayNames([inLang], { type: 'language' }).of(code) ?? code;
    return n.charAt(0).toLocaleUpperCase(inLang) + n.slice(1);
  } catch {
    return code;
  }
}

function fillSelect(sel, value) {
  if (!sel) return;
  sel.replaceChildren(...langs.map((l) => new Option(langLabel(l), l)));
  sel.value = value;
}

/** ctx: { api, speaker, notice, startTalk({interpret}), settingsClose() } */
export function initInterpreter(c) {
  ctx = c;
  $('#tm-interp')?.addEventListener('click', () => void (session ? stopInterp() : startInterp()));
  $('#ti-turn-a')?.addEventListener('click', () => session?.myTurn('a'));
  $('#ti-turn-b')?.addEventListener('click', () => session?.myTurn('b'));
  $('#ti-swap')?.addEventListener('click', () => {
    const a = $('#ti-lang-a');
    const b = $('#ti-lang-b');
    if (!a || !b) return;
    [a.value, b.value] = [b.value, a.value];
    void restart();
  });
  for (const id of ['#ti-lang-a', '#ti-lang-b']) $(id)?.addEventListener('change', () => void restart());
  $('#interp-start')?.addEventListener('click', () => {
    ctx.settingsClose?.();
    void ctx.startTalk?.({ interpret: true });
  });
  const save = () => void ctx.api('/talk/interpret', { method: 'PUT', body: { a: $('#interp-a').value, b: $('#interp-b').value, cloud: $('#interp-cloud').checked } }).then(() => note(t('Saved.'))).catch((e) => note(e.message));
  for (const id of ['#interp-a', '#interp-b', '#interp-cloud']) $(id)?.addEventListener('change', save);
}

function note(text) {
  const n = $('#interp-note');
  if (n) n.textContent = text;
}

/** The interpreter is on in the talk screen (talk.js sends every utterance here). */
export const interpOn = () => Boolean(session);

/** Hearing for the interpreter: either language may be spoken, so no language hint. */
export async function interpTranscribe(wav) {
  const res = await fetch('/api/voice/transcribe?lang=auto', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.text ?? '';
}

export async function interpHeard(text) {
  if (!session) return;
  setStatus(t('Translating…'));
  try {
    await session.heard(text);
  } catch (err) {
    ctx.notice?.(err?.message ?? String(err));
  }
  setStatus(session?.lines.at(-1)?.why || t('Listening…'));
}

function setStatus(s) {
  const el = $('#tm-status');
  if (el) el.textContent = s;
}

function speak(text, lang) {
  ctx.speaker.lang = lang;
  try {
    ctx.speaker.say(text);
  } finally {
    ctx.speaker.lang = null;
  }
}

function render(lines) {
  if (!session) return;
  const { a, b } = session;
  const last = lines.at(-1);
  const prev = lines.at(-2);
  for (const [side, lang] of [['a', a], ['b', b]]) {
    const big = $(`#ti-big-${side}`);
    const small = $(`#ti-prev-${side}`);
    if (big) {
      big.lang = lang;
      big.textContent = last ? sideTexts(last, a, b)[lang] || (last.why && last.from !== lang ? last.why : '…') : side === 'a' ? t('Speak when you are ready.') : '';
      big.classList.toggle('ti-own', Boolean(last && last.from === lang));
    }
    if (small) {
      small.lang = lang;
      small.textContent = prev ? sideTexts(prev, a, b)[lang] : '';
    }
  }
}

async function startInterp() {
  if (!ctx) return;
  const d = await ctx.api('/talk/interpret').catch(() => null);
  if (!d) return;
  langs = d.langs ?? langs;
  const a = $('#ti-lang-a')?.value || d.prefs.a;
  const b = $('#ti-lang-b')?.value || d.prefs.b;
  fillSelect($('#ti-lang-a'), a);
  fillSelect($('#ti-lang-b'), b);
  await open(a, b);
}

async function open(a, b) {
  const r = await ctx.api('/talk/interpret/start', { method: 'POST', body: { a, b } }).catch((e) => (ctx.notice?.(e.message), null));
  if (!r) return;
  session = new InterpreterSession({
    a,
    b,
    id: r.session.id,
    turn: (body) => ctx.api('/talk/interpret/turn', { method: 'POST', body }),
    speak,
    onLines: render,
  });
  const dlg = $('#talk-mode');
  dlg?.classList.add('ti-on');
  $('#ti-screen').hidden = false;
  $('#tm-interp')?.setAttribute('aria-pressed', 'true');
  const title = $('#tm-title');
  if (title) {
    title.dataset.was ??= title.textContent;
    title.textContent = t('Interpreter');
  }
  render([]);
}

async function restart() {
  if (!session) return;
  const a = $('#ti-lang-a').value;
  const b = $('#ti-lang-b').value;
  if (a === b) return void ctx.notice?.(t('Pick two different languages.'));
  await endSession();
  await open(a, b);
}

async function endSession() {
  const s = session;
  session = null;
  if (s?.id) await ctx.api('/talk/interpret/end', { method: 'POST', body: { id: s.id } }).catch(() => {});
}

/** Back to Talk with Sara (or the talk ends: talk.js calls this from stopTalk). */
export async function stopInterp() {
  if (!session) return;
  await endSession();
  $('#talk-mode')?.classList.remove('ti-on');
  const screen = $('#ti-screen');
  if (screen) screen.hidden = true;
  $('#tm-interp')?.setAttribute('aria-pressed', 'false');
  const title = $('#tm-title');
  if (title?.dataset.was) title.textContent = title.dataset.was;
  void loadInterpreter();
}

/** The talk screen opened from Settings → Interpreter: turn the interpreter on at once. */
export function interpAtStart(opts) {
  if (opts?.interpret) void startInterp();
}

function when(iso) {
  try {
    return new Date(iso).toLocaleString(uiLang(), { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Settings → Sara → Voice → Interpreter: the two languages, the cloud switch, saved transcripts. */
export async function loadInterpreter() {
  if (!ctx || !$('#interp-prefs')) return;
  const d = await ctx.api('/talk/interpret').catch(() => null);
  if (!d) return;
  langs = d.langs ?? langs;
  fillSelect($('#interp-a'), d.prefs.a);
  fillSelect($('#interp-b'), d.prefs.b);
  $('#interp-cloud').checked = d.prefs.cloud === true;
  const ul = $('#interp-list');
  if (!ul) return;
  if (!d.sessions.length) {
    const li = globalThis.document.createElement('li');
    li.className = 'muted';
    li.textContent = t('No transcripts yet.');
    return void ul.replaceChildren(li);
  }
  ul.replaceChildren(
    ...d.sessions.slice(0, 20).map((s) => {
      const li = globalThis.document.createElement('li');
      li.className = 'interp-row';
      const head = globalThis.document.createElement('span');
      head.className = 'interp-what';
      const b = globalThis.document.createElement('strong');
      b.textContent = `${langLabel(s.a)} ↔ ${langLabel(s.b)}`;
      const sub = globalThis.document.createElement('span');
      sub.className = 'muted';
      sub.textContent = `${when(s.startedAt)} · ${t('{n} lines', { n: s.count })}${s.first ? ` · “${s.first}”` : ''}`;
      head.append(b, sub);
      const acts = globalThis.document.createElement('span');
      acts.className = 'interp-acts';
      const dl = globalThis.document.createElement('a');
      dl.className = 'button ghost small';
      dl.href = `/api/talk/interpret/${encodeURIComponent(s.id)}/text`;
      dl.textContent = t('Download');
      dl.setAttribute('download', '');
      const del = globalThis.document.createElement('button');
      del.type = 'button';
      del.className = 'ghost small';
      del.textContent = t('Delete');
      del.addEventListener('click', async () => {
        del.disabled = true;
        await ctx.api(`/talk/interpret/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch((e) => note(e.message));
        void loadInterpreter();
      });
      acts.append(dl, del);
      li.append(head, acts);
      return li;
    }),
  );
}
