// N6 (docs/WHAT_SARA_KNOWS.md): facts_list ("what do you know about me?", with where each fact came
// from) and fact_forget ("forget that I…": the fact and the memory go, asked first). Only in the
// person's own chats (never shared rooms, other companions or other people). Private facts (health,
// learned in a private chat, a passport) are listed only in a private chat or when asked for.
import type { AppContext } from '../chat.ts';
import { factsFor } from '../facts.ts';
import { ToolError, type Tool, type ToolContext } from './types.ts';

function ownChat(app: AppContext, ctx: ToolContext) {
  const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
  if (conv?.partner || /-work(-nsfw)?$/.test(conv?.channel ?? '') || (conv?.channel ?? '').startsWith('group')) throw new ToolError('What you know about them is only used in their own chats, never in shared rooms or chats with others.');
  return conv;
}

export function createFactsTools(getApp: () => AppContext): Tool[] {
  return [
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: {
        name: 'facts_list',
        description:
          "What you know about the person's world (Settings → You → What Sara knows): people and family, home, vehicles, health, work, money (policies and accounts, last 4 digits only) and dates (birthdays, renewals, expiry and due dates), each with where it came from: something they said (with the chat) or a document in their Library (with the page and a cite link). Use it for \"what do you know about me?\" and before answering about their policies, lease, car or dates; name the source when you use a fact. query narrows it (e.g. 'insurance'). Private facts (health, a passport, anything from a private chat) are left out unless include_private is true; set that only when they ask about those themselves.",
        parameters: { type: 'object', properties: { query: { type: 'string' }, include_private: { type: 'boolean' } }, additionalProperties: false },
      },
      summarize: (a) => (a.query ? `look at what she knows about “${String(a.query).slice(0, 40)}”` : 'look at what she knows about you'),
      async run(args, ctx) {
        const app = getApp();
        const conv = ownChat(app, ctx);
        const includePrivate = Boolean(conv?.private) || args.include_private === true;
        const lines = factsFor(app).lines({ includePrivate, query: typeof args.query === 'string' ? args.query : undefined });
        const pending = factsFor(app).suggestions().length;
        if (!lines.length) return `Nothing kept${args.query ? ` about “${args.query}”` : ''} yet. They can add documents to the Library (policies, a lease, warranties) or tell you; the page is Settings → You → What Sara knows.`;
        return `What you know (Settings → You → What Sara knows; they can edit, delete or mark "not true" there):\n${lines.join('\n')}${pending ? `\n${pending} date${pending === 1 ? '' : 's'} from their documents can become reminders (Today or that page: Accept).` : ''}`;
      },
    },
    {
      defaultPermission: 'ask',
      spec: {
        name: 'fact_forget',
        description: "Forget a fact when the person says \"forget that…\" or \"that's not true\": every fact whose words match `what` is removed, and the memory it came from too. Asks them first. Say what was forgotten.",
        parameters: { type: 'object', properties: { what: { type: 'string', description: "The words of the fact, e.g. 'Honda Civic' or 'penicillin'." } }, required: ['what'], additionalProperties: false },
      },
      summarize: (a) => `forget what she knows about “${String(a.what ?? '').slice(0, 60)}”`,
      async run(args, ctx) {
        const app = getApp();
        ownChat(app, ctx);
        const what = String(args.what ?? '').trim();
        if (!what) throw new ToolError('Say what to forget.');
        const gone = factsFor(app).forget(what);
        if (!gone.length) return `No fact matches “${what}”. Look with facts_list and use its words.`;
        return `Forgot ${gone.length}: ${gone.map((f) => f.text).join('; ')}`;
      },
    },
  ];
}
