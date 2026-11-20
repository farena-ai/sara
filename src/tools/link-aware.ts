// LINKAWARE (docs/MESSAGES.md, Isolation): "did Hank reach out?", "who am I linked with?". Read-only:
// names, how long linked, unread counts, when their last message came and what waits by kind. She
// still can't read or send a message; the answer points the owner at Messages.
import type { AppContext } from '../chat.ts';
import { linkAwareOn, linkedFriendsReport } from '../link-aware.ts';
import type { Tool } from './types.ts';

export function createLinkAwareTools(appOf: () => AppContext): Tool[] {
  const tool: Tool = {
    spec: {
      name: 'linked_friends',
      description: "Lists the owner's linked Saras (Messages): each friend's name, how long they have been linked, how many unread messages are from them, when their last message arrived, and what of theirs waits for the owner by kind (help-pass suggestion, fix request, find-a-time request, shared-project invite). Use it for \"did Hank reach out?\", \"who am I linked with?\", \"any messages from Sam?\". Metadata only: you can never read or send the messages themselves; tell the owner to open Messages to read them.",
      parameters: { type: 'object', properties: { friend: { type: 'string', description: 'Optional: one friend’s name or first name.' } } },
    },
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: () => {
      try {
        const app = appOf();
        return linkAwareOn(app) && app.messages!.awareness().length > 0;
      } catch {
        return false;
      }
    },
    summarize: (a) => (a.friend ? `Linked Saras: ${String(a.friend)}` : 'Linked Saras'),
    async run(args) {
      return linkedFriendsReport(appOf(), args.friend);
    },
  };
  return [tool];
}
