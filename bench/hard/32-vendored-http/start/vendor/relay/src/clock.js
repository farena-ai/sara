// Clocks measure time in SECONDS (numbers, fractions allowed).
//
// createClock() is a virtual clock for tests and simulations: time stands still while code runs and
// jumps to the next timer when everything else is waiting, so a "5 second" wait takes no real time
// and the outcome is the same on every run. systemClock follows the real time.

export function createClock({ start = 0 } = {}) {
  let now = start;
  let seq = 0;
  let scheduled = false;
  const timers = [];

  function schedule() {
    if (scheduled || !timers.length) return;
    scheduled = true;
    setImmediate(tick);
  }

  function tick() {
    scheduled = false;
    if (!timers.length) return;
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const t = timers.shift();
    if (t.at > now) now = t.at;
    t.resolve();
    schedule();
  }

  function timer(seconds) {
    if (typeof seconds !== 'number' || !(seconds >= 0)) throw new RangeError(`seconds must be a number >= 0, got ${seconds}`);
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const t = { at: now + seconds, seq: seq++, resolve };
    timers.push(t);
    schedule();
    return {
      promise,
      cancel() {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      },
    };
  }

  return Object.freeze({
    virtual: true,
    now: () => now,
    timer,
    sleep: (seconds) => timer(seconds).promise,
    pending: () => timers.length,
  });
}

export const systemClock = Object.freeze({
  virtual: false,
  now: () => performance.now() / 1000,
  timer(seconds) {
    if (typeof seconds !== 'number' || !(seconds >= 0)) throw new RangeError(`seconds must be a number >= 0, got ${seconds}`);
    let handle;
    const promise = new Promise((resolve) => (handle = setTimeout(resolve, seconds * 1000)));
    return { promise, cancel: () => clearTimeout(handle) };
  },
  sleep(seconds) {
    return this.timer(seconds).promise;
  },
  pending: () => 0,
});
