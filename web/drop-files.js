// Drop files in, save her documents out (docs/desktop.md): the plain parts (no page, no words),
// used by web/drop.js and web/save-to-pc.js and checked in test/desktop-drop.test.ts.
const MB = 1024 * 1024;
/** How many files a dropped folder gives at most (the message box then keeps its own limits). */
const FOLDER_MAX = 20;
const DEPTH = 4;

/**
 * Sorts dropped files: what she can take, what is too big (with the limit in MB) and what she
 * can't read. Pictures are made smaller before they go, so only documents are checked for size.
 * `maxBytes`: the owner's (or a member's) largest document; `maxOtherBytes`: non-PDFs are read whole.
 */
export function sortDropped(files, { maxBytes, maxOtherBytes, isDoc }) {
  const take = [];
  const tooBig = [];
  const unreadable = [];
  for (const f of files) {
    const photo = String(f.type ?? '').startsWith('image/');
    if (!photo && !isDoc(f)) {
      unreadable.push(f.name);
      continue;
    }
    if (!photo) {
      const pdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      const limit = Math.min(maxBytes || Infinity, pdf ? Infinity : maxOtherBytes || Infinity);
      if (f.size > limit) {
        tooBig.push({ name: f.name, mb: Math.round(limit / MB) });
        continue;
      }
    }
    take.push(f);
  }
  return { take, tooBig, unreadable };
}

/** Text or links dropped from a browser or another app (web links only; never a script address). */
export function dropText(dt) {
  const types = [...(dt?.types ?? [])];
  if (types.includes('text/uri-list')) {
    const links = dt.getData('text/uri-list').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && /^https?:\/\//i.test(l));
    if (links.length) return { text: links.join('\n'), link: true };
    if (!types.includes('text/plain')) return { text: '', link: false };
  }
  if (types.includes('text/plain')) {
    const s = dt.getData('text/plain').trim();
    if (/^javascript:/i.test(s)) return { text: '', link: false };
    return { text: s, link: false };
  }
  return { text: '', link: false };
}

const readAll = (reader) =>
  new Promise((ok) => {
    const out = [];
    const more = () =>
      reader.readEntries(
        (batch) => {
          if (!batch.length) return ok(out);
          out.push(...batch);
          more();
        },
        () => ok(out),
      );
    more();
  });
const fileOf = (entry) => new Promise((ok) => entry.file(ok, () => ok(null)));

/**
 * The files in a drop: plain files as they are, folders opened (hidden files and folders left out,
 * a few levels deep) up to `max`. `more`: some were left because of the limit.
 */
export async function collectDropped(items, { max = FOLDER_MAX } = {}) {
  const files = [];
  const folders = [];
  let more = false;
  const walk = async (entry, depth) => {
    if (!entry || entry.name?.startsWith('.')) return;
    if (files.length >= max) {
      more = true;
      return;
    }
    if (entry.isFile) {
      const f = await fileOf(entry);
      if (f) files.push(f);
      return;
    }
    if (entry.isDirectory && depth < DEPTH) {
      for (const kid of await readAll(entry.createReader())) await walk(kid, depth + 1);
    }
  };
  const entries = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else if (typeof it.getAsFile === 'function') {
      const f = it.getAsFile();
      if (f) entries.push({ isFile: true, name: f.name, file: (ok) => ok(f) });
    }
  }
  for (const e of entries) {
    if (e.isDirectory) folders.push(e.name);
    await walk(e, 0);
  }
  return { files, folders, more };
}

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
};

/** Only her own file addresses: a document she made, a Library file, a file she shared. */
export function saveUrlOk(url) {
  const u = String(url ?? '');
  if (u.includes('..') || u.includes('?') || u.includes('#')) return false;
  return /^\/api\/library\/made\/\d+\/file$/.test(u) || /^\/api\/library\/\d+\/file$/.test(u) || /^\/api\/files\/[\w.-]+$/.test(u);
}

/** The DownloadURL a drag out to the desktop carries ("type:name:address"; no colon in the name). */
export function dragOutData(f, origin) {
  const ext = (f.format ?? String(f.name ?? '').split('.').pop() ?? '').toLowerCase();
  const name = String(f.name ?? 'document').replace(/[:\\/\r\n]/g, '_');
  return `${MIME[ext] ?? 'application/octet-stream'}:${name}:${origin}${f.url}`;
}
