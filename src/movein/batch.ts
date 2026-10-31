// Phase 104 (MI1, docs/design/MOVE_IN.md §7.3, §7.4, §10): Import = one batch; Undo removes exactly it.
// Every row the batch creates is listed in movein_items (batch id, native table + id, source ref,
// hash), so Undo deletes precisely those rows, puts the previous persona.json back, and marks the
// batch undone. Notes she learned later from imported conversations go with their conversation.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { writeFileAtomic } from '../fs-util.ts';
import { HistoryImporter } from '../history-import/index.ts';
import { SOURCE_CHANNEL, type HistorySource } from '../history-import/types.ts';
import type { MemoryKind } from '../memory.ts';
import { loadPersona, type Persona, validatePersona } from '../persona.ts';
import type { Bundle } from './bundle.ts';
import { ACTIVE_NOTES, type Choices, LEARN_DAYS, type Staging } from './staging.ts';
import type { BoardData, ConversationData, MemoryData, PersonaFinding, ScheduleData, SkillData, Staged } from './types.ts';
import { AGENT_NAME } from './types.ts';

export const UNDO_DAYS = 30;
const TX_ROWS = 5000;

export type BatchState = 'importing' | 'done' | 'partial' | 'undone';
export interface BatchRow {
  id: string;
  sourceKind: 'hermes' | 'openclaw' | 'custom';
  agentId: string;
  agentName: string;
  bundleSha256: string;
  herPast: boolean;
  createdAt: string;
  finishedAt: string | null;
  state: BatchState;
  report: Report | null;
}

export interface ReportLine {
  key: string;
  count: number;
  text: string;
  examples?: string[];
}
export interface Report {
  imported: ReportLine[];
  translated: ReportLine[];
  needsYou: ReportLine[];
  leftBehind: ReportLine[];
}

export interface PersonaChoice {
  /** Use a draft (by index) as her new sheet; undefined keeps the current Sara. */
  use?: number;
  /** The owner's edits on the card (name, age). */
  name?: string;
  age?: number;
}

export interface ImportChoices extends Choices {
  /** §6.5 "Was this her?" (default yes for a move-in). */
  herPast: boolean;
  persona?: PersonaChoice;
  /** §15 Q4: learn from all conversations, not just the last 90 days. */
  learnAll?: boolean;
  learn?: boolean;
}

/** The additive migration (node:sqlite, CREATE … IF NOT EXISTS). */
export function ensureTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS movein_batches (
      id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
      bundle_sha256 TEXT NOT NULL, her_past INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      finished_at TEXT, state TEXT NOT NULL, report_json TEXT);
    CREATE TABLE IF NOT EXISTS movein_items (
      batch_id TEXT NOT NULL, kind TEXT NOT NULL, native_table TEXT NOT NULL, native_id TEXT NOT NULL,
      source TEXT, sha256 TEXT);
    CREATE INDEX IF NOT EXISTS movein_items_batch ON movein_items(batch_id);
    CREATE INDEX IF NOT EXISTS movein_items_source ON movein_items(source);`);
}

const toBatch = (r: Record<string, unknown>): BatchRow => ({
  id: String(r.id),
  sourceKind: r.source_kind as BatchRow['sourceKind'],
  agentId: String(r.agent_id),
  agentName: String(r.agent_name),
  bundleSha256: String(r.bundle_sha256),
  herPast: Boolean(r.her_past),
  createdAt: String(r.created_at),
  finishedAt: (r.finished_at as string | null) ?? null,
  state: r.state as BatchState,
  report: r.report_json ? (JSON.parse(String(r.report_json)) as Report) : null,
});

export function batches(db: DatabaseSync): BatchRow[] {
  ensureTables(db);
  return (db.prepare('SELECT * FROM movein_batches ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(toBatch);
}
export function batch(db: DatabaseSync, id: string): BatchRow | undefined {
  ensureTables(db);
  const r = db.prepare('SELECT * FROM movein_batches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toBatch(r) : undefined;
}

/** For re-runs (§7.5): what an earlier, not-undone move-in of the same agent brought. */
export function earlier(db: DatabaseSync, kind: string, agentId: string): { refs: Set<string>; refShas: Set<string> } {
  ensureTables(db);
  const rows = db.prepare("SELECT i.source AS source, i.sha256 AS sha FROM movein_items i JOIN movein_batches b ON b.id = i.batch_id WHERE b.source_kind = ? AND b.agent_id = ? AND b.state IN ('done', 'partial') AND i.source IS NOT NULL").all(kind, agentId) as { source: string; sha: string | null }[];
  return { refs: new Set(rows.map((r) => r.source)), refShas: new Set(rows.map((r) => `${r.source}|${r.sha ?? ''}`)) };
}

const KIND_ORDER: MemoryKind[] = ['fact', 'decision', 'promise', 'self', 'lesson', 'milestone', 'date', 'summary', 'reflection'];

export interface BatchProgress {
  line: string;
  done: number;
  total: number;
}

/** What the batch needs from the bundle session (src/movein/index.ts). */
export interface BatchInput {
  app: AppContext;
  staging: Staging;
  bundle: Bundle;
  bundleSha: string;
  choices: ImportChoices;
  signal: AbortSignal;
  progress: (p: BatchProgress) => void;
  leftBehind: ReportLine[];
}

/** Runs the import. Returns the batch (done, or partial after Stop). */
export async function runBatch(inp: BatchInput): Promise<BatchRow> {
  const { app, staging, bundle, choices, signal } = inp;
  const db = app.store.db;
  ensureTables(db);
  const m = bundle.manifest;
  const kind = m.source.kind;
  const source: HistorySource = kind === 'openclaw' ? 'openclaw' : 'hermes';
  const agent = AGENT_NAME[kind];
  const channel = SOURCE_CHANNEL[source];
  const herPast = choices.herPast;
  const id = randomUUID();
  const now = app.now().toISOString();
  db.prepare('INSERT INTO movein_batches (id, source_kind, agent_id, agent_name, bundle_sha256, her_past, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, kind, m.source.agentId, m.source.displayName ?? m.source.agentId, inp.bundleSha, herPast ? 1 : 0, now, 'importing');
  const item = db.prepare('INSERT INTO movein_items (batch_id, kind, native_table, native_id, source, sha256) VALUES (?, ?, ?, ?, ?, ?)');
  const record = (k: string, table: string, nativeId: string | number, ref: string | null, sha: string | null) => item.run(id, k, table, String(nativeId), ref, sha);
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  const translated: ReportLine[] = [];
  const needsYou: ReportLine[] = [];
  const list = [...staging.selection(choices)];
  const total = list.length;
  let done = 0;
  const tick = (line: string) => inp.progress({ line, done, total });
  let stopped = false;

  // ---------------- personality (after its own review on the card) ----------------
  const personaF = list.find((f) => f.kind === 'persona');
  let personaNotes: { text: string; kind: MemoryKind; pinned?: boolean; tag?: string; from: string }[] = [];
  if (personaF && choices.persona?.use !== undefined) {
    const pf = personaF.data as PersonaFinding;
    const draft = pf.drafts[choices.persona.use] ?? pf.drafts[0];
    if (draft && herPast) {
      const sheet = validatePersona({ ...draft.sheet, ...(choices.persona.name ? { name: choices.persona.name } : {}), ...(choices.persona.age ? { age: choices.persona.age } : {}) });
      const dir = join(app.dataDir, 'movein', id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const cur = join(app.dataDir, 'persona.json');
      if (existsSync(cur)) copyFileSync(cur, join(dir, 'persona.before.json'));
      else writeFileAtomic(join(dir, 'persona.before.none'), '', 0o600);
      applyPersona(app, sheet);
      record('persona', 'persona.json', 'persona', personaF.ref, personaF.sha);
      bump('persona');
      personaNotes = draft.notes.map((n) => ({ text: n.text, kind: n.kind, ...(n.pinned ? { pinned: true } : {}), ...(n.tag ? { tag: n.tag } : {}), from: n.from }));
    }
    done++;
  } else if (personaF) done++;

  // ---------------- memories, profile, reflections (+ the persona's own notes) ----------------
  const notes = list.filter((f) => f.kind === 'memory');
  if ((notes.length || personaNotes.length) && app.memory) {
    tick('Memories');
    const anchor = app.store.insertImported({ title: `${herPast ? 'From before the move' : `Learned from ${agent}`}: notes (${m.source.displayName ?? m.source.agentId})`, channel, channelKey: `${herPast ? 'her:' : ''}movein-notes-${id}`, createdAt: now, updatedAt: now, archived: true, from: source, herPast, messages: [] });
    record('conversation', 'conversations', anchor.id, null, null);
    app.memory.setState(anchor.id, { summarizedThrough: 0, lastError: null });
    type N = { data: MemoryData; ref: string; sha: string; section: string };
    const all: N[] = [
      ...personaNotes.map((n) => ({ data: { kind: n.kind, content: n.text, happenedOn: now.slice(0, 10), ...(n.pinned ? { pinned: true } : {}), ...(n.tag ? { tag: n.tag } : {}) }, ref: n.from, sha: '', section: 'persona' })),
      ...notes.map((f) => ({ data: f.data as MemoryData, ref: f.ref, sha: f.sha, section: f.section })),
    ];
    // §6.4: more than ACTIVE_NOTES → the best by kind and recency are active, the rest archived.
    const rank = [...all].sort((a, b) => Number(Boolean(b.data.pinned)) - Number(Boolean(a.data.pinned)) || KIND_ORDER.indexOf(a.data.kind) - KIND_ORDER.indexOf(b.data.kind) || (a.data.happenedOn < b.data.happenedOn ? 1 : -1));
    const archived = new Set(rank.slice(ACTIVE_NOTES).map((x) => x));
    const mem = app.memory;
    let inTx = 0;
    db.exec('BEGIN');
    try {
      for (const n of all) {
        if (signal.aborted) {
          stopped = true;
          break;
        }
        const d = n.data;
        const evidence = d.evidence ?? `${herPast ? `From before the move (on ${agent})` : `From ${agent}`}${d.tag ? `: ${d.tag}` : ''}`;
        const row = mem.add({ kind: d.kind, content: app.redactor.redact(d.content), conversationId: anchor.id, sourceMessageId: null, happenedOn: d.happenedOn, evidence });
        if (d.pinned) mem.setPinned(row.id, true);
        if (d.superseded) mem.supersede(row.id, row.id);
        if (archived.has(n)) mem.setArchived(row.id, true);
        record('memory', 'memories', row.id, n.section === 'persona' ? null : n.ref, n.sha || null);
        bump(n.section === 'profile' ? 'profile' : n.section === 'reflections' ? 'reflections' : n.section === 'persona' ? 'personaNotes' : 'memories');
        if (archived.has(n)) bump('archived');
        if (n.section !== 'persona') done++;
        if (++inTx >= TX_ROWS) {
          db.exec('COMMIT');
          db.exec('BEGIN');
          inTx = 0;
          tick('Memories');
          await new Promise((r) => setImmediate(r));
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------- conversations ----------------
  const learnIds: string[] = [];
  const cutoff = Date.now() - LEARN_DAYS * 86_400_000;
  for (const f of list.filter((x) => x.kind === 'conversation')) {
    if (signal.aborted) {
      stopped = true;
      break;
    }
    const c = f.data as ConversationData;
    const r = app.store.insertImported({
      title: `${c.title}${c.channel ? ` · ${c.channel}` : ''}`.slice(0, 200),
      channel,
      channelKey: `${herPast ? 'her:' : ''}${c.sourceId}`.slice(0, 300),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      archived: true,
      from: source,
      herPast,
      messages: c.messages.map((x) => ({ role: x.role, content: app.redactor.redact(x.text), createdAt: x.at })),
    });
    app.memory?.setState(r.id, { summarizedThrough: r.lastId, lastError: null });
    record('conversation', 'conversations', r.id, f.ref, f.sha);
    bump('conversations');
    if (choices.learn !== false && (choices.learnAll || Date.parse(c.updatedAt) >= cutoff)) learnIds.push(r.id);
    done++;
    if (done % 25 === 0) {
      tick('Conversations');
      await new Promise((res) => setImmediate(res));
    }
  }

  // ---------------- skills (scripts held: off until reviewed) ----------------
  if (app.skills) {
    for (const f of list.filter((x) => x.kind === 'skill')) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      const s = f.data as SkillData;
      const files = [{ path: `${s.name}/SKILL.md`, data: Buffer.from(app.redactor.redact(await bundle.text(`${s.folder}SKILL.md`, 1024 * 1024)), 'utf8') }];
      for (const rel of s.files) files.push({ path: `${s.name}/${rel}`, data: Buffer.from(app.redactor.redact(await bundle.text(`${s.folder}${rel}`, 1024 * 1024).catch(() => '')), 'utf8') });
      try {
        const p = app.skills.stage(files, `${agent}: ${s.name}`, 'folder');
        const views = app.skills.accept(p.id, 'companion');
        for (const v of views) {
          if (s.scripts) app.skills.setSwitches(v.scope, v.name, { enabled: false });
          record('skill', 'skills', `${v.scope}/${v.name}`, f.ref, f.sha);
          bump('skills');
          if (s.scripts) bump('skillsHeld');
        }
      } catch (err) {
        needsYou.push({ key: 'skill', count: 1, text: `Skill "${s.name}" couldn't be added: ${(err as Error).message}` });
      }
      done++;
    }
  } else if (list.some((x) => x.kind === 'skill')) needsYou.push({ key: 'skills', count: list.filter((x) => x.kind === 'skill').length, text: 'Skills are not available on this server.' });

  // ---------------- schedules → tasks and reminders ----------------
  if (app.planner) {
    for (const f of list.filter((x) => x.kind === 'schedule')) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      const s = f.data as ScheduleData;
      if (s.target === 'reminder' && s.dueAt) {
        const r = app.planner.addReminder({ text: s.title, dueAt: s.dueAt });
        record('reminder', 'reminders', r.id, f.ref, f.sha);
        bump('reminders');
      } else {
        const t = app.planner.addTask({ title: s.title, notes: `${s.notes}\nOld schedule: ${s.words}.`, dueAt: s.dueAt ?? null, ...(s.repeat ? { repeat: s.repeat } : {}) });
        record('task', 'tasks', t.id, f.ref, f.sha);
        bump('tasks');
      }
      done++;
    }
  }

  // ---------------- the board ----------------
  if (app.board) {
    for (const f of list.filter((x) => x.kind === 'board')) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      const bd = f.data as BoardData;
      const b = app.board.createBoard(uniqueBoardName(app, bd.name));
      record('board', 'boards', b.id, f.ref, f.sha);
      const labels = [...new Set(bd.cards.flatMap((c) => c.labels))].slice(0, 20);
      const palette = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'];
      if (labels.length) app.board.setLabels(b.id, labels.map((name, i) => ({ name, color: palette[i % palette.length] })));
      const cols = app.board.columns(b.id);
      const byRef = new Map(bd.cards.map((c) => [c.ref, c.title]));
      for (const c of bd.cards) {
        const col = cols.find((x) => x.role === c.role) ?? cols[0];
        const deps = (c.dependsOn ?? []).map((r) => byRef.get(r)).filter(Boolean);
        const card = app.board.addCard(b.id, { title: c.title, notes: [c.notes, deps.length ? `Depends on: ${deps.join(', ')}` : ''].filter(Boolean).join('\n\n'), columnId: col.id, labels: c.labels }, 'sara');
        record('card', 'tasks', card.id, `${f.ref}#${c.ref}`, null);
        bump('cards');
      }
      done++;
    }
  }

  // ---------------- report (§10: MI1's first report) ----------------
  for (const f of staging.all('schedules')) {
    const s = f.data as ScheduleData;
    if (f.state !== 'new') continue;
    if (s.target === 'needs-you') needsYou.push({ key: 'schedule', count: 1, text: `Schedule "${s.title}" (${s.words}): ${s.why ?? 'set it up by hand'}.` });
  }
  if (counts.tasks || counts.reminders) translated.push({ key: 'schedules', count: (counts.tasks ?? 0) + (counts.reminders ?? 0), text: `cron jobs → ${counts.tasks ?? 0} tasks, ${counts.reminders ?? 0} reminders (tasks never act by themselves; scripts never run)` });
  for (const f of staging.all('later')) needsYou.push({ key: (f.data as { code: string }).code, count: 1, text: `${(f.data as { what: string }).what}: ${(f.data as { why: string }).why}` });
  const held = staging.counts(choices).held;
  for (const [cat, n] of Object.entries(held)) if (n && !(choices.sensitive?.[cat as 'medical'] === true)) needsYou.push({ key: `held-${cat}`, count: n, text: `${cat === 'medical' ? 'Health/medical' : 'Intimate'}: ${n} items held. Import the bundle again and say yes to bring them.` });
  if (counts.skillsHeld) needsYou.push({ key: 'skills-held', count: counts.skillsHeld, text: `${counts.skillsHeld} skills run scripts: they are off until you check them (Settings → Abilities → Skills).` });
  const imported: ReportLine[] = [];
  if (counts.persona) imported.push({ key: 'persona', count: 1, text: `Personality: her sheet from ${personaF?.ref.split('/').at(-1) ?? 'the persona files'}${counts.personaNotes ? `, ${counts.personaNotes} lines kept as her notes` : ''}` });
  if (counts.memories) imported.push({ key: 'memories', count: counts.memories, text: `Memories: ${counts.memories}${counts.archived ? ` (${counts.archived} archived)` : ''}` });
  if (counts.profile) imported.push({ key: 'profile', count: counts.profile, text: `About you: ${counts.profile} facts` });
  if (counts.reflections) imported.push({ key: 'reflections', count: counts.reflections, text: `Reflections: ${counts.reflections}` });
  if (counts.conversations) imported.push({ key: 'conversations', count: counts.conversations, text: `Past conversations: ${counts.conversations}${learnIds.length ? `; learning from ${learnIds.length} in the background` : ''}` });
  if (counts.skills) imported.push({ key: 'skills', count: counts.skills, text: `Skills: ${counts.skills}` });
  if (counts.cards) imported.push({ key: 'board', count: counts.cards, text: `Board cards: ${counts.cards}` });
  const report: Report = { imported, translated, needsYou, leftBehind: inp.leftBehind };

  // Her message in a new "Moving in" conversation (her words come in MI3; this is the plain report).
  const welcome = app.store.createConversation({ title: 'Moving in' });
  const name = app.persona.name;
  const lines = [`I've moved in${herPast ? ` from ${agent}` : ''}. Here's what came with me:`, ...imported.map((l) => `• ${l.text}`), ...(translated.length ? ['', 'Translated:', ...translated.map((l) => `• ${l.text}`)] : []), ...(needsYou.length ? ['', 'Needs you:', ...needsYou.slice(0, 12).map((l) => `• ${l.text}`)] : []), '', `Left behind on purpose: ${inp.leftBehind.map((l) => l.text).join('; ') || 'nothing'}.`, '', `You can undo this move-in for ${UNDO_DAYS} days in Settings → Data & health → Move in from another agent.`];
  app.store.addMessage(welcome.id, 'assistant', lines.join('\n').replace(/\bI've moved in\b/, `${name} here: I've moved in`), { moveIn: id });
  record('conversation', 'conversations', welcome.id, null, null);

  const state: BatchState = stopped ? 'partial' : 'done';
  db.prepare('UPDATE movein_batches SET state = ?, finished_at = ?, report_json = ? WHERE id = ?').run(state, app.now().toISOString(), JSON.stringify(report), id);
  // Learning: the most recent 90 days by default, in the background (pausable, as in Phase 51).
  if (learnIds.length) (app.historyImport ??= new HistoryImporter(() => app)).queueLearning(learnIds, source);
  app.events?.publish({ type: 'memory', conversationId: welcome.id });
  return batch(db, id)!;
}

function uniqueBoardName(app: AppContext, base: string): string {
  const taken = new Set(app.board!.boards().map((b) => b.name));
  let n = base.slice(0, 70);
  for (let k = 2; taken.has(n); k++) n = `${base.slice(0, 66)} ${k}`;
  return n;
}

/** Writes her sheet without renaming old notes (so Undo can put everything back exactly). */
export function applyPersona(app: AppContext, p: Persona): void {
  writeFileAtomic(join(app.dataDir, 'persona.json'), JSON.stringify(p, null, 2) + '\n', 0o600);
  app.persona = p;
}

/** What Undo will touch: counts per kind, and imported notes the owner edited since (§7.4). */
export function undoPreview(app: AppContext, id: string): { counts: Record<string, number>; edited: { id: number; content: string }[] } {
  const db = app.store.db;
  ensureTables(db);
  const items = db.prepare('SELECT kind, native_id FROM movein_items WHERE batch_id = ?').all(id) as { kind: string; native_id: string }[];
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const memIds = items.filter((i) => i.kind === 'memory').map((i) => Number(i.native_id));
  const edited = memIds.length && app.memory ? memIds.map((x) => app.memory!.get(x)).filter((x) => x?.edited).map((x) => ({ id: x!.id, content: x!.content })) : [];
  return { counts, edited };
}

/** Undo: every row the batch made, the persona back, the batch marked undone. */
export function undoBatch(app: AppContext, id: string, opts: { keepEdited?: boolean } = {}): { removed: Record<string, number> } {
  const db = app.store.db;
  ensureTables(db);
  const b = batch(db, id);
  if (!b) throw new Error('No such move-in.');
  if (b.state === 'undone') throw new Error('This move-in was already undone.');
  if (b.state === 'importing') throw new Error('This move-in is still running. Stop it first.');
  if (Date.parse(b.createdAt) < Date.now() - UNDO_DAYS * 86_400_000) throw new Error(`Undo is available for ${UNDO_DAYS} days after a move-in.`);
  const items = db.prepare('SELECT kind, native_table, native_id FROM movein_items WHERE batch_id = ? ORDER BY rowid DESC').all(id) as { kind: string; native_table: string; native_id: string }[];
  const removed: Record<string, number> = {};
  const bump = (k: string) => (removed[k] = (removed[k] ?? 0) + 1);
  const keep = new Set(opts.keepEdited ? undoPreview(app, id).edited.map((e) => e.id) : []);
  const convIds = items.filter((i) => i.kind === 'conversation').map((i) => i.native_id);
  // The learning queue forgets them first (it may be working on one right now).
  if (convIds.length && app.historyImport) app.historyImport.forget(convIds);
  db.exec('BEGIN');
  try {
    for (const i of items) {
      if (i.kind === 'memory' && app.memory) {
        const mid = Number(i.native_id);
        if (keep.has(mid)) {
          // Kept: it stays as her own note, no longer tied to the move-in's notes conversation.
          db.prepare('UPDATE memories SET conversation_id = NULL WHERE id = ?').run(mid);
          continue;
        }
        db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ? AND id <> ?').run(mid, mid);
        if (app.memory.delete(mid)) bump('memory');
      } else if (i.kind === 'conversation') {
        if (app.memory) {
          for (const r of db.prepare('SELECT id FROM memories WHERE conversation_id = ?').all(i.native_id) as { id: number }[]) {
            if (keep.has(r.id)) continue;
            db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(r.id);
            app.memory.delete(r.id);
            bump('learned');
          }
          db.prepare('DELETE FROM memory_state WHERE conversation_id = ?').run(i.native_id);
        }
        if (app.store.getConversation(i.native_id)) {
          app.store.deleteConversation(i.native_id);
          bump('conversation');
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const i of items) {
    if (i.kind === 'skill' && app.skills) {
      const [scope, name] = i.native_id.split('/');
      if (app.skills.delete(scope, name)) {
        bump('skill');
        // Moved to .trash by delete(); a move-in's skill leaves no copy behind.
        const trash = join(app.skills.dirOf(scope), '.trash');
        try {
          for (const d of readdirSync(trash)) if (d.startsWith(`${name}-`) && statSync(join(trash, d)).isDirectory()) rmSync(join(trash, d), { recursive: true, force: true });
        } catch {
          /* no trash */
        }
      }
    } else if ((i.kind === 'task' || i.kind === 'card') && app.planner) {
      app.planner.db.prepare('DELETE FROM card_activity WHERE task_id = ?').run(Number(i.native_id));
      if (app.planner.deleteTask(Number(i.native_id))) bump(i.kind);
    } else if (i.kind === 'reminder' && app.planner) {
      if (Number(app.planner.db.prepare('DELETE FROM reminders WHERE id = ?').run(Number(i.native_id)).changes)) bump('reminder');
    } else if (i.kind === 'board' && app.board) {
      const bid = Number(i.native_id);
      app.planner?.db.prepare('DELETE FROM board_labels WHERE board_id = ?').run(bid);
      if (app.board.deleteBoard(bid)) bump('board');
    } else if (i.kind === 'persona') {
      const dir = join(app.dataDir, 'movein', id);
      const before = join(dir, 'persona.before.json');
      if (existsSync(before)) {
        const p = validatePersona(JSON.parse(readFileSync(before, 'utf8')));
        copyFileSync(before, join(app.dataDir, 'persona.json'));
        app.persona = p;
      } else {
        rmSync(join(app.dataDir, 'persona.json'), { force: true });
        if (app.defaultPersonaPath) app.persona = loadPersona(app.defaultPersonaPath);
      }
      bump('persona');
    }
  }
  rmSync(join(app.dataDir, 'movein', id), { recursive: true, force: true });
  db.prepare("UPDATE movein_batches SET state = 'undone', finished_at = ? WHERE id = ?").run(app.now().toISOString(), id);
  app.events?.publish({ type: 'memory', conversationId: '' });
  return { removed };
}

export type { Staged };
