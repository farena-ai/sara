// Phase 22: one search across everything: conversations, memories, notes, to-dos, reminders,
// scrapbook and the files in the workspaces. Every word must match (any order, any case).
// Read-only, size-limited, and quick enough to run as the owner types.
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AppContext } from './chat.ts';
import { workspacesBase } from './tools/workspace.ts';

export interface FoundItem {
  kind: 'conversation' | 'message' | 'memory' | 'note' | 'task' | 'reminder' | 'scrapbook' | 'file';
  title: string;
  snippet: string;
  /** Where it lives, for opening it. */
  conversationId?: string;
  messageId?: number;
  id?: number;
  workspace?: string;
  path?: string;
  when?: string;
}

export interface FindResults {
  conversations: FoundItem[];
  memories: FoundItem[];
  notes: FoundItem[];
  tasks: FoundItem[];
  scrapbook: FoundItem[];
  files: FoundItem[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache']);
const MAX_FILE = 512 * 1024;
const MAX_FILES_SCANNED = 3000;

export const findWords = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

const allIn = (text: string, words: string[]) => {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
};

/** A short piece of the text around the first word. */
export function snippetOf(text: string, words: string[], width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(words[0] ?? '') - 50);
  return `${at ? '…' : ''}${flat.slice(at, at + width)}${flat.length > at + width ? '…' : ''}`;
}

/** Text files in the workspaces whose name or contents match. */
export function findFiles(dataDir: string, words: string[], limit = 15): FoundItem[] {
  const root = join(dataDir, 'workspaces');
  if (!existsSync(root) || !words.length) return [];
  const out: FoundItem[] = [];
  let scanned = 0;
  const buf = Buffer.alloc(MAX_FILE);
  const walk = (ws: string, dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || scanned >= MAX_FILES_SCANNED) return;
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(ws, full);
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      const rel = relative(join(root, ws), full).replaceAll('\\', '/');
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (allIn(rel, words)) {
        out.push({ kind: 'file', title: rel, snippet: `${ws === 'main' ? '' : `${ws} · `}file name matches`, workspace: ws, path: rel, when: st.mtime.toISOString() });
        continue;
      }
      if (st.size > MAX_FILE || st.size === 0) continue;
      let n = 0;
      const fd = openSync(full, 'r');
      try {
        n = readSync(fd, buf, 0, st.size, 0);
      } finally {
        closeSync(fd);
      }
      const head = buf.subarray(0, Math.min(n, 8000));
      if (head.includes(0)) continue; // binary
      const text = buf.subarray(0, n).toString('utf8');
      if (!allIn(text, words)) continue;
      const lines = text.split('\n');
      const ln = lines.findIndex((l) => l.toLowerCase().includes(words[0]));
      out.push({ kind: 'file', title: rel, snippet: `${ws === 'main' ? '' : `${ws} · `}line ${ln + 1}: ${snippetOf(lines[ln] ?? '', words, 140)}`, workspace: ws, path: rel, when: st.mtime.toISOString() });
    }
  };
  for (const ws of readdirSync(root, { withFileTypes: true })) if (ws.isDirectory()) walk(ws.name, join(root, ws.name));
  return out;
}

export function findEverything(app: AppContext, q: string, opts: { files?: boolean } = {}): FindResults {
  const words = findWords(q);
  const empty: FindResults = { conversations: [], memories: [], notes: [], tasks: [], scrapbook: [], files: [] };
  if (!words.length) return empty;
  // Conversations: titles and messages (the existing search), plus tags.
  const convs = app.store.search(q, 30).map(
    (h): FoundItem => (h.messageId ? { kind: 'message', title: h.title, snippet: h.snippet, conversationId: h.conversationId, messageId: h.messageId, when: h.createdAt } : { kind: 'conversation', title: h.title, snippet: '', conversationId: h.conversationId, when: h.createdAt }),
  );
  const tagHits = app.store
    .listConversations()
    .filter((c) => c.tags.length && words.every((w) => c.tags.some((t) => t.includes(w.replace(/^#/, '')))) && !convs.some((x) => x.conversationId === c.id && x.kind === 'conversation'))
    .slice(0, 10)
    .map((c): FoundItem => ({ kind: 'conversation', title: c.title, snippet: c.tags.map((t) => `#${t}`).join(' '), conversationId: c.id, when: c.updatedAt }));
  const memories = (app.memory?.list({ limit: 2000 }) ?? [])
    .filter((m) => !m.supersededBy && allIn(m.content, words))
    .slice(0, 10)
    .map((m): FoundItem => ({ kind: 'memory', title: m.kind === 'summary' ? 'Conversation note' : m.kind === 'self' ? 'About her' : 'About you', snippet: snippetOf(m.content, words), id: m.id, conversationId: m.conversationId ?? undefined, when: m.happenedOn }));
  const notes = (app.planner?.notes(undefined, 1000) ?? [])
    .filter((n) => allIn(`${n.title}\n${n.body}`, words))
    .slice(0, 10)
    .map((n): FoundItem => ({ kind: 'note', title: n.title, snippet: snippetOf(n.body || n.title, words), id: n.id, when: n.updatedAt }));
  const tasks = [
    ...(app.planner?.tasks({ status: 'all' }) ?? [])
      .filter((t) => allIn(`${t.title}\n${t.notes}\n${t.project ?? ''}`, words))
      .slice(0, 10)
      .map((t): FoundItem => ({ kind: 'task', title: t.title, snippet: [t.status === 'done' ? 'done' : t.dueAt ? `due ${t.dueAt.slice(0, 10)}` : 'to-do', t.project].filter(Boolean).join(' · '), id: t.id, when: t.updatedAt })),
    ...(app.planner?.reminders({ status: 'all', limit: 500 }) ?? [])
      .filter((r) => allIn(r.text, words))
      .slice(0, 5)
      .map((r): FoundItem => ({ kind: 'reminder', title: r.text, snippet: `${r.status === 'pending' ? 'reminder' : r.status} · ${r.placeId ? 'at a place' : r.dueAt.slice(0, 10)}`, id: r.id, when: r.placeId ? r.createdAt : r.dueAt })),
  ];
  const scrapbook = (app.scrapbook?.list({ limit: 1000 }) ?? [])
    .filter((e) => allIn(`${e.text}\n${e.note ?? ''}`, words))
    .slice(0, 8)
    .map((e): FoundItem => ({ kind: 'scrapbook', title: e.note || 'Saved moment', snippet: snippetOf(e.text, words), id: e.id, conversationId: e.conversationId ?? undefined, messageId: e.messageId ?? undefined, when: e.createdAt }));
  return { conversations: [...tagHits, ...convs].slice(0, 30), memories, notes, tasks, scrapbook, files: opts.files === false ? [] : findFiles(workspacesBase(app), words) };
}
