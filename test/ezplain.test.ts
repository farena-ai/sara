// 3.3.0 easy mode, part C (ezplain): plain words, email a normal person can set up, one approval at a
// time, settings you can find (everyday words in Ctrl K, the Settings search and "How do I…" in the
// chat) and settings you can just ask her to change (change_setting, a small allow-list with Undo).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cardFor } from '../src/cards.ts';
import { createEverydaySettingsTool, EVERYDAY_SETTINGS } from '../src/everyday-settings.ts';
import { explainSignIn } from '../src/mail/explain.ts';
import { searchGuide } from '../src/settingsguide.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const search: Any = await import(pathToFileURL(join(ROOT, 'web', 'settings-search.js')).href);
const everyday: Any = await import(pathToFileURL(join(ROOT, 'web', 'everyday-words.js')).href);

// The same page records test/phase128b.test.ts builds (title, group, keywords, questions, labels, text).
const html = web('index.html');
const sections = [...html.matchAll(/<section class="settings-page[^"]*" data-page="([\w-]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => ({ id: m[1], group: m[2].replace(/&amp;/g, '&'), title: m[3].replace(/&amp;/g, '&'), body: m[4] }));
const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ');
const howto = JSON.parse(web('howto.json')) as Record<string, { q: string }[]>;
const tips = JSON.parse(web('tips.json')) as { pages: Record<string, [string, string]> };
const F = search.foldText as (s: string) => string;
const records = sections.filter((s) => !['ab-recipes', 'account', 'desktop-app'].includes(s.id)).map((s) => {
  const head = [s.title, s.group, tips.pages[s.id]?.[0] ?? ''];
  for (const m of s.body.matchAll(/<(h3|h4|label|legend|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) head.push(strip(m[2]));
  for (const m of s.body.matchAll(/(?:data-tip|aria-label|placeholder)="([^"]*)"/g)) head.push(m[1]);
  return { id: s.id, title: F(s.title), group: F(s.group), was: '', keywords: (search.SETTINGS_KEYWORDS[s.id] ?? []).map(F), questions: (howto[s.id] ?? []).map((q) => F(q.q)), head: F(head.join(' ')), body: F(strip(s.body)) };
});

/** Everyday phrasings → the page that should come first. */
const FIRST: [string, string][] = [
  ['bigger text', 'you-appearance'],
  ['make the text bigger', 'you-appearance'],
  ['larger font', 'you-appearance'],
  ['font', 'you-appearance'],
  ['zoom in', 'you-appearance'],
  ['the letters are too small', 'you-appearance'],
  ['dark mode', 'you-appearance'],
  ['how much does this cost', 'dh-usage'],
  ['cost', 'dh-usage'],
  ['price', 'dh-usage'],
  ['my bill', 'dh-usage'],
  ['how much did I spend', 'dh-usage'],
  ['money', 'dh-usage'],
  ['quiet', 'her-voice'],
  ['mute her', 'her-voice'],
  ['turn off your voice', 'her-voice'],
  ['language', 'you-about'],
  ['change the language', 'you-about'],
  ['password', 'dh-devices'],
  ['phone', 'co-phone'],
  ['backup', 'dh-backups'],
  ['update', 'dh-updates'],
];

test('ezplain 11: everyday words find the right Settings page first (Ctrl K and the Settings search share it)', () => {
  for (const [q, want] of FIRST) {
    const got = search.rankPages(q, records).map((r: Any) => r.id);
    assert.equal(got[0], want, `“${q}” → ${got.slice(0, 4).join(', ')}`);
  }
  // "email" is also the name of the Email chat app page: both come first, the mailbox page next to it.
  assert.ok(search.rankPages('email', records).slice(0, 2).some((r: Any) => r.id === 'ab-mail'));
  assert.equal(search.rankPages('connect my email', records)[0].id, 'ab-mail');
  // Deleting a chat isn't a Settings page: Elsewhere says where it is, first.
  for (const q of ['delete a chat', 'remove conversation', 'delete this conversation', 'erase a chat']) {
    assert.equal(search.rankElsewhere(q, [])[0]?.id, 'howto:delete-chat', q);
  }
  // A specific name still wins over an everyday word ("add phone" is Devices and sign-in, "app password" is mail).
  assert.equal(search.rankPages('add phone', records)[0].id, 'dh-devices');
  assert.equal(search.rankPages('app password', records)[0].id, 'ab-mail');
  // Ctrl K puts the everyday answer first too.
  const app = web('app.js');
  assert.match(app, /const plain = everydayFor\(q\)/);
  assert.match(app, /return \[\.\.\.plain, \.\.\.named/);
  // One list of words: the browser and the server's settings guide read the same module.
  assert.ok(everyday.EVERYDAY.length >= 14);
  for (const e of everyday.EVERYDAY) assert.ok(e.page || e.place, e.id);
});

test('ezplain 11: "How do I…" in the chat (settings_guide) answers everyday words with the right place first', () => {
  const first = (q: string) => searchGuide(q, 5)[0];
  assert.match(first('bigger text')!.link, /settings:you-appearance/);
  assert.match(first('How do I make the text bigger?')!.text, /Text size/);
  assert.match(first('how much does this cost')!.link, /settings:dh-usage/);
  assert.match(first('how do I delete a chat')!.text, /⋯/);
  assert.match(first('turn off voice')!.link, /settings:her-voice/);
  assert.match(first('dark mode')!.link, /settings:you-appearance/);
  // Unrelated questions still go through the normal guide.
  assert.doesNotMatch(first('what does jealousy do')!.link, /you-appearance|dh-usage/);
});

test('ezplain 5: a failed mail sign-in says why in plain words (wrong password, 2-step off, IMAP off, unreachable)', () => {
  assert.equal(explainSignIn('NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)', 'gmail'), 'password');
  assert.equal(explainSignIn('535 5.7.8 Username and Password not accepted', 'gmail'), 'password');
  assert.equal(explainSignIn('[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)', 'gmail'), 'two-step');
  assert.equal(explainSignIn('534-5.7.9 Please log in with your web browser and then try again.', 'gmail'), 'two-step');
  assert.equal(explainSignIn('[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable it.', 'gmail'), 'imap-off');
  assert.equal(explainSignIn('IMAP access is disabled for your domain', 'zoho'), 'imap-off');
  assert.equal(explainSignIn('getaddrinfo ENOTFOUND imap.example.com', 'other'), 'unreachable');
  assert.equal(explainSignIn("imap.invalid couldn't be found", 'other'), 'unreachable');
  assert.equal(explainSignIn('connect ECONNREFUSED 127.0.0.1:1143', 'proton'), 'unreachable');
  assert.equal(explainSignIn('The mail server took too long to answer.', 'yahoo'), 'unreachable');
  assert.equal(explainSignIn('Something odd', 'yahoo'), 'other');
  // The routes send the reason with the error, and the page shows its own plain words for it.
  const routes = readFileSync(join(ROOT, 'src', 'routes', 'connections.ts'), 'utf8');
  assert.match(routes, /reason: explainSignIn\(last, String\(body\.preset/);
  assert.match(routes, /reason: explainSignIn\(msg, accts\.list\(\)/);
  const page = web('mail-accounts.js');
  for (const k of ['password', 'two-step', 'imap-off', 'unreachable']) assert.match(page, new RegExp(`(?:'${k}'|${k.replace('-', '_')}): \\(`), k);
  assert.match(page, /t\('Check it'\)/);
});

test('ezplain 5: Add Gmail starts the 3-step app-password route; Google Cloud is Advanced; Outlook has 3 plain steps', () => {
  const page = web('mail-accounts.js');
  // Add Gmail → the app-password form (owners too), with the Google Cloud route as Advanced.
  assert.match(page, /const addGmail = \(\) => \(\(adding = 'other'\), \(preset = 'gmail'\), render\(\)\)/);
  assert.match(page, /t\('Advanced: full Gmail organizing \(Google Cloud\)'\)/);
  assert.match(page, /t\('An app password is a separate password just for Sara\./);
  // The server list stays available, behind details.
  assert.match(page, /t\('Server details \(you can ignore these\)'\)/);
  // Outlook.com: app passwords stopped working for mail apps in September 2024, so it stays the
  // Microsoft sign-in, as three plain steps with no secret to make.
  assert.match(page, /const MS_STEPS = \['register', 'copy', 'signin'\];/);
  assert.match(page, /Public client\/native \(mobile & desktop\)/);
  assert.doesNotMatch(page, /Copy the Application ID and make a secret/);
});

test('ezplain 12/13: one approval in view; plain words for a skill program; Today says Approve / Not now', () => {
  const app = web('app.js');
  // The line above the box answers only while the card itself is out of view (or missing).
  assert.match(app, /function cardInView\(card\)/);
  assert.match(app, /const card = waitingCards\(\)\[0\];\n\s+const offscreen = card \? !cardInView\(card\) : false;/);
  assert.match(app, /t\('Show me'\)/);
  // No card in the chat but the server is waiting: the card is drawn again from the server's list.
  assert.match(app, /if \(!card && activity\.status === 'waiting'\) void restoreWaitingCards\(\);/);
  // Her panel says it waits and points to it; it no longer has a third set of Allow / Deny.
  const panel = web('her-panel.js');
  assert.doesNotMatch(panel, /hp-appr-btns/);
  assert.match(panel, /t\('Show me'\)/);
  const today = web('today.js');
  assert.match(today, /btn\('ghost small', t\('Not now'\)/);
  // Plain words on a skill's program; the file and its first lines behind Show details.
  const skills = web('skills.js');
  assert.match(skills, /t\('{name} wants to run a small program that came with her “{skill}” skill\.'/);
  assert.match(skills, /t\('It will: {what}'/);
  assert.match(skills, /el\('summary', '', t\('Show details'\)\)/);
  const tools = readFileSync(join(ROOT, 'src', 'skill-tools.ts'), 'utf8');
  assert.match(tools, /summary: `Run a small program from the “\$\{v\.name\}” skill`/);
  assert.match(tools, /about: /);
  // Skills she saves (or the owner asks for) need no approval, as the owner asked earlier.
  assert.match(readFileSync(join(ROOT, 'test', 'appr-skill-save.test.ts'), 'utf8'), /skill_save, recipe_save and skill_update are allowed by default/);
});

test('ezplain settings by asking: change_setting changes a small allow-list, with a card and Undo', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
  const tool = createEverydaySettingsTool(() => app);
  assert.equal(tool.defaultPermission, 'auto');
  const names = (tool.spec.parameters as Any).properties.setting.enum as string[];
  assert.deepEqual([...names].sort(), ['color', 'my_name', 'text_size', 'theme', 'voice'].sort());
  // Never anything that weakens safety, approvals or privacy.
  for (const bad of ['approvals', 'adult', 'privacy', 'tools', 'sandbox', 'password', 'sign_in']) assert.ok(!names.includes(bad), bad);
  const ctx = { signal: new AbortController().signal } as Any;
  const out = await tool.run({ setting: 'text_size', value: 'bigger' }, ctx);
  assert.match(out, /Text size/);
  const card = cardFor({ name: 'change_setting', args: { setting: 'text_size', value: 'bigger' }, status: 'ok', output: out }) as Any;
  assert.equal(card.kind, 'setting');
  assert.equal(card.setting, 'text_size');
  assert.equal(card.value, '17');
  assert.equal(card.device, true);
  assert.ok(card.id && card.at);
  assert.equal(cardFor({ name: 'change_setting', args: { setting: 'text_size', value: 'largest' }, status: 'ok', output: await tool.run({ setting: 'text_size', value: 'largest' }, ctx) })!.kind, 'setting');
  // A name is saved on the server for this person (the owner, or a member in their own space).
  app.settings.update({ ownerName: 'Patricia' });
  const named = await tool.run({ setting: 'my_name', value: 'Pat' }, ctx);
  assert.equal(app.settings.get().ownerName, 'Pat');
  const nc = cardFor({ name: 'change_setting', args: { setting: 'my_name', value: 'Pat' }, status: 'ok', output: named }) as Any;
  assert.equal(nc.device, false);
  assert.equal(nc.from, 'Patricia');
  // Unknown values are refused with the choices; dark/green map to the app's own values.
  await assert.rejects(tool.run({ setting: 'theme', value: 'purple-ish' }, ctx), /Night|Day/);
  assert.equal((cardFor({ name: 'change_setting', args: { setting: 'theme', value: 'dark mode' }, status: 'ok', output: await tool.run({ setting: 'theme', value: 'dark mode' }, ctx) }) as Any).value, 'dark');
  assert.equal((cardFor({ name: 'change_setting', args: { setting: 'color', value: 'green' }, status: 'ok', output: await tool.run({ setting: 'color', value: 'green' }, ctx) }) as Any).value, 'green');
  assert.equal((cardFor({ name: 'change_setting', args: { setting: 'voice', value: 'off' }, status: 'ok', output: await tool.run({ setting: 'voice', value: 'off' }, ctx) }) as Any).value, 'off');
  assert.ok(EVERYDAY_SETTINGS.text_size.values.includes('19'));
  // The card draws in the chat, applies once and has Undo; the lean picker offers it on everyday words.
  const cards = web('result-cards.js');
  assert.match(cards, /settingCard\(c\)/);
  const ec = web('everyday-card.js');
  assert.match(ec, /t\('Undo'\)/);
  const lean = readFileSync(join(ROOT, 'src', 'lean.ts'), 'utf8');
  assert.match(lean, /\[\/\^change_setting\$\/, 'settings', 'everyday settings'\]/);
});

test('ezplain 17: plain words on the main screens; the technical words stay in the Run view and Developer pages', () => {
  const steps = web('steps.js');
  assert.match(steps, /t\('How she answered'\)/);
  assert.doesNotMatch(steps, /t\('Show the run'\)/);
  const tl = web('run-timeline.js');
  assert.match(tl, /plainChat\(\)/);
  assert.match(tl, /t\('She did 1 thing'\)/);
  // The Appearance preview reads like an everyday chat, not a build.
  const pv = /<div class="ap-preview"[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? html.slice(html.indexOf('ap-pv-text') - 200, html.indexOf('ap-pv-text') + 900);
  assert.doesNotMatch(pv, /build|tests|Ship it|fast-model/i);
  // Sara Classic says it changes the whole layout, and how to go back.
  assert.match(web('app.js'), /t\('Sara Classic changes the whole layout/);
  // The honesty line says what to do, with a button.
  assert.match(web('app.js'), /t\('Ask her to really do it'\)/);
  // Her picture: Appearance is the one place, and Look and her page point there.
  assert.match(html, /id="ap-herpic-more"/);
});
