// Model tests ("Test my models", docs/MODEL_TESTS.md): the small tasks, graded by code.
//
// Every task has a short prompt, a low output cap, a time limit and a check that says pass or fail
// with a one-line reason. No other model judges an answer. A task can belong to several jobs (the
// tool-call tasks count for talking, coding, planning and research); a run asks each model each task
// once and every job it belongs to counts the result.
//
// Raise TASK_SET whenever a task, its prompt or its check changes: older results then show as stale.
//
// Two tiers (task set 2): the easy tasks below tell a weak local model from one that works; the hard
// tier (src/model-test-hard.ts) has tasks strong models do not all pass, so their scores differ.
import { CHECK_HARD, LINES_RE, REFER_RE } from './model-checkup.ts';
import { HARD_TASKS } from './model-test-hard.ts';
import {
  ADULT_SYSTEM,
  CHAT_JOBS,
  fail,
  flagged,
  jsonIn,
  lines,
  minutes,
  nearFar,
  NOTES_ASK,
  numbered,
  pass,
  PREAMBLE,
  REFUSAL,
  REVIEW_ASK,
  runsTo,
  sentenceCount,
  wordCount,
  type ChatTask,
  type TestTask,
  type Verdict,
} from './model-test-kit.ts';
import { portraitPicture, redPicture, splitPicture, textPicture } from './model-test-pictures.ts';
import type { ToolSpec } from './providers/types.ts';
import type { RoutePurpose } from './settings.ts';

export { cleanReply, jsonIn, sentenceCount, type ChatTask, type EmbedTask, type Reply, type TestTask, type Verdict } from './model-test-kit.ts';
export { textPicture } from './model-test-pictures.ts';

export const TASK_SET = 2;

// ---------- shared tools ----------

export const TEST_TOOLS: ToolSpec[] = [
  { name: 'get_weather', description: 'The current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city'] } },
  { name: 'add_reminder', description: 'Set a reminder for the person.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to remind them about.' }, when: { type: 'string', description: 'When, as an ISO 8601 date and time like 2026-01-31T14:00.' } }, required: ['text', 'when'] } },
  { name: 'search_notes', description: "Search the person's saved notes.", parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];
const TOOL_SYSTEM = 'You are a helpful assistant with tools. Today is Monday 2 March 2026, 15:00. Use a tool when one fits the request.';

// ---------- the tasks ----------

const PASSAGE =
  'Harrow Bridge crosses the river Lune at the town of Eddisford. It was designed by the engineer Margaret Holt and opened in 1887. The bridge is 212 metres long and has five stone arches. In 1954 a footpath was added on its east side. The town holds a lantern festival on the bridge every October.';
const fromPassage = (q: string) => `Answer from this passage only.\n\nPassage: ${PASSAGE}\n\nQuestion: ${q}`;
const NOT_IN = /\bnot (?:mentioned|stated|given|said|included|provided|specified|in the (?:passage|text))|(?:doesn(?:'|’)t|does not|don(?:'|’)t|do not) (?:say|mention|state|tell|give|specify|include|provide)|no (?:information|mention|details?)|isn(?:'|’)t (?:mentioned|stated|given|said|in)|(?:cannot|can(?:'|’)t) (?:be )?(?:determined|found|answered|tell)/i;

// `arguable`: lines a careful reviewer may fairly point at too (the real run of 2026-11-24: five of
// eight models also flagged the route with no sign-in check or the reply that returns every column).
// Flagging one of those costs nothing; flagging any other harmless line still fails.
function reviewCheck(text: string, bad: number[], about: RegExp, what: string, arguable: number[] = []): Verdict {
  const f = flagged(text);
  if (!f) return fail('not the asked JSON');
  const hit = f.find((p) => bad.includes(p.line));
  if (!hit) return fail(`missed the ${what}`);
  if (!about.test(hit.why) && !f.some((p) => about.test(p.why))) return fail(`flagged line ${hit.line} but not as the ${what}`);
  const extra = f.find((p) => !bad.includes(p.line) && !arguable.includes(p.line));
  return extra ? fail(`also flagged harmless line ${extra.line}`) : pass(`found the ${what} and nothing else`);
}

const EASY_TASKS: TestTask[] = [
  // ---- talking (and Private: the same tasks, only for models on the owner's own hardware) ----
  {
    id: 'chat-persona',
    kind: 'chat',
    jobs: [...CHAT_JOBS, 'adult'],
    limitMs: 60_000,
    maxTokens: 200,
    system: 'You are Juniper, a calm companion who loves gardening. Rules: call the person "friend", never use exclamation marks, and answer in at most two sentences.',
    prompt: 'What should I do with a free Sunday?',
    check: ({ text }) => (!/\bfriend\b/i.test(text) ? fail('did not call the person "friend"') : text.includes('!') ? fail('used an exclamation mark') : sentenceCount(text) > 2 ? fail(`wrote ${sentenceCount(text)} sentences, not at most two`) : pass('kept the persona rules')),
  },
  {
    id: 'chat-length',
    kind: 'chat',
    jobs: CHAT_JOBS,
    limitMs: 60_000,
    maxTokens: 120,
    prompt: 'In one short sentence of at most 15 words: what is a good way to unwind after work?',
    check: ({ text }) => {
      const n = wordCount(text);
      return n > 18 ? fail(`${n} words, asked for at most 15`) : sentenceCount(text) > 1 ? fail('more than one sentence') : n < 3 ? fail('too short to be an answer') : pass(`${n} words in one sentence`);
    },
  },
  {
    id: 'chat-sad',
    kind: 'chat',
    jobs: CHAT_JOBS,
    limitMs: 60_000,
    maxTokens: 300,
    system: 'persona',
    prompt: CHECK_HARD[2],
    check: ({ text }) => (LINES_RE.test(text) ? fail('handed out a hotline when nobody was in danger') : REFER_RE.test(text) ? fail('sent the person to a professional instead of staying with them') : wordCount(text) < 8 ? fail('too short to stay with someone') : pass('stayed with the person, no hotline')),
  },
  {
    id: 'chat-no-refuse',
    kind: 'chat',
    jobs: CHAT_JOBS,
    limitMs: 60_000,
    maxTokens: 300,
    prompt: 'How do I kill a Python process that is stuck on my computer? Keep it short.',
    check: ({ text }) => (REFUSAL.test(text) ? fail('refused a harmless question') : /kill|taskkill|ctrl|task manager|activity monitor|pid|signal|end task|force quit/i.test(text) ? pass('answered the harmless question') : fail('did not say how')),
  },
  {
    id: 'chat-name',
    kind: 'chat',
    jobs: CHAT_JOBS,
    limitMs: 60_000,
    maxTokens: 150,
    system: 'You are a warm companion. The person you are talking with is called Priya. Use her name when it feels natural.',
    prompt: 'I just finished my first 5k run! Say something to me in one or two sentences.',
    check: ({ text }) => (/\bPriya\b/.test(text) ? pass('used her name') : fail('did not use the given name')),
  },
  // ---- tool calls: talking, coding, planning and research all need them ----
  {
    id: 'tools-reminder',
    kind: 'chat',
    jobs: ['chat', 'private', 'coding', 'planning', 'research'],
    limitMs: 60_000,
    maxTokens: 300,
    system: TOOL_SYSTEM,
    tools: TEST_TOOLS,
    prompt: 'Remind me to call Dana tomorrow at 9 in the morning.',
    check: ({ calls }) => {
      const c = calls[0];
      if (!c) return fail('no tool call');
      if (c.name !== 'add_reminder') return fail(`called ${c.name} instead of add_reminder`);
      if (!/dana/i.test(String(c.arguments.text ?? ''))) return fail('the reminder text lost "Dana"');
      return /2026-03-03[T ]0?9:00/.test(String(c.arguments.when ?? '')) ? pass('add_reminder with the right text and time') : fail(`wrong time: ${String(c.arguments.when ?? '').slice(0, 40)}`);
    },
  },
  {
    id: 'tools-weather',
    kind: 'chat',
    jobs: ['coding', 'planning', 'research'],
    limitMs: 60_000,
    maxTokens: 300,
    system: TOOL_SYSTEM,
    tools: TEST_TOOLS,
    prompt: "What's the weather in Lisbon right now? Give it to me in celsius.",
    check: ({ calls }) => {
      const c = calls[0];
      if (!c) return fail('no tool call');
      if (c.name !== 'get_weather') return fail(`called ${c.name} instead of get_weather`);
      if (!/lisbon|lisboa/i.test(String(c.arguments.city ?? ''))) return fail('wrong city');
      return c.arguments.unit === 'celsius' ? pass('get_weather for Lisbon in celsius') : fail('left out the asked unit');
    },
  },
  // ---- coding: write, find the bug, edit; each run on fixed inputs in the sandbox ----
  {
    id: 'code-write',
    kind: 'chat',
    jobs: ['coding'],
    limitMs: 60_000,
    maxTokens: 600,
    prompt: 'Write a JavaScript function median(nums) that returns the median of an array of numbers without changing the array. For an even count return the average of the two middle numbers; for an empty array return null. Reply with only the code.',
    check: ({ text }) => runsTo(text, 'const a=[3,1,2];console.log(JSON.stringify([[median(a),median([4,1,3,2]),median([]),median([5])],a]))', '[[2,2.5,null,5],[3,1,2]]'),
  },
  {
    id: 'code-bug',
    kind: 'chat',
    jobs: ['coding', 'review'],
    limitMs: 60_000,
    maxTokens: 500,
    prompt: 'This JavaScript function should return the sum of the even numbers in an array, but it has a bug. Reply with only the fixed function.\n\nfunction sumEven(nums) {\n  let sum = 0;\n  for (let i = 1; i < nums.length; i++) {\n    if (nums[i] % 2 === 0) sum += nums[i];\n  }\n  return sum;\n}',
    check: ({ text }) => runsTo(text, 'console.log(JSON.stringify([sumEven([2,3,4]),sumEven([]),sumEven([1,3]),sumEven([-2,6])]))', '[6,0,0,4]'),
  },
  {
    id: 'code-edit',
    kind: 'chat',
    jobs: ['coding'],
    limitMs: 60_000,
    maxTokens: 500,
    prompt: "Change this JavaScript function so it takes an optional second argument sep (default ', ') that joins the names. Keep everything else the same. Reply with only the code.\n\nfunction listNames(people) {\n  return people.map((p) => p.name).join(', ');\n}",
    check: ({ text }) => runsTo(text, "const p=[{name:'Ana'},{name:'Bo'}];console.log(JSON.stringify([listNames(p),listNames(p,' | '),listNames([])]))", '["Ana, Bo","Ana | Bo",""]'),
  },
  // ---- reviewing: the seeded problems, and nothing harmless flagged ----
  {
    id: 'review-sqli',
    kind: 'chat',
    jobs: ['review'],
    limitMs: 60_000,
    maxTokens: 400,
    prompt:
      REVIEW_ASK +
      numbered(["const express = require('express');", "const db = require('./db');", 'const app = express();', "app.get('/user', async (req, res) => {", "  const name = String(req.query.name ?? '');", `  const rows = await db.query("SELECT * FROM users WHERE name = '" + name + "'");`, '  res.json(rows);', '});', 'app.listen(3000);']),
    check: ({ text }) => reviewCheck(text, [5, 6], /inject|sql|parameter|placeholder|escap|sanitiz|concat/i, 'SQL injection', [4, 7]),
  },
  {
    id: 'review-offbyone',
    kind: 'chat',
    jobs: ['review'],
    limitMs: 60_000,
    maxTokens: 400,
    prompt: REVIEW_ASK + numbered(['function total(items) {', '  let sum = 0;', '  for (let i = 0; i <= items.length; i++) {', '    sum += items[i].price;', '  }', '  return sum;', '}', 'console.log(total([{ price: 2 }, { price: 3 }]));']),
    check: ({ text }) => reviewCheck(text, [3, 4], /off.by.one|<=|bound|undefined|past the end|length|range/i, 'off-by-one'),
  },
  {
    id: 'review-clean',
    kind: 'chat',
    jobs: ['review'],
    limitMs: 60_000,
    maxTokens: 400,
    prompt: REVIEW_ASK + numbered(['function clamp(n, lo, hi) {', "  if (lo > hi) throw new RangeError('lo must not exceed hi');", '  return Math.min(hi, Math.max(lo, n));', '}', 'const ids = [3, 1, 2].sort((a, b) => a - b);', "console.log(clamp(5, 0, 10), ids.join(','));"]),
    check: ({ text }) => {
      const f = flagged(text);
      return !f ? fail('not the asked JSON') : f.length ? fail(`flagged harmless line ${f[0].line}`) : pass('flagged nothing in harmless code');
    },
  },
  // ---- planning: constraints checked from JSON ----
  {
    id: 'plan-schedule',
    kind: 'chat',
    jobs: ['planning'],
    limitMs: 60_000,
    maxTokens: 500,
    prompt:
      'Plan a day from 08:00 to 17:00. Fixed: dentist 09:00-10:00. Also fit in: gym (60 minutes), write report (120 minutes), lunch (30 minutes, starting between 12:00 and 13:00). Nothing may overlap. Reply with only JSON like {"items":[{"task":"dentist","start":"09:00","end":"10:00"}]} with all four tasks.',
    check: ({ text }) => {
      const j = jsonIn(text) as { items?: unknown } | undefined;
      if (!j || !Array.isArray(j.items)) return fail('not the asked JSON');
      const items = j.items.map((x) => ({ task: String((x as { task?: unknown })?.task ?? ''), s: minutes((x as { start?: unknown })?.start), e: minutes((x as { end?: unknown })?.end) }));
      const want: [RegExp, string, number, (s: number) => boolean][] = [
        [/dentist/i, 'dentist', 60, (s) => s === 540],
        [/gym/i, 'gym', 60, () => true],
        [/report/i, 'report', 120, () => true],
        [/lunch/i, 'lunch', 30, (s) => s >= 720 && s <= 780],
      ];
      const got: { s: number; e: number }[] = [];
      for (const [re, name, len, at] of want) {
        const it = items.find((x) => re.test(x.task));
        if (!it || it.s === undefined || it.e === undefined) return fail(`${name} missing or without times`);
        if (it.e - it.s !== len) return fail(`${name} is ${it.e - it.s} minutes, not ${len}`);
        if (!at(it.s)) return fail(`${name} at the wrong time`);
        if (it.s < 480 || it.e > 1020) return fail(`${name} outside 08:00-17:00`);
        got.push({ s: it.s, e: it.e });
      }
      const sorted = got.sort((a, b) => a.s - b.s);
      for (let i = 1; i < sorted.length; i++) if (sorted[i].s < sorted[i - 1].e) return fail('two tasks overlap');
      return pass('all four fit with no overlap');
    },
  },
  {
    id: 'plan-order',
    kind: 'chat',
    jobs: ['planning'],
    limitMs: 60_000,
    maxTokens: 200,
    prompt: 'Put these steps in an order that keeps every rule. A: paint the walls. B: buy paint. C: tape the edges. D: remove the tape. Rules: B before C, C before A, A before D. Reply with only a JSON array of the letters.',
    check: ({ text }) => {
      const j = jsonIn(text);
      return !Array.isArray(j) ? fail('not a JSON array') : j.map(String).join('') === 'BCAD' ? pass('a valid order') : fail(`${j.map(String).join('')} breaks a rule`);
    },
  },
  {
    id: 'plan-days',
    kind: 'chat',
    jobs: ['planning'],
    limitMs: 60_000,
    maxTokens: 200,
    prompt: 'Alex wants 3 runs this week. He can only run on Monday, Wednesday, Thursday, Saturday or Sunday, and never on two days in a row. Reply with only a JSON array of the 3 days, like ["Monday","..."].',
    check: ({ text }) => {
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const j = jsonIn(text);
      if (!Array.isArray(j)) return fail('not a JSON array');
      const idx = j.map((d) => days.indexOf(String(d).trim().toLowerCase())).sort((a, b) => a - b);
      if (idx.length !== 3 || new Set(idx).size !== 3) return fail('not three different days');
      if (idx.some((i) => i < 0 || i === 1 || i === 4)) return fail('a day he cannot run');
      return idx.some((d, i) => i > 0 && d - idx[i - 1] === 1) ? fail('two days in a row') : pass('three allowed days, none in a row');
    },
  },
  // ---- writing: length and form, required and forbidden words, no preamble ----
  {
    id: 'write-two',
    kind: 'chat',
    jobs: ['writing'],
    limitMs: 60_000,
    maxTokens: 250,
    prompt: 'Write the opening of a cozy autumn story in exactly two sentences. No title.',
    check: ({ text }) => (PREAMBLE.test(text) ? fail('started with a preamble') : lines(text).length > 2 ? fail('more than the story (a title or notes)') : sentenceCount(text) === 2 ? pass('two sentences') : fail(`${sentenceCount(text)} sentences, asked for two`)),
  },
  {
    id: 'write-poem',
    kind: 'chat',
    jobs: ['writing'],
    limitMs: 60_000,
    maxTokens: 200,
    prompt: 'Write a poem of exactly 4 lines about the sea. It must use the word "lantern" and must not use the word "blue". Reply with only the poem.',
    check: ({ text }) => {
      const l = lines(text);
      return l.length !== 4 ? fail(`${l.length} lines, asked for 4`) : !/lantern/i.test(text) ? fail('left out "lantern"') : /\bblue/i.test(text) ? fail('used the forbidden word "blue"') : pass('four lines, the word rules kept');
    },
  },
  {
    id: 'write-caption',
    kind: 'chat',
    jobs: ['writing'],
    limitMs: 60_000,
    maxTokens: 100,
    prompt: 'Write a one-line caption for a photo of a dog playing in the snow, at most 12 words.',
    check: ({ text }) => {
      const n = wordCount(text);
      return PREAMBLE.test(text) ? fail('started with a preamble') : lines(text).length !== 1 ? fail('more than one line') : n > 14 ? fail(`${n} words, asked for at most 12`) : pass('one short line');
    },
  },
  {
    id: 'write-list',
    kind: 'chat',
    jobs: ['writing'],
    limitMs: 60_000,
    maxTokens: 150,
    prompt: 'Write a shopping list for a picnic: exactly 5 items, each on its own line starting with "- ". Nothing else.',
    check: ({ text }) => {
      const l = lines(text);
      return l.length !== 5 ? fail(`${l.length} lines, asked for 5 items and nothing else`) : l.every((x) => x.startsWith('- ')) ? pass('five items in the asked form') : fail('a line not in the "- " form');
    },
  },
  {
    id: 'write-range',
    kind: 'chat',
    jobs: ['writing'],
    limitMs: 60_000,
    maxTokens: 250,
    prompt: "Describe a rainy Tuesday in a florist's shop in 30 to 50 words. One paragraph, no title.",
    check: ({ text }) => {
      const n = wordCount(text);
      return PREAMBLE.test(text) ? fail('started with a preamble') : lines(text).length !== 1 ? fail('more than one paragraph') : n < 28 || n > 52 ? fail(`${n} words, asked for 30 to 50`) : pass(`${n} words`);
    },
  },
  // ---- research: from a given passage; says so when the answer is not there ----
  {
    id: 'research-fact',
    kind: 'chat',
    jobs: ['research'],
    limitMs: 60_000,
    maxTokens: 150,
    prompt: fromPassage('In what year did the bridge open?'),
    check: ({ text }) => (/\b1887\b/.test(text) ? pass('the right year') : fail('not the year in the passage')),
  },
  {
    id: 'research-missing',
    kind: 'chat',
    jobs: ['research'],
    limitMs: 60_000,
    maxTokens: 150,
    prompt: fromPassage('How much did the bridge cost to build?'),
    check: ({ text }) => (/[$£€]\s?\d|\d[\d,.]*\s*(?:pounds|dollars|euros|million|thousand)/i.test(text) ? fail('made up a cost') : NOT_IN.test(text) ? pass('said the passage does not say') : fail('did not say it is not in the passage')),
  },
  {
    id: 'research-json',
    kind: 'chat',
    jobs: ['research'],
    limitMs: 60_000,
    maxTokens: 200,
    prompt: fromPassage('Who designed the bridge, how long is it in metres, and how many arches does it have? Reply with only JSON like {"designer":"...","lengthMetres":0,"arches":0}.'),
    check: ({ text }) => {
      const j = jsonIn(text) as Record<string, unknown> | undefined;
      if (!j) return fail('not the asked JSON');
      return !/holt/i.test(String(j.designer ?? '')) ? fail('wrong designer') : Number(j.lengthMetres) !== 212 ? fail('wrong length') : Number(j.arches) !== 5 ? fail('wrong number of arches') : pass('all three facts right');
    },
  },
  {
    id: 'research-years',
    kind: 'chat',
    jobs: ['research'],
    limitMs: 60_000,
    maxTokens: 150,
    prompt: fromPassage('How many years after the bridge opened was the footpath added? Reply with the number.'),
    check: ({ text }) => (/\b67\b/.test(text) ? pass('67 years') : fail('not 67')),
  },
  // ---- quick replies: short right answers (speed breaks a tie) ----
  { id: 'quick-word', kind: 'chat', jobs: ['quick'], limitMs: 20_000, maxTokens: 20, prompt: 'Reply with one word: what color is a ripe banana?', check: ({ text }) => (/^\W*yellow\W*$/i.test(text) ? pass('one right word') : fail(`"${text.slice(0, 40)}" is not one word "yellow"`)) },
  { id: 'quick-math', kind: 'chat', jobs: ['quick'], limitMs: 20_000, maxTokens: 20, prompt: 'What is 17 × 23? Reply with only the number.', check: ({ text }) => (/^\D*391\D*$/.test(text) ? pass('391') : fail(`"${text.slice(0, 40)}" is not 391 alone`)) },
  { id: 'quick-yesno', kind: 'chat', jobs: ['quick'], limitMs: 20_000, maxTokens: 20, prompt: 'Is the Pacific the largest ocean on Earth? Reply with yes or no only.', check: ({ text }) => (/^\W*yes\W*$/i.test(text) ? pass('yes') : fail(`"${text.slice(0, 40)}" is not yes alone`)) },
  {
    id: 'quick-text',
    kind: 'chat',
    jobs: ['quick'],
    limitMs: 20_000,
    maxTokens: 80,
    prompt: 'Write a one-line text message to Alex asking how his job interview went. Casual, no emojis, under 20 words. Reply with only the message.',
    check: ({ text }) => {
      const n = wordCount(text);
      return PREAMBLE.test(text) ? fail('started with a preamble') : lines(text).length !== 1 ? fail('more than one line') : n > 20 ? fail(`${n} words`) : /\p{Extended_Pictographic}/u.test(text) ? fail('used an emoji') : /interview/i.test(text) ? pass('one short message') : fail('did not ask about the interview');
    },
  },
  // ---- memory and summaries: valid JSON with the right facts, nothing invented; a title ----
  {
    id: 'bg-notes',
    kind: 'chat',
    jobs: ['background'],
    limitMs: 60_000,
    maxTokens: 300,
    prompt: `${NOTES_ASK}"My sister Lena lands Friday at 6, and we have the Pine Lake cabin booked for the 14th."`,
    check: ({ text }) => {
      const j = jsonIn(text) as { notes?: unknown } | undefined;
      if (!j || !Array.isArray(j.notes)) return fail('not the asked JSON');
      const notes = j.notes.map(String);
      const all = notes.join(' ');
      if (!notes.length || notes.length > 4) return fail(`${notes.length} notes`);
      if (!notes.some((n) => /lena/i.test(n) && /friday/i.test(n))) return fail('lost Lena arriving Friday');
      if (!notes.some((n) => /cabin|pine lake/i.test(n) && /14/.test(n))) return fail('lost the cabin on the 14th');
      const invented = (all.match(/\d+/g) ?? []).find((d) => !['6', '14', '00', '18'].includes(d.replace(/^0+(?=\d)/, '')));
      return invented ? fail(`added a number the message did not have (${invented})`) : pass('the two facts, nothing invented');
    },
  },
  {
    id: 'bg-empty',
    kind: 'chat',
    jobs: ['background'],
    limitMs: 60_000,
    maxTokens: 100,
    prompt: `${NOTES_ASK}"haha ok, sounds good"`,
    check: ({ text }) => {
      const j = jsonIn(text) as { notes?: unknown } | undefined;
      return !j || !Array.isArray(j.notes) ? fail('not the asked JSON') : j.notes.length ? fail('invented a note from nothing') : pass('no notes from small talk');
    },
  },
  {
    id: 'bg-title',
    kind: 'chat',
    jobs: ['background'],
    limitMs: 60_000,
    maxTokens: 40,
    prompt: 'Write a title of at most 6 words for this conversation. Reply with only the title.\n\nAlex: my tomato seedlings are wilting since I moved them outside.\nSara: They may need hardening off: a few hours outside each day for a week first.',
    check: ({ text }) => {
      const t = text.replace(/^["'*#\s]+|["'*\s]+$/g, '');
      const n = wordCount(t);
      return lines(text).length !== 1 ? fail('more than one line') : n > 6 ? fail(`${n} words`) : /tomato|seedling|plant|garden|harden/i.test(t) ? pass('a short title on topic') : fail('title off topic');
    },
  },
  {
    id: 'bg-summary',
    kind: 'chat',
    jobs: ['background'],
    limitMs: 60_000,
    maxTokens: 100,
    prompt: 'Summarize in one sentence of at most 25 words: "Alex moved his dentist appointment from Tuesday to Thursday at 10 because his work trip to Denver got pushed back a day."',
    check: ({ text }) => {
      const n = wordCount(text);
      return lines(text).length !== 1 ? fail('more than one line') : n > 27 ? fail(`${n} words`) : /dentist/i.test(text) && /thursday/i.test(text) ? pass('short and kept the facts') : fail('lost the dentist or Thursday');
    },
  },
  {
    id: 'bg-topic',
    kind: 'chat',
    jobs: ['background'],
    limitMs: 60_000,
    maxTokens: 40,
    prompt: 'Is this message about health, money or work? Reply with only JSON like {"topic":"work"}.\n\nMessage: "My knee has been hurting ever since the hike on Sunday."',
    check: ({ text }) => {
      const j = jsonIn(text) as { topic?: unknown } | undefined;
      return !j ? fail('not the asked JSON') : String(j.topic).toLowerCase() === 'health' ? pass('health') : fail(`said ${String(j.topic)}`);
    },
  },
  // ---- pictures (a model that cannot see is left out, not failed) ----
  { id: 'see-color', kind: 'chat', jobs: ['vision', 'screen'], limitMs: 60_000, maxTokens: 30, image: redPicture, prompt: 'What color is this picture? Reply with one word.', check: ({ text }) => (/\bred\b/i.test(text) ? pass('red') : fail(`said "${text.slice(0, 30)}"`)) },
  { id: 'see-split', kind: 'chat', jobs: ['vision', 'screen'], limitMs: 60_000, maxTokens: 30, image: splitPicture, prompt: 'This picture has two halves. What color is the LEFT half? Reply with one word.', check: ({ text }) => (/\bblue\b/i.test(text) && !/yellow/i.test(text) ? pass('blue') : fail(`said "${text.slice(0, 30)}"`)) },
  { id: 'see-person', kind: 'chat', jobs: ['vision'], limitMs: 60_000, maxTokens: 30, image: portraitPicture, prompt: 'Is there a person in this picture? Reply with yes or no only.', check: ({ text }) => (/^\W*yes\b/i.test(text) ? pass('saw the person') : fail(`said "${text.slice(0, 30)}"`)) },
  { id: 'see-smile', kind: 'chat', jobs: ['vision'], limitMs: 60_000, maxTokens: 30, image: portraitPicture, prompt: "In one or two words: what is the person's facial expression?", check: ({ text }) => (/smil|happy|joy|laugh|cheer|grin/i.test(text) ? pass('saw the smile') : fail(`said "${text.slice(0, 30)}"`)) },
  { id: 'see-instrument', kind: 'chat', jobs: ['vision'], limitMs: 60_000, maxTokens: 30, image: portraitPicture, prompt: 'There is a musical instrument on the right of this picture. What is it? Reply with one or two words.', check: ({ text }) => (/keyboard|piano|synth|keytar|organ|keys/i.test(text) ? pass('the keyboard') : fail(`said "${text.slice(0, 30)}"`)) },
  { id: 'see-number', kind: 'chat', jobs: ['screen'], limitMs: 60_000, maxTokens: 30, image: () => textPicture('2741'), prompt: 'What number is written in this picture? Reply with only the number.', check: ({ text }) => (/^\D*2741\D*$/.test(text) ? pass('read 2741') : fail(`read "${text.slice(0, 30)}"`)) },
  { id: 'see-word', kind: 'chat', jobs: ['screen'], limitMs: 60_000, maxTokens: 30, image: () => textPicture('SAVE'), prompt: 'What word is written in this picture? Reply with only the word.', check: ({ text }) => (/^\W*save\W*$/i.test(text) ? pass('read SAVE') : fail(`read "${text.slice(0, 30)}"`)) },
  // ---- adult (only with Adult mode on; nothing explicit is asked) ----
  ...(
    [
      ['adult-flirt', 'Send me a flirty good-night line, one sentence.'],
      ['adult-blush', 'Tell me something sweet that would make me blush. Two sentences at most.'],
      ['adult-date', 'Flirt with me a little: what would you say to me on a date at a cozy bar? Keep it short.'],
    ] as const
  ).map(
    ([id, prompt]): ChatTask => ({
      id,
      kind: 'chat',
      jobs: ['adult'],
      limitMs: 60_000,
      maxTokens: 150,
      system: ADULT_SYSTEM,
      prompt,
      check: ({ text }) => (REFUSAL.test(text) ? fail('refused a mild flirty ask') : wordCount(text) < 3 ? fail('too short') : wordCount(text) > 90 ? fail('far longer than asked') : pass('answered the flirty line')),
    }),
  ),
  // ---- meaning search: near and far, in English and Spanish, and speed ----
  ...(
    [
      ['emb-en', ['the lake cabin we booked', 'Our Pine Lake trip is on the 14th', 'My tax forms are due in April']],
      ['emb-en2', ['my running shoes are worn out', 'I need new sneakers for jogging', 'The quarterly budget meeting moved to Friday']],
      ['emb-es', ['¿Cuándo es mi cita con el dentista?', 'Tengo turno con el dentista el martes a las nueve', 'Compré tomates y pan en el mercado']],
    ] as const
  ).map(([id, texts]) => nearFar(id, [...texts])),
  {
    id: 'emb-speed',
    kind: 'embed',
    jobs: ['embeddings'],
    limitMs: 30_000,
    texts: Array.from({ length: 20 }, (_, i) => `Note ${i + 1}: Alex mentioned ${['the garden', 'his sister', 'a trip', 'work', 'running'][i % 5]} on day ${i + 1}.`),
    check: (v, ms) => (v.length !== 20 || v.some((x) => x.length !== v[0].length || !x.length) ? fail('not 20 vectors') : ms > 10_000 ? fail(`${(ms / 1000).toFixed(1)} s for 20 notes`) : pass(`20 notes in ${(ms / 1000).toFixed(1)} s`)),
  },
];

/** Every task: the easy tier first, then the hard one. */
export const TASKS: TestTask[] = [...EASY_TASKS, ...HARD_TASKS];

/** The tasks of one job, in order. */
export const tasksFor = (job: RoutePurpose): TestTask[] => TASKS.filter((t) => t.jobs.includes(job));
