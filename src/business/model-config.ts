import { withKeyRotation } from '../key-rotation.ts';
import { withBusinessWriter, type BusinessWriter } from './lifecycle.ts';
import { DatabaseSync } from 'node:sqlite';
import { initializeAudit, appendAudit } from './audit.ts';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../vault.ts';
import { writeFileAtomic } from '../fs-util.ts';
import { createProvider } from '../providers/registry.ts';
import type { Provider } from '../providers/types.ts';
import { CLOUD_MODEL, isLoopbackHost, privateLocalOn } from '../net-guard.ts';
import { envMode } from '../private-local.ts';
import type { BusinessProfile } from './profile.ts';
import { BusinessAccessError, exactFields, validId } from './policy.ts';
import { BusinessAdmissionError } from './budget.ts';
import { validateBusinessModelPolicy as validate, type BusinessModel } from './model-policy.ts';
export type { BusinessModel } from './model-policy.ts';

export interface BusinessModelPlan {
  readonly policyHash: string; readonly model: Readonly<BusinessModel>; readonly privateLocal: boolean;
  readonly instanceAllowanceNanoUsd: number; readonly workspaceAllowanceNanoUsd: number; readonly maxConcurrent: number;
}
function safeFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new BusinessAdmissionError('Business model configuration is unavailable.');
}
/** Read-only generation validation. Never constructs Vault, generates a key or repairs a file. */
export function validateBusinessOperatorSnapshot(businessDir: string): void {
  const keyPath = join(businessDir, 'operator', 'master.key');
  const vaultPath = join(businessDir, 'operator', 'secrets.enc');
  let key: Buffer | undefined;
  let secrets: Record<string, unknown> = {};
  if (existsSync(keyPath)) {
    safeFile(keyPath);
    const encoded = readFileSync(keyPath, 'utf8').trim();
    key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Invalid operator key.');
  }
  if (existsSync(vaultPath)) {
    safeFile(vaultPath); const bytes = readFileSync(vaultPath);
    if (!key || bytes.length < 28) throw new Error('Invalid operator Vault.');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const decoded: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.getPrototypeOf(decoded) !== Object.prototype) throw new Error('Invalid operator Vault record.');
    secrets = decoded as Record<string, unknown>;
    if (Object.keys(secrets).length > 1000 || Object.entries(secrets).some(([name, value]) => !(name.startsWith('business-provider:') || name === 'business-oidc:client-secret') || name.length > 256 || typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\u0000]/.test(value))) throw new Error('Invalid operator Vault record.');
  }
  const policyPath = join(businessDir, 'model-policy.json');
  if (!existsSync(policyPath)) return;
  safeFile(policyPath);
  const stored: unknown = JSON.parse(readFileSync(policyPath, 'utf8'));
  exactFields(stored, ['revision', 'policy']); validId(stored.revision);
  const policy = validate(stored.policy);
  for (const model of policy.models) if (model.provider.needsKey && !Object.hasOwn(secrets, `business-provider:${model.provider.id}`)) throw new Error('Missing configured business credential.');
}
export function operatorVault(profile: BusinessProfile): Vault {
  const dir = join(profile.businessDir, 'operator');
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new BusinessAccessError(400);
  for (const name of ['master.key', 'secrets.enc']) if (existsSync(join(dir, name))) safeFile(join(dir, name));
  return new Vault(dir);
}
/** EC10: reads the operator vault's references to external sources before the business server answers. */
export async function primeOperatorSecrets(profile: BusinessProfile): Promise<void> {
  if (existsSync(join(profile.businessDir, 'operator', 'secrets.enc'))) await operatorVault(profile).ready();
}
/** Local operator entry only. Organization and workspace HTTP roles never receive this capability. */
export function configureBusinessModels(profile: BusinessProfile, input: unknown, keys: Record<string, string> = {}, writer?: BusinessWriter): void {
  return withBusinessWriter(profile, () => configure(profile, input, keys), writer);
}
/** Shared by the packaged CLI and optional source-checkout convenience script. */
export function configureBusinessModelsFile(profile: BusinessProfile, file: string): void {
  safeFile(file);
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  exactFields(input, ['policy', 'keys']);
  configureBusinessModels(profile, input.policy, input.keys as Record<string, string> | undefined);
}
function configure(profile: BusinessProfile, input: unknown, keys: Record<string, string>): void {
  const policy = validate(input);
  exactFields(keys, policy.models.map(model => model.provider.id));
  for (const key of Object.values(keys)) if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n\u0000]/.test(key)) throw new BusinessAccessError(400);
  const db = new DatabaseSync(join(profile.businessDir, 'business.db'));
  try { initializeAudit(db); appendAudit(db, { action: 'operator.configure.attempt' }); } finally { db.close(); }
  const vault = operatorVault(profile);
  for (const model of policy.models) {
    const id = model.provider.id;
    if (keys[id]) vault.set(`business-provider:${id}`, keys[id]);
    if (model.provider.needsKey && !vault.has(`business-provider:${id}`)) throw new BusinessAdmissionError('A business provider key is required.');
  }
  const path = join(profile.businessDir, 'model-policy.json'); if (existsSync(path)) safeFile(path);
  writeFileAtomic(path, JSON.stringify({ revision: randomUUID(), policy }) + '\n', 0o600);
}

export class BusinessModels {
  readonly #profile: BusinessProfile;
  readonly #environmentPrivate: boolean;
  readonly #admission: () => void;
  constructor(profile: BusinessProfile, environmentPrivate = envMode(process.env.SARA_PRIVATE_LOCAL) !== undefined, admission: () => void = () => {}) { this.#admission = admission; this.#profile = profile; this.#environmentPrivate = environmentPrivate || envMode(process.env.SARA_PRIVATE_LOCAL) !== undefined; }
  plan(workspaceId: string): BusinessModelPlan {
    this.#admission();
    try {
      const path = join(this.#profile.businessDir, 'model-policy.json'); safeFile(path);
      const raw = readFileSync(path, 'utf8'); const stored = JSON.parse(raw) as { policy: unknown; revision: unknown };
      exactFields(stored, ['revision', 'policy']); validId(stored.revision);
      const policy = validate(stored.policy); const workspace = policy.workspaces[workspaceId];
      if (!workspace) throw new Error('Unconfigured');
      const model = policy.models.find(item => item.id === workspace.modelId)!;
      const privateLocal = policy.privateLocal || this.#environmentPrivate || privateLocalOn();
      if (privateLocal && (model.cloud || !model.provider.local || !isLoopbackHost(new URL(model.provider.baseUrl).hostname) || CLOUD_MODEL.test(model.model))) throw new Error('Private local');
      return Object.freeze({ policyHash: createHash('sha256').update(raw).digest('hex'), model, privateLocal,
        instanceAllowanceNanoUsd: policy.instanceAllowanceNanoUsd, workspaceAllowanceNanoUsd: workspace.allowanceNanoUsd, maxConcurrent: policy.maxConcurrent });
    } catch { throw new BusinessAdmissionError('Business model configuration is unavailable or disallowed.'); }
  }
  revalidate(workspaceId: string, plan: BusinessModelPlan): void {
    if (this.plan(workspaceId).policyHash !== plan.policyHash) throw new BusinessAdmissionError('Business model policy changed.');
  }
  provider(workspaceId: string, plan: BusinessModelPlan): Provider {
    this.revalidate(workspaceId, plan);
    const vault = operatorVault(this.#profile);
    const name = `business-provider:${plan.model.provider.id}`;
    if (plan.model.provider.needsKey && !vault.get(name)) throw new BusinessAdmissionError('Business model configuration is unavailable.');
    // EC10: several keys in the operator vault entry rotate when the provider refuses one.
    return withKeyRotation(vault, name, (key) => createProvider(plan.model.provider, key));
  }
  protectOutput(text: string): void {
    this.#admission();
    if (operatorVault(this.#profile).values().some(secret => secret && text.includes(secret))) throw new BusinessAdmissionError('Protected configuration appeared in model output.');
  }
  describe(workspaceId: string): object {
    try {
      const plan = this.plan(workspaceId);
      return { configured: true, policyHash: plan.policyHash, provider: plan.model.provider.label, model: plan.model.model,
        destination: new URL(plan.model.provider.baseUrl).host, egress: plan.model.cloud ? 'cloud' : 'local', privateLocal: plan.privateLocal,
        allowanceUnits: 'nano-US dollars; lifetime', tools: false, adultMode: false };
    } catch { return { configured: false, tools: false, adultMode: false }; }
  }
}
