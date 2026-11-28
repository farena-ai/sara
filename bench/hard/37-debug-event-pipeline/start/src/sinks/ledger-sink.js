// A sink that books amounts on accounts. Event data: { account, amount } with amount like "12.50".
//
// An account can be locked until a clock time ({ account, until }); events for it are rejected while it is
// locked ("account locked") and go through once it is not. An amount that cannot be read is rejected every
// time ("invalid amount"), so the event ends in the dead letters.
import { formatCents, parseAmount } from '../util/money.js';

export class LedgerSink {
  constructor({ locks = [] } = {}) {
    this.locks = locks.map((l) => ({ account: l.account, until: l.until }));
    this.totals = new Map(); // account -> cents
    this.booked = []; // ids in the order they were booked
  }

  deliver(events, { now }) {
    const rejected = [];
    let reason = null;
    for (const event of events) {
      const account = event.data?.account ?? event.key;
      const cents = parseAmount(event.data?.amount);
      let why = null;
      if (cents === null) why = 'invalid amount';
      else if (this.locks.some((l) => l.account === account && now < l.until)) why = 'account locked';
      if (why) {
        rejected.push(event.id);
        reason ??= why;
        continue;
      }
      this.totals.set(account, (this.totals.get(account) ?? 0) + cents);
      this.booked.push(event.id);
    }
    return rejected.length > 0 ? { rejected, reason } : undefined;
  }

  /** { account: "12.50", … } sorted by account. */
  report() {
    const out = {};
    for (const account of [...this.totals.keys()].sort()) out[account] = formatCents(this.totals.get(account));
    return out;
  }
}
