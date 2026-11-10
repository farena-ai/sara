// 3.3.0 easy mode (ezplain): the card for a setting she changed when asked (change_setting,
// src/everyday-settings.ts). A device setting (text size, Night or Day, the color, her spoken
// replies) is applied here, once, in the browser that shows the fresh card; the value it replaced is
// kept on this device, so Undo puts it back. The name she calls you is saved on the server; Undo
// saves the old one again. Nothing else can be changed this way.
import { t } from './naming.js';

const KEY = 'sara.everyday';
/** A fresh card applies itself; an old one (a reload, another device) only shows what changed. */
const FRESH_MS = 5 * 60_000;

const LABEL = { text_size: () => t('Text size'), theme: () => t('Night or Day'), color: () => t('Color'), voice: () => t('Her voice'), my_name: () => t('What she calls you') };
const SAY = {
  text_size: { 14: () => t('Small'), 15: () => t('Normal'), 17: () => t('Large'), 19: () => t('Larger') },
  theme: { dark: () => t('Night'), light: () => t('Day'), system: () => t('Follow the system') },
  color: { violet: () => t('Violet (default)'), blue: () => t('Blue'), pink: () => t('Rose'), emerald: () => t('Emerald'), amber: () => t('Amber'), cyan: () => t('Cyan'), green: () => t('Green'), red: () => t('Red'), grey: () => t('Gray'), rose: () => t('Theme color') },
  voice: { on: () => t('On'), off: () => t('Off') },
};
const say = (setting, v) => SAY[setting]?.[v]?.() ?? String(v ?? '');

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const store = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
};
const keep = (all) => {
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - 40))) delete all[id];
  localStorage.setItem(KEY, JSON.stringify(all));
};

/** This device's current value of a setting (the same controls Settings → Appearance uses). */
function current(setting) {
  if (setting === 'voice') return localStorage.getItem('sara.speak') === '1' ? 'on' : 'off';
  const sel = document.querySelector({ text_size: '#ap-size', theme: '#ap-theme', color: '#ap-accent' }[setting]);
  return sel?.value ?? '';
}
/** Sets it through the app's own control, so everything that listens to it updates as usual. */
function apply(setting, value) {
  if (setting === 'voice') {
    if (current('voice') !== value) document.querySelector('#speak-toggle')?.click();
    return;
  }
  const sel = document.querySelector({ text_size: '#ap-size', theme: '#ap-theme', color: '#ap-accent' }[setting]);
  if (!sel) return;
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

export function settingCard(c) {
  const card = el('div', 'rcard rcard-setting');
  card.setAttribute('role', 'group');
  const head = el('div', 'rcard-head');
  const title = el('span', 'rcard-title', t('Changed: {what} → {value}', { what: LABEL[c.setting]?.() ?? c.setting, value: say(c.setting, c.value) }));
  head.append(title);
  card.append(head);
  card.setAttribute('aria-label', title.textContent);
  const all = store();
  let before = all[c.id];
  if (c.device && before === undefined && Date.now() - Date.parse(c.at) < FRESH_MS) {
    before = current(c.setting);
    all[c.id] = before;
    keep(all);
    apply(c.setting, c.value);
  }
  if (!c.device) before = c.from;
  const line = el('p', 'rcard-sub muted small', c.device ? t('On this device. Settings → Appearance has it too.') : t('Saved. Settings → About you has it too.'));
  card.append(line);
  if (before === undefined || before === '' || before === c.value) return card;
  const undo = el('button', 'ghost small rcard-undo', t('Undo'));
  undo.type = 'button';
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    try {
      if (c.device) apply(c.setting, before);
      else {
        const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerName: before }) });
        if (!res.ok) throw new Error(String(res.status));
      }
      line.textContent = t('Put back: {what} → {value}', { what: LABEL[c.setting]?.() ?? c.setting, value: say(c.setting, before) });
      undo.remove();
    } catch {
      undo.disabled = false;
      line.textContent = t("Couldn't undo it. Change it in Settings instead.");
    }
  });
  card.append(undo);
  return card;
}
