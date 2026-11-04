import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { deliveryFor } from '../src/delivery.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const cases = [
  { mode: 'queued', state: 'queued', effects: 0 },
  { mode: 'attempted', state: 'outcome_unknown', effects: 0 },
  { mode: 'effect-before-response', state: 'outcome_unknown', effects: 1 },
  { mode: 'before-ack', state: 'outcome_unknown', effects: 1 },
  { mode: 'ack-fault', state: 'outcome_unknown', effects: 1 },
  { mode: 'ack-saved', state: 'acknowledged', effects: 1 },
] as const;

test('Q3 real process-death matrix retains uncertainty without duplicate effects', { timeout: 60000 }, async () => {
  const { dir, cleanup } = tempDir();
  const effects = new Map<string, number>();
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume the synthetic request. */ }
    const mode = req.url!.slice(1);
    effects.set(mode, (effects.get(mode) ?? 0) + 1);
    if (mode === 'effect-before-response') {
      writeFileSync(join(dir, mode, 'barrier.json'), '{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message_id: 9001 }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  let passed = false;
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const c of cases) {
      const home = join(dir, c.mode);
      mkdirSync(home);
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'test/fixtures/q3-crash-child.ts'), home, c.mode, `${base}/${c.mode}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = once(child, 'exit');
      let logs = '';
      child.stdout.on('data', b => { logs = (logs + b.toString()).slice(-8000); });
      child.stderr.on('data', b => { logs = (logs + b.toString()).slice(-8000); });
      try {
        const until = Date.now() + 10000;
        while (!existsSync(join(home, 'barrier.json')) && child.exitCode === null && Date.now() < until) await delay(10);
        assert.ok(existsSync(join(home, 'barrier.json')), `${c.mode} reached its durable barrier: ${logs}`);
        child.kill('SIGKILL');
        await exited;
        const app = makeApp(home, { now: new Date('2026-11-04T12:00:05Z') });
        try {
          const delivery = deliveryFor(app);
          const rows = delivery.list();
          assert.equal(rows.length, 1, c.mode);
          assert.equal(rows[0].state, c.state, c.mode);
          assert.equal(effects.get(c.mode) ?? 0, c.effects, c.mode);
          if (c.state !== 'acknowledged') assert.equal(delivery.review(rows[0].id).text, 'Synthetic retained crash review');
          await delay(30);
          assert.equal(effects.get(c.mode) ?? 0, c.effects, 'reopening never dispatches');
        } finally { app.store.close(); }
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    }
    console.log('Q3 crash matrix: six barriers checked; all uncertain effects held; zero duplicate dispatches.');
    passed = true;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    if (passed) cleanup(); else console.error('Q3 failed fixture retained for diagnosis:', dir);
  }
});
