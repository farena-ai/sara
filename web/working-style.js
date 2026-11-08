// C12 (docs/ops/C12_DESIGN.md): Memory → How she works with you. Each belief she holds about how he
// likes to work: the claim, where it holds, how sure she is, how often she saw it (message ids only,
// never copied text), with Confirm / Not true / Forget.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

export function initWorkingStyle(c) {
  ctx = c;
  $('#ws-on')?.addEventListener('change', () => void save($('#ws-on').checked));
}

async function save(on) {
  try {
    await ctx.api('/working-style', { method: 'PUT', body: { on } });
  } catch (e) {
    alert(e.message);
  }
  await loadWorkingStyle();
}

/** The claim in his language (the server sends only the trait, the value and the domain). */
function claim(b) {
  const d = b.domain;
  const say = {
    'reply-length:short': () => t('You prefer short answers'),
    'reply-length:long': () => t('You like fuller, detailed answers'),
    'options:one': () => t('You like one clear recommendation'),
    'options:options': () => t('You like a few options to choose from'),
    'ask-first:ask': () => t('Ask you before acting'),
    'ask-first:go': () => t('Go ahead on routine steps without asking'),
    'formality:casual': () => t('A casual tone'),
    'formality:formal': () => t('A formal, professional tone'),
    'feedback:direct': () => t('Direct, blunt feedback'),
    'feedback:gentle': () => t('Gentle feedback'),
    'expertise:new': () => t('You are new to {domain}', { domain: d }),
    'expertise:expert': () => t('You know {domain} well', { domain: d }),
    'hours:morning': () => t('You usually write in the morning'),
    'hours:afternoon': () => t('You usually write in the afternoon'),
    'hours:evening': () => t('You usually write in the evening'),
    'hours:night': () => t('You usually write late at night'),
  }[`${b.trait}:${b.value}`];
  return say ? say() : `${b.trait}: ${b.value}`;
}

const STATUS = {
  candidate: () => t('Noticed once'),
  held: () => t('She goes by this'),
  confirmed: () => t('You confirmed it'),
  contested: () => t('Not sure any more: she will ask'),
  retired: () => t('Not used'),
};

function where(b) {
  const bits = [];
  if (b.scope === 'project') bits.push(t('in one project'));
  else if (b.scope === 'channel') bits.push(t('on {channel}', { channel: b.scopeKey }));
  if (b.side === 'work') bits.push(t('at work'));
  return bits.join(', ');
}

function row(b) {
  const li = el('li', 'ws-item');
  li.append(el('strong', 'small', claim(b)));
  const facts = [STATUS[b.status]?.() ?? b.status, t('{n}% sure', { n: Math.round(b.confidence * 100) }), b.evidenceFor === 1 ? t('seen once') : t('seen {n} times in {s} chats', { n: b.evidenceFor, s: b.sessions })];
  if (b.evidenceAgainst) facts.push(b.evidenceAgainst === 1 ? t('once the other way') : t('{n} times the other way', { n: b.evidenceAgainst }));
  if (b.stated) facts.push(t('you said so'));
  const w = where(b);
  if (w) facts.push(w);
  li.append(el('p', 'muted small', facts.join(' · ')));
  const acts = el('div', 'rt-more-acts');
  const go = async (path, method) => {
    try {
      await ctx.api(`/working-style/${b.id}${path}`, method === 'DELETE' ? { method } : { method, body: {} });
    } catch (e) {
      alert(e.message);
    }
    await loadWorkingStyle();
  };
  if (b.status !== 'confirmed') acts.append(btn(t('Confirm'), 'ghost small', () => void go('/confirm', 'POST')));
  if (b.status !== 'retired') acts.append(btn(t('Not true'), 'ghost small', () => void go('/deny', 'POST')));
  acts.append(btn(t('Forget'), 'ghost small', () => void go('', 'DELETE')));
  li.append(acts);
  return li;
}

export async function loadWorkingStyle() {
  if (!ctx || !$('#ws-on')) return;
  let d;
  try {
    d = await ctx.api('/working-style');
  } catch (e) {
    $('#ws-status').textContent = e.message;
    return;
  }
  $('#ws-on').checked = d.settings.on && !d.pinned;
  $('#ws-on').disabled = d.pinned;
  $('#ws-list').replaceChildren(...d.beliefs.map(row));
  $('#ws-status').textContent = d.pinned ? t('Turned off by your admin.') : d.beliefs.length ? '' : t('Nothing yet. She notices how you like to work as you talk.');
}
