// ROADMAP_T T1/T2 (docs/SELF_REPAIR.md): "something is broken" / "fix yourself" in chat. Owner's companions only
// (main.ts adds them only when the space is not a household member or kid mode).
//   repair_status  read-only: what is wrong now (checks again), and what she fixed lately.
//   repair_fix     fixes one problem (by id) or 'everything' (level 1), or grows (a level 2 id, or learn: "X").
//                  Per the permission: level 1 runs without a card in 'auto1' or with the 24-hour full permission;
//                  otherwise one card covers the whole repair. Level 2 always asks once.
import type { AppContext } from '../chat.ts';
import { fill } from '../i18n.ts';
import { neverTouch, type Problem, type Repair, type RepairRun } from '../repair.ts';
import type { Tool } from './types.ts';

const line = (p: Problem) => `- [${p.id}] ${p.area ? `${p.area}: ` : ''}${fill(p.text, p.params)}${p.fixable ? (p.fix ? ` → fix: ${fill(p.fix, p.params)}` : '') : ` → ${p.fix ? fill(p.fix, p.params) : 'only explained'}${p.page ? ` (page ${p.page})` : ''}`}${p.level === 2 ? ' (level 2: grow)' : ''}`;
const runLine = (r: RepairRun) => `- ${fill(r.title, r.params)}: ${r.result}${r.undone ? ' (put back)' : ''}. ${r.steps.map((s) => fill(s.text, s.params)).join(' ')}`;

export function createRepairTools(engineOf: () => Repair | undefined): Tool[] {
  const status: Tool = {
    spec: {
      name: 'repair_status',
      description: "Check yourself: what is broken or not working right on this server now (model services, sign-ins, add-ons, stuck jobs and errands, the database, disk, settings, apps, health, repeated failures), and what you fixed lately. Use it when the person says something is broken, not working, or asks you to check or fix yourself. Read-only.",
      parameters: { type: 'object', properties: { deep: { type: 'boolean', description: 'Also run the full check (asks every model service; slower).' } } },
    },
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: () => Boolean(engineOf()),
    summarize: () => 'Check what is wrong',
    async run(args) {
      const rep = engineOf();
      if (!rep) return 'Only the owner of this server can use this.';
      const ps = await rep.detect({ deep: args.deep === true });
      const recent = rep.runs(8);
      return [
        ps.length ? `Problems now (${ps.length}):\n${ps.map(line).join('\n')}` : 'Problems now: none found.',
        recent.length ? `Recent repairs:\n${recent.map(runLine).join('\n')}` : '',
        'Explain them in plain words. To fix, call repair_fix with a problem id or "everything" (level 1). Problems marked "only explained" need the person (e.g. signing in again: never ask for passwords).',
      ].filter(Boolean).join('\n\n');
    },
  };
  const fix: Tool = {
    spec: {
      name: 'repair_fix',
      description: 'Fix what repair_status found: a problem id, or "everything" for all level 1 fixes (each is snapshotted, checked after, and put back by itself if health gets worse). A level 2 id ("grow:…") saves a skill on trial. To learn a new ability, pass learn ("check the shared calendar every Monday") and kind (skill, automation, addon). Never changes safety, limits, kid mode, approvals, the audit trail, passwords or its own permission.',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'A problem id from repair_status, or "everything".' },
          learn: { type: 'string', description: 'Level 2: what to learn to do.' },
          kind: { type: 'string', enum: ['skill', 'automation', 'addon'] },
          body: { type: 'string', description: 'For a skill: its steps (markdown).' },
          automation: { type: 'object', description: 'For an automation: {name, trigger, actions} as automation_create takes them.' },
        },
      },
    },
    defaultPermission: 'ask',
    isAvailable: () => Boolean(engineOf()),
    summarize: (args) => (args.learn ? `Learn: ${String(args.learn).slice(0, 80)}` : `Fix: ${String(args.problem ?? 'everything')}`),
    async prepare(args) {
      const rep = engineOf();
      if (!rep) return { refuse: 'Only the owner of this server can use this.' };
      const target = String(args.problem ?? '').trim();
      if (!target && !args.learn) return { refuse: 'Say which problem (an id from repair_status, or "everything"), or what to learn.' };
      if (target.startsWith('setting:') && neverTouch(target.slice(8))) return { refuse: 'Self-repair never changes safety, limits, kid mode, approvals, the audit trail, passwords or its own permission.' };
      if (!rep.checkedAt()) await rep.detect();
      const ps = target === 'everything' ? rep.problems().filter((p) => p.level === 1 && p.fixable) : target ? rep.problems().filter((p) => p.id === target) : [];
      if (target && !ps.length && !args.learn) return { refuse: target === 'everything' ? 'Nothing she can fix on her own right now.' : `No problem "${target}" right now (call repair_status again).` };
      const what = [...ps.map((p) => fill(p.text, p.params)), ...(args.learn ? [`learn (${String(args.kind ?? 'skill')}, on trial): ${String(args.learn).slice(0, 120)}`] : [])];
      const summary = `Self-repair: ${what.join('; ')}`.slice(0, 600);
      const alone = !args.learn && rep.allowedAlone(ps.map((p) => p.id));
      return { summary, ...(alone ? { auto: true } : {}) };
    },
    async run(args) {
      const rep = engineOf();
      if (!rep) return 'Only the owner of this server can use this.';
      const target = String(args.problem ?? '').trim();
      const learn = args.learn ? { what: String(args.learn), kind: String(args.kind ?? 'skill'), ...(typeof args.body === 'string' ? { body: args.body } : {}), ...(args.automation && typeof args.automation === 'object' ? { automation: args.automation as Record<string, unknown> } : {}) } : undefined;
      const runs = target ? await rep.fix(target, { by: 'chat', ...(learn ? { learn } : {}) }) : [await rep.learn(learn!, 'chat')];
      const left = rep.problems().filter((p) => p.level === 1);
      return [`Done (${runs.length}):\n${runs.map(runLine).join('\n')}`, left.length ? `Still open:\n${left.map(line).join('\n')}` : 'Nothing else is wrong now.', 'Tell the person in plain words what you did and that Undo is under Settings → Privacy & system → Health → Self-repair.'].join('\n\n');
    },
  };
  return [status, fix];
}

/** For the engine's own checks in tests: the AppContext's engine. */
export const engineOfApp = (app: () => AppContext) => () => app().repair;
