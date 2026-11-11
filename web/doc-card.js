// make_document (docs/DOCUMENTS.md): the card for a document she made, in place of the plain file
// chip. Download (the kept file from her Library), Open (a PDF opens in the browser; every other
// kind shows its preview, a page with no scripts, in a sandboxed frame), Make changes (asks her in
// the composer, which makes the next version and keeps the old ones) and the other versions.
import { t } from './naming.js';
import { addSaveButtons, dragOut } from './save-to-pc.js';

const ICON = { docx: '📘', pdf: '📕', xlsx: '📗', pptx: '📙', md: '📝', csv: '📊', html: '🌐' };
const KIND = () => ({ docx: t('Word document'), pdf: t('PDF'), xlsx: t('Excel spreadsheet'), pptx: t('PowerPoint presentation'), md: t('Markdown file'), csv: t('CSV file'), html: t('Web page') });

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const base = (id) => `/api/library/made/${encodeURIComponent(id)}`;

/** Opens the document: a PDF in a new tab; everything else as its preview in a dialog. */
export function openMade(made, name) {
  if (made.format === 'pdf') {
    window.open(`${base(made.id)}/file?inline=1`, '_blank', 'noopener');
    return;
  }
  let dlg = document.getElementById('doc-preview');
  if (!dlg) {
    dlg = el('dialog', 'doc-preview');
    dlg.id = 'doc-preview';
    const bar = el('div', 'doc-preview-bar');
    const title = el('strong', 'doc-preview-title');
    // The window's own ✕ (web/dialogs.js) closes it.
    const dl = el('a', 'button', t('Download'));
    bar.append(title, dl);
    const frame = el('iframe', 'doc-preview-frame');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    dlg.append(bar, frame);
    document.body.append(dlg);
  }
  dlg.querySelector('.doc-preview-title').textContent = name ?? made.title ?? '';
  const dl = dlg.querySelector('a');
  dl.href = `${base(made.id)}/file`;
  dl.setAttribute('download', name ?? 'document');
  const frame = dlg.querySelector('iframe');
  frame.title = t('Preview of {name}', { name: name ?? made.title ?? '' });
  frame.src = `${base(made.id)}/preview`;
  dlg.showModal();
}

/** Puts a \"change this document\" request in the composer for her (she makes the next version). */
function askChanges(made) {
  const input = document.getElementById('input');
  if (!input) return;
  input.value = `${t('Change “{title}” (document #{id}):', { title: made.title ?? '', id: made.id })} `;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function showVersions(made, box) {
  box.replaceChildren();
  try {
    const r = await fetch(base(made.id), { credentials: 'same-origin' });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const list = el('ul', 'doc-versions');
    for (const v of d.versions ?? []) {
      const li = el('li');
      const a = el('a', '', t('Version {n}', { n: v.version }));
      a.href = `${base(v.id)}/file`;
      a.setAttribute('download', v.name);
      li.append(a, el('span', 'muted small', ` · ${size(v.bytes)} · ${new Date(v.createdAt).toLocaleString()}`));
      list.append(li);
    }
    box.append(list);
  } catch {
    box.append(el('p', 'muted small', t("Couldn't load the versions.")));
  }
}

/** The card for one shared file that is a made document. */
export function docCard(f) {
  const made = f.made;
  const card = el('div', 'doc-card');
  card.dataset.format = made.format;
  const head = el('div', 'doc-card-head');
  head.append(el('span', 'doc-card-icon', ICON[made.format] ?? '📄'));
  const words = el('div', 'doc-card-words');
  words.append(el('span', 'doc-card-name', f.name ?? made.title ?? t('Document')));
  const meta = [KIND()[made.format] ?? made.format, size(Number(f.bytes ?? 0))];
  if (made.version > 1) meta.push(t('Version {n}', { n: made.version }));
  words.append(el('span', 'doc-card-meta muted small', meta.join(' · ')));
  head.append(words);
  const acts = el('div', 'doc-card-actions');
  const dl = el('a', 'button doc-download', t('Download'));
  dl.href = `${base(made.id)}/file`;
  dl.setAttribute('download', f.name ?? 'document');
  const open = el('button', 'ghost', t('Open'));
  open.type = 'button';
  open.addEventListener('click', () => openMade(made, f.name));
  const change = el('button', 'ghost', t('Make changes'));
  change.type = 'button';
  change.addEventListener('click', () => askChanges(made));
  acts.append(dl, open, change);
  // The desktop app: Save to… / Save to Downloads, and dragging the card out to a folder.
  addSaveButtons(acts, { url: `${base(made.id)}/file`, name: f.name ?? made.title });
  dragOut(card, { url: `${base(made.id)}/file`, name: f.name ?? made.title, format: made.format });
  const versions = el('div', 'doc-card-versions');
  if (made.version > 1) {
    const older = el('button', 'ghost', t('Other versions'));
    older.type = 'button';
    older.addEventListener('click', () => void showVersions(made, versions));
    acts.append(older);
  }
  card.append(head, acts, versions);
  return card;
}
