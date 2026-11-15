// R5 (docs/PHONE_CALLS.md): "call X" from chat. Every call asks first, always (asksFirst), on a card
// with the number, what she will say, the longest it may last, a cost estimate from the owner's own
// price and whether it's recorded. While phone calls are off or not set up, it doesn't ask: it says
// what's missing and gives the person the number and a script instead.
import type { AppContext } from '../chat.ts';
import { privateLocalOn } from '../net-guard.ts';
import { PhoneCallError, phoneCallsFor } from '../phone-calls.ts';
import { ToolError, type Tool } from './types.ts';

export function createPhoneCallTools(getApp: () => AppContext): Tool[] {
  const calls = () => phoneCallsFor(getApp());
  const who = (a: Record<string, unknown>) => String(a.name ?? '').trim();
  const to = (a: Record<string, unknown>) => {
    const n = String(a.number ?? '').trim();
    // "Call me": the owner's own number from the Phone calls settings.
    return !n || /^(me|owner)$/i.test(n) ? calls().settings().ownerNumber || n : n;
  };
  return [
    {
      defaultPermission: 'auto',
      // Ready: every call asks, on its own card (never an "always allow"). Not ready: it only explains.
      asksFirst: () => calls().ready(),
      isAvailable: () => !privateLocalOn() && !getApp().member && !getApp().demo,
      spec: {
        name: 'phone_call',
        description:
          'Place a real phone call in her own voice (only when phone calls are set up and switched on in Settings; otherwise this tells you what is missing and you give the person the number and what to say). Give the number (or "me" for the owner), who it is, and the script: what she says when they answer and what she wants from the call. The person approves each call on a card. The transcript and a summary come back to this chat when the call ends; for an errand\'s call step, use the errand instead.',
        parameters: {
          type: 'object',
          properties: {
            number: { type: 'string', description: 'The phone number to call, or "me".' },
            name: { type: 'string', description: 'Who it is (a business or a person).' },
            script: { type: 'string', description: 'What she says when they answer, and what she needs from the call.' },
          },
          required: ['number', 'script'],
        },
      },
      summarize: (a) => {
        try {
          return calls().card({ to: to(a), name: who(a), script: String(a.script ?? '') });
        } catch (err) {
          return `phone call: ${(err as Error).message}`;
        }
      },
      async run(args, ctx) {
        const c = calls();
        const number = to(args);
        const script = String(args.script ?? '').trim();
        if (!script) throw new ToolError('Say what she should say on the call (script).');
        if (!c.ready()) return `Phone calls aren't ready, so nothing was called. ${c.missingText()} Give the person the number (${number || 'none yet'}) and this script to call themselves: "${script.slice(0, 600)}"`;
        try {
          const call = await c.place({ to: number, name: who(args), script, conversationId: ctx.conversationId ?? null });
          return `Calling ${call.number} now (call ${call.id}). The transcript and a summary will be posted in this chat when it ends. Don't say what was agreed until then.`;
        } catch (err) {
          if (err instanceof PhoneCallError) throw new ToolError(err.message);
          throw err;
        }
      },
    },
  ];
}
