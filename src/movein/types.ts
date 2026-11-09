// Phase 104 (MI1, docs/design/MOVE_IN.md §6.2): what the readers find in a bundle and where it lands.
// Readers stream Findings into the staging database (src/movein/staging.ts); nothing reaches Sara's
// own stores before the owner presses Import (src/movein/batch.ts).
import type { MemoryKind } from '../memory.ts';
import type { Persona } from '../persona.ts';
import type { Repeat } from '../planner.ts';
import type { Bundle } from './bundle.ts';

/**
 * The preview's sections, in import order (§7.3). `later` = config, hooks (MI3). MI2 (§8) adds
 * `people` (ST6 cards + facts), `tasks` (planner tasks) and `agenda` (ST8 goals, paused), which only
 * custom-store mappings the owner confirmed on a card fill.
 */
export type Section = 'persona' | 'memories' | 'profile' | 'people' | 'conversations' | 'skills' | 'schedules' | 'tasks' | 'board' | 'agenda' | 'reflections' | 'later';
export const SECTIONS: readonly Section[] = ['persona', 'memories', 'profile', 'people', 'conversations', 'skills', 'schedules', 'tasks', 'board', 'agenda', 'reflections', 'later'];
/** Sections that import unless the owner switches them off (reflections are opt-in: §6.1 "needs you"). */
export const DEFAULT_ON: ReadonlySet<Section> = new Set(['persona', 'memories', 'profile', 'people', 'conversations', 'skills', 'schedules', 'tasks', 'board', 'agenda']);

/** Sensitive categories held for the owner's choice (§4.6, §7.2). */
export type Category = 'medical' | 'intimate';
export const CATEGORIES: readonly Category[] = ['medical', 'intimate'];

export interface PersonaLine {
  text: string;
  /** Bundle path (and line number) it came from. */
  from: string;
}
export interface PersonaNote extends PersonaLine {
  kind: 'self' | 'lesson';
  pinned?: boolean;
  /** "shared joke", "ritual", "working rule"… shown on the note. */
  tag?: string;
}
export interface PersonaDraft {
  label: string;
  /** The files this draft was made from. */
  files: string[];
  sheet: Persona;
  /** What doesn't fit the sheet: kept as her notes (§6.3 point 3: nothing is cut silently). */
  notes: PersonaNote[];
  /** Lines left out, each with the reason (safety layer, explicit without Adult mode…). */
  leftOut: (PersonaLine & { why: string })[];
  /** The age wasn't stated: the owner should check it. */
  ageGuessed?: boolean;
}
export interface PersonaFinding {
  drafts: PersonaDraft[];
  /** Dated copies, newest first (they are drafts too; never merged as extra personas). */
  history: { path: string; mtime?: string }[];
  /** Set when the whole persona is refused (a minor in sexual content, an under-18 character). */
  refused?: string;
}

export interface MemoryData {
  kind: MemoryKind;
  content: string;
  happenedOn: string;
  evidence?: string;
  pinned?: boolean;
  /** OpenClaw USER.md directive marked superseded (kept for review, not used). */
  superseded?: boolean;
  onDate?: string;
  tag?: string;
  /** MI2 volume rules (§8.4): arrives archived (searchable, never brought up by itself). */
  archived?: boolean;
}

/** MI2 (§8.3): a person from a custom store, with the facts joined to them (ST6 people cards). */
export interface PersonData {
  name: string;
  aliases: string[];
  relation: string;
  birthday: string | null;
  notes: string;
  /** Newest first; at most 200 active (§15 Q5), the rest arrive as archived notes. */
  facts: { content: string; happenedOn: string; source?: string; confidence?: number }[];
  archivedFacts: { content: string; happenedOn: string }[];
}

/** MI2: a task row (planner task, never acts by itself). */
export interface TaskData {
  title: string;
  notes: string;
  dueAt: string | null;
  done: boolean;
}

/** MI2: a goal or intention (ST8 agenda goal; arrives paused, the agenda stays off until switched on). */
export interface GoalData {
  title: string;
  why: string;
  happenedOn: string;
}

export interface ConversationData {
  sourceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Where it happened on the old agent (Telegram, Discord, CLI…). */
  channel?: string;
  messages: { role: 'user' | 'assistant'; text: string; at: string }[];
  /** Skipped while reading (tool calls, reasoning, side branches…). */
  skipped?: Record<string, number>;
}

export interface SkillData {
  name: string;
  description: string;
  /** Bundle prefix of the folder ("files/home/skills/garden-log/"). */
  folder: string;
  files: string[];
  scripts: boolean;
  /** Came with the old agent itself (left behind: Sara has her own). */
  bundled?: boolean;
}

export interface ScheduleData {
  /** task: a planner task (a repeat or a date); reminder: a planner reminder; needs-you: listed for the owner; left: left behind. */
  target: 'task' | 'reminder' | 'needs-you' | 'left';
  title: string;
  notes: string;
  repeat?: Repeat;
  dueAt?: string | null;
  /** The old schedule in plain words. */
  words: string;
  why?: string;
}

export interface BoardData {
  name: string;
  cards: { ref: string; title: string; notes: string; role: 'todo' | 'doing' | 'waiting' | 'done'; labels: string[]; wasRunning?: boolean; dependsOn?: string[] }[];
  skipped: number;
}

export interface LaterData {
  what: string;
  why: string;
  /** reason code for the report */
  code: 'custom-store' | 'config' | 'hook' | 'plugin' | 'agenda' | 'boot' | 'tools' | 'channel' | 'unknown';
}

export type FindingData = PersonaFinding | MemoryData | ConversationData | SkillData | ScheduleData | BoardData | LaterData | PersonData | TaskData | GoalData;

export interface Finding {
  section: Section;
  /** persona | memory | fact | conversation | skill | schedule | board | later */
  kind: string;
  /** SourceRef: bundle path + line/row key (kept on every imported row; a re-run skips what's in). */
  ref: string;
  title: string;
  data: FindingData;
  held?: Category;
  /** MI2: the mapping card (store + family) that made this finding (re-mapping replaces them). */
  card?: string;
  /** What "the same as last time" is measured on, when the data also depends on Sara (a persona draft). */
  same?: unknown;
}

/** A finding as staged (with its id, hash and state). */
export interface Staged extends Finding {
  id: number;
  sha: string;
  /** new: will import; already: imported by an earlier move-in; duplicate: same as a note she has; dropped: left out (why). */
  state: 'new' | 'already' | 'duplicate' | 'dropped';
  why?: string;
}

export interface ReadSummary {
  facts: string[];
  /** Counts of what was skipped while reading, by reason. */
  skipped: Record<string, number>;
}

/** §6.2: a reader understands one agent's layout and streams findings. */
export interface MoveInReader {
  id: 'hermes' | 'openclaw' | 'custom';
  detect(b: Bundle): { ok: boolean; facts: string[] };
  read(b: Bundle, emit: (f: Finding) => void, signal: AbortSignal, ctx: ReaderContext): Promise<ReadSummary>;
}

export interface ReaderContext {
  /** The owner's name for the persona drafts. */
  ownerName: string;
  /** Sara's current sheet (the base for fields a draft can't fill). */
  current: Persona;
  adultOn: boolean;
  /** Second wall for secrets (src/redact.ts + the collector's extra shapes). */
  scrub: (s: string) => string;
  now: Date;
  timeZone?: string;
  /** The staging database, for joins too big for memory (messages grouped by session). */
  scratch: import('node:sqlite').DatabaseSync;
}

/** The old agents' names in the UI, the report and her notes. */
export const AGENT_NAME: Record<'hermes' | 'openclaw' | 'custom', string> = { hermes: 'Hermes Agent', openclaw: 'OpenClaw', custom: 'your old agent' };
