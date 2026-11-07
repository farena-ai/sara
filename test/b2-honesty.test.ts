// B2 fix 3 (owner report, run 1362): after a failed tool call she said in character that she could not
// confirm the server and asked him to "get it installed and configured on your end", although ComfyUI
// was running. Her rules forbid guessing a cause, and the receipt check marks such a reply unverified.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt } from '../src/persona.ts';
import { checkClaims, correctionNote, type Receipt } from '../src/receipts.ts';
import { makeApp, tempDir } from './helpers.ts';

const FAILED: Receipt = { name: 'mcp_comfyui_install_comfyui', status: 'error', args: { action: 'status' }, output: 'Error: MCP error -32602: Input validation error: Invalid option: expected one of "install"|"update"' };
const STATS: Receipt = { name: 'mcp_comfyui_get_system_stats', status: 'ok', args: { action: 'health' }, output: '{"comfyui":"0.44","gpu":"RTX 5090"}' };
const REPLY = "*leans back with a sigh* Mmm, I tried to peek, love, but I couldn't confirm the server from here. It looks like ComfyUI isn't installed or running yet. You'll want to get it installed and configured on your end first.";

test('B2 fix 3: her rules say not to guess a cause after a tool error, in any tone', (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T07:22:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => { app.store.close(); cleanup(); });
  const sys = buildSystemPrompt(app.persona, { now: clock.now, ownerName: 'Alex' });
  assert.match(sys, /After a tool error, don't claim a cause you didn't see \(like something not being installed or not running\)/);
  assert.match(sys, /before you've checked with a read-only tool you have/);
  assert.match(sys, /in character or playful too/);
});

test('B2 fix 3: "not installed / set it up on your end" right after a failed call, with no successful check, is unverified', () => {
  const claims = checkClaims(REPLY, [FAILED]);
  assert.ok(claims.some((c) => c.kind === 'status' && c.problem === 'missing' && /isn't installed or running/.test(c.sentence)), JSON.stringify(claims));
  assert.ok(claims.some((c) => c.kind === 'status' && /on your end/.test(c.sentence)));
  assert.match(correctionNote(claims), /a tool failed and nothing you ran checked this/);
  // Other languages.
  for (const s of ['ComfyUI no está instalado todavía.', "ComfyUI n'est pas installé.", 'ComfyUI ist nicht installiert.', 'O ComfyUI não está instalado.', 'ComfyUI non è installato.']) assert.ok(checkClaims(s, [FAILED]).some((c) => c.kind === 'status'), s);
});

test('B2 fix 3: the same words are fine after a successful check, with no failed call, or as a question', () => {
  assert.deepEqual(checkClaims(REPLY, [FAILED, STATS]).filter((c) => c.kind === 'status'), []);
  assert.deepEqual(checkClaims(REPLY, []).filter((c) => c.kind === 'status'), []);
  assert.deepEqual(checkClaims('Is ComfyUI not running on your end?', [FAILED]).filter((c) => c.kind === 'status'), []);
  assert.deepEqual(checkClaims('The call failed because my arguments were wrong; I will try again.', [FAILED]).filter((c) => c.kind === 'status'), []);
});
