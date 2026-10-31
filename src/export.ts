// Phase 3.8: export / import everything as one JSON file. Secrets are scrubbed on export (vault
// values and key-shaped strings, same redactor as tool output); provider keys are never exported.
// Import merges: existing conversations (same id) are skipped, ids are remapped, memories keep
// their source turns. Importing the same file twice adds nothing the second time (rows identical to
// one already here are skipped).
import { MEMORY_KINDS, type MemoryKind } from './memory.ts';
import type { AppContext } from './chat.ts';
import { cleanTags } from './store.ts';
import { cleanTags as cleanRecipeTags } from './recipes.ts';
import { cleanBudget, cleanPrices } from './usage.ts';
import { cleanLimits } from './team.ts';
import { turnBudgetSettings } from './budget.ts';

export const EXPORT_FORMAT = 'sara-export';
export const EXPORT_VERSION = 1;

type Row = Record<string, string | number | null>;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  owner: { ownerName?: string; timeZone?: string };
  conversations: { [k: string]: unknown; messages: Row[] }[];
  memories: Row[];
  memoryState: Row[];
  /** Phase 78: run snapshots, only when asked for (import leaves them out). */
  runs?: { runs: Row[]; steps: Row[]; prompts: { sha: string; text: string }[] };
  projects: Row[];
  tasks: Row[];
  notes: Row[];
  reminders: Row[];
  /** Saved places, so place reminders keep working (older files don't have it). */
  places?: Row[];
  /** Phase 37: your shared playlist, reading list and watch list (older files don't have it). */
  sharedItems?: Row[];
  /** Phase 44: her library (kept documents, with the text she read; not the original files). */
  library?: ReturnType<import('./library/store.ts').LibraryStore['exportDocs']>;
  /** Phase 50: her recipes (how she did tricky jobs; older files don't have it). */
  recipes?: Row[];
  /** Phase 52: the token meter's records, and the owner's own model prices and job budget (older files don't have them). */
  usage?: Row[];
  prices?: import('./usage.ts').PriceRow[];
  jobBudget?: import('./usage.ts').Budget;
  /** L10: the team task limits (minutes, tokens, steps, dollar budget). */
  teamLimits?: Partial<import('./team.ts').TeamLimits>;
  /** Phase 79: the per-reply budgets (Settings → Budgets; older files don't have them). */
  turnBudgets?: import('./budget.ts').TurnBudgetSettings;
  /** Phase 101 (ST6): people cards, their facts and links (older files don't have them; import leaves them out). */
  people?: { people: Row[]; facts: Row[]; links: Row[] };
}

const has = (app: AppContext, table: string) => Boolean(app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table') AND name = ?").get(table));
const all = (app: AppContext, sql: string, ...args: (string | number)[]) => (has(app, sql.match(/FROM (\w+)/)![1]) ? (app.store.db.prepare(sql).all(...args) as Row[]) : []);

/**
 * Phase 78: run snapshots go in only with `runs: true` (Settings → Data → Export, "Include run
 * history"): they are records of how she worked, big, and not merged back by import. Backups
 * always carry them (a backup is the whole database).
 */
export function exportAll(app: AppContext, opts: { runs?: boolean } = {}): ExportFile {
  const s = app.settings.get();
  const conversations = all(app, 'SELECT * FROM conversations ORDER BY created_at').map((c) => ({ ...c, messages: all(app, 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', String(c.id)) }));
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: app.now().toISOString(),
    owner: { ownerName: s.ownerName, timeZone: s.timeZone },
    conversations,
    memories: all(app, 'SELECT * FROM memories ORDER BY id'),
    memoryState: all(app, 'SELECT * FROM memory_state'),
    projects: all(app, 'SELECT * FROM projects ORDER BY id'),
    tasks: all(app, 'SELECT * FROM tasks ORDER BY id'),
    notes: all(app, 'SELECT * FROM notes ORDER BY id'),
    reminders: all(app, 'SELECT * FROM reminders ORDER BY id'),
    places: all(app, 'SELECT * FROM places ORDER BY id'),
    sharedItems: all(app, 'SELECT * FROM shared_items ORDER BY id'),
    library: app.library?.exportDocs() ?? [],
    recipes: all(app, 'SELECT * FROM recipes ORDER BY id'),
    ...(has(app, 'people') ? { people: { people: all(app, "SELECT * FROM people WHERE status IN ('proposed','active') ORDER BY id"), facts: all(app, "SELECT f.* FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.status IN ('proposed','active') ORDER BY f.id"), links: all(app, 'SELECT * FROM person_links') } } : {}),
    usage: app.usage?.exportRows() ?? [],
    ...(s.prices?.length ? { prices: s.prices } : {}),
    ...(s.jobBudget && (s.jobBudget.tokens || s.jobBudget.usd) ? { jobBudget: s.jobBudget } : {}),
    ...(s.teamLimits && Object.keys(s.teamLimits).length ? { teamLimits: s.teamLimits } : {}),
    ...(s.turnBudgets && Object.keys(s.turnBudgets).length ? { turnBudgets: turnBudgetSettings(s) } : {}),
    ...(opts.runs && app.runs ? { runs: app.runs.exportRows() as unknown as ExportFile['runs'] } : {}),
  };
  return app.redactor.redactValue(file) as ExportFile;
}

export interface ImportResult {
  conversations: number;
  skippedConversations: number;
  messages: number;
  memories: number;
  projects: number;
  tasks: number;
  notes: number;
  reminders: number;
  places?: number;
  sharedItems?: number;
  documents?: number;
  recipes?: number;
  usage?: number;
  prices?: number;
}

const v = (x: unknown): string | number | null => (x === undefined || x === null ? null : typeof x === 'number' ? x : String(x));
const req = (x: unknown, what: string): string => {
  if (x === undefined || x === null || x === '') throw new Error(`Import file is missing ${what}.`);
  return String(x);
};

export function importAll(app: AppContext, data: unknown): ImportResult {
  const f = data as Partial<ExportFile>;
  if (!f || f.format !== EXPORT_FORMAT) throw new Error('Not a Sara export file.');
  if (typeof f.version !== 'number' || f.version > EXPORT_VERSION) throw new Error(`Export version ${String(f.version)} is newer than this Sara supports (${EXPORT_VERSION}).`);
  const db = app.store.db;
  const r: ImportResult = { conversations: 0, skippedConversations: 0, messages: 0, memories: 0, projects: 0, tasks: 0, notes: 0, reminders: 0 };
  const msgMap = new Map<number, number>();
  const convImported = new Set<string>();
  const projMap = new Map<number, number>();
  /** Per imported conversation: [old message id, new message id]. */
  const msgPairs = new Map<string, [number, number][]>();
  const now = app.now().toISOString();

  db.exec('BEGIN');
  try {
    // Projects first, so conversations filed in a project stay filed there.
    if (app.planner) {
      for (const p of f.projects ?? []) {
        const name = req(p.name, 'a project name');
        const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name) as Row | undefined;
        if (existing) projMap.set(Number(p.id), Number(existing.id));
        else {
          const id = db.prepare('INSERT INTO projects (name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, String(p.description ?? ''), p.status === 'archived' ? 'archived' : 'active', v(p.created_at) ?? now, v(p.updated_at) ?? now).lastInsertRowid;
          projMap.set(Number(p.id), Number(id));
          r.projects++;
        }
      }
    }
    const proj = (x: unknown) => (x === null || x === undefined ? null : (projMap.get(Number(x)) ?? null));

    for (const c of f.conversations ?? []) {
      const id = req(c.id, 'a conversation id');
      if (app.store.getConversation(id)) {
        r.skippedConversations++;
        continue;
      }
      const str = (x: unknown) => (x === undefined || x === null || x === '' ? null : String(x));
      db.prepare('INSERT INTO conversations (id, title, provider_id, model, workspace, mode, private, channel, channel_key, partner, project_id, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        String(c.title ?? 'Imported conversation').slice(0, 120),
        // Providers are per-server: imported chats use this server's default.
        null,
        null,
        /^[A-Za-z0-9._-]{1,64}$/.test(String(c.workspace ?? '')) ? String(c.workspace) : 'main',
        c.mode === 'coding' ? 'coding' : 'chat',
        // Private stays private (local models only, no web tools); anything but an explicit 0 is private.
        c.private === undefined || c.private === null || Number(c.private) === 0 ? 0 : 1,
        str(c.channel) ?? 'web',
        str(c.channel_key),
        // A partner chat (someone else talking to her) must not come back as an owner chat.
        str(c.partner),
        proj(c.project_id),
        str(c.archived_at),
        v(c.created_at) ?? now,
        v(c.updated_at) ?? now,
      );
      // Phase 22: tags come along (cleaned; bad ones are dropped).
      if (c.tags) {
        try {
          const tags = cleanTags(JSON.parse(String(c.tags)));
          if (tags.length) db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
        } catch {
          /* not tags */
        }
      }
      convImported.add(id);
      r.conversations++;
      const pairs: [number, number][] = [];
      msgPairs.set(id, pairs);
      for (const m of c.messages ?? []) {
        const role = String(m.role);
        if (!['user', 'assistant', 'tool', 'notice', 'system'].includes(role)) continue;
        const res = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?)').run(id, role, String(m.content ?? ''), v(m.created_at) ?? now, v(m.meta));
        msgMap.set(Number(m.id), Number(res.lastInsertRowid));
        pairs.push([Number(m.id), Number(res.lastInsertRowid)]);
        r.messages++;
      }
    }

    // Phase 44: her library first, so notes learned from a document stay linked to it.
    const docMap = new Map<number, number>();
    if (app.library && Array.isArray(f.library)) {
      r.documents = 0;
      for (const d of f.library) {
        if (!d || !Array.isArray(d.passages) || !d.passages.length) continue;
        const before = app.library.list().length;
        docMap.set(Number(d.id), app.library.importDoc({ name: String(d.name ?? 'document'), kind: d.kind ?? null, title: d.title ?? null, summary: d.summary ?? null, overview: typeof d.overview === 'string' ? d.overview : null, addedAt: d.addedAt, passages: d.passages.map((p) => ({ place: String(p.place ?? ''), heading: p.heading ?? null, text: String(p.text ?? '') })), sections: Array.isArray(d.sections) ? d.sections : [] }));
        if (app.library.list().length > before) r.documents++;
      }
    }
    if (app.memory) {
      const mapId = (x: unknown) => (x === null || x === undefined ? null : (msgMap.get(Number(x)) ?? null));
      const memMap = new Map<number, number>();
      const superseded: [number, number][] = [];
      for (const m of f.memories ?? []) {
        const conv = m.conversation_id === null || m.conversation_id === undefined ? null : String(m.conversation_id);
        // Memories tied to a conversation we skipped already exist here (same export source).
        if (conv && !convImported.has(conv) && app.store.getConversation(conv)) {
          const same = db.prepare('SELECT id FROM memories WHERE conversation_id = ? AND kind = ? AND content = ? ORDER BY id LIMIT 1').get(conv, String(m.kind), String(m.content ?? '')) as Row | undefined;
          if (same) memMap.set(Number(m.id), Number(same.id));
          continue;
        }
        const keepConv = conv && convImported.has(conv) ? conv : null;
        // Every known kind comes back as itself (dates keep their day, promises whether kept).
        const kind = MEMORY_KINDS.includes(String(m.kind) as MemoryKind) ? String(m.kind) : 'fact';
        const content = req(m.content, 'memory text');
        if (!keepConv) {
          // A note not tied to an imported chat (yours, or from a chat that isn't here): skip it if it's already here.
          const same = db.prepare('SELECT id FROM memories WHERE kind = ? AND content = ? AND on_date IS ? ORDER BY id LIMIT 1').get(kind, content, v(m.on_date)) as Row | undefined;
          if (same) {
            memMap.set(Number(m.id), Number(same.id));
            continue;
          }
        }
        const res = db.prepare(
          'INSERT INTO memories (kind, content, conversation_id, source_message_id, source_from_id, happened_on, evidence, edited, created_at, updated_at, on_date, resolved_at, source_doc_id, mentioned_on, pinned, last_used_on, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          kind,
          content,
          keepConv,
          keepConv ? mapId(m.source_message_id) : null,
          keepConv ? mapId(m.source_from_id) : null,
          String(m.happened_on ?? now.slice(0, 10)),
          v(m.evidence),
          Number(m.edited ?? 0),
          v(m.created_at) ?? now,
          v(m.updated_at) ?? now,
          v(m.on_date),
          v(m.resolved_at),
          m.source_doc_id === null || m.source_doc_id === undefined ? null : (docMap.get(Number(m.source_doc_id)) ?? null),
          v(m.mentioned_on),
          // Phase 76: pinned, last used, uses (absent in older export files).
          Number(m.pinned ?? 0) ? 1 : 0,
          v(m.last_used_on),
          Math.max(0, Math.round(Number(m.use_count ?? 0)) || 0),
        );
        const newId = Number(res.lastInsertRowid);
        memMap.set(Number(m.id), newId);
        if (m.superseded_by !== null && m.superseded_by !== undefined) superseded.push([newId, Number(m.superseded_by)]);
        r.memories++;
      }
      // Second pass: notes marked outdated stay outdated, pointing at the (remapped) newer note.
      for (const [newId, oldBy] of superseded) {
        const by = memMap.get(oldBy);
        // The newer note isn't in the file: keep it marked outdated (pointing at itself) rather than current.
        app.memory.supersede(newId, by ?? newId);
      }
      const pairsReady = new Set<string>();
      for (const st of f.memoryState ?? []) {
        const conv = String(st.conversation_id);
        if (!convImported.has(conv)) continue;
        // Highest imported message at or below the old position.
        const pairs = msgPairs.get(conv) ?? [];
        if (!pairsReady.has(conv)) {
          // Sort by old id and keep the running highest new id, so each lookup is one binary search.
          pairs.sort((x, y) => x[0] - y[0]);
          for (let i = 1; i < pairs.length; i++) pairs[i][1] = Math.max(pairs[i][1], pairs[i - 1][1]);
          pairsReady.add(conv);
        }
        const limit = Number(st.summarized_through);
        let lo = 0;
        let hi = pairs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (pairs[mid][0] <= limit) lo = mid + 1;
          else hi = mid;
        }
        app.memory.setState(conv, { summarizedThrough: lo > 0 ? pairs[lo - 1][1] : 0, lastError: null });
      }
    }

    if (app.planner) {
      const conv = (x: unknown) => (x && app.store.getConversation(String(x)) ? String(x) : null);
      for (const t of f.tasks ?? []) {
        const title = req(t.title, 'a task title');
        const created = v(t.created_at) ?? now;
        if (db.prepare('SELECT 1 FROM tasks WHERE title = ? AND created_at = ? AND due_at IS ? AND project_id IS ?').get(title, created, v(t.due_at), proj(t.project_id))) continue;
        db.prepare('INSERT INTO tasks (project_id, title, notes, status, priority, due_at, created_at, updated_at, done_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          proj(t.project_id),
          title,
          String(t.notes ?? ''),
          t.status === 'done' ? 'done' : 'open',
          ['low', 'normal', 'high'].includes(String(t.priority)) ? String(t.priority) : 'normal',
          v(t.due_at),
          created,
          v(t.updated_at) ?? now,
          v(t.done_at),
          conv(t.conversation_id),
        );
        r.tasks++;
      }
      for (const n of f.notes ?? []) {
        const title = String(n.title ?? 'Note');
        const body = String(n.body ?? '');
        const created = v(n.created_at) ?? now;
        if (db.prepare('SELECT 1 FROM notes WHERE title = ? AND body = ? AND created_at = ?').get(title, body, created)) continue;
        db.prepare('INSERT INTO notes (project_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(proj(n.project_id), title, body, created, v(n.updated_at) ?? now);
        r.notes++;
      }
      // Saved places (same name here: that one is used), so place reminders keep their place.
      const placeMap = new Map<number, number>();
      r.places = 0;
      for (const pl of f.places ?? []) {
        const name = String(pl.name ?? '').trim();
        if (!name) continue;
        const existing = app.planner.placeByName(name);
        if (existing) {
          placeMap.set(Number(pl.id), existing.id);
          continue;
        }
        try {
          placeMap.set(Number(pl.id), app.planner.savePlace({ name, lat: Number(pl.lat), lon: Number(pl.lon), radius: Number(pl.radius ?? 150) }).id);
          r.places++;
        } catch {
          /* bad coordinates or name: skip the place (its reminders are skipped too) */
        }
      }
      for (const rem of f.reminders ?? []) {
        if (rem.status !== 'pending') continue;
        const text = req(rem.text, 'reminder text');
        const due = req(rem.due_at, 'a reminder time');
        let placeId: number | null = null;
        let placeEvent: string | null = null;
        if (rem.place_id !== null && rem.place_id !== undefined) {
          placeId = placeMap.get(Number(rem.place_id)) ?? null;
          // A place reminder whose place isn't in the file could never fire: leave it out.
          if (placeId === null) continue;
          placeEvent = rem.place_event === 'leave' ? 'leave' : 'arrive';
        }
        const created = v(rem.created_at) ?? now;
        if (db.prepare("SELECT 1 FROM reminders WHERE status = 'pending' AND text = ? AND due_at = ? AND created_at = ? AND place_id IS ?").get(text, due, created, placeId)) continue;
        db.prepare('INSERT INTO reminders (text, due_at, repeat, conversation_id, status, created_at, fired, call, place_id, place_event, anchor_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          text,
          due,
          ['none', 'daily', 'weekdays', 'weekly', 'monthly'].includes(String(rem.repeat)) ? String(rem.repeat) : 'none',
          conv(rem.conversation_id),
          'pending',
          created,
          Number(rem.fired ?? 0),
          Number(rem.call ?? 0) ? 1 : 0,
          placeId,
          placeEvent,
          Number.isInteger(Number(rem.anchor_day)) && Number(rem.anchor_day) >= 1 && Number(rem.anchor_day) <= 31 ? Number(rem.anchor_day) : null,
        );
        r.reminders++;
      }
    }
    // Phase 50: recipes (one already here with the same title, steps and date is skipped).
    if (app.recipes && Array.isArray(f.recipes)) {
      r.recipes = 0;
      for (const rc of f.recipes) {
        const title = String(rc.title ?? '').trim().slice(0, 120);
        const steps = String(rc.steps ?? '').trim().slice(0, 12_000);
        if (!title || !steps) continue;
        const created = v(rc.created_at) ?? now;
        if (db.prepare('SELECT 1 FROM recipes WHERE title = ? AND steps = ? AND created_at = ?').get(title, steps, created)) continue;
        let tags: string[] = [];
        try {
          tags = cleanRecipeTags(JSON.parse(String(rc.tags ?? '[]')));
        } catch {
          tags = [];
        }
        const ws = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(rc.workspace ?? '')) ? String(rc.workspace) : null;
        const src = rc.source_conversation_id && app.store.getConversation(String(rc.source_conversation_id)) ? String(rc.source_conversation_id) : null;
        db.prepare('INSERT INTO recipes (title, when_to_use, steps, workspace, tags, created_at, updated_at, uses, last_used_at, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          title,
          String(rc.when_to_use ?? '').slice(0, 400),
          steps,
          ws,
          JSON.stringify(tags),
          created,
          v(rc.updated_at) ?? created,
          Math.max(0, Math.floor(Number(rc.uses ?? 0)) || 0),
          v(rc.last_used_at),
          src,
        );
        r.recipes++;
      }
    }
    // Phase 37: shared lists (same title on the same list is skipped).
    if (app.together) {
      r.sharedItems = 0;
      for (const it of f.sharedItems ?? []) {
        const list = String(it.list);
        const title = String(it.title ?? '').trim().slice(0, 200);
        if (!['music', 'reading', 'watch'].includes(list) || !title) continue;
        if (db.prepare('SELECT 1 FROM shared_items WHERE list = ? AND lower(title) = lower(?)').get(list, title)) continue;
        db.prepare('INSERT INTO shared_items (list, title, note, added_by, added_at, done_at) VALUES (?, ?, ?, ?, ?, ?)').run(list, title, v(it.note), it.added_by === 'her' ? 'her' : 'owner', v(it.added_at) ?? now, v(it.done_at));
        r.sharedItems++;
      }
    }
    // Phase 52: usage records (ones already here are skipped).
    if (app.usage && Array.isArray(f.usage)) r.usage = app.usage.importRows(f.usage, (id) => Boolean(app.store.getConversation(id)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const s = app.settings.get();
  // Phase 52: the owner's prices are added where this server has none for that model; the job
  // budget only when none is set here.
  if (Array.isArray(f.prices) && f.prices.length) {
    try {
      const mine = s.prices ?? [];
      const add = cleanPrices(f.prices).filter((pr) => !mine.some((m) => m.model.toLowerCase() === pr.model.toLowerCase() && (m.providerId ?? '') === (pr.providerId ?? '')));
      if (add.length) app.settings.update({ prices: [...mine, ...add] });
      r.prices = add.length;
    } catch {
      r.prices = 0;
    }
  }
  if (f.jobBudget && !(s.jobBudget?.tokens || s.jobBudget?.usd)) {
    const b = cleanBudget(f.jobBudget);
    if (b.tokens || b.usd) app.settings.update({ jobBudget: b });
  }
  // L10: team limits come back unless this server has its own already.
  if (f.teamLimits && typeof f.teamLimits === 'object' && !(s.teamLimits && Object.keys(s.teamLimits).length)) {
    const l = cleanLimits(f.teamLimits);
    app.settings.update({ teamLimits: { minutes: l.minutes, tokens: l.tokens, steps: l.steps, ...(l.usd ? { usd: l.usd } : {}) } });
  }
  // Phase 79: per-reply budgets come back unless this server has its own already.
  if (f.turnBudgets && typeof f.turnBudgets === 'object' && !(s.turnBudgets && Object.keys(s.turnBudgets).length)) {
    app.settings.update({ turnBudgets: turnBudgetSettings({ turnBudgets: f.turnBudgets }) });
  }
  if ((!s.ownerName && f.owner?.ownerName) || (!s.timeZone && f.owner?.timeZone)) {
    app.settings.update({ ...(!s.ownerName && f.owner?.ownerName ? { ownerName: f.owner.ownerName } : {}), ...(!s.timeZone && f.owner?.timeZone ? { timeZone: f.owner.timeZone } : {}) });
  }
  return r;
}
