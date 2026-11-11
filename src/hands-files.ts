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
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
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

/**
 * The relative path parts, or a FileRuleError: no "..", ".", drive letters, colons, leading
 * slashes, "~", UNC or device prefixes, control characters; at most 260 characters.
 */
export function cleanRelPath(raw: unknown): string[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.length > FILE_LIMITS.pathChars) throw new FileRuleError('denied_local', 'That path is too long.');
  if (/[\u0000-\u001f<>"|?*]/.test(s)) throw new FileRuleError('denied_local', 'That path has characters a file name can\u2019t have.');
  if (/^[\\/]/.test(s) || /^[a-z]:/i.test(s) || s.includes(':') || s.startsWith('~')) throw new FileRuleError('denied_local', 'Only a path inside Desktop, Documents or Downloads (like "Projects/notes.txt"), never a full path or another drive.');
  const parts = s.split(/[\\/]+/).filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === '.' || p === '..' || /^\.+$/.test(p)) throw new FileRuleError('denied_local', 'Only folders inside Desktop, Documents or Downloads: ".." is not allowed.');
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

/** Resolves folder + parts to a real path inside that folder's real root (or throws). */
function resolveIn(rootRaw: string, parts: string[]): { root: string; full: string } {
  let root: string;
  try {
    root = realpathSync(rootRaw);
  } catch {
    throw new FileRuleError('not_found', 'That folder isn\u2019t on this computer.');
  }
  for (const p of parts) if (hiddenName(p) || secretName(p)) throw new FileRuleError('denied_local', 'That file or folder is hidden or looks like it holds secrets (keys, passwords): it is never read.');
  let full: string;
  try {
    full = realpathSync(join(root, ...parts));
  } catch {
    throw new FileRuleError('not_found', 'There is no such file or folder there.');
  }
  if (!inside(root, full)) throw new FileRuleError('denied_local', 'That points outside the folder (a link or junction): it is never followed.');
  return { root, full };
}

/** f.list on a folder of this computer: { folder, path, entries, total, more, hidden }. */
export function listFiles(roots: Partial<Record<FileFolder, string>>, args: Record<string, unknown>): Record<string, unknown> {
  const folder = fileFolder(args.folder);
  if (!folder || !roots[folder]) throw new FileRuleError('denied_local', 'Only Desktop, Documents or Downloads.');
  const parts = cleanRelPath(args.path);
  const { root, full } = resolveIn(roots[folder]!, parts);
  if (!statSync(full).isDirectory()) throw new FileRuleError('not_found', 'That is a file, not a folder (read it instead).');
  const all: FileEntry[] = [];
  let hidden = 0;
  for (const d of readdirSync(full, { withFileTypes: true })) {
    if (hiddenName(d.name) || secretName(d.name)) {
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
        if (!inside(root, realpathSync(join(full, d.name)))) {
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
export function readTextFile(roots: Partial<Record<FileFolder, string>>, args: Record<string, unknown>): Record<string, unknown> {
  const folder = fileFolder(args.folder);
  if (!folder || !roots[folder]) throw new FileRuleError('denied_local', 'Only Desktop, Documents or Downloads.');
  const parts = cleanRelPath(args.path);
  if (!parts.length) throw new FileRuleError('denied_local', 'Say which file (its path inside the folder).');
  const { full } = resolveIn(roots[folder]!, parts);
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
    if (!name || hiddenName(name) || secretName(name)) continue;
    out.push({ name: maskDesktopText(name), dir: o.dir === true, ...(typeof o.bytes === 'number' && o.dir !== true ? { bytes: o.bytes } : {}), ...(typeof o.at === 'string' ? { at: o.at.slice(0, 40) } : {}) });
  }
  return out;
}
