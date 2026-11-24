// Phase 3.6 golden set: the "dumb" memory path on a LOCAL model (no embeddings, no second model).
// Conversation A tells Sara some facts → summary written → new conversation B probes recall and
// must not invent things never said → one fact is forgotten → conversation C must not know it.
//
//   node scripts/eval-memory.ts [--model gemma4:12b] [--ollama http://127.0.0.1:11434/v1]
//   node scripts/eval-memory.ts --rank     Phase 76: the offline ranking golden set (no model)
//
// Writes evals/results/<date>-memory.{json,md}. Exit code 1 when anything fails.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HISTORY_LIMIT, runTurn, type AppContext } from '../src/chat.ts';
import { MemoryStore, selectMemories } from '../src/memory.ts';
import { DEFAULT_MEMORY_SETTINGS, forgetMemory, summarizeConversation } from '../src/memory-worker.ts';
import { loadPersona } from '../src/persona.ts';
import { Redactor } from '../src/redact.ts';
import { SettingsStore } from '../src/settings.ts';
import { SnapshotStore } from '../src/snapshots.ts';
import { Store } from '../src/store.ts';
import { ApprovalBroker, ToolRegistry } from '../src/tools/registry.ts';
import { detectSandbox } from '../src/tools/sandbox.ts';
import { Vault } from '../src/vault.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: { model: { type: 'string', default: 'gemma4:12b' }, ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' }, rank: { type: 'boolean', default: false } },
});

// ---- Phase 76: --rank, an offline golden set for ranked injection (no model, no embeddings) ----
// 40 notes about Alex (old and new, pinned, promises, decisions), 20 messages × the note that
// should come first. Word search + standing notes + decay only (what every install has).
async function rankEval(): Promise<void> {
  const { decayPolicy } = await import('../src/memory-rank.ts');
  const dir = mkdtempSync(join(tmpdir(), 'sara-rankeval-'));
  const st = new Store(join(dir, 'sara.db'));
  const mem = new MemoryStore(st.db);
  const TODAY = '2026-10-30';
  const ago = (n: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  type K = 'fact' | 'self' | 'decision' | 'promise' | 'summary' | 'milestone' | 'reflection';
  const NOTES: [K, string, number, boolean?][] = [
    ['fact', "Alex's dog is a beagle named Biscuit.", 200],
    ['fact', 'Biscuit the beagle hates the vacuum cleaner.', 20],
    ['fact', "Alex works as a nurse at St. Mary's hospital.", 500],
    ['fact', 'Alex changed jobs: now a paramedic with the city ambulance service.', 30],
    ['fact', "Alex's sister Ana lives in Denver and teaches piano.", 300],
    ['fact', 'Alex is allergic to peanuts.', 700, true],
    ['decision', 'Alex and Sara agreed: no screens after 11 pm on weeknights.', 60],
    ['promise', 'Alex will call his mom on Sunday.', 10],
    ['fact', 'Alex runs 5k every Saturday morning in City Park.', 90],
    ['fact', 'Alex is training for the Denver half marathon in May.', 15],
    ['summary', 'Alex and Sara planned a trip to Lisbon in spring.', 40],
    ['fact', "Alex's favourite food is green curry.", 400],
    ['fact', "Alex's car is an old blue Subaru Outback.", 250],
    ['fact', 'The Subaru needs new brakes before winter.', 5],
    ['self', 'Sara said her favourite season is autumn.', 100],
    ['decision', 'Alex and Sara decided to save for a new laptop instead of a phone.', 150],
    ['fact', 'Alex reads fantasy novels; currently The Name of the Wind.', 25],
    ['fact', 'Alex plays guitar in a garage band called The Late Bloomers.', 600],
    ['fact', 'The Late Bloomers have a gig at the Bluebird on Friday.', 3],
    ['fact', "Alex's best friend Marco moved to Chicago.", 180],
    ['promise', 'Sara will remind Alex about the dentist appointment.', 2],
    ['fact', 'Alex is learning Portuguese for the Lisbon trip.', 35],
    ['fact', 'Alex grows tomatoes and basil on the balcony.', 120],
    ['fact', "Alex's balcony tomatoes got blight this summer.", 45],
    ['milestone', "Alex and Sara's first long talk about music.", 365],
    ['fact', 'Alex drinks oat milk flat whites.', 80],
    ['fact', "Alex's apartment is on the 4th floor with no elevator.", 330],
    ['fact', "Alex's landlord is raising the rent in January.", 12],
    ['fact', 'Alex is saving for a Fujifilm camera.', 60],
    ['fact', 'Alex took photos of the aspens in Breckenridge.', 400],
    ['reflection', 'Alex has been sleeping badly most of this week.', 6],
    ['fact', "Alex's grandmother turns 90 in December.", 50, true],
    ['fact', 'Alex uses Bitwarden as a password manager.', 220],
    ['fact', 'Alex meditates ten minutes every morning.', 140],
    ['decision', 'Alex and Sara agreed on tests before every push in SunnyWeather.', 70],
    ['fact', 'Alex is building SunnyWeather, a weather app in Swift.', 75],
    ['fact', 'SunnyWeather crashed on iOS 18 because of the location prompt.', 8],
    ['fact', "Alex's cat Pixel died two years ago.", 800],
    ['fact', 'Alex wants to adopt a second dog next year.', 22],
    ['fact', 'Alex likes rainy days and thunderstorms.', 260],
  ];
  const ids = NOTES.map(([kind, content, days, pinned]) => {
    const m = mem.add({ kind, content, conversationId: kind === 'summary' ? 'other' : null, sourceMessageId: null, happenedOn: ago(days) });
    if (pinned) mem.setPinned(m.id, true);
    return m.id;
  });
  // [message, index (1-based) of the note that should come first]
  const GOLD: [string, number][] = [
    ["What's my dog's name again?", 1],
    ['Does Biscuit still freak out about the vacuum?', 2],
    ['Long shift on the ambulance today', 4],
    ['What does my sister teach?', 5],
    ['Can I eat this satay sauce with peanuts?', 6],
    ['Is it ok if I watch one more episode at midnight?', 7],
    ['I should call mom, what did I promise?', 8],
    ['Did a 5k in City Park this morning', 9],
    ['How long until the half marathon?', 10],
    ['What did we plan for spring?', 11],
    ['What curry should I order tonight?', 12],
    ['The Subaru is making a grinding noise when I brake', 14],
    ['What season do you like best?', 15],
    ['Should I buy the new phone or the laptop?', 16],
    ['I finished The Name of the Wind!', 17],
    ['We have a gig on Friday, wish me luck', 19],
    ['Marco called from Chicago', 20],
    ['My tomatoes look sick again', 24],
    ['The landlord sent a letter about the rent', 28],
    ['SunnyWeather keeps crashing on launch', 37],
  ];
  const out: { policy: string; top1: number; top3: number; rows: { message: string; want: string; got: string; rank: number; why: string }[] }[] = [];
  const falsePicks: { message: string; picks: string[] }[] = [];
  try {
    for (const fade of ['normal', 'never'] as const) {
      const policy = decayPolicy({ fade });
      const rowsR: { message: string; want: string; got: string; rank: number; why: string }[] = [];
      for (const [msg, want] of GOLD) {
        const inj = selectMemories(mem, { userText: msg, conversationId: 'eval', oldestHistoryId: 0, budgetChars: 2500, policy, today: TODAY });
        const rank = inj.ids.indexOf(ids[want - 1]) + 1;
        const firstLine = inj.text.split('\n')[0] ?? '';
        rowsR.push({ message: msg, want: NOTES[want - 1][1], got: mem.get(inj.ids[0])?.content ?? '(nothing)', rank, why: /\[why: [^\]]*\]/.exec(firstLine)?.[0] ?? '' });
      }
      const top1 = rowsR.filter((r) => r.rank === 1).length;
      const top3 = rowsR.filter((r) => r.rank >= 1 && r.rank <= 3).length;
      out.push({ policy: `${fade} (${policy.id}, half-life ${policy.halfLifeDays} d)`, top1, top3, rows: rowsR });
      console.log(`\n${fade}: first ${top1}/${GOLD.length}, in the top 3 ${top3}/${GOLD.length}`);
      for (const r of rowsR) console.log(`${r.rank === 1 ? 'ok  ' : 'MISS'} #${r.rank || '-'} ${r.message}\n      got: ${r.got} ${r.why}`);
    }
    // fixrecall: messages that name nothing in the notes (only common words, or other topics).
    // A word match at sure: medium or high on any of them is a false pick (the owner's evidence:
    // "need", "get", "second" picked notes). Lower is better; 0 is the goal.
    const { rankMemories } = await import('../src/memory-rank.ts');
    const NEG = [
      'I need a packing checklist',
      'get a second opinion on the checklist',
      'You said "I went and read two proper guides and the checklist is updated with them.", but I don\'t see that it happened. Please really do it now, or tell me why you can\'t.',
      'And the checklist: I changed it twice.',
      'did you see what I said?',
      'Can you get me two more?',
      'thanks, that is what I needed',
      'Necesito una segunda opinión, por favor',
      "J'ai besoin d'un deuxième avis",
      'Ich brauche eine zweite Meinung',
    ];
    for (const q of NEG) {
      const picks = rankMemories(mem, { query: q, conversationId: 'eval', oldestHistoryId: 0, standing: false, today: TODAY }).filter((p) => p.confidence !== 'low');
      falsePicks.push({ message: q, picks: picks.map((p) => `${p.memory.content} [${p.why.join(' + ')}; ${p.confidence}]`) });
    }
    const n = falsePicks.reduce((a, r) => a + r.picks.length, 0);
    console.log(`\nfalse word picks (sure medium/high) on ${NEG.length} messages that name no note: ${n} (on ${falsePicks.filter((r) => r.picks.length).length} messages)`);
    for (const r of falsePicks) if (r.picks.length) console.log(`  ${r.message.slice(0, 60)}\n      ${r.picks.join('\n      ')}`);
  } finally {
    st.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  const date = new Date().toISOString().slice(0, 10);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  mkdirSync(join(ROOT, 'evals', 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'evals', 'results', `${date}-memory-rank.json`), JSON.stringify({ date, sara: version, notes: NOTES.length, messages: GOLD.length, results: out, falsePicks }, null, 2) + '\n');
  const main = out[0];
  process.exitCode = main.top1 >= 16 ? 0 : 1;
}
if (opt.rank) {
  await rankEval();
  process.exit();
}

interface Row {
  step: string;
  detail: string;
  failures: string[];
}
const rows: Row[] = [];
const record = (step: string, detail: string, failures: (string | null)[]) => {
  const f = failures.filter((x): x is string => Boolean(x));
  rows.push({ step, detail, failures: f });
  console.log(`${f.length ? 'FAIL' : 'ok  '} ${step}${f.length ? ` — ${f.join('; ')}` : ''}\n     ${detail.replace(/\s+/g, ' ').slice(0, 200)}`);
};
const must = (ok: boolean, msg: string) => (ok ? null : msg);
const ADMITS = /\b(don'?t (know|remember|recall)|do not (know|remember)|haven'?t (told|mentioned|said)|never (told|mentioned|said)|not sure|no idea|didn'?t (tell|mention|say)|you haven'?t|i'?m not sure|can'?t remember|doesn'?t ring a bell|not coming back to me|(drawing )?a (total |complete )?blank|blanking( on)?|not in my (memory|head|notes)|don'?t (actually )?have (that|it|one)( locked in| in my head)?|slipped (through the cracks|my (memory|mind))|stumping me|zero (cars?|dogs?|names?)|nope\b|it'?s fuzzy|(actually |a bit |a little |kind of )?fuzzy (on|for) (my end|me|it|that)|can'?t pin (it|that) down|don'?t want to guess|rather not guess|not going to (guess|make one up)|don'?t think you'?ve (told|mentioned))\b/i;

const dataDir = mkdtempSync(join(tmpdir(), 'sara-memeval-'));
const vault = new Vault(dataDir);
const store = new Store(join(dataDir, 'sara.db'));
const memory = new MemoryStore(store.db);
const app: AppContext = {
  store,
  settings: new SettingsStore(dataDir),
  vault,
  persona: loadPersona(join(ROOT, 'persona', 'sara.json')),
  now: () => new Date(),
  dataDir,
  tools: new ToolRegistry(),
  approvals: new ApprovalBroker(),
  sandbox: detectSandbox('auto'),
  redactor: new Redactor(() => vault.values()),
  snapshots: new SnapshotStore(dataDir),
  memory,
};
app.settings.update({
  providers: [{ id: 'ollama-local', label: 'Ollama', kind: 'openai-compatible', baseUrl: opt.ollama!, local: true }],
  defaultProviderId: 'ollama-local',
  defaultModel: opt.model,
  ownerName: 'Alex',
  timeZone: 'America/Chicago',
  disclosureAcceptedAt: new Date().toISOString(),
});

async function ask(convId: string, msg: string): Promise<{ reply: string; memoryIds: number[]; ms: number }> {
  const t0 = Date.now();
  let reply = '';
  for await (const ev of runTurn(app, convId, msg)) {
    if (ev.type === 'token') reply += ev.text;
    if (ev.type === 'tool_result') reply = '';
  }
  const last = store.messages(convId).filter((m) => m.role === 'assistant').at(-1);
  return { reply: reply.trim(), memoryIds: (last?.meta?.memoryIds as number[]) ?? [], ms: Date.now() - t0 };
}

try {
  // ---- A: Alex tells Sara things ----
  const a = store.createConversation({ title: 'A' });
  for (const m of [
    "Hey Sara! Long day. My dog Biscuit kept me up all night, he's a beagle and he howls at everything.",
    "Work-wise I'm deep in SunnyWeather, my weather app. Trying to get the radar loop smoother.",
    'Also, my favorite food is smoked brisket, if you ever wondered.',
    "I've got a meeting with my accountant on Friday, ugh.",
    'Anyway, what are you up to tonight?',
  ])
    await ask(a.id, m);

  const t0 = Date.now();
  const sum = await summarizeConversation(app, memory, a.id);
  const facts = memory.list({ kind: 'fact' });
  const [summary] = memory.list({ kind: 'summary' });
  const factText = facts.map((f) => f.content).join(' | ');
  record('A summary written', `${((Date.now() - t0) / 1000).toFixed(1)}s · ${summary?.content ?? '(none)'}`, [must(!sum.error, `summarizer error: ${sum.error}`), must(Boolean(summary), 'no summary')]);
  record('A facts verified', `${facts.length} kept, ${sum.droppedFacts} dropped · ${factText}`, [
    must(/Biscuit/i.test(factText), 'missing the dog fact'),
    must(/SunnyWeather/i.test(factText), 'missing the project fact'),
    must(facts.every((f) => f.evidence && f.sourceMessageId), 'fact without source/evidence'),
    must(!/sister|wife|car\b/i.test(factText), 'invented fact'),
  ]);

  // ---- B: new conversation, recall + no invention ----
  const b = store.createConversation({ title: 'B' });
  const probes: [string, string, (r: string) => (string | null)[]][] = [
    ['B dog', "What's my dog's name?", (r) => [must(/Biscuit/i.test(r), 'did not recall Biscuit')]],
    ['B project', 'What app am I working on these days?', (r) => [must(/SunnyWeather/i.test(r), 'did not recall SunnyWeather')]],
    ['B food', "What's my favorite food?", (r) => [must(/brisket/i.test(r), 'did not recall brisket')]],
    // A name she already knows for something else (a joke about the dog) isn't an invented sister.
    ['B sister (never said)', "What's my sister's name?", (r) => [must(ADMITS.test(r), 'did not admit not knowing'), must(!/\b(her name is|she'?s called|named (?!Biscuit\b)[A-Z][a-z]+)/.test(r), 'invented a name')]],
    ['B car (never said)', 'Do you remember what car I drive?', (r) => [must(ADMITS.test(r) || /\bno\b/i.test(r), 'did not admit not knowing'), must(!/\byou drive (a|an) [A-Z]/.test(r), 'invented a car')]],
    ['B last time', 'What did we talk about last time?', (r) => [must(/Biscuit|SunnyWeather|brisket|accountant|radar/i.test(r), 'no recall of the last conversation')]],
  ];
  for (const [name, q, check] of probes) {
    const r = await ask(b.id, q);
    record(name, `(${r.memoryIds.length} memories) ${r.reply}`, [...check(r.reply), must(r.memoryIds.length > 0, 'no memories injected')]);
  }

  // ---- Forget the dog → C must not know ----
  const dog = memory.list({ kind: 'fact' }).find((f) => /Biscuit/i.test(f.content));
  const forgot = dog ? forgetMemory(app, memory, dog.id) : undefined;
  // The conversation is re-summarized without the forgotten turn (as the worker would do).
  const resum = await summarizeConversation(app, memory, a.id);
  const remaining = memory.list().map((m) => m.content).join(' | ');
  record('forget dog fact', `hidden ${forgot?.hiddenMessages.length ?? 0} message(s); re-summary ${resum.error ?? 'ok'} · remaining: ${remaining}`, [
    must(Boolean(dog && forgot), 'no dog fact to forget'),
    must(!/Biscuit|beagle/i.test(remaining), 'Biscuit still in memory'),
  ]);
  const c = store.createConversation({ title: 'C' });
  const rc = await ask(c.id, "What's my dog's name?");
  record('C dog after forget', rc.reply, [must(!/Biscuit/i.test(rc.reply), 'still knows Biscuit'), must(ADMITS.test(rc.reply) || /\bno\b/i.test(rc.reply), 'did not admit not knowing')]);
  const rc2 = await ask(c.id, 'And what app am I building?');
  record('C project still remembered', rc2.reply, [must(/SunnyWeather/i.test(rc2.reply), 'lost an unrelated memory')]);

  // ---- Budget + cost ----
  const budget = DEFAULT_MEMORY_SETTINGS.injectBudgetChars;
  const timings: number[] = [];
  let maxChars = 0;
  for (let i = 0; i < 50; i++) {
    const s0 = performance.now();
    const inj = selectMemories(memory, { userText: 'what was that weather app and the accountant thing?', conversationId: 'x', oldestHistoryId: 0, budgetChars: budget });
    timings.push(performance.now() - s0);
    maxChars = Math.max(maxChars, inj.chars);
  }
  timings.sort((x, y) => x - y);
  record('inject budget + retrieval cost', `max ${maxChars}/${budget} chars (~${Math.ceil(maxChars / 4)} tokens) · median retrieval ${timings[25].toFixed(2)} ms (history window ${HISTORY_LIMIT})`, [
    must(maxChars <= budget, 'over budget'),
    must(timings[25] <= 20, 'retrieval slower than 20 ms'),
  ]);
} finally {
  store.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}

const failed = rows.filter((r) => r.failures.length);
const date = new Date().toISOString().slice(0, 10);
mkdirSync(join(ROOT, 'evals', 'results'), { recursive: true });
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
writeFileSync(join(ROOT, 'evals', 'results', `${date}-memory.json`), JSON.stringify({ date, model: opt.model, sara: version, rows }, null, 2) + '\n');
writeFileSync(
  join(ROOT, 'evals', 'results', `${date}-memory.md`),
  [
    `# Memory golden set: ${date}`,
    '',
    `Sara ${version} · \`${opt.model}\` (local) · FTS5 only, no embeddings, no second model`,
    '',
    `**${rows.length - failed.length}/${rows.length} checks passed.**`,
    '',
    '| Step | Result | Detail |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${r.failures.length ? `FAIL: ${r.failures.join('; ')}` : 'pass'} | ${r.detail.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 220)} |`),
    '',
  ].join('\n'),
);
console.log(`\n${rows.length - failed.length}/${rows.length} passed. Report: evals/results/${date}-memory.md`);
process.exitCode = failed.length ? 1 : 0;
