// Phase 50: recipes. After a tricky job goes well she can write down how she did it ("deploy this
// app", "fix the flaky tests"): a title, when to use it, and the steps. At the start of a coding
// turn the recipes that fit the request (and the workspace) are named in her instructions, so she
// finds and follows them next time. Saving asks the owner first by default; the owner can read,
// edit and delete them in Settings → Add-ons → Recipes. Kept per companion, in her database
// (so backups and export carry them).
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { cosine, embedTarget, type EmbedTarget, embedTexts } from './embeddings.ts';
import { ftsQuery } from './memory.ts';
import { num, str, ToolError, type Tool } from './tools/types.ts';
import { WORKSPACE_NAME_RE } from './tools/workspace.ts';

export const MAX_TITLE = 120;
export const MAX_WHEN = 400;
export const MAX_STEPS = 12_000;
/** Recipes named in her instructions per coding turn. */
export const TURN_RECIPES = 2;
/** Meaning-search floor for recipes (nomic-embed-text). */
export const RECIPE_MIN_SCORE = 0.55;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  when_to_use TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL,
  workspace TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  source_conversation_id TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(title, when_to_use, steps, tags, content='recipes', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS recipes_ai AFTER INSERT ON recipes BEGIN
  INSERT INTO recipes_fts(rowid, title, when_to_use, steps, tags) VALUES (new.id, new.title, new.when_to_use, new.steps, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS recipes_ad AFTER DELETE ON recipes BEGIN
  INSERT INTO recipes_fts(recipes_fts, rowid, title, when_to_use, steps, tags) VALUES ('delete', old.id, old.title, old.when_to_use, old.steps, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS recipes_au AFTER UPDATE OF title, when_to_use, steps, tags ON recipes BEGIN
  INSERT INTO recipes_fts(recipes_fts, rowid, title, when_to_use, steps, tags) VALUES ('delete', old.id, old.title, old.when_to_use, old.steps, old.tags);
  INSERT INTO recipes_fts(rowid, title, when_to_use, steps, tags) VALUES (new.id, new.title, new.when_to_use, new.steps, new.tags);
END;
CREATE TABLE IF NOT EXISTS recipe_vectors (
  recipe_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  sig TEXT NOT NULL,
  vec BLOB NOT NULL
);
`;

export interface Recipe {
  id: number;
  title: string;
  whenToUse: string;
  steps: string;
  /** The workspace it belongs to, or null for any. */
  workspace: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  uses: number;
  lastUsedAt: string | null;
  sourceConversationId: string | null;
}

export interface RecipeIn {
  title: string;
  whenToUse?: string;
  steps: string;
  workspace?: string | null;
  tags?: string[];
  sourceConversationId?: string | null;
}

type Row = Record<string, string | number | null>;

function toRecipe(r: Row): Recipe {
  let tags: string[] = [];
  try {
    tags = JSON.parse(String(r.tags ?? '[]')) as string[];
  } catch {
    tags = [];
  }
  return {
    id: Number(r.id),
    title: String(r.title),
    whenToUse: String(r.when_to_use ?? ''),
    steps: String(r.steps),
    workspace: (r.workspace as string | null) ?? null,
    tags,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    uses: Number(r.uses ?? 0),
    lastUsedAt: (r.last_used_at as string | null) ?? null,
    sourceConversationId: (r.source_conversation_id as string | null) ?? null,
  };
}

// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// eslint-disable-next-line no-control-regex
const block = (s: unknown, max: number) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

export function cleanTags(t: unknown): string[] {
  const list = Array.isArray(t) ? t : typeof t === 'string' ? t.split(',') : [];
  return [...new Set(list.map((x) => oneLine(x, 30).toLowerCase()).filter(Boolean))].slice(0, 10);
}

function cleanWorkspace(w: unknown): string | null {
  const s = typeof w === 'string' ? w.trim() : '';
  if (!s) return null;
  if (!WORKSPACE_NAME_RE.test(s)) throw new Error(`"${s}" isn't a workspace name.`);
  return s;
}

const sigOf = (model: string, r: Recipe) => `${model}:${createHash('sha1').update(`${r.title}\n${r.whenToUse}\n${r.steps}`).digest('hex').slice(0, 12)}`;

export class RecipeStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.#now = now;
    db.exec(SCHEMA);
  }

  get(id: number): Recipe | undefined {
    const r = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecipe(r) : undefined;
  }

  /** Newest first (most used first among the same day is not needed: the owner sorts by title in the UI). */
  list(): Recipe[] {
    return (this.db.prepare('SELECT * FROM recipes ORDER BY updated_at DESC, id DESC').all() as Row[]).map(toRecipe);
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as { n: number }).n);
  }

  /**
   * Saves a recipe. A recipe with the same title for the same workspace is updated instead (she
   * improves her own recipe rather than writing a second one).
   */
  save(r: RecipeIn): { recipe: Recipe; updated: boolean } {
    const title = oneLine(r.title, MAX_TITLE);
    const steps = block(r.steps, MAX_STEPS);
    if (!title) throw new Error('A recipe needs a title.');
    if (!steps) throw new Error('A recipe needs its steps.');
    const when = oneLine(r.whenToUse, MAX_WHEN);
    const ws = cleanWorkspace(r.workspace);
    const tags = JSON.stringify(cleanTags(r.tags));
    const now = this.#now().toISOString();
    const same = this.db.prepare('SELECT id FROM recipes WHERE lower(title) = lower(?) AND workspace IS ?').get(title, ws) as { id: number } | undefined;
    if (same) {
      this.db.prepare('UPDATE recipes SET title = ?, when_to_use = ?, steps = ?, tags = ?, updated_at = ? WHERE id = ?').run(title, when, steps, tags, now, same.id);
      return { recipe: this.get(same.id)!, updated: true };
    }
    const id = Number(this.db.prepare('INSERT INTO recipes (title, when_to_use, steps, workspace, tags, created_at, updated_at, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(title, when, steps, ws, tags, now, now, r.sourceConversationId ?? null).lastInsertRowid);
    return { recipe: this.get(id)!, updated: false };
  }

  /** The owner's edits (title, when to use, steps, workspace, tags). */
  update(id: number, patch: Partial<RecipeIn>): Recipe | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const title = patch.title !== undefined ? oneLine(patch.title, MAX_TITLE) : cur.title;
    const steps = patch.steps !== undefined ? block(patch.steps, MAX_STEPS) : cur.steps;
    if (!title) throw new Error('A recipe needs a title.');
    if (!steps) throw new Error('A recipe needs its steps.');
    const when = patch.whenToUse !== undefined ? oneLine(patch.whenToUse, MAX_WHEN) : cur.whenToUse;
    const ws = patch.workspace !== undefined ? cleanWorkspace(patch.workspace) : cur.workspace;
    const tags = patch.tags !== undefined ? cleanTags(patch.tags) : cur.tags;
    this.db.prepare('UPDATE recipes SET title = ?, when_to_use = ?, steps = ?, workspace = ?, tags = ?, updated_at = ? WHERE id = ?').run(title, when, steps, ws, JSON.stringify(tags), this.#now().toISOString(), id);
    return this.get(id);
  }

  delete(id: number): boolean {
    this.db.prepare('DELETE FROM recipe_vectors WHERE recipe_id = ?').run(id);
    return Number(this.db.prepare('DELETE FROM recipes WHERE id = ?').run(id).changes) > 0;
  }

  /** She opened it to follow it. */
  markUsed(id: number): Recipe | undefined {
    this.db.prepare('UPDATE recipes SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(this.#now().toISOString(), id);
    return this.get(id);
  }

  #scope(workspace: string | null | undefined): { sql: string; args: string[] } {
    return workspace ? { sql: '(r.workspace IS NULL OR r.workspace = ?)', args: [workspace] } : { sql: '1', args: [] };
  }

  /** Recipes with the words (best first). */
  searchWords(text: string, opts: { workspace?: string | null; limit?: number } = {}): { recipe: Recipe; rank: number }[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const scope = this.#scope(opts.workspace);
    try {
      const rows = this.db.prepare(`SELECT r.*, bm25(recipes_fts, 4.0, 3.0, 1.0, 2.0) AS rank FROM recipes_fts JOIN recipes r ON r.id = recipes_fts.rowid WHERE recipes_fts MATCH ? AND ${scope.sql} ORDER BY rank LIMIT ?`).all(q, ...scope.args, opts.limit ?? 8) as Row[];
      return rows.map((r) => ({ recipe: toRecipe(r), rank: Number(r.rank) }));
    } catch {
      return [];
    }
  }

  /** Makes vectors for recipes without one for the model (there are few, so all at once). */
  async indexVectors(target: EmbedTarget, signal?: AbortSignal): Promise<number> {
    const have = new Map((this.db.prepare('SELECT recipe_id, sig FROM recipe_vectors').all() as { recipe_id: number; sig: string }[]).map((r) => [r.recipe_id, r.sig]));
    const todo = this.list().filter((r) => have.get(r.id) !== sigOf(target.model, r)).slice(0, 64);
    if (!todo.length) return 0;
    const doc = (t: string) => (/nomic-embed/i.test(target.model) ? `search_document: ${t}` : t);
    const vecs = await embedTexts(target, todo.map((r) => doc(`${r.title}\nWhen: ${r.whenToUse}\n${r.steps.slice(0, 1500)}`)), signal);
    const put = this.db.prepare('INSERT INTO recipe_vectors (recipe_id, model, sig, vec) VALUES (?, ?, ?, ?) ON CONFLICT(recipe_id) DO UPDATE SET model = excluded.model, sig = excluded.sig, vec = excluded.vec');
    todo.forEach((r, i) => put.run(r.id, target.model, sigOf(target.model, r), new Uint8Array(vecs[i].buffer)));
    return todo.length;
  }

  /** Recipes close in meaning (needs the embeddings job; empty on any problem or timeout). */
  async searchMeaning(target: EmbedTarget | undefined, text: string, opts: { workspace?: string | null; limit?: number; timeoutMs?: number } = {}): Promise<{ recipe: Recipe; score: number }[]> {
    if (!target || !text.trim() || !this.count()) return [];
    try {
      const signal = AbortSignal.timeout(opts.timeoutMs ?? 2500);
      await this.indexVectors(target, signal);
      const query = /nomic-embed/i.test(target.model) ? `search_query: ${text.slice(0, 2000)}` : text.slice(0, 2000);
      const [q] = await embedTexts(target, [query], signal);
      const rows = this.db.prepare('SELECT recipe_id, vec FROM recipe_vectors WHERE model = ?').all(target.model) as { recipe_id: number; vec: Uint8Array }[];
      const out: { recipe: Recipe; score: number }[] = [];
      for (const r of rows) {
        const score = cosine(q, new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)));
        if (score < RECIPE_MIN_SCORE) continue;
        const recipe = this.get(r.recipe_id);
        if (recipe && (!opts.workspace || !recipe.workspace || recipe.workspace === opts.workspace)) out.push({ recipe, score });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
    } catch {
      return [];
    }
  }

  /** Words and meaning merged by reciprocal rank; a recipe for this very workspace counts a little more. */
  async find(text: string, opts: { workspace?: string | null; limit?: number; target?: EmbedTarget; timeoutMs?: number } = {}): Promise<Recipe[]> {
    const limit = opts.limit ?? 5;
    const words = this.searchWords(text, { workspace: opts.workspace, limit: limit * 2 });
    const meaning = await this.searchMeaning(opts.target, text, { workspace: opts.workspace, limit: limit * 2, timeoutMs: opts.timeoutMs });
    const merged = new Map<number, { recipe: Recipe; score: number }>();
    const add = (recipe: Recipe, s: number) => {
      const had = merged.get(recipe.id);
      if (had) had.score += s;
      else merged.set(recipe.id, { recipe, score: s + (opts.workspace && recipe.workspace === opts.workspace ? 0.002 : 0) });
    };
    words.forEach((w, i) => add(w.recipe, 1 / (60 + i)));
    meaning.forEach((m, i) => add(m.recipe, 1 / (60 + i)));
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.recipe);
  }

  /** For export. */
  exportRows(): Row[] {
    return this.db.prepare('SELECT * FROM recipes ORDER BY id').all() as Row[];
  }
}

const brief = (r: Recipe) => `#${r.id} ${r.title}${r.workspace ? ` [${r.workspace}]` : ''}${r.whenToUse ? ` — when: ${r.whenToUse}` : ''}`;

/** The "Recipes" lines for a coding turn: up to two that fit the request, or undefined. */
export async function recipesSection(app: AppContext, workspace: string, text: string): Promise<string | undefined> {
  const store = app.recipes;
  if (!store || !text.trim() || !store.count()) return undefined;
  const found = await store.find(text, { workspace, limit: TURN_RECIPES, target: embedTarget(app), timeoutMs: 1500 }).catch(() => []);
  if (!found.length) return undefined;
  return found.map(brief).join('\n');
}

export function createRecipeTools(app: () => AppContext): Tool[] {
  const recipes = () => {
    const r = app().recipes;
    if (!r) throw new ToolError('Recipes are not available here.');
    return r;
  };
  const wsOf = (conversationId?: string) => (conversationId ? app().store.getConversation(conversationId)?.workspace : undefined);
  const notPartner = (conversationId?: string) => {
    if (conversationId && app().store.getConversation(conversationId)?.partner) throw new ToolError('Recipes are private to the owner.');
  };
  return [
    {
      // Saving asks the owner by default: the approval card is where they see what she wrote.
      defaultPermission: 'ask',
      isAvailable: () => Boolean(app().recipes),
      spec: {
        name: 'recipe_save',
        description:
          "Save how you did a tricky job as a recipe you can follow next time (e.g. 'Deploy the site', 'Fix flaky tests'). Write the steps you actually took that worked: commands, files, checks, pitfalls. Saving again with the same title updates it. The owner approves each save.",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short name, e.g. "Deploy the weather app".' },
            when_to_use: { type: 'string', description: 'One line: when this recipe applies.' },
            steps: { type: 'string', description: 'Numbered steps in Markdown (commands in backticks).' },
            workspace: { type: 'string', description: 'Optional: only for this workspace. Default: the workspace of this conversation; "any" for every workspace.' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'when_to_use', 'steps'],
          additionalProperties: false,
        },
      },
      summarize: (a) => `Save recipe “${String(a.title ?? '').slice(0, 80)}”`,
      async run(args, ctx) {
        notPartner(ctx.conversationId);
        const wsArg = str(args, 'workspace', false).trim();
        const workspace = wsArg.toLowerCase() === 'any' ? null : wsArg || wsOf(ctx.conversationId) || null;
        try {
          const r = recipes().save({ title: str(args, 'title'), whenToUse: str(args, 'when_to_use', false), steps: str(args, 'steps'), workspace, tags: Array.isArray(args.tags) ? (args.tags as string[]) : [], sourceConversationId: ctx.conversationId ?? null });
          app().events?.publish({ type: 'recipes' });
          return `${r.updated ? 'Updated' : 'Saved'} recipe #${r.recipe.id} “${r.recipe.title}”${r.recipe.workspace ? ` for workspace ${r.recipe.workspace}` : ' for any workspace'}.`;
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().recipes),
      spec: {
        name: 'recipe_find',
        description: 'Look through the recipes you saved (how you did tricky jobs before) by words and meaning. Returns ids, titles and when to use them; open one with recipe_use.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you are about to do, e.g. "deploy" or "tests fail randomly".' } }, required: ['query'], additionalProperties: false },
      },
      summarize: (a) => `Looking for a recipe: “${String(a.query ?? '').slice(0, 60)}”`,
      async run(args, ctx) {
        notPartner(ctx.conversationId);
        const store = recipes();
        const query = str(args, 'query').trim();
        const found = await store.find(query, { workspace: wsOf(ctx.conversationId) ?? null, limit: 5, target: embedTarget(app()), timeoutMs: 3000 });
        if (!found.length) return store.count() ? `No recipe fits “${query}”. (${store.count()} saved; try other words.)` : 'No recipes saved yet.';
        return `${found.map((r) => `${brief(r)} (used ${r.uses}×)`).join('\n')}\nOpen one with recipe_use (id) before following it.`;
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().recipes),
      spec: {
        name: 'recipe_use',
        description: 'Open a saved recipe to follow it (shows its steps and counts the use). Adapt the steps to what you find; if something has changed, say so and update the recipe afterwards with recipe_save.',
        parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
      },
      summarize: (a) => `Opening recipe #${String(a.id ?? '?')}`,
      async run(args, ctx) {
        notPartner(ctx.conversationId);
        const id = Math.floor(num(args, 'id', 0));
        const r = recipes().markUsed(id);
        if (!r) throw new ToolError(`No recipe #${id}. Use recipe_find to see them.`);
        return `Recipe #${r.id}: ${r.title}${r.workspace ? ` (workspace ${r.workspace})` : ''}\nWhen to use: ${r.whenToUse || '—'}\n\n${r.steps}`;
      },
    },
  ];
}
