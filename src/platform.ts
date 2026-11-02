// Phase 46: Sara's server on Linux, Windows and macOS. What differs between them, in one place:
// how to name the system, which admin command to suggest, whether local voice exists, and the
// "how you reach her" block the installers set through environment variables.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { en } from './i18n.ts';

/** A friendly name for the operating system ("Windows", "macOS", "Linux"). */
export function systemName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
}

export interface HintEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * The command to suggest for an admin task (`reset-token`, `restore <file>`, `doctor`, `stop`,
 * `update`). Linux installs have `sudo sara …`; Docker has `docker compose exec`; the Windows and
 * macOS installers put a `sara` command on the PATH and set SARA_INSTALLED=1; a plain checkout uses
 * `node src/main.ts --…`.
 */
export function adminHint(task: string, o: HintEnv = {}): string {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  if (platform === 'linux' && exists('/usr/local/bin/sara')) return `sudo sara ${task}`;
  if (platform !== 'linux' && env.SARA_INSTALLED === '1') {
    // The Mac app runs her as the signed-in user, so its `sara` command needs no sudo (Phase 46d).
    if (task === 'stop') return platform === 'win32' ? 'sara stop, in a terminal opened as administrator' : 'sara stop (or the menu bar: Sara on this Mac → Stop)';
    return `sara ${task}`;
  }
  if (env.SARA_DATA === '/data') return task === 'stop' ? 'docker compose stop sara' : `docker compose exec sara node src/main.ts --${task}`;
  if (task === 'stop') return 'press Ctrl+C in the window where she runs';
  return `node src/main.ts --${task}`;
}

export interface AdminHelp {
  /** "Windows", "macOS", "Linux". */
  system: string;
  doctor: string;
  restore: string;
  resetToken: string;
  /** How this server gets a newer version. */
  update: string;
  /** How to install Claude Code / Grok Build for her. */
  agents: string;
  /** Where admin commands are typed. */
  where: string;
}

/** The admin hints the web app shows (Settings → Data & health, Backups, Updates, sign-in, subscriptions). */
export function adminHelp(o: HintEnv = {}): AdminHelp {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const docker = env.SARA_DATA === '/data' && !(platform === 'linux' && exists('/usr/local/bin/sara'));
  const installed = (platform === 'linux' && exists('/usr/local/bin/sara')) || (platform !== 'linux' && env.SARA_INSTALLED === '1');
  const update = docker
    ? 'docker compose pull && docker compose up -d'
    : installed
      ? platform === 'linux'
        ? 'sudo sara update'
        : `download the newest Sara installer for ${systemName(platform)} and run it (sara update opens the page)`
      : 'git pull, then start her again';
  const where = docker
    ? 'on the server, in the folder with docker-compose.yml'
    : platform === 'win32'
      ? env.SARA_INSTALLED === '1'
        ? 'in a terminal on the computer she runs on (opened as administrator when she runs as a service)'
        : 'in a terminal in her folder'
      : platform === 'darwin'
        ? 'in Terminal on the Mac she runs on'
        : 'on the server';
  return {
    system: systemName(platform),
    doctor: adminHint('doctor', { platform, env, exists }),
    restore: adminHint('restore <file>', { platform, env, exists }),
    resetToken: docker ? 'docker compose exec sara node src/main.ts --reset-token' : adminHint('reset-token', { platform, env, exists }),
    update,
    agents: agentInstallHint(platform),
    where,
  };
}

/**
 * Local voice (sherpa-onnx tools and models). Linux: deploy/install-voice.sh. Phase 126 part C
 * (WAKE.md §7): Windows and macOS too, once `sara voice install` (or Settings → Voice → Install
 * hearing and voices on this computer) has put voice.json in the voice folder.
 */
let localVoiceDir: string | undefined;
/** Set once at start-up (src/main.ts): the voice folder on Windows and macOS (`<data>/voice`). */
export function setLocalVoiceDir(dir: string | undefined): void {
  localVoiceDir = dir;
}
export function localVoiceSupported(platform: NodeJS.Platform = process.platform, opts: { dir?: string; exists?: (p: string) => boolean } = {}): boolean {
  if (platform === 'linux') return true;
  if (platform !== 'win32' && platform !== 'darwin') return false;
  const dir = opts.dir ?? localVoiceDir;
  return Boolean(dir && (opts.exists ?? existsSync)(join(dir, 'voice.json')));
}
/** Windows and macOS can install it (x64, arm64). */
export const localVoiceInstallable = (platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean => (platform === 'win32' || platform === 'darwin') && (arch === 'x64' || arch === 'arm64');

/** What to say when local voice isn't there. */
export function localVoiceMissing(platform: NodeJS.Platform = process.platform, opts: { dir?: string; exists?: (p: string) => boolean } = {}): string {
  if (platform === 'linux') return 'not installed (deploy/install-voice.sh)';
  if (localVoiceInstallable(platform) && !localVoiceSupported(platform, opts)) return 'not installed yet (Settings → Voice → Install hearing and voices on this computer, about 650 MB)';
  if (!localVoiceSupported(platform, opts)) return `Local voice isn't available on ${systemName(platform)} yet: use Grok or OpenAI voice`;
  return 'not installed (Settings → Voice → Install hearing and voices on this computer)';
}

/** How to install Claude Code / Grok Build for her (deploy/install-agents.sh is Linux only). */
export function agentInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') return 'Run deploy/install-agents.sh.';
  return 'Install it on this computer so it is on the PATH (or set SARA_CLAUDE_BIN / SARA_GROK_BIN to where it is).';
}

// ---- How the owner reaches her (set by the installers) ----

export type AccessMode = 'local' | 'tailscale' | 'domain' | 'lan';
export const ACCESS_MODES: readonly AccessMode[] = ['local', 'tailscale', 'domain', 'lan'];

const ACCESS_LABEL: Record<AccessMode, string> = {
  local: en('Just this computer'),
  tailscale: en('Tailscale (your private network)'),
  domain: en('Your own web address'),
  lan: en('Your home network'),
};

export interface AccessInfo {
  /** Null when no installer set it (a manual or older install). */
  mode: AccessMode | null;
  label: string;
  /** The address to open on a phone or another computer. */
  url: string | null;
  /** A plain warning when the way in isn't private (home network without HTTPS). */
  warning?: string;
  /**
   * Phase 122 (WHATSAPP §3.1 W2): the public https address Meta (or any webhook sender) calls:
   * `SARA_HOOK_URL` (the `/hook/` door: Funnel, a tunnel), else `SARA_PUBLIC_URL` when it is https
   * and the mode is `domain`; null otherwise (Tailscale without the door, home network, this computer).
   */
  hookUrl: string | null;
}

/** Reads SARA_ACCESS and SARA_PUBLIC_URL. Read-only: changed by the installer or `sara access`. */
export function accessInfo(env: NodeJS.ProcessEnv = process.env): AccessInfo {
  const raw = String(env.SARA_ACCESS ?? '').trim().toLowerCase();
  const mode = (ACCESS_MODES as readonly string[]).includes(raw) ? (raw as AccessMode) : null;
  let url: string | null = null;
  const u = String(env.SARA_PUBLIC_URL ?? '').trim();
  if (u) {
    try {
      const p = new URL(u);
      if ((p.protocol === 'https:' || p.protocol === 'http:') && !p.username && !p.password) url = p.href.replace(/\/$/, '');
    } catch {
      url = null;
    }
  }
  let hookUrl: string | null = null;
  const h = String(env.SARA_HOOK_URL ?? '').trim();
  if (h) {
    try {
      const p = new URL(h);
      if (p.protocol === 'https:' && !p.username && !p.password) hookUrl = p.origin;
    } catch {
      hookUrl = null;
    }
  }
  if (!hookUrl && url?.startsWith('https:') && mode === 'domain') hookUrl = new URL(url).origin;
  const info: AccessInfo = { mode, label: mode ? ACCESS_LABEL[mode] : en('Not set up by an installer'), url, hookUrl };
  if (url?.startsWith('http:') && mode !== 'local') info.warning = en('This address has no HTTPS: anyone on the same network could read what you send. Fine at home on a network you trust; use Tailscale for anywhere else.');
  return info;
}
