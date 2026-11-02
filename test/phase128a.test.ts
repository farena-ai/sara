// Phase 128 slice PL2a (2.61.0, docs/design/POLISH2.md §4.1 and §5 PL2a): no more brick walls. One
// setup card for every chat app (web/setup-card.js), the short consent step for Sara's own plugins
// (proven on the server, never by the plugin's own words), guided Signal, Email and Telegram, and
// the check-in note that never covers the message box. Runs as 2.61.0 until the release bumps
// package.json (like phase122b). No real Signal, Meta or Telegram: a stand-in signal-cli daemon on
// 127.0.0.1 and a stand-in DOM.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fromFolder } from '../src/packages.ts';
import { PLUGIN_LIMITS, PluginManager } from '../src/plugins/manager.ts';
import { linkQr, parseDaemon, probeDaemon } from '../src/plugins/signal-setup.ts';
import { satisfies } from '../src/plugins/manifest.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { FakeSignalCli } from './signal-cli-fake.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// PL2a ships in 2.61.0; until the release bumps package.json the test runs as 2.61.0.
const V = satisfies(PKG_VERSION, '>=2.61.0') ? PKG_VERSION : '2.61.0';
const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------- a tiny stand-in DOM, enough for web/setup-card.js ----------
class El {
  tagName: string;
  className = '';
  textContent = '';
  id = '';
  type = '';
  value = '';
  placeholder = '';
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: (El | string)[] = [];
  listeners: Record<string, ((e: unknown) => unknown)[]> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...xs: (El | string)[]) {
    this.children.push(...xs);
  }
  replaceChildren(...xs: (El | string)[]) {
    this.children = [...xs];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(ev: string, fn: (e: unknown) => unknown) {
    (this.listeners[ev] ??= []).push(fn);
  }
  async fire(ev: string) {
    for (const fn of this.listeners[ev] ?? []) await fn({ target: this });
  }
  all(): El[] {
    return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()]));
  }
  find(f: (e: El) => boolean): El | undefined {
    return this.all().find(f);
  }
  text(): string {
    return [this.textContent, ...this.children.map((c) => (typeof c === 'string' ? c : c.text()))].join(' ');
  }
}
(globalThis as Any).document = { createElement: (tag: string) => new El(tag), createTextNode: (s: string) => s };
const card: Any = await import(pathToFileURL(join(ROOT, 'web', 'setup-card.js')).href);

const APPS: Record<string, { page: string; box: string; file: string }> = {
  whatsapp: { page: 'co-whatsapp', box: 'wa-box', file: 'whatsapp.js' },
  matrix: { page: 'co-matrix', box: 'mx-box', file: 'matrix.js' },
  imessage: { page: 'co-imessage', box: 'im-box', file: 'imessage.js' },
  signal: { page: 'co-signal', box: 'sig-box', file: 'signal.js' },
  email: { page: 'co-email', box: 'em-box', file: 'email.js' },
  telegram: { page: 'co-telegram', box: 'tg-setup', file: 'telegram-setup.js' },
};

test('128a.1 N1: every Connections chat-app page renders a .setup-card with What you need, a time line and a cost line before setup', async () => {
  const html = web('index.html');
  for (const [app, x] of Object.entries(APPS)) {
    const page = html.slice(html.indexOf(`data-page="${x.page}"`), html.indexOf('</section>', html.indexOf(`data-page="${x.page}"`)));
    assert.match(page, new RegExp(`id="${x.box}"`), `${x.page} has the card's box`);
    assert.match(web(x.file), new RegExp(`setupCard\\('${app}'`), `${x.file} draws the shared card`);
    let started = 0;
    const c = card.setupCard(app, { builtin: true, onStart: () => void started++ }) as El;
    assert.match(c.className, /\bsetup-card\b/, app);
    assert.ok(c.find((e) => e.tagName === 'H4' && e.textContent === 'What you need'), `${app}: What you need`);
    const need = c.find((e) => e.tagName === 'UL' && e.className === 'plg-setup')!;
    assert.ok(need.children.length >= 2 && need.children.length <= 4, `${app}: 2–4 things you need`);
    assert.ok(c.find((e) => e.className === 'setup-time')?.textContent.trim(), `${app}: about how long`);
    assert.ok(c.find((e) => e.className === 'setup-cost')?.textContent.trim(), `${app}: what it costs`);
    const start = c.find((e) => e.tagName === 'BUTTON' && e.textContent === 'Start')!;
    const tick = c.find((e) => e.tagName === 'INPUT' && e.type === 'checkbox');
    // Only where there is one: the rules box with its tick (Meta's, Apple's, Matrix's), Start waits for it.
    if (['whatsapp', 'matrix', 'imessage'].includes(app)) {
      assert.equal(tick?.id, { whatsapp: 'wa-terms-tick', matrix: 'mx-terms-tick', imessage: 'im-terms-tick' }[app]);
      assert.equal(start.disabled, true, `${app}: Start waits for the tick`);
      tick!.checked = true;
      await tick!.fire('change');
      assert.equal(start.disabled, false);
    } else assert.equal(tick, undefined, `${app}: no rules box`);
    await start.fire('click');
    assert.equal(started, 1, `${app}: Start runs`);
  }
  // N6: Meta's rules in two bullets and the link, still with the tick.
  const wa = card.setupCard('whatsapp', { builtin: true }) as El;
  const rules = wa.find((e) => /\bsetup-rules\b/.test(e.className))!;
  assert.equal(rules.find((e) => e.tagName === 'UL')!.children.length, 2);
  assert.match(rules.text(), /Since January 2026 Meta's terms forbid offering a general-purpose AI assistant on WhatsApp/);
  assert.ok(rules.find((e) => e.tagName === 'A' && /whatsapp\.com\/legal\/business-solution-terms/.test((e as Any).href)));
  // Not part of this copy: Start hides and says why.
  const missing = card.setupCard('signal', { builtin: false, missing: 'not here' }) as El;
  assert.equal(missing.find((e) => e.tagName === 'BUTTON' && e.textContent === 'Start')!.hidden, true);
  assert.match(missing.text(), /not here/);
});

/** A rig with Sara's own plugins folder (a copy, so nothing in the repo moves) and a third-party copy of WhatsApp. */
function rig(t: { after: (fn: () => Promise<void> | void) => void }, fence: 'node-only' | 'bwrap' = 'node-only') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  const builtinDir = join(dir, 'builtin');
  cpSync(join(ROOT, 'plugins', 'whatsapp'), join(builtinDir, 'whatsapp'), { recursive: true });
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => x, fence, saraVersion: V, builtinDir });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    app.store.close();
    cleanup();
  });
  // Someone else's package with the same id, name and author line: it must not pass as Sara's own.
  const fake = join(dir, 'fake-whatsapp');
  cpSync(join(ROOT, 'plugins', 'whatsapp'), fake, { recursive: true });
  writeFileSync(join(fake, 'main.mjs'), `${readFileSync(join(fake, 'main.mjs'), 'utf8')}\n// changed by someone else\n`);
  return { app, pm, dir, fake };
}

test('128a.2 N2: a first-party plugin gets the consent step and installs with one OK; a third-party one keeps the full card; the fingerprint check runs both times', async (t) => {
  const { pm, fake } = rig(t);
  const seen: string[] = [];
  const orig = pm.checkFingerprint.bind(pm);
  pm.checkFingerprint = (files, sha) => {
    seen.push(sha);
    return orig(files, sha);
  };
  // Sara's own: staged from the plugins folder that ships with Sara.
  const own = pm.stageBuiltin('whatsapp');
  assert.equal(own.firstParty, true);
  assert.equal(own.builtin, true);
  assert.equal(card.consentKind(own), 'short', 'the page shows the consent step');
  assert.equal(own.needsTrust, true, 'no fence here: the consent step stands in for the trust tick');
  // One OK (consent), no trust tick.
  await pm.approve(own.id, { consent: true });
  assert.ok(pm.store.get('whatsapp'), 'installed');
  assert.deepEqual(seen, [own.sha], 'the fingerprint check ran');
  await pm.remove('whatsapp');

  // Third party, same manifest (id whatsapp, "The Sara team"): a folder is never first-party.
  for (const origin of [{ kind: 'folder' as const, where: fake }, { kind: 'zip' as const, where: 'whatsapp.zip' }, { kind: 'git' as const, where: 'https://example.com/whatsapp.git' }]) {
    const r = pm.stage(fromFolder(fake, PLUGIN_LIMITS), origin);
    assert.equal(r.firstParty, undefined, origin.kind);
    assert.equal(card.consentKind(r), 'full', `${origin.kind}: the full review card`);
    await assert.rejects(pm.approve(r.id, { consent: true }), /I trust this plugin's author/, 'consent alone is not enough');
    pm.cancel(r.id);
  }
  const third = pm.stage(fromFolder(fake, PLUGIN_LIMITS), { kind: 'folder', where: fake });
  await pm.approve(third.id, { trust: true });
  assert.equal(seen.at(-1), third.sha, 'the fingerprint check ran for the third-party one too');
  assert.equal(seen.length, 2);
  await pm.remove('whatsapp');

  // A builtin whose folder name doesn't match its id is not trusted as Sara's own either.
  const odd = pm.stage(fromFolder(fake, PLUGIN_LIMITS), { kind: 'builtin', where: 'other-name' });
  assert.equal(odd.firstParty, undefined);
  pm.cancel(odd.id);
  // The Sara Store's signature-checked list: only a first-party entry for the same id counts.
  for (const [trust, want] of [['first-party', true], ['reviewed', undefined], ['community', undefined]] as const) {
    pm.storeMatch = (sha) => ({ item: 'whatsapp', version: '1.0.0', name: 'WhatsApp', trust, ...(sha ? {} : {}) });
    const r = pm.stage(fromFolder(fake, PLUGIN_LIMITS), { kind: 'store', where: 'whatsapp@1.0.0' });
    assert.equal(r.firstParty, want, trust);
    pm.cancel(r.id);
  }
  pm.storeMatch = () => ({ item: 'whatsapp', version: '1.0.0', name: 'WhatsApp', trust: 'first-party', yanked: 'pulled' });
  const yanked = pm.stage(fromFolder(fake, PLUGIN_LIMITS), { kind: 'store', where: 'whatsapp@1.0.0' });
  assert.equal(yanked.firstParty, undefined, 'a pulled version is not trusted');
  pm.cancel(yanked.id);
  pm.storeMatch = undefined;

  // Files that change after the review are refused, first-party or not.
  const again = pm.stageBuiltin('whatsapp');
  const staged = (pm as Any).review(again.id);
  assert.ok(staged);
  assert.throws(() => pm.checkFingerprint([{ path: 'main.mjs', data: Buffer.from('x') }], again.sha), /changed after you looked/);
  // An update is never the short step (its card shows what changed).
  assert.equal(card.consentKind({ ...again, kind: 'update' }), 'full');
});

test('128a.3 N2: the consent step and the page wiring', async () => {
  const review = { id: 'r1', kind: 'install', firstParty: true, fence: 'node-only', manifest: { id: 'whatsapp', name: 'WhatsApp', version: '1.0.0' }, lines: [], files: [], sha: 'x' };
  let added = 0;
  let cancelled = 0;
  let detailed: Any = null;
  const step = card.consentStep(review, { name: 'WhatsApp', reach: 'It can reach graph.facebook.com.', reviewCard: (r: Any) => ((detailed = r), new El('div')), onAdd: async () => void added++, onCancel: () => void cancelled++ }) as El;
  assert.match(step.text(), /Add WhatsApp to Sara/);
  assert.match(step.text(), /It can reach graph\.facebook\.com\./);
  assert.match(step.text(), /Node's permission limits, without a sandbox/, 'the plain Windows line instead of the amber warning');
  assert.doesNotMatch(step.text(), /can't fence|Not fenced in/);
  const add = step.find((e) => e.tagName === 'BUTTON' && e.textContent === 'Add WhatsApp')!;
  await add.fire('click');
  assert.equal(added, 1, 'one OK');
  await step.find((e) => e.tagName === 'BUTTON' && e.textContent === 'Cancel')!.fire('click');
  assert.equal(cancelled, 1);
  // The full review card is one tap away under Details, read only (no trust tick).
  const det = step.find((e) => e.tagName === 'DETAILS')!;
  det.open = true;
  await det.fire('toggle');
  assert.equal(detailed?.needsTrust, false);
  // The pages: Start goes through startFirstParty; the server gets `consent`, never a page-made "first-party".
  for (const f of ['whatsapp.js', 'matrix.js', 'imessage.js', 'signal.js', 'email.js']) assert.match(web(f), /startFirstParty\('(whatsapp|matrix|imessage|signal|email)'/, f);
  const sc = web('setup-card.js');
  assert.match(sc, /body: \{ review: review\.id, consent: true \}/);
  assert.match(sc, /consentKind\(review\) === 'full'\) return void \(await o\.full\(id\)\)/, 'anything else: the full card');
  const route = readFileSync(join(ROOT, 'src', 'routes', 'plugins.ts'), 'utf8');
  assert.match(route, /pm\.approve\(r\.id, \{ trust: body\.trust === true, consent: body\.consent === true \}\)/);
});

test('128a.4 N3: Signal steps have an install line for Windows, macOS and Linux and Copy rows; daemon not reachable is one plain sentence', async (t) => {
  const js = web('signal.js');
  assert.match(js, /winget install EclipseAdoptium\.Temurin\.25\.JRE/, 'Windows');
  assert.match(js, /brew install signal-cli/, 'macOS');
  assert.match(js, /Linux-native \.tar\.gz/, 'Linux');
  assert.match(js, /\['docker', 'Docker'\]/, 'Docker as an option');
  assert.match(js, /copyRow\(t\('Start it with'\), daemonCmd\(\)/, 'the exact command for this computer, with Copy');
  assert.match(js, /daemon --tcp \$\{st\.address\} --receive-mode=manual/);
  assert.match(js, /register`/);
  assert.match(js, /link -n Sara`/);
  for (const fix of ['No Java found', 'Address already in use', 'is not registered']) assert.ok(js.includes(fix), fix);
  const { DIAG } = { DIAG: Object.fromEntries([...js.matchAll(/^ {2}([A-Z_]+): \(/gm)].map((m) => [m[1], true])) };
  for (const code of ['DAEMON_DOWN', 'DAEMON_SLOW', 'NOT_SIGNAL', 'NOT_LOCAL', 'BAD_ADDRESS']) assert.ok(DIAG[code], `the page explains ${code}`);
  assert.match(js, /DAEMON_DOWN: \(p\) => \[t\("Sara can't reach signal-cli at \{address\}\.", \{ address: [^}]+\}\), t\('Start it with the command in step 3 and leave that window open\.'\)\]/, 'one plain sentence and the fix');

  // The server's check: a stand-in daemon answers `version`; a closed port is DAEMON_DOWN.
  const fake = await new FakeSignalCli().start();
  t.after(() => fake.stop());
  const ok = await probeDaemon(`127.0.0.1:${fake.port}`);
  assert.equal(ok.ok, true);
  assert.ok(ok.version);
  assert.deepEqual(fake.calls('version').length, 1, 'one version call, nothing else');
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  assert.deepEqual(await probeDaemon(`127.0.0.1:${port}`), { ok: false, address: `127.0.0.1:${port}`, code: 'DAEMON_DOWN' });
  // Something else on the port (it answers, but not as signal-cli).
  const conns = new Set<import('node:net').Socket>();
  const other = createServer((c) => {
    conns.add(c);
    c.on('error', () => undefined);
    c.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const c of conns) c.destroy();
    return new Promise<void>((r) => other.close(() => r()));
  });
  assert.equal((await probeDaemon(`127.0.0.1:${(other.address() as AddressInfo).port}`)).code, 'NOT_SIGNAL');
  // Only this computer, or the home network with the switch; never the internet.
  assert.deepEqual(parseDaemon('8.8.8.8:7583'), { code: 'NOT_LOCAL' });
  assert.deepEqual(parseDaemon('8.8.8.8:7583', true), { code: 'NOT_LOCAL' });
  assert.deepEqual(parseDaemon('192.168.1.20:7583'), { code: 'NOT_LOCAL' });
  assert.deepEqual(parseDaemon('192.168.1.20:7583', true), { host: '192.168.1.20', port: 7583 });
  assert.deepEqual(parseDaemon('localhost:7583'), { host: '127.0.0.1', port: 7583 });
  assert.deepEqual(parseDaemon('example.com:7583'), { code: 'NOT_LOCAL' });
  assert.deepEqual(parseDaemon('nope'), { code: 'BAD_ADDRESS' });
  assert.deepEqual(parseDaemon(''), { host: '127.0.0.1', port: 7583 }, 'the default');
  // The link QR: only a sgnl://linkdevice address is drawn.
  assert.match(String(linkQr('sgnl://linkdevice?uuid=abcdefghij&pub_key=xyz')), /^data:image\/svg\+xml;base64,/);
  assert.equal(linkQr('https://example.com/?x=1234567890'), null);
  assert.equal(linkQr('sgnl://linkdevice?<script>'), null);
});

test('128a.5 C3: the shared helpers are imported, not copied', () => {
  for (const f of ['whatsapp.js', 'matrix.js', 'imessage.js', 'signal.js', 'email.js', 'telegram-setup.js']) {
    const js = web(f);
    assert.doesNotMatch(js, /function (copyRow|diagLine|field|okLine)\b/, f);
    assert.match(js, /from '\.\/setup-card\.js';/, f);
    assert.doesNotMatch(js, /style=/, `${f}: no inline styles`);
  }
  // The card module itself has no static imports (so a test can render it); its ✕ is only Test's failed line, never a close button.
  const sc = web('setup-card.js');
  assert.doesNotMatch(sc, /^import /m);
  assert.doesNotMatch(sc, /btn\('✕'/);
  // N8: one card level on phones.
  assert.match(web('screens.css'), /@media \(max-width: 480px\) \{\n {2}\.wa-box \.kit-card, \.plg-signal \.kit-card, \.setup-host \.kit-card \{ border: 0;/);
});

test('128a.6 N5 and N4: Telegram opens on the steps with the options under More; Email picks the provider first', () => {
  const html = web('index.html');
  const tg = html.slice(html.indexOf('data-page="co-telegram"'), html.indexOf('data-page="co-discord"'));
  assert.ok(tg.indexOf('id="tg-setup"') < tg.indexOf('<details id="tg-more"'), 'the steps come first');
  for (const id of ['tg-token', 'tg-enabled', 'tg-link', 'tg-owners', 'tg-cmd-native', 'tg-media-send', 'tg-prog-on', 'tg-rooms']) assert.ok(tg.indexOf(`id="${id}"`) > tg.indexOf('<details id="tg-more"'), `${id} kept, under More`);
  const tjs = web('telegram-setup.js');
  assert.match(tjs, /https:\/\/t\.me\/BotFather/);
  assert.match(tjs, /copyRow\(t\('Send this'\), '\/newbot'/);
  assert.match(tjs, /token: last\.running/, 'the key step is ✓ only when Sara reached the bot');
  assert.match(web('app.js'), /renderTelegramSetup\(tg, \{ reload: loadTelegram \}\);/);
  const ejs = web('email.js');
  const order = ['provider', 'add', 'account', 'link', 'test'].map((id) => ejs.indexOf(`{ id: '${id}'`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'provider first, then add, the address, the link, Test');
  for (const p of ['Gmail', 'iCloud', 'Fastmail', 'Other']) assert.match(ejs, new RegExp(`  ${p}: \\(\\) => \\['`), p);
  assert.match(ejs, /values = \{ provider: st\.provider \|\| 'Other', address, username: address \}/, 'the servers fill themselves from the provider');
});

test('128a.7 N26: the check-in note sits in the page flow (Today or above the message box), never over it', () => {
  const html = web('index.html');
  const chat = html.slice(html.indexOf('<main id="chat">'), html.indexOf('<form id="composer">'));
  assert.match(chat, /<div id="chat-checkin" class="checkin-slot"><\/div>\s*$/, 'right above the composer, in the flow');
  assert.match(html, /<div id="td-checkin" class="checkin-slot td-checkin"><\/div>/);
  const hub = web('hub.js');
  assert.match(hub, /function showFirst\(\) \{\n {2}if \(!st\.firstPending \|\| st\.folded\) return;\n {2}placeFirst\(\);/);
  assert.match(hub, /const host = today\?\.open \? \$\('#td-checkin'\) : \$\('#chat-checkin'\);/);
  assert.match(hub, /note\.classList\.add\('hub-note-inline'\);/);
  const css = web('hub.css');
  assert.match(css, /\.hub-note\.hub-note-inline \{ position: static; z-index: auto; transform: none; left: auto; bottom: auto;/);
});
