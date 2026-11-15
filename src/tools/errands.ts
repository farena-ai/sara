// R3 (docs/ERRANDS.md): her errand tools. errand_start always asks: its card IS the plan (each step and
// which ones ask first), so starting one takes exactly one Allow. Status and list only read. Updating
// adds a note or changes the plan (never "send without asking": only the person turns that on, on the
// Errands page). Stopping doesn't ask (it only stops).
import { type AppContext } from '../chat.ts';
import { ErrandError, errandsFor, TEMPLATES, type ErrandDraft, type StepDraft } from '../errands.ts';
import { privateLocalOn } from '../net-guard.ts';
import { ToolError, type Tool } from './types.ts';

const STEP_DOC =
  'steps (optional; else a ready plan is picked from the goal): [{text, kind:"research"|"message"|"form"|"browser"|"call"|"purchase"|"wait"|"decide", tool? (a read-only tool for research: mail_search, web_search, stores_near, find_product), args?, to?, subject?, body? (message; {merchant}, {amount}, {email}, {owner} are filled in), url? (form/purchase), phone?, script? (call), amount? (purchase, US dollars), options? (decide), followUpDays? (wait), needsOk? (browser: a final confirm)}]. Purchases are never made by her: they hand the page over. Calls ask first on their own card (number, script, cost) when phone calls are set up and on; otherwise they give the number and what to say.';
const guard = <T>(f: () => T): T => {
  try {
    return f();
  } catch (err) {
    if (err instanceof ErrandError) throw new ToolError(err.message);
    throw err;
  }
};
const guardAsync = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof ErrandError) throw new ToolError(err.message);
    throw err;
  }
};
const idOf = (args: Record<string, unknown>) => {
  const id = Number(String(args.id ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new ToolError('Which errand? Give its number (errand_list shows them).');
  return id;
};
const draftOf = (a: Record<string, unknown>): ErrandDraft => ({
  goal: String(a.goal ?? ''),
  ...(typeof a.template === 'string' && a.template ? { template: a.template } : {}),
  ...(Array.isArray(a.steps) ? { steps: a.steps as StepDraft[] } : {}),
  ...(a.facts && typeof a.facts === 'object' ? { facts: a.facts as Record<string, unknown> } : {}),
  ...(typeof a.deadline === 'string' && a.deadline ? { deadline: a.deadline } : {}),
  ...(typeof a.budget === 'number' ? { budget: a.budget } : {}),
});

export function createErrandTools(getApp: () => AppContext): Tool[] {
  const store = () => errandsFor(getApp());
  const off = () => !privateLocalOn();
  return [
    {
      defaultPermission: 'ask',
      isAvailable: off,
      spec: {
        name: 'errand_start',
        description: `Start an errand: a goal she takes care of from start to finish over days ("get this charge refunded", "book an oil change this week", "find and book a plumber", "cancel my subscription", "get quotes from 3 contractors", "write a complaint letter"). Ready plans (template): ${TEMPLATES.map((t) => t.id).join(', ')}. Give what you know as facts: merchant, amount, service, place, when, about, details. ${STEP_DOC} The person sees the plan on the card and taps Allow once; every email, form, purchase and choice still asks them on the way.`,
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'The goal in the person’s words.' },
            template: { type: 'string', enum: TEMPLATES.map((t) => t.id) },
            facts: { type: 'object', description: 'What is known: {merchant, amount, service, place, when, about, details}.' },
            steps: { type: 'array', items: { type: 'object' }, description: STEP_DOC },
            deadline: { type: 'string', description: 'YYYY-MM-DD (or a date-time): she stops with a summary after it.' },
            budget: { type: 'number', description: 'US dollars: she stops before anything that would cost more.' },
          },
          required: ['goal'],
        },
      },
      summarize: (a) => {
        try {
          return `Start this errand:\n${store().planText(draftOf(a))}`;
        } catch (err) {
          return `Can't start that yet: ${(err as Error).message}`;
        }
      },
      async run(args, ctx) {
        const e = guard(() => store().start(draftOf(args), { by: 'chat', conversationId: ctx.conversationId ?? null }));
        return `Errand #${e.id} “${e.goal}” started (${e.steps.length} steps). She works on it in the background and asks on the way; it's on the Errands page with its timeline. Don't say any step is done until errand_status shows it.`;
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'errand_status', description: 'One errand: each step, what came back and its evidence (Verified lines), what she needs from the person, the summary.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      summarize: (a) => `Errand #${String(a.id ?? '')}`,
      async run(args) {
        const e = store().get(idOf(args));
        if (!e) throw new ToolError('No errand with that number.');
        return store().statusText(e);
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'errand_list', description: 'The person’s errands: open ones first, with their status and what each needs from them.', parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Include done and stopped ones.' } } } },
      summarize: () => 'List errands',
      async run(args) {
        const list = store().list(args.all === true ? {} : { open: true });
        if (!list.length) return args.all === true ? 'No errands yet.' : 'No open errands.';
        return list.map((e) => `#${e.id} ${e.status.replace('_', ' ')} · ${e.goal} · ${e.steps.filter((s) => s.status === 'done').length}/${e.steps.length} steps${e.needs ? ` · needs: ${e.needs.split('\n')[0]}` : ''}`).join('\n');
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: off,
      spec: {
        name: 'errand_update',
        description: 'Change an errand: add a note (what they told you, e.g. "they called back and refunded it"), set facts (an email address, the amount), change the deadline or budget, add a step or remove one that hasn’t run.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, note: { type: 'string' }, facts: { type: 'object' }, deadline: { type: 'string' }, budget: { type: 'number' }, add_step: { type: 'object', description: STEP_DOC }, remove_step: { type: 'integer', description: 'Step number (1 = first) of a step that hasn’t run' }, send_without_asking: { type: 'boolean', description: 'Not hers to change: only the person turns this on, on the Errands page.' } },
          required: ['id'],
        },
      },
      summarize: (a) => `Update errand #${String(a.id ?? '')}${a.note ? `: ${String(a.note).slice(0, 80)}` : ''}`,
      async run(args) {
        const id = idOf(args);
        const e = guard(() =>
          store().update(
            id,
            {
              ...(typeof args.note === 'string' ? { note: args.note } : {}),
              ...(args.facts && typeof args.facts === 'object' ? { facts: args.facts as Record<string, unknown> } : {}),
              ...(typeof args.deadline === 'string' ? { deadline: args.deadline } : {}),
              ...(typeof args.budget === 'number' ? { budget: args.budget } : {}),
              ...(args.add_step && typeof args.add_step === 'object' ? { addStep: args.add_step as StepDraft } : {}),
              ...(typeof args.remove_step === 'number' ? { removeStep: args.remove_step - 1 } : {}),
            },
            { by: 'model' },
          ),
        );
        const extra = args.send_without_asking !== undefined ? ' Sending without asking was not changed: only you can turn that on, on the Errands page.' : '';
        return `Errand #${e.id} updated.${extra}`;
      },
    },
    {
      defaultPermission: 'auto',
      spec: { name: 'errand_stop', description: 'Stop an errand (it keeps its timeline and gets a summary of what was done and what wasn’t).', parameters: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id'] } },
      summarize: (a) => `Stop errand #${String(a.id ?? '')}`,
      async run(args) {
        const e = await guardAsync(async () => store().stop(idOf(args), typeof args.why === 'string' && args.why.trim() ? args.why.trim().slice(0, 200) : undefined));
        return `Errand #${e.id} stopped.\n${e.summary ?? ''}`;
      },
    },
  ];
}
