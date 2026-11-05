// Shared configuration-shape validation only: no stores, credentials, keys or inference are opened.
import type { ProviderConfig } from '../providers/types.ts';
import { validateProviderConfig } from '../providers/registry.ts';
import { CLOUD_MODEL, isLoopbackHost } from '../net-guard.ts';
import { BusinessAccessError, exactFields, validId } from './policy.ts';
import { boundedInteger } from './budget.ts';

export interface BusinessModel {
  id: string; provider: Readonly<ProviderConfig>; model: string; cloud: boolean;
  inputNanoUsdPerToken: number; outputNanoUsdPerToken: number; maxInputTokens: number; maxOutputTokens: number;
  maxOutputBytes: number; deadlineMs: number; tone: 'professional' | 'concise' | 'friendly';
}
export interface BusinessModelPolicy {
  version: 1; privateLocal: boolean; allowCloud: boolean; instanceAllowanceNanoUsd: number; maxConcurrent: number;
  models: BusinessModel[]; workspaces: Record<string, { modelId: string; allowanceNanoUsd: number }>;
}
export function validateBusinessModelPolicy(input: unknown): BusinessModelPolicy {
  exactFields(input, ['version', 'privateLocal', 'allowCloud', 'instanceAllowanceNanoUsd', 'maxConcurrent', 'models', 'workspaces']);
  if (input.version !== 1 || typeof input.privateLocal !== 'boolean' || typeof input.allowCloud !== 'boolean' || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 16) throw new BusinessAccessError(400);
  const models = input.models.map((value: unknown): BusinessModel => {
    exactFields(value, ['id', 'provider', 'model', 'cloud', 'inputNanoUsdPerToken', 'outputNanoUsdPerToken', 'maxInputTokens', 'maxOutputTokens', 'maxOutputBytes', 'deadlineMs', 'tone']);
    exactFields(value.provider, ['id', 'kind', 'label', 'baseUrl', 'local', 'needsKey']);
    const provider = validateProviderConfig(value.provider);
    const url = new URL(provider.baseUrl);
    if (!['openai-compatible', 'anthropic'].includes(provider.kind) || url.username || url.password || url.search || url.hash || provider.baseUrl.length > 512 || (url.protocol === 'http:' && !isLoopbackHost(url.hostname))) throw new BusinessAccessError(400);
    if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(value.id) || typeof value.model !== 'string' || !/^[\w.\-/:]{1,150}$/.test(value.model) || typeof value.cloud !== 'boolean' || typeof value.provider.local !== 'boolean' || typeof value.provider.needsKey !== 'boolean') throw new BusinessAccessError(400);
    // A relay on loopback is still cloud when its named model runs remotely.
    const remote = !provider.local || CLOUD_MODEL.test(value.model);
    if (remote && !value.cloud || value.cloud && !input.allowCloud) throw new BusinessAccessError(400);
    if (!['professional', 'concise', 'friendly'].includes(String(value.tone))) throw new BusinessAccessError(400);
    return Object.freeze({ id: value.id, provider: Object.freeze(provider), model: value.model, cloud: value.cloud,
      inputNanoUsdPerToken: boundedInteger(value.inputNanoUsdPerToken), outputNanoUsdPerToken: boundedInteger(value.outputNanoUsdPerToken),
      maxInputTokens: boundedInteger(value.maxInputTokens, 131072, 1024), maxOutputTokens: boundedInteger(value.maxOutputTokens, 32768, 1),
      maxOutputBytes: boundedInteger(value.maxOutputBytes, 131072, 64), deadlineMs: boundedInteger(value.deadlineMs, 120000, 100), tone: value.tone as BusinessModel['tone'] });
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new BusinessAccessError(400);
  if (!input.workspaces || typeof input.workspaces !== 'object' || Array.isArray(input.workspaces) || Object.getPrototypeOf(input.workspaces) !== Object.prototype || Object.keys(input.workspaces).length > 1000) throw new BusinessAccessError(400);
  const workspaces: BusinessModelPolicy['workspaces'] = {};
  for (const [id, value] of Object.entries(input.workspaces)) {
    validId(id); exactFields(value, ['modelId', 'allowanceNanoUsd']);
    if (typeof value.modelId !== 'string' || !models.some(model => model.id === value.modelId)) throw new BusinessAccessError(400);
    workspaces[id] = Object.freeze({ modelId: value.modelId, allowanceNanoUsd: boundedInteger(value.allowanceNanoUsd) });
  }
  return { version: 1, privateLocal: input.privateLocal, allowCloud: input.allowCloud,
    instanceAllowanceNanoUsd: boundedInteger(input.instanceAllowanceNanoUsd), maxConcurrent: boundedInteger(input.maxConcurrent, 16, 1), models, workspaces };
}
