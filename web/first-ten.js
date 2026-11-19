// W2.2 the first ten minutes (docs/design/W2FIRST.md): the parts of the guided setup window
// (web/get-started.js) that need more than one button. The model step looks at this computer and
// offers the right way (graphics card, processor or a free cloud model) with one click for the free
// local option (it only downloads after that click, through the existing /api/local-models/pull);
// the chat step is a compact Where do you text? with Send me a test; the end screen has three quick
// wins tailored to what is connected. Words: web/get-started-words.js.
import { t } from './naming.js';
import { chatWords, modelWords, pathWords, winsWords, winWords } from './get-started-words.js';

const WHERE_KEY = 'sara.where.defaults';
/** The picker's apps when /plugins/where can't answer (no plugin manager): same order and pages as src/plugins/where-text.ts. */
const WHERE_FALLBACK = [
  { id: 'imessage', name: 'iMessage', page: 'co-imessage' },
  { id: 'whatsapp', name: 'WhatsApp', page: 'co-whatsapp' },
  { id: 'signal', name: 'Signal', page: 'co-signal' },
  { id: 'telegram', name: 'Telegram', page: 'co-telegram' },
  { id: 'discord', name: 'Discord', page: 'co-discord' },
  { id: 'matrix', name: 'Matrix', page: 'co-matrix' },
  { id: 'slack', name: 'Slack', page: 'co-slack' },
  { id: 'teams', name: 'Microsoft Teams', page: 'co-teams' },
  { id: 'email', name: 'Email', page: 'co-email' },
];
let pollTimer = 0;

/** Stops a running progress poll (the window closed or moved on). */
export function stopFirstTen() {
  clearTimeout(pollTimer);
  pollTimer = 0;
}

// ---------------------------------------------------------------- the model step

/**
 * Draws the hardware line and the ways to run a model into `body`; returns the main button.
 * h: { api, el, button, openPage(page), after(), repaint() }.
 */
export async function paintModel(body, h) {
  const mw = modelWords(t);
  const box = h.el('div', 'ft-model');
  const wait = h.el('p', 'muted small', mw.looking);
  box.append(wait);
  body.append(box);
  const data = await h.api('/get-started/model').catch(() => null);
  if (!data) {
    wait.remove();
    return null;
  }
  const hw = data.hardware ?? {};
  const machine = h.el('div', 'ft-machine');
  machine.append(h.el('strong', '', mw.machine));
  const lines = h.el('ul', 'ft-hw small');
  lines.append(h.el('li', '', hw.gpu ? mw.gpu(hw.gpu.name, hw.gpu.vramGb) : hw.appleSilicon ? mw.gpu('Apple silicon', hw.budgetGb) : mw.noGpu));
  lines.append(h.el('li', '', mw.ram(hw.ramGb)));
  if (hw.cpu?.name) lines.append(h.el('li', '', mw.cores(hw.cpu.name, hw.cpu.cores)));
  machine.append(lines);
  const plan = data.plan;
  let chosen = plan.path;
  const group = h.el('div', 'ft-paths');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', mw.machine);
  const note = h.el('p', 'muted small ft-note');
  const status = h.el('p', 'small ft-status');
  status.setAttribute('role', 'status');
  const bar = h.el('div', 'gs-bar ft-bar');
  bar.hidden = true;
  const fill = h.el('span', 'gs-bar-fill');
  bar.append(fill);
  const main = h.button('', 'gs-main', () => run());
  const extra = h.el('div', 'ft-extra');

  function paintPaths() {
    group.replaceChildren();
    for (const p of plan.paths) {
      const pw = pathWords(p, t);
      const on = p === chosen;
      const b = h.el('button', `ft-path gs-pack${on ? ' on' : ''}`);
      b.type = 'button';
      b.dataset.path = p;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      const head = h.el('span', 'gs-pack-title', pw.title);
      if (p === plan.path) head.append(' ', h.el('span', 'gs-badge', mw.best));
      const opt = plan.options?.[p];
      b.append(head, h.el('span', 'gs-pack-text muted small', pw.text));
      if (opt && p !== 'cloud') b.append(h.el('span', 'ft-model-name small', `${opt.model.model} · ${opt.model.sizeGb} GB`));
      b.addEventListener('click', () => {
        chosen = p;
        paintPaths();
        paintMain();
      });
      group.append(b);
    }
  }
  function paintMain() {
    const opt = plan.options?.[chosen] ?? { action: 'cloud' };
    extra.replaceChildren();
    main.disabled = false;
    if (opt.action === 'cloud') {
      main.textContent = mw.cloud;
      note.textContent = '';
    } else if (opt.action === 'use') {
      main.textContent = mw.use(opt.use);
      note.textContent = '';
    } else if (opt.action === 'download') {
      main.textContent = mw.download(opt.model.model, opt.model.sizeGb);
      note.textContent = mw.downloadNote;
    } else {
      main.textContent = mw.getOllama;
      note.textContent = mw.getOllamaNote;
      extra.append(h.button(mw.check, 'ghost small', () => h.repaint()));
    }
  }
  async function run() {
    const opt = plan.options?.[chosen] ?? { action: 'cloud' };
    if (opt.action === 'cloud') return h.openPage('models-default');
    if (opt.action === 'get-ollama') return void window.open(data.download, '_blank', 'noopener');
    main.disabled = true;
    try {
      if (opt.action === 'use') {
        await h.api('/local-models/use', { method: 'POST', body: { model: opt.use } });
        status.textContent = mw.ready(opt.use);
        return void (await h.after());
      }
      await h.api('/local-models/pull', { method: 'POST', body: { model: opt.model.model } });
      watch(opt.model.model);
    } catch (err) {
      status.textContent = err.message;
      main.disabled = false;
    }
  }
  function watch(model) {
    bar.hidden = false;
    const cancel = h.button(mw.cancel, 'ghost small', async () => {
      await h.api('/local-models/pull', { method: 'DELETE' }).catch(() => undefined);
    });
    extra.replaceChildren(cancel);
    const tick = async () => {
      if (!box.isConnected) return stopFirstTen();
      const r = await h.api('/local-models/pull').catch(() => null);
      const p = r?.pull;
      if (!p || p.model !== model) return void (pollTimer = setTimeout(tick, 1500));
      const n = p.percent ?? 0;
      fill.dataset.n = String(Math.min(4, Math.floor(n / 25)));
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(n));
      status.textContent = mw.progress(n);
      if (p.state === 'running') return void (pollTimer = setTimeout(tick, 1500));
      bar.hidden = true;
      extra.replaceChildren();
      if (p.state === 'done') {
        status.textContent = mw.ready(model);
        return void (await h.after());
      }
      status.textContent = p.error ?? '';
      main.disabled = false;
    };
    stopFirstTen();
    void tick();
  }
  // A download already running (the window was closed and opened again): show its progress.
  wait.remove();
  box.append(machine, group, note, bar, status, extra);
  paintPaths();
  paintMain();
  if (data.pull?.state === 'running') {
    main.disabled = true;
    watch(data.pull.model);
  }
  return main;
}

// ---------------------------------------------------------------- the chat step

/** Where do you text?, compact: the apps as buttons (not done) or Send me a test (done). */
export async function paintChat(body, step, h) {
  const cw = chatWords(t);
  const box = h.el('div', 'ft-chat');
  body.append(box);
  const out = h.el('p', 'small ft-status');
  out.setAttribute('role', 'status');
  if (step.state === 'done') {
    const w = await h.api('/get-started/wins').catch(() => null);
    const name = w?.chat;
    if (!name) return null;
    box.append(h.el('p', 'muted small', cw.linked(name)));
    const test = h.button(cw.test, 'ghost', async (b) => {
      b.disabled = true;
      try {
        if (name === 'Telegram' || name === 'Discord') {
          await h.api(`/bridges/${name.toLowerCase()}/test-picture`, { method: 'POST', body: {} });
          out.textContent = cw.sent(name);
        } else {
          const where = await h.api('/plugins/where');
          const row = (where.apps ?? []).find((a) => a.name === name);
          const r = await h.api('/plugins/where/send-test', { method: 'POST', body: { app: row?.id ?? '' } });
          out.textContent = r.ok ? cw.sent(name) : t('The message did not go out. Press Check to see why.');
        }
      } catch (err) {
        out.textContent = err.message;
      }
      b.disabled = false;
    });
    test.classList.add('ft-test');
    box.append(test, out);
    return null;
  }
  const where = await h.api('/plugins/where').catch(() => null);
  const apps = where?.apps?.length ? where.apps : WHERE_FALLBACK;
  const grid = h.el('div', 'ft-apps');
  for (const a of apps) {
    if (a.available === false) continue;
    const b = h.button(a.name, 'ghost ft-app', async () => {
      try {
        const r = where ? await h.api('/plugins/where/pick', { method: 'POST', body: { app: a.id } }) : { page: a.page };
        try {
          sessionStorage.setItem(WHERE_KEY, JSON.stringify({ app: a.id, defaults: r.defaults ?? {} }));
        } catch {
          /* private mode: the page starts empty */
        }
        await h.openPage(r.page ?? a.page);
      } catch (err) {
        out.textContent = err.message;
      }
    });
    b.dataset.app = a.id;
    grid.append(b);
  }
  box.append(grid, out);
  return null;
}

// ---------------------------------------------------------------- the end screen

/** Three quick wins; `go(prompt)` starts one in a new chat. */
export async function winsBox(h, go) {
  const ww = winsWords(t);
  const box = h.el('div', 'ft-wins');
  const data = await h.api('/get-started/wins').catch(() => null);
  if (!data?.wins?.length) return box;
  box.append(h.el('strong', 'ft-wins-title', ww.title), h.el('p', 'muted small', ww.text));
  const list = h.el('div', 'ft-win-list');
  for (const w of data.wins) {
    const words = winWords(w, t);
    if (!words) continue;
    const b = h.el('button', 'ft-win gs-pack');
    b.type = 'button';
    b.dataset.win = w.id;
    b.append(h.el('span', 'gs-pack-title', words.title), h.el('span', 'gs-pack-text muted small', words.prompt));
    b.addEventListener('click', () => void go(words.prompt));
    list.append(b);
  }
  box.append(list);
  return box;
}
