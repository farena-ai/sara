// U1.2 / U1.4 (docs/CHECKS.md): the small shared part of the live check scripts: a step list that
// records pass / fail / skip with a plain detail, a markdown report under outputs/checks/, and a
// guard that keeps every secret out of what is printed or written.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type StepResult = 'pass' | 'fail' | 'skip';
export interface Step {
  group: string;
  name: string;
  result: StepResult;
  detail: string;
  ms: number;
}

export class CheckRun {
  readonly steps: Step[] = [];
  readonly #secrets = new Set<string>();
  #group = '';
  readonly title: string;
  constructor(title: string) {
    this.title = title;
  }

  /** Never printed or written: replaced with "•••" wherever it appears. */
  secret(...values: (string | undefined)[]): void {
    for (const v of values) if (v && v.length >= 4) this.#secrets.add(v);
  }
  scrub(text: string): string {
    let out = text;
    for (const s of this.#secrets) out = out.split(s).join('•••');
    return out;
  }
  group(name: string): void {
    this.#group = name;
    console.log(`\n# ${name}`);
  }
  #add(name: string, result: StepResult, detail: string, ms: number): void {
    const d = this.scrub(detail.replace(/\s+/g, ' ').trim()).slice(0, 400);
    this.steps.push({ group: this.#group, name, result, detail: d, ms });
    console.log(`${result === 'pass' ? 'ok  ' : result === 'skip' ? 'skip' : 'FAIL'} ${name}${d ? ` - ${d}` : ''}`);
  }
  /** One step: passes when `fn` returns (its string is the detail), fails on a throw. Never throws. */
  async step(name: string, fn: () => Promise<string | void> | string | void): Promise<boolean> {
    const t0 = Date.now();
    try {
      const d = await fn();
      this.#add(name, 'pass', d ?? '', Date.now() - t0);
      return true;
    } catch (err) {
      this.#add(name, 'fail', (err as Error).message ?? String(err), Date.now() - t0);
      return false;
    }
  }
  skip(name: string, why: string): void {
    this.#add(name, 'skip', why, 0);
  }
  get failed(): number {
    return this.steps.filter((s) => s.result === 'fail').length;
  }
  /** Writes outputs/checks/<base>-<date>.md (repo-relative) and returns the path. */
  report(root: string, base: string, intro: string[] = []): string {
    const d0 = new Date();
    const date = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const dir = join(root, 'outputs', 'checks');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${base}-${date}.md`);
    const n = (r: StepResult) => this.steps.filter((s) => s.result === r).length;
    const lines = [`# ${this.title} (${date})`, '', ...intro, '', `**${n('pass')} passed, ${n('fail')} failed, ${n('skip')} skipped** (${this.steps.length} steps).`, ''];
    let g = '';
    for (const s of this.steps) {
      if (s.group !== g) {
        g = s.group;
        lines.push('', `## ${g}`, '', '| | Step | Detail | ms |', '|---|---|---|---|');
      }
      lines.push(`| ${s.result === 'pass' ? '✓' : s.result === 'skip' ? '–' : '✗'} | ${s.name} | ${s.detail.replace(/\|/g, '\\|')} | ${s.ms} |`);
    }
    writeFileSync(file, this.scrub(lines.join('\n')) + '\n');
    return file;
  }
}

/** Throws with a plain message unless `ok`. */
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

/** Polls `f` until it returns something truthy (or throws after `ms`). */
export async function until<T>(f: () => Promise<T | undefined | false | null> | T | undefined | false | null, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

/** Env for a throwaway in-process server: never the owner's data, logs, instance or key. */
export function throwawayEnv(): void {
  for (const k of ['SARA_DEMO', 'SARA_PRIVATE_LOCAL', 'SARA_MASTER_KEY', 'SARA_INSTANCE', 'SARA_LOG_FILE', 'SARA_DATA']) delete process.env[k];
  Object.assign(process.env, { SARA_SANDBOX: 'none', SARA_REPORT_TO: 'off', SARA_SETUP: 'off', SARA_TESTING: '1' });
}

/** .secrets/test-accounts.json (docs/CHECKS.md): the owner's real TEST accounts, all optional. */
export interface RealCfg {
  gmail?: { address: string; appPassword: string }[];
  outlook?: { address: string; password: string; imapHost?: string; smtpHost?: string };
  imap?: { address: string; password: string; imapHost: string; smtpHost: string; imapPort?: number; smtpPort?: number; preset?: string };
  caldav?: { url?: string };
  icalLink?: { url: string };
  google?: { clientId: string; clientSecret: string; refreshToken: string; address: string };
}
/** What the file lacks, in plain words (each a skipped step). */
export function missingParts(c: RealCfg): string[] {
  const out: string[] = [];
  if (!c.gmail?.[0]?.address || !c.gmail[0].appPassword) out.push('gmail[0] (a Gmail address + app password)');
  if (!c.gmail?.[1]?.address || !c.gmail[1].appPassword) out.push('gmail[1] (a second Gmail, for "two Gmails")');
  if (!c.outlook?.address || !c.outlook.password) out.push('outlook (an Outlook.com / IMAP address + app password)');
  if (!c.imap?.address || !c.imap.password || !c.imap.imapHost || !c.imap.smtpHost) out.push('imap (another IMAP mailbox: address, password, imapHost, smtpHost)');
  if (!c.imap?.address || !(c.caldav?.url || c.imap?.preset === 'icloud' || c.imap?.preset === 'fastmail')) out.push('caldav (a CalDAV address for the imap mailbox)');
  if (!c.icalLink?.url) out.push('icalLink (a calendar link, .ics or webcal://)');
  if (!c.google?.refreshToken) out.push('google (optional: a Google OAuth test account: clientId, clientSecret, refreshToken, address)');
  return out;
}
