// N2 (docs/AUTOMATIONS.md): her automation tools. automation_create always asks: its card IS the
// preview (what will run, the next three times, which approvals each run asks), so making one takes
// exactly one Allow. Preview, dry run, list and history only read (a dry run performs nothing).
// Turning one on, deleting one and running one now ask; turning one off doesn't.
import { type AppContext } from '../chat.ts';
import { AutomationError, automationsFor, draftFromWords, localWhen, STARTERS, type Draft } from '../automations.ts';
import { ToolError, type Tool } from './types.ts';

const TRIGGER_DOC =
  'trigger: {kind:"schedule", every:"day"|"weekdays"|"week"|"month", time:"HH:MM" (24h, their time zone), days:[0-6] (week; 0=Sunday, 5=Friday), day:1-31 (month)} | {kind:"email", from?, words?} | {kind:"webhook", hookId, event?} | {kind:"calendar", minutes (before an event starts), words?} | {kind:"live"|"product"|"file", ref (an existing watch id) or watch:{…the watch_add / product_watch_add fields}}.';
const ACTION_DOC =
  'actions (in order): {kind:"notify", text, how:"phone"|"chat"|"desktop"} | {kind:"task", prompt (what Sara should do; a normal turn with the usual approvals)} | {kind:"draft_email", to, subject, body, sendWithoutAsking?} | {kind:"fill", document (their template in the Library), values?:{label:value}, timesheet?:{week:"this"|"last", start:"2200", end:"0700", lunchMinutes, regularHours, words (work event words), days:[0-6] (fixed work days without a calendar), source:\"calendar\"|\"tracked\"|\"both\" (tracked = hours logged with time_start/time_add)}} | {kind:"recipe", prompt (recipe name)} | {kind:"expense"|"bill", prompt}. In notify text, {week} and {files} are filled in.';

function draftOf(args: Record<string, unknown>): Draft | Record<string, unknown> {
  const words = String(args.description ?? '').trim();
  const starter = STARTERS.find((s) => s.id === args.starter);
  const base: Record<string, unknown> = starter ? { ...starter.draft } : words ? { ...draftFromWords(words) } : {};
  for (const k of ['name', 'trigger', 'condition', 'actions'] as const) if (args[k] !== undefined && args[k] !== null && args[k] !== '') base[k] = args[k];
  // A starter's time-sheet rules can be adjusted in words ("shifts are 2200-0700, no lunch").
  if (starter && words) {
    const w = draftFromWords(words);
    const ts = w.actions.find((a) => a.timesheet)?.timesheet;
    if (ts && Array.isArray(base.actions)) base.actions = (base.actions as Record<string, unknown>[]).map((a) => (a.kind === 'fill' ? { ...a, timesheet: { ...(a.timesheet as object), ...ts } } : a));
    if (args.trigger === undefined && /\b(every|each|on)\b/i.test(words)) base.trigger = w.trigger;
  }
  return base;
}
const guard = <T>(f: () => T): T => {
  try {
    return f();
  } catch (err) {
    if (err instanceof AutomationError) throw new ToolError(err.message);
    throw err;
  }
};
const guardAsync = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof AutomationError) throw new ToolError(err.message);
    throw err;
  }
};
const privateChat = (app: AppContext, conversationId?: string) => Boolean(conversationId && app.store.getConversation(conversationId)?.private);
const idOf = (args: Record<string, unknown>) => {
  const id = Number(String(args.id ?? '').replace(/^#|^auto:/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new ToolError('Which automation? Give its number (automation_list shows them).');
  return id;
};
const DRAFT_PROPS = {
  description: { type: 'string', description: 'The person’s words, e.g. "every Friday at 3, fill my time sheet from my calendar and send me the draft".' },
  starter: { type: 'string', description: 'A ready-made one: "timesheet" (Fill my time sheet every week).' },
  name: { type: 'string' },
  trigger: { type: 'object', description: TRIGGER_DOC },
  condition: { type: 'object', description: 'Optional {words}: run only when the trigger’s detail has these words.' },
  actions: { type: 'array', items: { type: 'object' }, description: ACTION_DOC },
};

export function createAutomationTools(getApp: () => AppContext): Tool[] {
  const store = () => automationsFor(getApp());
  const preview = (args: Record<string, unknown>) => {
    try {
      return store().previewText(draftOf(args));
    } catch (err) {
      return `Can't make that yet: ${(err as Error).message}`;
    }
  };
  return [
    {
      defaultPermission: 'ask',
      spec: {
        name: 'automation_create',
        description: `Make an automation ("When ___, do ___"): something that runs on its own on a schedule or when something happens. Use it for "every Friday…", "whenever…", "remind me every…", "when X then Y". Give the person's words as description and, when you can, the structure too. ${TRIGGER_DOC} ${ACTION_DOC} The person sees the preview (what runs, the next 3 times, the approvals) on the card and taps Allow once. Suggest automation_dry_run after.`,
        parameters: { type: 'object', properties: DRAFT_PROPS },
      },
      summarize: (a) => `Make this automation:\n${preview(a)}`,
      async run(args, ctx) {
        const app = getApp();
        if (privateChat(app, ctx.conversationId)) throw new ToolError('Automations can’t be set up from a private chat. Ask in a normal chat.');
        const a = guard(() => store().create(draftOf(args), { by: 'chat', conversationId: ctx.conversationId ?? null }));
        const next = a.nextAt ? ` Next run: ${localWhen(new Date(a.nextAt), app.settings.get().timeZone)}.` : '';
        return `Made automation #${a.id} “${a.name}” (on).${next} It's on Settings → You → Automations with its history. Offer a dry run (automation_dry_run) to see what it would do.`;
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: {
        name: 'automation_preview',
        description: 'Show exactly what an automation will do: when (the next 3 times), each action, and which approvals each run asks. For an existing one give id; for a new idea give description and/or the structure (as automation_create).',
        parameters: { type: 'object', properties: { id: { type: 'string' }, ...DRAFT_PROPS } },
      },
      summarize: (a) => `Preview automation ${String(a.id ?? a.name ?? a.description ?? '').slice(0, 60)}`,
      async run(args) {
        if (args.id) {
          const a = store().get(idOf(args));
          if (!a) throw new ToolError('No automation with that number.');
          return `#${a.id} ${a.enabled ? '(on)' : '(paused)'}\n${store().previewText(a)}`;
        }
        return preview(args);
      },
    },
    {
      defaultPermission: 'auto',
      spec: {
        name: 'automation_dry_run',
        description: 'Try an automation without doing anything: no draft is saved, no copy is kept, no task runs, no phone notification (one chat line labeled as a test). Reports what each action would do with today’s data. Give id (an existing one) or a draft (as automation_create).',
        parameters: { type: 'object', properties: { id: { type: 'string' }, ...DRAFT_PROPS } },
      },
      summarize: (a) => `Test-run automation ${String(a.id ?? a.name ?? '').slice(0, 60)} (nothing is done)`,
      async run(args, ctx) {
        const app = getApp();
        if (privateChat(app, ctx.conversationId)) throw new ToolError('Automations can’t be set up from a private chat.');
        const s = store();
        const steps = args.id ? (await s.fire(idOf(args), 'Test run', { dry: true })).steps : await guardAsync(() => s.dryDraft(draftOf(args), ctx.conversationId));
        return `Dry run (nothing was done):\n${steps.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}`;
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'automation_list', description: 'List every automation in one place: hers, and the watches, triggers, routines and repeating reminders set up elsewhere, with when they run, the next run and the last result.', parameters: { type: 'object', properties: {} } },
      summarize: () => 'List automations',
      async run() {
        const items = store().all();
        if (!items.length) return 'No automations yet.';
        return items.map((x) => `${x.key} ${x.enabled ? 'on' : 'off'} · ${x.name} · ${x.when}${x.nextLocal ? ` · next ${x.nextLocal}` : ''}${x.last ? ` · last ${x.last.outcome}` : ''}${x.status ? ` · ${x.status}` : ''}`).join('\n');
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'automation_history', description: 'The last runs of an automation (time, what started it, what each action did, the outcome).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      summarize: (a) => `Automation history #${String(a.id ?? '')}`,
      async run(args) {
        const runs = store().history(idOf(args), 10);
        if (!runs.length) return 'It has not run yet.';
        return runs.map((r) => `${r.at} ${r.dry ? 'test' : r.outcome} · ${r.trigger} · ${r.summary}`).join('\n');
      },
    },
    {
      defaultPermission: 'ask',
      spec: { name: 'automation_enable', description: 'Turn an automation back on.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      summarize: (a) => `Turn on automation #${String(a.id ?? '')}`,
      async run(args) {
        const a = guard(() => store().setEnabled(idOf(args), true));
        return `Automation #${a.id} “${a.name}” is on.`;
      },
    },
    {
      defaultPermission: 'auto',
      spec: { name: 'automation_disable', description: 'Pause an automation (it stays, with its history).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      summarize: (a) => `Pause automation #${String(a.id ?? '')}`,
      async run(args) {
        const a = guard(() => store().setEnabled(idOf(args), false));
        return `Automation #${a.id} “${a.name}” is paused.`;
      },
    },
    {
      defaultPermission: 'ask',
      spec: { name: 'automation_delete', description: 'Delete an automation and its history (a watch made for it goes too).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      summarize: (a) => `Delete automation #${String(a.id ?? '')}`,
      async run(args) {
        const id = idOf(args);
        if (!store().remove(id)) throw new ToolError('No automation with that number.');
        return `Deleted automation #${id}.`;
      },
    },
  ];
}
