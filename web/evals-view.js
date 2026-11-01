// Phase 84 (harness track M9): the Evals window. Pick which of your own past tasks to use and up to
// three variants (memory fading, the model, sandbox tries, the budget) as cards with pick-lists; see
// the estimate and the hard ceiling before anything runs; follow the runs live; then the result card:
// the winner with its evidence (or "No clear winner"), each task's pair linked to the side-by-side
// diff of the two runs (M8), "Use this setting" / "Keep mine", the settings history, and the optional
// "Re-check monthly" (off by default). Server: src/evals.ts, /api/evals.
import { locale, serverText, t } from './naming.js';
import { icon } from './icons.js';
import { openDiffSheet } from './branch-view.js';
import { openRunView } from './run-view.js';
import { emptyState } from './tidy.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const glyph = (name, cls = 'ev-icon') => {
  const s = el('span', cls);
  s.setAttribute('aria-hidden', 'true');
  const svg = icon(name) ?? icon('flask');
  if (svg) s.append(svg);
  return s;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
};
const raw = (node) => {
  node.dataset.raw = '';
  return node;
};
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const num = (n) => Number(n ?? 0).toLocaleString(locale());
const tokens = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })}M` : n >= 1000 ? `${Math.round(n / 1000).toLocaleString(locale())}k` : num(n));
const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => `$${Number(x ?? 0).toFixed(x && x < 0.1 ? 4 : 2)}`;

const st = { data: null, variants: [], draft: null, open: 0, timer: 0 };

const KIND = { coding: () => t('Coding conversations'), everyday: () => t('Everyday chats'), both: () => t('Coding and everyday') };
const MEMORY = { never: () => t('Never fade'), slow: () => t('Fade slowly (after a year)'), normal: () => t('Fade like a person (after about 4 months)'), custom: () => t('Custom (you pick how fast)') };
const SANDBOX = { risky: () => t('Only risky commands'), every: () => t('Every command'), off: () => t('Off') };
const RECALL = { on: () => t('On'), off: () => t('Off') };
const BUDGET = { tight: () => t('Tight (50k tokens, 10 steps)'), roomy: () => t('Roomy (500k tokens, 80 steps)') };
const STATUS = { draft: () => t('Waiting for your OK'), running: () => t('Running'), judging: () => t('The judge is reading'), done: () => t('Finished'), stopped: () => t('Stopped'), ceiling: () => t('Stopped at the ceiling'), error: () => t('Something went wrong'), interrupted: () => t('Interrupted by a restart') };
const FEEDBACK = { accepted: () => t('you said it worked'), corrected: () => t('you corrected it'), replaced: () => t('you used a re-run instead'), reported: () => t('you reported it'), none: () => '' };
const VERDICT = { better: () => t('better'), worse: () => t('worse'), unclear: () => t('not clear') };
const SKIP = { private: () => t('private (needs local models)'), 'nothing to grade': () => t('nothing to grade it by'), 'cannot rebuild': () => t("can't be rebuilt"), unfinished: () => t('unfinished'), 'no reply': () => t('no reply'), 'someone else': () => t('with someone else') };
const PART = { tests: () => t('tests'), done: () => t('finished'), feedback: () => t('your reaction'), judge: () => t('judge'), findings: () => t('findings'), tokens: () => t('tokens'), steps: () => t('steps'), time: () => t('time'), cost: () => t('cost') };

/** A variant in words (the page's language). */
function variantText(v, i) {
  if (!v || v.id === 'control') return t('Your settings now');
  const models = st.data?.choices.models ?? [];
  const bits = [];
  if (v.memory) bits.push(v.memory.preset === 'custom' ? t('Fading: half-life {n} days', { n: v.memory.halfLifeDays }) : `${t('Fading')}: ${MEMORY[v.memory.preset]?.() ?? v.memory.preset}`);
  if (v.model) bits.push(`${t('Model')}: ${models.find((m) => m.providerId === v.model.providerId && m.model === v.model.model)?.label ?? v.model.model}`);
  if (v.sandbox) bits.push(`${t('Sandbox tries')}: ${SANDBOX[v.sandbox]?.() ?? v.sandbox}`);
  if (v.budget) bits.push(`${t('Budget')}: ${BUDGET[v.budget]?.() ?? v.budget}`);
  if (v.recall) bits.push(`${t('Recall on her own')}: ${RECALL[v.recall]?.() ?? v.recall}`);
  return `${t('Variant {n}', { n: i ?? Number(String(v.id).slice(1)) })}: ${bits.join(' · ')}`;
}

function select(id, options, value, label, tipText) {
  const lab = el('label', 'ev-field');
  lab.append(el('span', '', label), tip(tipText));
  const s = el('select');
  if (id) s.id = id;
  for (const [v, text] of options) {
    const o = el('option', '', text);
    o.value = v;
    s.append(o);
  }
  s.value = value ?? '';
  lab.append(s);
  return { lab, s };
}

/** One variant card with its pick-lists. */
function variantCard(v, i) {
  const card = el('div', 'ev-variant');
  const head = el('div', 'ev-variant-head');
  head.append(glyph('sliders'), el('strong', '', t('Variant {n}', { n: i + 1 })));
  const rm = el('button', 'ghost small', t('Remove'));
  rm.type = 'button';
  rm.addEventListener('click', () => {
    st.variants.splice(i, 1);
    renderVariants();
  });
  head.append(rm);
  card.append(head);
  const now = st.data?.now ?? {};
  const mem = select('', [['', t('Same as now')], ...Object.entries(MEMORY).map(([k, f]) => [k, f()])], v.memory?.preset ?? '', t('Memory fading'), t('How old memory notes fade for this variant. Each task is replayed with the notes this policy would pick for its message (word matches; meaning matches are left out of the re-pick).'));
  const hl = select('', (st.data?.choices.halfLife ?? []).map((d) => [String(d), t('{n} days', { n: d })]), String(v.memory?.halfLifeDays ?? 90), t('Half-life'), t('How many days until an old note counts half as much, for this variant only.'));
  hl.lab.hidden = v.memory?.preset !== 'custom';
  mem.s.addEventListener('change', () => {
    v.memory = mem.s.value ? { preset: mem.s.value, ...(mem.s.value === 'custom' ? { halfLifeDays: Number(hl.s.value) } : {}) } : undefined;
    hl.lab.hidden = mem.s.value !== 'custom';
  });
  hl.s.addEventListener('change', () => {
    if (v.memory) v.memory.halfLifeDays = Number(hl.s.value);
  });
  const models = st.data?.choices.models ?? [];
  const mdl = select('', [['', t('Same as now')], ...models.map((m, k) => [String(k), m.local ? `${m.label} · ${t('on this computer')}` : m.label])], v.model ? String(models.findIndex((m) => m.providerId === v.model.providerId && m.model === v.model.model)) : '', t('Model'), t('Any model you have set up, also ones on this computer. Paid models cost money for every task: the estimate shows how much before anything runs. Private conversations are only used when every model is local.'));
  mdl.s.addEventListener('change', () => {
    const m = models[Number(mdl.s.value)];
    v.model = mdl.s.value !== '' && m ? { providerId: m.providerId, model: m.model } : undefined;
  });
  const sbx = select('', [['', `${t('Same as now')} (${SANDBOX[now.sandbox]?.() ?? ''})`], ...Object.entries(SANDBOX).map(([k, f]) => [k, f()])], v.sandbox ?? '', t('Sandbox tries'), t('Which commands try a throwaway copy first, for this variant. During an eval nobody is watching, so anything that would ask you first is answered No.'));
  sbx.s.addEventListener('change', () => {
    v.sandbox = sbx.s.value || undefined;
  });
  const bud = select('', [['', t('Same as now')], ...Object.entries(BUDGET).map(([k, f]) => [k, f()])], v.budget ?? '', t('Budget'), t("Each task's own limit for this variant. The eval's total ceiling still stops everything at its line."));
  bud.s.addEventListener('change', () => {
    v.budget = bud.s.value || undefined;
  });
  // Phase 85: recall on her own on or off for this variant (does it fix repeated errors faster?).
  const rcl = select('', [['', t('Same as now')], ...Object.entries(RECALL).map(([k, f]) => [k, f()])], v.recall ?? '', t('Recall on her own'), t('Whether she gets notes from her past runs (an error fixed before, a command that failed here) during this variant. Compare On and Off to see if it saves steps.'));
  rcl.s.addEventListener('change', () => {
    v.recall = rcl.s.value || undefined;
  });
  const grid = el('div', 'ev-variant-grid');
  grid.append(mem.lab, hl.lab, mdl.lab, sbx.lab, bud.lab, rcl.lab);
  card.append(grid);
  return card;
}

function renderVariants() {
  const box = $('#ev-variants');
  box.replaceChildren();
  const control = el('div', 'ev-variant ev-control');
  const head = el('div', 'ev-variant-head');
  head.append(glyph('check'), el('strong', '', t('Your settings now')));
  control.append(head, el('p', 'muted small', t('The control: every task is replayed with your settings as they are, so each variant is compared with a fresh run, not with what happened back then.')));
  box.append(control);
  st.variants.forEach((v, i) => box.append(variantCard(v, i)));
  $('#ev-add').disabled = st.variants.length >= (st.data?.choices.maxVariants ?? 3);
}

function chip(text, cls = '') {
  return el('span', `ev-chip ${cls}`.trim(), text);
}

/** The estimate card: the frozen tasks, what was left out, tokens/$/time and the ceiling, Start. */
function renderDraft(ev) {
  const box = $('#ev-draft');
  box.hidden = false;
  box.replaceChildren();
  const e = ev.estimate;
  box.append(el('h4', '', t('Before it starts')));
  const facts = el('p', 'ev-facts');
  facts.append(chip(t('Tasks: {n}', { n: e.tasks })), chip(t('Runs: {n}', { n: e.runs })), chip(t('About {n} tokens', { n: tokens(e.tokens) })), chip(e.paid ? (e.usd === null ? t('Cost: a model has no price') : t('About {usd}', { usd: usd(e.usd) })) : t('Free: models on this computer'), e.paid ? 'chip-warn' : 'chip-ok'), chip(t('Minutes: about {n}', { n: e.minutes })));
  box.append(facts);
  const skipped = Object.entries(ev.skipped ?? {});
  if (skipped.length) box.append(el('p', 'muted small', `${t('Left out')}: ${skipped.map(([k, n]) => `${SKIP[k]?.() ?? k} (${n})`).join(', ')}`));
  const list = el('ol', 'ev-tasks');
  for (const task of ev.tasks.slice(0, 50)) {
    const li = el('li');
    li.append(raw(el('span', 'ev-task-title', task.title)));
    if (task.tests) li.append(chip(t('tests'), 'chip-ok'));
    const fb = FEEDBACK[task.feedback?.kind ?? task.feedback]?.();
    if (fb) li.append(chip(fb));
    if (task.private) li.append(chip(t('private')));
    list.append(li);
  }
  const det = el('details', 'ev-tasklist');
  det.append(el('summary', '', t('The tasks (frozen: running it again uses the same ones)')), list);
  box.append(det);
  const ceil = select('ev-ceiling', (st.data?.choices.ceilings ?? []).filter((c) => c >= e.tokens).map((c) => [String(c), t('{n} tokens', { n: tokens(c) })]), String(ev.ceiling.tokens), t('Hard ceiling'), t('Everything stops at this many tokens in total (and at the $ line for paid models), even in the middle of a task. Results so far are still scored.'));
  if (!ceil.s.options.length) {
    const o = el('option', '', t('{n} tokens', { n: tokens(ev.ceiling.tokens) }));
    o.value = String(ev.ceiling.tokens);
    ceil.s.append(o);
  }
  ceil.s.value = String(ev.ceiling.tokens);
  box.append(ceil.lab);
  if (ev.ceiling.usd) box.append(el('p', 'small', t('And at most {usd} for paid models.', { usd: usd(ev.ceiling.usd) })));
  box.append(el('p', 'muted small', t('Each task is replayed from its first step in a throwaway copy of the project; your real files and conversations are never changed. Anything that would ask you first is answered No.')));
  const row = el('div', 'add-row ev-actions');
  const go = el('button', '', t('Start'));
  go.type = 'button';
  go.addEventListener('click', async () => {
    const c = Number(ceil.s.value);
    if (!confirm(t('Run {runs} replays now, stopping at {n} tokens at most?', { runs: e.runs, n: tokens(c) }))) return;
    go.disabled = true;
    try {
      const r = await api(`/evals/${ev.id}/start`, { method: 'POST', body: { confirm: true, ceiling: { tokens: c } } });
      box.hidden = true;
      st.draft = null;
      await refreshEvals();
      await openEval(r.eval.id);
    } catch (err) {
      $('#ev-status').textContent = err.message;
      go.disabled = false;
    }
  });
  const drop = el('button', 'ghost', t('Discard'));
  drop.type = 'button';
  drop.addEventListener('click', async () => {
    await api(`/evals/${ev.id}`, { method: 'DELETE' }).catch(() => {});
    box.hidden = true;
    st.draft = null;
    await refreshEvals();
  });
  row.append(go, drop);
  box.append(row);
}

function progressBar(p) {
  const bar = el('div', 'ev-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(p.total || 1));
  bar.setAttribute('aria-valuenow', String(p.done));
  const fill = el('span', 'ev-bar-fill');
  // A width class in steps of 5% (no inline style).
  fill.classList.add(`w${Math.round(((p.done || 0) / Math.max(1, p.total)) * 20) * 5}`);
  bar.append(fill);
  return bar;
}

function headlineText(result) {
  if (!result?.headline) return '';
  return t(result.headline.key, result.headline.params ?? {});
}

function evalRow(ev) {
  const b = el('button', `ev-row status-${ev.status}`);
  b.type = 'button';
  const top = el('span', 'ev-row-top');
  top.append(glyph(ev.result?.winner && ev.result.winner !== 'control' ? 'sparkle' : 'flask'), raw(el('strong', 'ev-row-title', ev.title || t('Eval #{n}', { n: ev.id }))), chip(STATUS[ev.status]?.() ?? ev.status, ev.status === 'done' ? 'chip-ok' : ev.status === 'ceiling' || ev.status === 'error' ? 'chip-warn' : ''));
  b.append(top);
  const sub = el('span', 'muted small');
  sub.textContent = ev.result ? headlineText(ev.result) : `${KIND[ev.kind]?.() ?? ev.kind} · ${t('Tasks: {n}', { n: ev.tasks.length })} · ${new Date(ev.createdAt).toLocaleString(locale())}`;
  b.append(sub);
  if (ev.status === 'running' || ev.status === 'judging') b.append(progressBar(ev.progress));
  b.addEventListener('click', () => void openEval(ev.id));
  return b;
}

/** The result card: headline, each variant's evidence, Use this setting / Keep mine, the tasks with their diff links. */
function renderDetail(ev, rows) {
  const box = $('#ev-detail');
  box.hidden = false;
  box.replaceChildren();
  const head = el('div', 'ev-detail-head');
  head.append(raw(el('h4', '', ev.title || t('Eval #{n}', { n: ev.id }))), chip(STATUS[ev.status]?.() ?? ev.status));
  box.append(head);
  const p = ev.progress ?? {};
  const line = el('p', 'small ev-facts');
  line.append(chip(t('Runs: {done} of {total}', { done: p.done ?? 0, total: p.total ?? 0 })), chip(t('Spent: {n} of {max} tokens', { n: tokens(p.tokens ?? 0), max: tokens(ev.ceiling.tokens) })));
  if (p.usd) line.append(chip(t('Spent: {usd}', { usd: usd(p.usd) })));
  if (p.ceilingHit) line.append(chip(t('Ceiling reached'), 'chip-warn'));
  box.append(line);
  if (ev.status === 'running' || ev.status === 'judging') {
    box.append(progressBar(p));
    const stop = el('button', 'ghost', t('Stop'));
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      await api(`/evals/${ev.id}/stop`, { method: 'POST', body: {} }).catch((err) => ($('#ev-status').textContent = err.message));
    });
    box.append(stop);
  }
  const r = ev.result;
  if (r) {
    const card = el('div', `ev-result ${r.winner && r.winner !== 'control' ? 'has-winner' : r.winner === 'control' ? 'control-wins' : 'no-winner'}`);
    const h = el('p', 'ev-headline');
    h.append(glyph(r.winner && r.winner !== 'control' ? 'sparkle' : r.winner === 'control' ? 'check' : 'compass'), el('span', '', headlineText(r)));
    card.append(h);
    if (r.winner && r.winner !== 'control') card.append(el('p', 'ev-winner', `${t('Winner')}: ${variantText(ev.variants.find((v) => v.id === r.winner))}`));
    if (!r.winner) card.append(el('p', 'muted small', t('A winner is named only when the wins and losses are uneven enough that chance is unlikely (sign test, p below {a}). Ties don\'t count either way.', { a: Number(r.alpha.toFixed(3)) })));
    for (const vr of r.variants) {
      const v = ev.variants.find((x) => x.id === vr.id);
      const rowEl = el('div', `ev-vrow verdict-${vr.verdict}`);
      const top = el('div', 'ev-vrow-top');
      top.append(el('span', 'ev-vname', variantText(v)), chip(VERDICT[vr.verdict]?.() ?? vr.verdict, vr.verdict === 'better' ? 'chip-ok' : vr.verdict === 'worse' ? 'chip-warn' : ''));
      rowEl.append(top);
      rowEl.append(el('p', 'small', t('Score {v} vs {c} ({pct}) · wins {w} · ties {t} · losses {l} · p={p}', { v: pct(vr.mean), c: pct(vr.controlMean), pct: `${vr.pct >= 0 ? '+' : '−'}${Math.abs(Math.round(vr.pct))}%`, w: vr.wins, t: vr.ties, l: vr.losses, p: vr.p < 0.001 ? '<0.001' : vr.p.toFixed(3) })));
      if (ev.status !== 'running' && ev.status !== 'judging') {
        const use = el('button', vr.id === r.winner ? '' : 'ghost', t('Use this setting'));
        use.type = 'button';
        use.addEventListener('click', async () => {
          if (vr.id !== r.winner && !confirm(t('This variant did not clearly win. Use it anyway?'))) return;
          try {
            await api(`/evals/${ev.id}/apply`, { method: 'POST', body: { variant: vr.id } });
            $('#ev-status').textContent = t('Settings changed. It is in the settings history below.');
            await refreshEvals();
            await openEval(ev.id);
          } catch (err) {
            $('#ev-status').textContent = err.message;
          }
        });
        rowEl.append(use);
      }
      card.append(rowEl);
    }
    if (ev.status !== 'running' && ev.status !== 'judging') {
      const acts = el('div', 'add-row ev-actions');
      const keep = el('button', r.winner === 'control' || !r.winner ? '' : 'ghost', t('Keep mine'));
      keep.type = 'button';
      keep.addEventListener('click', async () => {
        await api(`/evals/${ev.id}/apply`, { method: 'POST', body: { keep: true } }).catch((err) => ($('#ev-status').textContent = err.message));
        await openEval(ev.id);
      });
      const again = el('button', 'ghost', t('Run again on the same tasks'));
      again.type = 'button';
      again.addEventListener('click', async () => {
        try {
          const d = await api('/evals', { method: 'POST', body: { from: ev.id } });
          st.draft = d.eval;
          renderDraft(d.eval);
          $('#ev-draft').scrollIntoView({ block: 'nearest' });
        } catch (err) {
          $('#ev-status').textContent = err.message;
        }
      });
      const del = el('button', 'ghost', t('Delete'));
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(t('Delete this eval and its results? The runs it made go with it when run history is cleaned up.'))) return;
        await api(`/evals/${ev.id}`, { method: 'DELETE' }).catch(() => {});
        box.hidden = true;
        st.open = 0;
        await refreshEvals();
      });
      acts.append(keep, again, del);
      card.append(acts);
    }
    if (ev.applied) card.append(el('p', 'small ev-applied', ev.applied.kept ? t('You kept your settings ({when}).', { when: new Date(ev.applied.at).toLocaleString(locale()) }) : t('You used {what} ({when}).', { what: variantText(ev.variants.find((v) => v.id === ev.applied.variant)), when: new Date(ev.applied.at).toLocaleString(locale()) })));
    const w = el('p', 'muted small ev-weights');
    w.textContent = `${t('How the score is made')}: ${Object.entries(r.weights).map(([k, x]) => `${PART[k]?.() ?? k} ${Math.round(x * 100)}%`).join(' · ')}. ${t('Parts a task has no data for are left out and the rest scaled up. Lower tokens, steps, time, cost and findings score higher.')}`;
    card.append(w);
    box.append(card);
    box.append(taskTable(ev, r, rows));
  }
}

function taskTable(ev, r, rows) {
  const wrap = el('div', 'ev-task-results');
  wrap.append(el('h4', '', t('Each task')));
  const others = ev.variants.filter((v) => v.id !== 'control');
  for (const tr of r.tasks) {
    const task = ev.tasks[tr.idx];
    const card = el('div', 'ev-trow');
    const top = el('div', 'ev-trow-top');
    top.append(raw(el('span', 'ev-task-title', tr.title)));
    const orig = el('button', 'ghost small', t('Original'));
    orig.type = 'button';
    orig.addEventListener('click', () => void openRunView(task.runId, { api }));
    top.append(orig);
    card.append(top);
    const ctl = rows.find((x) => x.task === tr.idx && x.variant === 'control');
    card.append(el('p', 'small muted', `${t('Your settings now')}: ${tr.control.score === null ? '—' : pct(tr.control.score)}${ctl ? ` · ${runFacts(ctl)}` : ''}`));
    for (const v of others) {
      const x = tr.variants[v.id];
      const row = rows.find((y) => y.task === tr.idx && y.variant === v.id);
      const line = el('div', 'ev-pair');
      const outcome = x?.outcome ?? 'missing';
      line.append(chip(outcome === 'win' ? t('win') : outcome === 'loss' ? t('loss') : outcome === 'tie' ? t('tie') : t('no pair'), outcome === 'win' ? 'chip-ok' : outcome === 'loss' ? 'chip-warn' : ''));
      line.append(el('span', 'small', `${t('Variant {n}', { n: Number(v.id.slice(1)) })}: ${x?.score === null || x?.score === undefined ? '—' : pct(x.score)}${row ? ` · ${runFacts(row)}` : ''}`));
      if (tr.control.runId && x?.runId) {
        const cmp = el('button', 'ghost small', t('Compare the two runs'));
        cmp.type = 'button';
        cmp.addEventListener('click', () => void openDiffSheet(tr.control.runId, x.runId, { api, named: () => '' }, { labels: { a: t('Your settings now'), b: t('Variant {n}', { n: Number(v.id.slice(1)) }) } }));
        line.append(cmp);
      }
      card.append(line);
      if (x?.judge?.votes?.length) {
        const q = x.judge.votes.find((vv) => vv.valid && vv.quote);
        card.append(el('p', 'small muted ev-judge', `${t('Judge')}: ${outcome === 'missing' ? '' : x.judge.outcome === 'win' ? t('preferred the variant in both orders') : x.judge.outcome === 'loss' ? t('preferred your settings in both orders') : t('no preference (or the two orders disagreed)')}${q ? ` · "${q.quote}"` : ''}`));
      }
      if (row?.note) card.append(raw(el('p', 'small muted', row.note)));
    }
    wrap.append(card);
  }
  return wrap;
}

function runFacts(row) {
  const bits = [];
  if (row.tests) bits.push(row.tests.ran ? (row.tests.exitCode === 0 ? t('Tests passed') : t('Tests failed')) : t('tests not run'));
  bits.push(t('{n} tokens', { n: tokens(row.tokens) }), t('Steps: {n}', { n: row.steps }), `${Math.round(row.ms / 100) / 10} s`);
  if (row.findings) bits.push(t('Findings: {n}', { n: row.findings }));
  if (row.denied) bits.push(t('Asked first, answered No: {n}', { n: row.denied }));
  if (row.status !== 'ok') bits.push(STATUS[row.status]?.() ?? row.status);
  return bits.join(' · ');
}

export async function openEval(id) {
  st.open = id;
  try {
    const d = await api(`/evals/${id}`);
    renderDetail(d.eval, d.runs);
  } catch (err) {
    $('#ev-status').textContent = err.message;
  }
}

function renderHistory(list) {
  const box = $('#ev-history');
  box.replaceChildren();
  if (!list?.length) {
    box.append(emptyState({ icon: 'flask', text: t('No settings were changed by an eval yet.') }));
    return;
  }
  const ul = el('ul', 'ev-history-list');
  for (const h of list) {
    const li = el('li', 'small');
    li.append(el('span', 'muted', `${new Date(h.at).toLocaleString(locale())} · `), raw(el('span', '', h.what)));
    if (h.changes?.length) li.append(raw(el('code', 'ev-history-changes', h.changes.map((c) => `${c.key}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join('; '))));
    ul.append(li);
  }
  box.append(ul);
}

/** Loads the list, the pick-lists and the schedule. */
export async function refreshEvals() {
  if (!$('#evals')?.open) return;
  let d;
  try {
    d = await api('/evals');
  } catch (err) {
    $('#ev-status').textContent = err.message;
    return;
  }
  const first = !st.data;
  st.data = d;
  if (first) {
    const count = $('#ev-count');
    count.replaceChildren(...d.choices.counts.map((n) => Object.assign(el('option', '', String(n)), { value: String(n) })));
    count.value = String(d.choices.count);
    $('#ev-mbudget').replaceChildren(...(await scheduleChoices()));
    renderVariants();
  }
  $('#ev-judge-note').hidden = d.judgeModel;
  $('#ev-monthly').value = d.schedule.monthly ? 'on' : 'off';
  $('#ev-mbudget').value = String(d.schedule.budgetTokens);
  const list = $('#ev-list');
  list.replaceChildren(...(d.evals.length ? d.evals.filter((e) => e.status !== 'draft').map(evalRow) : [emptyState({ icon: 'flask', text: t('No evals yet. Pick variants above to try them on your own past tasks.'), howto: true })]));
  renderHistory(d.history);
  if (st.open) await openEval(st.open);
}

async function scheduleChoices() {
  const r = await api('/evals/schedule');
  return r.choices.map((n) => Object.assign(el('option', '', t('{n} tokens', { n: tokens(n) })), { value: String(n) }));
}

export async function openEvals() {
  const dlg = $('#evals');
  if (!dlg.open) dlg.showModal();
  $('#ev-status').textContent = '';
  await refreshEvals();
}

/** A live update from the server (`eval` event): the list and the open result follow. */
export function onEvalEvent(ev) {
  if (!$('#evals')?.open) return;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => void refreshEvals(), ev?.status === 'running' ? 400 : 0);
}

let wired = false;
export function initEvals() {
  if (wired || !$('#evals')) return;
  wired = true;
  $('#ev-add').addEventListener('click', () => {
    if (st.variants.length >= (st.data?.choices.maxVariants ?? 3)) return;
    st.variants.push({});
    renderVariants();
  });
  $('#ev-estimate').addEventListener('click', async () => {
    const b = $('#ev-estimate');
    b.disabled = true;
    $('#ev-status').textContent = t('Picking your tasks…');
    try {
      const variants = st.variants.map((v) => ({ ...(v.memory ? { memory: v.memory } : {}), ...(v.model ? { model: v.model } : {}), ...(v.sandbox ? { sandbox: v.sandbox } : {}), ...(v.budget ? { budget: v.budget } : {}), ...(v.recall ? { recall: v.recall } : {}) }));
      const d = await api('/evals', { method: 'POST', body: { kind: $('#ev-kind').value, count: Number($('#ev-count').value), judge: $('#ev-judge').value === 'on', concurrency: Number($('#ev-conc').value), variants } });
      st.draft = d.eval;
      $('#ev-status').textContent = '';
      renderDraft(d.eval);
    } catch (err) {
      $('#ev-status').textContent = err.message;
    }
    b.disabled = false;
  });
  // "Re-check monthly" saves on change; switching it on needs an explicit yes.
  $('#ev-monthly').addEventListener('change', async (e) => {
    const on = e.target.value === 'on';
    if (on && !confirm(t('Once a month, when nobody has used Sara for 20 minutes, run your last eval again on fresh tasks, inside the budget you pick. Paid models cost money each time. Switch it on?'))) {
      e.target.value = 'off';
      return;
    }
    try {
      await api('/evals/schedule', { method: 'PUT', body: { monthly: on } });
      $('#ev-status').textContent = on ? t('Re-check monthly is on.') : t('Re-check monthly is off.');
      await refreshEvals();
    } catch (err) {
      $('#ev-status').textContent = err.message;
    }
  });
  $('#ev-mbudget').addEventListener('change', async (e) => {
    await api('/evals/schedule', { method: 'PUT', body: { budgetTokens: Number(e.target.value) } }).catch((err) => ($('#ev-status').textContent = err.message));
  });
  $('#evals').addEventListener('close', () => {
    st.open = 0;
  });
}
