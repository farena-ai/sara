// Builds the batches handed to the sink: up to batchSize ready events from the queue.
import { describe } from '../queue/entry.js';

export class Batcher {
  constructor(queue, config, log) {
    this.queue = queue;
    this.batchSize = config.batchSize;
    this.log = log;
    this.nextId = 1;
  }

  next(now) {
    const items = this.queue.takeReady(now, this.batchSize);
    if (items.length === 0) return null;
    const batch = { id: this.nextId++, items, createdAt: now };
    if (this.log.enabled) {
      const { held, waiting } = this.queue.lastScan;
      this.log('batch', `#${batch.id} ${items.length}/${this.batchSize} [${items.map(describe).join(' ')}] held=${held} waiting=${waiting} left=${this.queue.size}`);
    }
    return batch;
  }
}
