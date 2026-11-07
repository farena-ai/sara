// EC3 (docs/ops/EC3_DESIGN.md §7): the Monitoring section under Settings → Data & health → Operations,
// the sample Grafana dashboard, and the scrape config.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { scrapeConfig } from '../src/routes/telemetry.ts';
import { ROOT } from './helpers.ts';

const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');

test('the Monitoring section sits on the Operations page, owner only, hidden until loaded, no inline styles', () => {
  const page = /<section class="settings-page" data-page="dh-operations"[^>]*>([\s\S]*?)<\/section>/.exec(html)!;
  assert.match(page[0], /data-group="Data & health"/);
  assert.match(page[0], /data-owner-only/);
  const box = /<div id="mon-box"[^>]*>/.exec(page[1])!;
  assert.match(box[0], /\bhidden\b/);
  assert.match(box[0], /data-nodirty/);
  for (const id of ['mon-metrics', 'mon-allow', 'mon-token-new', 'mon-token-del', 'mon-scrape-copy', 'mon-dashboard', 'mon-traces', 'mon-endpoint', 'mon-sample', 'mon-headers', 'mon-headers-save', 'mon-test', 'mon-last']) assert.ok(page[1].includes(`id="${id}"`), id);
  assert.ok(!/style=/.test(page[1]));
  for (const m of page[1].matchAll(/data-tip="([^"]+)"/g)) assert.ok(m[1].length <= 260, m[1]);
  const js = readFileSync(join(ROOT, 'web', 'monitoring.js'), 'utf8');
  assert.ok(!/\.style\b|innerHTML/.test(js), 'no inline styles or HTML strings');
});

test('exportLine words the last export status without the collector\'s own text', async () => {
  // A web module in Node: its naming.js import becomes a small stand-in.
  const stub = String.raw`const t = (s, p = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));`;
  const src = readFileSync(join(ROOT, 'web', 'monitoring.js'), 'utf8').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub);
  const { exportLine } = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as { exportLine: (l: unknown, now: number) => string };
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(exportLine(null, now), 'Nothing sent yet.');
  assert.equal(exportLine({ at: '2026-11-07T11:58:00Z', ok: true, spans: 5 }, now), 'Last export worked: 5 spans, 2 min ago.');
  assert.equal(exportLine({ at: '2026-11-07T12:00:00Z', ok: false, spans: 1, error: 'timeout' }, now), 'Last export failed (timeout), just now.');
});

test('the scrape config points at /metrics with a bearer token file, and the dashboard reads only sara_ metrics', () => {
  const cfg = scrapeConfig('https://sara.example.test');
  assert.match(cfg, /metrics_path: \/metrics/);
  assert.match(cfg, /scheme: https/);
  assert.match(cfg, /credentials_file: /);
  assert.match(cfg, /targets: \['sara\.example\.test'\]/);
  const d = JSON.parse(readFileSync(join(ROOT, 'docs', 'monitoring', 'grafana-dashboard.json'), 'utf8'));
  assert.equal(d.uid, 'sara-overview');
  assert.ok(d.panels.length >= 10);
  const names = new Set<string>();
  for (const p of d.panels) for (const t of p.targets) for (const m of String(t.expr).matchAll(/\b(sara_[a-z_]+?)(?:_bucket)?\{/g)) names.add(m[1]);
  const metrics = readFileSync(join(ROOT, 'src', 'telemetry', 'metrics.ts'), 'utf8');
  for (const n of names) assert.ok(metrics.includes(`'${n}'`), `dashboard uses unknown metric ${n}`);
  assert.ok(names.has('sara_turns_total') && names.has('sara_model_call_duration_seconds'));
});
