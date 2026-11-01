// Phase 114 (F4): one way to count a model list, shared by the first-run guide, Models → Default
// model and Models → On this computer. Ollama Cloud tags ("glm-5.2:cloud", "gpt-oss:120b-cloud")
// run on Ollama's servers, so they are counted apart from the models on this computer; embedding
// models can't chat and are not counted. The same rules as src/model-names.ts (countModels), which
// test/phase114a.test.ts keeps in step.
export const CLOUD_TAG = /(:|-)cloud$/i;
export const EMBED_TAG = /embed|minilm|bge-|e5-/i;

/** { here, cloud } for a list of model ids. */
export function modelCounts(ids) {
  const chat = (ids ?? []).filter((m) => !EMBED_TAG.test(String(m)));
  const cloud = chat.filter((m) => CLOUD_TAG.test(String(m).trim())).length;
  return { here: chat.length - cloud, cloud };
}

/** The ids split for a grouped picker: on this computer first, then Ollama Cloud. */
export function modelGroups(ids) {
  const chat = (ids ?? []).filter((m) => !EMBED_TAG.test(String(m)));
  return { here: chat.filter((m) => !CLOUD_TAG.test(String(m).trim())), cloud: chat.filter((m) => CLOUD_TAG.test(String(m).trim())) };
}

/**
 * The count in words. `local` = the provider runs on this computer or home network (Ollama), so
 * its own models are "on this computer"; a cloud API's are just "models".
 */
export function countWords({ here, cloud }, local, t) {
  if (!local) {
    const n = here + cloud;
    return n === 1 ? t('1 model') : t('{n} models', { n });
  }
  const mine = here === 1 ? t('1 on this computer') : t('{n} on this computer', { n: here });
  return cloud ? `${mine} · ${t('{n} on Ollama Cloud', { n: cloud })}` : mine;
}
