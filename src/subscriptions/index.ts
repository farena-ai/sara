// Subscription logins: ChatGPT (OpenAI's documented Sign in with ChatGPT for open-source apps),
// Claude (the owner's own Claude Code token, used by the official `claude` program) and Grok
// (the official `grok` program, signed in with xAI's device-code login). All optional and off
// until the owner signs in. Tokens live in the encrypted vault or in the CLI's private home under
// the data directory; nothing is shipped with Sara.
import { agentInstallHint } from '../platform.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind, AgentRuntime } from '../providers/cli-agent.ts';
import type { Vault } from '../vault.ts';
import { ChatGptAuth } from './chatgpt.ts';

export const CLAUDE_VAULT = 'sub:claude';

export interface ClaudeLogin {
  url: string;
  state: 'waiting' | 'done' | 'failed';
  error?: string;
  /** Where the program's output stood when the code was typed (errors after it count). */
  codeSentAt?: number;
}

/** Removes terminal escape codes; cursor-forward codes become spaces. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\r+\n/g, '\n')
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Number(n || 1)))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, (c) => (c === '\r' ? '\n' : ''));
}

/**
 * Finds `start` in terminal text and re-joins it if the terminal wrapped it: following lines are
 * appended while they contain no spaces (a wrapped URL/token), never ordinary text lines.
 */
export function findWrapped(text: string, start: RegExp, chars = /^[\w%&=.\-~:/?#+]+$/): string | undefined {
  const lines = text.split('\n').map((l) => l.trimEnd());
  for (let i = 0; i < lines.length; i++) {
    const m = start.exec(lines[i]);
    if (!m) continue;
    let out = lines[i].slice(m.index).split(/\s/)[0];
    if (/\s/.test(lines[i].slice(m.index).trim())) return out; // text continued on the same line
    for (let j = i + 1; j < lines.length && chars.test(lines[j].trim()) && lines[j].trim(); j++) out += lines[j].trim();
    return out;
  }
  return undefined;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface GrokLogin {
  url: string;
  code: string;
  state: 'waiting' | 'done' | 'failed';
  error?: string;
}

export class Subscriptions {
  readonly chatgpt: ChatGptAuth;
  readonly #vault: Vault;
  readonly #dataDir: string;
  readonly #agentsDir: string;
  #grokLogin: { proc: ChildProcess; info: GrokLogin } | undefined;
  #grokRenew: Promise<void> | undefined;
  #claudeLogin: { proc: ChildProcess; info: ClaudeLogin; out: () => string } | undefined;
  /** Test hook: run the CLI directly instead of under a pseudo-terminal. */
  readonly #pty: boolean;
  readonly #binArgs: Partial<Record<AgentKind, string[]>>;

  constructor(vault: Vault, dataDir: string, opts: { agentsDir?: string; chatgpt?: ChatGptAuth; pty?: boolean; bins?: Partial<Record<AgentKind, { bin: string; args?: string[] }>> } = {}) {
    this.#vault = vault;
    this.#pty = opts.pty ?? process.platform === 'linux';
    this.#bins = opts.bins ?? {};
    this.#binArgs = Object.fromEntries(Object.entries(this.#bins).map(([k, v]) => [k, v?.args ?? []]));
    this.#dataDir = dataDir;
    this.#agentsDir = opts.agentsDir ?? process.env.SARA_AGENTS_DIR ?? '/opt/sara-agents';
    this.chatgpt = opts.chatgpt ?? new ChatGptAuth(vault);
  }

  readonly #bins: Partial<Record<AgentKind, { bin: string; args?: string[] }>>;

  bin(kind: AgentKind): string {
    if (this.#bins[kind]) return this.#bins[kind]!.bin;
    const env = process.env[kind === 'claude' ? 'SARA_CLAUDE_BIN' : 'SARA_GROK_BIN'];
    if (env) return env;
    // deploy/install-agents.sh puts the native binaries here.
    const local = join(this.#agentsDir, 'bin', kind);
    return existsSync(local) ? local : kind;
  }

  installed(kind: AgentKind): boolean {
    if (this.#bins[kind]) return true;
    const b = this.bin(kind);
    return b !== kind || Boolean(process.env[kind === 'claude' ? 'SARA_CLAUDE_BIN' : 'SARA_GROK_BIN']);
  }

  agent(kind: AgentKind): AgentRuntime {
    return {
      kind,
      bin: this.bin(kind),
      home: join(this.#dataDir, 'agents', kind),
      tmpDir: join(this.#dataDir, 'tmp', 'agents'),
      env: (): Record<string, string> => {
        const t = kind === 'claude' ? this.#vault.get(CLAUDE_VAULT) : undefined;
        return t ? { CLAUDE_CODE_OAUTH_TOKEN: t } : {};
      },
      tools: true,
      ...(this.#binArgs[kind]?.length ? { binArgs: this.#binArgs[kind] } : {}),
    };
  }

  // ---- Claude ----
  setClaudeToken(token: string): void {
    const t = token.trim();
    if (!/^sk-ant-oat01-[\w-]{20,}$/.test(t)) throw new Error('That does not look like the token `claude setup-token` prints at the end. Copy the whole long line it shows.');
    this.#vault.set(CLAUDE_VAULT, t);
  }

  clearClaude(): void {
    this.#vault.delete(CLAUDE_VAULT);
  }

  claudeStatus(): { installed: boolean; signedIn: boolean; login: ClaudeLogin | null } {
    return { installed: this.installed('claude'), signedIn: Boolean(this.#vault.get(CLAUDE_VAULT)), login: this.#claudeLogin?.info ?? null };
  }

  /**
   * Starts the official `claude setup-token` sign-in and returns its link. The owner signs in,
   * Anthropic shows a code, and finishClaudeLogin() types that code into the same program, which
   * then prints a long-lived token for the owner's subscription. It needs a terminal, so on Linux
   * it runs under `script` (util-linux) with a wide virtual screen.
   */
  startClaudeLogin(): Promise<ClaudeLogin> {
    this.#claudeLogin?.proc.kill();
    const rt = this.agent('claude');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: rt.home, USERPROFILE: rt.home, TERM: 'xterm-256color', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const args = [...(rt.binArgs ?? []), 'setup-token'];
    const [cmd, argv] = this.#pty ? ['script', ['-qfc', `stty cols 4000 rows 60; exec ${[rt.bin, ...args].map(shq).join(' ')}`, '/dev/null']] : [rt.bin, args];
    return new Promise((resolve, reject) => {
      mkdirSync(rt.home, { recursive: true, mode: 0o700 });
      const proc = spawn(cmd, argv as string[], { env, cwd: rt.home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const info: ClaudeLogin = { url: '', state: 'waiting' };
      let raw = '';
      let urlTimer: NodeJS.Timeout | undefined;
      this.#claudeLogin = { proc, info, out: () => stripAnsi(raw) };
      const onData = (d: Buffer) => {
        raw = (raw + d).slice(-200_000);
        const text = stripAnsi(raw);
        // After a code was typed: Claude's own error (e.g. "OAuth error: … 400") ends the wait at
        // once, with its words, instead of waiting silently.
        if (info.state === 'waiting' && info.codeSentAt !== undefined) {
          const after = text.slice(info.codeSentAt);
          const err = /OAuth error:[^\n]*|Invalid code[^\n]*|[^\n]*(?:expired|invalid_grant)[^\n]*/i.exec(after)?.[0]?.trim();
          if (err && !/sk-ant-oat01-/.test(after)) {
            info.state = 'failed';
            info.error = `Claude refused that code (${err.replace(/\s+/g, ' ').slice(0, 200)}). Codes work once and only with the newest link: press "Sign in to Claude" again, use the link it opens, and paste the new code.`;
            console.warn(`claude sign-in: ${err.slice(0, 200)}`);
            setTimeout(() => proc.kill(), 200);
          }
        }
        // The link can arrive in pieces; take it once the prompt after it shows (or after 2 s).
        const url = findWrapped(text, /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\?/);
        if (url && !info.url) {
          const done = () => {
            if (info.url) return;
            info.url = findWrapped(stripAnsi(raw), /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\?/) ?? url;
            resolve(info);
          };
          if (/paste code|code here/i.test(text.slice(text.indexOf('oauth/authorize')))) done();
          else urlTimer ??= setTimeout(done, 2000);
        }
        const found = findWrapped(text, /sk-ant-oat01-/, /^[\w-]+$/);
        const token = found && /^sk-ant-oat01-[\w-]{20,}$/.test(found) ? found : undefined;
        if (token && info.state === 'waiting') {
          this.setClaudeToken(token);
          info.state = 'done';
          setTimeout(() => proc.kill(), 500);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      const timer = setTimeout(() => proc.kill(), 15 * 60_000);
      proc.on('error', (e) => {
        info.state = 'failed';
        info.error = `Claude Code isn't installed on this server (${e.message}). ${agentInstallHint()}`;
        reject(new Error(info.error));
      });
      proc.on('close', () => {
        clearTimeout(timer);
        if (info.state === 'waiting') {
          info.state = 'failed';
          const lines = stripAnsi(raw).split('\n').map((l) => l.trim()).filter(Boolean);
          info.error = lines.filter((l) => /error|invalid|fail/i.test(l)).slice(-1)[0]?.slice(0, 300) ?? 'Sign-in did not finish. Try again.';
        }
        if (!info.url) reject(new Error(info.error ?? 'Claude sign-in could not start.'));
      });
    });
  }

  /** Types the code from Anthropic's page into the waiting sign-in; resolves when the token is saved. */
  async finishClaudeLogin(code: string): Promise<{ installed: boolean; signedIn: boolean; login: ClaudeLogin | null }> {
    const l = this.#claudeLogin;
    if (!l || l.info.state !== 'waiting') throw new Error('Press "Sign in to Claude" first.');
    const c = code.trim().replace(/\s+/g, '');
    if (!c || c.length > 2000) throw new Error('Paste the code Claude showed you after signing in.');
    const info: ClaudeLogin = l.info;
    info.codeSentAt = l.out().length;
    // Claude's input box takes a long burst of characters as a paste, and an Enter inside the
    // paste doesn't submit it. Type the code, then press Enter on its own.
    l.proc.stdin?.write(c);
    await new Promise((r) => setTimeout(r, 400));
    l.proc.stdin?.write('\r');
    for (let i = 0; i < 120 && info.state === 'waiting'; i++) await new Promise((r) => setTimeout(r, 500));
    if ((info.state as ClaudeLogin['state']) !== 'done') throw new Error(l.info.error ?? 'Claude did not accept that code. Press "Sign in to Claude" and try again.');
    return this.claudeStatus();
  }

  // ---- Grok ----
  grokStatus(): { installed: boolean; signedIn: boolean; login: GrokLogin | null } {
    const home = this.agent('grok').home;
    return { installed: this.installed('grok'), signedIn: existsSync(join(home, '.grok', 'auth.json')), login: this.#grokLogin?.info ?? null };
  }

  /**
   * The Grok sign-in's access token, for xAI's own APIs that the subscription's usage pool covers
   * (voice, Imagine). Renewed by the official Grok program (`grok models` refreshes it) when it is
   * within 5 minutes of expiring. Undefined when not signed in.
   */
  async grokAccessToken(now: () => number = Date.now): Promise<string | undefined> {
    const rt = this.agent('grok');
    const file = join(rt.home, '.grok', 'auth.json');
    const read = (): { key?: string; expires_at?: string } | undefined => {
      if (!existsSync(file)) return undefined;
      try {
        return Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, { key?: string; expires_at?: string }>)[0];
      } catch {
        return undefined;
      }
    };
    let a = read();
    if (!a?.key) return undefined;
    const fresh = () => Boolean(a?.expires_at && Date.parse(a.expires_at) - now() > 5 * 60_000);
    if (!fresh()) {
      this.#grokRenew ??= new Promise<void>((resolve) => {
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: rt.home, USERPROFILE: rt.home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
        const p = spawn(rt.bin, [...(rt.binArgs ?? []), 'models'], { env, cwd: rt.home, stdio: 'ignore', windowsHide: true });
        const t = setTimeout(() => p.kill(), 60_000);
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        p.on('error', done);
        p.on('close', done);
      }).finally(() => (this.#grokRenew = undefined));
      await this.#grokRenew;
      a = read();
      // Grok renews its own sign-in when it needs to; a token with time left is still good even if
      // this renewal didn't move it. Only a token that is really past its time counts as expired.
      const valid = Boolean(a?.expires_at && Date.parse(a.expires_at) - now() > 30_000);
      if (!a?.key || (!fresh() && !valid)) throw new Error('Your Grok sign-in needs renewing. Sign in to Grok again (Settings → Models & usage → Providers and plans → Subscriptions).');
    }
    return a.key;
  }

  /** Starts `grok login --device-auth`; resolves once the link and code are known. */
  startGrokLogin(): Promise<GrokLogin> {
    this.#grokLogin?.proc.kill();
    const rt = this.agent('grok');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: rt.home, USERPROFILE: rt.home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    return new Promise((resolve, reject) => {
      const proc = spawn(rt.bin, ['login', '--device-auth'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const info: GrokLogin = { url: '', code: '', state: 'waiting' };
      this.#grokLogin = { proc, info };
      let out = '';
      const onData = (d: Buffer) => {
        out += d;
        const url = /https:\/\/accounts\.x\.ai\/\S+/.exec(out)?.[0];
        const code = /user_code=([A-Z0-9-]+)/.exec(out)?.[1] ?? /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(out)?.[1];
        if (url && code && !info.url) {
          info.url = url;
          info.code = code;
          resolve(info);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      const timer = setTimeout(() => proc.kill(), 15 * 60_000);
      proc.on('error', (e) => {
        info.state = 'failed';
        info.error = `Grok isn't installed on this server (${e.message}). ${agentInstallHint()}`;
        reject(new Error(info.error));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (info.state === 'waiting') {
          info.state = code === 0 && this.grokStatus().signedIn ? 'done' : 'failed';
          if (info.state === 'failed') info.error = out.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'Sign-in did not finish.';
        }
        if (!info.url) reject(new Error(info.error ?? 'Grok sign-in could not start.'));
      });
    });
  }

  async grokLogout(): Promise<void> {
    this.#grokLogin?.proc.kill();
    this.#grokLogin = undefined;
    const rt = this.agent('grok');
    await new Promise<void>((r) => {
      const p = spawn(rt.bin, ['logout'], { env: { PATH: process.env.PATH, HOME: rt.home, USERPROFILE: rt.home }, stdio: 'ignore', windowsHide: true });
      p.on('error', () => r());
      p.on('close', () => r());
    });
  }
}
