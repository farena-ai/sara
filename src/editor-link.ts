// EC14 (docs/ops/EC14_DESIGN.md): editors that speak the Agent Client Protocol (Zed, JetBrains).
// `sara acp` runs next to the editor and links a turn to the editor's own files and terminal: in
// such a turn her file and command tools pass her normal approval checks here, then run in the
// editor (the turn sends an `editor_call` event and waits for the editor's answer). The rest of her
// workspace-bound tools aren't offered, because the editor's folder is not her workspace.
import { randomBytes } from 'node:crypto';
import { ToolError } from './tools/types.ts';

/** Tools that run in the editor when a turn is linked to one (`shell` only with a terminal). */
export const EDITOR_TOOLS: ReadonlySet<string> = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'search', 'shell']);
/** Tools that don't touch her workspace and stay available in an editor turn. */
const EDITOR_EXTRA: ReadonlySet<string> = new Set(['web_fetch', 'web_search']);

export interface EditorLink {
  /** The editor's name as it introduced itself ("Zed"), for titles and the model's note. */
  label: string;
  /** The editor offered a terminal: `shell` runs there (else it isn't offered). */
  terminal: boolean;
}

/** A turn's editor link from a request body; undefined when it isn't an object. */
export function cleanEditorLink(v: unknown): EditorLink | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const label = String(o.label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Editor';
  return { label, terminal: o.terminal === true };
}

/** The tools an editor turn offers: the editor's file and command tools, plus the read-only web ones. */
export function editorTools<T extends { spec: { name: string } }>(tools: T[], link: EditorLink): T[] {
  return tools.filter((t) => (EDITOR_TOOLS.has(t.spec.name) && (t.spec.name !== 'shell' || link.terminal)) || EDITOR_EXTRA.has(t.spec.name));
}

/** The model's note for an editor turn (after her own instructions). */
export function editorNote(link: EditorLink): string {
  return `This conversation is linked to the owner's code editor (${link.label}). Your file tools (read_file, write_file, edit_file, list_dir, search) work on the folder open in the editor, with paths relative to it${link.terminal ? ', and shell runs in the editor\'s terminal' : ''}. The owner sees and approves your edits and commands in the editor.`;
}

/** A workspace name for an editor folder: its last part, cleaned ("My App!" → "My-App"). */
export function folderWorkspace(folder: string): string {
  const last = String(folder ?? '').split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
  const slug = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '').slice(0, 64);
  return slug || 'editor';
}

export interface EditorAnswer {
  ok: boolean;
  output: string;
}

const MAX_OUTPUT = 100_000;
/** How long a call waits for the editor (a command may run long in its terminal). */
const WAIT_MS = 10 * 60_000;

/** Calls waiting for the editor. Ids are random (128 bits) and answered by the signed-in owner only. */
export class EditorCalls {
  readonly #open = new Map<string, { conversationId: string; settle: (a: EditorAnswer) => void }>();

  get size(): number {
    return this.#open.size;
  }

  /** A new call; `result` is the editor's output, or rejects (a ToolError) on an error, Stop or no answer. */
  open(conversationId: string, signal: AbortSignal, waitMs = WAIT_MS): { id: string; result: Promise<string> } {
    const id = randomBytes(16).toString('hex');
    const result = new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (a: EditorAnswer) => {
        if (!this.#open.delete(id)) return;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const out = String(a.output ?? '').slice(0, MAX_OUTPUT);
        if (a.ok) resolve(out);
        else reject(new ToolError(out || 'The editor could not do it.'));
      };
      const onAbort = () => done({ ok: false, output: 'Cancelled.' });
      this.#open.set(id, { conversationId, settle: done });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => done({ ok: false, output: "The editor didn't answer in time." }), waitMs);
      timer.unref?.();
    });
    return { id, result };
  }

  /** The editor's answer; false when no such call is waiting. */
  answer(id: string, a: EditorAnswer): boolean {
    const c = this.#open.get(id);
    if (!c) return false;
    c.settle({ ok: a.ok === true, output: typeof a.output === 'string' ? a.output : '' });
    return true;
  }
}

export const editorCalls = new EditorCalls();
