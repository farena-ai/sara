// One way every popup window behaves (Phase 15):
// - close with the ✕ in the corner, Esc, or a click outside the window;
// - a save shows "Saved ✓" and keeps the window open;
// - windows with autoSave() save by themselves: a choice, switch or slider right away, typed text
//   when you leave the box (and anything left over when the window closes). No Save button.
// - closing with changes that couldn't be saved asks first (Save / Discard / Keep editing).
// Windows register their save function with `onSave(dialog, fn)`; anything typed or changed
// inside a registered window marks it unsaved until it is saved.
import { t } from './naming.js';
import { icon } from './icons.js';

const saves = new WeakMap();
const dirty = new WeakSet();
/** Windows that save by themselves, with their pending timer and running save. */
const autos = new WeakMap();

/** Inputs that never count as unsaved changes (search boxes, filters, file pickers). */
const IGNORE = 'input[type=search], input[type=file], [data-nodirty], [data-nodirty] *';

function isDirtyTarget(t) {
  return t instanceof Element && (t.matches('input, select, textarea') || t.isContentEditable) && !t.matches(IGNORE);
}

/** Registers the function that saves this window (used by Save and the unsaved-changes bar). */
export function onSave(dialog, fn) {
  saves.set(dialog, fn);
}

export const isDirty = (dialog) => dirty.has(dialog);
/** Marks a window unsaved for changes made by buttons/cards (not typing); autosaving windows save soon. */
export const markDirty = (dialog) => {
  dirty.add(dialog);
  if (autos.has(dialog)) saveSoon(dialog);
};
export const markClean = (dialog) => {
  dirty.delete(dialog);
  dialog.querySelector('.unsaved-bar')?.remove();
};

/** Shows "Saved ✓" in the window's corner for a moment and clears the unsaved state. */
export function saved(dialog, text = 'Saved ✓') {
  markClean(dialog);
  let tag = dialog.querySelector(':scope > .dialog-top > .saved-tag');
  if (!tag) {
    tag = document.createElement('span');
    tag.className = 'saved-tag';
    tag.setAttribute('role', 'status');
    top(dialog).append(tag);
  }
  tag.textContent = text;
  tag.classList.remove('show');
  void tag.offsetWidth; // restart the fade
  tag.classList.add('show');
}

/** Runs a window's save function; shows Saved ✓ or the error. Returns true when it saved. */
export async function runSave(dialog) {
  const a = autos.get(dialog);
  if (!a) return saveNow(dialog);
  // Autosaving windows: one save at a time; a change made during a save gets one more save after.
  clearTimeout(a.timer);
  if (a.running) {
    a.again = true;
    return a.running;
  }
  a.running = (async () => {
    let ok;
    do {
      a.again = false;
      ok = await saveNow(dialog);
    } while (a.again);
    a.running = null;
    return ok;
  })();
  return a.running;
}

/** Phase 114 (PL1c): a control changed by code for the person (segment buttons, choice cards) saves like a trusted change. */
export function changedByHand(node) {
  const dialog = node.closest('dialog');
  if (!dialog || !autos.has(dialog) || node.closest('[data-noauto]')) return;
  dirty.add(dialog);
  saveSoon(dialog);
}

function saveSoon(dialog, ms = 350) {
  const a = autos.get(dialog);
  clearTimeout(a.timer);
  a.timer = setTimeout(() => void runSave(dialog), ms);
}

async function saveNow(dialog) {
  const fn = saves.get(dialog);
  if (!fn) return true;
  try {
    const r = await fn();
    if (r === false) return false; // the save function showed its own error
    saved(dialog);
    return true;
  } catch (err) {
    saved(dialog, t('Not saved: {message}', { message: err.message }));
    dialog.querySelector(':scope > .dialog-top > .saved-tag')?.classList.add('error');
    dirty.add(dialog);
    return false;
  }
}

function askBeforeClose(dialog) {
  if (dialog.querySelector('.unsaved-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'unsaved-bar';
  bar.setAttribute('role', 'alertdialog');
  bar.append(Object.assign(document.createElement('span'), { textContent: t('You have changes that aren’t saved.') }));
  const btn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    bar.append(b);
    return b;
  };
  if (saves.has(dialog)) {
    btn(t('Save and close'), '', async () => {
      if (await runSave(dialog)) dialog.close('saved');
    }).focus();
  }
  btn(t('Discard'), 'ghost', () => {
    markClean(dialog);
    dialog.close('discard');
  });
  btn(t('Keep editing'), 'ghost', () => bar.remove());
  dialog.append(bar);
}

/** Closes unless there are unsaved changes (then asks). Autosaving windows save first. */
export async function requestClose(dialog) {
  const a = autos.get(dialog);
  if (a && (dirty.has(dialog) || a.running)) {
    // The box being typed in may not have sent its change yet: leaving it does.
    if (dialog.contains(document.activeElement)) document.activeElement.blur();
    if (!(await runSave(dialog))) return askBeforeClose(dialog);
    markClean(dialog);
    return dialog.close('saved');
  }
  if (dirty.has(dialog) && saves.has(dialog)) return askBeforeClose(dialog);
  markClean(dialog);
  dialog.close('cancel');
}

/** A zero-height strip pinned to the top of the window: holds the ✕ and "Saved ✓" while it scrolls. */
function top(dialog) {
  let bar = dialog.querySelector(':scope > .dialog-top');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'dialog-top';
    dialog.prepend(bar);
  }
  return bar;
}

function wire(dialog) {
  if (dialog.dataset.wired) return;
  dialog.dataset.wired = '1';
  // Windows that need an answer (e.g. a one-time question) have no ✕ and ignore Esc/outside clicks.
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dialog-x ghost';
  x.setAttribute('aria-label', t('Close'));
  x.title = t('Close (Esc)');
  x.append(icon('close') ?? '✕');
  x.addEventListener('click', () => requestClose(dialog));
  // Windows with their own quiet close in the header (data-nox, e.g. setup's "Set up later") skip the ✕.
  if (!dialog.dataset.required && !('nox' in dialog.dataset)) top(dialog).append(x);
  // Esc
  dialog.addEventListener('cancel', (e) => {
    if (dialog.dataset.required) return e.preventDefault(); // e.g. the required first-run steps
    if (autos.has(dialog)) {
      e.preventDefault();
      void requestClose(dialog);
    } else if (dirty.has(dialog) && saves.has(dialog)) {
      e.preventDefault();
      askBeforeClose(dialog);
    } else markClean(dialog);
  });
  // A click on the dimmed area outside the window. (Press and release both outside, so dragging
  // a text selection out of the window doesn't close it.)
  let downOutside = false;
  const outside = (e) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dialog.addEventListener('pointerdown', (e) => (downOutside = outside(e)));
  dialog.addEventListener('click', (e) => {
    if (downOutside && outside(e) && !dialog.dataset.required) requestClose(dialog);
    downOutside = false;
  });
  const mark = (e) => {
    // Only the owner's own edits count (not values the app fills in).
    if (e.isTrusted && isDirtyTarget(e.target) && dialog.open) dirty.add(dialog);
  };
  dialog.addEventListener('input', mark);
  dialog.addEventListener('change', mark);
  dialog.addEventListener('close', () => markClean(dialog));
  // <form method="dialog">: Enter in a text box must not close the window, and old-style
  // Close/Cancel buttons go through the same unsaved-changes check as the ✕.
  dialog.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.method !== 'dialog') return;
    const by = e.submitter;
    if (!by) return e.preventDefault();
    if (by.value === 'close' || by.value === 'cancel') {
      e.preventDefault();
      requestClose(dialog);
    }
  });
}

/** Wires every <dialog> on the page (and any added later), and starts each one clean. */
export function initDialogs() {
  for (const d of document.querySelectorAll('dialog')) wire(d);
  const show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function showModal() {
    wire(this);
    markClean(this);
    this.querySelector(':scope > .dialog-top > .saved-tag')?.classList.remove('show', 'error');
    return show.call(this);
  };
}

/**
 * The window saves by itself (no Save button): a pick-list, switch, slider or radio right after
 * it changes; typed text when the owner leaves the box (the browser's change event), never per
 * keystroke (a half-typed name or token would be saved). Parts with their own button are marked
 * data-noauto.
 */
export function autoSave(dialog) {
  autos.set(dialog, { timer: 0, running: null, again: false });
  dialog.addEventListener('change', (e) => {
    const t = e.target;
    if (!e.isTrusted || !isDirtyTarget(t) || t.closest('[data-noauto]') || hasOwnButton(t)) return;
    saveSoon(dialog);
  });
}

/** A text box in a row with its own button (Add, Save, Connect…) is that button's job. */
function hasOwnButton(t) {
  if (!t.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])')) return false;
  const row = t.closest('.add-row, p');
  return Boolean(row && dialogOf(row) && row.querySelector('button:not(.tip)'));
}
const dialogOf = (n) => n.closest('dialog');
