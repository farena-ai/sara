// Quick ask anywhere (docs/desktop.md "Quick ask anywhere"): the quick-ask shortcut brings what was
// selected in the app in front (UI Automation first, a Ctrl+C with the clipboard put back exactly as the
// fallback; never a password field, Sara's own or a hidden window), "This window" adds one picture of that
// app (hands-screen's capture), both as removable chips that go only with the question. The talk shortcut
// held down is push-to-talk; "Speak her replies" speaks typed answers in the app; a pill shows listening /
// thinking / speaking. Static checks on the sources (the native parts are exercised by the real run in
// docs/desktop.md; the page's logic is run below in a small stand-in DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const page = () => read('desktop', 'shared', 'quick-ask.html');
const cpp = () => read('desktop', 'windows', 'src', 'main.cpp');
const ctx = () => read('desktop', 'windows', 'src', 'quick-context.cpp');

test('built into Sara.exe, the capture is hands-screen\'s', () => {
  assert.match(read('desktop', 'windows', 'CMakeLists.txt'), /src\/quick-context\.cpp src\/voice-pill\.cpp/);
  assert.match(ctx(), /sarascreen::shot\(sarascreen::windowId\(w\), "", \{\}, 1600, false, 0\)/);
  assert.match(read('desktop', 'windows', 'src', 'hands-screen.cpp'), /std::string hiddenKindOf\(HWND h\) \{[\s\S]{0,400}return "sara";[\s\S]{0,200}blockedKind\(/);
});

test('selected text: UI Automation first, never a password field, Sara\'s own or a hidden window', () => {
  const c = ctx();
  assert.match(c, /UIA_TextPatternId/);
  assert.match(c, /get_CurrentIsPassword\(&pw\)\) && pw\) return Uia::Password/);
  assert.match(c, /ES_PASSWORD/);
  assert.match(c, /if \(hidden == "sara"\) \{\s+p\.skipped = L"sara";/);
  assert.match(c, /p\.skipped = L"hidden";/);
  // The focused element must belong to the window in front.
  assert.match(c, /\(DWORD\)pid != frontPid\) return Uia::Unavailable/);
  // A text pattern with nothing selected stays empty: no Ctrl+C (some editors copy the whole line).
  assert.match(c, /if \(u == Uia::Read\) \{[\s\S]{0,300}return done\(p\);/);
  // Key-shaped text is masked, the length is capped.
  assert.match(c, /sarascreen::maskSecrets/);
  assert.match(read('desktop', 'windows', 'src', 'quick-context.h'), /kMaxText = 8000/);
});

test('the Ctrl+C fallback: waits for the keys, saves every format, puts the clipboard back', () => {
  const c = ctx();
  const tick = c.slice(c.indexOf('void CALLBACK tick('), c.indexOf('}  // namespace\n\nbool SavedClipboard::save'));
  assert.match(tick, /if \(anyKeyHeld\(\)\)/, 'no Ctrl+C while the shortcut\'s keys are still down');
  assert.match(tick, /if \(GetForegroundWindow\(\) != j->p\.window\) \{\s+j->p\.skipped = L"moved";/);
  assert.match(tick, /if \(classicPasswordFocus\(j->p\.window\)\) \{\s+j->p\.skipped = L"password";/, 'checked again right before the Ctrl+C');
  assert.match(c, /EM_GETPASSWORDCHAR/, 'WinForms and other Edit-based password boxes too');
  assert.match(tick, /if \(!j->saved\.save\(owner\(\)\) \|\| !j->saved\.exact\)/, 'no Ctrl+C unless the clipboard can be put back exactly');
  assert.ok(tick.indexOf('saved.save') < tick.indexOf('sendCopy()'), 'saved before copying');
  assert.match(tick, /clipboardText\(owner\(\)\)\);\s+if \(!j->saved\.restore\(owner\(\)\)\)/, 'read, then put back at once');
  const save = c.slice(c.indexOf('bool SavedClipboard::save'), c.indexOf('bool SavedClipboard::restore'));
  assert.match(save, /EnumClipboardFormats/);
  assert.match(save, /CF_METAFILEPICT[\s\S]{0,300}exact = false;/);
  assert.match(save, /64u \* 1024 \* 1024\) exact = false/);
  assert.match(c, /dwExtraInfo = sarascreen::kInputTag/, 'her hands never take it for the owner\'s typing');
  assert.match(c, /SARA_QA_FORCE_COPY/);
  assert.match(c, /#ifdef SARA_TEST_HOOKS\n  \/\/ Test builds: SARA_QA_FORCE_COPY/);
});

test('main.cpp: the shortcut reads the front app, "This window", push-to-talk, the pill, the tray switches', () => {
  const c = cpp();
  assert.match(c, /saractx::pick\(fg, read, \[\]\(const saractx::Picked& p\)/);
  assert.match(c, /prefOn\(L"quickAskSelection", true\)/);
  assert.match(c, /L"',context:" \+ g_qaContext \+ L",speak:"/);
  assert.match(c, /\} else if \(a == L"window"\) \{\s+quickWindowShot\(\);/);
  assert.match(c, /saractx::captureWindow\(g_qaFront, url, w, h, why\)/);
  assert.match(c, /if \(wp == kTalkHotkeyId\) talkHotkey\(\);/);
  assert.match(c, /if \(wp == kPttTimer\) pttTick\(\);/);
  const ptt = c.slice(c.indexOf('static void pttTick() {'), c.indexOf('static void toggleSpeakReplies'));
  assert.match(ptt, /GetAsyncKeyState\(VK_ESCAPE\)[\s\S]{0,160}saraQuick\.cancelTalk/);
  assert.match(ptt, /held > 350[\s\S]{0,200}saraQuick\.hold/);
  assert.match(ptt, /saraQuick\.release/);
  assert.match(c, /L"Speak her replies"/);
  assert.match(c, /L"Quick ask includes selected text"/);
  assert.match(c, /wakeTray\(\);\s+voicePillSync\(\);/, 'the pill follows her voice state');
  assert.match(c, /soft \? L"window\.saraQuick&&saraQuick\.hidden\(\{soft:true\}\)"/);
  // Her spoken pieces play from blob: URLs; the page's CSP allows exactly that.
  assert.match(c, /media-src blob:/);
});

test('the page: chips with ✕, the window button, nothing sent until Send, spoken replies respect her voice', () => {
  const h = page();
  assert.match(h, /<div id="ctx" hidden/);
  assert.match(h, /<button id="win" class="icon" type="button" hidden/);
  assert.match(h, /post\(\{ a: 'window' \}\)/);
  assert.match(h, /'\/api\/voice\/speak'/);
  assert.match(h, /quietNow = c\.paused === 'quiet';/);
  assert.match(h, /session\.privateLocal && !\(voiceInfo\.tts === 'local' && voiceInfo\.localTts\)/);
  assert.doesNotMatch(h, /\sstyle=["']/);
});

/** Runs the page's first script in a tiny stand-in DOM and returns saraQuick, what it posted and fetched. */
function runPage() {
  const html = page();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const first = script.slice(0, script.indexOf('// V4b: her presence orb'));
  const posted: Record<string, unknown>[] = [];
  const fetched: { url: string; body: unknown }[] = [];
  class El {
    id: string; hidden = false; disabled = false; children: El[] = []; dataset: Record<string, string> = {}; style: Record<string, string> = {};
    textContent = ''; innerHTML = ''; value = ''; title = ''; placeholder = ''; className = ''; src = ''; alt = ''; type = ''; scrollTop = 0; scrollHeight = 0;
    classList = { toggle() {}, add() {}, remove() {} };
    onclick: null | (() => void) = null; onsubmit: null | ((e: unknown) => void) = null;
    attrs: Record<string, string> = {};
    constructor(id = '') { this.id = id; }
    get childElementCount() { return this.children.length; }
    append(...c: El[]) { this.children.push(...c); }
    appendChild(c: El) { this.children.push(c); return c; }
    insertBefore(c: El) { this.children.push(c); }
    remove() {}
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    getAttribute(k: string) { return this.attrs[k]; }
    addEventListener() {}
    focus() {}
    closest() { return new El(); }
    querySelector() { return new El(); }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { height: 100 }; }
    requestSubmit() { this.onsubmit?.({ preventDefault() {} }); }
    get innerText() { return ''; }
  }
  const els: Record<string, El> = {};
  const byId = (id: string) => (els[id] ??= new El(id));
  Object.defineProperty(byId('ctx'), 'textContent', { set(this: El) { this.children = []; }, get() { return ''; } });
  const session = { authenticated: true, demo: false, disclosureAccepted: true, identity: { name: 'Sara' }, privateLocal: false };
  const respond = (data: unknown) => ({ ok: true, status: 200, json: async () => data, blob: async () => ({}), body: null });
  const fetchFn = async (url: string, opts: { body?: string } = {}) => {
    fetched.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (url === '/api/session') return respond(session);
    if (url === '/api/conversations' ) return respond({ id: 'c1' });
    if (url.endsWith('/messages')) return { ok: true, status: 200, body: { pipeThrough: () => ({ getReader: () => ({ read: async () => ({ done: true }) }) }) } };
    return respond({});
  };
  const sandbox: Record<string, unknown> = {
    document: { getElementById: byId, createElement: () => new El(), documentElement: { classList: { toggle() {} } }, body: { dataset: {} }, querySelector: () => new El() },
    window: { chrome: { webview: { postMessage: (m: Record<string, unknown>) => posted.push(m) } } },
    navigator: { userAgent: 'test', mediaDevices: null },
    fetch: fetchFn, ResizeObserver: class { observe() {} }, EventSource: class { addEventListener() {} close() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, AbortController, TextDecoderStream: class {}, Blob, URL, atob,
    addEventListener() {}, console,
    Image: class { onerror: null | (() => void) = null; set src(_v: string) { queueMicrotask(() => this.onerror?.()); } },
  };
  sandbox.window = Object.assign(sandbox.window as object, sandbox);
  vm.runInNewContext(first, sandbox);
  const sq = (sandbox.window as { saraQuick: Record<string, (...a: unknown[]) => unknown> }).saraQuick;
  return { sq, posted, fetched, byId };
}

test('the page: selected text and the picture become chips, go with the question, then are cleared', async () => {
  const { sq, fetched, byId } = runPage();
  await new Promise((r) => setImmediate(r));
  sq.show({ theme: 'night', context: { app: 'Notepad', window: true, text: 'The quick brown fox', via: 'uia' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(byId('ctx').hidden, false);
  assert.equal(byId('ctx').children.length, 1);
  assert.equal(byId('win').hidden, false, 'This window is offered for an app that was in front');
  assert.deepEqual({ ...(sq.context() as object) }, { app: 'Notepad', text: 'The quick brown fox', window: true, skipped: '', pictures: 0 });
  // A bad picture is refused; a JPEG becomes the second chip.
  assert.equal(sq.picture({ data: 'data:text/html;base64,AAAA' }), false);
  assert.equal(sq.picture({ data: 'data:image/jpeg;base64,/9j/AAAA', w: 10, h: 10 }), true);
  assert.equal(byId('ctx').children.length, 2);
  assert.equal(byId('win').hidden, true, 'one picture at a time');
  assert.ok(!fetched.some((f) => f.url.endsWith('/messages')), 'nothing sent before Send');
  byId('q').value = 'What does it say?';
  byId('ask').onsubmit?.({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const sent = fetched.find((f) => f.url.endsWith('/messages'))!;
  assert.ok(sent, 'sent on Send');
  const body = sent.body as { content: string; images: string[] };
  assert.match(body.content, /^What does it say\?\n\nSelected in Notepad:\n```\nThe quick brown fox\n```$/);
  assert.deepEqual([...body.images], ['data:image/jpeg;base64,/9j/AAAA']);
  assert.equal((sq.context() as { text: string }).text, '');
  assert.equal((sq.context() as { pictures: number }).pictures, 0);
  assert.equal(byId('ctx').hidden, true);
});

test('the page: ✕ removes a chip; closing drops both; the tray\'s Ask has no context', async () => {
  const { sq, byId } = runPage();
  await new Promise((r) => setImmediate(r));
  sq.show({ context: { app: 'Notepad', window: true, text: 'secret plan' } });
  const chipEl = byId('ctx').children[0] as unknown as { children: { onclick?: () => void }[] };
  chipEl.children[1].onclick?.();
  assert.equal((sq.context() as { text: string }).text, '');
  sq.show({ context: { app: 'Notepad', window: true, text: 'again' } });
  sq.picture({ data: 'data:image/jpeg;base64,/9j/AAAA' });
  sq.hidden();
  assert.deepEqual({ ...(sq.context() as object) }, { app: '', text: '', window: false, skipped: '', pictures: 0 });
  sq.show({ context: {} });
  assert.equal(byId('win').hidden, true);
});
