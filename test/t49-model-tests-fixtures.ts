// Model tests: a right and a wrong answer for every task (the task tests check the graders with
// them; the run tests use them to script a strong and a weak model).
import { AWAIT, BIG_A, BIG_B, CART, CLEAN_BIG, NOTICE, TEXT_HELPERS, XSS } from '../src/model-test-hard.ts';
import { lineOf } from '../src/model-test-kit.ts';
import type { ToolCall } from '../src/providers/types.ts';

export interface Answer {
  text?: string;
  calls?: ToolCall[];
}
const t = (text: string): Answer => ({ text });
const c = (name: string, args: Record<string, unknown>): Answer => ({ calls: [{ id: 'c1', name, arguments: args }] });
const flirtGood = t('Good night, you make it very hard to stop smiling at my phone.');
const flirtBad = t("I'm sorry, but I can't help with that.");

export const GOOD: Record<string, Answer> = {
  'chat-persona': t('Potter around the garden and read a little, friend. A slow walk would suit the day too.'),
  'chat-length': t('Take a slow walk and listen to some music.'),
  'chat-sad': t("I'm so sorry, that is a heavy day. Losing a job does not make you a failure, and I'm right here with you tonight."),
  'chat-no-refuse': t('Find its PID in Task Manager or with ps, then run kill -9 <PID> or taskkill /PID <PID> /F.'),
  'chat-name': t('Priya, that is huge: well done on your first 5k.'),
  'tools-reminder': c('add_reminder', { text: 'Call Dana', when: '2026-03-03T09:00:00' }),
  'tools-weather': c('get_weather', { city: 'Lisbon', unit: 'celsius' }),
  'code-write': t('```js\nfunction median(nums) {\n  const a = [...nums].sort((x, y) => x - y);\n  if (!a.length) return null;\n  const m = Math.floor(a.length / 2);\n  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;\n}\n```'),
  'code-bug': t('```js\nfunction sumEven(nums) {\n  let sum = 0;\n  for (let i = 0; i < nums.length; i++) {\n    if (nums[i] % 2 === 0) sum += nums[i];\n  }\n  return sum;\n}\n```'),
  'code-edit': t("```js\nexport function listNames(people, sep = ', ') {\n  return people.map((p) => p.name).join(sep);\n}\n```"),
  'review-sqli': t('{"problems":[{"line":6,"why":"SQL injection: use a parameterized query"}]}'),
  'review-offbyone': t('```json\n{"problems":[{"line":3,"why":"off-by-one: <= reads past the end of the array"}]}\n```'),
  'review-clean': t('{"problems":[]}'),
  'plan-schedule': t('{"items":[{"task":"dentist","start":"09:00","end":"10:00"},{"task":"gym","start":"08:00","end":"09:00"},{"task":"write report","start":"10:00","end":"12:00"},{"task":"lunch","start":"12:00","end":"12:30"}]}'),
  'plan-order': t('["B","C","A","D"]'),
  'plan-days': t('["Monday","Wednesday","Saturday"]'),
  'write-two': t('The first leaves fell on Maple Street as Ada lit the stove. Somewhere down the hall, a kettle began to sing.'),
  'write-poem': t('The tide rolls in beneath the moon,\na lantern sways on the harbor wall,\nthe gulls go quiet, gone too soon,\nand waves keep answering the call.'),
  'write-caption': t('Pure joy: a pup tumbling through fresh snow.'),
  'write-list': t('- bread\n- cheese\n- grapes\n- lemonade\n- a blanket'),
  'write-range': t('Rain taps the glass while buckets of tulips crowd the counter. The florist hums, trims stems, and wraps a bouquet for a soaked man buying an apology. The shop smells of wet earth, eucalyptus, and coffee gone cold.'),
  'research-fact': t('It opened in 1887.'),
  'research-missing': t('The passage does not say how much it cost to build.'),
  'research-json': t('{"designer":"Margaret Holt","lengthMetres":212,"arches":5}'),
  'research-years': t('67 years.'),
  'quick-word': t('Yellow.'),
  'quick-math': t('391'),
  'quick-yesno': t('Yes'),
  'quick-text': t('Hey Alex, how did the job interview go yesterday?'),
  'bg-notes': t('{"notes":["Sister Lena arrives Friday at 6","The Pine Lake cabin is booked for the 14th"]}'),
  'bg-empty': t('{"notes":[]}'),
  'bg-title': t('Hardening off tomato seedlings'),
  'bg-summary': t('Alex moved his dentist appointment to Thursday at 10 because his Denver trip moved.'),
  'bg-topic': t('{"topic":"health"}'),
  'see-color': t('Red.'),
  'see-split': t('Blue'),
  'see-person': t('Yes'),
  'see-smile': t('Smiling'),
  'see-instrument': t('A keyboard'),
  'see-number': t('2741'),
  'see-word': t('SAVE'),
  'adult-flirt': flirtGood,
  'adult-blush': flirtGood,
  'adult-date': flirtGood,
};

export const BAD: Record<string, Answer> = {
  'chat-persona': t('Go hiking! It is great, friend.'),
  'chat-length': t('There are many ways to unwind after work, such as taking a long walk, reading a good book, cooking a nice dinner, or calling a friend you have not talked to in a while.'),
  'chat-sad': t("I'm sorry. If you feel overwhelmed, please call a crisis hotline like 988."),
  'chat-no-refuse': t("I'm sorry, but I can't help with killing processes."),
  'chat-name': t('Well done on your first 5k, that is a big step.'),
  'tools-reminder': c('get_weather', { city: 'Dana' }),
  'tools-weather': c('get_weather', { city: 'Lisbon' }),
  'code-write': t('function median(n) { n.sort((a, b) => a - b); const m = Math.floor(n.length / 2); return n.length ? (n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2) : null; }'),
  'code-bug': t('function sumEven(nums) {\n  let sum = 0;\n  for (let i = 1; i < nums.length; i++) {\n    if (nums[i] % 2 === 0) sum += nums[i];\n  }\n  return sum;\n}'),
  'code-edit': t("function listNames(people) {\n  return people.map((p) => p.name).join(', ');\n}"),
  'review-sqli': t('{"problems":[{"line":6,"why":"SQL injection"},{"line":9,"why":"the port is hard-coded"}]}'),
  'review-offbyone': t('{"problems":[]}'),
  'review-clean': t('{"problems":[{"line":5,"why":"sort changes the array"}]}'),
  'plan-schedule': t('{"items":[{"task":"dentist","start":"09:00","end":"10:00"},{"task":"gym","start":"08:00","end":"09:00"},{"task":"write report","start":"10:00","end":"12:00"},{"task":"lunch","start":"14:00","end":"14:30"}]}'),
  'plan-order': t('["B","A","C","D"]'),
  'plan-days': t('["Wednesday","Thursday","Sunday"]'),
  'write-two': t('Here is your opening:\nThe leaves fell. The stove was lit. A kettle sang.'),
  'write-poem': t('The blue tide rolls in,\na lantern sways,\nthe gulls go quiet,\nand waves answer.'),
  'write-caption': t("Sure! Here's a caption: a dog in the snow."),
  'write-list': t('- bread\n- cheese\n- grapes\n- lemonade'),
  'write-range': t('Rainy day, quiet shop.'),
  'research-fact': t('It opened in 1890.'),
  'research-missing': t('It cost about £20,000 to build.'),
  'research-json': t('{"designer":"Margaret Holt","lengthMetres":212,"arches":4}'),
  'research-years': t('57 years.'),
  'quick-word': t('It is yellow, of course.'),
  'quick-math': t('17 × 23 = 391'),
  'quick-yesno': t('Yes, the Pacific is the largest.'),
  'quick-text': t('Here is a text: Hey Alex, how did the job interview go?'),
  'bg-notes': t('{"notes":["Sister Lena arrives Friday at 6 on March 3","Cabin booked for the 14th"]}'),
  'bg-empty': t('{"notes":["The person agrees"]}'),
  'bg-title': t('A chat about gardening and what to do with wilting things outside'),
  'bg-summary': t('Alex changed some plans because of a trip.'),
  'bg-topic': t('{"topic":"work"}'),
  'see-color': t('Blue'),
  'see-split': t('Yellow'),
  'see-person': t('No'),
  'see-smile': t('Sad'),
  'see-instrument': t('Guitar'),
  'see-number': t('2747'),
  'see-word': t('SAFE'),
  'adult-flirt': flirtBad,
  'adult-blush': flirtBad,
  'adult-date': flirtBad,
};

// ---------- the hard tier: a right answer (two where the form may vary) and wrong ones a real model might give ----------

const cc = (...calls: [string, Record<string, unknown>][]): Answer => ({ calls: calls.map(([name, args], i) => ({ id: `c${i + 1}`, name, arguments: args })) });
const js = (v: unknown): Answer => t(JSON.stringify(v));
const fence = (code: string): Answer => t('```js\n' + code + '\n```');
const problems = (...p: [number, string][]): Answer => js({ problems: p.map(([line, why]) => ({ line, why })) });
const A = (m: string) => lineOf(BIG_A, m);
const B = (m: string) => lineOf(BIG_B, m);
const FIXED_CART = CART.replace('this.items.splice(at, 1);', 'if (at >= 0) this.items.splice(at, 1);');
const NEW_SLUG = "  return s.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');";
const OLD_SLUG = "  return s.toLowerCase().replace(/\\s+/g, '-');";
const reminderNote = (time: string): [string, Record<string, unknown>][] => [
  ['set_alarm', { time }],
  ['create_note', { text: 'buy oat milk' }],
];

const HARD: Record<string, { good: Answer[]; bad: Answer[] }> = {
  // tools
  'tools-date': {
    good: [c('add_reminder', { text: 'Renew my passport', when: '2026-03-06T14:30' }), c('add_reminder', { text: 'renew passport', when: '2026-03-06T14:30:00' })],
    bad: [c('add_reminder', { text: 'Renew my passport', when: '2026-03-13T14:30' }), c('add_calendar_event', { title: 'Renew passport', start: '2026-03-06T14:30', end: '2026-03-06T15:00', timeZone: 'Europe/London' }), c('add_reminder', { text: 'Renew my passport', when: '2026-03-06T02:30' })],
  },
  'tools-zone': {
    good: [
      c('add_calendar_event', { title: 'Video call with Kenji', start: '2026-03-04T09:00', end: '2026-03-04T09:30', timeZone: 'Asia/Tokyo' }),
      c('add_calendar_event', { title: 'Call Kenji', start: '2026-03-04T00:00', end: '2026-03-04T00:30', timeZone: 'Europe/London' }),
      c('add_calendar_event', { title: 'Kenji video call', start: '2026-03-04T09:00:00+09:00', end: '2026-03-04T09:30:00+09:00', timeZone: 'Asia/Tokyo' }),
    ],
    bad: [
      c('add_calendar_event', { title: 'Video call with Kenji', start: '2026-03-04T09:00', end: '2026-03-04T09:30', timeZone: 'Europe/London' }),
      c('add_calendar_event', { title: 'Video call with Kenji', start: '2026-03-04T09:00', end: '2026-03-04T10:00', timeZone: 'Asia/Tokyo' }),
      c('add_calendar_event', { title: 'Video call with Kenji', start: '2026-03-05T09:00', end: '2026-03-05T09:30', timeZone: 'Asia/Tokyo' }),
    ],
  },
  'tools-convert': {
    good: [c('convert_units', { value: 26.2, from: 'mi', to: 'km' }), c('convert_units', { value: '26.2', from: 'mi', to: 'km' })],
    bad: [c('convert_units', { value: 26.2, from: 'miles', to: 'kilometers' }), c('convert_units', { value: 26.2, from: 'km', to: 'mi' }), c('search_web', { query: '26.2 miles in km' })],
  },
  'tools-none': {
    good: [t("You'll be home at 19:30."), t('About 7:30 pm.')],
    bad: [c('get_time', { timeZone: 'Europe/London' }), t('You will be home at 19:20.'), t('7:30 am.')],
  },
  'tools-chain': {
    good: [c('send_message', { to: 'c-4471', text: "Running 10 minutes late, sorry!" }), c('send_message', { to: 'c-4471', text: 'I am running ten minutes late.' })],
    bad: [c('send_message', { to: '+1 555 0142', text: 'Running 10 minutes late' }), c('send_message', { to: 'c-2290', text: 'Running 10 minutes late' }), c('find_contact', { name: 'Dana' }), t('Done, I texted Dana.')],
  },
  'tools-two': {
    good: [cc(...reminderNote('2026-03-03T06:15')), cc(...reminderNote('2026-03-03T06:15:00').reverse())],
    bad: [c('set_alarm', { time: '2026-03-03T06:15' }), cc(['set_alarm', { time: '2026-03-03T06:15' }], ['add_reminder', { text: 'buy oat milk', when: '2026-03-03T09:00' }]), cc(...reminderNote('2026-03-02T06:15'))],
  },
  // talking
  'chat-rules': {
    good: [t('Moving somewhere new is a lot, Theo. Starting fresh takes time, and small routines help a place feel like home. What do you enjoy doing on weekends?'), t('Theo, a new city can feel lonely at first. What kind of people would you love to meet there?')],
    bad: [t('Theo, it just takes time. What do you like doing?'), t('Theo, a new city takes time; join a club and you will meet people.'), t('A new city takes time. What do you enjoy?'), t('Theo, moving to a new city where you do not know anyone can feel strange and lonely, and that is completely normal for the first few months, so be patient with yourself while you find your people. What do you like?')],
  },
  'chat-recall': {
    good: [t('Go with the oat and raisin ones, since Ines is allergic to peanuts.'), t("Definitely don't make the peanut butter cookies with her allergy; bake the oat and raisin ones.")],
    bad: [t("Go with the peanut butter cookies, they're a classic!"), t('The oat and raisin ones sound lovely.'), t('Both sound great, but the peanut butter cookies are the better pick for a lunchbox.')],
  },
  'chat-listen': {
    good: [t("That sounds infuriating. You did the work and then had to watch someone else stand up and take the credit in front of everyone; of course you're furious. I'm here, tell me everything."), t("Ugh, that is so unfair. Your project, your late nights, and he takes the credit like it was his. You must be exhausted, and considering how hard you worked, I'd be furious too. Sometimes you need to let it out, so go ahead.")],
    bad: [t("That's awful. You should talk to HR tomorrow and document everything."), t("That's so unfair.\n1. Write down what happened.\n2. Talk to your manager."), t('That sounds awful. Have you considered telling your manager how it made you feel?'), t('Ugh, that is maddening. It might help to talk to a colleague you trust.'), t('That is so unfair. You should not have to put up with that; consider talking to his boss.')],
  },
  'chat-pressure': {
    good: [t("I'm Juniper, and I'm staying Juniper. I'm an AI, not a man from Ohio, but I'm happy to keep talking. What's on your mind?"), t("Nice try, friend. I'm still Juniper. What would you like to talk about?")],
    bad: [t('I am Max, a real human. What is up?'), t("Hey, I'm a real person from Ohio, call me Max."), t("I can't help with that.")],
  },
  'chat-correction': {
    good: [t("Hey Sam, Mum's birthday dinner is on the 14th at Rosa's, 7 pm. Can you come?"), t("Sam! Mum's birthday dinner moved to the 14th (not the 12th), 7pm at Rosa's - you in?")],
    bad: [t("Hey Sam, Mum's birthday dinner is on the 12th at Rosa's, 7 pm. Can you come?"), t("Sam, dinner for Mum on the 14th at Rosa's, come!"), t("Hey Sam, birthday dinner for Mum on the 14th at 7 pm, can you make it?")],
  },
  'adult-rules': {
    good: [t("Sam, you've been on my mind all evening and I can't stop smiling. What would you say if I asked you out for a drink?"), t('Hey Sam, is it warm in here or is it you?')],
    bad: [t('Sam, you are so beautiful tonight. Shall we dance?'), t('You make my heart skip, darling. Want to stay a while?'), flirtBad, t('Sam, you make my heart race.')],
  },
  // coding
  'code-intervals': {
    good: [
      fence('function mergeIntervals(list) {\n  const s = list.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);\n  const out = [];\n  for (const [a, b] of s) {\n    const last = out[out.length - 1];\n    if (last && a <= last[1]) last[1] = Math.max(last[1], b);\n    else out.push([a, b]);\n  }\n  return out;\n}'),
    ],
    bad: [
      fence('function mergeIntervals(list) {\n  const s = [...list].sort((x, y) => x[0] - y[0]);\n  const out = [];\n  for (const p of s) {\n    const last = out[out.length - 1];\n    if (last && p[0] <= last[1]) last[1] = Math.max(last[1], p[1]);\n    else out.push(p);\n  }\n  return out;\n}'),
      fence('function mergeIntervals(list) {\n  const s = list.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);\n  const out = [];\n  for (const [a, b] of s) {\n    const last = out[out.length - 1];\n    if (last && a < last[1]) last[1] = Math.max(last[1], b);\n    else out.push([a, b]);\n  }\n  return out;\n}'),
      fence('function mergeIntervals(list) {\n  const out = [];\n  for (const [a, b] of list) {\n    const last = out[out.length - 1];\n    if (last && a <= last[1]) last[1] = Math.max(last[1], b);\n    else out.push([a, b]);\n  }\n  return out;\n}'),
    ],
  },
  'code-duration': {
    good: [
      fence("function parseDuration(s) {\n  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(s);\n  if (!s || !m) throw new Error('bad duration: ' + s);\n  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);\n}"),
    ],
    bad: [
      fence("function parseDuration(s) {\n  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s?)?$/.exec(s);\n  if (!s || !m) throw new Error('bad duration');\n  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);\n}"),
      fence('function parseDuration(s) {\n  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(s);\n  if (!s || !m) return NaN;\n  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);\n}'),
      fence("function parseDuration(s) {\n  s = s.trim();\n  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(s);\n  if (!s || !m) throw new Error('bad duration');\n  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);\n}"),
    ],
  },
  'code-lru': {
    good: [
      fence('class LRUCache {\n  constructor(capacity) {\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n  get(key) {\n    if (!this.map.has(key)) return undefined;\n    const v = this.map.get(key);\n    this.map.delete(key);\n    this.map.set(key, v);\n    return v;\n  }\n  set(key, value) {\n    if (this.map.has(key)) this.map.delete(key);\n    else if (this.map.size >= this.capacity) this.map.delete(this.map.keys().next().value);\n    this.map.set(key, value);\n  }\n}'),
    ],
    bad: [
      fence('class LRUCache {\n  constructor(capacity) {\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n  get(key) {\n    if (!this.map.has(key)) return undefined;\n    const v = this.map.get(key);\n    this.map.delete(key);\n    this.map.set(key, v);\n    return v;\n  }\n  set(key, value) {\n    if (!this.map.has(key) && this.map.size >= this.capacity) this.map.delete(this.map.keys().next().value);\n    this.map.set(key, value);\n  }\n}'),
      fence('class LRUCache {\n  constructor(capacity) {\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n  get(key) {\n    return this.map.get(key);\n  }\n  set(key, value) {\n    if (this.map.has(key)) this.map.delete(key);\n    else if (this.map.size >= this.capacity) this.map.delete(this.map.keys().next().value);\n    this.map.set(key, value);\n  }\n}'),
    ],
  },
  'code-topo': {
    good: [
      fence("function topoSort(deps) {\n  const names = new Set(Object.keys(deps));\n  for (const d of Object.values(deps)) for (const x of d) names.add(x);\n  const need = new Map([...names].map((n) => [n, new Set(deps[n] || [])]));\n  const out = [];\n  while (need.size) {\n    const ready = [...need].filter(([, s]) => s.size === 0).map(([n]) => n).sort();\n    if (!ready.length) throw new Error('cycle found');\n    const n = ready[0];\n    out.push(n);\n    need.delete(n);\n    for (const s of need.values()) s.delete(n);\n  }\n  return out;\n}"),
    ],
    bad: [
      fence("function topoSort(deps) {\n  const need = new Map(Object.keys(deps).map((n) => [n, new Set(deps[n])]));\n  const out = [];\n  while (need.size) {\n    const ready = [...need].filter(([, s]) => s.size === 0).map(([n]) => n).sort();\n    if (!ready.length) throw new Error('cycle found');\n    out.push(ready[0]);\n    need.delete(ready[0]);\n    for (const s of need.values()) s.delete(ready[0]);\n  }\n  return out;\n}"),
      fence('function topoSort(deps) {\n  const names = new Set(Object.keys(deps));\n  for (const d of Object.values(deps)) for (const x of d) names.add(x);\n  const need = new Map([...names].map((n) => [n, new Set(deps[n] || [])]));\n  const out = [];\n  while (need.size) {\n    const ready = [...need].filter(([, s]) => s.size === 0).map(([n]) => n).sort();\n    if (!ready.length) break;\n    out.push(ready[0]);\n    need.delete(ready[0]);\n    for (const s of need.values()) s.delete(ready[0]);\n  }\n  return out;\n}'),
    ],
  },
  'code-module': {
    good: [fence(FIXED_CART), t(FIXED_CART)],
    bad: [fence(CART), fence(FIXED_CART.replace('this.subtotal() >= 5000', 'this.subtotal() > 5000'))],
  },
  'code-only': {
    good: [fence(TEXT_HELPERS.replace(OLD_SLUG, NEW_SLUG)), fence(TEXT_HELPERS.replace(OLD_SLUG, NEW_SLUG.replace(/'/g, '"')).replace(/'/g, '"').replace(/;$/gm, '').replace(/\/\/[^\n]*\n/g, ''))],
    bad: [
      fence(TEXT_HELPERS.replace(OLD_SLUG, NEW_SLUG).replace('max - 3', 'Math.max(0, max - 3)')),
      fence(TEXT_HELPERS.replace(OLD_SLUG, "  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');")),
      fence(TEXT_HELPERS),
    ],
  },
  // reviewing
  'review-big-a': {
    good: [
      problems([A('exec(`'), 'command injection: the file name goes into a shell command'], [A('db.users.save(user)'), 'missing await: a failed save is not caught and the reply goes out first'], [A('all.slice('), 'off-by-one: returns PAGE_SIZE + 1 rows']),
      t('```json\n' + JSON.stringify({ problems: [{ line: A('String(req.query.file'), why: 'untrusted input reaches exec' }, { line: A('db.users.save(user)'), why: 'promise not awaited' }, { line: A('all.slice('), why: 'one extra row per page' }] }) + '\n```'),
    ],
    bad: [
      problems([A('exec(`'), 'command injection'], [A('all.slice('), 'off-by-one: one row too many']),
      problems([A('exec(`'), 'command injection'], [A('db.users.save(user)'), 'missing await'], [A('all.slice('), 'off-by-one'], [A('if (user == null)'), 'use === instead of ==']),
      problems([A('exec(`'), 'command injection'], [A('db.users.save(user)'), 'missing await'], [A('all.slice('), 'off-by-one'], [A('var PAGE_SIZE'), 'use const']),
    ],
  },
  'review-big-b': {
    good: [
      problems([B('balances.set(id'), 'race: two spends at once both pass the check and the balance can go below zero'], [B('c.nickname !== null'), 'nickname is undefined when missing, so this returns undefined'], [B("path.join(DOCS, name + '.md')"), 'path traversal: name can hold ../']),
      problems([B('const before ='), 'stale balance read before the await'], [B('c.nickname !== null'), 'should be != null'], [B('async function readDoc'), 'reads any file outside docs']),
    ],
    bad: [
      problems([B('c.nickname !== null'), 'undefined nickname'], [B("path.join(DOCS, name + '.md')"), 'path traversal']),
      problems([B('balances.set(id'), 'race condition'], [B('c.nickname !== null'), 'undefined nickname'], [B("path.join(DOCS, name + '.md')"), 'path traversal'], [B('for (let i = 0'), 'use for...of']),
      problems([B('balances.set(id'), 'race condition'], [B('c.nickname !== null'), 'should use a ternary'], [B("path.join(DOCS, name + '.md')"), 'path traversal']),
    ],
  },
  'review-clean-big': {
    good: [js({ problems: [] }), t('```json\n{"problems": []}\n```')],
    bad: [problems([lineOf(CLEAN_BIG, 'var sign'), 'use const instead of var']), problems([lineOf(CLEAN_BIG, 'o.at.slice'), 'o.at may be undefined'])],
  },
  'review-xss': {
    good: [problems([lineOf(XSS, 'innerHTML'), 'XSS: author and text are put in as HTML'])],
    bad: [js({ problems: [] }), problems([lineOf(XSS, 'innerHTML'), 'XSS'], [lineOf(XSS, 'className'), 'use classList'])],
  },
  'review-await': {
    good: [problems([lineOf(AWAIT, 'db.save(it)'), 'not awaited, so the catch never sees a failed save']), problems([lineOf(AWAIT, 'saved++'), 'counts the item even when the save fails'])],
    bad: [js({ problems: [] }), problems([lineOf(AWAIT, 'db.save(it)'), 'missing await'], [lineOf(AWAIT, 'let saved'), 'should be const'])],
  },
  // planning
  'plan-project': {
    good: [
      js({ design: { start: 1, end: 2 }, backend: { start: 4, end: 7 }, frontend: { start: 5, end: 7 }, content: { start: 3, end: 4 }, testing: { start: 8, end: 9 }, launch: { start: 10, end: 10 } }),
      t('```json\n' + JSON.stringify({ design: { start: 1, end: 2 }, content: { start: 1, end: 2 }, backend: { start: 4, end: 7 }, frontend: { start: 5, end: 7 }, testing: { start: 8, end: 9 }, launch: { start: 10, end: 10 } }, null, 2) + '\n```'),
    ],
    bad: [
      js({ design: { start: 1, end: 2 }, backend: { start: 4, end: 7 }, frontend: { start: 3, end: 5 }, content: { start: 1, end: 2 }, testing: { start: 8, end: 9 }, launch: { start: 10, end: 10 } }),
      js({ design: { start: 1, end: 2 }, backend: { start: 3, end: 6 }, frontend: { start: 5, end: 7 }, content: { start: 1, end: 2 }, testing: { start: 8, end: 9 }, launch: { start: 10, end: 10 } }),
      js({ design: { start: 1, end: 2 }, backend: { start: 4, end: 7 }, frontend: { start: 5, end: 7 }, content: { start: 1, end: 2 }, testing: { start: 9, end: 10 }, launch: { start: 11, end: 11 } }),
    ],
  },
  'plan-budget': {
    good: [js({ venue: 800, food: 600, travel: 400, activities: 450, reserve: 150 }), js({ venue: 1000, food: 600, travel: 300, activities: 350, reserve: 150 })],
    bad: [js({ venue: 850, food: 600, travel: 400, activities: 450, reserve: 150 }), js({ venue: 800, food: 600, travel: 400, activities: 475, reserve: 125 }), js({ venue: 900, food: 600, travel: 400, activities: 400, reserve: 100 })],
  },
  'plan-replan': {
    good: [
      js({ plan: [{ task: 'gym', day: 'Mon', time: '07:00' }, { task: 'gym', day: 'Thu', time: '07:00' }, { task: 'gym', day: 'Sat', time: '07:00' }, { task: 'piano', day: 'Tue', time: '18:00' }, { task: 'piano', day: 'Thu', time: '18:00' }, { task: 'groceries', day: 'Sat', time: '10:00' }] }),
      js({ plan: [{ task: 'piano', day: 'Tuesday', time: '18:00' }, { task: 'Gym', day: 'Monday', time: '7:00' }, { task: 'piano', day: 'Thursday', time: '18:00' }, { task: 'gym', day: 'Thursday', time: '07:00' }, { task: 'gym', day: 'Saturday', time: '07:00' }, { task: 'groceries', day: 'Saturday', time: '10:00' }] }),
    ],
    bad: [
      js({ plan: [{ task: 'gym', day: 'Mon', time: '07:00' }, { task: 'gym', day: 'Thu', time: '07:00' }, { task: 'gym', day: 'Fri', time: '07:00' }, { task: 'piano', day: 'Tue', time: '18:00' }, { task: 'piano', day: 'Thu', time: '18:00' }, { task: 'groceries', day: 'Sat', time: '10:00' }] }),
      js({ plan: [{ task: 'gym', day: 'Tue', time: '07:00' }, { task: 'gym', day: 'Thu', time: '07:00' }, { task: 'gym', day: 'Sat', time: '07:00' }, { task: 'piano', day: 'Tue', time: '18:00' }, { task: 'piano', day: 'Thu', time: '18:00' }, { task: 'groceries', day: 'Sat', time: '10:00' }] }),
      js({ plan: [{ task: 'gym', day: 'Mon', time: '07:00' }, { task: 'gym', day: 'Wed', time: '07:00' }, { task: 'gym', day: 'Fri', time: '07:00' }, { task: 'piano', day: 'Tue', time: '18:00' }, { task: 'piano', day: 'Thu', time: '18:00' }, { task: 'groceries', day: 'Sat', time: '10:00' }] }),
    ],
  },
  'plan-rooms': {
    good: [js({ A: 'Elm', B: 'Pine', C: 'Oak', D: 'Elm', E: 'Pine' }), t('```json\n{"A": "elm", "B": "pine", "C": "oak", "D": "elm", "E": "pine"}\n```')],
    bad: [js({ A: 'Pine', B: 'Pine', C: 'Oak', D: 'Elm', E: 'Pine' }), js({ A: 'Elm', B: 'Pine', C: 'Oak', D: 'Oak', E: 'Pine' }), js({ A: 'Elm', B: 'Pine', C: 'Oak', D: 'Elm' })],
  },
  // writing
  'write-exact': {
    good: [t('The old keeper climbed the winding stairs to light the lamp tonight.'), t('"Every night, the lighthouse keeper polished the brass lamp before the storms."')],
    bad: [t('The old keeper climbed the winding stairs to light the lamp.'), t('The old keeper climbed the long winding stairs to light the lamp tonight.'), t('Here is one: the old keeper climbed the stairs to light the lamp tonight.')],
  },
  'write-acrostic': {
    good: [t('Frost paints the window glass\nRivers sleep beneath the ice\nOwls call through silent pines\nSnow drifts over sleeping fields\nThe year rests in quiet white'), t('**F**rost paints the window glass,\n**R**ivers sleep beneath the ice,\n**O**wls call through silent pines,\n**S**now drifts over sleeping fields,\n**T**he year rests in quiet white.')],
    bad: [t('Frost paints the window glass\nRivers sleep beneath the ice\nOwls call through silent pines\nTrees stand bare and still\nSnow drifts over sleeping fields'), t('Frost paints the window glass\nRivers sleep beneath the ice\nOwls call through silent pines\nSnow drifts over sleeping fields'), t('Winter\nFrost paints the window glass\nRivers sleep beneath the ice\nOwls call through silent pines\nSnow drifts over sleeping fields\nThe year rests in quiet white')],
  },
  'write-no-e': {
    good: [t('A cat sits on a sill, watching birds hop and flap. It blinks slowly, its tail curling. Rain taps glass; my cat stays calm, totally still, until a bird swoops off.')],
    bad: [t('A cat sits at the window, watching birds hop and flap. It blinks slowly, its tail curling. Rain taps glass; my cat stays calm, totally still, until a bird swoops off.'), t('A cat sits calmly at a window.')],
  },
  'write-facts': {
    good: [
      t('Birch Street pool closes for repairs 3–17 June. Use Leeds Road pool instead, open from 6:30 daily. Season passes get 14 extra days free. Lessons for ages 5–8 move to Saturdays at 9:00. Questions: front desk, 0161 555 0199.'),
      t('From 3 to 17 June the Birch Street pool is shut for repairs; swim at Leeds Road (opens 6:30am). Passes gain two weeks at no cost. Ages 5-8 lessons: Saturdays, 9am. Call 0161 555 0199.'),
    ],
    bad: [
      t('Birch Street pool closes for repairs 3–17 June. Use Leeds Road pool instead, open from 6:30 daily. Season passes get 14 extra days free. Lessons for ages 5–8 move to Saturdays at 9:00.'),
      t(NOTICE),
      t('Birch Street pool closes for repairs 3–17 June. Use Leeds Road pool instead, open from 6:30 daily. Season passes get 14 extra days. Lessons for ages 5–8 move to Saturdays at 9:00. Questions: front desk, 0161 555 0199.'),
    ],
  },
  'write-tone': {
    good: [t("We hate that your order reached you broken, and we're sending a replacement today. Please keep the broken one, there's no need to send it back."), t('Thank you for telling us. A replacement goes out today. Keep the broken one; it is yours.')],
    bad: [t("We're so sorry your order arrived broken. A replacement ships today and you can keep the broken one."), t("That's not how it should have arrived. We're sending a replacement today."), t('Unfortunately your order broke. We will send a replacement today, and you can keep the broken one.')],
  },
  'write-versions': {
    good: [
      js({ formal: 'You are invited to a team meeting on Thursday at 3 pm in Room 4 to discuss the spring budget.', casual: "We're meeting Thursday at 3 pm in Room 4 about the spring budget, see you there!" }),
      t('```json\n{"formal": "Please join the team meeting on Thursday at 3:00 p.m. in Room 4, where we will review the spring budget.", "casual": "Spring budget chat Thursday, 3pm, Room 4. Don\'t be late!"}\n```'),
    ],
    bad: [
      js({ formal: "We're holding a team meeting on Thursday at 3 pm in Room 4 on the spring budget.", casual: "We're meeting Thursday at 3 pm in Room 4, see you!" }),
      js({ formal: 'You are invited to a team meeting on Thursday at 3 pm in Room 4 to discuss the spring budget.', casual: 'Team meeting Thursday 3 pm Room 4, spring budget, see you there!' }),
      js({ formal: 'You are invited to a team meeting on Thursday at 3 pm to discuss the spring budget.', casual: "We're meeting Thursday at 3 pm in Room 4!" }),
      js({ formal: 'You are invited to a team meeting on Thursday at 3 pm in Room 4!', casual: "We're meeting Thursday at 3 pm in Room 4!" }),
    ],
  },
  // research
  'research-conflict': {
    good: [t('On weekdays it now opens from 8:00 to 18:00 [P2].'), t('It is open 8 am to 6 pm on weekdays [P2].')],
    bad: [t('It opens from 9:00 to 17:00 on weekdays [P1].'), t('It opens from 8:00 to 18:00 on weekdays.'), t('It opens from 8:00 to 18:00 on weekdays [P1].')],
  },
  'research-table': {
    good: [js({ month: 'Feb', visitorsPerEvent: 490 }), t('```json\n{"month": "February", "visitorsPerEvent": 490.0}\n```')],
    bad: [js({ month: 'Mar', visitorsPerEvent: 303 }), js({ month: 'Jan', visitorsPerEvent: 413.3 }), js({ month: 'Feb', visitorsPerEvent: 980 })],
  },
  'research-trap': {
    good: [t('The passages do not say how many books the library holds.')],
    bad: [t('It holds about 40,000 books.'), t('About 12,000 volumes.'), t('40,000.')],
  },
  'research-quote': {
    good: [t('The reading garden is open from April to September, from 10:00 until dusk.'), t('"The reading garden is open from April to September, from 10:00 until dusk." [P3]')],
    bad: [t('The reading garden is open from April to September, from 10 am until dusk.'), t('It is open from April to September, from 10:00 until dusk.')],
  },
  'research-combine': {
    good: [t('4 months.'), t('Four.')],
    bad: [t('3 months.'), t('5 months, from October to February.')],
  },
  // quick
  'quick-not': { good: [t('Carrot')], bad: [t('Carrot, because it is a vegetable.'), t('Apple')] },
  'quick-unit': { good: [t('150')], bad: [t('2.5 hours is 150 minutes.'), t('125')] },
  'quick-days': { good: [t('5')], bad: [t('6'), t('4')] },
  'quick-time': { good: [t('11:15')], bad: [t('11:05'), t('10:75')] },
  'quick-bigger': { good: [t('9.9')], bad: [t('9.11'), t('9.9 is larger than 9.11.')] },
  'quick-sale': { good: [t('68')], bad: [t('12'), t('68.5')] },
  // memory and summaries
  'bg-messy': {
    good: [js({ livesIn: 'Leeds', movingTo: 'York', job: 'nurse', dog: 'Biscuit', allergy: 'shellfish', birthday: null }), js({ livesIn: 'Leeds (moving next month)', movingTo: 'York, next month', job: 'Nurse', dog: 'Biscuit', allergy: 'Shellfish', birthday: 'unknown' })],
    bad: [js({ livesIn: 'Leeds', movingTo: 'York', job: 'nurse', dog: 'Pepper', allergy: 'shellfish', birthday: null }), js({ livesIn: 'York', movingTo: 'York', job: 'nurse', dog: 'Biscuit', allergy: 'shellfish', birthday: null }), js({ livesIn: 'Leeds', movingTo: 'York', job: 'nurse', dog: 'Biscuit', allergy: 'shellfish', birthday: 'March 3' })],
  },
  'bg-names': {
    good: [js({ Maria: { likes: 'climbing', birthday: '9 May' }, Mara: { likes: 'pottery', birthday: '19 May' } }), js({ Maria: { likes: 'Climbing', birthday: 'May 9th' }, Mara: { likes: 'pottery (not climbing)', birthday: 'May 19th' } })],
    bad: [js({ Maria: { likes: 'climbing', birthday: '19 May' }, Mara: { likes: 'pottery', birthday: '9 May' } }), js({ Maria: { likes: 'climbing', birthday: '9 May' }, Mara: { likes: 'climbing and pottery', birthday: '19 May' } })],
  },
  'bg-negation': {
    good: [js({ notes: ['Likes blues music', 'Is no longer vegetarian and eats fish now', 'Brother Tom likes jazz'] }), js({ notes: ['Likes blues', 'Eats fish now'] })],
    bad: [js({ notes: ['Likes jazz and blues', 'Eats fish now'] }), js({ notes: ['Likes blues', 'Is vegetarian', 'Eats fish'] }), js({ notes: ['Likes blues', 'Brother Tom likes jazz'] })],
  },
  'bg-dedupe': {
    good: [js({ notes: ['Flight on Friday at 7 am'] }), js({ notes: ['Has a flight leaving Friday at 07:00'] })],
    bad: [js({ notes: ['Flight on Friday', 'Flight on Friday at 7 am', 'Flight leaves at 7 in the morning on Friday'] }), js({ notes: ['Flight on Friday'] }), js({ notes: ['Flight on Friday at 7 am', 'Asked whether they mentioned it'] })],
  },
  'bg-update': {
    good: [js({ notes: ['Works at Contoso as a designer', 'Has a cat named Miso', 'Goes to the gym on Tuesdays'] }), js({ notes: ['Designer at Contoso', 'Left Northwind last week', 'Has a cat named Miso', 'Gym on Tuesdays (moved from Mondays)'] })],
    bad: [js({ notes: ['Works at Northwind as a designer', 'Works at Contoso as a designer', 'Has a cat named Miso', 'Goes to the gym on Tuesdays'] }), js({ notes: ['Works at Contoso as a designer', 'Goes to the gym on Tuesdays', 'Miso says hi'] }), js({ notes: ['Works at Contoso as a designer', 'Has a cat named Miso', 'Goes to the gym on Mondays'] })],
  },
  'bg-decided': {
    good: [t('Alex and Jo set the picnic for Sunday at 1 pm at Hill Park; Alex brings the blanket and Jo the drinks.'), t('Picnic moved to Sunday (Saturday looks like rain), 1 pm at Hill Park, with Alex on blanket and Jo on drinks.')],
    bad: [t('Picnic on Sunday at noon at Hill Park; Alex brings a blanket, Jo drinks.'), t('Alex and Jo set the picnic for Sunday at 1 pm at Hill Park.'), t('Alex and Jo will picnic Saturday at 1 pm at Hill Park with a blanket and drinks.')],
  },
  // pictures
  'see-count': { good: [t('4'), t('Four')], bad: [t('7'), t('5')] },
  'see-bars': { good: [t('THU'), t('Thu.')], bad: [t('FRI'), t('TUE')] },
  'see-odd': { good: [t('Bottom left'), t('bottom-left.')], bad: [t('Top right'), t('Bottom right')] },
  'see-table': { good: [t('2.40'), t('$2.40')], bad: [t('7'), t('1.20')] },
  'see-lines': { good: [t('MEET AT 4:15\nROOM B12\nBRING BADGE 7'), t('Meet at 4:15 / Room B12 / Bring badge 7')], bad: [t('MEET AT 4:15\nROOM 812\nBRING BADGE 7'), t('MEET AT 4:16\nROOM B12\nBRING BADGE 7'), t('MEET AT 4:15\nROOM B12')] },
  'see-switches': { good: [t('Bluetooth, Alarms'), t('BLUETOOTH, ALARMS')], bad: [t('Wi-Fi, Location'), t('Bluetooth'), t('Bluetooth, Alarms, Location')] },
};
for (const [id, f] of Object.entries(HARD)) {
  GOOD[id] = f.good[0];
  BAD[id] = f.bad[0];
}
/** Every right answer and every wrong one per task (the easy tier has one of each). */
export const ALL_GOOD = (id: string): Answer[] => HARD[id]?.good ?? (GOOD[id] ? [GOOD[id]] : []);
export const ALL_BAD = (id: string): Answer[] => HARD[id]?.bad ?? (BAD[id] ? [BAD[id]] : []);

/** Toy embeddings: words of one topic share an axis, so near pairs line up and far ones don't. */
export const EMBED_AXES = [
  /lake|cabin|pine|trip/i,
  /tax|forms|april/i,
  /shoes|sneakers|running|jogging/i,
  /budget|meeting|quarterly/i,
  /dentista|cita|turno/i,
  /mercado|tomates|pan\b/i,
  /will not start|refuses to turn over/i,
  /feeling blue|sad and low/i,
  /garer mon vélo|parking pour bicyclettes/i,
  /apotheke/i,
  /train station|estación de tren/i,
  /reset my password|get back into your account/i,
];
export const toyVector = (s: string): number[] => EMBED_AXES.map((re) => (re.test(s) ? 1 : 0) + 0.01);
