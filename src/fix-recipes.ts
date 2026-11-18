// ROADMAP_U U3.17 (docs/SELF_REPAIR.md "Share fixes that worked"): fixes learned across linked servers.
//
//   sender    the owner turned on "Share fixes that worked" (Self-repair; off by default) and ticked friends.
//             A T1 level-1/level-2 fix that worked (run by her, the owner or a chat; never one that came from
//             a friend) or an applied T3 code change becomes a signed "fix recipe" sent once per friend over
//             the existing S9a link ('repair' scope, op 'recipe'):
//               playbook: the problem signature (problem kind or public name + the SHAPE of its evidence:
//                         numbers, times and anything quoted are masked) + the playbook fix id + her version.
//               code:     the patch (only when the scrubber leaves it unchanged), file names, test names with
//                         pass/fail (never their output), her version.
//             Never: problem texts, params, evidence values, chat or request text, names, paths of the owner.
//   receiver  stores it; shows it only when it has the same problem now (same signature, fixable) on a
//             compatible version (playbook: same major.minor; code: the exact version, and the patch must
//             fit her code unapplied). Use it = a proposal through HER engines: T1 runs her own playbook
//             for her own problem (her snapshot, verify, undo); a patch goes through T3 adopt (her protected
//             paths, test-weakening check and tests) and then waits for the normal Apply. Nothing
//             auto-applies across servers. Both help logs record recipes.
//   optional  "Send to the Sara developers": the existing hub ticket path with a scrubbed preview first.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { fileTicket, scrubText, ticketBlocked, ticketWire, type HubSpace } from './hub.ts';
import { en } from './i18n.ts';
import type { Messenger } from './messages.ts';
import { privateLocalOn } from './net-guard.ts';
import { repairFixed, repairSettings, type Problem, type Repair, type RepairRun } from './repair.ts';
import { cleanPath, parsePatch } from './self-code-rules.ts';
import { selfCodeOf, type CodeChange } from './self-code.ts';
import { SupportError, supportOf, type SupportLink } from './support.ts';

export interface Signature {
  problem: string;
  level: 1 | 2;
  shape: string[];
}
export interface RecipeCheck {
  name: string;
  ok: boolean;
  skipped?: boolean;
}
export interface Recipe {
  v: 1;
  kind: 'playbook' | 'code';
  version: string;
  at: string;
  fix?: string;
  signature?: Signature;
  patch?: string;
  files?: string[];
  checks?: RecipeCheck[];
}

const ID = /^[\w.:@/+-]{1,120}$/;
const SHAPE = /^[\w <>#×:./-]{0,60}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/;
/** Problems whose id after the kind is this server's own number or name (a job, an errand, a model service, a device). */
const KIND_ONLY = new Set(['job', 'errand', 'model', 'app']);
/** Problems whose id is a public name (an add-on package, a setting path, a tool or error kind). */
const NAMED = new Set(['addon', 'setting', 'db', 'disk', 'grow']);
const PATCH_MAX = 200_000;

/** One evidence line as a shape: times, numbers and anything else that is not a plain word are masked. */
export function shapeOf(e: unknown): string {
  const s = String(e ?? '')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<time>')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .trim();
  return SHAPE.test(s) ? s : '*';
}

/** The problem's signature (undefined: nothing to share for it). */
export function signatureOf(p: Pick<Problem, 'id' | 'level' | 'evidence' | 'fixable'>): Signature | undefined {
  if (!p.fixable || (p.level !== 1 && p.level !== 2)) return undefined;
  const kind = p.id.split(':')[0]!;
  const problem = KIND_ONLY.has(kind) ? kind : NAMED.has(kind) ? p.id : '';
  if (!problem || !ID.test(problem)) return undefined;
  return { problem, level: p.level, shape: (p.evidence ?? []).slice(0, 6).map(shapeOf) };
}

export function playbookRecipe(p: Problem, version: string, now: Date): Recipe | undefined {
  const signature = signatureOf(p);
  if (!signature) return undefined;
  return { v: 1, kind: 'playbook', version, at: now.toISOString(), fix: signature.problem.split(':')[0]!, signature };
}

const checksOf = (c: { steps?: { name: string; ok: boolean; skipped?: boolean }[] } | null | undefined): RecipeCheck[] => (c?.steps ?? []).slice(0, 8).map((s) => ({ name: String(s.name).slice(0, 20), ok: Boolean(s.ok), ...(s.skipped ? { skipped: true } : {}) }));

/** An applied code change as a recipe; undefined when the scrubber would change the patch (it looks private). */
export function codeRecipe(c: Pick<CodeChange, 'status' | 'diff' | 'files' | 'checks'>, version: string, now: Date, scrub: (s: string) => string): Recipe | undefined {
  if (c.status !== 'applied' || !c.diff || c.diff.length > PATCH_MAX) return undefined;
  if (scrub(c.diff) !== c.diff) return undefined;
  let files: string[];
  try {
    files = parsePatch(c.diff).map((f) => cleanPath(f.path));
  } catch {
    return undefined;
  }
  return { v: 1, kind: 'code', version, at: now.toISOString(), patch: c.diff, files, checks: checksOf(c.checks) };
}

const parts = (v: string) => (VERSION.test(v) ? v.split(/[-+]/)[0]!.split('.').map(Number) : undefined);
/** Playbook fixes: the same major.minor; a code patch: exactly the version it was tested on. */
export function compatible(r: Recipe, version: string): boolean {
  const a = parts(r.version);
  const b = parts(version);
  if (!a || !b) return false;
  return r.kind === 'code' ? r.version === version : a[0] === b[0] && a[1] === b[1];
}

/** The receiver's own problem with the same signature (fixable), if any. */
export function matchProblem(r: Recipe, problems: readonly Problem[]): Problem | undefined {
  const want = r.signature;
  if (r.kind !== 'playbook' || !want) return undefined;
  return problems.find((p) => {
    const s = signatureOf(p);
    return s && s.problem === want.problem && s.level === want.level && s.shape.length === want.shape.length && s.shape.every((x, i) => x === want.shape[i]);
  });
}

const bad = () => new SupportError(400, en('That fix recipe is not valid.'));
/** The receiver checks the shape itself (and drops anything else). */
export function cleanRecipe(x: unknown): Recipe {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const version = String(o.version ?? '');
  const at = String(o.at ?? '');
  if (o.v !== 1 || !VERSION.test(version) || !Number.isFinite(Date.parse(at))) throw bad();
  if (o.kind === 'playbook') {
    const s = (o.signature && typeof o.signature === 'object' ? o.signature : {}) as Record<string, unknown>;
    const problem = String(s.problem ?? '');
    const level = Number(s.level);
    const shape = Array.isArray(s.shape) ? s.shape.map(String) : null;
    const kind = problem.split(':')[0]!;
    if (!ID.test(problem) || !(KIND_ONLY.has(kind) ? problem === kind : NAMED.has(kind)) || (level !== 1 && level !== 2) || !shape || shape.length > 6 || !shape.every((v) => v === '*' || SHAPE.test(v))) throw bad();
    if (o.fix !== kind) throw bad();
    return { v: 1, kind: 'playbook', version, at, fix: kind, signature: { problem, level, shape } };
  }
  if (o.kind === 'code') {
    const patch = typeof o.patch === 'string' ? o.patch : '';
    if (!patch || patch.length > PATCH_MAX) throw bad();
    let files: string[];
    try {
      files = parsePatch(patch).map((f) => cleanPath(f.path));
    } catch {
      throw bad();
    }
    if (!files.length) throw bad();
    const checks = Array.isArray(o.checks) ? checksOf({ steps: o.checks as never }) : [];
    return { v: 1, kind: 'code', version, at, patch, files, checks };
  }
  throw bad();
}

const keyOf = (r: Recipe) => (r.kind === 'code' ? `code:${createHash('sha256').update(r.patch ?? '').digest('hex').slice(0, 32)}:${r.version}` : `fix:${r.signature!.problem}:${r.signature!.level}:${r.signature!.shape.join('|')}:${r.version.split('.').slice(0, 2).join('.')}`);

export interface RecipeDeps {
  repair(): Repair | undefined;
  selfCode(): { fits(patch: string): boolean; adopt(request: string, patch: string): { id: number } } | undefined;
  version(): string;
  settings(): Record<string, unknown>;
  privateLocal(): boolean;
  notify(title: string, body: string, link: string): void;
  hub(): HubSpace | undefined;
  scrub(s: string): string;
}
export interface RecipeView {
  id: string;
  side: 'in' | 'sent';
  link: string;
  peer: string;
  kind: Recipe['kind'];
  version: string;
  at: string;
  status: 'new' | 'used' | 'dismissed' | 'sent';
  /** in: this server's own problem (its text in her words); sent: the signature. */
  problem?: string;
  level?: number;
  text?: string;
  params?: Record<string, string | number>;
  files?: string[];
  checks?: RecipeCheck[];
  run?: number;
  change?: number;
  ticket?: string;
}

/** Open recipe stores: a fix that worked on a server's Repair goes to that server's store. */
const LIVE = new Set<FixRecipes>();
repairFixed.add((rep, run, p) => {
  for (const fr of LIVE) if (fr.deps.repair() === rep) fr.shareRun(run, p);
});

const SCHEMA = `CREATE TABLE IF NOT EXISTS fix_recipes (id TEXT PRIMARY KEY, side TEXT NOT NULL, link TEXT NOT NULL, peer TEXT NOT NULL, key TEXT NOT NULL, recipe TEXT NOT NULL, status TEXT NOT NULL, run INTEGER, change INTEGER, ticket TEXT, local TEXT, created_at TEXT NOT NULL, UNIQUE (side, link, key));`;
type Row = Record<string, unknown>;

export class FixRecipes {
  readonly #db: DatabaseSync;
  readonly #sp: SupportLink;
  readonly #now: () => Date;
  readonly deps: RecipeDeps;
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;

  constructor(o: { dataDir: string; messenger: Messenger; support: SupportLink; now: () => Date; deps: RecipeDeps }) {
    this.#db = new DatabaseSync(join(o.dataDir, 'fix-recipes.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#sp = o.support;
    this.#now = o.now;
    this.deps = o.deps;
    o.messenger.whenClosed(() => this.close());
    LIVE.add(this);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    LIVE.delete(this);
    this.#db.close();
  }
  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  #track(p: Promise<unknown>): void {
    this.#pending.add(p);
    void p.catch((err: Error) => console.warn(`fix recipes: ${err.message}`)).finally(() => this.#pending.delete(p));
  }

  /** The owner's choice (Self-repair → Share fixes that worked): off by default, and only the ticked friends. */
  share(): { on: boolean; links: string[] } {
    const s = repairSettings(this.deps.settings());
    return { on: s.share, links: s.shareLinks };
  }

  // ---- the sender ----------------------------------------------------------------------------------
  /** A T1 run that worked: share it (only her own, the owner's or a chat's; never one a friend sent). */
  shareRun(run: RepairRun, p: Problem | undefined): void {
    if (this.#closed || !p || !['fixed', 'applied'].includes(run.result) || !['auto', 'owner', 'chat'].includes(run.by)) return;
    const r = playbookRecipe(p, this.deps.version(), this.#now());
    if (r) this.#track(this.offer(r));
  }
  /** A T3 change went live: share it (never one adopted from a friend's recipe). */
  shareCode(c: CodeChange): void {
    if (this.#closed || c.status !== 'applied') return;
    if (this.#db.prepare("SELECT 1 FROM fix_recipes WHERE side = 'in' AND change = ?").get(c.id)) return;
    const r = codeRecipe(c, this.deps.version(), this.#now(), this.deps.scrub);
    if (r) this.#track(this.offer(r));
  }
  /** Sends a recipe once to each ticked friend. Returns how many got it. */
  async offer(r: Recipe): Promise<number> {
    const { on, links } = this.share();
    if (!on || this.deps.privateLocal()) return 0;
    const key = keyOf(r);
    let n = 0;
    for (const link of links) {
      if (this.#closed) break;
      let peer: string;
      try {
        peer = this.#sp.peer(link).name;
      } catch {
        continue;
      }
      if (this.#db.prepare("SELECT 1 FROM fix_recipes WHERE side = 'sent' AND link = ? AND key = ?").get(link, key)) continue;
      try {
        await this.#sp.call(link, 'recipe', r as unknown as Record<string, unknown>, 'repair');
      } catch {
        continue;
      }
      if (this.#closed) break;
      this.#db.prepare('INSERT OR IGNORE INTO fix_recipes (id, side, link, peer, key, recipe, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), 'sent', link, peer, key, JSON.stringify(r), 'sent', this.#now().toISOString());
      this.#sp.log(link, peer, 'helper', 'repair-recipe', `sent ${r.kind === 'code' ? (r.files ?? []).join(', ') : r.signature!.problem}`);
      audit({ action: 'fix-recipe.send', role: 'system', channel: 'repair-link', outcome: 'ok', target: `link:${peer}`, content: r.kind });
      this.#sp.onChange?.(link);
      n++;
    }
    return n;
  }

  // ---- the receiver ----------------------------------------------------------------------------------
  /** Peer op (signature already checked): store it; tell the owner only when it fits a problem here now. */
  async received(link: string, name: string, body: unknown): Promise<void> {
    const r = cleanRecipe(body);
    const id = randomUUID();
    const res = this.#db.prepare('INSERT OR IGNORE INTO fix_recipes (id, side, link, peer, key, recipe, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'in', link, name, keyOf(r), JSON.stringify(r), 'new', this.#now().toISOString());
    if (!res.changes) return;
    this.#sp.log(link, name, 'helped', 'repair-recipe', `received ${r.kind === 'code' ? (r.files ?? []).join(', ') : r.signature!.problem}`);
    audit({ action: 'fix-recipe.receive', who: `link:${name}`.slice(0, 80), role: 'system', channel: 'repair-link', outcome: 'pending', content: r.kind });
    if (await this.#fits(r)) this.deps.notify(name, en('Shared a fix that worked on their Sara for a problem yours has too. Self-repair shows it; nothing runs without your OK.'), link);
    this.#sp.onChange?.(link);
  }

  async #problems(): Promise<Problem[]> {
    const rep = this.deps.repair();
    if (!rep) return [];
    return rep.checkedAt() ? rep.problems() : await rep.detect().catch(() => []);
  }
  /** Same problem here now + compatible version (code: the patch fits her code unapplied). */
  async #fits(r: Recipe, problems?: Problem[]): Promise<Problem | true | undefined> {
    if (!compatible(r, this.deps.version())) return undefined;
    if (r.kind === 'code') return this.deps.selfCode()?.fits(r.patch!) ? true : undefined;
    return matchProblem(r, problems ?? (await this.#problems()));
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM fix_recipes WHERE id = ?').get(id) as Row | undefined;
  }
  #view(row: Row, hit?: Problem): RecipeView {
    const r = JSON.parse(String(row.recipe)) as Recipe;
    // A used one keeps the problem as it was shown here (it is gone from the list once fixed).
    const p = hit ?? (row.local ? (JSON.parse(String(row.local)) as Problem) : undefined);
    const side = String(row.side) as 'in' | 'sent';
    return {
      id: String(row.id),
      side,
      link: String(row.link),
      peer: String(row.peer),
      kind: r.kind,
      version: r.version,
      at: String(row.created_at),
      status: String(row.status) as RecipeView['status'],
      ...(r.kind === 'playbook' ? { problem: p?.id ?? r.signature!.problem, level: r.signature!.level } : { files: r.files ?? [], checks: r.checks ?? [] }),
      ...(p ? { text: p.text, ...(p.params ? { params: p.params } : {}) } : {}),
      ...(row.run ? { run: Number(row.run) } : {}),
      ...(row.change ? { change: Number(row.change) } : {}),
      ...(row.ticket ? { ticket: String(row.ticket) } : {}),
    };
  }

  /** Received recipes that fit this server now (and ones already used), and what this server sent. */
  async list(): Promise<{ in: RecipeView[]; sent: RecipeView[] }> {
    const problems = await this.#problems();
    const rows = this.#db.prepare('SELECT * FROM fix_recipes ORDER BY created_at DESC, rowid DESC LIMIT 100').all() as Row[];
    const out: { in: RecipeView[]; sent: RecipeView[] } = { in: [], sent: [] };
    for (const row of rows) {
      if (row.side === 'sent') {
        out.sent.push(this.#view(row));
        continue;
      }
      if (row.status === 'dismissed') continue;
      const r = JSON.parse(String(row.recipe)) as Recipe;
      if (row.status === 'used') {
        out.in.push(this.#view(row));
        continue;
      }
      const hit = await this.#fits(r, problems);
      if (hit) out.in.push(this.#view(row, hit === true ? undefined : hit));
    }
    return out;
  }

  /** The owner's OK: her own engine runs it (T1 playbook for her own problem, or T3 adopt + her tests). */
  async accept(id: string): Promise<RecipeView> {
    const row = this.#row(id);
    if (!row || row.side !== 'in') throw new SupportError(404, en('Not found'));
    if (row.status !== 'new') throw new SupportError(409, en('Already answered.'));
    const r = JSON.parse(String(row.recipe)) as Recipe;
    const peer = String(row.peer);
    const hit = await this.#fits(r);
    if (!hit) throw new SupportError(409, en('That fix does not match a problem on this Sara (any more), or it was made for another version.'));
    if (r.kind === 'playbook') {
      const rep = this.deps.repair();
      if (!rep || hit === true) throw new SupportError(409, en('Self-repair is not on here.'));
      const runs = await rep.fix(hit.id, { by: `link:${peer}` });
      const run = runs[0];
      this.#db.prepare("UPDATE fix_recipes SET status = 'used', run = ?, local = ? WHERE id = ?").run(run?.id ?? null, JSON.stringify({ id: hit.id, text: hit.text, ...(hit.params ? { params: hit.params } : {}) }), id);
      this.#sp.log(String(row.link), peer, 'helped', 'repair-recipe', `used: ${hit.id} ${run?.result ?? ''}`.trim());
      audit({ action: 'fix-recipe.use', role: 'owner', outcome: run && ['fixed', 'applied'].includes(run.result) ? 'ok' : 'failed', target: hit.id });
      return this.#view(this.#row(id)!, hit);
    }
    const sc = this.deps.selfCode();
    if (!sc) throw new SupportError(409, en('This install can’t change its own code.'));
    const ch = sc.adopt(`A code fix shared by ${peer}’s Sara (${(r.files ?? []).join(', ')})`.slice(0, 2000), r.patch!);
    this.#db.prepare("UPDATE fix_recipes SET status = 'used', change = ? WHERE id = ?").run(ch.id, id);
    this.#sp.log(String(row.link), peer, 'helped', 'repair-recipe', `used: code change #${ch.id}`);
    audit({ action: 'fix-recipe.use', role: 'owner', outcome: 'pending', target: `code:${ch.id}` });
    return this.#view(this.#row(id)!);
  }
  dismiss(id: string): void {
    const row = this.#row(id);
    if (!row || row.side !== 'in') throw new SupportError(404, en('Not found'));
    this.#db.prepare("UPDATE fix_recipes SET status = 'dismissed' WHERE id = ?").run(id);
  }

  // ---- optional: the Sara developers (the existing hub ticket path) -----------------------------------------
  #ticket(id: string): { kind: string; title: string; body: string; diagnostics?: Record<string, unknown> } {
    const row = this.#row(id);
    if (!row) throw new SupportError(404, en('Not found'));
    const r = JSON.parse(String(row.recipe)) as Recipe;
    const lines = [`A fix that worked on a Sara (${row.side === 'sent' ? 'here' : 'shared by a linked Sara'}).`, `Version: ${r.version}`];
    if (r.kind === 'playbook') lines.push(`Problem: ${r.signature!.problem} (level ${r.signature!.level})`, `Evidence shape: ${r.signature!.shape.join('; ') || '-'}`, `Fix: the built-in ${r.fix} playbook`);
    else lines.push(`Files: ${(r.files ?? []).join(', ')}`, `Checks: ${(r.checks ?? []).map((c) => `${c.name} ${c.skipped ? 'skipped' : c.ok ? 'passed' : 'failed'}`).join(', ') || 'none'}`);
    const title = r.kind === 'playbook' ? `Self-repair fix that worked: ${r.signature!.problem}` : `Self-repair code fix that worked: ${(r.files ?? []).join(', ')}`.slice(0, 120);
    return { kind: 'bug', title, body: lines.join('\n'), ...(r.kind === 'code' ? { diagnostics: { error: r.patch!.slice(0, 16_000) } } : {}) };
  }
  /** Exactly what "Send to the Sara developers" sends (scrubbed; nothing is sent by this). */
  preview(id: string): ReturnType<typeof ticketWire> {
    const t = this.#ticket(id);
    const h = this.deps.hub();
    const f = h?.facts();
    const scrub = (s: string) => (h ? h.scrub(s) : this.deps.scrub(s));
    return ticketWire({ kind: t.kind, title: scrub(t.title), body: scrub(t.body), ...(f ? { lang: f.lang, version: f.version, os: f.os } : {}), ...(t.diagnostics ? { diagnostics: { error: scrub(String(t.diagnostics.error)) } as never } : {}) });
  }
  async report(id: string): Promise<{ ticket: string }> {
    const h = this.deps.hub();
    if (!h || h.member) throw new SupportError(409, en('Reports are not available here.'));
    const t = this.#ticket(id);
    if (ticketBlocked(h)) throw new SupportError(409, en('Reports cannot be sent now (private local mode, the demo, or the network guard).'));
    const r = await fileTicket(h, t, this.#now());
    if (!r.ok) throw new SupportError(502, r.reason ?? en("The Sara developers' desk didn't take the report. Try again later."));
    this.#db.prepare('UPDATE fix_recipes SET ticket = ? WHERE id = ?').run(r.ticket, id);
    audit({ action: 'fix-recipe.report', role: 'owner', outcome: 'ok', target: r.ticket });
    return { ticket: r.ticket };
  }
}

let VERSION_HERE: string | undefined;
export function versionHere(): string {
  if (VERSION_HERE === undefined) {
    try {
      VERSION_HERE = String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? '');
    } catch {
      VERSION_HERE = '';
    }
  }
  return VERSION_HERE;
}

const cache = new WeakMap<Messenger, FixRecipes>();
/** The owner's fix recipes (undefined for members, kid mode and the demo: they have no Messenger). */
export function fixRecipesOf(app: AppContext): FixRecipes | undefined {
  const m = app.messages;
  const sp = supportOf(app);
  if (!m || !sp || app.member) return undefined;
  let r = cache.get(m);
  if (!r) {
    const deps: RecipeDeps = {
      repair: () => app.repair,
      selfCode: () => {
        const sc = selfCodeOf(app) as unknown as { status(): { available: boolean }; fits(p: string): boolean; adopt(q: string, p: string): { id: number } } | undefined;
        try {
          return sc && sc.status().available && typeof sc.adopt === 'function' ? sc : undefined;
        } catch {
          return undefined;
        }
      },
      version: versionHere,
      settings: () => app.settings.get() as unknown as Record<string, unknown>,
      privateLocal: () => privateLocalOn(),
      notify: (title, body, link) => m.onNotify?.(title, body, link),
      hub: () => (app as { hub?: HubSpace }).hub,
      scrub: (s) => ((app as { hub?: HubSpace }).hub?.scrub ?? ((x: string) => scrubText(x, (y) => y)))(s),
    };
    cache.set(m, (r = new FixRecipes({ dataDir: app.dataDir, messenger: m, support: sp, now: () => app.now(), deps })));
  }
  return r;
}
