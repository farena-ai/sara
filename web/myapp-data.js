// V3.1 My apps (src/my-apps.ts): added to every page of a kept app. `appData` is the app's own small
// data store on this server (get/set/remove/keys). The server fills in the app's address and whether
// this copy is a read-only share link; the page runs sandboxed, without the Sara session.
(() => {
  const base = '__ROOT__';
  const ask = async (path, init) => {
    const r = await fetch(base + path, init);
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 404) throw new Error(d.error || r.statusText);
    return { status: r.status, d };
  };
  window.appData = {
    readOnly: '__READONLY__' === 'true',
    async get(key, fallback = null) {
      const { status, d } = await ask(encodeURIComponent(key));
      return status === 404 ? fallback : d.value;
    },
    async set(key, value) {
      await ask(encodeURIComponent(key), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
      return value;
    },
    async remove(key) {
      await ask(encodeURIComponent(key), { method: 'DELETE' });
    },
    async keys() {
      const { d } = await ask('');
      return d.keys || [];
    },
  };
})();
