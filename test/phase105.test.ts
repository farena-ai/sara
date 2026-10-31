// Phase 105 (MI2, docs/design/MOVE_IN.md §8): custom SQLite and Postgres stores. A made-up store shaped
// like a heavily customised agent's (276 tables) goes through the collector, the profiles (telemetry
// recognised and skipped), the cards (nothing imports before Looks right), the no-model guess and a
// scripted model proposal (validated, retried once, masked samples), the mapper (people facts joined
// in SQLite, a 500-row check), one batch and exact Undo, and a saved mapping that maps the next bundle
// with no model call. Postgres: the collector's own read-only client against a fake server
// (SCRAM-SHA-256, one READ ONLY snapshot, nothing written) and a plain pg_dump file.
// All data is invented (owner "Alex"); fake keys are built from pieces (test/movein-fixtures.ts).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { makeApp, ROOT, text, type TestApp } from './helpers.ts';
import { ALL_FAKE, FAKE, MEDICAL_MARK } from './movein-fixtures.ts';
import { DATA_TABLES, FACT_MARK, INJECTION, makeMindStore, PEOPLE, writePgDump } from './movein-custom-fixtures.ts';
import { startFakePostgres } from './fake-postgres.ts';
import { MoveIn } from '../src/movein/index.ts';
import { PeopleStore } from '../src/people.ts';
import { AgendaStore } from '../src/agenda.ts';
import { guessMapping, normMapping, validate } from '../src/movein/mapping.ts';
import { families, telemetrySignals, profileColumn } from '../src/movein/schema.ts';

const COLLECTOR = join(ROOT, 'scripts', 'sara-movein.py');
const roots: string[] = [];
function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `sara-p105-${name}-`));
  roots.push(d);
  return d;
}
after(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows may hold a file a moment longer; it's a temp folder */
    }
  }
});

const PY = (() => {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && Number(r.stdout.trim()) >= 306) return cmd;
  }
  return undefined;
})();
const NO_PY = PY ? false : "no python3 (3.6+) on this machine: the collector runs on the old agent's machine";

/** Runs the collector with an empty home, so it never finds this machine's own agents. */
function collect(args: string[], cwd: string, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const home = join(cwd, 'empty-home');
  mkdirSync(home, { recursive: true });
  const r = spawnSync(PY!, [COLLECTOR, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', HOME: home, USERPROFILE: home, LOCALAPPDATA: home, HERMES_HOME: '', OPENCLAW_STATE_DIR: '', OPENCLAW_PROFILE: '', ...env }, timeout: 180_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
/** The same, without blocking the event loop (the fake Postgres server runs in this process). */
function collectAsync(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ status: number | null; out: string; err: string }> {
  const home = join(cwd, 'empty-home');
  mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const p = spawn(PY!, [COLLECTOR, ...args], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', HOME: home, USERPROFILE: home, LOCALAPPDATA: home, HERMES_HOME: '', OPENCLAW_STATE_DIR: '', OPENCLAW_PROFILE: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const timer = setTimeout(() => p.kill(), 180_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out, err });
    });
  });
}
function bundleIn(dir: string): string {
  const f = readdirSync(dir).find((x) => x.endsWith('.saramove'));
  assert.ok(f, `no bundle in ${dir}`);
  return join(dir, f);
}

let mind: { root: string; db: string; bundle: string; planted: ReturnType<typeof makeMindStore> } | undefined;
/** The 276-table store and its bundle (made once). */
function mindBundle() {
  if (mind) return mind;
  const root = scratch('mind');
  const folder = join(root, 'agent');
  const db = join(folder, 'mind.db');
  const planted = makeMindStore(db);
  const out = join(root, 'out');
  mkdirSync(out);
  const r = collect(['collect', '--scan', folder, '--yes', '--out', out, '--lang', 'en'], root);
  assert.equal(r.status, 0, r.err + r.out);
  mind = { root, db, bundle: bundleIn(out), planted };
  return mind;
}

function app(name: string): TestApp {
  const dir = scratch(name);
  const a = makeApp(dir, { now: new Date('2026-10-31T12:00:00Z') });
  a.people = new PeopleStore(a.store.db);
  a.agenda = { store: new AgendaStore(a.store.db) } as never;
  return a;
}
const TABLES = ['memories', 'people', 'person_facts', 'tasks', 'agenda_goals', 'conversations', 'messages'];
const count = (a: TestApp, t: string) => Number((a.store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);

test('schema: telemetry needs two signals; a parent table people point at is never a log', () => {
  const cols = (spec: [string, unknown[]][]) => spec.map(([name, vals]) => profileColumn({ name, type: '' }, vals));
  const log = cols([['id', [1, 2, 3, 4, 5, 6]], ['ts', [1767225600, 1767225605, 1767225610, 1767225615, 1767225620, 1767225625]], ['level', ['info', 'info', 'warn', 'info', 'info', 'info']], ['msg', ['tick ok', 'tick ok', 'retry', 'idle', 'tick ok', 'idle']]]);
  assert.deepEqual(telemetrySignals({ name: 'heartbeat_ticks', rows: 600, columns: log, dates: [] }).sort(), ['name', 'no-owner-words', 'shape']);
  const notes = cols([['id', [1, 2, 3]], ['content', ['Alex wants the porch painted a warm yellow before winter.', 'His sister Maya visits every second Sunday in spring.', 'He promised to call the plumber about the kitchen tap.']], ['created_at', ['2026-01-01', '2026-01-02', '2026-01-03']]]);
  assert.ok(telemetrySignals({ name: 'memories', rows: 3, columns: notes, dates: [] }).length < 2);
});

test('custom store: 276 tables profiled; ≥ 95% of planted telemetry skipped, no planted data table skipped; secrets and held tables never packed', { skip: NO_PY }, async () => {
  const m = mindBundle();
  assert.equal(m.planted.tables, 276);
  const a = app('profile');
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(m.bundle);
    assert.equal(s.state, 'ready', s.error);
    const v = mi.cards(s.id, { localOnly: true }) as any;
    const st = v.stores[0];
    assert.equal(st.tables, 276);
    const tele = new Set(st.telemetry.map((x: { name: string }) => x.name));
    const hit = m.planted.telemetry.filter((n) => tele.has(n)).length;
    assert.ok(hit / m.planted.telemetry.length >= 0.95, `${hit} of ${m.planted.telemetry.length} telemetry tables recognised`);
    for (const d of DATA_TABLES) assert.ok(!tele.has(d), `${d} is data, not telemetry`);
    // Search indexes, embeddings, migrations and locks are skipped with their own reasons.
    const left = new Map(st.left.map((x: { name: string; why: string }) => [x.name, x.why]));
    assert.match(String(left.get('memories_fts')), /search index/);
    assert.match(String(left.get('memory_embeddings')), /embeddings/);
    assert.match(String(left.get('schema_migrations')), /migrations/);
    assert.match(String(left.get('worker_locks')), /locks/);
    assert.match(String(left.get('api_tokens')), /never collected/);
    assert.match(String(left.get('health_log')), /medical/);
    // ~9 cards for 276 tables (families by foreign keys and prefixes).
    const keys = v.cards.map((c: { family: { tables: string[] } }) => c.family.tables.join('+'));
    assert.ok(keys.includes('persons+person_aliases+person_facts'), keys.join(' | '));
    assert.ok(keys.includes('chat_threads+chat_messages'));
    assert.ok(v.cards.length <= 12, `${v.cards.length} cards`);
    // The sample rows on the cards: secrets gone, medical values held.
    const shown = JSON.stringify(v.cards);
    for (const f of ALL_FAKE) assert.ok(!shown.includes(f), 'no secret on a card');
    assert.ok(!shown.includes(MEDICAL_MARK), 'medical values are masked on cards');
    // Nothing imports before a card is confirmed.
    const pv = mi.preview(s.id) as any;
    assert.equal(pv.sections.people.writes, 0);
    assert.equal(pv.sections.memories.writes, 0);
    assert.equal(pv.stores.undecided, v.cards.length);
  } finally {
    mi.close();
    a.store.close();
  }
});

test('custom store end to end: the no-model guess, confirm by hand, facts joined (500-row check), one batch, report, exact Undo', { skip: NO_PY }, async () => {
  const m = mindBundle();
  const a = app('e2e');
  const before = Object.fromEntries(TABLES.map((x) => [x, count(a, x)]));
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(m.bundle);
    mi.propose(s.id, { useModel: false });
    await mi.cardsIdle(s.id);
    let v = mi.cards(s.id) as any;
    const people = v.cards.find((c: { family: { tables: string[] } }) => c.family.tables.includes('person_facts'));
    assert.equal(people.state, 'proposed', JSON.stringify(people.errors));
    const by = Object.fromEntries(people.mapping.tables.map((x: { table: string; target: string }) => [x.table, x.target]));
    assert.deepEqual(by, { persons: 'person', person_aliases: 'person_alias', person_facts: 'person_fact' });
    // The card's samples come from the real mapper: people cards with their facts.
    const card = people.preview.samples.people[0];
    assert.ok(PEOPLE.includes(card.title), card.title);
    assert.ok(card.lines.some((l: string) => l.includes(FACT_MARK)));
    assert.equal(a.providerCalls, 0, 'the guess makes no model call');
    // The medical memory is held: its text is not on the card's samples either (found in the live run).
    assert.ok(!JSON.stringify(mi.cards(s.id)).includes(MEDICAL_MARK), 'held values are masked in what the card makes');
    // Confirm every card the guess proposed; skip the integrations card.
    for (const c of v.cards) {
      if (c.family.tables.includes('integrations')) mi.skipCard(s.id, c.key);
      else if (c.state === 'proposed') await mi.confirmCard(s.id, c.key);
    }
    await mi.cardsIdle(s.id);
    v = mi.cards(s.id) as any;
    const done = v.cards.find((c: { key: string }) => c.key === people.key);
    assert.equal(done.state, 'confirmed', JSON.stringify(done.errors));
    assert.equal(done.result.joinCheck.checked - done.result.joinCheck.matched, 1, 'the one fact about nobody is counted, not imported');
    const pv = mi.preview(s.id) as any;
    assert.equal(pv.sections.people.writes, 12);
    assert.ok(pv.sections.people.facts >= 12 * 45, String(pv.sections.people.facts));
    assert.ok(pv.held.medical >= 1, 'the medical memory is held');
    await mi.start(s.id, { herPast: true, sections: {}, sensitive: {} });
    await mi.idle(s.id);
    const [b] = mi.batches();
    assert.equal(b.state, 'done');
    // People cards with facts joined to the right person: the 500-row check against the store itself.
    const src = new DatabaseSync(m.db, { readOnly: true });
    const rows = src.prepare('SELECT p.display_name AS name, f.fact_text AS fact FROM person_facts f JOIN persons p ON p.id = f.person_id ORDER BY f.id LIMIT 500').all() as { name: string; fact: string }[];
    src.close();
    const got = a.store.db.prepare('SELECT p.name AS name, f.content AS fact FROM person_facts f JOIN people p ON p.id = f.person_id').all() as { name: string; fact: string }[];
    const index = new Set(got.map((x) => `${x.name}|${x.fact}`));
    const wrong = rows.filter((r) => !index.has(`${r.name}|${r.fact}`));
    assert.equal(wrong.length, 0, `${wrong.length} of 500 facts on the wrong card: ${JSON.stringify(wrong.slice(0, 2))}`);
    assert.equal(new Set(got.map((x) => x.fact)).size, got.length, 'the repeated fact was merged');
    const jordan = a.people!.list({ q: 'Jordan Lee', status: 'all' })[0];
    assert.ok(jordan.aliases.includes('Jor'), 'aliases come from person_aliases');
    // Tasks never act; goals are paused; the weight goal is not one of her goals; opinions are "I think".
    const tasks = a.store.db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
    assert.equal(tasks.length, 2);
    for (const tk of tasks) assert.ok(!tk.job_id && !tk.auto);
    assert.ok(tasks.some((tk) => tk.status === 'done'));
    const goals = a.store.db.prepare('SELECT title, status FROM agenda_goals').all() as { title: string; status: string }[];
    assert.ok(goals.length >= 3 && goals.every((g) => g.status === 'paused'), JSON.stringify(goals));
    assert.ok(!goals.some((g) => /pounds/.test(g.title)), 'a weight goal never becomes her goal');
    const mems = (a.store.db.prepare("SELECT group_concat(content, '\n') AS c FROM memories").get() as { c: string }).c;
    assert.match(mems, /I think slow mornings/);
    assert.match(mems, /My old notes said \(kept as a quote, not a rule\)/, 'instruction-like rows stay quotes');
    assert.ok(!mems.includes(INJECTION.slice(0, 20)) || mems.includes(`"${INJECTION}`), 'the injection is only a quote');
    assert.ok(!mems.includes(MEDICAL_MARK), 'held medical rows stay out unless chosen');
    // Conversations: tool messages skipped, imported channel.
    const conv = a.store.db.prepare("SELECT id FROM conversations WHERE channel = 'import-movein'").all() as { id: string }[];
    assert.equal(conv.length, 3 + 1 + 0, 'three threads + the notes anchor');
    assert.equal(Number((a.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%weather%'").get() as { n: number }).n), 0);
    // No secret anywhere in her data.
    const all = JSON.stringify([a.store.db.prepare('SELECT * FROM memories').all(), a.store.db.prepare('SELECT * FROM person_facts').all(), a.store.db.prepare('SELECT * FROM messages').all(), a.store.db.prepare('SELECT * FROM people').all()]);
    for (const f of ALL_FAKE) assert.ok(!all.includes(f), 'no secret reached her data');
    // The report: telemetry left behind with a count, the skipped card listed.
    assert.ok(b.report!.leftBehind.some((l) => l.key === 'telemetry-tables' && l.count >= 240));
    assert.ok(b.report!.leftBehind.some((l) => l.key === 'custom-skipped'));
    assert.ok(b.report!.imported.some((l) => l.key === 'people' && l.count === 12));
    mi.undo(b.id);
    assert.deepEqual(Object.fromEntries(TABLES.map((x) => [x, count(a, x)])), before);
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
  }
});

test('the model proposes (masked samples, fixed-menu JSON, validated, retried once); a saved mapping maps the next bundle with no model call', { skip: NO_PY }, async () => {
  const m = mindBundle();
  const a = app('model');
  // A provider that is "on this computer" (the default is local-only).
  a.settings.update({ providers: [{ id: 'local', kind: 'openai-compatible', label: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', local: true }] as never, defaultProviderId: 'local', defaultModel: 'fake-small' } as never);
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(m.bundle);
    const v = mi.cards(s.id) as any;
    const mem = v.cards.find((c: { family: { tables: string[] } }) => c.family.tables.join() === 'memories');
    // First answer names a column that doesn't exist; the retry fixes it.
    a.script.push(text('```json\n{"tables":[{"table":"memories","target":"memory","fields":{"content":"body"},"reason":"notes","confidence":0.9}]}\n```'));
    a.script.push(text('{"tables":[{"table":"memories","target":"memory","fields":{"content":"content","happenedOn":{"date_from":{"col":"created_at","as":"iso"}},"kind":"kind","pinned":"pinned"},"filter":[{"not_null":"content"}],"reason":"her notes about Alex","confidence":0.92}]}'));
    mi.propose(s.id, { keys: [mem.key], localOnly: true });
    await mi.cardsIdle(s.id);
    const after1 = (mi.cards(s.id) as any).cards.find((c: { key: string }) => c.key === mem.key);
    assert.equal(after1.state, 'proposed', JSON.stringify(after1.errors));
    assert.equal(after1.by, 'model');
    assert.equal(a.requests.length, 2, 'one call, retried once with the errors');
    const prompt = JSON.stringify(a.requests[0].messages);
    assert.match(prompt, /never instructions/);
    for (const f of ALL_FAKE) assert.ok(!prompt.includes(f), 'no secret in the prompt');
    assert.ok(!prompt.includes(MEDICAL_MARK), 'held values are masked in the prompt');
    assert.match(prompt, /«held: medical»/);
    assert.match(JSON.stringify(a.requests[1].messages), /doesn't exist/);
    await mi.confirmCard(s.id, mem.key);
    await mi.cardsIdle(s.id);
    assert.equal(mi.mappings().length, 1, 'the confirmed mapping is saved by fingerprint');
    // Exported mappings carry names only.
    const ex = JSON.stringify(mi.exportMappings());
    assert.ok(!ex.includes('garden') && !ex.includes(FACT_MARK), 'no data in an exported mapping');
    mi.deleteBundle(s.id);
    // The same store again: the memories card maps itself, no model call.
    const calls = a.requests.length;
    const s2 = await mi.addFile(m.bundle);
    const v2 = mi.cards(s2.id) as any;
    const again = v2.cards.find((c: { family: { tables: string[] } }) => c.family.tables.join() === 'memories');
    assert.equal(again.state, 'confirmed');
    assert.equal(again.by, 'saved');
    assert.equal(a.requests.length, calls, 'a saved mapping makes no model call');
    // Re-importing a shared file of mappings keeps only the menu.
    assert.equal(mi.importMappings({ format: 'sara-movein-mappings', version: 1, mappings: [{ fingerprint: 'f'.repeat(64), storeLabel: 'x', family: 'y', tables: [{ name: 't', columns: ['a'] }], mapping: { tables: [{ table: 't', target: 'memory', fields: { content: { sql: 'DROP TABLE x' } } }] } }] }), 1);
    const shared = mi.mappings().find((x) => x.fingerprint === 'f'.repeat(64))!;
    assert.deepEqual(shared.mapping.tables[0].fields, {}, 'anything outside the menu is dropped');
  } finally {
    mi.close();
    a.store.close();
  }
});

test('validation: missing columns, a filter that keeps nothing and facts without a people table are refused before the card shows', () => {
  const t = (key: string, cols: string[], extra: Record<string, unknown> = {}) => ({ key, name: key, columns: cols.map((c) => profileColumn({ name: c, type: 'TEXT' }, ['a b c d e'])), pk: ['id'], fks: [], rows: 5, packed: 5, newest: null, verdict: 'data' as const, why: '', telemetry: [], cats: [], samples: [Object.fromEntries(cols.map((c) => [c, 'x']))], ...extra });
  const facts = t('facts', ['id', 'person_id', 'text']);
  const fam = { id: 'f', title: 'facts', tables: ['facts'], fingerprint: 'x' };
  const bad = normMapping({ tables: [{ table: 'facts', target: 'person_fact', fields: { person: 'person_id', content: 'nope' }, filter: [{ eq: { col: 'text', value: 'never' } }] }] }, fam);
  const v = validate(bad, [facts as never]);
  assert.ok(v.errors.some((e) => /"nope" doesn't exist/.test(e)));
  assert.ok(v.errors.some((e) => /keeps none of the sample rows/.test(e)));
  assert.ok(v.errors.some((e) => /need a table mapped as people/.test(e)));
  // Small-model habits seen in the live run: an expression sent as a JSON string, a json_path of "." (the whole
  // value), and a mapping whose text comes out empty for every sample row (refused, so the retry fixes it).
  const quirks = normMapping({ tables: [{ table: 'facts', target: 'memory', fields: { content: { json_path: { col: 'text', path: '.' } }, kind: '{"const":"fact"}' } }] }, fam);
  assert.deepEqual(quirks.tables[0].fields, { content: { col: 'text' }, kind: { const: 'fact' } });
  const empty = normMapping({ tables: [{ table: 'facts', target: 'memory', fields: { content: { json_path: { col: 'text', path: 'a.b' } } } }] }, fam);
  assert.ok(validate(empty, [facts as never]).errors.some((e) => /comes out empty for every sample row/.test(e)));
  // The guess never invents a target for an unknown table.
  const g = guessMapping({ id: 'q', title: 'zz', tables: ['zz_things'], fingerprint: 'y' }, [t('zz_things', ['id', 'blob']) as never]);
  assert.equal(g.tables[0].target, 'skip');
  assert.equal(families([facts as never]).length, 1);
});

// -------------------------------------------------------------------------------------------------
// Postgres (§4.7, §8.6): the collector's own read-only client against a fake server, and dump files
// -------------------------------------------------------------------------------------------------
const PG_PASSWORD = ['fixture', '-only-', 'pw-7731'].join('');

test('Postgres: the built-in client signs in with SCRAM-SHA-256, reads one READ ONLY snapshot, writes nothing; schemas, views and secrets handled', { skip: NO_PY }, async () => {
  const pg = await startFakePostgres({ user: 'alex', password: PG_PASSWORD });
  const a = app('pg');
  const mi = new MoveIn(() => a);
  try {
    const root = scratch('pgout');
    const out = join(root, 'out');
    mkdirSync(out);
    // A wrong password: the store is listed as unreadable, nothing else breaks.
    const bad = await collectAsync(['collect', '--postgres', `postgres://alex@127.0.0.1:${pg.port}/app?sslmode=disable`, '--pg-client', 'builtin', '--plan-only', '--json', '--lang', 'en'], root, { PGPASSWORD: 'wrong' });
    assert.equal(bad.status, 0, bad.err);
    assert.match(bad.out, /password authentication failed/);
    assert.equal(pg.log.failedSignIns, 1);
    const r = await collectAsync(['collect', '--postgres', `postgres://alex@127.0.0.1:${pg.port}/app?sslmode=prefer`, '--pg-client', 'builtin', '--yes', '--out', out, '--lang', 'en'], root, { PGPASSWORD: PG_PASSWORD });
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(pg.log.signedIn >= 1);
    assert.ok(pg.log.ssl >= 1, 'sslmode=prefer asks for TLS first (the fake says no)');
    assert.deepEqual(pg.log.writes, [], 'nothing but reads was ever sent');
    for (const st of pg.log.startup) assert.match(st.options ?? '', /default_transaction_read_only=on/);
    assert.ok(pg.log.queries.some((q) => /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(q)), 'one read-only snapshot');
    assert.ok(pg.log.queries.some((q) => /^SELECT count\(\*\) FROM "app"\."person_facts"$/.test(q)), 'a never-analysed table is counted');
    assert.ok(!pg.log.queries.some((q) => /oauth_tokens|recent_notes|note_stats/.test(q) && /^COPY/.test(q)), 'secrets and views are never copied');
    const bundle = bundleIn(out);
    const raw = readFileSync(bundle);
    assert.ok(!raw.includes(Buffer.from(PG_PASSWORD)), 'the password is not in the bundle');
    const s = await mi.addFile(bundle);
    assert.equal(s.state, 'ready', s.error);
    const v = mi.cards(s.id) as any;
    const st = v.stores[0];
    assert.equal(st.kind, 'postgres');
    const left = new Map(st.left.map((x: { name: string; verdict: string }) => [x.name, x.verdict]));
    assert.equal(left.get('recent_notes'), 'view');
    assert.equal(left.get('note_stats'), 'derived');
    assert.equal(left.get('oauth_tokens'), 'secret');
    assert.ok(st.telemetry.some((x: { name: string }) => x.name === 'agent_runs'), 'the run log is telemetry');
    const fams = v.cards.map((c: { family: { tables: string[]; schema?: string } }) => c.family.tables.join('+'));
    assert.ok(fams.includes('app.persons+app.person_facts'), fams.join(' | '));
    assert.ok(v.cards.some((c: { family: { schema?: string } }) => c.family.schema === 'crm'), 'another schema is a family of its own');
    mi.propose(s.id, { useModel: false });
    await mi.cardsIdle(s.id);
    for (const c of (mi.cards(s.id) as any).cards) if (c.state === 'proposed' && c.family.schema !== 'crm') await mi.confirmCard(s.id, c.key);
    await mi.cardsIdle(s.id);
    const pv = mi.preview(s.id) as any;
    assert.equal(pv.sections.people.writes, 6);
    assert.ok(pv.sections.memories.writes >= 10, JSON.stringify(pv.sections.memories));
    await mi.start(s.id, { herPast: true, sections: {}, sensitive: {} });
    await mi.idle(s.id);
    // Quotes, commas and line breaks inside CSV values survive; timestamps arrive as dates.
    const facts = a.store.db.prepare("SELECT content, happened_on FROM person_facts WHERE content LIKE '%jazz%' OR content LIKE '%chess%'").all() as { content: string; happened_on: string }[];
    assert.ok(facts.some((f) => f.content.includes('jazz, "live"')), JSON.stringify(facts));
    assert.ok(facts.some((f) => f.content.includes('chess at night') || f.content.includes('chess\nat night')));
    assert.ok(facts.every((f) => /^2026-0\d-0\d$/.test(f.happened_on)));
    const [b] = mi.batches();
    mi.undo(b.id);
    assert.equal(count(a, 'people'), 0);
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
    await pg.close();
  }
});

test('Postgres: a plain pg_dump file reads the same (never restored anywhere); a custom-format dump needs pg_restore', { skip: NO_PY }, async () => {
  const root = scratch('dump');
  const dump = join(root, 'app.sql');
  writePgDump(dump);
  const out = join(root, 'out');
  mkdirSync(out);
  const r = collect(['collect', '--postgres-dump', dump, '--yes', '--out', out, '--lang', 'en'], root);
  assert.equal(r.status, 0, r.err + r.out);
  const a = app('dump');
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(bundleIn(out));
    assert.equal(s.state, 'ready', s.error);
    const v = mi.cards(s.id) as any;
    const fams = v.cards.map((c: { family: { tables: string[] } }) => c.family.tables.join('+'));
    assert.ok(fams.includes('app.persons+app.person_facts'), fams.join(' | '));
    const people = v.cards.find((c: { family: { tables: string[] } }) => c.family.tables.includes('app.persons'));
    mi.propose(s.id, { keys: [people.key], useModel: false });
    await mi.cardsIdle(s.id);
    const card = (mi.cards(s.id) as any).cards.find((c: { key: string }) => c.key === people.key);
    assert.equal(card.state, 'proposed', JSON.stringify(card.errors));
    assert.equal(card.preview.made.person, 6);
    assert.equal(card.preview.made.person_fact, 30);
    await mi.confirmCard(s.id, people.key);
    await mi.cardsIdle(s.id);
    await mi.start(s.id, { herPast: true, sections: {}, sensitive: {} });
    await mi.idle(s.id);
    const facts = (a.store.db.prepare("SELECT group_concat(content, '|') AS c FROM person_facts").get() as { c: string }).c;
    assert.ok(facts.includes('jazz, "live"') && /chess\s+at night/.test(facts), facts.slice(0, 300));
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
  }
  // A custom-format dump (PGDMP): without pg_restore on PATH it is listed as unreadable, with the reason.
  const custom = join(root, 'app.dump');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(custom, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64)]));
  if (spawnSync('pg_restore', ['--version']).status === 0) return; // pg_restore present: the real one would read it
  const noTools = collect(['collect', '--postgres-dump', custom, '--plan-only', '--json', '--lang', 'en'], root);
  assert.match(noTools.out + noTools.err, /needs pg_restore/);
});

test('collector: --schema-only lists names, types, keys and counts and reads no row', { skip: NO_PY }, () => {
  const m = mindBundle();
  const r = collect(['collect', '--scan', join(m.root, 'agent'), '--plan-only', '--json', '--schema-only', '--lang', 'en'], m.root);
  assert.equal(r.status, 0, r.err);
  const plan = JSON.parse(r.out) as { stores: { tables: { name: string; rows: number; columns: { name: string; type: string }[] }[] }[] };
  const persons = plan.stores[0].tables.find((t) => t.name === 'persons')!;
  assert.equal(persons.rows, 12);
  assert.ok(persons.columns.some((c) => c.name === 'display_name' && /TEXT/i.test(c.type)));
  assert.ok(!r.out.includes(FACT_MARK) && !r.out.includes('Jordan'), 'no row value in a schema-only run');
  assert.equal(collect(['collect', '--scan', join(m.root, 'agent'), '--schema-only', '--lang', 'en'], m.root).status, 2, '--schema-only only goes with --plan-only');
});

test('collector: the built-in Postgres client and dump reader are stdlib only (Python 3.6)', () => {
  const src = readFileSync(COLLECTOR, 'utf8');
  assert.doesNotMatch(src, /\bimport (psycopg|asyncpg|pg8000|requests)\b|from (psycopg|asyncpg|pg8000) /);
  assert.doesNotMatch(src, /(^|[^\w'"])f'[^']*\{|(^|[^\w'"])f"[^"]*\{/m, 'no f-strings');
  assert.match(src, /^VERSION = '2\.38\.0'/m);
  assert.match(src, /SCRAM-SHA-256/);
  assert.match(src, /READ ONLY/);
});

// -------------------------------------------------------------------------------------------------
// Routes and UI
// -------------------------------------------------------------------------------------------------
test('routes: cards, propose, confirm, skip and saved mappings are owner-only and answer', { skip: NO_PY }, async (t) => {
  const { OwnerAuth } = await import('../src/auth.ts');
  const { createSaraServer } = await import('../src/server.ts');
  const m = mindBundle();
  const a = app('routes');
  a.settings.update({ disclosureAcceptedAt: new Date().toISOString() });
  const auth = new OwnerAuth(a.dataDir);
  const owner = auth.newToken!;
  const server = createSaraServer({ app: a, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => {
    a.moveIn?.close();
    server.close();
    a.store.close();
  });
  const call = async (method: string, path: string, body?: unknown, token: string | null = owner) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  a.moveIn = new MoveIn(() => a);
  const s = await a.moveIn.addFile(m.bundle);
  assert.equal((await call('GET', `/api/movein/bundles/${s.id}/cards`, undefined, null)).status, 401);
  const v = await call('GET', `/api/movein/bundles/${s.id}/cards?localOnly=1`);
  assert.equal(v.status, 200);
  assert.ok(v.json.cards.length >= 5);
  assert.equal((await call('POST', `/api/movein/bundles/${s.id}/cards/propose`, { useModel: false })).status, 202);
  await a.moveIn!.cardsIdle(s.id);
  const key = (await call('GET', `/api/movein/bundles/${s.id}/cards`)).json.cards.find((c: { family: { tables: string[] } }) => c.family.tables.join() === 'tasks').key;
  assert.equal((await call('POST', `/api/movein/bundles/${s.id}/cards/confirm`, { key })).status, 202);
  await a.moveIn!.cardsIdle(s.id);
  const other = (await call('GET', `/api/movein/bundles/${s.id}/cards`)).json.cards.find((c: { family: { tables: string[] } }) => c.family.tables.join() === 'opinions').key;
  assert.equal((await call('POST', `/api/movein/bundles/${s.id}/cards/skip`, { key: other })).json.card.state, 'skipped');
  const maps = await call('GET', '/api/movein/mappings');
  assert.equal(maps.json.mappings.length, 1);
  const ex = await fetch(`${base}/api/movein/mappings/export`, { headers: { authorization: `Bearer ${owner}` } });
  assert.match(String(ex.headers.get('content-disposition')), /sara-movein-mappings\.json/);
  assert.equal((await call('DELETE', `/api/movein/mappings/${maps.json.mappings[0].fingerprint}`)).json.deleted, true);
  assert.equal((await call('POST', `/api/movein/bundles/${s.id}/cards/pull`, { store: 'nope', table: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/movein/bundles/${s.id}/cards/reset`, { key: 'nope' })).status, 400);
});

test('UI: the mapping cards, saved mappings, tips, translations, help and a fresh cache', () => {
  const js = readFileSync(join(ROOT, 'web', 'movein.js'), 'utf8');
  for (const id of ['storesBox', 'mappingCard', 'renderMappings', "post('confirm')", "post('skip')", '/cards/edit', '/cards/propose', 'Only models on this computer', 'Looks right']) assert.ok(js.includes(id), id);
  assert.doesNotMatch(js, /\.style\.|innerHTML\s*=|alert\(/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="mi-mappings"/);
  assert.match(html, /href="\/api\/movein\/mappings\/export"/);
  const css = readFileSync(join(ROOT, 'web', 'movein.css'), 'utf8');
  assert.match(css, /\.mi-map \{/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgb\(/i);
  assert.match(readFileSync(join(ROOT, 'web', 'help.html'), 'utf8'), /<strong>Her old databases<\/strong>/);
  assert.match(readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8'), /caches\.open\('sara-shell-v39'\)/);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${l}.json`), 'utf8')) as Record<string, string>;
    for (const k of ['Her old databases', 'Ask her to map them', 'Only models on this computer']) assert.ok(d[k], `${l}: ${k}`);
  }
  for (const f of ['src/movein/schema.ts', 'src/movein/mapping.ts', 'src/movein/custom.ts', 'src/movein/cards.ts', 'src/movein/readers/custom.ts', 'web/movein.js', 'web/movein.css', 'scripts/sara-movein.py', 'test/fake-postgres.ts']) assert.ok(!readFileSync(join(ROOT, f), 'utf8').includes('\r\n'), `${f}: LF`);
  assert.ok(existsSync(join(ROOT, 'test', 'fake-postgres.ts')));
  void FAKE;
});
