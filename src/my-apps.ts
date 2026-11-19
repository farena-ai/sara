// V3.1 My apps (docs/design/MY_APPS.md): small web apps she built for the person, kept on this
// server with versions and Undo, a small JSON data store per app and an optional share link.
//
// Security model (docs/THREAT_MODEL.md, "Previews" applies the same way):
// - Only static files are kept (pages, styles, scripts, pictures, fonts, data). Nothing the model
//   wrote ever runs on the server: scripts run in the visitor's browser only.
// - Address: /myapp/<space>/<token>/… . The 128-bit token is the only key (never the Sara session
//   cookie or bearer); <space> only tells the front server which person's space to ask.
// - Every response carries `Content-Security-Policy: sandbox …` without allow-same-origin: the page
//   runs in an opaque origin, so its scripts can't read Sara's cookies, storage or API, and
//   connect-src 'self' keeps its data from being sent anywhere else. No Set-Cookie, no referrer.
// - The data store (`_data/<key>`) is the app's own: the owner's open link reads and writes it, a
//   share link only reads it. Deleting the app deletes its data; Undo never touches the data.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { HttpError, readJson, readRaw, send } from './http.ts';
import { en, enf } from './i18n.ts';
import { SHARE_EXPIRY } from './share.ts';
import { isCanvasToken, serveCanvas } from './canvas.ts';

export const APP_LIMITS = {
  files: 60,
  fileBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  versions: 30,
  apps: 100,
  dataKeys: 100,
  dataValueBytes: 64 * 1024,
  dataTotalBytes: 1024 * 1024,
};

/** The kinds of file an app may have, and how they are served. Anything else is refused. */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  webmanifest: 'application/manifest+json',
};

/** What every app response carries (see the header comment). */
export const APP_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'self'";
export const APP_HEADERS: Record<string, string> = {
  'content-security-policy': APP_CSP,
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-resource-policy': 'cross-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=()',
  // fetch() from the page's opaque origin is a CORS request, without credentials.
  'access-control-allow-origin': '*',
};

const HEADERS = APP_HEADERS;

export class MyAppsError extends Error {}
const fail = (m: string): never => {
  throw new MyAppsError(m);
};

export function appMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** A file path inside an app: plain relative parts, a known kind of file, no hidden or reserved names. */
export function cleanAppPath(p: unknown): string {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!s || s.length > 120) fail(en('A file needs a short path like index.html.'));
  const parts = s.split('/');
  for (const part of parts) if (!part || part === '.' || part === '..' || part.startsWith('.') || !/^[A-Za-z0-9._ -]+$/.test(part)) fail(enf('"{path}" is not a path inside the app.', { path: s }));
  if (parts[0] === '_data' || parts[0] === '_sara') fail(enf('"{path}" uses a name the app server keeps for itself.', { path: s }));
  const ext = s.toLowerCase().split('.').pop() ?? '';
  if (!MIME[ext] || !s.includes('.')) fail(enf('"{path}" is not a kind of file an app may have (pages, styles, scripts, pictures, fonts and data only; no server code).', { path: s }));
  return s;
}

/** The space named in a /myapp/ address ('owner' or a member id), for the front server. */
export function myAppSpace(url: string | undefined): string | undefined {
  const m = /^\/myapp\/(owner|[0-9a-f]{6,20})\/[A-Za-z0-9_-]+(?:[/?]|$)/.exec(url ?? '');
  return m?.[1];
}

export interface AppFileInput {
  path: string;
  content: string;
  /** The content is base64 (pictures, fonts). */
  base64?: boolean;
}
export interface AppView {
  id: number;
  name: string;
  version: number;
  versions: number;
  createdAt: string;
  updatedAt: string;
  /** The owner's own address (opens and saves). */
  openPath: string;
  /** A read-only share address, or null. */
  sharePath: string | null;
  shareUntil: string | null;
  bytes: number;
  dataKeys: number;
  /** An older version is kept, so Undo can go back. */
  canUndo: boolean;
}
export interface VersionView {
  n: number;
  note: string;
  at: string;
  files: number;
  bytes: number;
  current: boolean;
}

type AppRow = { id: number | bigint; name: string; created: string; updated: string; current: number | bigint; open_token: string; share_token: string | null; share_until: string | null };
type Files = Record<string, string>; // path → base64

const OPEN = new Map<string, MyApps>();
const token = () => randomBytes(16).toString('base64url');
const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class MyApps {
  readonly dir: string;
  readonly space: string;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  private constructor(spaceDir: string, space: string, now: () => Date) {
    this.dir = join(spaceDir, 'my-apps');
    this.space = space;
    this.#now = now;
    mkdirSync(this.dir, { recursive: true });
    this.#db = new DatabaseSync(join(this.dir, 'apps.db'));
    this.#db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, current INTEGER NOT NULL, open_token TEXT NOT NULL UNIQUE, share_token TEXT UNIQUE, share_until TEXT);
      CREATE TABLE IF NOT EXISTS versions (app_id INTEGER NOT NULL, n INTEGER NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL, files TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (app_id, n));
      CREATE TABLE IF NOT EXISTS data (app_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (app_id, key));`);
  }

  /** The apps of a space folder (one instance per folder in this process). */
  static open(spaceDir: string, space: string, now: () => Date = () => new Date()): MyApps {
    let s = OPEN.get(spaceDir);
    if (!s) OPEN.set(spaceDir, (s = new MyApps(spaceDir, space, now)));
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
  /** True when this space already has an apps folder (ticks and lists never create one). */
  static exists(spaceDir: string): boolean {
    return OPEN.has(spaceDir) || existsSync(join(spaceDir, 'my-apps', 'apps.db'));
  }

  #rows(): AppRow[] {
    return this.#db.prepare('SELECT * FROM apps ORDER BY updated DESC, id DESC').all() as AppRow[];
  }
  #row(ref: number | string): AppRow | undefined {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref).replace(/^#/, ''))) {
      const r = this.#db.prepare('SELECT * FROM apps WHERE id = ?').get(Number(String(ref).replace(/^#/, ''))) as AppRow | undefined;
      if (r || typeof ref === 'number') return r;
    }
    const name = String(ref).trim().toLowerCase();
    return this.#rows().find((r) => r.name.toLowerCase() === name);
  }
  #need(ref: number | string): AppRow {
    return this.#row(ref) ?? fail(enf('There is no app "{name}". app_list shows the kept apps.', { name: ref }));
  }
  #shareLive(r: AppRow): boolean {
    return Boolean(r.share_token) && (!r.share_until || Date.parse(r.share_until) > this.#now().getTime());
  }
  #view(r: AppRow): AppView {
    const id = Number(r.id);
    const cur = this.#db.prepare('SELECT bytes FROM versions WHERE app_id = ? AND n = ?').get(id, Number(r.current)) as { bytes: number } | undefined;
    const count = (this.#db.prepare('SELECT COUNT(*) AS c FROM versions WHERE app_id = ?').get(id) as { c: number }).c;
    const keys = (this.#db.prepare('SELECT COUNT(*) AS c FROM data WHERE app_id = ?').get(id) as { c: number }).c;
    const live = this.#shareLive(r);
    const older = this.#db.prepare('SELECT 1 AS x FROM versions WHERE app_id = ? AND n < ? LIMIT 1').get(id, Number(r.current));
    return {
      id,
      name: r.name,
      version: Number(r.current),
      versions: Number(count),
      createdAt: r.created,
      updatedAt: r.updated,
      openPath: `/myapp/${this.space}/${r.open_token}/`,
      sharePath: live ? `/myapp/${this.space}/${r.share_token}/` : null,
      shareUntil: live ? r.share_until : null,
      bytes: Number(cur?.bytes ?? 0),
      dataKeys: Number(keys),
      canUndo: Boolean(older),
    };
  }
  #files(id: number, n: number): Files {
    const v = this.#db.prepare('SELECT files FROM versions WHERE app_id = ? AND n = ?').get(id, n) as { files: string } | undefined;
    return v ? (JSON.parse(v.files) as Files) : {};
  }
  #addVersion(id: number, files: Files, note: string): number {
    const paths = Object.keys(files);
    if (!paths.includes('index.html')) fail(en('An app needs an index.html page (the one that opens first).'));
    if (paths.length > APP_LIMITS.files) fail(enf('An app may have at most {n} files.', { n: APP_LIMITS.files }));
    let bytes = 0;
    for (const p of paths) bytes += Buffer.byteLength(files[p], 'base64');
    if (bytes > APP_LIMITS.totalBytes) fail(enf('The app is too big (at most {n} MB in all).', { n: APP_LIMITS.totalBytes / 1024 / 1024 }));
    const max = (this.#db.prepare('SELECT MAX(n) AS m FROM versions WHERE app_id = ?').get(id) as { m: number | null }).m ?? 0;
    const n = Number(max) + 1;
    const at = this.#now().toISOString();
    this.#db.prepare('INSERT INTO versions (app_id, n, note, at, files, bytes) VALUES (?, ?, ?, ?, ?, ?)').run(id, n, note.slice(0, 200), at, JSON.stringify(files), bytes);
    this.#db.prepare('UPDATE apps SET current = ?, updated = ? WHERE id = ?').run(n, at, id);
    // Past the cap the oldest versions go (never the one shown).
    const old = this.#db.prepare('SELECT n FROM versions WHERE app_id = ? ORDER BY n DESC LIMIT -1 OFFSET ?').all(id, APP_LIMITS.versions) as { n: number }[];
    for (const o of old) if (Number(o.n) !== n) this.#db.prepare('DELETE FROM versions WHERE app_id = ? AND n = ?').run(id, Number(o.n));
    return n;
  }
  static #encode(files: AppFileInput[] | undefined, into: Files): Files {
    for (const f of files ?? []) {
      const path = cleanAppPath(f?.path);
      const content = String(f?.content ?? '');
      let b64: string;
      if (f.base64) {
        const clean = content.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) fail(enf('"{path}" is not valid base64.', { path }));
        b64 = clean;
      } else b64 = Buffer.from(content, 'utf8').toString('base64');
      if (Buffer.byteLength(b64, 'base64') > APP_LIMITS.fileBytes) fail(enf('"{path}" is too big (at most {n} KB per file).', { path, n: APP_LIMITS.fileBytes / 1024 }));
      into[path] = b64;
    }
    return into;
  }
  #cleanName(v: unknown, except?: number): string {
    const name = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) fail(en('An app needs a name.'));
    const same = this.#rows().find((r) => r.name.toLowerCase() === name.toLowerCase() && Number(r.id) !== except);
    if (same) fail(enf('An app called "{name}" is already kept: edit it (app_edit) or pick another name.', { name: same.name }));
    return name;
  }

  list(): AppView[] {
    return this.#rows().map((r) => this.#view(r));
  }
  get(ref: number | string): AppView | undefined {
    const r = this.#row(ref);
    return r ? this.#view(r) : undefined;
  }
  keep(input: { name: unknown; files: AppFileInput[]; note?: string }): AppView {
    const name = this.#cleanName(input.name);
    if (this.#rows().length >= APP_LIMITS.apps) fail(enf('At most {n} apps can be kept; delete one first.', { n: APP_LIMITS.apps }));
    const files = MyApps.#encode(input.files, {});
    const at = this.#now().toISOString();
    this.#db.exec('BEGIN');
    try {
      const id = Number(this.#db.prepare('INSERT INTO apps (name, created, updated, current, open_token) VALUES (?, ?, ?, 0, ?)').run(name, at, at, token()).lastInsertRowid);
      this.#addVersion(id, files, input.note ?? 'Kept');
      this.#db.exec('COMMIT');
      return this.#view(this.#need(id));
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
  /** A new version built on the one shown now: changed/added files, removed paths. */
  edit(ref: number | string, input: { files?: AppFileInput[]; remove?: string[]; note?: string }): AppView {
    const r = this.#need(ref);
    const id = Number(r.id);
    const files = MyApps.#encode(input.files, { ...this.#files(id, Number(r.current)) });
    for (const p of input.remove ?? []) delete files[cleanAppPath(p)];
    if (!input.files?.length && !input.remove?.length) fail(en('Nothing to change: give files to add or change, or paths to remove.'));
    this.#addVersion(id, files, input.note ?? 'Changed');
    return this.#view(this.#need(id));
  }
  /** Back to the version before the one shown now. */
  undo(ref: number | string): AppView {
    const r = this.#need(ref);
    const prev = this.#db.prepare('SELECT MAX(n) AS n FROM versions WHERE app_id = ? AND n < ?').get(Number(r.id), Number(r.current)) as { n: number | null };
    if (!prev.n) fail(en('Nothing to undo: this is the first version kept.'));
    return this.restore(Number(r.id), Number(prev.n));
  }
  restore(ref: number | string, n: number): AppView {
    const r = this.#need(ref);
    const has = this.#db.prepare('SELECT 1 AS x FROM versions WHERE app_id = ? AND n = ?').get(Number(r.id), n);
    if (!has) fail(enf('There is no version {n} of "{name}".', { n, name: r.name }));
    this.#db.prepare('UPDATE apps SET current = ?, updated = ? WHERE id = ?').run(n, this.#now().toISOString(), Number(r.id));
    return this.#view(this.#need(Number(r.id)));
  }
  versions(ref: number | string): VersionView[] {
    const r = this.#need(ref);
    const rows = this.#db.prepare('SELECT n, note, at, files, bytes FROM versions WHERE app_id = ? ORDER BY n DESC').all(Number(r.id)) as { n: number; note: string; at: string; files: string; bytes: number }[];
    return rows.map((v) => ({ n: Number(v.n), note: v.note, at: v.at, files: Object.keys(JSON.parse(v.files)).length, bytes: Number(v.bytes), current: Number(v.n) === Number(r.current) }));
  }
  /** The files of a version (the one shown by default), as text (pictures as base64). */
  files(ref: number | string, n?: number): Record<string, string> {
    const r = this.#need(ref);
    const raw = this.#files(Number(r.id), n ?? Number(r.current));
    const out: Record<string, string> = {};
    for (const [p, b] of Object.entries(raw)) out[p] = /^(text|application\/(json|manifest)|image\/svg)/.test(appMime(p)) ? Buffer.from(b, 'base64').toString('utf8') : b;
    return out;
  }
  rename(ref: number | string, name: unknown): AppView {
    const r = this.#need(ref);
    this.#db.prepare('UPDATE apps SET name = ? WHERE id = ?').run(this.#cleanName(name, Number(r.id)), Number(r.id));
    return this.#view(this.#need(Number(r.id)));
  }
  remove(ref: number | string): void {
    const id = Number(this.#need(ref).id);
    for (const t of ['versions', 'data']) this.#db.prepare(`DELETE FROM ${t} WHERE app_id = ?`).run(id);
    this.#db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  }
  share(ref: number | string, expiry: string): AppView {
    const r = this.#need(ref);
    let until: string | null = null;
    if (expiry !== 'never') {
      const ms = (SHARE_EXPIRY as Record<string, number>)[expiry];
      if (!ms) fail(en('Pick how long the link works: 1h, 1d, 7d, 30d or never.'));
      until = new Date(this.#now().getTime() + ms).toISOString();
    }
    this.#db.prepare('UPDATE apps SET share_token = ?, share_until = ? WHERE id = ?').run(token(), until, Number(r.id));
    return this.#view(this.#need(Number(r.id)));
  }
  unshare(ref: number | string): AppView {
    const r = this.#need(ref);
    this.#db.prepare('UPDATE apps SET share_token = NULL, share_until = NULL WHERE id = ?').run(Number(r.id));
    return this.#view(this.#need(Number(r.id)));
  }

  // The app's own small data store.
  dataKeys(id: number): string[] {
    return (this.#db.prepare('SELECT key FROM data WHERE app_id = ? ORDER BY key').all(id) as { key: string }[]).map((x) => x.key);
  }
  getData(id: number, key: string): unknown {
    const v = this.#db.prepare('SELECT value FROM data WHERE app_id = ? AND key = ?').get(id, key) as { value: string } | undefined;
    return v ? JSON.parse(v.value) : undefined;
  }
  setData(id: number, key: string, value: unknown): void {
    if (!KEY_RE.test(key)) fail(en('A data name may use letters, digits, dot, dash and underscore (up to 64).'));
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json) > APP_LIMITS.dataValueBytes) fail(enf('That value is too big (at most {n} KB per name).', { n: APP_LIMITS.dataValueBytes / 1024 }));
    const others = this.#db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(value)), 0) AS b FROM data WHERE app_id = ? AND key <> ?').get(id, key) as { c: number; b: number };
    if (Number(others.c) >= APP_LIMITS.dataKeys) fail(enf('An app may keep at most {n} names.', { n: APP_LIMITS.dataKeys }));
    if (Number(others.b) + json.length > APP_LIMITS.dataTotalBytes) fail(en('This app keeps too much data already.'));
    this.#db.prepare('INSERT INTO data (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value').run(id, key, json);
  }
  deleteData(id: number, key: string): void {
    this.#db.prepare('DELETE FROM data WHERE app_id = ? AND key = ?').run(id, key);
  }

  /** Which app an address token opens, and whether it may save. */
  resolve(tok: string): { id: number; root: string; files: Files; readOnly: boolean } | undefined {
    if (!/^[A-Za-z0-9_-]{22}$/.test(tok)) return undefined;
    const own = this.#db.prepare('SELECT * FROM apps WHERE open_token = ?').get(tok) as AppRow | undefined;
    const shared = own ? undefined : (this.#db.prepare('SELECT * FROM apps WHERE share_token = ?').get(tok) as AppRow | undefined);
    const r = own ?? (shared && this.#shareLive(shared) ? shared : undefined);
    if (!r) return undefined;
    return { id: Number(r.id), root: `/myapp/${this.space}/${tok}/`, files: this.#files(Number(r.id), Number(r.current)), readOnly: !own };
  }
}

/** The person's own folder: a member's space, or the owner's data folder (shared by her companions). */
export function mySpaceDir(app: AppContext): string {
  if (app.member) return app.dataDir;
  return app.family?.spaceDirOf?.('owner') ?? app.dataDir;
}
export function myAppsFor(app: AppContext): MyApps {
  return MyApps.open(mySpaceDir(app), app.member ? app.member.id : 'owner', () => app.now());
}

/** The small script every page gets (web/myapp-data.js): `appData.get/set/remove/keys` on the app's own store. */
let helperText: string | undefined;
function helperScript(root: string, readOnly: boolean): string {
  helperText ??= readFileSync(new URL('../web/myapp-data.js', import.meta.url), 'utf8');
  return helperText.replace("'__ROOT__'", JSON.stringify(`${root}_data/`)).replace("'__READONLY__'", readOnly ? "'true'" : "'false'");
}

function withHelper(html: string, src: string): string {
  const tag = `<script src="${src}"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

function out(res: ServerResponse, status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'content-length': String(buf.length), ...extra });
  res.end(buf);
}
const outJson = (res: ServerResponse, status: number, body: unknown) => out(res, status, 'application/json; charset=utf-8', JSON.stringify(body));

/**
 * Serves /myapp/<space>/<token>/… from this space. Answers 404 for anything it does not know,
 * so a wrong or revoked token looks the same as no app at all. Cookies and authorization are
 * never read here.
 */
export async function serveMyApp(app: AppContext, req: IncomingMessage, res: ServerResponse, rawTarget: string): Promise<void> {
  const method = req.method ?? 'GET';
  const m = /^\/myapp\/([^/?]+)\/([^/?]+)(\/[^?]*)?(?:\?.*)?$/.exec(rawTarget);
  const want = app.member ? app.member.id : 'owner';
  const drain = () => readRaw(req, APP_LIMITS.dataValueBytes + 1024).catch(() => Buffer.alloc(0));
  const notFound = async () => {
    await drain();
    outJson(res, 404, { error: 'Not found' });
  };
  // D3: a live canvas in a chat rides the same door (src/canvas.ts, same CSP, token only).
  if (m && m[1] === want && isCanvasToken(m[2])) return serveCanvas(app, req, res, m[2], m[3] === undefined ? undefined : safeRest(m[3]), rawTarget.split('?')[1] ?? '');
  if (!m || m[1] !== want || !MyApps.exists(mySpaceDir(app))) return notFound();
  const hit = myAppsFor(app).resolve(m[2]);
  if (!hit) return notFound();
  if (!m[3]) return out(res, 308, 'text/plain; charset=utf-8', '', { location: hit.root });
  let rest: string;
  try {
    rest = decodeURIComponent(m[3].slice(1));
  } catch {
    return notFound();
  }
  const store = myAppsFor(app);
  if (rest === '_data' || rest.startsWith('_data/')) {
    const key = rest.slice(6);
    if (method === 'OPTIONS') return out(res, 204, 'text/plain; charset=utf-8', '', { 'access-control-allow-methods': 'GET, PUT, DELETE', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
    if (!key) {
      if (method !== 'GET') return notFound();
      return outJson(res, 200, { keys: store.dataKeys(hit.id), readOnly: hit.readOnly });
    }
    if (method === 'GET') {
      const v = store.getData(hit.id, key);
      return v === undefined ? outJson(res, 404, { error: 'Not found' }) : outJson(res, 200, { key, value: v });
    }
    if (method !== 'PUT' && method !== 'DELETE') return notFound();
    if (hit.readOnly) {
      await drain();
      return outJson(res, 403, { error: en('This is a shared, read-only copy of the app.') });
    }
    try {
      if (method === 'DELETE') {
        store.deleteData(hit.id, key);
        return outJson(res, 200, { key, deleted: true });
      }
      const body = await readJson(req, APP_LIMITS.dataValueBytes + 1024);
      store.setData(hit.id, key, body.value);
      return outJson(res, 200, { key, saved: true });
    } catch (err) {
      return outJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
    }
  }
  if (method === 'OPTIONS') return out(res, 204, 'text/plain; charset=utf-8', '');
  if (method !== 'GET' && method !== 'HEAD') return notFound();
  if (rest === '_sara/data.js') return out(res, 200, MIME.js, helperScript(hit.root, hit.readOnly));
  const path = rest === '' || rest.endsWith('/') ? `${rest}index.html` : rest;
  const b64 = hit.files[path];
  if (b64 === undefined) return notFound();
  const type = appMime(path);
  let body = Buffer.from(b64, 'base64');
  if (type.startsWith('text/html')) body = Buffer.from(withHelper(body.toString('utf8'), `${hit.root}_sara/data.js`));
  return out(res, 200, type, method === 'HEAD' ? Buffer.alloc(0) : body);
}

const safeRest = (p: string): string => {
  try {
    return decodeURIComponent(p.slice(1));
  } catch {
    return '\u0000';
  }
};

/** /api/library/apps[/:id[/undo|restore|share]] (the person's own apps). */
export async function myAppsRoute(app: AppContext, req: IncomingMessage, res: ServerResponse, method: string, c: string | undefined, d: string | undefined): Promise<void> {
  const store = myAppsFor(app);
  const guard = async (f: () => unknown | Promise<unknown>) => {
    try {
      return send(res, 200, await f());
    } catch (err) {
      if (err instanceof MyAppsError) throw new HttpError(/There is no app/.test(err.message) ? 404 : 400, err.message);
      throw err;
    }
  };
  if (!c) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return send(res, 200, { apps: store.list(), expiries: [...Object.keys(SHARE_EXPIRY), 'never'] });
  }
  if (!/^\d+$/.test(c)) throw new HttpError(404, 'Not found');
  const id = Number(c);
  if (!store.get(id)) throw new HttpError(404, 'There is no such app.');
  if (!d) {
    if (method === 'GET') return guard(() => ({ app: store.get(id), versions: store.versions(id), files: Object.keys(store.files(id)).sort(), data: store.dataKeys(id) }));
    if (method === 'PATCH') {
      const body = await readJson(req);
      return guard(() => ({ app: store.rename(id, body.name) }));
    }
    if (method === 'DELETE') return guard(() => (store.remove(id), { deleted: true }));
    throw new HttpError(405, 'Method not allowed');
  }
  if (d === 'undo' && method === 'POST') return guard(() => ({ app: store.undo(id) }));
  if (d === 'restore' && method === 'POST') {
    const body = await readJson(req);
    return guard(() => ({ app: store.restore(id, Number(body.n)) }));
  }
  if (d === 'share' && method === 'POST') {
    const body = await readJson(req);
    return guard(() => ({ app: store.share(id, String(body.expiry ?? '7d')) }));
  }
  if (d === 'share' && method === 'DELETE') return guard(() => ({ app: store.unshare(id) }));
  throw new HttpError(404, 'Not found');
}
