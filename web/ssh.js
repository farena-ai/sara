// Phase 73, rebuilt in 2.52.1 (docs/design/SSH_EASY.md): Settings → Abilities → Servers over SSH.
// One "Connect a server" form (address + user), then Sara looks at the server (a short checklist),
// then step 3: the server's ID card (host key) in plain words and the easiest way in (a cPanel
// token, the password once, or pasting her one line), with the other ways as small links. Every
// failure shows a plain-language diagnosis right under the button that caused it. A card per
// server with Test connection, Reconnect, Edit, Replace Sara's key, Clean up and Remove.
// Passwords and tokens go from their box to the server once and are never kept in this page.
import { serverText, t } from './naming.js';
import { emptyState } from './tidy.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

let state = { servers: [], warning: '' };
/** The server the Connect flow (step 2/3) is open for, and the path shown. */
let current = null;
let shownPath = '';
/** The name a "certificate is for another name" diagnosis offered (the "Use that name" button). */
let lastCertName = '';

const PATHS = ['cpanel', 'pw', 'paste', 'key'];

// ---------- the diagnosis box (title + fix + buttons + Details), under the button that caused it ----------
const ACTION_LABEL = {
  'edit-address': () => t('Edit address'),
  'find-port': () => t('Find the port'),
  'set-port': () => t('Set the port'),
  retry: () => t('Try again'),
  'trust-new': () => t('I reinstalled or moved it: trust the new one'),
  leave: () => t('Leave it stopped'),
  cpanel: () => t('Use a cPanel token'),
  paste: () => t('Add Sara’s key yourself'),
  password: () => t('Type the password once'),
  steps: () => t('Show the steps again'),
  check: () => t('Check now'),
  'edit-user': () => t('Edit user'),
  test: () => t('Test again'),
  'use-cert-name': () => t('Use that name'),
};

/** Shows a diagnosis (from the server) in `box`. `on` maps action names to handlers. */
function diagBox(box, d, on = {}) {
  box.replaceChildren();
  if (!d) return;
  if (d.code === 'CERT_NAME') lastCertName = d.params?.other ?? '';
  const ok = d.code === 'CONNECTED' || d.code === 'JAILED';
  const wrap = el('div', `ssh-diag ${ok ? 'ok' : d.code === 'HOSTKEY_CHANGED' ? 'bad' : 'warn'}`);
  wrap.append(el('strong', '', t(d.titleKey ?? d.title, d.params)));
  if (d.fixKey || d.fix) wrap.append(el('p', '', t(d.fixKey ?? d.fix, d.params)));
  const acts = (d.actions ?? []).filter((a) => ACTION_LABEL[a] && on[a]);
  if (acts.length) {
    const row = el('div', 'add-row');
    for (const a of acts) row.append(button(ACTION_LABEL[a](), 'ghost', () => on[a]()));
    wrap.append(row);
  }
  if (d.details) {
    const det = el('details', 'ssh-details');
    det.append(el('summary', '', t('Details')), el('pre', 'ssh-pre', d.details));
    wrap.append(det);
  }
  box.append(wrap);
  box.scrollIntoView?.({ block: 'nearest' });
}

function say(box, text) {
  box.replaceChildren();
  if (text) box.append(el('p', 'muted', text));
}

/** Runs a request for a button; a failure with a diagnosis shows it under the button. */
async function act(btn, box, fn, on = {}) {
  if (btn) btn.disabled = true;
  say(box, t('Working on it…'));
  try {
    return await fn();
  } catch (err) {
    if (err.data?.diagnosis) diagBox(box, err.data.diagnosis, on);
    else say(box, err.message);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}

function row(label, value, code) {
  const p = el('p', 'small ssh-row');
  p.append(el('span', 'muted', `${label} `));
  p.append(code ? el('code', '', value) : el('span', '', value));
  return p;
}

const day = (iso) => {
  try {
    return new Date(iso).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso?.slice(0, 10) ?? '';
  }
};

// ---------- the checklist (step 2, and Test connection) ----------
const PROBE_STEPS = [
  ['name', () => t('Find the name')],
  ['port', () => t('Find the SSH port')],
  ['hostkey', () => t('Read its ID card (host key)')],
  ['methods', () => t('See how it lets people in')],
  ['cpanel', () => t('Look for cPanel')],
  ['key', () => t('Make Sara’s own key')],
];
const TEST_STEPS = [
  ['name', () => t('Find the name')],
  ['port', () => t('The port answers SSH')],
  ['hostkey', () => t('Same ID card as before')],
  ['key', () => t('Sara’s key is accepted')],
  ['shell', () => t('A command runs')],
];
const FAIL_AT = { DNS: 'name', PORT_CLOSED: 'port', TIMEOUT: 'port', NOT_SSH: 'port', HOSTKEY_CHANGED: 'hostkey', PRIVATE_LOCAL: 'name', KEY_NOT_ACCEPTED: 'key', TWO_STEP: 'key', TOO_MANY: 'key', NO_SHELL: 'shell', UNKNOWN: 'key' };

/** steps: [[id, label]], marks: { id: { s: 'ok' | 'bad' | 'skip' | 'busy', note } }. */
function checklist(ul, steps, marks) {
  ul.replaceChildren(
    ...steps.map(([id, label]) => {
      const m = marks[id] ?? { s: 'skip' };
      const li = el('li', `ssh-step ${m.s}`);
      li.append(el('span', 'ssh-step-mark', m.s === 'ok' ? '✓' : m.s === 'bad' ? '!' : m.s === 'busy' ? '…' : '·'), el('span', 'ssh-step-text', label()));
      if (m.note) li.append(el('span', 'ssh-step-note muted', m.note));
      return li;
    }),
  );
}

function probeMarks(s) {
  const p = s.probe;
  if (!p) return {};
  const failed = p.code ? FAIL_AT[p.code] ?? 'port' : '';
  const marks = {};
  for (const [id] of PROBE_STEPS) {
    if (id === failed) {
      marks[id] = { s: 'bad' };
      break;
    }
    marks[id] = { s: 'ok' };
  }
  if (!p.code) {
    marks.port.note = t('SSH answers on port {port}.', { port: s.port });
    marks.methods.note = p.passwords === false ? t('Keys only (no passwords).') : p.passwords ? t('Passwords work too.') : t('It didn’t say.');
    marks.cpanel = p.cpanel?.found ? { s: 'ok', note: t('cPanel found.') } : { s: 'skip', note: t('No cPanel here.') };
  }
  return marks;
}

function testMarks(code) {
  const failed = FAIL_AT[code] ?? (code === 'CONNECTED' || code === 'JAILED' ? '' : 'key');
  const marks = {};
  for (const [id] of TEST_STEPS) {
    if (id === failed) {
      marks[id] = { s: 'bad' };
      break;
    }
    marks[id] = { s: 'ok' };
  }
  return marks;
}

// ---------- the cards ----------
function badgeOf(s) {
  if (s.hostKeyChanged) return ['bad', t('ID card changed')];
  if (s.ready) return ['ok', t('Connected')];
  if (s.probe?.code) return ['bad', t('Needs a look')];
  return ['wait', t('Not connected yet')];
}

const statusOf = (id) => document.querySelector(`.ssh-card[data-id="${id}"] .ssh-status`) ?? $('#ssh-status');

function card(s) {
  const c = el('article', 'ssh-card');
  c.dataset.id = s.id;
  const head = el('div', 'ssh-card-head');
  const [cls, label] = badgeOf(s);
  head.append(el('strong', '', s.name), el('span', `ssh-badge ${cls}`, label));
  c.append(head);
  c.append(row(t('Address'), `${s.user}@${s.host}:${s.port}`, true));
  if (s.keyPath) c.append(row(t('Key'), s.keySource === 'imported' ? t('the key you gave her') : t('Sara’s own (made {date})', { date: day(s.keyCreatedAt) }), false));
  c.append(row(t('Password'), s.passwordSaved ? t('saved, encrypted (you asked)') : t('not kept'), false));
  if (s.lastCheck) c.append(row(t('Last test'), `${s.lastCheck.ok ? t('worked') : t('didn’t work')} · ${day(s.lastCheck.at)}`, false));
  const actions = el('div', 'add-row ssh-actions');
  const status = el('div', 'ssh-status small');
  status.setAttribute('role', 'status');
  if (s.ready && !s.hostKeyChanged) actions.append(button(t('Test connection'), '', (b) => testServer(s, b, status)));
  if (!s.ready || s.hostKeyChanged || ['KEY_NOT_ACCEPTED', 'PASSWORD_OFF'].includes(s.lastCheck?.code)) actions.append(button(s.hostKeyChanged ? t('See the new ID card') : t('Reconnect'), s.ready ? 'ghost' : '', () => openFlow(s)));
  const more = el('details', 'ssh-more');
  more.append(el('summary', 'ghost', t('More')));
  const menu = el('div', 'ssh-menu');
  menu.append(button(t('Edit'), 'ghost', () => openEdit(s, c)));
  if (s.ready && s.keySource === 'made') {
    menu.append(
      button(t('Replace Sara’s key'), 'ghost', async (b) => {
        if (!confirm(t('Make a new key for {name}, put it there with the current one, check it, then remove the old line?', { name: s.name }))) return;
        const r = await act(b, status, () => api(`/ssh/servers/${s.id}/replace-key`, { method: 'POST', body: {} }));
        if (!r) return;
        render(r);
        if (r.reconnect) {
          openFlow(r.server);
          if (r.diagnosis) diagBox($('#ssh-done'), r.diagnosis);
        } else say(statusOf(s.id), t('Done: the new key works and the old line is gone.'));
      }),
    );
  }
  if (s.ready && s.lastCheck?.extraLines > 0) {
    menu.append(
      button(t('Clean up old Sara keys'), 'ghost', async (b) => {
        const l = await act(b, status, () => api(`/ssh/servers/${s.id}/cleanup`));
        if (!l) return;
        const old = l.lines.filter((x) => !x.current).map((x) => x.comment);
        if (!old.length) return say(status, t('No old Sara keys there.'));
        if (!confirm(t('Remove these old Sara key lines from {name}? {list}. Other lines are not touched.', { name: s.name, list: old.join(', ') }))) return say(status, '');
        const r = await act(b, status, () => api(`/ssh/servers/${s.id}/cleanup`, { method: 'POST', body: {} }));
        if (!r) return;
        render(r);
        say(statusOf(s.id), t('Removed {n} old line(s).', { n: r.removed }));
      }),
    );
  }
  if (s.passwordSaved) {
    menu.append(
      button(t('Forget the password'), 'ghost', async (b) => {
        const r = await act(b, status, () => api(`/ssh/servers/${s.id}/password`, { method: 'DELETE' }));
        if (!r) return;
        render(r);
        say(statusOf(s.id), t('Forgot the password for {name}.', { name: s.name }));
      }),
    );
  }
  if (s.keyPath) {
    menu.append(
      button(t('Remove Sara’s key'), 'ghost danger-text', async (b) => {
        const ask = s.keySource === 'imported' ? t('Delete her copy of the key you gave her for {name}? It stays on the server.', { name: s.name }) : t('Remove Sara’s key from {name}? She signs in one last time to remove exactly her line, then deletes the key here.', { name: s.name });
        if (!confirm(ask)) return;
        const r = await act(b, status, () => api(`/ssh/servers/${s.id}/revoke`, { method: 'POST', body: {} }));
        if (!r) return;
        render(r);
        say(statusOf(s.id), r.message);
      }),
    );
  }
  menu.append(
    button(t('Remove server'), 'ghost danger-text', async (b) => {
      const made = s.keyPath && s.keySource === 'made' && s.keyInstalledAt;
      if (!confirm(made ? t('Remove {name}? She first removes her key from the server, then forgets the server, its ID card and any saved password.', { name: s.name }) : t('Remove {name}? She forgets the server, its ID card, her key and any saved password.', { name: s.name }))) return;
      const r = await act(b, status, () => api(`/ssh/servers/${s.id}`, { method: 'DELETE', body: { revoke: Boolean(made) } }));
      if (!r) return;
      if (current?.id === s.id) closeFlow();
      render(r);
      $('#ssh-status').textContent = r.message || t('Removed {name}.', { name: s.name });
    }),
  );
  more.append(menu);
  actions.append(more);
  c.append(actions, status);
  return c;
}

async function testServer(s, b, status) {
  const r = await act(b, status, () => api(`/ssh/servers/${s.id}/test`, { method: 'POST', body: {} }));
  if (!r) return;
  render(r);
  const st = statusOf(s.id);
  st.replaceChildren();
  const ul = el('ul', 'ssh-checklist');
  checklist(ul, TEST_STEPS, testMarks(r.code));
  const box = el('div');
  st.append(ul, box);
  const again = () => testServer(r.server, null, statusOf(s.id));
  diagBox(box, r.diagnosis, { test: again, retry: again, check: again, steps: () => openFlow(r.server, 'paste'), 'edit-user': () => openEdit(r.server), 'trust-new': () => openFlow(r.server) });
}

// ---------- edit (name, user, port) without removing ----------
let editing = null;
function openEdit(s, cardEl) {
  editing = s;
  const box = $('#ssh-edit');
  $('#ssh-edit-name').value = s.name;
  $('#ssh-edit-user').value = s.user;
  $('#ssh-edit-port').value = String(s.port);
  say($('#ssh-edit-status'), '');
  (cardEl ?? document.querySelector(`.ssh-card[data-id="${s.id}"]`) ?? $('#ssh-list')).append(box);
  box.hidden = false;
  box.scrollIntoView?.({ block: 'nearest' });
}
function closeEdit() {
  editing = null;
  $('#ssh-edit').hidden = true;
  $('#ssh-list').after($('#ssh-edit'));
}

// ---------- render ----------
function render(v) {
  state = { ...state, ...v };
  const off = $('#ssh-off');
  off.hidden = v.available !== false && !v.privateLocal;
  off.textContent = v.available === false ? t('The ssh program isn’t installed on the Sara server (it comes with OpenSSH: openssh-client on Linux, built into macOS and Windows 10/11).') : v.privateLocal ? t('Private local mode is on: she can only reach servers on this computer.') : '';
  if (editing) closeEdit();
  $('#ssh-list-head').hidden = !state.servers.length;
  $('#ssh-list').replaceChildren(...(state.servers.length ? state.servers.map(card) : [emptyState({ icon: 'server', text: t('No servers yet.'), why: t('Connect one above; every command she runs there asks you first.') })]));
  if (current) {
    const s = state.servers.find((x) => x.id === current.id);
    if (s) fillFlow(s);
    else closeFlow();
  }
}

// ---------- step 2 and 3: the Connect flow for one server ----------
function show(id, on) {
  $(id).hidden = !on;
}

function recommendedPath(s) {
  const p = s.probe;
  if (!p) return 'paste';
  if (p.recommended === 'cpanel') return 'cpanel';
  if (p.recommended === 'password') return 'pw';
  return 'paste';
}

// The fix-it screen's words (the same templates as src/ssh-easy.ts DIAG, for a probe saved earlier).
const PROBE_DIAG = {
  DNS: ['I can’t find “{host}”.', 'Check the spelling. If it’s your website’s name, try the server name from your host’s welcome email.', ['edit-address']],
  PORT_CLOSED: ['Nothing answers SSH on {host} (ports tried: {ports}).', 'Shared hosts often use another port (2222, 21098, 18765, 65002). Or SSH may be switched off for your account: in cPanel look under Security → SSH Access, or ask your host.', ['find-port', 'set-port']],
  TIMEOUT: ['{host} didn’t answer (ports tried: {ports}).', 'The address may be wrong, a firewall may block SSH, or your host may have blocked this computer after failed sign-ins (cPanel’s cPHulk does this). Wait 15 minutes, or ask your host to unblock this computer’s address.', ['retry', 'set-port']],
  NOT_SSH: ['Port {port} answers, but it isn’t SSH (it looks like a web server).', 'Let Sara look for the SSH port, or set it yourself.', ['find-port', 'set-port']],
  PRIVATE_LOCAL: ['Private local mode is on.', 'While “Nothing leaves this computer” is on, Sara only connects to this computer.', []],
};

function fillFlow(s) {
  current = s;
  $('#ssh-flow').hidden = false;
  $('#ssh-flow-head').textContent = t('Connect {name}', { name: s.name });
  const p = s.probe;
  const notFound = Boolean(p?.code) && p.code !== 'HOSTKEY_CHANGED';
  checklist($('#ssh-checklist'), PROBE_STEPS, p ? probeMarks(s) : {});
  show('#ssh-checklist', Boolean(p));
  // Not found: the fix-it screen.
  show('#ssh-notfound', notFound);
  if (notFound) {
    const [title, fix, actions] = PROBE_DIAG[p.code] ?? PROBE_DIAG.TIMEOUT;
    diagBox($('#ssh-notfound-diag'), { code: p.code, titleKey: title, fixKey: fix, params: p.params ?? {}, actions }, {
      'find-port': () => reprobe(s, true),
      'set-port': () => openEdit(s),
      retry: () => reprobe(s, false),
      'edit-address': () => {
        closeFlow();
        $('#ssh-host').value = s.host;
        $('#ssh-user').value = s.user;
        $('#ssh-host').focus?.();
      },
    });
  }
  // The ID card (host key).
  const needTrust = Boolean(s.pendingFingerprint) && !notFound;
  show('#ssh-hk', needTrust);
  if (needTrust) {
    $('#ssh-hk-fp').textContent = s.pendingFingerprint;
    $('#ssh-hk').classList.toggle('bad', Boolean(s.hostKeyChanged));
    $('#ssh-trust').classList.toggle('ghost', Boolean(s.hostKeyChanged));
    show('#ssh-leave', Boolean(s.hostKeyChanged));
    if (s.hostKeyChanged) {
      $('#ssh-hk-title').textContent = t('Stop: {host} is showing a different ID card.', { host: s.host });
      $('#ssh-hk-text').textContent = t('It was {old} and now it is {new}. This happens when a server is reinstalled or moved to a new machine, and also when someone is in between you and it. Sara stopped and didn’t sign in.', { old: s.fingerprint, new: s.pendingFingerprint });
      $('#ssh-trust').textContent = t('I reinstalled or moved it: trust the new one');
    } else {
      $('#ssh-hk-title').textContent = t('Is this really your server?');
      $('#ssh-hk-text').textContent = t('Every server has an ID card (its host key). Sara will remember this one and refuse to talk to the server if it ever changes, so nobody can pretend to be it later.');
      $('#ssh-trust').textContent = t('Yes, remember it and continue');
    }
  }
  // The ways in (after the ID card is accepted).
  const trusted = Boolean(s.fingerprint) && !s.pendingFingerprint && !notFound;
  show('#ssh-paths', trusted && !s.ready);
  $('#ssh-step-line').textContent = !p && !s.fingerprint ? t('Step 2 of 3: Sara is looking at the server…') : notFound ? t('Step 2 of 3: something needs fixing first.') : s.ready ? t('Done.') : needTrust ? t('Step 3 of 3: say yes to the ID card, then pick the way in.') : t('Step 3 of 3: pick the way in.');
  if (trusted && !s.ready) showPath(s, shownPath || recommendedPath(s));
  // Connected: the result sits right under the checklist (the buttons that led here are gone).
  if (s.ready && !s.hostKeyChanged && !$('#ssh-done').childElementCount) {
    const jailed = /jailshell/.test(s.lastCheck?.shell ?? '');
    diagBox($('#ssh-done'), jailed ? { code: 'JAILED', titleKey: 'Connected, with a limited shell (jailshell).', fixKey: 'Most file and website commands work; system commands (sudo, services) don’t.', params: {}, actions: [] } : { code: 'CONNECTED', titleKey: 'Connected. Sara can work on {name}.', params: { name: s.name }, actions: [] });
  }
}

function showPath(s, which) {
  const p = s.probe;
  const pwOk = !p || p.passwords !== false;
  if (which === 'pw' && !pwOk) which = recommendedPath(s) === 'pw' ? 'paste' : recommendedPath(s);
  shownPath = which;
  for (const k of PATHS) show(`#ssh-path-${k}`, k === which);
  // "Other ways": every path but this one (the password only when the server takes passwords).
  show('#ssh-other-cpanel', which !== 'cpanel');
  show('#ssh-other-pw', which !== 'pw' && pwOk);
  show('#ssh-other-paste', which !== 'paste');
  show('#ssh-other-key', which !== 'key');
  if (which === 'cpanel') $('#ssh-open-cpanel').href = `https://${s.cpanelHost ?? s.host}:${p?.cpanel?.port ?? 2083}/`;
  if (which === 'paste') {
    if (!$('#ssh-paste-host').dataset.touched) $('#ssh-paste-host').value = p?.cpanel?.found ? 'cpanel' : s.port === 18765 ? 'siteground' : s.port === 65002 ? 'hostinger' : 'console';
    fillPaste(s);
  }
  if (which === 'pw' && s.askedToSavePassword && !$('#ssh-save-pw').dataset.touched) {
    $('#ssh-save-pw').checked = true;
    showWarn();
  }
}

const PASTE_STEPS = {
  cpanel: () => [t('In cPanel: Security → SSH Access → Manage SSH Keys → Import Key.'), t('Name: sara. Leave the private key box empty, paste the key into Public Key, press Import.'), t('Go back, find sara under Public Keys and press Manage → Authorize. (Authorize is the step everybody misses: without it the key does nothing.)')],
  siteground: () => [t('In Site Tools: Devs → SSH Keys Manager → Import.'), t('Paste the key and press Import. SiteGround uses SSH port 18765.')],
  hostinger: () => [t('In hPanel: Advanced → SSH Access → SSH keys → Add SSH key.'), t('Paste the key and save. Hostinger uses SSH port 65002.')],
  console: () => [t('Open your provider’s web console for the server (DigitalOcean, Hetzner, Linode, AWS Lightsail…).'), t('Paste the one line below and press Enter.')],
  home: () => [t('Open a terminal on that computer (Raspberry Pi, Linux box, Mac), signed in as the user above.'), t('Paste the one line below and press Enter.')],
};
function fillPaste(s) {
  const kind = $('#ssh-paste-host').value;
  $('#ssh-paste-steps').replaceChildren(...(PASTE_STEPS[kind] ?? PASTE_STEPS.console)().map((x) => el('li', '', x)));
  $('#ssh-pubkey').textContent = s.publicKey ?? '';
  $('#ssh-oneline').textContent = s.pasteCommand ?? '';
  const panel = kind === 'cpanel' || kind === 'siteground' || kind === 'hostinger';
  // A panel takes the key; a terminal or web console takes the one line.
  show('#ssh-paste-what', panel);
  show('#ssh-pubkey', panel);
  show('#ssh-copy-key', panel);
  show('#ssh-oneline-what', !panel);
  show('#ssh-oneline', !panel);
  show('#ssh-copy-line', !panel);
}

async function reprobe(s, findPort) {
  const r = await act(null, $('#ssh-notfound').hidden ? $('#ssh-done') : $('#ssh-notfound-diag'), () => api(`/ssh/servers/${s.id}/probe`, { method: 'POST', body: { findPort } }));
  if (r) {
    say($('#ssh-done'), '');
    render(r);
  }
}

function openFlow(s, path = '') {
  $('#ssh-announce').hidden = true;
  clearSecrets();
  shownPath = path;
  delete $('#ssh-paste-host').dataset.touched;
  for (const id of ['#ssh-hk-status', '#ssh-cpanel-status', '#ssh-pw-status', '#ssh-check-status', '#ssh-key-status', '#ssh-done']) say($(id), '');
  fillFlow(s);
  // A server from before 2.52.1: look at it first.
  if (!s.probe && !s.ready) void reprobe(s, false);
  $('#ssh-flow').scrollIntoView?.({ block: 'start' });
}

function clearSecrets() {
  $('#ssh-pw').value = '';
  $('#ssh-token').value = '';
  $('#ssh-key-text').value = '';
  $('#ssh-key-path').value = '';
  $('#ssh-save-pw').checked = false;
  delete $('#ssh-save-pw').dataset.touched;
  $('#ssh-confirm-risk').checked = false;
  showWarn();
}

function closeFlow() {
  current = null;
  shownPath = '';
  clearSecrets();
  $('#ssh-flow').hidden = true;
}

function showWarn() {
  const on = $('#ssh-save-pw').checked;
  $('#ssh-save-warn').hidden = !on;
  $('#ssh-confirm-row').hidden = !on;
  $('#ssh-save-warn').textContent = on ? t(state.warning) : '';
  if (!on) $('#ssh-confirm-risk').checked = false;
}

/** After her key went on the server: the result under the button. */
function connected(r, box) {
  if (r.test?.ok) box = $('#ssh-done');
  render(r);
  const test = r.test ?? r;
  if (test?.diagnosis) diagBox(box, test.diagnosis, { test: () => testServer(r.server, null, statusOf(r.server.id)) });
  if (test?.ok && r.tokenRevoked) box.append(el('p', 'muted', t('Sara deleted the token for you.')));
  else if (test?.ok && r.tokenRevoked === false) box.append(el('p', 'muted', t('Delete the token in cPanel → Manage API Tokens: Sara couldn’t find one called sara.')));
}

// ---------- the address the owner typed, shown back ----------
function parseShown() {
  const raw = $('#ssh-host').value.trim();
  if (!raw) return say($('#ssh-parsed'), '');
  let s = raw;
  let user = '';
  let port = '';
  const cmd = /^ssh\s+(.*)$/i.exec(s);
  if (cmd) {
    const p = /-p\s*(\d+)/.exec(cmd[1]);
    if (p) port = p[1];
    s = cmd[1].replace(/-p\s*\d+/, '').trim().split(/\s+/).find((w) => !w.startsWith('-')) ?? '';
  }
  const link = /^(https?|sftp|ssh):\/\/(?:([^@/:\s]+)@)?([^/:?#\s]+)(?::(\d+))?/i.exec(s);
  let cpanel = false;
  if (link) {
    user = link[2] ?? '';
    s = link[3];
    cpanel = /^https?/i.test(link[1]);
    if (!cpanel && link[4]) port = link[4];
  } else {
    const at = s.lastIndexOf('@');
    if (at > 0) {
      user = s.slice(0, at);
      s = s.slice(at + 1);
    }
    const hp = /^([^:[\]]+):(\d+)$/.exec(s);
    if (hp) {
      s = hp[1];
      port = hp[2];
    }
  }
  if (user && !$('#ssh-user').value.trim()) $('#ssh-user').value = user;
  if (port) {
    $('#ssh-port').value = port;
    $('#ssh-port-row').hidden = false;
    $('#ssh-port-auto').hidden = true;
    $('#ssh-port-show').hidden = true;
  }
  const u = $('#ssh-user').value.trim() || '?';
  let line = port ? t('Server {host}, user {user}, port {port}.', { host: s, user: u, port }) : t('Server {host}, user {user}, port: I’ll find it.', { host: s, user: u });
  if (cpanel) line += ` ${t('That’s a cPanel link: I’ll check for cPanel.')}`;
  $('#ssh-parsed').textContent = line;
  $('#ssh-user').placeholder = cpanel ? t('your cPanel user name (top right in cPanel)') : t('e.g. your cPanel user name');
}

/** The chat's deep link (/#view=settings:ab-ssh&server=<id>): open that server's step 3. */
let pendingFocus = '';
export function focusSshServer(id) {
  const s = state.servers.find((x) => x.id === id);
  if (!s) {
    pendingFocus = id;
    return;
  }
  openFlow(s);
}

export async function loadSsh() {
  try {
    render(await api('/ssh'));
    if (pendingFocus) {
      const id = pendingFocus;
      pendingFocus = '';
      focusSshServer(id);
    }
  } catch (err) {
    $('#ssh-status').textContent = err.status === 403 ? '' : err.message;
  }
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = t('Copied');
    setTimeout(() => {
      btn.textContent = was;
    }, 1500);
  } catch {
    /* the line stays visible to copy by hand */
  }
}

export function initSsh() {
  $('#ssh-host').addEventListener('input', parseShown);
  $('#ssh-user').addEventListener('input', parseShown);
  $('#ssh-port-show').addEventListener('click', () => {
    $('#ssh-port-row').hidden = false;
    $('#ssh-port-auto').hidden = true;
    $('#ssh-port-show').hidden = true;
    $('#ssh-port').focus?.();
  });
  $('#ssh-connect-go').addEventListener('click', async () => {
    const box = $('#ssh-connect-status');
    const body = { address: $('#ssh-host').value.trim(), user: $('#ssh-user').value.trim(), ...($('#ssh-port-row').hidden || !$('#ssh-port').value ? {} : { port: Number($('#ssh-port').value) }) };
    const r = await act($('#ssh-connect-go'), box, () => {
      say(box, t('Looking at the server… (this takes a few seconds)'));
      return api('/ssh/servers', { method: 'POST', body });
    });
    if (!r) return;
    say(box, '');
    render(r);
    for (const id of ['#ssh-host', '#ssh-user', '#ssh-port']) $(id).value = '';
    $('#ssh-parsed').textContent = '';
    $('#ssh-port-row').hidden = true;
    $('#ssh-port-auto').hidden = false;
    $('#ssh-port-show').hidden = false;
    openFlow(r.server);
  });
  $('#ssh-flow-close').addEventListener('click', closeFlow);
  $('#ssh-trust').addEventListener('click', async () => {
    if (!current?.pendingFingerprint) return;
    if (current.hostKeyChanged && !confirm(t('Trust the NEW ID card of {name}? Do this only if you know why it changed (a reinstall, a new server at that address).', { name: current.name }))) return;
    const r = await act($('#ssh-trust'), $('#ssh-hk-status'), () => api(`/ssh/servers/${current.id}/trust`, { method: 'POST', body: { fingerprint: current.pendingFingerprint } }));
    if (!r) return;
    say($('#ssh-hk-status'), '');
    render(r);
    $('#ssh-paths').scrollIntoView?.({ block: 'nearest' });
  });
  $('#ssh-leave').addEventListener('click', closeFlow);
  for (const [id, path] of [['#ssh-other-cpanel', 'cpanel'], ['#ssh-other-pw', 'pw'], ['#ssh-other-paste', 'paste'], ['#ssh-other-key', 'key']]) {
    $(id).addEventListener('click', () => current && showPath(current, path));
  }
  $('#ssh-paste-host').addEventListener('change', () => {
    $('#ssh-paste-host').dataset.touched = '1';
    if (current) fillPaste(current);
  });
  $('#ssh-copy-key').addEventListener('click', () => copy($('#ssh-pubkey').textContent, $('#ssh-copy-key')));
  $('#ssh-copy-line').addEventListener('click', () => copy($('#ssh-oneline').textContent, $('#ssh-copy-line')));
  const pathOn = () => ({ paste: () => current && showPath(current, 'paste'), cpanel: () => current && showPath(current, 'cpanel'), password: () => current && showPath(current, 'pw'), 'edit-user': () => current && openEdit(current), steps: () => current && showPath(current, 'paste'), check: () => $('#ssh-check-go').click() });
  // (a) The cPanel token: sent once, never kept here.
  const sendToken = async (apiHost) => {
    if (!current) return;
    const tok = $('#ssh-token');
    const box = $('#ssh-cpanel-status');
    const host = apiHost ?? current.cpanelHost;
    const on = { ...pathOn(), 'use-cert-name': () => sendToken(lastCertName) };
    const r = await act($('#ssh-cpanel-go'), box, () => api(`/ssh/servers/${current.id}/cpanel`, { method: 'POST', body: { token: tok.value, revokeToken: $('#ssh-revoke-token').checked, ...(host ? { apiHost: host } : {}) } }), on);
    if (r) {
      tok.value = '';
      connected(r, box);
    }
  };
  $('#ssh-cpanel-go').addEventListener('click', () => void sendToken());
  // (b) The password once.
  $('#ssh-save-pw').addEventListener('change', () => {
    $('#ssh-save-pw').dataset.touched = '1';
    showWarn();
  });
  $('#ssh-login').addEventListener('click', async () => {
    if (!current) return;
    let box = $('#ssh-pw-status');
    const save = $('#ssh-save-pw').checked;
    if (save && !$('#ssh-confirm-risk').checked) return say(box, t('Tick “I understand the risk” to keep the password, or untick Save.'));
    if (save && !confirm(t('Keep the password for {name}, encrypted with her other secrets? You can forget it any time here.', { name: current.name }))) return;
    const pw = $('#ssh-pw');
    const r = await act($('#ssh-login'), box, () => api(`/ssh/servers/${current.id}/login`, { method: 'POST', body: { password: pw.value, savePassword: save, confirmRisk: save && $('#ssh-confirm-risk').checked } }), { ...pathOn(), retry: () => pw.focus?.() });
    pw.value = '';
    if (!r) return;
    say(box, '');
    render(r);
    box = $('#ssh-done');
    box.append(el('p', 'muted', r.server.passwordSaved ? t('Sara installed her own key. The password is saved encrypted because you asked.') : t('Sara installed her own key and did not keep the password.')));
  });
  // (c) Copy and paste, then check.
  $('#ssh-check-go').addEventListener('click', async () => {
    if (!current) return;
    const box = $('#ssh-check-status');
    const r = await act($('#ssh-check-go'), box, () => api(`/ssh/servers/${current.id}/check`, { method: 'POST', body: {} }), pathOn());
    if (!r) return;
    render(r);
    diagBox(r.ok ? $('#ssh-done') : box, r.diagnosis, { ...pathOn(), check: () => $('#ssh-check-go').click(), test: () => $('#ssh-check-go').click() });
  });
  // Advanced: a key the owner already has.
  $('#ssh-key-go').addEventListener('click', async () => {
    if (!current) return;
    const box = $('#ssh-key-status');
    const r = await act($('#ssh-key-go'), box, () => api(`/ssh/servers/${current.id}/key`, { method: 'POST', body: { privateKey: $('#ssh-key-text').value, keyPath: $('#ssh-key-path').value.trim() } }));
    $('#ssh-key-text').value = '';
    if (!r) return;
    render(r);
    say(box, t('She signed in to {name} with the key. Her copy: {path}', { name: r.server.name, path: r.server.keyPath }));
  });
  // Edit.
  $('#ssh-edit-cancel').addEventListener('click', closeEdit);
  $('#ssh-edit-save').addEventListener('click', async () => {
    if (!editing) return;
    const id = editing.id;
    const r = await act($('#ssh-edit-save'), $('#ssh-edit-status'), () => api(`/ssh/servers/${id}`, { method: 'PATCH', body: { name: $('#ssh-edit-name').value.trim(), user: $('#ssh-edit-user').value.trim(), port: Number($('#ssh-edit-port').value) || undefined } }));
    if (!r) return;
    closeEdit();
    render(r);
    if (!r.server.ready || r.server.hostKeyChanged) openFlow(r.server);
    else say(statusOf(id), t('Saved.'));
  });
  // Nothing typed here outlives the window.
  $('#settings').addEventListener('close', () => {
    clearSecrets();
    $('#ssh-announce').hidden = true;
  });
}
