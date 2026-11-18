// V2.6 (docs/UPKEEP.md): upkeep_list and upkeep_log, the person's car and house upkeep from chat
// ("when is my oil change due?", "I changed the furnace filter today"). Each space its own list
// (src/upkeep.ts); logging moves the next due date and its Planner reminder.
import type { AppContext } from '../chat.ts';
import { findUpkeep, upkeepAction, UpkeepError, upkeepLine, upkeepList } from '../upkeep.ts';
import { ToolError, type Tool } from './types.ts';

const WHERE = 'Settings → You → My details → Car and house upkeep';

export function createUpkeepTools(getApp: () => AppContext): Tool[] {
  const list: Tool = {
    defaultPermission: 'auto',
    interruptible: true,
    spec: {
      name: 'upkeep_list',
      description: `The person's car and house upkeep (${WHERE}): each job (oil change, tire rotation, furnace/AC filter, gutters, smoke alarms…) with its next due date (by months, or by miles for a car), the last time it was done, and service receipts found but not logged yet. Use it for "when is my oil change due?" or "what upkeep is coming up?".`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    summarize: () => 'read your car and house upkeep',
    async run() {
      const l = upkeepList(getApp());
      if (!l.items.length) return `No upkeep schedules yet. They can be set up in ${WHERE} (a car from My details, or the home: filters, gutters, smoke alarms).`;
      const lines = l.items.map(upkeepLine);
      for (const [car, o] of Object.entries(l.odometer)) lines.push(`Odometer ${car}: ${o.miles.toLocaleString('en-US')} miles on ${o.date} (about ${o.perDay} miles a day)`);
      for (const f of l.found) lines.push(`Receipt not logged yet: ${f.item} at ${f.store} on ${f.date} looks like “${f.title}”${f.car ? ` (${f.car})` : ''}`);
      return `Upkeep (${WHERE}), soonest first:\n${lines.join('\n')}`;
    },
  };
  const log: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'upkeep_log',
      description: `Log that an upkeep job was done (an oil change, a new furnace filter, cleaned gutters, tested smoke alarms…), which resets its next due date and reminder in ${WHERE}. Pass the job in a few words; the date (YYYY-MM-DD, default today), the odometer miles for a car, a cost and a short note when the person says them. Only log what they say was done.`,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The job in a few words, e.g. "oil change Civic" or "furnace filter".' },
          date: { type: 'string', description: 'YYYY-MM-DD, default today.' },
          miles: { type: 'number', description: 'Odometer miles at the service (cars).' },
          cost: { type: 'number', description: 'What it cost, in dollars.' },
          note: { type: 'string' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `log upkeep: ${String((a as { task?: string }).task ?? '')}`,
    async run(args) {
      const app = getApp();
      const a = args as { task?: string; date?: string; miles?: number; cost?: number; note?: string };
      const it = findUpkeep(app, String(a.task ?? ''));
      if (!it) throw new ToolError(`No upkeep task matches “${a.task}”. Call upkeep_list to see the jobs, or set one up in ${WHERE}.`);
      try {
        const r = upkeepAction(app, 'log', { id: it.id, date: a.date, miles: a.miles, cost: a.cost, note: a.note });
        const x = r.item!;
        return `Logged “${x.title}”${x.car ? ` (${x.car})` : ''} on ${x.history[0].date}; next due ${x.next.date}${x.next.miles ? ` or at ${x.next.miles.toLocaleString('en-US')} miles` : ''}${x.remind ? ', with a reminder that day' : ''}.`;
      } catch (err) {
        if (err instanceof UpkeepError) throw new ToolError(err.message);
        throw err;
      }
    },
  };
  return [list, log];
}
