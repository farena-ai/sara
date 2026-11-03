// PL2a (docs/design/POLISH2.md N3): Settings → Chat apps → Signal as guided steps, like WhatsApp's.
// Before: the shared setup card (web/setup-card.js). Then six steps: get signal-cli (Windows, macOS,
// Linux, or Docker), register her number or link it to your phone (the link shown as a QR code),
// start it with the exact command for this computer (Copy), add Signal from the short consent step,
// link your chat, Test. Steps 1–3 turn ✓ only when Sara reached the daemon (POST
// /api/plugins/signal/probe); every failure is one plain sentence with the fix.
import { t } from './naming.js';
import { addBuiltin, openPluginSettings, reviewCard } from './plugins.js';
import { api, btn, checking, copyRow, diagLine as diagWith, el, enc, field, foldedLine, link, okLine, pathList, setupCard, startFirstParty, stepNav, stepper, testList, tick, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);
const RELEASES = 'https://github.com/AsamK/signal-cli/releases/latest';
const JAVA = 'https://adoptium.net/temurin/releases/';
const CAPTCHA = 'https://signalcaptchas.org/registration/generate.html';

/** Every diagnosis (src/plugins/signal-setup.ts codes, then the plugin's own): the title, then the fix. */
export const DIAG = {
  DAEMON_DOWN: (p) => [t("Sara can't reach signal-cli at {address}.", { address: p.address ?? '127.0.0.1:7583' }), t('Start it with the command in step 3 and leave that window open.')],
  DAEMON_SLOW: (p) => [t('signal-cli at {address} took too long to answer.', { address: p.address ?? '127.0.0.1:7583' }), t('It may still be starting: wait 30 seconds and press Check again.')],
  NOT_SIGNAL: () => [t('Something else answers on that port.'), t('Use another port in both places, like 127.0.0.1:7584.')],
  NOT_LOCAL: () => [t('That address is not on this computer.'), t("signal-cli has no password, so Sara only uses it on this computer. For your home network, tick It's on another computer at home.")],
  BAD_ADDRESS: () => [t('That is not an address with a port.'), t('Type it like 127.0.0.1:7583.')],
  NOT_RUNNING: () => [t("The Signal plugin isn't running."), t('Switch it on for her in Settings → Plugins.')],
  UNKNOWN: () => [t('signal-cli said something Sara does not know.'), t('Press Details, or try again.')],
};

/** What signal-cli prints when it can't start, and the plain fix (shown under step 3). */
const FIXES = () => [
  [t('“java” is not recognized, or No Java found'), t('Install Java 25 or newer (step 1), then open a new window.')],
  [t('Address already in use'), t('Another program has port 7583: use 127.0.0.1:7584 in the command and in the box below.')],
  [t('User … is not registered'), t('Do step 2 first, with the same number.')],
];

const STEPS = {
  get: () => t('Get signal-cli'),
  number: () => t('Register her number, or link to your phone'),
  start: () => t('Start it'),
  add: () => t('Add Signal to Sara'),
  link: () => t('Link your Signal'),
  test: () => t('Test'),
};

let st = { open: '', number: '', address: '127.0.0.1:7583', other: false, mode: 'register', probe: null, os: '' };
let view = null;

const os = () => st.os || (/Windows/i.test(navigator.userAgent) ? 'win' : /Mac/i.test(navigator.userAgent) ? 'mac' : 'linux');
const num = () => st.number || '+…';
const cli = () => (os() === 'win' ? 'signal-cli.bat' : 'signal-cli');
const daemonCmd = () => `${cli()} -a ${num()} daemon --tcp ${st.address} --receive-mode=manual`;
const diagLine = (d) => diagWith(d, DIAG);

function getBody(body) {
  const pick = el('div', 'setup-os');
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', t('Your computer'));
  for (const [id, name] of [['win', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux'], ['docker', 'Docker']]) {
    const b = btn(name, os() === id ? '' : 'ghost', () => ((st.os = id), render()));
    b.setAttribute('aria-pressed', String(os() === id));
    pick.append(b);
  }
  body.append(pick);
  const o = os();
  if (o === 'win') {
    body.append(pathList(t('Install Java 25 or newer (Temurin) → download the signal-cli .tar.gz from its releases page → unpack it, for example to C:\\signal-cli → open a terminal in its bin folder')));
    body.append(copyRow(t('Java, with winget'), 'winget install EclipseAdoptium.Temurin.25.JRE', t('Run this in a terminal on Windows, or install Java 25 from adoptium.net. signal-cli needs Java to run.')));
    body.append(link(t('Java downloads ↗'), JAVA));
  } else if (o === 'mac') {
    body.append(copyRow(t('With Homebrew'), 'brew install signal-cli', t('Homebrew installs signal-cli and the Java it needs. No Homebrew? Get it from brew.sh, or use the release download.')));
  } else if (o === 'linux') {
    body.append(pathList(t('Download the Linux-native .tar.gz from the releases page → unpack it → move signal-cli into /usr/local/bin')));
    body.append(copyRow(t('Or the Java build'), 'sudo apt install openjdk-25-jre', t('The Java build of signal-cli runs anywhere with Java 25 or newer. The native build needs no Java.')));
  } else {
    body.append(el('p', 'small', t('Any signal-cli image that runs daemon --tcp works. Publish the port to 127.0.0.1 only, and keep its data folder in a volume.')));
    body.append(copyRow(t('Port to publish'), '-p 127.0.0.1:7583:7583', t('Only this computer can reach the daemon then. signal-cli has no password, so never publish it to your network or the internet.')));
  }
  body.append(link(t('signal-cli releases ↗'), RELEASES));
}

function numberBody(body) {
  const pick = el('div', 'setup-os');
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', t('How she gets a Signal account'));
  for (const [id, name] of [['register', t('Register her number')], ['link', t('Link to my phone')]]) {
    const b = btn(name, st.mode === id ? '' : 'ghost', () => ((st.mode = id), render()));
    b.setAttribute('aria-pressed', String(st.mode === id));
    pick.append(b);
  }
  body.append(pick);
  if (st.mode === 'register') {
    const f = field('sig-number', t('Her number'), t('A number only she uses, with + and the country code first. It gets one text or call with a code. Your own number would sign you out of Signal on your phone.'), { value: st.number, placeholder: '+1…', mode: 'tel' });
    f.querySelector('input').addEventListener('change', (e) => ((st.number = e.target.value.trim()), render()));
    body.append(f);
    body.append(copyRow(t('1. Ask for the code'), `${cli()} -a ${num()} register`, t('Signal texts a code to her number. If it says a captcha is needed, solve it on the captcha page, copy the link it gives and add --captcha and that link to this command.')));
    body.append(link(t('Captcha page ↗'), CAPTCHA));
    body.append(copyRow(t('2. Type the code'), `${cli()} -a ${num()} verify 123-456`, t('Replace 123-456 with the code Signal sent. Then her number is ready for step 3.')));
  } else {
    body.append(el('p', 'small', t('Quick try: she answers in your Note to Self only, because she would be writing as you.')));
    body.append(copyRow(t('1. Run this'), `${cli()} link -n Sara`, t('It prints an address starting with sgnl://linkdevice. Paste it below to see it as a QR code, then scan it in Signal on your phone.')));
    const f = field('sig-link-uri', t('2. Paste what it printed'), t('The whole sgnl://linkdevice address. Sara only draws it as a QR code; it is not kept or sent anywhere.'), { placeholder: 'sgnl://linkdevice?…' });
    const out = el('div', 'wa-check');
    body.append(f, btn(t('Show the QR code'), '', async () => {
      try {
        const r = await api('/plugins/signal/qr', { method: 'POST', body: { link: $('#sig-link-uri').value } });
        const img = el('img', 'setup-qr');
        img.src = r.qr;
        img.alt = t('QR code to link Signal');
        out.replaceChildren(img, el('p', 'small', t('On your phone: Signal → Settings → Linked devices → + → scan this.')));
      } catch (err) {
        out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
      }
    }), out);
  }
}

function startBody(body, out) {
  body.append(copyRow(t('Start it with'), daemonCmd(), t('Run this on this computer and leave the window open while she uses Signal. It listens on this computer only.')));
  const f = field('sig-address', t('Where it listens'), t("The address in the command, usually 127.0.0.1:7583. Sara checks that signal-cli answers there; it has no password, so keep it on this computer."), { value: st.address });
  f.querySelector('input').addEventListener('change', (e) => ((st.address = e.target.value.trim() || '127.0.0.1:7583'), render()));
  body.append(f, tick('sig-other', t("It's on another computer at home"), t('Only for signal-cli on your home network or in another Docker container. Never an address on the internet.'), st.other));
  body.querySelector('#sig-other').addEventListener('change', (e) => (st.other = e.target.checked));
  body.append(btn(t('Check'), '', () => probe(out)));
  if (st.probe?.ok) body.append(okLine(t('signal-cli {version} answers at {address}.', { version: st.probe.version, address: st.probe.address })));
  const fixes = el('details', 'wa-details');
  fixes.append(el('summary', '', t('It won’t start?')));
  for (const [said, fix] of FIXES()) {
    const p = el('p', 'small');
    p.append(el('strong', '', said), document.createTextNode(` · ${fix}`));
    fixes.append(p);
  }
  body.append(fixes);
}

async function probe(out) {
  checking(out);
  try {
    st.probe = await api('/plugins/signal/probe', { method: 'POST', body: { address: st.address, onOtherMachine: st.other } });
  } catch (err) {
    st.probe = { ok: false, code: 'UNKNOWN', detail: err.message };
  }
  sessionStorage.setItem('sara.signal.setup', JSON.stringify({ number: st.number, address: st.address, other: st.other, mode: st.mode }));
  if (!st.probe.ok) return void out.replaceChildren(diagLine({ code: st.probe.code, params: { address: st.probe.address }, detail: st.probe.detail }));
  if (view.plugin) await saveSettings().catch(() => undefined);
  if (!view.plugin || !view.on) st.open = 'add';
  render();
}

const saveSettings = () => api('/plugins/signal/settings', { method: 'PUT', body: { companion: view.companion, values: { daemon: st.address, account: st.mode === 'register' ? st.number : '', linkedMode: st.mode === 'link', onOtherMachine: st.other } } });

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const step = view.steps.find((s) => s.id === id);
  if (id === 'get') getBody(body);
  if (id === 'number') numberBody(body);
  if (id === 'start') startBody(body, out);
  if (id === 'add') {
    if (view.plugin) body.append(okLine(view.on ? t('Added and on for her.') : t('Added, but switched off. Switch it on for her in Settings → Plugins.')));
    else body.append(el('p', 'small', t('Signal comes with Sara: one short step, and only Sara holds its connection.')), btn(t('Add Signal'), '', () => startFirstParty('signal', body, { name: 'Signal', reach: t('It can reach signal-cli on this computer, at the address in step 3; nothing else.'), reviewCard, full: addBuiltin, done: afterAdd })));
  }
  if (id === 'link') {
    const row = el('div', 'add-row');
    row.append(btn(t('Link my Signal'), '', async () => {
      try {
        const r = await api('/plugins/signal/link', { method: 'POST', body: { companion: view.companion } });
        out.replaceChildren(copyRow(t('Send this to her'), `/link ${r.code}`, t('Send it to her number from Signal on your phone, within 10 minutes. That is how she knows which chat is you.')));
      } catch (err) {
        out.replaceChildren(diagLine({ code: 'NOT_RUNNING', detail: err.message }));
      }
    }), tip(t("Gives a code for 10 minutes. Send it to her from your own Signal. That's how she knows which chat is you.")));
    body.append(row);
    if (view.linked) body.append(okLine(t('Linked to you')));
  }
  if (id === 'test') {
    const row = el('div', 'add-row');
    row.append(btn(t('Test'), '', async () => {
      checking(out);
      const r = await api('/plugins/signal/test', { method: 'POST', body: { companion: view.companion } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
      out.replaceChildren(testList(r));
      if (r.ok) ((view.tested = true), render());
    }), tip(t('Checks signal-cli, her account and the link. Sends nothing to anyone.')));
    body.append(row);
  }
  if (step?.diagnosis && !out.childNodes.length) out.append(diagLine(step.diagnosis));
  body.append(out);
  body.append(stepNav(view.steps.map((s) => s.id), id, { primary: step?.ok || id === 'get' || id === 'number' }, (to) => ((st.open = to), render())));
  return body;
}

async function afterAdd() {
  await load();
  if (st.probe?.ok) await saveSettings().catch(() => undefined);
  await load();
}

function render() {
  const box = $('#sig-box');
  const chip = $('#sig-chip');
  if (!box || !view) return;
  const reached = st.probe?.ok === true || view.state === 'ok';
  view.steps = [
    { id: 'get', ok: reached },
    { id: 'number', ok: reached },
    { id: 'start', ok: reached },
    { id: 'add', ok: Boolean(view.plugin && view.on) },
    { id: 'link', ok: view.linked },
    { id: 'test', ok: view.state === 'ok' && view.linked },
  ];
  const all = view.steps.every((s) => s.ok);
  chip.textContent = all ? t('Connected') : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.plugin || reached ? t('{n} of {total} done', { n: view.steps.filter((s) => s.ok).length, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = all ? 'ok' : view.state === 'error' || view.state === 'paused' ? 'warn' : '';
  if (!view.started && !view.plugin) {
    box.replaceChildren(setupCard('signal', { builtin: view.builtin, missing: t("Signal doesn't come with this copy of Sara."), onStart: () => ((view.started = true), sessionStorage.setItem('sara.signal.started', '1'), render()) }));
    return;
  }
  if (all && !view.force) {
    box.replaceChildren(foldedLine(t('Signal: working'), () => ((view.force = true), (st.open = 'get'), render())), btnRow());
    return;
  }
  if (!st.open || !view.steps.some((s) => s.id === st.open)) st.open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  const left = stepper({ title: t('Set up Signal'), steps: view.steps, open: st.open, titleOf: (id) => STEPS[id](), bodyOf: stepBody, onOpen: (id) => ((st.open = id), render()) });
  const good = el('div', 'kit-card');
  good.append(el('h3', '', t('Good to know')), el('p', 'small', t('Signal may limit accounts that act like bots; use a number you can lose.')), el('p', 'small', t('Signal chats stay end-to-end encrypted up to signal-cli on this computer.')), link(t('How Signal works'), '/help#signal'));
  const grid = el('div', 'wa-grid');
  grid.append(left, good);
  box.replaceChildren(grid, ...(view.plugin ? [btnRow()] : []));
}

function btnRow() {
  const row = el('div', 'add-row');
  row.append(btn(t('Signal settings'), 'ghost', () => openPluginSettings(view.plugin)));
  if (view.update) row.append(btn(t('Update available: {version}', { version: view.update }), 'ghost', () => addBuiltin('signal')));
  return row;
}

async function load() {
  const box = $('#sig-box');
  if (!box) return;
  try {
    const [{ builtin }, { plugins }] = await Promise.all([api('/plugins/builtin'), api('/plugins')]);
    const b = builtin.find((x) => x.id === 'signal');
    const p = plugins.find((x) => x.id === 'signal');
    const on = p?.companions.find((c) => c.on);
    let bridge = { state: on ? 'connecting' : 'off', linked: [] };
    if (on) bridge = await api(`/plugins/signal/bridge?companion=${enc(on.id)}`).catch(() => bridge);
    const keep = view ? { started: view.started, force: view.force } : { started: sessionStorage.getItem('sara.signal.started') === '1' };
    view = { ...keep, builtin: Boolean(b), plugin: p ?? null, on: Boolean(on), companion: on?.id ?? p?.companions[0]?.id ?? 'main', state: bridge.state, linked: (bridge.linked ?? []).length > 0, update: b?.updateAvailable ? b.version : '', steps: [] };
    const saved = JSON.parse(sessionStorage.getItem('sara.signal.setup') ?? 'null');
    if (saved && !st.number) Object.assign(st, saved);
    render();
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadSignalPage() {
  await load();
}
