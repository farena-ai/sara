// Discovery is an inert public read model. Installation and connection authority
// remain with the existing plugin manager and verified Store client.
import { discoveryData } from './discovery-data.ts';

export const NATIVE_CANDIDATE_IDS = Object.freeze(['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard',
  // A2: developer add-ons from the add-ons session, through the same local-candidate path.
  'secret-scanner', 'license-auditor', 'sbom-builder', 'artifact-provenance-verifier', 'coverage-explorer', 'log-explorer', 'incident-workbench', 'environment-config-doctor', 'database-fixture-studio', 'data-contract-validator', 'change-impact-analyzer', 'architecture-guard', 'sql-migration-reviewer', 'visual-regression', 'localization-qa', 'accessibility-auditor', 'build-cache-inspector', 'api-contract-guard', 'http-webhook-workbench',
  // Lab add-ons (N09, N25, N28): staged-snapshot execution, same local-candidate path.
  'performance-regression-lab', 'code-migration-studio', 'build-reproducibility-inspector',
  // H_EXEC add-ons (N03, N04): an owner-approved job in a disposable copy, same local-candidate path.
  'test-doctor', 'flaky-test-lab'] as const);
export type CandidateId = typeof NATIVE_CANDIDATE_IDS[number];
export type CostTier = 'local-only' | 'mixed' | 'provider' | 'unconfirmed';
export type QualificationState = 'in-testing' | 'tested' | 'needs-account' | 'blocked';
export interface DiscoveryText {
  readonly name: string; readonly summary: string; readonly description: string;
  readonly prerequisites: readonly string[]; readonly permissions: readonly string[];
  readonly limitations: readonly string[]; readonly qualification: string;
  readonly cost: string; readonly privacy: string;
}
export interface DiscoveryItem extends DiscoveryText {
  readonly id: string; readonly kind: 'plugin' | 'mcp'; readonly status: QualificationState;
  readonly costTier: CostTier; readonly source: string; readonly documentation: string;
}
export interface NativeCandidate extends DiscoveryItem {
  readonly kind: 'plugin'; readonly id: CandidateId; readonly version: string;
  readonly tool: string; readonly contentSha: string;
}
interface SecretPurpose { readonly key: string; readonly purpose: string }
export type RecipePreview =
  | { readonly transport: 'stdio'; readonly command: string; readonly args: readonly string[];
      readonly environment: readonly { readonly name: string; readonly publicValue: string; readonly purpose: string }[];
      readonly substitutions: readonly { readonly key: string; readonly purpose: string }[];
      readonly secrets: readonly SecretPurpose[]; readonly guide: readonly string[] }
  | { readonly transport: 'http'; readonly url: string;
      readonly secrets: readonly (SecretPurpose & { readonly header: string; readonly prefix: string })[];
      readonly guide: readonly string[] };
export interface McpInvestigation extends DiscoveryItem {
  readonly kind: 'mcp'; readonly recipePreview?: RecipePreview;
}
export interface GuidedPack {
  readonly id: string; readonly name: string; readonly summary: string; readonly description: string;
  readonly items: readonly string[]; readonly alternatives: readonly string[];
  readonly setup: readonly string[]; readonly privacy: string; readonly cost: string;
}
export interface AddonsDiscovery {
  readonly candidates: readonly NativeCandidate[];
  readonly investigations: readonly McpInvestigation[];
  readonly packs: readonly GuidedPack[];
}

const PREVIEWS = ['markitdown', 'tavily', 'firecrawl', 'chrome-devtools', 'dbhub', 'drawio', 'linear'] as const;
const BLOCKED = ['notion', 'serena', 'supabase', 'figma', 'google-workspace', 'microsoft-365', 'slack', 'atlassian', 'home-assistant', 'obsidian', 'sentry', 'cloudflare', 'docker', 'gitlab'] as const;
const GUIDES = ['everyday-assistant', 'research-documents', 'developer', 'creator', 'small-business', 'private-local'] as const;
// These legacy references are navigation identities, never availability claims.
const GUIDE_REFERENCES: readonly string[] = [...NATIVE_CANDIDATE_IDS, ...PREVIEWS, ...BLOCKED, 'focus', 'weather-alerts', 'filesystem', 'reading-list', 'github', 'context7', 'playwright', 'comfyui', 'blender'];
const COMMON = ['id', 'kind', 'name', 'summary', 'description', 'status', 'costTier', 'source', 'documentation', 'qualification', 'prerequisites', 'permissions', 'limitations', 'cost', 'privacy'];
const TOOLS = ['brief', 'extract', 'inspect', 'notebook', 'snapshot', 'review', 'workflow', 'workflow', 'workflow', 'workflow', 'workflow', 'workflow', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'analyze', 'rehearse', 'compare', 'check', 'audit', 'inspect', 'compare', 'request', 'compare', 'migrate', 'inspect', 'diagnose', 'repeat'];
// Pinned manifest versions; every other candidate is 1.0.0.
const VERSIONS: Readonly<Record<string, string>> = { 'api-contract-guard': '0.1.0' };
const COSTS: readonly CostTier[] = ['local-only', 'mixed', 'provider', 'unconfirmed'];

/** Unknown cost classifications remain unconfirmed; prose never decides cost. */
export function costTierFor(value: unknown): CostTier {
  return COSTS.includes(value as CostTier) ? value as CostTier : 'unconfirmed';
}
function invalid(): never { throw new TypeError('Invalid add-on discovery metadata.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const entries = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k))) invalid();
  if (required.some(k => !Object.hasOwn(entries, k))) invalid();
  if (Object.values(entries).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, max = 16): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k)))) invalid();
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value')) invalid();
  }
  return value;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  // Authoring receipts and server-local paths never belong in public prose.
  if (/(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\|\/(?:home|opt|Users|mnt|var|etc|tmp)\/)|(?:outputs|docs[\\/]ops|docs[\\/]store|store[\\/](?:addons|plugins|mcp))[\\/]/i.test(value)) invalid();
  return value;
}
function strings(value: unknown, max = 16, size = 2000): string[] {
  return array(value, max).map(v => text(v, size));
}
function url(value: unknown): string {
  const raw = text(value, 2048);
  if (raw.trim() !== raw || /\s/.test(raw)) invalid();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { invalid(); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || !host.includes('.') || /[:\[\]]/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(host)) invalid();
  if (/\.(?:zip|tgz|sarapack|exe|msi|dmg)(?:$|\/)/i.test(parsed.pathname)) invalid();
  return raw;
}
function exactIds(items: readonly { id: string }[], expected: readonly string[]): void {
  if (items.length !== expected.length || new Set(items.map(x => x.id)).size !== expected.length || items.some(x => !expected.includes(x.id))) invalid();
}
function common(value: unknown, kind: 'plugin' | 'mcp'): DiscoveryItem {
  const x = record(value, kind === 'plugin' ? [...COMMON, 'version', 'tool', 'contentSha'] : COMMON, kind === 'mcp' ? ['recipePreview'] : []);
  if (x.kind !== kind || !COSTS.includes(x.costTier as CostTier)) invalid();
  if (!['in-testing', 'tested', 'needs-account', 'blocked'].includes(x.status as string)) invalid();
  return { id: text(x.id, 80), kind, name: text(x.name, 100), summary: text(x.summary, 240), description: text(x.description),
    status: x.status as QualificationState, costTier: x.costTier as CostTier,
    source: url(x.source), documentation: url(x.documentation), qualification: text(x.qualification),
    prerequisites: strings(x.prerequisites), permissions: strings(x.permissions), limitations: strings(x.limitations), cost: text(x.cost), privacy: text(x.privacy) };
}
function recipe(value: unknown, id: string): RecipePreview {
  const http = id === 'linear';
  const x = record(value, http ? ['transport', 'url', 'secrets', 'guide'] : ['transport', 'command', 'args', 'environment', 'substitutions', 'secrets', 'guide']);
  const guide = strings(x.guide);
  const secrets = array(x.secrets).map(v => {
    const s = record(v, http ? ['key', 'purpose', 'header', 'prefix'] : ['key', 'purpose']);
    const key = text(s.key, 80); if (!/^[A-Z][A-Z0-9_]*$/.test(key)) invalid();
    const base = { key, purpose: text(s.purpose) };
    if (!http) return base;
    if (s.header !== 'Authorization' || s.prefix !== 'Bearer ') invalid();
    return { ...base, header: 'Authorization', prefix: 'Bearer ' };
  });
  if (http) {
    if (x.transport !== 'http' || x.url !== 'https://mcp.linear.app/mcp' || secrets.length !== 1 || secrets[0].key !== 'LINEAR_API_KEY') invalid();
    return pinnedRecipe({ transport: 'http', url: url(x.url), secrets: secrets as (SecretPurpose & { header: string; prefix: string })[], guide }, id);
  }
  const command = id === 'markitdown' ? 'uvx' : 'npx';
  if (x.transport !== 'stdio' || x.command !== command) invalid();
  const environment = array(x.environment).map(v => {
    const e = record(v, ['name', 'publicValue', 'purpose']);
    return { name: text(e.name, 80), publicValue: text(e.publicValue, 80), purpose: text(e.purpose) };
  });
  const substitutions = array(x.substitutions).map(v => {
    const s = record(v, ['key', 'purpose']); return { key: text(s.key, 80), purpose: text(s.purpose) };
  });
  return pinnedRecipe({ transport: 'stdio', command, args: strings(x.args), environment, substitutions, secrets, guide }, id);
}
// The previews are pinned preparation contracts. Validating their public shape
// must not admit a newer executable, broader environment or missing safety guide.
function pinnedRecipe(value: RecipePreview, id: string): RecipePreview {
  const expected = discoveryData.investigations.find(item => item.id === id);
  if (!expected || !('recipePreview' in expected) || JSON.stringify(value) !== JSON.stringify(expected.recipePreview)) invalid();
  return value;
}
function pack(value: unknown): GuidedPack {
  const x = record(value, ['id', 'name', 'summary', 'description', 'items', 'alternatives', 'setup', 'privacy', 'cost']);
  const refs = (value: unknown) => { const values = strings(value, 16, 80); if (new Set(values).size !== values.length || values.some(v => !GUIDE_REFERENCES.includes(v))) invalid(); return values; };
  return { id: text(x.id, 80), name: text(x.name, 100), summary: text(x.summary, 240), description: text(x.description), items: refs(x.items), alternatives: refs(x.alternatives), setup: strings(x.setup), privacy: text(x.privacy), cost: text(x.cost) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Validate a complete public model, copying only allowlisted bounded values. */
export function validateDiscovery(input: unknown): AddonsDiscovery {
  const x = record(input, ['candidates', 'investigations', 'packs']);
  const candidates: NativeCandidate[] = array(x.candidates, NATIVE_CANDIDATE_IDS.length).map(value => {
    const item = common(value, 'plugin'); const source = value as Record<string, unknown>;
    const index = NATIVE_CANDIDATE_IDS.indexOf(item.id as CandidateId);
    // A1 candidates are in testing; A2 developer candidates carry their host-tested state.
    const status = index < 12 ? 'in-testing' : 'tested';
    const version = VERSIONS[item.id] ?? '1.0.0';
    if (index < 0 || item.status !== status || source.version !== version || source.tool !== TOOLS[index] || typeof source.contentSha !== 'string' || !/^[a-f0-9]{64}$/.test(source.contentSha)) invalid();
    return { ...item, kind: 'plugin', id: item.id as CandidateId, version, tool: source.tool as string, contentSha: source.contentSha };
  });
  const investigations: McpInvestigation[] = array(x.investigations, 21).map(value => {
    const item = common(value, 'mcp'); const source = value as Record<string, unknown>;
    const blocked = (BLOCKED as readonly string[]).includes(item.id);
    const status = blocked ? 'blocked' : ['tavily', 'firecrawl', 'linear'].includes(item.id) ? 'needs-account' : 'in-testing';
    if (item.status !== status || blocked === Object.hasOwn(source, 'recipePreview')) invalid();
    return blocked ? { ...item, kind: 'mcp' } : { ...item, kind: 'mcp', recipePreview: recipe(source.recipePreview, item.id) };
  });
  const packs = array(x.packs, 6).map(pack);
  exactIds(candidates, NATIVE_CANDIDATE_IDS); exactIds(investigations, [...PREVIEWS, ...BLOCKED]); exactIds(packs, GUIDES);
  return freeze({ candidates, investigations, packs });
}

const model = validateDiscovery(discoveryData);
export const PUBLIC_NATIVE_CANDIDATES = model.candidates;
export const PUBLIC_MCP_INVESTIGATIONS = model.investigations;
export const PUBLIC_GUIDED_PACKS = model.packs;
export function getNativeCandidate(id: unknown): NativeCandidate | undefined {
  return typeof id === 'string' ? PUBLIC_NATIVE_CANDIDATES.find(candidate => candidate.id === id) : undefined;
}
