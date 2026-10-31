// Phase 92 (computer use CU5, docs/design/COMPUTER_USE.md §5, §6.1–6.2, §7.4, §7.6): desktop look.
// The rules every hands device follows when it looks at the whole screen (the Windows and Mac apps
// port them as fixed lists; the reference hands use this file directly):
// - which windows are hidden (the sensitive-windows blocklist, §7.4): blacked out in pictures, left out
//   of element lists, and listed by d.windows only as "(hidden: password manager)", never by title;
// - Sara's own windows (the app, its badge, its windows) never appear at all, not even as hidden;
// - password / secure fields are boxed out of pictures and never give their value;
// - key-shaped text in names and values is masked;
// - pictures are at most 1280 px on the long side, one per 500 ms; element lists at most 300 items,
//   depth 8; a picture's viewId is good for 20 s (then `stale_view`: look again).
// All of this happens ON THE DEVICE before anything is sent. The server re-checks what comes back
// (desktopItems / desktopWindows below) so a device that got it wrong still can't leak a title.
// Also here: a tiny PNG encoder (no dependencies) and the fixture desktop the reference hands use in
// tests and conformance (recorded-screen style windows with known text, a fixture "KeePass" window,
// Sara's own window), so desktop look is tested without anyone's real screen.
import { desktopActionVerdict, looksSecret } from './computer-policy.ts';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

/** CU5's command set: look at the desktop. */
export const CU5_OPS = ['d.screens', 'd.windows', 'd.shot', 'd.elements'] as const;
/** CU6's command set: typed, supervised desktop input. */
export const CU6_OPS = ['d.click', 'd.type', 'd.keys', 'd.scroll', 'd.drag', 'd.launch'] as const;
export const DESKTOP_INPUT_OPS: ReadonlySet<string> = new Set(CU6_OPS);
export const DESKTOP_LIMITS = { maxEdge: 1280, elements: 300, depth: 8, viewTtlMs: 20_000, pictureEveryMs: 500, windows: 60 } as const;

/**
 * §7.4: the default sensitive-windows list. A window is hidden when its title or its app/process
 * name contains one of these (lower case). The apps add the person's own list (one name per line).
 */
export const DESKTOP_BLOCKLIST: readonly { kind: string; titles: readonly string[]; apps: readonly string[] }[] = [
  {
    kind: 'password manager',
    titles: ['1password', 'bitwarden', 'keepass', 'lastpass', 'dashlane', 'proton pass', 'keychain access', 'credential manager', 'enpass', 'nordpass', 'roboform'],
    apps: ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'proton pass', 'keychain access', 'enpass', 'nordpass', 'roboform'],
  },
  { kind: 'security settings', titles: ['windows security', 'privacy & security', 'privacy and security', 'credential manager', 'manage passwords'], apps: ['securityhealthhost', 'securityhealthui'] },
  {
    kind: 'banking',
    titles: ['online banking', 'bank of america', 'wells fargo', 'chase bank', 'chase.com', 'citibank', 'barclays', 'hsbc', 'santander', 'capital one', 'paypal', 'revolut', 'monzo', 'n26', 'sparkasse', 'credit union', 'ing banking', 'bnp paribas'],
    apps: [],
  },
  // A window showing one of Sara's own sign-in tokens (§7.4).
  { kind: 'sign-in token', titles: ['sara_dev.', 'sara_hands.', 'sara_m.'], apps: [] },
];

/** Which hidden kind a window is (undefined: not hidden). `extra` is the person's own list on that computer. */
export function blockedKind(title: string, app: string, extra: readonly string[] = []): string | undefined {
  const t = String(title ?? '').toLowerCase();
  const a = String(app ?? '').toLowerCase();
  for (const b of DESKTOP_BLOCKLIST) {
    if (b.titles.some((x) => t.includes(x)) || b.apps.some((x) => a === x || a.includes(x))) return b.kind;
  }
  for (const raw of extra) {
    const x = raw.trim().toLowerCase();
    if (x.length >= 3 && (t.includes(x) || a.includes(x))) return 'your list';
  }
  return undefined;
}

/** §7.6: the fixed key shapes masked in element names and values (ported to both apps). */
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bxai-[A-Za-z0-9]{20,}/g, /\bsara_(?:dev|hands|m)\.[\w-]+\.[\w-]+/g, /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g];
export const maskDesktopText = (s: string): string => SECRET_SHAPES.reduce((t, re) => t.replace(re, '[hidden]'), s);

const plain = (s: unknown, n: number) => maskDesktopText(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, n);

export interface DesktopItem {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  secret?: boolean;
  disabled?: boolean;
  focused?: boolean;
  /** [x, y, w, h] in picture pixels of the viewId (or screen points without one). */
  box?: [number, number, number, number];
}

/** The server's re-check of an element list: refs and roles only as given, secret values never, names masked. */
export function desktopItems(raw: unknown): DesktopItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DesktopItem[] = [];
  for (const x of raw.slice(0, DESKTOP_LIMITS.elements)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const ref = String(o.ref ?? '');
    if (!/^e\d{1,4}$/.test(ref)) continue;
    const it: DesktopItem = { ref, role: plain(o.role, 40) || 'element' };
    const name = plain(o.name, 200).trim();
    if (name) it.name = name;
    if (o.secret === true) it.secret = true;
    else if (o.value !== undefined && o.value !== null && String(o.value) !== '') it.value = plain(o.value, 200);
    if (o.disabled === true) it.disabled = true;
    if (o.focused === true) it.focused = true;
    if (Array.isArray(o.box) && o.box.length === 4 && o.box.every((n) => Number.isFinite(Number(n)))) it.box = (o.box as unknown[]).map((n) => Math.round(Number(n))) as DesktopItem['box'];
    out.push(it);
  }
  return out;
}

export interface DesktopWindow {
  id?: string;
  title?: string;
  app?: string;
  bounds?: [number, number, number, number];
  minimized?: boolean;
  focused?: boolean;
  screen?: string;
  /** Hidden by the blocklist: only the kind, never the title, app or id. */
  hidden?: string;
}

/** The server's re-check of a window list: a hidden window keeps only its kind; a title the blocklist names is hidden here too. */
export function desktopWindows(raw: unknown): DesktopWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: DesktopWindow[] = [];
  for (const x of raw.slice(0, DESKTOP_LIMITS.windows)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const title = plain(o.title, 160);
    const app = plain(o.app, 80);
    const kind = o.hidden ? plain(o.hidden, 40) || 'hidden' : blockedKind(title, app);
    if (kind) {
      out.push({ hidden: kind });
      continue;
    }
    const w: DesktopWindow = { id: plain(o.id, 40), title, app };
    if (Array.isArray(o.bounds) && o.bounds.length === 4) w.bounds = (o.bounds as unknown[]).map((n) => Math.round(Number(n) || 0)) as DesktopWindow['bounds'];
    if (o.minimized === true) w.minimized = true;
    if (o.focused === true) w.focused = true;
    if (o.screen) w.screen = plain(o.screen, 20);
    out.push(w);
  }
  return out;
}

// ---------------- a tiny PNG (8-bit RGB, filter 0) ----------------
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Reads back a PNG made by encodePng (tests: is that area black?). */
export function readPng(png: Buffer): { w: number; h: number; rgb: Buffer } | undefined {
  if (png.length < 33 || png.readUInt32BE(12) !== 0x49484452) return undefined;
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const parts: Buffer[] = [];
  for (let p = 8; p + 8 <= png.length; ) {
    const len = png.readUInt32BE(p);
    const type = png.subarray(p + 4, p + 8).toString('latin1');
    if (type === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) raw.copy(rgb, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
  return { w, h, rgb };
}

// ---------------- the fixture desktop (reference hands, tests, conformance) ----------------
export interface FixtureElement {
  role: string;
  name?: string;
  value?: string;
  secure?: boolean;
  disabled?: boolean;
  /** [x, y, w, h] inside the window. */
  box: [number, number, number, number];
}
export interface FixtureWindow {
  id: string;
  title: string;
  app: string;
  bounds: [number, number, number, number];
  color: [number, number, number];
  minimized?: boolean;
  elevated?: boolean;
  origin?: string;
  /** One of Sara's own windows (never in a picture or a list). */
  own?: boolean;
  elements: FixtureElement[];
}

/** A small known desktop: a notes window with text and a password field, a fixture KeePass, Sara's own window on top. */
export function fixtureWindows(): FixtureWindow[] {
  return [
    {
      id: 'w101',
      title: 'Sara fixture: Notes',
      app: 'fixture-notes',
      bounds: [40, 40, 520, 360],
      color: [235, 240, 250],
      elements: [
        { role: 'text', name: 'Shopping list: apples, oat milk, 12 eggs', box: [20, 20, 400, 24] },
        { role: 'edit', name: 'Name', value: 'Robin', box: [20, 70, 240, 28] },
        { role: 'edit', name: 'Password', value: 'hunter2-fixture-secret', secure: true, box: [20, 120, 240, 28] },
        { role: 'edit', name: 'API key', value: 'sk' + '-fixtureabcdefghijklmnop1234', box: [20, 170, 300, 28] },
        { role: 'button', name: 'Save', box: [20, 230, 100, 32] },
        { role: 'button', name: 'Archive', disabled: true, box: [140, 230, 100, 32] },
      ],
    },
    { id: 'w102', title: 'Passwords.kdbx - KeePass', app: 'KeePass', bounds: [600, 60, 400, 300], color: [60, 160, 90], elements: [{ role: 'text', name: 'bank login: 9999-fixture', box: [10, 10, 300, 24] }] },
    { id: 'w103', title: 'Sara', app: 'Sara', bounds: [700, 420, 300, 200], color: [200, 80, 160], own: true, elements: [{ role: 'button', name: 'Allow', box: [10, 10, 80, 30] }] },
    { id: 'w104', title: 'Hidden helper', app: 'fixture-tray', bounds: [0, 0, 10, 10], color: [10, 10, 10], minimized: true, elements: [] },
  ];
}

interface View {
  id: string;
  at: number;
  /** Screen point → picture pixel: (sx - ox) * scale. */
  ox: number;
  oy: number;
  scale: number;
  window?: string;
  width?: number;
  height?: number;
  signature?: string;
}

/** The fixture desktop: the same rules as the apps, on known windows. */
export class TestDesktop {
  readonly screen = { id: 's1', w: 1100, h: 700, scale: 1, primary: true };
  readonly windows: FixtureWindow[];
  readonly extra: string[];
  readonly #views = new Map<string, View>();
  #taskActive = false;
  #walkAway = false;
  get awake(): boolean { return this.#taskActive && this.#walkAway && !this.locked && !this.paused && !this.stopped; }
  beginTask(walkAway: boolean): void { this.#taskActive = true; this.#walkAway = walkAway; }
  endTask(): void { this.#taskActive = false; }
  #viewN = 0;
  #lastShot = 0;
  readonly takeover: 'pause' | 'keep';
  transportSecure: boolean;
  locked = false;
  stopped = false;
  foreground = 'w101';
  ownOrigin = '';
  focused = '';
  clicked = '';
  selection: [number, number] = [0, 0];
  readonly keyEvents: string[] = [];
  scroll = { x: 0, y: 0 };
  drag?: { from: string; x: number; y: number };
  launched: string[] = [];
  paused = false;
  /** Tests: the clock. */
  now = () => Date.now();

  constructor(opts: { windows?: FixtureWindow[]; extra?: string[]; takeover?: 'pause' | 'keep'; transportSecure?: boolean } = {}) {
    this.windows = opts.windows ?? fixtureWindows();
    this.extra = opts.extra ?? [];
    this.takeover = opts.takeover ?? 'pause';
    this.transportSecure = opts.transportSecure !== false;
  }

  #hidden(w: FixtureWindow): string | undefined {
    return blockedKind(w.title, w.app, this.extra);
  }
  #visible(): FixtureWindow[] {
    return this.windows.filter((w) => !w.own && !w.minimized);
  }
  /** The window in front (the last visible, not hidden, not Sara's). */
  front(): FixtureWindow | undefined {
    return [...this.#visible()].reverse().find((w) => !this.#hidden(w));
  }

  /** Tests and the Linux reference device use this to simulate the owner's real input. */
  ownerInput(): void {
    if (this.takeover === 'keep' || this.paused || this.stopped) return;
    this.paused = true;
  }

  resume(): void {
    if (!this.stopped) this.paused = false;
  }

  stop(): void {
    this.endTask();
    this.stopped = true;
    this.paused = false;
  }

  screens(): Record<string, unknown> {
    return { screens: [this.screen] };
  }

  list(): Record<string, unknown> {
    const front = this.front();
    const out: Record<string, unknown>[] = [];
    for (const w of [...this.windows].reverse()) {
      if (w.own) continue;
      const k = this.#hidden(w);
      if (k) out.push({ hidden: k });
      else out.push({ id: w.id, title: maskDesktopText(w.title), app: w.app, bounds: w.bounds, ...(w.minimized ? { minimized: true } : {}), ...(w === front ? { focused: true } : {}), screen: this.screen.id });
    }
    return { windows: out };
  }

  #find(id: unknown): FixtureWindow {
    const w = this.windows.find((x) => x.id === String(id ?? ''));
    if (!w || w.own) throw Object.assign(new Error('No such window (pc_windows lists them).'), { code: 'not_found' });
    const k = this.#hidden(w);
    if (k) throw Object.assign(new Error(`That window is hidden from Sara (${k}).`), { code: 'blocked_window' });
    if (w.minimized) throw Object.assign(new Error('That window is minimized.'), { code: 'not_found' });
    return w;
  }

  #items(w: FixtureWindow, v: View | undefined, limit: number): { items: DesktopItem[]; total: number } {
    const all = w.elements.map((e, i) => {
      const [x, y, bw, bh] = e.box;
      const sx = w.bounds[0] + x;
      const sy = w.bounds[1] + y;
      const box: [number, number, number, number] = v ? [Math.round((sx - v.ox) * v.scale), Math.round((sy - v.oy) * v.scale), Math.max(1, Math.round(bw * v.scale)), Math.max(1, Math.round(bh * v.scale))] : [sx, sy, bw, bh];
      const it: DesktopItem = { ref: `e${i + 1}`, role: e.role, box };
      if (e.name) it.name = maskDesktopText(e.name);
      if (e.secure) it.secret = true;
      else if (e.value !== undefined) it.value = maskDesktopText(e.value);
      if (e.disabled) it.disabled = true;
      return it;
    });
    return { items: all.slice(0, limit), total: all.length };
  }

  elements(a: Record<string, unknown>): Record<string, unknown> {
    const w = a.window ? this.#find(a.window) : this.front();
    if (!w) return { items: [], total: 0 };
    let v: View | undefined;
    if (a.viewId) {
      v = this.#views.get(String(a.viewId));
      if (!v || this.now() - v.at > DESKTOP_LIMITS.viewTtlMs) throw Object.assign(new Error('That picture is older than 20 seconds: look again.'), { code: 'stale_view' });
    }
    const limit = Math.max(1, Math.min(DESKTOP_LIMITS.elements, Number(a.limit) || DESKTOP_LIMITS.elements));
    const coords = v ? 'picture' : 'screen';
    if (!v) { v = { id: `v${++this.#viewN}`, at: this.now(), ox: 0, oy: 0, scale: 1, window: w.id, width: this.screen.w, height: this.screen.h, signature: this.#signature(w) }; this.#views.set(v.id, v); }
    const { items, total } = this.#items(w, v, limit);
    return { viewId: v.id, window: { id: w.id, title: maskDesktopText(w.title), app: w.app }, items, total, ...(total > items.length ? { more: true } : {}), coords };
  }

  #signature(w: FixtureWindow): string { return JSON.stringify([w.bounds, w.elements.map(e => [e.role, e.name, e.box, !!e.secure, !!e.disabled])]); }

  #view(a: Record<string, unknown>): View {
    const id = String(a.viewId ?? '');
    const v = this.#views.get(id);
    if (!v || this.now() - v.at > DESKTOP_LIMITS.viewTtlMs) throw Object.assign(new Error('That look is older than 20 seconds: look again before acting.'), { code: 'stale_view' });
    return v;
  }

  inspect(op: string, a: Record<string, unknown>): { window?: FixtureWindow; element?: FixtureElement } {
    const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
    if (!DESKTOP_INPUT_OPS.has(op)) fail('unsupported', 'Unsupported desktop action.');
    if (this.stopped) fail('stopped', 'Stopped on the computer.');
    if (!this.transportSecure) fail('denied_local', 'Desktop input is refused over an unencrypted connection unless it is loopback.');
    if (this.locked) fail('denied_local', 'The screen is locked or the secure desktop is active; Sara cannot control it.');
    if (this.paused) fail('takeover', 'Paused: the owner took over the computer. Press Resume.');
    if (op === 'd.launch') {
      if (!['fixture-notes', 'fixture-calculator'].includes(String(a.app))) fail('denied_local', 'Only an installed, allowed app may be opened; no paths or commands.');
      return {};
    }
    const v = this.#view(a);
    if (a.window && a.window !== v.window) {
      this.#find(a.window); // Preserve the specific blocked-window refusal.
      fail('stale_view', 'That window is not the one in this look.');
    }
    const w = this.#find(v.window);
    if (w.elevated) fail('denied_local', "I can't control windows running as administrator");
    if (/msedge|chrome|chromium|safari|firefox|brave|opera/i.test(w.app) && (!w.origin || w.origin === this.ownOrigin)) fail('denied_local', 'Sara cannot control her own server/sign-in in a browser, or a browser whose address cannot be checked.');
    if (this.foreground !== w.id) fail('denied_local', 'The target window is not in front: look again.');
    if (v.signature !== this.#signature(w)) fail('stale_view', 'The window or controls changed: look again.');
    let element: FixtureElement | undefined;
    if (typeof a.ref === 'string' && /^e[1-9]\d{0,3}$/.test(a.ref)) element = w.elements[Number(a.ref.slice(1)) - 1];
    else {
      const x = Number(a.x), y = Number(a.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= (v.width ?? 0) || y >= (v.height ?? 0)) fail('denied_local', 'The point is outside this picture.');
      const sx = v.ox + x / v.scale, sy = v.oy + y / v.scale;
      element = w.elements.find(e => sx >= w.bounds[0] + e.box[0] && sx < w.bounds[0] + e.box[0] + e.box[2] && sy >= w.bounds[1] + e.box[1] && sy < w.bounds[1] + e.box[1] + e.box[3]);
    }
    if (!element) fail('stale_view', 'That element is not in the latest look.');
    if (a.ref && (op === 'd.drag' || (op === 'd.click' && element!.role !== 'button'))) {
      const [x, y, width, height] = element!.box;
      const point = [x + width / 2, y + height / 2];
      const hit = w.elements.filter(e => point[0] >= e.box[0] && point[0] < e.box[0] + e.box[2] && point[1] >= e.box[1] && point[1] < e.box[1] + e.box[3]).sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3])[0];
      if (hit !== element) fail('stale_view', "That container's point hits a different control: look again.");
    }
    if (element!.secure) fail('denied_local', 'That is a password field: Sara never types or presses keys into those.');
    if (element!.disabled) fail('denied_local', 'That control is disabled.');
    const verdict = desktopActionVerdict({ site: w.app, target: { role: element!.role, name: element!.name }, level: 'always', text: typeof a.text === 'string' ? a.text : undefined });
    if (verdict.act === 'block') fail('denied_local', verdict.why);
    if (op === 'd.type' && (String(a.text ?? '').length > 2000 || looksSecret(String(a.text ?? '')))) fail('denied_local', 'Text is too long or looks like a secret.');
    if (op === 'd.keys' && !/^(?:Enter|Tab|Shift\+Tab|Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Backspace|Ctrl\+A)$/i.test(String(a.combo))) fail('denied_local', 'That key combination is not an allowed desktop key.');
    if (op === 'd.drag' && (![a.toX, a.toY].every(n => typeof n === 'number' && Number.isFinite(n)) || Number(a.toX) < 0 || Number(a.toY) < 0 || Number(a.toX) >= (v.width ?? 0) || Number(a.toY) >= (v.height ?? 0))) fail('denied_local', 'The drag endpoint is outside this picture.');
    return { window: w, element };
  }

  /** A local decision may take time; revalidate the exact approved identity before refreshing its age. */
  refreshApproved(a: Record<string, unknown>): void {
    const v = this.#views.get(String(a.viewId));
    if (!v) throw Object.assign(new Error('That approved look is no longer available.'), { code: 'stale_view' });
    const at = v.at;
    v.at = this.now();
    try { this.inspect('d.click', a); } catch (e) { v.at = at; throw e; }
  }

  /** Observable fixture effects; unsupported operations never report success. */
  act(op: string, a: Record<string, unknown>): Record<string, unknown> {
    const { window: w, element: e } = this.inspect(op, a);
    if (op === 'd.launch') {
      const app = String(a.app);
      this.launched.push(app);
      if (app === 'fixture-calculator' && !this.windows.some(w => w.app === app)) this.windows.push({ id: 'w105', title: 'Fixture Calculator', app, bounds: [80, 80, 360, 300], color: [230, 235, 245], elements: [{ role: 'text', name: '0', box: [20, 20, 280, 40] }, { role: 'button', name: 'Clear', box: [20, 80, 100, 44] }] });
      const window = this.windows.find(w => w.app === app)!;
      this.foreground = window.id;
      return { changed: true, launched: app, after: this.list() };
    }
    const ref = `e${w!.elements.indexOf(e!) + 1}`;
    this.focused = ref;
    if (op === 'd.type') {
      if (e!.role !== 'edit') throw Object.assign(new Error('That control is not editable.'), { code: 'denied_local' });
      e!.value = String(a.text ?? '');
      this.selection = [e!.value.length, e!.value.length];
    } else if (op === 'd.keys') {
      const key = String(a.combo).toLowerCase();
      this.keyEvents.push(key);
      if (e!.role === 'edit') {
        const value = e!.value ?? '';
        let [start, end] = this.selection.map(n => Math.min(value.length, n)) as [number, number];
        if (key === 'ctrl+a') [start, end] = [0, value.length];
        else if (key === 'backspace') {
          const from = start === end ? Math.max(0, start - 1) : start;
          e!.value = value.slice(0, from) + value.slice(end);
          [start, end] = [from, from];
        } else if (key === 'home') [start, end] = [0, 0];
        else if (key === 'end') [start, end] = [value.length, value.length];
        else if (key === 'arrowleft') [start, end] = [Math.max(0, start - 1), Math.max(0, start - 1)];
        else if (key === 'arrowright') [start, end] = [Math.min(value.length, end + 1), Math.min(value.length, end + 1)];
        this.selection = [start, end];
      }
      if (key === 'enter' && e!.role === 'button') this.clicked = e!.name ?? ref;
      if (key.includes('tab')) this.focused = `e${Math.min(w!.elements.length, w!.elements.indexOf(e!) + 2)}`;
    } else if (op === 'd.click') this.clicked = e!.name ?? ref;
    else if (op === 'd.scroll') { this.scroll.x += Number(a.dx ?? 0); this.scroll.y += Number(a.dy ?? 0); }
    else if (op === 'd.drag') this.drag = { from: ref, x: Number(a.toX), y: Number(a.toY) };
    return { changed: true, op, window: w!.id, ref, focused: this.focused, selection: this.selection, keys: this.keyEvents.slice(-4), clicked: this.clicked, scroll: this.scroll, ...(this.drag ? { drag: this.drag } : {}) };
  }

  /** d.shot: the picture with hidden windows black, secure fields boxed out, Sara's own windows left out. */
  shot(a: Record<string, unknown>): { png: Buffer; w: number; h: number; viewId: string; result: Record<string, unknown> } {
    const t = this.now();
    if (t - this.#lastShot < DESKTOP_LIMITS.pictureEveryMs) throw Object.assign(new Error('At most one picture every 500 ms.'), { code: 'rate_limited' });
    this.#lastShot = t;
    const S = this.screen;
    const rgb = new Uint8Array(S.w * S.h * 3).fill(90);
    const fill = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
      for (let yy = Math.max(0, y); yy < Math.min(S.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(S.w, x + w); xx++) rgb.set(c, (yy * S.w + xx) * 3);
    };
    let blacked = 0;
    let masked = 0;
    for (const w of this.#visible()) {
      const [x, y, ww, hh] = w.bounds;
      if (this.#hidden(w)) {
        fill(x, y, ww, hh, [0, 0, 0]);
        blacked++;
        continue;
      }
      fill(x, y, ww, hh, w.color);
      for (const e of w.elements) {
        const [ex, ey, ew, eh] = e.box;
        if (e.secure) {
          fill(x + ex, y + ey, ew, eh, [20, 20, 20]);
          masked++;
        } else fill(x + ex, y + ey, ew, eh, [255, 255, 255]);
      }
    }
    // The area: a window, part of the screen, or the whole screen.
    let [ox, oy, cw, ch] = [0, 0, S.w, S.h];
    let win: FixtureWindow | undefined;
    if (a.window) {
      win = this.#find(a.window);
      [ox, oy, cw, ch] = win.bounds;
    } else if (Array.isArray(a.area) && a.area.length === 4) {
      [ox, oy, cw, ch] = (a.area as unknown[]).map((n) => Math.round(Number(n) || 0)) as [number, number, number, number];
    }
    ox = Math.max(0, Math.min(S.w - 1, ox));
    oy = Math.max(0, Math.min(S.h - 1, oy));
    cw = Math.max(1, Math.min(S.w - ox, cw));
    ch = Math.max(1, Math.min(S.h - oy, ch));
    const maxEdge = Math.max(64, Math.min(DESKTOP_LIMITS.maxEdge, Number(a.maxEdge) || DESKTOP_LIMITS.maxEdge));
    const scale = Math.min(1, maxEdge / Math.max(cw, ch));
    const w = Math.max(1, Math.round(cw * scale));
    const h = Math.max(1, Math.round(ch * scale));
    const out = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = ox + Math.min(cw - 1, Math.floor(x / scale));
      const sy = oy + Math.min(ch - 1, Math.floor(y / scale));
      out.set(rgb.subarray((sy * S.w + sx) * 3, (sy * S.w + sx) * 3 + 3), (y * w + x) * 3);
    }
    const viewId = `v${++this.#viewN}`;
    const targetWindow = win ?? this.front();
    const v: View = { id: viewId, at: t, ox, oy, scale, width: w, height: h, ...(targetWindow ? { window: targetWindow.id, signature: this.#signature(targetWindow) } : {}) };
    this.#views.set(viewId, v);
    for (const [k, old] of this.#views) if (t - old.at > DESKTOP_LIMITS.viewTtlMs * 3) this.#views.delete(k);
    const result: Record<string, unknown> = { viewId, w, h, scale, blackedOut: blacked, masked, ...(win ? { window: { id: win.id, title: maskDesktopText(win.title), app: win.app } } : { screen: S.id }) };
    if (a.marks === true) {
      const target = win ?? this.front();
      if (target) {
        const { items, total } = this.#items(target, v, DESKTOP_LIMITS.elements);
        for (const it of items) {
          const [bx, by, bw, bh] = it.box!;
          for (let xx = bx; xx < bx + bw; xx++) for (const yy of [by, by + bh - 1]) if (xx >= 0 && xx < w && yy >= 0 && yy < h) out.set([230, 30, 30], (yy * w + xx) * 3);
          for (let yy = by; yy < by + bh; yy++) for (const xx of [bx, bx + bw - 1]) if (xx >= 0 && xx < w && yy >= 0 && yy < h) out.set([230, 30, 30], (yy * w + xx) * 3);
        }
        Object.assign(result, { items, total, marksOf: { id: target.id, title: maskDesktopText(target.title), app: target.app } });
      }
    }
    return { png: encodePng(w, h, out), w, h, viewId, result };
  }
}
