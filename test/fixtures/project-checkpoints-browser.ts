import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../../src/auth.ts';
import { createSaraServer } from '../../src/server.ts';
import { ProjectKnowledgeStore } from '../../src/projectknow.ts';
import { LookBuilder } from '../../src/look.ts';
import { makeApp, ROOT, tempDir } from '../helpers.ts';

/** Fixed invented data on loopback; accepts neither an installed-data path nor a remote target. */
export async function startProjectCheckpointBrowserFixture({ preserveData = false } = {}) {
  const temp = tempDir();
  const app = makeApp(temp.dir, { now: new Date('2026-11-05T12:00:00.000Z') });
  let server: ReturnType<typeof createSaraServer> | undefined;
  let closed = false;
  let keepData = preserveData;
  const originalFetch = globalThis.fetch;
  const unexpectedOutbound: string[] = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    if (server) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    try { app.store.close(); }
    finally { globalThis.fetch = originalFetch; if (!keepData) temp.cleanup(); }
  };
  try {
    globalThis.fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (['127.0.0.1', 'host.docker.internal'].includes(url.hostname) && url.port === '11434' && url.pathname === '/api/tags') return Response.json({ models: [] });
      unexpectedOutbound.push(`blocked-${url.origin}${url.pathname}`);
      throw Error('Synthetic checkpoint fixture permits no outbound calls');
    };
    app.settings.update({ usePath: 'coding', persona: { innerLife: false, typing: 'instant' }, proactive: { enabled: false }, providers: [] });
    for (const workspace of ['main', 'other']) {
      const project = join(temp.dir, 'workspaces', workspace);
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: `checkpoint-fixture-${workspace}`, type: 'module' }));
      app.store.createConversation({ mode: 'coding', workspace, title: `Synthetic checkpoint journey ${workspace}` });
    }
    app.look = new LookBuilder({ dataDir: temp.dir, key: async () => undefined });
    app.projects = new ProjectKnowledgeStore(app, app.store.db);
    app.projects.get('main');
    app.projects.get('other');
    const auth = new OwnerAuth(temp.dir);
    server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: auth.newToken!, dataDir: temp.dir, preserve: () => { keepData = true; }, close, unexpectedOutbound, providerRequests: () => app.requests.length };
  } catch (error) { await close(); throw error; }
}
