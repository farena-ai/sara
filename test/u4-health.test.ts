// U4.22 (docs/HEALTH.md): a private, local-only health log. Medications with dose reminders, a
// taken/skipped log and a refill estimate; appointments with prep questions and after-visit notes;
// symptoms, mood, sleep and measurements (quick add by chat: "headache 6/10", "BP 128/82"); a doctor
// summary PDF for a date range. Never medical advice. Stored encrypted in the person's own space,
// and kept out of memory, Ask about anything (unless asked from a private chat with "include health"
// on), support/hub reports, fix recipes, outside apps and cloud models (unless allowed).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { after, test } from 'node:test';
import { askEverything } from '../src/ask-everything.ts';
import { PEOPLE_TOOLS } from '../src/chat.ts';
import { healthFor, HealthLog, healthMessage, parseQuick, kidHealth } from '../src/health-log.ts';
import { hideHealth } from '../src/health-terms.ts';
import { scrubText } from '../src/hub.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { summarizeConversation } from '../src/memory-worker.ts';
import { MemoryStore } from '../src/memory.ts';
import { createHealthTools } from '../src/tools/health-log.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-18T14:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
after(() => {
  for (const a of apps) {
    HealthLog.closeFor(a.dataDir);
    a.store.close();
  }
  for (const d of dirs) d();
});
// A made-up medicine name, built at run time (so it is no real drug and no grep finds it in fixtures).
const MED = ['Zor', 'va', 'tinex'].join('');
const SYMPTOM = ['wobble', 'knee'].join('');

function space(member?: { id: string; child?: boolean }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  if (member) {
    const rec = { id: member.id, name: 'Bo', status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 }, ...(member.child ? { child: { band: '9-12' } } : {}) };
    (app as unknown as { member: unknown }).member = { record: () => rec, child: () => rec.child, limits: () => rec.limits };
  }
  return app;
}
const ctx = (over: Record<string, unknown> = {}) => ({ workspaceDir: '.', signal: new AbortController().signal, sandbox: { kind: 'none' }, ...over }) as never;
const tool = (app: App, name: string) => createHealthTools(() => app).find((t) => t.spec.name === name)!;

test('quick add reads symptoms, mood, sleep and measurements', () => {
  assert.deepEqual(parseQuick('headache 6/10'), { type: 'symptom', name: 'headache', value: 6, scale: 10 });
  assert.deepEqual(parseQuick('BP 128/82'), { type: 'measure', name: 'blood pressure', value: 128, value2: 82, unit: 'mmHg' });
  assert.deepEqual(parseQuick('blood pressure 131/85'), { type: 'measure', name: 'blood pressure', value: 131, value2: 85, unit: 'mmHg' });
  assert.deepEqual(parseQuick('mood 7/10'), { type: 'mood', name: 'mood', value: 7, scale: 10 });
  assert.deepEqual(parseQuick('slept 7.5h'), { type: 'sleep', name: 'sleep', value: 7.5, unit: 'h' });
  assert.deepEqual(parseQuick('weight 172 lb'), { type: 'measure', name: 'weight', value: 172, unit: 'lb' });
  assert.deepEqual(parseQuick('glucose 104'), { type: 'measure', name: 'glucose', value: 104, unit: 'mg/dL' });
  assert.deepEqual(parseQuick('pulse 72'), { type: 'measure', name: 'pulse', value: 72, unit: 'bpm' });
  assert.equal(parseQuick('meet Sam at 6/10'), undefined);
  assert.equal(parseQuick('what is the weather'), undefined);
});

test('stored encrypted at rest in the person\'s own space', () => {
  const app = space();
  const h = healthFor(app);
  h.addMed({ name: MED, dose: '10 mg', times: ['08:00'], supply: 30, perDose: 1 });
  h.addEntry({ type: 'symptom', name: SYMPTOM, value: 4, scale: 10, note: 'after the stairs' });
  const folder = join(app.dataDir, 'health-log');
  for (const f of readdirSync(folder)) {
    const bytes = readFileSync(join(folder, f));
    assert.ok(!bytes.includes(MED), `${f} holds the medicine name in clear`);
    assert.ok(!bytes.includes(SYMPTOM), `${f} holds the symptom in clear`);
  }
  if (process.platform !== 'win32') assert.equal(statSync(join(folder, 'health.key')).mode & 0o777, 0o600);
  // Nothing about it in the chat database either.
  const db = readFileSync(join(app.dataDir, 'sara.db'));
  assert.ok(!db.includes(MED));
  // Reopened, it reads back.
  HealthLog.closeFor(app.dataDir);
  assert.equal(healthFor(app).meds()[0].name, MED);
});

test('household members are isolated; a parent manages a child\'s medicine reminders', () => {
  const owner = space();
  const bo = space({ id: 'm1' });
  healthFor(owner).addMed({ name: MED, dose: '5 mg', times: ['09:00'] });
  assert.equal(healthFor(bo).meds().length, 0);
  healthFor(bo).addEntry({ type: 'mood', name: 'mood', value: 3, scale: 10 });
  assert.equal(healthFor(owner).entries({}).length, 0);
  assert.ok(MEMBER_ROUTES.has('health-log'), 'members have their own health log');

  const kid = space({ id: 'k1', child: true });
  const family = (person: string) => ({
    person,
    people: () => [{ id: 'owner', name: 'Alex' }, { id: 'k1', name: 'Kim', child: { band: '9-12' } }, { id: 'm1', name: 'Bo' }],
    store: { isParent: (p: string) => p === 'owner', parents: () => ['owner'] },
    spaceDirOf: (id: string) => (id === 'k1' ? kid.dataDir : id === 'm1' ? bo.dataDir : owner.dataDir),
    tz: () => 'America/Chicago',
  });
  (owner as unknown as { family: unknown }).family = family('owner');
  (bo as unknown as { family: unknown }).family = family('m1');
  const k = kidHealth(owner, 'k1');
  k.addMed({ name: 'Allergy syrup', dose: '5 ml', times: ['07:30'], managedBy: 'parent' });
  assert.equal(healthFor(kid).meds()[0].name, 'Allergy syrup');
  // A parent sees the child's medicines and doses, never their symptoms or mood.
  healthFor(kid).addEntry({ type: 'mood', name: 'mood', value: 2, scale: 10 });
  assert.deepEqual(Object.keys(kidHealth(owner, 'k1').parentView()).sort(), ['doses', 'meds']);
  // Not a parent, not a child: refused.
  assert.throws(() => kidHealth(bo, 'k1'), /parent/i);
  assert.throws(() => kidHealth(owner, 'm1'), /child/i);
});

test('dose reminders, the taken/skipped log and the refill estimate', async () => {
  const app = space();
  const sent: { title: string; body: string }[] = [];
  (app as unknown as { push: unknown }).push = { notifyOwner: async (title: string, body: string) => void sent.push({ title, body }) };
  const h = healthFor(app);
  // 8:00 in Chicago is 14:00 UTC on Nov 18.
  const med = h.addMed({ name: MED, dose: '10 mg', times: ['08:00', '20:00'], supply: 10, perDose: 1, refilledOn: '2026-11-15' });
  assert.equal(h.due(new Date('2026-11-18T13:59:00Z')), 0);
  assert.equal(h.due(new Date('2026-11-18T14:01:00Z')), 1);
  assert.equal(h.due(new Date('2026-11-18T14:05:00Z')), 0, 'one reminder per dose');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent).includes(MED), 'no medicine name on the lock screen unless asked');
  const [dose] = h.doses({ status: 'due' });
  assert.equal(dose.medId, med.id);
  h.markDose(dose.id, 'taken');
  assert.equal(h.doses({ status: 'taken' }).length, 1);
  h.logDose(med.id, 'skipped');
  assert.equal(h.doses({ status: 'skipped' }).length, 1);
  const r = h.refill(med.id);
  // 10 on hand, 1 taken: 9 left at 2 a day → 4 days.
  assert.equal(r?.left, 9);
  assert.equal(r?.daysLeft, 4);
  assert.equal(r?.soon, true);
  // Reminders off: no notices.
  h.setSettings({ reminders: false });
  assert.equal(h.due(new Date('2026-11-19T02:01:00Z')), 0);
});

test('appointments: prep questions and after-visit notes; a doctor summary PDF with the banner', () => {
  const app = space();
  const h = healthFor(app);
  const a = h.addAppt({ title: 'Dr. Lee checkup', when: '2026-11-20T15:00:00Z', questions: ['Ask about the knee'] });
  h.updateAppt(a.id, { notes: 'Keep walking daily.', addQuestion: 'Refill?' });
  assert.deepEqual(h.appts()[0].questions, ['Ask about the knee', 'Refill?']);
  h.addMed({ name: MED, dose: '10 mg', times: ['08:00'] });
  h.addEntry({ type: 'measure', name: 'blood pressure', value: 128, value2: 82, unit: 'mmHg', at: '2026-11-17T12:00:00Z' });
  h.addEntry({ type: 'symptom', name: 'headache', value: 6, scale: 10, at: '2026-10-01T12:00:00Z' });
  const md = h.summaryMarkdown('2026-11-01', '2026-11-30');
  assert.match(md, /not medical advice/i);
  assert.match(md, /128\/82/);
  assert.ok(!md.includes('headache'), 'only the date range');
  const pdf = h.summaryPdf('2026-11-01', '2026-11-30');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const streams = [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => {
    try {
      return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      return '';
    }
  });
  assert.ok(streams.join('').includes('not medical advice'));
});

test('chat tools: logging always works; reading needs a local model unless a cloud model is allowed', async () => {
  const app = space();
  const conv = app.store.createConversation({ title: 'Chat' });
  const u = app.store.addMessage(conv.id, 'user', 'BP 128/82');
  const log = tool(app, 'health_log');
  const out = String(await log.run({ text: 'BP 128/82' }, ctx({ conversationId: conv.id, modelLocal: false })));
  assert.match(out, /Logged/);
  assert.ok(!out.includes('128'), 'a cloud model is not told the numbers back');
  assert.equal(healthFor(app).entries({}).length, 1);
  assert.equal(app.store.messages(conv.id).find((m) => m.id === u.id)?.meta?.health, true, 'the message is marked as health');
  const read = tool(app, 'health_read');
  const cloud = String(await read.run({ what: 'recent' }, ctx({ conversationId: conv.id, modelLocal: false })));
  assert.match(cloud, /local model/i);
  assert.ok(!cloud.includes('128'));
  const local = String(await read.run({ what: 'recent' }, ctx({ conversationId: conv.id, modelLocal: true })));
  assert.match(local, /128\/82/);
  assert.match(local, /not medical advice/i);
  healthFor(app).setSettings({ cloudOk: true });
  assert.match(String(await read.run({ what: 'recent' }, ctx({ conversationId: conv.id, modelLocal: false }))), /128\/82/);
  // Never to other apps, outside requests or group chats.
  for (const t of createHealthTools(() => app)) assert.ok(PEOPLE_TOOLS.has(t.spec.name), t.spec.name);
  // Kids never get the chat tools (a parent manages their reminders from the page).
  const fam = readFileSync(join(ROOT, 'src/family.ts'), 'utf8');
  assert.ok(!/'health_/.test(fam.slice(fam.indexOf('KID_TOOLS'), fam.indexOf('KID_TOOLS') + 2000)));
});

test('exclusions: memory, Ask about anything, support/hub/fix-recipe scrubbing', async () => {
  const app = space();
  const h = healthFor(app);
  h.addMed({ name: MED, dose: '10 mg', times: ['08:00'] });
  h.addEntry({ type: 'symptom', name: SYMPTOM, value: 5, scale: 10 });
  // Memory: health lines never reach the memory model.
  const conv = app.store.createConversation({ title: 'Chat' });
  const m1 = app.store.addMessage(conv.id, 'user', `${SYMPTOM} 5/10 and I took my ${MED}`);
  app.store.updateMessageMeta(m1.id, { health: true });
  app.store.addMessage(conv.id, 'assistant', '', { toolCalls: [{ id: 'c1', name: 'health_log', arguments: { text: `${SYMPTOM} 5/10` } }] });
  app.store.addMessage(conv.id, 'tool', `Logged: ${SYMPTOM} 5/10`, { toolCallId: 'c1', name: 'health_log', status: 'ok' });
  app.store.addMessage(conv.id, 'user', 'I love hiking in Colorado every summer');
  assert.equal(healthMessage(app.store.messages(conv.id)[0]), true);
  app.script.push(text('{"summary":"Talked about hiking.","facts":[],"sara":[],"dates":[],"decisions":[],"promises":[],"milestones":[]}'));
  const mem = new MemoryStore(app.store.db);
  await summarizeConversation(app, mem, conv.id);
  const sentToModel = JSON.stringify(app.requests.at(-1)?.messages ?? []);
  assert.ok(sentToModel.includes('hiking'));
  assert.ok(!sentToModel.includes(MED) && !sentToModel.includes(SYMPTOM), 'health lines never reach the memory model');

  // Ask about anything: not in chats; the health source only from a private chat with "include health" on.
  const plain = await askEverything(app, `${SYMPTOM} ${MED}`, { conversationId: conv.id });
  assert.ok(!JSON.stringify(plain.groups).includes(MED));
  assert.ok(!plain.groups.some((g) => g.source === 'health'));
  const priv = app.store.createConversation({ title: 'Private' });
  app.store.db.prepare('UPDATE conversations SET private = 1 WHERE id = ?').run(priv.id);
  const off = await askEverything(app, MED, { conversationId: priv.id });
  assert.ok(!off.groups.some((g) => g.source === 'health'), 'off until the person turns on include health');
  h.setSettings({ includeInAsk: true });
  const on = await askEverything(app, MED, { conversationId: priv.id });
  assert.ok(on.groups.some((g) => g.source === 'health' && JSON.stringify(g.items).includes(MED)));
  const notPrivate = await askEverything(app, MED, { conversationId: conv.id });
  assert.ok(!notPrivate.groups.some((g) => g.source === 'health'), 'still never outside a private chat');

  // Support/hub reports and fix recipes all pass scrubText: the person's health words are hidden.
  const report = scrubText(`tool health_log failed for ${MED} 10 mg\nBP 128/82 logged\nother line ok`, (s) => s);
  assert.ok(!report.includes(MED) && !report.includes('128/82'));
  assert.match(report, /other line ok/);
  assert.equal(hideHealth(`${SYMPTOM} again`).includes(SYMPTOM), false);
});

test('web: the Health place, banner, settings with tips, strings in five languages', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  assert.match(html, /<dialog id="health"/);
  assert.match(html, /data-dest="health"/);
  assert.match(html, /id="hl-banner"[^>]*>[^<]*not medical advice/i);
  const nav = readFileSync(join(ROOT, 'web/nav.js'), 'utf8');
  assert.match(nav, /'health'/);
  const tips = (JSON.parse(readFileSync(join(ROOT, 'web/tips.json'), 'utf8')) as { tips: Record<string, unknown> }).tips;
  for (const id of ['hs-cloud', 'hs-ask', 'hs-remind', 'hs-names']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.ok(tips[id], `${id} has a tip`);
  }
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = readFileSync(join(ROOT, `web/i18n/${lang}.json`), 'utf8');
    assert.ok(tr.includes('"Health"'), `${lang} has Health`);
  }
});
