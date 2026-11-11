// PRQ (docs/ops/PRQ_DESIGN.md): programs add-ons need on the computer where Sara runs. The store
// card's "It needs" line and Settings → Add-ons → Other programs list them; *Install it for me*
// shows the approval card with the exact commands, then the progress (Stop), then the re-check.
// Owner only (the server refuses everyone else). Every value is set as text.
import { serverText, t } from './naming.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => onClick(b));
  return b;
};
const enc = encodeURIComponent;
async function api(path, o = {}) {
  const res = await fetch(`/api${path}`, { method: o.method ?? 'GET', headers: o.body !== undefined ? { 'content-type': 'application/json' } : {}, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

const REASON = {
  'no-winget': () => t("This Windows has no winget (App Installer), so Sara can't install it. Get it from the vendor's page."),
  'no-brew': () => t("Homebrew is not installed, so Sara can't install it. Install Homebrew, or get it from the vendor's page."),
  'link-only': () => t("Install it yourself from the vendor's page: it needs a license to accept and often a restart. Then press Check again."),
  unsupported: () => t("Sara can't install programs on this system. Get it from the vendor's page."),
  'no-package': () => t("This system has no package for it that Sara trusts. Get it from the vendor's page."),
  'no-root': () => t('Sara runs without administrator rights here. Run these commands yourself in a terminal, then press Check again:'),
  arch: () => t("There is no build for this processor that Sara can install. Get it from the vendor's page."),
};
const AFTER = {
  'blender-addon': () => t('Then, in Blender: Edit → Preferences → Add-ons → Install from disk, switch the add-on on and press Connect in its side panel.'),
  'docker-group': () => t('Then start Docker. On Linux, add the user Sara runs as to the docker group and restart Sara.'),
};
const ELEVATION = {
  uac: () => t('Windows may ask you to allow it (a User Account Control prompt on this computer).'),
  sudo: () => t('It runs with sudo; this computer allows that without a password.'),
  root: () => t('Sara runs as the administrator (root) here.'),
};
function sourceLine(c) {
  if (c.method === 'winget') return t("From winget, Microsoft's package manager: package {ref}.", { ref: c.source.ref });
  if (c.method === 'brew') return t('From Homebrew: {ref}.', { ref: c.source.ref });
  if (c.method === 'download') return t("From the vendor's official download, checked against its sha256: {ref}", { ref: c.source.ref });
  return t("From this system's package manager ({pm}).", { pm: c.method });
}
const RESULT = {
  stopped: () => t('Stopped. Nothing else runs.'),
  timeout: () => t('It took too long and was stopped.'),
};

/** The manual steps (Sara can't install it here): why, the commands, the vendor's page. */
function manualCard(m, name, after, onCheck) {
  const box = el('section', 'prop-card prq-card');
  box.append(el('h4', 'prop-title', t('How to install {name}', { name })), el('p', 'small', REASON[m.reason]?.() ?? m.reason));
  if (m.lines?.length) box.append(el('pre', 'prop-args small prq-lines', m.lines.join('\n')));
  const a = el('a', 'small', t("{name}: the vendor's page", { name }));
  a.href = m.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  box.append(a);
  if (after && AFTER[after]) box.append(el('p', 'muted small', AFTER[after]()));
  const row = el('div', 'prop-buttons');
  row.append(btn(t('Check again'), 'ghost', () => onCheck()));
  box.append(row);
  return box;
}

/** The approval card: the exact commands, where they come from, elevation, private local. */
function approvalCard(c, host, onDone) {
  const body = [el('p', 'small', sourceLine(c)), el('p', 'small', t('It runs these steps on the computer where Sara runs:'))];
  const list = el('ol', 'prq-steps small');
  for (const s of c.steps) {
    const li = el('li');
    if (s.kind === 'run') li.append(el('code', 'stp-cmd', s.line));
    else if (s.kind === 'download') {
      li.append(el('span', '', t('Download {url}', { url: s.url })));
      if (s.sha256) li.append(el('code', 'stp-cmd', `sha256 ${s.sha256}`));
    } else li.append(el('span', '', t('Write {file} (fixed text from Sara)', { file: s.file })));
    list.append(li);
  }
  body.push(list);
  if (ELEVATION[c.elevation]) body.push(el('p', 'muted small', ELEVATION[c.elevation]()));
  if (c.userInstall) body.push(el('p', 'muted small', t('It goes into your own folder (~/.local), without administrator rights. Tool servers in the Linux sandbox may not see it there.')));
  if (c.after && AFTER[c.after]) body.push(el('p', 'muted small', AFTER[c.after]()));
  if (c.privateLocal) body.push(el('p', 'skl-warn small', t('Private local mode is on: installing a program needs the internet. Turn Nothing leaves this computer off for the install, then on again.')));
  const card = el('section', 'prop-card prq-card');
  card.setAttribute('aria-label', t('Install {name}?', { name: c.name }));
  card.append(el('h4', 'prop-title', t('Install {name}?', { name: c.name })), ...body);
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const row = el('div', 'prop-buttons');
  row.append(
    btn(t('Install'), '', async (b) => {
      b.disabled = true;
      try {
        const r = await api(`/prereqs/plans/${enc(c.id)}/approve`, { method: 'POST', body: {} });
        progress(r.job, host, onDone);
      } catch (err) {
        status.textContent = err.message;
        b.disabled = false;
      }
    }),
    btn(t('Cancel'), 'ghost', () => onDone(null)),
  );
  card.append(row, status);
  return card;
}

/** The running install: step n of m, the installer's last lines, Stop; then the result and the re-check. */
function progress(job, host, onDone) {
  const card = el('section', 'prop-card prq-card');
  const title = el('h4', 'prop-title');
  const step = el('p', 'small');
  step.setAttribute('role', 'status');
  const out = el('pre', 'prop-args small prq-lines');
  const row = el('div', 'prop-buttons');
  const stop = btn(t('Stop'), 'ghost', async (b) => {
    b.disabled = true;
    try {
      await api(`/prereqs/jobs/${enc(job.id)}/stop`, { method: 'POST', body: {} });
    } catch (err) {
      step.textContent = err.message;
    }
  });
  row.append(stop);
  card.append(title, step, out, row);
  host.replaceChildren(card);
  const paint = (j) => {
    out.textContent = j.lines.join('\n');
    out.scrollTop = out.scrollHeight;
    if (j.state === 'running') {
      title.textContent = t('Installing {name}…', { name: j.name });
      step.textContent = t('Step {n} of {m}', { n: j.step, m: j.steps });
      return false;
    }
    stop.remove();
    title.textContent = j.name;
    if (j.state === 'ok') step.textContent = j.found ? (j.version ? t('{name} {version} is installed.', { name: j.name, version: j.version }) : t('{name} is installed.', { name: j.name })) : t("The installer finished, but Sara can't find {name} yet. Restart Sara, then press Check again.", { name: j.name });
    else step.textContent = RESULT[j.state]?.() ?? t('The install did not finish: {error}', { error: j.error ?? j.state });
    step.className = `small ${j.state === 'ok' && j.found ? 'skl-note' : 'skl-warn'}`;
    row.append(btn(j.found ? t('Continue') : t('Close'), j.found ? '' : 'ghost', () => onDone(j)));
    return true;
  };
  paint(job);
  const tick = async () => {
    if (!card.isConnected) return;
    try {
      const r = await api(`/prereqs/jobs/${enc(job.id)}`);
      if (paint(r.job)) return;
    } catch (err) {
      step.textContent = err.message;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

/** *Install it for me* for one program, inside `host`; `onDone(job|null)` when the owner moves on. */
export async function installProgram(id, host, onDone) {
  host.replaceChildren(el('p', 'muted small', t('Working…')));
  let r;
  try {
    r = await api(`/prereqs/${enc(id)}/plan`, { method: 'POST', body: {} });
  } catch (err) {
    host.replaceChildren(el('p', 'skl-warn small', err.message));
    return;
  }
  if (r.job) return progress(r.job, host, onDone);
  if (r.card.manual) return void host.replaceChildren(manualCard(r.card.manual, r.card.name, r.card.after, () => onDone(null)));
  host.replaceChildren(approvalCard(r.card, host, onDone));
}

const NAME = (n) => n.what.replace(/^app:/, '');
/** The store card's "It needs" line; missing catalog programs get *Install it for me*. */
export function needsLine(needs, onInstalled) {
  const box = el('div', 'prq-needs small');
  box.append(el('span', '', t('It needs:')));
  const host = el('div', 'prq-host');
  for (const n of needs) {
    const item = el('span', `prq-need${n.found === false ? ' prq-missing' : ''}`, n.found === true ? t('{what} (found)', { what: NAME(n) }) : n.old ? t('{what} (too old)', { what: NAME(n) }) : n.found === false ? t('{what} (not found)', { what: NAME(n) }) : NAME(n));
    box.append(item);
    if (n.program && n.found === false) {
      const go = btn(t('Install it for me'), 'small', () => {
        go.hidden = true;
        void installProgram(n.program, host, (j) => {
          if (j) return onInstalled(j);
          host.replaceChildren();
          go.hidden = false;
        });
      });
      item.append(' ', go);
    }
  }
  box.append(host);
  return box;
}

// ---- Settings → Add-ons → Other programs: the programs list and the install setting ----

const STATE = (p) => (p.found ? (p.old ? t('Found, but too old ({version})', { version: p.version ?? '?' }) : p.version ? t('Found ({version})', { version: p.version }) : t('Found')) : t('Not found'));

// ---- Sara's own browser (src/browser-setup.ts): her testing browser and the Browser add-on ----

const WHY = {
  platform: () => t('This system is not one the browser runs on (Windows, Mac and Linux are).'),
  arch: () => t('There is no browser build for this processor.'),
  musl: () => t('This Linux uses musl (for example Alpine), and the browser needs a glibc-based Linux such as Debian, Ubuntu or AlmaLinux.'),
};
/** What the card says for one state (exported for tests). */
export function browserWords(b) {
  if (b.state === 'ready') return b.browser?.source === 'system' ? t('Ready: it uses {name} on this computer.', { name: b.browser.kind === 'edge' ? 'Microsoft Edge' : 'Google Chrome' }) : t('Ready: Sara downloaded the browser into her own folder and it passed a test.');
  if (b.state === 'downloading') return b.percent ? t('Downloading the browser… {n}%', { n: b.percent }) : t('Downloading the browser…');
  if (b.state === 'checking') return b.step === 'libraries' ? t('Checking what the browser needs on this server…') : t('Testing the browser…');
  if (b.state === 'needs-admin') return b.command ? t('Needs your server admin: this server lacks a few system libraries the browser uses. Ask them to run:') : t('Needs your server admin: this server lacks these system libraries: {list}', { list: (b.missing ?? []).join(', ') });
  if (b.state === 'unsupported') return t('Not supported on this system: {why}', { why: WHY[b.why]?.() ?? b.why ?? '' });
  if (b.state === 'failed') return t('Getting the browser did not work: {error}', { error: b.error ?? '' });
  if (b.why === 'private') return t('Private local mode is on: getting the browser needs the internet. Turn Nothing leaves this computer off for the download, then on again.');
  return t('Not downloaded yet. Sara gets it the first time it is needed (about 110 MB, into her own folder).');
}
/** The status card: Ready / Downloading (progress) / Needs your server admin (command) / Not supported; Try again. */
export function browserCard() {
  const box = el('section', 'prop-card prq-card prq-browser');
  box.setAttribute('aria-label', t('Browser'));
  const title = el('h4', 'prop-title', t('Browser'));
  const line = el('p', 'small');
  line.setAttribute('role', 'status');
  const bar = el('progress', 'prq-bar');
  bar.max = 100;
  const extra = el('div', 'prq-host');
  const row = el('div', 'prop-buttons');
  box.append(title, line, bar, extra, row);
  let timer;
  const paint = (b) => {
    line.textContent = browserWords(b);
    line.className = `small ${b.state === 'ready' ? 'skl-note' : b.state === 'needs-admin' || b.state === 'failed' || b.state === 'unsupported' ? 'skl-warn' : ''}`;
    box.dataset.state = b.state;
    bar.hidden = b.state !== 'downloading';
    if (b.percent) bar.value = b.percent;
    else bar.removeAttribute('value');
    extra.replaceChildren();
    if (b.state === 'needs-admin' && b.command) {
      const code = el('pre', 'prop-args small prq-lines', b.command);
      const copy = btn(t('Copy'), 'ghost small', async () => {
        try {
          await navigator.clipboard.writeText(b.command);
          copy.textContent = t('Copied');
        } catch {
          copy.textContent = t('Select the line and copy it');
        }
      });
      extra.append(code, copy, el('p', 'muted small', t('Then press Try again. Nothing else on the server changes.')));
    }
    if (b.state === 'ready' && b.noSandbox) extra.append(el('p', 'muted small', t("It runs without Chrome's own sandbox here, inside Sara's sandbox instead.")));
    row.replaceChildren();
    const busy = b.state === 'downloading' || b.state === 'checking';
    if (!busy && b.state !== 'unsupported' && b.why !== 'private') {
      row.append(btn(b.state === 'ready' ? t('Check again') : b.state === 'missing' ? t('Get it now') : t('Try again'), b.state === 'ready' ? 'ghost small' : 'small', async (bt) => {
        bt.disabled = true;
        try {
          paint((await api('/prereqs/browser', { method: 'POST', body: {} })).browser);
          poll();
        } catch (err) {
          line.textContent = err.message;
          bt.disabled = false;
        }
      }));
    }
    return busy;
  };
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!box.isConnected) return;
      try {
        if (paint((await api('/prereqs/browser')).browser)) poll();
      } catch {
        poll();
      }
    }, 1500);
  };
  line.textContent = t('Working…');
  bar.hidden = true;
  api('/prereqs/browser').then((r) => {
    if (paint(r.browser)) poll();
  }, (err) => {
    // 403 (not the owner) or 404 (no setup on this server): no card.
    if (err.status === 403 || err.status === 404) box.remove();
    else line.textContent = err.message;
  });
  return box;
}
export async function loadPrograms() {
  const box = document.querySelector('#prq-list');
  if (!box) return;
  let r;
  try {
    r = await api('/prereqs');
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.status === 403 ? '' : err.message));
    return;
  }
  const sel = document.querySelector('#prq-installs');
  if (sel) {
    sel.value = r.own;
    sel.disabled = r.pinned;
  }
  const host = el('div', 'prq-host');
  const rows = r.programs.map((p) => {
    const row = el('div', 'prq-row');
    // Only programs one of the owner's add-ons needs are a problem; the rest are just listed.
    const needed = !Array.isArray(p.neededBy) || p.neededBy.length > 0;
    row.append(el('span', 'prq-name', p.name), el('span', `small ${(p.found && !p.old) || !needed ? 'muted' : 'prq-missing'}`, STATE(p)));
    if ((!p.found || p.old) && !needed) row.append(el('span', 'muted small', t('None of your add-ons need it.')));
    if (!p.found || p.old) {
      if (p.manual) row.append(btn(t('How to install'), 'ghost small', () => host.replaceChildren(manualCard(p.manual, p.name, p.after, () => void loadPrograms()))));
      else if (r.installs !== 'off') row.append(btn(t('Install it for me'), 'small', () => void installProgram(p.id, host, () => void loadPrograms())));
    }
    return row;
  });
  box.replaceChildren(...rows, host, browserCard());
}

export function wirePrograms() {
  const sel = document.querySelector('#prq-installs');
  sel?.addEventListener('change', async () => {
    const status = document.querySelector('#prq-status');
    try {
      await api('/prereqs/settings', { method: 'PUT', body: { installs: sel.value } });
      if (status) status.textContent = t('Saved.');
      await loadPrograms();
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  });
}
