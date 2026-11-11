// 3.5 (PC tools, docs/design/PC_TOOLS.md): her commands on your own computer in the chat. A live
// panel (the command, its output as it comes, Stop) from the computer's `run` events, and the final
// card from pc_run's result (src/cards.ts `pc-run`). Text only (textContent), never HTML.
import { t } from './naming.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
};
const LIVE_MAX = 8000;

/** The final card: which computer, the command, how it ended, the end of its output. */
export function pcRunCard(c, shell) {
  const titles = { done: t('Ran a command on your computer'), stopped: t('Stopped on your computer'), timeout: t('The command took too long and was stopped'), denied: t('You said no on your computer') };
  const tone = c.outcome === 'done' && c.exitCode === 0 ? 'ok' : c.outcome === 'denied' ? '' : 'bad';
  const card = shell('pc-run', 'monitor', titles[c.outcome] ?? titles.done, tone);
  card.append(el('code', 'rc-cmd', c.command));
  const meta = [c.computer ? t('On {computer}', { computer: c.computer }) : '', c.shell === 'cmd' ? 'cmd' : 'PowerShell', c.cwd ?? '', typeof c.exitCode === 'number' ? t('Exit code {code}', { code: c.exitCode }) : '', typeof c.seconds === 'number' ? t('{n} s', { n: c.seconds }) : ''].filter(Boolean).join(' \u00b7 ');
  if (meta) card.append(el('p', 'rc-meta', meta));
  if (c.output) {
    const pre = el('pre', 'rc-output', c.output);
    card.append(pre);
    if (c.truncated) card.append(el('p', 'rc-meta', t('Only the end of the output is shown here.')));
  }
  return card;
}

const live = { id: '', deviceId: '', timer: 0 };

/** A `computer` event with `run`: the live panel for the open chat (asking → running → done). */
export function onPcRunEvent(ev, currentId, { stop } = {}) {
  const box = document.getElementById('pc-run-live');
  if (!box || !ev?.run || (ev.conversationId && ev.conversationId !== currentId)) return;
  const r = ev.run;
  const text = box.querySelector('#pc-run-text');
  const out = box.querySelector('#pc-run-out');
  const stopBtn = box.querySelector('#pc-run-stop');
  if (r.id !== live.id) {
    live.id = r.id;
    live.deviceId = ev.deviceId;
    out.textContent = '';
    box.querySelector('#pc-run-cmd').textContent = r.command ?? '';
    stopBtn.onclick = () => stop?.(live.deviceId);
  }
  clearTimeout(live.timer);
  box.hidden = false;
  stopBtn.hidden = r.state === 'done';
  if (r.state === 'sent' || r.state === 'asking') text.textContent = t('Waiting for your yes on your computer (Allow once, Allow for this task, or Don\u2019t).');
  else if (r.state === 'running') text.textContent = t('Running on your computer\u2026');
  if (typeof r.chunk === 'string') {
    out.textContent = (out.textContent + r.chunk).slice(-LIVE_MAX);
    out.hidden = false;
    out.scrollTop = out.scrollHeight;
  }
  if (r.state === 'done') {
    text.textContent = r.outcome === 'denied' ? t('You said no on your computer.') : r.outcome === 'stopped' ? t('Stopped.') : r.outcome === 'timeout' ? t('Took too long: stopped.') : t('Done.');
    live.timer = setTimeout(() => {
      box.hidden = true;
      live.id = '';
    }, 4000);
  }
}
