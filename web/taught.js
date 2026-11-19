// D1 (docs/design/D1TEACH.md): Settings → Skills & tools → Skills → Skills she learns → Shown in your
// browser. The steps you showed the browser extension ("Watch me do this"), waiting for you: read the
// steps, then Save as a skill, Edit first (the skill editor with the draft), Make an automation (the
// skill plus an Automations entry that stays off until you set when it runs) or Delete. Passwords,
// cards and codes were never recorded: those steps only say you type them yourself.
import { serverText, t } from './naming.js';
import { editDraft, loadSkills } from './skills.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.body !== undefined ? 'POST' : 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
const say = (text) => {
  const s = $('#tch-status');
  if (s) s.textContent = text ?? '';
};
const what = (x) => x?.label || x?.text || x?.name || x?.id || x?.tag || '?';

/** One step in words, in the person's language. */
export function stepWords(s) {
  if (s.kind === 'go') return t('Open {url}', { url: s.url });
  if (s.kind === 'click') return t('Click “{what}”', { what: what(s.target) });
  if (s.secret) return t('“{what}”: you type this yourself (not recorded)', { what: what(s.target) });
  if (s.kind === 'pick') return t('Pick “{value}” in “{what}”', { value: s.value ?? '', what: what(s.target) });
  return t('Type “{value}” into “{what}”', { value: s.value ?? '', what: what(s.target) });
}

const when = (iso) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
};
const host = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

function item(v) {
  const card = el('div', 'tch-item');
  const head = el('p', 'tch-head');
  const name = el('strong', '', v.title);
  name.dataset.raw = '';
  head.append(name);
  card.append(head);
  const facts = [t('Shown {day}', { day: when(v.at) }), t('{n} steps', { n: v.steps.length })];
  if (v.startUrl) facts.push(t('starts at {site}', { site: host(v.startUrl) }));
  card.append(el('p', 'muted small', facts.join(' · ')));
  const box = el('details', 'tch-steps');
  box.append(el('summary', '', t('The steps')));
  const ol = el('ol', '');
  for (const s of v.steps) {
    const li = el('li', s.secret ? 'tch-secret' : '', stepWords(s));
    li.dataset.raw = '';
    ol.append(li);
  }
  box.append(ol);
  card.append(box);
  const row = el('div', 'tch-actions');
  const act = async (b, action, draft) => {
    for (const x of row.querySelectorAll('button')) x.disabled = true;
    try {
      const r = await api(`/skills/taught/${encodeURIComponent(v.id)}`, { body: { action, ...(draft ? { draft } : {}) } });
      if (action === 'automation') say(t('Made the automation “{name}”. It is off until you set when it runs in Automations.', { name: r.automation?.name ?? '' }));
      else if (action === 'skill') say(t('Saved as the skill “{name}”.', { name: r.skill?.name ?? '' }));
      else say(t('Deleted.'));
      void loadSkills();
      await loadTaught();
    } catch (err) {
      say(err.message);
      for (const x of row.querySelectorAll('button')) x.disabled = false;
    }
  };
  if (v.skillName) {
    card.append(el('p', 'lsk-done', t('Saved as the skill “{name}”.', { name: v.skillName })));
    row.append(btn(t('Make an automation'), '', (b) => act(b, 'automation')), btn(t('Done'), 'ghost', (b) => act(b, 'discard')));
  } else {
    row.append(
      btn(t('Save as a skill'), '', (b) => act(b, 'skill')),
      btn(t('Edit first'), 'ghost', () => editDraft(v.draft, async (draft) => act(null, 'skill', draft))),
      btn(t('Make an automation'), 'ghost', (b) => act(b, 'automation')),
      btn(t('Delete'), 'ghost danger-text', (b) => act(b, 'discard')),
    );
  }
  card.append(row);
  return card;
}

export async function loadTaught() {
  const list = $('#tch-list');
  if (!list) return;
  try {
    const d = await api('/skills/taught');
    list.replaceChildren(...(d.taught ?? []).map(item));
    if (!d.taught?.length) list.append(el('p', 'muted small', t('Nothing yet. In the browser extension, press Watch me do this and do the task once.')));
  } catch (err) {
    say(err.message);
  }
}
