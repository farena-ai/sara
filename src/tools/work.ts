// N7 (docs/WORK_AND_TEAMS.md): work and teams. Shared lists for the household (shared boards from
// Phase 99: only lists shared on purpose cross between spaces), a light client pipeline tied to E6
// quotes and invoices, and time tracking that feeds invoices and time sheets. Every person (owner or
// member) has their own clients and hours in their own store.db; shared lists live in the one shared
// store and each call names the person asking.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { DocError, FORMAT_LABEL, imagesOf, keepMade, renderDocument } from '../documents/make.ts';
import { cleanSpec, MIME, type DocFormat } from '../documents/spec.ts';
import { usDate } from '../biz/invoices.ts';
import { fmtMoney, toCents } from '../biz/money.ts';
import { billedExpenses, billExpenses } from '../biz/pack.ts';
import { bizStore } from '../biz/store.ts';
import { formatLocal, parseWhen, zonedParts } from '../planner.ts';
import { fold } from '../people.ts';
import { clientStoreOf, foldName, isStage, STAGES, type Client, type Stage } from '../work/clients.ts';
import { localDayOf, LONG_TIMER_HOURS, sumHours, timeStoreOf, type TimeEntry } from '../work/time.ts';
import { createBizTools } from './biz.ts';
import { shareMade } from './make-document.ts';
import { humanSize } from './send-file.ts';
import { ToolError, type Tool, type ToolContext } from './types.ts';
import { todayChanged } from '../today.ts';

export const WORK_TOOLS = ['household_lists', 'list_share', 'task_assign', 'client_add', 'client_stage', 'clients_pipeline', 'time_start', 'time_stop', 'time_add', 'time_report', 'time_invoice'] as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const tz = (app: AppContext) => app.settings.get().timeZone;

/** The person's own database for clients and hours (the same one their invoices live in). */
export function workDb(app: AppContext): DatabaseSync {
  let db = app.store.db;
  try {
    db = app.companions?.main.app.store.db ?? db;
  } catch {
    /* no companions here (tests) */
  }
  return db;
}
export const clientsOf = (app: AppContext) => clientStoreOf(workDb(app), app.now);
export const timeOf = (app: AppContext) => timeStoreOf(workDb(app), app.now);

/** \"today\", \"yesterday\", \"friday\", \"2026-11-12\" → a local date. */
function dayOf(app: AppContext, v: unknown, fallback?: string): string {
  const s = String(v ?? '').trim();
  if (!s) {
    if (fallback) return fallback;
    throw new ToolError('Give the date (YYYY-MM-DD, today, yesterday).');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const now = app.now();
  if (/^yesterday$/i.test(s)) return localDayOf(new Date(now.getTime() - 86_400_000), tz(app));
  const d = parseWhen(s, now, tz(app), { dateOnlyHour: 12 });
  if (!d) throw new ToolError(`Couldn't understand the date “${s}”. Use YYYY-MM-DD, today or yesterday.`);
  return localDayOf(d, tz(app));
}
const hrs = (h: number) => `${h.toFixed(1)} h`;

// ---------------------------------------------------------------- shared lists

function shared(app: AppContext) {
  const sb = app.sharedBoards;
  if (!sb) throw new ToolError('Shared lists need household members (Settings → Household). There is nobody to share with here.');
  return sb;
}
/** A household name (or \"me\") → their person id. */
function personOf(app: AppContext, name: string): string {
  const sb = shared(app);
  const n = fold(name.trim());
  if (!n) throw new ToolError('Say who.');
  if (['me', 'myself', 'i', 'mine'].includes(n)) return sb.person;
  const all = sb.people();
  const hit = all.find((p) => fold(p.name) === n || p.id === name.trim()) ?? all.filter((p) => fold(p.name).split(/\s+/)[0] === n.split(/\s+/)[0]).at(0);
  if (!hit) throw new ToolError(`“${name}” isn't in this household. People here: ${all.map((p) => p.name).join(', ')}.`);
  return hit.id;
}
const nameOf = (app: AppContext, id: string) => (id === app.sharedBoards?.person ? 'you' : (app.sharedBoards?.people().find((p) => p.id === id)?.name ?? id));
const assigneeName = (app: AppContext, a: string | null) => (!a ? '' : a.startsWith('member:') ? nameOf(app, a.slice(7)) : a === 'me' ? 'its creator' : a);

function listsTool(getApp: () => AppContext): Tool {
  return {
    changes: false,
    spec: {
      name: 'household_lists',
      description: "The lists shared in this household (groceries, chores, a team's to-dos): each open item with who it's assigned to and when it's due, what is assigned to this person, and invitations waiting. Only lists shared with this person show; their own private to-dos are in todo/board_list.",
      parameters: obj({ list: { type: 'string', description: 'One list by name (default: all of them).' } }),
    },
    defaultPermission: 'auto',
    summarize: (a) => `shared lists${a.list ? `: ${String(a.list)}` : ''}`,
    async run(args) {
      const app = getApp();
      const sb = shared(app);
      const me = sb.person;
      const want = String(args.list ?? '').trim();
      const boards = want ? [sb.store.findBoard(me, want)].filter((b) => b !== undefined) : sb.store.boardsFor(me);
      const w = sb.store.sharedWith(me);
      const out: string[] = [];
      if (w.invites.length) out.push(`Invitations waiting: ${w.invites.map((i) => `“${i.name}” from ${nameOf(app, i.from)}`).join(', ')} (accept on the Board or on Today).`);
      if (!boards.length) out.push(want ? `No shared list called “${want}”.` : 'No shared lists yet. list_share makes one.');
      for (const b of boards) {
        const v = sb.store.view(me, b.id)!;
        const open = v.cards.filter((c) => c.status === 'open');
        const done = v.cards.filter((c) => c.status === 'done').slice(-5);
        out.push(`List “${b.name}” (shared with ${b.members.filter((m) => m.person !== me).map((m) => `${nameOf(app, m.person)}${m.status === 'invited' ? ' (invited)' : ''}`).join(', ') || 'nobody yet'}): ${open.length} open`);
        for (const c of open.slice(0, 50)) out.push(`  ${c.ref} ${c.title}${c.assignee ? ` → ${assigneeName(app, c.assignee)}` : ''}${c.dueAt ? `, due ${formatLocal(c.dueAt, tz(app))}` : ''}`);
        for (const c of done) out.push(`  ✓ ${c.title}${c.doneBy ? ` (done by ${nameOf(app, c.doneBy)})` : ''}`);
      }
      if (w.assigned.length) out.push(`Assigned to you: ${w.assigned.map((a) => `${a.title} (${a.board})`).join(', ')}.`);
      return out.join('\n');
    },
  };
}

function shareTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'list_share',
      description: "Share a list with people in this household (by name): makes the shared list when there is none by that name (with items, if given) and invites them; they see it in their own space after accepting. Only what is shared here crosses to them; nothing else of this person's does.",
      parameters: obj(
        {
          list: { type: 'string', description: 'The list name, like Groceries or Chores' },
          people: { type: 'array', items: { type: 'string' }, description: 'Household names to share with' },
          items: { type: 'array', items: { type: 'string' }, description: 'Optional: items to put on it' },
        },
        ['list', 'people'],
      ),
    },
    // Sharing shows a list to another person: they ask first.
    defaultPermission: 'ask',
    summarize: (a) => `Share the list “${String(a.list ?? '')}” with ${(Array.isArray(a.people) ? a.people : []).map(String).join(', ')}`,
    async run(args) {
      const app = getApp();
      const sb = shared(app);
      const me = sb.person;
      const name = String(args.list ?? '').trim();
      if (!name) throw new ToolError('Name the list.');
      const ids = [...new Set((Array.isArray(args.people) ? args.people : []).map((p) => personOf(app, String(p))).filter((p) => p !== me))];
      if (!ids.length) throw new ToolError('Say who to share it with (a person in this household other than you).');
      const known = sb.people().map((p) => p.id);
      let b = sb.store.findBoard(me, name);
      const made = !b;
      try {
        b = b ? sb.store.share(me, b.id, ids, known) : sb.store.create(me, name, ids, known);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      if (!b) throw new ToolError(`You can't share “${name}”.`);
      const items = (Array.isArray(args.items) ? args.items : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
      for (const it of items) sb.store.addCard(me, b.id, { title: it });
      const who = ids.map((p) => nameOf(app, p)).join(' and ');
      return `${made ? 'Made the shared list' : 'Shared the list'} “${b.name}” with ${who}${items.length ? `, with ${items.length} item${items.length === 1 ? '' : 's'}` : ''}. They see an invitation on Today and the Board; once they accept, it shows in their own space. Nothing else of yours is shared.`;
    },
  };
}

function assignTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'task_assign',
      description: 'On a shared list: give an item to someone (to = a household name, me, or nobody), with an optional due date; adds the item when it is not there yet. done=true ticks it off (it records who did it). The person it is given to gets a notification.',
      parameters: obj(
        {
          list: { type: 'string' },
          task: { type: 'string', description: 'The item: its title or its ref (s12)' },
          to: { type: 'string', description: 'A household name, me, or nobody' },
          due: { type: 'string', description: 'When, in local time: friday 5pm, 2026-11-20' },
          done: { type: 'boolean' },
        },
        ['list', 'task'],
      ),
    },
    defaultPermission: 'auto',
    summarize: (a) => (a.done ? `Tick off “${String(a.task ?? '')}”` : `Give “${String(a.task ?? '')}” to ${String(a.to ?? '?')}`),
    async run(args) {
      const app = getApp();
      const sb = shared(app);
      const me = sb.person;
      const b = sb.store.findBoard(me, String(args.list ?? ''));
      if (!b) throw new ToolError(`No shared list called “${String(args.list ?? '')}”. Lists: ${sb.store.boardsFor(me).map((x) => x.name).join(', ') || 'none (list_share makes one)'}.`);
      const q = String(args.task ?? '').trim();
      if (!q) throw new ToolError('Which item?');
      let card = sb.store.findCard(me, b.id, q);
      const added = !card;
      let dueAt: string | null | undefined;
      if (args.due !== undefined && String(args.due).trim()) {
        const d = parseWhen(String(args.due), app.now(), tz(app), { dateOnlyHour: 17 });
        if (!d) throw new ToolError(`Couldn't understand the time “${String(args.due)}”.`);
        dueAt = d.toISOString();
      }
      try {
        if (!card) card = sb.store.addCard(me, b.id, { title: q, ...(dueAt ? { dueAt } : {}) })!;
        else if (dueAt) card = sb.store.update(me, card.ref, { dueAt })!;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      const bits: string[] = [];
      if (args.to !== undefined && String(args.to).trim()) {
        const toRaw = String(args.to).trim();
        const target = /^(nobody|none|no one|unassign)$/i.test(toRaw) ? null : `member:${personOf(app, toRaw)}`;
        if (target && !b.members.some((m) => `member:${m.person}` === target && m.status === 'member')) throw new ToolError(`${toRaw} isn't on “${b.name}” yet${b.members.some((m) => `member:${m.person}` === target) ? ' (the invitation is still open)' : ''}. Share it first with list_share.`);
        try {
          if (app.cardWork) app.cardWork.assign(card.ref, target, 'me');
          else sb.store.source(me).setAssignee(Number(card.ref.slice(1)), target, 'me');
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
        bits.push(target ? `given to ${nameOf(app, target.slice(7))}${target.slice(7) !== me ? ' (they get a notification)' : ''}` : 'unassigned');
      }
      if (args.done === true) {
        sb.store.update(me, card.ref, { status: 'done' });
        bits.push('ticked off');
      }
      const now = sb.store.card(me, card.ref)!;
      return `${added ? 'Added' : 'Updated'} “${now.title}” on ${b.name}${bits.length ? `: ${bits.join(', ')}` : ''}${now.dueAt ? `, due ${formatLocal(now.dueAt, tz(app))}` : ''}.`;
    },
  };
}

// ---------------------------------------------------------------- clients

const STAGE_WORD: Record<Stage, string> = { lead: 'Lead', quoted: 'Quoted', won: 'Won', invoiced: 'Invoiced', paid: 'Paid', lost: 'Lost' };
function clientLine(c: Client): string {
  return `#${c.id} ${c.name}${c.email ? ` <${c.email}>` : ''} · ${STAGE_WORD[c.stage]}${c.valueCents ? ` · ${fmtMoney(c.valueCents, c.currency)}` : ''}${c.rateCents ? ` · ${fmtMoney(c.rateCents, c.currency)}/h` : ''}${c.nextStep ? ` · next: ${c.nextStep}${c.nextDate ? ` by ${usDate(c.nextDate)}` : ''}` : ''}`;
}
function findClient(app: AppContext, q: unknown): Client {
  const c = clientsOf(app).find(q);
  if (!c) throw new ToolError(`No client “${String(q ?? '')}”. client_add adds one; clients_pipeline lists them.`);
  return c;
}
function moneyArg(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const c = toCents(v);
  if (c === undefined || c < 0) throw new ToolError(`${what} must be an amount like 1500 or "85.00".`);
  return c;
}

function clientAddTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'client_add',
      description: "Add a client (or update one): a person or company this person works for, on their People cards too. Stage lead (default), quoted, won, invoiced, paid or lost; value (the deal, in their currency); rate (hourly, for time_invoice); next_step with next_date. Stages also move by themselves when invoice_make makes a quote or invoice and invoice_mark records accepted or paid.",
      parameters: obj({ name: { type: 'string' }, email: { type: 'string' }, stage: { type: 'string', enum: [...STAGES] }, value: { type: 'number' }, rate: { type: 'number', description: 'Hourly rate' }, next_step: { type: 'string' }, next_date: { type: 'string' } }, ['name']),
    },
    defaultPermission: 'auto',
    summarize: (a) => `client: ${String(a.name ?? '')}`,
    async run(args) {
      const app = getApp();
      const cs = clientsOf(app);
      const name = String(args.name ?? '').trim();
      const email = String(args.email ?? '').trim();
      const stage = args.stage === undefined || args.stage === '' ? undefined : String(args.stage);
      if (stage !== undefined && !isStage(stage)) throw new ToolError(`stage is one of ${STAGES.join(', ')}.`);
      const valueCents = moneyArg(args.value, 'value');
      const rateCents = moneyArg(args.rate, 'rate');
      const nextDate = args.next_date ? dayOf(app, args.next_date) : undefined;
      const currency = bizStore(app).details().currency;
      // The People card: an existing one by name, or a new active card marked as a client.
      let personId: number | null = null;
      const people = app.people;
      if (people && name) {
        const hit = people.list({ q: name, status: 'all', limit: 5 }).find((p) => [p.name, p.fullName ?? '', ...p.aliases].some((n) => fold(n) === fold(name)) && p.status === 'active');
        try {
          personId = hit ? hit.id : people.create({ name, relation: 'client', circle: 'work', status: 'active', origin: 'owner', notes: email ? `Email: ${email}` : '' }).id;
        } catch {
          personId = null;
        }
      }
      const cur = cs.find(name, email);
      try {
        if (cur) {
          cs.update(cur.id, { ...(email ? { email } : {}), ...(valueCents !== undefined ? { valueCents } : {}), ...(rateCents !== undefined ? { rateCents } : {}), ...(args.next_step !== undefined ? { nextStep: String(args.next_step) } : {}), ...(nextDate ? { nextDate } : {}), ...(personId && !cur.personId ? { personId } : {}) });
          if (stage) cs.setStage(cur.id, stage as Stage);
          return `Updated client ${clientLine(cs.get(cur.id)!)}.`;
        }
        const c = cs.add({ name, email, stage: (stage as Stage) ?? 'lead', currency, ...(valueCents !== undefined ? { valueCents } : {}), ...(rateCents !== undefined ? { rateCents } : {}), nextStep: String(args.next_step ?? ''), nextDate: nextDate ?? null, personId });
        return `Added client ${clientLine(c)}${personId ? ' (on their People card too)' : ''}.`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  };
}

function clientStageTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'client_stage',
      description: 'Move a client to a stage (lead, quoted, won, invoiced, paid, lost) and/or set their next step and date, value or hourly rate. Use it for what happened outside Sara (a call, a lost deal); quotes and invoices made with invoice_make move stages by themselves.',
      parameters: obj({ client: { type: 'string' }, stage: { type: 'string', enum: [...STAGES] }, next_step: { type: 'string' }, next_date: { type: 'string' }, value: { type: 'number' }, rate: { type: 'number' } }, ['client']),
    },
    defaultPermission: 'auto',
    summarize: (a) => `client ${String(a.client ?? '')}${a.stage ? ` → ${String(a.stage)}` : ''}`,
    async run(args) {
      const app = getApp();
      const cs = clientsOf(app);
      const c = findClient(app, args.client);
      if (args.stage !== undefined && args.stage !== '' && !isStage(args.stage)) throw new ToolError(`stage is one of ${STAGES.join(', ')}.`);
      const valueCents = moneyArg(args.value, 'value');
      const rateCents = moneyArg(args.rate, 'rate');
      cs.update(c.id, { ...(valueCents !== undefined ? { valueCents } : {}), ...(rateCents !== undefined ? { rateCents } : {}), ...(args.next_step !== undefined ? { nextStep: String(args.next_step) } : {}), ...(args.next_date ? { nextDate: dayOf(app, args.next_date) } : args.next_step === '' ? { nextDate: null } : {}) });
      const before = c.stage;
      if (isStage(args.stage)) cs.setStage(c.id, args.stage);
      const now = cs.get(c.id)!;
      return `${now.name}: ${before !== now.stage ? `${STAGE_WORD[before]} → ${STAGE_WORD[now.stage]}` : STAGE_WORD[now.stage]}. ${clientLine(now)}.`;
    },
  };
}

/** The pipeline in words (also the Today tile's numbers). */
export function pipelineText(app: AppContext): string {
  const cs = clientsOf(app);
  const today = localDayOf(app.now(), tz(app));
  const p = cs.pipeline(today);
  if (!p.total) return 'No clients yet. client_add adds one (or say "add Acme as a lead").';
  const all = cs.list();
  const lines = [`Clients: ${p.total}. Open value ${fmtMoney(p.openCents, p.currency)} (lead to invoiced); won ${fmtMoney(p.wonCents, p.currency)} (won, invoiced, paid).`];
  for (const s of p.stages) if (s.count) lines.push(`${STAGE_WORD[s.stage]}: ${s.count} · ${fmtMoney(s.valueCents, p.currency)} — ${all.filter((c) => c.stage === s.stage).map((c) => c.name).join(', ')}`);
  if (p.overdue.length) lines.push(`Next steps overdue: ${p.overdue.map((c) => `${c.name}: ${c.nextStep} (was due ${usDate(c.nextDate!)})`).join('; ')}`);
  if (p.due.length) lines.push(`Next steps today: ${p.due.map((c) => `${c.name}: ${c.nextStep}`).join('; ')}`);
  return lines.join('\n');
}

function pipelineTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'clients_pipeline',
      description: 'The client pipeline: how many clients are at each stage (lead, quoted, won, invoiced, paid, lost) and their value, every client with stage, rate and next step, and next steps that are overdue or due today. Numbers are worked out by code.',
      parameters: obj({ client: { type: 'string', description: 'One client, with their stage history' } }),
    },
    defaultPermission: 'auto',
    summarize: () => 'client pipeline',
    async run(args) {
      const app = getApp();
      if (args.client) {
        const c = findClient(app, args.client);
        const moves = clientsOf(app).moves(c.id);
        const unbilled = timeOf(app).unbilled((e) => e.clientId === c.id || foldName(e.client) === foldName(c.name));
        return `${clientLine(c)}\nHistory: ${moves.map((m) => `${usDate(localDayOf(new Date(m.at), tz(app)))} ${m.from ? `${STAGE_WORD[m.from]} → ` : ''}${STAGE_WORD[m.to]} (${m.why})`).join('; ')}${unbilled.length ? `\nUnbilled time: ${hrs(sumHours(unbilled.map((e) => e.hours!)))} in ${unbilled.length} entr${unbilled.length === 1 ? 'y' : 'ies'}.` : ''}`;
      }
      return `${pipelineText(app)}\n${clientsOf(app).list().map(clientLine).join('\n')}`;
    },
  };
}

/** follow_ups adds these: client next steps that are due (today or earlier). */
export function clientStepLines(app: AppContext): string[] {
  const today = localDayOf(app.now(), tz(app));
  const p = clientsOf(app).pipeline(today);
  return [...p.overdue, ...p.due].map((c) => `- client ${c.name} (${STAGE_WORD[c.stage]}): ${c.nextStep} (${c.nextDate! < today ? `was due ${usDate(c.nextDate!)}` : 'today'})`);
}

// ---------------------------------------------------------------- time

function clientFor(app: AppContext, q: unknown): { clientId: number | null; client: string } {
  const s = String(q ?? '').trim();
  if (!s) return { clientId: null, client: '' };
  const c = clientsOf(app).find(s);
  return c ? { clientId: c.id, client: c.name } : { clientId: null, client: s };
}
/** 2026-11-13T15:30:00Z → "9:30 AM" in the person's time zone. */
const clock = (iso: string, zone?: string) => {
  const p = zonedParts(new Date(iso), zone);
  return `${((p.h + 11) % 12) + 1}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
};
const entryLine = (e: TimeEntry, app: AppContext) => `#${e.id} ${usDate(e.day)} ${e.start && e.end ? `${clock(e.start, tz(app))}-${clock(e.end, tz(app))} ` : ''}${hrs(e.hours ?? 0)}${e.client ? ` · ${e.client}` : ''}${e.project ? ` · ${e.project}` : ''}${e.note ? ` · ${e.note}` : ''}${e.invoiceId ? ' · billed' : ''}`;

function timeStartTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'time_start',
      description: `Start a timer for work (optional client, project, note). One timer runs at a time: a running one is stopped first. After ${LONG_TIMER_HOURS} hours a reminder asks whether it is still running.`,
      parameters: obj({ client: { type: 'string' }, project: { type: 'string' }, note: { type: 'string' } }),
    },
    defaultPermission: 'auto',
    summarize: (a) => `start timer${a.client ? ` for ${String(a.client)}` : ''}`,
    async run(args, ctx) {
      const app = getApp();
      const ts = timeOf(app);
      const prev = ts.running();
      if (prev?.reminderId) app.planner?.cancelReminder(prev.reminderId);
      const { entry, stopped } = ts.start({ ...clientFor(app, args.client), project: String(args.project ?? ''), note: String(args.note ?? '') }, tz(app));
      const what = [entry.client, entry.project].filter(Boolean).join(' · ') || 'work';
      const rem = app.planner?.addReminder({ text: `Your timer for ${what} has been running ${LONG_TIMER_HOURS} hours. Still working? If not, say “stop my timer” and fix the hours with time_add.`, dueAt: new Date(Date.parse(entry.start!) + LONG_TIMER_HOURS * 3_600_000).toISOString(), conversationId: ctx.conversationId ?? null });
      if (rem) ts.setReminder(entry.id, rem.id);
      return `${stopped ? `Stopped the timer for ${[stopped.client, stopped.project].filter(Boolean).join(' · ') || 'work'} at ${hrs(stopped.hours ?? 0)}. ` : ''}Timer started for ${what} at ${formatLocal(entry.start!, tz(app))}.`;
    },
  };
}
function timeStopTool(getApp: () => AppContext): Tool {
  return {
    spec: { name: 'time_stop', description: 'Stop the running timer; the time is kept rounded to 0.1 hour.', parameters: obj({ note: { type: 'string' } }) },
    defaultPermission: 'auto',
    summarize: () => 'stop timer',
    async run() {
      const app = getApp();
      const ts = timeOf(app);
      const run = ts.running();
      if (!run) return 'No timer is running.';
      if (run.reminderId) app.planner?.cancelReminder(run.reminderId);
      const e = ts.stop()!;
      const today = ts.report(e.day, e.day).hours;
      return `Stopped: ${entryLine(e, app)}. Today so far: ${hrs(today)}.`;
    },
  };
}
function timeAddTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'time_add',
      description: 'Log time already worked: date (YYYY-MM-DD, today, yesterday) and either hours (2, 1.5) or start and end clock times (9:00, 11:30; an end before the start runs past midnight), with client, project and note. Timed entries may not overlap; hours are rounded to 0.1.',
      parameters: obj({ date: { type: 'string' }, hours: { type: 'number' }, start: { type: 'string' }, end: { type: 'string' }, client: { type: 'string' }, project: { type: 'string' }, note: { type: 'string' } }, ['date']),
    },
    defaultPermission: 'auto',
    summarize: (a) => `log ${a.hours ? `${String(a.hours)} h` : `${String(a.start ?? '')}-${String(a.end ?? '')}`}${a.client ? ` for ${String(a.client)}` : ''}`,
    async run(args) {
      const app = getApp();
      try {
        const e = timeOf(app).add({ day: dayOf(app, args.date), ...(args.start || args.end ? { start: String(args.start ?? ''), end: String(args.end ?? '') } : { hours: Number(args.hours) }), ...clientFor(app, args.client), project: String(args.project ?? ''), note: String(args.note ?? '') }, tz(app));
        return `Logged ${entryLine(e, app)}.`;
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError((err as Error).message);
      }
    },
  };
}

function fileOut(app: AppContext, ctx: ToolContext, format: DocFormat, title: string, content: string): string {
  const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
  try {
    const spec = cleanSpec({ format, title, template: 'plain', content });
    const data = renderDocument(spec, imagesOf(app));
    const made = keepMade(app, { spec, data, ...(conv ? { conversationId: conv.id } : {}), keep: !conv?.private });
    const sharedIn = shareMade(app, ctx, conv, made, data, MIME[spec.format]);
    return `“${made.name}” (${FORMAT_LABEL[spec.format]}, ${humanSize(data.length)}, document #${made.id}${made.libraryId ? `, Library #${made.libraryId}` : ''}${sharedIn ? ', in the chat with Download and Open' : ''})`;
  } catch (err) {
    if (err instanceof DocError) throw new ToolError(err.message);
    throw err;
  }
}

function timeReportTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'time_report',
      description: 'Hours worked between two dates (default: this week so far), totaled by client, project or day, with what is still unbilled; format xlsx (or docx/pdf) also makes a file with every entry.',
      parameters: obj({ from: { type: 'string' }, to: { type: 'string' }, by: { type: 'string', enum: ['client', 'project', 'day'] }, client: { type: 'string' }, format: { type: 'string', enum: ['none', 'xlsx', 'docx', 'pdf'] } }),
    },
    defaultPermission: 'auto',
    summarize: (a) => `hours ${String(a.from ?? 'this week')}${a.to ? ` to ${String(a.to)}` : ''}`,
    async run(args, ctx) {
      const app = getApp();
      const today = localDayOf(app.now(), tz(app));
      const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
      const monday = new Date(Date.parse(`${today}T12:00:00Z`) - ((wd + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
      const from = dayOf(app, args.from, monday);
      const to = dayOf(app, args.to, today);
      if (to < from) throw new ToolError('“to” is before “from”.');
      const by = args.by === 'project' || args.by === 'day' ? args.by : 'client';
      let r = timeOf(app).report(from, to, by);
      if (args.client) {
        const c = clientFor(app, args.client);
        const keep = r.entries.filter((e) => (c.clientId !== null && e.clientId === c.clientId) || foldName(e.client) === foldName(c.client));
        r = { ...r, entries: keep, hours: sumHours(keep.map((e) => e.hours!)) };
      }
      const run = timeOf(app).running();
      const head = `Hours ${usDate(from)} – ${usDate(to)}: ${hrs(r.hours)} in ${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'}.${run ? ` (A timer is running: ${hrs(timeOf(app).runningHours(run))} so far, not counted.)` : ''}`;
      const groups = args.client ? [] : r.groups.map((g) => `- ${g.key}: ${hrs(g.hours)}${g.unbilled && g.unbilled !== g.hours ? ` (${hrs(g.unbilled)} unbilled)` : g.unbilled ? ' (unbilled)' : ''}`);
      let file = '';
      const format = String(args.format ?? 'none');
      if (['xlsx', 'docx', 'pdf'].includes(format) && r.entries.length) {
        const rows = r.entries.map((e) => `| ${e.day} | ${e.client || ''} | ${e.project || ''} | ${(e.note || '').replace(/\|/g, '/')} | ${e.hours!.toFixed(1)} | ${e.invoiceId ? 'yes' : 'no'} |`);
        const content = `# Hours ${from} to ${to}\n\n| Date | Client | Project | Note | Hours | Billed |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n| Total | | | | ${r.hours.toFixed(1)} | |\n`;
        file = `\nFile: ${fileOut(app, ctx, format as DocFormat, `Hours ${from} to ${to}`, content)}.`;
      }
      return `${head}\n${groups.join('\n')}${args.client ? `\n${r.entries.map((e) => `- ${entryLine(e, app)}`).join('\n')}` : ''}${file}`;
    },
  };
}

function timeInvoiceTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'time_invoice',
      description: "\"Invoice my hours for <client>\": makes an invoice (invoice_make's engine and numbering) from that client's unbilled tracked time, one line per project (hours × the client's hourly rate), and marks those entries billed so they are never billed twice. rate sets (and saves) the client's hourly rate when none is set. through limits it to time up to a date.",
      parameters: obj({ client: { type: 'string' }, rate: { type: 'number' }, through: { type: 'string' }, format: { type: 'string', enum: ['pdf', 'docx', 'both'] }, template: { type: 'string' }, expenses: { type: 'array', items: { type: 'number' }, description: 'U4.29: expense ids (expense_report lists them) to bill at cost on the same invoice; each is billed once.' } }, ['client']),
    },
    defaultPermission: 'auto',
    summarize: (a) => `Invoice hours for ${String(a.client ?? '?')}`,
    async run(args, ctx) {
      const app = getApp();
      const cs = clientsOf(app);
      const ts = timeOf(app);
      const named = String(args.client ?? '').trim();
      let c = cs.find(named);
      const rate = moneyArg(args.rate, 'rate');
      if (!c) {
        const loose = ts.unbilled((e) => foldName(e.client) === foldName(named));
        if (!loose.length) throw new ToolError(`No client “${named}” and no unbilled time for that name.`);
        c = cs.add({ name: loose[0]!.client, stage: 'won', currency: bizStore(app).details().currency, ...(rate !== undefined ? { rateCents: rate } : {}) }, 'invoiced hours');
      }
      if (rate !== undefined && rate > 0 && rate !== c.rateCents) c = cs.update(c.id, { rateCents: rate })!;
      if (!c.rateCents) throw new ToolError(`${c.name} has no hourly rate yet. Ask for it, then call again with rate (it is saved on the client).`);
      const through = args.through ? dayOf(app, args.through) : '9999-12-31';
      const cid = c.id;
      const cname = foldName(c.name);
      const entries = ts.unbilled((e) => e.clientId === cid || (e.clientId === null && foldName(e.client) === cname), through);
      const run = ts.running();
      const runNote = run && (run.clientId === cid || foldName(run.client) === cname) ? ' A timer for this client is still running and is not on it; stop it and invoice again for that time.' : '';
      // U4.29: expenses billed at cost on the same invoice, each only once.
      const billed = billedExpenses(app);
      const exp = (Array.isArray(args.expenses) ? args.expenses : []).map((x) => {
        const e = bizStore(app).expense(Number(x));
        if (!e) throw new ToolError(`There is no expense #${String(x)}.`);
        const on = billed.get(e.id);
        if (on !== undefined) throw new ToolError(`Expense #${e.id} (${e.vendor}) is already billed on ${bizStore(app).invoice(on)?.number ?? `invoice #${on}`}.`);
        return e;
      });
      if (!entries.length && !exp.length) return `No unbilled time for ${c.name}.${runNote}`;
      // Hold them first, so two invoices made at once can never take the same hours.
      const ids = entries.map((e) => e.id);
      if (ts.reserve(ids) !== ids.length) {
        ts.settle(ids, null);
        throw new ToolError('Some of that time was just billed on another invoice. Try again.');
      }
      const groups = new Map<string, TimeEntry[]>();
      for (const e of entries) groups.set(e.project || 'Work', [...(groups.get(e.project || 'Work') ?? []), e]);
      const items = [...groups.entries()].map(([project, xs]) => {
        const days = xs.map((x) => x.day).sort();
        const span = days[0] === days.at(-1) ? usDate(days[0]!) : `${usDate(days[0]!)} – ${usDate(days.at(-1)!)}`;
        return { desc: `${project} (hours, ${span})`, qty: sumHours(xs.map((x) => x.hours!)), unit_price: (c!.rateCents / 100).toFixed(2) };
      });
      for (const e of exp) items.push({ desc: `Expense: ${e.vendor} (${usDate(e.date)})`, qty: 1, unit_price: (e.totalCents / 100).toFixed(2) });
      const notes = `Hours: ${entries.map((e) => `${usDate(e.day)} ${e.hours!.toFixed(1)} h${e.project ? ` ${e.project}` : ''}${e.note ? ` (${e.note})` : ''}`).join('; ')}`.slice(0, 1900);
      const make = createBizTools(getApp).find((t) => t.spec.name === 'invoice_make')!;
      const store = bizStore(app);
      const lastId = store.invoices()[0]?.id ?? 0;
      let out: string;
      try {
        out = String(await make.run({ kind: 'invoice', client: c.email ? `${c.name} <${c.email}>` : c.name, items, notes, ...(args.format ? { format: args.format } : {}), ...(args.template ? { template: args.template } : {}) }, ctx));
      } catch (err) {
        ts.settle(ids, null);
        throw err;
      }
      const inv = store.invoices().find((i) => i.id > lastId && i.kind === 'invoice');
      ts.settle(ids, inv ? inv.id : null);
      if (inv && exp.length) billExpenses(app, exp.map((e) => e.id), inv.id);
      const total = sumHours(entries.map((e) => e.hours!));
      return `${out}\nBilled ${hrs(total)} of tracked time (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}) at ${fmtMoney(c.rateCents, inv?.currency ?? c.currency)}/h on ${inv?.number ?? 'the invoice'}; those entries are marked billed and won't be billed again (voiding the invoice frees them).${runNote}`;
    },
  };
}

export function createWorkTools(getApp: () => AppContext): Tool[] {
  const tools = [listsTool(getApp), shareTool(getApp), assignTool(getApp), clientAddTool(getApp), clientStageTool(getApp), pipelineTool(getApp), timeStartTool(getApp), timeStopTool(getApp), timeAddTool(getApp), timeReportTool(getApp), timeInvoiceTool(getApp)];
  // Today's tiles follow every change (the reads change nothing).
  const READS = new Set(['household_lists', 'clients_pipeline', 'time_report']);
  for (const t of tools) {
    if (READS.has(t.spec.name)) continue;
    const run = t.run.bind(t);
    t.run = async (args, ctx) => {
      try {
        return await run(args, ctx);
      } finally {
        const app = getApp();
        todayChanged(app, 'worktime');
        todayChanged(app, 'shared');
      }
    };
  }
  return tools;
}

/** Today: the running timer and the pipeline (only once used). */
export function workTile(app: AppContext): { timer: { client: string; project: string; note: string; start: string; hours: number; long: boolean } | null; pipeline: { stages: { stage: Stage; count: number; valueCents: number }[]; openCents: number; overdue: number; due: number; currency: string } | null; week: number } | undefined {
  const ts = timeOf(app);
  const run = ts.running();
  const today = localDayOf(app.now(), tz(app));
  const p = clientsOf(app).pipeline(today);
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = new Date(Date.parse(`${today}T12:00:00Z`) - ((wd + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  const week = ts.report(monday, today).hours;
  if (!run && !p.total && !week) return undefined;
  const h = run ? ts.runningHours(run) : 0;
  return {
    timer: run ? { client: run.client, project: run.project, note: run.note, start: run.start!, hours: h, long: h >= LONG_TIMER_HOURS } : null,
    pipeline: p.total ? { stages: p.stages.filter((s) => s.count), openCents: p.openCents, overdue: p.overdue.length, due: p.due.length, currency: p.currency } : null,
    week,
  };
}
