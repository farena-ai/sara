// V3.4 "Fix this issue" (Settings → Connections → Apps and services → GitHub). A repository's open
// issues, each with one button: her team fixes it in a worktree of its own, runs the tests until
// they pass, reviews it, then shows a pull-request card. Nothing reaches GitHub before "Open the
// pull request". Server: /api/github-watch/fix (src/fix-issue.ts).
import { t } from './naming.js';

let ctx = null;
let timer = 0;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (label, cls, on) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', on);
  return b;
};

/** `api(path, init)` comes from app.js. */
export function initFixIssue(c) {
  if (ctx) return;
  ctx = c;
  $('#fx-show')?.addEventListener('click', () => void loadFixIssue());
  $('#fx-repo')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void loadFixIssue();
    }
  });
}

const STATE = {
  working: () => t('Her team is on it: fixing, testing, reviewing…'),
  waiting: () => t('Waiting for you on the Team page.'),
  ready: () => t('Fixed and tested. Ready for your OK.'),
  pr: () => t('Pull request open.'),
  done: () => t('Done.'),
  failed: () => t('Stopped with a problem. The work is kept in its worktree.'),
  stopped: () => t('Not opened. The work is kept in its worktree.'),
  limit: () => t('Stopped at the spending limit.'),
  interrupted: () => t('Interrupted by a restart. Open the Team page to go on.'),
};

/** Reads the list (the repository box, or the watched repositories) and draws it. */
export async function loadFixIssue() {
  if (!ctx || !$('#fx-list')) return;
  clearTimeout(timer);
  const status = $('#fx-status');
  const repo = $('#fx-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
  let d;
  try {
    d = await ctx.api(`/github-watch/fix${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`);
  } catch (err) {
    status.textContent = err.message;
    $('#fx-list').replaceChildren();
    return;
  }
  const dl = $('#fx-repos');
  dl.replaceChildren(...(d.repos ?? []).map((r) => Object.assign(document.createElement('option'), { value: r })));
  if (!d.connected) {
    status.textContent = t('Save a GitHub token above first.');
    $('#fx-list').replaceChildren();
    return;
  }
  if (!repo && !d.repos?.length) {
    status.textContent = t('Type a repository (owner/name), or watch one above.');
    $('#fx-list').replaceChildren();
    return;
  }
  status.textContent = d.issues.length ? t('Open issues: {n}.', { n: d.issues.length }) : t('No open issues.');
  const cards = await Promise.all(d.issues.map((i) => (i.fix && (i.fix.state === 'ready' || i.fix.state === 'pr') ? ctx.api(`/github-watch/fix/${i.fix.task}`).catch(() => null) : null)));
  const mixed = new Set(d.issues.map((i) => i.repo.toLowerCase())).size > 1;
  $('#fx-list').replaceChildren(...d.issues.map((i, n) => row(i, cards[n]?.card ?? null, mixed)));
  // While her team works, look again now and then (only while this page is on screen).
  if (d.issues.some((i) => i.fix?.state === 'working')) timer = setTimeout(() => { if ($('#fx-list')?.offsetParent) void loadFixIssue(); }, 5000);
}

function row(i, card, mixed) {
  const li = el('li', 'fx-row');
  const head = el('div', 'fx-head');
  const title = el('a', 'fx-title', `#${i.number} ${i.title}`);
  Object.assign(title, { href: i.url, target: '_blank', rel: 'noopener' });
  head.append(title);
  // The repository name only when the list mixes several repositories.
  if (mixed) head.append(el('span', 'muted small', i.repo));
  const f = i.fix;
  const again = !f || ['failed', 'stopped', 'limit'].includes(f.state);
  if (again) head.append(btn(f ? t('Try again') : t('Fix this issue'), 'small fx-go', () => void start(i, li)));
  li.append(head);
  if (f) {
    const st = el('p', `small fx-state fx-${f.state}`, STATE[f.state]?.() ?? f.state);
    if (f.conversationId) {
      const a = el('a', '', t('Open the chat'));
      a.href = `#c=${f.conversationId}`;
      st.append(' ', a);
    }
    if (f.prUrl) {
      const a = el('a', '', t('See the pull request'));
      Object.assign(a, { href: f.prUrl, target: '_blank', rel: 'noopener' });
      st.append(' ', a);
    }
    li.append(st);
  }
  if (card && f) li.append(prCard(f, card));
  return li;
}
function prCard(f, c) {
  const box = el('div', 'fx-card');
  const add = c.files.reduce((n, x) => n + x.added, 0);
  const del = c.files.reduce((n, x) => n + x.removed, 0);
  box.append(el('strong', '', f.state === 'ready' ? t('Pull request, waiting for your OK') : t('Pull request')));
  box.append(el('p', 'small', t('Files changed: {n} (+{add} −{del}) on {branch}.', { n: c.files.length, add, del, branch: c.branch })));
  const files = el('ul', 'fx-files');
  for (const x of c.files.slice(0, 12)) {
    const li = el('li', 'small');
    li.append(el('code', '', x.path), ` +${x.added} −${x.removed}`);
    files.append(li);
  }
  box.append(files);
  box.append(el('p', `small ${c.tests?.ok ? 'fx-ok' : 'fx-bad'}`, c.tests ? (c.tests.ok ? t('Tests passed: {command}', { command: c.tests.command }) : t('Tests failed: {command}', { command: c.tests.command })) : t('No tests ran.')));
  if (c.fixes) box.append(el('p', 'small muted', t('Rounds back to the coder until the tests passed: {n}.', { n: c.fixes })));
  if (c.review) box.append(el('p', `small ${c.review.ok ? 'fx-ok' : 'fx-bad'}`, c.review.ok ? t('Review: looks good.') : t('Review asks for: {detail}', { detail: c.review.detail })));
  if (f.state === 'ready') {
    box.append(el('p', 'small muted', t('Nothing is on GitHub yet.')));
    const row = el('div', 'add-row');
    row.append(btn(t('Open the pull request'), 'fx-open', () => void answer(f, 'open', box)), btn(t('Not now'), 'ghost', () => void answer(f, 'not-now', box)));
    box.append(row);
  }
  return box;
}

async function start(i, li) {
  const st = $('#fx-status');
  li.querySelector('.fx-go')?.setAttribute('disabled', '');
  st.textContent = t('Getting the repository ready…');
  try {
    await ctx.api('/github-watch/fix', { method: 'POST', body: { repo: i.repo, number: i.number } });
    if (!$('#fx-repo').value.trim()) $('#fx-repo').value = i.repo;
    await loadFixIssue();
    st.textContent = t('Started #{n}. Her team works in a worktree of its own.', { n: i.number });
  } catch (err) {
    st.textContent = err.message;
    li.querySelector('.fx-go')?.removeAttribute('disabled');
  }
}

async function answer(f, decision, box) {
  for (const b of box.querySelectorAll('button')) b.disabled = true;
  try {
    await ctx.api(`/github-watch/fix/${f.task}/${decision}`, { method: 'POST' });
    $('#fx-status').textContent = decision === 'open' ? t('Opening the pull request…') : t('Not opened. The work is kept in its worktree.');
    setTimeout(() => void loadFixIssue(), 1500);
  } catch (err) {
    $('#fx-status').textContent = err.message;
    for (const b of box.querySelectorAll('button')) b.disabled = false;
  }
}
