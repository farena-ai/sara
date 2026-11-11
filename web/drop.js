// Drop anywhere on her window (docs/desktop.md → Drop files in, save her documents out): files,
// folders (their files, up to the limit), pictures, text and links from a browser. A full-window
// overlay says where they go; everything lands in the message box with the usual checks and is
// never sent until the person presses Send. Works the same in a browser and in the desktop apps.
import { t } from './naming.js';
import { collectDropped, dropText, sortDropped } from './drop-files.js';

const MB = 1024 * 1024;

let limits = null;
/** The size limits a drop is checked against (the Library's settings; members see theirs). */
async function loadLimits() {
  if (limits) return limits;
  try {
    const r = await fetch('/api/library/settings', { credentials: 'same-origin' });
    if (r.ok) {
      const s = await r.json();
      limits = { maxBytes: Number(s.maxBytes) || 0, maxOtherBytes: Number(s.maxOtherBytes) || 0 };
    }
  } catch {
    /* an older server or signed out: the upload says it */
  }
  return limits ?? { maxBytes: 0, maxOtherBytes: 0 };
}

let overlay = null;
function showOverlay(on) {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'drop-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const box = document.createElement('div');
    box.className = 'drop-box';
    const big = document.createElement('strong');
    big.className = 'drop-title';
    const small = document.createElement('span');
    small.className = 'drop-sub';
    box.append(big, small);
    overlay.append(box);
    document.body.append(overlay);
  }
  if (on) {
    overlay.querySelector('.drop-title').textContent = t('Drop to give these to Sara');
    const mb = limits?.maxBytes ? Math.round(limits.maxBytes / MB) : 0;
    overlay.querySelector('.drop-sub').textContent = mb ? `${t('Up to 5 documents and 4 photos, documents up to {n} MB each.', { n: mb })} ${t('Nothing is sent until you press Send.')}` : t('Nothing is sent until you press Send.');
  }
  overlay.classList.toggle('on', on);
  document.documentElement.classList.toggle('dropping', on);
}

/**
 * Turns on the window-wide drop. `take(files)` puts files in the message box (false: refused, e.g.
 * signed out or the demo); `insertText(s)` puts words in it; `say(msg)` shows a problem;
 * `isDoc(file)` is the Library's own check.
 */
export function initDrop({ take, insertText, say, isDoc, ready = () => true }) {
  let depth = 0;
  let ours = false;
  // Her own drags (a conversation onto a project, a document card out) are not a drop for her.
  window.addEventListener('dragstart', () => (ours = true), true);
  window.addEventListener('dragend', () => (ours = false), true);
  const wanted = (e) => {
    if (ours || !ready()) return false;
    const types = [...(e.dataTransfer?.types ?? [])];
    return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
  };
  window.addEventListener('dragenter', (e) => {
    if (!wanted(e)) return;
    e.preventDefault();
    depth++;
    void loadLimits().then(() => depth > 0 && showOverlay(true));
    showOverlay(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!wanted(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!wanted(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth || !e.relatedTarget) {
      depth = 0;
      showOverlay(false);
    }
  });
  window.addEventListener('drop', async (e) => {
    const was = ours;
    ours = false;
    depth = 0;
    showOverlay(false);
    if (was || !ready()) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = [...dt.types];
    // A drop into a text field of the page (the message box, a note) keeps the browser's own handling.
    const field = e.target?.closest?.('textarea, input, [contenteditable="true"]');
    if (!types.includes('Files') && field) return;
    e.preventDefault();
    if (types.includes('Files')) {
      const items = [...(dt.items ?? [])];
      const got = items.length ? await collectDropped(items) : { files: [...dt.files], folders: [], more: false };
      const lim = await loadLimits();
      const r = sortDropped(got.files, { ...lim, isDoc });
      for (const b of r.tooBig) say(t('{name} is too big: the most she takes is {n} MB.', { name: b.name, n: b.mb }));
      // From a folder, files she can't read are just left out; a file dropped by itself is named.
      if (r.unreadable.length && !got.folders.length) say(`${t("She can't read")} ${r.unreadable.join(', ')}. ${t('She reads PDF, Word, Excel, PowerPoint, e-books, web pages, text, Markdown and CSV files.')}`);
      if (got.more) say(t('That folder has more files than she takes at once. She took the first {n}.', { n: got.files.length }));
      if (r.take.length && take(r.take) === false) say(t('Open a chat first, then drop the files again.'));
      return;
    }
    const { text } = dropText(dt);
    if (text) insertText(text);
  });
}
