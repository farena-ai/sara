// Phase 57: Sara as an MCP server, so Claude Code, Cursor, Claude Desktop and other MCP apps can
// use her memory, planner, library and notes. Streamable HTTP at /mcp (JSON-RPC over POST; a
// single JSON answer, or an SSE stream for tool calls), with the API key as a Bearer token.
// Clients/mcp/sara-mcp.ts bridges stdio apps to it.
//
// Both protocol eras are served ("dual-era"): the handshake revisions 2025-03-26, 2025-06-18 and
// 2025-11-25 (`initialize`, then requests; no sessions are minted, every request stands alone)
// and the stateless 2026-07-28 revision (every request carries its version in
// params._meta["io.modelcontextprotocol/protocolVersion"] and the MCP-Protocol-Version header;
// `server/discover`; results carry resultType).
//
// What she shares: read-only tools by default (memory notes, facts, recent conversation titles
// and summaries, today's agenda, to-dos, library passages, planner notes) and `ask_sara`.
// Never: secrets or the vault, partner chats (other people's), private conversations, imported
// history from other assistants' raw lines, or anything explicit while Adult mode is off. Write
// tools (to-dos, notes, remember_fact) appear only when the owner turns on "Let other apps
// change things", and follow her approval rules (an action that asks first waits in Sara).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OwnerAuth } from './auth.ts';
import type { AppContext } from './chat.ts';
import { localDate } from './memory-worker.ts';
import { formatLocal, parseWhen, type Priority } from './planner.ts';
import { appConversation, callerOf, corsAllowed, externalTurn, type KeyLimiter, otherAppsSettings, type Caller } from './other-apps.ts';
import { sharedWithApps } from './recall.ts';
import { detectExplicit } from './safety.ts';
import { adultModeOn } from './settings.ts';
import { buildToday } from './today.ts';

/** Revisions with the `initialize` handshake, newest first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** Stateless revisions (per-request metadata). */
export const MODERN_VERSIONS = ['2026-07-28'] as const;
export const SUPPORTED_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const MAX_BODY = 1024 * 1024;

export interface McpDeps {
  app: AppContext;
  auth: OwnerAuth;
  demo?: boolean;
  version: string;
  limiter: KeyLimiter;
  /**
   * Asks the owner in Sara before a change (an approval card in the app's MCP conversation).
   * `run` happens only after Allow; its words are posted there.
   */
  requestApproval?: (conversationId: string, name: string, summary: string, args: Record<string, unknown>, run: () => Promise<string>) => void;
}

type Json = Record<string, unknown>;
interface RpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Json;
}

class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly http: number;
  constructor(code: number, message: string, data?: unknown, http = 200) {
    super(message);
    this.code = code;
    this.data = data;
    this.http = http;
  }
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function writeJson(res: ServerResponse, status: number, body: unknown, version?: string): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...HEADERS, ...(version ? { 'mcp-protocol-version': version } : {}) });
  res.end(JSON.stringify(body));
}

const rpcError = (id: RpcRequest['id'], e: RpcError) => ({ jsonrpc: '2.0', ...(id !== undefined && id !== null ? { id } : {}), error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });

// ---------- what she shares ----------

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  write?: boolean;
  /** Write tools that overwrite or remove what's there (annotations.destructiveHint). */
  destructive?: boolean;
  /** Calling it again with the same arguments changes nothing more (annotations.idempotentHint). */
  idempotent?: boolean;
  run: (args: Json, cx: CallContext) => Promise<string>;
}

interface CallContext {
  deps: McpDeps;
  app: AppContext;
  caller: Caller;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown, def: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : def));

/** The conversations that are the owner's own (never other people's, never private, never imported). */
function shareableConversation(app: AppContext, id: string | null): boolean {
  // A memory from a deleted conversation (or none) is still hers. Same rule as other apps' turns (M3).
  return !id || sharedWithApps(app.store.getConversation(id));
}

/** With Adult mode off, nothing explicit leaves: such lines are left out. Secrets are always scrubbed. */
function clean(app: AppContext, text: string): string {
  const adult = adultModeOn(app.settings.get());
  const kept: string[] = [];
  let dropped = 0;
  for (const block of text.split(/\n(?=\S)|\n\n/)) {
    if (!adult && detectExplicit(block)) dropped++;
    else kept.push(block);
  }
  const out = app.redactor.redact(kept.join('\n'));
  return dropped ? `${out}${out ? '\n' : ''}(${dropped} item${dropped === 1 ? '' : 's'} left out: Adult mode is off.)` : out;
}

function memoryLines(app: AppContext, opts: { q?: string; kind?: 'fact'; limit: number }): string {
  if (!app.memory || app.settings.get().memory?.enabled === false) return 'Her memory is turned off.';
  // Phase 101 (ST6): people cards never reach other apps: no note linked to a person or naming one.
  const gate = app.people?.gate();
  const list = app.memory
    .list({ ...(opts.q ? { q: opts.q } : {}), ...(opts.kind ? { kind: opts.kind } : {}), limit: Math.min(200, opts.limit * 3) })
    .filter((m) => m.supersededBy === null && shareableConversation(app, m.conversationId) && (!gate || gate.memory(m)))
    .slice(0, opts.limit);
  if (!list.length) return opts.q ? `Nothing in her memory about “${opts.q}”.` : 'No notes yet.';
  return list.map((m) => `- [${m.kind}, ${m.happenedOn}] ${m.content.replace(/\s+/g, ' ')}`).join('\n');
}

/** Said by every write tool: changes need the owner's switch and follow her approval rules. */
const ASKS = (setting: string) =>
  `Only listed when the owner turns on "Let other apps change things" in Sara. Follows the owner's approval setting for her ${setting} tool (allowed, ask first, or off): when it asks first, it returns "Waiting for approval in Sara" and nothing changes until the owner presses Allow there; when it is off, it returns that it's turned off.`;
const ASKS_ALWAYS = (setting: string) =>
  `Only listed when the owner turns on "Let other apps change things" in Sara. Deleting always waits for the owner: it returns "Waiting for approval in Sara" and nothing changes until the owner presses Allow there (even when her ${setting} tool is set to allowed); when that tool is off, it returns that it's turned off.`;
const ID_HINT = (what: string, from: string) => `The ${what} id: the number after # in ${from}'s results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.`;
const PROJECT = { type: 'string', maxLength: 80, description: 'Planner project name to file it under, e.g. "Garden" or "Sara". Created if it doesn\'t exist. Up to 80 characters.', examples: ['Garden'] };

const TOOLS: ToolDef[] = [
  {
    name: 'search_memory',
    title: 'Search her memory',
    description:
      "Search Sara's long-term memory about the owner (facts, summaries of past conversations, decisions, promises, dates) by words and meaning. Use it for context about the owner's life, preferences and projects; use list_facts to browse all facts, search_library for documents, and list_recent_conversations for what was talked about lately. Returns plain text, one note per line: \"- [kind, YYYY-MM-DD] text\", best match first, or a line saying nothing was found. Read-only. Never includes other people's chats, private conversations or (while Adult mode is off) anything explicit.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for in her memory. Up to 200 characters.', examples: ['sister', 'deploy server', 'favourite food'] },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Most notes to return, 1 to 50 (default 10).', examples: [10] },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, { app }) {
      const q = str(args.query, 200);
      if (!q) throw new RpcError(-32602, 'Say what to look for (query).');
      return clean(app, memoryLines(app, { q, limit: num(args.limit, 10, 50) }));
    },
  },
  {
    name: 'list_facts',
    title: 'List facts about the owner',
    description:
      'List the facts Sara has learned about the owner (name, people, likes, habits, work), newest first. Use it to get a general picture of the owner; use search_memory to find something specific, and remember_fact to add a fact. Returns plain text, one fact per line: "- [fact, YYYY-MM-DD] text", or "No notes yet." Read-only; facts from other people\'s chats and private conversations are never included.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30, description: 'Most facts to return, 1 to 100 (default 30).', examples: [30] } },
      additionalProperties: false,
    },
    async run(args, { app }) {
      return clean(app, memoryLines(app, { kind: 'fact', limit: num(args.limit, 30, 100) }));
    },
  },
  {
    name: 'list_recent_conversations',
    title: 'List recent conversations',
    description:
      "List the owner's most recent conversations with Sara, newest first, each with its title, when it was last active and a short summary when she has one. Use it to see what the owner has been talking about lately; use search_memory to look for a topic across all of her memory. Returns plain text, one conversation per line: \"- Title (last <date and time>): summary\", or \"No conversations yet.\" Read-only. Never lists other people's chats, private, archived or imported conversations.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 30, default: 10, description: 'Most conversations to return, 1 to 30 (default 10).', examples: [10] } },
      additionalProperties: false,
    },
    async run(args, { app }) {
      const limit = num(args.limit, 10, 30);
      const tz = app.settings.get().timeZone;
      const convs = app.store.listConversations().filter((c) => shareableConversation(app, c.id) && !c.archivedAt).slice(0, limit);
      if (!convs.length) return 'No conversations yet.';
      // Phase 101: a summary naming someone on a people card stays out.
      const gate = app.people?.gate();
      const summaries = (app.memory?.list({ kind: 'summary', limit: 400 }) ?? []).filter((m) => !gate || gate.memory(m));
      return clean(
        app,
        convs
          .map((c) => {
            const sum = summaries.find((m) => m.conversationId === c.id)?.content.replace(/\s+/g, ' ').slice(0, 300);
            return `- ${!gate || gate.text(c.title) ? c.title : 'A conversation'} (${c.mode === 'coding' ? 'coding, ' : ''}last ${formatLocal(c.updatedAt, tz)})${sum ? `: ${sum}` : ''}`;
          })
          .join('\n'),
      );
    },
  },
  {
    name: 'get_today',
    title: "Get today's agenda",
    description:
      "Get the owner's agenda for today in one view: to-dos due today or overdue (and high-priority ones without a date), reminders in the next 24 hours, calendar events when a calendar is connected, and birthdays or other dates that matter coming up. Use it for \"what's on today\"; use list_tasks for the whole to-do list with filters. Returns plain text: the date, then sections \"To-dos:\" (\"- #id title (due …)\"), \"Reminders:\", \"Calendar:\" and \"Coming up:\". The #ids work with complete_task, update_task and delete_task. Read-only; takes no input.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, { app }) {
      const t = await buildToday(app);
      const tz = app.settings.get().timeZone;
      const lines = [`${t.date}`];
      lines.push(t.agenda.tasks.length ? `To-dos:\n${t.agenda.tasks.map((x) => `- #${x.id} ${x.title}${x.dueAt ? ` (due ${formatLocal(x.dueAt, tz)}${x.overdue ? ', overdue' : ''})` : ''}${x.project ? ` [${x.project}]` : ''}`).join('\n')}` : 'No to-dos due today.');
      if (t.agenda.reminders.length) lines.push(`Reminders:\n${t.agenda.reminders.map((r) => `- ${formatLocal(r.dueAt, tz)}: ${r.text}`).join('\n')}`);
      if (t.calendar?.events.length) lines.push(`Calendar:\n${t.calendar.events.map((e) => `- ${e.allDay ? 'all day' : formatLocal(e.start, tz)}: ${e.title}${e.location ? ` (${e.location})` : ''}`).join('\n')}`);
      // Phase 101 (ST6): dates about people on cards stay in her space.
      const gate = app.people?.gate();
      const dates = t.dates.filter((d) => d.personId === undefined && (!gate || gate.text(d.what)));
      if (dates.length) lines.push(`Coming up:\n${dates.map((d) => `- in ${d.inDays} day${d.inDays === 1 ? '' : 's'}: ${d.what}`).join('\n')}`);
      return clean(app, lines.join('\n\n'));
    },
  },
  {
    name: 'list_tasks',
    title: 'List to-dos',
    description:
      "List the to-dos in the owner's planner in Sara, optionally only open or done ones, or one project. Use it to see the whole to-do list or find a to-do's id; use get_today for just what's due today. Returns plain text, up to 100 lines, open ones first by priority and due date: \"- #id [ ] title (priority) due <date> [project]\" ([x] when done), or \"Nothing open.\" The #id is what complete_task, update_task and delete_task take. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], default: 'open', description: 'Which to-dos: "open" (default), "done", or "all".', examples: ['open'] },
        project: { type: 'string', maxLength: 80, description: 'Only to-dos in this planner project (name, any case). Leave out for all projects.', examples: ['Garden'] },
      },
      additionalProperties: false,
    },
    async run(args, { app }) {
      if (!app.planner) return 'The planner is not available.';
      const status = args.status === 'done' || args.status === 'all' ? args.status : 'open';
      const project = str(args.project, 80).toLowerCase();
      const tz = app.settings.get().timeZone;
      const list = app.planner.tasks({ status }).filter((t) => !project || (t.project ?? '').toLowerCase() === project).slice(0, 100);
      if (!list.length) return status === 'open' ? 'Nothing open.' : 'No to-dos.';
      return clean(app, list.map((t) => `- #${t.id} [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.priority !== 'normal' ? ` (${t.priority})` : ''}${t.dueAt ? ` due ${formatLocal(t.dueAt, tz)}` : ''}${t.project ? ` [${t.project}]` : ''}`).join('\n'));
    },
  },
  {
    name: 'search_library',
    title: 'Search her library',
    description:
      "Search the documents the owner keeps in Sara's library (PDFs, Word files, spreadsheets, books, saved web pages) by words and meaning. Use it for questions answered by the owner's documents; use search_memory for what Sara remembers from conversations. Returns up to 6 passages (each up to 1,400 characters), each headed by \"[document title, place]\" (page or section), or a line saying nothing was found. Read-only; documents shared in a single chat only are left out.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: 'What to look for, as words or a question. Up to 300 characters.', examples: ['when does the lease end', 'warranty period'] } },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, { app }) {
      const q = str(args.query, 300);
      if (!q) throw new RpcError(-32602, 'Say what to look for (query).');
      if (!app.library) return 'There is no library here.';
      const { embedTarget } = await import('./embeddings.ts');
      const hits = (await app.library.find(q, { target: embedTarget(app), limit: 8, timeoutMs: 4000 })).filter((h) => h.doc.keep && !h.doc.conversationId).slice(0, 6);
      if (!hits.length) return `Nothing about “${q}” in her library.`;
      return clean(app, hits.map((h) => `[${h.doc.title || h.doc.name}${h.passage.place ? `, ${h.passage.place}` : ''}]\n${h.passage.text.slice(0, 1400)}`).join('\n\n'));
    },
  },
  {
    name: 'list_notes',
    title: 'List notes',
    description:
      "List the notes in the owner's planner in Sara (titles only), newest first, or the ones matching some words. Use it to find a note's id; then read it with read_note, change it with update_note or remove it with delete_note. Returns plain text, up to 100 lines: \"- #id title [project] (updated YYYY-MM-DD)\", or \"No notes.\" Read-only.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200, description: 'Only notes containing these words (title or text). Leave out to list the newest notes.', examples: ['deploy', 'recipe'] } },
      additionalProperties: false,
    },
    async run(args, { app }) {
      if (!app.planner) return 'The planner is not available.';
      const list = app.planner.notes(str(args.query, 200) || undefined, 100);
      if (!list.length) return 'No notes.';
      return clean(app, list.map((n) => `- #${n.id} ${n.title}${n.project ? ` [${n.project}]` : ''} (updated ${n.updatedAt.slice(0, 10)})`).join('\n'));
    },
  },
  {
    name: 'read_note',
    title: 'Read a note',
    description:
      "Read one note from the owner's planner in Sara, in full, by its id. Use list_notes first to find the id. Returns the note as Markdown: \"# Title\", a blank line, then the text. An unknown id returns an error. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: ID_HINT('note', 'list_notes'), examples: [12] } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, { app }) {
      const n = app.planner?.note(Number(args.id));
      if (!n) throw new RpcError(-32602, 'No note with that id. Use list_notes.');
      return clean(app, `# ${n.title}\n\n${n.body}`);
    },
  },
  {
    name: 'ask_sara',
    title: 'Ask Sara',
    description:
      "Send Sara a message and get her reply, as in a chat: she answers with her memory and personality in a conversation kept for this app, which the owner can read in Sara. Use it for questions, opinions or anything conversational; to store a fact on purpose use remember_fact, and to change the planner use the to-do and note tools. Returns her reply as plain text (with the AI notice when a new session starts). If her own tools are allowed for other apps and one needs the owner's OK, it returns a note that it is waiting for approval in Sara. Can take up to a few minutes; one key can have two replies running at once.",
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', minLength: 1, maxLength: 20000, description: 'What to say to her, in plain words. Up to 20,000 characters.', examples: ['What did we decide about the garden fence?'] } },
      required: ['message'],
      additionalProperties: false,
    },
    async run(args, cx) {
      const { app, caller } = cx;
      const message = str(args.message, 20_000);
      if (!message) throw new RpcError(-32602, 'Say what to send her (message).');
      if (!app.settings.get().disclosureAcceptedAt) return `Open ${app.persona.name} in a browser once and accept the AI notice first.`;
      const convId = appConversation(app, 'mcp', caller, 'default');
      const s = otherAppsSettings(app.settings.get());
      // Hardening L6: the same cap on turns at once per key as /v1 (shared with it).
      if (!cx.deps.limiter.begin(caller.id)) return 'This key already has two replies running. Wait for one to finish.';
      let r;
      try {
        r = await externalTurn(app, convId, message, { noTools: !s.tools }, { stopOnApproval: true });
      } finally {
        cx.deps.limiter.end(caller.id);
      }
      if (r.busy) return `${app.persona.name} is still answering an earlier message here. Try again in a moment.`;
      const title = app.store.getConversation(convId)?.title ?? 'MCP';
      if (r.waiting) return [...r.notices, r.text.trim(), `(Waiting for approval in Sara: open the conversation “${title}” to allow or decline “${r.waiting}”. Her answer appears there.)`].filter(Boolean).join('\n\n');
      // UX 14: the AI notice stays with the error.
      if (r.error && !r.text.trim()) return [...r.notices, `She couldn't answer: ${r.error}`].join('\n\n');
      return [...r.notices, r.text].filter((x) => x.trim()).join('\n\n');
    },
  },
  {
    name: 'add_task',
    title: 'Add a to-do',
    description: `Add a new to-do to the owner's planner in Sara, with an optional due time, project and priority. Use update_task to change an existing one. Returns "Added to-do #id: title" (the #id works with complete_task, update_task and delete_task). A due time without an hour means 9:00 in the owner's time zone. ${ASKS('todo')}`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'What to do, short. Up to 200 characters.', examples: ['Call the vet'] },
        due: { type: 'string', maxLength: 80, description: 'When it is due, in words or as a date, read in the owner\'s time zone. Leave out for no due date.', examples: ['tomorrow 9am', 'friday', '2026-11-03'] },
        project: PROJECT,
        priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal', description: 'How important: "low", "normal" (default) or "high".', examples: ['high'] },
      },
      required: ['title'],
      additionalProperties: false,
    },
    write: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const title = str(args.title, 200);
      if (!title) throw new RpcError(-32602, 'Give the to-do a title.');
      const s = cx.app.settings.get();
      const due = str(args.due, 80);
      const at = due ? parseWhen(due, cx.app.now(), s.timeZone, { dateOnlyHour: 9 }) : null;
      if (due && !at) throw new RpcError(-32602, `Couldn't understand the time "${due}".`);
      const priority = (['low', 'normal', 'high'] as const).includes(args.priority as Priority) ? (args.priority as Priority) : 'normal';
      const project = str(args.project, 80) || null;
      return gated(cx, 'todo', 'add_task', `Add a to-do: ${title}${at ? ` (due ${formatLocal(at.toISOString(), s.timeZone)})` : ''}`, args, async () => {
        const t = planner.addTask({ title, project, priority, dueAt: at ? at.toISOString() : null });
        cx.app.events?.publish({ type: 'planner', what: 'tasks' });
        return `Added to-do #${t.id}: ${t.title}`;
      });
    },
  },
  {
    name: 'complete_task',
    title: 'Complete a to-do',
    description: `Mark one of the owner's to-dos in Sara as done, by its id (from list_tasks or get_today). Use update_task with status "open" to reopen one. Returns "Done: to-do #id title". Marking a to-do that is already done changes nothing. ${ASKS('todo')}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: ID_HINT('to-do', 'list_tasks or get_today'), examples: [12] } },
      required: ['id'],
      additionalProperties: false,
    },
    write: true,
    idempotent: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const t = knownTask(cx, args.id);
      if (t.status === 'done') return `To-do #${t.id} is already done: ${t.title}`;
      return gated(cx, 'todo', 'complete_task', `Mark to-do #${t.id} done: ${t.title}`, args, async () => {
        const done = planner.updateTask(t.id, { status: 'done' });
        if (!done) return `To-do #${t.id} is gone (deleted in the meantime).`;
        cx.app.events?.publish({ type: 'planner', what: 'tasks' });
        return `Done: to-do #${done.id} ${done.title}`;
      });
    },
  },
  {
    name: 'update_task',
    title: 'Change a to-do',
    description: `Change one of the owner's to-dos in Sara by its id (from list_tasks or get_today): its title, due time, project, priority, details or status. Only the fields you give change; the rest stay as they are. Use complete_task to simply tick one off. Returns "Changed to-do #id: title" with the new due time. ${ASKS('todo')}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: ID_HINT('to-do', 'list_tasks or get_today'), examples: [12] },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'New title. Up to 200 characters.', examples: ['Call the vet about Biscuit'] },
        due: { type: 'string', maxLength: 80, description: 'New due time in words or as a date, read in the owner\'s time zone; "none" removes the due date.', examples: ['next monday 10am', '2026-11-03', 'none'] },
        project: { type: 'string', maxLength: 80, description: 'Move it to this planner project (created if new); an empty string takes it out of any project.', examples: ['Garden', ''] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'New priority: "low", "normal" or "high".', examples: ['high'] },
        notes: { type: 'string', maxLength: 2000, description: 'New details for the to-do (replaces the old ones). Up to 2,000 characters.', examples: ['Ask about the booster shot.'] },
        status: { type: 'string', enum: ['open', 'done'], description: '"done" ticks it off; "open" reopens a done to-do.', examples: ['open'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
    write: true,
    destructive: true,
    idempotent: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const t = knownTask(cx, args.id);
      const s = cx.app.settings.get();
      const patch: Parameters<NonNullable<AppContext['planner']>['updateTask']>[1] = {};
      const changes: string[] = [];
      if (args.title !== undefined) {
        const title = str(args.title, 200);
        if (!title) throw new RpcError(-32602, 'The new title is empty.');
        patch.title = title;
        changes.push(`title “${title}”`);
      }
      if (args.due !== undefined) {
        const due = str(args.due, 80);
        if (!due || /^(none|no date|no due date|clear|never)$/i.test(due)) {
          patch.dueAt = null;
          changes.push('no due date');
        } else {
          const at = parseWhen(due, cx.app.now(), s.timeZone, { dateOnlyHour: 9 });
          if (!at) throw new RpcError(-32602, `Couldn't understand the time "${due}".`);
          patch.dueAt = at.toISOString();
          changes.push(`due ${formatLocal(patch.dueAt, s.timeZone)}`);
        }
      }
      if (args.project !== undefined) {
        patch.project = str(args.project, 80) || null;
        changes.push(patch.project ? `project ${patch.project}` : 'no project');
      }
      if (args.priority !== undefined) {
        if (!(['low', 'normal', 'high'] as const).includes(args.priority as Priority)) throw new RpcError(-32602, 'priority is low, normal or high.');
        patch.priority = args.priority as Priority;
        changes.push(`${patch.priority} priority`);
      }
      if (args.notes !== undefined) {
        patch.notes = str(args.notes, 2000);
        changes.push('new details');
      }
      if (args.status !== undefined) {
        if (args.status !== 'open' && args.status !== 'done') throw new RpcError(-32602, 'status is open or done.');
        patch.status = args.status;
        changes.push(args.status === 'done' ? 'done' : 'reopened');
      }
      if (!changes.length) throw new RpcError(-32602, 'Say what to change (title, due, project, priority, notes or status).');
      return gated(cx, 'todo', 'update_task', `Change to-do #${t.id} (${t.title}): ${changes.join(', ')}`, args, async () => {
        const u = planner.updateTask(t.id, patch);
        if (!u) return `To-do #${t.id} is gone (deleted in the meantime).`;
        cx.app.events?.publish({ type: 'planner', what: 'tasks' });
        return `Changed to-do #${u.id}: ${u.title}${u.dueAt ? ` (due ${formatLocal(u.dueAt, s.timeZone)})` : ''}${u.status === 'done' ? ' (done)' : ''}`;
      });
    },
  },
  {
    name: 'delete_task',
    title: 'Delete a to-do',
    description: `Delete one of the owner's to-dos from Sara's planner for good, by its id (from list_tasks or get_today). This can't be undone; to tick a to-do off instead, use complete_task. Returns "Deleted to-do #id: title". ${ASKS_ALWAYS('todo')}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: ID_HINT('to-do', 'list_tasks or get_today'), examples: [12] } },
      required: ['id'],
      additionalProperties: false,
    },
    write: true,
    destructive: true,
    idempotent: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const t = knownTask(cx, args.id);
      return gated(cx, 'todo', 'delete_task', `Delete to-do #${t.id}: ${t.title}`, args, { alwaysAsk: true }, async () => {
        if (!planner.deleteTask(t.id)) return `To-do #${t.id} was already deleted.`;
        cx.app.events?.publish({ type: 'planner', what: 'tasks' });
        return `Deleted to-do #${t.id}: ${t.title}`;
      });
    },
  },
  {
    name: 'add_note',
    title: 'Add a note',
    description: `Save a new note (a title and free text, Markdown welcome) in the owner's planner in Sara, optionally in a project. Use update_note to change an existing note and remember_fact for a single fact about the owner. Returns "Saved note #id: title" (the #id works with read_note, update_note and delete_note). ${ASKS('note')}`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'The note\'s title. Up to 200 characters.', examples: ['Deploy steps'] },
        body: { type: 'string', maxLength: 20000, description: 'The note\'s text (Markdown is fine). Up to 20,000 characters.', examples: ['ssh in, git pull, restart the service'] },
        project: PROJECT,
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    write: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const title = str(args.title, 200);
      const body = str(args.body, 20_000);
      if (!title) throw new RpcError(-32602, 'Give the note a title.');
      return gated(cx, 'note', 'add_note', `Save a note: ${title}`, args, async () => {
        const n = planner.saveNote({ title, body, project: str(args.project, 80) || null });
        cx.app.events?.publish({ type: 'planner', what: 'notes' });
        return `Saved note #${n.id}: ${n.title}`;
      });
    },
  },
  {
    name: 'update_note',
    title: 'Change a note',
    description: `Change one of the owner's notes in Sara by its id (from list_notes): its title, its text (replaced as a whole) or its project. Only the fields you give change. Read the note with read_note first if you mean to edit part of the text. Returns "Changed note #id: title". ${ASKS('note')}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: ID_HINT('note', 'list_notes'), examples: [12] },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'New title. Up to 200 characters.', examples: ['Deploy steps (server 2)'] },
        body: { type: 'string', maxLength: 20000, description: 'New text for the whole note; it replaces the old text. Up to 20,000 characters.', examples: ['ssh in, git pull, npm ci, restart the service'] },
        project: { type: 'string', maxLength: 80, description: 'Move it to this planner project (created if new); an empty string takes it out of any project.', examples: ['Sara', ''] },
      },
      required: ['id'],
      additionalProperties: false,
    },
    write: true,
    destructive: true,
    idempotent: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const n = knownNote(cx, args.id);
      const changes: string[] = [];
      let title: string | undefined;
      if (args.title !== undefined) {
        title = str(args.title, 200);
        if (!title) throw new RpcError(-32602, 'The new title is empty.');
        changes.push(`title “${title}”`);
      }
      const body = args.body !== undefined ? str(args.body, 20_000) : undefined;
      if (body !== undefined) changes.push('new text');
      const project = args.project !== undefined ? str(args.project, 80) || null : undefined;
      if (project !== undefined) changes.push(project ? `project ${project}` : 'no project');
      if (!changes.length) throw new RpcError(-32602, 'Say what to change (title, body or project).');
      return gated(cx, 'note', 'update_note', `Change note #${n.id} (${n.title}): ${changes.join(', ')}`, args, async () => {
        const cur = planner.note(n.id);
        if (!cur) return `Note #${n.id} is gone (deleted in the meantime).`;
        const u = planner.saveNote({ id: n.id, title: title ?? cur.title, body: body ?? cur.body, ...(project !== undefined ? { project } : {}) });
        cx.app.events?.publish({ type: 'planner', what: 'notes' });
        return `Changed note #${u.id}: ${u.title}`;
      });
    },
  },
  {
    name: 'delete_note',
    title: 'Delete a note',
    description: `Delete one of the owner's notes from Sara's planner for good, by its id (from list_notes). This can't be undone. Returns "Deleted note #id: title". ${ASKS_ALWAYS('note')}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: ID_HINT('note', 'list_notes'), examples: [12] } },
      required: ['id'],
      additionalProperties: false,
    },
    write: true,
    destructive: true,
    idempotent: true,
    async run(args, cx) {
      const planner = cx.app.planner;
      if (!planner) return 'The planner is not available.';
      const n = knownNote(cx, args.id);
      return gated(cx, 'note', 'delete_note', `Delete note #${n.id}: ${n.title}`, args, { alwaysAsk: true }, async () => {
        if (!planner.deleteNote(n.id)) return `Note #${n.id} was already deleted.`;
        cx.app.events?.publish({ type: 'planner', what: 'notes' });
        return `Deleted note #${n.id}: ${n.title}`;
      });
    },
  },
  {
    name: 'remember_fact',
    title: 'Remember a fact',
    description:
      'Ask Sara to remember one fact about the owner in her long-term memory, marked as told by this app. Use it to store something on purpose (ask_sara is for conversation, and she may or may not keep what is said there); use add_note for longer text. Returns "Remembered (#id): fact" once the owner allows it. Only listed when the owner turns on "Let other apps change things" in Sara, and it always asks first: it returns "Waiting for approval in Sara" and nothing is stored until the owner presses Allow there.',
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', minLength: 1, maxLength: 400, description: 'One short fact about the owner, as a sentence. Up to 400 characters.', examples: ['Prefers tabs over spaces', 'Works from home on Fridays'] } },
      required: ['fact'],
      additionalProperties: false,
    },
    write: true,
    async run(args, cx) {
      const fact = str(args.fact, 400);
      if (!fact) throw new RpcError(-32602, 'Say the fact.');
      const memory = cx.app.memory;
      if (!memory) return 'Her memory is not available.';
      // Facts are hers to keep: always asked first (there is no "allowed" setting for this one).
      return gated(cx, null, 'remember_fact', `Remember: ${fact}`, args, async () => {
        const s = cx.app.settings.get();
        const m = memory.add({ kind: 'fact', content: fact, conversationId: null, sourceMessageId: null, happenedOn: localDate(cx.app.now().toISOString(), s.timeZone), evidence: `told by ${cx.caller.label}` });
        return `Remembered (#${m.id}): ${fact}`;
      });
    },
  },
];

/** A to-do the tool may act on, or a clear error (nothing is asked or changed). */
function knownTask(cx: CallContext, id: unknown) {
  const n = Number(id);
  const t = Number.isInteger(n) && n > 0 ? cx.app.planner?.task(n) : undefined;
  if (!t) throw new RpcError(-32602, `No to-do with id ${String(id).slice(0, 20)}. Use list_tasks to see the ids.`);
  return t;
}

/** A note the tool may act on, or a clear error. */
function knownNote(cx: CallContext, id: unknown) {
  const n = Number(id);
  const note = Number.isInteger(n) && n > 0 ? cx.app.planner?.note(n) : undefined;
  if (!note) throw new RpcError(-32602, `No note with id ${String(id).slice(0, 20)}. Use list_notes to see the ids.`);
  return note;
}

/** Old names still accepted by tools/call (not listed). */
const ALIASES: Record<string, string> = { recent_conversations: 'list_recent_conversations' };
const PLANNER_TOOLS = new Set(['list_notes', 'read_note', 'list_tasks', 'add_task', 'complete_task', 'update_task', 'delete_task', 'add_note', 'update_note', 'delete_note']);

/** Every tool as tools/list shows it (write tools included). Used to keep the stdio bridge's --describe list identical. */
export function describeTools(): Json[] {
  return TOOLS.map((t) => toolListing(t));
}

function toolListing(t: ToolDef): Json {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: readOnly(t), destructiveHint: Boolean(t.write && t.destructive), idempotentHint: readOnly(t) || Boolean(t.write && t.idempotent), openWorldHint: false } };
}

function readOnly(t: ToolDef): boolean {
  return !t.write && t.name !== 'ask_sara';
}

/** Write tools follow her approval rules: the matching tool's setting (auto / ask / never); `null` = always ask. */
async function gated(cx: CallContext, tool: string | null, name: string, summary: string, args: Json, ...rest: [() => Promise<string>] | [{ alwaysAsk: boolean }, () => Promise<string>]): Promise<string> {
  const run = rest.length === 1 ? rest[0] : rest[1];
  // Deleting from another app always waits for the owner, even when the tool is "allowed".
  const alwaysAsk = rest.length === 2 && rest[0].alwaysAsk;
  const set = tool ? cx.app.tools.permission(tool, cx.app.settings.get().toolPermissions) : 'ask';
  const perm = alwaysAsk && set === 'auto' ? 'ask' : set;
  if (perm === 'never') return `The owner has turned off ${tool === 'todo' ? 'to-dos' : 'notes'} for ${cx.app.persona.name} (Settings → Abilities → Tools and approvals).`;
  if (perm === 'auto') return run();
  if (!cx.deps.requestApproval) return 'This needs the owner’s OK, and approvals aren’t available here.';
  // Changes wait in their own conversation, so ask_sara isn't blocked while the owner decides.
  const convId = appConversation(cx.app, 'mcp', cx.caller, 'changes');
  try {
    cx.deps.requestApproval(convId, name, `${cx.caller.label}: ${summary}`, args, run);
  } catch (err) {
    return (err as Error).message;
  }
  const title = cx.app.store.getConversation(convId)?.title ?? 'MCP';
  return `Waiting for approval in Sara: the owner can allow or decline it in the conversation “${title}”. Nothing is changed until then.`;
}

function toolsFor(app: AppContext): ToolDef[] {
  const s = otherAppsSettings(app.settings.get());
  return TOOLS.filter((t) => !t.write || s.changes).filter((t) => !PLANNER_TOOLS.has(t.name) || Boolean(app.planner)).filter((t) => t.name !== 'search_library' || Boolean(app.library));
}

const RESOURCES = [
  { uri: 'sara://today', name: 'today', title: 'Today', description: "Today's agenda", mimeType: 'text/plain', tool: 'get_today' },
  { uri: 'sara://tasks', name: 'tasks', title: 'To-dos', description: 'Open to-dos', mimeType: 'text/plain', tool: 'list_tasks' },
  { uri: 'sara://facts', name: 'facts', title: 'What she knows about the owner', description: 'Facts from her memory', mimeType: 'text/plain', tool: 'list_facts' },
  { uri: 'sara://conversations', name: 'conversations', title: 'Recent conversations', description: 'Titles and summaries', mimeType: 'text/plain', tool: 'list_recent_conversations' },
] as const;

function instructions(app: AppContext): string {
  return `${app.persona.name} is the owner's AI companion. These tools read her memory about the owner, the planner (to-dos, notes, today), her library, and let you ask her directly (ask_sara). Treat what they return as the owner's private context: use it to help, don't repeat it elsewhere.`;
}

// ---------- the protocol ----------

async function dispatch(msg: RpcRequest, version: string, modern: boolean, cx: CallContext, onProgress?: () => void): Promise<Json> {
  const method = String(msg.method ?? '');
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;
  const done = (r: Json): Json => (modern ? { resultType: 'complete', ...r } : r);
  const app = cx.app;
  const serverInfo = { name: 'sara', title: app.persona.name, version: cx.deps.version };
  const capabilities = { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } };
  switch (method) {
    case 'initialize': {
      const want = String(params.protocolVersion ?? '');
      const pv = (LEGACY_VERSIONS as readonly string[]).includes(want) ? want : LEGACY_VERSIONS[0];
      return { protocolVersion: pv, capabilities, serverInfo, instructions: instructions(app) };
    }
    case 'server/discover':
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, instructions: instructions(app) });
    case 'ping':
      return done({});
    case 'tools/list':
      return done({ tools: toolsFor(app).map((t) => toolListing(t)) });
    case 'tools/call': {
      const asked = String(params.name ?? '');
      const name = ALIASES[asked] ?? asked;
      const tool = toolsFor(app).find((t) => t.name === name);
      if (!tool) {
        const hidden = TOOLS.find((t) => t.name === name);
        if (hidden?.write) return done({ content: [{ type: 'text', text: `${name} is off: the owner can turn on “Let other apps change things” in Sara (Settings → Connections → Other apps).` }], isError: true });
        throw new RpcError(-32602, `Unknown tool: ${name.slice(0, 60)}`);
      }
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Json;
      onProgress?.();
      try {
        const text = await tool.run(args, cx);
        return done({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        if (err instanceof RpcError && err.code !== -32602) throw err;
        return done({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    case 'resources/list':
      return done({ resources: RESOURCES.filter((r) => toolsFor(app).some((t) => t.name === r.tool)).map(({ tool: _t, ...r }) => r) });
    case 'resources/templates/list':
      return done({ resourceTemplates: [] });
    case 'resources/read': {
      const uri = String(params.uri ?? '');
      const r = RESOURCES.find((x) => x.uri === uri);
      const tool = r && toolsFor(app).find((t) => t.name === r.tool);
      if (!r || !tool) throw new RpcError(-32602, `Unknown resource: ${uri.slice(0, 80)}`, { uri });
      return done({ contents: [{ uri, mimeType: 'text/plain', text: await tool.run({}, cx) }] });
    }
    case 'prompts/list':
      return done({ prompts: [] });
    default:
      throw new RpcError(-32601, `Method not found: ${method.slice(0, 60)}`, undefined, modern ? 404 : 200);
  }
}

/** Handles /mcp: POST JSON-RPC (one message per request); GET/DELETE are not offered (405). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, deps: McpDeps): Promise<void> {
  const method = req.method ?? 'GET';
  if (deps.demo) return writeJson(res, 404, { jsonrpc: '2.0', error: { code: -32600, message: 'MCP is off on the demo server.' } });
  const s = otherAppsSettings(deps.app.settings.get());
  // DNS rebinding / other web pages: an Origin must be this site or one the owner allowed.
  if (!corsAllowed(req, res, s)) return writeJson(res, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'This web address may not use Sara’s MCP server. Allow it in Settings → Connections → Other apps.' } });
  if (method === 'OPTIONS') {
    res.writeHead(204, HEADERS);
    return void res.end();
  }
  if (method !== 'POST') {
    res.writeHead(405, { allow: 'POST', ...HEADERS });
    return void res.end();
  }
  const caller = callerOf(req, deps.auth);
  if (!caller) {
    res.setHeader('www-authenticate', 'Bearer realm="sara"');
    return writeJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Missing or wrong API key. Make one in Sara: Settings → Connections → Other apps → Create an API key.' } });
  }
  const wait = deps.limiter.take(`mcp:${caller.id}`);
  if (wait) {
    res.setHeader('retry-after', String(wait));
    return writeJson(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: `Too many requests. Try again in ${wait} seconds.` } });
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return writeJson(res, 415, { jsonrpc: '2.0', error: { code: -32700, message: 'Send JSON (Content-Type: application/json).' } });
  // Hardening L6: decode once at the end, so a character split across chunks stays whole.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) return writeJson(res, 413, { jsonrpc: '2.0', error: { code: -32600, message: 'Request too large.' } });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let msg: RpcRequest;
  try {
    msg = JSON.parse(raw) as RpcRequest;
  } catch {
    return writeJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Responses from the client (no method) aren't expected: this server never asks the client anything.
    return writeJson(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request: send one JSON-RPC request or notification.' } });
  }
  const id = msg.id;
  const isNotification = id === undefined;

  // Which revision: per-request metadata (2026-07-28) or the handshake era.
  const header = String(req.headers['mcp-protocol-version'] ?? '').trim();
  const meta = (msg.params && typeof msg.params === 'object' ? (msg.params as Json)._meta : undefined) as Json | undefined;
  const metaVersion = meta && typeof meta[META_VERSION] === 'string' ? String(meta[META_VERSION]) : '';
  let version: string;
  let modern = false;
  if (metaVersion) {
    if (header && header !== metaVersion) return writeJson(res, 400, rpcError(id, new RpcError(-32020, 'MCP-Protocol-Version header does not match the request’s protocol version.', { header, body: metaVersion })));
    if (!(MODERN_VERSIONS as readonly string[]).includes(metaVersion)) return writeJson(res, 400, rpcError(id, new RpcError(-32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: metaVersion })));
    const mh = req.headers['mcp-method'];
    if (typeof mh === 'string' && mh !== msg.method) return writeJson(res, 400, rpcError(id, new RpcError(-32020, 'Mcp-Method header does not match the request.', { header: mh, body: msg.method })));
    version = metaVersion;
    modern = true;
  } else if (msg.method === 'initialize') {
    version = LEGACY_VERSIONS.includes(String((msg.params as Json | undefined)?.protocolVersion) as (typeof LEGACY_VERSIONS)[number]) ? String((msg.params as Json).protocolVersion) : LEGACY_VERSIONS[0];
  } else if (header) {
    if ((MODERN_VERSIONS as readonly string[]).includes(header)) return writeJson(res, 400, rpcError(id, new RpcError(-32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: header, reason: 'missing _meta protocol version' })));
    if (!(LEGACY_VERSIONS as readonly string[]).includes(header)) return writeJson(res, 400, rpcError(id, new RpcError(-32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: header })));
    version = header;
  } else {
    version = '2025-03-26'; // clients from before the header existed
  }

  if (isNotification) {
    res.writeHead(202, { ...HEADERS, 'mcp-protocol-version': version });
    return void res.end();
  }
  const cx: CallContext = { deps, app: deps.app, caller };
  const accept = String(req.headers.accept ?? '');
  const sse = msg.method === 'tools/call' && /text\/event-stream/.test(accept);
  if (!sse) {
    try {
      const result = await dispatch(msg, version, modern, cx);
      return writeJson(res, 200, { jsonrpc: '2.0', id, result }, version);
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(-32603, 'Internal error');
      if (!(err instanceof RpcError)) console.error('mcp:', err);
      return writeJson(res, e.http, rpcError(id, e), version);
    }
  }
  // Tool calls answer on an SSE stream scoped to this request (keep-alive comments while she works).
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', connection: 'keep-alive', 'mcp-protocol-version': version, ...HEADERS });
  const write = (s: string) => {
    if (!res.destroyed && !res.writableEnded) res.write(s);
  };
  const heartbeat = setInterval(() => write(':\n\n'), 15_000);
  try {
    const result = await dispatch(msg, version, modern, cx);
    write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
  } catch (err) {
    const e = err instanceof RpcError ? err : new RpcError(-32603, 'Internal error');
    if (!(err instanceof RpcError)) console.error('mcp:', err);
    write(`event: message\ndata: ${JSON.stringify(rpcError(id, e))}\n\n`);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
