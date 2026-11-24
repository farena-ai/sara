// T49: "Test my models" on Settings → Models & usage → Which model does what. Each connected model
// gets the same small tasks per job, checked by code; the page shows "11 of 12 (92)" per job, the
// best with its backups, and Use / Use the best for every job (with Undo). The work is on the server
// (/api/model-tests/*); this file is the dialog, the live line and the results. An older server
// without these routes (404) hides the feature.
import { t } from './naming.js';

// ---------- small pure parts (test/t49-model-tests-web.test.ts) ----------

/** One key per model: provider and model name. */
export const keyOf = (m) => `${m?.providerId ?? ''}\n${m?.model ?? ''}`;

export const countModels = (n) => (n === 1 ? t('1 model') : t('{n} models', { n }));
export const countJobs = (n) => (n === 1 ? t('1 job') : t('{n} jobs', { n }));
export const countCalls = (n) => (n === 1 ? t('1 call') : t('{n} calls', { n }));

/** "About 8 minutes." from the plan's estimate. */
export function aboutTime(minutes) {
  const m = Math.max(1, Math.round(Number(minutes) || 0));
  if (m <= 1) return t('About a minute.');
  if (m < 90) return t('About {n} minutes.', { n: m });
  return t('About {n} hours.', { n: Math.round(m / 60) });
}

/** How a model is paid for, in plain words. */
export function billingText(billing) {
  if (billing === 'local') return t('on this computer');
  if (billing === 'subscription') return t('your subscription');
  if (billing === 'api') return t('paid by use');
  return '';
}

/**
 * The plan in plain words: what runs, what it costs, how long, and what is left out and why.
 * @returns {{ empty: boolean, lines: string[], leftOut: { label: string, why: string }[] }}
 */
export function planView(plan) {
  const models = plan?.models ?? [];
  const inc = models.filter((m) => m.included);
  const leftOut = models.filter((m) => !m.included).map((m) => ({ label: m.label || m.model, why: m.why ? t(m.why) : t('Left out.') }));
  if (!models.length) return { empty: true, lines: [t('No models are connected yet. Add one in Providers and plans first.')], leftOut };
  if (!inc.length) return { empty: true, lines: [t('Nothing to test with these choices.')], leftOut };
  const lines = [t('Tests {models} on {jobs}: {calls} in all.', { models: countModels(inc.length), jobs: countJobs(plan.jobs?.length ?? 0), calls: countCalls(plan.calls ?? 0) })];
  const paid = Number(plan.paidCalls) || 0;
  lines.push(paid === 0 ? t('None of them are paid by use.') : paid === 1 ? t('1 of them is paid by use (your API key).') : t('{n} of them are paid by use (your API key).', { n: paid }));
  const subs = inc.filter((m) => m.billing === 'subscription').map((m) => m.label || m.model);
  if (subs.length) lines.push(t('These count toward your subscription: {models}.', { models: subs.join(', ') }));
  lines.push(aboutTime(plan.minutes));
  return { empty: false, lines, leftOut };
}

/**
 * What the dialog's choices ask the server for, or the one thing still missing.
 * choice: { kind: 'all'|'provider'|'compare'|'models', providerId?, job?, models?, jobs?, includePaid? }
 * @returns {{ body?: object, problem?: string }}
 */
export function requestBody(choice) {
  const paid = { includePaid: Boolean(choice?.includePaid) };
  const jobs = choice?.jobs?.length ? { jobs: [...choice.jobs] } : {};
  const uniq = (list) => [...new Map((list ?? []).filter((m) => m?.providerId && m?.model).map((m) => [keyOf(m), { providerId: m.providerId, model: m.model }])).values()];
  if (choice?.kind === 'provider') {
    if (!choice.providerId) return { problem: t('Pick a provider.') };
    return { body: { scope: { kind: 'provider', providerId: choice.providerId }, ...jobs, ...paid } };
  }
  if (choice?.kind === 'compare') {
    if (!choice.job) return { problem: t('Pick a job.') };
    const models = uniq(choice.models);
    if (models.length < 2) return { problem: t('Pick two or three models.') };
    return { body: { scope: { kind: 'models', models: models.slice(0, 3) }, jobs: [choice.job], ...paid } };
  }
  if (choice?.kind === 'models') {
    const models = uniq(choice.models).slice(0, 20);
    if (!models.length) return { problem: t('Pick a model.') };
    return { body: { scope: { kind: 'models', models }, ...jobs, ...paid } };
  }
  return { body: { scope: { kind: 'all' }, ...jobs, ...paid } };
}

/**
 * The progress sentence for a run (/status's run, or the model-tests event).
 * names: { model({providerId, model}) → label, job(id) → label }
 */
export function progressText(run, names) {
  if (!run) return '';
  const n = { done: run.done ?? 0, total: run.total ?? 0 };
  if (run.state === 'running') {
    return run.current ? t('Testing {model} for {job}, {done} of {total}', { model: names.model(run.current), job: names.job(run.current.job), ...n }) : t('Testing models… {done} of {total}', n);
  }
  if (run.state === 'done') return t('Model tests finished: {done} of {total}.', n);
  if (run.state === 'stopped') return t('Stopped after {done} of {total}. What finished is kept.', n);
  if (run.state === 'failed') return run.error ? t('The model tests failed: {error}', { error: run.error }) : t('The model tests failed.');
  return '';
}

/** The short line on the page while a run goes on ("Testing models… 14 of 96"). */
export function pageLine(run, names) {
  if (run?.state === 'running') return t('Testing models… {done} of {total}', { done: run.done ?? 0, total: run.total ?? 0 });
  return progressText(run, names);
}

/** A score, honestly: "11 of 12 (92)", or "could not be tested" for one that errored. */
export function scoreText(s) {
  if (!s) return '';
  if (s.error) return t('could not be tested');
  return t('{passed} of {total} ({score})', { passed: s.passed, total: s.total, score: s.score });
}

/** The line under a job row for the model it uses now: "Score 92, 11 of 12". */
export function rowScoreText(model, job) {
  const s = model?.scores?.[job];
  if (!s) return '';
  const text = s.error ? t('Model tests: could not be tested') : t('Score {score}, {passed} of {total}', { score: s.score, passed: s.passed, total: s.total });
  return model.stale ? `${text} · ${t('tested before the tests changed')}` : text;
}

/** The model with this provider and name in /scores, if any. */
export function findModel(data, m) {
  if (!m) return null;
  return (data?.models ?? []).find((x) => x.providerId === m.providerId && x.model === m.model) ?? null;
}

/** Scores this close count as a tie (TIE_POINTS in src/model-tests.ts). */
const TIE_POINTS = 3;

/** When the server sent no best list for a job: highest score first; errors and untested left out; within 3 points is a tie. */
export function rankJob(data, job) {
  const rows = (data?.models ?? [])
    .filter((m) => m.scores?.[job] && !m.scores[job].error)
    .map((m) => ({ providerId: m.providerId, model: m.model, score: m.scores[job].score }))
    .sort((a, b) => b.score - a.score);
  const top = rows[0]?.score ?? 0;
  const close = rows.filter((r) => top - r.score <= TIE_POINTS).length;
  return rows.slice(0, 3).map((r) => ({ ...r, tie: close > 1 && top - r.score <= TIE_POINTS, why: '' }));
}

/**
 * A job's best model and its backups, ready to show (at most 3).
 * @returns {{ providerId: string, model: string, label: string, score: number, passed?: number, total?: number, tie: boolean, why: string, stale: boolean }[]}
 */
export function bestFor(data, job) {
  const list = data?.best?.[job] ?? rankJob(data, job);
  return list.slice(0, 3).map((b) => {
    const m = findModel(data, b);
    const s = m?.scores?.[job];
    return { providerId: b.providerId, model: b.model, label: m?.label || b.model, score: b.score, passed: s?.passed, total: s?.total, tie: Boolean(b.tie), why: b.why ? t(b.why) : '', stale: Boolean(m?.stale) };
  });
}

/** One best/backup entry as text: "qwen3 · 11 of 12 (92) · tied". */
export function entryText(b) {
  const score = b.total ? scoreText({ score: b.score, passed: b.passed, total: b.total }) : String(b.score);
  return [b.label, score, b.tie ? t('tied') : ''].filter(Boolean).join(' · ');
}

/**
 * The every model × job table: only jobs that have a score somewhere, only models tested at least once.
 * A cell is { kind: 'score'|'error'|'none', text, detail?, best?, tie? }.
 */
export function tableModel(data) {
  const models = data?.models ?? [];
  const jobs = (data?.jobs ?? []).filter((j) => models.some((m) => m.scores?.[j.id]));
  const lists = Object.fromEntries(jobs.map((j) => [j.id, bestFor(data, j.id)]));
  const rows = models
    .filter((m) => Object.keys(m.scores ?? {}).length)
    .map((m) => ({
      key: keyOf(m),
      label: m.label || m.model,
      stale: Boolean(m.stale),
      testedAt: m.testedAt ?? null,
      cells: jobs.map((j) => {
        const s = m.scores?.[j.id];
        if (!s) return { kind: 'none', text: '' };
        if (s.error) return { kind: 'error', text: t('could not be tested'), detail: s.error };
        const list = lists[j.id];
        const best = Boolean(list[0] && keyOf(list[0]) === keyOf(m));
        // Every model in a tie is marked, not only the one that won it.
        const tie = list.some((b) => b.tie && keyOf(b) === keyOf(m));
        return { kind: 'score', text: String(s.score), detail: t('{passed} of {total}', { passed: s.passed, total: s.total }), best, tie };
      }),
    }));
  return { jobs, rows };
}

/** Models connected but never tested (the server's list, and any listed model with no scores at all). */
export function notTestedYet(data) {
  const out = new Map();
  for (const u of data?.untested ?? []) out.set(keyOf(u), { providerId: u.providerId, model: u.model, label: u.label || u.model });
  for (const m of data?.models ?? []) if (!m.testedAt && !Object.keys(m.scores ?? {}).length && !out.has(keyOf(m))) out.set(keyOf(m), { providerId: m.providerId, model: m.model, label: m.label || m.model });
  return [...out.values()];
}

export const untestedLine = (n) => (!n ? '' : n === 1 ? t('1 model not tested yet.') : t('{n} models not tested yet.', { n }));

/** True when /scores has nothing to show yet. */
export const noScores = (data) => !(data?.models ?? []).some((m) => Object.keys(m.scores ?? {}).length);

/**
 * The routes each changed job had before Use the best for every job: /apply's `previous` when the
 * server sends it ({ job, providerId, model, fallbacks } list, { job, route } list or a job → route
 * map), else the snapshot taken just before. null = the job had no model of its own.
 */
export function previousRoutes(res, before) {
  const out = {};
  const jobs = (res?.changed ?? []).map((c) => c.job);
  const prev = res?.previous;
  const fromList = Array.isArray(prev) ? Object.fromEntries(prev.map((p) => [p.job, p.route !== undefined ? p.route : p.providerId ? { providerId: p.providerId, model: p.model, ...(p.fallbacks?.length ? { fallbacks: p.fallbacks } : {}) } : null])) : null;
  for (const job of jobs) {
    if (fromList && job in fromList) out[job] = fromList[job] ?? null;
    else if (prev && !Array.isArray(prev) && typeof prev === 'object' && job in prev) out[job] = prev[job] ?? null;
    else out[job] = before?.[job] ?? null;
  }
  return out;
}

/** The routes to save for Undo: today's routes with the changed jobs put back. */
export function undoRoutes(current, previous) {
  const routes = { ...(current ?? {}) };
  for (const [job, r] of Object.entries(previous ?? {})) {
    if (r) routes[job] = r;
    else delete routes[job];
  }
  return routes;
}

// ---------- the page and the dialog ----------

const $ = (s) => document.querySelector(s);
const POLL_MS = 4000;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(label, fn, cls = 'ghost') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

/**
 * @type {{ ctx: any, available: boolean | null, scores: any, run: any, lastEvent: number, poll: number,
 *   choice: any, planSeq: number, planTimer: number, slots: any[], planModels: any[], autoNew: boolean, undo: any }}
 */
const mt = { ctx: null, available: null, scores: null, run: null, lastEvent: 0, poll: 0, choice: { kind: 'all', jobs: [], includePaid: false }, planSeq: 0, planTimer: 0, slots: [], planModels: [], autoNew: false, undo: null };

const names = {
  model: (m) => {
    const hit = findModel(mt.scores, m) ?? mt.planModels.find((x) => x.providerId === m.providerId && x.model === m.model);
    return hit?.label || m.model;
  },
  job: (id) => {
    const j = (mt.scores?.jobs ?? []).find((x) => x.id === id) ?? (mt.ctx?.jobs?.() ?? []).find((x) => x.id === id);
    return j ? t(j.label) : id;
  },
};
const testJobs = () => (mt.scores?.jobs?.length ? mt.scores.jobs : (mt.ctx?.jobs?.() ?? []).filter((j) => j.id !== 'companion'));

/**
 * ctx: { api, providers() → [{id,label}], jobs() → [{id,label}], modelPick(blank, cur), providerSelect(blank),
 *        useModel(job, providerId, model) → Promise<boolean>, currentModel(job) → {providerId, model} | null,
 *        rows() → Map(job → { el }), reload() → Promise }
 */
export function initModelTests(ctx) {
  mt.ctx = ctx;
  $('#mtest-open')?.addEventListener('click', () => openModelTests());
  $('#mtest-start')?.addEventListener('click', () => void start());
  const page = document.querySelector('.settings-page[data-page="models-routes"]');
  if (page) new MutationObserver(() => !page.hidden && void loadModelTests()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

/** Hides everything of this feature (an older server) or shows it. */
function showFeature(on) {
  for (const e of document.querySelectorAll('[data-mtest]')) {
    if (e.id === 'mtest-live') continue; // shown only while a run goes on
    e.hidden = !on;
  }
  if (!on) $('#mtest-live')?.setAttribute('hidden', '');
}

/** Loads the scores and the run (page shown, run ended). */
export async function loadModelTests() {
  if (!mt.ctx) return;
  try {
    const [scores, status] = await Promise.all([mt.ctx.api('/model-tests/scores'), mt.ctx.api('/model-tests/status').catch(() => ({ run: null }))]);
    mt.available = true;
    mt.scores = scores;
    showFeature(true);
    if (status?.run?.state === 'running') setRun(status.run);
    else paintLive();
  } catch (err) {
    if (err?.status === 404) {
      mt.available = false;
      showFeature(false);
      return;
    }
    mt.scores = null;
  }
  paintPage();
}

/** Settings → the "Test new models when they appear" tick, and each row's score (renderRoutes calls this). */
export function modelTestsRoutes(s) {
  mt.autoNew = Boolean(s?.modelTests?.autoNew);
  const box = $('#mtest-auto-new');
  if (box) box.checked = mt.autoNew;
  paintRows();
}

/** What saveRoutes adds to its settings body (nothing on a server without model tests). */
export function modelTestsSettings() {
  const box = $('#mtest-auto-new');
  if (mt.available !== true || !box) return {};
  return { modelTests: { autoNew: box.checked } };
}

/** The server-sent `model-tests` event: the run object of /status. */
export function onModelTestsEvent(data) {
  mt.lastEvent = Date.now();
  // The contract sends the run itself; a { run } wrapper is read the same way.
  setRun(data && !('state' in data) && 'run' in data ? data.run : data);
}

function setRun(run) {
  const was = mt.run;
  mt.run = run ?? null;
  const running = mt.run?.state === 'running';
  if (running) startPoll();
  else stopPoll();
  paintLive();
  paintProgress();
  const ended = mt.run && !running && was?.state === 'running' && (!was.id || was.id === mt.run.id);
  if (ended) {
    void (async () => {
      try {
        mt.scores = await mt.ctx.api('/model-tests/scores');
      } catch {
        /* keep the last scores */
      }
      paintPage();
      const d = $('#model-tests-dialog');
      if (d?.open) showView(mt.run.state === 'failed' ? 'setup' : 'result');
    })();
  }
}

function startPoll() {
  if (mt.poll) return;
  mt.poll = setInterval(async () => {
    // The live event is the main way; this only covers a channel that went quiet.
    if (Date.now() - mt.lastEvent < POLL_MS + 2000) return;
    try {
      const { run } = await mt.ctx.api('/model-tests/status');
      setRun(run);
    } catch {
      /* try again next time */
    }
  }, POLL_MS);
}
function stopPoll() {
  clearInterval(mt.poll);
  mt.poll = 0;
}

async function stopRun() {
  try {
    await mt.ctx.api('/model-tests/stop', { method: 'POST', body: {} });
    const { run } = await mt.ctx.api('/model-tests/status');
    setRun(run);
  } catch (err) {
    const st = $('#mtest-status');
    if (st) st.textContent = err?.message ?? String(err);
  }
}

// ----- the live line on the page -----
function paintLive() {
  const line = $('#mtest-live');
  if (!line) return;
  const run = mt.run;
  const show = mt.available === true && run && (run.state === 'running' || run.state === 'failed' || run.state === 'stopped');
  line.hidden = !show;
  if (!show) return line.replaceChildren();
  const text = el('span', run.state === 'failed' ? 'bad' : '', pageLine(run, names));
  line.replaceChildren(text);
  if (run.state === 'running') line.append(' ', button(t('Stop'), () => void stopRun()));
}

// ----- the dialog -----
/** Opens the dialog: progress while a run goes on, else the choices (models: those chosen, for Test them). */
export function openModelTests(opts = {}) {
  const d = $('#model-tests-dialog');
  if (!d || mt.available === false) return;
  mt.choice = opts.models?.length ? { kind: 'models', models: opts.models, jobs: [], includePaid: false } : { kind: 'all', jobs: [], includePaid: false };
  $('#mtest-status').textContent = '';
  buildSetup();
  showView(mt.run?.state === 'running' ? 'running' : 'setup');
  if (!d.open) d.showModal();
  if (mt.run?.state !== 'running') planSoon(0);
}

function showView(view) {
  const running = view === 'running';
  $('#mtest-setup').hidden = view !== 'setup';
  $('#mtest-plan').hidden = view !== 'setup';
  $('#mtest-go').hidden = view !== 'setup';
  $('#mtest-progress').hidden = !running;
  const done = $('#mtest-done');
  done.hidden = view !== 'result';
  if (view === 'result') {
    const again = el('div', 'add-row');
    again.append(button(t('Test again'), () => openModelTests()));
    const head = mt.run && mt.run.state !== 'running' ? [el('p', 'small', progressText(mt.run, names))] : [];
    done.replaceChildren(...head, ...results({ inDialog: true }), again);
  }
  if (running) paintProgress();
  const failed = view === 'setup' && mt.run?.state === 'failed';
  if (failed) $('#mtest-status').textContent = progressText(mt.run, names);
  $('#mtest-status').classList.toggle('bad', failed);
}

function paintProgress() {
  const box = $('#mtest-progress');
  if (!box) return;
  const run = mt.run;
  if (!run || run.state !== 'running') {
    if (!box.hidden && $('#model-tests-dialog')?.open && run) box.replaceChildren(el('p', run.state === 'failed' ? 'bad' : 'muted small', progressText(run, names)));
    return;
  }
  const bar = document.createElement('progress');
  bar.className = 'gl-bar';
  bar.max = Math.max(1, run.total ?? 1);
  bar.value = run.done ?? 0;
  bar.setAttribute('aria-label', t('Model tests'));
  const row = el('div', 'add-row');
  row.append(button(t('Stop'), () => void stopRun()), el('span', 'muted small', t('You can close this window; the tests go on.')));
  box.replaceChildren(el('p', 'mtest-now', progressText(run, names)), bar, row);
}

/** One choice card (a radio button that looks like a card). */
function choiceCard(kind, title, sub) {
  const b = el('button', 'pick-card');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(mt.choice.kind === kind));
  b.dataset.kind = kind;
  b.append(el('strong', '', title), el('span', 'muted small', sub));
  b.addEventListener('click', () => {
    mt.choice.kind = kind;
    buildSetup();
    planSoon();
  });
  return b;
}

function buildSetup() {
  const box = $('#mtest-setup');
  const c = mt.choice;
  const providers = mt.ctx.providers?.() ?? [];
  if (!providers.length) {
    box.replaceChildren(el('p', 'muted', t('No models are connected yet. Add one in Providers and plans first.')));
    $('#mtest-start').disabled = true;
    $('#mtest-plan').replaceChildren();
    return;
  }
  const cards = el('div', 'pick-cards mtest-kinds');
  cards.setAttribute('role', 'radiogroup');
  cards.setAttribute('aria-label', t('What to test'));
  if (c.kind === 'models') cards.append(choiceCard('models', t('The models not tested yet'), c.models.map((m) => m.label || m.model).join(', ')));
  cards.append(
    choiceCard('all', t('All my models'), t('Every connected model, on every job it can do.')),
    choiceCard('provider', t('One provider'), t('Only the models of one provider.')),
    choiceCard('compare', t('Compare two or three for one job'), t('Pick a job and two or three models.')),
  );
  const parts = [cards];
  if (c.kind === 'provider') {
    const sel = mt.ctx.providerSelect(t('Choose…'));
    sel.setAttribute('aria-label', t('Provider'));
    sel.value = c.providerId ?? '';
    sel.addEventListener('change', () => ((c.providerId = sel.value), planSoon()));
    const row = el('label', 'row mtest-pick', t('Provider'));
    row.append(' ', sel);
    parts.push(row);
  }
  if (c.kind === 'compare') {
    const job = document.createElement('select');
    job.setAttribute('aria-label', t('Which job'));
    job.append(new Option(t('Choose…'), ''), ...testJobs().filter((j) => j.id !== 'embeddings').map((j) => new Option(t(j.label), j.id)));
    job.value = c.job ?? '';
    job.addEventListener('change', () => ((c.job = job.value), planSoon()));
    const jr = el('label', 'row mtest-pick', t('Which job'));
    jr.append(' ', job);
    parts.push(jr);
    mt.slots = [0, 1, 2].map((k) => mt.ctx.modelPick(k === 2 ? t('(optional)') : t('Choose…'), c.models?.[k]));
    mt.slots.forEach((s, k) => {
      s.sel.setAttribute('aria-label', t('Model {n}: provider', { n: k + 1 }));
      s.chooser.el.querySelector('select')?.setAttribute('aria-label', t('Model {n}: model', { n: k + 1 }));
      const line = el('div', 'route-row');
      line.append(el('span', '', `${t('Model')} ${k + 1}`), s.sel, s.chooser.el);
      const changed = () => ((c.models = mt.slots.map((x) => x.value())), planSoon());
      line.addEventListener('change', changed);
      line.addEventListener('input', changed);
      parts.push(line);
    });
  } else {
    // Only these jobs (optional): none ticked means every job.
    const det = document.createElement('details');
    det.className = 'mtest-jobs';
    det.open = Boolean(c.jobs.length);
    det.append(el('summary', '', t('Only these jobs')));
    const grid = el('div', 'mtest-job-picks');
    for (const j of testJobs()) {
      const lab = el('label', 'row');
      const box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.value = j.id;
      box2.checked = c.jobs.includes(j.id);
      box2.addEventListener('change', () => {
        c.jobs = [...grid.querySelectorAll('input:checked')].map((x) => x.value);
        planSoon();
      });
      lab.append(box2, ' ', t(j.label));
      grid.append(lab);
    }
    det.append(el('p', 'muted small', t('None ticked: every job.')), grid);
    parts.push(det);
  }
  const paid = el('label', 'row mtest-paid');
  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.id = 'mtest-include-paid';
  tick.checked = Boolean(c.includePaid);
  tick.addEventListener('change', () => ((c.includePaid = tick.checked), planSoon()));
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t('Off: models paid by the token (your API key) are left out, so the tests cost nothing extra. On: they are tested too, and the plan says how many calls that is before you start.');
  paid.append(tick, ' ', t('Also test models I pay for by use'), ' ', tip);
  parts.push(paid);
  box.replaceChildren(...parts);
}

function planSoon(ms = 250) {
  clearTimeout(mt.planTimer);
  mt.planTimer = setTimeout(() => void plan(), ms);
}

async function plan() {
  const box = $('#mtest-plan');
  const startBtn = $('#mtest-start');
  if (!(mt.ctx.providers?.() ?? []).length) return void (startBtn.disabled = true); // buildSetup said why
  if (mt.choice.kind === 'compare') mt.choice.models = mt.slots.map((s) => s.value());
  const req = requestBody(mt.choice);
  if (req.problem) {
    box.replaceChildren(el('p', 'muted small', req.problem));
    startBtn.disabled = true;
    return;
  }
  const seq = ++mt.planSeq;
  startBtn.disabled = true;
  box.replaceChildren(el('p', 'muted small', t('Working out the plan…')));
  try {
    const p = await mt.ctx.api('/model-tests/plan', { method: 'POST', body: req.body });
    if (seq !== mt.planSeq) return; // a newer choice was made meanwhile
    mt.planModels = p.models ?? [];
    const v = planView(p);
    const parts = v.lines.map((line) => el('p', 'small', line));
    if (v.leftOut.length) {
      parts.push(el('p', 'small mtest-left-head', t('Left out:')));
      const ul = el('ul', 'small muted mtest-left');
      for (const m of v.leftOut) ul.append(el('li', '', `${m.label}: ${m.why}`));
      parts.push(ul);
    }
    box.replaceChildren(...parts);
    startBtn.disabled = v.empty;
  } catch (err) {
    if (seq !== mt.planSeq) return;
    box.replaceChildren(el('p', 'bad small', err?.message ?? String(err)));
  }
}

async function start() {
  const req = requestBody(mt.choice);
  const st = $('#mtest-status');
  if (req.problem) return void (st.textContent = req.problem);
  $('#mtest-start').disabled = true;
  st.textContent = '';
  try {
    const { runId } = await mt.ctx.api('/model-tests/start', { method: 'POST', body: req.body });
    setRun({ id: runId, state: 'running', done: 0, total: 0, startedAt: new Date().toISOString() });
    showView('running');
  } catch (err) {
    st.textContent = err?.message ?? String(err);
    // 409: a run is already going: show it.
    if (err?.status === 409) {
      try {
        const { run } = await mt.ctx.api('/model-tests/status');
        setRun(run);
        if (run?.state === 'running') showView('running');
      } catch {
        /* the message above says enough */
      }
    }
  }
  $('#mtest-start').disabled = false;
}

// ----- results (the page section, and the dialog when a run ends) -----
function paintPage() {
  const box = $('#mtest-results');
  if (box && mt.available === true) box.replaceChildren(...results({ inDialog: false }));
  paintRows();
}

function paintRows() {
  const rows = mt.ctx?.rows?.();
  if (!rows) return;
  for (const [job, r] of rows) {
    let line = r.el.querySelector(':scope > .mtest-row-score');
    const text = mt.available === true && mt.scores ? rowScoreText(findModel(mt.scores, mt.ctx.currentModel(job)), job) : '';
    if (!text) {
      line?.remove();
    } else {
      if (!line) {
        line = el('div', 'mtest-row-score');
        r.el.insertBefore(line, r.el.querySelector(':scope > details'));
      }
      line.textContent = text;
    }
    // A new pick in the row: its score follows.
    if (!r.el.dataset.mtWatch) {
      r.el.dataset.mtWatch = '1';
      r.el.addEventListener('change', () => setTimeout(paintRows, 0));
    }
  }
}

function results({ inDialog }) {
  const data = mt.scores;
  const out = [];
  if (!inDialog) out.push(el('h3', 'mtest-head', t('Model test results')));
  const providers = mt.ctx.providers?.() ?? [];
  if (!providers.length) {
    out.push(el('p', 'muted small', t('No models are connected yet. Add one in Providers and plans, then test them here.')));
    return out;
  }
  if (!data) {
    out.push(el('p', 'muted small', t('The scores could not be loaded. Try again in a moment.')));
    return out;
  }
  if (!inDialog) out.push(el('p', 'muted small', t('Each model gets the same small tasks for each job, checked by code on this computer. A score is how many it passed.')));
  const untested = notTestedYet(data);
  if (noScores(data)) {
    out.push(el('p', 'muted small', t('No scores yet. Press Test my models… to start.')));
  } else {
    const list = el('div', 'mtest-best');
    for (const j of data.jobs ?? []) {
      const best = bestFor(data, j.id);
      if (!best.length) continue;
      const row = el('div', 'mtest-job');
      row.append(el('span', 'mtest-job-name', t(j.label)));
      const main = el('div', 'mtest-job-main');
      const top = best[0];
      const line = el('div', 'mtest-job-top');
      line.append(el('strong', '', top.label), el('span', 'small', ` ${entryText({ ...top, label: '' })}`));
      line.append(' ', button(t('Use'), () => void useOne(j.id, top), 'ghost small'));
      main.append(line);
      if (top.why) main.append(el('p', 'muted small', top.why));
      else if (top.tie) main.append(el('p', 'muted small', t('Close scores count as a tie.')));
      if (best.length > 1) main.append(el('p', 'muted small', `${t('Backup models')}: ${best.slice(1).map(entryText).join('; ')}`));
      row.append(main);
      list.append(row);
    }
    out.push(list);
    const acts = el('div', 'add-row');
    acts.append(button(t('Use the best for every job'), () => void applyAll(), ''));
    const st = el('span', 'muted small mtest-apply-status');
    st.setAttribute('role', 'status');
    acts.append(st);
    out.push(acts);
    if (mt.undo?.lines?.length) {
      const done = el('div', 'mtest-applied small');
      for (const l of mt.undo.lines) done.append(el('p', '', l));
      if (mt.undo.previous) done.append(button(t('Undo'), () => void undoApply()));
      out.push(done);
    }
    out.push(table(data));
  }
  if (untested.length) {
    const row = el('p', 'small mtest-untested', untestedLine(untested.length));
    row.append(' ', button(t('Test them'), () => openModelTests({ models: untested.slice(0, 20) })));
    out.push(row);
  }
  if (!inDialog && data.best && Object.values(data.best).some((l) => l?.some((b) => b.tie))) out.push(el('p', 'muted small', t('Scores within 3 points count as a tie. A tie goes to the faster model for Quick replies, the one on this computer for Private, and the cheaper one for the rest.')));
  return out;
}

function table(data) {
  const { jobs, rows } = tableModel(data);
  const wrap = el('div', 'mtest-table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', t('Every score'));
  const tbl = el('table', 'mtest-table');
  const head = el('tr');
  head.append(el('th', '', t('Model')), ...jobs.map((j) => el('th', 'num', t(j.label))), el('th', '', t('Tested')));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const name = el('th', '', r.label);
    name.scope = 'row';
    if (r.stale) name.append(el('span', 'mtest-stale small', t('tested before the tests changed')));
    tr.append(name);
    for (const c of r.cells) {
      const td = el('td', `num${c.kind === 'error' ? ' mtest-err' : ''}${c.best ? ' mtest-top' : ''}`);
      if (c.kind === 'score') {
        td.append(el('span', '', c.text), el('span', 'mtest-detail', c.detail));
        if (c.tie) td.append(el('span', 'mtest-detail', t('tied')));
      } else if (c.kind === 'error') {
        td.textContent = c.text;
        td.title = c.detail ?? '';
      } else td.textContent = '–';
      tr.append(td);
    }
    tr.append(el('td', 'muted', day(r.testedAt)));
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  wrap.append(tbl);
  return wrap;
}

async function useOne(job, b) {
  const ok = await mt.ctx.useModel(job, b.providerId, b.model);
  const text = ok ? t('{job} now uses {model}. It saves by itself.', { job: names.job(job), model: b.label }) : t('That job is not on this page.');
  for (const st of document.querySelectorAll('.mtest-apply-status')) st.textContent = text;
  paintRows();
}

async function applyAll() {
  const sts = () => document.querySelectorAll('.mtest-apply-status');
  try {
    // Kept in case the server does not send what it replaced.
    const before = await mt.ctx.api('/settings').catch(() => null);
    const res = await mt.ctx.api('/model-tests/apply', { method: 'POST', body: {} });
    const changed = res?.changed ?? [];
    mt.undo = {
      lines: changed.length ? changed.map((c) => t('{job}: now {model}', { job: names.job(c.job), model: names.model(c) })) : [t('Nothing changed: every job with a score already uses its best model.')],
      previous: changed.length ? previousRoutes(res, before?.routes) : null,
      autoJobs: before?.autoJobs ?? null,
    };
    await mt.ctx.reload();
    paintPage();
    if ($('#model-tests-dialog')?.open && !$('#mtest-done').hidden) showView('result');
  } catch (err) {
    for (const st of sts()) st.textContent = err?.message ?? String(err);
  }
}

async function undoApply() {
  const u = mt.undo;
  if (!u?.previous) return;
  try {
    const s = await mt.ctx.api('/settings');
    const body = { routes: undoRoutes(s.routes, u.previous), ...(Array.isArray(u.autoJobs) ? { autoJobs: u.autoJobs } : {}) };
    await mt.ctx.api('/settings', { method: 'PUT', body });
    mt.undo = { lines: [t('Undone: the jobs use the models they had before.')], previous: null };
    await mt.ctx.reload();
    paintPage();
    if ($('#model-tests-dialog')?.open && !$('#mtest-done').hidden) showView('result');
  } catch (err) {
    for (const st of document.querySelectorAll('.mtest-apply-status')) st.textContent = err?.message ?? String(err);
  }
}
