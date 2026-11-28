// Hands a batch to the sink and reports what came back.
import { splitOutcome } from './outcome.js';

export function toSinkEvent(entry) {
  return { id: entry.id, key: entry.key, seq: entry.seq, attempt: entry.attempts + 1, data: entry.data };
}

export class Dispatcher {
  constructor(sink, log) {
    this.sink = sink;
    this.log = log;
  }

  deliver(batch, now) {
    let result;
    try {
      result = this.sink.deliver(batch.items.map(toSinkEvent), { batchId: batch.id, now });
    } catch (err) {
      this.log('dispatch', `#${batch.id} failed: ${err.message}`);
      return { accepted: [], retry: batch.items.slice(), reason: err.message };
    }
    if (result && typeof result.then === 'function') throw new Error('sinks must deliver synchronously');
    const { accepted, retry } = splitOutcome(batch.items, result);
    const reason = result?.reason ?? 'rejected';
    if (this.log.enabled && result?.rejected?.length) {
      this.log('dispatch', `#${batch.id} sink rejected ${result.rejected.join(' ')} (${reason}); accepted ${accepted.length}, to retry ${retry.length}`);
    }
    return { accepted, retry, reason };
  }
}
