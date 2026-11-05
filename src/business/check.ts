import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { isIP } from 'node:net';
import { validateBusinessModelPolicy } from './model-policy.ts';
import { BUSINESS_UUID } from './types.ts';
import { exactFields, validId } from './policy.ts';

type CheckStatus = 'ok' | 'needs-action' | 'unverified' | 'blocked';
type CheckId = 'invocation' | 'origin' | 'port' | 'data-root' | 'profile-marker' | 'layout' | 'storage' | 'model-policy' | 'access' | 'usage-recovery' | 'credentials' | 'inference' | 'backup' | 'availability';
export interface BusinessCheck { id: CheckId; status: CheckStatus; message: string; action: string }
export interface BusinessCheckReport { version: 1; status: 'configuration-only' | 'setup-needed' | 'blocked'; checks: BusinessCheck[] }

// Messages are deliberately fixed. No filesystem name, parser exception or configured value enters output.
const guidance: Record<CheckId, { message: string; action: string }> = {
  invocation: { message: 'An explicit business profile, data root and argument-free inspection are required.', action: 'Set SARA_PROFILE=business and a dedicated SARA_DATA; use --business-check without arguments.' },
  origin: { message: 'Serving origin configuration is checked without contacting the hostname.', action: 'Set an exact HTTPS origin, or an HTTP localhost origin for local evaluation; use a hostname for passkeys.' },
  port: { message: 'The serving port is checked independently of the public reverse-proxy port.', action: 'Set SARA_PORT to a decimal integer from 1 to 65535, or use the default port.' },
  'data-root': { message: 'The dedicated data path is inspected without creating directories.', action: 'Use a separate business root outside personal, household and other profile directories.' },
  'profile-marker': { message: 'The business profile marker is checked without initialization or repair.', action: 'For a missing or empty root, perform deliberate business setup; preserve an invalid root for operator review.' },
  layout: { message: 'Only bounded, recognized business filesystem metadata is inspected.', action: 'Review unexpected, linked, nonregular, excessive or incomplete state offline; do not convert personal data.' },
  storage: { message: 'Database validity and schema remain unknown; no database is opened or copied.', action: 'If storage is absent, perform deliberate setup; otherwise review storage through the supported offline operator procedure.' },
  'model-policy': { message: 'Only the bounded stored model-policy shape is checked; credentials and inference remain unverified.', action: 'Configure an explicit local policy and workspace binding with --business-configure when needed.' },
  access: { message: 'Current identities, passkeys, organization grants and workspace access are unknown.', action: 'Use the intended hostname and individual passkeys; authorized administrators and managers must verify current access.' },
  'usage-recovery': { message: 'Pending requests, held exposure, spending pauses and recovery state are unknown and unchanged.', action: 'Stop the intended runtime before explicit --business-status and any separately authorized recovery or uncertainty review.' },
  credentials: { message: 'Credential, key and encrypted Vault validity are unknown; their contents are never read.', action: 'The installation operator must verify credential custody separately; browser administration does not grant this authority.' },
  inference: { message: 'Provider reachability, model availability and successful inference are unverified.', action: 'Perform a separate approved inference check within the installation model and spending policy.' },
  backup: { message: 'Backup validity, custody and restoration targets are unverified.', action: 'Take a private encrypted business backup and rehearse recovery into a separate fresh target.' },
  availability: { message: 'Production availability and capacity are unverified; this is configuration inspection only.', action: 'Verify hostname-bound health and the intended workload separately before making a production decision.' },
};
const ids = Object.keys(guidance) as CheckId[];
const personalState = ['owner.json', 'owner.json.bak', 'household.json', 'settings.json', 'sara.db', 'members', 'companions'];
const sidecar = '(?:-wal|-shm|-journal)?';
const uuid = BUSINESS_UUID.source.slice(1, -1);
const authDirectory = new RegExp(`^business/auth/${uuid}(?:/(?:0|[1-9][0-9]{0,14}))?$`);
const authFile = new RegExp(`^business/auth/${uuid}/(?:0|[1-9][0-9]{0,14})/(?:owner\\.json(?:\\.bak)?|scope\\.json)$`);
const workspaceDirectory = new RegExp(`^business/workspaces/${uuid}$`);
const workspaceFile = new RegExp(`^business/workspaces/${uuid}/content\\.db${sidecar}$`);

function metadata(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function regularFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe file metadata.');
}
function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.nlink === after.nlink && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function revalidateDirectories(root: string, snapshots: Map<string, Stats | undefined>, layoutDirectories: Set<string>): void {
  for (const [path, before] of snapshots) {
    const after = metadata(path);
    if (!before) { if (after) throw new Error('Missing directory changed during inspection.'); continue; }
    if (!after || !after.isDirectory() || after.isSymbolicLink() || realpathSync(path) !== path || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) throw new Error('Directory ancestry changed during inspection.');
    // Ignore unrelated ancestor-directory activity; inspected-tree changes refuse the snapshot.
    if (layoutDirectories.has(path) && !sameFile(before, after)) throw new Error('Inspected directory changed.');
    if (!layoutDirectories.has(path) || path === root) {
      if (personalState.some(name => metadata(join(path, name))) || path !== root && metadata(join(path, 'profile.json'))) throw new Error('Profile ancestry changed during inspection.');
    }
  }
}
/** Only profile/policy callers use this reader. Growth cannot cause an unbounded allocation/read. */
function boundedJson(path: string, maximum: number, revalidate: () => void): unknown {
  revalidate();
  const before = lstatSync(path); regularFile(before);
  if (before.size > maximum) throw new Error('Input exceeds inspection bound.');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    // O_NOFOLLOW protects only the leaf. Recheck the original parents before reading this fd.
    revalidate();
    const opened = fstatSync(descriptor); regularFile(opened);
    if (!sameFile(before, opened) || opened.size > maximum) throw new Error('Input changed during inspection.');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor); regularFile(after);
    const final = lstatSync(path); regularFile(final);
    if (length > maximum || length !== opened.size || !sameFile(opened, after) || !sameFile(after, final)) throw new Error('Input changed during inspection.');
    revalidate();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown;
  } finally { closeSync(descriptor); }
}
function inspectAncestors(root: string, snapshots: Map<string, Stats | undefined>): void {
  let count = 0;
  for (let path = root; ; path = dirname(path)) {
    if (++count > 256) throw new Error('Path exceeds inspection bound.');
    const stat = metadata(path);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Unsafe path ancestry.');
      if (personalState.some(name => metadata(join(path, name)))) throw new Error('Personal or household ancestry.');
      if (path !== root && metadata(join(path, 'profile.json'))) throw new Error('Nested profile ancestry.');
    }
    snapshots.set(path, stat);
    if (path === parse(path).root) return;
  }
}
function knownPath(path: string, directory: boolean): boolean {
  if (directory) return ['business', 'business/auth', 'business/operator', 'business/workspaces'].includes(path) || authDirectory.test(path) || workspaceDirectory.test(path);
  return ['profile.json', 'business/model-policy.json', 'business/recovery-generation.json', 'business/proxy-secret', 'business/operator/master.key', 'business/operator/secrets.enc'].includes(path)
    || new RegExp(`^business/(?:business|writer-fence)\\.db${sidecar}$`).test(path) || authFile.test(path) || workspaceFile.test(path);
}
function inspectLayout(root: string, snapshots: Map<string, Stats | undefined>, layoutDirectories: Set<string>): Set<string> {
  const present = new Set<string>(); let entries = 0;
  function walk(directory: string, prefix: string, depth: number) {
    if (depth > 10) throw new Error('Tree exceeds inspection depth.');
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Unsafe directory metadata.');
    if (!snapshots.has(directory)) snapshots.set(directory, info);
    layoutDirectories.add(directory);
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > 10000) throw new Error('Tree exceeds inspection entry bound.');
        const path = join(directory, entry.name); const relative = prefix + entry.name; const stat = lstatSync(path);
        if (stat.isSymbolicLink() || relative.length > 512 || !knownPath(relative, stat.isDirectory())) throw new Error('Unrecognized or linked state.');
        present.add(relative);
        if (stat.isDirectory()) walk(path, relative + '/', depth + 1);
        else regularFile(stat);
      }
    } finally { handle.closeSync(); }
    if (!sameFile(info, lstatSync(directory))) throw new Error('Directory changed during inspection.');
  }
  walk(root, '', 0); return present;
}

/** Configuration evidence only. Never initializes a profile or constructs a store, Vault or runtime. */
export function inspectBusinessConfiguration(env: NodeJS.ProcessEnv, args: readonly string[] = []): BusinessCheckReport {
  const checks = ids.map(id => ({ id, status: 'unverified' as CheckStatus, ...guidance[id] }));
  const set = (id: CheckId, status: CheckStatus) => { checks.find(check => check.id === id)!.status = status; };
  const snapshots = new Map<string, Stats | undefined>(); const layoutDirectories = new Set<string>();
  let root = '';
  const revalidate = () => revalidateDirectories(root, snapshots, layoutDirectories);
  const result = (): BusinessCheckReport => {
    try { revalidate(); } catch { set('layout', 'blocked'); }
    return { version: 1, status: checks.some(check => check.status === 'blocked') ? 'blocked' : checks.some(check => check.status === 'needs-action') ? 'setup-needed' : 'configuration-only', checks };
  };
  if (args.length || env.SARA_PROFILE !== 'business' || !env.SARA_DATA?.trim() || env.SARA_DATA.length > 4096 || env.SARA_DATA.includes('\0')) { set('invocation', 'blocked'); return result(); }
  set('invocation', 'ok');
  try {
    const value = env.SARA_BUSINESS_ORIGIN;
    if (!value || value.length > 2048) throw new Error('Explicit origin required.');
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid origin.');
    set('origin', isIP(url.hostname.replace(/^\[|\]$/g, '')) ? 'needs-action' : 'ok');
  } catch { set('origin', 'blocked'); }
  const port = env.SARA_PORT ?? '7860';
  set('port', /^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535 ? 'ok' : 'blocked');
  if (checks.some(check => check.status === 'blocked')) return result();
  root = resolve(env.SARA_DATA);
  let rootExists: boolean;
  try { inspectAncestors(root, snapshots); rootExists = !!metadata(root); set('data-root', 'ok'); }
  catch { set('data-root', 'blocked'); return result(); }
  if (!rootExists) { set('profile-marker', 'needs-action'); set('storage', 'needs-action'); set('model-policy', 'needs-action'); return result(); }
  let present: Set<string>;
  try { present = inspectLayout(root, snapshots, layoutDirectories); revalidate(); set('layout', 'ok'); }
  catch { set('layout', 'blocked'); return result(); }
  if (!present.size) { set('profile-marker', 'needs-action'); set('storage', 'needs-action'); set('model-policy', 'needs-action'); return result(); }
  if (!present.has('profile.json')) { set('profile-marker', 'blocked'); return result(); }
  try {
    const marker = boundedJson(join(root, 'profile.json'), 4096, revalidate); exactFields(marker, ['version', 'profile']);
    if (marker.version !== 1 || marker.profile !== 'business') throw new Error('Unsupported profile marker.');
    set('profile-marker', 'ok');
  } catch { set('profile-marker', 'blocked'); return result(); }
  if (!present.has('business/business.db')) set('storage', 'needs-action');
  if (!present.has('business/model-policy.json')) set('model-policy', 'needs-action');
  else {
    try {
      const stored = boundedJson(join(root, 'business', 'model-policy.json'), 262144, revalidate); exactFields(stored, ['revision', 'policy']); validId(stored.revision);
      const policy = validateBusinessModelPolicy(stored.policy);
      set('model-policy', Object.keys(policy.workspaces).length ? 'ok' : 'needs-action');
    } catch { set('model-policy', 'blocked'); }
  }
  return result();
}
