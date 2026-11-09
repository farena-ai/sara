import type { AppContext } from './chat.ts';
import { ownerEvidenceConversation, type OwnerEvidenceTurn } from './owner-evidence.ts';
import { ownerCuesNote, recentOwnerCues } from './attunement.ts';

/** Fresh read-only evidence for the actual provider handoff; never a persisted mood profile. */
export function ownerCueNote(app: AppContext, conversationId: string, turn: OwnerEvidenceTurn): string | undefined {
  if (app.settings.get().persona?.innerLife === false) return undefined;
  const conversation = ownerEvidenceConversation(app, conversationId, turn);
  if (!conversation) return undefined;
  const now = app.now();
  if (!Number.isFinite(now.getTime())) return undefined;
  const messages = app.store.followUpEvidenceSince(new Date(now.getTime() - 30 * 60_000).toISOString(), {
    workspace: conversation.workspace,
    conversationId: conversation.id,
    until: now.toISOString(),
  }).slice(-6);
  return ownerCuesNote(recentOwnerCues(messages, now, app.persona.name));
}
