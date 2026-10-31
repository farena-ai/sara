// Phase 101 (ST6, docs/design/STAPLES.md §9.3): the one-time backfill. Reads the facts and dates she
// already remembers in batches of 40 and proposes people from them: code finds "his brother Jeff"
// on its own, and (when a background model is set and the budget allows: 200k tokens by default)
// the model reads each batch too. Notes from private conversations never go to the model. Every
// card it makes is *proposed*: nothing reaches recall until he accepts it (or it's mentioned in 3
// conversations). The result is the proposal card "I found N people in what I remember".
import type { AppContext } from './chat.ts';
import type { Memory } from './memory.ts';
import { type AboutItem, BACKFILL_BATCH, BACKFILL_BUDGET, type BackfillStatus, fold } from './people.ts';
import { usageScope } from './usage.ts';

const MODEL_MAX_TOKENS = 700;

export function backfillPrompt(owner: string, notes: { id: number; content: string }[]): string {
  return `Below are notes about ${owner}, one per line with its number. Find the people in ${owner}'s life they mention (not ${owner}, not pets, not companies or places, not famous people). For each person give the name as written, who they are to ${owner} when a note says it ("my brother", "my manager", or to someone else: "Jeff's wife"), and the numbers of the notes about them.

${notes.map((n) => `${n.id}. ${n.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}

Return ONLY a JSON object: {"people": [{"name": "...", "relation": "..." or null, "notes": [1, 2]}]}. Use {"people": []} when there are none.`;
}

export function parseBackfill(text: string): { name: string; relation: string | null; notes: number[] }[] {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  try {
    const j = JSON.parse(cleaned.slice(a, b + 1)) as { people?: unknown };
    if (!Array.isArray(j.people)) return [];
    return j.people
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string')
      .slice(0, 60)
      .map((p) => ({ name: String(p.name).trim().slice(0, 80), relation: typeof p.relation === 'string' && p.relation.trim() ? p.relation.trim().slice(0, 80) : null, notes: Array.isArray(p.notes) ? p.notes.map(Number).filter((n) => Number.isInteger(n)) : [] }))
      .filter((p) => p.name.length >= 2);
  } catch {
    return [];
  }
}

const running = new WeakMap<object, Promise<BackfillStatus>>();

/** Starts the backfill in the background (once at a time per store); returns the status now. */
export function startBackfill(app: AppContext, opts: { budget?: number; useModel?: boolean } = {}): BackfillStatus {
  const people = app.people;
  if (!people || !app.memory) throw new Error('People cards are not available here.');
  if (!running.has(people)) {
    const p = usageScope.run({ purpose: 'memory' }, () => runBackfill(app, opts)).finally(() => running.delete(people));
    running.set(people, p);
    p.catch(() => undefined);
  }
  return people.backfillStatus();
}
/** Tests: wait for a running backfill. */
export function backfillDone(app: AppContext): Promise<BackfillStatus> | undefined {
  return app.people ? running.get(app.people) : undefined;
}

export async function runBackfill(app: AppContext, opts: { budget?: number; useModel?: boolean } = {}): Promise<BackfillStatus> {
  const people = app.people!;
  const mem = app.memory!;
  const budget = opts.budget ?? BACKFILL_BUDGET;
  const notes = mem.listAll().filter((m) => (m.kind === 'fact' || m.kind === 'date') && m.supersededBy === null && !people.isPersonMemory(m.id));
  const st: BackfillStatus = { state: 'running', done: 0, total: notes.length, tokens: 0, budget, proposed: 0, usedModel: false, startedAt: app.now().toISOString() };
  people.setBackfillStatus(st);
  const before = new Set(people.list({ status: 'all' }).map((p) => p.id));
  const owner = app.settings.get().ownerName?.trim() || 'the owner';
  const isPrivate = (m: Memory) => Boolean(m.conversationId && app.store.getConversation(m.conversationId)?.private);
  let conv: import('./store.ts').Conversation | undefined;
  let complete: typeof import('./life.ts').complete | undefined;
  if (opts.useModel !== false) {
    try {
      const life = await import('./life.ts');
      complete = life.complete;
      conv = life.targetConversation(app) ?? app.store.listConversations().find((c) => !c.partner && !c.private);
    } catch {
      complete = undefined;
    }
  }
  const found = new Map<number, AboutItem[]>();
  const add = (id: number, item: AboutItem) => {
    const list = found.get(id) ?? [];
    const same = list.find((x) => fold(x.name) === fold(item.name));
    if (same) {
      if (!same.relation && item.relation) same.relation = item.relation;
    } else list.push(item);
    found.set(id, list);
  };
  try {
    for (let i = 0; i < notes.length; i += BACKFILL_BATCH) {
      const batch = notes.slice(i, i + BACKFILL_BATCH);
      for (const m of batch) for (const item of people.aboutFromText(m.content)) add(m.id, item);
      const forModel = batch.filter((m) => !isPrivate(m));
      if (complete && conv && forModel.length && st.tokens < budget) {
        const prompt = backfillPrompt(owner, forModel.map((m) => ({ id: m.id, content: m.content })));
        try {
          const out = await complete(app, conv, [{ role: 'system', content: 'You find people in notes. Output only valid JSON.' }, { role: 'user', content: prompt }], MODEL_MAX_TOKENS, 'background');
          st.tokens += Math.ceil((prompt.length + out.length) / 4);
          st.usedModel = true;
          const byId = new Map(forModel.map((m) => [m.id, m]));
          for (const p of parseBackfill(out)) {
            const first = fold(p.name.split(/\s+/)[0]);
            for (const id of p.notes) {
              const m = byId.get(id);
              // The name must really be in that note (no invented people).
              if (m && fold(m.content).includes(first)) add(id, { name: p.name, relation: p.relation });
            }
          }
        } catch (err) {
          st.tokens += Math.ceil(prompt.length / 4);
          console.warn(`people backfill: ${(err as Error).message}`);
        }
      }
      for (const m of batch) {
        const items = found.get(m.id);
        if (items?.length) people.linkMemory(m, items, { private: isPrivate(m) });
      }
      st.done = Math.min(notes.length, i + batch.length);
      people.setBackfillStatus({ ...st });
      // A breath between batches (the server keeps answering).
      await new Promise((r) => setTimeout(r, 0));
    }
    // Notes that name someone found above without saying who they are go on that card too.
    const names = people.list({ status: 'all' }).filter((p) => !before.has(p.id) || p.status === 'proposed');
    for (const m of notes) {
      if (people.isPersonMemory(m.id)) continue;
      const items = names.filter((p) => new RegExp(`(?<![\\p{L}])${fold(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(fold(m.content))).map((p) => ({ name: p.name }));
      if (items.length) people.linkMemory(m, items, { private: isPrivate(m) });
    }
    st.proposed = people.list({ status: 'proposed' }).filter((p) => !before.has(p.id)).length;
    st.state = 'done';
  } catch (err) {
    st.state = 'failed';
    st.error = (err as Error).message.slice(0, 300);
  }
  st.endedAt = app.now().toISOString();
  people.setBackfillStatus({ ...st });
  app.events?.publish({ type: 'people', what: 'backfill' });
  return st;
}
