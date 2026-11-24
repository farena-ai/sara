// Z6: the tool and routing evals (scripts/eval-tools.ts): how a model's first move is read and
// counted, that the case list is sound, and the routing fix the first run led to.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RESEARCH_RE } from '../src/chat.ts';
import { CASES } from '../scripts/eval-tools-cases.ts';
import { grade, readMove, report, ROUTE_MODELS, routeOfModel, summarize, type CaseResult } from '../scripts/eval-tools.ts';

test('Z6 evals: a model\'s first move is read from a streamed or a plain answer', () => {
  const stream = [
    'data: {"choices":[{"delta":{"content":"Let me "}}]}',
    'data: {"choices":[{"delta":{"content":"check."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"remind","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"todo","arguments":"{}"}}]}}]}',
    'data: not json',
    'data: [DONE]',
  ].join('\n\n');
  assert.deepEqual(readMove(stream), { calls: ['remind', 'todo'], text: 'Let me check.' });
  assert.deepEqual(readMove(JSON.stringify({ choices: [{ message: { content: ' 12 ', tool_calls: [{ function: { name: 'web_search' } }] } }] })), { calls: ['web_search'], text: '12' });
  assert.deepEqual(readMove(JSON.stringify({ choices: [{ message: { content: 'Twelve.' } }] })), { calls: [], text: 'Twelve.' });
  assert.deepEqual(readMove('<html>502</html>'), { calls: [], text: '' });
});

test('Z6 evals: how a first move counts', () => {
  const want = { want: ['remind'], alsoFine: ['todo'] };
  assert.equal(grade(want, { calls: ['remind'], text: '' }), 'right');
  assert.equal(grade(want, { calls: ['todo'], text: '' }), 'right', 'another fine first move');
  assert.equal(grade(want, { calls: ['recall', 'remind'], text: '' }), 'right', 'the wanted tool among several');
  assert.equal(grade(want, { calls: ['find_tools'], text: '' }), 'looked', 'she went looking for a tool: slower, not wrong');
  assert.equal(grade(want, { calls: ['web_search'], text: '' }), 'wrong');
  assert.equal(grade(want, { calls: [], text: 'I will remind you.' }), 'none', 'a promise without the tool');
  // Just talking: no tool is the right move.
  assert.equal(grade({ want: [] }, { calls: [], text: 'Sorry you slept badly.' }), 'right');
  assert.equal(grade({ want: [] }, { calls: ['web_search'], text: '' }), 'wrong');
  assert.equal(grade({ want: [], alsoFine: ['recall'] }, { calls: ['recall'], text: '' }), 'right');
});

test('Z6 evals: the summary and the report say what happened', () => {
  const seen = (n: number) => ({ model: ROUTE_MODELS.chat, tools: Array.from({ length: n }, (_, i) => `t${i}`), toolChars: n * 400, systemChars: 1000 });
  const results: CaseResult[] = [
    { id: 'a', text: 'remind me', want: ['remind'], offered: true, route: 'chat', routeOk: true, seen: seen(20), move: { calls: ['remind'], text: '' }, verdict: 'right' },
    { id: 'b', text: 'the | score', want: ['sports_scores'], offered: false, route: 'chat', routeOk: 'n/a', seen: seen(24), move: { calls: ['find_tools'], text: '' }, verdict: 'looked' },
    { id: 'c', text: 'hello', want: [], offered: 'n/a', route: 'research', routeOk: false, seen: seen(30), move: { calls: [], text: 'hi' }, verdict: 'right' },
  ];
  const s = summarize(results);
  assert.deepEqual(s.offer, { asked: 2, offered: 1 });
  assert.deepEqual(s.route, { asked: 2, right: 1 });
  assert.deepEqual(s.choice, { right: 2, looked: 1, wrong: 0, none: 0, error: 0 });
  assert.deepEqual(s.toolsOffered, { median: 24, max: 30 });
  const md = report(results, { version: '9.9.9', at: '2026-11-23T00:00:00Z', model: 'm' });
  assert.match(md, /in 1 of 2 cases \(50%\)/);
  assert.match(md, /first move was right in 2 of 3 \(67%\)/);
  assert.match(md, /\| b \| the \/ score \| sports_scores \| not offered; model: looked \(find_tools\) \|/);
  assert.match(md, /\| c \| hello \| no tool \| went to research \|/);
  // Without a model there is no choice line.
  const plain = report(results.map(({ move: _m, verdict: _v, ...r }) => r), { version: '9.9.9', at: 'x' });
  assert.ok(!plain.includes('**Choice:**'));
  assert.match(plain, /no model \(offer and route only\)/);
  assert.equal(routeOfModel(ROUTE_MODELS.research), 'research');
  assert.equal(routeOfModel('something-else'), 'other');
});

test('Z6 evals: the case list is sound', () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(CASES.length >= 60);
  const NAME = /^[a-z][a-z0-9_]*$/;
  for (const c of CASES) {
    assert.match(c.id, /^[a-z0-9-]+$/, c.id);
    assert.ok(c.text.trim().length > 8, c.id);
    for (const n of [...c.want, ...(c.alsoFine ?? [])]) assert.match(n, NAME, `${c.id}: ${n}`);
    if (c.route) assert.ok(c.route in ROUTE_MODELS, c.id);
    if (c.coding) assert.equal(c.route, 'coding', c.id);
  }
  assert.ok(CASES.filter((c) => !c.want.length).length >= 5, 'cases where no tool is the right move');
  assert.ok(CASES.filter((c) => c.id.startsWith('h-')).length >= 15, 'held-out cases');
  assert.ok(CASES.filter((c) => /[^\x00-\x7f]/.test(c.text)).length >= 5, 'other languages');
});

test('Z6 routing: research asks in six languages go to research; the word as a thing someone does stays in chat', () => {
  const yes = [
    'Research the best budget e-readers and what people are saying about them.',
    'can you research heat pumps for me',
    'I need you to research this properly',
    'Look up how much a heat pump costs to run.',
    'find out when the store closes',
    'Investiga cuáles son los mejores lectores electrónicos baratos.',
    'Recherchiere bitte, was eine Wärmepumpe im Betrieb kostet.',
    'Recherche les meilleurs vélos électriques',
    'Pesquise os melhores celulares baratos',
    'Fai una ricerca sui migliori telefoni',
  ];
  const no = [
    'My brother does cancer research in Boston, I am so proud of him.',
    'I did some research on my family tree over the weekend, it was fun.',
    'The research shows it works.',
    'She got a research grant!',
    'La recherche avance bien.',
    'A pesquisa foi boa.',
    'What is 15 percent of 80?',
  ];
  for (const t of yes) assert.ok(RESEARCH_RE.test(t), `research: ${t}`);
  for (const t of no) assert.ok(!RESEARCH_RE.test(t), `not research: ${t}`);
});
