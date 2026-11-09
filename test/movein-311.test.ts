// 3.1.1 move-in: the collector on a REAL-shaped Hermes Agent home (installs, venvs, caches, browser data,
// a junction, thousands of files) stays fast and bounded, says what it skipped and why, shows progress;
// the Hermes reader keeps the owner's chats apart (helper/subagent sessions left out, a chat opened from
// another one stays its own, a compression continuation joins its chat); skills are held by what they are
// about, not by a word in their instructions; a re-run brings only what is new.
// All data is made up (owner "Alex").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './helpers.ts';
import { MoveIn } from '../src/movein/index.ts';
import { PY, T0, app, cleanupScratch, openclaw2611, put, realisticHermes, scratch } from './movein-real-fixtures.ts';

const COLLECTOR = join(ROOT, 'scripts', 'sara-movein.py');
after(cleanupScratch);
const NO_PY = PY ? false : 'no python3 on this machine';

function collect(args: string[], cwd: string): { status: number | null; out: string; err: string; ms: number } {
  const t = Date.now();
  const r = spawnSync(PY!, [COLLECTOR, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', HERMES_HOME: '' }, timeout: 120_000 });
  return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t };
}

test('collector: a real-shaped Hermes home is read fast; installs, caches, browser data are named, never walked; links never followed', { skip: NO_PY }, () => {
  const root = scratch('bounded');
  const home = realisticHermes(root, { bulk: 3000 });
  const r = collect(['collect', '--hermes-home', home, '--plan-only', '--json', '--progress', 'off'], root);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.ms < 20_000, `plan-only took ${r.ms} ms`);
  const plan = JSON.parse(r.out) as { skipped: Record<string, { files: number }>; packed: { byKind: Record<string, number> } };
  // installs/ holds 3000 files: only a bounded peek is counted (no full walk).
  assert.ok(plan.skipped.other.files < 1500, JSON.stringify(plan.skipped));
  assert.equal(plan.packed.byKind.skill, 2, 'two real skills; .hub and the ledger are Hermes bookkeeping');
  const out = join(root, 'out');
  mkdirSync(out);
  const c = collect(['collect', '--hermes-home', home, '--yes', '--out', out, '--progress', 'off'], root);
  assert.equal(c.status, 0, c.err + c.out);
  const file = readdirSync(out).find((f) => f.endsWith('.saramove'))!;
  const list = spawnSync(PY!, ['-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist()))', join(out, file)], { encoding: 'utf8' });
  const names = JSON.parse(list.stdout) as string[];
  assert.ok(!names.some((n) => /installs|site-packages|browser|cache\/web|SECRET-OUTSIDE|projects\.db|models_dev/.test(n)), names.join('\n'));
  assert.ok(names.includes('files/home/SOUL.md'));
  const manifest = JSON.parse(spawnSync(PY!, ['-c', 'import zipfile,sys; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read("manifest.json").decode())', join(out, file)], { encoding: 'utf8' }).stdout) as { skipped: { path: string; reason: string; why?: string }[] };
  const inst = manifest.skipped.find((s) => s.path === 'home/installs/');
  assert.ok(inst && /never opened/.test(inst.why ?? ''), JSON.stringify(inst));
  if (existsSync(join(home, 'skills', 'linked'))) assert.ok(manifest.skipped.some((s) => s.path === 'home/skills/linked' && /link/.test(s.why ?? '')));
});

test('collector: progress lines while it works; a folder over the budget is skipped with a note naming --include-large', { skip: NO_PY }, () => {
  const root = scratch('progress');
  const home = realisticHermes(root, { bulk: 10 });
  for (let i = 0; i < 40; i++) put(home, `skills/bulk/s${i}/SKILL.md`, `---\nname: s${i}\ndescription: skill ${i}\n---\n`);
  const r = collect(['collect', '--hermes-home', home, '--plan-only', '--json', '--progress', 'json', '--section-files', '30'], root);
  assert.equal(r.status, 0, r.err);
  const lines = r.err.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { progress: string; text: string });
  assert.ok(lines.some((l) => l.progress === 'look' && /Looking through/.test(l.text)), r.err);
  const plan = JSON.parse(r.out) as { notes: string[]; skipped: Record<string, unknown>; packed: { byKind: Record<string, number> } };
  assert.ok(plan.notes.some((n) => /too large: skills\/.*--include-large/.test(n)), plan.notes.join('\n'));
  assert.ok(plan.skipped['too-big']);
  assert.ok(!plan.packed.byKind.skill);
  const big = collect(['collect', '--hermes-home', home, '--plan-only', '--json', '--progress', 'off', '--section-files', '30', '--include-large'], root);
  assert.equal((JSON.parse(big.out) as { packed: { byKind: Record<string, number> } }).packed.byKind.skill, 42);
});

test('Hermes reader: helpers left out (counted), a chat opened from another stays its own, compression joins; skills held by topic', { skip: NO_PY }, async () => {
  const root = scratch('reader');
  const home = realisticHermes(root, { bulk: 5 });
  const out = join(root, 'out');
  mkdirSync(out);
  const c = collect(['collect', '--hermes-home', home, '--yes', '--out', out, '--progress', 'off', '--include-category', 'medical'], root);
  assert.equal(c.status, 0, c.err + c.out);
  const file = join(out, readdirSync(out).find((f) => f.endsWith('.saramove'))!);
  const a = app('reader-app');
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(file);
    assert.equal(s.state, 'ready', s.error);
    const pv = mi.preview(s.id) as Record<string, any>;
    // d1+d1b (one chat), d2 (its own), l1 → 3 conversations; sa1/sa2 are helpers.
    assert.equal(pv.conversations.count, 3, JSON.stringify(pv.conversations));
    assert.ok(pv.leftBehind.some((l: { key: string; count: number }) => l.key === 'skip-helpers' && l.count === 2), JSON.stringify(pv.leftBehind));
    const skills = mi.section(s.id, 'skills');
    assert.equal(skills.find((x) => x.title === 'debugging')?.held, null, 'a coding skill is not medical');
    assert.equal(skills.find((x) => x.title === 'med-reminders')?.held, 'medical');
    await mi.start(s.id, { herPast: true, sections: {}, sensitive: {}, learn: false });
    await mi.idle(s.id);
    const trip = a.store.db.prepare("SELECT c.id, COUNT(m.id) AS n FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.title LIKE 'Trip planning%' GROUP BY c.id").all() as { n: number }[];
    assert.deepEqual(trip.map((x) => x.n), [6], 'the compression continuation is one chat with all six messages');
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
  }
});

test('re-run: the same bundle brings nothing twice; a chat that went on brings only its new messages', { skip: NO_PY }, async () => {
  const root = scratch('rerun');
  const home = realisticHermes(root, { bulk: 5 });
  const run = (tag: string) => {
    const out = join(root, `out-${tag}`);
    mkdirSync(out);
    const c = collect(['collect', '--hermes-home', home, '--yes', '--out', out, '--progress', 'off'], root);
    assert.equal(c.status, 0, c.err + c.out);
    return join(out, readdirSync(out).find((f) => f.endsWith('.saramove'))!);
  };
  const a = app('rerun-app');
  const mi = new MoveIn(() => a);
  try {
    const first = await mi.addFile(run('1'));
    await mi.start(first.id, { herPast: true, sections: {}, sensitive: {}, learn: false, persona: { use: 0 } });
    await mi.idle(first.id);
    const msgs = () => (a.store.db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel LIKE 'import-%'").get() as { n: number }).n;
    const after1 = msgs();
    const mems1 = (a.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    // Same data again: nothing new.
    const again = await mi.addFile(run('2'));
    const pv = mi.preview(again.id) as Record<string, any>;
    assert.equal(pv.sections.conversations.writes, 0, JSON.stringify(pv.sections.conversations));
    assert.equal(pv.sections.memories.writes, 0, JSON.stringify(pv.sections.memories));
    assert.equal(pv.sections.persona.writes, 0, 'the same SOUL.md is not applied again');
    mi.deleteBundle(again.id);
    // Alex kept talking in "Garden ideas": two new messages.
    const db = new DatabaseSync(join(home, 'state.db'));
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES (?, ?, ?, ?, ?)').run('d2', 'user', 'One more garden question', T0 + 200000, 'n1');
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES (?, ?, ?, ?, ?)').run('d2', 'assistant', 'Plant the beans now.', T0 + 200010, 'n2');
    db.close();
    const third = await mi.addFile(run('3'));
    const pv3 = mi.preview(third.id) as Record<string, any>;
    assert.equal(pv3.sections.conversations.writes, 1, JSON.stringify(pv3.sections.conversations));
    await mi.start(third.id, { herPast: true, sections: {}, sensitive: {}, learn: false });
    await mi.idle(third.id);
    assert.equal(msgs(), after1 + 2, 'only the two new messages came over');
    assert.equal((a.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, mems1, 'no note twice');
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
  }
});

test('OpenClaw 2026.11 (as a real install lays it out): chats from the agent database, automations from cron_jobs, setup templates left out', { skip: NO_PY }, async () => {
  const root = scratch('oc2611');
  const oc = openclaw2611(root);
  const out = join(root, 'out');
  mkdirSync(out);
  const c = collect(['collect', '--openclaw-state', oc.state, '--yes', '--out', out, '--progress', 'off'], root);
  assert.equal(c.status, 0, c.err + c.out);
  assert.doesNotMatch(c.out, /Telemetry\s+1 tables in stores \(session_transcript_active_events/, 'the active branch is data, not telemetry');
  const a = app('oc2611-app');
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(join(out, readdirSync(out).find((f) => f.endsWith('.saramove'))!));
    assert.equal(s.state, 'ready', s.error);
    const pv = mi.preview(s.id) as Record<string, any>;
    assert.equal(pv.source.displayName, 'Juniper');
    assert.equal(pv.conversations.count, 3, JSON.stringify(pv.conversations));
    assert.equal(pv.sections.memories.found, 2, 'MEMORY.md only: the untouched AGENTS.md template is not 3 working rules');
    assert.equal(pv.sections.profile.found, 2);
    assert.equal(pv.sections.schedules.found, 2, "your two jobs; OpenClaw's own dreaming and heartbeat jobs stay behind");
    assert.equal(pv.sections.skills.found, 1);
    const persona = pv.persona.drafts[0];
    assert.equal(persona.sheet.name, 'Juniper');
    assert.ok(!persona.files.includes('SOUL.md'), 'the setup SOUL.md template is not her personality');
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
  }
});
