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
  if (perm === 'never') throw new ToolError(`${name} is set to Off in Settings → Coding → Tools and approvals.`);
  if (o.unattended && perm !== 'auto') throw new ToolError(`For pictures on her own, ${name} must be Always allowed (Settings → Coding → Tools and approvals).`);
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

const NO_PICTURE = "The picture was made, but this Sara can't receive pictures from tool servers yet, so nothing was sent.";

export async function comfyPhoto(d: EngineDeps, e: ComfyEngine, prompt: string, o: RunOpts): Promise<Buffer> {
  const name = (tool: string) => mcpToolName(e.server, tool);
  const wf = fillWorkflow(e, prompt, d.random);
  const queued = await runTool(d, name('enqueue_workflow'), { action: 'enqueue', workflow: wf }, o);
  const id = /prompt_id["']?\s*[:=]\s*["']?([\w-]{6,})/i.exec(queued.text)?.[1];
  if (!id) throw new ToolError(`ComfyUI didn't take the workflow: ${queued.text.slice(0, 200)}`);
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 100; i++) {
    if (o.signal?.aborted) throw new ToolError('Stopped.');
    const h = await runTool(d, name('get_history'), { action: 'list', prompt_id: id }, o);
    if (/"status_str"\s*:\s*"error"|execution_error/i.test(h.text)) throw new ToolError(`ComfyUI couldn't finish the picture: ${h.text.slice(0, 200)}`);
    const m = /"filename"\s*:\s*"([^"]+\.(?:png|jpe?g|webp))"(?:[^}]*?"subfolder"\s*:\s*"([^"]*)")?/i.exec(h.text);
    if (m) {
      const got = await runTool(d, name('get_image'), { action: 'get', filename: m[2] ? `${m[2]}/${m[1]}` : m[1] }, o);
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
