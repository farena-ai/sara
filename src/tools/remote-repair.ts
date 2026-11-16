// ROADMAP_T T5 (docs/REMOTE_REPAIR.md): remote repair tools. Owner only (members, kid mode and the demo have no
// Messenger, so remoteRepairOf() is undefined and all three stay hidden), off in private chats and private local
// mode (lean OFF list).
//   remote_help_request  helped side: "I can't get X working, can you have Sam fix it" → a card in the chat with
//                        Sam (how long, what Sam may do). Nothing is sent until the owner presses Give a fix pass.
//   remote_look          helper side: the linked server's support report + its own problem list. Asks once per pass.
//   remote_fix_plan      helper side: a plan of steps the other server's own engines accept. Always asks; the
//                        other owner approves it there (per step, or once for the plan; code changes always).
import type { AppContext } from '../chat.ts';
import { fill } from '../i18n.ts';
import { privateLocalOn } from '../net-guard.ts';
import { remoteRepairOf, stepShape, STEP_KINDS, type RemoteRepair } from '../remote-repair.ts';
import { SUPPORT_ALLOW, supportFindings, SupportError } from '../support.ts';
import type { Tool } from './types.ts';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

function byName<T extends { name: string }>(list: T[], name: unknown, none: string): T {
  const want = norm(name);
  const hit = want ? list.filter((p) => norm(p.name) === want || norm(p.name).startsWith(want)) : list;
  if (!hit.length) throw new SupportError(403, none);
  if (hit.length > 1) throw new SupportError(400, `Which one: ${hit.map((p) => p.name).join(', ')}?`);
  return hit[0]!;
}
/** A linked server with an accepted fix pass held by this owner. */
function held(rr: RemoteRepair, name: unknown) {
  const list = rr.support.peers().map((p) => ({ ...p, pass: rr.activePass(p.id, 'held') })).filter((p) => p.pass);
  return byName(list, name, list.length ? `No fix pass from "${String(name)}". Fix passes held: ${list.map((p) => p.name).join(', ')}.` : 'Nobody has given you a fix pass right now. They ask under Messages → their chat with you → Ask to fix something.');
}

export function createRemoteRepairTools(appOf: () => AppContext): Tool[] {
  const rr = () => {
    try {
      return remoteRepairOf(appOf());
    } catch {
      return undefined;
    }
  };
  const anyHeld = () => {
    const r = rr();
    return Boolean(r && r.support.peers().some((p) => r.activePass(p.id, 'held')));
  };
  const ask: Tool = {
    spec: {
      name: 'remote_help_request',
      description: "When the owner can't get something working and asks to have a linked friend's Sara fix it (\"can you have Sam fix it\"): puts a card in the Messages chat with that friend where the owner picks how long (1 hour, 1 day, 7 days) and what the friend may do (look only / fix with my OK each time / fix within this pass). Nothing is sent until the owner presses the button there.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The linked friend (their name in Messages).' }, problem: { type: 'string', description: 'What is not working, in the owner’s words.' } },
        required: ['problem'],
      },
    },
    defaultPermission: 'auto',
    isAvailable: () => {
      const r = rr();
      return Boolean(r && !privateLocalOn() && r.support.peers().length);
    },
    summarize: (args) => `Ask ${String(args.name ?? 'a linked friend')} to fix something (a card in Messages)`,
    async run(args) {
      const r = rr();
      if (!r) return 'Only the owner of this server can use this.';
      const p = byName(r.support.peers(), args.name, 'No linked server by that name. Link one under Messages → Link a server first.');
      r.draft(p.id, args.problem);
      return fill('I put a card in your chat with {name} under Messages: pick how long (1 hour, 1 day or 7 days) and what {name}’s Sara may do, then press Give a fix pass. Nothing is sent until you do, and you can revoke it at any time.', { name: p.name });
    },
  };
  const look: Tool = {
    spec: {
      name: 'remote_look',
      description: "Look at a linked owner's Sara when they gave you a fix pass: their health report (redacted, keys hidden) and their own list of problems with ids (for remote_fix_plan). Never their chats, memories, files, mail or messages.",
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The other owner’s name (optional when only one pass is held).' } } },
    },
    defaultPermission: 'ask',
    interruptible: true,
    isAvailable: anyHeld,
    summarize: (args) => `Look at ${String(args.name ?? 'the linked')}'s Sara (fix pass)`,
    async prepare(args) {
      const r = rr();
      if (!r) return { refuse: 'Only the owner of this server can use this.' };
      try {
        const p = held(r, args.name);
        return { summary: `Look at ${p.name}'s Sara with their fix pass (health, problems, logs with private things removed, settings without keys).`, ...(p.pass!.asked ? { auto: true } : {}) };
      } catch (err) {
        return { refuse: (err as Error).message };
      }
    },
    async run(args) {
      const r = rr();
      if (!r) return 'Only the owner of this server can use this.';
      const p = held(r, args.name);
      r.markAsked(p.pass!.id);
      const res = await r.support.call(p.id, 'look', {}, 'repair');
      r.support.log(p.id, p.name, 'helper', 'repair-look');
      const rep = (res.report ?? {}) as Record<string, any>;
      const probs = (res.problems ?? []) as { id: string; level: number; text: string; params?: Record<string, unknown>; fixable: boolean }[];
      const can = (res.can ?? {}) as { code?: boolean; settings?: string[] };
      const f = supportFindings(rep);
      return [
        `${p.name}'s Sara (version ${rep.version?.server ?? '?'}). Fix pass: ${p.pass!.scope === 'look' ? 'look only' : p.pass!.scope === 'each' ? `${p.name} approves each step` : `${p.name} approves the plan once (code changes always ask)`}.`,
        probs.length ? `Problems (id: what):\n${probs.map((x) => `- ${x.id} (level ${x.level}${x.fixable || x.level === 2 ? '' : ', only the owner can fix'}): ${fill(x.text, x.params)}`).join('\n')}` : 'Problems: none found.',
        f.length ? `Report findings:\n${f.map((x) => `- [${x.level}] ${x.area ? `${x.area}: ` : ''}${fill(x.text, x.params)}`).join('\n')}` : '',
        `Last log lines (redacted):\n${(rep.log ?? []).slice(-10).join('\n') || '(none)'}`,
        `A plan (remote_fix_plan) may only have: {kind:'fix', problem:<id from the list>}, {kind:'learn', what}, {kind:'setting', path, value} with path in ${(can.settings ?? Object.keys(SUPPORT_ALLOW)).join(', ')}${can.code ? ", {kind:'code', request:<what to change, in words>} (their Sara writes and tests it herself)" : ''}. No commands, files, remote control or passwords.`,
      ]
        .filter(Boolean)
        .join('\n\n');
    },
  };
  const plan: Tool = {
    spec: {
      name: 'remote_fix_plan',
      description: "Send a fix plan to a linked owner who gave you a fix pass. Steps (max 10), each one of: {kind:'fix', problem:'<id from remote_look>'}, {kind:'learn', what:'...'}, {kind:'setting', path, value} (defaultProviderId, defaultModel, defaultFallbacks, fallbackAfterSec 10-600, autoJobs, historyBudgetMode, memoryTidy.on, persona.innerLife), {kind:'code', request:'<the change in words>'}. Their server checks and runs each step itself after its owner's OK.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The other owner’s name.' },
          steps: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: [...STEP_KINDS] }, problem: { type: 'string' }, what: { type: 'string' }, path: { type: 'string' }, value: {}, request: { type: 'string' } }, required: ['kind'] } },
          note: { type: 'string', description: 'Why, in plain words, for the other owner.' },
        },
        required: ['steps'],
      },
    },
    defaultPermission: 'ask',
    isAvailable: anyHeld,
    summarize: (args) => `Send a fix plan to ${String(args.name ?? 'the linked')}'s Sara`,
    async prepare(args) {
      const r = rr();
      if (!r) return { refuse: 'Only the owner of this server can use this.' };
      try {
        const p = held(r, args.name);
        if (p.pass!.scope === 'look') return { refuse: `${p.name}'s fix pass is for looking only.` };
        const steps = (Array.isArray(args.steps) ? args.steps : []).map((x, n) => stepShape(x, n));
        if (!steps.length) return { refuse: 'A plan needs at least one step.' };
        return { summary: `Send ${p.name} a fix plan: ${steps.map((s) => (s.kind === 'fix' ? `fix ${s.problem}` : s.kind === 'setting' ? `${s.path} → ${JSON.stringify(s.value)}` : s.kind === 'learn' ? `learn “${s.what}”` : `code change “${s.request!.slice(0, 80)}”`)).join('; ')} (their server checks each step; ${p.name} approves).`, ask: true };
      } catch (err) {
        return { refuse: (err as Error).message };
      }
    },
    async run(args) {
      const r = rr();
      if (!r) return 'Only the owner of this server can use this.';
      const p = held(r, args.name);
      const out = await r.send(p.id, args.steps, args.note);
      return `Sent to ${p.name} (${out.steps.length} step(s)). Their server checked every step; it waits for ${p.name}'s OK. You see each step's progress in Messages → your chat with ${p.name}, with Stop.`;
    },
  };
  return [ask, look, plan];
}
