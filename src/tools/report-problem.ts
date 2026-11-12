// Fred fix C: "can you tell the support desk?" The companion drafts a problem report for the person
// (their words, the last error in this chat, the failing turn's tool names and statuses, the same
// scrubbed diagnostics Report a problem builds) and ALWAYS asks before anything is sent: the
// approval card shows the draft. Sending goes through fileTicket (src/hub.ts), so it lands in
// Help → My reports like a report from the sheet.
import type { AppContext } from '../chat.ts';
import { buildDiagnostics, fileTicket, ticketBlocked, type DiagStep } from '../hub.ts';
import type { Tool } from './types.ts';

export const REPORT_PROBLEM = 'report_problem';

/** The newest error the app kept in this conversation (a `turnerror:` notice), if any. */
export function lastTurnError(app: AppContext, conversationId: string | undefined): string | undefined {
  if (!conversationId) return undefined;
  const msgs = app.store.messages(conversationId);
  for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 200; i--) {
    const m = msgs[i];
    if (m.role === 'notice' && m.content.startsWith('turnerror:')) return String((m.meta as { error?: unknown } | undefined)?.error ?? m.content.slice('turnerror:'.length));
  }
  return undefined;
}

function stepsOf(app: AppContext, conversationId: string | undefined): DiagStep[] {
  if (!conversationId || !app.runs) return [];
  // The newest run that ended in an error (else the newest run): tool names and statuses only.
  const runs = app.runs.list({ conversationId, limit: 5 });
  const run = runs.find((r) => r.status === 'error') ?? runs[0];
  return run ? app.runs.steps(run.id).flatMap((s) => s.tools.map((t) => ({ tool: t.name, status: t.status }))) : [];
}

interface Draft { title: string; body: string; error?: string }

function draftOf(app: AppContext, args: Record<string, unknown>, conversationId: string | undefined): Draft {
  const clean = (v: unknown, max: number) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  const error = args.include_last_error === false ? undefined : lastTurnError(app, conversationId);
  const title = clean(args.title, 120).replace(/\s+/g, ' ') || (error ? error.split('\n')[0].slice(0, 120) : 'A problem in Sara');
  const body = clean(args.what_happened, 4000) || title;
  return { title, body, ...(error ? { error } : {}) };
}

export function createReportProblemTool(getApp: () => AppContext): Tool {
  return {
    defaultPermission: 'ask',
    source: 'built-in',
    isAvailable: () => {
      const app = getApp();
      return Boolean(app.hub && !app.hub.demo);
    },
    // Sending anything to the support desk always asks, whatever the tool's setting.
    asksFirst: () => true,
    spec: {
      name: REPORT_PROBLEM,
      description:
        "Send a problem report to the people who make this app (the support desk), for the person, when they ask you to report or tell the developers about something that went wrong (a failed reply, an error, a bug). You write a short title and what happened in their words; the app adds the last error from this chat and scrubbed diagnostics, shows them the whole draft and sends it only if they say yes. Never send one they didn't ask for.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short title (under 120 characters).' },
          what_happened: { type: 'string', description: 'What went wrong, in their words: what they did, what they expected, what happened.' },
          include_last_error: { type: 'boolean', description: 'Add the last error from this chat (default true).' },
        },
        required: ['title', 'what_happened'],
      },
    },
    summarize: (a) => `Report a problem: ${String(a.title ?? '').slice(0, 100)}`,
    async prepare(args, ctx) {
      const app = getApp();
      if (!app.hub || app.hub.demo) return { refuse: 'Reports are not available here.' };
      if (ticketBlocked(app.hub)) return { refuse: "Reports can't be sent while “Nothing leaves this computer” is on (or the support desk can't be reached from here)." };
      const d = draftOf(app, args, ctx.conversationId);
      const lines = [`Send this problem report to the people who make Sara? “${d.title}”`, d.body !== d.title ? d.body.slice(0, 600) : '', d.error ? `Last error: ${d.error.slice(0, 400)}` : '', 'With scrubbed diagnostics (version, settings shape, recent log, the failing step’s tool names). Nothing is sent unless you say yes.'];
      return { summary: lines.filter(Boolean).join('\n'), ask: true };
    },
    async run(args, ctx) {
      const app = getApp();
      const hub = app.hub;
      if (!hub || hub.demo) return 'Reports are not available here.';
      const d = draftOf(app, args, ctx.conversationId);
      const diagnostics = buildDiagnostics(hub, { error: d.error, settings: app.settings.get() as unknown as Record<string, unknown>, steps: stepsOf(app, ctx.conversationId) });
      const r = await fileTicket(hub, { kind: 'bug', title: d.title, body: d.body, diagnostics });
      if (r.ok) return `Sent to the support desk as ${r.ticket}. They can follow it (and read the team's replies) in Help → My reports.`;
      if (r.code === 'private') return "Not sent: reports can't be sent while “Nothing leaves this computer” is on.";
      if (r.code === 'limit') return 'Not sent: too many reports today. Try again tomorrow.';
      if (r.code === 'refused') return `Not sent: the support desk refused the report: ${r.reason || 'no reason given'}. They can try Help → Report a problem.`;
      if (r.code === 'title') return 'Not sent: the report needs a short title.';
      return "Not sent: the support desk didn't answer. Try again later, or use Help → Report a problem.";
    },
  };
}
