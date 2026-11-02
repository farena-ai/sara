// Phase 116 (BR2 B6, docs/design/BRIDGES2.md §5.6): `/btw`, the side question. One small model
// call beside the work: a read-only slice of the conversation (with the running turn's stored
// steps), no tools, the turn-start safety checks, and NOTHING written to the conversation: no
// message, no memory, no mood, no title, no run record. One usage row (purpose `btw`) and the
// shared daily ledger (source `btw`). It never touches the running turn, its controller, the
// pending queue or the progress message.
import { cheapCall } from './cheap.ts';
import { preflight, type AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { personalize } from './identity.ts';
import { buildSystemPrompt, identityOf } from './persona.ts';
import { whileBusySettings } from './pending.ts';
import { CRISIS_RESOURCES, CRISIS_SYSTEM_NOTE, detectExplicit, MINOR_BLOCK_REPLY, minorSexualMatch } from './safety.ts';
import { adultModeOn } from './settings.ts';
import { redactTypedPassword } from './ssh.ts';
import type { Conversation } from './store.ts';

export const BTW_RULE = "This is a quick side question while you work on something else. Answer briefly from what you can see here. You can't use tools or change anything, and your work carries on separately.";
export const BTW_MAX_TOKENS = 600;
export const BTW_TIMEOUT_MS = 60_000;
const HISTORY_MESSAGES = 20;
const HISTORY_CHARS = 16_000;

export type AsideResult =
  | { ok: true; text: string; model: string; local: boolean; crisis?: boolean; blocked?: boolean }
  | { ok: false; status: 400 | 429 | 503; text: string; key: string };

/** The side question's lines, in English (translated where they are shown). */
export const BTW_LINES = {
  cap: en("That's the side-question limit for today."),
  none: en('No model can answer side questions here right now.'),
  busy: en("I'm busy with the big job on this model; ask again in a moment, or set a quick model for side questions."),
  empty: en('Ask your side question after /btw.'),
  explicit: en("I'll keep that one for another time."),
} as const;

/** The conversation as plain lines (no pictures, no tool-call shapes: any model can take it). */
function slice(app: AppContext, conv: Conversation): { transcript: string; doing: string[] } {
  const owner = app.settings.get().ownerName?.trim() || 'Owner';
  const msgs = app.store.messages(conv.id).filter((m) => m.role !== 'notice').slice(-HISTORY_MESSAGES);
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === 'user') lines.push(`${conv.partner ?? owner}${m.meta?.steer ? ' (while you worked)' : ''}: ${m.content}`);
    else if (m.role === 'assistant' && m.content.trim()) lines.push(`You: ${m.content}`);
    else if (m.role === 'tool') lines.push(`[${String(m.meta?.name ?? 'tool')} result, ${String(m.meta?.status ?? 'ok')}]: ${app.redactor.redact(m.content).slice(0, 2000)}`);
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > HISTORY_CHARS) transcript = `…${transcript.slice(-HISTORY_CHARS)}`;
  // What she is doing right now: the step summaries since his last message (already scrubbed).
  const lastUser = app.store.messages(conv.id).findLast((m) => m.role === 'user' && !m.meta?.steer);
  const doing = app.store
    .messages(conv.id)
    .filter((m) => m.role === 'tool' && (!lastUser || m.id > lastUser.id))
    .slice(-6)
    .map((m) => `- ${String(m.meta?.summary ?? m.meta?.name ?? 'a step')} (${String(m.meta?.status ?? 'ok')})`);
  return { transcript, doing };
}

/** Answers a side question about `conv`. Never throws; never stores anything in the conversation. */
export async function answerAside(app: AppContext, conv: Conversation, question: string, opts: { owner?: boolean } = {}): Promise<AsideResult> {
  const q = redactTypedPassword(question.trim()).text.slice(0, 4000);
  if (!q) return { ok: false, status: 400, text: BTW_LINES.empty, key: BTW_LINES.empty };
  const s = app.settings.get();
  const pf = preflight(q, conv.partner ? { others: true } : { owner: opts.owner !== false });
  if (pf.minor) {
    app.store.recordSafetyEvent('minor_sexual_block', conv.id);
    return { ok: true, text: MINOR_BLOCK_REPLY, model: '', local: true, blocked: true };
  }
  // Adult content only where a turn would allow it (his own chats with Adult mode on; adult channels).
  const adultOn = adultModeOn(s) && !conv.channel.includes('-work') && (conv.channel.endsWith('-nsfw') || (!conv.partner && ['web', 'telegram', 'discord'].includes(conv.channel)));
  const safetyNotes = [BTW_RULE, ...(pf.crisis ? [CRISIS_SYSTEM_NOTE] : [])];
  const system = buildSystemPrompt(app.persona, { now: app.now(), timeZone: s.timeZone, ownerName: conv.partner ?? s.ownerName, safetyNotes, tools: [], partner: Boolean(conv.partner) });
  const { transcript, doing } = slice(app, conv);
  const user = [transcript ? `The conversation so far (most recent last):\n\n${transcript}` : '', doing.length ? `What you're doing right now:\n${doing.join('\n')}` : '', `The side question: ${q}`].filter(Boolean).join('\n\n');
  const cfg = whileBusySettings(app).btw;
  const r = await cheapCall(app, { source: 'btw', purpose: 'btw', conv, model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: BTW_MAX_TOKENS, temperature: 0.4, cap: { runs: cfg.dailyCap }, timeoutMs: BTW_TIMEOUT_MS });
  if (pf.crisis) app.store.recordSafetyEvent('crisis_referral', conv.id);
  if (!r.ok) {
    if (pf.crisis) return { ok: true, text: CRISIS_RESOURCES, model: '', local: true, crisis: true };
    if (r.skipped === 'cap') return { ok: false, status: 429, text: BTW_LINES.cap, key: BTW_LINES.cap };
    if (r.skipped === 'no-model') return { ok: false, status: 503, text: BTW_LINES.none, key: BTW_LINES.none };
    return { ok: false, status: 503, text: personalize(BTW_LINES.busy, identityOf(app.persona)), key: BTW_LINES.busy };
  }
  let text = app.redactor.redact(r.text).trim();
  if (minorSexualMatch(text, { fromHer: true })) {
    app.store.recordSafetyEvent('minor_sexual_block', conv.id);
    text = MINOR_BLOCK_REPLY;
  } else if (!adultOn && detectExplicit(text)) text = BTW_LINES.explicit;
  if (pf.crisis) text = `${text}\n\n${CRISIS_RESOURCES}`.trim();
  return { ok: true, text: text || '…', model: r.model, local: r.local, ...(pf.crisis ? { crisis: true } : {}) };
}
