// Qualification child only: fail a read after a real worker has completed its first backup.
const originalFetch = globalThis.fetch;
let backedUp = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (backedUp && url.hostname === '127.0.0.1' && url.pathname === '/api/health') throw new Error('Synthetic post-backup failure');
  const response = await originalFetch(input, init);
  if (url.hostname === '127.0.0.1' && url.pathname === '/api/backups' && response.ok) backedUp = true;
  return response;
};
