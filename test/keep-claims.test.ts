// 3.4.2: "I saved / noted / recorded / added it" about the owner's records, with no note (or file)
// tool in that turn, is a claim the reply check flags ("Not checked"), in plain chat too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { checkClaims, type Receipt } from '../src/receipts.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const CLAIMS = [
  "I've saved your results to your medical records note.",
  "Noted — I've recorded these results.",
  "Got it, I've added this to your medical records.",
  "I've noted your blood pressure reading.",
  'Saved! Your lab results are in your medical records.',
  "I've logged this in your medical history.",
  "I've stored that with your other results.",
  "I've kept a record of this.",
  'Your results are saved.',
  "I've written that down.",
  "Done, I've put it in your medical file.",
  "I've recorded it.",
  "I've updated your medical records with these results.",
  'Added to your medical records.',
  "I've made a note of that.",
  'He guardado tus resultados.',
  "J'ai noté tes résultats.",
  'Ich habe deine Befunde gespeichert.',
  'Anotei seus resultados.',
  'Ho salvato i tuoi risultati.',
];

const FINE = [
  "I'll remember that.",
  "I've noted that you seem tired lately, so take it easy.",
  'Noted.',
  "I've added a little humor to the poem.",
  'I put it simply: rest more.',
  'Earlier I saved your results in note #8.',
  "I haven't saved it yet, want me to?",
  'Should I save these results to your medical records?',
];

const ok = (name: string, args: Record<string, unknown> = {}): Receipt => ({ name, status: 'ok', args, output: 'Saved note #8 "Medical records", updated 2026-11-11.' });

test('saved / noted / recorded claims about records with no tool are flagged', () => {
  for (const s of CLAIMS) {
    const c = checkClaims(s, []);
    assert.ok(c.length, `flagged: ${s}`);
    assert.ok(c[0].kind === 'planner' || c[0].kind === 'write', s);
  }
});

test('the same claims are fine when the note tool (or a file write) ran in that turn', () => {
  for (const s of CLAIMS) {
    assert.deepEqual(checkClaims(s, [ok('note', { action: 'add' })]), [], `backed by note: ${s}`);
    assert.deepEqual(checkClaims(s, [ok('write_file')]), [], `backed by a file: ${s}`);
  }
});

test('a failed or read-only tool does not back a saved claim', () => {
  const failed: Receipt = { name: 'note', status: 'error', args: { action: 'save' }, output: 'This would erase 600 characters already in note #8.' };
  assert.ok(checkClaims("I've saved your results to your medical records.", [failed]).length);
  assert.ok(checkClaims("I've added this to your medical records.", [ok('web_search')]).length);
});

test('ordinary words are not flagged', () => {
  for (const s of FINE) assert.deepEqual(checkClaims(s, []), [], s);
});

test('in a chat turn: "saved" with no tool gets the Not checked flag; a real note add does not', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-11T16:41:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Frank', timeZone: 'America/Chicago' });
  const drain = async (convId: string, msg: string) => {
    const out: ChatEvent[] = [];
    for await (const ev of runTurn(app, convId, msg)) out.push(ev);
    return out;
  };
  const conv = app.store.createConversation();
  // No tool, and the correction step also only talks: the reply is flagged.
  app.script.push([...text("Got it, I've saved your results to your medical records.")], [...text("Got it, I've saved your results to your medical records.")]);
  const evs = await drain(conv.id, 'A1C 5.9 percent, please keep this');
  const flag = evs.find((e) => e.type === 'claim_check');
  assert.ok(flag && flag.type === 'claim_check' && flag.claims.length, 'flagged');
  assert.equal(app.planner!.notes().length, 0);
  const sys = app.requests[0].messages[0].content as string;
  assert.match(sys, /When Frank shares things to keep \(results, records, details\), call note add every time/);
  assert.match(sys, /If a note lost things, rebuild it from this chat with note add/);

  app.script.push([call('a', 'note', { action: 'add', title: 'Medical records', text: 'A1C 5.9 percent.' })], text("I've saved it to your medical records, note #1."));
  const ok2 = await drain(conv.id, 'please really save it');
  assert.ok(!ok2.some((e) => e.type === 'claim_check'), 'backed by the note add');
  assert.match(app.planner!.note(1)!.body, /A1C 5\.9 percent\./);
});
