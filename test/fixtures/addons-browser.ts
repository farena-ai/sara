import { join, resolve, relative, isAbsolute } from 'node:path';
import { cpSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../../src/auth.ts';
import { createSaraServer } from '../../src/server.ts';
import { PluginManager } from '../../src/plugins/manager.ts';
import { LookBuilder } from '../../src/look.ts';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fromFolder, hashFiles } from '../../src/packages.ts';
import { parseManifest, permissionIds } from '../../src/plugins/manifest.ts';
import { StoreClient } from '../../src/store/client.ts';
import { StoreInstalls } from '../../src/store/installs.ts';
import { sha256 } from '../../src/store/verify.ts';
import { zipStored } from '../../src/zip-write.ts';
import { makeApp, ROOT, tempDir } from '../helpers.ts';
import { NATIVE_CANDIDATE_IDS } from '../../src/addons/discovery.ts';

/** Actual owner app + default packaged candidate roots, isolated from installed owner data. */
export async function startAddonsBrowserFixture(options: { runtimeCopy?: boolean } = {}) {
  const temp = tempDir();
  let Manager = PluginManager;
  let copiedCandidateRoot: string | undefined;
  if (options.runtimeCopy) {
    const runtime = join(temp.dir, 'runtime-copy');
    mkdirSync(runtime, { recursive: true });
    cpSync(join(ROOT, 'src'), join(runtime, 'src'), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(runtime, 'package.json'));
    for (const id of ['email', 'signal', 'whatsapp', 'matrix', 'imessage']) cpSync(join(ROOT, 'plugins', id), join(runtime, 'plugins', id), { recursive: true });
    for (const id of NATIVE_CANDIDATE_IDS) cpSync(join(ROOT, 'store', 'plugins', id), join(runtime, 'store', 'plugins', id), { recursive: true });
    const copied = await import(pathToFileURL(join(runtime, 'src', 'plugins', 'manager.ts')).href);
    if (copied.CANDIDATE_DIR !== join(runtime, 'store', 'plugins') || copied.BUILTIN_DIR !== join(runtime, 'plugins')) throw new Error('Runtime-copy manager did not resolve default payload roots');
    Manager = copied.PluginManager;
    copiedCandidateRoot = copied.CANDIDATE_DIR;
  }
  const app = makeApp(temp.dir, { now: new Date() });
  app.settings.update({ usePath: 'coding', persona: { innerLife: false, typing: 'instant' }, proactive: { enabled: false }, providers: [] });
  app.companionId = 'main';
  app.look = new LookBuilder({ dataDir: temp.dir, key: async () => undefined });
  app.providerFactory = () => { throw new Error('No model use in add-ons browser qualification'); };
  const pm = new Manager({ db: app.store.db, dataDir: temp.dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: text => text, fence: 'node-only' });
  app.pluginManager = pm; pm.attach('main', app);
  // Ephemeral TEST signing key and actual StoreClient verification, never the public store.
  const keys = generateKeyPairSync('ed25519');
  const now = new Date();
  const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const author = { name: 'Synthetic fixture author', key: `ed25519:${'9b'.repeat(32)}`, since: '2026-11-05' };
  const payloads = new Map<string, Buffer>();
  const shelfItems = [];
  for (const id of ['daily-briefing', 'focus']) {
    const files = fromFolder(join(ROOT, 'store/plugins', id));
    const manifest = parseManifest(JSON.parse(files.find(file => file.path === 'sara-plugin.json')!.data.toString('utf8')), { saraVersion: '2.68.0' });
    const zip = zipStored(files);
    const entry = { format: 'sara-store-entry', v: 1, id, kind: 'plugin', version: manifest.version, name: manifest.name, description: manifest.description, about: [], author, license: 'MIT', shots: [], changes: [], checks: { ran: iso(now), by: 'sara-store-check 2.68.0', results: [{ id: 'manifest', ok: true }] }, tested: [], needs: [], works: ['windows', 'macos', 'linux'], manifest };
    const bytes = Buffer.from(JSON.stringify(entry));
    const version = { version: manifest.version, sara: '>=2.65.0', published: '2026-11-05', entry: `entries/${id}/${manifest.version}.json`, entrySha: sha256(bytes), package: `packages/${id}-${manifest.version}.zip`, sha256: sha256(zip), size: zip.length, contentSha: hashFiles(files), permissions: permissionIds(manifest) };
    payloads.set(`/v1/${version.entry}`, bytes); payloads.set(`/v1/${version.package}`, zip);
    shelfItems.push({ id, kind: 'plugin', name: manifest.name, summary: manifest.description, trust: 'first-party', category: 'everyday', tags: ['synthetic'], author, latest: manifest.version, versions: [version] });
  }
  const index = Buffer.from(JSON.stringify({ format: 'sara-store-index', v: 1, seq: 1, generated: iso(now), expires: iso(new Date(now.getTime() + 86400_000)), key: 'store-2026a', minSara: '2.65.0', items: shelfItems, blocked: [], reservedIds: ['sara'] }));
  payloads.set('/v1/index.json', index);
  payloads.set('/v1/index.sig', Buffer.from(JSON.stringify({ v: 1, key: 'store-2026a', sig: sign(null, index, keys.privateKey).toString('base64') })));
  const client = new StoreClient({ dataDir: temp.dir, base: 'http://127.0.0.1:1/store', blocked: () => undefined, keys: { 'store-2026a': Buffer.from((keys.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64') }, held: async () => [], send: async url => {
    const bytes = payloads.get(new URL(url).pathname.replace(/^\/store/, ''));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  } });
  const installs = new StoreInstalls(app.store.db);
  app.storeClient = client; app.storeInstalls = installs;
  pm.storeMatch = contentSha => client.match(contentSha);
  const auth = new OwnerAuth(temp.dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), updaterFetch: async () => Response.json({ tag_name: 'v2.68.0', html_url: 'https://github.com/farena-ai/sara/releases/tag/v2.68.0' }) });
  const fetchBefore = globalThis.fetch;
  const unexpectedOutbound: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (['127.0.0.1', 'host.docker.internal'].includes(url.hostname) && url.port === '11434' && url.pathname === '/api/tags') return Response.json({ models: [] });
    if (url.hostname === '127.0.0.1' && server.listening && url.port === String((server.address() as AddressInfo).port)) return fetchBefore(input, init);
    unexpectedOutbound.push(`blocked-outbound-service:${url.protocol}//${url.hostname}${url.pathname}`);
    throw new Error('Synthetic fixture permits no external services');
  };
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    globalThis.fetch = fetchBefore;
    await pm.stopAll();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    app.store.close(); temp.cleanup();
  }
  try {
    await client.check();
    if (client.current()?.index.items.length !== 2) throw new Error('Synthetic signed StoreClient shelf did not verify');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: auth.newToken!, pm, app, installs, unexpectedOutbound, close,
      damageCopiedPayloads() {
        if (!copiedCandidateRoot) throw new Error('Payload damage is limited to the explicit synthetic runtime-copy fixture');
        const manifest = join(copiedCandidateRoot, 'meeting-assistant', 'sara-plugin.json');
        const entrypoint = join(copiedCandidateRoot, 'document-desk', 'main.mjs');
        for (const target of [manifest, entrypoint]) {
          const within = relative(resolve(temp.dir), resolve(target));
          if (within.startsWith('..') || isAbsolute(within)) throw new Error('Synthetic payload target escaped its fixture');
        }
        unlinkSync(manifest);
        appendFileSync(entrypoint, '\n// Synthetic tamper fixture.\n');
      },
    };
  } catch (error) { await close(); throw error; }
}
