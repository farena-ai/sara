import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openBusinessProfile } from '../../src/business/profile.ts';
import { createBusinessRuntime } from '../../src/business/runtime.ts';
import type { BusinessSession } from '../../src/business/identity.ts';

export async function contentFixture(hostname = '127.0.0.1') {
  const dir = mkdtempSync(join(tmpdir(), 'sara-b1-content-'));
  const profile = openBusinessProfile(dir);
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  const runtime = createBusinessRuntime({ profile, origin: `http://${hostname}:${port}` });
  await new Promise<void>(r => runtime.server.listen(port, '127.0.0.1', r));
  const admin = runtime.auth.claim('127.0.0.1', runtime.auth.claimCode, 'Alex', true)!;
  runtime.control.bootstrapAdministrator();
  const add = (name: string) => {
    const s = runtime.auth.createIdentity(name, true);
    const invite = runtime.control.createInvite(admin.principal, { scope: 'organization', role: 'user', subject: s.principal.identityId });
    runtime.control.redeemInvite(invite.code, { principal: s.principal }); return s;
  };
  const request = (path: string, session = admin, data?: unknown, headers: Record<string, string> = {}) => fetch(runtime.origin + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { origin: runtime.origin, cookie: `sara_business_session=${session.value}`, 'content-type': 'application/json', ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const grant = (w: string, s: BusinessSession, role: 'manager' | 'contributor' | 'viewer' = 'viewer') => runtime.control.setWorkspaceMember(admin.principal, w, s.principal.identityId, { role, status: 'active' });
  const context = (w: string, s = admin) => runtime.policy.authorizeWorkspace(s.principal, w, 'read');
  const seed = async (workspaceId: string, canary: string) => {
    assert.ok(runtime.workspaces, 'Business workspace content reader must exist');
    const scoped = runtime.workspaces.openWorkspace(context(workspaceId));
    await scoped.conversations();
    const ids = { conversation: randomUUID(), message: randomUUID(), document: randomUUID(), memory: randomUUID(), upload: randomUUID(), citation: randomUUID(), notification: randomUUID() };
    const db = new DatabaseSync(join(profile.businessDir, 'workspaces', workspaceId, 'content.db'));
    try {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO conversations(id,title,created_at) VALUES (?,?,?)').run(ids.conversation, canary, now);
      db.prepare('INSERT INTO messages(id,conversation_id,actor_id,role,body,created_at) VALUES (?,?,?,?,?,?)').run(ids.message, ids.conversation, admin.principal.identityId, 'user', canary, now);
      db.prepare('INSERT INTO documents(id,title,mime,body,created_at) VALUES (?,?,?,?,?)').run(ids.document, canary, 'text/markdown', canary, now);
      db.prepare('INSERT INTO memories(id,body,created_at) VALUES (?,?,?)').run(ids.memory, canary, now);
      db.prepare('INSERT INTO uploads(id,name,mime,body,created_at) VALUES (?,?,?,?,?)').run(ids.upload, canary, 'text/plain', canary, now);
      db.prepare('INSERT INTO citations(id,document_id,excerpt) VALUES (?,?,?)').run(ids.citation, ids.document, canary);
      db.prepare('INSERT INTO notifications(id,kind,resource_id,created_at) VALUES (?,?,?,?)').run(ids.notification, 'document.changed', ids.document, now);
    } finally { db.close(); }
    return ids;
  };
  return { dir, profile, runtime, admin, add, request, grant, context, seed, async close() { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}
