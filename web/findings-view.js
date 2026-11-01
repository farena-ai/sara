// Phase 81 (harness track M6): findings on screen. One window (`#findings`) for everything the
// security pass, live advisories, the sandbox gate and the plan check found, per project and per
// run, with pick-list filters; each finding shows the real line it quotes, what to do, and its
// actions: Fix on a branch (the fix-branch loop: progress, the re-check, the tests, the diff, then
// Apply to my branch / Keep the branch / Discard), Dismiss or Accept with a reason. Also the small
// "Security pass" card under a coding reply, the approval card's "Known vulnerability" section and
// the line under her step after the install check. Server: src/security/*.ts, /api/findings.
// Phase 82 (M7): threats show their entry point → dangerous line path; the Threat model tab
// (surfaces, trust boundaries, open threats, what changed; /api/threat-model) and the small
// "Threat model" card under a coding reply with "Fix these" (the fix-only second pass).
// Phase 86 (M11): the Red team tab (the plan with its budget before anything runs, live progress,
// the report: what was tried, what broke with its reproduction steps, what was dropped and why,
// the attacker scripts to read and OK on a computer without isolation, "Fix what broke"), the
// ship card's section and "Red-team this" on the chat cards (/api/redteam).
import { locale, serverText, t } from './naming.js';
import { icon } from './icons.js';
import { emptyState } from './tidy.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const glyph = (name, cls = 'fnd-icon') => {
  const s = el('span', cls);
  s.setAttribute('aria-hidden', 'true');
  const svg = icon(name) ?? icon('warn');
  if (svg) s.append(svg);
  return s;
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

const SEV = { block: () => t('blocks'), high: () => t('serious'), medium: () => t('worth a look'), low: () => t('minor'), info: () => t('note') };
const SOURCE = {
  security: () => t('Code check'),
  advisory: () => t('Known vulnerability'),
  sandbox: () => t('Sandbox try'),
  contradiction: () => t('Your decisions'),
  threat: () => t('Threat check'),
  redteam: () => t('Red team'),
};
const STAGE = { 'making the branch': () => t('making the branch'), 'asking the Coding model': () => t('asking the Coding model'), 'running the tests': () => t('running the tests'), 'sending the breaking input again': () => t('sending the breaking input again') };
const STATUS = { open: () => t('open'), fixed: () => t('fixed'), dismissed: () => t('dismissed'), accepted: () => t('accepted') };
/** The code checks' titles and advice in the app language (the server's English is the fallback). */
const RULE = {
  'secret-in-code': [() => t('A secret written into the code'), () => t('Move it to an environment variable or a secrets file that git ignores, and change the key: anyone who saw this file has it.')],
  'code-exec': [() => t('Runs code or a command built from a variable'), () => t('Never pass outside input to eval, new Function or a shell. Use a fixed program with an argument list, or parse the data instead of running it.')],
  'sql-string': [() => t('SQL built by joining strings'), () => t('Use placeholders (? or $1 or %s with the values passed separately) so input can never change the query.')],
  'path-traversal': [() => t('A file path taken from the request'), () => t('Keep only the file name, resolve it inside the allowed folder and check the result is still inside it before reading or sending it.')],
  'tls-off': [() => t('Certificate checks turned off'), () => t('Leave TLS verification on. For a private certificate, add its CA to the trusted list instead.')],
  'unsafe-deserialize': [() => t('Unsafe loading of data'), () => t('pickle, marshal, plain yaml.load and unserialize can run code from the data. Use JSON or a safe loader for anything not fully trusted.')],
  'cors-credentials': [() => t('Any website may call this with the user\'s cookies'), () => t('With credentials allowed, list the exact origins that may call it; a wildcard or an echoed origin lets any site act as the signed-in user.')],
  'missing-auth': [() => t('A new route without the sign-in check the others use'), () => t('The other routes in this file use a sign-in check; add the same one here unless this route is meant to be public.')],
  'weak-crypto': [() => t('Weak cryptography for a secret'), () => t('Use a slow password hash (scrypt, bcrypt, argon2), SHA-256 or better for signatures, a secure random source for tokens and an authenticated cipher.')],
  'inner-html': [() => t('HTML built from input'), () => t('Set textContent (or create elements) instead of innerHTML for anything from the user, the address bar or the server.')],
  'debug-on': [() => t('Debug mode switched on in code'), () => t('Read debug mode from the environment and keep it off by default.')],
  // Phase 82: the threat rules (src/security/threat-graph.ts THREAT_RULES).
  'threat:shell': [() => t('Outside input reaches a shell command'), () => t('Run a fixed program with an argument list (execFile / spawn without a shell / subprocess with a list) and check the value against what is allowed first.')],
  'threat:sql': [() => t('Outside input reaches an SQL query'), () => t('Pass the value as a parameter (? / $1 / %s with the values separately) instead of putting it into the query text.')],
  'threat:path': [() => t('Outside input chooses a file path'), () => t('Keep only the file name (basename), or resolve the path inside the allowed folder and refuse it unless the result still starts with that folder.')],
  'threat:ssrf': [() => t('Outside input chooses where the server connects'), () => t('Use a fixed host, or check the URL\'s host against an allowlist before the request; never let input pick the address.')],
  'threat:deserialize': [() => t('Outside input is loaded with an unsafe loader'), () => t('Load outside data as JSON or with a safe loader (yaml.safe_load); pickle, marshal and unserialize can run code from the data.')],
  'threat:html': [() => t('Outside input is written into HTML'), () => t('Escape the value (or set textContent) before it goes into the page, or send it as JSON.')],
  'threat:redirect': [() => t('Outside input chooses where a redirect goes'), () => t('Redirect only to local paths (starting with one "/" and not "//") or to an allowlist of addresses.')],
  'threat:eval': [() => t('Outside input is run as code'), () => t('Never run outside input as code; parse the data (JSON.parse, a small parser) or map it to fixed actions.')],
  'threat:secret': [() => t('A secret is sent back to the caller'), () => t('Send only the fields the caller needs; keep environment variables, keys and passwords on the server.')],
  'threat:auth': [() => t('Anyone can reach a change without signing in'), () => t('Add the sign-in check (the middleware or decorator the project uses) to this route, or check the user inside the handler before the change.')],
  'threat:ratelimit': [() => t('A sign-in route with no rate limit'), () => t('Limit attempts per address and account (express-rate-limit, Flask-Limiter, slowapi, a counter with a lockout) so passwords can\'t be guessed quickly.')],
  // Phase 86: red-team breaks and insecure defaults (src/redteam-probes.ts BREAK_RULES, DEFAULT_RULES).
  'redteam:exit': [() => t('The app stopped on unusual input'), () => t('One request with unusual input took the whole app down. Check the value before using it (type, presence, length) and catch errors in the handler so a bad request gets a 400, not a crash.')],
  'redteam:crash': [() => t('A server error on unusual input'), () => t('The handler failed on input it did not expect and answered 500. Validate the value first and answer 400 with a short message.')],
  'redteam:uncaught': [() => t('An uncaught error in the log on unusual input'), () => t('The input made the code throw where nothing catches it. Validate the value first and handle the error in the handler.')],
  'redteam:timeout': [() => t('No answer to unusual input (it hung)'), () => t('The app did not answer within the time limit: a loop or a wait on input it did not expect. Bound the work by the input size and answer 400 for values out of range.')],
  'redteam:stack-trace': [() => t('A stack trace sent back to the caller'), () => t('The response shows the code\'s stack trace (files, lines, versions). Log it on the server and send a short error message instead.')],
  'redteam:secret-echo': [() => t('A secret sent back to the caller'), () => t('The response contains a secret from the project\'s environment or config. Send only the fields the caller needs and keep keys on the server.')],
  'redteam:tests': [() => t('The tests fail'), () => t('The project\'s own tests fail in a clean copy. Fix them first: a red-team run means more when the tests pass.')],
  'redteam:debug-on': [() => t('Debug mode is on by default'), () => t('Debug pages show code, settings and sometimes a console to whoever triggers an error. Read debug mode from the environment and keep it off unless set.')],
  'redteam:default-credentials': [() => t('A default password in the code or config'), () => t('Well-known defaults (admin, password, changeme…) are the first thing anyone tries. Read the credential from the environment and refuse to start without one.')],
  'redteam:cors-wildcard': [() => t('Any website may call this app (CORS *)'), () => t('Access-Control-Allow-Origin: * lets every site read the responses. List the origins that need it instead.')],
  'redteam:missing-headers': [() => t('Security headers missing from responses'), () => t('Responses had no X-Content-Type-Options and no Content-Security-Policy or X-Frame-Options. Set them once for every response (a small middleware, or helmet for Express).')],
  'redteam:listen-all': [() => t('Listens on every network interface by default'), () => t('Binding to 0.0.0.0 (or an empty host) exposes the app to the whole network. Default to 127.0.0.1 and make the host a setting.')],
  'redteam:world-writable': [() => t('Files anyone on the machine can change'), () => t('These files are writable by every user. Remove the write bit for others (chmod o-w).')],
  'redteam:env-committed': [() => t('A secrets file is committed to git'), () => t('This env file with real values is tracked by git, so everyone with the repository has the keys. Remove it from git (git rm --cached), add it to .gitignore and change the keys.')],
};
const titleOf = (f) => (RULE[f.rule]?.[0] ?? (() => f.title))();
const adviceOf = (f) => ((f.source === 'security' || f.source === 'threat' || f.source === 'redteam') && (f.origin !== 'model' || f.source === 'redteam') && RULE[f.rule] ? RULE[f.rule][1]() : f.advice);
/** Red-team titles: the reviewer's own words for a break, else the rule's (in the app language). */
const rtTitle = (f) => (f.source === 'redteam' && f.origin === 'model' && f.meta?.reviewed ? f.title : titleOf(f));
/** STRIDE categories of threats, in the app language. */
const CATEGORY = {
  Spoofing: () => t('Spoofing'),
  Tampering: () => t('Tampering'),
  Repudiation: () => t('Repudiation'),
  'Information disclosure': () => t('Information disclosure'),
  'Denial of service': () => t('Denial of service'),
  'Elevation of privilege': () => t('Elevation of privilege'),
};
/** Trust boundaries in the threat model summary (src/security/threats.ts threatModelOf). */
const BOUNDARY = {
  'network-in': () => t('Network → your server (HTTP routes, uploads)'),
  'messages-in': () => t('Messages from clients (WebSocket, workers)'),
  'local-in': () => t('Command line and environment'),
  outbound: () => t('Your server → other servers'),
  database: () => t('Your server → database'),
  files: () => t('Your server → files'),
  shell: () => t('Your server → commands and code'),
  deserialize: () => t('Loading serialized data'),
  'html-out': () => t('Your server → browsers (HTML, redirects)'),
};
const REASONS = [
  ['Not a real problem', () => t('Not a real problem')],
  ['Test or example code', () => t('Test or example code')],
  ['Accepted risk', () => t('Accepted risk')],
  ['Fixed another way', () => t('Fixed another way')],
];

const st = { filter: { workspace: '', status: 'open', severity: '', source: '', runId: 0, conversationId: '' }, data: null, open: new Set(), poll: null, tab: 'list' };

function sevChip(sev) {
  return el('span', `fnd-sev sev-${sev}`, (SEV[sev] ?? SEV.info)());
}

/** The diff of a fix, line by line (added / removed marked; no colours inline: CSS). */
function diffBlock(diff) {
  const pre = raw(el('pre', 'fnd-diff'));
  for (const line of String(diff ?? '').replace(/\s+$/, '').split('\n').slice(0, 400)) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    const cls = line.startsWith('+') ? 'fnd-add' : line.startsWith('-') ? 'fnd-del' : line.startsWith('@@') ? 'fnd-hunk' : '';
    pre.append(el('span', cls, `${line}\n`));
  }
  return pre;
}

/** The fix-branch panel: progress, then the proof (re-check, tests), the diff and the three choices. */
function fixPanel(f, refresh) {
  const fix = f.fix;
  const box = el('div', `fnd-fix fix-${fix.state}`);
  const head = el('p', 'fnd-fix-head');
  head.append(glyph('branch'), raw(el('code', '', fix.branch)));
  const words = {
    working: () => t('Working on the fix: {stage}', { stage: (STAGE[fix.stage] ?? (() => '…'))() }),
    ready: () => t('The fix is ready on its own branch.'),
    failed: () => t('No fix: {why}', { why: fix.error ?? '' }),
    applied: () => t('Applied to your files (not committed).'),
    kept: () => t('Kept on its branch: merge it when you like.'),
    discarded: () => t('Discarded.'),
  };
  head.append(el('span', '', (words[fix.state] ?? words.working)()));
  box.append(head);
  if (fix.batch?.results) {
    const ul = el('ul', 'fnd-batch-list small');
    const rt = f.source === 'redteam';
    for (const [id, r] of Object.entries(fix.batch.results)) ul.append(el('li', r.fixed ? 'fnd-pass' : 'fnd-fail', r.fixed ? (rt ? t('#{id}: the same input no longer breaks it', { id }) : t('#{id}: the threat rule no longer finds it', { id })) : t('#{id}: still found', { id })));
    box.append(ul);
  } else if (fix.recheck) box.append(el('p', `small ${fix.recheck.fixed ? 'fnd-pass' : 'fnd-fail'}`, fix.recheck.fixed ? t('Re-check: the problem is gone ({before} → {after}).', { before: fix.recheck.before, after: fix.recheck.after }) : t('Re-check: still found ({after}).', { after: fix.recheck.after })));
  if (fix.tests) {
    const tline = !fix.tests.ran ? t('Tests not run: {why}', { why: fix.tests.note ?? '' }) : fix.tests.exitCode === 0 ? t('Tests pass ({command}) in a sandbox copy · {s} s', { command: fix.tests.command, s: (fix.tests.ms / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }) }) : t('Tests fail ({command}) in a sandbox copy', { command: fix.tests.command });
    box.append(el('p', `small ${fix.tests.ran && fix.tests.exitCode === 0 ? 'fnd-pass' : 'fnd-fail'}`, tline));
    if (fix.tests.ran && !fix.tests.isolated) box.append(el('p', 'small muted', t('Not isolated on this computer: the tests ran in a copy.')));
    if (fix.tests.output) {
      const d = el('details', 'fnd-out');
      d.append(el('summary', '', t('Test output')), raw(el('pre', '', fix.tests.output)));
      box.append(d);
    }
  } else if (fix.state === 'ready') box.append(el('p', 'small muted', t('No tests found in this project.')));
  if (fix.note) box.append(raw(el('p', 'small', fix.note)));
  if (fix.diff && (fix.state === 'ready' || fix.state === 'kept')) box.append(diffBlock(fix.diff));
  if (fix.applied?.conflicts?.length) box.append(el('p', 'small fnd-fail', t('Left alone (changed meanwhile): {files}', { files: fix.applied.conflicts.join(', ') })));
  const row = el('div', 'row fnd-actions');
  const act = async (how, ask) => {
    if (ask && !confirm(ask)) return;
    row.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api(`/findings/${f.id}/fix/${how}`, { method: 'POST', body: {} });
    } catch (err) {
      box.append(el('p', 'small fnd-fail', err.message));
    }
    await refresh();
  };
  if (fix.state === 'ready') {
    const apply = el('button', '', t('Apply to my branch'));
    apply.type = 'button';
    apply.addEventListener('click', () => void act('apply'));
    const keep = el('button', 'ghost', t('Keep the branch'));
    keep.type = 'button';
    keep.addEventListener('click', () => void act('keep'));
    const drop = el('button', 'ghost', t('Discard'));
    drop.type = 'button';
    drop.addEventListener('click', () => void act('discard', t('Throw this fix and its branch away?')));
    row.append(apply, keep, drop);
    box.append(el('p', 'small muted', t('Nothing is pushed: the branch stays on this computer.')));
  } else if (fix.state === 'kept' || fix.state === 'failed') {
    const drop = el('button', 'ghost small', fix.state === 'kept' ? t('Delete the branch') : t('Clear'));
    drop.type = 'button';
    drop.addEventListener('click', () => void act('discard', fix.state === 'kept' ? t('Delete the branch {branch}?', { branch: fix.branch }) : undefined));
    row.append(drop);
  }
  if (row.childElementCount) box.append(row);
  return box;
}

/** Dismiss / accept with a reason (a pick-list, plus your own words). */
function reasonForm(f, status, refresh, onCancel) {
  const form = el('div', 'fnd-reason');
  const sel = el('select');
  sel.setAttribute('aria-label', t('Why'));
  for (const [v, w] of REASONS) sel.append(new Option(w(), v));
  sel.append(new Option(t('Other (write it)'), ''));
  const other = el('input');
  other.type = 'text';
  other.placeholder = t('Why (kept with the finding)');
  other.hidden = true;
  other.setAttribute('aria-label', t('Why (kept with the finding)'));
  sel.addEventListener('change', () => (other.hidden = sel.value !== ''));
  const ok = el('button', '', status === 'dismissed' ? t('Dismiss') : t('Accept'));
  ok.type = 'button';
  const cancel = el('button', 'ghost', t('Cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const msg = el('span', 'small fnd-fail');
  ok.addEventListener('click', async () => {
    const reason = sel.value || other.value.trim();
    if (!reason) return void (msg.textContent = t('Say why (a reason is kept with the finding).'));
    ok.disabled = true;
    try {
      await api(`/findings/${f.id}/status`, { method: 'POST', body: { status, reason } });
      await refresh();
    } catch (err) {
      msg.textContent = err.message;
      ok.disabled = false;
    }
  });
  form.append(sel, other, ok, cancel, msg);
  return form;
}

function findingCard(f, refresh) {
  const card = el('article', `fnd-card sev-${f.severity} status-${f.status}`);
  card.dataset.id = String(f.id);
  const head = el('div', 'fnd-head');
  head.append(glyph(f.source === 'advisory' ? 'shield' : f.source === 'sandbox' ? 'sandbox' : f.source === 'contradiction' ? 'warn' : f.source === 'threat' ? 'compass' : f.source === 'redteam' ? 'target' : 'shield'), sevChip(f.severity), el('strong', 'fnd-title', rtTitle(f)));
  const meta = el('p', 'fnd-meta small muted');
  meta.append(el('span', '', (SOURCE[f.source] ?? (() => f.source))()));
  if (f.origin === 'model' && f.source !== 'redteam') meta.append(el('span', '', t('found by the Reviewing model, quote checked')));
  if (f.source === 'redteam' && f.meta?.probe !== 'default') meta.append(el('span', '', f.meta?.reviewed ? t('reproduced and checked by the Reviewing model') : t('reproduced in a fresh copy')));
  if (f.file) meta.append(raw(el('code', '', `${f.file}${f.line ? `:${f.line}` : ''}`)));
  if (f.workspace) meta.append(raw(el('span', '', f.workspace)));
  meta.append(el('span', '', `#${f.id}`));
  if (f.status !== 'open') meta.append(el('span', `fnd-status st-${f.status}`, (STATUS[f.status] ?? STATUS.open)()));
  card.append(head, meta);
  if (f.source === 'threat' && f.meta?.entry) card.append(threatPath(f));
  else if (f.source === 'redteam' && f.meta?.input) card.append(reproBlock({ input: f.meta.input, observed: f.meta.observed, file: f.file, line: f.line, quote: f.quote, entry: f.meta.entry?.label }));
  else if (f.quote) card.append(raw(el('pre', 'fnd-quote', f.quote)));
  const advice = adviceOf(f);
  if (advice) card.append(el('p', 'small', advice));
  if (f.source === 'advisory' && Array.isArray(f.meta?.vulns)) {
    const ul = el('ul', 'fnd-vulns small');
    for (const v of f.meta.vulns.slice(0, 6)) {
      const li = el('li');
      const a = raw(el('a', '', v.id));
      a.href = v.url;
      a.target = '_blank';
      a.rel = 'noopener';
      li.append(a, raw(el('span', '', ` ${v.summary ?? ''}${v.fixed ? ` (${t('fixed in {v}', { v: v.fixed })})` : ''}`)));
      ul.append(li);
    }
    card.append(ul);
  }
  if (f.reason) card.append(el('p', 'small muted fnd-why', t('Why: {reason}', { reason: f.reason })));
  const member = f.fix?.batch && f.fix.batch.lead !== f.id;
  if (member && f.fix.state !== 'discarded') card.append(el('p', 'small muted fnd-batch', t('In the fix pass with #{id}: its branch and diff are there.', { id: f.fix.batch.lead })));
  else if (f.fix && f.fix.state !== 'discarded') card.append(fixPanel(f, refresh));
  // While a fix is being made or waits for your choice, its own buttons are the ones that count.
  const fixBusy = f.fix && (f.fix.state === 'working' || f.fix.state === 'ready');
  if (f.status === 'open' && !fixBusy) {
    const row = el('div', 'row fnd-actions');
    if (f.canFix) {
      const fixB = el('button', '', t('Fix on a branch'));
      fixB.type = 'button';
      fixB.addEventListener('click', async () => {
        fixB.disabled = true;
        try {
          await api(`/findings/${f.id}/fix`, { method: 'POST', body: {} });
        } catch (err) {
          card.append(el('p', 'small fnd-fail', err.message));
        }
        await refresh();
      });
      row.append(fixB);
    }
    for (const [status, label] of [['dismissed', () => t('Dismiss')], ['accepted', () => t('Accept')]]) {
      const b = el('button', 'ghost', label());
      b.type = 'button';
      b.addEventListener('click', () => {
        row.hidden = true;
        const form = reasonForm(f, status, refresh, () => {
          form.remove();
          row.hidden = false;
        });
        card.append(form);
      });
      row.append(b);
    }
    card.append(row);
  } else if (f.status === 'dismissed' || f.status === 'accepted') {
    const re = el('button', 'ghost small', t('Open again'));
    re.type = 'button';
    re.addEventListener('click', async () => {
      await api(`/findings/${f.id}/status`, { method: 'POST', body: { status: 'open' } });
      await refresh();
    });
    card.append(re);
  }
  return card;
}

function query() {
  const q = new URLSearchParams();
  const f = st.filter;
  if (f.workspace) q.set('workspace', f.workspace);
  if (f.status) q.set('status', f.status);
  if (f.severity) q.set('severity', f.severity);
  if (f.source) q.set('source', f.source);
  if (f.runId) q.set('runId', String(f.runId));
  if (f.conversationId) q.set('conversationId', f.conversationId);
  return q.toString();
}

/** Reloads the open window (filters kept). */
export async function refreshFindings() {
  const dlg = $('#findings');
  if (!dlg?.open) return;
  let data;
  try {
    data = await api(`/findings?${query()}`);
  } catch (err) {
    $('#fnd-status-line').textContent = err.message;
    return;
  }
  st.data = data;
  const ws = $('#fnd-ws');
  const cur = st.filter.workspace;
  // The project asked for stays in the list even before it has findings (a red-team plan, a new project).
  const names = cur && !data.workspaces.includes(cur) ? [...data.workspaces, cur] : data.workspaces;
  ws.replaceChildren(new Option(t('All projects'), ''), ...names.map((w) => new Option(w, w)));
  ws.value = cur;
  const c = data.counts;
  const open = c.bySeverity;
  $('#fnd-status-line').textContent = t('Open: {n} ({high} serious) · fixed: {fixed} · dismissed: {dismissed} · accepted: {accepted}', { n: c.open, high: open.high + open.block, fixed: c.fixed, dismissed: c.dismissed, accepted: c.accepted });
  const chip = $('#fnd-run-chip');
  chip.hidden = !st.filter.runId && !st.filter.conversationId;
  $('#fnd-run-label').textContent = st.filter.runId ? t('Only run #{id}', { id: st.filter.runId }) : st.filter.conversationId ? t('Only this conversation') : '';
  $('#fnd-fixall').disabled = !st.filter.workspace || !(open.high + open.block);
  $('#fnd-scan').disabled = !st.filter.workspace && !st.filter.conversationId;
  if (st.tab === 'threats') return void renderThreatModel();
  if (st.tab === 'redteam') return void renderRedTeam();
  const list = $('#fnd-list');
  if (!data.findings.length) {
    list.replaceChildren(st.filter.status === 'open' ? emptyState({ icon: 'shield', text: t('Nothing open here.'), why: t('Her security pass adds findings here after each coding turn.'), howto: true }) : emptyState({ icon: 'search', text: t('No findings match these filters.') }));
  } else list.replaceChildren(...data.findings.map((f) => findingCard(f, refreshFindings)));
  // A fix still working: look again in a moment (stops when the window closes or none is left).
  clearTimeout(st.poll);
  if (data.findings.some((f) => f.fix?.state === 'working')) st.poll = setTimeout(() => void refreshFindings(), 1500);
}

/** Opens the Findings window, optionally for one project, run or conversation. */
export async function openFindings(opts = {}) {
  st.filter = { workspace: opts.workspace ?? '', status: opts.status ?? 'open', severity: '', source: opts.source ?? '', runId: opts.runId ?? 0, conversationId: opts.conversationId ?? '' };
  $('#fnd-status').value = st.filter.status;
  $('#fnd-severity').value = '';
  $('#fnd-source').value = st.filter.source;
  const dlg = $('#findings');
  if (!dlg.open) dlg.showModal();
  showTab(opts.tab === 'threats' || opts.tab === 'redteam' ? opts.tab : 'list');
  if (opts.tab === 'redteam' && opts.plan) void showPlan();
  await refreshFindings();
}

let wired = false;
/** Wires the window's filters and buttons (once). */
export function initFindings() {
  if (wired || !$('#findings')) return;
  wired = true;
  const set = (k) => (e) => {
    st.filter[k] = e.target.value;
    void refreshFindings();
  };
  $('#fnd-ws').addEventListener('change', (e) => {
    if (rt.view === 'plan') rt.view = 'home';
    set('workspace')(e);
  });
  $('#fnd-status').addEventListener('change', set('status'));
  $('#fnd-severity').addEventListener('change', set('severity'));
  $('#fnd-source').addEventListener('change', set('source'));
  $('#fnd-run-clear').addEventListener('click', () => {
    st.filter.runId = 0;
    st.filter.conversationId = '';
    void refreshFindings();
  });
  $('#fnd-scan').addEventListener('click', async () => {
    const b = $('#fnd-scan');
    b.disabled = true;
    $('#fnd-status-line').textContent = t('Checking…');
    try {
      const body = st.filter.conversationId ? { conversationId: st.filter.conversationId } : { workspace: st.filter.workspace };
      const r = await api('/findings/scan', { method: 'POST', body });
      st.filter.runId = 0;
      $('#fnd-status-line').textContent = t('Checked {n} files.', { n: r.summary.files });
    } catch (err) {
      $('#fnd-status-line').textContent = err.message;
    }
    b.disabled = false;
    await refreshFindings();
  });
  $('#fnd-fixall').addEventListener('click', async () => {
    if (!confirm(t('Make a fix branch for every open serious finding in {project}, one after another? Nothing is pushed; you choose for each fix.', { project: st.filter.workspace }))) return;
    try {
      const r = await api('/findings/fix-all', { method: 'POST', body: { workspace: st.filter.workspace } });
      $('#fnd-status-line').textContent = t('Fixes started: {n}', { n: r.started.length });
    } catch (err) {
      $('#fnd-status-line').textContent = err.message;
    }
    await refreshFindings();
  });
  $('#findings').addEventListener('close', () => clearTimeout(st.poll));
  $('#fnd-tab-list').addEventListener('click', () => showTab('list'));
  $('#fnd-tab-threats').addEventListener('click', () => showTab('threats'));
  $('#fnd-tab-redteam').addEventListener('click', () => showTab('redteam'));
}

// ---- Phase 82: the threat model ----------------------------------------------------------------

/** A threat's entry point → sink path, each step with its file and line (the quotes are real lines). */
function threatPath(f) {
  const box = el('div', 'fnd-threat');
  const m = f.meta ?? {};
  const top = el('p', 'small fnd-threat-cat');
  if (m.category) top.append(el('span', 'fnd-chip', (CATEGORY[m.category] ?? (() => m.category))()));
  top.append(el('span', 'muted', t('Entry point → dangerous line')));
  box.append(top);
  const ol = el('ol', 'fnd-path small');
  for (const s of Array.isArray(m.path) ? m.path : []) {
    const li = el('li');
    li.append(raw(el('span', 'fnd-step', s.label)), raw(el('code', '', `${s.file}:${s.line}`)));
    ol.append(li);
  }
  box.append(ol);
  if (m.entry?.quote) {
    box.append(el('p', 'small muted', t('Entry point')));
    box.append(raw(el('pre', 'fnd-quote', m.entry.quote)));
  }
  box.append(el('p', 'small muted', t('Dangerous line')));
  box.append(raw(el('pre', 'fnd-quote', f.quote ?? '')));
  return box;
}

/** "Fix these": the second pass over these open threats (one branch, one diff). */
async function fixThese(ids, workspace) {
  return api('/threat-model/fix', { method: 'POST', body: { ids, ...(workspace ? { workspace } : {}) } });
}

function section(title, ...children) {
  const s = el('section', 'fnd-tm-section');
  s.append(el('h3', '', title), ...children);
  return s;
}

/** The Threat model tab: surfaces, trust boundaries, open threats, what changed (one project). */
async function renderThreatModel() {
  const box = $('#fnd-threats');
  const ws = st.filter.workspace;
  if (!ws) return void box.replaceChildren(el('p', 'muted fnd-empty', t('Pick a project to see its threat model.')));
  let r;
  try {
    r = await api(`/threat-model?workspace=${encodeURIComponent(ws)}`);
  } catch (err) {
    return void box.replaceChildren(el('p', 'small fnd-fail', err.message));
  }
  const m = r.summary;
  const head = el('div', 'fnd-tm-head');
  const line = el('p', 'small muted', m ? t('Written {when} from {n} code files. Every threat quotes real lines; nothing was run.', { when: new Date(m.at).toLocaleString(locale()), n: m.files }) : t('No threat model for this project yet. It is written after a coding turn that changes files, or now.'));
  const row = el('div', 'row fnd-actions');
  const scan = el('button', 'ghost', t('Check the whole project'));
  scan.type = 'button';
  scan.addEventListener('click', async () => {
    scan.disabled = true;
    line.textContent = t('Checking…');
    try {
      await api('/threat-model/scan', { method: 'POST', body: { workspace: ws } });
    } catch (err) {
      line.textContent = err.message;
    }
    await renderThreatModel();
  });
  row.append(scan);
  const openIds = (m?.open ?? []).map((o) => o.id);
  const turnIds = (m?.changed?.ids ?? []).filter((id) => openIds.includes(id));
  if (r.mode === 'offer' && turnIds.length) {
    const fx = el('button', '', t('Fix these'));
    fx.type = 'button';
    fx.addEventListener('click', async () => {
      if (!confirm(t('Make one local fix branch for these {n} threats? The Coding model may only fix them: no new features, no refactors. Nothing is pushed; you choose Apply, Keep or Discard.', { n: turnIds.length }))) return;
      fx.disabled = true;
      try {
        await fixThese(turnIds, ws);
        line.textContent = t('The fix pass started: see its progress in Findings.');
      } catch (err) {
        line.textContent = err.message;
      }
    });
    row.append(fx);
  }
  head.append(line, row);
  if (!m) return void box.replaceChildren(head);
  const surf = el('ul', 'fnd-tm-list small');
  for (const e of m.entries) {
    const li = el('li');
    li.append(raw(el('code', '', e.label)), raw(el('span', 'muted', ` ${e.file}:${e.line}`)));
    if (e.kind === 'http' || e.kind === 'upload') li.append(el('span', `fnd-chip ${e.authed ? 'chip-ok' : 'chip-warn'}`, e.authed ? t('signed in') : t('no sign-in check seen')));
    if (e.upload) li.append(el('span', 'fnd-chip', t('file upload')));
    if (e.kind === 'message') li.append(el('span', 'fnd-chip', t('messages')));
    if (e.kind === 'cli') li.append(el('span', 'fnd-chip', t('command line')));
    surf.append(li);
  }
  if (!m.entries.length) surf.append(el('li', 'muted', t('No entry points found.')));
  if (m.envReads) surf.append(el('li', 'muted', t('Environment variables read in {n} places (set by whoever runs the app; no threats from these).', { n: m.envReads })));
  const bounds = el('ul', 'fnd-tm-list small');
  for (const b of m.boundaries) {
    const li = el('li');
    li.append(el('span', '', (BOUNDARY[b.id] ?? (() => b.id))()), el('span', 'fnd-chip', String(b.count)));
    bounds.append(li);
  }
  const open = el('div', 'fnd-list');
  for (const o of m.open) {
    const c = el('article', `fnd-card sev-${o.severity}`);
    const h = el('div', 'fnd-head');
    h.append(glyph('shield'), sevChip(o.severity), el('strong', 'fnd-title', (RULE[o.rule]?.[0] ?? (() => o.title))()), raw(el('span', 'muted small', `#${o.id}`)));
    c.append(h);
    if (o.category) c.append(el('p', 'small muted', (CATEGORY[o.category] ?? (() => o.category))()));
    c.append(raw(el('p', 'small fnd-tm-path', o.path || `${o.entry} → ${o.sink}`)));
    if (o.origin === 'model') c.append(el('p', 'small muted', t('found by the Reviewing model, quote checked')));
    open.append(c);
  }
  if (!m.open.length) open.append(el('p', 'muted small', t('None open.')));
  const changed = el('p', 'small');
  changed.textContent = m.changed.files.length ? t('Files this turn: {files}', { files: m.changed.files.join(', ') }) : t('A check you started (the whole project).');
  const news = el('p', 'small muted', t('New threats: {n} · open from this pass: {open}', { n: m.changed.newIds.length, open: m.changed.ids.length }));
  box.replaceChildren(head, section(t('Surfaces (entry points)'), surf), section(t('Trust boundaries'), bounds), section(t('Open threats'), open), section(t('What changed this turn'), changed, news));
}

function showTab(tab) {
  // Phase 114 (PL1c, V8): the coder names stay; a plain line under the tabs says what each one is.
  const sub = $('#fnd-tab-sub');
  if (sub) sub.textContent = { list: t('What her checks found in your code, each with the real line.'), threats: t('How someone could attack this project, written from its own code.'), redteam: t('She tries to break it before you ship.') }[tab] ?? '';
  st.tab = tab;
  for (const [id, name] of [['#fnd-tab-list', 'list'], ['#fnd-tab-threats', 'threats'], ['#fnd-tab-redteam', 'redteam']]) {
    $(id).classList.toggle('active', tab === name);
    $(id).setAttribute('aria-selected', String(tab === name));
  }
  $('#findings').classList.toggle('fnd-on-threats', tab !== 'list');
  $('#fnd-threats').hidden = tab !== 'threats';
  $('#fnd-redteam').hidden = tab !== 'redteam';
  $('#fnd-list').hidden = tab !== 'list';
  clearTimeout(rt.poll);
  if (tab === 'threats') void renderThreatModel();
  else if (tab === 'redteam') void renderRedTeam();
  else void refreshFindings();
}

/** The small card under a coding reply once the threat pass is done (`meta.threats`). */
export function threatCard(summary, opts = {}) {
  const n = summary.counts ?? {};
  const serious = (n.high ?? 0) + (n.block ?? 0);
  const total = (summary.ids ?? []).length;
  const box = el('div', `fnd-chat fnd-threat-chat ${serious ? 'fnd-flagged' : total ? 'fnd-some' : 'fnd-clean'}`);
  box.append(glyph('compass'));
  const body = el('div', 'fnd-chat-body');
  body.append(el('strong', '', t('Threat model')));
  body.append(el('span', 'small', total ? t('Threats: {n} ({serious} serious), each from an entry point to a quoted line', { n: total, serious }) : t('No threats in what she changed.')));
  const notes = [t('Entry points: {n}', { n: summary.entries ?? 0 })];
  if (summary.reviewer?.ran) notes.push(t('Reviewing model: {n} added', { n: summary.reviewer.added ?? 0 }));
  if (summary.error) notes.push(t('The pass stopped: {why}', { why: summary.error }));
  body.append(el('span', 'small muted', notes.join(' · ')));
  const msg = el('span', 'small muted');
  body.append(msg);
  box.append(body);
  const row = el('div', 'fnd-chat-actions');
  if (opts.onOpen) {
    const b = el('button', 'ghost small', t('Show threat model'));
    b.type = 'button';
    b.addEventListener('click', () => opts.onOpen(summary));
    row.append(b);
  }
  if (opts.redteam) row.append(redteamButton(summary.workspace, opts.conversationId));
  if (total && summary.mode === 'offer') {
    const fx = el('button', 'small', t('Fix these'));
    fx.type = 'button';
    fx.addEventListener('click', async () => {
      fx.disabled = true;
      try {
        await fixThese(summary.ids, summary.workspace);
        msg.textContent = t('The fix pass started: see its progress in Findings.');
        opts.onFixStarted?.(summary);
      } catch (err) {
        msg.textContent = err.message;
        fx.disabled = false;
      }
    });
    row.append(fx);
  }
  if (row.childElementCount) box.append(row);
  return box;
}


// ---- in the chat ---------------------------------------------------------------------------------

/** The small card under a coding reply once her security pass is done (`meta.security`). */
export function securityCard(summary, opts = {}) {
  const n = summary.counts ?? {};
  const serious = (n.high ?? 0) + (n.block ?? 0);
  const total = (summary.ids ?? []).length;
  const box = el('div', `fnd-chat ${serious ? 'fnd-flagged' : total ? 'fnd-some' : 'fnd-clean'}`);
  box.append(glyph('shield'));
  const body = el('div', 'fnd-chat-body');
  body.append(el('strong', '', t('Security pass')));
  body.append(el('span', 'small', total ? t('Findings: {n} ({serious} serious)', { n: total, serious }) : t('Nothing found in the files she changed.')));
  const notes = [];
  if (summary.reviewer?.ran) notes.push(t('Reviewing model: {n} added', { n: summary.reviewer.added ?? 0 }));
  const adv = summary.advisories ?? {};
  if (adv.note === 'offline') notes.push(t('Dependencies not checked: offline'));
  else if (adv.note === 'private') notes.push(t('Dependencies not checked: private conversation'));
  else if (adv.checked) notes.push(t('Dependencies checked: {n}', { n: adv.checked }));
  if (summary.error) notes.push(t('The pass stopped: {why}', { why: summary.error }));
  if (notes.length) body.append(el('span', 'small muted', notes.join(' · ')));
  box.append(body);
  if (total && opts.onOpen) {
    const b = el('button', 'ghost small', t('Show findings'));
    b.type = 'button';
    b.addEventListener('click', () => opts.onOpen(summary));
    box.append(b);
  }
  const rtWs = opts.workspace ?? summary.workspace;
  if (opts.redteam && rtWs) box.append(redteamButton(rtWs, opts.conversationId));
  return box;
}

/** The approval card's "Known vulnerability" section (the buttons are the caller's). */
export function advisorySection(card) {
  const box = el('div', 'fnd-adv');
  const head = el('p', 'fnd-adv-head');
  head.append(glyph('shield'), el('strong', '', t('Known vulnerability')));
  box.append(head);
  for (const p of card.packages ?? []) {
    const row = el('div', 'fnd-adv-pkg');
    const top = el('p', '');
    top.append(sevChip(p.severity), raw(el('code', '', `${p.name} ${p.version}`)), el('span', 'small muted', ` ${p.ecosystem}`));
    row.append(top);
    const ul = el('ul', 'fnd-vulns small');
    for (const v of (p.vulns ?? []).slice(0, 4)) {
      const li = el('li');
      const a = raw(el('a', '', v.id));
      a.href = v.url;
      a.target = '_blank';
      a.rel = 'noopener';
      li.append(a, raw(el('span', '', ` ${v.summary ?? ''}`)));
      if (v.fixed) li.append(el('span', 'muted', ` (${t('fixed in {v}', { v: v.fixed })})`));
      ul.append(li);
    }
    row.append(ul);
    box.append(row);
  }
  box.append(el('p', 'small muted', t('From OSV.dev. Installing anyway is your explicit choice and is recorded with the finding.')));
  return box;
}

/** The line under her step after the install check (installed anyway, not installed, not checked). */
export function advisoryFlag(ev) {
  const words = {
    override: () => t('Installed anyway (your override): {packages}', { packages: ev.packages.join(', ') }),
    declined: () => t('Not installed (known vulnerability): {packages}', { packages: ev.packages.join(', ') }),
    offline: () => t('Not checked: offline ({packages})', { packages: ev.packages.join(', ') }),
  };
  const box = el('div', `fnd-flag fnd-flag-${ev.state}`);
  box.dataset.call = ev.id ?? '';
  box.append(glyph('shield'), raw(el('span', 'small', (words[ev.state] ?? words.offline)())));
  return box;
}


// ---- Phase 86: red-team mode ---------------------------------------------------------------------

const rt = { poll: null, report: null, plan: null, view: 'home' };
const BREAK_KIND = {
  exit: () => t('the app stopped'),
  crash: () => t('server error'),
  uncaught: () => t('uncaught error'),
  timeout: () => t('no answer (hung)'),
  'stack-trace': () => t('stack trace shown'),
  'secret-echo': () => t('secret sent back'),
};
const PROBE_KIND = {
  baseline: () => t('an ordinary value'),
  empty: () => t('an empty value'),
  missing: () => t('a missing field'),
  huge: () => t('a very long value'),
  unicode: () => t('unusual Unicode'),
  path: () => t('path-like text (../)'),
  quotes: () => t('quote characters'),
  number: () => t('a number out of range'),
  type: () => t('the wrong type'),
  duplicate: () => t('a duplicated parameter'),
  'malformed-json': () => t('malformed JSON'),
  'content-type': () => t('the wrong content type'),
  nested: () => t('deep nesting'),
};
const RT_STATUS = { running: () => t('running'), awaiting: () => t('waiting for your OK'), done: () => t('done'), stopped: () => t('stopped'), error: () => t('stopped by an error') };
const RT_STAGE = {
  starting: () => t('starting'),
  'running the tests': () => t('running the tests'),
  'probing the entry points': () => t('probing the entry points'),
  'checking insecure defaults': () => t('checking insecure defaults'),
  'asking the Coding model for probe scripts': () => t('asking the Coding model for probe scripts'),
  'reproducing what broke': () => t('reproducing what broke'),
  'the Reviewing model checks each break': () => t('the Reviewing model checks each break'),
  'waiting for your OK on the probe scripts': () => t('waiting for your OK on the probe scripts'),
  'running the approved probe scripts': () => t('running the approved probe scripts'),
};
const DROP_WHY = {
  'did not happen again in a fresh copy': () => t('did not happen again in a fresh copy'),
  'not confirmed by the Reviewing model': () => t('not confirmed by the Reviewing model'),
  'the Reviewing model found it is not a real problem': () => t('the Reviewing model found it is not a real problem'),
  'the review did not cite the reproducing input': () => t('the review did not cite the reproducing input'),
  'the review did not cite the observed output': () => t('the review did not cite the observed output'),
  'no code line could be quoted': () => t('no code line could be quoted'),
  'no Reviewing model to check a model-written probe': () => t('no Reviewing model to check a model-written probe'),
  'passed when run again': () => t('passed when run again'),
};
const n = (x) => Number(x ?? 0).toLocaleString(locale());

/** A break's reproduction steps: the input, what was observed, the code line (all real text). */
function reproBlock(b) {
  const box = el('div', 'fnd-repro');
  if (b.entry) box.append(el('p', 'small muted', t('Entry point: {e}', { e: b.entry })));
  box.append(el('p', 'small muted', t('Send this')), raw(el('pre', 'fnd-quote', b.input)));
  if (b.observed) box.append(el('p', 'small muted', t('What happened')), raw(el('pre', 'fnd-quote', b.observed)));
  if (b.file && b.quote) {
    const p = el('p', 'small muted', t('The line'));
    p.append(raw(el('code', '', ` ${b.file}:${b.line}`)));
    box.append(p, raw(el('pre', 'fnd-quote', b.quote)));
  }
  return box;
}

async function startRun(body) {
  return api('/redteam', { method: 'POST', body: { ...body, confirm: true } });
}

/** The plan card: what she will try, the budget and the isolation, before anything runs. */
async function showPlan() {
  rt.view = 'plan';
  const box = $('#fnd-redteam');
  const body = st.filter.conversationId ? { conversationId: st.filter.conversationId } : { workspace: st.filter.workspace };
  if (!body.conversationId && !body.workspace) return void box.replaceChildren(el('p', 'muted fnd-empty', t('Pick a project to red-team.')));
  box.replaceChildren(el('p', 'muted small', t('Looking…')));
  let r;
  try {
    r = await api('/redteam/plan', { method: 'POST', body });
  } catch (err) {
    return void box.replaceChildren(el('p', 'small fnd-fail', err.message));
  }
  const p = r.plan;
  rt.plan = p;
  const card = el('article', 'fnd-card fnd-rt-plan');
  const head = el('div', 'fnd-head');
  head.append(glyph('target'), el('strong', 'fnd-title', t('Red-team {project}', { project: p.workspace })));
  card.append(head, el('p', 'small', t('She tries to break it in a throwaway copy with the network off. Nothing touches your files; anything that breaks is shown with the input that broke it.')));
  const ul = el('ul', 'fnd-tm-list small');
  ul.append(el('li', '', p.tests ? t('Tests: {cmd}', { cmd: p.tests }) : t('Tests: none found')));
  ul.append(el('li', '', p.start.none ? t('The app: not started ({why})', { why: p.start.none }) : t('The app: {cmd}, on a free local port', { cmd: p.start.command })));
  ul.append(el('li', '', t('Entry points: {n} · unusual inputs to send: {probes}', { n: p.entries.length, probes: p.probes })));
  ul.append(el('li', '', t('Insecure defaults: {n} checks (debug mode, default passwords, CORS, security headers, open interfaces, file permissions, committed secrets)', { n: p.defaults.length })));
  ul.append(el('li', '', p.scripts.max ? (p.scripts.needApproval ? t('Probe scripts by the Coding model: up to {n}; you read and OK each one before it runs', { n: p.scripts.max }) : t('Probe scripts by the Coding model: up to {n}, checked by code, run in the sandbox', { n: p.scripts.max })) : t('Probe scripts by the Coding model: off')));
  ul.append(el('li', '', t('Budget: up to {tokens} tokens for the two models · time limit {m} min', { tokens: n(p.budget.tokens), m: p.budget.minutes })));
  card.append(ul);
  const chip = el('p', 'small');
  chip.append(el('span', `fnd-chip ${p.isolation.isolated ? 'chip-ok' : 'chip-warn'}`, p.isolation.isolated ? t('Isolated ({how})', { how: p.isolation.label }) : t('Not isolated')));
  if (!p.isolation.isolated) chip.append(el('span', 'muted', ` ${t('This computer has no OS sandbox: it runs in a copy, the probes only reach the app it starts, and scripts wait for your OK.')}`));
  card.append(chip);
  for (const x of p.notTried ?? []) card.append(raw(el('p', 'small muted', x)));
  const row = el('div', 'row fnd-actions');
  const go = el('button', '', t('Start'));
  go.type = 'button';
  const back = el('button', 'ghost', t('Cancel'));
  back.type = 'button';
  back.addEventListener('click', () => {
    rt.view = 'home';
    void renderRedTeam();
  });
  const msg = el('span', 'small fnd-fail');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const s = await startRun(body);
      rt.view = s.report.id;
      await renderRedTeam();
    } catch (err) {
      msg.textContent = err.message;
      go.disabled = false;
    }
  });
  row.append(go, back, msg);
  card.append(row);
  box.replaceChildren(card);
}

/** The Red team tab: Red-team this, the project's runs, and the open report. */
async function renderRedTeam() {
  clearTimeout(rt.poll);
  const box = $('#fnd-redteam');
  if (!box || st.tab !== 'redteam') return;
  const ws = st.filter.workspace;
  // The plan stays on screen while the window refreshes (it is fetched by showPlan).
  if (rt.view === 'plan') return;
  if (typeof rt.view === 'number') return void renderReport(rt.view);
  const head = el('div', 'fnd-tm-head');
  head.append(el('p', 'small muted', t('Before you ship: she tries to break her own work in a throwaway copy (tests, unusual input at every entry point, insecure defaults, probe scripts) and reports only what she could break twice.')));
  const row = el('div', 'row fnd-actions');
  const go = el('button', '', t('Red-team this'));
  go.type = 'button';
  go.disabled = !ws && !st.filter.conversationId;
  go.addEventListener('click', () => void showPlan());
  row.append(go);
  head.append(row);
  if (!ws) return void box.replaceChildren(head, el('p', 'muted fnd-empty', t('Pick a project to red-team.')));
  let r;
  try {
    r = await api(`/redteam?workspace=${encodeURIComponent(ws)}`);
  } catch (err) {
    return void box.replaceChildren(head, el('p', 'small fnd-fail', err.message));
  }
  const list = el('div', 'fnd-list');
  for (const x of r.reports ?? []) {
    const c = el('article', `fnd-card fnd-rt-row ${x.serious ? 'sev-high' : x.breaks ? 'sev-medium' : 'status-fixed'}`);
    const h = el('div', 'fnd-head');
    h.append(glyph('target'), el('strong', 'fnd-title', t('Run #{id}', { id: x.id })), el('span', 'fnd-chip', (RT_STATUS[x.status] ?? RT_STATUS.done)()));
    c.append(h, el('p', 'small muted', `${new Date(x.startedAt).toLocaleString(locale())} · ${x.breaks ? t('Broke: {n} ({serious} serious)', { n: x.breaks, serious: x.serious }) : t('Nothing broke')}${x.reason === 'ship' ? ` · ${t('before shipping')}` : ''}`));
    const open = el('button', 'ghost small', t('Show the report'));
    open.type = 'button';
    open.addEventListener('click', () => {
      rt.view = x.id;
      void renderReport(x.id);
    });
    c.append(open);
    list.append(c);
  }
  if (!(r.reports ?? []).length) list.append(el('p', 'muted small', t('No red-team runs in this project yet.')));
  box.replaceChildren(head, section(t('Runs'), list));
}

/** One report: progress while it runs, then what was tried, what broke, what was dropped. */
async function renderReport(id) {
  clearTimeout(rt.poll);
  const box = $('#fnd-redteam');
  let data;
  try {
    data = await api(`/redteam/${id}`);
  } catch (err) {
    return void box.replaceChildren(el('p', 'small fnd-fail', err.message));
  }
  const r = data.report;
  rt.report = r;
  const head = el('div', 'fnd-tm-head');
  const top = el('div', 'row fnd-actions');
  const back = el('button', 'ghost small', t('All runs'));
  back.type = 'button';
  back.addEventListener('click', () => {
    rt.view = 'home';
    void renderRedTeam();
  });
  top.append(back);
  const title = el('p', 'fnd-head');
  title.append(glyph('target'), el('strong', '', t('Red-team report #{id}', { id: r.id })), el('span', 'fnd-chip', (RT_STATUS[r.status] ?? RT_STATUS.done)()), el('span', `fnd-chip ${r.isolation.isolated ? 'chip-ok' : 'chip-warn'}`, r.isolation.isolated ? t('Isolated') : t('Not isolated')));
  head.append(top, title);
  if (r.status === 'running') {
    head.append(el('p', 'small', t('Working: {stage}', { stage: (RT_STAGE[r.stage] ?? (() => r.stage || '…'))() })));
    const stop = el('button', 'ghost small', t('Stop'));
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      await api(`/redteam/${r.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
      void renderReport(r.id);
    });
    top.append(stop);
  }
  head.append(el('p', 'small muted', t('Budget: {used} of {tokens} tokens · {s} s of {m} min', { used: n(r.budget.usedTokens), tokens: n(r.budget.tokens), s: Math.round((r.budget.ms ?? 0) / 1000), m: r.budget.minutes })));
  if (r.error) head.append(el('p', 'small fnd-fail', serverWords(r.error)));
  const parts = [head];
  // What was tried.
  const tried = el('ul', 'fnd-tm-list small');
  if (r.tests) tried.append(el('li', r.tests.ran && r.tests.exitCode === 0 ? 'fnd-pass' : 'fnd-fail', !r.tests.ran ? t('Tests not run: {why}', { why: r.tests.note ?? '' }) : r.tests.exitCode === 0 ? t('Tests pass ({command})', { command: r.tests.command }) : t('Tests fail ({command}): {n} failing', { command: r.tests.command, n: r.tests.failures.length || 1 })));
  else tried.append(el('li', 'muted', t('Tests: none found')));
  if (r.app) tried.append(el('li', r.app.started ? '' : 'fnd-fail', r.app.started ? t('The app started in the copy on 127.0.0.1:{port}', { port: r.app.port }) : t('The app did not start: {why}', { why: r.app.why ?? '' })));
  const kinds = Object.entries(r.tried.byKind ?? {}).filter(([k]) => k !== 'baseline').map(([k, v]) => `${(PROBE_KIND[k] ?? (() => k))()} ${v}`);
  tried.append(el('li', '', t('Unusual inputs sent: {n}', { n: r.tried.probes }) + (kinds.length ? ` (${kinds.join(', ')})` : '')));
  tried.append(el('li', '', t('Insecure-default checks: {n}', { n: r.tried.defaults })));
  if (r.scripts.length || r.attacker.ran) tried.append(el('li', '', t('Probe scripts: {written} written, {rejected} refused by the checks, {ran} run', { written: r.attacker.written, rejected: r.attacker.rejected, ran: r.tried.scripts })));
  else if (r.attacker.note) tried.append(el('li', 'muted', t('Probe scripts: none ({why})', { why: r.attacker.note })));
  if (r.status !== 'running' || r.reviewer.ran) tried.append(el('li', 'muted', r.reviewer.ran ? t('Reviewing model: kept {kept}, dropped {dropped}', { kept: r.reviewer.kept, dropped: r.reviewer.dropped }) : t('Reviewing model: not used ({why}); only breaks found by code count', { why: r.reviewer.note ?? '-' })));
  for (const b of r.tried.behaviour ?? []) tried.append(el('li', 'fnd-fail', t('Sandbox: {what}', { what: b.title })));
  parts.push(section(t('What was tried'), tried));
  // Scripts waiting for the owner's OK.
  const waiting = r.scripts.filter((x) => x.status === 'awaiting');
  if (waiting.length && r.status === 'awaiting') parts.push(section(t('Probe scripts waiting for your OK'), scriptsApproval(r, waiting)));
  // What broke.
  const broke = el('div', 'fnd-list');
  for (const b of r.breaks) {
    const c = el('article', `fnd-card sev-${b.severity}`);
    const h = el('div', 'fnd-head');
    const rule = b.by === 'default' ? `redteam:${b.kind}` : b.by === 'tests' ? 'redteam:tests' : `redteam:${b.kind}`;
    h.append(glyph('target'), sevChip(b.severity), el('strong', 'fnd-title', b.by === 'probe' || b.by === 'script' ? b.title : (RULE[rule]?.[0] ?? (() => b.title))()), raw(el('span', 'muted small', `#${b.findingId}`)));
    c.append(h);
    const how = el('p', 'small muted');
    how.textContent = b.by === 'default' ? t('Insecure default, found by code') : b.by === 'tests' ? t('The project tests, run twice') : `${(BREAK_KIND[b.kind] ?? (() => b.kind))()} · ${t('reproduced in a fresh copy')}${b.also ? ` · ${t('{n} more inputs broke it the same way', { n: b.also })}` : ''}`;
    c.append(how);
    if (b.input) c.append(reproBlock(b));
    else if (b.quote) c.append(raw(el('pre', 'fnd-quote', `${b.file ? `${b.file}:${b.line}  ` : ''}${b.quote}`)));
    broke.append(c);
  }
  if (!r.breaks.length) broke.append(el('p', 'muted small', r.status === 'running' ? t('Nothing yet.') : t('Nothing broke that could be proven twice.')));
  const fixRow = el('div', 'row fnd-actions');
  const fixable = r.breaks.filter((b) => b.file && b.quote).length;
  if (fixable && r.status !== 'running') {
    const fx = el('button', '', t('Fix what broke'));
    fx.type = 'button';
    const m = el('span', 'small muted');
    fx.addEventListener('click', async () => {
      if (!confirm(t('Make one local fix branch for what broke? The Coding model may only fix these breaks; the same inputs are sent again and the tests run before you choose. Nothing is pushed.'))) return;
      fx.disabled = true;
      try {
        await api(`/redteam/${r.id}/fix`, { method: 'POST', body: {} });
        m.textContent = t('The fix pass started: see its progress in Findings.');
        await openFindings({ workspace: r.workspace, source: 'redteam' });
      } catch (err) {
        m.textContent = err.message;
        fx.disabled = false;
      }
    });
    fixRow.append(fx, m);
  }
  parts.push(section(t('What broke'), broke, ...(fixRow.childElementCount ? [fixRow] : [])));
  // Dropped ("no theater") and refused scripts.
  if (r.dropped.length || r.scripts.some((x) => x.status === 'rejected')) {
    const d = el('details', 'fnd-out');
    d.append(el('summary', '', t('Dropped or refused: {n}', { n: r.dropped.length + r.scripts.filter((x) => x.status === 'rejected').length })));
    const ul = el('ul', 'fnd-tm-list small');
    for (const x of r.dropped) ul.append(raw(el('li', '', `${x.title}: ${(DROP_WHY[x.why] ?? (() => x.why))()}${x.input ? ` · ${x.input}` : ''}`)));
    for (const x of r.scripts.filter((s) => s.status === 'rejected')) ul.append(raw(el('li', '', `${x.id}: ${t('refused')} (${(x.problems ?? []).join('; ')})`)));
    d.append(ul);
    parts.push(d);
  }
  box.replaceChildren(...parts);
  if (r.status === 'running') rt.poll = setTimeout(() => {
    if (st.tab === 'redteam' && rt.view === r.id && $('#findings')?.open) void renderReport(r.id);
  }, 2000);
}

/** Server words in the report that have a translation (the rest are shown as sent). */
const serverWords = (s) => (s === 'Stopped at the time limit.' ? t('Stopped at the time limit.') : s === 'Interrupted by a restart.' ? t('Interrupted by a restart.') : s);

/** The attacker scripts to read and approve (copy-only mode): each in full, ticked to run. */
function scriptsApproval(r, list) {
  const box = el('div', 'fnd-rt-scripts');
  box.append(el('p', 'small', t('No OS sandbox on this computer, so nothing the Coding model wrote runs until you have read it. Each script passed the checks: it only talks to the app through APP_URL, starts no programs, installs nothing and writes no files.')));
  const picks = [];
  for (const s of list) {
    const c = el('article', 'fnd-card');
    const lab = el('label', 'row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.value = s.id;
    picks.push(cb);
    lab.append(cb, el('span', '', t('Run {id} ({lang})', { id: s.id, lang: s.lang === 'python' ? 'Python' : 'Node' })));
    c.append(lab);
    if (s.purpose) c.append(raw(el('p', 'small muted', s.purpose)));
    c.append(raw(el('pre', 'fnd-diff', s.code)));
    box.append(c);
  }
  const row = el('div', 'row fnd-actions');
  const go = el('button', '', t('Run the ones I ticked'));
  go.type = 'button';
  const skip = el('button', 'ghost', t('Skip them'));
  skip.type = 'button';
  const send = async (ids) => {
    go.disabled = skip.disabled = true;
    try {
      await api(`/redteam/${r.id}/scripts`, { method: 'POST', body: { approve: ids } });
    } catch (err) {
      box.append(el('p', 'small fnd-fail', err.message));
    }
    void renderReport(r.id);
  };
  go.addEventListener('click', () => {
    const ids = picks.filter((x) => x.checked).map((x) => x.value);
    if (!ids.length) return void skip.click();
    void send(ids);
  });
  skip.addEventListener('click', () => void send([]));
  row.append(go, skip);
  box.append(row);
  return box;
}

/** \"Red-team this\": opens the Red team tab on the plan for a project or conversation. */
export function openRedTeam(opts = {}) {
  rt.view = 'plan';
  return openFindings({ ...opts, tab: 'redteam', plan: true });
}

/** The ship card's section (Ask me: an offer; Always: the run's result). Buttons are the caller's. */
export function redteamGateSection(card) {
  const box = el('div', 'fnd-adv fnd-rt-gate');
  const head = el('p', 'fnd-adv-head');
  head.append(glyph('target'), el('strong', '', t('Red-team before shipping')));
  box.append(head);
  if (card.mode === 'ask') box.append(el('p', 'small', t('Try to break it first? A red-team run in a throwaway copy takes a few minutes; nothing is pushed until you say so.')));
  else if (card.error) box.append(el('p', 'small fnd-fail', card.error));
  else box.append(el('p', 'small', card.breaks ? t('The red-team run found {n} breaks ({serious} serious). Look at the report before shipping.', { n: card.breaks, serious: card.serious ?? 0 }) : t('The red-team run found nothing it could prove.')));
  if (card.id) {
    const b = el('button', 'ghost small', t('Show the report'));
    b.type = 'button';
    b.addEventListener('click', () => {
      rt.view = card.id;
      void openFindings({ workspace: card.workspace, tab: 'redteam' });
    });
    box.append(b);
  }
  return box;
}

/** The line under her step when you chose \"Red-team first\". */
export function redteamFlag(ev) {
  const box = el('div', 'fnd-flag');
  box.dataset.call = ev.id ?? '';
  box.append(glyph('target'), el('span', 'small', t('Red-team run #{id} started: shipping waits for its report.', { id: ev.runId })));
  const b = el('button', 'ghost small', t('Show the report'));
  b.type = 'button';
  b.addEventListener('click', () => {
    rt.view = ev.runId;
    void openFindings({ workspace: ev.workspace, tab: 'redteam' });
  });
  box.append(b);
  return box;
}

/** \"Red-team this\" for the chat cards (security pass / threat model). */
export function redteamButton(workspace, conversationId) {
  const b = el('button', 'ghost small', t('Red-team this'));
  b.type = 'button';
  b.addEventListener('click', () => void openRedTeam({ workspace, ...(conversationId ? { conversationId } : {}) }));
  return b;
}
