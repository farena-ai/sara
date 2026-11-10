// Phase 75 (stage 1, "her work on screen"): the step line under each reply. Built from the tool
// events the chat stream already sends (tool_call / approval / tool_running / tool_result) and,
// after a reload, from the stored tool messages; the memories she used in the reply count as a
// step too. One quiet line, collapsed: "Remembered 2 things · Checked the weather 0.4 s · Added a
// to-do"; live while she works ("Checking the weather…"); one tap or click opens the details of
// every step (what ran, the output, how long). Replaces the grey "$ command" boxes.
import { locale, t } from './naming.js';
import { icon } from './icons.js';
import { stepWordsWith } from './step-words.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** The step's line icon (web/icons.js), decorative: the verb beside it says what she did. */
function stepIcon(name) {
  const span = el('span', 'step-icon');
  span.setAttribute('aria-hidden', 'true');
  const svg = icon(name) ?? icon('tool');
  if (svg) span.append(svg);
  return span;
}

// How long a step took: "0.4 s", "12 s", "2 min".
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const nf = (n, d) => n.toLocaleString(locale(), { maximumFractionDigits: d });
  if (ms < 10_000) return `${nf(Math.max(0.1, ms / 1000), 1)} s`;
  if (ms < 90_000) return `${nf(Math.round(ms / 1000), 0)} s`;
  return `${nf(Math.round(ms / 60_000), 0)} min`;
}

/** The words for one step (web/step-words.js), translated with the app's t(). */
export function stepWords(name, args = {}, named = '') {
  return stepWordsWith(t, name, args, named);
}

const DETAIL_LIMIT = 4000;

/**
 * A new step line (collapsed). `named(name)` gives a tool's plain name; `undo(body, snapshotId)`
 * adds the "Undo to before this step" button to a step's details.
 */
export function stepLine({ named = () => '', undo = () => {} } = {}) {
  const box = el('details', 'steps');
  box.setAttribute('aria-live', 'polite');
  const sum = el('summary', 'steps-sum');
  sum.append(el('span', 'steps-dot'), el('span', 'steps-text'), el('span', 'steps-total'));
  const list = el('ol', 'steps-list');
  box.append(sum, list);
  box._named = named;
  box._undo = undo;
  box._steps = [];
  return box;
}

function rowFor(box, step) {
  const li = el('li', `step ${step.status}`);
  if (step.id) li.dataset.call = step.id;
  const d = el('details', 'step-detail');
  const s = el('summary', 'step-head');
  s.append(stepIcon(step.icon), el('span', 'step-verb'), el('span', 'step-ms'));
  const body = el('div', 'step-body');
  d.append(s, body);
  li.append(d);
  step.li = li;
  step.body = body;
  box.querySelector('.steps-list').append(li);
}

function fillRow(step) {
  const li = step.li;
  li.className = `step ${step.status}`;
  const verb = step.status === 'running' ? step.now : step.status === 'waiting' ? t('Waiting for your OK: {what}', { what: step.done }) : step.status === 'denied' && step.timedOut ? t('Not approved in time: {what}', { what: step.done }) : step.status === 'denied' ? t('Not allowed: {what}', { what: step.done }) : step.status === 'error' ? t("Didn't work: {what}", { what: step.done }) : step.done;
  li.querySelector('.step-verb').textContent = verb;
  li.querySelector('.step-ms').textContent = step.ms !== undefined && step.status !== 'running' && step.status !== 'waiting' ? fmtDuration(step.ms) : '';
  const body = step.body;
  // What ran (the command or the call's summary), then what came back.
  if (!body.querySelector('.step-what')) {
    const what = el('code', 'step-what', step.what || step.name);
    const raw = el('span', 'tool-raw', step.name);
    const head = el('div', 'step-what-row');
    head.append(what, raw);
    body.prepend(head);
  }
  let out = body.querySelector('.step-out');
  if (step.output !== undefined) {
    if (!out) {
      out = el('pre', 'step-out');
      body.append(out);
    }
    out.textContent = String(step.output ?? '').slice(0, DETAIL_LIMIT) || t('(no output)');
  }
  if (step.status === 'ok' && SKILL_SAVES.has(step.name)) skillActions(step);
}

// 3.0.3: a skill she saved or changed (no OK needed by default): Open it, or Undo (a new skill goes
// to the trash; a change goes back to the version kept before it).
const SKILL_SAVES = new Set(['skill_save', 'recipe_save', 'skill_update']);
const SAVED_RE = /^(Saved|Updated|Changed) skill "([a-z0-9-]{1,64})"/;
async function skillApi(path, method = 'GET', body) {
  const res = await fetch(`/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function skillActions(step) {
  const m = SAVED_RE.exec(String(step.output ?? ''));
  if (!m || step.li.querySelector('.skill-saved-acts')) return;
  const [, how, name] = m;
  const row = step.li.querySelector('.step-head');
  if (!row) return;
  const box = el('span', 'skill-saved-acts');
  const open = el('a', 'step-link small', t('Open skill'));
  open.href = '/#view=settings:ab-skills';
  const undo = el('button', 'step-link small linkish', t('Undo'));
  undo.type = 'button';
  undo.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    undo.disabled = true;
    try {
      const enc = encodeURIComponent;
      let scope = 'companion';
      let v = await skillApi(`/skills/companion/${enc(name)}`).catch(() => null);
      if (!v && how === 'Changed') {
        scope = 'shared';
        v = await skillApi(`/skills/shared/${enc(name)}`);
      }
      if (!v) throw new Error(t('That skill is gone already.'));
      if (how === 'Saved') await skillApi(`/skills/${scope}/${enc(name)}`, 'DELETE');
      else {
        const prev = v.versions?.[0]?.version;
        if (!prev) throw new Error(t('No earlier version to go back to.'));
        await skillApi(`/skills/${scope}/${enc(name)}/restore`, 'POST', { version: prev });
      }
      box.replaceChildren(el('span', 'small muted', how === 'Saved' ? t('Undone: the skill is in the trash.') : t('Undone: back to the version before.')));
    } catch (err) {
      undo.disabled = false;
      undo.title = err.message;
      box.append(el('span', 'small muted', ` ${err.message}`));
    }
  });
  box.append(open, ' ', undo);
  row.append(box);
}

function render(box) {
  const steps = box._steps;
  const running = steps.find((s) => s.status === 'running' || s.status === 'waiting');
  // Finished steps with the same words are counted once ("Wrote a file ×2 0.2 s").
  const groups = [];
  for (const s of steps) {
    const g = groups.at(-1);
    if (g && s.status === 'ok' && g.status === 'ok' && g.done === s.done && s.kind !== 'memory') {
      g.n += 1;
      g.ms = (g.ms ?? 0) + (s.ms ?? 0);
    } else groups.push({ ...s, n: 1 });
  }
  const said = (s) => (s.status === 'error' ? t("Didn't work: {what}", { what: s.done }) : s.status === 'denied' && s.timedOut ? t('Not approved in time: {what}', { what: s.done }) : s.status === 'denied' ? t('Not allowed: {what}', { what: s.done }) : s.done);
  const parts = groups.map((s) => (s.status === 'running' ? s.now : s.status === 'waiting' ? t('Waiting for your OK') : `${s.n > 1 ? `${said(s)} ×${s.n}` : said(s)}${s.ms !== undefined && s.kind !== 'memory' ? ` ${fmtDuration(s.ms)}` : ''}`));
  // Long turns: the first two, the one running now, then "+3 more".
  const runningAt = groups.findIndex((s) => s.status === 'running' || s.status === 'waiting');
  const shown = parts.length > 4 ? [...parts.slice(0, 2), ...(runningAt >= 2 ? [parts[runningAt]] : []), t('+{n} more', { n: parts.length - (runningAt >= 2 ? 3 : 2) })] : parts;
  box.querySelector('.steps-text').textContent = shown.join(' · ');
  const total = steps.filter((s) => s.ms !== undefined).reduce((n, s) => n + s.ms, 0);
  box.querySelector('.steps-total').textContent = !running && total >= 1000 && steps.length > 1 ? fmtDuration(total) : '';
  box.classList.toggle('live', Boolean(running));
  box.classList.toggle('has-error', steps.some((s) => s.status === 'error'));
  box.querySelector('.steps-sum').setAttribute('aria-label', `${t('What she did')}: ${parts.join(', ')}`);
  // V4b: the run timeline (web/run-timeline.js) redraws its head, marks and footer.
  box._after?.(box);
}

/** A tool call starts (or comes from history with its result already). */
export function addStep(box, { id, name, summary, args, status = 'running', output, ms, snapshotId, timedOut }) {
  const named = box._named(name) || '';
  const [now, done, icon] = stepWords(name, args, named);
  const command = name === 'shell' ? String(args?.command ?? '') : '';
  const step = { kind: 'tool', id, name, args, now, done, icon, status, what: command || summary || name, output, ms, ...(timedOut ? { timedOut: true } : {}) };
  rowFor(box, step);
  box._steps.push(step);
  fillRow(step);
  if (snapshotId) box._undo(step.body, snapshotId);
  render(box);
  return step;
}

const find = (box, id) => box._steps.find((s) => s.id === id) ?? box._steps.findLast((s) => s.status === 'running' || s.status === 'waiting');

/** Waiting for the owner's OK (an approval card is showing). */
export function waitStep(box, id) {
  const s = find(box, id);
  if (!s) return;
  s.status = 'waiting';
  fillRow(s);
  render(box);
}

/** An approved call starts running. */
export function runStep(box, id) {
  const s = find(box, id);
  if (!s) return;
  s.status = 'running';
  fillRow(s);
  render(box);
}

/** A call's result arrived. */
export function finishStep(box, { id, status, output, ms, snapshotId, timedOut }) {
  const s = find(box, id);
  if (!s) return null;
  s.status = status;
  // 3.0.3: the approval card ran out unanswered ("Not approved in time"), not a "no".
  if (timedOut) s.timedOut = true;
  s.output = output;
  s.ms = ms;
  fillRow(s);
  if (snapshotId) box._undo(s.body, snapshotId);
  render(box);
  return s.body;
}

/** The memories she used in this reply (ids from the reply's meta), as the first step. */
// V4d: the notes she already had and used for this reply (recalled, not saved this turn: the
// owner read "Remembered n things" as new notes). `ids` (the reply's meta.memoryIds) open exactly
// those notes; without them the link opens Memory.
export function memoryStep(box, count, { ids = [], open } = {}) {
  if (!count || box._steps.some((s) => s.kind === 'memory')) return;
  const done = count === 1 ? t('Used 1 memory') : t('Used {n} memories', { n: count });
  const why = t('Things she already knew about you that shaped this reply.');
  const step = { kind: 'memory', name: 'memory', now: done, done, icon: 'memory', status: 'ok' };
  const li = el('li', 'step ok memory');
  const row = el('div', 'step-head');
  const verb = el('span', 'step-verb', done);
  verb.title = why;
  row.append(stepIcon('memory'), verb);
  const link = el('a', 'step-link small', t('See what she remembers'));
  link.href = '/#view=memory';
  if (ids.length && open) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      open(ids);
    });
  }
  row.append(link);
  li.append(row, el('p', 'step-sub muted small', why));
  step.li = li;
  box.querySelector('.steps-list').prepend(li);
  box._steps.unshift(step);
  render(box);
}

/**
 * 3.0.3: the notes she saved from this turn (her tools during the reply, or the memory worker once the
 * chat went quiet: `meta.savedMemoryIds`), right after "Used n memories". The link opens Memory with
 * exactly those notes highlighted.
 */
export function savedStep(box, count, { ids = [], open } = {}) {
  if (!count || box._steps.some((s) => s.kind === 'saved')) return;
  const done = count === 1 ? t('Saved 1 new memory') : t('Saved {n} new memories', { n: count });
  const why = t('New things she noted about you from this conversation.');
  const step = { kind: 'saved', name: 'saved', now: done, done, icon: 'memory', status: 'ok' };
  const li = el('li', 'step ok memory saved');
  const row = el('div', 'step-head');
  const verb = el('span', 'step-verb', done);
  verb.title = why;
  row.append(stepIcon('memory'), verb);
  const link = el('a', 'step-link small', t('See them in Memory'));
  link.href = '/#view=memory';
  if (ids.length && open) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      open(ids);
    });
  }
  row.append(link);
  li.append(row, el('p', 'step-sub muted small', why));
  step.li = li;
  // After "Used n memories" when there is one, else first.
  const used = box._steps.findIndex((s) => s.kind === 'memory' && s.name === 'memory');
  if (used >= 0) {
    box._steps[used].li.after(li);
    box._steps.splice(used + 1, 0, step);
  } else {
    box.querySelector('.steps-list').prepend(li);
    box._steps.unshift(step);
  }
  render(box);
}

/**
 * Phase 85: a note she remembered on her own, as a step where it happened ("Remembered on her own:
 * the same error before"). The chip under the step line has the note itself and "Not useful".
 */
export function recallStep(box, what) {
  const done = t('Remembered on her own: {what}', { what });
  const step = { kind: 'memory', name: 'recall', now: done, done, icon: 'recall', status: 'ok' };
  const li = el('li', 'step ok memory recall');
  const row = el('div', 'step-head');
  row.append(stepIcon('recall'), el('span', 'step-verb', done));
  li.append(row);
  step.li = li;
  box.querySelector('.steps-list').append(li);
  box._steps.push(step);
  render(box);
}

/** Phase 96: a skill loaded up front for this reply ("Used skill: …"; the link opens Settings → Skills). */
export function skillStep(box, name) {
  if (!name || box._steps.some((s) => s.kind === 'skill' && s.skill === name)) return;
  const done = t('Used skill: {name}', { name });
  const step = { kind: 'skill', skill: name, name: 'skill', now: done, done, icon: 'book', status: 'ok' };
  const li = el('li', 'step ok skill');
  const row = el('div', 'step-head');
  row.append(stepIcon('book'), el('span', 'step-verb', done));
  const link = el('a', 'step-link small', t('See her skills'));
  link.href = '/#view=settings:ab-skills';
  row.append(link);
  li.append(row);
  step.li = li;
  box.querySelector('.steps-list').prepend(li);
  box._steps.unshift(step);
  render(box);
}

/** Phase 98: what a plugin did in this turn, as one line in the step list (never her own step). */
export function pluginStep(box, words, what) {
  if (!words || box._steps.some((s) => s.kind === 'plugin' && s.done === words)) return;
  const bad = what === 'skipped' || what === 'dropped';
  const step = { kind: 'plugin', name: 'plugin', now: words, done: words, icon: 'tool', status: bad ? 'error' : 'ok' };
  const li = el('li', `step ${bad ? 'error' : 'ok'} plugin`);
  const row = el('div', 'step-head');
  row.append(stepIcon('tool'), el('span', 'step-verb', words));
  const link = el('a', 'step-link small', t('Plugins'));
  link.href = '/#view=settings:ab-plugins';
  row.append(link);
  li.append(row);
  step.li = li;
  box.querySelector('.steps-list').append(li);
  box._steps.push(step);
  render(box);
}

/**
 * Phase 78: "Show the run" at the end of the step list: opens the Run view (web/run-view.js) for
 * this reply's run (every step's model, tokens, cost, tools, files and memory picks).
 */
export function runLink(box, runId, open) {
  if (!runId || box._runId === runId) return;
  box._runId = runId;
  box.querySelector('.step-run')?.remove();
  const li = el('li', 'step step-run');
  const btn = el('button', 'step-link small run-open');
  btn.type = 'button';
  // 3.3.0 (ezplain): plain words; the Run view itself keeps the technical details.
  btn.append(stepIcon('compass'), el('span', '', t('How she answered')));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    open(runId);
  });
  li.append(btn);
  box.querySelector('.steps-list').append(li);
  box._after?.(box);
}

/**
 * Phase 79: the reply's budget meter (web/budget-view.js) at the end of the line's summary, replaced
 * as the turn goes on.
 */
export function setBudget(box, meter) {
  if (!box || !meter) return;
  const sum = box.querySelector('.steps-sum');
  sum.querySelector('.budget-meter')?.remove();
  sum.append(meter);
}

/** True when a line has anything to show. */
export const hasSteps = (box) => Boolean(box?._steps?.length);
