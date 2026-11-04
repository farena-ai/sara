import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp } from '../helpers.ts';
import { deliveryFor } from '../../src/delivery.ts';
import { JobManager } from '../../src/jobs.ts';
import { JobRecoveryStore } from '../../src/job-recovery.ts';
import { TeamManager } from '../../src/team.ts';
import { Goals } from '../../src/goals.ts';

export const FIXTURE_TOKEN = 'local-q3-fixture-not-a-real-secret';
export const RECOVERY_SPACES = ['', 'companions/fixture-companion', 'members/0123456789', 'members/0123456789/companions/fixture-member-companion'];
export function seedRecoveryData(root: string): { conversationId: string; jobId: number; teamId: number; deliveryId: string } {
  const now = '2026-11-04T12:00:00.000Z';
  let first!: ReturnType<typeof seedRecoveryData>;
  for (const [i, rel] of RECOVERY_SPACES.entries()) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ tokenHash: createHash('sha256').update(FIXTURE_TOKEN).digest('hex'), sessionSecret: randomBytes(32).toString('hex'), sessions: [] }));
    if (rel.includes('companions/')) writeFileSync(join(dir, 'companion.json'), JSON.stringify({ id: rel.split('/').at(-1), createdAt: now }));
    const app = makeApp(dir, { now: new Date(now) });
    try {
      app.settings.update({ ownerName: 'Alex', usePath: 'coding', persona: { innerLife: false, typing: 'instant' }, proactive: { enabled: false } });
      const conv = app.store.createConversation({ mode: 'coding', workspace: 'fixture', title: `Q3 recovery fixture ${i}` });
      app.jobs = new JobManager(app, app.store.db);
      const jobId = Number(app.store.db.prepare("INSERT INTO jobs(conversation_id,workspace,label,kind,status,started_at,tail) VALUES(?,?,?,'command','running',?,?)").run(conv.id, 'fixture', 'Fixture interrupted command', now, 'A checkpoint saved before interruption').lastInsertRowid);
      new JobRecoveryStore(app, app.store.db).save(jobId, { conversationId: conv.id, workspace: 'fixture', label: 'Fixture command', command: 'echo fixture', timeoutMs: 120000, recoveryIntent: { kind: 'command', command: 'echo Review this fixture before restarting' } });
      const ledger = deliveryFor(app);
      const descriptor = { bridge: 'telegram' as const, operation: 'sendMessage', destination: '777', review: { text: `Fixture delivery text ${i}` } };
      const attempted = ledger.enqueue(descriptor).id;
      ledger.attempt(attempted);
      ledger.enqueue({ ...descriptor, operation: 'sendDocument', review: { text: '', attachments: [{ name: 'fixture-report.txt', mime: 'text/plain', size: 24 }] } });
      const accepted = ledger.enqueue({ ...descriptor, bridge: 'discord' }).id;
      ledger.attempt(accepted); ledger.acknowledge(accepted, ['9001']);
      app.team = new TeamManager(app, app.store.db);
      const teamId = Number(app.store.db.prepare("INSERT INTO team_tasks(conversation_id,workspace,goal,status,limits,created_at) VALUES(?,?,'Review interrupted fixture work','running',?,?)").run(conv.id, 'fixture', JSON.stringify({ minutes: 10, tokens: 20000, steps: 4 }), now).lastInsertRowid);
      app.store.db.prepare("INSERT INTO team_steps(task_id,idx,helper,title,instructions,status,receipts) VALUES(?,0,'coder','Interrupted fixture step','Review existing effects','running',?)").run(teamId, JSON.stringify([{ name: 'fixture_effect', status: 'ok', args: {}, output: 'One prior effect, review before repeating' }]));
      const goals = new Goals(app, app.store.db);
      app.store.db.prepare("INSERT INTO chat_goals(conversation_id,text,checks,workspace,state,caps,round,created_at,started_at,updated_at) VALUES(?,'Fixture bounded goal','[]','fixture','running',?,1,?,?,?)").run(conv.id, JSON.stringify({ rounds: 3, minutes: 10, tokens: 10000, usd: 1 }), now, now, now);
      void goals;
      if (i === 0) first = { conversationId: conv.id, jobId, teamId, deliveryId: attempted };
    } finally { app.store.close(); }
  }
  writeFileSync(join(root, 'household.json'), JSON.stringify({ invites: [], members: [{ id: '0123456789', name: 'Sam fixture', status: 'active', createdAt: now, ownerConfirmed18At: now, memberConfirmed18At: now, limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } }] }));
  return first;
}
