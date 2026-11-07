// Phase 128 slice PL2d (2.61.3, docs/design/POLISH2.md §5 PL2d): docs and the code debt. The README
// status line and START_HERE's answer count follow package.json and web/howto.json; the guide's new
// sections (Commands you can type, Long chats and /compact, Routines) resolve; every copy of the
// plugin SDK files is byte-equal to its source (C4: 15 sara-plugin.mjs, 3 http1.mjs, 4 pace.mjs, one
// pace file with per-app limits, Q8); the C1 split of web/app.js into settings-nav.js, tours.js and
// setup-wizard.js moved code only; the guide's Settings paths use the 8 groups.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SDK_SOURCES, sdkCopies, sha256 } from '../scripts/sdk-sync.ts';
import { ROOT } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const web = (f: string) => read('web', f);
const help = web('help.html');
const howto = JSON.parse(web('howto.json')) as Record<string, { q: string }[]>;
const MODULES = ['settings-nav.js', 'tours.js', 'setup-wizard.js'];

// The release step writes the README status line from package.json's version.
test('128d.1 N35: the README status line is package.json\'s version', () => {
  assert.match(read('README.md'), new RegExp(`> \\*\\*Status:\\*\\* ${PKG_VERSION.replaceAll('.', '\\.')}[,\\s]`));
});

test('128d.2 N37: START_HERE\'s answer count is the number of questions in web/howto.json (written by scripts/gen-guide.ts)', () => {
  const n = Object.values(howto).reduce((sum, qs) => sum + qs.length, 0);
  const m = /All (\d+)\s+answers/.exec(read('docs', 'START_HERE.md'));
  assert.ok(m, 'START_HERE says how many answers there are');
  assert.equal(Number(m![1]), n);
  assert.match(read('docs', 'HOW_DO_I.md'), new RegExp(`${n}|How do I`), 'HOW_DO_I.md is generated from the same file');
});

test('128d.3 N38: the new guide sections resolve to unique ids, and every # link in the guide resolves to exactly one id', () => {
  const ids = [...help.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const count = (id: string) => ids.filter((x) => x === id).length;
  for (const id of ['slash', 'compact', 'routines']) {
    assert.equal(count(id), 1, `#${id} once`);
    assert.ok(help.includes(`<a href="#${id}">`), `the menu links to #${id}`);
  }
  for (const m of help.matchAll(/href="#([^"]+)"/g)) assert.equal(count(m[1]), 1, `#${m[1]}`);
  // The sections say what the app does: the / menu, /compact and Planner → Routines.
  const section = (id: string) => help.slice(help.indexOf(`<h2 id="${id}">`), help.indexOf('<h2', help.indexOf(`<h2 id="${id}">`) + 4));
  assert.match(section('slash'), /<code>\/goal<\/code>[^]*<code>\/compact<\/code>[^]*Esc closes the list/);
  assert.match(section('compact'), /Tidy this chat[^]*Undo[^]*nothing is deleted/);
  assert.match(section('routines'), /Planner → Routines[^]*Turn on/);
  // How do I…? has the / menu and routines (and /compact), so HOW_DO_I.md lists them.
  assert.ok(howto.chat.some((x) => /\/ commands/.test(x.q)));
  assert.ok(howto.today.some((x) => /routine/.test(x.q)));
  assert.ok(howto['models-default'].some((x) => /tidy a long chat/.test(x.q)));
  for (const [page, qs] of Object.entries(howto)) assert.ok(qs.length >= 2 && qs.length <= 4, `${page}: 2–4 questions`);
});

test('128d.4 C4: every sara-plugin.mjs, http1.mjs and pace.mjs (outside node_modules and outputs) has its source\'s hash', () => {
  const copies = sdkCopies();
  assert.equal(copies['sara-plugin.mjs'].length, 55 /* EC1: + plugins/slack */, copies['sara-plugin.mjs'].join(', '));
  assert.deepEqual(copies['sara-job.mjs'], ['src/plugins/sara-job.mjs', 'store/plugins/documentation-doctor/sara-job.mjs', 'store/plugins/flaky-test-lab/sara-job.mjs', 'store/plugins/release-readiness/sara-job.mjs', 'store/plugins/repository-onboarding/sara-job.mjs', 'store/plugins/test-doctor/sara-job.mjs']);
  for (const id of ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard']) {
    assert.ok(copies['sara-plugin.mjs'].includes(`store/plugins/${id}/sara-plugin.mjs`), `${id}: standalone SDK remains hash-checked`);
  }
  assert.ok(copies['sara-plugin.mjs'].includes('plugins/whatsapp/sara-plugin.mjs') && copies['sara-plugin.mjs'].includes('store/plugins/focus/sara-plugin.mjs'));
  for (const id of ['api-contract-guard', 'secret-scanner', 'license-auditor', 'sbom-builder', 'artifact-provenance-verifier', 'coverage-explorer', 'log-explorer', 'incident-workbench', 'environment-config-doctor', 'database-fixture-studio', 'data-contract-validator', 'change-impact-analyzer', 'architecture-guard', 'sql-migration-reviewer', 'visual-regression', 'localization-qa', 'accessibility-auditor', 'build-cache-inspector', 'http-webhook-workbench',
    'performance-regression-lab', 'code-migration-studio', 'build-reproducibility-inspector', 'test-doctor', 'flaky-test-lab', 'documentation-doctor', 'release-readiness', 'repository-onboarding']) {
    assert.ok(copies['sara-plugin.mjs'].includes(`store/plugins/${id}/sara-plugin.mjs`), `${id}: developer candidate SDK remains hash-checked`);
  }
  assert.deepEqual(copies['http1.mjs'], ['plugins/imessage/http1.mjs', 'plugins/matrix/http1.mjs', 'plugins/slack/http1.mjs', 'plugins/whatsapp/http1.mjs']);
  assert.deepEqual(copies['pace.mjs'], ['plugins/imessage/pace.mjs', 'plugins/matrix/pace.mjs', 'plugins/signal/pace.mjs', 'plugins/slack/pace.mjs', 'plugins/whatsapp/pace.mjs']);
  for (const [name, list] of Object.entries(copies)) {
    const want = sha256(join(ROOT, SDK_SOURCES[name]));
    for (const c of list) assert.equal(sha256(join(ROOT, c)), want, `${c} differs from ${SDK_SOURCES[name]}: run node scripts/sdk-sync.ts`);
  }
});

test('128d.5 Q8: one pace.mjs keeps each app\'s numbers from before the merge', async () => {
  const { LIMITS, pacing } = await import(pathToFileURL(join(ROOT, 'plugins', 'whatsapp', 'pace.mjs')).href);
  const pick = (app: string, ...k: string[]) => k.map((x) => pacing(app)[x]);
  assert.deepEqual(pick('whatsapp', 'EVERY_MS', 'BURST', 'PER_HOUR', 'PER_DAY', 'MAX_BACKOFF_MS'), [6_000, 5, 200, 1_000, 300_000]);
  assert.deepEqual(pick('matrix', 'EVERY_MS', 'BURST', 'PER_HOUR', 'PER_DAY', 'DEFAULT_RETRY_MS', 'MAX_RETRY_MS', 'TYPING_EVERY_MS'), [1_000, 5, 600, 3_000, 5_000, 300_000, 25_000]);
  assert.deepEqual(pick('imessage', 'EVERY_MS', 'BURST', 'PER_HOUR', 'PER_DAY', 'TYPING_EVERY_MS'), [2_000, 4, 150, 600, 20_000]);
  assert.deepEqual(pick('signal', 'PER_CHAT_GAP_MS', 'GROUP_PER_MINUTE', 'PER_HOUR', 'PER_DAY', 'REPLY_WINDOW_MS', 'PAUSE_CHAT_MS', 'PAUSE_ALL_MS'), [1_000, 20, 60, 400, 86_400_000, 3_600_000, 21_600_000]);
  assert.deepEqual(Object.keys(LIMITS).sort(), ['imessage', 'matrix', 'signal', 'slack', 'whatsapp']);
  // Each plugin asks for its own app's pace.
  for (const app of ['whatsapp', 'matrix', 'imessage', 'signal', 'slack']) assert.match(read('plugins', app, 'main.mjs'), new RegExp(`= pacing\\('${app}'\\);`));
  // The caps still name the app, and the WhatsApp backoff still retries the same message (fake clock).
  const { Pacer, CapError } = pacing('whatsapp');
  let now = 0;
  const p = new Pacer({ now: () => now, sleep: async (ms: number) => void (now += ms) });
  let tries = 0;
  assert.equal(await p.send('a', async () => (++tries < 3 ? Promise.reject(Object.assign(new Error('rate'), { rate: true })) : 'ok'), (e: { rate?: boolean }) => Boolean(e.rate)), 'ok');
  assert.equal(tries, 3);
  assert.equal(new CapError('daily', 'WhatsApp').message, 'over the daily cap of WhatsApp sends');
  // iMessage never retries by itself (its main.mjs tries once more after 10 s).
  const im = new (pacing('imessage').Pacer)({ now: () => now, sleep: async (ms: number) => void (now += ms) });
  let imTries = 0;
  await assert.rejects(() => im.send('b', async () => {
    imTries++;
    throw new Error('down');
  }), /down/);
  assert.equal(imTries, 1);
});

/** The t('…') keys and the #ids in quoted strings of a file (the same extraction as the fixture). */
function keysIds(s: string): { keys: string[]; ids: string[] } {
  const keys = [...s.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  const ids = [...s.matchAll(/(['"`])((?:\\.|(?!\1)[^\n])*)\1/g)].flatMap((m) => [...m[2].matchAll(/#([A-Za-z][\w-]*)/g)].map((h) => h[1]));
  return { keys: keys.sort(), ids: ids.sort() };
}

test('128d.6 C1: the split moved code only: the modules\' keys and ids equal the baseline taken at the move; nothing is defined twice', () => {
  // test/fixtures/pl2d-split.json was written right after the move (and the whole web app's sorted
  // keys and ids were checked equal before and after it). Change it only when you change these
  // modules on purpose.
  const base = JSON.parse(read('test', 'fixtures', 'pl2d-split.json')) as Record<string, { keys: string[]; ids: string[] }>;
  for (const f of MODULES) assert.deepEqual(keysIds(web(f)), base[f], f);
  const app = web('app.js');
  const moved: Record<string, string[]> = {
    'settings-nav.js': ['OLD_TABS', 'settingsPages', 'SETTINGS_GROUPS', 'SETTINGS_WAS', 'SETTINGS_ORDER', 'setGroupOpen', 'buildSettingsNav', 'openGroupOf', 'clearSettingsSearch', 'settingsRecord', 'matchSettings', 'restoreSettingsOrder', 'paintElsewhere'],
    'tours.js': ['closeOpenDialogs', 'settingsAt', 'makeTours', 'runTour', 'tourFromHash', 'offerFirstTour', 'queueTourOffer'],
    'setup-wizard.js': ['su', 'suShow', 'suPathCards', 'suWho', 'suPing', 'openSetup', 'suConnect', 'suggestModel', 'suFinish'],
  };
  const defines = (src: string, n: string) => new RegExp(`^(?:export )?(?:async function|function|const|let) ${n}\\b`, 'm').test(src);
  for (const [f, names] of Object.entries(moved)) {
    for (const n of names) {
      assert.ok(defines(web(f), n), `${f} defines ${n}`);
      assert.ok(!defines(app, n), `app.js no longer defines ${n}`);
    }
  }
  // app.js wires them where the code used to be, in the same order.
  const at = (s: string) => app.indexOf(s);
  assert.ok(at('initSettingsNav({') > 0 && at('initSettingsNav({') < at('\nbuildSettingsNav();'), 'set up before the top-level build of the list');
  assert.ok(at("window.addEventListener('hashchange', openViewFromHash);") < at('initTours({') && at('initTours({') < at("window.addEventListener('hashchange', reportFromHash);"));
  assert.ok(at('initSetupWizard({') > at('initTours({'));
  // Every id the modules use is still on the page, and every key is translated (i18n test).
  const html = web('index.html');
  for (const f of MODULES) for (const id of new Set(keysIds(web(f)).ids)) assert.ok(html.includes(`id="${id}"`) || ['settings-nav-list'].includes(id), `${f}: #${id} on the page`);
});

test('128d.7 the Settings paths in the guide and the app use the 8 groups (no "Abilities →" or a chat app under "Connections →")', () => {
  const chatApps = ['Telegram', 'Discord', 'Signal', 'Email', 'WhatsApp', 'Matrix', 'iMessage', 'Pick up across apps'];
  const files = ['help.html', 'index.html', 'tips.json', 'howto.json', ...MODULES, 'app.js', 'store.js', 'packs.js', 'movein.js', 'persist.js', 'refs.js', 'lean.js', 'ssh.js', 'skills.js', 'plugins.js', 'pickup.js'];
  for (const f of files) {
    const s = web(f);
    assert.doesNotMatch(s, /Abilities\s*(?:→|&rarr;)/, `${f}: "Abilities →"`);
    for (const a of chatApps) assert.ok(!new RegExp(`Connections\\s*(?:→|&rarr;)\\s*${a}\\b`).test(s), `${f}: Connections → ${a}`);
  }
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${l}.json`)) as Record<string, string>;
    assert.equal(Object.keys(d).filter((k) => /Abilities\s*(?:→|&rarr;)/.test(k)).length, 0, `${l}: no old key left`);
  }
  // The one-release search alias for the old names is still there (docs/design/POLISH2.md Q2).
  assert.match(web('settings-nav.js'), /const SETTINGS_WAS = \{/);
});
