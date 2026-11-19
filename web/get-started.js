// R2 (docs/GETTING_STARTED.md): the guided setup window, its card on Today, the example cards of
// the sample space with their tour, and the starter packs card in Settings → You → About you.
// Every step opens the existing connect page (Models, Email and calendar, Phone, Devices); when that
// page closes the guide comes back at the same step and ticks what got connected. One main button
// per screen; Skip for now and Back are quiet. Words: web/get-started-words.js. Server:
// src/routes/get-started.ts.
import { t } from './naming.js';
import { icon } from './icons.js';
import { startTour } from './tour.js';
import { paintChat, paintModel, stopFirstTen, winsBox } from './first-ten.js';
import { guideWords, packResultWords, packWords, PACK_IDS, routineName, sampleSectionWords, sampleTour, sampleWords, stepWords } from './get-started-words.js';

const $ = (sel) => document.querySelector(sel);
/** What app.js lends this module (api, el, firstRun, isMember, openSettings, paintFitness, paintTryCards, startWin, state). */
let ctx = null;
let data = null;
/** The guide reopens when the Settings page it opened closes. */
let reopen = false;
let showing = null;

const AUTO_JOBS = ['chat', 'coding', 'vision', 'research'];
const demo = () => document.body.classList.contains('demo');
const el = (...a) => ctx.el(...a);
function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}

async function load() {
  // Today can open before app.js lends its helpers (a start on Today): nothing to draw yet.
  if (!ctx || demo()) return null;
  data = await ctx.api('/get-started').catch(() => null);
  ctx.state.packTry = data?.packs?.current ? data.packs.list.find((p) => p.id === data.packs.current)?.tryCards ?? null : null;
  return data;
}
const send = async (path, method, body) => {
  data = await ctx.api(`/get-started${path}`, { method, body: body ?? {} });
  ctx.state.packTry = data?.packs?.current ? data.packs.list.find((p) => p.id === data.packs.current)?.tryCards ?? null : null;
  return data;
};

// ---------------------------------------------------------------- the window

function dialog() {
  let d = $('#gs');
  if (d) return d;
  d = el('dialog', 'gs-dialog');
  d.id = 'gs';
  // Its own ✕ is in the header (dialogs.js would add a second one on top of it).
  d.dataset.nox = '';
  d.setAttribute('aria-labelledby', 'gs-title');
  d.addEventListener('close', () => {
    showing = null;
    stopFirstTen();
    void paintToday();
  });
  document.body.append(d);
  return d;
}

/** Opens the guide at its saved step (or `at`; 'end' = the last screen). */
export async function openGuide(at) {
  if (!(await load())) return;
  const d = dialog();
  ctx.firstRun?.drop?.('guide');
  if (!data.guide.offered) void send('/mark', 'POST', { offered: true }).catch(() => undefined);
  showing = at ?? (data.guide.complete ? 'end' : data.guide.at);
  await paint();
  if (!d.open) d.showModal();
  // showModal focuses the first control (the ✕): the step's main button is where to start.
  d.querySelector('.gs-acts .gs-main')?.focus();
}

async function go(step) {
  showing = step;
  if (step !== 'end') await send('/step', 'POST', { id: step, action: 'go' }).catch(() => undefined);
  await paint();
}

function nextOf(step) {
  const ids = data.guide.steps.map((s) => s.id);
  return ids[ids.indexOf(step) + 1] ?? 'end';
}
function prevOf(step) {
  const ids = data.guide.steps.map((s) => s.id);
  if (step === 'end') return ids[ids.length - 1];
  return ids[ids.indexOf(step) - 1];
}

/** Opens a Settings page from the guide; the guide comes back when Settings closes. */
async function openPage(page) {
  reopen = true;
  $('#gs').close();
  await ctx.openSettings(page);
}

async function paint() {
  const d = dialog();
  const w = guideWords(t);
  const steps = data.guide.steps;
  const total = steps.length;
  const idx = steps.findIndex((s) => s.id === showing);
  const head = el('div', 'gs-head');
  head.append(el('span', 'gs-count muted small', showing === 'end' ? w.title : w.count(idx + 1, total)), button('×', 'ghost icon gs-x', () => d.close()));
  head.lastChild.setAttribute('aria-label', w.close);
  const dots = el('ol', 'gs-dots');
  dots.setAttribute('aria-hidden', 'true');
  for (const s of steps) {
    const li = el('li', `gs-dot gs-${s.state}${s.id === showing ? ' gs-now' : ''}`);
    dots.append(li);
  }
  const body = el('div', 'gs-body');
  const acts = el('div', 'gs-acts');
  if (showing === 'end') paintEnd(body, acts, w);
  else await paintStep(steps[idx], body, acts, w);
  d.replaceChildren(head, dots, body, acts);
  d.querySelector('.gs-acts .gs-main')?.focus();
}

async function paintStep(step, body, acts, w) {
  const sw = stepWords(step.id, t);
  const title = el('h2', 'gs-title', sw.title);
  title.id = 'gs-title';
  const status = el('p', `gs-state small ${step.state === 'done' ? 'good' : 'muted'}`, step.state === 'done' ? `✓ ${w.done}` : step.state === 'skipped' ? w.skipped : w.todo);
  status.setAttribute('role', 'status');
  body.append(title, el('p', 'gs-text', sw.text), status);
  const after = () => go(nextOf(step.id));
  // W2.2: the parts that need more than one button (web/first-ten.js).
  const h = { api: ctx.api, el, button, openPage, after, repaint: () => paint() };
  let main;
  if (step.id === 'model' && step.state !== 'done' && !ctx.isMember()) {
    main = (await paintModel(body, h)) ?? button(sw.go, 'gs-main', () => openPage(sw.page));
    body.append(button(sw.go, 'linkish small ft-own', () => openPage(sw.page)));
  } else if (step.id === 'chat') {
    await paintChat(body, step, h);
    main = step.state === 'done' ? button(w.next, 'gs-main', after) : button(sw.go, 'gs-main', () => openPage(sw.page));
  } else if (step.id === 'model') {
    const fit = el('div', 'gs-fit fitness-note');
    fit.hidden = true;
    body.append(fit);
    const f = await ctx.api('/model-jobs/fitness').catch(() => null);
    if (step.state === 'done') void ctx.paintFitness(fit);
    if (step.state !== 'done') main = button(sw.go, 'gs-main', () => openPage(sw.page));
    else if (f && f.autoChat === false) {
      main = button(w.useAuto, 'gs-main', async (b) => {
        b.disabled = true;
        try {
          await ctx.api('/settings', { method: 'PUT', body: { autoJobs: AUTO_JOBS } });
          await after();
        } catch (err) {
          b.disabled = false;
          status.textContent = err.message;
        }
      });
    } else {
      if (f?.autoChat) body.append(el('p', 'muted small', w.autoOn));
      main = button(w.next, 'gs-main', after);
    }
  } else if (step.state === 'done') main = button(w.next, 'gs-main', after);
  else if (step.id === 'computer') {
    main = button(sw.go, 'gs-main', () => void window.open('/download', '_blank', 'noopener'));
    body.append(button(w.pair, 'linkish small gs-pair', () => openPage(sw.page)));
  } else main = button(sw.go, 'gs-main', () => openPage(sw.page));
  const back = prevOf(step.id);
  if (back) acts.append(button(w.back, 'ghost', () => go(back)));
  if (step.state !== 'done') {
    acts.append(
      button(w.skip, 'ghost', async () => {
        await send('/step', 'POST', { id: step.id, action: 'skip' });
        await go(nextOf(step.id));
      }),
    );
  }
  acts.append(main);
}

function paintEnd(body, acts, w) {
  const title = el('h2', 'gs-title', w.endTitle);
  title.id = 'gs-title';
  body.append(title);
  // W2.2: three quick wins tailored to what is connected, then the pack (web/first-ten.js).
  const wins = el('div', 'ft-wins-slot');
  body.append(wins, el('p', 'gs-text', w.endText), packPicker('gs'));
  void winsBox({ api: ctx.api, el, button }, async (prompt) => {
    await send('/mark', 'POST', { finished: true, offered: true }).catch(() => undefined);
    $('#gs').close();
    await ctx.startWin?.(prompt);
  }).then((box) => wins.replaceWith(box));
  const row = el('label', 'row gs-examples');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = Boolean(data.guide.samples);
  box.dataset.noauto = '';
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = w.examplesTip;
  row.append(box, el('span', '', w.examples), tip);
  body.append(row);
  acts.append(button(w.back, 'ghost', () => go(prevOf('end'))));
  acts.append(
    button(w.finish, 'gs-main', async (b) => {
      b.disabled = true;
      const want = box.checked;
      if (want !== Boolean(data.guide.samples)) await send('/samples', want ? 'POST' : 'DELETE').catch(() => undefined);
      await send('/mark', 'POST', { finished: true, offered: true }).catch(() => undefined);
      $('#gs').close();
      if (want) {
        await ctx.openToday();
        await paintToday();
        setTimeout(runSampleTour, 300);
      }
    }),
  );
}

// ---------------------------------------------------------------- starter packs

/** The pack cards (in the guide's last screen and Settings → You). */
function packPicker(where) {
  const box = el('div', 'gs-packs');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', t('Starter pack'));
  const status = el('p', 'muted small gs-pack-status');
  status.setAttribute('role', 'status');
  const current = data?.packs?.current ?? null;
  for (const id of [...PACK_IDS, 'none']) {
    const pw = packWords(id, t);
    const on = (current ?? 'none') === id;
    const b = el('button', `gs-pack${on ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
    b.dataset.pack = id;
    b.append(el('span', 'gs-pack-title', pw.title), el('span', 'gs-pack-text muted small', pw.text));
    const def = data?.packs?.list.find((p) => p.id === id);
    if (def?.routines?.length) b.title = def.routines.map((n) => routineName(n, t)).join(' · ');
    b.addEventListener('click', async () => {
      if (on) return;
      for (const x of box.querySelectorAll('.gs-pack')) x.disabled = true;
      try {
        const r = await send('/pack', 'PUT', { id: id === 'none' ? null : id });
        const fresh = packPicker(where);
        fresh.querySelector('.gs-pack-status').textContent = packResultWords(r.result, t);
        box.replaceWith(fresh);
        void ctx.paintTryCards();
      } catch (err) {
        status.textContent = err.message;
        for (const x of box.querySelectorAll('.gs-pack')) x.disabled = false;
      }
    });
    box.append(b);
  }
  box.append(status);
  return box;
}

/** Settings → You → About you: Guided setup and the starter packs. */
export async function paintSettingsCard() {
  const host = $('#gs-card');
  if (!host || demo()) return;
  await load();
  if (!data) return void (host.hidden = true);
  host.hidden = false;
  const w = guideWords(t);
  const head = el('h3', '', t('Starter pack'));
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t('A pack picks Try cards, the order of Today and a few routines for what you use her for. Routines stay off until you press Allow. Pick None to undo it.');
  head.append(' ', tip);
  const open = button(w.open, 'ghost small', () => openGuide());
  open.id = 'gs-open';
  host.replaceChildren(el('p', 'small', ''), head, packPicker('settings'));
  host.firstChild.append(open, ' ', el('span', 'muted', t('{done} of {total} steps done', { done: data.guide.done, total: data.guide.total })));
}

// ---------------------------------------------------------------- Today

function fmtDay(iso) {
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Today: the "Finish setting up" card and the example cards (both only when there is something). */
export async function paintToday() {
  const card = $('#td-gs');
  const ex = $('#td-examples');
  if (!card || !ex || !ctx) return;
  if (demo() || !(await load())) {
    card.hidden = ex.hidden = true;
    return;
  }
  const w = guideWords(t);
  const g = data.guide;
  card.hidden = g.finished || g.complete;
  if (!card.hidden) {
    const bar = el('div', 'gs-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(g.total));
    bar.setAttribute('aria-valuenow', String(g.done));
    const fill = el('span', 'gs-bar-fill');
    fill.dataset.n = String(Math.round((g.done / Math.max(1, g.total)) * 4));
    bar.append(fill);
    card.replaceChildren(el('p', 'gs-today-text', w.today(g.done, g.total)), bar, button(w.resume, 'small', () => openGuide()), button(w.hide, 'ghost small', async () => {
      await send('/mark', 'POST', { finished: true }).catch(() => undefined);
      void paintToday();
    }));
  }
  const s = data.samples;
  ex.hidden = !s?.on || !s.cards.length;
  if (ex.hidden) return void ex.replaceChildren();
  const sw = sampleSectionWords(t);
  const head = el('div', 'today-start-head');
  const h = el('h3', '', sw.title);
  h.id = 'td-examples-title';
  head.append(h, el('span', 'gs-badge', sw.badge));
  const list = el('div', 'gs-samples');
  for (const c of s.cards) {
    const words = sampleWords(c, t, fmtDay);
    if (!words) continue;
    const box = el('div', 'gs-sample');
    box.dataset.sample = c.kind;
    box.append(icon(words.icon, 'try-ic') ?? '', el('span', 'gs-sample-title', words.title), el('span', 'muted small', words.text), el('span', 'gs-badge small', sw.badge));
    list.append(box);
  }
  const remove = button(sw.remove, 'ghost small', async (b) => {
    b.disabled = true;
    await send('/samples', 'DELETE').catch(() => undefined);
    await paintToday();
    $('#td-status').textContent = sw.removed;
  });
  remove.id = 'td-examples-remove';
  const acts = el('div', 'gs-sample-acts');
  acts.append(button(sw.tour, 'small', () => runSampleTour()), remove);
  ex.setAttribute('aria-labelledby', 'td-examples-title');
  ex.replaceChildren(head, el('p', 'muted small', sw.lead), list, acts);
}

export function runSampleTour() {
  if (!$('#td-examples') || $('#td-examples').hidden) return;
  void startTour(sampleTour(t), t);
}

// ---------------------------------------------------------------- first sign-in

/** Offered once per person after the first sign-in, when little is set up yet (the first-run queue). */
async function queueGuide() {
  if (demo() || !(await load())) return;
  const g = data.guide;
  if (g.offered || g.finished || g.done >= 3) return;
  ctx.firstRun.add(
    'guide',
    async () => {
      // W2.2: opened by hand (Today, Settings) or finished meanwhile: don't open it again.
      if (!(await load()) || data.guide.offered || data.guide.finished) return;
      void send('/mark', 'POST', { offered: true }).catch(() => undefined);
      void openGuide();
    },
    () => Boolean(ctx.state.replied) || ctx.isMember(),
  );
}

/** Called once by app.js after sign-in. */
export function initGetStarted(c) {
  ctx = c;
  $('#settings')?.addEventListener('close', () => {
    if (!reopen) return;
    reopen = false;
    void openGuide();
  });
  void queueGuide();
}
