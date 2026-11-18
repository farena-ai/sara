// U4.22 (docs/HEALTH.md): her health log tools. Logging always works (the person's words are already
// in this chat), but she only repeats numbers back to a local model or a cloud model the person
// allowed for health. Reading the log (health_read) needs the same; otherwise she explains. The
// message that logged is marked `meta.health` (kept out of memory and Ask about anything). Never
// to other apps, outside requests or group chats (PEOPLE_TOOLS in src/chat.ts); kids never get these
// tools (KID_TOOLS) - a parent manages a child's medicines on the Health page.
import type { AppContext } from '../chat.ts';
import { entryText, healthFor, healthModelOk, NOT_ADVICE, parseQuick, type Quick } from '../health-log.ts';
import { formatLocal } from '../planner.ts';
import { ToolError, type Tool } from './types.ts';

export const HEALTH_TOOL_NAMES = ['health_log', 'health_read'] as const;
const LOCAL_ONLY = 'Your health log is only read with a local model on this server (a cloud model would see it). Logging still works. To change this: Settings → You → What Sara knows → Health log.';

/** Marks the newest message the person sent in this chat as health (memory and Ask skip it). */
function markLast(app: AppContext, conversationId: string | undefined): void {
  if (!conversationId) return;
  try {
    const last = app.store.messages(conversationId).findLast((m) => m.role === 'user');
    if (last) app.store.updateMessageMeta(last.id, { health: true });
  } catch {
    /* no such chat */
  }
}

export function createHealthTools(getApp: () => AppContext): Tool[] {
  return [
    {
      defaultPermission: 'auto',
      spec: {
        name: 'health_log',
        description:
          'Log something in the person\u2019s private Health log: a symptom with a 0-10 score ("headache 6/10"), mood, sleep, a measurement ("BP 128/82", "weight 172 lb", "glucose 104"), or a medicine dose taken/skipped (med + status). Use it when they state a reading or symptom to log. Never give medical advice or a diagnosis.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The reading as they said it, e.g. "headache 6/10" or "BP 128/82".' },
            note: { type: 'string', description: 'Optional note in their words.' },
            med: { type: 'string', description: 'A medicine name, to log a dose.' },
            status: { type: 'string', enum: ['taken', 'skipped'], description: 'For a dose: taken or skipped.' },
          },
        },
      },
      summarize: () => 'Log in Health',
      async run(args, ctx) {
        const app = getApp();
        const h = healthFor(app);
        const ok = healthModelOk(app, ctx.modelLocal);
        if (typeof args.med === 'string' && args.med.trim()) {
          const want = args.med.trim().toLowerCase();
          const med = h.meds().find((m) => m.name.toLowerCase() === want) ?? h.meds().find((m) => m.name.toLowerCase().includes(want) || want.includes(m.name.toLowerCase()));
          if (!med) throw new ToolError(ok ? `No medicine called "${args.med}" in Health. Add it on the Health page first.` : 'No medicine with that name in Health. Add it on the Health page first.');
          const status = args.status === 'skipped' ? 'skipped' : 'taken';
          h.logDose(med.id, status);
          markLast(app, ctx.conversationId);
          return ok ? `Logged in Health: ${med.name} ${status}.` : `Logged in Health (${status}).`;
        }
        const q: Quick | undefined = parseQuick(String(args.text ?? ''));
        if (!q) throw new ToolError('Say it like "headache 6/10", "mood 7/10", "slept 7h", "BP 128/82", "weight 172 lb" or "glucose 104".');
        const e = h.addEntry({ ...q, ...(typeof args.note === 'string' && args.note.trim() ? { note: args.note } : {}) });
        markLast(app, ctx.conversationId);
        // A cloud model is not told the numbers back (the Health page shows them).
        return ok ? `Logged in Health: ${entryText(e)}.` : 'Logged in Health.';
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: {
        name: 'health_read',
        description:
          'Read the person\u2019s private Health log: "meds" (medicines, doses due, refill estimates), "recent" (symptoms, mood, sleep, measurements of the last days), "appointments" (with prep questions and notes). Only to answer what they asked; never medical advice or a diagnosis.',
        parameters: {
          type: 'object',
          properties: {
            what: { type: 'string', enum: ['meds', 'recent', 'appointments'] },
            days: { type: 'number', description: 'For recent: how many days back (default 14).' },
          },
          required: ['what'],
        },
      },
      summarize: () => 'Read Health',
      async run(args, ctx) {
        const app = getApp();
        if (!healthModelOk(app, ctx.modelLocal)) return LOCAL_ONLY;
        const h = healthFor(app);
        const tz = app.settings.get().timeZone || undefined;
        markLast(app, ctx.conversationId);
        const lines: string[] = [];
        if (args.what === 'meds') {
          const meds = h.meds();
          if (!meds.length) lines.push('No medicines in Health.');
          for (const m of meds) {
            const r = h.refill(m.id);
            lines.push(`- ${m.name} ${m.dose} at ${m.times.join(', ') || 'no set time'}${r ? ` · about ${r.left} left, refill by ${r.date}${r.soon ? ' (soon)' : ''}` : ''}`);
          }
          const due = h.doses({ status: 'due' });
          if (due.length) lines.push(`Doses waiting to be marked: ${due.length}.`);
        } else if (args.what === 'appointments') {
          const list = h.appts().filter((a) => Date.parse(a.when) > app.now().getTime() - 30 * 86_400_000);
          if (!list.length) lines.push('No appointments in Health.');
          for (const a of list) lines.push(`- ${a.title} ${formatLocal(a.when, tz)}${a.where ? ` at ${a.where}` : ''}${a.questions.length ? `; questions: ${a.questions.join('; ')}` : ''}${a.notes ? `; after the visit: ${a.notes}` : ''}`);
        } else {
          const days = Math.max(1, Math.min(90, Number(args.days) || 14));
          const list = h.entries({ from: new Date(app.now().getTime() - days * 86_400_000).toISOString(), limit: 60 });
          if (!list.length) lines.push(`Nothing logged in the last ${days} days.`);
          for (const e of list) lines.push(`- ${formatLocal(e.at, tz)} ${entryText(e)}${e.note ? ` (${e.note})` : ''}`);
        }
        return `${lines.join('\n')}\n\n${NOT_ADVICE}`;
      },
    },
  ];
}
