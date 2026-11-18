// V1.1 (docs/design/V1MOVEIN.md): what a ChatGPT or Claude export knows about you besides the chats.
// ChatGPT: saved memories (memories*.json in newer exports, and every memory the model wrote inside a
// chat: assistant messages to the "bio" tool), custom instructions (user.json / user_settings.json /
// custom_instructions.json: about_user_message, about_model_message and friends). Claude: projects.json
// (each project's instructions = prompt_template, and its knowledge files = docs[].content). They come in
// as notes on Import (src/history-import/index.ts); nothing here writes anything.
import type { HistorySource } from './types.ts';

export interface ExportNote {
  kind: 'memory' | 'instructions' | 'project';
  text: string;
  /** The export file (and item) it came from. */
  from: string;
  /** Custom instructions: about you, or how you want answers. */
  about?: 'you' | 'answers';
  /** Longer than a note: the first part is kept. */
  clipped?: boolean;
}

/** One note's size: longer knowledge files keep their start (the checklist says so). */
export const NOTE_CHARS = 2000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const parse = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
};

const MEMORY_FILE = /(^|\/)(memories|memory|user_memories|saved_memories)\.json$/i;
const USER_FILE = /(^|\/)(user|user_settings|custom_instructions|users)\.json$/i;
const PROJECTS_FILE = /(^|\/)projects\.json$/i;

const ABOUT_YOU = ['about_user_message', 'about_user', 'aboutUser', 'what_should_chatgpt_know', 'user_profile', 'traits_about_user'];
const ABOUT_ANSWERS = ['about_model_message', 'about_model', 'aboutModel', 'how_should_chatgpt_respond', 'traits_model_message', 'response_style'];

function clip(text: string): { text: string; clipped: boolean } {
  return text.length > NOTE_CHARS ? { text: `${text.slice(0, NOTE_CHARS - 2).trimEnd()} …`, clipped: true } : { text, clipped: false };
}

/** Memory texts from a memories file: strings, or objects with content / memory / text / value. */
function memoryTexts(v: unknown): string[] {
  const list = Array.isArray(v) ? v : Array.isArray(obj(v)?.memories) ? (obj(v)!.memories as unknown[]) : Array.isArray(obj(v)?.items) ? (obj(v)!.items as unknown[]) : [];
  return list.map((x) => (typeof x === 'string' ? x.trim() : str(obj(x)?.content) || str(obj(x)?.memory) || str(obj(x)?.text) || str(obj(x)?.value))).filter(Boolean);
}

/** Custom-instruction fields wherever they sit (top level, under custom_instructions, or a settings list). */
function instructionFields(v: unknown, out: { about: 'you' | 'answers'; text: string }[], depth = 0): void {
  if (depth > 3) return;
  if (Array.isArray(v)) return void v.forEach((x) => instructionFields(x, out, depth + 1));
  const o = obj(v);
  if (!o) return;
  for (const k of ABOUT_YOU) if (str(o[k])) out.push({ about: 'you', text: str(o[k]) });
  for (const k of ABOUT_ANSWERS) if (str(o[k])) out.push({ about: 'answers', text: str(o[k]) });
  for (const k of ['custom_instructions', 'customInstructions', 'settings', 'user_system_message', 'personalization']) if (o[k] && typeof o[k] === 'object') instructionFields(o[k], out, depth + 1);
}

/**
 * The notes in an export. `read(name)` gives a file's text; `names` lists the zip; `bio` is what the
 * ChatGPT reader collected from in-chat memory writes. Duplicates (same words) are dropped.
 */
export function exportNotes(source: HistorySource, names: string[], read: (name: string) => string | undefined, bio: string[] = []): { notes: ExportNote[]; clipped: number } {
  const notes: ExportNote[] = [];
  const seen = new Set<string>();
  let clipped = 0;
  const add = (n: ExportNote) => {
    const key = n.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (n.clipped) clipped++;
    notes.push(n);
  };
  const files = names.filter((n) => !/__MACOSX\//.test(n));
  for (const name of files.filter((n) => MEMORY_FILE.test(n))) for (const text of memoryTexts(parse(read(name)))) add({ kind: 'memory', ...clip(text), from: name });
  for (const text of bio) add({ kind: 'memory', ...clip(text), from: 'conversations.json (memory written in a chat)' });
  if (source === 'chatgpt') {
    for (const name of files.filter((n) => USER_FILE.test(n))) {
      const found: { about: 'you' | 'answers'; text: string }[] = [];
      instructionFields(parse(read(name)), found);
      for (const f of found) add({ kind: 'instructions', about: f.about, ...clip(f.text), from: name });
    }
  }
  for (const name of files.filter((n) => PROJECTS_FILE.test(n))) {
    const v = parse(read(name));
    for (const p of Array.isArray(v) ? v : []) {
      const o = obj(p);
      if (!o) continue;
      const pname = str(o.name) || 'a project';
      const rules = str(o.prompt_template) || str(o.instructions);
      if (rules) add({ kind: 'project', ...clip(`Project "${pname}" instructions: ${rules}`), from: `${name} (${pname})` });
      for (const d of Array.isArray(o.docs) ? o.docs : []) {
        const doc = obj(d);
        const text = str(doc?.content);
        if (!text) continue;
        add({ kind: 'project', ...clip(`Project "${pname}", file ${str(doc?.filename) || 'untitled'}: ${text}`), from: `${name} (${pname})` });
      }
    }
  }
  return { notes, clipped };
}
