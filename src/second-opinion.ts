// D8 (docs/design/D8SECOND.md): "Get a second opinion" on one of her replies. Two other connected
// models answer the same question on their own (her reply is not shown to them, no tools), and the
// web marks where the answers differ: a sentence only one answer has, or the same sentence with
// other numbers in it. The spend is estimated before anything is sent; private chats (and private
// local mode) only ever use models on this computer; past the spend limit no pay-per-use model is
// offered. The candidates and their ranking come from Auto (src/auto-route.ts), so household
// members only see the models they are allowed and the cost autopilot's rules apply unchanged.
import { autoCandidates, autoChoose, spendLimitHit, type AutoCand } from './auto-route.ts';
import { cheapCall, isLocalModel } from './cheap.ts';
import { resolveProvider, type AppContext } from './chat.ts';
import { HttpError } from './http.ts';
import { en } from './i18n.ts';
import { privateLocalOn } from './net-guard.ts';
import type { ChatMessage } from './providers/types.ts';
import type { Conversation, StoredMessage } from './store.ts';
import { costOf, findPrice, priceTable, type Billing } from './usage.ts';

/** Second opinions a day (each asks two models), so a stuck button can't run up a bill. */
export const SECOND_OPINION_CAP = 40;
/** How many other models answer. */
export const SECOND_OPINION_MODELS = 2;
const MAX_TOKENS = 1200;
const HISTORY = 8;
const SYSTEM = 'You are giving a second opinion. Answer the last message yourself, plainly and briefly, in the language it is written in. Say so when you are not sure.';

export interface OpinionModel {
  providerId: string;
  provider: string;
  model: string;
  local: boolean;
  billing: Billing;
  /** Estimated dollars for this one answer; 0 = free (on this computer or a subscription), null = price unknown. */
  estUsd: number | null;
}

export interface OpinionPlan {
  /** The two picked first (Auto's ranking, different providers when possible). */
  models: OpinionModel[];
  /** Every model that may answer here (to swap one in). */
  choices: OpinionModel[];
  /** The two picks together (unknown prices count 0; see `unknown`). */
  estUsd: number;
  unknown: boolean;
  /** Only models on this computer (private chat or private local mode). */
  private: boolean;
  spendHit: boolean;
}

export type PartKind = 'same' | 'only' | 'number';
export interface Part {
  text: string;
  kind: PartKind;
}
export interface OpinionAnswer {
  mine?: boolean;
  providerId?: string;
  provider: string;
  model: string;
  local?: boolean;
  text: string;
  error?: string;
  parts: Part[];
}
export interface OpinionResult {
  at: string;
  answers: OpinionAnswer[];
  /** Parts that are not shared, over every answer. */
  differ: number;
}

const key = (p: { providerId: string; model: string }) => `${p.providerId}/${p.model}`;

/** The question her reply answered: the chat up to it (text only, her reply left out). */
function questionOf(app: AppContext, conv: Conversation, reply: StoredMessage): ChatMessage[] {
  const before = app.store.messages(conv.id).filter((m) => m.id < reply.id && (m.role === 'user' || m.role === 'assistant') && m.content.trim());
  const last = before.map((m) => m.role).lastIndexOf('user');
  if (last < 0) throw new HttpError(409, 'There is no question before this reply to ask about.');
  const lines = before.slice(0, last + 1).slice(-HISTORY);
  return [{ role: 'system', content: SYSTEM }, ...lines.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 6000) }))];
}

/** A reply of hers in this chat (404 otherwise). */
export function replyOf(app: AppContext, conv: Conversation, id: number): StoredMessage {
  const m = Number.isInteger(id) ? app.store.messageById(id) : undefined;
  if (!m || m.conversationId !== conv.id || m.role !== 'assistant' || !m.content.trim()) throw new HttpError(404, 'That reply was not found.');
  return m;
}

/** What one answer may cost: the question in, about her reply's length out. */
function estimate(app: AppContext, c: AutoCand, inTokens: number, outTokens: number): number | null {
  const table = priceTable(app.settings.get().prices);
  return costOf(c.billing, findPrice(table, c.providerId, c.model), { input: inTokens, output: outTokens });
}

/** The models that may give a second opinion on this reply, and the two picked first. */
export function secondOpinionPlan(app: AppContext, conv: Conversation, reply: StoredMessage): OpinionPlan {
  const localOnly = Boolean(conv.private) || privateLocalOn();
  const spendHit = spendLimitHit(app);
  const messages = questionOf(app, conv, reply);
  const inTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
  const outTokens = Math.min(MAX_TOKENS, Math.max(150, Math.ceil((reply.content.length / 4) * 1.3)));
  const answered = { model: String(reply.meta?.model ?? ''), provider: String(reply.meta?.provider ?? '') };
  const cands = autoCandidates(app);
  const byKey = new Map(cands.map((c) => [key(c), c]));
  const ranked = autoChoose(cands, 'chat', { localOnly, spendHit }, 99)
    .map((p) => byKey.get(key(p))!)
    // Never the model that already answered; in a private chat, local is checked twice.
    .filter((c) => !(c.model === answered.model && (!answered.provider || c.provider === answered.provider)))
    .filter((c) => !localOnly || (c.local && isLocalModel(app.settings.get().providers.find((p) => p.id === c.providerId)!, c.model)));
  const choices: OpinionModel[] = ranked.map((c) => ({ providerId: c.providerId, provider: c.provider, model: c.model, local: c.local, billing: c.billing, estUsd: estimate(app, c, inTokens, outTokens) }));
  // Two different providers first (two views from different makers), then anything left.
  const models: OpinionModel[] = [];
  for (const c of choices) if (models.length < SECOND_OPINION_MODELS && !models.some((m) => m.providerId === c.providerId)) models.push(c);
  for (const c of choices) if (models.length < SECOND_OPINION_MODELS && !models.includes(c)) models.push(c);
  return { models, choices, estUsd: Math.round(models.reduce((n, m) => n + (m.estUsd ?? 0), 0) * 1e8) / 1e8, unknown: models.some((m) => m.estUsd === null), private: localOnly, spendHit };
}

/** 409 with a plain reason when no other model may answer here. */
export function needChoices(plan: OpinionPlan): void {
  if (plan.choices.length) return;
  throw new HttpError(409, plan.private ? en('This chat is private, and no other model on this computer is connected to give a second opinion.') : en('No other model is connected to give a second opinion. Add one in Settings → Models & usage.'));
}

/** Ask two other models; keeps the result on the reply (meta.secondOpinion). */
export async function askSecondOpinion(app: AppContext, conv: Conversation, reply: StoredMessage, wanted?: { providerId: string; model: string }[]): Promise<OpinionResult> {
  const plan = secondOpinionPlan(app, conv, reply);
  needChoices(plan);
  let picks = plan.models;
  if (wanted?.length) {
    const allowed = new Map(plan.choices.map((c) => [key(c), c]));
    picks = [];
    for (const w of wanted.slice(0, SECOND_OPINION_MODELS)) {
      const c = allowed.get(key({ providerId: String(w.providerId), model: String(w.model) }));
      if (!c) throw new HttpError(400, plan.private ? en('This chat is private: only models on this computer may give a second opinion.') : en('That model cannot give a second opinion here.'));
      if (!picks.includes(c)) picks.push(c);
    }
  }
  const messages = questionOf(app, conv, reply);
  const answers = await Promise.all(
    picks.map(async (m): Promise<Omit<OpinionAnswer, 'parts'>> => {
      const base = { providerId: m.providerId, provider: m.provider, model: m.model, local: m.local };
      let route;
      try {
        route = [{ ...resolveProvider(app, m.providerId, m.model, { purpose: 'second-opinion', conversationId: conv.id }), from: 'default' as const }];
      } catch (err) {
        return { ...base, text: '', error: (err as Error).message.slice(0, 200) };
      }
      const r = await cheapCall(app, { source: 'second-opinion', purpose: 'second-opinion', conv, model: 'quick', route, messages, maxTokens: MAX_TOKENS, temperature: 0.3, cap: { runs: SECOND_OPINION_CAP * SECOND_OPINION_MODELS }, timeoutMs: 90_000 });
      if (!r.ok) return { ...base, text: '', error: r.skipped === 'cap' ? en('Today’s second opinions are used up.') : r.reason };
      return { ...base, text: r.text };
    }),
  );
  const all: Omit<OpinionAnswer, 'parts'>[] = [{ mine: true, provider: String(reply.meta?.provider ?? ''), model: String(reply.meta?.model ?? ''), text: reply.content }, ...answers];
  const withText = all.filter((a) => a.text);
  const diffs = diffAnswers(withText.map((a) => a.text));
  const out: OpinionAnswer[] = all.map((a) => ({ ...a, parts: a.text ? diffs[withText.indexOf(a)] : [] }));
  const result: OpinionResult = { at: app.now().toISOString(), answers: out, differ: out.reduce((n, a) => n + a.parts.filter((p) => p.kind !== 'same').length, 0) };
  app.store.updateMessageMeta(reply.id, { secondOpinion: result });
  return result;
}

// ---------- where the answers differ ----------

const STOP = new Set('the a an and or but to of it is are was be in on at for with as so then that this these those you your i we they he she its by from not no do does'.split(' '));
const NUM = /\d+(?:[.,]\d+)?/g;

/** Sentences, each with its trailing space, so joining them gives the text back. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?]+(?=\s|$)\s*|\n\s*/g;
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const to = m.index + m[0].length;
    if (to > from) out.push(text.slice(from, to));
    from = to;
    if (!m[0].length) re.lastIndex++;
  }
  if (from < text.length) out.push(text.slice(from));
  return out.length ? out : [text];
}

const wordsOf = (s: string) => new Set((s.toLowerCase().replace(NUM, ' ').match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)));
const numsOf = (s: string) => [...(s.match(NUM) ?? [])].map((n) => n.replace(',', '.')).sort().join(' ');

function alike(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  const jaccard = both / (a.size + b.size - both);
  return jaccard >= 0.5 || (Math.min(a.size, b.size) >= 3 && both / Math.min(a.size, b.size) >= 0.8);
}

/**
 * For each answer, its sentences marked: `same` (another answer says it too), `number` (another
 * answer has the same sentence with other numbers), `only` (no other answer says it).
 */
export function diffAnswers(texts: string[]): Part[][] {
  const split = texts.map((t) => sentences(t).map((s) => ({ s, w: wordsOf(s), n: numsOf(s) })));
  return split.map((mine, i) =>
    mine.map(({ s, w, n }) => {
      if (!w.size) return { text: s, kind: 'same' as const };
      let kind: PartKind = 'only';
      for (const [j, other] of split.entries()) {
        if (j === i) continue;
        for (const o of other) {
          if (!alike(w, o.w)) continue;
          if (o.n === n) return { text: s, kind: 'same' as const };
          kind = 'number';
        }
      }
      return { text: s, kind };
    }),
  );
}
