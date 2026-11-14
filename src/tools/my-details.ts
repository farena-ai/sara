// N4 (docs/MY_DETAILS.md): my_details_get, the person's own saved details (Settings → You → My details),
// for filling forms and answering "what's my policy number?". Each space reads its own person's details;
// never in a chat with another companion or person, never in a shared room. Nothing secret is kept there
// (no passwords, card numbers, SSNs: src/my-details.ts refuses them).
import type { AppContext } from '../chat.ts';
import { detailLines, myDetailsFor } from '../my-details.ts';
import { ToolError, type Tool } from './types.ts';

export function createMyDetailsTool(getApp: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'my_details_get',
      description: "The person's own saved details from Settings → You → My details: name, emails, phones, home/work/shipping addresses, date of birth, clothing and shoe sizes, vehicles (make, model, year, plate, VIN), insurance (company, policy number), loyalty numbers, employer and job title, emergency contact. Use it to answer their questions about these or before filling a form (pc_fill_form uses them by itself). Never passwords, card numbers or SSNs: those are never stored. If a detail is missing, ask them and suggest saving it there.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    summarize: () => 'read your saved details (My details)',
    async run(_args, ctx) {
      const app = getApp();
      const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
      if (conv?.partner || /-work(-nsfw)?$/.test(conv?.channel ?? '')) throw new ToolError('My details are only used in the person\u2019s own chats, never in shared rooms or chats with others.');
      const lines = detailLines((app.myDetails ?? myDetailsFor(app.store.db)).get());
      if (!lines.length) return 'My details are empty. Ask them for what you need, and suggest saving it in Settings → You → My details so forms can be filled next time.';
      return `Their saved details (Settings → You → My details):\n${lines.join('\n')}`;
    },
  };
}
