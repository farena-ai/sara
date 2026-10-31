// Phase 75 (stage 1, "her work on screen"): the step line under each reply. Built from the tool
// events the chat stream already sends (tool_call / approval / tool_running / tool_result) and,
// after a reload, from the stored tool messages; the memories she used in the reply count as a
// step too. One quiet line, collapsed: "Remembered 2 things · Checked the weather 0.4 s · Added a
// to-do"; live while she works ("Checking the weather…"); one tap or click opens the details of
// every step (what ran, the output, how long). Replaces the grey "$ command" boxes.
import { locale, t } from './naming.js';
import { icon } from './icons.js';

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

const TEST_CMD = /(^|[;&|(\s])(npm (run )?(test|check)\b|npm t\b|yarn test|pnpm (run )?test|bun test|node (--\S+ )*--test\b|npx (jest|vitest|mocha)\b|jest\b|vitest\b|pytest\b|python3? -m (pytest|unittest)\b|cargo test\b|go test\b|deno test\b|make (check|test)\b|dotnet test\b)/;

/**
 * The words for one step: [while running, when done, icon]. Known tools read as everyday verbs;
 * others fall back to their plain name (TOOL_NAME in app.js, passed as `named`) or the raw name.
 */
export function stepWords(name, args = {}, named = '') {
  const a = args ?? {};
  const cmd = String(a.command ?? a.url ?? '');
  const act = String(a.action ?? '');
  const pair = (now, done, icon) => [now, done, icon];
  if (/\bwttr\.in\b/i.test(cmd) && (name === 'shell' || name === 'web_fetch')) return pair(t('Checking the weather…'), t('Checked the weather'), 'weather');
  switch (name) {
    case 'shell':
      if (TEST_CMD.test(cmd)) return pair(t('Running the tests…'), t('Ran the tests'), 'flask');
      if (/^\s*git\b/.test(cmd)) return pair(t('Checking the project…'), t('Checked the project'), 'branch');
      if (/\b(npm|pnpm|yarn) (i|install|ci|add)\b|\bpip3? install\b/.test(cmd)) return pair(t('Installing packages…'), t('Installed packages'), 'package');
      if (/\b(npm run build|make\b|tsc\b|cargo build|go build|vite build)/.test(cmd)) return pair(t('Building the project…'), t('Built the project'), 'wrench');
      return pair(t('Running a command…'), t('Ran a command'), 'terminal');
    case 'todo':
      if (act === 'add') return pair(t('Adding a to-do…'), t('Added a to-do'), 'todo');
      if (act === 'done') return pair(t('Ticking off a to-do…'), t('Ticked off a to-do'), 'todo');
      if (act === 'list') return pair(t('Looking at your to-dos…'), t('Looked at your to-dos'), 'todo');
      return pair(t('Updating your to-dos…'), t('Updated your to-dos'), 'todo');
    case 'remind':
      if (act === 'set') return pair(t('Setting a reminder…'), t('Set a reminder'), 'reminder');
      if (act === 'cancel') return pair(t('Cancelling a reminder…'), t('Cancelled a reminder'), 'reminder');
      return pair(t('Checking your reminders…'), t('Checked your reminders'), 'reminder');
    case 'note':
      if (act === 'save') return pair(t('Saving a note…'), t('Saved a note'), 'note');
      return pair(t('Looking through your notes…'), t('Looked through your notes'), 'note');
    case 'recall':
      return pair(t('Looking back at past chats…'), t('Looked back at past chats'), 'recall');
    case 'web_search':
      return pair(t('Searching the web…'), t('Searched the web'), 'search');
    // Phase 100: other agents (A2A).
    case 'a2a_send':
      return pair(t('Asking {name}…', { name: String(a.peer ?? '') }), t('Asked {name}', { name: String(a.peer ?? '') }), 'globe');
    case 'a2a_reply':
      return pair(t('Answering {name}…', { name: String(a.peer ?? t('the agent')) }), t('Answered the agent'), 'globe');
    case 'a2a_status':
      return pair(t('Checking on a task…'), t('Checked on a task'), 'globe');
    case 'a2a_cancel':
      return pair(t('Canceling a task…'), t('Canceled a task'), 'globe');
    case 'a2a_agents':
      return pair(t('Looking at the agents she can ask…'), t('Looked at the agents she can ask'), 'globe');
    case 'web_fetch':
      return pair(t('Reading a web page…'), t('Read a web page'), 'globe');
    case 'calendar_events':
      return pair(t('Looking at your calendar…'), t('Looked at your calendar'), 'calendar');
    case 'calendar_add':
      return pair(t('Adding to your calendar…'), t('Added to your calendar'), 'calendar');
    case 'read_file':
      return pair(t('Reading a file…'), t('Read a file'), 'file');
    case 'write_file':
      return pair(t('Writing a file…'), t('Wrote a file'), 'file-edit');
    case 'edit_file':
      return pair(t('Editing a file…'), t('Edited a file'), 'file-edit');
    case 'list_dir':
    case 'search':
    case 'code_map':
    case 'code_find':
    case 'code_refs':
    case 'code_deps':
      return pair(t('Looking through the files…'), t('Looked through the files'), 'files');
    case 'home_status':
      return pair(t('Checking your home…'), t('Checked your home'), 'home');
    case 'home_control':
      return pair(t('Changing something at home…'), t('Changed something at home'), 'home');
    case 'take_photo':
      return pair(t('Making a picture…'), t('Made a picture'), 'photo');
    case 'share_photo':
      return pair(t('Picking a picture…'), t('Sent a picture'), 'photo');
    case 'moments':
      return pair(t('Looking through your moments…'), t('Looked through your moments'), 'moments');
    case 'start_job':
      return pair(t('Starting a background task…'), t('Started a background task'), 'job');
    case 'job_status':
      return pair(t('Checking a background task…'), t('Checked a background task'), 'job');
    case 'gmail_search':
    case 'gmail_read':
    case 'gmail_thread':
    case 'gmail_needs_answer':
      return pair(t('Checking your email…'), t('Checked your email'), 'mail');
    case 'gmail_draft':
      return pair(t('Writing an email draft…'), t('Wrote an email draft'), 'mail');
    case 'gmail_send':
      return pair(t('Sending an email…'), t('Sent an email'), 'mail');
    case 'git':
      return pair(t('Checking the project…'), t('Checked the project'), 'branch');
    case 'git_commit':
      return pair(t('Saving a checkpoint…'), t('Saved a checkpoint'), 'branch');
    case 'git_push':
      return pair(t('Sending work to GitHub…'), t('Sent work to GitHub'), 'branch');
    case 'library':
      return pair(t('Reading your documents…'), t('Read your documents'), 'book');
    // Phase 96: her skills (how-tos she follows).
    case 'skill_use':
      return pair(t('Opening a skill…'), t('Used skill: {name}', { name: String(a.name ?? '') }), 'book');
    case 'skill_read':
      return pair(t('Reading a skill file…'), t('Read a skill file'), 'book');
    case 'skill_find':
      return pair(t('Looking for a skill…'), t('Looked for a skill'), 'search');
    case 'skill_run':
      return pair(t("Running a skill's script…"), t("Ran a skill's script"), 'terminal');
    case 'skill_save':
    case 'recipe_save':
      return pair(t('Saving a skill…'), t('Saved a skill'), 'book');
    case 'skill_update':
      return pair(t('Changing a skill…'), t('Changed a skill'), 'book');
    case 'settings_guide':
      return pair(t('Looking up how the app works…'), t('Looked up how the app works'), 'help');
    case 'preview_start':
      return pair(t('Starting a preview…'), t('Started a preview'), 'monitor');
    default:
      if (/^browser_/.test(name)) return pair(t('Using her test browser…'), t('Used her test browser'), 'compass');
      return [t('Using {tool}…', { tool: named || name }), t('Used {tool}', { tool: named || name }), 'tool'];
  }
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
  const verb = step.status === 'running' ? step.now : step.status === 'waiting' ? t('Waiting for your OK: {what}', { what: step.done }) : step.status === 'denied' ? t('Not allowed: {what}', { what: step.done }) : step.status === 'error' ? t("Didn't work: {what}", { what: step.done }) : step.done;
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
  const said = (s) => (s.status === 'error' ? t("Didn't work: {what}", { what: s.done }) : s.status === 'denied' ? t('Not allowed: {what}', { what: s.done }) : s.done);
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
}

/** A tool call starts (or comes from history with its result already). */
export function addStep(box, { id, name, summary, args, status = 'running', output, ms, snapshotId }) {
  const named = box._named(name) || '';
  const [now, done, icon] = stepWords(name, args, named);
  const command = name === 'shell' ? String(args?.command ?? '') : '';
  const step = { kind: 'tool', id, name, now, done, icon, status, what: command || summary || name, output, ms };
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
export function finishStep(box, { id, status, output, ms, snapshotId }) {
  const s = find(box, id);
  if (!s) return null;
  s.status = status;
  s.output = output;
  s.ms = ms;
  fillRow(s);
  if (snapshotId) box._undo(s.body, snapshotId);
  render(box);
  return s.body;
}

/** The memories she used in this reply (ids from the reply's meta), as the first step. */
export function memoryStep(box, count) {
  if (!count || box._steps.some((s) => s.kind === 'memory')) return;
  const done = count === 1 ? t('Remembered 1 thing') : t('Remembered {n} things', { n: count });
  const step = { kind: 'memory', name: 'memory', now: done, done, icon: 'memory', status: 'ok' };
  const li = el('li', 'step ok memory');
  const row = el('div', 'step-head');
  row.append(stepIcon('memory'), el('span', 'step-verb', done));
  const link = el('a', 'step-link small', t('See what she remembers'));
  link.href = '/#view=memory';
  row.append(link);
  li.append(row);
  step.li = li;
  box.querySelector('.steps-list').prepend(li);
  box._steps.unshift(step);
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
  btn.append(stepIcon('compass'), el('span', '', t('Show the run')));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    open(runId);
  });
  li.append(btn);
  box.querySelector('.steps-list').append(li);
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
