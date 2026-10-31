// Phase 97 (ST2, docs/design/STAPLES.md §5.9): the offline eval of \"make this a skill?\" offers.
// 40 scripted conversations with 6 planted repeats (the same kind of request, worded differently,
// 3 times on 2 days) and 6 near misses (the same day only, twice only, the same words for different
// kinds of work, different tasks that share a word, repeats spread wider than the look-back, and
// repeats she got wrong), plus a few one-off asks. Two sets: the tuning set and a held-out set
// written after the thresholds were set (other wordings, other tasks). Run by hand:
//   node scripts/eval-learning.ts                 word vectors (no embeddings job)
//   node scripts/eval-learning.ts --ollama        meaning vectors from a local Ollama (nomic-embed-text)
// Pass: ≥ 5 of 6 planted repeats offered and ≤ 1 false offer, on each set.
import { join } from 'node:path';
import { runTurn } from '../src/chat.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { SkillLearner } from '../src/skill-learning.ts';
import { SkillStore } from '../src/skill-store.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, tempDir, text, call } from '../test/helpers.ts';
import type { StreamEvent } from '../src/providers/types.ts';

type Ask = { day: number; said: string; tools?: string[]; corrected?: boolean };
interface Case {
  id: string;
  planted: boolean;
  asks: Ask[];
}

const TUNING: Case[] = [
  // Planted repeats (3 asks on 2 days each).
  { id: 'sales-sheet', planted: true, asks: [{ day: 1, said: 'please put the weekly sales numbers into the team spreadsheet' }, { day: 1, said: 'put this week’s sales numbers into the team spreadsheet please' }, { day: 3, said: 'can you put the weekly sales numbers in the team spreadsheet again' }] },
  { id: 'menu-es', planted: true, asks: [{ day: 2, said: 'translate the cafeteria menu into spanish for the newsletter' }, { day: 4, said: 'please translate this cafeteria menu into spanish for the newsletter' }, { day: 4, said: 'translate the new cafeteria menu into spanish for our newsletter' }] },
  { id: 'team-mail', planted: true, asks: [{ day: 1, said: 'summarise the unread email from my team', tools: ['gmail_search'] }, { day: 2, said: 'summarise my unread team email please', tools: ['gmail_search'] }, { day: 5, said: 'give me a summary of the unread email from the team', tools: ['gmail_search'] }] },
  { id: 'groceries', planted: true, asks: [{ day: 3, said: 'add milk eggs and bread to the shopping list', tools: ['shared_list'] }, { day: 6, said: 'add eggs bread and milk to our shopping list', tools: ['shared_list'] }, { day: 6, said: 'please add bread milk and eggs to the shopping list', tools: ['shared_list'] }] },
  { id: 'run-weather', planted: true, asks: [{ day: 2, said: 'check the weather tomorrow morning and plan my run route', tools: ['web_fetch'] }, { day: 7, said: 'check tomorrow morning weather and plan a run route for me', tools: ['web_fetch'] }, { day: 8, said: 'look at the weather for tomorrow morning and plan my run route', tools: ['web_fetch'] }] },
  { id: 'release-post', planted: true, asks: [{ day: 4, said: 'write a linkedin post about the new release of the app' }, { day: 5, said: 'write a linkedin post about our new app release' }, { day: 9, said: 'please write a linkedin post about the app release' }] },
  // Near misses.
  { id: 'same-day', planted: false, asks: [{ day: 3, said: 'convert the meeting notes into a numbered action list' }, { day: 3, said: 'convert these meeting notes into a numbered action list' }, { day: 3, said: 'please convert the meeting notes to a numbered action list' }] },
  { id: 'twice', planted: false, asks: [{ day: 2, said: 'draft a thank you note for the plumber who fixed the sink' }, { day: 6, said: 'draft a thank you note for the plumber who fixed our sink' }] },
  { id: 'same-words-other-kinds', planted: false, asks: [{ day: 1, said: 'summarise the latest updates for the project', tools: ['web_fetch'] }, { day: 4, said: 'summarise the latest updates for the project', tools: ['shared_list'] }, { day: 6, said: 'summarise the latest updates for the project', tools: ['gmail_search'] }] },
  { id: 'shared-word', planted: false, asks: [{ day: 1, said: 'write a short poem about autumn leaves' }, { day: 4, said: 'write a limerick about my lazy cat' }, { day: 8, said: 'write a haiku about the sea at night' }] },
  { id: 'too-spread', planted: false, asks: [{ day: 1, said: 'prepare the quarterly tax summary for the accountant' }, { day: 20, said: 'prepare the quarterly tax summary for my accountant' }, { day: 45, said: 'please prepare the quarterly tax summary for the accountant' }] },
  { id: 'got-wrong', planted: false, asks: [{ day: 2, said: 'format the guest list as a table sorted by surname', corrected: true }, { day: 5, said: 'format the guest list as a table sorted by surname please', corrected: true }, { day: 7, said: 'format our guest list as a table sorted by surname', corrected: true }] },
  // One-offs.
  { id: 'one-1', planted: false, asks: [{ day: 2, said: 'hi, how was your day?' }] },
  { id: 'one-2', planted: false, asks: [{ day: 5, said: 'explain how compound interest works' }] },
  { id: 'one-3', planted: false, asks: [{ day: 6, said: 'find a good name for a fishing boat' }] },
  { id: 'one-4', planted: false, asks: [{ day: 8, said: 'thanks, that was perfect' }] },
  { id: 'one-5', planted: false, asks: [{ day: 9, said: 'what should I cook tonight?' }] },
];

const HELD_OUT: Case[] = [
  { id: 'invoice', planted: true, asks: [{ day: 1, said: 'make the monthly invoice for the design client from the hours log' }, { day: 2, said: 'make this month’s invoice for the design client from my hours log' }, { day: 2, said: 'please make the monthly design client invoice from the hours log' }] },
  { id: 'standup', planted: true, asks: [{ day: 3, said: 'write my standup update from yesterday’s tasks', tools: ['list_tasks'] }, { day: 4, said: 'write the standup update from my tasks of yesterday', tools: ['list_tasks'] }, { day: 6, said: 'please write my standup update from yesterday tasks', tools: ['list_tasks'] }] },
  { id: 'newsletter-links', planted: true, asks: [{ day: 2, said: 'collect the best links of the week for the newsletter', tools: ['web_fetch'] }, { day: 5, said: 'collect this week’s best links for the newsletter', tools: ['web_fetch'] }, { day: 9, said: 'please collect the week’s best links for our newsletter', tools: ['web_fetch'] }] },
  { id: 'reply-landlord', planted: true, asks: [{ day: 1, said: 'reply to the landlord email about the rent receipt', tools: ['gmail_search'] }, { day: 6, said: 'reply to the email from the landlord about my rent receipt', tools: ['gmail_search'] }, { day: 7, said: 'please reply to the landlord’s rent receipt email', tools: ['gmail_search'] }] },
  { id: 'recipe-scale', planted: true, asks: [{ day: 4, said: 'scale the lasagna recipe for eight people and list the shopping' }, { day: 8, said: 'scale this lasagna recipe for eight people and list what to shop' }, { day: 8, said: 'scale the lasagna recipe to eight people and list the shopping' }] },
  { id: 'kids-schedule', planted: true, asks: [{ day: 2, said: 'put the kids football practice times into the family calendar', tools: ['calendar_add'] }, { day: 3, said: 'put the football practice times for the kids into the family calendar', tools: ['calendar_add'] }, { day: 9, said: 'please put the kids football practice times in the family calendar', tools: ['calendar_add'] }] },
  { id: 'ho-same-day', planted: false, asks: [{ day: 5, said: 'rename the holiday photos by date and place' }, { day: 5, said: 'rename these holiday photos by date and place' }, { day: 5, said: 'please rename the holiday photos by place and date' }] },
  { id: 'ho-twice', planted: false, asks: [{ day: 1, said: 'list three gift ideas for my sister' }, { day: 7, said: 'list three gift ideas for my sister again' }] },
  { id: 'ho-kinds', planted: false, asks: [{ day: 2, said: 'check what is new today', tools: ['web_fetch'] }, { day: 5, said: 'check what is new today', tools: ['gmail_search'] }, { day: 8, said: 'check what is new today', tools: ['list_tasks'] }] },
  { id: 'ho-shared-word', planted: false, asks: [{ day: 2, said: 'plan a birthday party for my nephew' }, { day: 5, said: 'plan a weekend hike in the mountains' }, { day: 8, said: 'plan the menu for a dinner with friends' }] },
  { id: 'ho-spread', planted: false, asks: [{ day: 1, said: 'write the yearly review of my reading list' }, { day: 35, said: 'write the yearly review of my reading list' }, { day: 70, said: 'write the yearly review of the reading list' }] },
  { id: 'ho-wrong', planted: false, asks: [{ day: 3, said: 'turn the budget notes into a pie chart description', corrected: true }, { day: 6, said: 'turn my budget notes into a pie chart description', corrected: true }, { day: 7, said: 'turn the budget notes into a pie chart description please', corrected: true }] },
  { id: 'ho-one-1', planted: false, asks: [{ day: 3, said: 'good morning!' }] },
  { id: 'ho-one-2', planted: false, asks: [{ day: 4, said: 'what is the capital of australia' }] },
  { id: 'ho-one-3', planted: false, asks: [{ day: 6, said: 'tell me a joke about penguins' }] },
  { id: 'ho-one-4', planted: false, asks: [{ day: 9, said: 'ok cool, talk later' }] },
  { id: 'ho-one-5', planted: false, asks: [{ day: 9, said: 'remind me what we talked about yesterday' }] },
];

const stub = (name: string): Tool => ({ defaultPermission: 'auto', spec: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } }, summarize: () => name, run: async () => 'ok' });

async function runSet(name: string, cases: Case[], ollama: boolean): Promise<{ offered: number; planted: number; falseOffers: string[]; missed: string[]; conversations: number }> {
  const { dir, cleanup } = tempDir();
  const start = new Date('2026-09-01T12:00:00Z');
  const clock = { now: start };
  const app = makeApp(dir, clock);
  try {
    // The six built-in starter skills are there, as on a real server (a request one covers isn't a new offer).
    app.skills = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), builtinDir: join(import.meta.dirname, '..', 'skills'), now: () => clock.now });
    const runs = new RunStore(app.store.db, () => clock.now);
    runs.settings = () => runSettings(app.settings.get());
    app.runs = runs;
    for (const t of ['gmail_search', 'shared_list', 'web_fetch', 'list_tasks', 'calendar_add']) app.tools.add(stub(t));
    app.settings.update({
      providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }, ...(ollama ? [{ id: 'emb', label: 'Ollama', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', local: true }] : [])],
      defaultProviderId: 'p',
      defaultModel: 'm',
      ownerName: 'Alex',
      timeZone: 'UTC',
      disclosureAcceptedAt: start.toISOString(),
      // The eval counts what would be offered, so the daily cap doesn't hide one.
      skillLearning: { perDay: 3 },
      ...(ollama ? { routes: { embeddings: { providerId: 'emb', model: 'nomic-embed-text' } } } : {}),
    });
    const learner = new SkillLearner(app);
    app.learning = learner;
    // Every ask in day order (the asks of different cases interleave as in real life).
    const all = cases.flatMap((c) => c.asks.map((a, i) => ({ c, a, i })));
    all.sort((x, y) => x.a.day - y.a.day || x.i - y.i);
    const byCase = new Map<string, Set<number>>();
    let conversations = 0;
    for (const { c, a } of all) {
      clock.now = new Date(start.getTime() + (a.day - 1) * 86_400_000 + (conversations % 6) * 600_000);
      const conv = app.store.createConversation();
      conversations++;
      const steps: StreamEvent[][] = a.tools?.length ? [a.tools.map((t, k) => call(`c${conversations}-${k}`, t, {})), text('Done.')] : [text('Done.')];
      app.script.push(...steps, text('{}'));
      for await (const ev of runTurn(app, conv.id, a.said)) void ev;
      await learner.work;
      if (a.corrected) {
        app.script.length = 0;
        app.script.push(text('Sorry.'), text('{}'));
        for await (const ev of runTurn(app, conv.id, "no, that's wrong")) void ev;
        await learner.work;
      }
      app.script.length = 0;
      const offered = new Set<number>();
      for (const cand of learner.store.candidates({ status: ['offered'] })) offered.add(cand.id);
      // Which case each new offer belongs to: the candidate whose examples hold this case's messages.
      for (const cand of learner.store.candidates({ status: ['offered'] })) {
        const convIds = new Set(cand.examples.map((e) => e.conversationId));
        if (convIds.has(conv.id)) byCase.set(c.id, new Set([...(byCase.get(c.id) ?? []), cand.id]));
      }
      // Answer every offer with Not now so the next one can come (the cap is per day).
      for (const id of offered) await learner.decideOffer(id, 'later');
      await learner.work;
    }
    const models = [...new Set(learner.store.candidates({ kind: 'ask' }).map((c) => c.model ?? 'words'))].join(', ');
    const planted = cases.filter((c) => c.planted);
    const missed = planted.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    const falseOffers = cases.filter((c) => !c.planted && byCase.has(c.id)).map((c) => c.id);
    console.log(`${name}: ${conversations} conversations; planted repeats offered ${planted.length - missed.length} of ${planted.length}${missed.length ? ` (missed: ${missed.join(', ')})` : ''}; false offers ${falseOffers.length}${falseOffers.length ? ` (${falseOffers.join(', ')})` : ''}; vectors: ${models}`);
    return { offered: planted.length - missed.length, planted: planted.length, falseOffers, missed, conversations };
  } finally {
    app.store.close();
    cleanup();
  }
}

const ollama = process.argv.includes('--ollama');
console.log(`Vectors: ${ollama ? 'nomic-embed-text through a local Ollama (cosine ≥ 0.82)' : 'word vectors, no embeddings job (cosine ≥ 0.6)'}`);
const a = await runSet('tuning set', TUNING, ollama);
const b = await runSet('held-out set', HELD_OUT, ollama);
const ok = [a, b].every((r) => r.offered >= 5 && r.falseOffers.length <= 1);
console.log(ok ? 'PASS: ≥ 5 of 6 offered and ≤ 1 false offer on both sets.' : 'FAIL: below the bar (≥ 5 of 6, ≤ 1 false).');
process.exitCode = ok ? 0 : 1;
