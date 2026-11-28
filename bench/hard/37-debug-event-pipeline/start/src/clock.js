// Clocks. The pipeline never reads the time itself: it asks the clock it was given.
// Tests and the CLI use FakeClock, which only moves when told to.

export class FakeClock {
  constructor(start = 0) {
    if (!Number.isInteger(start) || start < 0) throw new RangeError(`bad clock start ${start}`);
    this.t = start;
  }

  now() {
    return this.t;
  }

  advance(ms) {
    if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`cannot advance the clock by ${ms}`);
    this.t += ms;
    return this.t;
  }

  set(t) {
    if (t < this.t) throw new RangeError(`the clock cannot go back (${this.t} -> ${t})`);
    this.t = t;
    return this.t;
  }
}

export class SystemClock {
  now() {
    return Date.now();
  }
}
