// Phase 65: finds out what an uploaded file is and reads it with the right reader. A zip is read
// with the project's own zip reader (src/library/zip.ts) under zip-bomb caps (entries, total size,
// unpack ratio); a ChatGPT or Claude export inside is read by the Phase 51 readers; anything else
// in it (a Character.AI export, a folder of SillyTavern chats, transcripts) by the readers here.
import { looksLikeChatGPT, parseChatGPT } from '../history-import/chatgpt.ts';
import { looksLikeClaude, parseClaude } from '../history-import/claude.ts';
import type { ParsedExport } from '../history-import/types.ts';
import { en } from '../i18n.ts';
import { ReadError } from '../library/read.ts';
import { decodeXmlBytes, openZip } from '../library/zip.ts';
import { looksLikeCharacterAI, looksLikeCsv, looksLikeGenericJson, looksLikeSillyTavern, readCharacterAI, readCsv, readGenericJson, readSillyTavern, readTranscript } from './readers.ts';
import { IMPORT_ZIP_LIMITS, ImportError, MAX_CONVERSATIONS, MAX_FILE_BYTES, MAX_SCANNED_ENTRIES, obj, type RawExport } from './types.ts';

export * from './types.ts';

const CONVERSATIONS_FILE = /(^|\/)conversations(-\d+)?\.jsonl?$/i;
const READABLE = /\.(json|jsonl|txt|md|markdown|csv|log)$/i;
const isZip = (b: Buffer) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
const isPng = (b: Buffer) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47;
const baseName = (n: string) => (n.split('/').pop() ?? n).replace(/\.[^.]+$/, '').slice(0, 60) || 'chat';

const NOT_A_CHAT = en("This file doesn't look like a chat export. Supported: ChatGPT and Claude exports, Character.AI chats, SillyTavern chats (.jsonl), and chats saved as JSON, CSV, text or Markdown.");
const CARD = en('This is a character card, not a chat. Import it in Settings → Sara → Name and personality → Import a character…');

/** A Phase 51 export (ChatGPT/Claude) as speakers: "You" and the assistant. */
function fromAssistant(p: ParsedExport): RawExport {
  const other = p.source === 'chatgpt' ? 'ChatGPT' : 'Claude';
  return {
    format: p.source === 'chatgpt' ? 'chatgpt' : 'claude',
    conversations: p.conversations.map((c) => ({ sourceId: c.sourceId, title: c.title, messages: c.messages.map((m) => ({ speaker: m.role === 'user' ? 'You' : other, text: m.text, at: m.createdAt })) })),
    ownerSpeakers: ['You'],
    characterName: other,
    leftOut: Object.values(p.skipped).reduce((a, b) => a + b, 0),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** One file (not a zip). `name` is its file name (the extension helps tell CSV and JSONL apart). */
export function readSingle(bytes: Buffer, name: string, now: Date): RawExport {
  if (bytes.length > MAX_FILE_BYTES) throw new ImportError(en('That file is bigger than 50 MB. Split it, or upload the zip it came in (up to 200 MB).'));
  if (isPng(bytes)) throw new ImportError(CARD);
  const head = bytes.subarray(0, 4096);
  if (head.includes(0) && !(head[0] === 0xff && head[1] === 0xfe) && !(head[0] === 0xfe && head[1] === 0xff)) throw new ImportError(NOT_A_CHAT);
  const text = decodeXmlBytes(bytes);
  const t = text.trimStart();
  const base = baseName(name);
  if (/\.jsonl$/i.test(name) || ((t.startsWith('{') || t.startsWith('[')) && parseJson(t) === undefined && /\n\s*\{/.test(t))) {
    const lines = text.split(/\r?\n/);
    const first = parseJson(lines.find((l) => l.trim()) ?? '');
    if (looksLikeSillyTavern(first)) return readSillyTavern(lines, base);
    const all = lines.filter((l) => l.trim()).map(parseJson).filter((x) => x !== undefined);
    if (looksLikeChatGPT(all)) return fromAssistant(parseChatGPT([all], now));
    if (looksLikeClaude(all)) return fromAssistant(parseClaude([all], now));
    if (looksLikeGenericJson(all)) return readGenericJson(all, base);
    throw new ImportError(NOT_A_CHAT);
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    const v = parseJson(t);
    if (v === undefined) throw new ImportError(en("This file isn't valid JSON, so it can't be read."));
    const o = obj(v);
    if (o && (/^chara_card_v[23]$/.test(String(o.spec ?? '')) || obj(o.data)?.first_mes !== undefined || (o.first_mes !== undefined && o.mes_example !== undefined))) throw new ImportError(CARD);
    const list = Array.isArray(v) ? v : o?.conversations;
    if (looksLikeChatGPT(list)) return fromAssistant(parseChatGPT([list], now));
    if (looksLikeClaude(list)) return fromAssistant(parseClaude([list], now));
    if (looksLikeCharacterAI(v)) return readCharacterAI(v);
    if (looksLikeGenericJson(v)) return readGenericJson(v, base);
    throw new ImportError(NOT_A_CHAT);
  }
  if (/\.csv$/i.test(name) || looksLikeCsv(text)) {
    if (looksLikeCsv(text)) return readCsv(text, base);
    throw new ImportError(en('This CSV file has no speaker and message columns (for example "sender" and "message").'));
  }
  const r = readTranscript(text, base);
  if (!r.conversations.length) throw new ImportError(en("No conversation found in this text. Each message should start with the speaker's name, like \"Alex: hi\" (a time before it is fine)."));
  return r;
}

/** Any upload: a zip (export) or a single chat file. */
export function readImportFile(bytes: Buffer, name: string, now: Date): RawExport {
  let r: RawExport;
  try {
    r = isZip(bytes) ? readZip(bytes, now) : readSingle(bytes, name, now);
  } catch (err) {
    if (err instanceof ReadError) throw new ImportError(err.message);
    throw err;
  }
  if (!r.conversations.length) throw new ImportError(en('There are no conversations in this file.'));
  if (r.conversations.length > MAX_CONVERSATIONS) r.conversations = r.conversations.slice(-MAX_CONVERSATIONS);
  return r;
}

function readZip(bytes: Buffer, now: Date): RawExport {
  const zip = openZip(bytes, IMPORT_ZIP_LIMITS);
  const names = [...zip.entries.keys()].filter((n) => !/(^|\/)(__MACOSX|\.)/.test(n));
  const convFiles = names.filter((n) => CONVERSATIONS_FILE.test(n)).sort();
  if (convFiles.length) {
    const lists: unknown[] = [];
    for (const n of convFiles) {
      const text = decodeXmlBytes(zip.read(n));
      if (/\.jsonl$/i.test(n)) lists.push(text.split(/\r?\n/).filter((l) => l.trim()).map(parseJson).filter((x) => x !== undefined));
      else {
        const v = parseJson(text);
        if (v === undefined) throw new ImportError(en("The conversations file in this export isn't valid JSON, so it can't be read."));
        lists.push(Array.isArray(v) ? v : obj(v)?.conversations);
      }
    }
    if (lists.some(looksLikeChatGPT)) return fromAssistant(parseChatGPT(lists, now));
    if (lists.some(looksLikeClaude)) return fromAssistant(parseClaude(lists, now));
  }
  // Anything else: every chat-like file in it, each read on its own, merged.
  const files = names.filter((n) => READABLE.test(n)).slice(0, MAX_SCANNED_ENTRIES);
  const parts: RawExport[] = [];
  for (const n of files) {
    const e = zip.get(n)!;
    if (e.size > MAX_FILE_BYTES || /(^|\/)(user|users|projects|account|settings)\.json$/i.test(n)) continue;
    try {
      parts.push(readSingle(zip.read(n), n, now));
    } catch (err) {
      if (err instanceof ReadError) throw new ImportError(err.message); // a bomb or a damaged zip stops it all
      /* not a chat: skipped */
    }
  }
  const found = parts.filter((p) => p.conversations.length);
  if (!found.length) throw new ImportError(en('No chats found in this zip. Supported: ChatGPT and Claude exports, Character.AI chats, SillyTavern chats (.jsonl), and chats saved as JSON, CSV, text or Markdown.'));
  // The most common kind of file wins the name; all chats are kept.
  const byFormat = new Map<string, number>();
  for (const p of found) byFormat.set(p.format, (byFormat.get(p.format) ?? 0) + p.conversations.length);
  const format = [...byFormat].sort((a, b) => b[1] - a[1])[0][0] as RawExport['format'];
  const seen = new Set<string>();
  return {
    format,
    conversations: found.flatMap((p) => p.conversations).filter((c) => !seen.has(c.sourceId) && Boolean(seen.add(c.sourceId))),
    ownerSpeakers: [...new Set(found.flatMap((p) => p.ownerSpeakers))],
    ...(found.find((p) => p.characterName)?.characterName ? { characterName: found.find((p) => p.characterName)!.characterName } : {}),
    leftOut: found.reduce((n, p) => n + p.leftOut, 0),
  };
}
