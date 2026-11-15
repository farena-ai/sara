// R7: Settings → Household → People on this server → Tools for household members. Rules for
// Everyone or one person: each tool family allowed as usual, always ask first, or off; every tool
// asks first; a daily cap for paid tools. The server enforces them (src/member-tools.ts); this
// section only shows and saves what it says.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
const FAMILIES = ['computer', 'mail-send', 'web', 'errands', 'automations'];
/** @type {{ api: (path: string, o?: object) => Promise<any> } | null} */
let ctx = null;
let view = null;

const status = (text) => {
  const s = $('#hmt-status');
  if (s) s.textContent = text;
};
const money = (n) => (n ? t('${usd} a day', { usd: n.toFixed(2) }) : t('No extra cap'));
const NAMES = () => ({ computer: t('Computer use'), 'mail-send': t('Sending email'), web: t('Web search and reading'), errands: t('Errands'), automations: t('Automations') });

export function initMemberTools(c) {
  ctx = c;
  $('#hmt-who')?.addEventListener('change', () => fill());
  for (const f of FAMILIES) $(`#hmt-${f}`)?.addEventListener('change', () => void save());
  $('#hmt-ask')?.addEventListener('change', () => void save());
  $('#hmt-spend')?.addEventListener('change', () => void save());
  const page = document.querySelector('.settings-page[data-page="household"]');
  if (page) new MutationObserver(() => !page.hidden && void load()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

async function load() {
  if (!ctx || !$('#hmt-box')) return;
  try {
    view = await ctx.api('/member-tools');
  } catch (e) {
    status(e.message);
    return;
  }
  const who = $('#hmt-who');
  const keep = who.value;
  who.replaceChildren(new Option(t('Everyone'), ''), ...view.people.map((p) => new Option(p.name, p.id)));
  who.value = view.people.some((p) => p.id === keep) ? keep : '';
  const spend = $('#hmt-spend');
  spend.replaceChildren(...view.spendChoices.map((n) => new Option(money(n), String(n))));
  fill();
}

/** The scope's own rules into the controls ("Same as everyone" for what a person hasn't set). */
function fill() {
  if (!view) return;
  const id = $('#hmt-who').value;
  const rules = id ? (view.rules.members[id] ?? { families: {} }) : view.rules.everyone;
  for (const f of FAMILIES) {
    const sel = $(`#hmt-${f}`);
    const same = sel.querySelector('option[value=""]');
    if (same) same.hidden = !id;
    sel.value = rules.families[f] ?? (id ? '' : 'allow');
  }
  $('#hmt-ask').checked = rules.alwaysAsk ?? (id ? (view.rules.everyone.alwaysAsk ?? false) : false);
  $('#hmt-spend').value = String(rules.spendPerDay ?? (id ? (view.rules.everyone.spendPerDay ?? 0) : 0));
  const p = view.people.find((x) => x.id === id);
  $('#hmt-now').textContent = p ? t('Now for {name}: {list}', { name: p.name, list: FAMILIES.filter((f) => p.effective.families[f] !== 'allow').map((f) => `${NAMES()[f]}: ${p.effective.families[f] === 'off' ? t('off') : t('asks first')}`).join(', ') || t('everything allowed as usual') }) : '';
}

async function save() {
  if (!view) return;
  const id = $('#hmt-who').value;
  const families = {};
  for (const f of FAMILIES) {
    const v = $(`#hmt-${f}`).value;
    if (v) families[f] = v;
  }
  const rules = { families, alwaysAsk: $('#hmt-ask').checked, spendPerDay: Number($('#hmt-spend').value) };
  try {
    view = await ctx.api('/member-tools', { method: 'PUT', body: id ? { members: { [id]: rules } } : { everyone: rules } });
    fill();
    status(t('Saved. It applies from their next step.'));
  } catch (e) {
    status(e.message);
  }
}
