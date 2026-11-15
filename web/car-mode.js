// N5b: car mode (docs/PHONE.md "Car mode"). One big Talk button, her answers spoken and short, no
// screens of text: the chat stays behind a full-screen dialog. Each message she gets in car mode
// carries `car: true`, so the server keeps her to two spoken sentences, leaves out computer use and
// long tasks, and has her newest messages ready to read aloud on request. It switches off by itself
// after 2 hours without use. Say or type "car mode" / "car mode off" to switch it.
import { t } from './naming.js';

const KEY = 'sara.car';
const SPEAK = 'sara.speak';
export const CAR_IDLE_MS = 2 * 3600_000;
// The same words as the server's CAR_ON_RE / CAR_OFF_RE (src/phone-actions.ts).
const NAMES = '(?:car mode|driving mode|modo (?:coche|carro|conducción)|mode voiture|automodus|auto-modus|modalità auto)';
const ON_RE = new RegExp(`^\\s*(?:(?:turn on|start|enable)\\s+)?${NAMES}(?:\\s+on)?\\s*[.!]?\\s*$`, 'i');
const OFF_RE = new RegExp(`^\\s*(?:(?:turn off|stop|exit|end|disable)\\s+)${NAMES}\\s*[.!]?\\s*$|^\\s*(?:car mode|driving mode)\\s+off\\s*[.!]?\\s*$`, 'i');

const store = globalThis.localStorage;
const read = () => {
  try {
    return JSON.parse(store?.getItem(KEY) ?? 'null') ?? { on: false, at: 0 };
  } catch {
    return { on: false, at: 0 };
  }
};

/** On, and used within the last 2 hours (otherwise it switches itself off). */
export function carOn(now = Date.now()) {
  const s = read();
  if (s.on && now - Number(s.at || 0) > CAR_IDLE_MS) {
    setCar(false);
    return false;
  }
  return Boolean(s.on);
}
/** A message in car mode counts as use. */
export function touchCar(now = Date.now()) {
  if (read().on) store?.setItem(KEY, JSON.stringify({ ...read(), at: now }));
}
/** "car mode" / "car mode off" said or typed: 'on', 'off' or null. */
export function carCommand(text) {
  const s = String(text ?? '');
  if (OFF_RE.test(s)) return 'off';
  if (ON_RE.test(s)) return 'on';
  return null;
}

let view = null;
export function setCar(on, now = Date.now()) {
  const was = read();
  if (on && !was.on) store?.setItem(KEY, JSON.stringify({ on: true, at: now, speak: store?.getItem(SPEAK) ?? '0' }));
  else if (!on && was.on) {
    store?.setItem(KEY, JSON.stringify({ on: false, at: now }));
    // Her voice goes back to what it was before car mode.
    store?.setItem(SPEAK, was.speak === '1' ? '1' : '0');
  }
  if (on) store?.setItem(SPEAK, '1');
  view?.sync();
}

/**
 * The dialog: `talk()` presses the message box's microphone (start, then send), `recording()` says
 * whether it listens, `voiceReady()` whether her voice is set up.
 */
export function initCarMode({ talk, recording, voiceReady }) {
  const dlg = globalThis.document?.querySelector('#car-mode');
  if (!dlg) return;
  const btn = dlg.querySelector('#car-talk');
  const label = dlg.querySelector('#car-talk-label');
  const status = dlg.querySelector('#car-status');
  const sync = () => {
    const on = carOn();
    if (on && !dlg.open) dlg.showModal();
    if (!on && dlg.open) dlg.close();
    const rec = recording();
    const speaking = document.documentElement.dataset.herState === 'speaking';
    btn.classList.toggle('car-listening', rec);
    label.textContent = rec ? t('Listening… tap to send') : t('Talk');
    btn.setAttribute('aria-pressed', String(rec));
    status.textContent = !voiceReady() ? t('Set up her voice first: Settings → Sara → Voice.') : rec ? t('I’m listening.') : speaking ? t('She’s answering.') : t('Tap Talk and say what you need.');
  };
  view = { sync };
  btn.addEventListener('click', () => {
    touchCar();
    if (!voiceReady()) return sync();
    talk();
    setTimeout(sync, 50);
  });
  dlg.querySelector('#car-exit').addEventListener('click', () => setCar(false));
  // Closed any other way (the app's own dialog handling): car mode ends too.
  dlg.addEventListener('close', () => carOn() && setCar(false));
  // Esc closes the dialog: that ends car mode too.
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    setCar(false);
  });
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-her-state'] });
  const mic = document.querySelector('#mic');
  if (mic) new MutationObserver(sync).observe(mic, { attributes: true, attributeFilter: ['class'] });
  setInterval(() => carOn() || !dlg.open || sync(), 60_000);
  sync();
}
export const carModeSync = () => view?.sync();

// R5 (docs/PHONE_CALLS.md "Car mode errands"): "approve" / "no" said in car mode answer the card that
// waits in this chat, when a phone may answer it (the server checks: computer use stays on the
// computer). The same words as approvalWord in src/phone-calls.ts.
const YES_RE = /^\s*(?:approve|approved|yes(?:,? do it)?|ok(?:ay)?,? do it|go ahead|allow( it)?|aprueba|apruebo|s[ií],? hazlo|adelante|approuve|j'approuve|oui,? vas-y|genehmigen|genehmigt|ja,? mach(?: es)?|aprovar|aprovo|sim,? pode|approva|approvo|s[iì],? fallo|vai)\s*[.!]*\s*$/i;
const NO_RE = /^\s*(?:decline|deny|no|don'?t|cancel|rechaza|no lo hagas|refuse|non|ablehnen|nein|recusar|n[aã]o|rifiuta|annulla)\s*[.!]*\s*$/i;
/** 'approve', 'decline' or null. */
export function approvalCommand(text) {
  const s = String(text ?? '');
  if (YES_RE.test(s)) return 'approve';
  if (NO_RE.test(s)) return 'decline';
  return null;
}
/**
 * In car mode with a card waiting in this chat: answers it by voice and says the outcome. Returns
 * true when the words were an answer (they are never sent to her as a message).
 */
export async function carAnswer(text, { api, conversationId, waiting, say }) {
  const word = approvalCommand(text);
  if (!word || !conversationId || !waiting) return false;
  try {
    const r = await api('/car/answer', { method: 'POST', body: { conversationId, approved: word === 'approve' } });
    say?.(r.line);
  } catch (err) {
    say?.(err.message);
  }
  return true;
}
