// R5 (docs/PHONE_CALLS.md "Car mode errands"): hands-free errands. In car mode she can start an
// errand by voice (errand_start's card is answered by saying "approve"), and she knows where each open
// errand stands in one spoken line ("your refund is waiting on the merchant"). Spoken approvals use the
// same rule as phone notifications (phoneMayApprove): computer use and cards with a choice to make
// stay on the computer.
import type { AppContext } from './chat.ts';
import type { Errand } from './errands.ts';
import { en } from './i18n.ts';
import { phoneMayApprove } from './phone-actions.ts';

/** One open errand in a short spoken line (English for her note; she says it in the person's language). */
export function errandLine(e: Errand): string {
  const goal = e.goal.length > 80 ? `${e.goal.slice(0, 79)}…` : e.goal;
  const step = e.steps.find((s) => s.status === 'waiting_you') ?? e.steps.find((s) => s.status === 'waiting_others') ?? e.steps.find((s) => s.status === 'todo');
  if (e.status === 'waiting_others') {
    const who = e.contacts.find((c) => !c.replied)?.name || e.facts.merchant || (step?.kind === 'call' ? 'the call' : 'their answer');
    return `"${goal}" is waiting on ${who}.`;
  }
  if (e.status === 'waiting_you') {
    const ask = (step?.ask ?? '').split(/(?<=[.!?:])\s/)[0]?.slice(0, 140) || 'your OK';
    return `"${goal}" needs you: ${ask}`;
  }
  if (e.status === 'planning') return `"${goal}" is planned and waits for Start on the Errands page.`;
  return `"${goal}" is in progress${step ? `: next, ${step.text.toLowerCase()}` : ''}.`;
}

/** Up to three open errands, newest first, for car mode's note. */
export function carErrandLines(app: AppContext): string[] {
  try {
    return (app.errands?.list({ open: true }) ?? []).slice(0, 3).map(errandLine);
  } catch {
    return [];
  }
}

/** Her instruction while the owner talks with her on a phone call. */
export function phoneCallNote(owner: string): string {
  return `${owner} is talking with you on a phone call: everything you say is spoken on the line. Answer in at most two short spoken sentences, with no lists, tables, markdown, links, emoji or code. Don't offer computer use or long tasks. If something needs ${owner}'s OK, the card is read out and ${owner} answers by saying approve or no.`;
}

export const CAR_LINES = {
  nothing: en('Nothing is waiting for your OK.'),
  pcOnly: en('That one needs you at the computer: approve it there.'),
  approved: en('Approved.'),
  declined: en('Declined.'),
} as const;

/**
 * "approve" / "no" said in car mode: answers the newest card waiting in this conversation, when a
 * phone may answer it. PC-only cards stay; English lines (the route translates).
 */
export function voiceAnswer(app: AppContext, active: Map<string, { approvals: Map<string, unknown> }>, conversationId: string, approved: boolean): { ok: boolean; line: string; pcOnly?: boolean } {
  const turn = active.get(conversationId);
  const cards = turn ? ([...turn.approvals.values()] as Parameters<typeof phoneMayApprove>[0][] & { approvalId?: string }[]) : [];
  const card = cards[cards.length - 1] as (Parameters<typeof phoneMayApprove>[0] & { approvalId?: string }) | undefined;
  if (!card?.approvalId) return { ok: false, line: CAR_LINES.nothing };
  if (!phoneMayApprove(card)) return { ok: false, line: CAR_LINES.pcOnly, pcOnly: true };
  if (!app.approvals.decide(card.approvalId, approved)) return { ok: false, line: CAR_LINES.nothing };
  return { ok: true, line: approved ? CAR_LINES.approved : CAR_LINES.declined };
}
