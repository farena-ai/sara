// D3 Live canvas in chat (docs/design/LIVE_CANVAS.md): small interactive views she posts in a chat
// (a checklist, a table, a chart, or a small page she wrote) that stay current with their source:
// her own data, the Planner's to-dos, or one data name of a kept My app.
//
// Security model: the same as V3.1 My apps (src/my-apps.ts), through the same door.
// - Address: /myapp/<space>/cv<128-bit token>/… . The token is the only key; Sara's session cookie
//   and bearer are never read here. A removed canvas answers 404 like a token that never existed.
// - Every response carries APP_CSP (CSP sandbox without allow-same-origin, connect-src 'self'), and
//   the chat frames it with sandbox="allow-scripts": an opaque origin, so its script can't read the
//   chat page, Sara's cookies, storage or API.
// - What the frame may do: read its own state, tick a checklist row (a `tasks` row can only be one
//   the source lists), and save its own data when the source is `own`. Model-written HTML is static,
//   capped and gets only the small helper (web/canvas-frame.js); nothing she wrote runs on the server.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { HttpError, readJson, readRaw, send } from './http.ts';
import { en, enf, trOwner } from './i18n.ts';
import { APP_HEADERS, myAppsFor, MyApps, mySpaceDir } from './my-apps.ts';

export const CANVAS_LIMITS = {
  canvases: 200,
  items: 100,
  rows: 200,
  columns: 12,
  cell: 200,
  title: 80,
  htmlBytes: 200 * 1024,
  dataBytes: 64 * 1024,
};
export const CANVAS_KINDS = ['checklist', 'table', 'chart', 'html'] as const;
export type CanvasKind = (typeof CANVAS_KINDS)[number];
export type CanvasSource = { type: 'own' } | { type: 'tasks'; project?: string } | { type: 'app'; app: string; key: string };
export type CanvasItem = { id: string; text: string; done: boolean };
export type CanvasBar = { label: string; value: number };
type ChartMap = { label?: string; value?: string; type?: 'bar' | 'line' };
/** What a canvas keeps of its own (only what its kind uses). */
type Own = { items?: CanvasItem[]; next?: number; columns?: string[]; rows?: string[][]; bars?: CanvasBar[]; data?: unknown };

export class CanvasError extends Error {}
const fail = (m: string): never => {
  throw new CanvasError(m);
};

export interface CanvasView {
  id: number;
  kind: CanvasKind;
  title: string;
  source: CanvasSource;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The frame's address (only for the person's own page; never stored in a chat card). */
  openPath: string;
}
export interface CanvasPost {
  kind: CanvasKind;
  title: unknown;
  items?: unknown[];
  columns?: unknown[];
  rows?: unknown[];
  bars?: unknown[];
  chart?: ChartMap;
  html?: unknown;
  data?: unknown;
  source?: Partial<CanvasSource> & { type?: string };
  conversationId?: string | null;
}
export interface CanvasPatch {
  title?: unknown;
  items?: unknown[];
  add?: unknown[];
  check?: unknown[];
  uncheck?: unknown[];
  remove?: unknown[];
  columns?: unknown[];
  rows?: unknown[];
  bars?: unknown[];
  html?: unknown;
  data?: unknown;
}

type Row = { id: number | bigint; kind: string; title: string; source: string; own: string; html: string | null; chart: string | null; token: string; conversation: string | null; created: string; updated: string };

const OPEN = new Map<string, CanvasStore>();
const TOKEN_RE = /^cv[A-Za-z0-9_-]{22}$/;
/** A canvas address token (the My apps door hands these to serveCanvas). */
export const isCanvasToken = (s: string | undefined): boolean => TOKEN_RE.test(s ?? '');
const clip = (v: unknown, n: number = CANVAS_LIMITS.cell): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const cellOf = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? clip(JSON.stringify(v)) : clip(v));

function cleanSource(s: CanvasPost['source']): CanvasSource {
  const type = String(s?.type ?? 'own');
  if (type === 'own') return { type: 'own' };
  if (type === 'tasks') {
    const project = clip((s as { project?: unknown }).project, 80);
    return project ? { type: 'tasks', project } : { type: 'tasks' };
  }
  if (type === 'app') {
    const app = clip((s as { app?: unknown }).app, 80);
    const key = String((s as { key?: unknown }).key ?? '').trim();
    if (!app || !/^[A-Za-z0-9._-]{1,64}$/.test(key)) fail(en('An app source needs the app name and one of its data names (letters, digits, . _ -).'));
    return { type: 'app', app, key };
  }
  return fail(en('The source is own (your data), tasks (Planner to-dos) or app (a kept app\'s data).'));
}

function itemsOf(list: unknown[] | undefined, start: number): { items: CanvasItem[]; next: number } {
  let next = start;
  const items: CanvasItem[] = [];
  for (const x of list ?? []) {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : { text: x };
    const text = clip(o.text ?? o.title ?? o.name, CANVAS_LIMITS.cell);
    if (!text) continue;
    items.push({ id: `i${next++}`, text, done: o.done === true || o.checked === true });
  }
  return { items, next };
}

/** A table from rows of arrays or objects (with columns, or the objects' keys). */
function tableOf(columns: unknown[] | undefined, rows: unknown[] | undefined): { columns: string[]; rows: string[][] } {
  let cols = (columns ?? []).map((c) => clip(c, 60)).filter(Boolean);
  const list = rows ?? [];
  if (!cols.length) {
    const keys: string[] = [];
    for (const r of list) if (r && typeof r === 'object' && !Array.isArray(r)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    cols = keys.map((k) => clip(k, 60));
    if (!cols.length) {
      const width = Math.max(0, ...list.map((r) => (Array.isArray(r) ? r.length : 1)));
      cols = Array.from({ length: width }, (_, i) => String.fromCharCode(65 + i));
    }
  }
  cols = cols.slice(0, CANVAS_LIMITS.columns);
  const out: string[][] = [];
  for (const r of list.slice(0, CANVAS_LIMITS.rows)) {
    if (Array.isArray(r)) out.push(cols.map((_, i) => cellOf(r[i])));
    else if (r && typeof r === 'object') out.push(cols.map((c) => cellOf((r as Record<string, unknown>)[c])));
    else out.push([cellOf(r), ...cols.slice(1).map(() => '')]);
  }
  return { columns: cols, rows: out };
}

/** Bars from {label, value} rows, objects with a mapping, or a {name: number} map. */
function barsOf(v: unknown, map: ChartMap = {}): CanvasBar[] {
  const out: CanvasBar[] = [];
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : NaN);
  if (Array.isArray(v)) {
    for (const r of v.slice(0, CANVAS_LIMITS.rows)) {
      if (Array.isArray(r)) {
        const value = num(r[1]);
        if (Number.isFinite(value)) out.push({ label: clip(r[0], 60), value });
        continue;
      }
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const keys = Object.keys(o);
      const lk = map.label ?? ('label' in o ? 'label' : keys.find((k) => typeof o[k] === 'string'));
      const vk = map.value ?? ('value' in o ? 'value' : keys.find((k) => k !== lk && Number.isFinite(num(o[k]))));
      const value = vk ? num(o[vk]) : NaN;
      if (lk && Number.isFinite(value)) out.push({ label: clip(o[lk], 60), value });
    }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v).slice(0, CANVAS_LIMITS.rows)) if (Number.isFinite(num(x))) out.push({ label: clip(k, 60), value: num(x) });
  }
  return out;
}

function checkSize(own: Own): void {
  if ((own.items?.length ?? 0) > CANVAS_LIMITS.items) fail(enf('A checklist may have at most {n} items.', { n: CANVAS_LIMITS.items }));
  if ((own.rows?.length ?? 0) > CANVAS_LIMITS.rows) fail(enf('A table may have at most {n} rows.', { n: CANVAS_LIMITS.rows }));
  if (Buffer.byteLength(JSON.stringify(own)) > CANVAS_LIMITS.dataBytes) fail(enf('That is too much for a live view (at most {n} KB of data).', { n: CANVAS_LIMITS.dataBytes / 1024 }));
}
function cleanHtml(v: unknown): string {
  const html = String(v ?? '');
  if (!html.trim()) fail(en('An html view needs its page (html).'));
  if (Buffer.byteLength(html) > CANVAS_LIMITS.htmlBytes) fail(enf('The page is too big (at most {n} KB).', { n: CANVAS_LIMITS.htmlBytes / 1024 }));
  return html;
}

export class CanvasStore {
  readonly space: string;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  private constructor(spaceDir: string, space: string, now: () => Date) {
    this.space = space;
    this.#now = now;
    const dir = join(spaceDir, 'canvas');
    mkdirSync(dir, { recursive: true });
    this.#db = new DatabaseSync(join(dir, 'canvas.db'));
    this.#db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS canvases (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, own TEXT NOT NULL, html TEXT, chart TEXT, token TEXT NOT NULL UNIQUE, conversation TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);`);
  }
  static open(spaceDir: string, space: string, now: () => Date = () => new Date()): CanvasStore {
    let s = OPEN.get(spaceDir);
    if (!s) OPEN.set(spaceDir, (s = new CanvasStore(spaceDir, space, now)));
    return s;
  }
  static closeFor(spaceDir: string): void {
    const s = OPEN.get(spaceDir);
    if (!s) return;
    OPEN.delete(spaceDir);
    try {
      s.#db.close();
    } catch {
      /* closed */
    }
  }
  static exists(spaceDir: string): boolean {
    return OPEN.has(spaceDir) || existsSync(join(spaceDir, 'canvas', 'canvas.db'));
  }

  #row(id: number): Row | undefined {
    return this.#db.prepare('SELECT * FROM canvases WHERE id = ?').get(id) as Row | undefined;
  }
  #need(ref: unknown): Row {
    const s = String(ref ?? '').trim().replace(/^#/, '');
    if (/^\d+$/.test(s)) {
      const r = this.#row(Number(s));
      if (r) return r;
    }
    const byTitle = (this.#db.prepare('SELECT * FROM canvases ORDER BY id DESC').all() as Row[]).find((r) => r.title.toLowerCase() === s.toLowerCase());
    return byTitle ?? fail(enf('There is no live view "{name}". canvas_list shows them.', { name: s }));
  }
  #view(r: Row): CanvasView {
    return {
      id: Number(r.id),
      kind: r.kind as CanvasKind,
      title: r.title,
      source: JSON.parse(r.source) as CanvasSource,
      conversationId: r.conversation,
      createdAt: r.created,
      updatedAt: r.updated,
      openPath: `/myapp/${this.space}/${r.token}/`,
    };
  }

  list(): CanvasView[] {
    return (this.#db.prepare('SELECT * FROM canvases ORDER BY updated DESC, id DESC').all() as Row[]).map((r) => this.#view(r));
  }
  get(id: number): CanvasView | undefined {
    const r = this.#row(id);
    return r ? this.#view(r) : undefined;
  }
  find(ref: unknown): CanvasView {
    return this.#view(this.#need(ref));
  }

  post(p: CanvasPost): CanvasView {
    const kind = String(p.kind ?? '') as CanvasKind;
    if (!CANVAS_KINDS.includes(kind)) fail(en('A live view is a checklist, table, chart or html page.'));
    const title = clip(p.title, CANVAS_LIMITS.title);
    if (!title) fail(en('A live view needs a short title.'));
    const n = (this.#db.prepare('SELECT COUNT(*) AS c FROM canvases').get() as { c: number }).c;
    if (Number(n) >= CANVAS_LIMITS.canvases) fail(enf('At most {n} live views are kept; remove one first.', { n: CANVAS_LIMITS.canvases }));
    const source = cleanSource(p.source);
    const own: Own = {};
    if (source.type === 'own') {
      if (kind === 'checklist') Object.assign(own, itemsOf(p.items, 1));
      if (kind === 'table') Object.assign(own, tableOf(p.columns, p.rows));
      if (kind === 'chart') own.bars = barsOf(p.bars ?? p.rows, p.chart);
    }
    if (kind === 'html') own.data = p.data ?? null;
    checkSize(own);
    const html = kind === 'html' ? cleanHtml(p.html) : null;
    const chart = p.chart ? JSON.stringify({ label: p.chart.label ? String(p.chart.label) : undefined, value: p.chart.value ? String(p.chart.value) : undefined, type: p.chart.type === 'line' ? 'line' : 'bar' }) : null;
    const at = this.#now().toISOString();
    const token = `cv${randomBytes(16).toString('base64url')}`;
    const id = Number(this.#db.prepare('INSERT INTO canvases (kind, title, source, own, html, chart, token, conversation, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(kind, title, JSON.stringify(source), JSON.stringify(own), html, chart, token, p.conversationId ?? null, at, at).lastInsertRowid);
    return this.#view(this.#row(id)!);
  }

  update(ref: unknown, patch: CanvasPatch): CanvasView {
    const r = this.#need(ref);
    const id = Number(r.id);
    const own = JSON.parse(r.own) as Own;
    const source = JSON.parse(r.source) as CanvasSource;
    let title = r.title;
    let html = r.html;
    let changed = false;
    if (patch.title !== undefined) {
      title = clip(patch.title, CANVAS_LIMITS.title) || fail(en('A live view needs a short title.'));
      changed = true;
    }
    const wantsData = ['items', 'add', 'check', 'uncheck', 'remove', 'columns', 'rows', 'bars'].some((k) => (patch as Record<string, unknown>)[k] !== undefined);
    if (wantsData && source.type !== 'own') fail(source.type === 'tasks' ? en('This view shows Planner to-dos: change the tasks instead (it follows them).') : enf('This view shows the app "{app}": change the app\'s data instead.', { app: source.app }));
    if (r.kind === 'checklist' && wantsData) {
      if (patch.items) Object.assign(own, itemsOf(patch.items, own.next ?? 1));
      if (patch.add) {
        const more = itemsOf(patch.add, own.next ?? 1);
        own.items = [...(own.items ?? []), ...more.items];
        own.next = more.next;
      }
      const match = (x: unknown) => {
        const s = String(x ?? '').trim().toLowerCase();
        return (i: CanvasItem) => i.id === s || i.text.toLowerCase() === s;
      };
      for (const x of patch.check ?? []) for (const i of (own.items ?? []).filter(match(x))) i.done = true;
      for (const x of patch.uncheck ?? []) for (const i of (own.items ?? []).filter(match(x))) i.done = false;
      for (const x of patch.remove ?? []) own.items = (own.items ?? []).filter((i) => !match(x)(i));
      changed = true;
    }
    if (r.kind === 'table' && (patch.rows || patch.columns)) {
      Object.assign(own, tableOf(patch.columns ?? own.columns, patch.rows ?? own.rows));
      changed = true;
    }
    if (r.kind === 'chart' && (patch.bars || patch.rows)) {
      own.bars = barsOf(patch.bars ?? patch.rows, r.chart ? (JSON.parse(r.chart) as ChartMap) : {});
      changed = true;
    }
    if (r.kind === 'html') {
      if (patch.html !== undefined) {
        html = cleanHtml(patch.html);
        changed = true;
      }
      if (patch.data !== undefined) {
        own.data = patch.data;
        changed = true;
      }
    }
    if (!changed) fail(en('Nothing to change: give a title, items to add/check/remove, rows, bars, html or data.'));
    checkSize(own);
    this.#db.prepare('UPDATE canvases SET title = ?, own = ?, html = ?, updated = ? WHERE id = ?').run(title, JSON.stringify(own), html, this.#now().toISOString(), id);
    return this.#view(this.#row(id)!);
  }

  remove(ref: unknown): void {
    this.#db.prepare('DELETE FROM canvases WHERE id = ?').run(Number(this.#need(ref).id));
  }

  /** What the frame shows now, read fresh from the source, with a short hash of it (`rev`). */
  state(app: AppContext, id: number): Record<string, any> {
    const r = this.#row(id) ?? fail(en('There is no such live view.'));
    const own = JSON.parse(r.own) as Own;
    const source = JSON.parse(r.source) as CanvasSource;
    const kind = r.kind as CanvasKind;
    const map = r.chart ? (JSON.parse(r.chart) as ChartMap) : {};
    const out: Record<string, any> = { id: Number(r.id), kind, title: r.title, source: source.type, chartType: map.type === 'line' ? 'line' : 'bar' };
    const s = app.settings.get();
    const problem = (text: string, params?: Record<string, unknown>) => (out.problem = trOwner(text, s, params));
    if (source.type === 'own') {
      if (kind === 'checklist') out.items = own.items ?? [];
      if (kind === 'table') Object.assign(out, { columns: own.columns ?? [], rows: own.rows ?? [] });
      if (kind === 'chart') out.bars = own.bars ?? [];
      if (kind === 'html') out.data = own.data ?? null;
    } else if (source.type === 'tasks') {
      const tasks = tasksOf(app, source, this.#now());
      if (!tasks) problem(en('There is no Planner project "{project}".'), { project: source.project });
      const list = tasks ?? [];
      if (kind === 'checklist') out.items = list.map((t) => ({ id: `t${t.id}`, text: t.title, done: t.status === 'done' }));
      if (kind === 'table') Object.assign(out, { columns: [trOwner(en('Task'), s), trOwner(en('Due'), s), trOwner(en('Project'), s), trOwner(en('Done'), s)], rows: list.map((t) => [t.title, t.dueAt ? t.dueAt.slice(0, 10) : '', t.project ?? '', t.status === 'done' ? '✓' : '']) });
      if (kind === 'chart') {
        const by = new Map<string, number>();
        for (const t of list) if (t.status === 'open') by.set(t.project ?? trOwner(en('No project'), s), (by.get(t.project ?? trOwner(en('No project'), s)) ?? 0) + 1);
        out.bars = [...by].map(([label, value]) => ({ label, value }));
      }
      if (kind === 'html') out.data = list.map((t) => ({ id: t.id, title: t.title, done: t.status === 'done', due: t.dueAt, project: t.project }));
    } else {
      const apps = MyApps.exists(mySpaceDir(app)) ? myAppsFor(app) : undefined;
      const kept = apps?.get(source.app);
      const value = kept ? apps!.getData(kept.id, source.key) : undefined;
      if (!kept) problem(en('There is no app "{app}" in My apps any more.'), { app: source.app });
      else if (value === undefined) problem(en('The app "{app}" has not saved "{key}" yet.'), { app: source.app, key: source.key });
      if (kind === 'checklist') out.items = Array.isArray(value) ? itemsOf(value, 1).items : [];
      if (kind === 'table') Object.assign(out, Array.isArray(value) ? tableOf(undefined, value) : value && typeof value === 'object' ? tableOf(['name', 'value'], Object.entries(value)) : { columns: [], rows: [] });
      if (kind === 'chart') out.bars = barsOf(value, map);
      if (kind === 'html') out.data = value ?? null;
    }
    out.canTick = kind === 'checklist' && source.type !== 'app' && !out.problem;
    out.canSave = kind === 'html' && source.type === 'own';
    out.rev = createHash('sha256').update(JSON.stringify(out)).digest('base64url').slice(0, 16);
    return out;
  }

  /** A checklist row ticked (or unticked) in the frame. */
  tick(app: AppContext, id: number, item: string, done: boolean): void {
    const r = this.#row(id) ?? fail(en('There is no such live view.'));
    if (r.kind !== 'checklist') fail(en('Only a checklist has rows to tick.'));
    const source = JSON.parse(r.source) as CanvasSource;
    if (source.type === 'app') fail(en('This list comes from an app: tick it in the app.'));
    if (source.type === 'tasks') {
      const listed = (tasksOf(app, source, this.#now()) ?? []).find((t) => `t${t.id}` === item) ?? fail(en('That to-do is not on this list.'));
      app.planner!.updateTask(listed.id, { status: done ? 'done' : 'open' });
      return;
    }
    const own = JSON.parse(r.own) as Own;
    const it = (own.items ?? []).find((i) => i.id === item) ?? fail(en('That row is not on this list.'));
    it.done = done;
    this.#db.prepare('UPDATE canvases SET own = ?, updated = ? WHERE id = ?').run(JSON.stringify(own), this.#now().toISOString(), id);
  }

  /** An html view saves its own data (own source only). */
  save(id: number, data: unknown): void {
    const r = this.#row(id) ?? fail(en('There is no such live view.'));
    const source = JSON.parse(r.source) as CanvasSource;
    if (r.kind !== 'html' || source.type !== 'own') fail(en('This live view shows data from somewhere else: it cannot save here.'));
    const own = JSON.parse(r.own) as Own;
    own.data = data ?? null;
    checkSize(own);
    this.#db.prepare('UPDATE canvases SET own = ?, updated = ? WHERE id = ?').run(JSON.stringify(own), this.#now().toISOString(), id);
  }

  resolve(tok: string): { id: number; kind: CanvasKind; title: string; html: string | null; root: string } | undefined {
    if (!TOKEN_RE.test(tok)) return undefined;
    const r = this.#db.prepare('SELECT * FROM canvases WHERE token = ?').get(tok) as Row | undefined;
    return r ? { id: Number(r.id), kind: r.kind as CanvasKind, title: r.title, html: r.html, root: `/myapp/${this.space}/${tok}/` } : undefined;
  }
}

/** Open to-dos of the source (and those done in the last day, so a ticked row stays in view). */
function tasksOf(app: AppContext, source: { project?: string }, now: Date) {
  const planner = app.planner;
  if (!planner) return [];
  let projectId: number | null | undefined;
  if (source.project) {
    projectId = planner.projects(true).find((p) => p.name.toLowerCase() === source.project!.toLowerCase())?.id;
    if (projectId === undefined) return undefined;
  }
  const since = now.getTime() - 24 * 3600_000;
  return planner
    .tasks({ status: 'all', ...(projectId !== undefined ? { projectId } : {}) })
    .filter((t) => t.status === 'open' || (t.doneAt && Date.parse(t.doneAt) >= since))
    .slice(0, CANVAS_LIMITS.items);
}

export function canvasFor(app: AppContext): CanvasStore {
  return CanvasStore.open(mySpaceDir(app), app.member ? app.member.id : 'owner', () => app.now());
}

let frameScript: string | undefined;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The words the frame shows, in the person's language (the frame can't load Sara's translations). */
function words(app: AppContext): Record<string, string> {
  const s = app.settings.get();
  return {
    empty: trOwner(en('Nothing here yet.'), s),
    done: trOwner(en('{done} of {total} done'), s),
    offline: trOwner(en('Not updating right now; trying again.'), s),
    failed: trOwner(en('That did not save. Try again.'), s),
    live: trOwner(en('Live'), s),
  };
}
function pageOf(app: AppContext, hit: { kind: CanvasKind; title: string; html: string | null; root: string }): string {
  const tag = `<script src="${hit.root}_sara/canvas.js"></script>`;
  const wordsTag = `<script type="application/json" id="cv-words">${JSON.stringify(words(app)).replace(/</g, '\\u003c')}</script>`;
  if (hit.kind === 'html') {
    const html = hit.html ?? '';
    const head = /<head[^>]*>/i.exec(html);
    if (head) return html.slice(0, head.index + head[0].length) + tag + wordsTag + html.slice(head.index + head[0].length);
    return tag + wordsTag + html;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${tag}<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(hit.title)}</title>${wordsTag}</head><body><main id="cv" data-kind="${hit.kind}" aria-live="polite"></main></body></html>`;
}

function out(res: ServerResponse, status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...APP_HEADERS, 'content-type': type, 'content-length': String(buf.length), ...extra });
  res.end(buf);
}
const outJson = (res: ServerResponse, status: number, body: unknown) => out(res, status, 'application/json; charset=utf-8', JSON.stringify(body));

/** /myapp/<space>/cv<token>/… (called by serveMyApp once the space matched). Never reads cookies. */
export async function serveCanvas(app: AppContext, req: IncomingMessage, res: ServerResponse, tok: string, rest: string | undefined, query: string): Promise<void> {
  const method = req.method ?? 'GET';
  const drain = () => readRaw(req, CANVAS_LIMITS.dataBytes + 1024).catch(() => Buffer.alloc(0));
  const notFound = async () => {
    await drain();
    outJson(res, 404, { error: 'Not found' });
  };
  if (!CanvasStore.exists(mySpaceDir(app))) return notFound();
  const store = canvasFor(app);
  const hit = store.resolve(tok);
  if (!hit) return notFound();
  if (rest === undefined) return out(res, 308, 'text/plain; charset=utf-8', '', { location: hit.root });
  if (method === 'OPTIONS') return out(res, 204, 'text/plain; charset=utf-8', '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
  try {
    if (rest === '_state' && method === 'GET') {
      const st = store.state(app, hit.id);
      const have = new URLSearchParams(query).get('rev');
      if (have && have === st.rev) return out(res, 204, 'text/plain; charset=utf-8', '');
      return outJson(res, 200, st);
    }
    if (rest === '_tick' && method === 'POST') {
      const body = await readJson(req, 4096);
      store.tick(app, hit.id, String(body.item ?? ''), body.done === true);
      return outJson(res, 200, { ok: true });
    }
    if (rest === '_save' && method === 'POST') {
      const body = await readJson(req, CANVAS_LIMITS.dataBytes + 1024);
      const st = store.state(app, hit.id);
      if (!st.canSave) return outJson(res, 403, { error: en('This live view shows data from somewhere else: it cannot save here.') });
      store.save(hit.id, body.data);
      return outJson(res, 200, { ok: true });
    }
  } catch (err) {
    if (err instanceof CanvasError || err instanceof HttpError) return outJson(res, 400, { error: err.message });
    throw err;
  }
  if (method !== 'GET' && method !== 'HEAD') return notFound();
  if (rest === '_sara/canvas.js') {
    frameScript ??= readFileSync(new URL('../web/canvas-frame.js', import.meta.url), 'utf8');
    return out(res, 200, 'text/javascript; charset=utf-8', frameScript);
  }
  if (rest === '' || rest === 'index.html') return out(res, 200, 'text/html; charset=utf-8', method === 'HEAD' ? '' : pageOf(app, hit));
  return notFound();
}

/** /api/library/canvases[/:id] (the person's own live views; needs the Sara session). */
export async function canvasRoute(app: AppContext, _req: IncomingMessage, res: ServerResponse, method: string, c: string | undefined): Promise<void> {
  const exists = CanvasStore.exists(mySpaceDir(app));
  if (!c) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return send(res, 200, { canvases: exists ? canvasFor(app).list() : [] });
  }
  if (!/^\d+$/.test(c) || !exists) throw new HttpError(404, 'There is no such live view.');
  const store = canvasFor(app);
  const v = store.get(Number(c));
  if (!v) throw new HttpError(404, 'There is no such live view.');
  if (method === 'GET') return send(res, 200, { canvas: v });
  if (method === 'DELETE') {
    store.remove(v.id);
    return send(res, 200, { deleted: true });
  }
  throw new HttpError(405, 'Method not allowed');
}
