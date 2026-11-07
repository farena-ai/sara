// B2 fix 8 (owner report, run 1376): she said she had sent the ComfyUI picture, but nothing was attached.
// A reply saying she sent / attached / shared a picture or file in a turn where no tool attached anything
// is marked unverified, and her rules say so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { checkClaims, correctionNote, type Receipt } from '../src/receipts.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, PNG, tempDir, text, type TestApp } from './helpers.ts';

const GOT: Receipt = { name: 'mcp_comfyui_get_image', status: 'ok', args: { action: 'get' }, output: 'ComfyUI_00001_.png\n[image image/png omitted]' };
const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };

test('B2 fix 8: "I sent you the picture" / "here it is" with nothing attached is unverified; with an attachment it is fine', () => {
  for (const s of ['I sent you the picture, love!', "Here it is, your new picture.", "I've attached the image.", 'Te envié la foto.', "Je t'ai envoyé la photo.", 'Ich habe dir das Bild geschickt.', 'Te enviei a foto.', 'Ti ho mandato la foto.']) {
    const c = checkClaims(s, [GOT], [], { attached: false });
    assert.ok(c.some((x) => x.kind === 'attach' && x.problem === 'missing'), s);
    assert.deepEqual(checkClaims(s, [GOT], [], { attached: true }).filter((x) => x.kind === 'attach'), [], `${s} (attached)`);
  }
  assert.match(correctionNote(checkClaims('I sent you the picture.', [GOT], [], { attached: false })), /nothing was attached to your reply/);
  // Not claims: a negation, a question, plain "here it is" with no picture or file in the reply, callers that don't say.
  for (const s of ["I couldn't send the picture; the tool didn't give me one.", 'Should I send you the picture?', 'Here it is: the plan for tomorrow.']) assert.deepEqual(checkClaims(s, [GOT], [], { attached: false }).filter((x) => x.kind === 'attach'), [], s);
  assert.deepEqual(checkClaims('I sent you the picture.', [GOT]).filter((x) => x.kind === 'attach'), []);
});

test('B2 fix 8: her rules say to claim a sent picture or file only when a tool attached it', (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-07T09:00:00Z') });
  t.after(() => { app.store.close(); cleanup(); });
  assert.match(buildSystemPrompt(app.persona, { now: new Date(), ownerName: 'Alex' }), /Only say you sent, attached or shared a picture or file when a tool attached it to your reply in this turn/);
});

async function turn(t: { after: (fn: () => void) => void }, attach: boolean) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T09:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [CLOUD], defaultProviderId: 'c', defaultModel: 'cloud-m', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() } as never);
  const tool: Tool = { spec: { name: 'get_pic', description: 'Gets a picture.', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', source: 'built-in', summarize: () => 'pic', run: async (_a, ctx) => { if (attach) ctx.attachImage?.(app.uploads!.save(`data:image/png;base64,${PNG}`).id); return attach ? 'Image attached to your reply (1 KB).' : 'ComfyUI_00001_.png'; } };
  app.tools.add(tool);
  t.after(() => { app.store.close(); cleanup(); });
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'get_pic', {})], text('I sent you the picture, love!'), text('Sorry, I could not attach it.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'send me the picture')) evs.push(ev);
  return evs;
}

test('B2 fix 8: in a turn, the claim is flagged only when nothing was attached', async (t) => {
  const flagged = (await turn(t, false)).find((e) => e.type === 'claim_check') as Extract<ChatEvent, { type: 'claim_check' }> | undefined;
  assert.ok(flagged?.claims.some((c) => c.kind === 'attach'), 'flagged without an attachment');
  const ok = (await turn(t, true)).find((e) => e.type === 'claim_check');
  assert.equal(ok, undefined, 'not flagged when the picture was attached');
});
