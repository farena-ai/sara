// Phase 51: the shape both export readers (ChatGPT, Claude) turn their files into.

// Phase 65: the companion apps ("Bring her from another app", src/companion-import/) as well.
// Phase 104 (move-in, docs/design/MOVE_IN.md): Hermes Agent and OpenClaw agents moving in.
export type HistorySource = 'chatgpt' | 'claude' | 'characterai' | 'sillytavern' | 'replika' | 'nomi' | 'kindroid' | 'text' | 'hermes' | 'openclaw';

/** How the other assistant is named in her prompt, recall and notes. */
export const SOURCE_NAME: Record<HistorySource, string> = { chatgpt: 'ChatGPT', claude: 'Claude', characterai: 'Character.AI', sillytavern: 'SillyTavern', replika: 'Replika', nomi: 'Nomi', kindroid: 'Kindroid', text: 'another app', hermes: 'Hermes Agent', openclaw: 'OpenClaw' };
/** The conversation channel imported chats live on. */
export const SOURCE_CHANNEL: Record<HistorySource, string> = { chatgpt: 'import-chatgpt', claude: 'import-claude', characterai: 'import-characterai', sillytavern: 'import-sillytavern', replika: 'import-replika', nomi: 'import-nomi', kindroid: 'import-kindroid', text: 'import-text', hermes: 'import-hermes', openclaw: 'import-openclaw' };
export const isHistorySource = (v: unknown): v is HistorySource => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_CHANNEL, v);

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO time the message was written (the original time). */
  createdAt: string;
  /** Things that were attached but aren't imported ("an image", "report.pdf"). */
  attachments?: string[];
}

export interface ImportedConversation {
  /** The conversation's id in the export (used to skip it on a second import). */
  sourceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ImportedMessage[];
}

/** What was left out while reading, for the preview. */
export interface SkipCounts {
  /** System prompts and custom instructions. */
  system: number;
  /** Tool calls, tool results, browsing and code-runner output. */
  tool: number;
  /** Hidden nodes, model reasoning and empty messages. */
  hidden: number;
  /** Pictures referenced by a message (not imported). */
  images: number;
  /** Other files attached to messages (not imported). */
  attachments: number;
  /** Conversations with no messages from you. */
  emptyConversations: number;
}

export const noSkips = (): SkipCounts => ({ system: 0, tool: 0, hidden: 0, images: 0, attachments: 0, emptyConversations: 0 });

export interface ParsedExport {
  source: HistorySource;
  conversations: ImportedConversation[];
  skipped: SkipCounts;
}

/** A time from an export (seconds since 1970, milliseconds, or an ISO string) as ISO, or undefined. */
export function isoTime(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** Message text is kept whole up to this size (a pasted log); longer is cut with a note. */
export const MAX_MESSAGE_CHARS = 60_000;

export function clipText(s: string): string {
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}\n[… the rest of this message was left out: too long]` : s;
}
