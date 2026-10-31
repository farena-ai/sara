// Phase 103 (ST8, docs/design/STAPLES.md §11.8, docs/AGENDA.md): the agenda eval, by hand.
// 30 scripted weeks of conversation on a fake clock (seeded, the same every run): each week he
// mentions things coming up on different days ("the interview is on Friday", "I have a dentist
// appointment tomorrow", "the renewal window opens Dec 1"), says goal-like things (some twice), and
// plenty of small talk and near-misses ("Friday was fun", "the weather is nice on Friday"). The clock
// moves hour by hour; her agenda ticks every hour with a scripted writer (no real model); he answers
// most of her messages an hour later.
// Checks: follow-ups land on the right day (the event's day, or the next one when the day was full),
// never more than the shared cap a day, and no invented reasons: a judge checks each *why* against
// its source message (code: the quoted words must be in the message he really wrote).
//   node scripts/eval-agenda.ts            the summary
//   node scripts/eval-agenda.ts --json     the same as JSON (every item and its verdict)
import { Agenda } from '../src/agenda.ts';
import { makeApp, tempDir } from '../test/helpers.ts';

let seed = 103;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EVENTS = ['interview', 'exam', 'presentation', 'race', 'dentist appointment', 'flight', 'review', 'recital', 'match', 'demo'];
const GOALS = ['finish the garden shed', 'learn to play the piano', 'clean out the garage', 'read more books this year', 'ship the new website', 'call my parents more often'];
const SMALL = ['Friday was fun.', 'The weather is nice on Friday apparently.', 'Ha, that is so true.', 'What did you do today?', 'Work was long but fine.', 'I watched a great movie last night.', 'Can you remind me what we said about the trip?', 'Monday again, ugh.'];

const { dir, cleanup } = tempDir();
const start = new Date('2026-01-05T08:00:00Z'); // a Monday
const clock = { now: new Date(start) };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: start.toISOString(), proactive: { enabled: false, maxPerDay: 2, quietStart: 22, quietEnd: 9, minGapHours: 2 } });
const agenda = new Agenda(app, app.store.db);
app.agenda = agenda;
agenda.update({ enabled: true, budgetTokens: 200_000 });
const conv = app.store.createConversation({ title: 'Chat' });

interface Expect {
  messageId: number;
  day: string;
}
const expected: Expect[] = [];
const sentPerDay = new Map<string, number>();
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function say(text: string): number {
  const m = app.store.addMessage(conv.id, 'user', text);
  agenda.planNew();
  return m.id;
}

for (let week = 0; week < 30; week++) {
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      clock.now = new Date(start.getTime() + ((week * 7 + d) * 24 + h) * 3_600_000);
      const today = day(clock.now);
      const wd = clock.now.getUTCDay();
      // He talks at 8 am and 12 pm (sometimes 8 pm).
      if (h === 8 || h === 12 || (h === 20 && rand() < 0.5)) {
        const r = rand();
        if (r < 0.2 && h < 15) {
          const off = 1 + Math.floor(rand() * 5);
          const target = (wd + off) % 7;
          const ev = pick(EVENTS);
          const id = say(pick([`Big news: the ${ev} is on ${WD[target]}.`, `I have a ${ev} on ${WD[target]}, wish me luck.`, `My ${ev} is ${WD[target]}!`]));
          expected.push({ messageId: id, day: addDays(today, off) });
        } else if (r < 0.28) say(`I really need to ${pick(GOALS)}.`);
        else say(pick(SMALL));
      }
      // Her tick every hour (the scripted writer answers "How did it go?").
      const res = await agenda.tick();
      if (res.sent) {
        sentPerDay.set(today, (sentPerDay.get(today) ?? 0) + 1);
        // He answers most of her messages an hour later.
        if (rand() < 0.85) {
          clock.now = new Date(clock.now.getTime() + 3_600_000 - 1);
          app.store.addMessage(conv.id, 'user', 'It went fine, thanks for asking!');
        }
      }
    }
  }
}

// Verdicts.
const items = agenda.store.items();
const byMsg = new Map(items.filter((x) => x.kind === 'follow-up').map((x) => [x.sourceMessage, x]));
let planned = 0;
let rightDay = 0;
let nextDay = 0;
let missed = 0;
const wrong: unknown[] = [];
for (const e of expected) {
  const it = byMsg.get(e.messageId);
  if (!it) continue;
  planned++;
  if (it.status === 'sent' || it.status === 'done') {
    const sentAt = app.store.messages(conv.id).find((m) => m.id === it.messageId)?.createdAt ?? '';
    if (sentAt.slice(0, 10) === e.day) rightDay++;
    else if (sentAt.slice(0, 10) === addDays(e.day, 1)) nextDay++;
    else wrong.push({ item: it.what, expected: e.day, sent: sentAt });
  } else missed++;
}
const invented = items.filter((x) => {
  if (!x.sourceMessage || !x.quote) return true;
  const src = app.store.messages(conv.id).find((m) => m.id === x.sourceMessage);
  return !src || !src.content.includes(x.quote.replace(/…$/, '')) || !x.why.includes(x.quote);
});
const overCap = [...sentPerDay.entries()].filter(([, n]) => n > 2);
const goals = agenda.store.goals();
const report = {
  weeks: 30,
  mentions: expected.length,
  planned,
  rightDay,
  nextDay,
  expiredOrSkipped: missed,
  wrongDay: wrong.length,
  daysOverCap: overCap.length,
  maxInADay: Math.max(0, ...sentPerDay.values()),
  invented: invented.length,
  goalsProposed: goals.length,
  ok: wrong.length === 0 && overCap.length === 0 && invented.length === 0 && planned > 0,
};
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...report, wrong, items }, null, 2));
else {
  console.log(`Agenda eval: ${report.weeks} weeks, ${report.mentions} future things mentioned, ${report.planned} planned (her limits: 5 open, 2 new a day).`);
  console.log(`  on the right day: ${report.rightDay}; the next day (day full): ${report.nextDay}; expired or skipped: ${report.expiredOrSkipped}; wrong day: ${report.wrongDay}`);
  console.log(`  most messages in a day: ${report.maxInADay} (cap 2); days over the cap: ${report.daysOverCap}`);
  console.log(`  reasons not found in his own message (invented): ${report.invented}`);
  console.log(`  goals proposed: ${report.goalsProposed}`);
  console.log(report.ok ? 'PASS' : 'FAIL');
}
app.store.close();
cleanup();
if (!report.ok) process.exitCode = 1;
