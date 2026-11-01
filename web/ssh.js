// Phase 73: Settings → Abilities → Servers over SSH. A card per server (address, host key
// fingerprint, her key file, password saved or not) with Sign in, Test, Forget password, Revoke key
// and Remove; an Add form; the sign-in box (approve the host key, then a password box or a key).
// The password goes from the password box to the server once and is never kept in this page.
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
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

let state = { servers: [], warning: '' };
/** The server the sign-in box is open for. */
let current = null;

function status(text) {
  $('#ssh-status').textContent = text ?? '';
}
function busy(btn, on) {
  if (btn) btn.disabled = on;
  if (on) status(t('Working on it…'));
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

function card(s) {
  const c = el('article', 'ssh-card');
  const head = el('div', 'ssh-card-head');
  head.append(el('strong', '', s.name), el('span', `ssh-badge ${s.hostKeyChanged ? 'bad' : s.ready ? 'ok' : 'wait'}`, s.hostKeyChanged ? t('Host key changed') : s.ready ? t('Ready') : t('Not signed in yet')));
  c.append(head);
  c.append(row(t('Address'), `${s.user}@${s.host}:${s.port}`, true));
  c.append(row(t('Host key'), s.fingerprint ?? t('not trusted yet'), Boolean(s.fingerprint)));
  if (s.hostKeyChanged) {
    const w = el('p', 'ssh-warn small', t('The server now shows a different host key ({fp}). She stopped and won’t sign in. If you changed or reinstalled the server, check the new fingerprint and trust it; otherwise someone may be in between.', { fp: s.pendingFingerprint }));
    c.append(w);
  }
  c.append(row(t('Her key'), s.keyPath ? `${s.keyPath}${s.keySource === 'imported' ? ` (${t('the key you gave her')})` : ''}` : t('none yet'), Boolean(s.keyPath)));
  c.append(row(t('Password saved'), s.passwordSaved ? t('Yes, encrypted') : t('No'), false));
  if (s.lastError && !s.hostKeyChanged) c.append(el('p', 'muted small', t('Last problem: {text}', { text: s.lastError })));
  const actions = el('div', 'add-row ssh-actions');
  if (!s.ready || s.hostKeyChanged) actions.append(button(s.hostKeyChanged ? t('Check the new host key') : t('Sign in'), '', () => openSignin(s)));
  if (s.ready && !s.hostKeyChanged) {
    actions.append(
      button(t('Test'), 'ghost', async (b) => {
        busy(b, true);
        try {
          const r = await api(`/ssh/servers/${s.id}/test`, { method: 'POST', body: {} });
          render(r);
          status(r.ok ? t('Signed in to {name}: it works.', { name: s.name }) : t('Couldn’t sign in to {name}: {text}', { name: s.name, text: r.message }));
        } catch (err) {
          status(err.message);
        } finally {
          busy(b, false);
        }
      }),
    );
    if (!s.keyPath) actions.append(button(t('Sign in'), 'ghost', () => openSignin(s)));
  }
  if (s.passwordSaved) {
    actions.append(
      button(t('Forget the password'), 'ghost', async (b) => {
        busy(b, true);
        try {
          render(await api(`/ssh/servers/${s.id}/password`, { method: 'DELETE' }));
          status(t('Forgot the password for {name}.', { name: s.name }));
        } catch (err) {
          status(err.message);
        } finally {
          busy(b, false);
        }
      }),
    );
  }
  if (s.keyPath) {
    actions.append(
      button(t('Revoke her key'), 'ghost danger-text', async (b) => {
        const ask = s.keySource === 'imported' ? t('Delete her copy of the key you gave her for {name}? It stays on the server.', { name: s.name }) : t('Revoke her key for {name}? She signs in one last time to remove exactly her line from ~/.ssh/authorized_keys there, then deletes the key here.', { name: s.name });
        if (!confirm(ask)) return;
        busy(b, true);
        try {
          const r = await api(`/ssh/servers/${s.id}/revoke`, { method: 'POST', body: {} });
          render(r);
          status(r.message);
        } catch (err) {
          status(err.message);
        } finally {
          busy(b, false);
        }
      }),
    );
  }
  actions.append(
    button(t('Remove'), 'ghost danger-text', async (b) => {
      const made = s.keyPath && s.keySource === 'made';
      if (!confirm(made ? t('Remove {name}? She first removes her key from the server, then forgets the server, its host key and any saved password.', { name: s.name }) : t('Remove {name}? She forgets the server, its host key, her key and any saved password.', { name: s.name }))) return;
      busy(b, true);
      try {
        const r = await api(`/ssh/servers/${s.id}`, { method: 'DELETE', body: { revoke: Boolean(made) } });
        if (current?.id === s.id) closeSignin();
        render(r);
        status(r.message || t('Removed {name}.', { name: s.name }));
      } catch (err) {
        status(err.message);
      } finally {
        busy(b, false);
      }
    }),
  );
  c.append(actions);
  return c;
}

function render(v) {
  state = { ...state, ...v };
  const off = $('#ssh-off');
  off.hidden = v.available !== false && !v.privateLocal;
  off.textContent = v.available === false ? t('The ssh program isn’t installed on the Sara server (it comes with OpenSSH: openssh-client on Linux, built into macOS and Windows 10/11).') : v.privateLocal ? t('Private local mode is on: she can only reach servers on this computer.') : '';
  $('#ssh-list').replaceChildren(...(state.servers.length ? state.servers.map(card) : [emptyState({ icon: 'server', text: t('No servers yet.'), why: t('Add one below; every command she runs there asks you first.'), howto: true })]));
  if (current) {
    const s = state.servers.find((x) => x.id === current.id);
    if (s) fillSignin(s);
  }
}

function fillSignin(s) {
  current = s;
  $('#ssh-signin').hidden = false;
  $('#ssh-signin-head').textContent = t('Sign in to {name}', { name: s.name });
  const needTrust = Boolean(s.pendingFingerprint);
  $('#ssh-fp-box').hidden = !needTrust;
  if (needTrust) $('#ssh-fp-line').textContent = s.hostKeyChanged ? t('The host key CHANGED. New fingerprint: {fp} (you trusted {old} before).', { fp: s.pendingFingerprint, old: s.fingerprint }) : t('Host key fingerprint of {host}: {fp}', { host: s.host, fp: s.pendingFingerprint });
  const trusted = Boolean(s.fingerprint) && !needTrust;
  $('#ssh-pw-box').hidden = !trusted || s.auth === 'key' || (s.ready && Boolean(s.keyPath));
  $('#ssh-key-box').hidden = !trusted || s.auth !== 'key' || (s.ready && Boolean(s.keyPath));
  if (!s.fingerprint && !needTrust) $('#ssh-fp-box').hidden = true;
  if (s.askedToSavePassword && !$('#ssh-pw-box').hidden && !$('#ssh-save-pw').dataset.touched) {
    $('#ssh-save-pw').checked = true;
    showWarn();
  }
}

function openSignin(s) {
  $('#ssh-announce').hidden = true;
  $('#ssh-pw').value = '';
  $('#ssh-save-pw').checked = false;
  delete $('#ssh-save-pw').dataset.touched;
  $('#ssh-confirm-risk').checked = false;
  $('#ssh-key-text').value = '';
  $('#ssh-key-path').value = '';
  showWarn();
  fillSignin(s);
  $('#ssh-signin').scrollIntoView?.({ block: 'nearest' });
}

function closeSignin() {
  current = null;
  $('#ssh-pw').value = '';
  $('#ssh-key-text').value = '';
  $('#ssh-signin').hidden = true;
}

function showWarn() {
  const on = $('#ssh-save-pw').checked;
  $('#ssh-save-warn').hidden = !on;
  $('#ssh-confirm-row').hidden = !on;
  $('#ssh-save-warn').textContent = on ? t(state.warning) : '';
  if (!on) $('#ssh-confirm-risk').checked = false;
}

export async function loadSsh() {
  try {
    render(await api('/ssh'));
  } catch (err) {
    status(err.status === 403 ? '' : err.message);
  }
}

export function initSsh() {
  $('#ssh-add-go').addEventListener('click', async () => {
    const b = $('#ssh-add-go');
    busy(b, true);
    try {
      const r = await api('/ssh/servers', { method: 'POST', body: { name: $('#ssh-name').value.trim(), host: $('#ssh-host').value.trim(), port: Number($('#ssh-port').value) || 22, user: $('#ssh-user').value.trim(), auth: $('#ssh-auth-key').checked ? 'key' : 'password' } });
      render(r);
      for (const id of ['#ssh-name', '#ssh-host', '#ssh-user']) $(id).value = '';
      $('#ssh-port').value = '22';
      openSignin(r.server);
      status(r.server.pendingFingerprint ? t('Check the fingerprint below before trusting it.') : r.server.lastError ?? '');
    } catch (err) {
      status(err.message);
    } finally {
      busy(b, false);
    }
  });
  $('#ssh-trust').addEventListener('click', async () => {
    if (!current?.pendingFingerprint) return;
    if (current.hostKeyChanged && !confirm(t('Trust the NEW host key of {name}? Do this only if you know why it changed (a reinstall, a new server at that address).', { name: current.name }))) return;
    const b = $('#ssh-trust');
    busy(b, true);
    try {
      render(await api(`/ssh/servers/${current.id}/trust`, { method: 'POST', body: { fingerprint: current.pendingFingerprint } }));
      status(t('Trusted. She will refuse this server if its host key ever changes.'));
    } catch (err) {
      status(err.message);
    } finally {
      busy(b, false);
    }
  });
  $('#ssh-rescan').addEventListener('click', async () => {
    if (!current) return;
    const b = $('#ssh-rescan');
    busy(b, true);
    try {
      render(await api(`/ssh/servers/${current.id}/scan`, { method: 'POST', body: {} }));
      status('');
    } catch (err) {
      status(err.message);
    } finally {
      busy(b, false);
    }
  });
  $('#ssh-save-pw').addEventListener('change', () => {
    $('#ssh-save-pw').dataset.touched = '1';
    showWarn();
  });
  $('#ssh-login').addEventListener('click', async () => {
    if (!current) return;
    const save = $('#ssh-save-pw').checked;
    if (save && !$('#ssh-confirm-risk').checked) {
      status(t('Tick “I understand the risk” to keep the password, or untick Save.'));
      return;
    }
    if (save && !confirm(t('Keep the password for {name}, encrypted with her other secrets? You can forget it any time here.', { name: current.name }))) return;
    const b = $('#ssh-login');
    const pw = $('#ssh-pw');
    busy(b, true);
    try {
      const r = await api(`/ssh/servers/${current.id}/login`, { method: 'POST', body: { password: pw.value, savePassword: save, confirmRisk: save && $('#ssh-confirm-risk').checked } });
      pw.value = '';
      closeSignin();
      render(r);
      $('#ssh-announce').hidden = false;
      $('#ssh-announce').textContent = r.server.passwordSaved
        ? t('She made her own SSH key for {name} and installed it there. Private key: {path} (on the Sara server). Installed line: {line}. She uses the key from now on; the password is saved encrypted because you asked.', { name: r.server.name, path: r.server.keyPath, line: r.server.publicKey })
        : t('She made her own SSH key for {name} and installed it there. Private key: {path} (on the Sara server). Installed line: {line}. She uses the key from now on and did not keep the password.', { name: r.server.name, path: r.server.keyPath, line: r.server.publicKey });
      status(r.server.lastError ?? '');
    } catch (err) {
      pw.value = '';
      status(err.message);
    } finally {
      busy(b, false);
    }
  });
  $('#ssh-key-go').addEventListener('click', async () => {
    if (!current) return;
    const b = $('#ssh-key-go');
    busy(b, true);
    try {
      const r = await api(`/ssh/servers/${current.id}/key`, { method: 'POST', body: { privateKey: $('#ssh-key-text').value, keyPath: $('#ssh-key-path').value.trim() } });
      $('#ssh-key-text').value = '';
      closeSignin();
      render(r);
      status(t('She signed in to {name} with the key. Her copy: {path}', { name: r.server.name, path: r.server.keyPath }));
    } catch (err) {
      $('#ssh-key-text').value = '';
      status(err.message);
    } finally {
      busy(b, false);
    }
  });
  $('#ssh-cancel').addEventListener('click', closeSignin);
  $('#ssh-key-cancel').addEventListener('click', closeSignin);
  // Nothing typed here outlives the window.
  $('#settings').addEventListener('close', () => {
    closeSignin();
    $('#ssh-announce').hidden = true;
  });
}
