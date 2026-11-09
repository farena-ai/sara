// M01-M30 developer MCP connections: an inert, validated public read model. Only fixture-tested
// entries carry a recipe preview, and the browser can only copy that preview into the normal
// Settings → Other programs (MCP) add form, switched off. Held and blocked entries never do.
import { developerConnectionsData } from './developer-connections-data.ts';
import type { CostTier, McpInvestigation, RecipePreview } from './discovery.ts';

/** Fixture-tested on this platform with a pinned upstream and no account. */
export const DEVELOPER_READY = Object.freeze(['storybook', 'qdrant'] as const);
/** A real upstream exists, but acceptance needs the owner's account, key, service or spending. */
export const DEVELOPER_HELD = Object.freeze(['postman', 'aws', 'azure', 'google-cloud', 'terraform', 'kubernetes', 'argo-cd', 'netlify', 'redis', 'elasticsearch-and-opensearch', 'clickhouse', 'snowflake', 'neon', 'pinecone', 'datadog', 'grafana', 'new-relic', 'posthog', 'launchdarkly', 'auth0', 'jenkins', 'buildkite'] as const);
/** No trustworthy pinnable upstream, a licence/terms problem or an unsafe tool surface. */
export const DEVELOPER_BLOCKED = Object.freeze(['local-git', 'pulumi', 'vercel', 'mongodb', 'stripe', 'circleci'] as const);
const ALL: readonly string[] = [...DEVELOPER_READY, ...DEVELOPER_HELD, ...DEVELOPER_BLOCKED];
const KEYS = ['id', 'kind', 'name', 'summary', 'description', 'status', 'costTier', 'source', 'documentation', 'qualification', 'prerequisites', 'permissions', 'limitations', 'cost', 'privacy'];
const COSTS: readonly CostTier[] = ['local-only', 'mixed', 'provider', 'unconfirmed'];
// The exact pinned launch of each READY recipe; a preview can never name anything else.
const PINS: Readonly<Record<string, { transport: 'stdio'; command: string; args: readonly string[] } | { transport: 'http'; url: string }>> = {
  qdrant: { transport: 'stdio', command: 'uvx', args: ['--python=3.12', 'mcp-server-qdrant==0.8.1'] },
  storybook: { transport: 'http', url: 'http://127.0.0.1:6006/mcp' },
};

function invalid(): never { throw new TypeError('Invalid developer connection metadata.'); }
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) invalid();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(d, 'value') || !d.enumerable) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 400): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  // Authoring receipts and local paths never belong in public prose.
  if (/(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\|\/(?:home|opt|Users|mnt|var|etc|tmp)\/)|(?:outputs|docs[\\/]ops|docs[\\/]store|store[\\/](?:addons|plugins|mcp))[\\/]/i.test(value)) invalid();
  return value;
}
function texts(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > max) invalid();
  return Array.from({ length: value.length }, (_v, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !Object.hasOwn(d, 'value')) invalid(); return text(d.value); });
}
function https(value: unknown): string {
  const raw = text(value, 300);
  let u: URL; try { u = new URL(raw); } catch { invalid(); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan)$/i.test(u.hostname)) invalid();
  return raw;
}
function preview(id: string, value: unknown): RecipePreview {
  const pin = PINS[id]; if (!pin) invalid();
  if (pin.transport === 'http') {
    const x = plain(value, ['transport', 'url', 'secrets', 'guide']);
    // A loopback app on this computer only, at its exact qualified address; no secrets.
    if (x.transport !== 'http' || x.url !== pin.url || !Array.isArray(x.secrets) || x.secrets.length) invalid();
    return { transport: 'http', url: pin.url, secrets: [], guide: texts(x.guide, 12) };
  }
  const x = plain(value, ['transport', 'command', 'args', 'environment', 'substitutions', 'secrets', 'guide']);
  if (x.transport !== 'stdio' || x.command !== pin.command || JSON.stringify(x.args) !== JSON.stringify(pin.args)) invalid();
  if (!Array.isArray(x.secrets) || x.secrets.length || !Array.isArray(x.substitutions) || x.substitutions.length || !Array.isArray(x.environment) || x.environment.length > 12) invalid();
  const environment = x.environment.map(v => {
    const e = plain(v, ['name', 'publicValue', 'purpose']);
    const name = text(e.name, 64); if (!/^[A-Z][A-Z0-9_]*$/.test(name)) invalid();
    const publicValue = text(e.publicValue, 120); if (/\s|\$/.test(publicValue)) invalid();
    return { name, publicValue, purpose: text(e.purpose, 260) };
  });
  return { transport: 'stdio', command: pin.command, args: [...pin.args], environment, substitutions: [], secrets: [], guide: texts(x.guide, 12) };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}

/** Validate the complete developer connection list: exact identities, states and pinned previews. */
export function validateDeveloperConnections(input: unknown): McpInvestigation[] {
  if (!Array.isArray(input) || input.length !== ALL.length) invalid();
  const seen = new Set<string>();
  const out = input.map((value: unknown) => {
    const source = value as Record<string, unknown>;
    const id = typeof source?.id === 'string' ? source.id : invalid();
    const ready = (DEVELOPER_READY as readonly string[]).includes(id);
    const status = ready ? 'tested' : (DEVELOPER_HELD as readonly string[]).includes(id) ? 'needs-account' : (DEVELOPER_BLOCKED as readonly string[]).includes(id) ? 'blocked' : invalid();
    const x = plain(value, ready ? [...KEYS, 'recipePreview'] : KEYS);
    if (seen.has(id) || x.kind !== 'mcp' || x.status !== status || !COSTS.includes(x.costTier as CostTier)) invalid();
    seen.add(id);
    const item: McpInvestigation = {
      id: text(id, 80), kind: 'mcp', name: text(x.name, 100), summary: text(x.summary, 240), description: text(x.description), status,
      costTier: x.costTier as CostTier, source: https(x.source), documentation: https(x.documentation), qualification: text(x.qualification),
      prerequisites: texts(x.prerequisites, 4), permissions: texts(x.permissions, 6), limitations: texts(x.limitations, 6), cost: text(x.cost), privacy: text(x.privacy, 20),
    };
    return ready ? { ...item, recipePreview: preview(id, x.recipePreview) } : item;
  });
  return deepFreeze(out);
}

export const PUBLIC_DEVELOPER_CONNECTIONS = validateDeveloperConnections(structuredClone(developerConnectionsData) as unknown);
