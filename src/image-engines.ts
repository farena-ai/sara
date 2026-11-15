// E7 (B1): the engine her new pictures are made with. Grok Imagine (edits from her look, keeps her
// face) stays the default; OpenAI images, a ComfyUI workflow, or any connected image tool make the
// picture from words (her name, look, clothes and art style), so the face can vary.
// Tool-server engines run through the registered MCP tools with a context that keeps the picture
// they return (the B2 seam: on a Sara without MCP image blocks the picture is missing and she says so).
import { netFetch } from './net-guard.ts';
import { mcpToolName } from './tools/mcp.ts';
import type { Permission, Tool, ToolContext } from './tools/types.ts';
import { ToolError } from './tools/types.ts';

export type PhotoEngine = 'grok' | 'openai' | 'comfyui' | 'tool';
export const PHOTO_ENGINES: readonly PhotoEngine[] = ['grok', 'openai', 'comfyui', 'tool'];
export const OPENAI_IMAGE_MODEL = 'gpt-image-1';

/** A ComfyUI workflow in API format: node id → { class_type, inputs }. */
export type ComfyWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;

export interface ComfyEngine {
  /** The MCP server's name (usually "comfyui"). */
  server: string;
  workflow: ComfyWorkflow;
  /** The node that takes the prompt, and which of its inputs (default "text"). */
  node: string;
  input?: string;
  /** New random seeds each time (every seed / noise_seed input). */
  seed?: boolean;
  /** MNT2: the name of the workflow saved inside ComfyUI this copy came from (none when pasted). */
  saved?: string;
}

export interface ToolEngine {
  /** Full tool name (mcp_<server>_<tool>) and the argument that takes the prompt. */
  name: string;
  arg: string;
}

/** Nodes that can take the prompt: a string input called text/prompt/positive. */
export function promptNodes(wf: ComfyWorkflow): { id: string; input: string; label: string }[] {
  const out: { id: string; input: string; label: string }[] = [];
  for (const [id, n] of Object.entries(wf ?? {})) {
    for (const [k, v] of Object.entries(n?.inputs ?? {})) {
      if (typeof v === 'string' && /^(text|prompt|positive|text_g|text_l|string)$/.test(k)) out.push({ id, input: k, label: `${id} · ${n._meta?.title ?? n.class_type ?? 'node'} · ${k}` });
    }
  }
  return out;
}

/** Checks a pasted workflow (API format, at most 300 nodes, 200 kB). */
export function cleanWorkflow(v: unknown): ComfyWorkflow {
  const wf = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new ToolError('Paste the workflow in API format (ComfyUI: Workflow → Export (API)).');
  if ('nodes' in (wf as object) && 'links' in (wf as object)) throw new ToolError('This is the normal workflow file; export it with Workflow → Export (API) instead.');
  const entries = Object.entries(wf as Record<string, unknown>);
  if (!entries.length || entries.length > 300 || JSON.stringify(wf).length > 200_000) throw new ToolError('The workflow is empty or too big (300 nodes, 200 kB at most).');
  for (const [, n] of entries) if (!n || typeof n !== 'object' || typeof (n as { class_type?: unknown }).class_type !== 'string') throw new ToolError('Every node needs a class_type: export it with Workflow → Export (API).');
  return wf as ComfyWorkflow;
}

/** The workflow with the prompt in the chosen node (and new seeds when asked). */
export function fillWorkflow(e: ComfyEngine, prompt: string, random: () => number = Math.random): ComfyWorkflow {
  const wf = structuredClone(e.workflow);
  const node = wf[e.node];
  const input = e.input || 'text';
  if (!node?.inputs || typeof node.inputs[input] !== 'string') throw new ToolError(`The workflow has no text input "${input}" on node ${e.node}; pick the node that takes the prompt again in Settings → Pictures from her.`);
  node.inputs[input] = prompt;
  if (e.seed) for (const n of Object.values(wf)) for (const k of ['seed', 'noise_seed']) if (typeof n.inputs?.[k] === 'number') n.inputs[k] = Math.floor(random() * 2 ** 48);
  return wf;
}

export interface EngineDeps {
  tools?: { get(name: string): Tool | undefined; permission(name: string): Permission };
  openaiKey?: () => string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RunOpts {
  signal?: AbortSignal;
  conversationId?: string;
  /** On her own (nobody sees a card): every tool used must be Always allowed. */
  unattended?: boolean;
}

/** Runs one registered (MCP) tool and keeps any picture it returns. */
async function runTool(d: EngineDeps, name: string, args: Record<string, unknown>, o: RunOpts): Promise<{ text: string; images: Buffer[] }> {
  const tool = d.tools?.get(name);
  if (!tool || (tool.isAvailable && !tool.isAvailable())) throw new ToolError(`The picture tool ${name} isn't connected right now.`);
  const perm = d.tools!.permission(name);
  if (perm === 'never') throw new ToolError(`${name} is set to Off in Settings → Skills & tools → Tools and approvals.`);
  if (o.unattended && perm !== 'auto') throw new ToolError(`For pictures on her own, ${name} must be Always allowed (Settings → Skills & tools → Tools and approvals).`);
  const images: Buffer[] = [];
  const ctx = {
    workspaceDir: '',
    signal: o.signal ?? new AbortController().signal,
    sandbox: { mode: 'none', network: true, detail: '' },
    conversationId: o.conversationId,
    attachImage: () => {},
    // B2 seam: MCP image blocks are handed to saveImage, then attachImage(id).
    saveImage: (bytes: Buffer) => {
      images.push(bytes);
      return `engine-${images.length}`;
    },
  } as unknown as ToolContext;
  const text = await tool.run(args, ctx);
  return { text, images };
}

/** MNT2: library names as get_workflow lists them ("1. SDXL/her day.json"); no "..", no absolute paths. */
const SAVED_NAME = /^(?!.*(?:^|\/)\.\.(?:\/|$))(?![\\/])(?![a-z]:)[^\n\r\u0000]{1,200}\.json$/i;

/** MNT2 (E7 follow-up): the workflows saved inside ComfyUI, through its tool server's get_workflow. */
export async function listComfyWorkflows(d: EngineDeps, server: string, o: RunOpts = {}): Promise<string[]> {
  const got = await runTool(d, mcpToolName(server, 'get_workflow'), { action: 'list' }, o);
  const names = [...got.text.matchAll(/^\s*\d+\.\s+(.+?)\s*$/gm)].map((m) => m[1]).filter((n) => SAVED_NAME.test(n));
  return [...new Set(names)].slice(0, 500);
}

/** The first JSON object in a tool's text (get_workflow may add conversion warnings after it). */
function firstObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** One saved workflow in API format (ComfyUI converts it), checked like a pasted one. */
export async function loadComfyWorkflow(d: EngineDeps, server: string, name: string, o: RunOpts = {}): Promise<ComfyWorkflow> {
  if (!SAVED_NAME.test(name)) throw new ToolError('Pick a workflow by its name from the list.');
  const got = await runTool(d, mcpToolName(server, 'get_workflow'), { action: 'get', filename: name, format: 'api' }, o);
  const wf = firstObject(got.text);
  if (!wf) throw new ToolError(`ComfyUI couldn't read that workflow: ${got.text.slice(0, 200)}`);
  return cleanWorkflow(wf);
}

const NO_PICTURE = "The picture was made, but this Sara can't receive pictures from tool servers yet, so nothing was sent.";

export type ComfyRun = { state: 'pending' } | { state: 'done'; file: string; type?: string } | { state: 'error'; reason: string };

const IMAGE_FILE = /\.(?:png|jpe?g|webp)$/i;
const EMPTY_RUN = 'ComfyUI finished but the workflow saved no picture: check it ends in Save Image.';

/**
 * Reads one get_history answer: the JSON of older tool servers, or the markdown of comfyui-mcp
 * (`**Status**: success | Completed: true`, `- Node 10: images → **sub/x.png (type=output)**`).
 */
export function readComfyHistory(text: string): ComfyRun {
  const t = String(text ?? '');
  // Markdown (comfyui-mcp 0.5x).
  const status = /\*\*Status\*\*:\s*([\w-]+)\s*\|\s*Completed:\s*(\w+)/i.exec(t);
  if (status || /^##\s+Execution:/m.test(t)) {
    if (/\*\*Execution was interrupted\/cancelled\*\*/i.test(t)) return { state: 'error', reason: 'it was stopped in ComfyUI.' };
    const exc = /\*\*Exception\*\*:\s*(.+)/.exec(t)?.[1]?.trim();
    const node = /\*\*Failed node\*\*:\s*(.+)/.exec(t)?.[1]?.trim();
    if (status?.[1].toLowerCase() === 'error' || exc) return { state: 'error', reason: [exc || 'the workflow failed', node ? `(node ${node})` : ''].filter(Boolean).join(' ').slice(0, 300) };
    for (const m of t.matchAll(/^\s*-\s*Node\s+[^:]+:\s*(?:images|videos|video|gifs)\s*→\s*\*\*(.+?)\*\*\s*$/gim)) {
      for (const part of m[1].split(/,\s+/)) {
        const f = /^(.+?)(?:\s+\(type=(output|temp|input)\))?$/.exec(part.trim());
        if (f && IMAGE_FILE.test(f[1])) return { state: 'done', file: f[1], ...(f[2] ? { type: f[2] } : {}) };
      }
    }
    if (status && (status[1].toLowerCase() === 'success' || status[2].toLowerCase() === 'true')) return { state: 'error', reason: EMPTY_RUN };
    return { state: 'pending' };
  }
  // JSON (older servers, raw ComfyUI history).
  if (/"status_str"\s*:\s*"error"|execution_error/i.test(t)) {
    const msg = /"exception_message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t)?.[1];
    return { state: 'error', reason: (msg ?? t).slice(0, 300) };
  }
  if (/execution_interrupted/i.test(t)) return { state: 'error', reason: 'it was stopped in ComfyUI.' };
  const m = /"filename"\s*:\s*"([^"]+\.(?:png|jpe?g|webp))"(?:[^}]*?"subfolder"\s*:\s*"([^"]*)")?(?:[^}]*?"type"\s*:\s*"(output|temp|input)")?/i.exec(t);
  if (m) return { state: 'done', file: m[2] ? `${m[2]}/${m[1]}` : m[1], ...(m[3] ? { type: m[3] } : {}) };
  if (/"status_str"\s*:\s*"success"|"completed"\s*:\s*true/i.test(t)) return { state: 'error', reason: EMPTY_RUN };
  return { state: 'pending' };
}

/** The readable part of a tool server's error (its JSON "message"), at most 300 characters. */
export function comfyReason(text: string): string {
  const t = String(text ?? '').trim();
  const j = firstObject(t) as { message?: unknown; error?: unknown } | undefined;
  const msg = typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : t;
  return msg.replace(/\s*\n\s*-?\s*/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function comfyPhoto(d: EngineDeps, e: ComfyEngine, prompt: string, o: RunOpts): Promise<Buffer> {
  const name = (tool: string) => mcpToolName(e.server, tool);
  const wf = fillWorkflow(e, prompt, d.random);
  let queued: { text: string };
  try {
    queued = await runTool(d, name('enqueue_workflow'), { action: 'enqueue', workflow: wf }, o);
  } catch (err) {
    // comfyui-mcp answers a refused workflow (a missing model, no output node) with a JSON error.
    throw new ToolError(`ComfyUI didn't take the workflow: ${comfyReason((err as Error).message)}`);
  }
  const id = /prompt_id["']?\s*[:=]\s*["']?([\w-]{6,})/i.exec(queued.text)?.[1];
  if (!id) throw new ToolError(`ComfyUI didn't take the workflow: ${comfyReason(queued.text)}`);
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 100; i++) {
    if (o.signal?.aborted) throw new ToolError('Stopped.');
    const h = await runTool(d, name('get_history'), { action: 'list', prompt_id: id }, o);
    const run = readComfyHistory(h.text);
    if (run.state === 'error') throw new ToolError(run.reason === EMPTY_RUN ? EMPTY_RUN : `ComfyUI couldn't finish the picture: ${run.reason}`);
    if (run.state === 'done') {
      const got = await runTool(d, name('get_image'), { action: 'get', filename: run.file, ...(run.type ? { type: run.type } : {}) }, o);
      if (!got.images.length) throw new ToolError(NO_PICTURE);
      return got.images[0];
    }
    await sleep(3000);
  }
  throw new ToolError('ComfyUI took longer than 5 minutes; nothing was sent.');
}

export async function toolPhoto(d: EngineDeps, e: ToolEngine, prompt: string, o: RunOpts): Promise<Buffer> {
  const got = await runTool(d, e.name, { [e.arg || 'prompt']: prompt }, o);
  if (!got.images.length) throw new ToolError(NO_PICTURE);
  return got.images[0];
}

export async function openaiPhoto(d: EngineDeps, prompt: string, model: string | undefined, o: RunOpts): Promise<Buffer> {
  const key = d.openaiKey?.();
  if (!key) throw new ToolError('No OpenAI key: add OpenAI in Settings → Models to make pictures with it.');
  const res = await (d.fetch ?? netFetch)('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || OPENAI_IMAGE_MODEL, prompt: prompt.slice(0, 1200), size: '1024x1024', quality: 'medium', n: 1 }),
    signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(o.signal ? [o.signal] : [])]),
  });
  const text = await res.text();
  if (!res.ok) throw new ToolError(`OpenAI said ${res.status}: ${text.slice(0, 200)}`);
  const b64 = (JSON.parse(text) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  if (!b64) throw new ToolError('OpenAI returned no image.');
  return Buffer.from(b64, 'base64');
}
