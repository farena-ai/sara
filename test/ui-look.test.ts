// Phase 75 (stage 1, "her work on screen"): static checks on the new look (no browser here).
// The design tokens, the no-flash theme script and the native-app strip, the step line and the
// result cards, and that the ids, the AI disclosure and the touch rules stay in place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
const theme = web('theme.css');
const look = web('look.css');
const steps = web('steps.js');
const cards = web('result-cards.js');

/** The custom properties set in one `selector { … }` block of theme.css. */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, selector);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const hex = (h: string) => {
  const v = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
};
const lum = (h: string) => {
  const [r, g, b] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('theme: Night and Day tokens from the spec, every text pair at WCAG AA', () => {
  const night = block(theme, ':root,\n:root[data-theme="dark"]');
  const day = block(theme, ':root[data-theme="light"]');
  // The spec's colours (docs/design/NEW_LOOK.md → Visual language).
  assert.equal(night['surface-0'], '#0f0d17');
  assert.equal(night['surface-1'], '#17141f');
  assert.equal(night['surface-2'], '#1e1a29');
  assert.equal(night.glass, 'rgb(30 26 41 / .72)');
  assert.equal(night['accent-from'], '#e0607e');
  assert.equal(night['accent-to'], '#9b6bff');
  assert.equal(night['accent-text'], '#f08aa5');
  assert.equal(day['accent-text'], '#b8436a');
  assert.equal(day['surface-0'], '#faf7f5');
  assert.match(night['glass-filter'], /blur\(18px\) saturate\(140%\)/);
  for (const [k, v] of [['success', '#4fd1a5'], ['warn', '#f5b452'], ['danger', '#ff6b7d']]) assert.equal(night[k], v, k);
  // Every token Night sets for colour, Day sets too.
  for (const k of ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'glass', 'hairline', 'hairline-strong', 'line', 'text-1', 'text-2', 'text-3', 'accent-solid', 'accent-text', 'mine-grad', 'on-accent', 'success', 'warn', 'danger', 'shadow-1', 'shadow-2', 'glow-edge']) {
    assert.ok(night[k] && day[k], `both themes set --${k}`);
  }
  // Contrast: body, muted and meta text on every surface they sit on; accents and states on the page.
  for (const t of [night, day]) {
    for (const surface of ['surface-0', 'surface-1', 'surface-2']) {
      for (const text of ['text-1', 'text-2']) assert.ok(contrast(t[text], t[surface]) >= 4.5, `${text} on ${surface}: ${contrast(t[text], t[surface]).toFixed(2)}`);
      assert.ok(contrast(t['text-3'], t[surface]) >= 4.5 || surface === 'surface-2', `text-3 on ${surface}`);
    }
    for (const k of ['accent-text', 'success', 'warn', 'danger']) assert.ok(contrast(t[k], t['surface-0']) >= 4.5, `${k}: ${contrast(t[k], t['surface-0']).toFixed(2)}`);
    // White text on your message gradient, at both ends.
    for (const end of t['mine-grad'].match(/#[0-9a-f]{6}/g)!) assert.ok(contrast('#ffffff', end) >= 4.5, `you: white on ${end}`);
  }
  // Shapes, spacing, motion, and reduced motion turns it all off.
  const shared = block(theme, ':root');
  for (const k of ['r-card', 'r-control', 'r-pill', 's-1', 's-4', 'dur-fast', 'dur', 'dur-slow', 'ease-out', 'fs-body', 'fs-meta', 'font-ui']) assert.ok(theme.includes(`--${k}:`), k);
  assert.ok(shared);
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: \.001ms !important/);
});

test('theme: every screen uses the tokens (old colour variables point at them)', () => {
  const style = web('style.css');
  const root = /\n:root \{([\s\S]*?)\n\}/.exec(style)![1];
  assert.doesNotMatch(root, /#[0-9a-f]{3,6}\b/i, 'style.css :root has no colour of its own');
  for (const [v, token] of [['bg', 'surface-0'], ['panel', 'surface-1'], ['panel-2', 'surface-2'], ['text', 'text-1'], ['muted', 'text-2'], ['accent', 'accent-solid'], ['accent-2', 'accent-text'], ['border', 'line'], ['error', 'danger']]) {
    assert.match(root, new RegExp(`--${v}: var\\(--${token}\\);`), v);
  }
  assert.doesNotMatch(style, /:root\[data-theme="light"\] \{\s*--bg/, 'no second set of light colours');
  const tidy = web('ui-tidy.css');
  assert.match(tidy, /--ok: var\(--success\);/);
  assert.doesNotMatch(tidy, /^\s*--danger:/m, 'ui-tidy.css must not override the --danger token');
});

test('theme: loaded first, no flash: the boot script sets the theme before any stylesheet', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const boot = head.indexOf('<script src="/theme-boot.js"></script>');
  assert.ok(boot > 0, 'a plain (not module, not inline) script');
  assert.ok(boot < head.indexOf('<link rel="stylesheet"'), 'before every stylesheet');
  assert.match(head, /<link rel="stylesheet" href="\/theme.css">\s*<link rel="stylesheet" href="\/style.css">\s*<link rel="stylesheet" href="\/ui-tidy.css">\s*<link rel="stylesheet" href="\/look.css">/);
  assert.match(head, /interactive-widget=resizes-content/, 'phones: the composer stays above the keyboard');
  assert.match(head, /viewport-fit=cover/, 'phones: safe areas');
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attributes');
  // The setting: Night / Day / Follow the system (V3, docs/ops/V3_DESIGN.md §5: the owner's default), on the same per-device key.
  assert.match(html, /<select id="ap-theme"><option value="dark">Night<\/option><option value="light">Day<\/option><option value="system">Follow the system \(default\)<\/option><\/select>/);
  const tips = JSON.parse(web('tips.json'));
  assert.match(JSON.stringify(tips), /"ap-theme":\["Follow the system is the default/);
  assert.match(app, /const themePick = \(pal = palettePick\(\)\) => \{\s*const v = localStorage\.getItem\('sara\.theme'\);\s*return v === 'light' \|\| v === 'system' \|\| v === 'dark' \? v : pal === 'classic' \? 'dark' : 'system';/);
});

/** Runs web/theme-boot.js against a fake page. */
function boot({ stored, light = false, search = '', shell, classes = [] as string[] }: { stored?: string; light?: boolean; search?: string; shell?: unknown; classes?: string[] }) {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  const cls = new Set(classes);
  const root = {
    setAttribute: (k: string, v: string) => (attrs[k] = v),
    classList: { add: (...c: string[]) => c.forEach((x) => cls.add(x)), contains: (c: string) => cls.has(c) },
    style: { setProperty: (k: string, v: string) => (props[k] = v) },
  };
  const posted: unknown[] = [];
  const window: Record<string, unknown> = { saraShell: shell, matchMedia: () => ({ matches: light }), chrome: { webview: { postMessage: (m: unknown) => posted.push(m) } } };
  runInNewContext(web('theme-boot.js'), {
    window,
    document: { documentElement: root },
    localStorage: { getItem: (k: string) => (k === 'sara.theme' ? (stored ?? null) : null) },
    matchMedia: () => ({ matches: light }),
    location: { search },
  });
  return { attrs, props, cls, window, posted };
}

test('theme-boot: Follow the system unless Night or Day was picked (V3, the owner default); the native strip', () => {
  assert.equal(boot({}).attrs['data-theme'], 'dark', 'nobody chose, a dark system: Night');
  assert.equal(boot({ light: true }).attrs['data-theme'], 'light', 'nobody chose, a light system: Day (V3)');
  assert.equal(boot({ stored: 'dark', light: true }).attrs['data-theme'], 'dark', 'a picked Night stays');
  assert.equal(boot({ stored: 'light' }).attrs['data-theme'], 'light');
  assert.equal(boot({ stored: 'system', light: true }).attrs['data-theme'], 'light');
  assert.equal(boot({ stored: 'system', light: false }).attrs['data-theme'], 'dark');
  assert.equal(boot({ stored: 'nonsense', light: true }).attrs['data-theme'], 'light', 'unknown values: the default (the system)');
  assert.ok(boot({}).cls.has('theme-night'));
  assert.equal(boot({}).attrs['data-accent'], 'blue', 'V3: Blue by default');
  // Normal browsers: nothing changes.
  const plain = boot({});
  assert.ok(!plain.cls.has('shell'));
  assert.equal(plain.props['--titlebar'], undefined);
  // The apps: window.saraShell or the class on <html>.
  const win = boot({ shell: { platform: 'windows', titlebar: 32 } });
  assert.ok(win.cls.has('shell') && win.cls.has('shell-windows'));
  assert.equal(win.props['--titlebar'], '32px');
  const mac = boot({ classes: ['shell-mac'] });
  assert.ok(mac.cls.has('shell-mac'));
  assert.equal(mac.props['--titlebar'], '28px');
  assert.equal(boot({ shell: { platform: 'darwin', titlebar: 999 } }).props['--titlebar'], '28px', 'out-of-range heights fall back');
  // The page tells the app it draws the strip; the app's own theme counts until one is picked here.
  assert.equal(JSON.stringify(win.posted), JSON.stringify([{ type: 'shell', titlebar: true }]));
  assert.equal(plain.posted.length, 0);
  assert.equal(boot({ shell: { platform: 'windows', titlebar: 32, theme: 'day' } }).attrs['data-theme'], 'light');
  assert.equal(boot({ stored: 'dark', shell: { platform: 'windows', titlebar: 32, theme: 'day' } }).attrs['data-theme'], 'dark');
  assert.match(app, /window\.saraShellSay\?\.\(\{ type: 'theme', theme: theme === 'light' \? 'day' : theme === 'system' \? 'system' : 'night' \}\)/);
  // Trying it in a browser.
  const tried = boot({ search: '?shell=windows&titlebar=40' });
  assert.ok(tried.cls.has('shell-windows') && tried.cls.has('shell-test'));
  assert.equal(tried.props['--titlebar'], '40px');
  assert.equal((tried.window.saraShell as { platform: string }).platform, 'windows');
  assert.equal(tried.posted.length, 0, 'the browser test mode sends nothing');
  // The page draws a drag strip with its controls left clickable.
  assert.match(look, /html\.shell \.shell-drag \{[^}]*height: var\(--titlebar\);[^}]*app-region: drag; -webkit-app-region: drag;/);
  assert.match(look, /html\.shell #chat-head :is\(button, a, input, select, textarea[^)]*\)[\s\S]*?\{ app-region: no-drag; -webkit-app-region: no-drag; \}/);
  assert.match(html, /<div id="shell-drag" class="shell-drag" aria-hidden="true"><\/div>/);
});

test('step line: built from the stream events and the stored tool messages; replaces the grey boxes', () => {
  for (const fn of ['stepLine', 'addStep', 'waitStep', 'runStep', 'finishStep', 'memoryStep', 'stepWords', 'fmtDuration']) assert.match(steps, new RegExp(`export (function|const) ${fn}\\b`), fn);
  // Every word on the line goes through t() as a literal (so the extractor and translations see it).
  // Phase 115 (BR1 B3): the verb table moved to web/step-words.js (shared with the chat apps' progress message); steps.js re-exports stepWords.
  const words = web('step-words.js');
  assert.match(steps, /import \{ stepWordsWith \} from '\.\/step-words\.js'/);
  assert.doesNotMatch(words, /pair\('/);
  assert.ok((words.match(/pair\(t\('/g) ?? []).length >= 40);
  assert.match(words, /t\('Checking the weather…'\), t\('Checked the weather'\)/);
  // History: tool messages become steps (no toolBlock), memories used in the reply too.
  const render = /function renderMessages\(messages, opts = \{\}\) \{([\s\S]*?)\n\}\n/.exec(app)![1];
  assert.doesNotMatch(render, /toolBlock\(/);
  assert.match(render, /addStep\(\(turn\.steps \?\?= newSteps\(\)\), \{ id: m\.meta\?\.toolCallId, name: m\.meta\?\.name/);
  assert.match(render, /m\.meta\?\.memoryIds/);
  assert.match(render, /memoryStep\(/);
  // Live: tool_call → a running step, approval → waiting, tool_running → running, tool_result → done.
  const stream = /async function runStream\(path, body, userBubble\) \{([\s\S]*?)\n\}\n/.exec(app)![1];
  assert.match(stream, /addStep\(ensureSteps\(\), \{ id: ev\.id, name: ev\.name, summary: ev\.summary, args: ev\.args, status: 'running' \}\)/);
  assert.match(stream, /waitStep\(steps, ev\.id\)/);
  assert.match(stream, /runStep\(steps, ev\.id\)/);
  assert.match(stream, /finishStep\(steps, ev\)/);
  assert.doesNotMatch(stream, /toolBlock\(/);
  // Undo to before a step still works from the details.
  assert.match(app, /stepLine\(\{ named: toolNamed, undo: addUndo \}\)/);
  // Collapsed by default, one tap opens: a native <details> (keyboard and screen readers).
  assert.match(steps, /el\('details', 'steps'\)/);
  assert.match(steps, /el\('details', 'step-detail'\)/);
  assert.match(look, /\.steps \{ display: block;/, 'a <details> shown as block, not grid (phones)');
});

test('result cards: from the tool result data only, one drawer per card kind, safe links', () => {
  const kinds = [...readFileSync(join(ROOT, 'src', 'cards.ts'), 'utf8').matchAll(/\| \{ kind: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 11, kinds.join());
  for (const k of kinds) assert.ok(k === 'file' ? /function files\(list\)/.test(cards) : new RegExp(`const DRAW = \\{[^}]*\\b${k}\\b`).test(cards), `card kind ${k} is drawn`);
  assert.doesNotMatch(cards, /innerHTML|insertAdjacentHTML/);
  assert.match(cards, /if \(!\/\^https\?:\\\/\\\/\/i\.test\(r\.url\)\) continue;/);
  assert.match(cards, /a\.rel = 'noopener noreferrer';/);
  // The cards come from ev.card / m.meta.card (the server's), never from her reply.
  assert.match(app, /if \(ev\.card && ev\.status === 'ok'\)/);
  assert.match(app, /m\.meta\?\.card/);
  assert.doesNotMatch(cards, /_raw|\.content\b/);
});

test('messages, composer and header: ids, actions, disclosure and touch rules kept', () => {
  for (const id of ['input', 'send', 'stop', 'mic', 'call', 'video-call-btn', 'attach', 'attach-file', 'together', 'conv-usage', 'conv-settings-btn', 'conv-summary', 'speak-toggle', 'pl-badge', 'server-btn', 'sara-status', 'chat-title', 'toggle-sidebar', 'composer', 'messages', 'activity']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // The composer: text first, then +, call, video, mic, Send.
  const form = /<form id="composer">([\s\S]*?)<\/form>/.exec(html)![1];
  const order = ['id="input"', 'id="composer-plus"', 'id="call"', 'id="video-call-btn"', 'id="mic"', 'id="send"'].map((s) => form.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'composer order');
  assert.match(form, /id="composer-menu" class="composer-menu head-pop" role="menu" hidden>[\s\S]*id="attach"[\s\S]*id="attach-photo"[\s\S]*id="together"/);
  assert.match(form, /id="send" type="submit" aria-label="Send"/);
  // The header: the AI disclosure pill is never folded away with the other chips.
  const head = /<header id="chat-head">([\s\S]*?)<\/header>/.exec(html)![1];
  const chips = /<div id="head-chips" class="head-chips">([\s\S]*?)<\/div>/.exec(head)![1];
  assert.doesNotMatch(chips, /ai-badge|pl-badge/);
  assert.match(head, /<span class="ai-badge" title="Sara is an AI companion">AI companion<\/span>/);
  assert.match(head, /id="ctx-ring"[^>]*aria-label="How full this conversation is"[^>]*aria-controls="ctx-sheet"/);
  // The usage footnote lives in the ring's sheet now.
  assert.match(head, /<div id="ctx-sheet"[\s\S]*id="conv-usage"/);
  // Message actions: inside the message, shown on hover/focus, long-press or ⋯ (touch), Escape closes.
  assert.match(app, /div\.append\(more, bar\)/);
  assert.match(look, /\.msg:hover > \.msg-actions, \.msg:focus-within > \.msg-actions, \.msg\.show-actions > \.msg-actions \{ opacity: 1;/);
  assert.match(look, /@media \(hover: none\) \{\s*button\.msg-more \{[^}]*width: 44px;/);
  assert.match(web('look.js'), /setTimeout\(\(\) => \{\s*msg\.querySelector\(':scope > \.msg-more'\)\?\.click\(\);/);
  // 44 px targets on touch screens; one row on phones.
  assert.match(look, /@media \(pointer: coarse\) \{[\s\S]*#composer > button\.icon, #composer-plus, #composer #send \{ width: 44px; height: 44px; \}/);
  // The tour still finds the composer and the conversation settings.
  for (const sel of ['#input', '#conv-settings-btn', '#new-chat']) assert.match(app, new RegExp(`sel: '${sel}'`), sel);
});

test('PL2c N32: disabled buttons pass 3:1 against their card in both themes (text and border)', () => {
  const night = block(theme, ':root,\n:root[data-theme="dark"]');
  const day = block(theme, ':root[data-theme="light"]');
  for (const [name, th] of [['Night', night], ['Day', day]] as const) {
    for (const card of ['surface-1', 'surface-2']) {
      assert.ok(contrast(th['btn-off-text'], th[card]) >= 3, `${name}: disabled text on --${card}: ${contrast(th['btn-off-text'], th[card]).toFixed(2)}`);
      assert.ok(contrast(th['btn-off-line'], th[card]) >= 3, `${name}: disabled border on --${card}: ${contrast(th['btn-off-line'], th[card]).toFixed(2)}`);
    }
    // Readable on its own fill too.
    assert.ok(contrast(th['btn-off-text'], th['btn-off-fill']) >= 3, `${name}: text on the disabled fill`);
  }
  // The rule uses the tokens (no opacity fade, no gradient) for every gradient-style button.
  const screens = web('screens.css');
  assert.match(screens, /button:disabled:not\(\.ghost, \.tip, \.linkish, \.icon, \.tab\), button:disabled:not\(\.ghost, \.tip, \.linkish, \.icon, \.tab\):hover \{\s*background: var\(--btn-off-fill\);\s*color: var\(--btn-off-text\);\s*border: 1px solid var\(--btn-off-line\);\s*box-shadow: none;\s*opacity: 1;/);
  assert.match(screens, /button\.ghost:disabled, button\.ghost:disabled:hover \{ color: var\(--btn-off-text\); border-color: var\(--btn-off-line\); opacity: 1;/);
});
