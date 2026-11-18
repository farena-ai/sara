// U3.16 (docs/AGENT_TEAMS.md "Team recipes"): a team run's plan kept for next time. After a run
// finishes, "Save as a team recipe" keeps the plan's SHAPE only: the helpers (kind, name,
// instructions, model = Auto unless pinned, tools, budget, computer tick), the parts and what each
// waits for, the checker's rules (its instructions) and the result type. The job text becomes the
// placeholder {job}; a new run fills it. Never kept: findings, reports, receipts, actions, the log,
// results, and anything the redactor sees as a secret. A recipe is checked again (cleanRunPlan) when
// it is saved, edited, imported and used, so a recipe can never carry a hard-limit tool, and a run
// from one still waits for the person's one plan approval.
//
// Table (additive, the owner's store.db): team_recipes (one row per recipe; the plan as JSON).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { cleanRunPlan, type RunPlan, type RunRole, type RunStepPlan, type TeamRun } from './team-runs.ts';

export const RECIPE_KIND = 'sara-team-recipe';
export const JOB = '{job}';
export interface RecipePlan {
  roles: RunRole[];
  steps: RunStepPlan[];
  deliver: RunPlan['deliver'];
}
export interface TeamRecipe {
  id: number;
  name: string;
  description: string;
  plan: RecipePlan;
  uses: number;
  createdAt: string;
  updatedAt: string;
}
/** The shareable JSON (no ids, counts or dates). */
export interface RecipeJson {
  kind: typeof RECIPE_KIND;
  version: 1;
  name: string;
  description: string;
  plan: RecipePlan;
}

export class TeamRecipeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const FINISHED = new Set(['done', 'waiting', 'failed', 'limit', 'stopped', 'interrupted']);
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !NOISE.has(w));
const NOISE = new Set(['my', 'the', 'use', 'run', 'with', 'team', 'recipe', 'start', 'from', 'our', 'a', 'an', 'please', 'get']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Row = Record<string, string | number | null>;

export class TeamRecipes {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS team_recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
  }

  #view(r: Row): TeamRecipe {
    return { id: Number(r.id), name: String(r.name), description: String(r.description), plan: JSON.parse(String(r.plan)) as RecipePlan, uses: Number(r.uses), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }

  list(): TeamRecipe[] {
    return (this.#db.prepare('SELECT * FROM team_recipes ORDER BY lower(name)').all() as Row[]).map((r) => this.#view(r));
  }

  get(id: number): TeamRecipe | undefined {
    const r = this.#db.prepare('SELECT * FROM team_recipes WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  #must(id: number): TeamRecipe {
    const r = this.get(id);
    if (!r) throw new TeamRecipeError(404, en('No such team recipe.'));
    return r;
  }

  #name(raw: unknown, except?: number): string {
    const name = String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (name.length < 2) throw new TeamRecipeError(400, en('Give the recipe a name.'));
    if (this.list().some((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase())) throw new TeamRecipeError(409, en('A team recipe with this name already exists.'));
    return name;
  }

  #free(base: string, suffix: (n: number) => string): string {
    const taken = new Set(this.list().map((r) => r.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 1; ; n++) {
      const name = `${base.slice(0, 50)}${suffix(n)}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  /**
   * A plan made safe for keeping: checked like any plan (known tools, never a hard-limit tool),
   * the job text swapped for {job}, every text through the redactor, nothing of the run's results.
   */
  #shape(raw: unknown, o: { goal?: string; imported?: boolean }): RecipePlan {
    const app = this.#app;
    let plan: RunPlan;
    try {
      plan = cleanRunPlan(app, raw, { private: false, fromModel: o.imported === true, goal: JOB });
    } catch (err) {
      throw new TeamRecipeError(400, (err as Error).message);
    }
    const goal = (o.goal ?? '').trim();
    const re = goal.length >= 4 ? new RegExp(escapeRe(goal), 'gi') : null;
    const txt = (s: string) => app.redactor.redact(re ? s.replace(re, JOB) : s);
    return {
      roles: plan.roles.map((r) => ({ id: r.id, name: txt(r.name), kind: r.kind, instructions: txt(r.instructions), model: r.model, tools: r.tools, computer: o.imported ? false : r.computer, budget: r.budget })),
      steps: plan.steps.map((s) => ({ id: s.id, role: s.role, title: txt(s.title), instructions: txt(s.instructions), after: s.after })),
      deliver: { kind: plan.deliver.kind, format: plan.deliver.format, title: txt(plan.deliver.title) },
    };
  }

  #insert(name: string, description: string, plan: RecipePlan): TeamRecipe {
    const now = this.#app.now().toISOString();
    const id = Number(this.#db.prepare('INSERT INTO team_recipes (name, description, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, this.#app.redactor.redact(description.trim().slice(0, 300)), JSON.stringify(plan), now, now).lastInsertRowid);
    return this.get(id)!;
  }

  /** "Save as a team recipe" on a finished run. */
  saveFromRun(runId: number, o: { name: unknown; description?: unknown }): TeamRecipe {
    const run: TeamRun | undefined = this.#app.teamRuns?.get(runId);
    if (!run) throw new TeamRecipeError(404, en('No such team run.'));
    if (!FINISHED.has(run.status)) throw new TeamRecipeError(409, en('Save a recipe after the run has finished.'));
    const name = this.#name(o.name);
    return this.#insert(name, String(o.description ?? ''), this.#shape(run.plan, { goal: run.goal }));
  }

  update(id: number, patch: { name?: unknown; description?: unknown; plan?: unknown }): TeamRecipe {
    const cur = this.#must(id);
    const name = patch.name === undefined ? cur.name : this.#name(patch.name, id);
    const description = patch.description === undefined ? cur.description : this.#app.redactor.redact(String(patch.description).trim().slice(0, 300));
    const plan = patch.plan === undefined ? cur.plan : this.#shape(patch.plan, {});
    this.#db.prepare('UPDATE team_recipes SET name = ?, description = ?, plan = ?, updated_at = ? WHERE id = ?').run(name, description, JSON.stringify(plan), this.#app.now().toISOString(), id);
    return this.get(id)!;
  }

  duplicate(id: number): TeamRecipe {
    const cur = this.#must(id);
    return this.#insert(this.#free(`${cur.name} (copy)`, (n) => ` (copy ${n + 1})`), cur.description, cur.plan);
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM team_recipes WHERE id = ?').run(id).changes) > 0;
  }

  exportJson(id: number): RecipeJson {
    const r = this.#must(id);
    return { kind: RECIPE_KIND, version: 1, name: r.name, description: r.description, plan: r.plan };
  }

  /** Someone's shared recipe: checked like her own proposals (no computer tick, unknown tools and models dropped). */
  importJson(raw: unknown): TeamRecipe {
    const j = (raw ?? {}) as Partial<RecipeJson>;
    if (j.kind !== RECIPE_KIND || j.version !== 1) throw new TeamRecipeError(400, en('This is not a Sara team recipe.'));
    const plan = this.#shape(j.plan, { imported: true });
    const base = String(j.name ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 55) || 'Imported recipe';
    return this.#insert(this.#free(this.#app.redactor.redact(base), (n) => ` (${n + 1})`), String(j.description ?? ''), plan);
  }

  /** A recipe by id or by name as said in a chat ("use my product comparison team"). */
  find(q: string | number): TeamRecipe | undefined {
    if (typeof q === 'number' || /^\d+$/.test(String(q).trim())) return this.get(Number(q));
    const want = words(String(q));
    if (!want.length) return undefined;
    let best: { r: TeamRecipe; score: number } | undefined;
    for (const r of this.list()) {
      const have = words(r.name);
      if (!have.length) continue;
      const shared = have.filter((w) => want.includes(w)).length;
      // Every word of the name said, or every word said is in the name.
      if (shared === have.length || shared === want.length) {
        const score = shared / Math.max(have.length, want.length);
        if (!best || score > best.score) best = { r, score };
      }
    }
    return best?.r;
  }

  /** The recipe's plan for a new job ({job} filled in), counted as one use. */
  planFor(id: number, goal: string): Record<string, unknown> {
    const r = this.#must(id);
    this.#db.prepare('UPDATE team_recipes SET uses = uses + 1 WHERE id = ?').run(id);
    const fill = (s: string) => s.split(JOB).join(goal);
    return {
      roles: r.plan.roles.map((x) => ({ ...x, name: fill(x.name), instructions: fill(x.instructions) })),
      steps: r.plan.steps.map((s) => ({ ...s, title: fill(s.title), instructions: fill(s.instructions) })),
      deliver: { ...r.plan.deliver, title: fill(r.plan.deliver.title) },
    };
  }
}

/** Server words the recipe routes use (so the extractor sees them). */
export const TEAM_RECIPE_LINES = [en('No such team recipe.')];
