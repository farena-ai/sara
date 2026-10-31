// Real Linux browser hands. No fixture desktop/system/vault is instantiated here.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserInfo } from '../../src/browser.ts';
import { blockedKind } from '../../src/hands-desktop.ts';
import { HandsRef, OpError, type HandsRefOptions } from '../../src/hands-ref.ts';
import { LinuxSystem } from './checkup.ts';
import { LinuxVault, type SecretStore } from './secrets.ts';

export class DeviceGate {
  #stopped = false; #paused = false;
  check(): void { if (this.#stopped || this.#paused) throw new OpError(this.#stopped ? 'stopped' : 'takeover', this.#stopped ? 'stopped: restart sara hands to reconnect' : 'takeover: resume locally first'); }
  pause(): void { this.#paused = true; }
  resume(): void { this.#paused = false; }
  stop(): void { this.#stopped = true; }
}
export function normalizeServer(raw: string): string {
  const u = new URL(raw);
  if (u.username || u.password) throw new Error('Server addresses cannot contain credentials');
  if (u.pathname !== '/' || u.search || u.hash) throw new Error('Use the server origin without a path, query or fragment');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw new Error('Use HTTPS for a remote hands server; HTTP is allowed only on loopback');
  return u.origin;
}
export function linuxBrowser(env: NodeJS.ProcessEnv = process.env): BrowserInfo {
  const paths = [env.SARA_HANDS_BROWSER, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].filter((p): p is string => Boolean(p));
  const path = paths.find((p) => existsSync(p) && !/headless/i.test(p));
  return { found: Boolean(path), ...(path ? { path, kind: /chromium/.test(path) ? 'chromium' : 'chrome', name: /chromium/.test(path) ? 'Chromium' : 'Google Chrome' } : {}), how: 'Install Chrome or Chromium on this Linux desktop, then run sara hands again.' };
}
export class LinuxHands extends HandsRef {
  readonly gate = new DeviceGate();
  #store: SecretStore;
  constructor(opts: { server: string; token: string; dir: string; store: SecretStore; checks?: boolean; info?: BrowserInfo; name?: string; consent?: HandsRefOptions['consent']; managers?: HandsRefOptions['managers']; localOnly?: boolean; onToken?: HandsRefOptions['onToken']; log?: (s: string) => void; testBrowser?: { headless: true; args?: string[] } }) {
    const profile = join(opts.dir, 'browser');
    for (const dir of [opts.dir, profile, join(profile, 'Default'), join(opts.dir, 'Downloads', 'Sara')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 }); const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error('Hands folders must be private directories owned by this user');
      chmodSync(dir, 0o700);
    }
    const prefsFile = join(profile, 'Default', 'Preferences');
    let prefs: Record<string, any> = {};
    if (existsSync(prefsFile)) { if (!lstatSync(prefsFile).isFile() || lstatSync(prefsFile).isSymbolicLink()) throw new Error('Invalid browser preferences file'); prefs = JSON.parse(readFileSync(prefsFile, 'utf8')); }
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    prefs.autofill = { ...prefs.autofill, profile_enabled: false, credit_card_enabled: false };
    writeFileSync(prefsFile, `${JSON.stringify(prefs)}\n`, { mode: 0o600 });
    super({ server: normalizeServer(opts.server), token: opts.token, name: opts.name ?? 'Linux computer', info: opts.info ?? linuxBrowser(), headless: opts.testBrowser?.headless ?? false,
      profileDir: profile, folder: join(opts.dir, 'Downloads', 'Sara'), realProfile: true, serializeBrowser: true,
      ...(opts.testBrowser?.args ? { browserArgs: opts.testBrowser.args } : {}), vault: new LinuxVault(opts.store),
      optIn: { browser: true, desktop: opts.checks === true }, ...(opts.checks ? { checkSystem: new LinuxSystem() } : {}),
      logFile: join(opts.dir, 'hands-log.jsonl'), consent: opts.consent, managers: opts.managers, localOnly: opts.localOnly,
      onToken: opts.onToken, log: opts.log, flushSecrets: () => opts.store.flush(),
    });
    this.#store = opts.store;
    this.browser.beforeCommand = () => this.gate.check();
    this.browser.onOwnerInput = () => this.userInput();
    this.browser.addressCheck = (url) => { try { const u = new URL(url); return !blockedKind(u.hostname + u.pathname, ''); } catch { return false; } };
    const shot = this.browser.shot.bind(this.browser);
    this.browser.shot = async (tab, w, q) => {
      const doc = await this.browser.cdp!.send('DOM.getDocument', { depth: -1, pierce: true }, tab.sessionId);
      let count = 0;
      const safe = (node: Record<string, unknown>): boolean => {
        if (++count > 20000 || (Array.isArray(node.shadowRoots) && node.shadowRoots.some((r: Record<string, unknown>) => r.shadowRootType !== 'user-agent'))) return false;
        return !Array.isArray(node.children) || node.children.every((n) => safe(n as Record<string, unknown>));
      };
      if (!safe(doc.root as Record<string, unknown>)) throw new OpError('perm_missing', 'No picture: this page has a shadow tree or is too large to mask safely. Use the text view.');
      type Plan = { complete: boolean; width: number; height: number; url: string; boxes: { x: number; y: number; w: number; h: number }[] };
      const before = await this.browser.agent<Plan>(tab, 'privacy', {});
      const image = await shot(tab, w, q);
      const after = await this.browser.agent<Plan>(tab, 'privacy', {});
      if (!before.complete || !after.complete || before.width !== after.width || before.height !== after.height || before.url !== after.url) throw new OpError('stale_view', 'No picture: the page changed while masking. Look again.');
      const masked = await this.browser.agent<{ data: string }>(tab, 'redactPicture', { data: image.data.toString('base64'), w: image.w, h: image.h, quality: q, scale: image.w / before.width, boxes: [...before.boxes, ...after.boxes] });
      if (!masked?.data) throw new OpError('perm_missing', 'The picture could not be masked locally.');
      return { ...image, data: Buffer.from(masked.data, 'base64') };
    };
  }
  override hello(): Record<string, unknown> {
    return { ...super.hello(), app: 'linux-hands 1', os: `linux ${process.arch}`, perms: { capture: false, input: false, ax: false }, approvalsHere: false, vault: { kind: this.#store.kind, verify: false } };
  }
  override tellLogins(): void {
    if (this.ws?.open) this.ws.send(JSON.stringify({ t: 'ev', kind: 'logins', logins: this.vault.list(this.serverOrigin), vault: { kind: this.#store.kind, verify: false } }));
  }
  override userInput(): void { if (this.yourTurn) return; this.gate.pause(); super.userInput(); }
  override resume(): void { this.gate.resume(); super.resume(); }
  override pressStop(): void { this.gate.stop(); super.pressStop(); this.ws?.close(1000, 'local Stop'); void this.stop(); }
}
