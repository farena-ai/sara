// 3.4.x (computer use, the owner's own files): what the Sara app on a computer lets the companion
// read there, READ ONLY, when the person switched on "Files" in the app (Settings → Computer use; off
// by default). Two ops: f.list (a folder) and f.read (a small text file). Only inside the person's
// Desktop, Documents and Downloads folders (and their subfolders). The rules live here so the server,
// the reference device (src/hands-ref.ts) and the tests agree; the Windows app does the same in
// desktop/windows/src/hands-files.cpp before anything leaves the computer.
//
// - folder is one of desktop / documents / downloads; path is relative to it: no "..", no "." parts,
//   no drive letters, colons (alternate data streams), leading slashes, "~" or UNC prefixes;
// - the real path (links and junctions followed) must stay inside the real folder;
// - hidden entries (dot names; on Windows the hidden/system attributes) and secret-shaped names (keys,
//   certificates, password databases, wallets, .env files) are left out of lists and never read;
// - a list has at most 200 entries; a read only text-type files up to 1 MB, at most 32,000
//   characters back, NUL bytes refuse it as binary, key-shaped text is masked;
// - nothing is ever written, moved, renamed, opened or deleted.
//
// 3.5.x (reach): the person may let her read more than the three folders (the app's "Which folders"
// under Files): folders they pick, their whole user folder, or all their drives. Each allowed place is a
// ROOT with a short name ("desktop", "Projects", "home", "drive C"); the server is told only those
// names (HandsHello.fileRoots), never the paths. Whatever the roots, these stay out at any depth: system
// folders (Windows, Program Files, ProgramData, AppData…), other people's user folders, and places that
// hold keys or credentials (.ssh, .gnupg, password stores, browser profiles, wallets).
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, isAbsolute, sep } from 'node:path';
import { maskDesktopText } from './hands-desktop.ts';

/** The ops (need "Files" on that computer). */
export const FILE_OPS = ['f.list', 'f.read'] as const;
export const FILE_OPS_SET: ReadonlySet<string> = new Set(FILE_OPS);
/** The person's own folders the companion may read (names as the tool and the device use them). */
export const FILE_FOLDERS = ['desktop', 'documents', 'downloads'] as const;
export type FileFolder = (typeof FILE_FOLDERS)[number];
export const FILE_FOLDER_NAMES: Record<FileFolder, string> = { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads' };
export const FILE_LIMITS = { entries: 200, readBytes: 1024 * 1024, chars: 32_000, pathChars: 260 } as const;
/** File types read as text (lower case, with the dot). */
export const TEXT_TYPES: ReadonlySet<string> = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.ini', '.cfg', '.conf', '.yaml', '.yml', '.toml', '.srt', '.vtt', '.text']);

/** Secret-shaped file names: left out of lists, never read. */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|ppk|kdbx|kdb|keychain|keychain-db|jks|keystore|gpg|asc|ovpn|sqlite-wal)$/i,
  /^wallet\.dat$/i,
  /^\.?netrc$/i,
  /^credentials(\.json)?$/i,
  /^\.?npmrc$/i,
  /^\.?git-credentials$/i,
  /passwords?\b/i,
  /recovery[ _-]?(codes?|key)/i,
  /seed[ _-]?phrase/i,
];
export const secretName = (name: string): boolean => SECRET_NAMES.some((re) => re.test(name));
/**
 * 3.5.x: folders never entered whatever the roots (lower case): system folders, app data (browser
 * profiles, password stores, wallets live there), and folders named after key/credential stores.
 * The same list as desktop/windows/src/hands-files.cpp (kBlockedDirs).
 */
export const BLOCKED_DIRS: ReadonlySet<string> = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'application data', 'local settings', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'config.msi', 'msocache', '$windows.~bt', '$windows.~ws', 'windows.old', 'documents and settings', 'boot', 'efi',
  'library', 'user data', 'mozilla', 'thunderbird',
  '1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'enpass', 'password store', 'passwords', 'electrum', 'exodus', 'wallets', 'wallet', 'bitcoin', 'ethereum', 'monero',
]);
export const blockedDir = (name: string): boolean => BLOCKED_DIRS.has(name.toLowerCase().trim());
export const hiddenName = (name: string): boolean => name.startsWith('.') || /^(desktop\.ini|thumbs\.db|\$recycle\.bin|ntuser\.dat.*)$/i.test(name);

export class FileRuleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A folder name as given (\"Desktop\", \"my documents\"), or undefined. */
export function fileFolder(raw: unknown): FileFolder | undefined {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^my\s+/, '');
  if (s === 'desktop') return 'desktop';
  if (s === 'documents' || s === 'document' || s === 'docs' || s === 'my documents') return 'documents';
  if (s === 'downloads' || s === 'download') return 'downloads';
  return undefined;
}

/** 3.5.x: "Which folders" on that computer (the app's choice under Files). */
export const FILE_SCOPES = ['three', 'picked', 'home', 'drives'] as const;
export type FileScope = (typeof FILE_SCOPES)[number];
/** At most this many roots are kept from a device's hello. */
export const MAX_FILE_ROOTS = 40;

/** A root's name as the server keeps it: plain text, no slashes or colons except "drive X", ≤ 60 characters. */
export function rootName(raw: unknown): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s;
}
/** The roots a device reported (names only); an older app means the three folders. */
export function fileRootsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...FILE_FOLDERS];
  const out: string[] = [];
  for (const x of raw.slice(0, MAX_FILE_ROOTS)) {
    const n = rootName(x);
    if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.length ? out : [...FILE_FOLDERS];
}
/** A root name as given ("Desktop", "my documents", "projects", "drive c") → the device's root name, or undefined. */
export function matchRoot(raw: unknown, roots: readonly string[]): string | undefined {
  const known = fileFolder(raw);
  if (known && roots.includes(known)) return known;
  const s = String(raw ?? '').trim().toLowerCase().replace(/^my\s+/, '').replace(/[:\\/]+$/, '');
  if (!s) return undefined;
  const drive = /^(?:drive\s+)?([a-z])$/.exec(s);
  return roots.find((r) => r.toLowerCase() === s) ?? (drive ? roots.find((r) => r.toLowerCase() === `drive ${drive[1]}`) : undefined) ?? (s === 'user folder' || s === 'my user folder' || s === 'home folder' ? roots.find((r) => r === 'home') : undefined);
}
/** The display name of a root ("Desktop" for desktop, others as they are). */
export const rootLabel = (root: string): string => (FILE_FOLDER_NAMES as Record<string, string>)[root] ?? root;

/**
 * The reference device's roots for a scope (the same naming as the Windows app): the three folders,
 * then each picked folder by its own name ("Projects", "Projects 2" for a second one), "home"
 * (the user folder) or each drive as "drive C".
 */
export function rootsFor(scope: FileScope, base: Partial<Record<FileFolder, string>>, opts: { picked?: string[]; home?: string; drives?: string[] } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILE_FOLDERS) if (base[k]) out[k] = base[k]!;
  const add = (name: string, path: string) => {
    let n = rootName(name) || 'folder';
    for (let i = 2; Object.keys(out).some((k) => k.toLowerCase() === n.toLowerCase()); i++) n = `${rootName(name) || 'folder'} ${i}`;
    out[n] = path;
  };
  if (scope === 'picked') for (const p of (opts.picked ?? []).slice(0, 20)) add(basename(p) || p, p);
  if ((scope === 'home' || scope === 'drives') && opts.home) out.home = opts.home;
  if (scope === 'drives') for (const d of opts.drives ?? []) add(`drive ${d.replace(/[:\\/]+$/, '').toUpperCase()}`, d);
  return out;
}

/**
 * The relative path parts, or a FileRuleError: no "..", ".", drive letters, colons, leading
 * slashes, "~", UNC or device prefixes, control characters; at most 260 characters.
 */
export function cleanRelPath(raw: unknown): string[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.length > FILE_LIMITS.pathChars) throw new FileRuleError('denied_local', 'That path is too long.');
  if (/[\u0000-\u001f<>"|?*]/.test(s)) throw new FileRuleError('denied_local', 'That path has characters a file name can\u2019t have.');
  if (/^[\\/]/.test(s) || /^[a-z]:/i.test(s) || s.includes(':') || s.startsWith('~')) throw new FileRuleError('denied_local', 'Only a path inside one of the allowed folders (like "Projects/notes.txt"), never a full path or another drive.');
  const parts = s.split(/[\\/]+/).filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === '.' || p === '..' || /^\.+$/.test(p)) throw new FileRuleError('denied_local', 'Only folders inside the allowed folders: ".." is not allowed.');
    if (/[. ]$/.test(p)) throw new FileRuleError('denied_local', 'That name ends with a dot or a space, which Windows doesn\u2019t allow.');
  }
  return parts;
}

/** Inside the root (both real paths)? */
const inside = (root: string, full: string) => {
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
};

export interface FileEntry {
  name: string;
  dir: boolean;
  bytes?: number;
  at?: string;
}

export const BLOCKED_AREA = 'That is a system folder, another person\u2019s folder or a place that holds keys or passwords: it is never read.';
/** The person's own user folder and the folder that holds everyone's (other people's are never entered). */
export interface FileAreas {
  /** The person's own user folder (C:\\Users\\Alex). */
  home?: string;
  /** Where every user folder lives (C:\\Users); others' folders in it are refused. */
  usersDir?: string;
}
/** Is a real path in a refused area (a blocked folder at any depth below the root, or another person's user folder)? */
export function blockedArea(root: string, full: string, areas: FileAreas = {}): boolean {
  const rel = relative(root, full);
  if (rel && rel.split(/[\\/]+/).some((p) => blockedDir(p) || hiddenName(p) || secretName(p))) return true;
  if (areas.usersDir) {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const usersDir = real(areas.usersDir);
    const homeDir = areas.home ? real(areas.home) : '';
    const u = relative(usersDir, full);
    if (u && !u.startsWith('..') && !isAbsolute(u)) {
      const who = u.split(/[\\/]+/)[0].toLowerCase();
      const me = homeDir ? basename(homeDir).toLowerCase() : '';
      if (who !== me && who !== 'public') return true;
      // C:\Users\Public is fine; inside the person's own folder AppData etc. are caught above when the root is higher.
      if (who === me && homeDir) {
        const inHome = relative(homeDir, full);
        if (inHome && inHome.split(/[\\/]+/).some((p) => blockedDir(p) || hiddenName(p))) return true;
      }
    }
  }
  return false;
}

/** Resolves folder + parts to a real path inside that folder's real root (or throws). */
function resolveIn(rootRaw: string, parts: string[], areas: FileAreas = {}): { root: string; full: string } {
  let root: string;
  try {
    root = realpathSync(rootRaw);
  } catch {
    throw new FileRuleError('not_found', 'That folder isn\u2019t on this computer.');
  }
  for (const p of parts) if (hiddenName(p) || secretName(p)) throw new FileRuleError('denied_local', 'That file or folder is hidden or looks like it holds secrets (keys, passwords): it is never read.');
  for (const p of parts) if (blockedDir(p)) throw new FileRuleError('denied_local', BLOCKED_AREA);
  let full: string;
  try {
    full = realpathSync(join(root, ...parts));
  } catch {
    throw new FileRuleError('not_found', 'There is no such file or folder there.');
  }
  if (!inside(root, full)) throw new FileRuleError('denied_local', 'That points outside the folder (a link or junction): it is never followed.');
  if (blockedArea(root, full, areas)) throw new FileRuleError('denied_local', BLOCKED_AREA);
  return { root, full };
}

/** f.list on a folder of this computer: { folder, path, entries, total, more, hidden }. */
export function listFiles(roots: Partial<Record<string, string>>, args: Record<string, unknown>, areas: FileAreas = {}): Record<string, unknown> {
  const names = Object.keys(roots).filter((k) => roots[k]);
  const folder = matchRoot(args.folder, names);
  if (!folder) throw new FileRuleError('denied_local', `Only these folders: ${names.map(rootLabel).join(', ')}.`);
  const parts = cleanRelPath(args.path);
  const { root, full } = resolveIn(roots[folder]!, parts, areas);
  if (!statSync(full).isDirectory()) throw new FileRuleError('not_found', 'That is a file, not a folder (read it instead).');
  const all: FileEntry[] = [];
  let hidden = 0;
  for (const d of readdirSync(full, { withFileTypes: true })) {
    if (hiddenName(d.name) || secretName(d.name) || blockedDir(d.name) || blockedArea(root, join(full, d.name), areas)) {
      hidden++;
      continue;
    }
    let st;
    try {
      st = lstatSync(join(full, d.name));
    } catch {
      continue;
    }
    // Links and junctions that lead outside are left out (they are never followed).
    if (st.isSymbolicLink()) {
      try {
        const real = realpathSync(join(full, d.name));
        if (!inside(root, real) || blockedArea(root, real, areas)) {
          hidden++;
          continue;
        }
        st = statSync(join(full, d.name));
      } catch {
        continue;
      }
    }
    all.push({ name: maskDesktopText(d.name), dir: st.isDirectory(), ...(st.isDirectory() ? {} : { bytes: st.size }), at: st.mtime.toISOString() });
  }
  all.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const entries = all.slice(0, FILE_LIMITS.entries);
  return { folder, path: parts.join('/'), entries, total: all.length, more: all.length > entries.length, hidden };
}

/** f.read of a small text file: { folder, path, name, bytes, text, more }. */
export function readTextFile(roots: Partial<Record<string, string>>, args: Record<string, unknown>, areas: FileAreas = {}): Record<string, unknown> {
  const names = Object.keys(roots).filter((k) => roots[k]);
  const folder = matchRoot(args.folder, names);
  if (!folder) throw new FileRuleError('denied_local', `Only these folders: ${names.map(rootLabel).join(', ')}.`);
  const parts = cleanRelPath(args.path);
  if (!parts.length) throw new FileRuleError('denied_local', 'Say which file (its path inside the folder).');
  const { full } = resolveIn(roots[folder]!, parts, areas);
  const st = statSync(full);
  if (st.isDirectory()) throw new FileRuleError('not_found', 'That is a folder (list it instead).');
  const name = parts[parts.length - 1];
  const ext = (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase();
  if (!TEXT_TYPES.has(ext)) throw new FileRuleError('denied_local', `Only text files can be read (${[...TEXT_TYPES].slice(0, 8).join(', ')}…). For a Word, PDF or picture file, ask the owner to send it in the chat.`);
  if (st.size > FILE_LIMITS.readBytes) throw new FileRuleError('denied_local', `That file is ${Math.round(st.size / 1024)} KB: only text files up to 1 MB are read.`);
  const buf = readFileSync(full);
  if (buf.includes(0)) throw new FileRuleError('denied_local', 'That file is not text (it has binary data).');
  const all = buf.toString('utf8').replace(/^\uFEFF/, '');
  const max = Math.min(FILE_LIMITS.chars, Math.max(500, Number(args.max ?? FILE_LIMITS.chars) || FILE_LIMITS.chars));
  return { folder, path: parts.join('/'), name: maskDesktopText(name), bytes: st.size, at: st.mtime.toISOString(), text: maskDesktopText(all.slice(0, max)), more: all.length > max };
}

/** What the server keeps of a device's f.list answer (whatever a device sends). */
export function fileEntries(raw: unknown): FileEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FileEntry[] = [];
  for (const x of raw.slice(0, FILE_LIMITS.entries)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const name = String(o.name ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 255);
    if (!name || hiddenName(name) || secretName(name) || (o.dir === true && blockedDir(name))) continue;
    out.push({ name: maskDesktopText(name), dir: o.dir === true, ...(typeof o.bytes === 'number' && o.dir !== true ? { bytes: o.bytes } : {}), ...(typeof o.at === 'string' ? { at: o.at.slice(0, 40) } : {}) });
  }
  return out;
}
