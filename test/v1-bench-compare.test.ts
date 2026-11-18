// V1.4 Open benchmark page: the same original repository tasks (bench/) run through other agent
// harnesses the user installed themselves, one rerun command, and a static results page.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadTasks } from '../scripts/bench-tasks.ts';
import {
  buildPage,
  compareSummary,
  fill,
  findOnPath,
  loadHarnesses,
  PRESETS,
  runHarness,
  selfTest,
  validHarness,
  type Harness,
} from '../scripts/bench-compare.ts';

const ROOT = join(import.meta.dirname, '..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const jsTask = () => loadTasks().find((t) => t.lang === 'js')!;
// A fake harness: a plain Node script that "does the task" by laying the reference solution over its
// working folder (or does nothing). It stands in for someone's installed agent CLI.
const FAKE = join(ROOT, 'scripts', 'bench-fake-harness.ts');
const fake = (how: 'solve' | 'nothing' | 'hang'): Harness => ({ id: `fake-${how}`, label: `Fake (${how})`, internal: true, command: ['{node}', FAKE, how, '{workspace}', '{solution}', '{promptFile}'] });

test('V1.4 presets are command lines only (no other harness code in the repo) and all valid', () => {
  assert.ok(PRESETS.length >= 3);
  for (const h of PRESETS) {
    assert.equal(validHarness(h), undefined, h.id);
    assert.ok(!h.internal, `${h.id} is a user CLI`);
    assert.ok(h.command.some((a) => /\{prompt(File)?\}/.test(a)) || h.stdin, `${h.id} gets the task text`);
  }
  assert.match(validHarness({ id: 'Bad Id', label: 'x', command: ['a'] }) ?? '', /id/);
  assert.match(validHarness({ id: 'ok', label: 'x', command: [] }) ?? '', /command/);
  assert.match(validHarness({ id: 'ok', label: 'x', command: ['a', 5 as unknown as string] }) ?? '', /command/);
});

test('V1.4 a user file adds and overrides harnesses; bad entries are reported, not run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v1bench-cfg-'));
  try {
    const f = join(dir, 'harnesses.json');
    writeFileSync(f, JSON.stringify([
      { id: 'my-agent', label: 'My agent', command: ['my-agent', '--task-file', '{promptFile}'], model: 'some-model' },
      { id: PRESETS[0].id, label: 'Renamed', command: ['x', '{promptFile}'] },
      { id: 'BAD', label: 'b', command: [] },
    ]));
    const { harnesses, problems } = loadHarnesses(f);
    assert.equal(harnesses.find((h) => h.id === 'my-agent')?.model, 'some-model');
    assert.equal(harnesses.find((h) => h.id === PRESETS[0].id)?.label, 'Renamed');
    assert.equal(harnesses.filter((h) => h.id === PRESETS[0].id).length, 1);
    assert.ok(!harnesses.some((h) => h.id === 'BAD'));
    assert.equal(problems.length, 1);
    // No file at all: just the presets.
    assert.equal(loadHarnesses(join(dir, 'none.json')).harnesses.length, PRESETS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V1.4 placeholders are filled; {solution} only for the built-in fake harness', () => {
  const vars = { prompt: 'Do it', promptFile: '/w/TASK.md', workspace: '/w', node: '/n', python: 'py', solution: '/s' };
  assert.deepEqual(fill(['{node}', 'a={workspace}', '{prompt}', '{promptFile}'], vars, false), ['/n', 'a=/w', 'Do it', '/w/TASK.md']);
  assert.deepEqual(fill(['{solution}'], vars, false), ['']);
  assert.deepEqual(fill(['{solution}'], vars, true), ['/s']);
});

test('V1.4 findOnPath finds node and not a made-up program', () => {
  assert.ok(findOnPath(process.execPath));
  assert.ok(findOnPath('node'));
  assert.equal(findOnPath(`no-such-cli-${process.pid}`), undefined);
});

test('V1.4 a fake harness adapter produces a row graded by the hidden tests', async () => {
  const t = jsTask();
  const good = await runHarness(fake('solve'), t, { python, timeoutSec: 120 });
  assert.equal(good.pass, true, good.detail);
  assert.equal(good.task, t.id);
  assert.ok(good.filesChanged >= 1);
  assert.equal(good.exit, 0);
  const bad = await runHarness(fake('nothing'), t, { python, timeoutSec: 120 });
  assert.equal(bad.pass, false);
  assert.equal(bad.filesChanged, 0);
});

test('V1.4 a harness that runs past its time is stopped and graded on what it left', async () => {
  const r = await runHarness(fake('hang'), jsTask(), { python, timeoutSec: 2 });
  assert.equal(r.pass, false);
  assert.match(r.error ?? '', /time/i);
  assert.ok(r.seconds < 30);
});

test('V1.4 a missing CLI gives a clear row error instead of a crash', async () => {
  const r = await runHarness({ id: 'gone', label: 'Gone', command: [`no-such-cli-${process.pid}`, '{promptFile}'] }, jsTask(), { python, timeoutSec: 10 });
  assert.equal(r.pass, false);
  assert.match(r.error ?? '', /not found/i);
});

test('V1.4 Windows .cmd shims (npm CLIs) run with quoted paths; {prompt} with line breaks is refused', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v1bench shim '));
  try {
    const shim = join(dir, 'fake-agent.cmd');
    writeFileSync(shim, `@"${process.execPath}" "${FAKE}" %*\r\n`);
    const ok = await runHarness({ id: 'shim', label: 'Shim', internal: true, command: [shim, 'solve', '{workspace}', '{solution}', '{promptFile}'] }, jsTask(), { python, timeoutSec: 120 });
    assert.equal(ok.pass, true, ok.detail ?? ok.error);
    const refused = await runHarness({ id: 'shim2', label: 'Shim', command: [shim, 'nothing', '{workspace}', '', '{prompt}'] }, jsTask(), { python, timeoutSec: 30 });
    assert.match(refused.error ?? '', /promptFile|stdin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V1.4 selfTest (part of --mode verify): solve passes, nothing fails', async () => {
  const s = await selfTest({ python, task: jsTask() });
  assert.equal(s.ok, true, JSON.stringify(s));
});

test('V1.4 the published summary keeps scores, model, date and the exact command; no paths or replies', () => {
  const s = compareSummary({
    harness: 'my-agent', label: 'My agent', version: 'my-agent 1.2.3', model: 'some-model', tier: 'tasks',
    command: ['my-agent', '--task-file', '{promptFile}'], at: '2026-11-18T10:00:00.000Z', finished: '2026-11-18T10:20:00.000Z',
    platform: 'win32', python: 'Python 3.14', tasks: 2, pass: 1, pass1: 50, seconds: 1200,
    runs: [
      { task: 'a', title: 'A', kind: 'bug', lang: 'js', pass: true, seconds: 600, exit: 0, filesChanged: 2 },
      { task: 'b', title: 'B', kind: 'feature', lang: 'python', pass: false, seconds: 600, exit: 1, filesChanged: 0, detail: 'C:\\Users\\someone\\x failed', error: 'stopped after 480 s' },
    ],
  }, '2026-11-18-compare-tasks-my-agent.json');
  assert.equal(s.passed, 1);
  assert.equal(s.model, 'some-model');
  assert.equal(s.rerun, 'node scripts/bench-compare.ts --harness my-agent');
  assert.equal(s.command, 'my-agent --task-file {promptFile}');
  assert.deepEqual(s.failed, ['b']);
  const text = JSON.stringify(s);
  assert.ok(!/Users|someone|detail/.test(text), text);
});

test('V1.4 the results page builds offline: no scripts, no outside files, light and dark, every row', () => {
  const sara = JSON.parse(readFileSync(join(ROOT, 'docs', 'results', 'tasks-agent.json'), 'utf8'));
  const other = compareSummary({
    harness: 'my-agent', label: 'My <agent>', version: '', model: '', tier: 'tasks', command: ['my-agent', '{promptFile}'],
    at: '2026-11-18T10:00:00.000Z', finished: '2026-11-18T10:20:00.000Z', platform: 'linux', python: 'Python 3', tasks: 1, pass: 1, pass1: 100, seconds: 60,
    runs: [{ task: sara.runs[0].task, title: 't', kind: 'bug', lang: 'js', pass: true, seconds: 60, exit: 0, filesChanged: 1 }],
  }, 'f.json');
  const html = buildPage({ sara: [sara], others: [other], built: '2026-11-18' });
  assert.match(html, /^<!doctype html>/i);
  assert.ok(!/<script|<link|@import|https?:\/\/(?!github\.com\/farena-ai)/i.test(html.replace(/href="https:\/\/github\.com\/farena-ai[^"]*"/g, '')), 'nothing loaded from outside');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /My &lt;agent&gt;/, 'labels are escaped');
  assert.match(html, new RegExp(sara.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const plain = html.replace(/<[^>]+>/g, '');
  assert.match(plain, /node scripts\/bench-tasks\.ts --mode agent/);
  assert.match(plain, /node scripts\/bench-compare\.ts --harness my-agent/);
  assert.match(html, /the CLI's own default/, 'an unknown model says so');
  assert.match(html, /2026-11-18/);
});

test('V1.4 the shipped page is current with the shipped summaries', async () => {
  const page = join(ROOT, 'docs', 'results', 'index.html');
  assert.ok(existsSync(page), 'docs/results/index.html is built');
  const { pageFromDocs } = await import('../scripts/bench-compare.ts');
  const html = readFileSync(page, 'utf8');
  const built = /data-built="([\d-]+)"/.exec(html)?.[1];
  assert.ok(built);
  assert.equal(html.replace(/\r\n/g, '\n'), pageFromDocs(built));
  // A better run never hides a worse one: the projects tier lists each run of that day.
  const pa = JSON.parse(readFileSync(join(ROOT, 'docs', 'results', 'projects-agent.json'), 'utf8'));
  if (pa.everyRun?.length > 1) assert.ok(html.includes(`every run: ${pa.everyRun.map((x: { passed: number; of: number }) => `${x.passed}/${x.of}`).join(', ')}`));
});
