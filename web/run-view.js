// Phase 78 (harness track M3): the Run view. Opened from \"Show the run\" on a reply's step line
// (web/steps.js). Phase 83 (M8): each step of a reply has \"Branch from here\" (web/branch-view.js);
// a branch shows where it came from and compares with its original; a run lists its branches. Each step with its time, model, tokens
// and cost, the tools it ran (status, approval, files, output), the memory notes that went in (ids,
// sureness and why, never their text: no memory is fetched here), plan-check findings, and in
// coding conversations git HEAD with the dirty files. \"What was sent\" loads that step's prompt
// (system prompt from its stored copy + the history it saw) only when asked.
// Desktop: a window; phone: a full-screen sheet (CSS in look.css, `.run-view`).
import { locale, t } from './naming.js';
import { icon } from './icons.js';
import { fmtDuration, stepWords } from './steps.js';
import { budgetMeter } from './budget-view.js';
import { editWords, openBranchSheet, openDiffSheet } from './branch-view.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const runGlyph = (name, cls = 'run-icon') => {
  const s = el('span', cls);
  s.setAttribute('aria-hidden', 'true');
  const svg = icon(name) ?? icon('tool');
  if (svg) s.append(svg);
  return s;
};

const nf = (n, d = 0) => Number(n ?? 0).toLocaleString(locale(), { maximumFractionDigits: d });
const tokens = (n) => (n >= 10_000 ? `${nf(n / 1000, 1)}k` : nf(n));

/** \"about $0.0042\" / \"local\" / \"$0 (subscription)\" / \"cost unknown\" for a set of calls. */
function costWords(calls) {
  if (!calls.length) return '';
  const paid = calls.filter((c) => (c.billing ?? 'api') === 'api');
  if (!paid.length) return calls.some((c) => c.billing === 'subscription') ? t('$0 (subscription)') : t('local');
  if (paid.some((c) => !c.reported)) return t('cost unknown (no token counts)');
  if (paid.some((c) => c.usd === null)) return t('cost unknown (no price for this model)');
  const usd = paid.reduce((n, c) => n + (c.usd ?? 0), 0);
  return t('about {usd}', { usd: `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` });
}

const KIND = { turn: () => t('A reply'), job: () => t('A background job'), team: () => t('A team task'), eval: () => t('A test run'), redteam: () => t('A break-it run') };
const STATUS = {
  ok: () => t('finished'),
  error: () => t('ended with an error'),
  stopped: () => t('stopped'),
  running: () => t('still running'),
  interrupted: () => t('cut off by a restart'),
  budget: () => t('stopped at its budget'),
  limit: () => t('stopped at a limit'),
  blocked: () => t('blocked by a safety check'),
};
const STOPPED = { contradiction: () => t('stopped: goes against a decision'), minors: () => t('stopped: safety check'), steps: () => t('stopped: step limit'), budget: () => t('stopped: budget'), gate: () => t('stopped: waiting for your OK') };
const APPROVAL = { auto: () => t('ran without asking'), allowed: () => t('you allowed it'), denied: () => t('you said no'), refused: () => t('not allowed here') };
const TOOL_STATUS = { ok: () => t('done'), error: () => t('failed'), denied: () => t('not run') };
const SURE = { high: () => t('sure: high'), medium: () => t('sure: medium'), low: () => t('sure: low') };
const PURPOSE = { 'safety check': () => t('safety check'), 'claim check': () => t('claim check'), 'claim judge': () => t('claim check'), 'plan judge': () => t('plan check'), agent: () => t('agent') };

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
const dayTime = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Step labels the server writes in fixed English words, in the app's language. */
function labelText(label) {
  if (!label) return '';
  if (label === 'Report') return t('Her report');
  const job = /^(Background|Agent) job #(\d+)$/.exec(label);
  if (job) return job[1] === 'Agent' ? t('Agent job #{id}', { id: job[2] }) : t('Background job #{id}', { id: job[2] });
  return PURPOSE[label]?.() ?? label;
}

function chip(text, cls = '') {
  return el('span', `run-chip${cls ? ` ${cls}` : ''}`, text);
}

function stat(label, value) {
  const c = el('div', 'run-stat');
  c.append(el('span', 'run-stat-v', value), el('span', 'run-stat-l muted small', label));
  return c;
}

/** One memory pick (from M1's meta): \"Note #12 · sure: high · matched dog, biscuit\". */
function pickRow(p) {
  const li = el('li', 'run-pick');
  const why = [];
  if (p.words?.length) why.push(t('matched {words}', { words: p.words.join(', ') }));
  if (p.meaning) why.push(t('close in meaning'));
  if (p.standing) why.push(t('standing note'));
  if (p.pinned) why.push(t('pinned'));
  if (p.old) why.push(t('older, may be out of date'));
  li.append(el('span', 'run-pick-id', t('Note #{id}', { id: p.id })), chip(SURE[p.sure]?.() ?? String(p.sure ?? '')), el('span', 'muted small', why.join(' · ')));
  return li;
}

function toolRow(x, named) {
  const li = el('li', `run-tool ${x.status}`);
  const d = el('details', 'run-tool-d');
  const s = el('summary', 'run-tool-head');
  const [, done, ic] = stepWords(x.name, x.args, named(x.name));
  s.append(runGlyph(ic), el('span', 'run-tool-verb', done), chip(TOOL_STATUS[x.status]?.() ?? x.status, x.status === 'ok' ? 'ok' : 'bad'), el('span', 'muted small', [APPROVAL[x.approval]?.() ?? '', fmtDuration(x.ms)].filter(Boolean).join(' · ')));
  const body = el('div', 'run-tool-body');
  const what = el('code', 'run-what', x.name === 'shell' ? String(x.args?.command ?? x.summary) : x.summary || x.name);
  body.append(what);
  if (x.files?.length) body.append(el('p', 'small', `${t('Files')}: ${x.files.join(', ')}`));
  if (x.snapshotId) body.append(el('p', 'muted small', t('Undo point saved before it')));
  for (const c of x.contradictions ?? []) body.append(el('p', 'run-contra small', `${c.act === 'stop' ? t('Stopped for your OK') : t('Flagged')}: “${c.note}”${c.answer ? ` · ${c.answer === 'override' ? t('you said do it anyway') : c.answer === 'update' ? t('you asked to update the note') : t('you said no')}` : ''}`));
  const out = el('pre', 'run-out', x.output || t('(no output)'));
  body.append(out);
  if (x.outputChars > x.output.length) body.append(el('p', 'muted small', t('Output shortened here: {n} characters in all.', { n: nf(x.outputChars) })));
  d.append(s, body);
  li.append(d);
  return li;
}

function section(title, ...children) {
  const box = el('div', 'run-sec');
  box.append(el('h4', 'run-sec-h', title), ...children);
  return box;
}

function stepCard(run, step, api, named, branchable, ctx, replan = false) {
  const d = el('details', `run-step${step.stopped ? ' stopped' : ''}`);
  const s = el('summary', 'run-step-head');
  const n = el('span', 'run-step-n', String(step.idx + 1));
  n.setAttribute('aria-label', t('Step {n}', { n: step.idx + 1 }));
  // What the step did, in words (the tools' verbs, or her answer); the model goes on the line below.
  const did = step.tools.map((x) => {
    const [, done] = stepWords(x.name, x.args, named(x.name));
    return x.status === 'ok' ? done : x.status === 'denied' ? t('Not allowed: {what}', { what: done }) : t("Didn't work: {what}", { what: done });
  });
  const title = el('span', 'run-step-title', labelText(step.label) || (did.length ? did.join(' · ') : step.replyMessageId ? t('Answered') : t('Step {n}', { n: step.idx + 1 })));
  const meta = el('span', 'run-step-meta muted small', [time(step.at), step.label ? '' : step.model, step.calls.length ? `${tokens(step.tokensIn)} ${t('in')} · ${tokens(step.tokensOut)} ${t('out')}` : '', costWords(step.calls), step.ms ? fmtDuration(step.ms) : ''].filter(Boolean).join(' · '));
  const chips = el('span', 'run-step-chips');
  if (step.tools.length) chips.append(chip(step.tools.length === 1 ? t('1 tool') : t('{n} tools', { n: step.tools.length })));
  if (step.memoryPicks.length) chips.append(chip(step.memoryPicks.length === 1 ? t('1 note') : t('{n} notes', { n: step.memoryPicks.length })));
  if (step.contradictions.length) chips.append(chip(t('plan check'), 'warn'));
  if (step.stopped) chips.append(chip(STOPPED[step.stopped]?.() ?? step.stopped, 'bad'));
  if (step.tools.some((x) => x.status === 'error')) chips.append(chip(t('a tool failed'), 'bad'));
  s.append(n, title, chips, meta);
  d.append(s);
  const body = el('div', 'run-step-body');
  d.append(body);
  // Filled on first open (lists can be long).
  d.addEventListener('toggle', () => {
    if (!d.open || body.childElementCount) return;
    // Phase 83: carry on from this step with something changed (a new run; this one stays).
    if (branchable && step.systemSha && !step.label) {
      const row = el('div', 'run-branch-row');
      const b = el('button', 'ghost small run-branch');
      b.type = 'button';
      b.append(runGlyph('branch'), el('span', '', replan ? t('Re-plan from here') : t('Branch from here')));
      b.addEventListener('click', () => void openBranchSheet(run, step, ctx));
      row.append(b, el('span', 'muted small', replan ? t('She plans again from this step with what she saw then. Nothing she did on your computer is repeated: each new action asks you first.') : t('Change your message, a result, a note or the model, and see what she does then.')));
      body.append(row);
    }
    if (step.calls.length) {
      const ul = el('ul', 'run-calls');
      for (const c of step.calls) {
        const li = el('li', `run-call${c.ok ? '' : ' bad'}`);
        li.append(el('strong', '', c.model), el('span', 'muted small', ` ${c.provider}`), el('span', 'small', ` · ${tokens(c.in)} ${t('in')} · ${tokens(c.out)} ${t('out')} · ${costWords([c])} · ${fmtDuration(c.ms)}${c.firstMs !== undefined ? ` (${t('first word after {s}', { s: fmtDuration(c.firstMs) })})` : ''}`));
        if (c.purpose) li.append(chip(PURPOSE[c.purpose]?.() ?? c.purpose));
        if (!c.ok) li.append(el('span', 'run-err small', ` ${t('failed')}: ${c.error ?? ''}`));
        ul.append(li);
      }
      body.append(section(t('Model calls'), ul));
    }
    if (step.memoryPicks.length) {
      const ul = el('ul', 'run-picks');
      for (const p of step.memoryPicks) ul.append(pickRow(p));
      body.append(section(t('What she remembered'), ul, el('p', 'muted small', step.policyId ? t('Memory policy {id}', { id: step.policyId }) : '')));
    }
    if (step.tools.length) {
      const ul = el('ul', 'run-tools');
      for (const x of step.tools) ul.append(toolRow(x, named));
      body.append(section(t('Tools'), ul));
    }
    if (step.contradictions.length && !step.tools.some((x) => x.contradictions?.length)) {
      const ul = el('ul', 'run-contras');
      for (const c of step.contradictions) ul.append(el('li', 'run-contra small', `“${c.note}” · ${c.act === 'stop' ? t('Stopped for your OK') : t('Flagged')}`));
      body.append(section(t('Plan check'), ul));
    }
    const ref = step.workspaceRef;
    if (ref && (ref.head || ref.branch || ref.error)) {
      const lines = [el('p', 'small', ref.head ? t('Commit {head} on {branch}', { head: ref.head.slice(0, 10), branch: ref.branch ?? '?' }) : ref.error ? t("Couldn't read the repository: {error}", { error: ref.error }) : t('Branch {branch}', { branch: ref.branch ?? '?' }))];
      if (ref.dirty?.length) {
        const ul = el('ul', 'run-dirty small');
        for (const f of ref.dirty.slice(0, 50)) ul.append(el('li', '', `${f.path}${f.sha ? ` · ${f.sha}` : f.gone ? ` · ${t('removed')}` : ''}`));
        lines.push(el('p', 'muted small', ref.dirty.length === 1 ? t('1 changed file not committed yet:') : t('{n} changed files not committed yet:', { n: ref.dirty.length + (ref.more ?? 0) })), ul);
      } else if (ref.dirty) lines.push(el('p', 'muted small', t('Nothing changed since that commit.')));
      body.append(section(t('Workspace'), ...lines));
    }
    // What was sent: loaded only when asked.
    const sentBtn = el('button', 'ghost small', t('Show what was sent to the model'));
    sentBtn.type = 'button';
    const sent = el('div', 'run-sent');
    sentBtn.addEventListener('click', async () => {
      sentBtn.disabled = true;
      sent.replaceChildren(el('p', 'muted small', t('Loading…')));
      try {
        const r = await api(`/runs/${run.id}/steps/${step.idx}`);
        const parts = [];
        if (r.prompt.system) {
          const sd = el('details', 'run-prompt');
          sd.append(el('summary', '', t('Her instructions ({n} characters)', { n: nf(r.prompt.system.length) })), el('pre', 'run-out', r.prompt.system));
          parts.push(sd);
        }
        const hd = el('details', 'run-prompt');
        hd.append(el('summary', '', r.prompt.history.length === 1 ? t('1 message of the conversation') : t('{n} messages of the conversation', { n: r.prompt.history.length })));
        for (const m of r.prompt.history) {
          const row = el('div', `run-msg ${m.role}`);
          row.append(el('span', 'run-msg-role small', m.role === 'user' ? t('You') : m.role === 'assistant' ? t('Her') : m.role === 'tool' ? t('Tool result') : m.role), el('pre', 'run-out', m.content || (m.toolCalls ? JSON.stringify(m.toolCalls, null, 1) : '')));
          hd.append(row);
        }
        parts.push(hd);
        if (r.prompt.extra?.length) {
          const xd = el('details', 'run-prompt');
          xd.append(el('summary', '', t('Notes from the app')));
          for (const x of r.prompt.extra) xd.append(el('pre', 'run-out', x));
          parts.push(xd);
        }
        for (const [callId, ch] of Object.entries(r.changes ?? {})) {
          const all = [...ch.added.map((f) => `+ ${f}`), ...ch.changed.map((f) => `~ ${f}`), ...ch.removed.map((f) => `- ${f}`)];
          if (all.length) parts.push(el('p', 'small', `${t('Files it changed')} (${callId}): ${all.join(', ')}`));
        }
        sent.replaceChildren(...parts);
        sentBtn.hidden = true;
      } catch (err) {
        sent.replaceChildren(el('p', 'run-err small', err.message));
        sentBtn.disabled = false;
      }
    });
    if (step.systemSha || step.historyToId) body.append(section(t('Prompt'), sentBtn, sent));
  });
  return d;
}

/**
 * Opens the Run view for a run id. `api` is the app's fetch helper; `named(toolName)` its plain
 * tool names.
 */
export async function openRunView(runId, { api, named = () => '' }) {
  const dlg = document.querySelector('#run-view');
  const body = dlg.querySelector('.run-body');
  body.replaceChildren(el('p', 'muted', t('Loading…')));
  if (!dlg.open) dlg.showModal();
  let data;
  try {
    data = await api(`/runs/${runId}`);
  } catch (err) {
    body.replaceChildren(el('p', 'run-err', err.message));
    return;
  }
  const { run, steps } = data;
  const ctx = { api, named, openRun: (id) => void openRunView(id, { api, named }) };
  const head = el('div', 'run-head');
  const h = el('h2', 'run-title');
  h.append(runGlyph('compass', 'run-icon big'), document.createTextNode(t('The run')));
  head.append(h, el('p', 'muted small', [KIND[run.kind]?.() ?? run.kind, dayTime(run.startedAt), STATUS[run.status]?.() ?? run.status, data.conversation?.title && !run.title ? `“${data.conversation.title}”` : ''].filter(Boolean).join(' · ')));
  if (run.title) head.append(el('p', 'run-ask', run.title));
  // Phase 83: a branch says where it came from and what changed, and compares with its original.
  if (run.parentRunId) {
    const ban = el('div', 'run-branch-banner');
    ban.append(runGlyph('branch'), el('span', '', t('A branch from step {n} of an earlier run', { n: (run.branchedFromStep ?? 0) + 1 })), el('span', 'muted small', editWords(run.branch?.edits ?? []).join(' · ')));
    const cmp = el('button', 'ghost small', t('Compare with the original'));
    cmp.type = 'button';
    cmp.addEventListener('click', () => void openDiffSheet(run.parentRunId, run.id, ctx));
    const up = el('button', 'ghost small', t('Open the original'));
    up.type = 'button';
    up.addEventListener('click', () => void openRunView(run.parentRunId, { api, named }));
    ban.append(cmp, up);
    head.append(ban);
  }
  const calls = steps.flatMap((s) => s.calls);
  const stats = el('div', 'run-stats');
  stats.append(
    stat(t('Steps'), nf(steps.length)),
    stat(t('Model calls'), nf(calls.length)),
    stat(t('Tokens in / out'), `${tokens(run.tokensIn)} / ${tokens(run.tokensOut)}`),
    stat(t('Cost'), costWords(calls) || '–'),
    stat(t('Time'), fmtDuration(run.ms)),
    stat(t('Tools'), nf(steps.reduce((n, s) => n + s.tools.length, 0))),
  );
  // Phase 79: the run's budget (a reply's, a job's or a team task's limits) as a meter.
  const b = run.budget;
  if (b && typeof b === 'object') {
    const limits = b.limits ?? { ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.usd ? { usd: b.usd } : {}), ...(b.steps ? { steps: b.steps } : {}), ...(b.minutes ? { minutes: b.minutes } : {}) };
    const used = b.used ?? { tokens: run.tokensIn + run.tokensOut, usd: run.usd, steps: steps.length, minutes: run.ms / 60_000 };
    const fr = [limits.tokens ? used.tokens / limits.tokens : 0, limits.usd ? used.usd / limits.usd : 0, limits.steps ? used.steps / limits.steps : 0, limits.minutes ? used.minutes / limits.minutes : 0];
    const st = b.limits ? b : { stage: run.status === 'budget' || run.status === 'limit' ? 'reached' : 'meter', limits, used, frac: Math.max(...fr) };
    const c = el('div', 'run-stat run-budget');
    c.append(budgetMeter(st), el('span', 'run-stat-l muted small', t('Budget use')));
    stats.append(c);
  }
  const list = el('ol', 'run-steps');
  const branchable = run.kind === 'turn' && run.status !== 'running' && !data.running;
  // Phase 88: a run that used her hands on a computer "re-plans": nothing she did there is repeated.
  const replan = steps.some((s) => s.tools.some((x) => String(x.name).startsWith('pc_')));
  // A branch's own steps start at the step it was made from; the ones before are its original's.
  for (const s of steps) {
    const li = el('li', '');
    li.append(stepCard(run, s, api, named, branchable, ctx, replan));
    list.append(li);
  }
  // Phase 83: the branches made from this run.
  let branchBox = null;
  if (data.branches?.length) {
    branchBox = el('div', 'run-sec run-branches');
    const ul = el('ul', 'run-branch-list');
    for (const x of data.branches) {
      const li = el('li', 'run-branch-item');
      li.append(runGlyph('branch'), el('span', '', `${t('From step {n}', { n: (x.branchedFromStep ?? 0) + 1 })} · ${editWords(x.edits).join(' · ')}`), el('span', 'muted small', [STATUS[x.status]?.() ?? x.status, `${tokens(x.tokensIn + x.tokensOut)} ${t('tokens')}`, dayTime(x.startedAt)].join(' · ')));
      const cmp = el('button', 'ghost small', t('Compare'));
      cmp.type = 'button';
      cmp.addEventListener('click', () => void openDiffSheet(run.id, x.id, ctx));
      const open = el('button', 'ghost small', t('Open'));
      open.type = 'button';
      open.addEventListener('click', () => void openRunView(x.id, { api, named }));
      li.append(cmp, open);
      ul.append(li);
    }
    branchBox.append(el('h4', 'run-sec-h', t('Branches')), ul);
  }
  const note = el('p', 'muted small run-foot', branchable ? t('Secrets are hidden in what is kept here. Branch from a step to try something else: this run stays as it is. Kept as long as Settings → Data & health → Health says.') : t('Read only. Secrets are hidden in what is kept here. Kept as long as Settings → Data & health → Health says.'));
  body.replaceChildren(...[head, stats, steps.length ? list : el('p', 'muted', t('No steps were recorded for this run.')), branchBox, note].filter(Boolean));
  // A single step opens by itself.
  if (steps.length === 1) list.querySelector('details')?.setAttribute('open', '');
}
