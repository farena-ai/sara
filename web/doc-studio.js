// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): the Library document panel for
// contracts, proposals and letters. Mark a document as a template (its blanks are found) and fill
// them in; review a Word file's tracked changes (and accept or reject them all); the clause checklist
// with quotes; and Ready to sign (a PDF with signature and date fields, after the check). Every file
// it makes is a new copy in the Library; the original never changes. Information, not legal advice.
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
let shown = null;
let opener = () => {};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const TYPE_LABEL = () => ({ contract: t('Contract'), nda: t('NDA'), sow: t('Statement of work'), proposal: t('Proposal'), letter: t('Letter'), invoice: t('Invoice cover') });
const CLAUSE = () => ({ parties: t('Parties'), term: t('Term'), payment: t('Payment'), termination: t('Termination'), liability_cap: t('Liability cap'), indemnity: t('Indemnity'), confidentiality: t('Confidentiality'), ip: t('Intellectual property'), governing_law: t('Governing law'), signatures: t('Signatures'), exclusions: t('What is not confidential'), scope: t('Scope'), timeline: t('Timeline'), price: t('Price'), assumptions: t('Assumptions'), acceptance: t('Acceptance'), date: t('Date'), greeting: t('Greeting'), closing: t('Closing'), invoice_no: t('Invoice number'), amount_due: t('Amount due'), due_date: t('Due date'), pay_how: t('How to pay') });
const CHECK = () => ({ placeholders: t('No blanks left'), tracked: t('No tracked changes left'), fields: t('Signature and date fields'), pages: t('Page numbers') });
const STATUS = () => ({ present: t('Present'), missing: t('Missing'), unusual: t('Unusual') });
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** A line saying what was made, with Open (in the Library) and Download. */
function madeLine(made, lead) {
  const p = el('p', 'small dstu-made');
  p.append(el('span', '', `${lead} ${made.name}`), ' ');
  if (made.libraryId) p.append(btn(t('Open'), 'ghost small', () => opener(made.libraryId)), ' ');
  const a = el('a', 'button ghost small', t('Download'));
  a.href = `/api/library/made/${made.id}/file`;
  a.setAttribute('download', made.name);
  p.append(a);
  if (made.format === 'pdf') {
    const o = el('a', 'button ghost small', t('Open the PDF'));
    o.href = `/api/library/made/${made.id}/file?inline=1`;
    o.target = '_blank';
    o.rel = 'noopener';
    p.append(' ', o);
  }
  return p;
}

function templateCard(info, box) {
  const card = el('div', 'dstu-card');
  const row = el('div', 'dstu-row');
  const on = el('input');
  on.type = 'checkbox';
  on.id = 'dstu-template-on';
  on.checked = Boolean(info.template);
  const lab = el('label', '', t('Use as a template'));
  lab.htmlFor = on.id;
  const kind = el('select');
  kind.id = 'dstu-template-type';
  kind.setAttribute('aria-label', t('Kind of document'));
  const labels = TYPE_LABEL();
  for (const k of info.types) {
    const o = el('option', '', labels[k] ?? k);
    o.value = k;
    kind.append(o);
  }
  kind.value = info.template?.type ?? info.type;
  const save = async () => {
    try {
      await api(`/doc-studio/${info.id}/template`, { method: 'PUT', body: JSON.stringify({ on: on.checked, type: kind.value }) });
      await showDocStudio(shown, { open: opener });
    } catch (err) {
      status.textContent = err.message;
    }
  };
  on.addEventListener('change', save);
  kind.addEventListener('change', () => on.checked && save());
  row.append(on, lab, tip(t('Marks this document as a template: she finds its blanks ({{Client}}, [CLIENT NAME], Date: ____) so you or she can fill them in. The original never changes.')), kind);
  card.append(row);
  const status = el('p', 'small muted', '');
  status.setAttribute('role', 'status');
  if (info.template) {
    const ph = info.template.placeholders.filter((p) => p.kind !== 'signature');
    if (!ph.length) card.append(el('p', 'small muted', t('No blanks found. Blanks look like {{Client}}, [CLIENT NAME], «Date» or a label with a line (Date: ______).')));
    else if (!info.docx) card.append(el('p', 'small muted', t('{n} blanks. Ask her in the chat to draft from it; filling in here works for Word files.', { n: ph.length })));
    else {
      card.append(el('p', 'small', t('Fill in the blanks for a new copy. Blanks you leave empty stay as they are.')));
      const form = el('div', 'dstu-form');
      const inputs = new Map();
      ph.forEach((p, i) => {
        const id = `dstu-ph-${i}`;
        const l = el('label', 'dstu-label', p.label);
        l.htmlFor = id;
        const inp = el('input');
        inp.id = id;
        inp.type = 'text';
        inp.autocomplete = 'off';
        inputs.set(p.label, inp);
        form.append(l, inp);
      });
      const tl = el('label', 'dstu-label', t('Title of the new document'));
      tl.htmlFor = 'dstu-title';
      const title = el('input');
      title.id = 'dstu-title';
      title.type = 'text';
      title.placeholder = info.name.replace(/\.[a-z0-9]+$/i, '');
      form.append(tl, title);
      card.append(form);
      card.append(
        btn(t('Make the document'), 'small', async () => {
          const values = {};
          for (const [k, inp] of inputs) if (inp.value.trim()) values[k] = inp.value.trim();
          status.textContent = t('Making it…');
          try {
            const r = await api(`/doc-studio/${info.id}/fill`, { method: 'POST', body: JSON.stringify({ values, title: title.value }) });
            status.replaceChildren(madeLine(r.made, t('Made')));
            if (r.missing.length) status.append(el('p', 'small muted', t('Not filled yet: {list}', { list: r.missing.join(', ') })));
          } catch (err) {
            status.textContent = err.message;
          }
        }),
      );
    }
  }
  card.append(status);
  box.append(card);
}

function reviewCard(info, box) {
  if (!info.docx) return;
  const card = el('div', 'dstu-card');
  const head = el('p', 'dstu-sub');
  head.append(el('strong', '', t('Tracked changes')), tip(t('Changes she or anyone made with Track Changes on. Accept or Reject each one in Word (Review tab), or all at once here; either way you get a new version.')));
  card.append(head);
  if (!info.revisions.length) {
    card.append(el('p', 'small muted', t('No tracked changes in this file.')));
    box.append(card);
    return;
  }
  card.append(el('p', 'small muted', t('{n} changes', { n: info.revisions.length })));
  const list = el('ul', 'dstu-revs');
  const revs = info.revisions.slice(0, 120);
  for (let i = 0; i < revs.length; i++) {
    const r = revs[i];
    // A removal right before an addition in the same sentence is one change: “30” → “15”.
    const next = revs[i + 1];
    const pair = r.type === 'del' && next?.type === 'ins' && next.context === r.context && next.author === r.author;
    const li = el('li', `dstu-rev dstu-${pair ? 'chg' : r.type}`);
    if (pair) {
      li.append(el('span', 'dstu-kind', t('Changed')), ' ', el('del', '', r.text), ' → ', el('ins', '', next.text));
      i++;
    } else li.append(el('span', 'dstu-kind', r.type === 'ins' ? t('Added') : t('Removed')), ' ', el(r.type === 'ins' ? 'ins' : 'del', '', r.text));
    li.append(el('div', 'small muted', `${r.author || t('Someone')} · ${when(r.date)}`));
    if (r.context && r.context !== r.text) li.append(el('div', 'small muted dstu-ctx', `“${r.context.slice(0, 220)}”`));
    list.append(li);
  }
  card.append(list);
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const act = (how) => async () => {
    status.textContent = t('Working…');
    try {
      const r = await api(`/doc-studio/${info.id}/resolve`, { method: 'POST', body: JSON.stringify({ how }) });
      status.replaceChildren(madeLine(r.made, how === 'accept' ? t('Accepted all, new version:') : t('Rejected all, new version:')));
    } catch (err) {
      status.textContent = err.message;
    }
  };
  const row = el('div', 'actions-left');
  row.append(btn(t('Accept all'), 'ghost small', act('accept')), btn(t('Reject all'), 'ghost small', act('reject')));
  card.append(row, status);
  box.append(card);
}

function checklistCard(info, box) {
  if (!info.checklist) return;
  const c = info.checklist;
  const card = el('div', 'dstu-card');
  const head = el('p', 'dstu-sub');
  head.append(el('strong', '', t('Clause checklist')), tip(t('The usual clauses for this kind of document, each found by its wording and quoted with where it is. Missing or unusual ones are worth a closer look.')));
  card.append(head);
  card.append(el('p', 'dstu-banner small', t('Information, not legal advice. For anything important, have a lawyer read it.')));
  card.append(el('p', 'small muted', t('{present} present, {missing} missing, {unusual} unusual', { present: c.present, missing: c.missing, unusual: c.unusual })));
  const st = STATUS();
  const names = CLAUSE();
  const list = el('ul', 'dstu-checks');
  for (const i of c.items) {
    const li = el('li', `dstu-check dstu-${i.status}`);
    li.append(el('span', 'dstu-chip', st[i.status]), ' ', el('strong', '', names[i.id] ?? i.label));
    if (i.note) li.append(el('div', 'small', i.note));
    if (i.quote) li.append(el('blockquote', 'small dstu-quote', `“${i.quote}”`));
    if (i.quote && i.where && i.where !== 'the document') li.append(el('div', 'small muted', i.where));
    list.append(li);
  }
  card.append(list);
  if (c.others?.length) {
    card.append(el('p', 'small', t('Worth a second look:')));
    const ul = el('ul', 'dstu-checks');
    for (const o of c.others) {
      const li = el('li', 'dstu-check dstu-unusual');
      li.append(el('strong', '', o.label), el('blockquote', 'small dstu-quote', `“${o.quote}”`));
      if (o.where && o.where !== 'the document') li.append(el('div', 'small muted', o.where));
      ul.append(li);
    }
    card.append(ul);
  }
  box.append(card);
}

function signCard(info, box) {
  if (!info.docx) return;
  const card = el('div', 'dstu-card');
  const head = el('p', 'dstu-sub');
  head.append(el('strong', '', t('Ready to sign')), tip(t('Checks that no blanks or tracked changes are left, then makes a PDF with page numbers and a signature, name and date field for each signer.')));
  card.append(head);
  const status = el('div', 'small');
  status.setAttribute('role', 'status');
  card.append(
    btn(t('Make the signing PDF'), 'small', async () => {
      status.textContent = t('Checking…');
      try {
        const r = await api(`/doc-studio/${info.id}/sign`, { method: 'POST', body: '{}' });
        const ul = el('ul', 'dstu-checks');
        for (const c of r.checks) {
          const li = el('li', `dstu-check ${c.ok ? 'dstu-present' : 'dstu-missing'}`);
          li.append(el('span', 'dstu-chip', c.ok ? '✓' : '✗'), ' ', el('strong', '', CHECK()[c.id] ?? c.id), el('div', 'small muted', c.detail));
          ul.append(li);
        }
        status.replaceChildren(el('p', '', r.ready ? t('Ready to sign.') : t('Not ready to sign yet.')), ul);
        if (r.made) status.append(madeLine(r.made, t('Made')));
      } catch (err) {
        status.textContent = err.message;
      }
    }),
  );
  card.append(status);
  box.append(card);
}

/** Shows the panel for a Library document (contracts, proposals, letters and other text documents). */
export async function showDocStudio(d, o = {}) {
  const box = $('#lib-doc-studio');
  const body = $('#lib-doc-studio-body');
  if (!box || !body) return;
  if (o.open) opener = o.open;
  shown = d;
  // The server reads the file itself, so a document still waiting for the Library's reader works too.
  const fits = d && d.keep && !d.readOnly && d.status !== 'failed' && /\.(docx|pdf|txt|md|markdown|odt|rtf|html?)$/i.test(d.name);
  box.hidden = !fits;
  if (!fits) return body.replaceChildren();
  let info;
  try {
    info = await api(`/doc-studio/${d.id}`);
  } catch {
    box.hidden = true;
    return;
  }
  if (shown !== d) return;
  body.replaceChildren();
  templateCard(info, body);
  reviewCard(info, body);
  checklistCard(info, body);
  signCard(info, body);
}
