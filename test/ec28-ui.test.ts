// EC28 (docs/ops/EC1828_DESIGN.md): the readiness half of Settings → Data & health → Readiness and
// recovery: owner only, hidden until loaded, no inline styles, short tips, and the page's words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readinessReport } from '../src/readiness.ts';
import { ROOT } from './helpers.ts';

const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'web', 'readiness.js'), 'utf8');

async function load() {
  const stub = String.raw`const t = (s, p = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));`;
  const src = js.replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub);
  return (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as {
    areaLine: (a: unknown) => string;
    verdictLine: (r: unknown) => string;
    drillLine: (d: unknown) => string;
    TITLES: Record<string, () => string>;
  };
}

test('EC28 the readiness box sits on the Recovery page (renamed), owner only, hidden until loaded, no inline styles', () => {
  const page = /<section class="settings-page" data-page="dh-recovery"[^>]*>([\s\S]*?)<\/section>/.exec(html)!;
  assert.match(page[0], /data-group="Data & health"/);
  assert.match(page[0], /data-title="Readiness and recovery"/);
  assert.match(page[0], /data-owner-only/);
  const box = /<div id="rd-box"[^>]*>/.exec(page[1])!;
  assert.match(box[0], /\bhidden\b/);
  for (const id of ['rd-again', 'rd-status', 'rd-verdict', 'rd-list', 'rd-drill', 'rd-drill-status', 'rd-drill-last', 'recovery-content']) assert.ok(page[1].includes(`id="${id}"`), id);
  assert.ok(page[1].indexOf('id="rd-box"') < page[1].indexOf('id="recovery-content"'), 'readiness first, interrupted work below');
  assert.ok(!/style=/.test(page[1]));
  for (const m of page[1].matchAll(/data-tip="([^"]+)"/g)) assert.ok(m[1].length <= 260, m[1]);
  assert.ok(!/\.style\b|innerHTML/.test(js), 'no inline styles or HTML strings');
  for (const m of js.matchAll(/t\('([^']+)'\)/g)) if (/^(Ready:|From the|Every chat|Interrupted)/.test(m[1])) assert.ok(m[1].length <= 260, m[1]);
});

test('EC28 every area and reason the rules can give has words and a title', async () => {
  const { areaLine, TITLES, verdictLine } = await load();
  const now = new Date('2026-11-07T12:00:00Z');
  const base = {
    backups: { count: 0, newestAt: null, newestName: null, auto: true }, drill: undefined, offsiteTest: undefined, diskFreeBytes: null,
    model: { configured: false }, bridges: [], paused: { jobs: 1, teams: 0, deliveries: 0 }, safety: {}, audit: { present: false, ok: false }, metrics: false,
  };
  const r = readinessReport(base as never, now);
  for (const a of r.areas) {
    assert.ok(TITLES[a.id], a.id);
    const line = areaLine(a);
    assert.ok(line && !line.includes('{'), `${a.id}:${a.reason} → ${line}`);
    if (a.reason !== 'unknown') assert.notEqual(line, "The safety check-up couldn't run.", `${a.id}:${a.reason} has its own words`);
  }
  assert.equal(verdictLine(r), `Not ready yet: ${r.counts['not-ready']} thing(s) to fix first.`);
  assert.equal(areaLine({ id: 'updates', reason: 'safety', line: 'Version 9 is out' }), 'Version 9 is out');
});

test('EC28 the last drill in words: measured time, counts and data loss; a failure says why', async () => {
  const { drillLine } = await load();
  assert.equal(drillLine(null), 'No restore drill has run yet.');
  const ok = drillLine({ at: '2026-11-07T12:00:00Z', ok: true, backup: 'sara-auto.tar.gz', restoreMs: 1200, bootMs: 4300, totalMs: 5600, dataLossHours: 6.5, counts: { conversations: 3, messages: 40, memories: 7 }, databases: 2, vaultEntries: 4 });
  assert.match(ok, /sara-auto\.tar\.gz restored in 1\.2 s and started in 4\.3 s \(5\.6 s in all\)\. 3 chats, 40 messages, 7 memories, 2 database\(s\), 4 vault entries\. Restoring it now would lose 6\.5 h\./);
  assert.match(drillLine({ at: '2026-11-07T12:00:00Z', ok: false, error: 'The database is damaged.' }), /failed\. The database is damaged\./);
});
