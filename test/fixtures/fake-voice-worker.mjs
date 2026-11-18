// U5 voice fast: a fake sara-voice-worker (same line protocol as deploy/voice/sara-voice-worker.c).
// FAKE_WORKER_LOG: append "start <mode> <pid>" per start. FAKE_WORKER_READY_MS: load delay.
// FAKE_WORKER_FAIL=1: print "fail" instead of "ready". Text "crash" exits 3; "bad" answers err;
// "slow" waits 2 s before answering.
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const log = process.env.FAKE_WORKER_LOG;
if (log) appendFileSync(log, `start ${mode} ${process.pid}\n`);
const wav = () => {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(56, 4);
  b.write('WAVE', 8, 'ascii');
  return b;
};
setTimeout(() => {
  if (process.env.FAKE_WORKER_FAIL === '1') {
    process.stdout.write('fail model did not load\n');
    process.exit(2);
  }
  process.stdout.write('ready\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = mode === 'tts' ? line.split('\t').slice(3).join('\t') : basename(line);
    if (/crash/.test(text)) process.exit(3);
    if (/bad/.test(text)) return void process.stdout.write('err no audio\n');
    const answer = () => {
      if (mode === 'tts') {
        writeFileSync(line.split('\t')[2], wav());
        process.stdout.write(`ok 10\n`);
      } else process.stdout.write(`ok heard ${text} by ${process.pid}\n`);
    };
    if (/slow/.test(text)) setTimeout(answer, 2000);
    else answer();
  });
  rl.on('close', () => process.exit(0));
}, Number(process.env.FAKE_WORKER_READY_MS ?? 0));
