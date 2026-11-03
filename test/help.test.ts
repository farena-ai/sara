// Phase 41: help everywhere: every setting has a ? tip, the tips and tours point at real things,
// and she answers questions about her settings from her own guide, with links into the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error plain JS module shared with the browser
import { inline } from '../web/markdown.js';
import { tipCoverage } from '../scripts/tip-coverage.ts';
import { createSettingsGuideTool, guideEntries, searchGuide } from '../src/settingsguide.ts';

const WEB = join(import.meta.dirname, '..', 'web');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const help = readFileSync(join(WEB, 'help.html'), 'utf8');
const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => readFileSync(join(WEB, f), 'utf8')).join('\n');
const tips = JSON.parse(readFileSync(join(WEB, 'tips.json'), 'utf8')) as { tips: Record<string, [string, string]>; pages: Record<string, [string, string]> };
const anchors = new Set([...help.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

test('help: every setting has a ? tip (in the page or in tips.json)', () => {
  const r = tipCoverage(html, tips.tips);
  assert.ok(r.total > 200, `counted ${r.total} settings`);
  assert.deepEqual(r.uncovered, [], 'settings without a tip');
});

test('help: tips point at real controls and real guide sections; every page has a summary', () => {
  for (const [id, [text, guide]] of Object.entries(tips.tips)) {
    assert.ok(html.includes(`id="${id}"`), `tips.json: no control #${id}`);
    assert.ok(anchors.has(guide), `tips.json: #${id} links to a missing guide section "${guide}"`);
    assert.ok(text.length >= 15 && text.length <= 260, `#${id}: tip length ${text.length}`);
    assert.ok(!/<|>/.test(text), `#${id}: plain text`);
  }
  const pages = [...html.matchAll(/class="settings-page" data-page="([^"]+)"/g)].map((m) => m[1]);
  for (const p of pages) {
    assert.ok(tips.pages[p], `page ${p} has no summary`);
    assert.ok(anchors.has(tips.pages[p][1]), `page ${p}: guide section ${tips.pages[p][1]} missing`);
  }
  // In-page tips are plain text too.
  for (const m of html.matchAll(/class="tip" data-tip="([^"]*)"/g)) assert.ok(m[1].length >= 15, `short tip: ${m[1]}`);
});

test('help: every tour step points at something on the page', () => {
  const block = app.slice(app.indexOf('function makeTours'), app.indexOf('function runTour'));
  const sels = [...block.matchAll(/sel: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(sels.length >= 20, `${sels.length} steps`);
  for (const s of sels) {
    const id = /^#([\w-]+)/.exec(s)?.[1];
    assert.ok(id && html.includes(`id="${id}"`), `tour step ${s}: not in index.html`);
    const page = /data-page="([\w-]+)"/.exec(s)?.[1];
    if (page) assert.ok(html.includes(`data-page="${page}"`), `tour step ${s}: no such page`);
  }
  for (const name of ['first', 'studio', 'models', 'team']) {
    assert.match(block, new RegExp(`\\b${name}: \\[`), `tour ${name}`);
    assert.ok(html.includes(`data-tour="${name}"`), `Help window offers the ${name} tour`);
  }
});

test('ask her: answers come from her own guide, with links into the app', () => {
  const entries = guideEntries();
  assert.ok(entries.length > 250, `${entries.length} entries`);
  const top = (q: string, n = 3) => searchGuide(q, n).map((e) => `${e.title} ${e.link}`);
  assert.match(top('what does jealousy do?', 1)[0], /Jealousy dial .*#view=settings:her-relationship/);
  const pics = top('which model should I use for pictures?').join('\n');
  assert.match(pics, /Looking at pictures.*models-routes/, 'the vision job');
  assert.match(pics, /her-pictures/, 'and pictures from her');
  assert.match(top('how do I connect Telegram?', 1)[0], /co-telegram/);
  assert.match(top('how do backups work', 2).join('\n'), /dh-backups/);
  assert.match(top('show me around', 1)[0], /#tour=first/);
  assert.match(top('can she call me', 3).join('\n'), /her-calls/);
  // Adult mode only comes up when asked about.
  for (const q of ['what is private mode', 'how do I turn things on', 'what can I change about her']) assert.ok(!top(q, 5).some((x) => /adult/i.test(x)), q);
  assert.match(top('how do I turn on adult mode', 2).join('\n'), /you-adult/);
  // Labels are clean words, no markup.
  for (const e of entries) assert.ok(!/[<>]|id="/.test(e.title), `title: ${e.title}`);
});

test('ask her: the settings_guide tool answers with page links; in-app links render, others stay out', async () => {
  const tool = createSettingsGuideTool();
  assert.equal(tool.defaultPermission, 'auto');
  const out = await tool.run({ question: 'what does jealousy do?' }, {} as never);
  assert.match(String(out), /Jealousy dial/);
  assert.match(String(out), /Link: \[Open Relationship\]\(\/#view=settings:her-relationship\)/);
  assert.match(String(await tool.run({ question: 'zzzz qqqq' }, {} as never)), /Nothing in the settings guide matches/);
  const link = (s: string) => (inline(s) as { t: string; href?: string }[]).find((n) => n.t === 'a')?.href;
  assert.equal(link('[Open it](/#view=settings:her-relationship)'), '/#view=settings:her-relationship');
  assert.equal(link('[Tour](/#tour=studio)'), '/#tour=studio');
  assert.equal(link('[Guide](/help#voice)'), '/help#voice');
  assert.equal(link('[Open](/ #view=settings:co-telegram)'), '/#view=settings:co-telegram', 'a stray space is dropped');
  assert.equal(link('[x](javascript:alert(1))'), undefined);
  assert.equal(link('[x](/api/settings)'), undefined);
  assert.equal(link('[x](//evil.example/#view=x)'), undefined);
});
