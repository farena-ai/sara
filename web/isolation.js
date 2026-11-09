// EC8 + EC9 (docs/ops/EC89_DESIGN.md): Settings → Tools → Isolation and Sites sandboxed work may
// reach. Owner only (the server refuses everyone else). Every value is set as text; every word goes
// through t().
import { installProgram } from './prereqs.js';
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
async function api(path, o = {}) {
  const res = await fetch(`/api${path}`, { method: o.method ?? 'GET', headers: o.body !== undefined ? { 'content-type': 'application/json' } : {}, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

const ENGINE = { podman: 'Podman', docker: 'Docker' };
function statusLine(v) {
  const s = v.sandbox;
  if (s.refused) return t('Refused: your admin requires the container sandbox, and no working Podman or Docker was found. Commands and add-on jobs do not run.');
  if (s.mode === 'container') return t("Isolated: a {engine} container. Only the workspace is mounted; Sara's data, your files and the system are out of reach.", { engine: ENGINE[v.found?.engine] ?? t('container') });
  if (s.mode === 'bwrap') return t("Isolated: bubblewrap. Only the workspace is writable; Sara's data is hidden.");
  if (s.mode === 'seatbelt') return t("Isolated: the macOS sandbox. Only the workspace is writable; your home folder and Sara's data are hidden.");
  if (s.mode === 'user') return t("Isolated: a separate user account that can't read Sara's data.");
  return t('Not isolated: commands run directly on this computer, and she asks before every command.');
}
function engineLine(v) {
  if (v.found) return t('Found: {engine} {version}{rootless}, image {image}.', { engine: ENGINE[v.found.engine], version: v.found.version, rootless: v.found.rootless ? ` ${t('(rootless)')}` : '', image: v.found.image });
  const parts = (v.tried ?? []).map((x) => {
    const engine = ENGINE[x.engine] ?? x.engine;
    if (/not running/.test(x.why ?? '')) return t('{engine} is installed but not running.', { engine });
    if (/image/.test(x.why ?? '')) return t('{engine} works, but the image {image} is not on this computer (run: {command}).', { engine, image: v.image, command: `${x.engine} pull ${v.image}` });
    return t('{engine} is not installed.', { engine });
  });
  return parts.join(' ');
}
const ENFORCE = {
  container: () => t('Enforced: the container network only reaches the egress proxy.'),
  namespace: () => t('Enforced: no network inside the sandbox except the egress proxy.'),
  seatbelt: () => t('Enforced: the macOS sandbox only allows the egress proxy.'),
  'node-guard': () => t('Enforced by a Node guard inside the job (not an operating-system boundary).'),
  variables: () => t('Not enforced here: only programs that honor proxy settings use the list. Use a container for real enforcement.'),
};

const hostsText = (hosts) => hosts.map((h) => (typeof h === 'string' ? h : `${h.host} key=${h.key}`)).join('\n');
function parseHosts(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\S+)\s+key=(\S+)$/.exec(l);
      return m ? { host: m[1], key: m[2] } : l;
    });
}

function render(v) {
  $('#iso-status').textContent = statusLine(v);
  const sel = $('#iso-backend');
  sel.value = v.backend;
  sel.disabled = v.pinned.containerSandbox;
  $('#iso-engines').textContent = engineLine(v);
  // No engine at all: offer the one-click install the catalog has (Docker).
  $('#iso-install').hidden = Boolean(v.found) || (v.platform === 'linux' && v.backend !== 'container' && !v.pinned.containerSandbox);
  $('#eg-mode').value = v.egress.mode;
  $('#eg-hosts').value = hostsText(v.egress.hosts);
  $('#eg-mode').disabled = v.pinned.egressAllowlist;
  $('#eg-hosts').disabled = v.pinned.egressAllowlist;
  $('#eg-save').disabled = v.pinned.egressAllowlist;
  const lines = [t('Commands: {how}', { how: ENFORCE[v.egress.commands]() }), t('Add-on jobs: {how}', { how: ENFORCE[v.egress.jobs]() })];
  if (v.pinned.egressAllowlist) lines.unshift(t('Set by your admin.'));
  $('#eg-note').textContent = lines.join(' ');
}

export async function loadIsolation() {
  if (!$('#iso-status')) return;
  try {
    render(await api('/isolation'));
  } catch (err) {
    $('#iso-status').textContent = err.status === 403 ? '' : err.message;
  }
}

async function act(fn) {
  const msg = $('#iso-msg');
  msg.textContent = t('Working…');
  try {
    render(await fn());
    msg.textContent = t('Saved.');
  } catch (err) {
    msg.textContent = err.message;
  }
}

export function wireIsolation() {
  if (!$('#iso-backend')) return;
  $('#iso-backend').addEventListener('change', () => act(() => api('/isolation', { method: 'PUT', body: { backend: $('#iso-backend').value } })));
  $('#iso-recheck').addEventListener('click', () => act(() => api('/isolation/recheck', { method: 'POST', body: {} })));
  $('#eg-save').addEventListener('click', () => act(() => api('/isolation', { method: 'PUT', body: { egressMode: $('#eg-mode').value, egressHosts: parseHosts($('#eg-hosts').value) } })));
  $('#iso-install').addEventListener('click', () => {
    void installProgram('docker', $('#iso-host'), () => {
      $('#iso-host').replaceChildren();
      void act(() => api('/isolation/recheck', { method: 'POST', body: {} }));
    });
  });
}
