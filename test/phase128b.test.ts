// Phase 128 slice PL2b (2.61.1, docs/design/POLISH2.md §4.2, §4.3 and §5 PL2b): find it, and know
// it's there. Settings in 8 groups with every page id unchanged, a better Settings search (keywords,
// the How do I…? questions, ranking, Elsewhere), the / menu in the message box with one command list,
// the @ menu in a new chat (N20), Share her on the Companions row, Tidy this chat from 70% (N25) and
// the coding tour's new stop. Runs as 2.61.1 until the release bumps package.json (like phase122b).
// Static checks plus the pure helpers in Node; no browser, a fake clock for the app.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { APP_MENU, appMenu, appMenuTable, DESCRIPTIONS, isCommandName, MENU_COMMANDS } from '../src/bridges/commands.ts';
import { GROUP_ORDER, howtoSections, pageTitles, type HowtoData } from '../src/guide-howto.ts';
import { withAppMenuTable } from '../src/guide-commands.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { satisfies } from '../src/plugins/manifest.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// PL2b ships in 2.61.1; until the release bumps package.json the test runs as 2.61.1.
const V = satisfies(PKG_VERSION, '>=2.61.1') ? PKG_VERSION : '2.61.1';
const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const search: Any = await import(pathToFileURL(join(ROOT, 'web', 'settings-search.js')).href);
// slash.js and next-steps.js only import naming.js (no DOM at import time).
const slash: Any = await import(pathToFileURL(join(ROOT, 'web', 'slash.js')).href);

/** The Settings pages of index.html: id, group, title and the section's HTML. */
const sections = [...html.matchAll(/<section class="settings-page[^"]*" data-page="([\w-]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => ({ id: m[1], group: m[2].replace(/&amp;/g, '&'), title: m[3].replace(/&amp;/g, '&'), body: m[4] }));
const list = (name: string) => /const NAME = \[([\s\S]*?)\];/.source.replace('NAME', name);
const ORDER = new RegExp(list('SETTINGS_ORDER')).exec(app)![1].match(/'([\w-]+)'/g)!.map((s) => s.slice(1, -1));
const GROUPS = [...new RegExp(list('SETTINGS_GROUPS')).exec(app)![1].matchAll(/name: '([^']+)'/g)].map((m) => m[1]);

test('128b.1 N29: every page id in SETTINGS_ORDER is in exactly one group; 8 groups (+ Household) with bounded pages; ids unchanged', () => {
  assert.equal(V.startsWith('2.61') || satisfies(V, '>=2.61.1'), true);
  assert.deepEqual(GROUPS, ['Her', 'You', 'Models', 'Chat apps', 'Add-ons', 'Coding', 'Connections', 'Data & health', 'Household']);
  // The guide's index and HOW_DO_I.md group the same way (generated from the group table).
  assert.deepEqual(GROUP_ORDER, GROUPS);
  assert.equal(new Set(ORDER).size, ORDER.length, 'SETTINGS_ORDER has no page twice');
  assert.deepEqual([...ORDER].sort(), sections.map((s) => s.id).sort(), 'SETTINGS_ORDER lists every page');
  const byGroup = new Map<string, string[]>();
  for (const s of sections) {
    assert.ok(GROUPS.includes(s.group), `${s.id}: group ${s.group} has a header`);
    byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s.id]);
  }
  // The retired Recipes page and the member-only account page aren't in the owner's list.
  // Q3 adds Recovery and Q4 adds Operations; EC7 adds Microsoft Teams as the eleventh chat app (Chat
  // apps keeps its chat apps together rather than splitting them); other groups retain the ten-page cap.
  assert.equal(byGroup.get('Data & health')?.length, 12);
  assert.ok(byGroup.get('Data & health')?.includes('dh-operations'));
  for (const [g, ids] of byGroup) assert.ok(ids.filter((x) => x !== 'ab-recipes' && x !== 'account').length <= (g === 'Data & health' || g === 'Chat apps' ? 12 : 10), `${g}: ${ids.length} pages`);
  const want: Record<string, string[]> = {
    'Chat apps': ['co-telegram', 'co-discord', 'co-signal', 'co-email', 'co-whatsapp', 'co-matrix', 'co-imessage', 'co-slack', 'co-teams', 'co-pickup', 'co-continuity'],
    'Add-ons': ['ab-store', 'ab-skills', 'ab-plugins', 'ab-mcp', 'ab-search', 'ab-library', 'ab-google', 'ab-home', 'ab-recipes'],
    Coding: ['ab-projects', 'ab-precise', 'ab-persist', 'ab-budgets', 'ab-github', 'ab-ssh', 'ab-tools'],
    // V1 (docs/ops/V1_DESIGN.md §7): Appearance became its own page in You.
    You: ['you-about', 'you-appearance', 'you-briefing', 'you-leave-by', 'ab-when', 'you-adult'],
    Connections: ['co-phone', 'co-computer', 'desktop-app', 'co-apps', 'co-agents', 'co-hooks'],
  };
  for (const [g, ids] of Object.entries(want)) assert.deepEqual([...byGroup.get(g)!].sort(), [...ids].sort(), g);
  // Inside each group the nav follows SETTINGS_ORDER, so a group's pages are next to each other.
  const groupOf = new Map(sections.map((s) => [s.id, s.group]));
  const runs = ORDER.map((id) => groupOf.get(id)).filter((g, i, a) => g !== a[i - 1]);
  assert.deepEqual(runs, GROUPS, 'one run per group, in the group order');
});

test('128b.2 OLD_TABS, every openSettings / showSettingsTab / settings: link, the tours and the checklist still resolve', () => {
  const ids = new Set(sections.map((s) => s.id));
  const old = /const OLD_TABS = \{([^}]+)\}/.exec(app)![1];
  const oldTabs = new Map([...old.matchAll(/'?([\w-]+)'?: '([\w-]+)'/g)].map((m) => [m[1], m[2]]));
  assert.ok(oldTabs.size >= 9);
  for (const [k, v] of oldTabs) assert.ok(ids.has(v), `OLD_TABS.${k} → ${v}`);
  const files = readdirSync(join(ROOT, 'web')).filter((f) => f.endsWith('.js'));
  let n = 0;
  for (const f of files) {
    const src = web(f);
    for (const m of src.matchAll(/(?:openSettings|showSettingsTab|openSettingsPage)\(\s*'([\w-]+)'/g)) {
      n++;
      // V3: 'home' is the Settings home (every page under its group), not a page.
      assert.ok(ids.has(m[1]) || m[1] === 'home' || ids.has(oldTabs.get(m[1]) ?? ''), `${f}: openSettings('${m[1]}')`);
    }
    for (const m of src.matchAll(/['`]settings:([\w-]+)['`]/g)) assert.ok(ids.has(m[1]), `${f}: settings:${m[1]}`);
  }
  assert.ok(n > 20, `${n} openSettings calls`);
  for (const m of readFileSync(join(ROOT, 'src', 'checklist.ts'), 'utf8').matchAll(/open: 'settings:([\w-]+)'/g)) assert.ok(ids.has(m[1]), `checklist: ${m[1]}`);
  const tours = app.slice(app.indexOf('function makeTours'), app.indexOf('function runTour'));
  for (const m of tours.matchAll(/(?:settingsAt\('|data-page=\\?")([\w-]+)/g)) assert.ok(ids.has(m[1]), `tour: ${m[1]}`);
  // The first tour's step on Settings → Her still points at the same button.
  assert.match(tours, /sel: '#settings-nav-list \[data-page="her-character"\]'/);
});

// ---------- search (N30) ----------
const howto = JSON.parse(web('howto.json')) as Record<string, { q: string }[]>;
const was = /const SETTINGS_WAS = \{([\s\S]*?)\n\};/.exec(app)![1];
const wasOf = (id: string) => [...was.matchAll(/(\w+): \[([^\]]+)\]/g)].find((m) => m[2].includes(`'${id}'`) && sections.find((s) => s.id === id)?.group !== m[1])?.[1] ?? '';
const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ');
const tips = JSON.parse(web('tips.json')) as { pages: Record<string, [string, string]> };
const F = search.foldText as (s: string) => string;
/** The same record the app builds from the live page (title, group, old group, keywords, questions, labels and tips, text). */
const records = ORDER.filter((id) => !['ab-recipes', 'account', 'desktop-app'].includes(id)).map((id) => {
  const s = sections.find((x) => x.id === id)!;
  const head = [s.title, s.group, tips.pages[id]?.[0] ?? ''];
  for (const m of s.body.matchAll(/<(h3|h4|label|legend|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) head.push(strip(m[2]));
  for (const m of s.body.matchAll(/(?:data-tip|aria-label|placeholder)="([^"]*)"/g)) head.push(m[1]);
  return { id, title: F(s.title), group: F(s.group), was: F(wasOf(id)), keywords: (search.SETTINGS_KEYWORDS[id] ?? []).map(F), questions: (howto[id] ?? []).map((q) => F(q.q)), head: F(head.join(' ')), body: F(strip(s.body)) };
});
const commands = APP_MENU.map((c) => ({ name: c.name, line: DESCRIPTIONS[c.name] }));

test('128b.3 N30: search returns the expected first page for 30 terms; routine and compact land in Elsewhere', () => {
  const first: [string, string | string[]][] = [
    ['whatsapp', 'co-whatsapp'],
    ['matrix', 'co-matrix'],
    ['imessage', 'co-imessage'],
    ['signal', 'co-signal'],
    ['telegram', 'co-telegram'],
    ['tailscale', ['co-whatsapp', 'co-matrix']],
    ['funnel', ['co-whatsapp', 'co-matrix']],
    ['@', 'ab-precise'],
    ['@file', 'ab-precise'],
    ['takedown', 'ab-store'],
    ['hey sara', 'her-hey'],
    ['wake word', 'her-hey'],
    ['push to talk', 'her-hey'],
    ['store', 'ab-store'],
    ['get more', 'ab-store'],
    ['share her', 'her-companions'],
    ['character card', 'her-companions'],
    ['companion packs', 'her-companions'],
    ['keep going', 'ab-persist'],
    ['goal', 'ab-persist'],
    ['when it comes up', 'ab-when'],
    ['pick up', 'co-pickup'],
    ['check her edits', 'ab-precise'],
    ['short tool list', 'ab-tools'],
    ['tidy long chats', 'models-default'],
    ['safety check-up', 'dh-safety'],
    ['cpanel', 'ab-ssh'],
    ['signal-cli', 'co-signal'],
    ['bluebubbles', 'co-imessage'],
    ['botfather', 'co-telegram'],
  ];
  assert.equal(first.length, 30);
  // EC1: Slack is found by its name (an extra term, outside the original 30).
  first.push(['slack', 'co-slack']);
  // EC7: Microsoft Teams too.
  first.push(['teams', 'co-teams']);
  for (const [q, want] of first) {
    const got = search.rankPages(q, records).map((r: Any) => r.id);
    const top = Array.isArray(want) ? got.slice(0, want.length).sort() : got[0];
    assert.deepEqual(top, Array.isArray(want) ? [...want].sort() : want, `“${q}” → ${got.slice(0, 4).join(', ')}`);
  }
  // Single symbols are search words (they were dropped before 2.61.1).
  assert.deepEqual(search.searchWords('@'), ['@']);
  // Elsewhere: routine → Planner → Routines; compact → /compact (first in each list).
  assert.equal(search.rankElsewhere('routine', commands)[0].id, 'planner:routines');
  assert.deepEqual(search.rankElsewhere('routine', commands)[0].label, ['Planner', 'Routines']);
  assert.equal(search.rankElsewhere('compact', commands)[0].id, 'command:compact');
  assert.equal(search.rankElsewhere('/goal', commands)[0].id, 'command:goal');
  assert.equal(search.rankElsewhere('repeats', commands)[0].id, 'planner:repeats');
  assert.deepEqual(search.rankElsewhere('whatsapp', commands), []);
  // Q2: the old group names still find their pages for one release (\"moved to …\").
  const abilities = search.rankPages('abilities', records).map((r: Any) => r.id);
  for (const id of ['ab-store', 'ab-tools', 'ab-ssh', 'ab-when']) assert.ok(abilities.includes(id), `abilities → ${id}`);
  assert.ok(search.rankPages('connections', records).some((r: Any) => r.id === 'co-whatsapp'));
  assert.match(app, /t\('Some \{old\} pages moved in 2\.61\.1, to \{groups\}\.'/);
  // Every page added since 2.48 is found first by its own title.
  for (const id of ['co-signal', 'co-email', 'ab-persist', 'ab-when', 'co-pickup', 'ab-precise', 'dh-safety', 'co-whatsapp', 'co-matrix', 'co-imessage', 'co-slack', 'co-teams', 'ab-store', 'her-hey']) {
    const title = sections.find((s) => s.id === id)!.title;
    assert.equal(search.rankPages(title, records)[0].id, id, `${title}`);
  }
  // The Settings window and Ctrl+K share the index.
  assert.match(app, /return rankPages\(q, pages\.map\(\(p\) => settingsRecord\(p, headOf, bodyOf\)\)\)\.map\(\(r\) => r\.p\);/);
  assert.match(app, /const tiered = matchSettings\(q, pages\)/);
  assert.match(app, /const elsewhere = rankElsewhere\(q,/);
  assert.match(html, /<div id="settings-elsewhere" class="settings-elsewhere" aria-live="polite" hidden><\/div>/);
});

// ---------- the / menu (N19, Q5) ----------
test('128b.4 N19: the / menu opens on / at position 0 only, owner-only commands only for the owner, own-chat commands only in own chats', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const sara = makeApp(dir, { now: new Date('2026-11-02T12:00:00Z') });
    const owner = appMenu(sara as Any, { member: false });
    const member = appMenu(sara as Any, { member: true });
    assert.deepEqual(owner.map((c) => c.name), APP_MENU.map((c) => c.name));
    for (const n of ['goal', 'loop', 'model', 'remember', 'when', 'continue', 'problems', 'compact', 'tools']) assert.ok(!member.some((c) => c.name === n), `member: no /${n}`);
    for (const n of ['new', 'stop', 'status', 'help']) assert.ok(member.some((c) => c.name === n), `member: /${n}`);
    // The menu only opens on / as the first character, until the first space.
    const own = { own: true, offRecord: false };
    assert.equal(slash.slashRows('hello /', owner, own), null);
    assert.equal(slash.slashRows(' /', owner, own), null);
    assert.equal(slash.slashRows('/goal ', owner, own), null);
    assert.equal(slash.slashRows('/', owner, null), null, 'no chat (demo, editing): no menu');
    assert.equal(slash.slashRows('/', owner, own).length, owner.length);
    assert.deepEqual(slash.slashRows('/co', owner, own).map((c: Any) => c.name), ['compact', 'continue']);
    assert.deepEqual(slash.slashRows('/tidy', owner, own).map((c: Any) => c.name), ['compact'], 'words of the line match too');
    // Group, partner and off-the-record chats: only what works there.
    const shared = slash.slashRows('/', owner, { own: false, offRecord: false }).map((c: Any) => c.name);
    for (const n of ['goal', 'loop', 'compact', 'remember', 'model']) assert.ok(!shared.includes(n), `shared chat: no /${n}`);
    assert.ok(shared.includes('stop') && shared.includes('new'));
    // The household route list lets a member read their short list.
    assert.ok(MEMBER_ROUTES.has('chat-menu'));
    assert.match(readFileSync(join(ROOT, 'src', 'routes', 'admin.ts'), 'utf8'), /a === 'chat-menu' && !b && method === 'GET'\) return send\(res, 200, \{ commands: appMenu\(app, \{ member: Boolean\(opts\.member\) \}\) \}\)/);
    sara.store.close?.();
  } finally {
    cleanup();
  }
  // Keyboard and touch: ↑ ↓ Enter Tab Escape, a listbox with aria-activedescendant, 44 px rows, a ?.
  const js = web('slash.js');
  for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) assert.ok(js.includes(`'${k}'`), k);
  assert.match(js, /setAttribute\('aria-activedescendant', `slash-opt-\$\{active\}`\)/);
  assert.match(js, /li\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\);\n\s*li\.addEventListener\('click', \(\) => pick\(it\)\);/);
  assert.match(html, /<ul id="slash-list" class="slash-list" role="listbox" aria-label="Commands"><\/ul>/);
  assert.match(html, /id="slash-tip" type="button" class="tip" data-tip="Type \/ at the start of the message box/);
  assert.match(web('refs.css'), /\.ref-item \{[^}]*min-height: 44px/);
  assert.match(app, /initSlash\(\{/);
});

test('128b.5 one command list: the / menu, the Telegram and Discord menus and the guide table cannot drift', () => {
  for (const c of APP_MENU) assert.ok(isCommandName(c.name), c.name);
  const names = APP_MENU.map((c) => c.name);
  // Every command in the owner's Telegram menu is in the app's (except /settings: \"where her settings are\" is the app).
  const tg = /const full: CommandName\[\] = \[([^\]]+)\]/.exec(readFileSync(join(ROOT, 'src', 'bridges', 'telegram.ts'), 'utf8'))![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1));
  for (const n of tg.filter((x) => x !== 'settings')) assert.ok(names.includes(n as Any), `Telegram /${n} is in the / menu`);
  for (const n of MENU_COMMANDS) assert.ok(names.includes(n), `Discord /${n} is in the / menu`);
  // The menu's lines are the chat apps' lines (DESCRIPTIONS), and docs/CHATS.md's table is generated from them.
  const chats = readFileSync(join(ROOT, 'docs', 'CHATS.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(withAppMenuTable(chats), chats, 'run node scripts/gen-guide.ts');
  for (const c of APP_MENU) assert.ok(appMenuTable().includes(`| \`/${c.name}\` | ${DESCRIPTIONS[c.name]} |`), c.name);
  // Every command in the menu runs in the app: the server's commands, the busy ones, and /goal and /loop as cards.
  const run = /const CHAT_COMMAND = \/\^\\\/\(([^)]+)\)/.exec(app)![1].split('|');
  const busy = /\^\\\/\(([^)]+)\)/.exec(web('busy.js'))![1].split('|');
  for (const n of names) assert.ok(run.includes(n) || busy.includes(n) || n === 'goal' || n === 'loop', `/${n} runs in the app`);
  assert.match(app, /persistCmd\[1\]\.toLowerCase\(\) === 'goal' \? openGoalCard\(/);
});

// ---------- N20, N16, N25, N27 ----------
test('128b.6 N20: @ in a new chat (no conversation yet) opens the menu; the conversation is made when a reference needs it; one hint where @ cannot work', () => {
  // Checked live with Edge and real key events (outputs/ui-review/pl2b): fresh data, no conversation,
  // typing @ showed nothing; place() returned null without a conversation.
  assert.match(app, /if \(!conv\) return \{ workspace: true, url: true \};/);
  assert.match(app, /ensure: \(\) => ensureConversation\(\),/);
  const refs = web('refs.js');
  assert.match(refs, /if \(!ctx\.state\.currentId && ctx\.ensure\) await ctx\.ensure\(\)\.catch\(\(\) => null\);/);
  assert.match(refs, /const why = token\.text === '@' \? ctx\.hint\?\.\(\) : '';/);
  assert.match(refs, /note\.setAttribute\('role', 'presentation'\);/);
});

test('128b.7 N16 Share her on the row and the Store link; N25 Tidy this chat from 70%; the coding tour stop; sw v70', () => {
  const packs = web('packs.js');
  assert.match(packs, /if \(!o\.member\) li\.append\(' ', btn\(t\('Share her'\), 'ghost small pkp-share', \(\) => void openShare\(id\)\)\);/);
  assert.doesNotMatch(packs, /items\.append\(btn\(t\('Share her'\)/, 'not inside ⋯ any more');
  assert.match(html, /<button id="cmp-store" type="button" class="ghost" data-owner-only>Get a companion from the Store<\/button>/);
  assert.match(app, /\$\('#cmp-store'\)\.addEventListener\('click', \(\) => showSettingsTab\('ab-store', \{ focus: true \}\)\);/);
  const panel = web('her-panel.js');
  const offered = new Function(`return ${/export const tidyOffered = (\(pct\) => [^;]+);/.exec(panel)![1]}`)() as (p: unknown) => boolean;
  assert.equal(offered('69'), false);
  assert.equal(offered('70'), true);
  assert.equal(offered(85), true);
  assert.match(html, /<button id="hp-ctx-tidy" type="button" class="ghost small hp-ctx-tidy" hidden>Tidy this chat<\/button>/);
  assert.match(panel, /tidy\.addEventListener\('click', \(\) => src\.click\(\)\);/);
  // One new stop in the coding tour; its selector is on the page.
  const coding = app.slice(app.indexOf('  coding: ['), app.indexOf('  studio: ['));
  assert.match(coding, /sel: '#input', title: t\('Type \/ for commands'\)/);
  assert.match(html, /<textarea id="input"/);
  const sw = web('sw.js');
  // PL2c (2.61.2) moved the cache on to v71; the PL2b history line stays.
  assert.ok(Number(/event\.waitUntil\(caches\.open\('sara-shell-v(\d+)'\)/.exec(sw)?.[1]) >= 70);
  assert.match(sw, /v70 \(PL2b, 2\.61\.1\)/);
  assert.match(sw, /sara-shell-v69 from 2\.61\.0/);
});

test('128b.8 the guide index groups pages by the new table (generated; HOW_DO_I.md and help.html agree)', () => {
  const titles = pageTitles(html);
  const heads = howtoSections(howto as unknown as HowtoData, titles).slice(1).map((s) => s.heading);
  assert.deepEqual(heads, GROUPS);
  const md = readFileSync(join(ROOT, 'docs', 'HOW_DO_I.md'), 'utf8');
  for (const g of ['Chat apps', 'Add-ons', 'Coding']) assert.ok(md.includes(`## Settings → ${g}`), g);
  assert.ok(!md.includes('## Settings → Abilities'));
});
