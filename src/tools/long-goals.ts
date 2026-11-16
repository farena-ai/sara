// S3 (docs/GOALS.md "Goals over days"): her goal tools. goal_create always asks: its card IS the plan
// (each milestone, its date and what it starts), so setting one up takes one Allow. Anything a
// milestone starts still asks on its own (an errand waits for Start, an automation is made switched
// off). goal_status only reads. goal_update adds a note, ticks a milestone off or changes the plan;
// a proposed new plan is only the person's to use (Goals page or Today), never hers.
import { type AppContext } from '../chat.ts';
import { GoalError, longGoalsFor, MILESTONE_KINDS, type GoalDraft, type MilestoneDraft } from '../long-goals.ts';
import { ToolError, type Tool } from './types.ts';

const MILESTONE_DOC =
  'milestones (optional; else three checkpoints are spread up to the due date): [{text, due: "YYYY-MM-DD", kind?: "none"|"task"|"reminder"|"errand"|"automation", errand?: {template?, facts?} (errand: a goal she takes care of step by step; it waits for the person’s Start), automation?: {name, trigger, actions} (an automation draft; made switched off until the person turns it on)}]. A task goes in the Planner; a reminder rings on the morning of its date.';
const guard = <T>(f: () => T): T => {
  try {
    return f();
  } catch (err) {
    if (err instanceof GoalError) throw new ToolError(err.message);
    throw err;
  }
};
const idOf = (args: Record<string, unknown>) => {
  const id = Number(String(args.id ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new ToolError('Which goal? Give its number (goal_status without an id lists them).');
  return id;
};
const draftOf = (a: Record<string, unknown>): GoalDraft => ({
  title: String(a.title ?? a.goal ?? ''),
  ...(typeof a.due === 'string' && a.due ? { due: a.due } : {}),
  ...(Array.isArray(a.milestones) ? { milestones: a.milestones as MilestoneDraft[] } : {}),
});
const nth = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v - 1 : undefined);

export function createLongGoalTools(getApp: () => AppContext): Tool[] {
  const store = () => longGoalsFor(getApp());
  return [
    {
      defaultPermission: 'ask',
      spec: {
        name: 'goal_create',
        description: `Set up a long-running goal she follows over days or weeks ("get my house sale paperwork done by Dec 15", "run a 10k in March", "learn Spanish basics this winter"): a plan of milestones with due dates. She checks progress, nudges before each checkpoint, proposes a new plan when something slips and sends a weekly summary. For a single multi-step job ("get this charge refunded") use errand_start instead. ${MILESTONE_DOC} The person sees the plan on the card and taps Allow once.`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The goal in the person’s words.' },
            due: { type: 'string', description: 'YYYY-MM-DD: when it should be done.' },
            milestones: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, due: { type: 'string' }, kind: { type: 'string', enum: [...MILESTONE_KINDS] } } }, description: MILESTONE_DOC },
          },
          required: ['title'],
        },
      },
      summarize: (a) => {
        try {
          return `Set up this goal:\n${store().planText(draftOf(a))}`;
        } catch (err) {
          return `Can't set that up yet: ${(err as Error).message}`;
        }
      },
      async run(args, ctx) {
        const g = guard(() => store().create(draftOf(args), { by: 'chat', conversationId: ctx.conversationId ?? null }));
        return `Goal #${g.id} “${g.title}” set up with ${g.milestones.length} milestones. It's on the Goals page with its progress and history. Don't say a milestone is done until goal_status shows it.`;
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'goal_status', description: 'The person’s long-running goals (no id: all open ones with progress and the next step) or one goal: each milestone, its date, what it started, a waiting new plan and recent history.', parameters: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean', description: 'Include done and stopped goals.' } } } },
      summarize: (a) => (a.id ? `Goal #${String(a.id)}` : 'List goals'),
      async run(args) {
        if (args.id === undefined || args.id === '') return store().listText(args.all === true);
        const g = store().get(idOf(args));
        if (!g) throw new ToolError('No goal with that number.');
        return store().statusText(g);
      },
    },
    {
      defaultPermission: 'auto',
      spec: {
        name: 'goal_update',
        description: 'Change a goal: add a note (what they told you), tick a milestone off when they say it is done, reopen or skip one, add a milestone, move a milestone’s date or the goal’s date, pause, resume or stop it. A proposed new plan is theirs to use on the Goals page: you can’t use it for them.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            note: { type: 'string' },
            done: { type: 'integer', description: 'Milestone number (1 = first) to tick off.' },
            undone: { type: 'integer', description: 'Milestone number to reopen.' },
            skip: { type: 'integer', description: 'Milestone number to skip.' },
            add_milestone: { type: 'object', description: '{text, due?, kind?}' },
            move: { type: 'object', description: '{milestone: number, due: "YYYY-MM-DD"}' },
            due: { type: 'string', description: 'The goal’s new date, YYYY-MM-DD.' },
            title: { type: 'string' },
            state: { type: 'string', enum: ['pause', 'resume', 'stop'] },
          },
          required: ['id'],
        },
      },
      summarize: (a) => `Update goal #${String(a.id ?? '')}${a.note ? `: ${String(a.note).slice(0, 80)}` : ''}`,
      async run(args) {
        const id = idOf(args);
        const s = store();
        const mv = args.move && typeof args.move === 'object' ? (args.move as Record<string, unknown>) : undefined;
        let g = guard(() =>
          s.update(
            id,
            {
              ...(typeof args.note === 'string' ? { note: args.note } : {}),
              ...(typeof args.title === 'string' ? { title: args.title } : {}),
              ...(typeof args.due === 'string' ? { due: args.due } : {}),
              ...(nth(args.done) !== undefined ? { done: nth(args.done)! } : {}),
              ...(nth(args.undone) !== undefined ? { undone: nth(args.undone)! } : {}),
              ...(nth(args.skip) !== undefined ? { skip: nth(args.skip)! } : {}),
              ...(args.add_milestone && typeof args.add_milestone === 'object' ? { addMilestone: args.add_milestone as MilestoneDraft } : {}),
              ...(mv && nth(mv.milestone) !== undefined ? { milestoneDue: { index: nth(mv.milestone)!, due: typeof mv.due === 'string' ? mv.due : null } } : {}),
            },
            { by: 'model' },
          ),
        );
        if (args.state === 'pause') g = s.pause(id);
        else if (args.state === 'resume') g = s.resume(id);
        else if (args.state === 'stop') g = s.stop(id);
        const p = s.progress(g);
        return `Goal #${g.id} updated (${g.status}, ${p.done} of ${p.total} milestones).${g.proposal ? ' A new plan still waits for them on the Goals page.' : ''}`;
      },
    },
  ];
}
