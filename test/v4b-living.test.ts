// V4b (docs/ops/V4_DESIGN.md → Living parts): the presence orb's states from real signals, reduced
// motion, the run timeline from a recorded step stream (verified only with evidence), and the wiring
// into the chat (approve/deny, receipts, step details and Show the run stay where they were).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const stub = String.raw`const t = (s, p = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));`;
/** A web module in Node: its naming.js import becomes a small stand-in. */
async function webModule<T>(file: string): Promise<T> {
  const src = read('web', file).replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/from '\.\/run-model\.js'/, `from '${new URL(`file:///${join(ROOT, 'web', 'run-model.js').replace(/\\/g, '/')}`).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as T;
}

type Sig = Record<string, unknown>;
interface OrbMod {
  newSignals: () => Sig;
  reduceSignal: (s: Sig, ev: unknown) => Sig;
  orbState: (s: Sig) => string;
  voiceLevel: (s: Sig, now: number, tick?: number) => number;
  orbLabel: (state: string, name?: string) => string;
  mountOrbs: (root: unknown) => void;
  orbSignal: (ev: unknown) => void;
  readAccent: (style: { getPropertyValue: (k: string) => string }) => { h: number; s: number; l: number };
}

test('orb: a recorded turn maps to idle → thinking → speaking → idle; mic and calls to listening', async () => {
  const { newSignals, reduceSignal, orbState } = await webModule<OrbMod>('orb.js');
  // The setActivity / speaker.onState calls of one spoken turn with a tool step, as app.js makes them.
  const stream = [
    [{ type: 'activity', status: 'thinking' }, 'thinking'],
    [{ type: 'activity', status: 'running' }, 'thinking'],
    [{ type: 'activity', status: 'waiting' }, 'thinking'],
    [{ type: 'activity', status: 'writing' }, 'thinking'],
    [{ type: 'speaking', on: true }, 'speaking'],
    [{ type: 'activity', status: '' }, 'speaking'],
    [{ type: 'speaking', on: false }, 'idle'],
    [{ type: 'activity', status: 'listening' }, 'listening'],
    [{ type: 'activity', status: 'hearing' }, 'listening'],
    [{ type: 'speaking', on: true }, 'speaking'],
    [{ type: 'speaking', on: false }, 'listening'],
    [{ type: 'activity', status: null }, 'idle'],
    [{ type: 'mic', on: true }, 'listening'],
    [{ type: 'mic', on: false }, 'idle'],
    [{ type: 'bogus' }, 'idle'],
  ] as const;
  let s = newSignals();
  for (const [ev, want] of stream) {
    s = reduceSignal(s, ev);
    assert.equal(orbState(s), want, JSON.stringify(ev));
  }
  assert.equal(orbState(reduceSignal(newSignals(), null)), 'idle');
});

test('orb: the waveform follows a fresh mic level, else a gentle synthetic one; labels use her name', async () => {
  const { newSignals, reduceSignal, voiceLevel, orbLabel, readAccent } = await webModule<OrbMod>('orb.js');
  const s = reduceSignal(newSignals(), { type: 'level', value: 0.25, at: 1000 });
  assert.equal(voiceLevel(s, 1100), Math.min(1, Math.sqrt(0.25) * 2.2));
  const stale = voiceLevel(s, 5000, 5000);
  assert.ok(stale >= 0.4 && stale <= 1, 'synthetic level when the mic level is old');
  assert.equal(reduceSignal(s, { type: 'level', value: 9 }).level, 1, 'clamped');
  assert.equal(orbLabel('thinking'), 'Sara: thinking');
  assert.equal(orbLabel('idle', 'Inbox triage'), 'Inbox triage: here');
  // Colours: V4's --acc-h/s/l win; else the palette's --accent-solid.
  assert.deepEqual(readAccent({ getPropertyValue: (k) => ({ '--acc-h': ' 345', '--acc-s': '68%', '--acc-l': '62%' })[k] ?? '' }), { h: 345, s: 68, l: 62 });
  assert.deepEqual(readAccent({ getPropertyValue: (k) => (k === '--accent-solid' ? '#2f6fe0' : '') }), { h: 218, s: 74, l: 53 });
});

test('orb: reduced motion draws still frames only (no animation loop), redrawn when the state changes', async () => {
  const frames: number[] = [];
  let rafs = 0;
  const calls: string[] = [];
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : typeof k === 'string' ? (...a: unknown[]) => (k === 'clearRect' && calls.push('clear'), a) : undefined), set: () => true });
  const attrs = new Map<string, string>();
  const el = { dataset: { orbSize: '38' } as Record<string, string>, isConnected: true, _orb: undefined, matches: () => true, getBoundingClientRect: () => ({ width: 38 }), replaceChildren() {}, setAttribute: (k: string, v: string) => attrs.set(k, v), getAttribute: (k: string) => attrs.get(k) ?? null };
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, matchMedia: g.matchMedia, requestAnimationFrame: g.requestAnimationFrame, Element: g.Element, getComputedStyle: g.getComputedStyle };
  g.Element = class {};
  g.document = { hidden: false, documentElement: { dataset: {}, classList: { contains: () => false } }, createElement: () => ({ getContext: () => ctx, setAttribute() {}, width: 0, height: 0 }), addEventListener() {} };
  g.matchMedia = () => ({ matches: true });
  g.requestAnimationFrame = (f: (n: number) => void) => (rafs++, frames.push(1), 0);
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const { mountOrbs, orbSignal } = await webModule<OrbMod>('orb.js');
    mountOrbs({ querySelectorAll: () => [el] });
    assert.equal(attrs.get('role'), 'img');
    assert.equal(attrs.get('aria-label'), 'Sara: here');
    const drawn = calls.length;
    assert.ok(drawn >= 1, 'a still frame on mount');
    orbSignal({ type: 'activity', status: 'thinking' });
    assert.equal(attrs.get('aria-label'), 'Sara: thinking');
    assert.ok(calls.length > drawn, 'redrawn once for the new state');
    const after = calls.length;
    orbSignal({ type: 'level', value: 0.3 });
    assert.equal(calls.length, after, 'a level change alone draws nothing when motion is reduced');
    assert.equal(rafs, 0, 'no animation loop with reduced motion');
  } finally {
    Object.assign(g, saved);
  }
  // CSS: the timeline's shimmer, bar and step marks stop too.
  const css = read('web', 'v4-living.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*v4-run-prog\.live > i/);
});

interface Model {
  timelineModel: (steps: unknown[], ev?: unknown) => { total: number; done: number; live: boolean; active: number; waiting: boolean; errors: number; verified: number; marks: (null | { by: string })[]; progress: number | null; sandboxTries: number };
  verification: (step: unknown, ev?: unknown) => null | { by: string };
  sandboxVerified: (rec: unknown) => boolean;
  runTotals: (run: unknown) => null | { tokens: number; usd: number; incomplete: boolean };
}

test('run timeline: a recorded step stream, live then done; verified only with sandbox or checks evidence', async () => {
  const { timelineModel, verification, sandboxVerified, runTotals } = (await import(new URL('../web/run-model.js', import.meta.url).href)) as Model;
  // tool_call / approval / tool_running / sandbox / tool_result / checks, as the chat stream sends them.
  const steps: Record<string, unknown>[] = [];
  const sandbox = new Map<string, unknown>();
  let checks: unknown = null;
  const ev = () => ({ sandbox, checks });
  const recorded: [string, Record<string, unknown>][] = [
    ['tool_call', { id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }],
    ['tool_result', { id: 'c1', status: 'ok' }],
    ['tool_call', { id: 'c2', name: 'write_file', args: { path: 'src/a.ts' } }],
    ['tool_result', { id: 'c2', status: 'ok' }],
    ['tool_call', { id: 'c3', name: 'shell', args: { command: 'npm test' } }],
    ['approval', { id: 'c3' }],
    ['tool_running', { id: 'c3' }],
    ['sandbox', { id: 'c3', record: { ran: true, isolated: true, exitCode: 0, timedOut: false, decision: 'applied', label: 'Docker' } }],
    ['tool_result', { id: 'c3', status: 'ok' }],
    ['tool_call', { id: 'c4', name: 'shell', args: { command: 'npm run lint' } }],
    ['sandbox', { id: 'c4', record: { ran: true, isolated: false, exitCode: 0, timedOut: false, decision: 'ran' } }],
    ['tool_result', { id: 'c4', status: 'ok' }],
    ['tool_call', { id: 'c5', name: 'web_fetch', args: {} }],
    ['tool_result', { id: 'c5', status: 'error' }],
  ];
  const seen: { live: boolean; waiting: boolean; active: number }[] = [];
  for (const [type, e] of recorded) {
    const s = steps.find((x) => x.id === e.id);
    if (type === 'tool_call') steps.push({ kind: 'tool', id: e.id, name: e.name, args: e.args, status: 'running' });
    else if (type === 'approval') s!.status = 'waiting';
    else if (type === 'tool_running') s!.status = 'running';
    else if (type === 'sandbox') sandbox.set(String(e.id), e.record);
    else if (type === 'tool_result') s!.status = e.status;
    const m = timelineModel(steps, ev());
    seen.push({ live: m.live, waiting: m.waiting, active: m.active });
    if (m.live) assert.equal(m.progress, null, 'no made-up share while live');
  }
  assert.deepEqual(seen[5], { live: true, waiting: true, active: 2 }, 'the approval waits on step 3');
  const m = timelineModel(steps, ev());
  assert.equal(m.live, false);
  assert.equal(m.total, 5);
  assert.equal(m.done, 5);
  assert.equal(m.errors, 1);
  assert.equal(m.progress, 1);
  assert.equal(m.sandboxTries, 2);
  // Only c3 (isolated sandbox, exit 0) is verified; the read, the write without checks, the
  // non-isolated try and the failed fetch are plain.
  assert.deepEqual(m.marks.map((x) => x?.by ?? null), [null, null, 'sandbox', null, null]);
  // A clean checks chip covering the written file verifies the write (and nothing else).
  checks = { state: 'clean', checker: 'tsc', files: ['src/a.ts'], left: 0, fixed: 0, lines: [] };
  assert.deepEqual(timelineModel(steps, ev()).marks.map((x) => x?.by ?? null), [null, 'checks', 'sandbox', null, null]);
  checks = { state: 'left', checker: 'tsc', files: ['src/a.ts'], left: 2, fixed: 0, lines: [] };
  assert.equal(timelineModel(steps, ev()).verified, 1, 'problems left: not verified');
  checks = { state: 'clean', checker: 'tsc', files: ['src/other.ts'] };
  assert.equal(verification(steps[1], ev()), null, 'another file: not verified');
  for (const rec of [null, { ran: false, isolated: true, exitCode: 0 }, { ran: true, isolated: true, exitCode: 1 }, { ran: true, isolated: true, exitCode: 0, timedOut: true }, { ran: true, isolated: true, exitCode: 0, decision: 'cancelled' }]) assert.equal(sandboxVerified(rec), false, JSON.stringify(rec));
  // A failed step is never verified, whatever the evidence says.
  sandbox.set('c5', { ran: true, isolated: true, exitCode: 0 });
  assert.equal(verification(steps[4], ev()), null);
  assert.deepEqual(runTotals({ tokensIn: 2000, tokensOut: 840, usd: 0.031, unpriced: 0, unreported: 0 }), { tokens: 2840, usd: 0.031, incomplete: false });
  assert.equal(runTotals({ tokensIn: 1, tokensOut: 1, usd: 0, unpriced: 1 })!.incomplete, true);
  assert.equal(runTotals(null), null);
});

test('run timeline: wired into the existing step line and chat stream; existing behaviours stay', () => {
  const app = read('web', 'app.js');
  const steps = read('web', 'steps.js');
  const tl = read('web', 'run-timeline.js');
  // The same step line, decorated: live in the stream, from history after a reload.
  assert.match(app, /const newSteps = \(live = false\) => runTimeline\(stepLine\(\{ named: toolNamed, undo: addUndo \}\), \{ api, live \}\);/);
  assert.match(app, /steps = newSteps\(true\);/);
  assert.match(steps, /box\._after\?\.\(box\);/);
  // Evidence only from real events and stored records.
  assert.match(app, /runEvidence\(steps, 'sandbox', ev\.record, ev\.id\);/);
  assert.match(app, /runEvidence\(steps, 'checks', ev\.chip\);/);
  assert.match(app, /if \(m\.meta\?\.sandbox\?\.decision\) runEvidence\(turn\.steps, 'sandbox', m\.meta\.sandbox, m\.meta\.toolCallId\);/);
  assert.match(app, /runEvidence\(turn\.steps, 'checks', m\.meta\.checks\)/);
  // The approval card is the same card (Allow / Deny / Always allow), inside the run; budget cards stay apart.
  assert.match(app, /if \(ev\.budget \|\| !runApproval\(steps, card\)\) place\(card\);/);
  assert.match(app, /document\.querySelector\(`\.approval\[data-call="\$\{CSS\.escape\(ev\.id\)\}"\]`\)\?\.remove\(\);/);
  // "verified" is written in one place, from verification() only.
  assert.equal((tl.match(/t\('verified'\)/g) ?? []).length, 1);
  assert.match(tl, /const v = verification\(s, ev\);/);
  // Fold / Show steps per person (owner or member id).
  assert.match(tl, /sara\.v4\.runFold\.\$\{who\}/);
  assert.match(app, /setRunUser\(session\.role === 'member' \? `m\$\{session\.member\?\.id \?\? ''\}` : 'owner'\);/);
  // Receipts flags, step details, Undo and Show the run are untouched.
  assert.match(app, /function flagClaims\(el, claims\)/);
  assert.match(steps, /export function runLink\(box, runId, open\)/);
  assert.match(steps, /if \(snapshotId\) box\._undo\(step\.body, snapshotId\);/);
  // One stylesheet, linked once.
  const html = read('web', 'index.html');
  assert.equal((html.match(/href="\/v4-living\.css"/g) ?? []).length, 1);
});

test('orb: mounted in the header, sidebar brand, her messages, the call screen, worker rows and quick-ask', () => {
  const html = read('web', 'index.html');
  assert.match(html, /id="her-face"[^>]*>.*<span class="v4-orb v4-orb-face" data-orb-size="38"><\/span><\/button>/);
  assert.match(html, /id="brand-today"[^>]*>.*<span class="v4-orb v4-orb-face" data-orb-size="30"><\/span>/);
  assert.match(html, /<span class="v4-orb v4-orb-call" data-orb-size="56"><\/span>/);
  const app = read('web', 'app.js');
  assert.match(app, /div\.prepend\(img, orbMount\(28, \{ cls: 'v4-orb-face msg-orb' \}\)\);/);
  assert.match(app, /orbSignal\(\{ type: 'activity', status: status \|\| '' \}\);/);
  assert.match(app, /orbSignal\(\{ type: 'speaking', on \}\);/);
  assert.match(read('web', 'workers.js'), /orbMount\(16, \{ state: w\.running \? 'thinking' : 'idle'/);
  assert.match(read('web', 'voice.js'), /new CustomEvent\('sara-mic-level'/);
  const qa = read('desktop', 'shared', 'quick-ask.html');
  assert.match(qa, /<span id="orb" role="img" aria-label="Sara: here">/);
  assert.match(qa, /prefers-reduced-motion: reduce/);
  // Her own picture is never removed: with a custom face the orb is a badge.
  assert.match(app, /classList\.toggle\('v4-own-face', pic !== 'orb'\)/); // V4d: Appearance → Her picture
  assert.match(read('web', 'v4-living.css'), /:root\[data-palette="classic"\] \.v4-orb \{ display: none; \}/);
});
