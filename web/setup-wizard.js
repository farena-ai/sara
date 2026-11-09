// The first-run setup guide (moved out of app.js in PL2d, 2.61.3; code moved only,
// docs/design/POLISH2.md C1): step 1 your name and the use choice, step 2 who she is, step 3
// connect a brain (a test message must answer), step 4 the starter chips and the check-in card.
import { setIdentity, t } from './naming.js';
import { icon } from './icons.js';
import { normPath, pathChoices, starterChips } from './first-run.js';
import { CLOUD_TAG, countWords, modelCounts } from './model-count.js';
import { suggestModel } from './model-suggest.js';
import { foldFirstRun, unfoldFirstRun } from './hub.js';
import { todayOpen } from './today.js';
import { queueTourOffer } from './tours.js';

const $ = (sel) => document.querySelector(sel);
/** What app.js lends this module (api, el, fillModelOptions, firstRun, galleryList, loadChecklist, loadConversations, loadProviders, loadToday, modelCache, modelViewFor, openRoutines, openSettings, openWizard, renderGallery, renderMessages, runStarter, setChatTitle, starterButton, state). */
let ctx = null;
const el = (...a) => ctx.el(...a);
const api = (...a) => ctx.api(...a);
const renderGallery = (...a) => ctx.renderGallery(...a);
const galleryList = (...a) => ctx.galleryList(...a);
const starterButton = (...a) => ctx.starterButton(...a);
const openRoutines = (...a) => ctx.openRoutines(...a);
const modelViewFor = (...a) => ctx.modelViewFor(...a);
const fillModelOptions = (...a) => ctx.fillModelOptions(...a);
const loadProviders = (...a) => ctx.loadProviders(...a);
const loadConversations = (...a) => ctx.loadConversations(...a);
const setChatTitle = (...a) => ctx.setChatTitle(...a);
const loadToday = (...a) => ctx.loadToday(...a);
const loadChecklist = (...a) => ctx.loadChecklist(...a);
const openSettings = (...a) => ctx.openSettings(...a);
const openWizard = (...a) => ctx.openWizard(...a);
const renderMessages = (...a) => ctx.renderMessages(...a);
const runStarter = (...a) => ctx.runStarter(...a);
let state = null;
let firstRun = null;
let modelCache = null;

// ---------- first-run setup guide ----------
// Phase 114 (PL1b): `path` = the use choice of step 1; `brainOk` = the picked model answered a test
// ping; `ping` numbers the pings (a newer one wins); `coderPick` = the model Models → Which model does
// what would pick for coding.
const su = { step: 1, info: null, provider: null, openSubs: false, original: null, changed: false, path: 'both', brainOk: false, ping: 0, coderPick: '', local: false, who: 'keep', way: '', recovery: false, connect: 0, saved: null };

function suShow(step) {
  su.step = step;
  for (const sec of document.querySelectorAll('#setup [data-step]')) sec.hidden = Number(sec.dataset.step) !== step;
  $('#setup-step').textContent = su.recovery ? t('Connect a brain') : t('Step {step} of 4', { step });
  $('#su-back').hidden = su.recovery || step === 1 || step === 4;
  $('#su-skip').hidden = step === 4;
  $('#su-skip').textContent = su.recovery ? t('Cancel') : t('Set up later');
  // Phase 114 (F3): Next is the primary button everywhere. In Connect a brain it waits until a model
  // answered (or subscriptions open at the end); skipping is a quiet link, never the strong button.
  $('#su-next').textContent = su.recovery ? t('Use this model') : step === 4 ? t('Start talking') : t('Next');
  $('#su-next').disabled = step === 3 && !su.brainOk && !su.openSubs;
  $('#su-later').hidden = su.recovery || step !== 3 || su.brainOk;
  $('#su-recovery-note').hidden = !su.recovery;
  if (step === 4) suStepFour();
}

/** Phase 114 (F9): the three use cards of step 1. */
function suPathCards() {
  $('#su-path').replaceChildren(
    ...pathChoices(t).map((c) => {
      const b = el('button', 'pick-card su-path-card');
      b.type = 'button';
      b.dataset.path = c.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === su.path));
      b.append(el('span', 'su-path-icon', c.icon), el('strong', '', c.title), el('span', 'muted small', c.text));
      b.addEventListener('click', () => {
        su.path = c.id;
        for (const x of document.querySelectorAll('#su-path .su-path-card')) x.setAttribute('aria-checked', String(x === b));
      });
      return b;
    }),
  );
}

/**
 * Phase 114 (§5.2/§5.3): My subscription comes first, tagged, when no Ollama was found here
 * ("Easiest") or for a coder who is already signed in to one.
 */
function suOrderBrains() {
  const signed = Object.values(su.info?.subscriptions ?? {}).some(Boolean);
  const up = (su.path === 'coding' && signed) || !su.info?.ollama?.[0];
  const card = $('#su-ways [data-way="subs"]');
  const tag = $('#su-subs-tag');
  tag.hidden = !up;
  tag.textContent = signed ? t('Signed in ✓') : t('Easiest');
  if (up) $('#su-ways').prepend(card);
  else $('#su-ways').append(card);
}

/** Phase 114 (PL1c): the four ways to connect a brain are choice cards; the picked one opens its panel. */
function suWay(way) {
  su.way = way;
  for (const b of document.querySelectorAll('#su-ways .su-way')) {
    const on = b.dataset.way === way;
    b.setAttribute('aria-checked', String(on));
    $(`#${b.getAttribute('aria-controls')}`).hidden = !on;
  }
}

/** Phase 114 (PL1c, F7/F8): step 2's choice cards: keep her, a ready-made character, or make my own (Create your companion opens after setup). */
function suWhoCards() {
  const name = su.original?.name || 'Sara';
  const cards = [
    { id: 'keep', title: t('Keep {name}', { name }), text: t('She is ready to go; change anything later.') },
    { id: 'gallery', title: t('A ready-made character'), text: t('Pick from characters with their own personality.') },
    { id: 'new', title: t('Make my own'), text: t('✨ Create your companion opens after setup.') },
  ];
  $('#su-who').replaceChildren(
    ...cards.map((c) => {
      const b = el('button', 'pick-card su-who-card');
      b.type = 'button';
      b.dataset.who = c.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === su.who));
      const art = el('span', `su-who-art su-who-${c.id}`);
      art.setAttribute('aria-hidden', 'true');
      if (c.id === 'keep') {
        const img = el('img', 'su-who-face');
        img.src = $('#my-face')?.src || '/sara-portrait.jpg';
        img.alt = '';
        art.append(img);
      } else art.append(icon(c.id === 'new' ? 'sparkle' : 'group') ?? '');
      const title = el('strong', '', c.title);
      if (c.id === 'keep') title.dataset.raw = '';
      b.append(art, title, el('span', 'muted small', c.text));
      b.addEventListener('click', () => suWho(c.id));
      return b;
    }),
  );
}
function suWho(v) {
  su.who = v;
  for (const x of document.querySelectorAll('#su-who .su-who-card')) x.setAttribute('aria-checked', String(x.dataset.who === v));
  $('#su-new').hidden = v !== 'new';
  $('#su-gallery-box').hidden = v !== 'gallery';
  // Phase 51: ready-made characters to pick from.
  if (v === 'gallery' && !$('#su-gallery').childElementCount)
    void renderGallery($('#su-gallery'), {
      pick: (id, box) => {
        su.gallery = id;
        for (const c of box.querySelectorAll('.gallery-card')) c.classList.toggle('picked', c.dataset.id === id);
      },
    });
}

/** Phase 114 (F5/F6): the picked-for-you card: the model, why, where it runs, and its status chip. */
function suPicked(model) {
  $('#su-pick-name').textContent = model;
  const where = CLOUD_TAG.test(model) ? t('on Ollama Cloud') : su.local ? t('runs on this computer') : t('in the cloud');
  const why = model === su.coderPick ? t('good with code and tools') : t('a good all-rounder');
  const tags = [el('span', 'muted', ` · ${why} · ${where}`)];
  if (model === su.coderPick && su.path !== 'company') tags.push(el('span', 'su-chip su-chip-code', t('Good for coding')));
  $('#su-pick-tags').replaceChildren(...tags);
}
function suStatus(kind) {
  const chip = $('#su-status');
  chip.dataset.state = kind;
  chip.textContent = kind === 'ok' ? t('Connected ✓') : kind === 'checking' ? t('Checking it answers…') : kind === 'fail' ? t('No answer yet') : '';
}
/** Phase 114 (§5.2 step 3): done when the picked model answers a short test message. */
async function suPing() {
  const model = $('#su-model').value;
  const run = ++su.ping;
  su.brainOk = false;
  suStatus('checking');
  suShow(3);
  try {
    const r = await api('/model-jobs/test', { method: 'POST', body: { job: 'quick', providerId: su.provider, model } });
    if (run !== su.ping) return;
    if (!r.ok) throw new Error(r.error || t('It did not answer.'));
    su.brainOk = true;
    suStatus('ok');
    $('#su-error').textContent = '';
  } catch (err) {
    if (run !== su.ping) return;
    suStatus('fail');
    $('#su-error').textContent = `${err.message} ${su.recovery ? t('Pick another model with Change, or press Cancel.') : t('Pick another model with Change, or press Skip for now.')}`;
  }
  suShow(3);
}

/** Phase 114 (F2/F13): the last step: starter chips for the use choice and the check-in card folded in. */
function suStepFour() {
  const talks = Boolean(su.provider && su.brainOk) || Boolean(state.providers?.providers?.length);
  const chips = starterChips(su.path, 'wizard', t).filter((c) => talks || c.kind === 'page');
  $('#su-starters').replaceChildren(...chips.map((c) => starterButton(c, () => {
    su.starter = c;
    return suFinish();
  })));
  $('#su-starters-note').hidden = !chips.length;
  // Phase 121 (BEGIN §4.9): one quiet link under the chips; the gallery opens after the wizard closes.
  const rt = $('#su-routine');
  if (rt) rt.onclick = async () => {
    await suFinish();
    void openRoutines(su.path === 'coding' ? 'ci-watch' : 'morning-brief');
  };
  foldFirstRun($('#su-checkin'));
}

export async function openSetup(info) {
  su.recovery = false;
  su.openSubs = false;
  $('#su-subs').checked = false;
  su.info = info;
  $('#su-owner').value = info.ownerName ?? '';
  // M2: who she was before step 2, so Back + Keep can bring her back.
  su.original = (await api('/persona').catch(() => null))?.persona ?? null;
  su.changed = false;
  const presets = state.providers.presets.filter((p) => p.needsKey);
  $('#su-preset').replaceChildren(...presets.map((p) => new Option(p.label, p.id)));
  suShowLocal(info.ollama?.[0]);
  su.path = normPath(info.usePath);
  su.brainOk = false;
  su.provider = null;
  $('#su-model-row').hidden = true;
  suPathCards();
  suWhoCards();
  suWho('keep');
  suWay(info.ollama?.[0] ? 'local' : '');
  suShow(1);
  $('#setup').showModal();
  // Fresh pass: start in the name field (the dialog would otherwise focus "Set up later" and ring it).
  $('#su-owner').focus();
}

/** Reuse only the model step; owner identity and character are never revisited. */
export async function openModelSetup(info) {
  su.recovery = true;
  su.info = info;
  su.path = normPath(state.usePath);
  su.provider = null;
  su.brainOk = false;
  su.openSubs = false;
  su.ping++;
  su.connect++;
  su.closeRefresh = null;
  $('#su-subs').checked = false;
  $('#su-error').textContent = '';
  $('#su-status').textContent = '';
  $('#su-model-row').hidden = true;
  $('#su-preset').replaceChildren(...state.providers.presets.filter((p) => p.needsKey).map((p) => new Option(p.label, p.id)));
  suShowLocal(info.ollama?.[0]);
  suOrderBrains();
  suWay(info.ollama?.[0] ? 'local' : '');
  suShow(3);
  $('#setup').showModal();
}

async function suCancelRecovery() {
  $('#setup').close();
  await suRecoverClosed();
}

function suRecoverClosed() {
  if (su.closeRefresh) return su.closeRefresh;
  su.ping++;
  su.connect++;
  // Use it explicitly saves a connection. Cancel never changes its default or other settings.
  su.closeRefresh = (async () => {
    try {
      await loadProviders();
      ctx.refreshModelSettings?.();
    } catch (err) {
      $('#settings-error').textContent = err.message;
    }
  })();
  return su.closeRefresh;
}

// Phase 23: "On this computer": Ollama found here, or how to get it (then look again).
function suShowLocal(found) {
  const box = $('#su-found');
  box.hidden = !found;
  $('#su-local-none').hidden = Boolean(found);
  if (!found) return;
  suWay('local');
  // Phase 114 (F4): the models on that computer, counted as Models → On this computer counts them.
  const cloudToo = found.cloud ? ` ${t('It can use Ollama Cloud models too.')}` : '';
  box.replaceChildren(el('span', 'su-found-text', found.models ? `${found.models === 1 ? t('Found Ollama on this computer with 1 model.') : t('Found Ollama on this computer with {n} models.', { n: found.models })}${cloudToo}` : found.cloud ? t('Found Ollama on this computer with Ollama Cloud models only.') : t('Found Ollama on this computer, but it has no models yet: run ollama pull gemma3 there, then Look again.')));
  if (!found.models && !found.cloud) return;
  const go = el('button', '', t('Use it'));
  go.type = 'button';
  go.className = 'su-use-local';
  su.useLocal = go;
  go.addEventListener('click', () => suConnect({ id: 'ollama-local', label: t('Ollama on this computer'), kind: 'openai-compatible', baseUrl: found.url, local: true, needsKey: false }));
  box.append(go);
}

/**
 * 3.0.3: in the first-run guide the picked model is the default model from the moment it is picked
 * (the connection was already made the default), not only after its test answered and Next was
 * pressed: a slow first answer + Connect a brain later / Set up later left no default model.
 * Model recovery (su.recovery) still changes nothing until Use this model.
 */
function suSaveDefault(model) {
  if (su.recovery || !su.provider || !model) return Promise.resolve();
  const body = { defaultProviderId: su.provider, defaultModel: model };
  su.saved = (su.saved ?? Promise.resolve()).then(() => api('/settings', { method: 'PUT', body })).then(() => {
    Object.assign(state.providers, body);
  }, (err) => void ($('#su-error').textContent = err.message));
  return su.saved;
}

async function suConnect(config, apiKey) {
  const run = ++su.connect;
  ++su.ping;
  su.provider = null;
  $('#su-error').textContent = '';
  $('#su-model-row').hidden = true;
  su.brainOk = false;
  su.local = Boolean(config.local);
  suShow(3);
  try {
    // A recovery attempt must never replace an existing provider or its saved key.
    if (su.recovery) {
      let id = config.id;
      let n = 2;
      while (state.providers.providers.some((p) => p.id === id)) id = `${config.id}-${n++}`;
      config = { ...config, id };
    }
    await api(`/providers/${config.id}`, { method: 'PUT', body: { ...config, ...(su.recovery ? { preserveDefault: true } : {}), ...(apiKey ? { apiKey } : {}) } });
    if (run !== su.connect) return;
    await loadProviders();
    $('#su-model-note').textContent = t('Loading models…');
    $('#su-model-row').hidden = false;
    // Phase 114 (F4/F5): the same list and count as Models → Default model, in two groups (on this
    // computer, Ollama Cloud) with the pick first, instead of every raw tag in one long list.
    modelCache.delete(config.id);
    const view = await modelViewFor(config.id);
    if (run !== su.connect) return;
    const models = view.models;
    if (!models.length) throw new Error(t('Connected to {label}, but it has no models yet.', { label: config.label }));
    // Phase 114 (§5.3): for coding, the model Which model does what → Use recommended picks for code.
    const rec = su.path === 'company' ? null : (await api('/model-jobs/recommend').catch(() => null))?.picks?.coding;
    if (run !== su.connect) return;
    su.coderPick = rec && rec.providerId === config.id && models.includes(rec.model) ? rec.model : '';
    const pick = su.path === 'coding' && su.coderPick ? su.coderPick : suggestModel(models);
    fillModelOptions($('#su-model'), view, '', { pick });
    $('#su-model').value = pick;
    const counted = countWords(modelCounts(models), Boolean(config.local), t);
    $('#su-model-note').textContent = `${config.label}: ${counted}. ${models.length > 1 ? t('Any of them works; you can change it now or later.') : t('You can change it later.')}`;
    su.provider = config.id;
    await suSaveDefault(pick);
    if (run !== su.connect) return;
    suPicked(pick);
    $('#su-model-pick').hidden = true;
    $('#su-change').hidden = models.length < 2;
    // F6: the Use it button becomes a Connected chip.
    if (config.id === 'ollama-local') su.useLocal?.replaceWith(el('span', 'su-chip', t('Connected ✓')));
    suShow(3);
    $('#su-model-row').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    await suPing();
  } catch (err) {
    if (run !== su.connect) return;
    $('#su-model-row').hidden = true;
    $('#su-error').textContent = err.message;
    suShow(3);
  }
}

async function suFinish() {
  await api('/setup/done', { method: 'POST', body: {} });
  // Phase 114 (F2): the check-in card goes back where it lives (seen; it doesn't come again).
  unfoldFirstRun();
  state.usePath = su.path;
  $('#setup').close();
  await loadProviders();
  await loadConversations();
  setChatTitle(); // M3: the header shows the character picked in setup
  // Phase 114 (F1): Today under the wizard shows the name and the brain just set up (what Refresh does).
  if (todayOpen()) await Promise.all([loadToday(true), loadChecklist()]).catch(() => undefined);
  const starter = su.starter;
  su.starter = null;
  if (su.openSubs) openSettings('models');
  else if (!state.providers.providers.length) openSettings('models');
  // Phase 114 (PL1c, F8): "Make my own" is the one make-her flow, ✨ Create your companion.
  else if (su.who === 'new') await openWizard().catch((err) => void ($('#su-error').textContent = err.message));
  else {
    if (!state.messages?.length) renderMessages([]);
    // Phase 114 (F2): the tour is offered after her first reply, never on top of something else.
    queueTourOffer();
    if (starter) await runStarter(starter);
  }
  firstRun.pump();
}


/** Called by app.js where this code used to be, so everything runs in the same order as before. */
export function initSetupWizard(c) {
  ctx = c;
  ({ state, firstRun, modelCache } = c);
  for (const b of document.querySelectorAll('#su-ways .su-way')) b.addEventListener('click', () => suWay(b.dataset.way));
  $('#su-change').addEventListener('click', () => {
    $('#su-model-pick').hidden = false;
    $('#su-change').hidden = true;
    $('#su-model').focus();
  });
  $('#su-model').addEventListener('change', () => {
    suPicked($('#su-model').value);
    void suSaveDefault($('#su-model').value);
    void suPing();
  });
  $('#su-rescan').addEventListener('click', async () => {
    $('#su-rescan').disabled = true;
    $('#su-rescan').textContent = t('Looking…');
    try {
      const info = await api('/setup?detect');
      suShowLocal(info.ollama?.[0]);
      if (!info.ollama?.[0]) $('#su-rescan').textContent = t('Not found yet. Look again');
    } catch (err) {
      $('#su-rescan').textContent = err.message;
    } finally {
      $('#su-rescan').disabled = false;
    }
  });

  $('#su-subs').addEventListener('change', () => {
    su.openSubs = $('#su-subs').checked;
    suShow(su.step);
  });
  $('#su-key-go').addEventListener('click', () => {
    const preset = state.providers.presets.find((p) => p.id === $('#su-preset').value);
    const key = $('#su-key').value.trim();
    if (!preset || !key) return ($('#su-error').textContent = t('Pick the service and paste its key.'));
    suConnect(preset, key);
  });
  $('#su-host-go').addEventListener('click', () => {
    let h = $('#su-host').value.trim().replace(/\/+$/, '');
    if (!h) return ($('#su-error').textContent = t("Type that computer's address."));
    if (!/^https?:\/\//.test(h)) h = `http://${h}`;
    if (!/:\d+$/.test(new URL(h).host)) h = `${h}:11434`;
    suConnect({ id: 'ollama-pc', label: t('Ollama on my computer'), kind: 'openai-compatible', baseUrl: `${h}/v1`, local: true, needsKey: false });
  });
  $('#su-back').addEventListener('click', async () => {
    // M2: back to step 2 undoes the character picked there (Next picks it again), so Keep means the original.
    if (su.step === 3 && su.changed && su.original) {
      const r = await api('/persona', { method: 'PUT', body: su.original }).catch((err) => void ($('#su-error').textContent = err.message));
      if (r) {
        su.changed = false;
        setIdentity(r.persona);
        setChatTitle();
      }
    }
    suShow(Math.max(1, su.step - 1));
  });
  // L14: Enter in the name boxes goes on, like Next.
  for (const id of ['#su-owner'])
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      $('#su-next').click();
    });
  $('#su-skip').addEventListener('click', () => su.recovery ? suCancelRecovery() : suFinish());
  $('#setup').addEventListener('cancel', (e) => {
    if (!su.recovery) return;
    e.preventDefault();
    void suCancelRecovery();
  });
  $('#setup').addEventListener('close', () => {
    // Includes the shared dialog handler's backdrop close.
    if (su.recovery && !$('#setup').open) return suRecoverClosed();
    su.ping++;
    su.connect++;
  });
  // Phase 114 (F3): Connect a brain later (Getting started keeps the step).
  $('#su-later').addEventListener('click', () => {
    $('#su-done-title').textContent = t('Almost there');
    suShow(4);
  });
  $('#su-next').addEventListener('click', async () => {
    $('#su-error').textContent = '';
    try {
      if (su.recovery) {
        if (su.openSubs) {
          await suCancelRecovery();
          return ctx.openSubscriptions();
        }
        if (!su.provider || !su.brainOk || !$('#su-model').value) return;
        await api('/settings', { method: 'PUT', body: { defaultProviderId: su.provider, defaultModel: $('#su-model').value } });
        await suCancelRecovery();
        return;
      }
      if (su.step === 1) {
        const name = $('#su-owner').value.trim();
        if (!name) return ($('#su-error').textContent = t('Type your name so Sara knows what to call you (or press Set up later).'));
        // Phase 114 (F9): the use choice is saved with the name (for this companion; About you changes it).
        await api('/settings', { method: 'PUT', body: { ownerName: name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, usePath: su.path } });
        state.usePath = su.path;
        suOrderBrains();
        return suShow(2);
      }
      if (su.step === 2) {
        if (su.who === 'gallery') {
          if (!su.gallery) return ($('#su-error').textContent = t('Pick a character (or choose Keep).'));
          const g = (await galleryList()).find((x) => x.id === su.gallery);
          const r = await api('/character/import', { method: 'POST', body: { file: g.file, look: false, voice: false } });
          setIdentity(r.persona);
          su.changed = true;
        }
        setChatTitle();
        return suShow(3);
      }
      if (su.step === 3) {
        if (su.provider && $('#su-model').value) await api('/settings', { method: 'PUT', body: { defaultProviderId: su.provider, defaultModel: $('#su-model').value } });
        $('#su-done-title').textContent = (su.provider && su.brainOk ? t('All set. Say hi to Sara!') : t('Almost there'));
        return suShow(4);
      }
      await suFinish();
    } catch (err) {
      $('#su-error').textContent = err.message;
    }
  });
}
