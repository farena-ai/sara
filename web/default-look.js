// The built-in looks (src/default-look.ts): Sara (she), a male default (he) and a they/them default.
// Until a custom look exists, the one matching her pronouns shows ("auto"), or the one picked by name
// in Settings → Her → Look. When the pronouns change while a built-in look shows, the owner is asked
// once whether to switch to the matching one; the pictures update at once either way (no reload).
import { t } from './naming.js';

let deps = { api: async () => ({}), onChange: () => {} };
let lastPronouns;

/** Shows the built-in look picker (Settings → Her → Look) from GET /api/look. */
export function renderDefaultLook(l) {
  const sel = document.querySelector('#look-default');
  if (!sel || !l?.defaults) return;
  sel.value = l.defaultLook ?? 'auto';
  const note = document.querySelector('#look-default-note');
  if (note) note.textContent = l.custom ? t('Used again when you go back to the default look.') : '';
}

async function pick(look, offered) {
  const l = await deps.api('/look/default', { method: 'PUT', body: { ...(look ? { look } : {}), ...(offered ? { offered } : {}) } });
  renderDefaultLook(l);
  deps.onChange();
  return l;
}

/** The pronouns changed (a rename or new pronouns): offer the matching built-in look once. */
async function pronounsChanged(pronouns, before) {
  const l = await deps.api('/look').catch(() => null);
  if (!l || l.custom || !l.defaults) return;
  // The look that showed before the change ("auto" followed the old pronouns).
  const shown = l.defaultLook === 'auto' ? (before === 'he' || before === 'they' ? before : 'she') : l.defaultLook;
  if (shown === l.defaultMatch || l.defaultOffered === pronouns) {
    deps.onChange();
    return;
  }
  const label = l.defaults.find((d) => d.id === l.defaultMatch)?.label ?? '';
  const yes = confirm(`${t('Use the matching default look?')}\n${t(label)}`);
  // Yes: the look follows the pronouns from now on. No: the one shown stays, picked by name.
  await pick(yes ? 'auto' : shown, pronouns);
}

/** Wires the picker and follows renames (naming.js fires "sara-identity" on every change). */
export function initDefaultLook(d) {
  deps = { ...deps, ...d };
  document.querySelector('#look-default')?.addEventListener('change', (e) => void pick(e.target.value).catch(() => {}));
  document.addEventListener('sara-identity', (e) => {
    const p = e.detail?.pronouns ?? 'she';
    const before = lastPronouns;
    lastPronouns = p;
    if (before !== undefined && p !== before) void pronounsChanged(p, before).catch(() => {});
  });
}
