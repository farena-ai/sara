// Phase 105 (MI2, docs/design/MOVE_IN.md §8): custom stores as mapping cards. After a bundle is read,
// every store (stores/<id>/ with reader "custom") is profiled and split into families; each family is
// one card. "Ask her" makes one model call per family (secret-scrubbed samples, sensitive values
// masked, values cut to 300 chars; a fixed-menu JSON answer validated in code, retried once with the
// errors), or, without a usable model, the no-model guess. The owner confirms or skips every card;
// a confirmed card runs the mapper into staging and is saved by its fingerprint, so a later bundle of
// the same shape maps itself without model calls (§8.5). Nothing imports from an unconfirmed card.
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveChain, type AppContext } from '../chat.ts';
import { isCloudModelName } from '../model-names.ts';
import { askModel } from '../security/pass.ts';
import type { Conversation } from '../store.ts';
import { billingOf, costOf, findPrice, priceTable } from '../usage.ts';
import type { Bundle } from './bundle.ts';
import { cardKey, type MapResult, previewMapping, runMapping } from './custom.ts';
import { type FamilyMapping, guessMapping, maskSample, mappingPrompt, normMapping, parseAnswer, validate } from './mapping.ts';
import type { Row } from './readers/common.ts';
import { type Family, fingerprint, profileStore, type StoreProfile, type StoreSchemaFile, type TableProfile } from './schema.ts';
import type { Staging } from './staging.ts';
import { categoryOf } from './text.ts';

export type CardState = 'new' | 'proposing' | 'proposed' | 'failed' | 'mapping' | 'confirmed' | 'skipped';
export interface Card {
  key: string;
  store: string;
  family: Family;
  state: CardState;
  mapping?: FamilyMapping;
  /** Who made the mapping on the card. */
  by?: 'model' | 'guess' | 'saved' | 'owner';
  model?: string;
  errors?: string[];
  warnings?: string[];
  /** What the mapper made of the first rows (the sample cards). */
  preview?: Awaited<ReturnType<typeof previewMapping>>;
  /** After confirm: findings staged, by section. */
  staged?: Record<string, number>;
  result?: Pick<MapResult, 'made' | 'dropped' | 'joinCheck' | 'rowsRead'>;
  progress?: { table: string; done: number; total: number };
  savedAt?: string;
  line?: string;
  /** The owner pulled a telemetry table back in (its own card). */
  pulled?: boolean;
}

const routeConv = (localOnly: boolean) => ({ id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: localOnly, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '', updatedAt: '' }) as unknown as Conversation;

/** The additive migration for saved mappings (§8.5). */
export function ensureMappingTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS movein_mappings (
    fingerprint TEXT PRIMARY KEY, store_label TEXT NOT NULL, family TEXT NOT NULL, mapping_json TEXT NOT NULL,
    confirmed_at TEXT NOT NULL, tables_json TEXT)`);
}
export interface SavedMapping {
  fingerprint: string;
  storeLabel: string;
  family: string;
  mapping: FamilyMapping;
  confirmedAt: string;
  tables: { name: string; columns: string[] }[];
}
export function savedMappings(db: DatabaseSync): SavedMapping[] {
  ensureMappingTable(db);
  return (db.prepare('SELECT * FROM movein_mappings ORDER BY confirmed_at DESC').all() as Record<string, string>[]).map((r) => ({ fingerprint: r.fingerprint, storeLabel: r.store_label, family: r.family, mapping: JSON.parse(r.mapping_json) as FamilyMapping, confirmedAt: r.confirmed_at, tables: r.tables_json ? (JSON.parse(r.tables_json) as SavedMapping['tables']) : [] }));
}
export function saveMapping(db: DatabaseSync, m: SavedMapping): void {
  ensureMappingTable(db);
  db.prepare('INSERT INTO movein_mappings (fingerprint, store_label, family, mapping_json, confirmed_at, tables_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET store_label = excluded.store_label, family = excluded.family, mapping_json = excluded.mapping_json, confirmed_at = excluded.confirmed_at, tables_json = excluded.tables_json').run(m.fingerprint, m.storeLabel.slice(0, 200), m.family.slice(0, 200), JSON.stringify(m.mapping), m.confirmedAt, JSON.stringify(m.tables));
}
export function deleteMapping(db: DatabaseSync, fp: string): boolean {
  ensureMappingTable(db);
  return Number(db.prepare('DELETE FROM movein_mappings WHERE fingerprint = ?').run(fp).changes) > 0;
}

export interface CardsDeps {
  app: AppContext;
  staging: Staging;
  bundle: () => Promise<Bundle>;
  /** A scratch database file for the mapper's joins (deleted after each run). */
  scratchPath: string;
  publish: () => void;
}

export class StoreCards {
  readonly #d: CardsDeps;
  #busy: Promise<void> = Promise.resolve();
  #abort?: AbortController;

  constructor(d: CardsDeps) {
    this.#d = d;
  }

  get stores(): StoreProfile[] {
    return this.#d.staging.meta<StoreProfile[]>('stores') ?? [];
  }
  get cards(): Card[] {
    return this.#d.staging.meta<Card[]>('cards') ?? [];
  }
  /** MI3: stores recognised as copies of another store in this bundle (mapped once). */
  get copies(): StoreCopy[] {
    return this.#d.staging.meta<StoreCopy[]>('storeCopies') ?? [];
  }
  #setCards(cards: Card[]): void {
    this.#d.staging.setMeta('cards', cards);
    this.#d.publish();
  }
  #patch(key: string, p: Partial<Card>): Card | undefined {
    const cards = this.cards;
    const c = cards.find((x) => x.key === key);
    if (!c) return undefined;
    Object.assign(c, p);
    for (const k of Object.keys(p) as (keyof Card)[]) if (p[k] === undefined) delete c[k];
    this.#setCards(cards);
    return c;
  }

  /** §8.1: profiles + families for every custom store of the bundle; saved mappings re-run at once (§7.5, §8.5). */
  async discover(b: Bundle, signal?: AbortSignal): Promise<void> {
    const all = b.manifest.items.filter((it) => (it.kind === 'sqlite' || it.kind === 'postgres') && it.reader === 'custom').map((it) => it.path);
    // MI3: copies of one store (backups, probe and round-trip copies) are recognised by their
    // fingerprint and mapped once; the copies are listed (left behind), never turned into cards.
    const { keep: paths, copies } = await duplicateStores(b, all);
    this.#d.staging.setMeta('storeCopies', copies);
    const stores: StoreProfile[] = [];
    for (const p of paths) {
      if (signal?.aborted) break;
      const s = await profileStore(b, p, signal);
      if (s) stores.push(s);
    }
    this.#d.staging.setMeta('stores', stores);
    const cards: Card[] = stores.flatMap((s) => s.families.map((f) => ({ key: cardKey(s.id, f.id), store: s.id, family: f, state: 'new' as CardState })));
    this.#setCards(cards);
    const saved = new Map(savedMappings(this.#d.app.store.db).map((m) => [m.fingerprint, m]));
    for (const c of cards) {
      const m = saved.get(c.family.fingerprint);
      if (m) await this.#confirm(c.key, m.mapping, 'saved', m.confirmedAt);
    }
  }

  #storeOf(c: Card): StoreProfile {
    const s = this.stores.find((x) => x.id === c.store);
    if (!s) throw new Error('That store is gone.');
    return s;
  }
  #tablesOf(c: Card, s = this.#storeOf(c)): TableProfile[] {
    return c.family.tables.map((k) => s.tables.find((t) => t.key === k)!).filter(Boolean);
  }

  /** What the cards cost to propose with the model (§8.4: one call per family, no calls for the rows). */
  estimate(localOnly: boolean): { calls: number; inputTokens: number; outputTokens: number; model: { label: string; local: boolean; usd: number | null } | null; problem?: string } {
    const todo = this.cards.filter((c) => c.state === 'new' || c.state === 'failed');
    let input = 0;
    for (const c of todo) input += Math.ceil(mappingPrompt(c.family, this.#tablesOf(c), this.#samplesFor(c)).length / 3.5);
    const out = todo.length * 1000;
    const m = this.#chain(localOnly);
    if ('problem' in m) return { calls: todo.length, inputTokens: input, outputTokens: out, model: null, problem: m.problem };
    const { provider, model } = m.chain[0];
    const billing = billingOf(provider.config);
    const usd = costOf(billing, findPrice(priceTable(this.#d.app.settings.get().prices), provider.config.id, model), { input, output: out });
    return { calls: todo.length, inputTokens: input, outputTokens: out, model: { label: `${provider.config.label} · ${model}`, local: billing === 'local', usd: usd === null ? null : Math.round(usd * 100) / 100 } };
  }

  #chain(localOnly: boolean): { chain: ReturnType<typeof resolveChain> } | { problem: string } {
    try {
      const chain = resolveChain(this.#d.app, routeConv(localOnly), 'background');
      const first = chain[0];
      if (!first) return { problem: 'No model is set up for this yet.' };
      if (localOnly && (!first.provider.config.local || isCloudModelName(first.model))) return { problem: 'No model on your own hardware is set up for this.' };
      return { chain };
    } catch {
      return { problem: localOnly ? 'No model on your own hardware is set up for this.' : 'No model is set up for this yet.' };
    }
  }

  /** Masked samples for the prompt and the card (secrets scrubbed, held values masked, ≤ 300 chars). */
  #samplesFor(c: Card, chosen: Set<string> = new Set()): Map<string, Row[]> {
    const scrub = (s: string) => this.#d.app.redactor.redact(s);
    return new Map(this.#tablesOf(c).map((t) => [t.key, t.samples.map((r) => maskSample(r, t, scrub, chosen, categoryOf))]));
  }
  /** The card's sample rows as shown on screen (same masking as the prompt). */
  samples(key: string, chosen: Set<string> = new Set()): Record<string, Row[]> {
    const c = this.cards.find((x) => x.key === key);
    return c ? Object.fromEntries(this.#samplesFor(c, chosen)) : {};
  }

  /** "Ask her": proposals for the cards not decided yet, one model call per family (background). */
  propose(opts: { keys?: string[]; localOnly?: boolean; useModel?: boolean; schemaOnly?: boolean } = {}): void {
    const keys = new Set(opts.keys?.length ? opts.keys : this.cards.filter((c) => c.state === 'new' || c.state === 'failed' || c.state === 'proposed').map((c) => c.key));
    for (const k of keys) this.#patch(k, { state: 'proposing', line: 'Waiting for her' });
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#busy = this.#busy.then(async () => {
      for (const k of keys) {
        if (signal.aborted) {
          this.#patch(k, { state: 'new', line: undefined });
          continue;
        }
        try {
          await this.#proposeOne(k, opts, signal);
        } catch (err) {
          this.#patch(k, { state: 'failed', line: (err as Error).message, errors: [(err as Error).message] });
        }
      }
    });
  }
  stop(): void {
    this.#abort?.abort();
  }
  /** Waits until proposals and mapper runs are done (tests, the batch). */
  async idle(): Promise<void> {
    for (let i = 0; i < 3; i++) await this.#busy;
  }

  async #proposeOne(key: string, opts: { localOnly?: boolean; useModel?: boolean; schemaOnly?: boolean }, signal: AbortSignal): Promise<void> {
    const c = this.cards.find((x) => x.key === key);
    if (!c) return;
    const tables = this.#tablesOf(c);
    let mapping: FamilyMapping | undefined;
    let by: Card['by'] = 'guess';
    let model: string | undefined;
    let errors: string[] = [];
    let warnings: string[] = [];
    const m = opts.useModel === false ? { problem: 'no model' } : this.#chain(opts.localOnly !== false);
    if ('chain' in m) {
      this.#patch(key, { line: 'She is reading the tables' });
      const prompt = mappingPrompt(c.family, tables, opts.schemaOnly ? null : this.#samplesFor(c));
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: prompt }];
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        const r = await askModel(m.chain, messages as never, 1500, signal).catch((err: Error) => ({ text: '', model: '', error: err.message }));
        model = r.model || model;
        const raw = parseAnswer(r.text);
        if (!raw) {
          errors = ['error' in r ? `The model didn't answer: ${String(r.error).slice(0, 160)}` : "The answer wasn't the JSON asked for."];
        } else {
          const cand = normMapping(raw, c.family);
          const v = validate(cand, tables);
          errors = v.errors;
          warnings = v.warnings;
          if (!v.errors.length) {
            mapping = cand;
            by = 'model';
            break;
          }
          mapping = cand;
        }
        // Retried once with the errors (§8.3).
        messages.push({ role: 'assistant', content: r.text.slice(0, 6000) }, { role: 'user', content: `That mapping has problems:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again with only the corrected JSON.` });
      }
      if (by !== 'model') {
        // Her answer didn't pass twice. Sara's own guess from the names is the starting point: shown as a
        // proposal (with her problems as a warning) when it passes the same checks, otherwise "I couldn't
        // map this; pick by hand".
        const g = guessMapping(c.family, tables);
        const v = validate(g, tables);
        const said = `Her answer didn't pass the checks (${(errors[0] ?? 'no answer').slice(0, 160)}).`;
        const usable = !v.errors.length && g.tables.some((x) => x.target !== 'skip');
        this.#patch(key, usable ? { state: 'proposed', mapping: g, by: 'guess', model, errors: [], warnings: [...v.warnings, `${said} This is Sara's own guess from the names.`], line: undefined } : { state: 'failed', mapping: g, by: 'guess', model, errors: errors.length ? errors : ["I couldn't map this"], warnings: v.warnings, line: "I couldn't map this; pick by hand" });
        await this.#renderPreview(key);
        return;
      }
    } else {
      mapping = guessMapping(c.family, tables);
      const v = validate(mapping, tables);
      errors = v.errors;
      warnings = [...v.warnings, ...(opts.useModel === false ? [] : [`${m.problem} This is Sara's own guess from the names.`])];
      by = 'guess';
    }
    this.#patch(key, { state: errors.length ? 'failed' : 'proposed', mapping, by, model, errors, warnings, line: errors.length ? "I couldn't map this; pick by hand" : undefined });
    await this.#renderPreview(key);
  }

  async #renderPreview(key: string): Promise<void> {
    const c = this.cards.find((x) => x.key === key);
    if (!c?.mapping) return;
    const db = new DatabaseSync(':memory:');
    try {
      const pv = await previewMapping(await this.#d.bundle(), this.#storeOf(c), c.family, c.mapping, db, { scrub: (s) => this.#d.app.redactor.redact(s), now: this.#d.app.now() });
      this.#patch(key, { preview: pv });
    } finally {
      db.close();
    }
  }

  /** The hand edit (§8.3: the same menu, no SQL box): validated and rendered before it can be confirmed. */
  async edit(key: string, raw: unknown): Promise<Card> {
    const c = this.cards.find((x) => x.key === key);
    if (!c) throw new Error('No such card.');
    if (c.state === 'mapping' || c.state === 'proposing') throw new Error('Wait for this card to finish.');
    const mapping = normMapping(raw, c.family);
    const v = validate(mapping, this.#tablesOf(c));
    this.#patch(key, { mapping, by: 'owner', errors: v.errors, warnings: v.warnings, state: v.errors.length ? 'failed' : 'proposed', line: undefined });
    await this.#renderPreview(key);
    return this.cards.find((x) => x.key === key)!;
  }

  /** Looks right: the mapper runs over all rows into staging (streamed), and the mapping is saved. */
  async confirm(key: string): Promise<Card> {
    const c = this.cards.find((x) => x.key === key);
    if (!c) throw new Error('No such card.');
    if (!c.mapping) throw new Error('This card has no mapping yet. Ask her, or pick by hand.');
    const v = validate(c.mapping, this.#tablesOf(c));
    if (v.errors.length) throw new Error(`This mapping has problems: ${v.errors.slice(0, 3).join('; ')}`);
    this.#patch(key, { state: 'mapping', line: 'Mapping the rows' });
    this.#busy = this.#busy.then(() => this.#confirm(key, c.mapping!, c.by === 'saved' ? 'saved' : (c.by ?? 'owner'))).catch(() => undefined);
    return this.cards.find((x) => x.key === key)!;
  }

  async #confirm(key: string, mapping: FamilyMapping, by: Card['by'], savedAt?: string): Promise<void> {
    const c = this.cards.find((x) => x.key === key);
    if (!c) return;
    const st = this.#d.staging;
    const store = this.#storeOf(c);
    st.clearCard(key);
    this.#patch(key, { state: 'mapping', mapping, by, line: 'Mapping the rows' });
    for (const x of ['', '-wal', '-shm', '-journal']) rmSync(this.#d.scratchPath + x, { force: true });
    const db = new DatabaseSync(this.#d.scratchPath);
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;');
    this.#abort ??= new AbortController();
    let lastTick = 0;
    try {
      const r = await runMapping({
        b: await this.#d.bundle(),
        store,
        family: c.family,
        mapping,
        db,
        emit: (f) => st.add(f),
        ctx: { scrub: (s) => this.#d.app.redactor.redact(s), now: this.#d.app.now() },
        signal: this.#abort.signal,
        progress: (table, done, total) => {
          if (Date.now() - lastTick < 400 && done < total) return;
          lastTick = Date.now();
          this.#patch(key, { progress: { table, done, total }, line: `${table} ${done.toLocaleString('en')} / ${total.toLocaleString('en')}` });
        },
      });
      st.flush();
      const app = this.#d.app;
      st.settle({ already: () => false, alreadyRef: () => false, existing: (text) => (app.memory ? app.memory.search(text, 5).map((x) => ({ id: x.memory.id, content: x.memory.content })) : []), card: key });
      const savedTime = savedAt ?? app.now().toISOString();
      saveMapping(app.store.db, { fingerprint: c.family.fingerprint, storeLabel: store.label, family: c.family.title, mapping, confirmedAt: savedTime, tables: this.#tablesOf(c, store).map((t) => ({ name: t.key, columns: t.columns.map((x) => x.name) })) });
      this.#patch(key, { state: 'confirmed', staged: st.cardCounts(key), result: { made: r.made, dropped: r.dropped, joinCheck: r.joinCheck, rowsRead: r.rowsRead }, progress: undefined, line: undefined, savedAt: savedTime });
    } catch (err) {
      st.clearCard(key);
      this.#patch(key, { state: 'failed', errors: [(err as Error).message], progress: undefined, line: (err as Error).message });
    } finally {
      db.close();
      for (const x of ['', '-wal', '-shm', '-journal']) rmSync(this.#d.scratchPath + x, { force: true });
    }
  }

  /** Skip: nothing from this family imports (its staged rows go). */
  skip(key: string): Card {
    const c = this.cards.find((x) => x.key === key);
    if (!c) throw new Error('No such card.');
    if (c.state === 'mapping') throw new Error('Wait for this card to finish.');
    this.#d.staging.clearCard(key);
    return this.#patch(key, { state: 'skipped', staged: undefined, line: undefined })!;
  }
  /** Back to undecided (its staged rows go). */
  reset(key: string): Card {
    const c = this.cards.find((x) => x.key === key);
    if (!c) throw new Error('No such card.');
    if (c.state === 'mapping') throw new Error('Wait for this card to finish.');
    this.#d.staging.clearCard(key);
    return this.#patch(key, { state: c.mapping ? 'proposed' : 'new', staged: undefined, result: undefined })!;
  }

  /** §8.2: the owner pulls a skipped telemetry table back in (only when its rows were packed). */
  pull(store: string, table: string): Card {
    const s = this.stores.find((x) => x.id === store);
    const t = s?.tables.find((x) => x.key === table);
    if (!s || !t) throw new Error('No such table.');
    if (t.verdict !== 'telemetry') throw new Error('Only tables skipped as logs or telemetry can be pulled back in.');
    if (!t.packed) throw new Error(`The collector packed no rows of ${t.name}. Run it again with --include-table ${s.label}:${t.name}.`);
    const stores = this.stores;
    const tt = stores.find((x) => x.id === store)!.tables.find((x) => x.key === table)!;
    tt.verdict = 'data';
    tt.why = 'pulled back in by you';
    const fam: Family = { id: `pulled-${t.name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60), title: t.name, tables: [t.key], fingerprint: `pulled:${s.fingerprint}:${t.key}` };
    stores.find((x) => x.id === store)!.families.push(fam);
    this.#d.staging.setMeta('stores', stores);
    const card: Card = { key: cardKey(store, fam.id), store, family: fam, state: 'new', pulled: true };
    this.#setCards([...this.cards.filter((x) => x.key !== card.key), card]);
    return card;
  }

  /** The cards for the page (with their masked sample rows) and the per-store skipped lists. */
  view(chosen: Set<string> = new Set()): { stores: Record<string, unknown>[]; cards: Record<string, unknown>[]; copies: StoreCopy[] } {
    const stores = this.stores.map((s) => {
      const by = (v: string) => s.tables.filter((t) => t.verdict === v).map((t) => ({ key: t.key, name: t.name, rows: t.rows, why: t.why, packed: t.packed > 0, signals: t.telemetry }));
      return { id: s.id, label: s.label, kind: s.kind, tables: s.tables.length, families: s.families.length, telemetry: by('telemetry'), left: s.tables.filter((t) => !['data', 'telemetry'].includes(t.verdict)).map((t) => ({ key: t.key, name: t.name, rows: t.rows, verdict: t.verdict, why: t.why })) };
    });
    const cards = this.cards.map((c) => {
      const s = this.stores.find((x) => x.id === c.store);
      const smp = this.samples(c.key, chosen);
      return {
        ...c,
        storeLabel: s?.label ?? c.store,
        storeKind: s?.kind ?? 'sqlite',
        tables: (s ? this.#tablesOf(c, s) : []).map((t) => ({ key: t.key, name: t.name, schema: t.schema ?? null, rows: t.rows, packed: t.packed, newest: t.newest, cats: t.cats, columns: t.columns.map((x) => ({ name: x.name, type: x.type, observed: x.observed, date: x.date ?? null, id: x.looksId })), fks: t.fks, samples: (smp[t.key] ?? []).slice(0, 3) })),
      };
    });
    return { stores, cards, copies: this.copies };
  }

  /** Cards the owner still has to decide (the report's "needs you"). */
  undecided(): Card[] {
    return this.cards.filter((c) => c.state !== 'confirmed' && c.state !== 'skipped');
  }
  busy(): boolean {
    return this.cards.some((c) => c.state === 'proposing' || c.state === 'mapping');
  }
}

/** A copy of another store in the same bundle (same tables and columns): mapped once, listed here. */
export interface StoreCopy {
  path: string;
  label: string;
  /** The store that is mapped instead. */
  of: string;
  ofLabel: string;
  rows: number;
}

const COPY_HINT = /(^|[^a-z])(copy|copies|backup|bak|probe|roundtrip|round[-_]trip|rt|snapshot|snap|old|orig|tmp|temp|test|dup|clone|mirror|\d{6,}|\d{4}-\d{2}-\d{2})([^a-z]|$)/i;

/**
 * Groups a bundle's custom stores by fingerprint (sorted table + column names). In each group the
 * store kept is the one whose name doesn't look like a copy, then the one with the most rows; the
 * others are copies when their name looks like a copy or their row counts equal the kept store's.
 * Same-shaped stores with different data and ordinary names stay separate.
 */
export async function duplicateStores(b: Bundle, paths: string[]): Promise<{ keep: string[]; copies: StoreCopy[] }> {
  const info: { path: string; label: string; fp: string; rows: number; sig: string }[] = [];
  for (const p of paths) {
    let schema: StoreSchemaFile | undefined;
    try {
      schema = JSON.parse(await b.text(`${p}schema.json`, 64 * 1024 * 1024)) as StoreSchemaFile;
    } catch {
      schema = undefined;
    }
    const src = b.manifest.items.find((it) => it.path === p)?.source ?? p;
    const tables = (schema?.tables ?? []).map((t) => ({ name: t.schema ? `${t.schema}.${t.name}` : t.name, columns: t.columns.map((c) => c.name), rows: t.rows ?? 0 }));
    info.push({ path: p, label: src.split('/').filter(Boolean).slice(-2).join('/'), fp: tables.length ? fingerprint(tables) : `none:${p}`, rows: tables.reduce((n, t) => n + Math.max(0, t.rows), 0), sig: tables.map((t) => `${t.name}=${t.rows}`).sort().join(',') });
  }
  const groups = new Map<string, typeof info>();
  for (const i of info) groups.set(i.fp, [...(groups.get(i.fp) ?? []), i]);
  const keep: string[] = [];
  const copies: StoreCopy[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      keep.push(g[0].path);
      continue;
    }
    const ranked = [...g].sort((x, y) => Number(COPY_HINT.test(x.label.split('/').at(-1)!)) - Number(COPY_HINT.test(y.label.split('/').at(-1)!)) || y.rows - x.rows || x.label.length - y.label.length);
    const main = ranked[0];
    keep.push(main.path);
    for (const o of ranked.slice(1)) {
      if (COPY_HINT.test(o.label.split('/').at(-1)!) || o.sig === main.sig || o.rows === 0) copies.push({ path: o.path, label: o.label, of: main.path, ofLabel: main.label, rows: o.rows });
      else keep.push(o.path);
    }
  }
  return { keep: paths.filter((p) => keep.includes(p)), copies };
}
