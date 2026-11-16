// T3 (docs/SELF_CODE.md): the chat tool for level 3 self-repair, and the coding model she uses for it.
//   self_code_fix {problem}  prepares a change to her own code in a separate copy (the owner's coding
//                            model, under the per-repair spending cap). Always asks; nothing changes until
//                            the owner presses Approve on the card in Settings → Privacy & system → Updates.
// Owner only: members, kid mode and the demo have no SelfCode (selfCodeOf is undefined), so it is hidden.
import type { AppContext } from '../chat.ts';
import type { Conversation } from '../store.ts';
import { resolveChain } from '../chat.ts';
import { privateLocalOn } from '../net-guard.ts';
import { SelfCodeError, type ModelFn, type SelfCode } from '../self-code.ts';
import { usageScope } from '../usage.ts';
import type { Tool } from './types.ts';

/** The owner's coding route (falls back like every route), metered under the purpose 'self-code'. */
export function codingModel(app: AppContext): ModelFn {
  return async (messages, signal) => {
    const conv = { id: '', title: 'Code change', providerId: null, model: null, workspace: '', mode: 'coding', private: false, channel: null, channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [] } as unknown as Conversation;
    const chain = resolveChain(app, conv, 'coding');
    const local = (c: (typeof chain)[number]) => c.provider.config.local === true;
    // Private local mode: local models only (the chain may still hold a cloud fallback).
    const pick = privateLocalOn() ? chain.find(local) : chain[0];
    if (!pick) throw new SelfCodeError(409, 'Private local mode is on and no local coding model is set up.');
    const scope: { purpose: string; usd?: number; tokens?: number } = { purpose: 'self-code' };
    let text = '';
    await usageScope.run(scope, async () => {
      for await (const ev of pick.provider.stream({ model: pick.model, messages, temperature: 0.2, maxTokens: 12_000, signal })) {
        if (ev.type === 'text') text += ev.text;
      }
    });
    return { text, usd: scope.usd ?? 0, local: local(pick) };
  };
}

export function createSelfCodeTools(scOf: () => SelfCode | undefined): Tool[] {
  const fix: Tool = {
    spec: {
      name: 'self_code_fix',
      description:
        "Change Sara's own source code to fix something that is broken in her or to add something the owner asked for. She prepares the change in a separate copy with the coding model (under a spending cap), runs the typecheck and tests, and shows the owner one card (summary, diff, test result) under Settings → Privacy & system → Updates → Code changes. Nothing changes until the owner presses Approve there. Use it only when settings or a repair can't fix it. She can never change the safety layer, hard limits, kid mode, approvals, the audit trail, the vault or her own permissions.",
      parameters: { type: 'object', properties: { problem: { type: 'string', description: 'What is wrong, or what to change, in plain words (with any error text).' } }, required: ['problem'] },
    },
    defaultPermission: 'ask',
    isAvailable: () => Boolean(scOf()),
    summarize: (args) => `Prepare a change to her own code: ${String(args.problem ?? '').slice(0, 120)}`,
    async prepare(args) {
      const sc = scOf();
      if (!sc) return { refuse: 'Only the owner of this server can use this.' };
      const st = sc.status();
      if (!st.available) return { refuse: `${st.why ?? 'She cannot change her own code on this install.'} To send it to the developers: Settings → Privacy & system → Reports (or /bug).` };
      return { summary: `Prepare a change to her own code in a separate copy for: "${String(args.problem ?? '').slice(0, 300)}". The coding model may spend up to $${st.cap.toFixed(2)} and ${st.minutes} minutes; then the checks run. Nothing changes until you press Approve on its card (Settings → Privacy & system → Updates → Code changes).` };
    },
    async run(args) {
      const sc = scOf();
      if (!sc) return 'Only the owner of this server can use this.';
      try {
        const c = sc.start(String(args.problem ?? ''));
        return `Started preparing code change #${c.id} in a separate copy. When it's ready (usually a few minutes), its card appears under Settings → Privacy & system → Updates → Code changes with a plain summary, the diff and the test result; nothing changes until the owner presses Approve.`;
      } catch (err) {
        return String((err as Error).message);
      }
    },
  };
  return [fix];
}
