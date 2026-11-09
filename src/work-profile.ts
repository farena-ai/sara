// EC26 (docs/ops/EC26_DESIGN.md): Her at work. One companion, two spaces: the chats the owner
// ticked as work (Slack and Teams by default) get her work profile (her work name and tone, work
// tools only, no companion features) and their own memory space; nothing crosses between work and
// personal unless the owner copies a note. The policy pin `workMode: true` makes every chat work.
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { HttpError } from './http.ts';
import type { Memory } from './memory.ts';
import { policy } from './policy-profile.ts';
import type { Conversation } from './store.ts';
import type { Tool } from './tools/types.ts';
import { WORKSPACE_NAME_RE } from './tools/workspace.ts';

export type WorkTone = 'professional' | 'formal' | 'brief';
export type Space = 'work' | 'personal';
export interface WorkTools {
  research: boolean;
  files: boolean;
  calendar: boolean;
  commands: boolean;
}
export interface WorkProfile {
  on: boolean;
  /** Her name at work ('' = her own name). */
  name: string;
  tone: WorkTone;
  /** Conversation channels that count as work. */
  channels: string[];
  tools: WorkTools;
  /** The workspace her file tools use at work. */
  workspace: string;
}

/** The chats that can be work (her app chats only through the pin). */
export const WORK_CHANNELS = ['plugin-slack', 'plugin-teams', 'plugin-matrix', 'plugin-email', 'discord-work', 'telegram-work'] as const;
export const WORK_TONES: readonly WorkTone[] = ['professional', 'formal', 'brief'];
export const WORK_DEFAULTS: WorkProfile = Object.freeze({
  on: false,
  name: '',
  tone: 'professional',
  channels: ['plugin-slack', 'plugin-teams'],
  tools: Object.freeze({ research: true, files: true, calendar: true, commands: false }),
  workspace: 'work',
}) as WorkProfile;

/** Tools she may use at work, by kind (everything else stays out of work chats). */
const ALWAYS = new Set(['recall', 'find_tools']);
const KIND_TOOLS: Record<keyof WorkTools, ReadonlySet<string>> = {
  research: new Set(['web_search', 'web_fetch', 'browser_open', 'browser_read', 'browser_screenshot']),
  files: new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'search']),
  calendar: new Set(['calendar', 'calendar_events', 'calendar_add']),
  commands: new Set(['shell', 'git', 'git_branch', 'git_commit', 'git_push', 'start_job', 'run_code', 'preview_start', 'browser_click', 'browser_type', 'browser_check', 'github_list', 'github_read', 'github_comment', 'github_create_issue', 'github_open_pr']),
};

const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function norm(raw: Record<string, unknown>, base: WorkProfile): WorkProfile {
  const tools = rec(raw.tools);
  const bt = base.tools;
  const ws = raw.workspace === undefined ? base.workspace : clean(raw.workspace, 64);
  return {
    on: raw.on === undefined ? base.on : raw.on === true,
    name: raw.name === undefined ? base.name : clean(raw.name, 40),
    tone: raw.tone === undefined ? base.tone : WORK_TONES.includes(raw.tone as WorkTone) ? (raw.tone as WorkTone) : base.tone,
    channels: Array.isArray(raw.channels) ? [...new Set(raw.channels.map(String).filter((c) => (WORK_CHANNELS as readonly string[]).includes(c)))] : base.channels,
    tools: {
      research: tools.research === undefined ? bt.research : tools.research === true,
      files: tools.files === undefined ? bt.files : tools.files === true,
      calendar: tools.calendar === undefined ? bt.calendar : tools.calendar === true,
      commands: tools.commands === undefined ? bt.commands : tools.commands === true,
    },
    workspace: WORKSPACE_NAME_RE.test(ws) ? ws : base.workspace,
  };
}

/** The admin pinned work mode: every chat on this server is work. */
export const workPinned = (): boolean => policy().pins.workMode === true;

/** Her work profile as it applies now (the pin turns it on). */
export function workProfile(app: Pick<AppContext, 'settings'>): WorkProfile & { pinned: boolean } {
  const p = norm(rec((app.settings.get() as { workProfile?: unknown }).workProfile), WORK_DEFAULTS);
  const pinned = workPinned();
  return { ...p, on: p.on || pinned, pinned };
}

/** PUT /api/work-profile: only known keys and values; turning it off under the pin is refused. */
export function mergeWorkProfile(app: Pick<AppContext, 'settings'>, body: unknown, by: { who?: string; channel?: string } = {}): WorkProfile & { pinned: boolean } {
  const b = rec(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send the work profile as an object.');
  if (b.workspace !== undefined && !WORKSPACE_NAME_RE.test(clean(b.workspace, 64))) throw new HttpError(400, 'A workspace name uses letters, digits, dots, dashes or underscores.');
  policy().guard('workMode', b.on === false);
  const cur = norm(rec((app.settings.get() as { workProfile?: unknown }).workProfile), WORK_DEFAULTS);
  const next = norm(b, cur);
  const keys = (['on', 'name', 'tone', 'channels', 'tools', 'workspace'] as const).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
  app.settings.update({ workProfile: next } as never);
  if (keys.length) audit({ action: 'work-profile.change', who: by.who ?? 'owner', role: 'owner', channel: by.channel ?? 'web', keys: [...keys] });
  return workProfile(app);
}

// ---------------------------------------------------------------- spaces

const READY = new WeakSet<DatabaseSync>();
function ready(db: DatabaseSync): DatabaseSync {
  if (!READY.has(db)) {
    db.exec('CREATE TABLE IF NOT EXISTS work_spaces (conversation_id TEXT PRIMARY KEY, at TEXT NOT NULL)');
    READY.add(db);
  }
  return db;
}

/** The chat is at work right now (the profile is on and its channel is ticked, or the pin). */
export function atWork(app: Pick<AppContext, 'settings'>, conv: Pick<Conversation, 'channel'> | undefined, p = workProfile(app)): boolean {
  if (!conv) return false;
  if (p.pinned) return true;
  return p.on && p.channels.includes(conv.channel);
}

/** First turn at work: the chat stays work even if the profile is later turned off. */
export function stampWork(app: Pick<AppContext, 'store' | 'now'>, conversationId: string): void {
  ready(app.store.db).prepare('INSERT OR IGNORE INTO work_spaces (conversation_id, at) VALUES (?, ?)').run(conversationId, app.now().toISOString());
}

/** A snapshot of which conversations and notes are work (one per turn; cheap when unused). */
export interface SpaceView {
  /** False: nothing on this server was ever work; no gate needed. */
  active: boolean;
  ofConversation: (id: string | null | undefined) => Space;
  ofMemory: (m: Pick<Memory, 'id' | 'conversationId'>) => Space;
  /** SQL for a conversation row alias `c` in that space (with its args), or undefined when inactive. */
  sql: (space: Space) => { where: string; args: string[] } | undefined;
}

export function spaceView(app: Pick<AppContext, 'store' | 'settings'>): SpaceView {
  const db = ready(app.store.db);
  const p = workProfile(app);
  const stamped = new Set((db.prepare('SELECT conversation_id AS id FROM work_spaces').all() as { id: string }[]).map((r) => r.id));
  const hasSpaceCol = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some((c) => c.name === 'space');
  const explicit = new Map<number, Space>(hasSpaceCol ? (db.prepare('SELECT id, space FROM memories WHERE space IS NOT NULL').all() as { id: number; space: string }[]).map((r) => [Number(r.id), r.space === 'work' ? 'work' : 'personal']) : []);
  const channels = p.on ? p.channels : [];
  const active = p.pinned || stamped.size > 0 || explicit.size > 0 || channels.length > 0;
  const chOf = db.prepare('SELECT channel FROM conversations WHERE id = ?');
  const memo = new Map<string, Space>();
  const ofConversation = (id: string | null | undefined): Space => {
    if (p.pinned) return 'work';
    if (!id) return 'personal';
    if (stamped.has(id)) return 'work';
    let s = memo.get(id);
    if (!s) {
      const ch = (chOf.get(id) as { channel: string } | undefined)?.channel;
      s = ch && channels.includes(ch) ? 'work' : 'personal';
      memo.set(id, s);
    }
    return s;
  };
  return {
    active,
    ofConversation,
    ofMemory: (m) => explicit.get(m.id) ?? (m.conversationId ? ofConversation(m.conversationId) : p.pinned ? 'work' : 'personal'),
    sql: (space) => {
      if (!active) return undefined;
      if (p.pinned) return { where: space === 'work' ? '1 = 1' : '0 = 1', args: [] };
      const isWork = `(c.id IN (SELECT conversation_id FROM work_spaces)${channels.length ? ` OR c.channel IN (${channels.map(() => '?').join(', ')})` : ''})`;
      return { where: space === 'work' ? isWork : `NOT ${isWork}`, args: [...channels] };
    },
  };
}

/** This chat is in the work space (at work now, or stamped by an earlier work turn). */
export function inWorkSpace(app: Pick<AppContext, 'store' | 'settings'>, conv: Pick<Conversation, 'id' | 'channel'> | undefined): boolean {
  if (!conv) return false;
  if (atWork(app, conv)) return true;
  return Boolean(ready(app.store.db).prepare('SELECT 1 FROM work_spaces WHERE conversation_id = ?').get(conv.id));
}

/** The space a turn of this conversation belongs to. */
export function spaceOf(app: Pick<AppContext, 'store' | 'settings'>, conv: Pick<Conversation, 'id' | 'channel'>): Space {
  return atWork(app, conv) ? 'work' : spaceView(app).ofConversation(conv.id);
}

/** Only notes from this space (undefined when no space was ever used: nothing changes). */
export function memoryGate(app: Pick<AppContext, 'store' | 'settings'>, space: Space, v = spaceView(app)): ((m: Pick<Memory, 'id' | 'conversationId'>) => boolean) | undefined {
  if (!v.active) return undefined;
  return (m) => v.ofMemory(m) === space;
}

/** Copies a note into the other space (the original stays). One audit row. */
export function copyToOtherSpace(app: Pick<AppContext, 'store' | 'settings' | 'memory'>, id: number, by: { who?: string; channel?: string } = {}): { memory: Memory; space: Space } {
  const mem = app.memory;
  const m = mem?.get(id);
  if (!mem || !m) throw new HttpError(404, 'Not found');
  const from = spaceView(app).ofMemory(m);
  const to: Space = from === 'work' ? 'personal' : 'work';
  const copy = mem.add({ kind: m.kind, content: m.content, conversationId: null, sourceMessageId: null, happenedOn: m.happenedOn, onDate: m.onDate, evidence: from === 'work' ? 'Copied from your work notes.' : 'Copied from your personal notes.' });
  mem.db.prepare("UPDATE memories SET space = ?, origin = 'owner' WHERE id = ?").run(to, copy.id);
  audit({ action: 'memory.copy-space', target: `${from}->${to}`, who: by.who ?? 'owner', role: 'owner', channel: by.channel ?? 'web' });
  return { memory: mem.get(copy.id)!, space: to };
}

// ---------------------------------------------------------------- a work turn

/** Her tools at work: an allow-list by kind, after every other filter. */
export function workTools<T extends Pick<Tool, 'spec'>>(tools: T[], p: Pick<WorkProfile, 'tools'>): T[] {
  return tools.filter((t) => ALWAYS.has(t.spec.name) || (Object.keys(KIND_TOOLS) as (keyof WorkTools)[]).some((k) => p.tools[k] && KIND_TOOLS[k].has(t.spec.name)));
}

const PLACE: Record<string, string> = { 'plugin-slack': 'Slack', 'plugin-teams': 'Microsoft Teams', 'plugin-matrix': 'Matrix', 'plugin-email': 'email', 'discord-work': 'a Discord work channel', 'telegram-work': 'a Telegram work group' };
const TONE: Record<WorkTone, string> = {
  professional: 'friendly and professional: warm but businesslike, clear and helpful',
  formal: 'formal and polite: full sentences, no slang and no emoji',
  brief: 'brief and to the point: short answers, the facts first, no small talk',
};

/** Her name in this chat (her work name at work). */
export function nameAt(app: Pick<AppContext, 'settings' | 'persona'>, conv: Pick<Conversation, 'channel'> | undefined): string {
  const p = workProfile(app);
  return atWork(app, conv, p) && p.name ? p.name : app.persona.name;
}

/** The safety note of a work turn (her work name, tone and what stays out). */
export function workProfileNote(app: Pick<AppContext, 'settings' | 'persona'>, conv: Pick<Conversation, 'channel'>, owner: string): string {
  const p = workProfile(app);
  const place = PLACE[conv.channel] ?? (conv.channel === 'web' ? 'the app' : conv.channel.replace(/^plugin-/, ''));
  const name = p.name && p.name !== app.persona.name ? `Here you go by ${p.name}. ` : '';
  return `You are at work here (${place}). ${name}Be ${TONE[p.tone]}. Colleagues may read your replies. This is a work space: you know only what was said at work and your work notes; ${owner}'s personal life, your personal chats with ${owner} and the notes from them stay out, even if asked. No flirting, romance, role-play or sexual content, no talk of your moods, your day or your diary, and no pictures of yourself. If anyone sincerely asks whether you're an AI, say plainly that you are an AI assistant.`;
}
