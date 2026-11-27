// W0.7 (docs/ALWAYS_ALLOW.md): "Always allow everything", one switch per person. Settings →
// Connections → Computer use → Always allow everything (turn on: the one-time warning, then the
// password/code/passkey again), and the "Always allow is on" badge with Turn off above the composer.
// The server is the source of truth: GET/PUT/DELETE /api/computer/always. Text only (textContent).
import { t } from './naming.js';

let ctx = null;
let view = null;
let timer = 0;
const $ = (s) => document.querySelector(s);

const when = (iso) => {
  try {
    const d = new Date(iso);
    const today = d.toDateString() === new Date().toDateString();
    return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};

const ALW_AWAY_KEY = 'sara.alw.away';

function paint() {
  const v = view;
  const bar = $('#alw-banner');
  if (bar) {
    // Put away with its ×: stays away for this turn-on (a new one, or a new end time, shows it again).
    const sig = v?.on ? String(v.until ?? 'on') : '';
    if (v && !v.on) localStorage.removeItem(ALW_AWAY_KEY);
    bar.hidden = !v?.on || localStorage.getItem(ALW_AWAY_KEY) === sig;
    const txt = $('#alw-banner-text');
    if (txt && v?.on) txt.textContent = v.until ? t('Always allow is on until {time}: she acts without asking.', { time: when(v.until) }) : t('Always allow is on: she acts without asking until you turn it off.');
  }
  const state = $('#alw-state');
  if (!state || !v) return;
  state.textContent = v.on ? (v.until ? t('On until {time}. Every command and computer action runs without a card.', { time: when(v.until) }) : t('On until you turn it off. Every command and computer action runs without a card.')) : v.ended?.why === 'time' ? t('Off: the time ran out.') : t('Off. Her approval cards ask as usual.');
  $('#alw-on').hidden = v.on || !v.may;
  $('#alw-off').hidden = !v.on;
  $('#alw-for').disabled = v.on || !v.may;
  if (!v.on) $('#alw-for').value = v.for || '1h';
  const why = $('#alw-why');
  why.hidden = v.may;
  why.textContent = v.may ? '' : t(v.why || 'Not available here.');
  clearTimeout(timer);
  // Repaint when it runs out (the server turns it off on its own; this only refreshes the page).
  if (v.on && v.until) timer = setTimeout(() => void refreshAlwaysAllow(), Math.min(2 ** 31 - 1, Math.max(1000, Date.parse(v.until) - Date.now() + 1000)));
}

export async function refreshAlwaysAllow() {
  if (!ctx) return;
  try {
    view = await ctx.api('/computer/always');
  } catch {
    view = null;
  }
  paint();
}

function warn() {
  const d = $('#alw-warn');
  if (!d?.showModal) return Promise.resolve(confirm(t('Always allow everything: Sara runs every command and computer action for you without asking first, including payments, account settings and deleting things. Turn it on only if you accept that.')));
  return new Promise((resolve) => {
    const done = (ok) => {
      d.close();
      resolve(ok);
    };
    $('#alw-warn-yes').onclick = () => done(true);
    $('#alw-warn-no').onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}

async function turnOn() {
  const status = $('#alw-status');
  status.textContent = '';
  if (!(await warn())) return;
  try {
    const proof = await ctx.confirmProof();
    if (!proof) return;
    view = await ctx.api('/computer/always', { method: 'PUT', body: { on: true, for: $('#alw-for').value, warned: true, ...proof } });
    status.textContent = t('Always allow is on.');
  } catch (err) {
    status.textContent = err.message;
  }
  paint();
}

export async function turnOffAlwaysAllow() {
  try {
    view = await ctx.api('/computer/always', { method: 'DELETE' });
    const status = $('#alw-status');
    if (status) status.textContent = t('Always allow is off.');
  } catch (err) {
    const status = $('#alw-status');
    if (status) status.textContent = err.message;
  }
  paint();
}

export function initAlwaysAllow(c) {
  ctx = c;
  $('#alw-on')?.addEventListener('click', () => void turnOn());
  $('#alw-off')?.addEventListener('click', () => void turnOffAlwaysAllow());
  $('#alw-banner-off')?.addEventListener('click', () => void turnOffAlwaysAllow());
  $('#alw-banner-x')?.addEventListener('click', () => {
    if (view?.on) localStorage.setItem(ALW_AWAY_KEY, String(view.until ?? 'on'));
    paint();
  });
  void refreshAlwaysAllow();
}
