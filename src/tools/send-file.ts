// Phase 115 (BR1, docs/design/BRIDGES2.md §4.4): send_file, "Share a file in this chat". The only
// new tool of the track. She shares a file she made or found (a workspace file, or a library
// document) into the conversation: the web app shows a chip that downloads it, and Telegram,
// Discord and plugin bridges send it as a real file after the turn.
//
// Checks, in order: the workspace path guard (no `..`, no links out, no secret-looking files, no
// data folder), the size caps, the minors check on the name, caption and text-like content, and the
// secrets check: a saved secret's exact value is a hard refusal; a key-shaped string makes it ask
// first (with the line number, redacted). It also asks first in a shared work room and over 5 MB.
// The model only ever reads "Shared report.pdf (120 KB) in this chat." or the refusal, never the
// content. Off in private conversations and private local mode (OFFSERVER_TOOL), and never offered
// outside the owner's own chats (chat.ts).
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { AppContext } from '../chat.ts';
import { KEY_SHAPED, vaultSecretValues } from '../redact.ts';
import { minorSexualMatch } from '../safety.ts';
import { fileQuotaHit, recordShared, SEND_FILE_ASK_BYTES, sha256, sharedDir, TELEGRAM_FILE_OUT } from '../bridges/media.ts';
import { ToolError, type Prepared, type Tool } from './types.ts';
import { resolveInside, workspaceDir } from './workspace.ts';

const MAX_SEND_BYTES = TELEGRAM_FILE_OUT;
const SCAN_BYTES = 1024 * 1024;

/** Names that are never shared, whatever the folder (keys, env files, the vault). */
const SECRET_NAME = /(^|[\\/])(\.secrets|\.ssh|\.gnupg)([\\/]|$)|(^|[\\/])\.env(\.[^\\/]*)?$|(^|[\\/])id_[a-z0-9]+(\.pub)?$|\.(pem|key|p12|pfx|keystore|jks)$|(^|[\\/])(vault|vault\.json|vault\.enc|sara\.db|store\.db)$/i;

const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

export const humanSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Text-like: the first 64 KB decode as UTF-8 without NUL bytes. */
function textLike(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  return !head.toString('utf8').includes('\uFFFD');
}

interface Found {
  path: string;
  name: string;
  bytes: number;
  mime: string;
}

/** What the call points at (a workspace path or a library document), checked; throws a ToolError with the refusal. */
function locate(app: AppContext, args: Record<string, unknown>, conversationId: string | undefined): Found {
  const conv = conversationId ? app.store.getConversation(conversationId) : undefined;
  if (!conv) throw new ToolError('There is no conversation to share the file in.');
  if (conv.partner) throw new ToolError("Files can't be shared in this chat.");
  const libId = Number(args.libraryId);
  if (args.libraryId !== undefined && args.libraryId !== null && args.libraryId !== '') {
    const doc = Number.isInteger(libId) ? app.library?.get(libId) : undefined;
    const path = doc ? app.library?.filePath(doc) : undefined;
    if (!doc || !path || !existsSync(path)) throw new ToolError('That library document has no file to share.');
    return { path, name: doc.name, bytes: statSync(path).size, mime: mimeOf(doc.name) };
  }
  const p = String(args.path ?? '').trim();
  if (!p) throw new ToolError('Give the path of a file in the workspace, or a library document id.');
  const root = workspaceDir(app.rootDir ?? app.dataDir, conv.workspace);
  const abs = resolveInside(root, p);
  if (!existsSync(abs)) throw new ToolError(`There is no file at ${p}.`);
  const real = realpathSync(abs);
  const rel = relative(root, real).split(sep).join('/');
  if (SECRET_NAME.test(rel)) throw new ToolError("That file looks like it holds keys or secrets, so I won't send it.");
  // The data folder itself (when a workspace sits inside it through a link).
  if (real.startsWith(join(app.dataDir, 'vault')) || real === join(app.dataDir, 'sara.db')) throw new ToolError("That file is part of Sara's own data, so I won't send it.");
  if (lstatSync(abs).isDirectory()) throw new ToolError('That is a folder; share a file.');
  return { path: real, name: basename(real), bytes: statSync(real).size, mime: mimeOf(real) };
}

/** The content checks: a saved secret refuses, a key-shaped string asks (with its line, redacted), the minors check refuses. */
function scan(app: AppContext, f: Found, caption: string): { refuse?: string; ask?: string } {
  if (minorSexualMatch(`${f.name} ${caption}`, { fromHer: true })) return { refuse: "I won't share that." };
  const bytes = readFileSync(f.path).subarray(0, SCAN_BYTES);
  if (!textLike(bytes)) return {};
  const text = bytes.toString('utf8');
  for (const v of vaultSecretValues(app.vault.values())) if (v.length >= 6 && text.includes(v)) return { refuse: "That file contains one of your saved secrets, so I won't send it." };
  if (minorSexualMatch(text, { fromHer: true })) return { refuse: "I won't share that." };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (KEY_SHAPED.some((re) => re.test(lines[i]))) return { ask: `line ${i + 1} looks like a key: ${app.redactor.redact(lines[i]).trim().slice(0, 120)}` };
  }
  return {};
}

export function createSendFileTool(getApp: () => AppContext): Tool {
  const tool: Tool = {
    spec: {
      name: 'send_file',
      description: 'Share a file in this chat: a file in the workspace (path) or a library document (libraryId). The owner gets it as a real file (a download in the app; a file in Telegram or Discord). Use it when he asks for a file, a PDF, a chart or a document. Pictures you make already arrive with your reply.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A file inside the workspace, e.g. "report.pdf" or "out/chart.png".' },
          libraryId: { type: 'number', description: 'A library document id (instead of path).' },
          caption: { type: 'string', description: 'A short line to go with it (up to 300 characters).' },
        },
      },
    },
    defaultPermission: 'auto',
    summarize: (args) => `Share ${String(args.path ?? (args.libraryId !== undefined ? `library document ${String(args.libraryId)}` : 'a file')).slice(0, 120)} in this chat`,
    prepare: async (args, ctx): Promise<Prepared> => {
      const app = getApp();
      try {
        const f = locate(app, args, ctx.conversationId);
        if (f.bytes > MAX_SEND_BYTES) return { refuse: `Error: ${f.name} is ${humanSize(f.bytes)}; chat apps take files up to ${humanSize(MAX_SEND_BYTES)}.` };
        const caption = String(args.caption ?? '').slice(0, 300);
        const s = scan(app, f, caption);
        if (s.refuse) return { refuse: `Error: ${s.refuse}` };
        const conv = app.store.getConversation(ctx.conversationId!)!;
        const room = /-work(-nsfw)?$/.test(conv.channel);
        const reasons = [room ? 'this is a shared room' : '', f.bytes > SEND_FILE_ASK_BYTES ? `it is ${humanSize(f.bytes)}` : '', s.ask ?? ''].filter(Boolean);
        return { summary: `Share ${f.name} (${humanSize(f.bytes)}) in this chat${reasons.length ? `: ${reasons.join('; ')}` : ''}`, ...(reasons.length ? { ask: true } : {}) };
      } catch (err) {
        return { refuse: `Error: ${(err as Error).message}` };
      }
    },
    run: async (args, ctx) => {
      const app = getApp();
      const f = locate(app, args, ctx.conversationId);
      if (f.bytes > MAX_SEND_BYTES) throw new ToolError(`${f.name} is too big to share (${humanSize(f.bytes)}).`);
      const caption = String(args.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const s = scan(app, f, caption);
      if (s.refuse) throw new ToolError(s.refuse);
      if (fileQuotaHit(app, f.bytes)) throw new ToolError("That's my file limit for today.");
      const conv = app.store.getConversation(ctx.conversationId!)!;
      const bytes = readFileSync(f.path);
      const hash = sha256(bytes);
      const copy = join(sharedDir(app), hash);
      if (!existsSync(copy)) copyFileSync(f.path, copy);
      const keep = (app.settings.get() as { chats?: { media?: { sentKeepDays?: number } } }).chats?.media?.sentKeepDays;
      const days = [7, 30, 90].includes(Number(keep)) ? Number(keep) : 30;
      const id = recordShared(app, { conversationId: conv.id, direction: 'out', bridge: conv.channel.startsWith('telegram') ? 'telegram' : conv.channel.startsWith('discord') ? 'discord' : conv.channel.startsWith('plugin-') ? conv.channel : 'web', chatKey: conv.channelKey ?? conv.id, sender: 'her', kind: 'file', name: f.name, mime: f.mime, bytes: f.bytes, path: copy, status: 'ok', expiresAt: new Date(app.now().getTime() + days * 86_400_000).toISOString() });
      ctx.attachFile?.({ id, name: f.name, mime: f.mime, bytes: f.bytes, ...(caption ? { caption } : {}) });
      return `Shared ${f.name} (${humanSize(f.bytes)}) in this chat.`;
    },
  };
  return tool;
}
