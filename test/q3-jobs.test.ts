import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobManager } from '../src/jobs.ts';
import { makeApp, tempDir } from './helpers.ts';
test('Q3 jobs refuse direct replay even for old clients', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const jobs = new JobManager(app, app.store.db);
  try {
    assert.throws(() => jobs.continueWithMore(1), /review/i);
    assert.equal(jobs.canContinue(1), false);
    assert.equal(typeof jobs.prepareRecovery, 'function');
  } finally {
    app.store.close();
    cleanup();
  }
});

import { TeamManager, createTeamTools } from '../src/team.ts';
test('Q3 team has explicit acknowledged recovery entry', () =>
  assert.equal(typeof TeamManager.prototype.resume, 'function'));
import { JobRecoveryStore } from '../src/job-recovery.ts';
function fixture() {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const conv = app.store.createConversation({
    mode: 'coding',
    workspace: 'q3',
  });
  const jobs = new JobManager(app, app.store.db);
  app.jobs = jobs;
  for (const tool of createTeamTools(() => app)) app.tools.add(tool);
  app.tools.add({
    spec: {
      name: 'start_job',
      description: 'fixture',
      parameters: { type: 'object', properties: {} },
    },
    defaultPermission: 'ask',
    summarize: () => 'fixture',
    run: async () => {
      throw Error('must never execute');
    },
  });
  app.tools.add({
    spec: {
      name: 'delegate_task',
      description: 'fixture',
      parameters: { type: 'object', properties: {} },
    },
    defaultPermission: 'ask',
    summarize: () => 'fixture',
    run: async () => {
      throw Error('must never execute');
    },
  });
  const insert = (
    intent: Parameters<JobRecoveryStore['save']>[1]['recoveryIntent'],
  ) => {
    const id = Number(
      app.store.db
        .prepare(
          "INSERT INTO jobs(conversation_id,workspace,label,kind,status,started_at,tail) VALUES(?,?,'redacted label','command','running',?,'safe progress')",
        )
        .run(conv.id, conv.workspace, app.now().toISOString()).lastInsertRowid,
    );
    new JobRecoveryStore(app, app.store.db).save(id, {
      conversationId: conv.id,
      workspace: 'q3',
      label: 'fixture',
      command: 'not persisted generated shell',
      timeoutMs: 120000,
      recoveryIntent: intent,
      budget: { tokens: 40000 },
    });
    return id;
  };
  return {
    app,
    jobs,
    conv,
    insert,
    dir,
    cleanup: () => {
      app.store.close();
      cleanup();
    },
  };
}
test('Q3 durable restart review survives fresh objects without execution and hides encrypted intent', () => {
  const f = fixture();
  try {
    const id = f.insert({
      kind: 'command',
      command: 'echo unique-original-request-93852',
    });
    const fresh = new JobManager(f.app, f.app.store.db);
    assert.equal(fresh.get(id)?.status, 'interrupted');
    assert.equal(fresh.running().length, 0);
    assert.equal(fresh.get(id)?.tail, 'safe progress');
    assert.equal(fresh.get(id)?.recovery?.mode, 'restart-review');
    assert.equal(
      JSON.stringify(fresh.list()).includes('unique-original-request'),
      false,
    );
    const raw = f.app.store.db
      .prepare('SELECT payload FROM job_recovery WHERE job_id=?')
      .get(id) as { payload: string };
    assert.equal(raw.payload.includes('unique-original-request'), false);
    const review = fresh.prepareRecovery(id, { tokens: Infinity, usd: 1e9 });
    assert.equal(review.conversationId, f.conv.id);
    assert.match(review.draft, /unique-original-request/);
    assert.doesNotMatch(review.draft, /budget_tokens/);
    assert.doesNotMatch(review.draft, /budget_usd/);
    assert.equal(f.app.providerCalls, 0);
    assert.equal(fresh.running().length, 0);
  } finally {
    f.cleanup();
  }
});
test('Q3 review refuses changed policy/workspace/deleted conversation and corrupt checkpoints independently', () => {
  const f = fixture();
  try {
    const id = f.insert({
      kind: 'agent',
      agent: 'claude',
      task: 'implement synthetic fixture',
    });
    const fresh = new JobManager(f.app, f.app.store.db);
    f.app.settings.update({ toolPermissions: { delegate_task: 'never' } });
    assert.throws(() => fresh.prepareRecovery(id), /disabled/);
    f.app.settings.update({ toolPermissions: { delegate_task: 'ask' } });
    f.app.store.updateConversation(f.conv.id, { workspace: 'changed' });
    assert.throws(() => fresh.prepareRecovery(id), /workspace/);
    f.app.store.updateConversation(f.conv.id, { workspace: 'q3' });
    assert.match(
      fresh.prepareRecovery(id).draft,
      /implement synthetic fixture/,
    );
    f.app.store.db
      .prepare("UPDATE job_recovery SET payload='invalid' WHERE job_id=?")
      .run(id);
    assert.equal(fresh.get(id)?.recovery?.mode, 'unsupported');
    assert.throws(() => fresh.prepareRecovery(id), /protected/);
    const other = f.insert({ kind: 'command', command: 'echo good' });
    new JobManager(f.app, f.app.store.db);
    f.app.store.deleteConversation(f.conv.id);
    assert.throws(() => fresh.prepareRecovery(other), /conversation/);
  } finally {
    f.cleanup();
  }
});
test('Q3 redacted secret requests and generic runtime work never become executable drafts', () => {
  const f = fixture();
  try {
    f.app.vault.set('fixture-secret', 'synthetic-secret-93208912358');
    const id = f.insert({
      kind: 'command',
      command: 'echo synthetic-secret-93208912358',
    });
    const runtime = f.insert(undefined);
    const fresh = new JobManager(f.app, f.app.store.db);
    assert.equal(fresh.get(id)?.recovery?.mode, 'unsupported');
    assert.equal(fresh.get(runtime)?.recovery?.mode, 'unsupported');
    assert.throws(() => fresh.prepareRecovery(id), /protected/);
  } finally {
    f.cleanup();
  }
});
import { recoveryScope } from '../src/recovery-scope.ts';

test('Q3 unknown checkpoint versions and replaced encryption keys fail closed per row', () => {
  const f = fixture();
  try {
    const id = f.insert({ kind: 'command', command: 'echo version fixture' });
    const context = `${recoveryScope(f.app.store.db)}:job:${id}:v1`;
    f.app.store.db
      .prepare('UPDATE job_recovery SET payload=? WHERE job_id=?')
      .run(
        f.app.vault.seal(
          JSON.stringify({
            version: 99,
            intent: { kind: 'command', command: 'echo bad' },
            timeoutMs: 120000,
            budget: {},
          }),
          context,
        ),
        id,
      );
    const fresh = new JobManager(f.app, f.app.store.db);
    assert.equal(fresh.get(id)?.recovery?.mode, 'unsupported');
    assert.throws(() => fresh.prepareRecovery(id), /protected/);
    const good = f.insert({
      kind: 'command',
      command: 'echo good unaffected row',
    });
    new JobManager(f.app, f.app.store.db);
    assert.equal(fresh.get(good)?.recovery?.mode, 'restart-review');
    const original = f.app.vault.unseal;
    f.app.vault.unseal = () => {
      throw new Error('wrong key fixture');
    };
    assert.equal(fresh.get(good)?.recovery?.mode, 'unsupported');
    assert.throws(() => fresh.prepareRecovery(good), /protected/);
    f.app.vault.unseal = original;
  } finally {
    f.cleanup();
  }
});

test('Q3 explicit team review preserves completed/inflight receipts and resets stale workflow grants', async () => {
  const f = fixture();
  try {
    new TeamManager(f.app, f.app.store.db);
    const db = f.app.store.db;
    const id = Number(
      db
        .prepare(
          "INSERT INTO team_tasks(conversation_id,workspace,goal,status,limits,created_at,workflow) VALUES(?,?,'Synthetic recovery plan','running',?,?,?)",
        )
        .run(
          f.conv.id,
          f.conv.workspace,
          JSON.stringify({ minutes: 5, tokens: 50000, steps: 10 }),
          f.app.now().toISOString(),
          JSON.stringify({
            pr: false,
            checkpoints: false,
            passed: ['plan', 'pr'],
          }),
        ).lastInsertRowid,
    );
    for (const [idx, status] of [
      [0, 'done'],
      [1, 'running'],
    ] as const)
      db.prepare(
        "INSERT INTO team_steps(task_id,idx,helper,title,instructions,status,receipts) VALUES(?,?,'writer','Synthetic step','fixture',?,?)",
      ).run(
        id,
        idx,
        status,
        JSON.stringify([
          {
            name: 'write_file',
            args: { path: 'fixture.txt' },
            status: 'ok',
            output: `old-receipt-${idx}`,
          },
        ]),
      );
    const team = new TeamManager(f.app, db);
    f.app.team = team;
    assert.equal(team.get(id)?.status, 'interrupted');
    assert.equal(team.get(id)?.steps[1].status, 'running');
    assert.deepEqual(team.resumeInterrupted(), []);
    assert.throws(() => team.resume(id, false), /Acknowledge/);
    f.app.settings.update({ toolPermissions: { team_task: 'never' } });
    assert.throws(() => team.resume(id, true), /disabled/);
    f.app.settings.update({ toolPermissions: { team_task: 'ask' } });
    team.resume(id, true);
    assert.throws(() => team.resume(id, true), /interrupted/);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const resumed = team.get(id)!;
    assert.equal(resumed.status, 'waiting');
    assert.deepEqual(resumed.workflow?.passed, []);
    assert.equal(resumed.workflow?.checkpoints, true);
    assert.equal(resumed.steps[0].status, 'done');
    assert.equal(resumed.steps[0].receipts[0].output, 'old-receipt-0');
    assert.equal(resumed.steps[1].receipts[0].output, 'old-receipt-1');
    assert.equal(f.app.providerCalls, 0);
    team.stop(id);
    await team.finished(id);
  } finally {
    f.cleanup();
  }
});
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '../src/tools/workspace.ts';

test('Q3 command review only promises its supported timeout bound', () => {
  const f = fixture();
  try {
    const id = f.insert({ kind: 'command', command: 'echo bounded command' });
    const fresh = new JobManager(f.app, f.app.store.db);
    const review = fresh.prepareRecovery(id, { tokens: 100000, usd: 10 });
    assert.doesNotMatch(review.draft, /budget_tokens|budget_usd/);
    assert.match(review.warning, /no token or dollar cap/i);
    assert.match(review.draft, /timeout_minutes/);
  } finally {
    f.cleanup();
  }
});

test('Q3 split secret output cannot enter durable live tails', async () => {
  const f = fixture();
  let started: ReturnType<JobManager['start']> | undefined;
  try {
    const secret = 'synthetic-split-secret-925368794';
    const eventTails: string[] = [];
    f.app.events!.subscribe((event) => {
      if (event.type === 'job') eventTails.push(event.job.tail);
    });
    f.app.vault.set('split-fixture', secret);
    const ws = workspaceDir(f.dir, f.conv.workspace);
    writeFileSync(
      join(ws, 'split.cjs'),
      `process.stdout.write('synthetic-split-'); setTimeout(()=>process.stdout.write('secret-925368794\\nSECOND_OUTPUT_READY\\n'),650); setTimeout(()=>{},5000);`,
    );
    const run = (started = f.jobs.start({
      conversationId: f.conv.id,
      workspace: f.conv.workspace,
      label: 'split output fixture',
      command: `${JSON.stringify(process.execPath)} split.cjs`,
      timeoutMs: 10000,
    }));
    const deadline = Date.now() + 12000;
    while (true) {
      const progress = f.app.store.db
        .prepare('SELECT tail FROM jobs WHERE id=?')
        .get(run.job.id) as { tail: string };
      if (progress.tail.includes('SECOND_OUTPUT_READY')) break;
      assert.ok(
        Date.now() < deadline,
        'second output must reach the persisted checkpoint before the deadline',
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stored = f.app.store.db
      .prepare('SELECT tail FROM jobs WHERE id=?')
      .get(run.job.id) as { tail: string };
    assert.equal(stored.tail.includes(secret), false);
    assert.equal(
      eventTails.some((tail) => tail.includes(secret)),
      false,
    );
    assert.ok(stored.tail.includes('[REDACTED]'));
    assert.equal(f.jobs.get(run.job.id)!.tail.includes(secret), false);
  } finally {
    if (started) {
      f.jobs.stop(started.job.id);
      await started.done;
    }
    f.cleanup();
  }
});
function interruptedWorkflow(f: ReturnType<typeof fixture>) {
  new TeamManager(f.app, f.app.store.db);
  const db = f.app.store.db;
  const id = Number(
    db
      .prepare(
        "INSERT INTO team_tasks(conversation_id,workspace,goal,status,limits,created_at,workflow) VALUES(?,?,'Synthetic private recovery','interrupted',?,?,?)",
      )
      .run(
        f.conv.id,
        f.conv.workspace,
        JSON.stringify({ minutes: 5, tokens: 50000, steps: 10 }),
        f.app.now().toISOString(),
        JSON.stringify({
          pr: true,
          checkpoints: false,
          passed: ['plan', 'pr'],
        }),
      ).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO team_steps(task_id,idx,helper,title,instructions,status,receipts) VALUES(?,0,'writer','Completed local work','fixture','done','[]')",
  ).run(id);
  const team = new TeamManager(f.app, db);
  f.app.team = team;
  return { team, id };
}

test('Q3 team recovery requires an existing enabled tool including default never policy', () => {
  const f = fixture();
  try {
    const { team, id } = interruptedWorkflow(f);
    f.app.tools.remove('team_task');
    assert.throws(() => team.resume(id, true), /disabled/);
    f.app.tools.add({
      spec: {
        name: 'team_task',
        description: 'fixture',
        parameters: { type: 'object', properties: {} },
      },
      summarize: () => 'fixture',
      defaultPermission: 'never',
      run: async () => '',
    });
    assert.throws(() => team.resume(id, true), /disabled/);
    assert.equal(team.get(id)?.status, 'interrupted');
  } finally {
    f.cleanup();
  }
});

test('Q3 private PR recovery is held and privacy changes after resume prevent publication', async () => {
  const f = fixture();
  try {
    const { team, id } = interruptedWorkflow(f);
    let effects = 0;
    for (const name of ['git_commit', 'git_push', 'github_open_pr'])
      f.app.tools.add({
        spec: {
          name,
          description: 'fixture',
          parameters: { type: 'object', properties: {} },
        },
        summarize: () => 'fixture',
        defaultPermission: 'auto',
        run: async () => {
          effects++;
          return 'fixture';
        },
      });
    f.app.store.updateConversation(f.conv.id, { private: true });
    assert.throws(() => team.resume(id, true), /private/);
    f.app.store.updateConversation(f.conv.id, { private: false });
    team.resume(id, true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(team.get(id)?.checkpoint?.kind, 'plan');
    team.answer(id, 'go');
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(team.get(id)?.checkpoint?.kind, 'pr');
    f.app.store.updateConversation(f.conv.id, { private: true });
    team.answer(id, 'go');
    const finished = await team.finished(id);
    assert.equal(effects, 0);
    assert.notEqual(finished.status, 'done');
    assert.match(JSON.stringify(finished.steps), /privacy/);
  } finally {
    f.cleanup();
  }
});
