// Model names with a meaning of their own.

/**
 * Ollama Cloud models run on Ollama's servers, even when asked through a local Ollama daemon. A
 * daemon names them with a `:cloud` tag or a `-cloud` suffix on the tag ("glm-5.2:cloud",
 * "gpt-oss:120b-cloud"); a local model that merely contains "cloud" ("cloudy:7b",
 * "my-cloud-distill:8b") is not one. net-guard.ts keeps its own copy of this rule (the egress gate
 * imports nothing); test/model-names.test.ts pins both to the same answers.
 */
export const CLOUD_MODEL_NAME = /(:|-)cloud$/i;

/** Is this an Ollama Cloud model name? */
export const isCloudModelName = (model: string): boolean => CLOUD_MODEL_NAME.test(String(model ?? '').trim());

/** Embedding-only models (they can't chat): left out of model counts and the local chat list. */
export const EMBED_MODEL_NAME = /embed|minilm|bge-|e5-/i;

/**
 * Phase 114 (F4): one counting rule for a model list: Ollama Cloud tags apart from the models on
 * this computer, embedding models not counted. web/model-count.js keeps the same rules (tested).
 */
export function countModels(names: string[]): { here: number; cloud: number } {
  const chat = names.filter((m) => !EMBED_MODEL_NAME.test(String(m)));
  const cloud = chat.filter((m) => isCloudModelName(m)).length;
  return { here: chat.length - cloud, cloud };
}
