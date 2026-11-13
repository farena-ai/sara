// A sensible first model for a beginner, shared by the first-run guide (web) and the server (a
// provider that becomes the default without a model gets this one, so it is never left empty).

/**
 * A sensible first model for a beginner from a provider's list: a well-known general model of a
 * medium size, not an embedding, vision-only, uncensored or test build. (They can pick any.)
 * E7: `noGpu` (a computer without a graphics card): an Ollama Cloud model first, else the smallest
 * usable local model (up to 3B), since a bigger one on the processor answers in minutes.
 * @param {string[]} models
 * @param {{ noGpu?: boolean }} [opts]
 * @returns {string | undefined}
 */
export function suggestModel(models, opts = {}) {
  const bad = /embed|bge|nomic|minilm|rerank|whisper|tts|vision-only|uncensor|abliterat|^hf\.co\/|nvfp4|test|preview|-base\b|guard/i;
  const order = [/^gpt-5(\.\d)?$/, /^gpt-5[\w.-]*mini/, /claude-.*sonnet|^sonnet$/, /^grok-4[\w.]*$/, /gemma\d*:(12|27|31)b|gemma\d*:\d+b-cloud/, /gpt-oss/, /qwen\d[\w.]*:(14|30|32)b/, /llama\d[\w.]*:(8|70)b/, /mistral/, /gemma|qwen|llama|glm|deepseek|kimi/];
  const ok = models.filter((m) => !bad.test(m));
  if (opts.noGpu) {
    const cloud = ok.filter((m) => /(:|-)cloud$/i.test(m));
    if (cloud.length) return suggestModel(cloud);
    const size = (m) => Number(/[:-](\d+(?:\.\d+)?)b(?![a-z])/i.exec(m)?.[1] ?? NaN);
    const small = ok.filter((m) => size(m) <= 3).sort((a, b) => size(b) - size(a));
    if (small.length) return small[0];
  }
  for (const re of order) {
    const hit = ok.find((m) => re.test(m));
    if (hit) return hit;
  }
  return ok[0] ?? models[0];
}
