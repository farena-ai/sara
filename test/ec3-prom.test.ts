// EC3 (docs/ops/EC3_DESIGN.md): the hand-rolled Prometheus registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry, safeLabel } from '../src/telemetry/prom.ts';

test('counters and gauges render HELP, TYPE and escaped labels in text format 0.0.4', () => {
  const r = new Registry();
  const c = r.counter('sara_demo_total', 'Demo counter.', ['outcome']);
  c.inc({ outcome: 'ok' });
  c.inc({ outcome: 'ok' }, 2);
  c.inc({ outcome: 'a"b\\c\nd' });
  const g = r.gauge('sara_demo_gauge', 'Demo gauge.');
  g.set({}, 4.5);
  const out = r.render();
  assert.match(out, /^# HELP sara_demo_total Demo counter\.\n# TYPE sara_demo_total counter\n/m);
  assert.match(out, /^sara_demo_total\{outcome="ok"\} 3$/m);
  assert.match(out, /^# TYPE sara_demo_gauge gauge\nsara_demo_gauge 4\.5$/m);
  // Unsafe characters never reach the output: labels are clipped to a safe alphabet.
  assert.ok(!out.includes('\n' + 'd"}'));
  assert.match(out, /sara_demo_total\{outcome="a_b_c_d"\} 1/);
  assert.ok(out.endsWith('\n'));
});

test('a counter refuses to go down and unknown labels are rejected', () => {
  const r = new Registry();
  const c = r.counter('sara_x_total', 'X.', ['kind']);
  assert.throws(() => c.inc({ kind: 'a' }, -1));
  assert.throws(() => c.inc({ other: 'a' } as never));
  assert.throws(() => r.counter('bad name', 'X.'));
});

test('histogram buckets are cumulative with sum, count and +Inf', () => {
  const r = new Registry();
  const h = r.histogram('sara_lat_seconds', 'Latency.', ['provider'], [0.1, 1, 10]);
  for (const v of [0.05, 0.1, 0.5, 2, 20]) h.observe({ provider: 'p' }, v);
  const out = r.render();
  assert.match(out, /^# TYPE sara_lat_seconds histogram$/m);
  assert.match(out, /^sara_lat_seconds_bucket\{provider="p",le="0\.1"\} 2$/m);
  assert.match(out, /^sara_lat_seconds_bucket\{provider="p",le="1"\} 3$/m);
  assert.match(out, /^sara_lat_seconds_bucket\{provider="p",le="10"\} 4$/m);
  assert.match(out, /^sara_lat_seconds_bucket\{provider="p",le="\+Inf"\} 5$/m);
  assert.match(out, /^sara_lat_seconds_sum\{provider="p"\} 22\.65$/m);
  assert.match(out, /^sara_lat_seconds_count\{provider="p"\} 5$/m);
  // Non-finite or negative observations are dropped, not rendered as NaN.
  h.observe({ provider: 'p' }, Number.NaN);
  h.observe({ provider: 'p' }, -1);
  assert.match(r.render(), /^sara_lat_seconds_count\{provider="p"\} 5$/m);
});

test('each metric caps its series; extra label sets fold into "other"', () => {
  const r = new Registry({ maxSeries: 3 });
  const c = r.counter('sara_cap_total', 'Cap.', ['model']);
  for (let i = 0; i < 10; i++) c.inc({ model: `m${i}` });
  const lines = r.render().split('\n').filter((l) => l.startsWith('sara_cap_total{'));
  assert.equal(lines.length, 3);
  assert.ok(lines.includes('sara_cap_total{model="other"} 8'));
});

test('safeLabel keeps ids and names, clips length and strips everything else', () => {
  assert.equal(safeLabel('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(safeLabel('mcp:files'), 'mcp:files');
  assert.equal(safeLabel('hello world, my secret'), 'hello_world__my_secret');
  assert.equal(safeLabel('x'.repeat(100)).length, 64);
  assert.equal(safeLabel(''), 'unknown');
});
