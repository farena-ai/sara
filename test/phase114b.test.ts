// Phase 114 slice PL1b (2.47.1, docs/design/POLISH.md §5, §7 and §8): the first run in one queue
// (wizard → check-in card folded into the last step → tour offer after her first reply, never two at
// once), the use choice (company, coding or both: saved per companion, changeable in About you),
// Next as the primary button in Connect a brain with a test ping, the picked-for-you card and the
// Connected chip, two six-stop tours (the 14-stop one kept), starter chips (wizard step 4 and an
// empty chat) and Getting started ordered by the choice, two columns, nothing cut off. The queue runs
// in Node against a small stand-in for the page with a fake clock; the server parts against a
// throwaway data folder.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { CHECKLIST_ORDER, checklist, OWNER_STEPS } from '../src/checklist.ts';
import { CompanionSettings } from '../src/companions.ts';
import { createSaraServer } from '../src/server.ts';
import { SettingsStore, usePathOf } from '../src/settings.ts';
import { loadTitleSet } from '../src/title-evals.ts';
import { sentenceCase, titlePrompt } from '../src/titles.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'];
const lang = (l: string) => JSON.parse(web(`i18n/${l}.json`)) as Record<string, string>;
const fr = () => import(pathToFileURL(join(ROOT, 'web', 'first-run.js')).href);
const t = (s: string) => s;

// ---------- a stand-in page: dialogs and notes, enough for overlayCount and the queue ----------
class Page {
  dialogs = new Map<string, boolean>(); // id → open
  notes = new Map<string, { cls: string; hidden: boolean }>();
  querySelectorAll(sel: string) {
    if (sel === 'dialog[open]') return [...this.dialogs].filter(([, open]) => open).map(([id]) => ({ id }));
    return [...this.notes].filter(([, n]) => (n.cls === 'hub-note' && !n.hidden) || n.cls === 'tour-offer' || n.cls === 'tour-card').map(([id]) => ({ id }));
  }
  count() {
    return [...this.dialogs].filter(([id, open]) => open && id !== 'today').length + this.querySelectorAll('notes').length;
  }
}
/** A fake clock for setTimeout / clearTimeout. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => (due.set(++seq, { at: now + ms, fn }), seq),
    clearTimeout: (id: number) => void due.delete(id),
    advance(ms: number) {
      now += ms;
      for (const [id, x] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (x.at > now) continue;
        due.delete(id);
        x.fn();
      }
    },
  };
}

test('114b.1 F2: wizard → check-in → tour offer, one at a time, the tour only after her first reply (fake clock)', async () => {
  const { createQueue, overlayCount } = await fr();
  const page = new Page();
  const timers = fakeTimers();
  const max: number[] = [];
  const check = () => max.push(page.count());
  // Today is a page under everything, the wizard is open (setup on: claim, token and disclosure came before as screens).
  page.dialogs.set('today', true);
  page.dialogs.set('setup', true);
  const q = createQueue({ doc: page, timers, every: 1500 });
  let replied = false;
  q.add('notice', () => page.notes.set('hub-first', { cls: 'hub-note', hidden: false }));
  q.add('tour', () => page.notes.set('offer', { cls: 'tour-offer', hidden: false }), () => replied);
  check();
  assert.equal(overlayCount(page), 1, 'only the wizard (Today is not an overlay)');
  assert.deepEqual(q.waiting, ['notice', 'tour']);
  // Steps 1–4 pass; the queue keeps waiting while the wizard is open.
  for (let i = 0; i < 4; i++) {
    timers.advance(1500);
    check();
  }
  assert.equal(page.notes.size, 0, 'nothing shows under the wizard');
  // Wizard closes without the card being folded in (Set up later): the notice comes next, alone.
  page.dialogs.set('setup', false);
  timers.advance(1500);
  check();
  assert.equal(page.notes.get('hub-first')?.hidden, false);
  assert.deepEqual(q.waiting, ['tour'], 'the tour waits');
  // Got it → the queue looks again, but she hasn't replied yet.
  page.notes.get('hub-first')!.hidden = true;
  q.pump();
  timers.advance(3000);
  check();
  assert.ok(!page.notes.has('offer'), 'no tour offer before her first reply');
  replied = true;
  q.pump();
  check();
  assert.ok(page.notes.has('offer'), 'offered after her first reply');
  assert.deepEqual(q.waiting, []);
  assert.ok(max.every((n) => n <= 1), `never more than one at once: ${max.join(',')}`);
  // A folded card is dropped from the queue (it lives in the wizard's last step).
  const q2 = createQueue({ doc: new Page(), timers });
  q2.add('notice', () => assert.fail('folded: not shown again'), () => false);
  q2.drop('notice');
  assert.deepEqual(q2.waiting, []);
});

test('114b.2 the use choice: saved per companion, About you changes it, the setup and settings answer it', async (t) => {
  assert.equal(usePathOf('coding'), 'coding');
  assert.equal(usePathOf(undefined), 'both', 'skipped = both');
  assert.equal(usePathOf('ninja'), 'both');
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-01T15:00:00Z') });
  app.settings.update({ disclosureAcceptedAt: new Date().toISOString() });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'PUT', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  let r = await call('/api/settings');
  assert.deepEqual([r.json.usePath, r.json.usePathChosen], ['both', false]);
  assert.equal((await call('/api/setup')).json.usePath, 'both');
  r = await call('/api/settings', { usePath: 'coding' });
  assert.equal(r.status, 200);
  assert.deepEqual([(await call('/api/settings')).json.usePath, (await call('/api/settings')).json.usePathChosen], ['coding', true]);
  assert.equal((await call('/api/setup')).json.usePath, 'coding', 'the wizard shows it again');
  assert.equal((await call('/api/checklist')).json.path, 'coding');
  r = await call('/api/settings', { usePath: 'ninja' });
  assert.equal(r.status, 400);
  assert.equal(app.settings.get().usePath, 'coding', 'unchanged');
  // Per companion: a second companion keeps her own choice; the server's settings don't carry it.
  const d2 = tempDir();
  t.after(d2.cleanup);
  const server2 = new SettingsStore(d2.dir);
  mkdirSync(join(d2.dir, 'mira'));
  const mira = new CompanionSettings(join(d2.dir, 'mira'), server2);
  mira.update({ usePath: 'company' });
  assert.equal(mira.get().usePath, 'company');
  assert.equal(server2.get().usePath, undefined, 'saved in her folder, not the shared settings');
  // The page: step 1 saves it with the name, About you changes it, the chips and Today follow.
  const app_ = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app_, /body: \{ ownerName: name, timeZone: Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone, usePath: su\.path \}/);
  assert.match(app_, /\$\('#use-path'\)\.addEventListener\('change', async \(\) => \{[^]*?usePath: v[^]*?renderMessages\(\[\]\)[^]*?loadChecklist\(\)/);
  assert.match(web('index.html'), /<select id="use-path"><option value="company">[^<]+<\/option><option value="coding">[^<]+<\/option><option value="both">Both<\/option><\/select>/);
});

test('114b.3 Getting started follows the choice (7 steps each), coder steps tick themselves, members get no owner-only steps', (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-01T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const input = { devices: [] as string[], pushDevices: 0, personaCustom: false };
  const ids = () => checklist(app, input).items.map((i) => i.id);
  assert.deepEqual(ids(), ['brain', 'talk', 'yours', 'phone', 'voice', 'morning', 'backup'], 'never chosen: the list from before');
  app.settings.update({ usePath: 'company' });
  assert.deepEqual(ids(), ['brain', 'talk', 'yours', 'voice', 'phone', 'morning', 'backup'], '§5.2 order');
  app.settings.update({ usePath: 'coding' });
  assert.deepEqual(ids(), ['brain', 'project', 'tools', 'github', 'editor', 'budgets', 'backup'], '§5.3 order');
  for (const p of ['company', 'coding', 'both'] as const) assert.equal(CHECKLIST_ORDER[p].length, 7);
  const done = (extra = {}) => Object.fromEntries(checklist(app, { ...input, ...extra }).items.map((i) => [i.id, i.done]));
  assert.deepEqual(done(), { brain: false, project: false, tools: false, github: false, editor: false, budgets: false, backup: false });
  app.store.createConversation({ mode: 'coding' } as never);
  app.settings.update({ toolPermissions: { run_command: 'ask' }, turnBudgets: { coding: { tokens: 30_000 } } } as never);
  app.vault.set('git:github', 'x');
  assert.deepEqual(done({ devices: ['Sara for VS Code'] }), { brain: false, project: true, tools: true, github: true, editor: true, budgets: true, backup: false });
  assert.ok(checklist(app, input).items.every((i) => /^(chat|settings:[a-z-]+)$/.test(i.open)));
  // A household member: their own list, no owner-only steps.
  const member = checklist(app, { ...input, member: true }).items.map((i) => i.id);
  assert.deepEqual(member, ['project', 'editor']);
  assert.ok(!member.some((id) => OWNER_STEPS.includes(id)));
  app.settings.update({ usePath: 'company' });
  assert.deepEqual(checklist(app, { ...input, member: true }).items.map((i) => i.id), ['talk', 'yours', 'voice', 'phone', 'morning']);
  // The new step names are translated (Today shows them with t()).
  for (const l of LANGS) for (const k of ['Open a project', 'Choose how she runs code', 'Add a GitHub token', 'Use her from your editor', 'Set a budget']) assert.ok(lang(l)[k], `${l}: ${k}`);
});

test('114b.4 F11: two columns, the whole description, the next step highlighted (1440 and 390)', () => {
  const css = web('today.css');
  assert.match(css, /#today \.today-start-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /#today \.start-item \.start-hint \{ display: block; overflow: visible; white-space: normal; text-overflow: clip; \}/);
  assert.match(css, /#today \.start-item\.next \{/);
  // No clamp or ellipsis on those nodes anywhere, and the phone keeps the hint (one column).
  for (const f of ['today.css', 'style.css', 'polish.css', 'screens.css', 'ui-tidy.css', 'first-run.css']) {
    for (const m of web(f).matchAll(/([^{}]*start-hint[^{}]*)\{([^}]*)\}/g)) {
      if (/\.done/.test(m[1])) continue;
      assert.doesNotMatch(m[2], /line-clamp|text-overflow: ellipsis|display: none/, `${f}: ${m[1].trim()}`);
    }
  }
  assert.match(css, /#today \.today-start-list \{ grid-template-columns: minmax\(0, 1fr\); \}/, 'phone: one column');
  assert.match(['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n'), /const next = left\[0\]\?\.id;[^]*?\$\{i\.id === next \? ' next' : ''\}/);
});

test('114b.5 F3/F5/F6: Next is primary and waits for a test ping; no primary button says Skip; the picked-for-you card', () => {
  const html = web('index.html');
  const setup = html.slice(html.indexOf('<dialog id="setup"'), html.indexOf('</dialog>', html.indexOf('<dialog id="setup"')));
  for (const m of setup.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) if (/skip|later/i.test(m[2])) assert.match(m[1], /class="(ghost|linkish)[^"]*"/, `quiet: ${m[2]}`);
  assert.match(setup, /<div class="setup-head">[^]*?<button id="su-skip" type="button" class="linkish small">Set up later<\/button>/, 'Set up later in the header');
  assert.match(setup, /<button id="su-later" type="button" class="linkish" hidden>Skip for now<\/button>/);
  assert.match(setup, /<button id="su-next" type="button">Next<\/button>/);
  for (const id of ['su-path', 'su-model-row', 'su-status', 'su-pick-name', 'su-pick-tags', 'su-change', 'su-model-pick', 'su-subs-box', 'su-subs-tag', 'su-starters', 'su-checkin']) assert.match(setup, new RegExp(`id="${id}"`), id);
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.doesNotMatch(app, /\$\('#su-next'\)\.textContent = [^;]*Skip/, 'the primary button never says Skip');
  assert.match(app, /\$\('#su-next'\)\.disabled = step === 3 && !su\.brainOk && !su\.openSubs;/);
  assert.match(app, /api\('\/model-jobs\/test', \{ method: 'POST', body: \{ job: 'quick', providerId: su\.provider, model \} \}\)/, 'a real test message');
  assert.match(app, /su\.brainOk = true;\n\s*suStatus\('ok'\);/);
  assert.match(app, /kind === 'ok' \? t\('Connected ✓'\)/);
  assert.match(app, /su\.useLocal\?\.replaceWith\(el\('span', 'su-chip', t\('Connected ✓'\)\)\)/, 'F6: Use it becomes a chip');
  // F5 builds on fillModelOptions' pick (PL1a); coding picks what Use recommended picks for code.
  assert.match(app, /fillModelOptions\(\$\('#su-model'\), view, '', \{ pick \}\)/);
  assert.match(app, /const pick = su\.path === 'coding' && su\.coderPick \? su\.coderPick : suggestModel\(models, \{ noGpu \}\);/);
  assert.match(app, /t\('Good for coding'\)/);
});

test('114b.6 starter chips send a real message; the short tours (6 stops) are offered after her first reply; the full tour stays', async () => {
  const { starterChips, tourFor, offerText, pathChoices, normPath } = await fr();
  assert.deepEqual(pathChoices(t).map((c: { id: string }) => c.id), ['company', 'coding', 'both']);
  assert.equal(normPath('x'), 'both');
  assert.deepEqual([tourFor('company'), tourFor('coding'), tourFor('both'), tourFor(undefined)], ['company', 'coding', 'company', 'company']);
  const labels = (p: string, w: string) => starterChips(p, w, t).map((c: { label: string }) => c.label);
  assert.deepEqual(labels('company', 'wizard'), ['Tell me about yourself', 'Plan my day with me', 'What can you do?'], '§5.2 step 4');
  assert.deepEqual(labels('coding', 'wizard'), ['Look at my project', 'Fix a failing test', 'Start a new project', 'Connect GitHub', 'Use her from my editor'], '§5.3 step 4');
  for (const p of ['company', 'coding', 'both']) assert.equal(starterChips(p, 'chat', t).length, 4, `${p}: 4 chips in an empty chat`);
  assert.deepEqual(labels('both', 'chat'), ['Plan my day with me', 'Tell me about yourself', 'Look at my project', 'Fix a failing test'], 'F13');
  for (const c of [...starterChips('company', 'chat', t), ...starterChips('coding', 'wizard', t)]) {
    if (c.kind === 'send' || c.kind === 'code') assert.ok(c.text.length >= c.label.length);
    else assert.ok(c.kind === 'starter' || (c.kind === 'page' && /^[a-z]+-[a-z]+$/.test(c.page)));
  }
  assert.match(offerText('coding', t), /Seven quick stops/); // PL2b: the coding tour's seventh stop (the / menu)
  assert.doesNotMatch(offerText('company', t), /one-minute/);
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  // A chip sends a real message (a coding conversation for code chips).
  assert.match(app, /async function runStarter\(c\) \{[^]*?await api\('\/conversations', \{ method: 'POST', body: \{ mode: 'coding' \} \}\)[^]*?await send\(c\.text\);/);
  // The offer waits in the queue until her first reply; the demo keeps its own start.
  assert.match(app, /firstRun\.add\('tour', offerFirstTour, \(\) => Boolean\(state\.replied\) && !tourRunning\(\)\)/);
  assert.match(app, /if \(state\.messages\?\.some\(\(m\) => m\.role === 'assistant' && m\.content\.trim\(\)\)\) \{\n\s*state\.replied = true;\n\s*firstRun\.pump\(\);/);
  assert.match(app, /if \(session\.demo\) setTimeout\(offerFirstTour, 4000\);\n\s*else queueTourOffer\(\);/);
  assert.doesNotMatch(app, /setTimeout\(offerFirstTour, 1500\)/, 'not right after the wizard any more');
  // The queue holds while the wizard loads; the hub's notes go through it.
  assert.match(app, /createQueue\(\{ doc: document, busy: \(\) => Boolean\(state\.setupPending\) \|\| overlayCount\(document\) > 0 \}\)/);
  assert.match(app, /initHub\(\{ demo: Boolean\(session\.demo\), openSettings, queue: firstRun \}\)/);
  // The tours: 6 stops for each width (coding: 7 since PL2b, 2.61.1: one stop for the / menu, POLISH2 N27); the 14-stop tour still in Help.
  // PL2d: the tours moved to tours.js (one level deeper, inside makeTours); the indent is not the test.
  const block = (name: string) => app.slice(app.indexOf(`  ${name}: [`), app.indexOf('  ],', app.indexOf(`  ${name}: [`)));
  for (const name of ['company', 'coding']) {
    const steps = [...block(name).matchAll(/^ +\{ (.*) \},?$/gm)].map((m) => m[1]);
    const wide = steps.filter((s) => !/when: \(\) => phoneWidth\(\)/.test(s));
    const phone = steps.filter((s) => !/when: \(\) => !phoneWidth\(\)/.test(s));
    const stops = name === 'coding' ? 7 : 6;
    assert.equal(wide.length, stops, `${name} on a wide screen`);
    assert.equal(phone.length, stops, `${name} on a phone`);
  }
  assert.match(block('coding'), /sel: '#conv-settings-btn'[^]*sel: '#messages'[^]*sel: '#tool-list'[^]*sel: '#open-team'[^]*sel: '#open-findings'[^]*sel: '#pj-work-dials'/, '§5.3 order');
  assert.match(block('company'), /sel: '#input'[^]*sel: '#her-face'[^]*sel: '#open-today'[^]*sel: '#open-planner'[^]*sel: '#open-memory'[^]*data-page="her-character"/, '§5.2 order');
  assert.ok(/when: \(\) => !isMember\(\), before: settingsAt\('ab-tools'\)/.test(block('coding')), 'members: no owner-only stops');
  const html = web('index.html');
  for (const name of ['company', 'coding', 'first']) assert.match(html, new RegExp(`data-tour="${name}"`));
  assert.match(html, /data-tour="first"><strong>The full tour<\/strong>/);
});

test('114b.7 F2: the check-in notice folds into the last step (same text, same three buttons) and the first ping still waits for it', () => {
  const html = web('index.html');
  assert.ok(html.includes("Sara sends one small anonymous check-in a day so we can support you and plan features: the version, the kind of computer (Windows, Mac or Linux) and which features are switched on. We don&#39;t keep your IP address, your name, your chats or anything about your system beyond that."), 'the text is unchanged');
  const hub = web('hub.js');
  assert.match(hub, /export function foldFirstRun\(host\) \{[^]*?st\.queue\?\.drop\('notice'\);[^]*?note\.classList\.replace\('hub-note', 'hub-note-folded'\);[^]*?host\.append\(note\);[^]*?api\('\/hub\/first-run', \{ method: 'POST', body: \{ action: 'shown' \} \}\)/, 'shown is recorded when folded in');
  assert.match(hub, /export function unfoldFirstRun\(\) \{[^]*?if \(st\.firstPending\) void firstRun\('dismiss'\);/);
  assert.match(hub, /if \(st\.folded\) \{\n\s*const pre = \$\('#hub-first-preview'\);/, 'Show what\'s sent stays inside the wizard');
  assert.match(hub, /if \(!st\.firstPending \|\| st\.member \|\| st\.demo \|\| !host\) return false;/, 'members and the demo: never');
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /function suStepFour\(\) \{[^]*?foldFirstRun\(\$\('#su-checkin'\)\);/);
  assert.match(app, /async function suFinish\(\) \{\n\s*await api\('\/setup\/done', \{ method: 'POST', body: \{\} \}\);\n[^]*?unfoldFirstRun\(\);/);
  // The server still blocks the first check-in until the notice was shown (Phase 113).
  assert.match(readFileSync(join(ROOT, 'src', 'routes', 'hub.ts'), 'utf8'), /if \(body\.action === 'shown' && !st\.noticeShownAt\) hub\.state\.update\(\{ noticeShownAt: now \}\);/);
});

test('114b.8 the page rules: tips ≤ 260 in every language, translations, no inline style, 44 px, sw bumped, help updated', () => {
  const tips = JSON.parse(web('tips.json')) as { tips: Record<string, [string, string]> };
  const tip = tips.tips['use-path'][0];
  assert.ok(tip.length <= 260);
  for (const l of LANGS) {
    const d = lang(l);
    assert.ok(d[tip] && d[tip].length <= 260, `${l}: tip`);
    for (const k of ['What will you mostly do with her?', 'Picked for you', 'Connected ✓', 'Good for coding', 'Companion tour', 'Coder tour', 'Tell me about yourself', 'Fix a failing test', 'Set up later']) assert.ok(d[k] && d[k] !== k, `${l}: ${k}`);
  }
  const html = web('index.html');
  const setup = html.slice(html.indexOf('<dialog id="setup"'), html.indexOf('</dialog>', html.indexOf('<dialog id="setup"')));
  assert.doesNotMatch(setup, /style="/);
  assert.match(html, /<link rel="stylesheet" href="\/first-run\.css">/);
  const css = web('first-run.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'theme tokens only');
  for (const sel of ['.starter-chip', '#setup #su-change', '#setup .setup-head #su-skip, #setup #su-later']) assert.match(css, new RegExp(`${sel.replace(/[.#()]/g, (c) => `\\${c}`)} \\{[^}]*min-height: 44px`), sel);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v49'\)/);
  const help = web('help.html');
  assert.match(help, /<em>Companion tour<\/em> and the <em>Coder tour<\/em> \(six stops each\)/);
  assert.match(help, /what you will mostly do with her: <em>Company<\/em>, <em>Coding<\/em> or <em>Both<\/em>/);
});

test('114b.9 F14: casual titles: the prompt asks for 3-5 words in sentence case; a Title Case answer is turned into sentence case (names kept, German left alone)', (t) => {
  assert.equal(sentenceCase('Introduction To Assistant Capabilities', 'en'), 'Introduction to assistant capabilities');
  assert.equal(sentenceCase('Trip To Paris With Mia', 'en', 'we fly to Paris next week with Mia.'), 'Trip to Paris with Mia', 'names from the talk keep their capital');
  assert.equal(sentenceCase('Fixing The GitHub API Tests', 'en'), 'Fixing the GitHub API tests');
  assert.equal(sentenceCase('Tomato garden plans', 'en'), 'Tomato garden plans', 'already sentence case');
  assert.equal(sentenceCase('Planes Para El Fin De Semana', 'es'), 'Planes para el fin de semana');
  assert.equal(sentenceCase('Planung Der Gartenarbeit', 'de'), 'Planung Der Gartenarbeit', 'German nouns keep capitals');
  // Over the title eval set: a Title Case answer built from each session's topics never stays Title Case.
  const titleCase = (s: string) => s.split(' ').filter((w) => /^\p{L}{3,}/u.test(w)).slice(1).every((w) => /^\p{Lu}/u.test(w));
  const set = loadTitleSet();
  let n = 0;
  for (const s of set.sessions) {
    if (s.lang === 'de') continue;
    const answer = ['Talking', 'About', ...s.topics.slice(0, 3)].map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    const out = sentenceCase(answer, s.lang, (s.lines ?? []).join('\n'));
    assert.ok(!titleCase(out) || out.split(' ').length < 3, `${s.id}: ${out}`);
    n++;
  }
  assert.ok(n >= 30, `${n} sessions`);
  // The prompt itself.
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-01T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation({});
  const { system } = titlePrompt(app, conv, [], 'en');
  assert.match(system, /short, casual title of 3 to 5 words .* in sentence case \(only the first word and names start with a capital\)/);
  assert.match(readFileSync(join(ROOT, 'src', 'titles.ts'), 'utf8'), /if \(out && out !== 'SAME'\) out = sentenceCase\(out, lang, /);
});
