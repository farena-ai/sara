// C13 (docs/ops/C13_DESIGN.md): the Workspace tab on a project page, the owner's only.
// Files (a tree from /api/workspaces/:ws/tree), a plain editor (a textarea with line numbers; Save
// refuses when the file changed meanwhile), Problems (the language server, when one is installed), a
// terminal (each command through her shell's rules: off when commands are off, same sandbox and
// network), a chat with her that sees the open file (an @file reference), and the task worktrees
// with Merge / Open PR / Discard. Folder: the main checkout or one of her task worktrees.
// Also: Settings → Coding → GitHub → "Her commits" (the co-author line, the language servers found).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
let ctx = null;
const st = { ws: null, root: '', path: '', hash: '', dirty: false, conv: null, busy: false, trees: [] };

const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function initWorkspaceView(c) {
  ctx = c;
  if (!$('#pp-work')) return;
  $('#wv-root').addEventListener('change', () => {
    st.root = $('#wv-root').value;
    void loadTree();
  });
  $('#wv-text').addEventListener('input', () => {
    st.dirty = true;
    $('#wv-save').disabled = false;
    numberLines();
  });
  $('#wv-text').addEventListener('scroll', () => ($('#wv-lines').scrollTop = $('#wv-text').scrollTop));
  $('#wv-text').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  });
  $('#wv-save').addEventListener('click', () => void save());
  $('#wv-check').addEventListener('click', () => void problems());
  $('#wv-run').addEventListener('click', () => void run());
  $('#wv-cmd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  });
  $('#wv-send').addEventListener('click', () => void ask());
  $('#wv-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  });
  $('#wv-start').addEventListener('click', () => void startTree());
  document.addEventListener('pp-tab', (e) => {
    if (e.detail === 'workspace') void open(ctx.workspace());
  });
  // Settings → Coding → GitHub: the co-author line.
  $('#ca-save')?.addEventListener('click', () => void saveCoAuthor());
}

/** The project page's Workspace tab was opened. */
async function open(ws) {
  if (!ws) return;
  if (st.ws !== ws) Object.assign(st, { ws, root: '', path: '', hash: '', dirty: false, conv: null });
  await Promise.all([loadTrees(), loadTree()]);
}

const rootPath = (rel) => (st.root ? `${st.root}/${rel}` : rel);

async function loadTree() {
  const box = $('#wv-files');
  box.replaceChildren(ctx.el('p', 'muted small', t('Loading…')));
  try {
    const r = await ctx.api(`/workspaces/${encodeURIComponent(st.ws)}/tree${st.root ? `?dir=${encodeURIComponent(st.root)}` : ''}`);
    const pre = st.root ? `${st.root}/` : '';
    const list = r.entries.filter((e) => !e.dir).map((e) => ({ ...e, rel: e.path.startsWith(pre) ? e.path.slice(pre.length) : e.path }));
    box.replaceChildren(
      ...(list.length
        ? list.map((f) => {
            const b = ctx.el('button', `wv-file${f.rel === st.path ? ' active' : ''}`, f.rel);
            b.type = 'button';
            b.title = fmt(f.size ?? 0);
            b.addEventListener('click', () => void openFile(f.rel));
            return b;
          })
        : [ctx.el('p', 'muted small', t('The workspace is empty.'))]),
      ...(r.truncated ? [ctx.el('p', 'muted small', t('Only the first {n} files are listed.', { n: r.entries.length }))] : []),
    );
  } catch (err) {
    box.replaceChildren(ctx.el('p', 'muted small', err.message));
  }
}

function numberLines() {
  const n = $('#wv-text').value.split('\n').length;
  $('#wv-lines').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  $('#wv-lines').scrollTop = $('#wv-text').scrollTop;
}

async function openFile(rel) {
  if (st.dirty && !confirm(t('Leave without saving your changes to {path}?', { path: st.path }))) return;
  try {
    const f = await ctx.api(`/workspaces/${encodeURIComponent(st.ws)}/file?path=${encodeURIComponent(rootPath(rel))}`);
    const ta = $('#wv-text');
    if (f.binary) {
      ta.value = '';
      ta.readOnly = true;
      $('#wv-path').textContent = t('{path} is not a text file ({size}).', { path: rel, size: fmt(f.size) });
    } else {
      ta.value = f.text;
      ta.readOnly = Boolean(f.truncated);
      $('#wv-path').textContent = f.truncated ? `${rel} · ${t('(first 200 KB shown)')}` : rel;
    }
    Object.assign(st, { path: rel, hash: f.hash ?? '', dirty: false });
    $('#wv-save').disabled = true;
    $('#wv-problems').hidden = true;
    numberLines();
    for (const b of document.querySelectorAll('.wv-file')) b.classList.toggle('active', b.textContent === rel);
  } catch (err) {
    $('#wv-status').textContent = err.message;
  }
}

async function save() {
  if (!st.path || !st.dirty) return;
  try {
    const r = await ctx.api(`/workspaces/${encodeURIComponent(st.ws)}/file`, { method: 'PUT', body: { path: rootPath(st.path), text: $('#wv-text').value, ...(st.hash ? { hash: st.hash } : {}) } });
    Object.assign(st, { hash: r.hash, dirty: false });
    $('#wv-save').disabled = true;
    $('#wv-status').textContent = t('Saved {path}.', { path: st.path });
  } catch (err) {
    $('#wv-status').textContent = err.message;
  }
}

async function problems() {
  if (!st.path) return;
  const ul = $('#wv-problems');
  ul.hidden = false;
  ul.replaceChildren(ctx.el('li', 'muted small', t('Asking the language server…')));
  try {
    const r = await ctx.api(`/workspaces/${encodeURIComponent(st.ws)}/diagnostics?path=${encodeURIComponent(rootPath(st.path))}`);
    if (!r.available) return ul.replaceChildren(ctx.el('li', 'muted small', r.reason ?? t('No language server for this kind of file on this computer.')));
    if (!r.diagnostics.length) return ul.replaceChildren(ctx.el('li', 'muted small', t('No problems reported.')));
    ul.replaceChildren(
      ...r.diagnostics.map((d) => {
        const li = ctx.el('li', `wv-${d.severity}`, `${d.line}:${d.column} ${d.message}`);
        li.addEventListener('click', () => goLine(d.line));
        return li;
      }),
    );
  } catch (err) {
    ul.replaceChildren(ctx.el('li', 'muted small', err.message));
  }
}
function goLine(n) {
  const ta = $('#wv-text');
  const lines = ta.value.split('\n');
  const at = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(at, at + (lines[n - 1]?.length ?? 0));
}

async function run() {
  const cmd = $('#wv-cmd').value.trim();
  if (!cmd || st.busy) return;
  st.busy = true;
  $('#wv-run').disabled = true;
  const out = $('#wv-out');
  out.textContent += `${out.textContent ? '\n' : ''}$ ${cmd}\n`;
  try {
    const r = await ctx.api(`/workspaces/${encodeURIComponent(st.ws)}/run`, { method: 'POST', body: { command: cmd, ...(st.root ? { cwd: st.root } : {}), ...(st.conv ? { conversationId: st.conv } : {}) } });
    out.textContent += `${r.output}${r.output.endsWith('\n') || !r.output ? '' : '\n'}${r.timedOut ? t('(stopped: over 2 minutes; use a background job for long commands)') : t('(exit code {n})', { n: r.exitCode ?? '?' })}\n`;
    $('#wv-cmd').value = '';
  } catch (err) {
    out.textContent += `${err.message}\n`;
  } finally {
    st.busy = false;
    $('#wv-run').disabled = false;
    out.scrollTop = out.scrollHeight;
  }
}

/** The coding conversation the Workspace chat uses (one per workspace, made when first needed). */
async function conversation() {
  if (st.conv) return st.conv;
  const key = `sara.workspace-chat.${st.ws}`;
  const saved = localStorage.getItem(key);
  if (saved) {
    try {
      const c = await ctx.api(`/conversations/${encodeURIComponent(saved)}/messages?limit=1`);
      if (c) return (st.conv = saved);
    } catch {
      localStorage.removeItem(key);
    }
  }
  const conv = await ctx.api('/conversations', { method: 'POST', body: { ...(ctx.projectId() ? { projectId: ctx.projectId() } : {}), workspace: st.ws, mode: 'coding' } });
  localStorage.setItem(key, conv.id);
  return (st.conv = conv.id);
}

function bubble(cls, text) {
  const b = ctx.el('div', `wv-msg ${cls}`, text);
  $('#wv-msgs').append(b);
  $('#wv-msgs').scrollTop = $('#wv-msgs').scrollHeight;
  return b;
}

async function ask() {
  const text = $('#wv-ask').value.trim();
  if (!text || st.chatting) return;
  st.chatting = true;
  $('#wv-send').disabled = true;
  try {
    const id = await conversation();
    const ref = st.path ? `@file:${/\s/.test(rootPath(st.path)) ? `"${rootPath(st.path)}"` : rootPath(st.path)} ` : '';
    bubble('me', text);
    $('#wv-ask').value = '';
    const reply = bubble('her', '');
    const res = await ctx.api(`/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { content: `${ref}${text}` }, raw: true });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      reply.textContent = d.error ?? `HTTP ${res.status}`;
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === 'token') reply.textContent += ev.text;
        else if (ev.type === 'tool_call') bubble('step muted small', `• ${ev.summary ?? ev.name}`);
        else if (ev.type === 'approval') approvalCard(ev);
        else if (ev.type === 'error') bubble('step', ev.message);
      }
    }
    // Her tools may have changed files or made a worktree.
    void loadTrees();
    if (st.path && !st.dirty) void openFile(st.path);
  } catch (err) {
    bubble('step', err.message);
  } finally {
    st.chatting = false;
    $('#wv-send').disabled = false;
  }
}

function approvalCard(ev) {
  const card = ctx.el('div', 'wv-msg wv-ask-card');
  card.append(ctx.el('p', 'small', ev.summary ?? ev.name));
  const row = ctx.el('div', 'add-row');
  const decide = async (approved) => {
    row.replaceChildren(ctx.el('span', 'muted small', approved ? t('Allowed') : t('Not allowed')));
    try {
      await ctx.api(`/approvals/${encodeURIComponent(ev.approvalId)}`, { method: 'POST', body: { approved } });
    } catch (err) {
      row.replaceChildren(ctx.el('span', 'muted small', err.message));
    }
  };
  const yes = ctx.el('button', '', t('Allow'));
  yes.type = 'button';
  yes.addEventListener('click', () => void decide(true));
  const no = ctx.el('button', 'ghost', t("Don't"));
  no.type = 'button';
  no.addEventListener('click', () => void decide(false));
  row.append(yes, no);
  card.append(row);
  $('#wv-msgs').append(card);
  $('#wv-msgs').scrollTop = $('#wv-msgs').scrollHeight;
}

// ---------- task worktrees ----------
async function loadTrees() {
  const box = $('#wv-trees');
  try {
    const r = await ctx.api(`/worktrees?workspace=${encodeURIComponent(st.ws)}`);
    st.trees = r.worktrees.filter((w) => w.state === 'active');
    const sel = $('#wv-root');
    const keep = st.root;
    sel.replaceChildren(new Option(t('Main checkout'), ''), ...st.trees.map((w) => new Option(t('Task: {branch}', { branch: w.branch }), w.folder)));
    st.root = st.trees.some((w) => w.folder === keep) ? keep : '';
    sel.value = st.root;
    box.replaceChildren(...r.worktrees.slice(0, 8).map(treeRow));
    box.hidden = !r.worktrees.length;
  } catch (err) {
    box.hidden = false;
    box.replaceChildren(ctx.el('p', 'muted small', err.message));
  }
}

function treeRow(w) {
  const row = ctx.el('div', `wv-tree wv-tree-${w.state}`);
  const s = w.status;
  const line = w.state === 'active' ? t('{branch} from {base}: {n} commit(s), {d} uncommitted file(s)', { branch: w.branch, base: w.base, n: s?.ahead ?? 0, d: s?.dirty.length ?? 0 }) : `${w.branch}: ${w.state === 'merged' ? t('merged') : w.state === 'pr' ? t('pull request') : t('discarded')}`;
  row.append(ctx.el('span', 'small', line));
  if (w.prUrl) {
    const a = ctx.el('a', 'small', t('Pull request'));
    a.href = w.prUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    row.append(a);
  }
  if (w.state === 'active') {
    const btn = (label, cls, fn) => {
      const b = ctx.el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', () => void fn(b));
      row.append(b);
    };
    btn(t('Merge'), 'small', () => act(w, 'merge'));
    btn(w.prUrl ? t('Done with the PR') : t('Open PR'), 'ghost small', () => (w.prUrl ? act(w, 'close') : openPr(w)));
    btn(t('Discard'), 'ghost small danger', () => act(w, 'discard'));
  }
  return row;
}

async function act(w, what, body = {}) {
  try {
    await ctx.api(`/worktrees/${w.id}/${what}`, { method: 'POST', body });
    $('#wv-status').textContent = what === 'merge' ? t('Merged {branch} into {base}.', { branch: w.branch, base: w.base }) : what === 'discard' ? t('Discarded {branch}.', { branch: w.branch }) : t('Done.');
  } catch (err) {
    // Uncommitted or unmerged work: say what would be lost, and only then delete it.
    if (err.status === 409 && err.data?.code === 'unsaved' && confirm(`${err.message}\n\n${(err.data.detail?.dirty ?? []).slice(0, 15).join('\n')}\n\n${t('Delete it anyway?')}`)) return act(w, what, { confirm: true });
    $('#wv-status').textContent = err.message;
  }
  await loadTrees();
  await loadTree();
}

async function openPr(w) {
  try {
    const d = await ctx.api(`/worktrees/${w.id}/pr-draft`, { method: 'POST', body: {} });
    const title = prompt(t('Pull request title (the branch is pushed, then the pull request is opened on GitHub):'), d.title);
    if (title === null) return;
    const r = await ctx.api(`/worktrees/${w.id}/pr`, { method: 'POST', body: { confirm: true, title, body: d.body } });
    $('#wv-status').textContent = t('Opened pull request #{n}.', { n: r.number });
  } catch (err) {
    $('#wv-status').textContent = err.message;
  }
  await loadTrees();
}

async function startTree() {
  const task = $('#wv-task').value.trim();
  if (!task) return void $('#wv-task').focus();
  try {
    const id = await conversation();
    const r = await ctx.api('/worktrees', { method: 'POST', body: { conversationId: id, task } });
    $('#wv-task').value = '';
    st.root = r.worktree.folder;
    $('#wv-status').textContent = t('She works on branch {branch} in this chat now.', { branch: r.worktree.branch });
  } catch (err) {
    $('#wv-status').textContent = err.message;
  }
  await loadTrees();
  await loadTree();
}

// ---------- Settings → Coding → GitHub: her commits ----------
export async function loadCoAuthor() {
  if (!$('#ca-on')) return;
  try {
    const r = await ctx.api('/coding-depth');
    $('#ca-on').checked = r.coAuthor.on;
    $('#ca-name').value = r.saved.name ?? '';
    $('#ca-name').placeholder = r.coAuthor.name;
    $('#ca-email').value = r.saved.email ?? '';
    $('#ca-email').placeholder = r.coAuthor.email;
    $('#ca-servers').textContent = r.servers.length ? t('Language servers on this computer: {list}.', { list: r.servers.map((s) => `${s.bin} ${s.found ? '✓' : '✗'}`).join(' · ') }) : '';
  } catch (err) {
    $('#ca-status').textContent = err.message;
  }
}
async function saveCoAuthor() {
  try {
    await ctx.api('/coding-depth', { method: 'PUT', body: { coAuthor: { on: $('#ca-on').checked, name: $('#ca-name').value, email: $('#ca-email').value } } });
    $('#ca-status').textContent = t('Saved.');
  } catch (err) {
    $('#ca-status').textContent = err.message;
  }
  await loadCoAuthor();
}
