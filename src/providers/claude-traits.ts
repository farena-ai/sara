// Z5: what each Claude model accepts on the Messages API. The API changed under the adapter: the
// newer models refuse `temperature` (a 400), think before answering unless told otherwise (and that
// thinking counts against max_tokens, so a judge asking for 8 tokens got nothing back), and take an
// `effort` level instead of a thinking budget. This file is the one place that knows which model is
// which; src/providers/anthropic.ts builds the request from it.
//
// A name this file does not recognise as a Claude model (another service behind an Anthropic-style
// address) gets the request as it always was.
import type { ChatRequest } from './types.ts';

export interface ClaudeTraits {
  /** A Claude model this file recognises. */
  claude: boolean;
  /** `temperature` (and top_p / top_k) are refused. */
  noSampling: boolean;
  /** Takes `output_config.effort`. */
  effort: boolean;
  /** Takes `thinking: { type: 'adaptive' }`. */
  adaptive: boolean;
  /** Thinks when the request says nothing about thinking. */
  thinksByDefault: boolean;
  /** Takes `output_config.format` (an answer that must fit a JSON schema). */
  jsonSchema: boolean;
}

const NONE: ClaudeTraits = { claude: false, noSampling: false, effort: false, adaptive: false, thinksByDefault: false, jsonSchema: false };
const NEWEST: ClaudeTraits = { claude: true, noSampling: true, effort: true, adaptive: true, thinksByDefault: true, jsonSchema: true };

/** claude-opus-4-7, claude-sonnet-5, claude-haiku-4-5-20251001, claude-3-5-sonnet-20241022, us.anthropic.claude-opus-4-6-v1 … */
export function claudeModel(model: string): { family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos'; version: number } | undefined {
  const m = model.toLowerCase();
  // Current naming: family first, then the version (one or two parts; a longer number is a date).
  const now = /claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?)?/.exec(m);
  if (now) return { family: now[1] as 'opus', version: now[2] ? Number(now[2]) + (now[3] ? Number(now[3]) / 10 : 0) : 0 };
  // Old naming: claude-3-5-sonnet, claude-3-opus.
  const old = /claude-(\d)(?:[-.](\d)(?!\d))?-(opus|sonnet|haiku)/.exec(m);
  if (old) return { family: old[3] as 'opus', version: Number(old[1]) + (old[2] ? Number(old[2]) / 10 : 0) };
  return undefined;
}

export function claudeTraits(model: string): ClaudeTraits {
  const c = claudeModel(model);
  if (!c) return NONE;
  // Fable and Mythos are all of the newest kind (a name with no number, like the preview, too).
  if (c.family === 'fable' || c.family === 'mythos') return NEWEST;
  const v = c.version;
  if (!v) return { ...NONE, claude: true };
  if (c.family === 'opus') return { claude: true, noSampling: v >= 4.7, effort: v >= 4.6, adaptive: v >= 4.6, thinksByDefault: v >= 5, jsonSchema: v >= 4.5 };
  if (c.family === 'sonnet') return { claude: true, noSampling: v >= 5, effort: v >= 4.6, adaptive: v >= 4.6, thinksByDefault: v >= 5, jsonSchema: v >= 4.5 };
  return { claude: true, noSampling: v >= 5.5, effort: v >= 5.5, adaptive: v >= 5.5, thinksByDefault: v >= 5.5, jsonSchema: v >= 4.5 };
}

/**
 * Room for thinking on top of a small reply limit. Thinking counts against max_tokens on the models
 * that think by default, and it cannot be switched off on all of them, so a limit sized for the
 * answer alone ("8 tokens: yes or no") is used up before the answer starts.
 */
export const THINK_ROOM = 4096;
/** Reply limits at or above this already leave room. */
const ROOMY = 16_000;

export interface ClaudeExtras {
  max_tokens: number;
  temperature?: number;
  thinking?: { type: 'adaptive' };
  output_config?: { effort?: 'low' | 'medium' | 'high'; format?: { type: 'json_schema'; schema: Record<string, unknown> } };
}

/**
 * The parts of a request that depend on the model.
 * - `reasoning: 'none'` (background chores, a talk turn) is the lowest effort, never "disabled":
 *   the newest models refuse "disabled", each in its own way, and low effort is accepted by all.
 * - `reasoning: 'low' | 'medium' | 'high'` is that effort; models that do not think on their own
 *   (Opus and Sonnet 4.6 to 4.8) are also told they may.
 * - Nothing said: the model's own default.
 */
export function claudeExtras(req: Pick<ChatRequest, 'model' | 'maxTokens' | 'temperature' | 'reasoning' | 'json'>, defaultMax: number): ClaudeExtras {
  const t = claudeTraits(req.model);
  const asked = req.maxTokens ?? defaultMax;
  const out: ClaudeExtras = { max_tokens: t.thinksByDefault && asked < ROOMY ? asked + THINK_ROOM : asked };
  if (req.temperature !== undefined && !t.noSampling) out.temperature = req.temperature;
  const effort = req.reasoning === undefined ? undefined : req.reasoning === 'none' ? 'low' : req.reasoning;
  if (effort && t.effort) out.output_config = { effort };
  if (effort && req.reasoning !== 'none' && t.adaptive && !t.thinksByDefault) out.thinking = { type: 'adaptive' };
  if (req.json && t.jsonSchema) out.output_config = { ...out.output_config, format: { type: 'json_schema', schema: req.json.schema } };
  return out;
}
