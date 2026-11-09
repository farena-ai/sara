import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../../src/auth.ts';
import { createSaraServer } from '../../src/server.ts';
import { deliveryFor } from '../../src/delivery.ts';
import { LookBuilder } from '../../src/look.ts';
import { TeamManager } from '../../src/team.ts';
import { createCodingTools } from '../../src/tools/coding.ts';
import { JobManager } from '../../src/jobs.ts';
import { JobRecoveryStore } from '../../src/job-recovery.ts';
import { makeApp, ROOT, tempDir } from '../helpers.ts';

/** An isolated actual application; never accepts a data path or a remote origin. */
export async function startBrowserFixture() {
  const temp = tempDir();
  const clock = { now: new Date() };
  let app: ReturnType<typeof makeApp>;
  try { app = makeApp(temp.dir, clock); }
  catch (error) { temp.cleanup(); throw error; }
  let server: ReturnType<typeof createSaraServer> | undefined;
  let closed = false;
  const unexpectedOutbound: string[] = [];
  const realFetch = globalThis.fetch;
  async function close() {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(async () => {
        if (!server) return;
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      }),
      Promise.resolve().then(() => app.store.close()),
      Promise.resolve().then(() => { globalThis.fetch = realFetch; }),
    ]);
    // Temp cleanup follows store closure even when another teardown step failed.
    try { temp.cleanup(); } catch (error) { outcomes.push({ status: 'rejected', reason: error }); }
    const errors = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Browser fixture cleanup failed');
  }
  try {
  // Fresh setup normally probes local Ollama. Return a deterministic empty result without sockets.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (['127.0.0.1', 'host.docker.internal'].includes(url.hostname) && url.port === '11434' && url.pathname === '/api/tags') return Response.json({ models: [] });
    unexpectedOutbound.push('blocked-unexpected-fetch');
    throw new Error('Browser fixture permits no outbound provider or service requests');
  };
  app.settings.update({ usePath: 'coding', persona: { innerLife: false, typing: 'instant' }, proactive: { enabled: false }, providers: [] });
  const conv = app.store.createConversation({ mode: 'coding', workspace: 'fixture', title: 'Synthetic browser recovery' });
  app.look = new LookBuilder({ dataDir: temp.dir, key: async () => undefined });
  app.team = new TeamManager(app, app.store.db);
  app.jobs = new JobManager(app, app.store.db);
  for (const tool of createCodingTools(app)) app.tools.add(tool);
  const now = clock.now.toISOString();
  const jobId = Number(app.store.db.prepare("INSERT INTO jobs(conversation_id,workspace,label,kind,status,started_at,tail) VALUES(?,?,?,'command','interrupted',?,?)").run(conv.id, 'fixture', 'Synthetic interrupted command', now, 'Synthetic checkpoint').lastInsertRowid);
  new JobRecoveryStore(app, app.store.db).save(jobId, { conversationId: conv.id, workspace: 'fixture', label: 'Fixture command', command: 'echo fixture', timeoutMs: 120000, recoveryIntent: { kind: 'command', command: 'echo Synthetic reviewed draft' } });
  const deliveries = deliveryFor(app);
  const unknown = deliveries.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: 'synthetic', logicalKey: 'q4-browser-unknown', review: { text: 'Synthetic delivery review' } }).id;
  deliveries.attempt(unknown);
  // Construction after an interrupted attempt marks uncertainty without sending.
  deliveries.recoverInterrupted();
  const ack = deliveries.enqueue({ bridge: 'discord', operation: 'sendMessage', destination: 'synthetic', logicalKey: 'q4-browser-archive' }).id;
  deliveries.attempt(ack); deliveries.acknowledge(ack, ['9001']);
  app.store.db.prepare('UPDATE deliveries SET updated_at=? WHERE id=?').run('2025-01-01T00:00:00.000Z', ack);
  const auth = new OwnerAuth(temp.dir);
  const token = auth.newToken!;
  server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server!.once('error', failed);
    server!.listen(0, '127.0.0.1', () => {
      server!.off('error', failed);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, token, conversationId: conv.id, unknown, archiveId: ack, unexpectedOutbound,
    providerRequests: () => app.requests.length,
    close,
  };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser fixture startup and cleanup failed'); }
    throw error;
  }
}
