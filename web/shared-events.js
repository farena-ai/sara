// B1 follow-up: one /api/events stream for every tab of this browser. Browsers open at most six
// HTTP/1.1 connections to one server; with one stream per tab, a few tabs (plus a streaming reply)
// used them all and every button press waited. The tab holding a Web Lock opens the EventSource and
// passes each event on over a BroadcastChannel; when that tab closes, the next one takes over.
// Without Web Locks or BroadcastChannel each tab keeps its own stream, as before.
const CLOSED = 2;

/** An EventSource-like object (addEventListener, onerror, readyState, close) shared by all tabs. */
export function sharedEvents(url, env = globalThis) {
  const ES = env.EventSource;
  if (!env.navigator?.locks || !env.BroadcastChannel) return new ES(url);
  const name = `sara-events:${url}`;
  const listeners = new Map();
  const channel = new env.BroadcastChannel(name);
  const stop = new AbortController();
  let real = null;
  let release = null;
  const deliver = (type, data) => {
    for (const fn of listeners.get(type) ?? []) fn({ type, data });
  };
  const forward = (e) => {
    if (e.type === 'open') facade.readyState = 1;
    channel.postMessage({ type: e.type, data: e.data, state: real?.readyState });
    deliver(e.type, e.data);
  };
  const ended = (e) => {
    facade.readyState = CLOSED;
    facade.onerror?.(e ?? { type: 'error' });
    stop.abort(); // this object is done; the app opens a new one when it wants the stream again
    channel.close();
  };
  const facade = {
    readyState: 0,
    onerror: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
        real?.addEventListener(type, forward);
      }
      listeners.get(type).add(fn);
    },
    close() {
      if (stop.signal.aborted) return;
      facade.readyState = CLOSED;
      stop.abort();
      real?.close();
      real = null;
      channel.close();
      release?.();
    },
  };
  channel.onmessage = ({ data }) => {
    if (real || facade.readyState === CLOSED) return;
    if (data?.state === CLOSED) return void ended();
    if (typeof data?.state === 'number') facade.readyState = data.state;
    if (data?.type) deliver(data.type, data.data);
  };
  env.navigator.locks.request(name, { signal: stop.signal }, () => new Promise((done) => {
    release = done;
    if (stop.signal.aborted || facade.readyState === CLOSED) return void done();
    real = new ES(url);
    facade.readyState = real.readyState;
    for (const type of listeners.keys()) real.addEventListener(type, forward);
    if (!listeners.has('open')) real.addEventListener('open', forward);
    real.onerror = (e) => {
      facade.readyState = real?.readyState ?? CLOSED;
      if (facade.readyState !== CLOSED) return void facade.onerror?.(e);
      // Signed out (or the server refused): every tab hears it; the lock is let go a little later so
      // a waiting tab doesn't open a stream that would end the same way.
      channel.postMessage({ state: CLOSED });
      real = null;
      ended(e);
      setTimeout(done, 1000);
    };
  })).catch(() => {
    /* aborted: this tab closed its stream before it got the lock */
  });
  return facade;
}
