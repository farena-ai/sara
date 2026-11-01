// Phase 114 (PL1c, docs/design/POLISH.md §3.4 and §4): small choices as segment buttons or choice
// cards instead of a slider or a pick-list. The original <input type=range> or <select> stays in the
// page (hidden) with its id, tip and listeners, so saving, tours and tests keep working; the buttons
// set its value and send the same input/change events.
import { changedByHand } from './dialogs.js';

/**
 * Turns a range or a select into choices.
 *   items: [{ value, label, meaning?, tag? }]   kind: 'seg' (a row of segments) or 'cards' (choice cards)
 * Returns { sync } to call after the code sets the control's value.
 */
export function choices(control, items, { kind = 'seg', label = '' } = {}) {
  const doc = control.ownerDocument;
  const box = doc.createElement('div');
  box.className = kind === 'cards' ? 'pick-cards kit-cards' : 'seg';
  box.setAttribute('role', 'radiogroup');
  if (label) box.setAttribute('aria-label', label);
  const meaning = doc.createElement('p');
  meaning.className = 'muted small seg-meaning';
  const buttons = items.map((it) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = String(it.value);
    if (kind === 'cards') {
      b.className = 'pick-card kit-card-choice';
      const strong = doc.createElement('strong');
      strong.textContent = it.label;
      b.append(strong);
      if (it.tag) {
        const tag = doc.createElement('span');
        tag.className = 'su-chip kit-tag';
        tag.textContent = it.tag;
        b.append(tag);
      }
      if (it.meaning) {
        const m = doc.createElement('span');
        m.className = 'muted small';
        m.textContent = it.meaning;
        b.append(m);
      }
    } else b.textContent = it.label;
    b.addEventListener('click', () => {
      if (control.value === String(it.value)) return;
      control.value = String(it.value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      changedByHand(control);
      sync();
    });
    return b;
  });
  box.append(...buttons);
  function sync() {
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === String(control.value)));
    const it = items.find((x) => String(x.value) === String(control.value));
    meaning.textContent = kind === 'seg' ? (it?.meaning ?? '') : '';
    meaning.hidden = !meaning.textContent;
  }
  // The control's own label row stays for its tip; the control itself is replaced on screen.
  control.classList.add('kit-replaced');
  (control.closest('label') ?? control).after(box, meaning);
  control.addEventListener('input', sync);
  control.addEventListener('change', sync);
  sync();
  return { sync, box };
}
