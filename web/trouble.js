// 3.3.0 easy mode (ezfirst): her own trouble, told plainly (src/trouble.ts makes the notices).
// A failed reply that was a service problem (her AI service down, the key rejected, no credit,
// busy, the model gone) shows her words, ONE Fix it button (the Settings page that fixes it) and
// Try again, which really tries again and shows what happened. Today's Needs you lists the same
// notices (also mailboxes that signed her out and add-ons that stopped; web/today.js troubleNeeds).
//
// No imports: app.js passes el() and t() in, so this file also runs in Node for the tests.

/** The notice's words in the app language (the server's English template and its values). */
export const troubleText = (tr, t) => (tr?.key ? t(tr.key, tr.params ?? {}) : String(tr?.text ?? ''));

/**
 * The chat bubble for a failed reply with trouble: her words, Fix it, Try again (model trouble),
 * and the service's own words folded under Details (for Report this).
 */
export function troubleBubble(tr, { el, t, onFix, onRetry, detail = '' }) {
  const box = el('div', 'msg error trouble');
  box.dataset.trouble = tr.kind;
  box.append(el('p', 'trouble-text', troubleText(tr, t)));
  const row = el('div', 'trouble-acts');
  const fix = el('button', 'small', t(tr.fix?.label || 'Fix it'));
  fix.type = 'button';
  fix.dataset.page = tr.fix?.page ?? '';
  fix.addEventListener('click', () => onFix?.(tr.fix?.page));
  row.append(fix);
  if (tr.retry && onRetry) {
    const again = el('button', 'ghost small', t('Try again'));
    again.type = 'button';
    again.addEventListener('click', async () => {
      again.disabled = fix.disabled = true;
      again.textContent = t('Trying again…');
      try {
        await onRetry(box);
      } finally {
        again.disabled = fix.disabled = false;
        again.textContent = t('Try again');
      }
    });
    row.append(again);
  }
  box.append(row);
  if (detail && detail !== tr.text) {
    const more = el('details', 'trouble-more muted small');
    more.append(el('summary', '', t('Details')), el('span', '', detail));
    box.append(more);
  }
  return box;
}
