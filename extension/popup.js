// U4.25 (docs/EXTENSION.md): the popup. Pair with your Sara by a short code; then, on the page you are
// on: Ask Sara about it (URL + selected text + the page's readable text, read here and capped),
// Summarize, Save page to Library, Fill this form (Sara proposes values from My details, you approve
// them field by field, and only then are they typed; never passwords, cards or codes; the form is
// never sent). Off on this site switches it all off for that site. Data goes only to your paired Sara.
import { askBody, B, deviceName, isOff, loadConf, normalizeServer, originPattern, pageAllowed, pollPairing, saraCall, siteKey, startPairing, t, toggleSite } from './lib/common.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let conf = { server: '', token: '', deviceId: '', offSites: [] };
let tab;
let plan;

function say(text, error = false) {
  $('#status').textContent = text || '';
  $('#status').classList.toggle('error', Boolean(error));
}
const busy = (on) => document.querySelectorAll('#actions button').forEach((b) => (b.disabled = on));

function localize() {
  document.documentElement.lang = (B.i18n?.getUILanguage?.() || 'en').split('-')[0];
  for (const n of document.querySelectorAll('[data-t]')) n.textContent = t(n.dataset.t);
  $('#server').placeholder = t('serverPlaceholder');
  $('#question').placeholder = t('askPlaceholder');
}

async function activeTab() {
  const id = Number(params.get('tab'));
  if (id) return B.tabs.get(id);
  const [x] = await B.tabs.query({ active: true, currentWindow: true });
  return x;
}

/** Runs one of the page helpers (lib/extract.js, lib/fields.js) in the tab, after you clicked. */
async function inPage(func, args = []) {
  await B.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/extract.js', 'lib/fields.js'] });
  const [r] = await B.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return r?.result;
}

const readPage = () =>
  inPage(() => ({ url: location.href, title: document.title, selection: String(globalThis.getSelection?.() ?? '').trim(), text: globalThis.SaraExtract.readableText(document) }));

function errorText(err) {
  if (err?.status === 401) return t('revoked');
  if (err?.status === 0 || err instanceof TypeError) return t('cantReach');
  return err?.message || t('errorGeneric');
}

// ------------------------------------------------------------------ pairing
function showPair() {
  $('#pair-view').hidden = false;
  $('#main-view').hidden = true;
  $('#foot').hidden = true;
  $('#server').value = conf.server;
}

async function pair() {
  const server = normalizeServer($('#server').value);
  if (!server) return say(t('badServer'), true);
  // Firefox closes the popup while it asks for a permission: pair in a tab there.
  if (/Firefox\//.test(navigator.userAgent) && !params.has('tab') && !params.has('pair')) {
    await B.storage.local.set({ server });
    await B.tabs.create({ url: B.runtime.getURL('popup.html?pair=1') });
    return window.close();
  }
  // Only this server, asked now (no other site is ever reachable).
  const granted = await B.permissions.request({ origins: [originPattern(server)] }).catch(() => false);
  if (!granted) return say(t('permissionDenied'), true);
  $('#pair').disabled = true;
  say(t('pairing'));
  try {
    const s = await startPairing(server, deviceName());
    $('#code').textContent = s.code;
    $('#open-device').href = s.verifyUrl || `${server}/device`;
    $('#code-box').hidden = false;
    say('');
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2500));
      const p = await pollPairing(server, s.pollToken);
      if (p.status === 'approved' && p.token) {
        await B.storage.local.set({ server, token: p.token, deviceId: p.deviceId || '' });
        conf = await loadConf();
        $('#code-box').hidden = true;
        say(t('paired'));
        return showMain();
      }
      if (p.status === 'denied' || p.status === 'expired') break;
    }
    $('#code-box').hidden = true;
    say(t('pairFailed'), true);
  } catch (err) {
    say(errorText(err), true);
  } finally {
    $('#pair').disabled = false;
  }
}

async function unpair() {
  try {
    await saraCall(conf, '/api/device/logout', {});
  } catch {
    /* already gone on the server */
  }
  await B.storage.local.remove(['token', 'deviceId']);
  if (conf.server) await B.permissions.remove({ origins: [originPattern(conf.server)] }).catch(() => {});
  conf = await loadConf();
  say(t('unpaired'));
  showPair();
}

// ------------------------------------------------------------------ the page
let state = {};
function paintOff() {
  const off = isOff(conf.offSites, tab?.url);
  $('#site-off').checked = off;
  let note = '';
  if (!pageAllowed(tab?.url)) note = t('notWebPage');
  else if (off) note = t('offHereNote');
  else if (state.privateLocal) note = t('privateLocal');
  else if (state.on === false) note = t('extOff');
  $('#off-note').textContent = note;
  $('#off-note').hidden = !note;
  $('#actions').hidden = Boolean(note);
  $('#fill').hidden = state.forms === false;
}

async function showMain() {
  $('#pair-view').hidden = true;
  $('#main-view').hidden = false;
  $('#foot').hidden = false;
  $('#paired').textContent = t('pairedWith', [conf.server]);
  $('#site').textContent = siteKey(tab?.url);
  $('#site-off').disabled = !pageAllowed(tab?.url);
  try {
    state = await saraCall(conf, '/api/ext/state');
    if (state.companion) $('#who').textContent = state.companion;
  } catch (err) {
    say(errorText(err), true);
  }
  paintOff();
  const pending = (await (B.storage.session ?? B.storage.local).get('pending')).pending;
  if (pending && pending.tabId === tab?.id && Date.now() - pending.at < 60_000) {
    await (B.storage.session ?? B.storage.local).remove('pending');
    if (!$('#actions').hidden) pending.mode === 'save' ? await save() : await ask('ask', pending.selection);
  }
}

async function ask(mode, selection) {
  $('#fill-card').hidden = true;
  busy(true);
  say(t('thinking'));
  try {
    const page = await readPage();
    if (selection) page.selection = selection;
    const r = await saraCall(conf, '/api/ext/ask', askBody({ ...page, mode, question: $('#question').value }));
    // Her AI notice (first time) stays apart from her reply, in small print.
    $('#notice').textContent = (r.notices ?? []).join(' ');
    $('#notice').hidden = !r.notices?.length;
    $('#reply').textContent = [r.reply || '', r.waiting ? `${t('waitingApproval')} ${r.waiting}` : ''].filter(Boolean).join('\n\n');
    $('#cont').href = r.url;
    $('#cont').textContent = t('continueInSara');
    $('#out').hidden = false;
    say('');
  } catch (err) {
    say(err?.message?.includes('Cannot access') ? t('readFailed') : errorText(err), true);
  } finally {
    busy(false);
  }
}

async function save() {
  busy(true);
  say(t('saving'));
  try {
    const page = await readPage();
    const r = await saraCall(conf, '/api/ext/save', askBody(page));
    $('#notice').hidden = true;
    $('#reply').textContent = t('saved', [r.name]);
    $('#cont').href = r.url;
    $('#cont').textContent = t('openLibrary');
    $('#out').hidden = false;
    say('');
  } catch (err) {
    say(errorText(err), true);
  } finally {
    busy(false);
  }
}

async function fill() {
  $('#out').hidden = true;
  busy(true);
  say(t('thinking'));
  try {
    const fields = await inPage(() => {
      const r = globalThis.SaraFields.collect(document);
      globalThis.__saraFieldEls = r.elements;
      return r.fields;
    });
    if (!fields?.length) return say(t('fillNone'));
    plan = await saraCall(conf, '/api/ext/fill', { url: tab.url, title: tab.title, fields });
    const list = $('#fill-list');
    list.replaceChildren();
    for (const f of plan.fills) {
      const li = document.createElement('li');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, id: `ok-${f.ref}` });
      box.dataset.ref = f.ref;
      const lab = Object.assign(document.createElement('label'), { htmlFor: box.id, textContent: f.label });
      const val = Object.assign(document.createElement('input'), { type: 'text', value: f.value, maxLength: 500 });
      val.dataset.ref = f.ref;
      val.setAttribute('aria-label', f.label);
      li.append(box, lab, val);
      list.append(li);
    }
    const skipped = plan.skipped.map((s) => s.label).filter(Boolean);
    $('#fill-skipped').textContent = skipped.length ? t('fillSkipped', [skipped.join(', ')]) : '';
    $('#fill-skipped').hidden = !skipped.length;
    $('#fill-ok').hidden = !plan.fills.length;
    $('#fill-card').hidden = false;
    say(plan.fills.length ? '' : plan.hasDetails ? t('fillNoMatch') : t('noDetails'));
  } catch (err) {
    say(errorText(err), true);
  } finally {
    busy(false);
  }
}

async function approveFill() {
  const fills = [...document.querySelectorAll('#fill-list input[type="text"]')]
    .filter((v) => document.querySelector(`#ok-${v.dataset.ref}`)?.checked)
    .map((v) => ({ ref: v.dataset.ref, value: v.value }));
  try {
    const r = await inPage((f) => globalThis.SaraFields.applyFills(globalThis.__saraFieldEls ?? [], f), [fills]);
    $('#fill-card').hidden = true;
    say(t('filled', [String(r?.filled?.length ?? 0)]));
  } catch (err) {
    say(errorText(err), true);
  }
}

// ------------------------------------------------------------------ start
async function start() {
  localize();
  if (params.has('tab') || params.has('pair')) document.body.classList.add('tab');
  conf = await loadConf();
  tab = await activeTab().catch(() => undefined);
  $('#pair').addEventListener('click', () => void pair());
  $('#unpair').addEventListener('click', () => void unpair());
  $('#ask').addEventListener('click', () => void ask('ask'));
  $('#summarize').addEventListener('click', () => void ask('summarize'));
  $('#save').addEventListener('click', () => void save());
  $('#fill').addEventListener('click', () => void fill());
  $('#fill-ok').addEventListener('click', () => void approveFill());
  $('#fill-no').addEventListener('click', () => (($('#fill-card').hidden = true), say(t('fillCancelled'))));
  $('#question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask('ask');
    }
  });
  $('#site-off').addEventListener('change', async (e) => {
    conf.offSites = toggleSite(conf.offSites, tab?.url, e.target.checked);
    await B.storage.local.set({ offSites: conf.offSites });
    $('#out').hidden = true;
    $('#fill-card').hidden = true;
    paintOff();
  });
  if (conf.token && conf.server) await showMain();
  else showPair();
}

void start();
