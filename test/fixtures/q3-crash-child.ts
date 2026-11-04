import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp } from '../helpers.ts';
import { deliveryFor } from '../../src/delivery.ts';
import { sendDelivery } from '../../src/bridges/delivery.ts';
import { PRIO_REPLY, SendQueue } from '../../src/bridges/sendq.ts';

const [dir, mode, endpoint] = process.argv.slice(2);
if (!dir || !mode || new URL(endpoint).hostname !== '127.0.0.1') throw new Error('Invalid local crash fixture');
const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
const store = deliveryFor(app);
const queue = new SendQueue();
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
const barrier = () => writeFileSync(join(dir, 'barrier.json'), JSON.stringify({ mode }));
const acknowledge = store.acknowledge.bind(store);
if (mode === 'before-ack') store.acknowledge = () => { barrier(); block(); };
if (mode === 'ack-saved') store.acknowledge = (id, refs) => { acknowledge(id, refs); barrier(); block(); };
if (mode === 'ack-fault') store.acknowledge = () => { throw new Error('Synthetic acknowledgment persistence fault'); };
if (mode === 'queued') queue.pause('tg:777', 60000);
const pending = sendDelivery(app, queue, 'tg:777', PRIO_REPLY,
  { bridge: 'telegram', operation: 'sendMessage', destination: '777', review: { text: 'Synthetic retained crash review' } },
  async () => {
    if (mode === 'attempted') { barrier(); block(); }
    const res = await fetch(endpoint, { method: 'POST', body: 'synthetic effect', signal: AbortSignal.timeout(10000) });
    return res.json();
  });
if (mode === 'queued') { barrier(); block(); }
await pending.catch(() => { if (mode === 'ack-fault') { barrier(); block(); } });
throw new Error('Crash fixture unexpectedly completed without its parent terminating it');
