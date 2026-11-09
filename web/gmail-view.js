// Gmail organizing in the chat: the count-first approval section ("Archive 4,213 emails?", the
// search, a few of the emails) and the result card (done, failed, Undo, Open in Gmail). Every value
// from the server goes in as text; the only link is Gmail's own search page.
import { t, locale, serverText } from './naming.js';
import { icon } from './icons.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
};
const num = (n) => Number(n || 0).toLocaleString(locale());

async function post(path) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}

/** The action as a question's verb ("Archive", "Mark as read" …). */
const verbs = () => ({
  archive: t('Archive'), read: t('Mark as read'), unread: t('Mark as unread'), star: t('Star'), unstar: t('Unstar'),
  important: t('Mark as important'), not_important: t('Mark as not important'), label: t('Add a label to'), unlabel: t('Remove a label from'),
  trash: t('Move to trash'), untrash: t('Take out of trash'), spam: t('Mark as spam'), not_spam: t('Mark as not spam'),
});
/** What happened, for the result card's title. */
const doneWords = () => ({
  archive: t('Archived'), read: t('Marked as read'), unread: t('Marked as unread'), star: t('Starred'), unstar: t('Unstarred'),
  important: t('Marked as important'), not_important: t('Marked as not important'), label: t('Label added'), unlabel: t('Label removed'),
  trash: t('Moved to trash'), untrash: t('Taken out of trash'), spam: t('Marked as spam'), not_spam: t('Marked as not spam'), undo: t('Undone'),
});

/** The card's question, e.g. "Archive 4,213 emails?". */
export function gmailQuestion(d) {
  const verb = verbs()[d.action] ?? d.action;
  if (d.action === 'undo') return t('Undo “{verb}” on {count} emails?', { verb: verbs()[d.undoOf] ?? d.undoOf, count: num(d.count) });
  return d.capped ? t('{verb} at least {count} emails?', { verb, count: num(d.count) }) : t('{verb} {count} emails?', { verb, count: num(d.count) });
}

/** The approval card's section: the search, the label, a few of the emails and what to expect. */
export function gmailApproval(d) {
  const box = el('div', 'gm-approval');
  if (d.query) {
    const q = el('p', 'gm-query');
    q.append(el('span', 'gm-k', t('Search')), el('code', 'gm-q', d.query));
    q.lastChild.dataset.raw = '';
    box.append(q);
  }
  if (d.label) box.append(el('p', 'gm-line', t('Label: {label}', { label: d.label })));
  if (Array.isArray(d.samples) && d.samples.length) {
    box.append(el('p', 'gm-k', t('For example:')));
    const ul = el('ul', 'gm-samples');
    for (const s of d.samples.slice(0, 5)) {
      const li = el('li', 'gm-sample');
      li.dataset.raw = '';
      li.append(el('span', 'gm-from', String(s.from ?? '').replace(/\s*<[^>]+>/, '')), el('span', 'gm-subj', s.subject ?? ''));
      ul.append(li);
    }
    box.append(ul);
  }
  const notes = el('ul', 'gm-notes');
  if (d.capped) notes.append(el('li', '', t('That is the most for one go ({cap}). Ask her again for the rest.', { cap: num(d.cap) })));
  if (d.background) notes.append(el('li', '', t('This is a big one: it runs in the background with progress above the chat, and you can stop it.')));
  if (d.alwaysAsks) notes.append(el('li', '', t('Trash and spam always ask you first.')));
  // M1: another mailbox (Outlook, IMAP): which one, and where trash really goes.
  if (d.provider && d.provider !== 'Gmail' && d.account) box.prepend(el('p', 'gm-line', t('Mailbox: {account}', { account: d.account })));
  if (d.action === 'trash') notes.append(el('li', '', d.provider && d.provider !== 'Gmail' ? t('Nothing is deleted for good: it goes to the Deleted Items or Trash folder.') : t('Nothing is deleted for good: Gmail empties its trash after 30 days.')));
  if (d.action !== 'undo') notes.append(el('li', '', t('You can undo this for 30 days.')));
  box.append(notes);
  return box;
}

/** The result card of a Gmail change. */
export function gmailResult(c) {
  const title = doneWords()[c.action] ?? c.action;
  const bad = c.failed > 0 || c.stopped;
  const card = el('div', `rcard rcard-gmail${bad ? ' bad' : ' ok'}`);
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', title);
  const head = el('div', 'rcard-head');
  const ic = el('span', 'rcard-icon');
  ic.setAttribute('aria-hidden', 'true');
  const svg = icon(c.action === 'undo' ? 'undo' : c.action === 'archive' ? 'archive' : 'mail');
  if (svg) ic.append(svg);
  head.append(ic, el('span', 'rcard-title', title));
  card.append(head);
  card.append(el('p', 'rc-main', t('{done} of {total} emails', { done: num(c.done), total: num(c.total) })));
  const chips = el('div', 'rc-chips');
  if (c.label) chips.append(el('span', 'rc-chip', t('Label: {label}', { label: c.label })));
  if (c.failed) chips.append(el('span', 'rc-chip bad', t('{count} failed', { count: num(c.failed) })));
  if (c.stopped) chips.append(el('span', 'rc-chip bad', t('Stopped before the end')));
  if (chips.childElementCount) card.append(chips);
  if (c.query) {
    const q = el('code', 'rc-cmd gm-q', c.query);
    q.dataset.raw = '';
    card.append(q);
  }
  const row = el('div', 'gm-actions');
  const status = el('p', 'rc-meta gm-status');
  status.setAttribute('role', 'status');
  if (c.id && c.action !== 'undo') {
    const undo = el('button', 'ghost small gm-undo');
    undo.type = 'button';
    const u = icon('undo');
    if (u) undo.append(u);
    undo.append(document.createTextNode(t('Undo')));
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      status.textContent = t('Undoing…');
      try {
        const r = await post(`/google/undo/${encodeURIComponent(c.id)}`);
        status.textContent = r.job ? t('Undo is running in the background (task #{id}).', { id: r.job }) : t('Undone: {count} emails put back.', { count: num(r.done) });
        undo.hidden = true;
      } catch (err) {
        status.textContent = err.message;
        undo.disabled = false;
      }
    });
    row.append(undo);
  }
  if (c.link && /^https:\/\/mail\.google\.com\//.test(c.link)) {
    const a = el('a', 'rcard-link gm-open', t('Open in Gmail'));
    a.href = c.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row.append(a);
  }
  if (row.childElementCount) card.append(row);
  card.append(status);
  return card;
}
