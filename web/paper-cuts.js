// P3FIXES (docs/design/POLISH_FIXES.md): small helpers behind the polish pass's functional fixes.
// No imports and no top-level DOM use: tests load this file directly.

/** Unsent text per chat, kept in this browser tab (sessionStorage), never for off-the-record chats. */
export const DRAFT_KEY = 'sara.drafts';
export const DRAFT_MAX = 40;
export class Drafts {
  #s;
  constructor(storage) {
    this.#s = storage;
  }
  #all() {
    try {
      const v = JSON.parse(this.#s?.getItem(DRAFT_KEY) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  get(id) {
    if (!id) return '';
    const v = this.#all()[id];
    return typeof v?.text === 'string' ? v.text : '';
  }
  set(id, text, now = Date.now()) {
    if (!id) return;
    const all = this.#all();
    const s = String(text ?? '');
    if (s.trim()) all[id] = { text: s.slice(0, 20000), at: now };
    else if (!(id in all)) return;
    else delete all[id];
    for (const k of Object.keys(all).sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0)).slice(DRAFT_MAX)) delete all[k];
    try {
      this.#s?.setItem(DRAFT_KEY, JSON.stringify(all));
    } catch {
      /* storage full or blocked: the draft just isn't kept */
    }
  }
}

/** A message's time; with the day when it isn't today ("Yesterday, 9:30 PM", "Nov 12, 8:00 AM"). */
export function msgWhen(d, now, loc) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  let day;
  if (d.toDateString() === y.toDateString()) {
    const w = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }).format(-1, 'day');
    day = w.charAt(0).toLocaleUpperCase(loc) + w.slice(1);
  } else day = d.toLocaleDateString(loc, d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

/** Keys inside a small pop-up menu: Esc closes it (focus back to its button), arrows/Home/End move. */
export function menuKeys(menu, e, active = globalThis.document?.activeElement) {
  if (!menu?.isConnected) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    menu.remove();
    menu._anchor?.focus?.();
    return true;
  }
  const items = [...menu.querySelectorAll('.pop-item')];
  if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return false;
  e.preventDefault();
  const at = items.indexOf(active);
  const n = items.length;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowDown' ? (at + 1) % n : at <= 0 ? n - 1 : at - 1;
  items[next].focus();
  return true;
}

/** Shortcuts added in the polish pass: Ctrl/⌘+Shift+O a new chat, Shift+Esc back to the message box. */
export function extraShortcut(e) {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyO') return 'new';
  if (e.key === 'Escape' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return 'focus';
  return null;
}

/** Runs `fn` with the button disabled (aria-busy), once at a time: a second press while it runs does nothing. */
export async function busy(btn, fn) {
  if (!btn || btn.disabled) return undefined;
  btn.disabled = true;
  btn.setAttribute?.('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute?.('aria-busy');
  }
}
