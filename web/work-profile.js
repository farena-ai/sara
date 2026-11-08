// EC26 (docs/ops/EC26_DESIGN.md): Settings → Her → At work. Her work profile (name, tone, which
// chats are work, work tools) and the two memory spaces with Copy to work / Copy to personal.
// The server decides and refuses (the admin's workMode pin); this page only shows what it says.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let timer = 0;

export function initWorkProfile(c) {
  ctx = c;
  $('#atw-save')?.addEventListener('click', () => void save());
  $('#atw-space')?.addEventListener('change', () => void loadMemories());
  $('#atw-q')?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadMemories(), 250);
  });
  const page = document.querySelector('.settings-page[data-page="her-work"]');
  if (page) new MutationObserver(() => !page.hidden && void load()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

const status = (text) => {
  const s = $('#atw-status');
  if (s) s.textContent = text;
};

async function load() {
  if (!ctx || !$('#atw-on')) return;
  let d;
  try {
    d = await ctx.api('/work-profile');
  } catch (e) {
    status(e.message);
    return;
  }
  const p = d.profile;
  $('#atw-on').checked = p.on;
  $('#atw-on').disabled = p.pinned;
  $('#atw-pinned').hidden = !p.pinned;
  $('#atw-name').value = p.name;
  $('#atw-tone').value = p.tone;
  $('#atw-workspace').value = p.workspace;
  for (const k of ['research', 'files', 'calendar', 'commands']) $(`#atw-${k}`).checked = p.tools[k];
  for (const box of document.querySelectorAll('.atw-page input[data-channel]')) box.checked = p.channels.includes(box.dataset.channel);
  await loadMemories();
}

async function save() {
  const body = {
    on: $('#atw-on').checked,
    name: $('#atw-name').value.trim(),
    tone: $('#atw-tone').value,
    workspace: $('#atw-workspace').value.trim() || 'work',
    channels: [...document.querySelectorAll('.atw-page input[data-channel]:checked')].map((b) => b.dataset.channel),
    tools: Object.fromEntries(['research', 'files', 'calendar', 'commands'].map((k) => [k, $(`#atw-${k}`).checked])),
  };
  // Under the pin the profile stays on; the server refuses turning it off.
  if ($('#atw-on').disabled) delete body.on;
  try {
    await ctx.api('/work-profile', { method: 'PUT', body });
    status(t('Saved.'));
    await load();
  } catch (e) {
    status(e.message);
  }
}

async function loadMemories() {
  const list = $('#atw-memories');
  if (!list || !ctx) return;
  const space = $('#atw-space').value;
  const q = $('#atw-q').value.trim();
  let d;
  try {
    d = await ctx.api(`/work-profile/memories?space=${space}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  } catch (e) {
    status(e.message);
    return;
  }
  list.replaceChildren();
  if (!d.memories.length) list.append(ctx.el('p', 'muted small', space === 'work' ? t('No work notes yet.') : t('No personal notes found.')));
  for (const m of d.memories) {
    const row = ctx.el('div', 'sl-row');
    const info = ctx.el('div', 'sl-info');
    info.append(ctx.el('span', '', m.content), ctx.el('span', 'muted small', m.happenedOn));
    const copy = ctx.el('button', 'ghost', space === 'work' ? t('Copy to personal') : t('Copy to work'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await ctx.api('/work-profile/copy', { method: 'POST', body: { id: m.id } });
        status(space === 'work' ? t('Copied to your personal notes.') : t('Copied to your work notes.'));
      } catch (e) {
        status(e.message);
      }
    });
    const actions = ctx.el('div', 'dr-actions');
    actions.append(copy);
    row.append(info, actions);
    list.append(row);
  }
}
