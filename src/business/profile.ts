import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

export interface BusinessProfile {
  readonly profile: 'business';
  readonly root: string;
  readonly businessDir: string;
}

const PERSONAL_STATE = ['owner.json', 'owner.json.bak', 'household.json', 'settings.json', 'sara.db', 'members', 'companions'];

export function runtimeProfile(env: NodeJS.ProcessEnv): 'personal' | 'business' {
  const value = env.SARA_PROFILE ?? 'personal';
  if (value !== 'personal' && value !== 'business') throw new Error('SARA_PROFILE must be personal or business.');
  return value;
}

function ancestors(path: string): string[] {
  const paths: string[] = [];
  for (let p = resolve(path); ; p = dirname(p)) {
    paths.push(p);
    if (p === parse(p).root) return paths;
  }
}

function assertNoLinks(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('Business data must not contain symbolic links or path escapes.');
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertNoLinks(join(path, name));
}

/** Fail before creating anything in an existing personal/household installation. */
export function openBusinessProfile(dataRoot: string): BusinessProfile {
  if (!dataRoot.trim()) throw new Error('Business profile requires an explicit empty SARA_DATA root.');
  const root = resolve(dataRoot);
  for (const path of ancestors(root)) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) throw new Error('Business root cannot traverse a symbolic link or path escape.');
    if (PERSONAL_STATE.some(name => existsSync(join(path, name)))) throw new Error('Business profile cannot use a personal or household data root or its descendants.');
    if (path !== root && existsSync(join(path, 'profile.json'))) throw new Error('Business roots cannot be nested inside another profile.');
  }
  if (existsSync(root)) {
    assertNoLinks(root);
    const entries = readdirSync(root);
    if (existsSync(join(root, 'profile.json'))) {
      const marker = JSON.parse(readFileSync(join(root, 'profile.json'), 'utf8')) as { profile?: string; version?: number };
      if (marker.profile !== 'business' || marker.version !== 1) throw new Error('Invalid business profile marker.');
      if (entries.some(name => name !== 'profile.json' && name !== 'business')) throw new Error('Business root contains personal or unrecognized state.');
    } else if (entries.length) throw new Error('A new business profile requires an empty data root; personal data is never converted.');
  } else mkdirSync(root, { recursive: true, mode: 0o700 });
  const businessDir = join(root, 'business');
  if (!existsSync(join(root, 'profile.json'))) writeFileSync(join(root, 'profile.json'), JSON.stringify({ version: 1, profile: 'business' }) + '\n', { flag: 'wx', mode: 0o600 });
  mkdirSync(businessDir, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || realpathSync(businessDir) !== businessDir) throw new Error('Business data realpath escapes the configured root.');
  return Object.freeze({ profile: 'business', root, businessDir });
}

export function assertPersonalProfile(dataRoot: string): void {
  for (const path of ancestors(dataRoot)) {
    const marker = join(path, 'profile.json');
    if (!existsSync(marker)) continue;
    let profile: unknown;
    try { profile = (JSON.parse(readFileSync(marker, 'utf8')) as { profile?: unknown }).profile; } catch { continue; }
    if (profile === 'business') throw new Error('Marked business data cannot run as a personal instance. Select SARA_PROFILE=business.');
  }
}
