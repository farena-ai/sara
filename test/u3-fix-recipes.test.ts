// ROADMAP_U U3.17 (docs/SELF_REPAIR.md "Share fixes that worked"): when the owner allows it (off by default,
// and per linked friend), a fix that worked here (T1 level 1/2, or an applied T3 code change) is offered to
// linked servers as a signed "fix recipe": a problem signature (the problem id and the shape of its
// evidence, never private values) + the fix (T1 playbook id, or the code patch with its test results) + the
// sender's version. The receiving server shows it only when it has the same problem on a compatible
// version, as a proposal through its own engines (normal approval, undo, rollback); nothing auto-applies.
// Code patches pass the receiver's own protected-path / test-weakening checks and tests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cleanRecipe, codeRecipe, compatible, matchProblem, playbookRecipe, signatureOf } from '../src/fix-recipes.ts';
import type { Problem } from '../src/repair.ts';
import { makePatch, SelfCode } from '../src/self-code.ts';
import { signSupport } from '../src/support.ts';
import { checksOk, clock, linkPair, pairNode, until } from './helpers-repair-pair.ts';
import { tempDir } from './helpers.ts';

const at = new Date('2026-11-16T12:00:00Z');
const P = (x: Partial<Problem> & { id: string }): Problem => ({ level: 1, severity: 'medium', text: 'x', evidence: [], fixable: true, ...x });

test('U3.17: signatures keep the problem kind and evidence shape, never private values', () => {
  // Built at run time: nothing here looks like a real secret or id.
  const label = ['Call', 'Dr.', 'Rivera', 'about', 'results'].join(' ');
  const goal = ['Book', 'flights', 'to', 'Lisbon'].join(' ');
  const ps = [
    P({ id: 'job:17', text: 'The background job “{label}” has been running for {min} minutes.', params: { label, min: 93 }, evidence: ['started 2026-11-16T10:00:00.000Z'] }),
    P({ id: 'errand:4', text: 'e', params: { goal, h: 30 }, evidence: ['last change 2026-11-15T01:02:03.000Z'] }),
    P({ id: 'model:home-box-7', text: 'm', params: { service: 'home-box-7' }, evidence: ['down'] }),
    P({ id: 'setting:fallbackAfterSec', params: { path: 'fallbackAfterSec', value: '"rivera-lisbon"' }, evidence: ['now "rivera-lisbon"', 'default 60'] }),
    P({ id: 'addon:weather', params: { name: 'Weather', version: '1.0.0' }, evidence: ['crashed'] }),
    P({ id: 'grow:tool:web_fetch', level: 2, params: { tool: 'web_fetch', n: 4 }, evidence: ['4× web_fetch'] }),
    P({ id: 'app:phone-of-hank', params: { label: 'Hank’s phone', version: '3.1' }, evidence: ['update state: failed'] }),
  ];
  const sigs = ps.map(signatureOf);
  assert.deepEqual(
    sigs.map((s) => s?.problem),
    ['job', 'errand', 'model', 'setting:fallbackAfterSec', 'addon:weather', 'grow:tool:web_fetch', 'app'],
  );
  assert.deepEqual(sigs[0]!.shape, ['started <time>']);
  assert.deepEqual(sigs[3]!.shape, ['*', 'default #']);
  assert.deepEqual(sigs[5]!.shape, ['#× web_fetch']);
  assert.equal(signatureOf(P({ id: 'signin:google', fixable: false })), undefined, 'only fixable problems have recipes');
  // A whole recipe never carries params, texts, evidence values or the problem's number.
  const wire = JSON.stringify(ps.map((p) => playbookRecipe(p, '3.20.0', at)));
  for (const secret of [label, goal, 'home-box-7', 'rivera-lisbon', 'Hank', 'phone-of-hank', '2026-11-16T10', 'job:17', '93']) assert.ok(!wire.includes(secret), `${secret} must not leave`);
});

test('U3.17: matching needs the same signature, a fixable problem and a compatible version', () => {
  const r = playbookRecipe(P({ id: 'addon:weather', evidence: ['crashed'] }), '3.20.1', at)!;
  assert.equal(matchProblem(r, [P({ id: 'addon:weather', evidence: ['crashed'] })])?.id, 'addon:weather');
  assert.equal(matchProblem(r, [P({ id: 'addon:news', evidence: ['crashed'] })]), undefined, 'another add-on is another problem');
  assert.equal(matchProblem(r, [P({ id: 'addon:weather', evidence: ['crashed', 'extra'] })]), undefined, 'evidence shape differs');
  assert.equal(matchProblem(r, [P({ id: 'addon:weather', evidence: ['crashed'], fixable: false })]), undefined);
  // Kind-only signatures match any instance of that kind on the receiver (its own job / errand).
  const j = playbookRecipe(P({ id: 'job:3', evidence: ['started 2026-11-16T10:00:00.000Z'] }), '3.20.1', at)!;
  assert.equal(matchProblem(j, [P({ id: 'job:44', evidence: ['started 2026-11-14T08:00:00.000Z'] })])?.id, 'job:44');
  // Versions: playbook fixes need the same major.minor; code patches the exact version they were tested on.
  assert.equal(compatible(r, '3.20.4'), true);
  assert.equal(compatible(r, '3.21.0'), false);
  assert.equal(compatible(r, '4.20.1'), false);
  assert.equal(compatible(r, ''), false);
  const c = codeRecipe({ id: 2, status: 'applied', diff: makePatch([{ path: 'src/greet.ts', before: 'a\n', after: 'b\n' }]), files: ['src/greet.ts'], checks: checksOk } as never, '3.20.1', at, (s) => s)!;
  assert.equal(compatible(c, '3.20.1'), true);
  assert.equal(compatible(c, '3.20.2'), false);
  // The receiver checks the shape itself.
  assert.throws(() => cleanRecipe({ v: 1, kind: 'shell', version: '3.20.1' }));
  assert.throws(() => cleanRecipe({ ...r, signature: { ...r.signature, problem: 'x y; rm -rf' } }));
  assert.deepEqual(cleanRecipe(JSON.parse(JSON.stringify(r))), r);
});

test('U3.17: a code recipe carries the patch, file names, test names/results and version only; a patch that looks private is not shared', () => {
  const diff = makePatch([{ path: 'src/greet.ts', before: "return 'Helo';\n", after: "return 'Hello';\n" }]);
  const c = codeRecipe({ id: 5, status: 'applied', request: 'Hank says Rivera saw it', summary: 'Fixed for Hank', diff, files: ['src/greet.ts'], checks: { ...checksOk, steps: checksOk.steps.map((s) => ({ ...s, detail: 'C:/Users/hank' })) } } as never, '3.20.1', at, (s) => s)!;
  const wire = JSON.stringify(c);
  for (const x of ['Hank', 'Rivera', 'C:/Users']) assert.ok(!wire.includes(x));
  assert.deepEqual(c.checks, [{ name: 'typecheck', ok: true }, { name: 'related', ok: true }, { name: 'full', ok: true, skipped: true }]);
  assert.equal(codeRecipe({ id: 6, status: 'proposed', diff, files: [], checks: checksOk } as never, '3.20.1', at, (s) => s), undefined, 'only applied changes');
  assert.equal(codeRecipe({ id: 7, status: 'applied', diff, files: [], checks: checksOk } as never, '3.20.1', at, (s) => s.replace('Hello', '[REDACTED]')), undefined, 'the scrubber would change it: not shared');
});

test('U3.17: the receiver adopts a code patch only through its own rules and tests (protected paths, test weakening)', async (t) => {
  const tmp = tempDir();
  t.after(() => tmp.cleanup());
  const root = join(tmp.dir, 'root');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fake","version":"3.20.1"}\n');
  writeFileSync(join(root, 'src', 'greet.ts'), "export const greet = () => 'Helo';\n");
  writeFileSync(join(root, 'src', 'budget.ts'), 'export const CAP = 5;\n');
  writeFileSync(join(root, 'test', 'greet.test.ts'), "import assert from 'node:assert/strict';\nassert.ok(1);\nassert.ok(2);\n");
  const dataDir = join(tmp.dir, 'data');
  mkdirSync(dataDir);
  const db = new DatabaseSync(join(dataDir, 'sc.db'));
  t.after(() => db.close());
  let checked = 0;
  const sc = new SelfCode({ root, dataDir, db, now: () => at, info: () => ({ kind: 'source', level3: true, root, git: false, mode: 'relaunch' }), version: () => '3.20.1', checks: async () => (checked++, checksOk), settings: () => ({ capUsd: 1, minutes: 5, permission: 'ask', fullUntil: null }), audit: () => {} });
  const good = makePatch([{ path: 'src/greet.ts', before: "export const greet = () => 'Helo';\n", after: "export const greet = () => 'Hello';\n" }]);
  assert.equal(sc.fits(good), true);
  const c = sc.adopt('A fix shared by Sam’s Sara', good);
  await sc.idle();
  const done = sc.get(c.id)!;
  assert.equal(done.status, 'proposed', 'tested here, then it waits for the owner’s OK like any code change');
  assert.equal(checked, 1, 'her own tests ran');
  assert.equal(readFileSync(join(root, 'src', 'greet.ts'), 'utf8'), "export const greet = () => 'Helo';\n", 'nothing is applied by adopting');
  // Protected paths and weaker tests are refused on the receiver, whatever the sender said.
  const prot = makePatch([{ path: 'src/budget.ts', before: 'export const CAP = 5;\n', after: 'export const CAP = 500;\n' }]);
  assert.equal(sc.get(sc.adopt('shared', prot).id)!.status, 'refused');
  assert.match(sc.get(sc.list()[0]!.id)!.note ?? '', /hard limits/);
  const weak = makePatch([{ path: 'test/greet.test.ts', before: "import assert from 'node:assert/strict';\nassert.ok(1);\nassert.ok(2);\n", after: "import assert from 'node:assert/strict';\n" }]);
  await sc.idle();
  assert.equal(sc.get(sc.adopt('shared', weak).id)!.status, 'refused');
  // A patch that does not fit this code (different code = not the same problem) is never offered.
  const other = makePatch([{ path: 'src/greet.ts', before: "export const greet = () => 'Hi';\n", after: "export const greet = () => 'Hey';\n" }]);
  assert.equal(sc.fits(other), false);
  assert.equal(sc.fits(good.replace(/'Helo'/g, "'Helo'")), true);
  await sc.idle();
});

test('U3.17: off by default; on + friend ticked → a fix that worked is offered; shown only to a server with the same problem; needs approval; undo works', async (t) => {
  const hank = await pairNode(t, 'Hank');
  const sam = await pairNode(t, 'Sam');
  const kim = await pairNode(t, 'Kim', { addon: false });
  const hs = await linkPair(hank, sam);
  const hk = await linkPair(hank, kim);
  const samNotes: string[] = [];
  sam.m.onNotify = (title, body) => samNotes.push(`${title}: ${body}`);
  // Off by default: a fix that worked is not offered.
  assert.equal((await hank.req('GET', '/api/repair')).settings.share, false);
  await hank.req('POST', '/api/repair/fix', { problem: 'addon:weather' });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await sam.req('GET', '/api/remote-repair/recipes')).in.length, 0);
  // Members of the per-friend list only.
  assert.equal((await hank.raw('PUT', '/api/repair/settings', { share: true, shareLinks: ['not-a-link'] })).status, 400);
  await hank.req('PUT', '/api/repair/settings', { share: true, shareLinks: [hs.aLink, hk.aLink] });
  hank.fx.st.addons[0]!.status = 'crashed';
  hank.fx.st.addons[0]!.enabled = true;
  await hank.req('POST', '/api/repair/check');
  await hank.req('POST', '/api/repair/fix', { problem: 'addon:weather' });
  const r = await until(async () => {
    const x = (await sam.req('GET', '/api/remote-repair/recipes')).in;
    return x.length && x;
  }, 'recipe at Sam');
  assert.equal(r[0].kind, 'playbook');
  assert.equal(r[0].peer, 'Hank');
  assert.equal(r[0].problem, 'addon:weather', 'shown with the receiver’s own problem');
  assert.equal(r[0].text, 'The add-on {name} {version} stopped working.');
  assert.ok(samNotes.some((n) => /Hank/.test(n)), 'Sam is told (he has the same problem)');
  // Kim has no such problem: nothing is shown (and no notice).
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await kim.req('GET', '/api/remote-repair/recipes')).in.length, 0);
  // Nothing ran at Sam yet.
  assert.equal(sam.fx.st.addons[0]!.status, 'crashed');
  assert.equal(sam.fx.rep.runs().length, 0);
  // The sender sees what went where (one offer per friend; a second success does not send again).
  const sent = (await hank.req('GET', '/api/remote-repair/recipes')).sent;
  assert.deepEqual(sent.map((s: any) => s.peer).sort(), ['Kim', 'Sam']);
  // Sam approves: his own T1 engine runs his own playbook, with his undo.
  const used = await sam.req('POST', `/api/remote-repair/recipes/${r[0].id}/accept`, {});
  assert.equal(used.recipe.status, 'used');
  const run = sam.fx.rep.runs()[0]!;
  assert.equal(run.problem, 'addon:weather');
  assert.equal(run.by, 'link:Hank');
  assert.equal(run.result, 'fixed');
  assert.equal(sam.fx.st.addons[0]!.enabled, false);
  await sam.req('POST', `/api/repair/runs/${run.id}/undo`);
  assert.equal(sam.fx.st.addons[0]!.enabled, true, 'normal undo');
  // A fix Sam ran from Hank's recipe is not shared on again (no loops), and accepting twice is refused.
  assert.equal((await sam.raw('POST', `/api/remote-repair/recipes/${r[0].id}/accept`, {})).status, 409);
  // Both help logs record it.
  assert.ok((await hank.req('GET', '/api/support')).log.some((x: any) => x.kind === 'repair-recipe'));
  assert.ok((await sam.req('GET', '/api/support')).log.some((x: any) => x.kind === 'repair-recipe'));
});

test('U3.17: version mismatch and unknown links are refused; code recipes become a T3 proposal; private local mode sends nothing', async (t) => {
  const hank = await pairNode(t, 'Hank');
  const sam = await pairNode(t, 'Sam');
  const { aLink, bLink } = await linkPair(hank, sam);
  const key = hank.m.privateKeyFor(aLink)!;
  const post = (op: string, body: unknown) => {
    // The wire adds a request id (replay guard), as SupportLink.call does.
    const s = JSON.stringify({ id: randomUUID(), ...(body as object) });
    return fetch(`${sam.base}/msg/v1/repair/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(aLink, op, s, key, clock.now, 'repair') }, body: s });
  };
  const version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  const [maj, min] = version.split('.').map(Number);
  // A recipe from another minor version: stored but never shown, and Accept is refused.
  const old = playbookRecipe(P({ id: 'addon:weather', evidence: ['crashed'] }), `${maj}.${min! + 1}.0`, at)!;
  assert.equal((await post('recipe', old)).status, 200);
  assert.equal((await sam.req('GET', '/api/remote-repair/recipes')).in.length, 0);
  // A 'support'-scope signature never passes here.
  const s = JSON.stringify({ id: randomUUID(), ...old });
  assert.equal((await fetch(`${sam.base}/msg/v1/repair/recipe`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(aLink, 'recipe', s, key, clock.now) }, body: s })).status, 401);
  // A bad shape is refused.
  assert.equal((await post('recipe', { v: 1, kind: 'shell', version })).status, 400);
  // A code recipe on the same version: shown when the patch fits; Accept makes a T3 change through Sam's own engine.
  const diff = makePatch([{ path: 'src/greet.ts', before: 'a\n', after: 'b\n' }]);
  const cr = codeRecipe({ id: 3, status: 'applied', diff, files: ['src/greet.ts'], checks: checksOk } as never, version, at, (x) => x)!;
  assert.equal((await post('recipe', cr)).status, 200);
  const shown = (await sam.req('GET', '/api/remote-repair/recipes')).in;
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].files, ['src/greet.ts']);
  assert.deepEqual(shown[0].checks.map((c: any) => c.name), ['typecheck', 'related', 'full']);
  assert.equal(sam.code.adopted.length, 0, 'nothing before the OK');
  const used = await sam.req('POST', `/api/remote-repair/recipes/${shown[0].id}/accept`, {});
  assert.equal(sam.code.adopted.length, 1);
  assert.equal(sam.code.adopted[0]!.patch, diff);
  assert.equal(used.recipe.change, 1, 'a T3 change: prepared and tested there, then the normal Apply/Undo/rollback');
  // When the patch no longer fits (or another version): hidden.
  (sam.code as any).fits = () => false;
  assert.equal((await post('recipe', { ...cr, id: 'another' })).status, 200);
  assert.equal((await sam.req('GET', '/api/remote-repair/recipes')).in.filter((x: any) => x.status === 'new').length, 0);
  // Private local mode on the sender: nothing leaves.
  await hank.req('PUT', '/api/repair/settings', { share: true, shareLinks: [aLink] });
  const { setPrivateLocal } = await import('../src/net-guard.ts');
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  await hank.req('POST', '/api/repair/fix', { problem: 'addon:weather' });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await hank.req('GET', '/api/remote-repair/recipes')).sent.length, 0);
  void bLink;
});

test('U3.17: "Send to the Sara developers" shows the scrubbed preview first and sends exactly that', async (t) => {
  const hank = await pairNode(t, 'Hank');
  const sam = await pairNode(t, 'Sam');
  const { aLink } = await linkPair(hank, sam);
  await hank.req('PUT', '/api/repair/settings', { share: true, shareLinks: [aLink] });
  await hank.req('POST', '/api/repair/fix', { problem: 'addon:weather' });
  const sent = await until(async () => {
    const x = (await hank.req('GET', '/api/remote-repair/recipes')).sent;
    return x.length && x;
  }, 'sent');
  const r = await hank.req('GET', `/api/remote-repair/recipes/${sent[0].id}/report`);
  assert.match(r.preview.title, /addon:weather/);
  assert.doesNotMatch(JSON.stringify(r.preview), /Hank|Sam/);
  // No hub on this fixture: sending is refused plainly (the hub path is the T3 one).
  assert.equal((await hank.raw('POST', `/api/remote-repair/recipes/${sent[0].id}/report`, {})).status, 409);
});
