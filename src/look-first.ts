// T53: look first, then answer. Owner report (2026-11-27): asked a question, she "will almost
// hallucinate an answer or sometimes fully hallucinate an answer instead of defaulting to research".
// His server's own history showed why the written rules were not enough: of the last 201 replies,
// 7 used a tool and none searched the web; the models he talks with answer from what they think
// they know. So the app does the looking itself, before the model writes a word:
//   1. code decides whether his message can be a question at all (no model call for small talk);
//   2. one small model call says what it needs: nothing, her memory, the web (with the words to
//      search for), or both;
//   3. the app looks through her past conversations and/or searches the web, and hands her what it
//      found with the rule to answer from that and name the source, or to say she is not sure.
// A story, a game or roleplay is left alone. Nothing here runs in a private conversation's web
// part, for other people's chats, for another app's turn or in a crisis. Settings → Models & usage:
// "Check facts before she answers": Look it up first (default) / Offer to look it up / Off.
import type { AppContext } from './chat.ts';
import { cheapCall, fenceLines } from './cheap.ts';
import { searchConfig } from './integrations.ts';
import { ftsQuery } from './memory.ts';
import { privateLocalOn } from './net-guard.ts';
import { formatHits, recallMessages, topicOf, turnSpaceSql } from './recall.ts';
import type { Conversation } from './store.ts';
import { runSearch, type SearchResult } from './tools/search.ts';

export type LookFirstMode = 'auto' | 'offer' | 'off';
export const lookFirstMode = (s: { lookFirst?: unknown }): LookFirstMode => (s.lookFirst === 'offer' || s.lookFirst === 'off' ? s.lookFirst : 'auto');

/** What his message needs before she answers. */
export type LookNeed = { kind: 'none' } | { kind: 'memory' } | { kind: 'web'; query: string } | { kind: 'both'; query: string };

export const LOOK_FIRST = { minChars: 10, maxChars: 900, results: 5, planTokens: 40, planMs: 8_000, searchMs: 12_000, dailyRuns: 400, lines: 4, lineChars: 300 };

// Words a question or a request to be told something starts with, in the app's six languages.
const ASK_START =
  /^(?:\W{0,3})(?:what|who|whom|whose|when|where|which|why|how|is|are|was|were|does|do|did|can|could|should|will|would|has|have|tell me|explain|list|give me|show me|find|look up|search|compare|any idea|qué|que|quién|quien|cuándo|cuando|dónde|donde|cuál|cual|por qué|cómo|como|dime|explica|quel|quelle|quels|quelles|qui|quand|où|pourquoi|comment|combien|dis-moi|explique|est-ce|was|wer|wann|wo|welche|welcher|welches|warum|wieso|wie|erklär|erkläre|sag mir|o que|quem|quando|onde|qual|por que|me diga|explique|cosa|che|chi|dove|quale|perché|come|dimmi|spiega)\b/i;

/** Code only: can this message be a question worth a look? (Cheap; the small model call decides the rest.) */
export function mayNeedLook(text: string): boolean {
  const t = text.trim();
  if (t.length < LOOK_FIRST.minChars || t.length > LOOK_FIRST.maxChars || t.startsWith('/')) return false;
  return /[?？]/.test(t) || ASK_START.test(t);
}

export const LOOK_PLAN_PROMPT = `You decide what an assistant must check before she answers the person's newest message. Reply with ONE line and nothing else:
NONE
MEMORY
WEB: <search words>
BOTH: <search words>

NONE: small talk, feelings, opinions, jokes, anything about the assistant herself, creative writing, a story, game or roleplay the two are playing, a task for a tool (reminders, files), or a question the earlier lines already answer.
MEMORY: about the person's own life, plans, preferences, people they know, or what the two said or did before.
WEB: a question about the real world where a wrong answer matters or the facts may have changed: news, current events, prices, releases, versions, patch notes, game or product details, sports, people in public life, laws and rules, schedules, statistics, how to do something specific, or any exact name, number or date.
BOTH: the real world and the person's own past together.
When unsure between NONE and WEB for a real-world fact, choose WEB.
The search words: at most 12, what a careful person would type into a search engine, with the topic from the earlier lines when the newest message only says "it" or "that". Never put the person's name, private people's names, addresses, health or money details in them.`;

/** Reads the planner's one line. Anything unclear is "none": a look is only ever added on a clear word. */
export function parseLookPlan(out: string): LookNeed {
  const line = (out.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/^[`"'*\s]+|[`"'*\s]+$/g, '');
  if (/^memory\b/i.test(line)) return { kind: 'memory' };
  const m = /^(web|both)\s*[:\-]\s*(.+)$/i.exec(line);
  if (!m) return { kind: 'none' };
  const query = m[2]!.replace(/[<>"]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 14).join(' ').slice(0, 160);
  if (query.length < 3) return { kind: 'none' };
  return { kind: m[1]!.toLowerCase() === 'both' ? 'both' : 'web', query };
}

export interface LookGate {
  mode: LookFirstMode;
  /** An ordinary turn of the owner's own chat (not another app, a group, a replay, a goal round, a call). */
  ordinary: boolean;
  /** A crisis message: nothing is added. */
  crisis: boolean;
  /** A story, game or other activity is going on in this conversation. */
  playing: boolean;
  /** web_search is set up, switched on and needs no approval. */
  canSearch: boolean;
}

export interface LookResult {
  need: LookNeed['kind'];
  /** Lines from her past conversations (or that nothing was found), for "What you remember". */
  recalled?: string;
  /** Its own instruction message for this turn: what the web said, fenced as data, or the rule to offer. */
  note?: string;
  /** The words searched for, when a search ran (shown to the owner). */
  query?: string;
  /** Addresses the search gave (she may read them). */
  urls: string[];
  results: number;
}

const WEB_RULE = `Answer from these results and from what you remember, and name where each fact came from (the site, with its link). If they do not answer the question, say so plainly; read a result with web_fetch if you have it, or offer a proper research run. Do not fill the gaps from what you think you know, and never invent a name, number, date, quote or link.`;
const OFFER_RULE = `[Note from the app: this looks like a question about the real world, and nothing was looked up. Unless this conversation or your notes answer it, do not answer as if you were sure: say what you are not sure about and offer to look it up (do it yourself with web_search if you have it). Never present a guess as a fact.]`;
const NO_SEARCH_RULE = `[Note from the app: this looks like a question about the real world, and you cannot search the web here (web search is not set up, or not allowed in this conversation). Unless this conversation or your notes answer it, say plainly what you are not sure about. Never present a guess as a fact, and never invent a name, number, date, quote or link.]`;

export function webNote(query: string, results: SearchResult[]): string {
  if (!results.length) return `[Note from the app: before you answer, the web was searched for "${query}" and nothing came back. Say plainly that you could not find it; do not answer from a guess.]`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title} | ${r.url} | ${r.snippet.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  return `[Note from the app: before you answer, the web was searched for "${query}".]\n${fenceLines(lines, 'What the search found')}\n${WEB_RULE}`;
}

/**
 * The look before a reply. Never throws; any failure leaves the turn as it would have been.
 * `search` and `plan` are the real ones unless a test passes its own.
 */
export async function lookFirst(
  app: AppContext,
  conv: Conversation,
  text: string,
  gate: LookGate,
  o: { exclude: { conversationId: string; fromId: number }; owner: string; alreadyRecalled?: boolean; earlier?: string[]; signal?: AbortSignal; plan?: (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string>; search?: (query: string, signal: AbortSignal) => Promise<SearchResult[]> },
): Promise<LookResult | undefined> {
  if (gate.mode === 'off' || !gate.ordinary || gate.crisis || gate.playing || !mayNeedLook(text)) return undefined;
  let need: LookNeed = { kind: 'none' };
  try {
    const earlier = (o.earlier ?? []).slice(-LOOK_FIRST.lines).map((l) => l.replace(/\s+/g, ' ').slice(0, LOOK_FIRST.lineChars));
    // The date, so the search words say this year and not the one the model was trained in.
    const user = `Today is ${app.now().toISOString().slice(0, 10)}.

${earlier.length ? `${fenceLines(earlier, 'Earlier lines')}\n\n` : ''}${fenceLines([text.slice(0, LOOK_FIRST.maxChars)], 'Newest message')}`;
    const messages = [
      { role: 'system' as const, content: LOOK_PLAN_PROMPT },
      { role: 'user' as const, content: user },
    ];
    let out: string;
    if (o.plan) out = await o.plan(messages);
    else {
      const r = await cheapCall(app, { source: 'look-first', purpose: 'look-first', conv, model: 'quick', messages, maxTokens: LOOK_FIRST.planTokens, temperature: 0, cap: { runs: LOOK_FIRST.dailyRuns }, timeoutMs: LOOK_FIRST.planMs });
      out = r.ok ? r.text : '';
    }
    need = parseLookPlan(out);
  } catch {
    return undefined;
  }
  if (need.kind === 'none') return undefined;
  const res: LookResult = { need: need.kind, urls: [], results: 0 };
  // Memory first: her past conversations, by the topic words of his message.
  if ((need.kind === 'memory' || need.kind === 'both') && !o.alreadyRecalled) {
    try {
      const topic = topicOf(text);
      if (ftsQuery(topic)) {
        const hits = recallMessages(app.store, { query: topic, exclude: o.exclude, limit: 4, timeZone: app.settings.get().timeZone, space: turnSpaceSql(app, conv.id), now: app.now() });
        res.recalled = hits.length
          ? `From your past conversations (this is what really was said; rely on it over vague impressions):\n${formatHits(hits, o.owner)}`
          : `You looked through your past conversations for this and found nothing about it. If your notes above do not cover it either, say you do not have it; do not add a detail of your own.`;
      }
    } catch {
      /* her notes are still there */
    }
  }
  if (need.kind === 'web' || need.kind === 'both') {
    const webOk = gate.canSearch && !conv.private && !privateLocalOn();
    if (gate.mode === 'offer') res.note = OFFER_RULE;
    else if (!webOk) res.note = NO_SEARCH_RULE;
    else {
      try {
        const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(LOOK_FIRST.searchMs)]);
        const cfg = o.search ? undefined : searchConfig(app.settings, app.vault!);
        const found = o.search ? await o.search(need.query, signal) : cfg ? await runSearch(cfg, need.query, LOOK_FIRST.results, signal) : [];
        res.query = need.query;
        res.results = found.length;
        res.urls = found.map((r) => r.url);
        res.note = webNote(need.query, found.slice(0, LOOK_FIRST.results));
      } catch {
        // The search failed: she is told she could not check, never left to guess silently.
        res.note = NO_SEARCH_RULE;
      }
    }
  }
  return res.recalled || res.note ? res : undefined;
}
