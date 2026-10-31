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
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

/** CU5's command set: look at the desktop (no input: that is CU6). */
export const CU5_OPS = ['d.screens', 'd.windows', 'd.shot', 'd.elements'] as const;
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
}

/** The fixture desktop: the same rules as the apps, on known windows. */
export class TestDesktop {
  readonly screen = { id: 's1', w: 1100, h: 700, scale: 1, primary: true };
  readonly windows: FixtureWindow[];
  readonly extra: string[];
  readonly #views = new Map<string, View>();
  #viewN = 0;
  #lastShot = 0;
  /** Tests: the clock. */
  now = () => Date.now();

  constructor(opts: { windows?: FixtureWindow[]; extra?: string[] } = {}) {
    this.windows = opts.windows ?? fixtureWindows();
    this.extra = opts.extra ?? [];
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
    const { items, total } = this.#items(w, v, limit);
    return { window: { id: w.id, title: maskDesktopText(w.title), app: w.app }, items, total, ...(total > items.length ? { more: true } : {}), coords: v ? 'picture' : 'screen' };
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
    const v: View = { id: viewId, at: t, ox, oy, scale, ...(win ? { window: win.id } : {}) };
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
