// Explicit child-process qualification failure injection; never imported by the application.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1' && url.pathname === '/api/health') throw new Error('Synthetic transport failure');
  if (url.hostname === '127.0.0.1' && url.pathname === '/api/backups') await new Promise(resolve => setTimeout(resolve, 100));
  return originalFetch(input, init);
};
