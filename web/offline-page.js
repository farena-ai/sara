// Feature 4 (works offline): the service worker's offline page hands over to what this device kept.
// Only cached files are used here (sw.js SHELL). The copy was made by the app while connected
// (web/offline-hook.js), in the person's language; with no copy, the plain "Can't reach" card stays.
import { idbKV, openOfflineCopy } from './offline-store.js';
import { watchConnection } from './offline-sync.js';
import { mountOfflineView } from './offline-view.js';

const health = async () => {
  try {
    return (await fetch('/api/health', { cache: 'no-store' })).ok;
  } catch {
    return false;
  }
};
let view = null;
// Back to the app, in the chat that was being read.
// (A query, so it is a real page load: only a new #hash on the same page would load nothing.)
const back = () => location.replace(`/?back=${Date.now()}${view?.chatId ? `#c=${encodeURIComponent(view.chatId)}` : ''}`);

async function start() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return;
  // Never make an empty database here: only open the one the app made.
  const dbs = (await indexedDB.databases?.().catch(() => null)) ?? null;
  if (dbs && !dbs.some((d) => d.name === 'sara-offline')) return;
  const copy = await openOfflineCopy(idbKV());
  const owner = await copy.owner();
  const [list, notes] = await Promise.all([copy.list(), copy.notes()]);
  if (!owner || (!list.length && !notes.length)) return;
  clearTimeout(window.saraOfflineRetry);
  const words = await copy.words();
  document.getElementById('offline-card')?.setAttribute('hidden', '');
  document.documentElement.lang = words.lang ?? document.documentElement.lang;
  if (words.title) document.title = words.title;
  watchConnection({ check: health, onChange: (online) => online && back(), startOnline: false });
  view = mountOfflineView({
    copy,
    words,
    onRetry: async () => {
      if (await health()) back();
    },
  });
  await view.show();
}
start().catch((err) => console.warn('offline copy:', err));
