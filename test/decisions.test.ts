// E5 (docs/DECISIONS_HELPER.md): the decision helper and side-by-side comparisons. The math is
// deterministic code (ratings and raw values with units, direction, weights, ties, close calls,
// sensitivity); decisions are saved in each person's own space, recorded, reminded and reviewed;
// comparisons never invent a value; the chat card and the lean picker find them in six languages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createSaraServer } from '../src/server.ts';
import { cardFor } from '../src/cards.ts';
import { compareTable, createDecisionTools, DecisionStore, parseValue, scoreDecision, type DecisionInput } from '../src/decisions.ts';
import { familyOf, leanFor, DEFAULT_LEAN, searchTools } from '../src/lean.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const car: DecisionInput = {
  question: 'Which car should I buy?',
  options: ['Civic', 'Corolla', 'Model 3'],
  criteria: [
    { name: 'Price', weight: 5, higher_is_better: false },
    { name: 'Comfort', weight: 3 },
    { name: 'Range', weight: 2 },
  ],
  scores: {
    Civic: { Price: { value: '$24,000', source: 'honda.com' }, Comfort: { value: 7, source: 'you' }, Range: { value: '400 mi', source: 'estimate' } },
    Corolla: { Price: { value: '$22,000', source: 'toyota.com' }, Comfort: { value: 6, source: 'you' }, Range: { value: '450 mi', source: 'estimate' } },
    'Model 3': { Price: { value: '$40,000', source: 'tesla.com' }, Comfort: { value: 9, source: 'you' }, Range: { value: '330 mi', source: 'tesla.com' } },
  },
};

test('parseValue reads numbers with units, money and ratings', () => {
  assert.deepEqual(parseValue('$24,000'), { n: 24000, unit: '$' });
  assert.deepEqual(parseValue('400 mi'), { n: 400, unit: 'mi' });
  assert.deepEqual(parseValue(7), { n: 7, unit: '' });
  assert.deepEqual(parseValue('4.5 stars'), { n: 4.5, unit: 'stars' });
  assert.deepEqual(parseValue('1.2k'), { n: 1200, unit: '' });
  assert.equal(parseValue('great'), null);
  assert.equal(parseValue(''), null);
});

test('scoreDecision: min-max per raw criterion, direction aware, weighted totals', () => {
  const r = scoreDecision(car);
  // Price (lower better): Corolla 1, Civic (40000-24000)/18000, Model 3 0.
  const price = (o: string) => r.rows.find((x) => x.option === o)!.cells.find((c) => c.criterion === 'Price')!.norm;
  assert.equal(price('Corolla'), 1);
  assert.equal(price('Model 3'), 0);
  assert.ok(Math.abs(price('Civic') - 16000 / 18000) < 1e-9);
  // Comfort is a 1–10 rating: (v-1)/9, not min-max.
  const comfort = r.rows.find((x) => x.option === 'Civic')!.cells.find((c) => c.criterion === 'Comfort')!;
  assert.ok(Math.abs(comfort.norm - 6 / 9) < 1e-9);
  assert.equal(comfort.kind, 'rating');
  // Totals are the weighted mean × 100; ranked best first.
  const corolla = r.rows.find((x) => x.option === 'Corolla')!;
  const expect = ((5 * 1 + 3 * (5 / 9) + 2 * 1) / 10) * 100;
  assert.ok(Math.abs(corolla.total - expect) < 1e-6);
  assert.equal(r.rows[0].option, 'Corolla');
  assert.equal(r.rows[0].rank, 1);
  assert.deepEqual(r.rows.map((x) => x.rank), [1, 2, 3]);
  // Sources: "you said", "from <source>", estimates flagged.
  assert.equal(comfort.source, 'you said');
  const est = r.rows.find((x) => x.option === 'Civic')!.cells.find((c) => c.criterion === 'Range')!;
  assert.equal(est.source, 'my estimate');
  assert.equal(est.estimate, true);
  assert.equal(r.rows.find((x) => x.option === 'Civic')!.cells.find((c) => c.criterion === 'Price')!.source, 'from honda.com');
  assert.equal(r.estimates, 2);
});

test('scoreDecision: higher-is-better flips, equal values, missing scores and ties', () => {
  const r = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 3 }, { name: 'Y', weight: 3 }], scores: { A: { X: 8, Y: 2 }, B: { X: 2, Y: 8 } } });
  assert.equal(r.rows[0].total, r.rows[1].total);
  assert.deepEqual(r.rows.map((x) => x.rank), [1, 1], 'a tie shares the rank');
  assert.equal(r.tie, true);
  assert.equal(r.closeCall, true);
  const same = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'Cost', weight: 2, higher_is_better: false }], scores: { A: { Cost: '$5' }, B: { Cost: '$5' } } });
  assert.equal(same.rows[0].cells[0].norm, same.rows[1].cells[0].norm, 'equal raw values score the same');
  const miss = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 1 }, { name: 'Y', weight: 1 }], scores: { A: { X: 9, Y: 9 }, B: { X: 9 } } });
  assert.equal(miss.missing.length, 1);
  assert.deepEqual(miss.missing[0], { option: 'B', criterion: 'Y' });
  assert.equal(miss.rows.find((x) => x.option === 'B')!.cells.find((c) => c.criterion === 'Y')!.norm, 0, 'missing counts as zero (and is said)');
  // Array form of scores works the same.
  const arr = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 1 }], scores: [{ option: 'A', criterion: 'X', value: 9, source: 'you' }, { option: 'b', criterion: 'x', value: 3, source: 'you' }] });
  assert.equal(arr.rows[0].option, 'A');
  assert.equal(arr.missing.length, 0, 'option and criterion names match case-insensitively');
  assert.throws(() => scoreDecision({ question: 'q', options: ['A'], criteria: [{ name: 'X', weight: 1 }] }), /at least two options/);
  assert.throws(() => scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [] }), /criteria/);
  assert.throws(() => scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 9 }] }), /weight/);
});

test('scoreDecision: close call within 5%, sensitivity to weights ±1 and to the closest swap', () => {
  // A wins on X (weight 3), B on Y (weight 2): a weight move flips it.
  const r = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 3 }, { name: 'Y', weight: 2 }], scores: { A: { X: 9, Y: 4 }, B: { X: 5, Y: 9 } } });
  assert.equal(r.rows[0].option, 'A');
  assert.ok(r.flips.some((f) => f.kind === 'weight' && f.criterion === 'X' && f.delta === -1 && f.winner === 'B'), JSON.stringify(r.flips));
  assert.ok(r.flips.some((f) => f.kind === 'weight' && f.criterion === 'Y' && f.delta === 1 && f.winner === 'B'));
  assert.equal(r.robust, false);
  // Deciding factors: where the winner gains and where the runner-up does.
  assert.equal(r.factors[0].criterion, 'X');
  assert.ok(r.factors[0].points > 0);
  assert.ok(r.factors.some((f) => f.criterion === 'Y' && f.points < 0));
  // A clear winner: no flips, not a close call.
  const clear = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 3 }, { name: 'Y', weight: 2 }], scores: { A: { X: 9, Y: 9 }, B: { X: 3, Y: 4 } } });
  assert.equal(clear.closeCall, false);
  assert.equal(clear.robust, true);
  assert.deepEqual(clear.flips, []);
  // Within 5%: a close call; swapping their closest scores flips it.
  const close = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 1 }, { name: 'Y', weight: 1 }], scores: { A: { X: 8, Y: 7 }, B: { X: 7, Y: 7.5 } } });
  assert.equal(close.closeCall, true);
  assert.ok(close.flips.some((f) => f.kind === 'swap'), JSON.stringify(close.flips));
  // A wide lead (two raw prices are always 0 and 1) is not a "close score" to swap.
  const wide = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'Price', weight: 4, higher_is_better: false }, { name: 'Fun', weight: 3 }], scores: { A: { Price: '$300', Fun: 8 }, B: { Price: '$250', Fun: 6 } } });
  assert.ok(!wide.flips.some((f) => f.kind === 'swap'));
  // Weights clamp at 1..5 (weight 5 never tries 6).
  const top = scoreDecision({ question: 'q', options: ['A', 'B'], criteria: [{ name: 'X', weight: 5 }, { name: 'Y', weight: 1 }], scores: { A: { X: 9, Y: 1 }, B: { X: 1, Y: 9 } } });
  assert.ok(!top.flips.some((f) => f.kind === 'weight' && ((f.criterion === 'X' && f.delta === 1) || (f.criterion === 'Y' && f.delta === -1))));
});

test('compareTable: provided values only, missing marked, rows accepted as they come', () => {
  const t = compareTable({ items: [{ name: 'Plan A', values: { Price: '$10/mo', Data: '5 GB' }, source: 'a.com' }, { name: 'Plan B', Price: '$12/mo' }, 'Plan C'], attributes: ['Price', 'Data'] });
  assert.deepEqual(t.attributes, ['Price', 'Data']);
  assert.equal(t.rows[0].cells[0].value, '$10/mo');
  assert.equal(t.rows[1].cells[0].value, '$12/mo', 'flat rows (find_product) work');
  assert.equal(t.rows[1].cells[1].value, null);
  assert.equal(t.rows[2].cells.every((c) => c.value === null), true);
  assert.equal(t.missing, 3);
  assert.match(t.text, /\| Plan B \| \$12\/mo \| — \|/);
  assert.match(t.text, /3 values missing/);
  // Attributes default to the keys the rows have.
  const auto = compareTable({ items: [{ name: 'X', price: 3, store: 'Y' }, { name: 'Z', price: 4 }] });
  assert.deepEqual(auto.attributes, ['price', 'store']);
  assert.throws(() => compareTable({ items: [] }), /items/);
});

function setup(dir: string, now = new Date('2026-11-13T15:00:00Z')) {
  const clock = { now };
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'UTC' } as never);
  const tools = Object.fromEntries(createDecisionTools(() => app).map((t) => [t.spec.name, t]));
  const ctx = { conversationId: 'c1' } as never;
  return { app, tools, ctx, clock };
}

test('decide saves the decision; record, revisit reminder, review and "last time" recall', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { app, tools, ctx } = setup(dir);
  const out = String(await tools.decide.run(car as never, ctx));
  assert.match(out, /Decision #1 saved/);
  assert.match(out, /1\. Corolla/);
  assert.match(out, /my estimate/);
  assert.match(out, /pre-mortem/i);
  assert.match(out, /How to undo/i);
  const store = new DecisionStore(app.store.db, () => app.now());
  assert.equal(store.get(1)!.status, 'open');
  const rec = String(await tools.decision_record.run({ id: 1, chosen: 'corolla', why: 'cheapest and reliable', revisit: '2027-05-01' } as never, ctx));
  assert.match(rec, /Recorded: Corolla/);
  const d = store.get(1)!;
  assert.equal(d.chosen, 'Corolla');
  assert.equal(d.status, 'chosen');
  assert.ok(d.reminderId);
  const rem = app.planner!.reminder(d.reminderId!)!;
  assert.match(rem.text, /How did choosing Corolla work out\?/);
  assert.equal(rem.dueAt.slice(0, 10), '2027-05-01');
  await assert.rejects(async () => tools.decision_record.run({ id: 99, chosen: 'x' } as never, ctx), /No decision #99/);
  const rev = String(await tools.decision_review.run({ id: 1, outcome: 'No problems in six months.', rating: 5 } as never, ctx));
  assert.match(rev, /5\/5/);
  assert.equal(store.get(1)!.status, 'reviewed');
  await assert.rejects(async () => tools.decision_review.run({ id: 1, outcome: 'x', rating: 9 } as never, ctx), /rating/);
  const list = String(await tools.decision_list.run({} as never, ctx));
  assert.match(list, /#1 .*Which car should I buy\?.*chose Corolla.*5\/5/);
  // A later, similar decision recalls the last one.
  const again = String(await tools.decide.run({ ...car, question: 'Which car should I buy for my son?' } as never, ctx));
  assert.match(again, /Last time .*chose Corolla.*5\/5/);
});

test('decisions: each household space keeps its own', async (t) => {
  const a = tempDir();
  const b = tempDir();
  t.after(() => {
    a.cleanup();
    b.cleanup();
  });
  const owner = setup(a.dir);
  const member = setup(b.dir);
  await owner.tools.decide.run(car as never, owner.ctx);
  assert.match(String(await member.tools.decision_list.run({} as never, member.ctx)), /No decisions/);
  await assert.rejects(async () => member.tools.decision_record.run({ id: 1, chosen: 'Civic' } as never, member.ctx), /No decision #1/);
  assert.equal(new DecisionStore(owner.app.store.db, () => new Date()).get(1)!.chosen, null);
  const { MEMBER_ROUTES } = await import('../src/household.ts');
  assert.ok(MEMBER_ROUTES.has('decisions'), 'a member uses their own decisions');
});

test('cards: decide and compare draw from the real result; web card and styles follow the rules', () => {
  const card = cardFor({ name: 'decide', args: car as never, status: 'ok', output: 'Decision #7 saved (open).\n…' }) as { kind: string; id: number; rows: { option: string; pct: number }[]; closeCall: boolean };
  assert.equal(card.kind, 'decision');
  assert.equal(card.id, 7);
  assert.equal(card.rows[0].option, 'Corolla');
  assert.ok(card.rows[0].pct > card.rows[1].pct);
  assert.equal(cardFor({ name: 'decide', args: car as never, status: 'error', output: 'x' }), undefined);
  const cmp = cardFor({ name: 'compare', args: { items: [{ name: 'A', values: { p: 1 } }, { name: 'B' }], attributes: ['p'] }, status: 'ok', output: 'ok' }) as { kind: string; rows: { cells: (string | null)[] }[] };
  assert.equal(cmp.kind, 'compare');
  assert.deepEqual(cmp.rows[1].cells, [null]);
  const js = readFileSync(join(ROOT, 'web', 'decision-card.js'), 'utf8');
  assert.match(js, /export function decisionCard/);
  assert.match(js, /export function compareCard/);
  assert.match(js, /t\('Close call'\)/);
  assert.match(js, /t\('I chose this'\)/);
  assert.match(js, /t\('Save as document'\)/);
  assert.ok(!/style=|\.style\.(?!setProperty\('--)/.test(js), 'no inline styles (bars use a CSS variable)');
  assert.ok(!/innerHTML/.test(js), 'text only');
  const cards = readFileSync(join(ROOT, 'web', 'result-cards.js'), 'utf8');
  assert.match(cards, /decision: \(c\) => decisionCard\(c\)/);
  assert.match(cards, /compare: \(c\) => compareCard\(c\)/);
  const css = readFileSync(join(ROOT, 'web', 'decision.css'), 'utf8');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(css), 'theme variables only');
  assert.match(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'), /href="\/decision\.css"/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const k of ['Close call', 'I chose this', 'Save as document', 'Saved: {option}', 'missing', '{n} × my estimate']) assert.ok(tr[k], `${lang}: ${k}`);
  }
});

test('lean picker and find_tools find the decision tools in six languages', () => {
  const { dir, cleanup } = tempDir();
  try {
    const { tools } = setup(dir);
    const list = Object.values(tools);
    for (const tool of list) assert.equal(familyOf(tool).id, 'decisions');
    assert.equal(searchTools(list, 'help me decide')[0]?.tool.spec.name, 'decide');
    assert.equal(searchTools(list, 'compare these plans side by side')[0]?.tool.spec.name, 'compare');
    const lean = { ...DEFAULT_LEAN.tools, mode: 'always' as const };
    for (const msg of ['Should I take the job in Denver?', 'which is better, the iPad or the Surface', 'pros and cons of renting', 'Civic vs Corolla', 'ayúdame a decidir entre dos pisos', 'aide-moi à choisir entre ces deux offres', 'soll ich das Angebot annehmen, Vor- und Nachteile', 'devo escolher entre estes dois planos', 'aiutami a decidere tra queste due case', 'compare these two phones']) {
      const tt = leanFor(lean, list, { text: msg, mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
      assert.ok(tt.offeredNames(list).includes('decide'), msg);
    }
  } finally {
    cleanup();
  }
});

test('persona tells her to help decide, show the math and never fake data', async () => {
  const src = readFileSync(join(ROOT, 'src', 'persona.ts'), 'utf8');
  assert.match(src, /ctx\.tools\.includes\('decide'\)/);
  assert.match(src, /don't decide for/i);
  assert.match(src, /close call/i);
});

test('routes: I chose this and Save as document; the demo gets 403', async (t) => {
  for (const demo of [false, true]) {
    const { dir, cleanup } = tempDir();
    const { app, tools, ctx } = setup(dir);
    app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: app.now().toISOString() } as never);
    app.library = new LibraryStore(app.store.db, dir, () => app.now());
    await tools.decide.run(car as never, ctx);
    const auth = new OwnerAuth(dir);
    const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(demo ? { demo: true } : {}) } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.store.close();
      cleanup();
    });
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { Origin: base, authorization: ['Bearer', auth.newToken].join(' '), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    if (demo) {
      assert.equal((await api('/api/decisions')).status, 403);
      continue;
    }
    assert.equal((await api('/api/decisions')).body.decisions.length, 1);
    assert.equal((await api('/api/decisions/1/choose', 'POST', { chosen: 'Nope' })).status, 400, 'only one of the options');
    const chose = await api('/api/decisions/1/choose', 'POST', { chosen: 'Civic' });
    assert.equal(chose.status, 200);
    assert.equal(chose.body.decision.chosen, 'Civic');
    const doc = await api('/api/decisions/1/document', 'POST', {});
    assert.equal(doc.status, 200, JSON.stringify(doc.body));
    assert.match(doc.body.made.name, /\.docx$/);
    assert.equal((await api('/api/decisions/99')).status, 404);
  }
});
