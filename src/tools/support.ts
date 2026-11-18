// S9b (docs/SUPPORT_LINK.md): the helper's tools. Owner only (members, kid mode and the demo have no
// Messenger, so supportOf() is undefined and both stay hidden), off in private chats and private local mode.
//   support_look     reads a linked server's redacted support report over a valid help pass and lists what
//                    looks wrong. Asks the owner once per pass; later looks on the same pass don't ask.
//   support_propose  sends a proposed change (allowlisted settings, or a plain instruction). Always asks;
//                    the other owner still has to approve it on their side before anything changes.
import { untrustedPeer, type AppContext } from '../chat.ts';
import { fill } from '../i18n.ts';
import { SUPPORT_ALLOW, supportFindings, supportOf, SupportError, type SupportLink } from '../support.ts';
import type { Tool } from './types.ts';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** The linked server with a valid pass, by name (or the only one). */
function pick(sp: SupportLink, name: unknown): { id: string; name: string; pass: string; asked: boolean } {
  const held = sp.peers().map((p) => ({ ...p, pass: sp.activePass(p.id, 'held') })).filter((p) => p.pass);
  const want = norm(name);
  const hit = want ? held.filter((p) => norm(p.name) === want || norm(p.name).startsWith(want)) : held;
  if (!hit.length) throw new SupportError(403, held.length ? `No help pass from "${String(name)}". Passes held: ${held.map((p) => p.name).join(', ')}.` : 'Nobody has given you a help pass right now. They give one under Messages → their chat with you → Ask for help.');
  if (hit.length > 1) throw new SupportError(400, `Which one: ${hit.map((p) => p.name).join(', ')}?`);
  const h = hit[0]!;
  return { id: h.id, name: h.name, pass: h.pass!.id, asked: h.pass!.asked };
}

export function createSupportTools(appOf: () => AppContext): Tool[] {
  const sp = () => supportOf(appOf());
  const anyPass = () => {
    try {
      const s = sp();
      return Boolean(s && s.peers().some((p) => s.activePass(p.id, 'held')));
    } catch {
      return false;
    }
  };
  const look: Tool = {
    spec: {
      name: 'support_look',
      description: "Look at a linked owner's Sara when they gave you a help pass: health, self-test, versions and updates, recent errors, redacted log lines, settings (keys hidden), model status and app versions. Never their chats, memories, files, mail or messages. Use it when the owner asks what's wrong with that person's Sara.",
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The other owner’s name (optional when only one pass is held).' } } },
    },
    defaultPermission: 'ask',
    interruptible: true,
    isAvailable: anyPass,
    summarize: (args) => `Look at ${String(args.name ?? 'the linked')}'s Sara (help pass)`,
    async prepare(args) {
      const s = sp();
      if (!s) return { refuse: 'Only the owner of this server can use this.' };
      try {
        const p = pick(s, args.name);
        return { summary: `Look at ${p.name}'s Sara with their help pass (health, errors, logs with private things removed, settings without keys).`, ...(p.asked ? { auto: true } : {}) };
      } catch (err) {
        return { refuse: (err as Error).message };
      }
    },
    async run(args) {
      const s = sp();
      if (!s) return 'Only the owner of this server can use this.';
      const p = pick(s, args.name);
      s.markAsked(p.pass);
      const r = await s.call(p.id, 'look', {});
      s.log(p.id, p.name, 'helper', 'look');
      const rep = (r.report ?? {}) as Record<string, any>;
      const f = supportFindings(rep);
      const lines = [
        `${p.name}'s Sara (version ${rep.version?.server ?? '?'}; looked at ${rep.at ?? ''}).`,
        f.length ? `Findings:\n${f.map((x) => `- [${x.level}] ${x.area ? `${x.area}: ` : ''}${fill(x.text, x.params)}`).join('\n')}` : 'Findings: nothing looks wrong.',
        `Default model: ${rep.models?.default?.provider ?? '?'} / ${rep.models?.default?.model ?? '?'}; fallbacks: ${(rep.models?.fallbacks ?? []).map((x: any) => `${x.providerId}/${x.model}`).join(', ') || 'none'}; wait before fallback: ${rep.models?.fallbackAfterSec ?? '?'} s.`,
        `Recent turn errors: ${(rep.errors?.turns ?? []).slice(0, 5).map((x: any) => `${x.kind}: ${x.message}`).join(' | ') || 'none'}.`,
        `Last log lines (redacted):\n${(rep.log ?? []).slice(-15).join('\n') || '(none)'}`,
      ];
      // U5.33: the report comes from the other server: fenced as untrusted data, never instructions.
      return `${untrustedPeer(p.name, lines.join('\n\n'), 'friend:')}\n\nYou can only suggest changes (support_propose): ${Object.keys(SUPPORT_ALLOW).join(', ')}, or a plain instruction. ${p.name} approves or denies each one.`;
    },
  };
  const propose: Tool = {
    spec: {
      name: 'support_propose',
      description: "Suggest a fix to a linked owner who gave you a help pass. Either settings changes from this list only: defaultProviderId, defaultModel, defaultFallbacks ([{providerId, model}]), fallbackAfterSec (10-600), autoJobs, historyBudgetMode, memoryTidy.on, persona.innerLife; or a plain instruction in `note`. Nothing changes until that owner approves it on their side.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The other owner’s name.' },
          changes: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, value: {} }, required: ['path', 'value'] } },
          note: { type: 'string', description: 'Why, or a plain instruction for them.' },
        },
      },
    },
    defaultPermission: 'ask',
    isAvailable: anyPass,
    summarize: (args) => `Suggest a fix to ${String(args.name ?? 'the linked')}'s Sara`,
    async prepare(args) {
      const s = sp();
      if (!s) return { refuse: 'Only the owner of this server can use this.' };
      try {
        const p = pick(s, args.name);
        const ch = Array.isArray(args.changes) ? (args.changes as { path?: unknown; value?: unknown }[]) : [];
        const bad = ch.find((c) => !Object.hasOwn(SUPPORT_ALLOW, String(c?.path ?? '')));
        if (bad) return { refuse: `Only these settings can be suggested: ${Object.keys(SUPPORT_ALLOW).join(', ')}.` };
        return { summary: `Suggest to ${p.name}: ${ch.map((c) => `${String(c.path)} → ${JSON.stringify(c.value)}`).join('; ') || String(args.note ?? '').slice(0, 200)} (they approve or deny it).`, ask: true };
      } catch (err) {
        return { refuse: (err as Error).message };
      }
    },
    async run(args) {
      const s = sp();
      if (!s) return 'Only the owner of this server can use this.';
      const p = pick(s, args.name);
      const ch = (Array.isArray(args.changes) ? args.changes : []).slice(0, 8).map((c: any) => ({ path: String(c?.path ?? ''), value: c?.value }));
      if (ch.some((c) => !Object.hasOwn(SUPPORT_ALLOW, c.path))) return 'That setting can’t be changed through a help pass.';
      const out = await s.propose(p.id, ch, args.note);
      return `Sent to ${p.name}. It waits for their OK (proposal ${out.id.slice(0, 8)}); nothing changes until they approve it.`;
    },
  };
  return [look, propose];
}
