// Secrets never enter arguments, logs, server storage or model output. Secret Service is preferred.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { TestVault, cleanLoginName, type ConsentAnswer, type LoginView, type SavedLogin } from '../../src/hands-logins.ts';
import { DBus, variant, type Variant } from './dbus.ts';

export interface SecretStore { kind: string; get(key: string): string | undefined; set(key: string, value: string): void; flush(): Promise<void> }
export class PrivateStore implements SecretStore {
  kind = 'file-0600';
  #dir: string; #values: Record<string, string> = {};
  constructor(dir: string, warn: (s: string) => void) {
    this.#dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('Hands data folder must belong to this user and cannot be a symlink');
    chmodSync(dir, 0o700);
    warn('Secret Service unavailable: hands token and saved logins use an unencrypted user-only 0600 file. Anyone with your account or disk access can read it.');
    try {
      const fd = openSync(join(dir, 'secrets.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const f = fstatSync(fd);
        if (!f.isFile() || f.size > 2 * 1024 * 1024 || (process.getuid && (f.uid !== process.getuid() || (f.mode & 0o077) !== 0))) throw new Error('Insecure hands secrets file');
        this.#values = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, string>;
      } finally { closeSync(fd); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  get(key: string): string | undefined { return typeof this.#values[key] === 'string' ? this.#values[key] : undefined; }
  set(key: string, value: string): void {
    const next = { ...this.#values, [key]: value };
    const temp = join(this.#dir, `.secrets-${randomBytes(12).toString('hex')}`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next)}\n`); } finally { closeSync(fd); }
    try { renameSync(temp, join(this.#dir, 'secrets.json')); this.#values = next; } finally { rmSync(temp, { force: true }); }
  }
  async flush(): Promise<void> {}
}

const SERVICE = 'org.freedesktop.secrets';
const PATH = '/org/freedesktop/secrets';
export class KeyringStore implements SecretStore {
  kind = 'secret-service';
  #bus: DBus; #session = ''; #item = ''; #collection = ''; #scope: string;
  #values: Record<string, string> = {}; #queue: Promise<void> = Promise.resolve(); #failure?: Error;
  constructor(bus: DBus, scope: string) { this.#bus = bus; this.#scope = scope; }
  async open(): Promise<void> {
    const call = (member: string, signature: string, body: unknown[]) => this.#bus.call(SERVICE, PATH, 'org.freedesktop.Secret.Service', member, signature, body);
    const [, session] = await call('OpenSession', 'sv', ['plain', variant('s', '')]); this.#session = String(session);
    const [collection] = await call('ReadAlias', 's', ['default']); this.#collection = String(collection);
    if (this.#collection === '/') throw new Error('Create and unlock a default keyring first');
    const [unlocked, locked] = await call('SearchItems', 'a{ss}', [{ application: 'sara-hands', server: this.#scope }]);
    if ((locked as string[]).length) throw new Error('Unlock your keyring before starting Sara hands');
    this.#item = (unlocked as string[])[0] ?? '';
    if (this.#item) {
      const [secret] = await this.#bus.call(SERVICE, this.#item, 'org.freedesktop.Secret.Item', 'GetSecret', 'o', [this.#session]);
      this.#values = JSON.parse(Buffer.from((secret as [string, number[], number[], string])[2]).toString('utf8')) as Record<string, string>;
    }
  }
  get(key: string): string | undefined { return typeof this.#values[key] === 'string' ? this.#values[key] : undefined; }
  set(key: string, value: string): void {
    this.#values = { ...this.#values, [key]: value }; const payload = JSON.stringify(this.#values);
    this.#queue = this.#queue.then(async () => {
      if (this.#failure) throw this.#failure;
      const secret = [this.#session, [], [...Buffer.from(payload)], 'application/json'];
      if (this.#item) await this.#bus.call(SERVICE, this.#item, 'org.freedesktop.Secret.Item', 'SetSecret', '(oayays)', [secret]);
      else {
        const [item, prompt] = await this.#bus.call(SERVICE, this.#collection, 'org.freedesktop.Secret.Collection', 'CreateItem', 'a{sv}(oayays)b', [{ 'org.freedesktop.Secret.Item.Label': variant('s', 'Sara hands'), 'org.freedesktop.Secret.Item.Attributes': variant('a{ss}', { application: 'sara-hands', server: this.#scope }) }, secret, true]);
        if (prompt !== '/' || item === '/') throw new Error('Unlock your keyring and restart Sara hands');
        this.#item = String(item);
      }
    }).catch((err: Error) => { this.#failure = err; });
  }
  async flush(): Promise<void> { await this.#queue; if (this.#failure) throw this.#failure; }
}

export class LinuxVault extends TestVault {
  #store: SecretStore;
  #entries: SavedLogin[];
  constructor(store: SecretStore) {
    const entries = JSON.parse(store.get('logins') ?? '[]') as SavedLogin[]; super(entries);
    this.#store = store; this.#entries = entries;
  }
  #persist(): void { this.#store.set('logins', JSON.stringify(this.#entries)); }
  override save(server: string, site: string, answer: ConsentAnswer, now = new Date()): LoginView {
    const view = super.save(server, site, answer, now);
    const entry = this.find(server, view.name)!;
    this.#entries = this.#entries.filter((x) => !(x.server === server && x.name.toLowerCase() === entry.name.toLowerCase()));
    this.#entries.push(entry); this.#persist(); return view;
  }
  override touch(server: string, name: string, now = new Date()): void {
    super.touch(server, name, now);
    const entry = this.find(server, name);
    if (entry) this.#entries = this.#entries.map((x) => x.server === server && x.name.toLowerCase() === entry.name.toLowerCase() ? entry : x);
    this.#persist();
  }
  override remove(server: string, name: string | { all: true }): number {
    const n = super.remove(server, name);
    this.#entries = this.#entries.filter((x) => x.server !== server || (typeof name === 'string' && x.name.toLowerCase() !== cleanLoginName(name).toLowerCase()));
    this.#persist(); return n;
  }
}
