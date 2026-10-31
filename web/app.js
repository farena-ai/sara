// Sara web client (no build step).
import { Call, Mic, Speaker } from './voice.js';
import { LiveCall } from './live.js';
import { VideoCallView } from './video-call.js';
import { parse as parseMd, toDom } from './markdown.js';
import { Presence, setLookVersion } from './presence.js';
import { openLightbox } from './lightbox.js';
import { browserLang, currentIdentity, currentLang, locale, savedLang, setIdentity, setLanguage, serverText, t, toLang, translateOnly } from './naming.js';
import { autoSave, initDialogs, markDirty, onSave, runSave, saved } from './dialogs.js';
import { endTour, startTour, tourRunning } from './tour.js';
import { isDocFile, loadLibrarySettings, openLibrary, saveLibrarySettings, uploadDoc, waitRead } from './library.js';
import { initProjectMap, resetProjectMap } from './codemap.js';
import { initSkills, loadSkills, skillApproval } from './skills.js';
import { initLearning, learnCard, loadLearning } from './learned-skills.js';
import { initPlugins, loadPlugins, pluginAskLine, pluginNotice, pluginResultCard, pluginStepWords } from './plugins.js';
import { initAgents, loadAgents } from './agents.js';
import { hookNotice, initHooks, loadHooks } from './hooks.js';
import { boardEvent, initBoard, openCardOnBoard, plannerView, rememberView } from './board.js';
import { agendaEvent, agendaNotice, agendaWhy, initAgenda, loadAgenda, renderPlansTile } from './agenda.js';
import { initPeople, peopleEvent, peopleOnOpen, showPerson } from './people.js';
import { initOtherApps, keyUse, loadOtherApps } from './other-apps.js';
import { initAlexa, loadAlexa } from './alexa.js';
import { initSsh, loadSsh } from './ssh.js';
import { initPresence, loadPresence } from './home-presence.js';
import { initCards } from './cards.js';
import { initImport, loadImport } from './import.js';
import { initLocalModels, loadLocalModels, setPrivateBadge } from './local-models.js';
import { faceUrl, groupTag, initGroups, isGroup, openGroupDialog, showGroupButton, speakerHeader } from './group.js';
import { appLink, inPhoneApp, phoneKind } from './pair-link.js';
import { addToMomentsButton, initMoments, loadMoments, openMoments, renderTodayMoments, renderTodayPhotos } from './moments.js';
import { closeToday, initToday, renderTodayTiles, showToday, todayOpen } from './today.js';
import { initBottomBar } from './bottom-bar.js';
import { startsOnToday } from './start-view.js';
import { DISMISS_KEY, SEEN_KEY, reloadNow, shouldCheck, shouldRemind, updatedNote, updatesShown, versionChanged } from './update-check.js';
import { initHousehold, joinFromLink, loadAccount, loadHousehold, showPaused } from './household.js';
import { initNav, relabelNav, revealNav, setMore } from './nav.js';
import { emptyState, initTidy, overflowMenu } from './tidy.js';
import { addStep, finishStep, hasSteps, memoryStep, pluginStep, recallStep, runLink, runStep, setBudget, skillStep, stepLine, waitStep } from './steps.js';
import { budgetCard, budgetMeter, fillBudgetSelect, overrideNote } from './budget-view.js';
import { sandboxButtons, sandboxFirstNote, sandboxFlag, sandboxSection, teamSandboxRow } from './sandbox-view.js';
import { advisoryFlag, advisorySection, initFindings, openFindings, openRedTeam, redteamFlag, redteamGateSection, refreshFindings, securityCard, threatCard } from './findings-view.js';
import { openRunView } from './run-view.js';
import { recallChip, recallKindWords } from './recall-view.js';
import { initEvals, onEvalEvent, openEvals } from './evals-view.js';
import { renderCard, renderCards } from './result-cards.js';
import { gmailApproval, gmailQuestion } from './gmail-view.js';
import { initLook, setContextRing, setLookBusy, showHeadChips } from './look.js';
import { closePanel, initHerPanel, openPanel, panelConv, panelFace, panelJobs, panelMessages, panelMood, panelNow, panelOpen, togglePanel } from './her-panel.js';
import { initCommandBar, openCommandBar, score as cmdScore } from './command-bar.js';
import { icon, paintIcons, setIcon, TOOL_ICONS } from './icons.js';
import { ring as progressRing, share as shareOf } from './viz.js';
/** Phase 71: a household member (their own space; owner-only pages and loaders are left out). */
const isMember = () => document.body.classList.contains('member');
const $ = (sel) => document.querySelector(sel);

// 2.8: the chrome's line icons (web/icons.js) go in before anything reads or moves those buttons, and the
// aurora behind the app rests while nobody can see it (a hidden tab).
paintIcons(document);
const markHidden = () => document.documentElement.classList.toggle('page-hidden', document.visibilityState === 'hidden');
document.addEventListener('visibilitychange', markHidden);
markHidden();

const state = {
  conversations: [],
  currentId: null,
  providers: { presets: [], providers: [], defaultProviderId: null, defaultModel: null },
  streaming: null,
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (opts.raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { data, status: res.status });
  return data;
}

// Phase 24: WebAuthn needs bytes; the server speaks base64url.
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)),
};
const passkeysWork = () => Boolean(window.PublicKeyCredential) && window.isSecureContext && !navigator.userAgent.includes('SaraPhone/');

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// ---------- boot ----------
// The access QR (just the server address) opens this sign-in page on a phone: offer Sara's app
// first, with this server filled in (pair-link.js). Inside the phone app: point to the code page.
function offerPhoneApp(session) {
  const ua = navigator.userAgent;
  let gaveUp = false; // Android's fallback page said the app isn't installed (this tab only)
  try {
    gaveUp = sessionStorage.getItem('sara.noApp') === '1';
  } catch {
    /* private mode */
  }
  // iPhone: no app button until the app is in the App Store (IOS_APP_URL in pair-link.js).
  const kind = session.demo || gaveUp ? null : phoneKind(ua, navigator.maxTouchPoints);
  const link = kind ? appLink(kind, location.origin) : null;
  $('#login-app-block').hidden = !link;
  if (link) {
    $('#login-app').href = link;
    $('#login-app-note').textContent = t('The app opens with this server filled in; sign it in there with a code from Settings → Devices and sign-in.');
  }
  $('#login-paircode').hidden = Boolean(session.demo) || !(inPhoneApp(ua) || phoneKind(ua, navigator.maxTouchPoints));
}
let langReady;
async function boot() {
  // Phase 53: the page speaks the last language used on this device until the owner's pick is known.
  langReady ??= setLanguage(savedLang());
  await langReady;
  const session = await api('/session');
  $('#disclosure-text').textContent = session.disclosure;
  // Demo server (Phase 16): try it without signing in; demo-only parts of the app are hidden.
  document.body.classList.toggle('demo', Boolean(session.demo));
  $('#demo-start').hidden = $('#demo-note').hidden = !session.demo;
  $('#login-help').hidden = Boolean(session.demo);
  $('#demo-bar').hidden = !session.demo;
  $('#login-passkey').hidden = !(session.passkeys && passkeysWork());
  if (session.demo) $('#login-intro').textContent = t('Have a sign-in token (for example for app review)? Enter it here. Or just try the demo.');
  if (!session.authenticated && session.demo && /[?&]demo=1/.test(location.search)) {
    await api('/demo/start', { method: 'POST', body: {} }).catch(() => {});
    history.replaceState(null, '', '/');
    return boot();
  }
  if (!session.authenticated) {
    offerPhoneApp(session);
    showClaim(session.claim);
    // Phase 71: joining a household with an invite (not on the demo server).
    $('#join-open').hidden = Boolean(session.demo);
    if (!session.demo) joinFromLink();
    return show('login');
  }
  // Phase 71: the owner, or a household member in their own space.
  document.body.classList.toggle('member', session.role === 'member');
  buildSettingsNav(); // the nav was built before we knew who signed in: owner or member pages
  if (session.role === 'member' && session.member?.status !== 'active') return showPaused(session.member);
  const langChanged = await applyLanguage(session.language, session.appLanguage);
  setIdentity(session.identity);
  // Phase 68: the apps name this server after her (until renamed) and show the server switcher.
  void serversSignedIn(session.identity?.name);
  // Phase 67: the header shows when nothing may leave this computer.
  setPrivateBadge(Boolean(session.privateLocal));
  void loadCompanions();
  if (!session.disclosureAccepted) {
    // The AI notice is written by the server in the owner's language: fetch it again if that just changed.
    if (langChanged) $('#disclosure-text').textContent = (await api('/session').catch(() => session)).disclosure;
    return show('disclosure');
  }
  show('main');
  // Phone apps: the owner is signed in, so the app can save its widget sign-in and set up
  // notifications (iPhone).
  window.SaraPhone?.ready?.();
  // 2.18: "Sara was updated to X", the on-open update check and the version watch (web/update-check.js).
  initUpdates(session);
  startEvents();
  void api('/settings').then((s) => applyAdminHelp(s.admin), () => {});
  await Promise.all([loadConversations(), loadProviders()]);
  // 2.7.1: Today first, unless a link says where to go (web/start-view.js). Read before the
  // conversation link below is taken out of the address.
  const onToday = startsOnToday({ hash: location.hash, answering: Boolean(sessionStorage.getItem('sara.answer')), wizard: sessionStorage.getItem('sara.openWizard') === '1', demo: Boolean(session.demo) });
  // Opened from a notification: /#c=<conversation id>.
  const fromLink = /#c=([\w-]+)/.exec(location.hash)?.[1];
  if (fromLink) history.replaceState(null, '', '/');
  if (fromLink && (await openElsewhere(fromLink))) return;
  const first = state.conversations.find((c) => c.id === fromLink) ?? state.conversations.find((c) => !c.archivedAt) ?? state.conversations.find((c) => !String(c.channel ?? '').startsWith('import-'));
  if (first) await openConversation(first.id);
  else {
    $('#chat-title').textContent = t('Sara');
    renderMessages([]);
  }
  // The last conversation stays open underneath: Chat is one tap away.
  if (onToday) void openToday();
  if (session.adultAsk) $('#adult-ask').showModal();
  const setup = await api('/setup').catch(() => ({ done: true }));
  if (!setup.done) openSetup(setup);
  else if (!state.providers.providers.length) openSettings('models');
  else if (!tourFromHash()) setTimeout(offerFirstTour, 4000);
  refreshSaraStatus();
  setInterval(refreshSaraStatus, 5 * 60_000);
  // 2.18: the update check starts once the first-run windows (setup, the tour offer) had their turn.
  startUpdateChecks();
  initVoice();
  // Opened while she's ringing (e.g. from the "Sara is calling" notification): show the call.
  const answer = JSON.parse(sessionStorage.getItem('sara.answer') ?? 'null');
  sessionStorage.removeItem('sara.answer');
  api('/calls').then((d) => {
    if (d.ring?.state !== 'ringing') return;
    // Switched here to answer her call (Phase 31): answer straight away.
    if (answer?.ringId === d.ring.id) return window.saraAnswerRing(answer.ringId, answer.conversationId);
    onRing(d.ring);
  }, () => {});
}

/**
 * Phase 53: the owner's language pick ('auto' = this browser's language). While it's Automatic, the
 * server learns the browser language (for the AI notice and her replies) when it changed.
 */
/** M3: with no conversation open the header shows her (current) name. */
function setChatTitle() {
  if (!state.currentId) $('#chat-title').textContent = t('Sara');
}

async function applyLanguage(pick, serverLang) {
  const auto = !pick || pick === 'auto';
  const want = auto ? browserLang() : toLang(pick) ?? 'en';
  if (want !== currentLang()) await setLanguage(want);
  if (auto && serverLang !== undefined && serverLang !== want) {
    // Awaited so the AI notice that follows comes in this language.
    await api('/settings', { method: 'PUT', body: { languageDetected: want } }).catch(() => {});
    return true;
  }
  return false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const code = $('#login-code').hidden ? undefined : $('#login-code').value.trim();
    await api('/login', { method: 'POST', body: { token: $('#login-token').value.trim(), ...(code ? { code } : {}) } });
    $('#login-token').value = '';
    $('#login-code').value = '';
    $('#login-code').hidden = true;
    await boot();
  } catch (err) {
    // Phase 24: two-step sign-in asks for the authenticator code next.
    if (err.data?.twoStep) {
      $('#login-code').hidden = false;
      $('#login-code').value = '';
      $('#login-code').focus();
    }
    $('#login-error').textContent = err.message;
  }
});

// Phase 24: passkey sign-in.
$('#login-passkey').addEventListener('click', async () => {
  $('#login-error').textContent = '';
  try {
    const o = await api('/passkey/signin-options', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64u.dec(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout, allowCredentials: [] } });
    if (!cred) return;
    await api('/passkey/signin', {
      method: 'POST',
      body: { id: cred.id, clientDataJSON: b64u.enc(cred.response.clientDataJSON), authenticatorData: b64u.enc(cred.response.authenticatorData), signature: b64u.enc(cred.response.signature) },
    });
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.name === 'NotAllowedError' ? t('Passkey sign-in was cancelled.') : err.message;
  }
});

// ---------- Phase 59: first sign-in in the browser (a new server, src/claim.ts) ----------
function showClaim(c) {
  const box = $('#claim');
  box.hidden = !c || (!c.open && !c.closed);
  if (box.hidden) {
    if (box.dataset.shown) $('#login-intro').textContent = t('Enter the owner token printed in the server log on first start.');
    delete box.dataset.shown;
    return;
  }
  box.dataset.shown = '1';
  const browser = c.mode === 'browser';
  $('#claim-code-row').hidden = $('#claim-help').hidden = browser || !c.open;
  $('#claim-go').hidden = !c.open;
  $('#claim-intro').textContent = browser
    ? t('This server has no owner yet. Your server already checked who you are, so one click makes you her owner.')
    : t('This server has no owner yet. Enter the setup code from her log to become her owner.');
  $('#claim-closed').hidden = c.open;
  $('#claim-closed').textContent = c.closed === 'locked' ? t('Too many wrong setup codes. Restart Sara for a new code, or sign in with the owner token from her log.') : t('Setup in the browser has timed out. Restart Sara to open it again (with a new setup code), or sign in with the owner token from her log.');
  $('#login-intro').textContent = t('Already have the owner token? Enter it here.');
}
async function claimServer() {
  $('#login-error').textContent = '';
  const code = $('#claim-code-row').hidden ? undefined : $('#claim-code').value.trim();
  if (code === '') {
    $('#login-error').textContent = t('Enter the setup code from her log.');
    return $('#claim-code').focus();
  }
  try {
    const { token } = await api('/claim', { method: 'POST', body: code ? { code } : {} });
    $('#claim-code').value = '';
    $('#claimed-token').textContent = token;
    $('#claimed-saved').checked = false;
    $('#claimed-done').disabled = true;
    show('claimed');
  } catch (err) {
    $('#login-error').textContent = err.message;
    // Setup may have closed meanwhile (timed out, too many codes): show why.
    api('/claim').then((c) => c.open || showClaim(c.closed ? c : null), () => {});
  }
}
$('#claim-go').addEventListener('click', claimServer);
$('#claim-code').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  claimServer();
});
$('#claimed-copy').addEventListener('click', () => copyText($('#claimed-token').textContent, $('#claimed-copy')));
$('#claimed-saved').addEventListener('change', () => {
  $('#claimed-done').disabled = !$('#claimed-saved').checked;
});
$('#claimed-done').addEventListener('click', async () => {
  $('#claimed-token').textContent = '';
  await boot();
});

$('#disclosure-accept').addEventListener('click', async () => {
  await api('/disclosure/accept', { method: 'POST', body: {} });
  await boot();
});

$('#demo-start').addEventListener('click', async () => {
  try {
    await api('/demo/start', { method: 'POST', body: {} });
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} });
  show('login');
});

// ---------- conversations ----------
async function loadConversations() {
  const [convs] = await Promise.all([api('/conversations'), loadProjects()]);
  state.conversations = convs;
  renderConversations();
}

// ---------- conversation list: projects, no project, archived ----------
const collapsed = new Set(JSON.parse(localStorage.getItem('sara.collapsed') ?? '[]'));
const saveCollapsed = () => localStorage.setItem('sara.collapsed', JSON.stringify([...collapsed]));

async function loadProjects() {
  try {
    state.projects = await api('/projects');
  } catch {
    state.projects = [];
  }
}

function convRow(c) {
  const a = document.createElement('a');
  a.href = '#';
  a.className = `conv${c.id === state.currentId ? ' active' : ''}`;
  a.draggable = true;
  a.dataset.id = c.id;
  const title = el('span', 'conv-title', c.title);
  a.append(title);
  // Phase 66: a group chat shows who's in it.
  if (isGroup(c)) a.append(el('span', 'channel-tag group-tag', groupTag(c)));
  else if (c.channel && c.channel !== 'web') a.append(el('span', 'channel-tag', c.partner ? `${c.channel} · ${c.partner}` : c.channel));
  if (c.offRecord) {
    a.classList.add('offrecord');
    title.prepend('🕶 ');
  }
  if (c.working) {
    const dot = el('span', 'working-dot');
    dot.title = t('Sara is working here');
    a.prepend(dot);
  }
  const more = el('button', 'conv-more ghost', '⋯');
  more.type = 'button';
  more.title = t('Move, archive or delete');
  more.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    convMenu(c, more);
  });
  a.append(more);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    $('#main').classList.remove('show-sidebar');
    openConversation(c.id);
  });
  a.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/sara-conv', c.id));
  return a;
}

function group(key, label, convs, opts = {}) {
  const box = el('div', 'conv-group');
  const head = el('div', 'group-head');
  const isCollapsed = collapsed.has(key);
  const toggle = el('button', 'group-toggle', `${isCollapsed ? '▸' : '▾'} ${label}`);
  toggle.type = 'button';
  toggle.append(el('small', 'muted', ` ${convs.length}`));
  toggle.addEventListener('click', () => {
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    saveCollapsed();
    renderConversations();
  });
  head.append(toggle);
  for (const b of opts.buttons ?? []) head.append(b);
  box.append(head);
  if (opts.dropProject !== undefined) {
    head.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/sara-conv')) {
        e.preventDefault();
        head.classList.add('drop');
      }
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop'));
    head.addEventListener('drop', async (e) => {
      e.preventDefault();
      head.classList.remove('drop');
      const id = e.dataTransfer.getData('text/sara-conv');
      if (id) await moveConversation(id, { projectId: opts.dropProject, archived: false });
    });
  }
  if (!isCollapsed) {
    if (!convs.length && opts.empty) box.append(el('p', 'muted small group-empty', opts.empty));
    for (const c of convs) box.append(convRow(c));
  }
  return box;
}

function smallBtn(label, title, fn) {
  const b = el('button', 'ghost small group-btn', label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function renderTagFilter() {
  const counts = new Map();
  for (const c of state.conversations) for (const tg of c.tags ?? []) counts.set(tg, (counts.get(tg) ?? 0) + 1);
  if (state.tagFilter && !counts.has(state.tagFilter)) state.tagFilter = null;
  const box = $('#tag-filter');
  box.hidden = !counts.size;
  box.replaceChildren(
    ...[...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tg, n]) => {
        const b = el('button', `tag-chip${state.tagFilter === tg ? ' on' : ''}`, `#${tg}`);
        b.type = 'button';
        b.title = state.tagFilter === tg ? t('Show all conversations') : t('Show only #{tg} ({n})', { tg, n });
        b.addEventListener('click', () => {
          state.tagFilter = state.tagFilter === tg ? null : tg;
          renderConversations();
        });
        return b;
      }),
  );
}

function renderConversations() {
  renderTagFilter();
  if ($('#conv-search')?.value.trim()) return void runSearch();
  const nav = $('#conversations');
  const all = state.tagFilter ? state.conversations.filter((c) => c.tags?.includes(state.tagFilter)) : state.conversations;
  const live = all.filter((c) => !c.archivedAt);
  const archived = all.filter((c) => c.archivedAt);
  const projects = (state.projects ?? []).filter((p) => p.status === 'active');
  const known = new Set(projects.map((p) => p.id));
  const groups = projects.map((p) =>
    group(`p${p.id}`, p.name, live.filter((c) => c.projectId === p.id), {
      dropProject: p.id,
      empty: t('Empty: drag a conversation here, or press +.'),
      buttons: [smallBtn('+', t('New conversation in {name}', { name: p.name }), () => newConversation(p.id)), smallBtn('▤', t('Project page: conversations, to-dos, notes and files'), () => openProjectPage(p.id))],
    }),
  );
  const loose = live.filter((c) => c.projectId === null || !known.has(c.projectId));
  const parts = [...groups, group('none', projects.length ? t('No project') : t('Conversations'), loose, { dropProject: null })];
  if (archived.length) parts.push(group('archived', t('Archived'), archived));
  if (!collapsed.has('archived-init')) {
    collapsed.add('archived');
    collapsed.add('archived-init');
    saveCollapsed();
  }
  nav.replaceChildren(...parts);
}

// Phase 22: tags.
const tagsEdit = { conv: null, tags: [] };
async function openTags(c) {
  tagsEdit.conv = c;
  tagsEdit.tags = [...(c.tags ?? [])];
  $('#tags-status').textContent = '';
  const { tags } = await api('/tags').catch(() => ({ tags: [] }));
  tagsEdit.known = tags.map((x) => x.tag);
  renderTagChips();
  $('#tags-dialog').showModal();
}
function renderTagChips() {
  const all = [...new Set([...tagsEdit.tags, ...(tagsEdit.known ?? [])])];
  $('#tags-chips').replaceChildren(
    ...all.map((tg) => {
      const on = tagsEdit.tags.includes(tg);
      const b = el('button', `chip${on ? ' on' : ''}`, `#${tg}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => {
        tagsEdit.tags = on ? tagsEdit.tags.filter((x) => x !== tg) : [...tagsEdit.tags, tg];
        renderTagChips();
      });
      return b;
    }),
  );
  if (!all.length) $('#tags-chips').append(el('p', 'muted small', t('No tags yet: add one below.')));
}
$('#tags-add').addEventListener('click', () => {
  const tg = $('#tags-new').value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!tg) return;
  if (!tagsEdit.tags.includes(tg)) tagsEdit.tags.push(tg);
  $('#tags-new').value = '';
  renderTagChips();
});
$('#tags-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#tags-add').click();
  }
});
$('#tags-save').addEventListener('click', async () => {
  try {
    await moveConversation(tagsEdit.conv.id, { tags: tagsEdit.tags });
    saved($('#tags-dialog'));
  } catch (err) {
    $('#tags-status').textContent = err.message;
  }
});

async function moveConversation(id, patch) {
  const updated = await api(`/conversations/${id}`, { method: 'PATCH', body: patch });
  state.conversations = state.conversations.map((c) => (c.id === id ? { ...c, ...updated } : c));
  if (state.conv?.id === id) state.conv = { ...state.conv, ...updated };
  await loadProjects();
  renderConversations();
}

function closeMenus() {
  for (const m of document.querySelectorAll('.pop-menu')) m.remove();
}
document.addEventListener('click', closeMenus);

function convMenu(c, anchor) {
  closeMenus();
  const menu = el('div', 'pop-menu');
  const item = (label, fn, cls = '') => {
    const b = el('button', `pop-item ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenus();
      await fn();
    });
    menu.append(b);
  };
  menu.append(el('div', 'pop-label', t('Move to')));
  for (const p of (state.projects ?? []).filter((x) => x.status === 'active')) if (p.id !== c.projectId) item(`📁 ${p.name}`, () => moveConversation(c.id, { projectId: p.id }));
  if (c.projectId !== null) item(t('No project'), () => moveConversation(c.id, { projectId: null }));
  item(t('+ New project…'), () => openProjectDialog(null, c.id));
  menu.append(el('hr'));
  if (isGroup(c)) item(t('Group chat settings…'), () => openGroupDialog(c));
  item(t('Rename…'), async () => {
    const title = prompt(t('Rename conversation'), c.title)?.trim();
    if (!title || title === c.title) return;
    await moveConversation(c.id, { title });
    if (state.conv?.id === c.id) $('#chat-title').textContent = title;
  });
  if (!c.offRecord) item(c.tags?.length ? `Tags (${c.tags.map((x) => `#${x}`).join(' ')})…` : t('Tags…'), () => openTags(c));
  item(c.archivedAt ? t('Unarchive') : t('Archive'), () => moveConversation(c.id, { archived: !c.archivedAt }));
  item(t('Delete…'), () => openDeleteDialog(c), 'danger-text');
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
}

async function newConversation(projectId = null, offRecord = false) {
  if (todayOpen()) closeToday({ focus: false });
  const conv = await api('/conversations', { method: 'POST', body: offRecord ? { offRecord: true } : projectId ? { projectId } : {} });
  state.conversations.unshift(conv);
  if (projectId) collapsed.delete(`p${projectId}`);
  state.currentId = conv.id;
  state.conv = conv;
  renderConvSummary();
  $('#chat-title').textContent = conv.title;
  renderConversations();
  renderMessages([]);
  $('#input').focus();
}

// Project dialog (new / edit). `thenMove` files a conversation into a newly created project.
let projectEditing = null;
let projectThenMove = null;
function openProjectDialog(p, thenMove = null) {
  projectEditing = p;
  projectThenMove = thenMove;
  $('#pd-title').textContent = p ? t('Project') : t('New project');
  $('#pd-name').value = p?.name ?? '';
  $('#pd-workspace').value = p?.workspace ?? '';
  $('#pd-error').textContent = '';
  $('#pd-delete').hidden = !p;
  $('#pd-archive').hidden = !p;
  $('#project-dialog').showModal();
  $('#pd-name').focus();
}
$('#new-project').addEventListener('click', () => openProjectDialog(null));
$('#pd-save').addEventListener('click', async () => {
  $('#pd-error').textContent = '';
  const body = { name: $('#pd-name').value.trim(), workspace: $('#pd-workspace').value.trim() || null };
  try {
    const p = projectEditing ? await api(`/projects/${projectEditing.id}`, { method: 'PATCH', body }) : await api('/projects', { method: 'POST', body });
    if (projectEditing) {
      projectEditing = p;
      saved($('#project-dialog'));
    } else $('#project-dialog').close();
    if (projectThenMove) await moveConversation(projectThenMove, { projectId: p.id });
    await loadProjects();
    renderConversations();
  } catch (err) {
    $('#pd-error').textContent = err.message;
  }
});
$('#pd-archive').addEventListener('click', async () => {
  if (!projectEditing) return;
  if (!confirm(t('Archive "{name}"? Its conversations move to No project; its to-dos and notes stay in the Planner.', { name: projectEditing.name }))) return;
  for (const c of state.conversations.filter((x) => x.projectId === projectEditing.id)) await api(`/conversations/${c.id}`, { method: 'PATCH', body: { projectId: null } });
  await api(`/projects/${projectEditing.id}`, { method: 'PATCH', body: { status: 'archived' } });
  $('#project-dialog').close();
  await loadConversations();
});
$('#pd-delete').addEventListener('click', async () => {
  if (!projectEditing) return;
  if (!confirm(t('Delete the project "{name}"? Nothing else is deleted: its conversations move to No project and its to-dos stay (without a project).', { name: projectEditing.name }))) return;
  await api(`/projects/${projectEditing.id}`, { method: 'DELETE' });
  $('#project-dialog').close();
  await loadConversations();
});

// Delete dialog.
let deleting = null;
async function openDeleteDialog(c) {
  deleting = c;
  $('#dc-title').textContent = c.title;
  $('#dc-forget').checked = false;
  $('#dc-count').textContent = '';
  $('#delete-conv').showModal();
  try {
    const { count } = await api(`/conversations/${c.id}/memories`);
    $('#dc-count').textContent = count ? t('(memories from it: {n})', { n: count }) : t('(nothing saved from it yet)');
  } catch {
    /* ignore */
  }
}
$('#dc-archive').addEventListener('click', async () => {
  $('#delete-conv').close();
  if (deleting) await moveConversation(deleting.id, { archived: true });
});
$('#dc-delete').addEventListener('click', async () => {
  if (!deleting) return;
  await api(`/conversations/${deleting.id}${$('#dc-forget').checked ? '?forget=1' : ''}`, { method: 'DELETE' });
  $('#delete-conv').close();
  state.conversations = state.conversations.filter((c) => c.id !== deleting.id);
  if (state.currentId === deleting.id) {
    const next = state.conversations.find((c) => !c.archivedAt);
    if (next) await openConversation(next.id);
    else {
      state.currentId = null;
      state.conv = null;
      renderMessages([]);
    }
  }
  renderConversations();
});

// Phase 22: long conversations load in pages (the latest PAGE messages; earlier ones on demand).
const PAGE = 150;
async function openConversation(id) {
  if (todayOpen()) closeToday({ focus: false });
  stopWatching();
  const conv = await api(`/conversations/${id}?limit=${PAGE}`);
  // Phase 49: another conversation's app preview doesn't stay open beside this one.
  if (id !== state.currentId && state.previewUrl) closePreview();
  state.currentId = conv.id;
  $('#chat-title').textContent = conv.title;
  state.conv = conv;
  renderConvSummary();
  renderConversations();
  renderMessages(conv.messages, { busy: Boolean(conv.activity) });
  renderPins();
  if (conv.activity && !state.streaming) watchConversation(conv);
  void loadJobs();
  void updateConvUsage();
  // Phase 37: an activity you're doing together here.
  if (conv.together && !together.data) together.data = await api('/together').catch(() => null);
  renderTogetherBar();
}

/** Loads the next page of earlier messages, keeping the view where it was. */
async function loadEarlier() {
  if (state.loadingEarlier || !state.conv?.earlier || !state.messages?.length) return false;
  state.loadingEarlier = true;
  const id = state.currentId;
  try {
    const page = await api(`/conversations/${id}/messages?before=${state.messages[0].id}&limit=${PAGE}`);
    if (state.currentId !== id) return false;
    const box = $('#messages');
    const fromBottom = box.scrollHeight - box.scrollTop;
    state.conv.earlier = page.earlier;
    renderMessages([...page.messages, ...state.messages], { keepScroll: true, busy: Boolean(state.watch || state.streaming) });
    box.scrollTop = box.scrollHeight - fromBottom;
    return true;
  } finally {
    state.loadingEarlier = false;
  }
}
$('#messages').addEventListener('scroll', () => {
  if ($('#messages').scrollTop < 80 && state.conv?.earlier) void loadEarlier();
});

/** Scrolls to a message, loading earlier pages until it's there. */
async function jumpToMessage(id) {
  for (let i = 0; i < 40 && !document.querySelector(`#messages [data-id="${id}"]`); i++) if (!(await loadEarlier())) break;
  const target = document.querySelector(`#messages [data-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('highlight');
  setTimeout(() => target.classList.remove('highlight'), 2500);
}

// Phase 22: pinned messages, shown above the conversation.
function renderPins() {
  const pins = state.conv?.pinned ?? [];
  $('#pins').hidden = !pins.length;
  $('#pins-count').textContent = `${pins.length} pinned`;
  $('#pins-list').replaceChildren(
    ...pins.map((p) => {
      const a = el('button', 'pin-item ghost small');
      a.type = 'button';
      a.append(el('span', 'muted', p.role === 'user' ? t('You: ') : `${t('Sara')}: `), p.snippet.replace(/[*_`#>~]+/g, ''));
      a.addEventListener('click', () => {
        $('#pins-list').hidden = true;
        void jumpToMessage(p.id);
      });
      return a;
    }),
  );
  if (!pins.length) $('#pins-list').hidden = true;
}
$('#pins-toggle').addEventListener('click', () => ($('#pins-list').hidden = !$('#pins-list').hidden));
async function setPinned(m, on, btn) {
  try {
    const r = await api(`/conversations/${state.currentId}/messages/${m.id}`, { method: 'PATCH', body: { pinned: on } });
    m.meta = { ...m.meta, pinned: on };
    state.conv.pinned = r.pinned;
    renderPins();
    btn.textContent = on ? t('📌 Pinned') : '📌';
    btn.title = on ? t('Unpin') : t('Pin to the top of this conversation');
    btn.classList.toggle('on', on);
  } catch (err) {
    btn.title = err.message;
  }
}

// Follows a turn that is running on the server without our own stream (after a reload or from
// another device): polls the conversation until Sara is done.
function watchConversation(conv) {
  let count = conv.messages.length;
  const show = (c) => {
    setActivity(c.activity.status, c.activity.detail, Date.parse(c.activity.startedAt));
    for (const ev of c.activity.approvals) {
      if (!document.querySelector(`.approval[data-call="${CSS.escape(ev.id)}"]`)) append(approvalCard(ev));
    }
  };
  show(conv);
  setComposerBusy(true);
  state.watch = setInterval(async () => {
    if (state.currentId !== conv.id) return stopWatching();
    let c;
    try {
      c = await api(`/conversations/${conv.id}?limit=${PAGE}`);
    } catch {
      return;
    }
    state.conv = { ...state.conv, earlier: c.earlier, pinned: c.pinned };
    if (c.messages.length !== count) {
      count = c.messages.length;
      renderMessages(c.messages, { busy: Boolean(c.activity) });
    }
    if (c.activity) show(c);
    else {
      stopWatching();
      renderMessages(c.messages);
      await loadConversations();
    }
  }, 2000);
}

function stopWatching() {
  if (state.watch) clearInterval(state.watch);
  state.watch = null;
  if (!state.streaming) {
    setActivity(null);
    setComposerBusy(false);
  }
}

function setComposerBusy(busy) {
  $('#send').hidden = busy;
  $('#stop').hidden = !busy;
}

// ---------- activity indicator ----------
const ACTIVITY_LABEL = { thinking: 'Sara is thinking', writing: 'Sara is writing', running: 'Working', waiting: 'Waiting for your OK', listening: 'Listening', hearing: 'Hearing you', answering: 'Answering' };
const activity = { timer: null, startedAt: 0, stepAt: 0, status: '', detail: '' };

function fmtSecs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setActivity(status, detail = '', startedAt) {
  const bar = $('#activity');
  if (!status) {
    bar.hidden = true;
    clearInterval(activity.timer);
    activity.timer = null;
    activity.status = '';
    document.title = t('Sara');
    setLookBusy(null);
    panelNow(null);
    return;
  }
  if (!activity.timer) activity.startedAt = startedAt ?? Date.now();
  else if (startedAt) activity.startedAt = startedAt;
  if (status !== activity.status || detail !== activity.detail) activity.stepAt = Date.now();
  activity.status = status;
  activity.detail = detail;
  bar.hidden = false;
  bar.dataset.status = status;
  setLookBusy(status);
  renderActivity();
  if (!activity.timer) activity.timer = setInterval(renderActivity, 1000);
  document.title = (status === 'waiting' ? t('(!) Sara needs your OK') : t('Sara is working…'));
}

function renderActivity() {
  const now = Date.now();
  $('#activity-text').textContent = `${ACTIVITY_LABEL[activity.status] ? t(ACTIVITY_LABEL[activity.status]) : activity.status}${activity.detail ? `: ${/^.*?: (Remember|Add a to-do|Save a note): /.test(activity.detail) ? appApprovalText({ id: 'app-', summary: activity.detail }) : activity.detail}` : '…'}`;
  const step = activity.status === 'running' || activity.status === 'waiting' ? `${fmtSecs(now - activity.stepAt)} · ` : '';
  $('#activity-time').textContent = `${step}${t('total {time}', { time: fmtSecs(now - activity.startedAt) })}`;
  // Phase 75: her panel's "Now" says the same, in its own words.
  panelNow(activity.status, activity.status === 'answering' ? activity.detail : '', activity.startedAt);
}

$('#new-chat').addEventListener('click', () => newConversation());
$('#new-offrecord').addEventListener('click', () => newConversation(null, true));
$('#offrecord-end').addEventListener('click', async () => {
  const id = state.currentId;
  if (!state.conv?.offRecord || !confirm(t('Close this conversation? It is gone for good.'))) return;
  await api(`/conversations/${id}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter((c) => c.id !== id);
  const next = state.conversations.find((c) => !c.archivedAt);
  if (next) await openConversation(next.id);
  else await newConversation();
});

$('#toggle-sidebar').addEventListener('click', () => $('#main').classList.toggle('show-sidebar'));
// The sidebar's places: pinned ones, the rest under More (web/nav.js).
initNav();
initTidy();
initLook();
// Phase 75 (stage 2): her panel (web/her-panel.js) and the command bar (web/command-bar.js).
initHerPanel({
  api,
  conv: () => state.conv,
  messages: () => state.messages,
  isGroup,
  faceUrl,
  currentCompanion: () => state.companions?.companions.find((c) => c.current)?.id ?? null,
  convFacts,
  memKind: (k) => t(MEM_KIND_LABEL[k] ?? k),
  // Phase 85: "Remembered on her own" chips in the panel (web/recall-view.js).
  recallChip: (it, o = {}) => recallChip(it, { ...o, api }),
  openSara: () => openSara(),
  openToday: () => openToday(),
  openPlanner: (tab) => (tab ? openPlannerTab(tab) : $('#open-planner').click()),
  openConvSettings: () => $('#conv-settings-btn').click(),
  jumpTo: (convId, msgId) => openAtMessage(convId, msgId),
  openMemory: (text) => {
    $('#open-memory').click();
    setTimeout(() => {
      $('#mem-q').value = String(text ?? '').split(/\s+/).slice(0, 6).join(' ');
      $('#mem-q').dispatchEvent(new Event('input'));
    }, 60);
  },
});
/** A control can be used here (not hidden for this person, the demo or this device). */
const usable = (n) => Boolean(n) && !n.hidden && !n.closest('[hidden]:not(#side-more-menu)') && getComputedStyle(n).display !== 'none' && !(isMember() && n.closest('[data-owner-only]'));
/** A place's line under its name: its tooltip without the name or the shortcut again. */
const placeSub = (btn) => {
  const name = btn.querySelector('span')?.textContent?.trim() ?? '';
  const sub = btn.title.replace(/\s*\((Alt|Ctrl)\+[^)]*\)$/, '').trim();
  const rest = sub.toLowerCase().startsWith(`${name.toLowerCase()}:`) ? sub.slice(name.length + 1).trim() : sub;
  return rest.toLowerCase() === name.toLowerCase() ? '' : rest.charAt(0).toLocaleUpperCase() + rest.slice(1);
};
const placeKey = { today: 'Alt+T', planner: 'Alt+P', memory: 'Alt+M', library: 'Alt+L', scrapbook: 'Alt+B', story: 'Alt+Y' };
// 2.8: icon names from web/icons.js (the command bar draws them as line icons).
const PLACE_ICON = { today: 'today', planner: 'planner', memory: 'memory', library: 'library', scrapbook: 'scrapbook', moments: 'moments', story: 'story', team: 'team' };
initCommandBar({
  api,
  places: () => [
    ...[...document.querySelectorAll('#side-nav .side-dest')]
      .map((row) => ({ row, btn: row.querySelector('.side-go') }))
      .filter(({ row, btn }) => btn && !(isMember() && row.hasAttribute('data-owner-only')) && getComputedStyle(row).display !== 'none')
      .map(({ row, btn }) => ({ key: `place:${row.dataset.dest}`, icon: PLACE_ICON[row.dataset.dest] ?? 'dot', label: btn.querySelector('span')?.textContent?.trim() || row.dataset.dest, sub: placeSub(btn), hint: placeKey[row.dataset.dest] ?? '', run: () => btn.click() })),
    { key: 'place:her', icon: 'heart', label: t('Her page'), sub: t('Her day, mood and character'), hint: 'Alt+H', run: () => openSara() },
    { key: 'place:settings', icon: 'settings', label: t('Settings'), hint: 'Ctrl+,', run: () => openSettings() },
    { key: 'place:help', icon: 'help', label: t('Help'), sub: t('Tours and the guide'), run: () => $('#open-help').click() },
  ],
  conversations: () =>
    state.conversations
      .filter((c) => !String(c.channel ?? '').startsWith('import-'))
      .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)))
      .map((c) => ({ key: `conv:${c.id}`, icon: c.offRecord ? 'offrecord' : isGroup(c) ? 'group' : 'chat', label: c.title || t('New conversation'), sub: c.archivedAt ? t('Archived') : '', raw: true, run: () => { $('#main').classList.remove('show-sidebar'); return openConversation(c.id); } })),
  settings: () => settingsPages().map((p) => ({ key: `settings:${p.dataset.page}`, icon: 'settings', label: t(p.dataset.title), sub: t(p.dataset.group), run: () => openSettings(p.dataset.page) })),
  // The Settings window's own tiered search for pages, plus every setting's label on its own.
  searchSettings: (q) => {
    const pages = settingsPages();
    const pageItem = (p) => ({ key: `settings:${p.dataset.page}`, icon: 'settings', label: t(p.dataset.title), sub: t(p.dataset.group), run: () => openSettings(p.dataset.page) });
    // Pages: the ones whose name fits first, then the Settings window's tiered search.
    const named = pages.filter((p) => cmdScore(q, t(p.dataset.title), p.dataset.title));
    const tiered = matchSettings(q, pages).filter((p) => !named.includes(p));
    const seen = new Set();
    const labels = [];
    for (const p of pages) {
      for (const n of p.querySelectorAll('label, h3, h4, legend')) {
        // The label's own words: without the choices of a list inside it or its ? button.
        const words = n.cloneNode(true);
        for (const x of words.querySelectorAll('select, option, input, textarea, button, .muted')) x.remove();
        const text = words.textContent.replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
        if (!text || text.length > 90 || seen.has(text)) continue;
        const sc = cmdScore(q, text);
        if (!sc) continue;
        seen.add(text);
        labels.push({ sc, key: `settings:${p.dataset.page}`, icon: 'sliders', label: text, sub: `${t(p.dataset.group)} → ${t(p.dataset.title)}`, run: async () => {
          await openSettings(p.dataset.page);
          n.scrollIntoView({ block: 'center' });
          (n.querySelector('input, select, textarea') ?? n.nextElementSibling?.querySelector?.('input, select, textarea'))?.focus({ preventScroll: true });
          n.classList.add('cmd-found');
          setTimeout(() => n.classList.remove('cmd-found'), 2200);
        } });
      }
    }
    labels.sort((a, b) => b.sc - a.sc);
    const strong = labels.filter((x) => x.sc >= 3);
    const weak = labels.filter((x) => x.sc < 3);
    return [...named.slice(0, 3).map(pageItem), ...strong.slice(0, 4), ...tiered.slice(0, 2).map(pageItem), ...weak].slice(0, 6);
  },
  actions: () => {
    const list = [];
    const add = (key, icon, label, run, hint = '', words = '') => list.push({ key: `action:${key}`, icon, label, run, hint, words });
    if (usable($('#new-chat'))) add('new', 'edit', t('New conversation'), () => $('#new-chat').click(), 'Alt+N');
    if (usable($('#new-project'))) add('project', 'project', t('New project'), () => $('#new-project').click());
    if (usable($('#new-offrecord'))) add('offrecord', 'offrecord', t('Off the record'), () => $('#new-offrecord').click(), '', t('private conversation not saved'));
    if (usable($('#new-group'))) add('group', 'group', t('New group chat'), () => $('#new-group').click());
    if (usable($('#call'))) add('call', 'phone', t('Start a call'), () => $('#call').click(), '', t('voice talk'));
    if (usable($('#video-call-btn'))) add('video', 'video', t('Start a video call'), () => $('#video-call-btn').click());
    for (const c of state.companions?.companions ?? []) if (!c.current) add(`companion:${c.id}`, 'switch', t('Switch to {name}', { name: c.name }), () => switchCompanion(c.id), '', t('switch companion'));
    const light = document.documentElement.dataset.theme === 'light';
    add('theme', light ? 'moon' : 'sun', light ? t('Switch to Night') : t('Switch to Day'), () => {
      const sel = $('#ap-theme');
      sel.value = light ? 'dark' : 'light';
      sel.dispatchEvent(new Event('change'));
    }, '', t('switch theme dark light'));
    add('panel', 'panel', panelOpen() ? t('Fold her panel away') : t('Show her panel'), () => togglePanel(), 'Ctrl+\\');
    if (usable($('#server-btn'))) add('servers', 'server', t('Open Your Saras'), () => $('#server-btn').click(), '', t('servers switch'));
    add('search', 'search', t('Search messages, memories and notes'), () => {
      $('#main').classList.add('show-sidebar');
      $('#conv-search').focus();
    });
    add('tour', 'compass', t('Show me around'), () => runTour('first'), '', t('tour'));
    return list;
  },
});
// On a phone the list slides over the chat: ✕, a tap beside it, or Escape closes it.
const closeSidebar = () => $('#main').classList.remove('show-sidebar');
$('#close-sidebar').addEventListener('click', closeSidebar);
$('#sidebar-scrim').addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#main').classList.contains('show-sidebar') && !document.querySelector('dialog[open]:not(#today)')) closeSidebar();
});
// Phase 75 (stage 3): Today's tiles (web/today.js) and the phone's bottom bar (web/bottom-bar.js).
/** Puts words in the message box for the owner to check and send (smart-home asks from Today). */
async function askInChat(text) {
  if (!state.currentId || state.conv?.offRecord) await newConversation();
  $('#input').value = text;
  $('#input').dispatchEvent(new Event('input'));
  $('#input').focus();
}
// Phase 101 (ST6): Memory → People (web/people.js).
initPeople({ jumpTo: (convId, msgId) => openAtMessage(convId, msgId), openMemory: () => openMemory({ tab: 'people' }) });
initToday({
  api,
  status: (msg) => ($('#td-status').textContent = msg),
  member: isMember,
  demo: () => document.body.classList.contains('demo'),
  openConversation: (id) => openConversation(id),
  openSettings: (page) => openSettings(page),
  ask: askInChat,
  openCard: (boardId, ref) => openCardOnBoard(boardId, ref),
  // Phase 103: Today's "Her plans" tile (web/agenda.js).
  renderPlans: (plans, head) => renderPlansTile(plans, head),
  renderPhotos: renderTodayPhotos,
});
// Phase 103 (ST8): Planner → Her plans and the chat's "Why I'm writing" line (web/agenda.js).
initAgenda({
  api,
  openConversation: (id) => {
    $('#planner').close();
    void openConversation(id);
  },
  openPlanner: async (tab) => {
    if (!$('#planner').open) await openPlanner();
    document.querySelector(`#planner .tab[data-tab="${tab}"]`)?.click();
  },
  refreshToday: () => {
    if (todayOpen()) void loadToday();
  },
});
initBottomBar({
  openToday: () => openToday(),
  closeToday,
  todayOpen,
  openPlanner: () => $('#open-planner').click(),
  openMore: () => {
    $('#main').classList.add('show-sidebar');
    setMore(true);
  },
  closeSidebar,
});

// ---------- messages ----------
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const was = btn.textContent;
      btn.textContent = t('Copied');
      setTimeout(() => (btn.textContent = was), 1200);
    }
  } catch {
    /* clipboard blocked */
  }
}

/** Renders an assistant reply's Markdown into its bubble (safe: DOM nodes only). */
function setReply(div, raw, { partial = false } = {}) {
  if (!partial) div._raw = raw;
  let body = div.querySelector(':scope > .md');
  if (!body) {
    body = el('div', 'md');
    div.prepend(body);
  }
  body.replaceChildren(toDom(parseMd(raw.trimEnd()), document, { onCopy: copyText, copyLabel: t('Copy') }));
}

// While streaming, re-render at most once per frame.
// Phase 27: optional human-feeling typing (Settings → Appearance). A short pause before she
// starts, a varied pace, small pauses after commas and sentences; long replies catch up faster.
const humanTyping = () => localStorage.getItem('sara.typing') === 'human' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
function typeReply(div, raw) {
  div._raw = raw;
  if (div._typer) return;
  div._shown ??= 0;
  const tick = () => {
    const target = div._raw ?? '';
    if (div._shown >= target.length) {
      div._typer = null;
      for (const r of div._typed?.splice(0) ?? []) r();
      return;
    }
    const backlog = target.length - div._shown;
    // Nobody is watching (tab in the background, where timers crawl): show it all.
    if (document.hidden) div._shown = target.length;
    else div._shown = Math.min(target.length, div._shown + 1 + Math.floor(Math.random() * 3) + Math.floor(backlog / 250));
    setReply(div, target.slice(0, div._shown), { partial: true });
    $('#messages').scrollTop = $('#messages').scrollHeight;
    const last = target[div._shown - 1];
    const delay = backlog > 600 ? 20 : /[.!?…]/.test(last) ? 220 + Math.random() * 260 : /[,;:]/.test(last) ? 90 + Math.random() * 90 : last === '\n' ? 160 : 28 + Math.random() * 40;
    div._typer = setTimeout(tick, delay);
  };
  div._typer = setTimeout(tick, div._shown ? 0 : 350 + Math.random() * 500);
}
/** Resolves when a typed reply has caught up (at once if it isn't typing). */
function typedOut(div) {
  return div?._typer ? new Promise((r) => (div._typed ??= []).push(r)) : Promise.resolve();
}
/** Show the whole reply now (a tool started, the reply was stopped…). */
function finishTyping(div) {
  if (!div?._typer) return;
  clearTimeout(div._typer);
  div._typer = null;
  div._shown = (div._raw ?? '').length;
  for (const r of div._typed?.splice(0) ?? []) r();
}

function queueReply(div, raw) {
  if (humanTyping()) return typeReply(div, raw);
  div._raw = raw;
  if (div._queued) return;
  div._queued = true;
  requestAnimationFrame(() => {
    div._queued = false;
    setReply(div, div._raw);
  });
}

function bubble(role, text, kind, id, images = [], docs = []) {
  const div = document.createElement('div');
  if (id) div.dataset.id = id;
  div.className = `msg ${role}${kind ? ` ${kind}` : ''}`;
  if (role === 'assistant') setReply(div, text);
  else div.textContent = (text === '(photo)' && images.length) || (text === '(document)' && docs.length) ? '' : text;
  // Phase 44: documents shared with the message (open them in her library).
  if (docs.length) {
    const row = el('div', 'msg-docs');
    for (const d of docs) {
      const chip = el('button', 'doc-chip', `📄 ${d.name}`);
      chip.type = 'button';
      chip.title = d.keep ? t('In her library') : t('Shared in this chat only');
      chip.addEventListener('click', () => void openLibrary(d.id));
      row.append(chip);
    }
    div.prepend(row);
  }
  if (images.length) {
    const row = el('div', 'msg-photos');
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'photo';
      img.addEventListener('click', () => window.open(src, '_blank', 'noopener'));
      row.append(img);
    }
    div.prepend(row);
  }
  return div;
}

function msgActions(div, m, { last, lastUser, other = false }) {
  const bar = el('div', 'msg-actions');
  // Phase 75: who and when, shown with the actions (on hover, long-press or the ⋯ button).
  const when = msgTime(m.createdAt);
  if (m.role === 'assistant' && !m.meta?.speaker) bar.append(el('span', 'msg-meta', when ? `${currentIdentity().name || t('Sara')} · ${when}` : currentIdentity().name || t('Sara')));
  else if (when) bar.append(el('span', 'msg-meta', when));
  if (m.role === 'assistant') {
    const copy = el('button', 'ghost small', t('Copy'));
    copy.type = 'button';
    copy.title = t('Copy this reply');
    copy.addEventListener('click', () => copyText(div._raw ?? m.content, copy));
    bar.append(copy);
    if (m.meta?.voiceNote) {
      // Phase 26: a missed call's message, in her voice.
      const play = el('button', 'ghost small', t('▶ Play'));
      play.type = 'button';
      play.title = t('Hear her message');
      play.addEventListener('click', () => speaker.say(m.content));
      bar.prepend(play);
    }
    if (last) {
      const again = el('button', 'ghost small', t('↻ Regenerate'));
      again.type = 'button';
      again.title = t('Ask Sara to answer your last message again');
      again.addEventListener('click', () => regenerate());
      bar.append(again);
    }
    if (m.id) {
      // Phase 19: flag an offensive or harmful reply (kept on your server; sent to the app's developer).
      const flag = el('button', 'ghost small', m.meta?.reported ? t('⚑ Reported') : '⚑');
      flag.type = 'button';
      flag.title = t('Report this reply');
      flag.disabled = Boolean(m.meta?.reported);
      flag.addEventListener('click', () => openReport(m, flag));
      bar.append(flag);
    }
    if (m.meta?.model) {
      const who = el('span', 'msg-model', m.meta.model);
      who.title = m.meta.provider ? `${m.meta.model} · ${m.meta.provider}` : m.meta.model;
      bar.append(who);
    }
  }
  if ((m.role === 'assistant' || m.role === 'user') && m.id && !state.conv?.partner) {
    // Phase 22: pin to the top of the conversation.
    const on = m.meta?.pinned === true;
    const pin = el('button', `ghost small${on ? ' on' : ''}`, on ? t('📌 Pinned') : '📌');
    pin.type = 'button';
    pin.title = on ? t('Unpin') : t('Pin to the top of this conversation');
    pin.addEventListener('click', () => setPinned(m, !(m.meta?.pinned === true), pin));
    bar.append(pin);
    // Another companion's line in a group chat is hers to keep, not this one's scrapbook moment.
    if (!state.conv?.offRecord && !other) {
      const keep = el('button', 'ghost small', '♡');
      keep.type = 'button';
      keep.title = t('Keep this moment in your scrapbook');
      keep.addEventListener('click', async () => {
        try {
          await api('/scrapbook', { method: 'POST', body: { messageId: m.id } });
          keep.textContent = t('♥ Kept');
          keep.disabled = true;
        } catch (err) {
          keep.title = err.message;
        }
      });
      bar.append(keep);
    }
    // Phase 70: a photo can go in "Our moments" by hand (e.g. from a private conversation).
    if (!state.conv?.offRecord && !other && Array.isArray(m.meta?.images) && m.meta.images.length) bar.append(addToMomentsButton(m.id));
  }
  if (m.role === 'user' && lastUser) {
    const edit = el('button', 'ghost small', t('✎ Edit'));
    edit.type = 'button';
    edit.title = t('Change your last message and have Sara answer it again');
    edit.addEventListener('click', () => startEdit(m.content));
    bar.append(edit);
  }
  if (bar.querySelector('button')) {
    // Phase 75: the row lives inside the message and shows on hover, focus, long-press or ⋯.
    const more = el('button', 'ghost small msg-more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', t('Message actions'));
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMsgActions(div);
    });
    div.append(more, bar);
  }
  return bar;
}

/** Opens or closes one message's actions (touch: long-press or ⋯); only one is open at a time. */
function toggleMsgActions(div, open = !div.classList.contains('show-actions')) {
  for (const o of document.querySelectorAll('#messages .msg.show-actions')) {
    if (o === div) continue;
    o.classList.remove('show-actions');
    o.querySelector(':scope > .msg-more')?.setAttribute('aria-expanded', 'false');
  }
  div.classList.toggle('show-actions', open);
  div.querySelector(':scope > .msg-more')?.setAttribute('aria-expanded', String(open));
}

const msgTime = (iso) => {
  const d = iso ? new Date(String(iso).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(iso)) ? '' : 'Z')) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }) : '';
};

// ---------- Phase 75: her messages, step lines and result cards ----------
const toolNamed = (name) => (TOOL_NAME[name] ? t(TOOL_NAME[name]) : '');
const newSteps = () => stepLine({ named: toolNamed, undo: addUndo });
/** Phase 78: the Run view of one reply's run. */
const showRun = (runId) => void openRunView(runId, { api, named: toolNamed });
/** Her small face at the start of a run of her messages (one companion; groups show the speaker). */
function herFace(div, start) {
  div.classList.add('her');
  if (!start || div.querySelector(':scope > .msg-face')) return;
  div.classList.add('run-start');
  const img = document.createElement('img');
  img.className = 'avatar msg-face';
  img.alt = '';
  img.src = document.querySelector('#chat-head .head-face')?.getAttribute('src') || '/sara-avatar.jpg';
  div.prepend(img);
}
const isHerBubble = (n) => n?.classList?.contains('msg') && n.classList.contains('assistant');

/** True when the conversation ends without Sara's answer (restart, error, Stop). */
function unfinished(messages) {
  const visible = messages.filter((m) => m.role !== 'notice');
  const lastMsg = visible.at(-1);
  if (!lastMsg) return false;
  if (lastMsg.role === 'user' || lastMsg.role === 'tool') return true;
  return lastMsg.role === 'assistant' && Boolean(lastMsg.meta?.toolCalls?.length || lastMsg.meta?.partial);
}

function renderMessages(messages, opts = {}) {
  const box = $('#messages');
  state.messages = messages;
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('Say hi to Sara.');
    box.replaceChildren(empty);
    return;
  }
  const els = [];
  const lastAssistant = messages.findLast((m) => m.role === 'assistant' && m.content.trim());
  const lastUser = messages.findLast((m) => m.role === 'user');
  // Phase 75: what she did in a turn (tools, memories) becomes one step line under the reply that
  // ends it; result cards sit where the result came; the files she changed form one card.
  let turn = null;
  const newTurn = () => ({ steps: null, files: [], filesSlot: null, mem: new Set(), runId: 0, budget: null, budgetMsg: null });
  const flush = () => {
    if (!turn) return;
    if (turn.mem.size) memoryStep((turn.steps ??= newSteps()), turn.mem.size);
    // Phase 79: the reply's budget meter on its step line.
    if (turn.budget && turn.steps) setBudget(turn.steps, budgetMeter(turn.budget, { compact: true }));
    // Phase 78: "Show the run" (not on the demo, which keeps no run history for visitors).
    if (turn.runId && turn.steps && !document.body.classList.contains('demo')) runLink(turn.steps, turn.runId, showRun);
    if (turn.filesSlot) {
      const card = renderCards(turn.files)[0];
      const at = els.indexOf(turn.filesSlot);
      if (card) els[at] = card;
      else els.splice(at, 1);
    }
    if (hasSteps(turn.steps)) els.push(turn.steps);
    // Phase 79: "Budget reached" with what was dropped; Continue only on the latest reply (it answers the last message again).
    if (turn.budget?.stage === 'reached') {
      const latest = turn.budgetMsg === lastAssistant && lastAssistant.id > (lastUser?.id ?? 0) && !document.body.classList.contains('demo') && !isGroup(state.conv);
      els.push(budgetCard(turn.budget, latest ? { onContinue: (more) => void runStream(`/conversations/${state.currentId}/continue`, { budget: more }, null) } : {}));
    }
    turn = null;
  };
  let prevBubble = null;
  for (const m of messages) {
    if (m.role === 'user') flush();
    turn ??= newTurn();
    if (m.role === 'assistant' && Array.isArray(m.meta?.memoryIds)) for (const id of m.meta.memoryIds) turn.mem.add(id);
    if (m.role === 'assistant' && m.meta?.runId) turn.runId = m.meta.runId;
    // Phase 96: a skill loaded up front for this reply.
    if (m.role === 'assistant' && typeof m.meta?.autoSkill === 'string') skillStep((turn.steps ??= newSteps()), m.meta.autoSkill);
    // Phase 98: what plugins did in this turn ("Weather alerts added a note").
    if (m.role === 'assistant' && Array.isArray(m.meta?.plugins)) for (const pe of m.meta.plugins) pluginStep((turn.steps ??= newSteps()), pluginStepWords(pe), pe.what);
    if (m.role === 'assistant' && m.meta?.budget) {
      turn.budget = m.meta.budget;
      turn.budgetMsg = m;
    }
    // Phase 77: flags and finished stops of her plan check (`meta.contradictions`), under that step.
    if (m.role === 'assistant' && Array.isArray(m.meta?.contradictions)) for (const c of m.meta.contradictions) if (c?.note && c.status !== 'open') els.push(contradictionFlag(c));
    // Phase 85: notes she remembered on her own for that step ("Not useful" lowers that trigger).
    if (m.role === 'assistant' && Array.isArray(m.meta?.recall)) for (const it of m.meta.recall) if (it?.ref) {
      els.push(recallChip(it, { api, messageId: m.id }));
      // On the step line where it happened (after the step whose result set it off).
      recallStep((turn.steps ??= newSteps()), recallKindWords(it.kind));
    }
    // Phase 80: a command tried in a sandbox copy first (what it did and what you chose).
    if (m.role === 'tool' && m.meta?.sandbox?.decision) els.push(sandboxFlag({ ...m.meta.sandbox, callId: m.meta.toolCallId }));
    // Phase 81: an install the "Known vulnerability" card stopped, and your answer.
    if (m.role === 'tool' && m.meta?.advisory?.answer) els.push(advisoryFlag({ id: m.meta.toolCallId, state: m.meta.advisory.answer === 'override' ? 'override' : 'declined', packages: (m.meta.advisory.packages ?? []).map((p) => `${p.name} ${p.version}`) }));
    if (m.role === 'tool') {
      addStep((turn.steps ??= newSteps()), { id: m.meta?.toolCallId, name: m.meta?.name, summary: m.meta?.summary ?? m.meta?.name, args: m.meta?.args, status: m.meta?.status ?? 'ok', output: m.content, ms: m.meta?.ms, snapshotId: m.meta?.snapshotId });
      const card = (m.meta?.status ?? 'ok') === 'ok' ? m.meta?.card : null;
      if (card?.kind === 'file') {
        turn.files.push(card);
        if (!turn.filesSlot) els.push((turn.filesSlot = { slot: true }));
      } else if (card) {
        const c = renderCard(card);
        if (c) els.push(c);
      }
      // Phase 98: cards plugins added under this step.
      for (const pc of Array.isArray(m.meta?.pluginCards) ? m.meta.pluginCards : []) els.push(pluginResultCard(pc));
      // Phase 49: a preview link she opened gets a card that opens it beside the chat.
      if (m.meta?.name === 'preview_start' && (m.meta?.status ?? 'ok') === 'ok') {
        const pc = previewCard(m.content);
        if (pc) els.push(pc);
      }
    } else if (m.role === 'notice' && m.kind === 'job') {
      els.push(jobCard(m.content, m.meta?.status, m.meta));
      // A background Gmail change: its result card (done, Undo) rides on the job's notice.
      if (m.meta?.card) {
        const rc = renderCard(m.meta.card);
        if (rc) els.push(rc);
      }
    } else if (m.role === 'notice' && m.kind === 'hook') {
      // Phase 102: a webhook delivery (or its result), labelled as the webhook's, never as her.
      els.push(hookNotice(m, { openSettings: (page) => void openSettings(page) }));
    } else if (m.role === 'notice' && m.kind === 'agenda') {
      // Phase 103: "Added to her plans" (or a goal she suggests) after her reply (web/agenda.js).
      els.push(agendaNotice(m));
    } else if (m.role === 'notice' && m.kind === 'plugin') {
      // Phase 98: a plugin's note or card (after her reply, or from its schedule), labelled as the plugin's.
      els.push(pluginNotice(m));
    } else if (m.role === 'notice' && (m.kind === 'skill' || m.kind === 'skillfix')) {
      // Phase 97: "make this a skill?" and "a fix for …?" (web/learned-skills.js), after her reply.
      els.push(learnCard(m));
    } else if (m.role === 'notice' && m.kind === 'call') {
      els.push(bubble('notice', `📞 ${t('Sara called you')}: ${m.content}`, 'call', m.id));
    } else if (m.role === 'assistant' && !m.content.trim() && !m.meta?.proof?.length) {
      continue;
    } else {
      // Phase 61: app notices with a template (a backup model took over) in the app language.
      const b = bubble(m.role, m.role === 'notice' && m.meta?.key ? serverText(m.meta, m.content) : m.content, m.kind, m.id, Array.isArray(m.meta?.images) ? m.meta.images.map((i) => `/api/uploads/${i}`) : [], Array.isArray(m.meta?.docs) ? m.meta.docs : []);
      // Phase 51: a reply from another assistant in imported history is labelled as theirs.
      if (m.role === 'assistant' && typeof m.meta?.importedFrom === 'string') {
        b.classList.add('imported');
        b.prepend(el('span', 'msg-from muted small', `${IMPORTED_NAMES[m.meta.importedFrom] ?? t('Another assistant')} ${t('said (imported)')}`));
      }
      // Phase 102: what a webhook delivered is labelled as the webhook's, never as the owner's words.
      if (m.role === 'user' && m.meta?.hookFrom) {
        b.classList.add('from-hook');
        b.prepend(el('span', 'msg-from small', t('From the webhook {name}', { name: m.meta.hookFrom.name ?? '' })));
      }
      // Phase 83: an answer taken from a branch ("Use this answer") says it is a re-run.
      if (m.role === 'assistant' && m.meta?.rerun) {
        b.classList.add('rerun');
        b.prepend(el('span', 'msg-from muted small', t('Re-run from step {n} (a branch of an earlier reply)', { n: Number(m.meta.rerun.fromStep ?? 0) + 1 })));
      }
      // Phase 66: who said it, in a group chat (her face, name and colour).
      if (m.role === 'assistant' && m.meta?.speaker) speakerHeader(b, m.meta.speaker);
      if (m.meta?.unverified) flagClaims(b, m.meta.unverified);
      // Phase 79: a reply that ran on extra budget the owner gave says so.
      const extra = m.role === 'assistant' ? overrideNote(m.meta?.budget) : null;
      if (extra) b.append(extra);
      if (Array.isArray(m.meta?.proof) && m.meta.proof.length) b.append(proofStrip(m.meta.proof));
      if (m.meta?.team?.id) {
        const tb = el('button', 'ghost small team-link', `👥 ${t('Team task')} #${m.meta.team.id}`);
        tb.type = 'button';
        tb.addEventListener('click', () => void openTeam(m.meta.team.id));
        b.append(tb);
        if (m.meta.team.status === 'limit') b.append(continueButton(`/team/${m.meta.team.id}/continue`, () => void openTeam(m.meta.team.id)));
      }
      // Phase 52: a job she stopped at its budget can carry on.
      if (m.meta?.budget && m.meta?.job) b.append(continueButton(`/jobs/${m.meta.job}/continue`, () => void loadJobs()));
      if (m.meta?.forgotten) b.classList.add('forgotten');
      if (m.meta?.reminder) b.classList.add('reminder');
      if (m.meta?.proactive) b.classList.add('proactive');
      // Phase 103: a message from her plans says why she wrote (tap → the plan on Her plans).
      if (m.role === 'assistant' && m.meta?.agenda) b.append(agendaWhy(m.meta.agenda));
      if (m.meta?.call) b.classList.add('missed-call');
      if (m.role === 'assistant') {
        const sameRun = prevBubble?.role === 'assistant' && (prevBubble.meta?.speaker?.id ?? null) === (m.meta?.speaker?.id ?? null);
        if (!m.meta?.speaker) herFace(b, !sameRun);
        else b.classList.add('her', ...(sameRun ? [] : ['run-start']));
      }
      prevBubble = m;
      els.push(b);
      b._msg = m;
      // The reply that ends a turn (no tool calls after it) carries the turn's step line.
      if (m.role === 'assistant' && !m.meta?.toolCalls?.length) flush();
      // Phase 81: her security pass over the files this turn changed (when it has finished).
      // Phase 86: "Red-team this" on the after-turn card (the threat card when there is one, else this one).
      const rtWs = (state.conversations ?? []).find((c) => c.id === state.currentId)?.workspace;
      if (m.role === 'assistant' && m.meta?.security && !document.body.classList.contains('demo')) els.push(securityCard(m.meta.security, { onOpen: (sum) => void openFindings(sum.runId ? { runId: sum.runId } : { conversationId: state.currentId }), redteam: !m.meta?.threats, workspace: rtWs, conversationId: state.currentId }));
      // Phase 82: the threat model of the same turn (entry point → dangerous line), with "Fix these".
      if (m.role === 'assistant' && m.meta?.threats && !document.body.classList.contains('demo')) els.push(threatCard(m.meta.threats, { onOpen: (sum) => void openFindings({ workspace: sum.workspace, tab: 'threats' }), onFixStarted: (sum) => void openFindings({ workspace: sum.workspace, source: 'threat' }), redteam: true, conversationId: state.currentId }));
    }
  }
  flush();
  box.replaceChildren(...els);
  for (const b of els) {
    if (!b._msg) continue;
    const m = b._msg;
    const solo = !isGroup(state.conv);
    msgActions(b, m, { last: solo && m === lastAssistant && lastAssistant.id > (lastUser?.id ?? 0), lastUser: solo && m === lastUser && !m.meta?.forgotten && !state.conv?.partner, other: Boolean(m.meta?.groupFrom) });
  }
  if (!opts.busy && !state.conv?.partner && !isGroup(state.conv) && unfinished(messages)) box.append(continueBar());
  if (state.conv?.earlier) {
    const more = el('button', 'ghost small earlier-btn', t('Show earlier messages ({earlier})', { earlier: state.conv.earlier }));
    more.type = 'button';
    more.addEventListener('click', () => loadEarlier());
    box.prepend(more);
  }
  if (!opts.keepScroll) box.scrollTop = box.scrollHeight;
  updateContextRing();
  panelMessages();
}

function continueBar() {
  const bar = el('div', 'msg notice continue-bar', t("Sara didn't finish this reply (it was stopped, failed or the server restarted). "));
  const go = el('button', 'small', t('Continue'));
  go.type = 'button';
  go.addEventListener('click', () => {
    bar.remove();
    runStream(`/conversations/${state.currentId}/continue`, {}, null);
  });
  bar.append(go);
  return bar;
}

function append(el) {
  const box = $('#messages');
  box.querySelector('.empty')?.remove();
  box.append(el);
  box.scrollTop = box.scrollHeight;
}

/** Removes everything shown from the last owner message on (for regenerate / edit). */
function cutFromLastUser({ keepUser }) {
  const box = $('#messages');
  const users = [...box.querySelectorAll('.msg.user')];
  const lastU = users.at(-1);
  if (!lastU) return null;
  let n = lastU.nextSibling;
  while (n) {
    const next = n.nextSibling;
    n.remove();
    n = next;
  }
  if (!keepUser) {
    lastU.remove();
    return null;
  }
  return lastU;
}

async function regenerate() {
  if (state.streaming || state.watch || !state.currentId) return;
  const userBubble = cutFromLastUser({ keepUser: true });
  await runStream(`/conversations/${state.currentId}/retry`, {}, userBubble);
}

function startEdit(text) {
  if (state.streaming || state.watch) return;
  state.editing = true;
  $('#editing').hidden = false;
  $('#input').value = text;
  autosize();
  $('#input').focus();
}
function stopEdit() {
  state.editing = false;
  $('#editing').hidden = true;
}
$('#edit-cancel').addEventListener('click', () => {
  stopEdit();
  $('#input').value = '';
  autosize();
});

async function send(text) {
  if (!state.currentId) {
    const conv = await api('/conversations', { method: 'POST', body: {} });
    state.conversations.unshift(conv);
    state.currentId = conv.id;
    state.conv = conv;
    // Show its label (workspace, model) and list entry right away, not only after reopening.
    renderConvSummary();
    $('#chat-title').textContent = conv.title;
    renderConversations();
  }
  $('#messages .continue-bar')?.remove();
  if (state.editing) {
    stopEdit();
    cutFromLastUser({ keepUser: false });
    const userBubble = bubble('user', text);
    append(userBubble);
    return runStream(`/conversations/${state.currentId}/retry`, { content: text }, userBubble);
  }
  const photos = state.photos.splice(0);
  const pending = state.docs.splice(0);
  renderAttachments();
  // Phase 44: documents go up first (kept in her library, or for this chat only), then she reads
  // them, then the message goes with them.
  const docs = [];
  if (pending.length) {
    setComposerBusy(true);
    try {
      for (const p of pending) {
        setActivity('thinking', `${t('Sending')} ${p.file.name}…`);
        try {
          const d = await uploadDoc(p.file, { keep: p.keep, conversationId: state.currentId });
          docs.push({ id: d.id, name: d.name, keep: d.keep });
        } catch (err) {
          append(bubble('error', `${p.file.name}: ${err.message}`));
        }
      }
      if (docs.length) await waitRead(docs.map((d) => d.id), (s) => setActivity('thinking', s));
    } finally {
      setActivity(null);
      setComposerBusy(false);
    }
    if (!docs.length && (text === '(document)' || !text)) return;
  }
  const userBubble = bubble('user', text, undefined, undefined, photos, docs);
  append(userBubble);
  // Phase 69: on a classic video call with the camera on, her answer may look at the newest picture.
  const onVideo = videoView.active && voice.call?.active && !voice.liveCall;
  const frame = onVideo ? { videoCall: true, ...(videoView.sendsFrames ? { liveFrame: true, ...(videoView.lookAsk ? { liveFrameAsk: true } : {}) } : {}) } : {};
  videoView.lookAsk = false;
  const body = { content: text, ...(photos.length ? { images: photos } : {}), ...(docs.length ? { docs: docs.map((d) => d.id) } : {}), ...frame };
  if (videoView.active && voice.call?.active) videoView.you(text, true);
  return runStream(`/conversations/${state.currentId}/messages`, body, userBubble);
}

// ---------- photos ----------
state.photos = [];
const MAX_PHOTOS = 4;
/** Shrinks a photo to at most 1600 px on its long side as JPEG (keeps uploads small). */
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.86);
}
async function addPhotos(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (state.photos.length >= MAX_PHOTOS) {
      append(bubble('error', t('Up to {MAX_PHOTOS} photos per message.', { MAX_PHOTOS })));
      break;
    }
    try {
      state.photos.push(await shrinkPhoto(f));
    } catch {
      append(bubble('error', f.name ? t("Couldn't read {name}.", { name: f.name }) : t("Couldn't read that photo.")));
    }
  }
  renderAttachments();
}
// Phase 44: documents waiting to go with the next message.
state.docs = [];
function addDocs(files) {
  for (const f of files) {
    if (state.docs.length >= 5) {
      append(bubble('error', t('Up to 5 documents per message. Add more on the Library page.')));
      break;
    }
    if (state.conv?.offRecord) {
      append(bubble('error', t("Off-the-record chats don't save files, so documents can't be shared here.")));
      break;
    }
    state.docs.push({ file: f, keep: true });
  }
  renderAttachments();
}
/** Photos go to addPhotos, documents to addDocs. */
function addFiles(files) {
  const list = [...files];
  const photos = list.filter((f) => f.type.startsWith('image/'));
  const docs = list.filter((f) => !f.type.startsWith('image/') && isDocFile(f));
  const other = list.filter((f) => !photos.includes(f) && !docs.includes(f));
  if (other.length) append(bubble('error', `${t("She can't read")} ${other.map((f) => f.name).join(', ')}. ${t('She reads PDF, Word, Excel, PowerPoint, e-books, web pages, text, Markdown and CSV files.')}`));
  if (photos.length) void addPhotos(photos);
  if (docs.length) addDocs(docs);
}
function renderAttachments() {
  const box = $('#attachments');
  box.hidden = !state.photos.length && !state.docs.length;
  const docChips = state.docs.map((d, i) => {
    const w = el('span', 'attachment doc');
    w.append(el('span', 'doc-name', `📄 ${d.file.name}`));
    const keep = document.createElement('select');
    keep.className = 'doc-keep';
    keep.setAttribute('aria-label', t('Keep it or read it once'));
    keep.title = t('Keep in her library: she remembers the key points and can look it up any time. Just read this once: only for this chat.');
    for (const [v, label] of [['1', t('Keep in her library')], ['0', t('Just read this once')]]) keep.append(new Option(label, v, false, (v === '1') === d.keep));
    keep.addEventListener('change', () => (d.keep = keep.value === '1'));
    const x = el('button', 'ghost small', '×');
    x.type = 'button';
    x.title = t('Remove');
    x.addEventListener('click', () => {
      state.docs.splice(i, 1);
      renderAttachments();
    });
    w.append(keep, x);
    return w;
  });
  box.replaceChildren(...docChips,
    ...state.photos.map((src, i) => {
      const w = el('span', 'attachment');
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'photo to send';
      const x = el('button', 'ghost small', '×');
      x.type = 'button';
      x.title = t('Remove');
      x.addEventListener('click', () => {
        state.photos.splice(i, 1);
        renderAttachments();
      });
      w.append(img, x);
      return w;
    }),
  );
}
$('#attach').addEventListener('click', () => $('#attach-file').click());
// Phase 92 (§1, §9.4): "Show Sara my screen" for web-only users: the browser's own prompt picks a
// window or the screen, one picture is taken and added to the message (nothing is sent until Send),
// and the capture stops at once.
$('#show-screen').hidden = !(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') || Boolean(window.SaraDesktop);
$('#show-screen').addEventListener('click', async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 300));
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error(t('No picture came from the screen.'));
    const scale = Math.min(1, 1600 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error(t('No picture came from the screen.'));
    addFiles([new File([blob], 'screen.jpg', { type: 'image/jpeg' })]);
    $('#input').focus();
  } catch (err) {
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') alert(err.message || t('No picture came from the screen.'));
  } finally {
    for (const tr of stream?.getTracks() ?? []) tr.stop();
  }
});
// Phase 75: the + menu's Photo (a picker for pictures only; on phones it offers the camera too).
$('#attach-photo').addEventListener('click', () => $('#attach-photo-file').click());
$('#attach-photo-file').addEventListener('change', () => {
  addFiles($('#attach-photo-file').files);
  $('#attach-photo-file').value = '';
  $('#input').focus();
});
$('#attach-file').addEventListener('change', async () => {
  addFiles($('#attach-file').files);
  $('#attach-file').value = '';
  $('#input').focus();
});
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
// Phase 75: files from the desktop apps (Explorer's Send To → Sara, `Sara.exe <files>`, the Mac Dock icon)
// land in the message box like a drop; nothing is sent until the owner presses Send. Refused while
// signed out (no conversation open) and on the demo; off-the-record chats refuse documents in addDocs.
window.saraDesktopAttach = (files) => {
  if (document.body.classList.contains('demo') || !state.currentId || !files?.length) return false;
  addFiles(files);
  $('#input').focus();
  return true;
};
for (const ev of ['dragover', 'drop']) {
  $('#chat').addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (ev === 'drop') addFiles(e.dataTransfer.files);
  });
}

/** Posts to a turn endpoint and shows the streamed reply, tools and approvals as they arrive. */
async function runStream(path, body, userBubble) {
  for (const bar of document.querySelectorAll('#messages .msg-actions, #messages .msg-more')) bar.remove();
  let reply = null;
  let pendingTyped = null;
  // Phase 75: this turn's step line (last in the turn: replies and cards go above it).
  let steps = null;
  const liveFiles = [];
  let filesEl = null;
  const place = (node) => {
    if (!node) return;
    if (steps?.isConnected) {
      steps.before(node);
      const box = $('#messages');
      box.scrollTop = box.scrollHeight;
    } else append(node);
  };
  const ensureSteps = () => {
    if (!steps) {
      steps = newSteps();
      append(steps);
    }
    return steps;
  };
  // Phase 63: tool calls still being written, by their place in the model step.
  const building = new Map();
  const dropBuilding = () => {
    for (const card of building.values()) card.remove();
    building.clear();
  };
  const controller = new AbortController();
  state.streaming = controller;
  setComposerBusy(true);
  setActivity('thinking');
  // Phase 66: in a group chat each reply starts with a "speaker" event (who is answering now).
  let groupSpeaker = null;
  const endReply = () => {
    finishTyping(reply);
    if (reply) setReply(reply, reply._raw ?? '');
    reply?.classList.remove('typing');
    reply = null;
  };

  try {
    const res = await api(path, { method: 'POST', body, raw: true, signal: controller.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      userBubble?.remove();
      throw new Error(serverText(data, `HTTP ${res.status}`));
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine.slice(6));
        if (ev.type === 'speaker') {
          if (voiceOn()) speaker.flush();
          endReply();
          groupSpeaker = ev.speaker;
          speaker.voice = ev.speaker?.id ?? null;
          setActivity('answering', ev.speaker?.name ?? '');
          continue;
        }
        if (ev.type === 'retract') {
          // A banter reply with nothing to add is taken back.
          if (voiceOn()) speaker.stop();
          finishTyping(reply);
          (reply ?? [...document.querySelectorAll('#messages .msg.assistant')].pop())?.remove();
          reply = null;
          continue;
        }
        if (ev.type === 'group_done') continue;
        if (ev.type === 'notice') {
          // Phase 69: the AI notice and crisis help show on the video call screen too.
          if (videoView.active) videoView.notice(ev.kind, ev.key ? serverText(ev, ev.text) : ev.text);
          const n = bubble('notice', ev.key ? serverText(ev, ev.text) : ev.text, ev.kind);
          if (ev.kind === 'disclosure' && userBubble) userBubble.before(n);
          else append(n);
        } else if (ev.type === 'tool_progress') {
          setActivity('writing', ev.path ? `writing ${ev.path} · ${Math.round(ev.chars / 1024)} KB so far` : `preparing ${ev.name} · ${Math.round(ev.chars / 1024)} KB so far`);
        } else if (ev.type === 'tool_building') {
          // Phase 63: the call as the model writes it; the finished call replaces it.
          if (voiceOn()) speaker.flush();
          endReply();
          const box = $('#messages');
          const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
          let card = building.get(ev.index);
          if (!card) {
            card = buildingCard();
            building.set(ev.index, card);
            place(card);
          }
          fillBuildingCard(card, ev);
          if (near) box.scrollTop = box.scrollHeight;
          setActivity('writing', ev.path || ev.name);
        } else if (ev.type === 'tool_call') {
          if (voiceOn()) speaker.flush();
          endReply();
          // The live card of this call (same id, else the oldest one) makes way for its step.
          const live = [...building.entries()].find(([, c]) => c.dataset.call === ev.id) ?? [...building.entries()].sort((x, y) => x[0] - y[0])[0];
          if (live) {
            building.delete(live[0]);
            live[1].remove();
          }
          addStep(ensureSteps(), { id: ev.id, name: ev.name, summary: ev.summary, args: ev.args, status: 'running' });
          setActivity('running', ev.summary);
        } else if (ev.type === 'budget') {
          // Phase 79: the meter on this turn's step line; at the limit, the "Budget reached" card
          // (the redraw after the turn adds its Continue button).
          if (steps || ev.state.stage !== 'meter') setBudget(ensureSteps(), budgetMeter(ev.state, { compact: true }));
          if (ev.state.stage === 'reached') place(budgetCard(ev.state));
          else if (ev.state.stage === 'smaller-model' || ev.state.stage === 'fewer-tools' || ev.state.stage === 'summarize-stop') setActivity('thinking', t('saving budget'));
        } else if (ev.type === 'approval') {
          if (steps && !ev.budget) waitStep(steps, ev.id);
          const card = approvalCard(ev);
          place(card);
          card.scrollIntoView({ block: 'nearest' });
          setActivity('waiting', ev.summary);
        } else if (ev.type === 'contradiction') {
          // Phase 77: a flag (she mentions it), or how a stop ended (Do it anyway / Don't / Update the note).
          const old = document.querySelector(`.contradict-flag[data-call="${CSS.escape(ev.id)}"][data-mem="${ev.item.memoryId}"]`);
          const node = contradictionFlag(ev.item);
          if (old) old.replaceWith(node);
          else place(node);
        } else if (ev.type === 'skill') {
          // Phase 96: a skill that fits was loaded up front ("Used skill: …").
          skillStep(ensureSteps(), ev.name);
        } else if (ev.type === 'plugin') {
          // Phase 98: a plugin's note, card, stop, ask or skip (labelled with the plugin's name).
          if (ev.card) place(pluginResultCard(ev.card));
          else if (ev.what === 'followup') place(pluginNotice({ content: '', meta: { plugin: { name: ev.name, note: ev.text } } }));
          else pluginStep(ensureSteps(), pluginStepWords(ev), ev.what);
        } else if (ev.type === 'recall') {
          // Phase 85: a note she remembered on her own went into her next step.
          recallStep(ensureSteps(), recallKindWords(ev.item.kind));
          place(recallChip(ev.item, { api }));
        } else if (ev.type === 'sandbox_running') {
          // Phase 80: the command is being tried in a throwaway copy first.
          document.querySelector(`.approval[data-call="${CSS.escape(ev.id)}"]`)?.remove();
          if (steps) runStep(steps, ev.id);
          setActivity('running', t('trying it in a sandbox copy'));
        } else if (ev.type === 'sandbox') {
          // Phase 80: what the try showed and what you chose, under her step.
          place(sandboxFlag({ ...ev.record, callId: ev.id }));
        } else if (ev.type === 'advisory') {
          // Phase 81: the install check's outcome (installed anyway, not installed, not checked: offline).
          place(advisoryFlag(ev));
        } else if (ev.type === 'redteam') {
          // Phase 86: "Red-team first" on the ship card: the run started, shipping waits for its report.
          place(redteamFlag(ev));
        } else if (ev.type === 'tool_running') {
          document.querySelector(`.approval[data-call="${CSS.escape(ev.id)}"]`)?.remove();
          if (steps) runStep(steps, ev.id);
          setActivity('running', ev.summary);
        } else if (ev.type === 'tool_result') {
          if (steps) finishStep(steps, ev);
          // Phase 75: a result card from the tool's own result (the server's `card`).
          if (ev.card && ev.status === 'ok') {
            if (ev.card.kind === 'file') {
              liveFiles.push(ev.card);
              const fresh = renderCards(liveFiles)[0];
              if (filesEl?.isConnected) filesEl.replaceWith(fresh);
              else place(fresh);
              filesEl = fresh;
            } else place(renderCard(ev.card));
          }
          if (ev.name === 'preview_start' && ev.status === 'ok') {
            const card = previewCard(ev.output);
            if (card) {
              place(card);
              // The first preview of a conversation opens by itself (on wide screens).
              if (!state.previewUrl && matchMedia('(min-width: 761px)').matches) openPreview(card.dataset.url);
            }
          }
          document.querySelector(`.approval[data-call="${CSS.escape(ev.id)}"]`)?.remove();
          setActivity('thinking');
        } else if (ev.type === 'token') {
          if (groupSpeaker) setActivity('answering', groupSpeaker.name);
          else if (activity.status !== 'writing') setActivity('writing');
          if (!reply) {
            reply = bubble('assistant', '', 'typing');
            speakerHeader(reply, groupSpeaker);
            const before = steps?.isConnected ? steps.previousElementSibling : $('#messages').lastElementChild;
            if (!groupSpeaker) herFace(reply, !isHerBubble(before));
            else reply.classList.add('her', ...(isHerBubble(before) ? [] : ['run-start']));
            place(reply);
          }
          queueReply(reply, (reply._raw ?? '') + ev.text);
          if (voiceOn()) speaker.feed(ev.text);
          if (videoView.active && voice.call?.active) videoView.her(ev.text);
          $('#messages').scrollTop = $('#messages').scrollHeight;
        } else if (ev.type === 'claim_check') {
          if (voiceOn() && ev.correcting) speaker.stop();
          const r = reply;
          if (ev.correcting || !r?._typer) {
            endReply();
            if (r) flagClaims(r, ev.claims);
          } else {
            // Typed reply still being shown: mark the claims once it's all there.
            reply = null;
            void typedOut(r).then(() => {
              r.classList.remove('typing');
              flagClaims(r, ev.claims);
            });
            pendingTyped = r;
          }
          if (ev.correcting) setActivity('thinking', t('checking her claims'));
        } else if (ev.type === 'replace') {
          // Phase 28: her reply failed a safety check; show the replacement instead.
          if (voiceOn()) speaker.stop();
          const r = reply ?? [...document.querySelectorAll('#messages .msg.assistant')].pop();
          finishTyping(r);
          if (r) {
            r.classList.remove('typing');
            setReply(r, ev.text);
          }
          if (videoView.active && voice.call?.active) videoView.herDone(ev.text);
          reply = null;
          pendingTyped = null;
        } else if (ev.type === 'proof') {
          // Phase 49: a screenshot she took; the strip lands on her reply when it's done.
          place(proofStrip([ev.id], true));
        } else if (ev.type === 'image') {
          endReply();
          place(bubble('assistant', '', 'photo', undefined, [`/api/uploads/${ev.id}`]));
        } else if (ev.type === 'error') {
          dropBuilding();
          append(bubble('error', ev.speaker ? `${ev.speaker.name}: ${serverText(ev, ev.message)}` : ev.message));
        }
        // A call that was dropped (a fallback, a blocked reply) never stays half-written.
        if (ev.type === 'notice' || ev.type === 'replace' || ev.type === 'claim_check' || ev.type === 'done') dropBuilding();
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') append(bubble('error', err.message));
  } finally {
    dropBuilding();
    if (voiceOn()) speaker.flush();
    if (videoView.active && voice.call?.active) videoView.herDone();
    // A typed reply finishes typing before the chat is redrawn (stopping shows it all at once).
    if (!controller.signal.aborted) await Promise.all([typedOut(reply), typedOut(pendingTyped)]);
    else finishTyping(pendingTyped);
    endReply();
    speaker.voice = null;
    state.streaming = null;
    setActivity(null);
    setComposerBusy(false);
    await loadConversations();
    const current = state.conversations.find((c) => c.id === state.currentId);
    if (current) $('#chat-title').textContent = current.title;
    // Redraw from the server so every message has its id, model and buttons.
    try {
      const c = await api(`/conversations/${state.currentId}?limit=${Math.max(PAGE, (state.messages?.length ?? 0) + 10)}`);
      if (!c.activity && !state.streaming) {
        state.conv = { ...state.conv, earlier: c.earlier, pinned: c.pinned };
        renderPins();
        const errors = [...document.querySelectorAll('#messages .msg.error')];
        renderMessages(c.messages);
        for (const e of errors) append(e);
      }
    } catch {
      /* keep what is shown */
    }
    refreshSaraStatus();
    void updateConvUsage();
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#input').value.trim() || (state.photos.length ? '(photo)' : state.docs.length ? '(document)' : '');
  if (!text || state.streaming || state.watch) return;
  $('#input').value = '';
  autosize();
  send(text);
});

$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

function autosize() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  // A scroll bar only when it's taller than the box can grow (no stray arrows on one line).
  el.classList.toggle('scrolls', el.scrollHeight > 200);
}
$('#input').addEventListener('input', autosize);

$('#stop').addEventListener('click', async () => {
  if (state.currentId) await api(`/conversations/${state.currentId}/stop`, { method: 'POST', body: {} }).catch(() => {});
  state.streaming?.abort();
});

// ---------- Phase 49: previews and proof ----------
const PREVIEW_RE = /\/preview\/[0-9a-f]{32}\/[^\s)"'<>]*/;
function previewCard(output) {
  const m = PREVIEW_RE.exec(String(output ?? ''));
  if (!m) return null;
  const card = el('div', 'preview-card');
  card.dataset.url = m[0];
  const port = /port (\d+)/.exec(String(output))?.[1];
  card.append(el('span', '', '🖥️'), el('span', 'muted', port ? t('Her app (port {port})', { port }) : t('Her app')));
  const open = el('button', 'small', t('Preview'));
  open.type = 'button';
  open.addEventListener('click', () => openPreview(m[0]));
  card.append(open);
  return card;
}

function openPreview(url) {
  if (!url || !PREVIEW_RE.test(url)) return;
  state.previewUrl = url;
  const pane = $('#preview-pane');
  pane.hidden = false;
  $('#main').classList.add('has-preview');
  $('#preview-frame').src = url;
  $('#preview-newtab').href = url;
  $('#preview-where').textContent = url.replace(/^\/preview\/[0-9a-f]{32}/, '') || '/';
}
function closePreview() {
  state.previewUrl = null;
  $('#preview-pane').hidden = true;
  $('#main').classList.remove('has-preview');
  $('#preview-frame').removeAttribute('src');
}
$('#preview-close').addEventListener('click', closePreview);
$('#preview-reload').addEventListener('click', () => {
  // A sandboxed frame can't be reached from here (on purpose): reload it by setting its address again.
  if (state.previewUrl) $('#preview-frame').src = state.previewUrl;
});
$('#preview-width').addEventListener('click', () => {
  const phone = $('#preview-stage').classList.toggle('phone');
  $('#preview-width').setAttribute('aria-pressed', String(phone));
  $('#preview-width').textContent = phone ? `🖥 ${t('Desktop')}` : `📱 ${t('Phone')}`;
});

/** A small strip of screenshots she took while testing (proof for her claims). */
function proofStrip(ids, live = false) {
  const strip = el('div', live ? 'proof-strip msg notice' : 'proof-strip');
  strip.append(el('span', 'proof-label', live ? t('📸 Screenshot from her testing browser') : t('📸 What she saw while testing')));
  for (const id of ids) {
    const img = document.createElement('img');
    img.src = `/api/uploads/${id}`;
    img.alt = t('Screenshot from her testing browser');
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(img.src, '_blank', 'noopener'));
    strip.append(img);
  }
  return strip;
}

// ---------- receipts ----------
function flagClaims(el, claims) {
  el.classList.add('unverified');
  const note = document.createElement('div');
  note.className = 'claim-flag';
  note.textContent = `${t('Not checked:')} ${claims.map((c) => (c.problem === 'contradicted' ? t('"{sentence}" (what really happened says otherwise)', { sentence: c.sentence }) : t('"{sentence}" (nothing she did shows this)', { sentence: c.sentence }))).join('; ')}`;
  el.append(note);
}

// ---------- tool activity ----------
const STATUS_LABEL = { running: 'running…', ok: 'done', error: 'failed', denied: 'declined' };

// Everyday tools read as plain words with an icon; code tools (files, shell, git) stay monospace.
/** A span holding one of web/icons.js's line icons (decorative; the words beside it say what it is). */
function iconSpan(cls, name) {
  const span = el('span', cls);
  span.setAttribute('aria-hidden', 'true');
  const svg = icon(name) ?? icon('tool');
  if (svg) span.append(svg);
  return span;
}
const CODE_TOOL = /^(shell|read_file|write_file|edit_file|list_dir|search|git|git_\w+|github_\w+|review_code|delegate_task)$/;

function toolBlock({ name, summary, status, output, ms, snapshotId }) {
  const d = document.createElement('details');
  d.className = `tool ${status}`;
  const sum = document.createElement('summary');
  const label = document.createElement('span');
  const plain = name && !CODE_TOOL.test(name);
  label.className = plain ? 'tool-summary plain' : 'tool-summary';
  label.textContent = summary || name || 'tool';
  if (plain) setIcon(label, TOOL_ICONS[name] ?? 'tool');
  const st = document.createElement('span');
  st.className = 'tool-status';
  sum.append(label, st);
  const pre = document.createElement('pre');
  d.append(sum, pre);
  fillToolBlock(d, { status, output, ms, snapshotId });
  return d;
}

/** Phase 63: the live card of a tool call being written (file path, the text growing, a line count). */
function buildingCard() {
  const d = document.createElement('div');
  d.className = 'tool running building';
  const head = el('div', 'building-head');
  head.append(el('span', 'tool-summary'), el('span', 'tool-status'));
  const pre = el('pre', 'building-code');
  pre.append(document.createElement('code'));
  d.append(head, pre);
  return d;
}

function fillBuildingCard(d, ev) {
  if (ev.id) d.dataset.call = ev.id;
  d.classList.toggle('file', ev.kind === 'file');
  const plain = Boolean(ev.name && !CODE_TOOL.test(ev.name));
  const label = d.querySelector('.tool-summary');
  label.classList.toggle('plain', plain);
  // A file shows its path (the tool's name until the path can be read); other tools their name.
  label.textContent = ev.kind === 'file' && ev.path ? ev.path : ev.name;
  if (plain) setIcon(label, TOOL_ICONS[ev.name] ?? 'tool');
  label.title = `${ev.name}${ev.path ? ` ${ev.path}` : ''}`;
  d.querySelector('.tool-status').textContent = ev.kind === 'file' && ev.lines ? (ev.lines === 1 ? t('writing… 1 line') : t('writing… {n} lines', { n: ev.lines })) : t('writing…');
  const pre = d.querySelector('.building-code');
  pre.hidden = !ev.preview;
  pre.classList.toggle('cut', Boolean(ev.cut));
  pre.firstChild.textContent = ev.preview;
  pre.scrollTop = pre.scrollHeight;
}

function addUndo(d, snapshotId) {
  if (!snapshotId || d.querySelector('.undo') || !state.conv) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost undo';
  btn.textContent = t('Undo to before this step');
  btn.addEventListener('click', async () => {
    if (!confirm(t('Put every file in this workspace back the way it was before this step? Later changes are undone (you can undo the undo).'))) return;
    btn.disabled = true;
    try {
      const r = await api(`/workspaces/${encodeURIComponent(state.conv.workspace)}/snapshots/${snapshotId}/restore`, { method: 'POST', body: { conversationId: state.conv.id } });
      append(bubble('notice', t('Workspace restored: {restored} files put back, {removed} removed.', { restored: r.restored, removed: r.removed }), 'restore'));
    } catch (err) {
      append(bubble('error', err.message));
      btn.disabled = false;
    }
  });
  d.append(btn);
}

function fillToolBlock(d, { status, output, ms, snapshotId }) {
  addUndo(d, snapshotId);
  d.className = `tool ${status}`;
  d.querySelector('.tool-status').textContent = `${STATUS_LABEL[status] ? t(STATUS_LABEL[status]) : status}${ms !== undefined && status !== 'running' ? ` · ${(ms / 1000).toFixed(1)}s` : ''}`;
  d.querySelector('pre').textContent = output ?? '';
}

/**
 * Approvals that came from another app (MCP write tools; their id starts with "app-") as
 * "Claude Code wants to remember: I like tea". The server's summary is "<key name>: <what>".
 */
/** A key nobody named is "Another app" on the server: shown in the app language. */
const appName = (name) => (name === 'Another app' ? t('Another app') : name);

function appApprovalText(ev) {
  if (!String(ev.id ?? '').startsWith('app-')) return '';
  const m = /^(.*?): (Remember|Add a to-do|Save a note): ([\s\S]*)$/.exec(String(ev.summary ?? ''));
  if (!m) {
    const g = /^(.*?): ([\s\S]+)$/.exec(String(ev.summary ?? ''));
    return g ? t('{app} wants to: {what}', { app: appName(g[1]), what: g[2] }) : String(ev.summary ?? '');
  }
  const [, name, verb, what] = m;
  const app = appName(name);
  if (verb === 'Remember') return t('{app} wants to remember: {what}', { app, what });
  if (verb === 'Add a to-do') return t('{app} wants to add a to-do: {what}', { app, what });
  return t('{app} wants to save a note: {what}', { app, what });
}

function approvalCard(ev, block) {
  const card = document.createElement('div');
  card.className = 'approval';
  card.dataset.call = ev.id;
  const title = document.createElement('p');
  const what = document.createElement('pre');
  const fromApp = appApprovalText(ev);
  if (fromApp) {
    // UX 8: a change another app (MCP) asked for: one plain sentence, no tool names or JSON.
    title.textContent = fromApp;
    title.dataset.raw = '';
    what.hidden = true;
  } else if (TOOL_NAME[ev.name]) {
    // UI cleanup (wave 2): a built-in tool reads as its plain name with an icon and one sentence
    // on what it does; the exact command or details stay below, the raw name in small print.
    card.classList.add('approval-tidy');
    title.className = 'approval-title';
    title.append(
      iconSpan('approval-icon', TOOL_ICONS[ev.name] ?? (CODE_TOOL.test(ev.name) ? 'terminal' : 'tool')),
      el('span', 'approval-what', t('{app} wants to: {what}', { app: currentIdentity().name || t('Sara'), what: t(TOOL_NAME[ev.name]) })),
    );
    title.dataset.raw = '';
    // Phase 99: a board step reads as one plain line ("Move “Fix login” (Website) from To do to Doing").
    what.textContent = ev.name === 'shell' ? String(ev.args.command ?? '') : /^card_/.test(ev.name) && ev.summary ? ev.summary : JSON.stringify(ev.args, null, 2);
  } else {
    title.textContent = t('{name} wants to use {tool}:', { name: currentIdentity().name || t('Sara'), tool: ev.name });
    title.dataset.raw = '';
    what.textContent = ev.name === 'shell' ? String(ev.args.command ?? '') : JSON.stringify(ev.args, null, 2);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const c = ev.contradiction;
  // Phase 79: "Ask me before going on": the budget is reached; going on is the owner's explicit OK.
  if (ev.budget) {
    title.textContent = t('Budget reached: keep going?');
    title.dataset.raw = '';
    what.hidden = true;
    card.classList.add('approval-budget');
  }
  const decide = async (approved, how) => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api(`/approvals/${ev.approvalId}`, { method: 'POST', body: { approved, ...(how ? { how } : {}) } });
      card.remove();
      // Phase 77: "Update the note" opens that note so you can correct it.
      if (how === 'update' && c) void openMemory({ focus: c.memoryId });
    } catch (err) {
      title.textContent = err.message;
    }
  };
  // Phase 80: "Ran in a sandbox": what the try did in a throwaway copy; Apply / Discard / Run for real.
  if (ev.sandbox) {
    title.textContent = t('Ran in a sandbox: apply it to your workspace?');
    title.dataset.raw = '';
    card.classList.add('approval-sandbox');
    card.append(title, sandboxSection(ev.sandbox), sandboxButtons(ev.sandbox, decide));
    if (block) block.open = false;
    return card;
  }
  // Phase 96: a skill's script, a skill to save, or a change to one (web/skills.js).
  if (ev.skill) {
    skillApproval(card, title, ev, decide);
    if (block) block.open = false;
    return card;
  }
  // Phase 88: computer use: what she would do where, and only the answers this card allows.
  if (ev.computer) {
    computerApproval(card, title, ev.computer, decide);
    if (block) block.open = false;
    return card;
  }
  // Phase 98: a plugin asked to check this (normally automatic) step with the owner.
  if (ev.plugin) title.after(pluginAskLine(ev.plugin));
  // Phase 81: "Known vulnerability": installing a known-vulnerable version needs an explicit override.
  const adv = ev.advisory;
  if (adv && !c) {
    title.textContent = t('Known vulnerability: install anyway?');
    title.dataset.raw = '';
    card.classList.add('approval-advisory');
  }
  // Phase 86: "Red-team before shipping": Red-team first / Ship / Don't.
  const rtg = ev.redteam;
  if (rtg && !c && !adv) {
    title.textContent = rtg.mode === 'ask' ? t('Red-team before shipping?') : t('Ship after the red-team run?');
    title.dataset.raw = '';
    card.classList.add('approval-advisory');
  }
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.textContent = c ? t('Do it anyway') : adv ? t('Install anyway') : rtg ? t('Ship without it') : ev.budget ? t('Keep going') : ev.sandboxFirst ? t('Try it in a copy') : t('Allow');
  yes.addEventListener('click', () => decide(true, c || adv ? 'override' : undefined));
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'ghost';
  no.textContent = c ? t("Don't") : adv ? t("Don't install") : ev.budget ? t('Wrap up') : t('Deny');
  no.addEventListener('click', () => decide(false, c || adv ? 'deny' : undefined));
  row.append(yes, no);
  if (rtg && !c && !adv && rtg.mode === 'ask') {
    const first = document.createElement('button');
    first.type = 'button';
    first.textContent = t('Red-team first');
    first.addEventListener('click', () => decide(false, 'redteam'));
    row.prepend(first);
    yes.className = 'ghost';
  }
  if (c) {
    const upd = document.createElement('button');
    upd.type = 'button';
    upd.className = 'ghost';
    upd.textContent = t('Update the note');
    upd.addEventListener('click', () => decide(false, 'update'));
    row.append(upd);
    card.classList.add('approval-contradict');
  }
  // Gmail organizing: the count-first card ("Archive 4,213 emails?", the search, a few of them).
  const gm = ev.detail?.kind === 'gmail' ? gmailApproval(ev.detail) : null;
  if (gm) {
    const q = title.querySelector('.approval-what');
    if (q) q.textContent = gmailQuestion(ev.detail);
    else title.textContent = gmailQuestion(ev.detail);
    what.hidden = true;
    card.classList.add('approval-gmail');
  }
  card.append(title, ...(c ? [contradictionSection(c)] : []), ...(adv ? [advisorySection(adv)] : []), ...(rtg && !c && !adv ? [redteamGateSection(rtg)] : []), ...(ev.budget ? [budgetMeter(ev.budget)] : []), ...(gm ? [gm] : []), what, ...(ev.sandboxFirst ? [sandboxFirstNote(ev.sandboxFirst)] : []), row);
  if (card.classList.contains('approval-tidy')) {
    if (TOOL_WORDS[ev.name]) title.after(el('p', 'approval-about muted small', t(TOOL_WORDS[ev.name])));
    row.append(el('span', 'tool-raw approval-raw', ev.name));
  }
  if (block) block.open = false;
  return card;
}

// ---------- Phase 88: computer-use cards (docs/design/COMPUTER_USE.md §9.2) ----------
const CU_ROLE = {
  button: (n) => t('the button “{name}”', { name: n }),
  link: (n) => t('the link “{name}”', { name: n }),
  textbox: (n) => t('the field “{name}”', { name: n }),
  combobox: (n) => t('the list “{name}”', { name: n }),
  checkbox: (n) => t('the checkbox “{name}”', { name: n }),
  radio: (n) => t('the option “{name}”', { name: n }),
};
const cuTarget = (k) => (k.name ? (CU_ROLE[k.role] ?? ((n) => `“${n}”`))(k.name) : t('the page'));
const CU_ASK = {
  click: (a) => t('{name} wants to click {target} on {site}', a),
  type: (a) => t('{name} wants to type into {target} on {site}', a),
  select: (a) => t('{name} wants to choose in {target} on {site}', a),
  keys: (a) => t('{name} wants to press keys on {site}', a),
  upload: (a) => t('{name} wants to upload a file to {target} on {site}', a),
  login: (a) => t('{name} wants to sign in to {site} with your saved “{login}” login', a),
  // Phase 91: a login from the owner's own password manager on that computer.
  pmLogin: (a) => t('{name} wants to sign in to {site} with your password manager ({managers})', a),
};
const CU_TEXT = { type: (a) => t('Text: {text}', a), select: (a) => t('Option: {text}', a), keys: (a) => t('Keys: {text}', a), upload: (a) => t('File: {text}', a) };
const CU_KIND = { click: () => t('clicking'), type: () => t('typing'), select: () => t('choosing in lists'), keys: () => t('pressing keys'), upload: () => t('uploading files') };
function computerApproval(card, title, k, decide) {
  card.classList.add('approval-computer');
  card.classList.add('approval-tidy');
  if (k.risk === 'payment' || k.risk === 'account') card.classList.add('approval-advisory');
  title.className = 'approval-title';
  const managers = Array.isArray(k.managers) ? k.managers.join(', ') : '';
  const ask = (k.action === 'login' && managers ? CU_ASK.pmLogin : (CU_ASK[k.action] ?? CU_ASK.click))({ name: currentIdentity().name || t('Sara'), target: cuTarget(k), site: k.site, login: k.name || '', managers });
  title.replaceChildren(iconSpan('approval-icon', k.action === 'type' ? 'keyboard' : k.action === 'login' ? 'lock' : 'pointer'), el('span', 'approval-what', ask));
  title.dataset.raw = '';
  const where = el('p', 'approval-about muted small', t('In the Sara browser on {computer}.', { computer: k.computer }));
  where.dataset.raw = '';
  const lines = [where];
  if (k.text && CU_TEXT[k.action]) {
    const tx = el('p', 'cu-card-text small', CU_TEXT[k.action]({ text: k.text }));
    tx.dataset.raw = '';
    lines.push(tx);
  }
  // Phase 90: a saved login fills on that computer only; she never sees the password.
  if (k.action === 'login') {
    const kept = el('p', 'muted small', t('The password stays on {computer}: Sara never sees it.', { computer: k.computer }));
    kept.dataset.raw = '';
    lines.push(kept);
  }
  if (k.action === 'login' && managers) {
    const unlock = el('p', 'muted small', t('If it is locked, you unlock it yourself in its own window there.'));
    unlock.dataset.raw = '';
    lines.push(unlock);
  }
  const why = k.risk === 'login' && managers ? t('Signing in with your password manager: this asks every time.') : k.risk === 'login' ? t('Using a saved login: this asks every time.') : k.risk === 'payment' ? t('A payment or purchase: this asks every time.') : k.risk === 'account' ? t('Account or security settings: this asks every time.') : k.risk === 'send' ? t('Sending something as you: this asks every time.') : k.choices.includes('task') ? t('Her first action on this site in this task.') : k.choices.includes('always') ? t('Every action asks (your setting).') : t('This asks every time.');
  lines.push(el('p', 'muted small', why));
  const row = el('div', 'row');
  const btn = (label, cls, fn) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    row.append(b);
    return b;
  };
  btn(t('Allow once'), '', () => decide(true));
  if (k.choices.includes('task')) btn(t('Allow for this task'), 'ghost', () => decide(true, 'task'));
  if (k.choices.includes('always')) btn(t('Always on {site}', { site: k.site }), 'ghost', () => decide(true, 'always'));
  btn(t("Don't"), 'ghost', () => decide(false));
  card.append(title, ...lines, row);
}

// ---------- Phase 77: her plans checked against what you decided ----------
const contradictRule = {
  'push-branch': (x) => t('rule: no push to {branch}', { branch: x.join(', ') }),
  'no-push': () => t('rule: no pushing'),
  'force-push': () => t('rule: no force push'),
  'tests-first': (x) => (x[0] === 'commit' ? t('rule: tests before every commit') : t('rule: tests before every push')),
  path: (x) => t('rule: hands off {path}', { path: x.join(' ') }),
  'package-manager': (x) => t('rule: not {program}', { program: x.join(', ') }),
  command: (x) => t('rule: never {command}', { command: x.join(' ') }),
  fuzzy: (x) => t('shared words {words}', { words: x.map((w) => `“${w}”`).join(', ') }),
};
const sureWord = { high: () => t('high'), medium: () => t('medium'), low: () => t('low') };
/** The note's [why …; sure …] line, in the app language (the same format as her memory notes). */
function contradictBracket(c) {
  const reasons = [];
  if (c.words?.length && c.rule !== 'fuzzy') reasons.push(t('words {words}', { words: c.words.slice(0, 4).map((w) => `“${w}”`).join(', ') }));
  const rule = contradictRule[c.rule];
  if (rule) reasons.push(rule(Array.isArray(c.target) ? c.target : []));
  return `[${t('why: {reasons}; sure: {sure}', { reasons: reasons.join(' + '), sure: (sureWord[c.sure] ?? sureWord.low)() })}]`;
}
/** The approval card's "This goes against something you decided" section. */
function contradictionSection(c) {
  const box = el('div', 'contradict');
  const head = el('p', 'contradict-head');
  head.append(iconSpan('contradict-icon', 'warn'), el('strong', '', t('This goes against something you decided')));
  const note = el('blockquote', 'contradict-note', `“${c.note}”`);
  note.dataset.raw = '';
  const meta = el('p', 'contradict-meta muted small', [t('Decided on {date}', { date: memDay(c.decidedOn) }), c.quote ? t('Your words: “{quote}”', { quote: c.quote }) : ''].filter(Boolean).join(' · '));
  meta.dataset.raw = '';
  const why = el('p', 'contradict-why muted small', contradictBracket(c));
  why.dataset.raw = '';
  box.append(head, note, meta, why);
  // Other notes the same step goes against (one answer covers them all).
  for (const o of Array.isArray(c.also) ? c.also.slice(0, 3) : []) {
    const more = el('p', 'contradict-also small', t('Also: “{note}” ({date})', { note: o.note, date: memDay(o.decidedOn) }));
    more.dataset.raw = '';
    box.append(more);
  }
  return box;
}
/** A flag under her step: she was told and mentions it (or how a stop ended). */
function contradictionFlag(c) {
  const box = el('div', `contradict-flag${c.act === 'stop' ? ' contradict-stopped' : ''}`);
  box.dataset.call = c.callId ?? '';
  box.dataset.mem = String(c.memoryId);
  const head =
    c.act !== 'stop' ? t('This may go against something you decided:') : c.answer === 'override' ? t('You chose to do it anyway, against what you decided:') : c.answer === 'update' ? t('Stopped so you can update the note:') : t('Stopped: it goes against what you decided:');
  const body = el('div', 'contradict-flag-body');
  const q = el('span', 'contradict-flag-note', `“${c.note}”`);
  q.dataset.raw = '';
  const why = el('span', 'contradict-why muted small', contradictBracket(c));
  why.dataset.raw = '';
  body.append(el('span', 'contradict-flag-head', head), q, why);
  const open = el('button', 'linkish small', t('Open the note'));
  open.type = 'button';
  open.addEventListener('click', () => void openMemory({ focus: c.memoryId }));
  body.append(open);
  box.append(iconSpan('contradict-icon', 'warn'), body);
  return box;
}

// ---------- tools settings ----------
// L11: what each built-in tool is for, in plain words (her own instructions stay out of tooltips).
const TOOL_WORDS = {
  list_dir: 'See which files and folders are in her workspace.',
  read_file: 'Read a file in her workspace.',
  write_file: 'Create or replace a file in her workspace.',
  edit_file: 'Change part of a file in her workspace.',
  search: 'Search the files in her workspace for words.',
  shell: 'Run a command in her workspace (for example to build or test a project).',
  web_fetch: 'Open a public web page and read it.',
  web_search: 'Search the web.',
  todo: 'Your to-do list and projects.',
  note: 'Notes she keeps for you.',
  remind: 'Reminders at a time or a place.',
  scrapbook: 'Your shared scrapbook of moments and inside jokes.',
  recall: 'Look back through your past conversations.',
  library: 'Read the documents you gave her.',
  tune_personality: 'Change one of her personality dials when you ask her to.',
  code_map: 'An overview of the code in her workspace.',
  code_find: 'Find code in her workspace by name or words.',
  code_refs: 'Find where something in the code is used.',
  code_deps: 'Which files use which other files.',
  recipe_save: 'Save how she did a tricky job, to do it again later.',
  skill_use: 'Open one of her skills (a how-to) to follow it.',
  skill_read: 'Read a file that comes with one of her skills.',
  skill_find: 'Look through her skills.',
  skill_run: 'Run a script that comes with one of her skills (asks you first).',
  skill_save: 'Save a new skill or change one (asks you first).',
  skill_update: 'Change one of her skills when a step was wrong (asks you first).',
  recipe_find: 'Look through the recipes she saved.',
  recipe_use: 'Follow a saved recipe.',
  share_photo: 'Send you one of her own pictures.',
  take_photo: 'Make a new picture of herself to send you.',
  ssh_servers: 'See the list of your servers she can reach over SSH.',
  ssh_connect: 'Add one of your servers to work on over SSH (you sign in to it in Settings).',
  ssh_run: 'Run a command on one of your servers over SSH.',
  ssh_forget_password: 'Forget a saved server password.',
  ssh_revoke_key: 'Remove her SSH key from one of your servers.',
  ssh_remove_server: 'Remove a server from her list.',
  start_job: 'Start a long task in the background and keep talking.',
  job_status: 'Check on a background task.',
  stop_job: 'Stop a background task.',
  git: 'Look at the project history and changes (read only).',
  git_commit: 'Save a checkpoint of the project (a commit).',
  git_branch: 'Start or switch to a separate line of work (a branch).',
  git_push: 'Send the saved work to GitHub.',
  delegate_task: 'Hand a coding job to Claude Code or Grok Build.',
  preview_start: 'Show you a web app she runs, next to the chat.',
  preview_stop: 'Close a preview.',
  browser_open: 'Open a page in her testing browser.',
  browser_screenshot: 'Take a picture of the page in her testing browser.',
  browser_click: 'Click something in her testing browser.',
  browser_type: 'Type into a box in her testing browser.',
  browser_read: 'Read the page in her testing browser.',
  browser_check: 'Check that a page in her testing browser works.',
  github_list: 'List issues and pull requests on GitHub.',
  github_read: 'Read an issue or pull request on GitHub.',
  github_create_issue: 'Open a new issue on GitHub.',
  github_comment: 'Comment on GitHub.',
  github_open_pr: 'Open a pull request on GitHub.',
  home_status: 'See your smart home (Home Assistant).',
  home_control: 'Switch things in your smart home (Home Assistant).',
  gmail_search: 'Search your Gmail.',
  gmail_read: 'Read an email.',
  gmail_thread: 'Read a whole email conversation.',
  gmail_needs_answer: 'Find emails waiting for your answer.',
  gmail_draft: 'Write an email draft for you to check and send.',
  gmail_send: 'Send an email when you clearly ask her to.',
  gmail_organize: 'Archive, mark read, label, star, trash or mark spam on many emails at once. Shows the count first; Undo for 30 days.',
  gmail_undo: 'Undo a change she made to your Gmail.',
  gmail_labels: 'See your Gmail labels.',
  gmail_senders: 'See who sends you the most email, to tidy up.',
  gmail_unsubscribe_info: 'Find the unsubscribe link of a sender (you open it yourself).',
  calendar_events: 'See your Google Calendar.',
  calendar_add: 'Add an event to your Google Calendar.',
  calendar_remove: 'Delete an event from your Google Calendar.',
  team_task: 'Lead a team of helpers on a bigger job.',
  team_status: 'Check on a team task.',
  starter_create: 'Start a new project from a ready-made template.',
  project_note: 'Remember things about a coding project.',
  settings_guide: 'Look up how this app works, to help you with settings.',
  review_code: 'Review code changes and say what to fix.',
  github_post_review: 'Post her code review on GitHub.',
  work_on_issue: 'Have her team work a GitHub issue through to a pull request.',
  shared_list: 'Your shared lists: music, books and shows.',
  change_outfit: 'Change into another of her saved looks.',
  moments: 'Find and show photos from your album of moments.',
};
// UI cleanup: each tool with a plain name, an icon, a sentence on what it lets her do and its raw
// name in small print; grouped by topic, each group with a summary and "Set all to".
const TOOL_NAME = {
  list_dir: 'See her files', read_file: 'Read files', write_file: 'Write files', edit_file: 'Edit files', search: 'Search her files',
  code_map: 'Code overview', code_find: 'Find code', code_refs: 'Where code is used', code_deps: 'How files connect',
  starter_create: 'Start a project from a template', project_note: 'Project notes', review_code: 'Review code',
  shell: 'Run commands', start_job: 'Start a background task', job_status: 'Check a background task', stop_job: 'Stop a background task', delegate_task: 'Hand a job to a coding agent',
  git: 'Look at project history', git_commit: 'Save a checkpoint (commit)', git_branch: 'Make or switch a branch', git_push: 'Send work to GitHub (push)',
  github_list: 'List GitHub issues and pull requests', github_read: 'Read a GitHub issue or pull request', github_create_issue: 'Open a GitHub issue', github_comment: 'Comment on GitHub', github_open_pr: 'Open a pull request', github_post_review: 'Post a code review on GitHub',
  team_task: 'Lead a team on a big job', team_status: 'Check on the team', work_on_issue: 'Work a GitHub issue with the team',
  web_search: 'Search the web', web_fetch: 'Open web pages',
  preview_start: 'Show you an app she runs', preview_stop: 'Close a preview', browser_open: 'Open a page in her test browser', browser_screenshot: 'Screenshot her test browser', browser_click: 'Click in her test browser', browser_type: 'Type in her test browser', browser_read: 'Read her test browser', browser_check: 'Check a page works',
  todo: 'To-dos', note: 'Notes', remind: 'Reminders', shared_list: 'Shared lists',
  recall: 'Look back at past chats', library: 'Read your documents', recipe_save: 'Save a recipe', recipe_find: 'Find a recipe', recipe_use: 'Follow a recipe',
  skill_use: 'Use a skill', skill_read: 'Read a skill\'s file', skill_find: 'Find a skill', skill_run: 'Run a skill\'s script', skill_save: 'Save a skill', skill_update: 'Change a skill',
  scrapbook: 'Scrapbook', moments: 'Our moments', share_photo: 'Send her pictures', take_photo: 'Make a new picture', change_outfit: 'Change her outfit',
  gmail_search: 'Search Gmail', gmail_read: 'Read an email', gmail_thread: 'Read an email conversation', gmail_needs_answer: 'Find emails to answer', gmail_draft: 'Draft an email', gmail_send: 'Send an email',
  gmail_organize: 'Organize your Gmail', gmail_undo: 'Undo a Gmail change', gmail_labels: 'See Gmail labels', gmail_senders: 'Gmail clean-up summary', gmail_unsubscribe_info: 'Find unsubscribe links',
  calendar_events: 'See your calendar', calendar_add: 'Add a calendar event', calendar_remove: 'Delete a calendar event',
  home_status: 'See your smart home', home_control: 'Switch things at home',
  ssh_servers: 'List your servers', ssh_connect: 'Add a server', ssh_run: 'Run commands on a server', ssh_forget_password: 'Forget a server password', ssh_revoke_key: 'Remove her key from a server', ssh_remove_server: 'Remove a server',
  tune_personality: 'Adjust her personality', settings_guide: 'Look up how the app works',
  board_list: 'Look at your board', card_add: 'Put a card on your board', card_move: 'Move a card on your board', card_comment: 'Comment on a card', card_ask: 'Ask you about a card', card_assign: 'Assign a card',
  agenda_add: 'Added to her plans', agenda_goal: 'Suggest a goal', agenda_list: 'Look at her plans',
};
const TOOL_GROUP_OF = {
  todo: 'plan', note: 'plan', remind: 'plan', shared_list: 'plan',
  board_list: 'plan', card_add: 'plan', card_move: 'plan', card_comment: 'plan', card_ask: 'plan', card_assign: 'plan',
  agenda_add: 'plan', agenda_goal: 'plan', agenda_list: 'plan',
  recall: 'memory', library: 'memory', recipe_save: 'memory', recipe_find: 'memory', recipe_use: 'memory',
  skill_use: 'memory', skill_read: 'memory', skill_find: 'memory', skill_run: 'run', skill_save: 'memory', skill_update: 'memory',
  scrapbook: 'pictures', moments: 'pictures', share_photo: 'pictures', take_photo: 'pictures', change_outfit: 'pictures',
  web_search: 'web', web_fetch: 'web',
  gmail_search: 'mail', gmail_read: 'mail', gmail_thread: 'mail', gmail_needs_answer: 'mail', gmail_draft: 'mail', gmail_send: 'mail', calendar_events: 'mail', calendar_add: 'mail', calendar_remove: 'mail',
  gmail_organize: 'mail', gmail_undo: 'mail', gmail_labels: 'mail', gmail_senders: 'mail', gmail_unsubscribe_info: 'mail',
  home_status: 'home', home_control: 'home',
  list_dir: 'files', read_file: 'files', write_file: 'files', edit_file: 'files', search: 'files', code_map: 'files', code_find: 'files', code_refs: 'files', code_deps: 'files', starter_create: 'files', project_note: 'files', review_code: 'files',
  shell: 'run', start_job: 'run', job_status: 'run', stop_job: 'run', delegate_task: 'run',
  git: 'git', git_commit: 'git', git_branch: 'git', git_push: 'git', github_list: 'git', github_read: 'git', github_create_issue: 'git', github_comment: 'git', github_open_pr: 'git', github_post_review: 'git',
  team_task: 'team', team_status: 'team', work_on_issue: 'team',
  preview_start: 'browser', preview_stop: 'browser', browser_open: 'browser', browser_screenshot: 'browser', browser_click: 'browser', browser_type: 'browser', browser_read: 'browser', browser_check: 'browser',
  ssh_servers: 'ssh', ssh_connect: 'ssh', ssh_run: 'ssh', ssh_forget_password: 'ssh', ssh_revoke_key: 'ssh', ssh_remove_server: 'ssh',
  tune_personality: 'her', settings_guide: 'her',
};
const TOOL_GROUP_ORDER = ['plan', 'memory', 'pictures', 'web', 'mail', 'home', 'her', 'files', 'run', 'git', 'team', 'browser', 'ssh', 'mcp', 'other'];
const TOOL_GROUP_ICON = { plan: 'todo', memory: 'recall', pictures: 'photo', web: 'globe', mail: 'mail', home: 'home', her: 'sliders', files: 'folder', run: 'terminal', git: 'branch', team: 'team', browser: 'compass', ssh: 'server', mcp: 'puzzle', other: 'tool' };
const TOOL_GROUP_TEXT = {
  plan: 'Planner and notes', memory: 'Memory and know-how', pictures: 'Pictures and keepsakes', web: 'The web', mail: 'Email and calendar', home: 'Smart home',
  her: 'Her and this app', files: 'Files and code', run: 'Running commands', git: 'Git and GitHub', team: 'Her team', browser: 'Test browser and previews',
  ssh: 'Servers over SSH', mcp: 'Other programs (MCP)', other: 'Other tools',
};
const TOOL_GROUP_ABOUT = {
  plan: 'Your to-dos, notes, reminders and shared lists.', memory: 'Looking back at your chats, your documents and how she did tricky jobs.', pictures: 'Her pictures, outfits, the scrapbook and your album.',
  web: 'Searching the web and reading public pages.', mail: 'Your Gmail and Google Calendar. Sending, organizing mail and adding events ask first.', home: 'Lights, sensors and switches through Home Assistant.',
  her: 'Changing her personality dials and looking up how the app works.', files: 'Reading and changing files in her workspace.', run: 'Commands and long tasks on this server.',
  git: 'Project history and GitHub: commits, branches, issues and pull requests.', team: 'Helpers she leads on bigger jobs.', browser: 'A browser without a window she tests her web apps in.',
  ssh: 'Your other servers over SSH. Commands ask first.', mcp: 'Tools from other programs you added.', other: 'Tools that fit no other group.',
};
// Why a tool can't be used yet, and the page that sets it up.
const TOOL_NEEDS = {
  web_search: 'search', github_list: 'github', github_read: 'github', github_create_issue: 'github', github_comment: 'github', github_open_pr: 'github', github_post_review: 'github', work_on_issue: 'github',
  gmail_search: 'google', gmail_read: 'google', gmail_thread: 'google', gmail_needs_answer: 'google', gmail_draft: 'google', gmail_send: 'google', calendar_events: 'google', calendar_add: 'google', calendar_remove: 'google',
  gmail_organize: 'google', gmail_undo: 'google', gmail_labels: 'google', gmail_senders: 'google', gmail_unsubscribe_info: 'google',
  home_status: 'home', home_control: 'home', take_photo: 'pictures', change_outfit: 'looks', delegate_task: 'agents', moments: 'moments',
};
const TOOL_NEED_TEXT = {
  search: 'Needs a web search service first.', github: 'Needs your GitHub token first.', google: 'Needs Gmail and Calendar connected first.', home: 'Needs Home Assistant connected first.',
  pictures: 'Needs pictures from her set up first.', looks: 'Needs saved looks in her closet first.', agents: 'Needs Claude Code or Grok Build signed in first.', moments: 'Our moments is off.', none: 'Not set up yet',
};
const TOOL_NEED_PAGE = { search: 'ab-search', github: 'ab-github', google: 'ab-google', home: 'ab-home', pictures: 'her-pictures', looks: 'her-look', agents: 'models-subs' };
const PERM_LABEL = { auto: 'Allowed', ask: 'Ask me first', never: 'Off' };
const toolGroupsOpen = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem('sara.toolGroups') ?? '[]'));
  } catch {
    return new Set();
  }
};
function toolGroupSummary(box) {
  const sels = [...box.querySelectorAll('select[data-tool]')];
  const n = (p) => sels.filter((s) => s.value === p).length;
  const parts = [sels.length === 1 ? t('1 tool') : t('{n} tools', { n: sels.length })];
  if (n('auto')) parts.push(t('{n} allowed', { n: n('auto') }));
  if (n('ask')) parts.push(t('{n} ask first', { n: n('ask') }));
  if (n('never')) parts.push(t('{n} off', { n: n('never') }));
  box.querySelector('.tool-group-sum').textContent = parts.join(' · ');
}
function toolRow(tool) {
  const row = el('div', 'tool-perm');
  row.dataset.toolRow = tool.name;
  const builtIn = tool.source === 'built-in';
  const icon = iconSpan('tool-icon', builtIn ? (TOOL_ICONS[tool.name] ?? (CODE_TOOL.test(tool.name) ? 'terminal' : 'tool')) : 'puzzle');
  const text = el('div', 'tool-text');
  const title = el('span', 'tool-name', builtIn ? t(TOOL_NAME[tool.name] ?? tool.name) : tool.name);
  const words = builtIn ? t(TOOL_WORDS[tool.name] ?? '') : tool.description;
  // L11: the plain description is also the hover tip (her own instructions stay out of it).
  title.title = words;
  const what = el('span', 'tool-what', words);
  const raw = el('code', 'tool-raw', tool.name);
  if (!builtIn) raw.append(el('small', '', ` · ${tool.source}`));
  text.append(title, what);
  const meta = el('span', 'tool-meta');
  meta.append(raw);
  if (!tool.available) {
    row.classList.add('unavailable');
    const need = TOOL_NEEDS[tool.name] ?? 'none';
    const note = el('span', 'tool-need', t(TOOL_NEED_TEXT[need]));
    if (TOOL_NEED_PAGE[need]) {
      const go = el('button', 'linkish tool-need-go', t('Set it up'));
      go.type = 'button';
      go.addEventListener('click', () => showSettingsTab(TOOL_NEED_PAGE[need], { focus: true }));
      note.append(' ', go);
    }
    meta.append(note);
    row.title = t(TOOL_NEED_TEXT[need]);
  }
  text.append(meta);
  const sel = document.createElement('select');
  sel.dataset.tool = tool.name;
  sel.setAttribute('aria-label', builtIn ? t(TOOL_NAME[tool.name] ?? tool.name) : tool.name);
  for (const p of ['auto', 'ask', 'never']) sel.append(new Option(t(PERM_LABEL[p]), p));
  sel.value = tool.permission;
  sel.addEventListener('change', () => toolGroupSummary(row.closest('.tool-group')));
  row.append(icon, text, sel);
  return row;
}
async function loadTools() {
  const data = await api('/tools');
  // M9: the server's sandbox words are translated here (keys in i18n/_extra.json).
  $('#sandbox-status').textContent = `${data.sandbox.mode !== 'none' ? t('Sandbox: on.') : t('Sandbox: off.')} ${t(data.sandbox.note ? data.sandbox.detail.replace(data.sandbox.note, '').trim() : data.sandbox.detail)}`;
  // Phase 46: no sandbox (Windows): commands ask first unless you chose otherwise.
  $('#sandbox-note').hidden = !data.sandbox.note;
  $('#sandbox-note').textContent = data.sandbox.note ? t('{note} You can still set a tool to Allowed below; then her commands run on this computer without asking.', { note: t(data.sandbox.note) }) : '';
  $('#shell-network').checked = data.shellNetwork;
  // Phase 77: check her plans against what you decided.
  $('#contradict-on').checked = data.contradict?.on !== false;
  $('#contradict-mode').value = data.contradict?.mode ?? 'stop';
  $('#contradict-mode').disabled = !$('#contradict-on').checked;
  // Phase 49: the browser she tests web apps with.
  const br = data.browser ?? { found: false, how: '' };
  $('#browser-status').textContent = br.found ? `${t('Found')}: ${br.name}. ${t('She can open her previews in it, click through them and take desktop and phone screenshots.')}` : `${t('Not found.')} ${br.how}`;
  const byGroup = new Map();
  for (const tool of data.tools) {
    const g = tool.source !== 'built-in' ? 'mcp' : (TOOL_GROUP_OF[tool.name] ?? 'other');
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(tool);
  }
  const open = toolGroupsOpen();
  $('#tool-list').replaceChildren(
    ...TOOL_GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
      const box = document.createElement('details');
      box.className = 'tool-group';
      box.dataset.group = g;
      box.open = open.has(g);
      const sum = document.createElement('summary');
      const icon = iconSpan('tool-group-icon', TOOL_GROUP_ICON[g]);
      const head = el('span', 'tool-group-head');
      head.append(el('strong', 'tool-group-name', t(TOOL_GROUP_TEXT[g])), el('span', 'tool-group-about', t(TOOL_GROUP_ABOUT[g])));
      sum.append(icon, head, el('span', 'tool-group-sum'));
      box.append(sum);
      // "Set all to": one choice for the whole group (each tool can still be changed after).
      const bar = el('div', 'tool-group-bar');
      const set = document.createElement('select');
      set.className = 'tool-group-set';
      set.setAttribute('aria-label', t('Set every tool in {group} to', { group: t(TOOL_GROUP_TEXT[g]) }));
      set.append(new Option(t('Set all to…'), ''));
      for (const p of ['auto', 'ask', 'never']) set.append(new Option(t(PERM_LABEL[p]), p));
      set.addEventListener('change', () => {
        if (!set.value) return;
        for (const s of box.querySelectorAll('select[data-tool]')) s.value = set.value;
        set.value = '';
        toolGroupSummary(box);
        markSettingsArea('ab-tools');
      });
      const lab = el('label', 'tool-group-set-label');
      lab.append(el('span', 'muted small', t('Whole group:')), set);
      bar.append(lab);
      box.append(bar, ...byGroup.get(g).map(toolRow));
      box.addEventListener('toggle', () => {
        const now = toolGroupsOpen();
        if (box.open) now.add(g);
        else now.delete(g);
        localStorage.setItem('sara.toolGroups', JSON.stringify([...now]));
      });
      toolGroupSummary(box);
      return box;
    }),
  );
}

$('#contradict-on').addEventListener('change', () => ($('#contradict-mode').disabled = !$('#contradict-on').checked));
$('#browser-recheck').addEventListener('click', async () => {
  $('#browser-status').textContent = t('Looking…');
  await api('/tools?recheck=1').catch(() => {});
  await loadTools().catch(() => {});
});

async function saveTools() {
  const permissions = {};
  for (const sel of document.querySelectorAll('#tool-list select[data-tool]')) permissions[sel.dataset.tool] = sel.value;
  await api('/tools', { method: 'PUT', body: { permissions, shellNetwork: $('#shell-network').checked, contradict: { on: $('#contradict-on').checked, mode: $('#contradict-mode').value } } });
}

// ---------- conversation settings ----------
/** Security review: live calls go through a cloud voice service, so private conversations show no call button. */
function syncCallButton() {
  $('#call').hidden = !voice.callShown || (voice.live && Boolean(state.conv?.private));
  // Phase 69: a video call is the same call with her picture full size (not in group chats: CSS).
  $('#video-call-btn').hidden = $('#call').hidden;
}
function renderConvSummary() {
  const c = state.conv;
  if (!c) return;
  syncCallButton();
  // Phase 66: no photos, calls, regenerate or edit in a group chat (yet).
  $('#main').classList.toggle('in-group', isGroup(c));
  const input = $('#input');
  input.dataset.solo ??= input.placeholder;
  input.placeholder = isGroup(c) ? t('Message the group…') : input.dataset.solo;
  if (isGroup(c)) {
    const style = { fits: t('Whoever fits'), everyone: t('Everyone answers'), turns: t('Take turns'), mention: t('@mention only') }[c.group?.turnStyle] ?? '';
    $('#conv-summary').textContent = `${groupTag(c)} · ${style}${c.group?.banter ? ` · ${t('Banter: {n}', { n: c.group.banter })}` : ''}`;
    panelConv();
    return;
  }
  const demo = document.body.classList.contains('demo');
  $('#offrecord-bar').hidden = !c.offRecord || demo;
  $('#demo-bar').hidden = !demo;
  $('#main').classList.toggle('offrecord', Boolean(c.offRecord));
  const s = state.providers;
  const prov = c.providerId ?? s.defaultProviderId;
  const model = c.model ?? (c.providerId ? null : s.defaultModel) ?? '';
  const label = s.providers.find((p) => p.id === prov)?.label ?? prov ?? t('no provider');
  const kind = s.providers.find((p) => p.id === prov)?.kind;
  const plan = kind === 'chatgpt' ? ` · ${t('Using ChatGPT plan')}` : kind === 'claude-code' ? ` · ${t('Claude subscription')}` : kind === 'grok-cli' ? ` · ${t('Grok subscription')}` : '';
  // L11: "main" is the main folder of her workspaces.
  // Phase 71: members have no workspace folders (the file tools are the owner's), so no folder part.
  const folder = isMember() ? '' : `${c.workspace === 'main' ? t('main folder') : c.workspace} · `;
  $('#conv-summary').textContent = `${c.mode === 'coding' ? `${t('Coding')} · ` : ''}${folder}${model || label}${plan}`;
  panelConv();
}

/** Phase 75: "This conversation" in her panel: [label, value, class] rows from the same facts. */
function convFacts() {
  const c = state.conv;
  if (!c) return [];
  if (isGroup(c)) {
    const style = { fits: t('Whoever fits'), everyone: t('Everyone answers'), turns: t('Take turns'), mention: t('@mention only') }[c.group?.turnStyle] ?? '';
    return [
      [t('Who is here'), (c.group?.members ?? []).map((m) => m.name).join(', ')],
      ...(style ? [[t('Who answers'), style]] : []),
      [t('Privacy'), c.private ? t('Private: local models only, nothing leaves your server') : c.channel === 'a2a' ? t('Another agent: kept here, nothing is learned from it') : t('Saved: she remembers what matters'), c.private ? 'hp-private' : ''],
    ];
  }
  const s = state.providers;
  const prov = c.providerId ?? s.defaultProviderId;
  const model = c.model ?? (c.providerId ? null : s.defaultModel) ?? '';
  const label = s.providers.find((p) => p.id === prov)?.label ?? prov ?? t('no provider');
  const demo = document.body.classList.contains('demo');
  const privacy = c.offRecord ? [t('Off the record: nothing is saved'), 'hp-offrecord'] : c.private ? [t('Private: local models only, nothing leaves your server'), 'hp-private'] : demo ? [t('Demo: not saved, gone after a few hours'), 'hp-offrecord'] : c.channel === 'a2a' ? [t('Another agent: kept here, nothing is learned from it'), 'hp-offrecord'] : [t('Saved: she remembers what matters'), ''];
  return [
    [t('Model'), model ? `${model} · ${label}` : label],
    ...(isMember() || demo ? [] : [[t('Workspace'), c.workspace === 'main' ? t('main folder') : String(c.workspace ?? '')]]),
    ...(c.mode === 'coding' ? [[t('Mode'), t('Coding')]] : []),
    [t('Privacy'), privacy[0], privacy[1]],
  ];
}

async function csLoadModels(selected) {
  const sel = $('#cs-model');
  const prov = $('#cs-provider').value;
  sel.replaceChildren(new Option(t('Loading…'), ''));
  if (!prov) {
    sel.replaceChildren(new Option(t('Default ({model})', { model: state.providers.defaultModel ?? t('none') }), ''));
    return;
  }
  try {
    const view = await modelViewFor(prov);
    fillModelOptions(sel, view, selected);
    sel.value = selected || view.models[0] || '';
    $('#cs-status').textContent = '';
  } catch (err) {
    sel.replaceChildren(...(selected ? [new Option(selected, selected)] : []));
    $('#cs-status').textContent = t("Couldn't load models: {message}", { message: err.message });
  }
}

$('#conv-settings-btn').addEventListener('click', async () => {
  if (!state.conv) return;
  if (isGroup(state.conv)) return openGroupDialog(state.conv);
  await loadProviders();
  const c = state.conv;
  $('#cs-error').textContent = '';
  $('#cs-mode').value = c.mode;
  $('#cs-workspace').value = c.workspace;
  $('#cs-project').replaceChildren(new Option(t('No project'), ''), ...(state.projects ?? []).filter((p) => p.status === 'active' || p.id === c.projectId).map((p) => new Option(p.name, String(p.id))));
  $('#cs-project').value = c.projectId === null || c.projectId === undefined ? '' : String(c.projectId);
  $('#cs-archive').textContent = c.archivedAt ? t('Unarchive') : t('Archive');
  const ws = await api('/workspaces').catch(() => []);
  $('#cs-workspaces').replaceChildren(...ws.map((w) => new Option(w, w)));
  const def = state.providers.providers.find((p) => p.id === state.providers.defaultProviderId);
  $('#cs-provider').replaceChildren(
    new Option(t('Default ({model})', { model: `${def?.label ?? t('none')} · ${state.providers.defaultModel ?? ''}` }), ''),
    ...state.providers.providers.map((p) => new Option(p.label, p.id)),
  );
  $('#cs-provider').value = c.providerId ?? '';
  $('#cs-private').checked = Boolean(c.private);
  await csLoadModels(c.model);
  $('#conv-settings').showModal();
});

$('#cs-provider').addEventListener('change', () => csLoadModels(null));

onSave($('#conv-settings'), async () => {
  $('#cs-error').textContent = '';
  const providerId = $('#cs-provider').value || null;
  try {
    const conv = await api(`/conversations/${state.conv.id}`, {
      method: 'PATCH',
      body: {
        mode: $('#cs-mode').value,
        workspace: $('#cs-workspace').value.trim() || 'main',
        providerId,
        model: providerId ? $('#cs-model').value || null : null,
        private: $('#cs-private').checked,
        projectId: $('#cs-project').value ? Number($('#cs-project').value) : null,
      },
    });
    state.conv = { ...state.conv, ...conv };
    state.conversations = state.conversations.map((x) => (x.id === conv.id ? { ...x, ...conv } : x));
    renderConvSummary();
    renderConversations();
  } catch (err) {
    $('#cs-error').textContent = err.message;
    throw err;
  }
});
autoSave($('#conv-settings'));

$('#cs-archive').addEventListener('click', async () => {
  $('#conv-settings').close();
  await moveConversation(state.conv.id, { archived: !state.conv.archivedAt });
});
$('#cs-delete').addEventListener('click', () => {
  $('#conv-settings').close();
  openDeleteDialog(state.conv);
});

$('#cs-remember').addEventListener('click', async () => {
  $('#cs-status').textContent = t('Writing summary…');
  try {
    const r = await api(`/conversations/${state.conv.id}/remember`, { method: 'POST', body: {} });
    $('#cs-status').textContent = r.summaryId ? `${t('Saved a summary. New facts: {n}.', { n: r.factIds.length })}${r.droppedFacts ? ` ${t('Skipped because she could not show where they came from: {n}.', { n: r.droppedFacts })}` : ''}` : t('Nothing new to remember.');
  } catch (err) {
    $('#cs-status').textContent = err.message;
  }
});

// ---------- Sara: status, her day, inner life, character ----------
async function refreshSaraStatus() {
  try {
    const st = await api('/sara/state');
    const el = $('#sara-status');
    el.hidden = !st.enabled;
    if (st.enabled) el.textContent = `${t(st.mood)} · ${t(st.energy)}`;
    setFace(st);
    panelMood(st);
    return st;
  } catch {
    return null;
  }
}
$('#sara-status').addEventListener('click', () => openSara());

// Her picture follows her mood (or the owner's own picture).
function setFace(st) {
  const custom = st.customAvatar;
  const x = st.expression && st.expression !== 'default' ? st.expression : null;
  // The look's version, so a new look is fetched instead of the copy the page already holds.
  const v = state.lookVersion ? `?v=${state.lookVersion}` : '';
  const avatar = custom ? `/api/sara/avatar?t=${Date.now() >> 16}` : x ? `/sara/avatar-${x}.jpg${v}` : `/sara-avatar.jpg${v}`;
  const portrait = custom ? avatar : x ? `/sara/portrait-${x}.jpg${v}` : `/sara-portrait.jpg${v}`;
  for (const img of document.querySelectorAll('img.avatar')) if (!img.src.endsWith(avatar)) img.src = avatar;
  state.expression = x ?? 'default';
  state.customAvatar = custom ? avatar : null;
  panelFace({ avatar, portrait, expression: state.expression });
  for (const pr of [sdPresence, callPresence]) pr.setExpression(state.expression, state.customAvatar);
  if (videoView.open) videoView.backdrop();
  $('#avatar-reset').hidden = !custom;
}
// M10: "Add documents", "Import a file"… are buttons that open their hidden file picker.
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button[data-pick]') : null;
  if (b) document.getElementById(b.dataset.pick)?.click();
});
$('#avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const res = await fetch('/api/sara/avatar', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: f });
  if (!res.ok) alert(serverText(await res.json().catch(() => ({})), t('Upload failed')));
  e.target.value = '';
  await refreshSaraStatus();
});
$('#avatar-reset').addEventListener('click', async () => {
  await api('/sara/avatar', { method: 'DELETE' });
  await refreshSaraStatus();
});
$('#open-sara').addEventListener('click', () => openSara());

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

async function loadThreads() {
  const list = await api('/sara/threads').catch(() => []);
  const box = $('#sd-threads');
  if (!list.length) {
    box.replaceChildren(el('li', 'muted small', t('Nothing yet: she picks something up after her first week with you, or add one.')));
    return;
  }
  box.replaceChildren(
    ...list.map((th) => {
      const li = el('li', th.status === 'done' ? 'done' : '');
      const title = el('strong', '', th.title);
      title.dataset.raw = '';
      li.append(title);
      if (th.status === 'done') li.append(el('span', 'muted small', ` · ${t('finished')}`));
      else if (th.byOwner) li.append(el('span', 'muted small', ` · ${t('from you')}`));
      const last = th.notes.at(-1);
      if (last) {
        const n = el('div', 'muted small', `${last.day}: ${last.text}`);
        n.dataset.raw = '';
        li.append(n);
      }
      const act = (label, fn) => {
        const b = el('button', 'ghost small', label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          await fn();
          loadThreads();
        });
        return b;
      };
      li.append(
        act(t('Rename'), async () => {
          const v = prompt(t('What is it?'), th.title);
          if (v && v.trim() !== th.title) await api(`/sara/threads/${th.id}`, { method: 'PATCH', body: { title: v.trim() } });
        }),
        th.status === 'done' ? act(t('Pick it up again'), () => api(`/sara/threads/${th.id}`, { method: 'PATCH', body: { status: 'active' } })) : act(t('Finished'), () => api(`/sara/threads/${th.id}`, { method: 'PATCH', body: { status: 'done' } })),
        act(t('Remove'), async () => {
          if (confirm(t('Remove "{title}"?', { title: th.title }))) await api(`/sara/threads/${th.id}`, { method: 'DELETE' });
        }),
      );
      return li;
    }),
  );
}
$('#sd-thread-add').addEventListener('click', async () => {
  const title = $('#sd-thread-new').value.trim();
  if (!title) return;
  try {
    await api('/sara/threads', { method: 'POST', body: { title } });
    $('#sd-thread-new').value = '';
  } catch (err) {
    $('#sd-error').textContent = err.message;
  }
  loadThreads();
});

async function openSara() {
  void loadThreads();
  $('#sd-error').textContent = '';
  const [st, settings, pe] = await Promise.all([refreshSaraStatus(), api('/settings'), api('/persona')]);
  const p = pe.persona;
  $('#sd-title').textContent = p.name;
  $('#sd-status').textContent = st?.enabled ? t('Right now: {mood}, {energy}.', { mood: t(st.mood), energy: t(st.energy) }) : t('Inner life is off.');
  $('#sd-day').textContent = st?.day ?? (st?.enabled ? t('She hasn\'t started her day yet (written after 6 am, once you\'ve talked).') : '');
  // With inner life off there is no day to show: leave out the empty section (wave 2).
  $('#sd-day-box').hidden = !st?.enabled && !st?.day;
  $('#sd-inner').checked = settings.innerLife;
  $('#sd-typing').value = settings.typing ?? 'instant';
  const pr = settings.proactive;
  $('#sd-pro-enabled').checked = pr.enabled;
  $('#sd-pro-max').value = pr.maxPerDay;
  $('#sd-pro-qs').value = pr.quietStart;
  $('#sd-pro-qe').value = pr.quietEnd;
  $('#sd-pro-gap').value = pr.minGapHours;
  $('#pe-name').value = p.name;
  $('#pe-age').value = p.age;
  $('#pe-pronouns').value = p.pronouns ?? 'she';
  $('#pe-appearance').value = p.appearance ?? '';
  $('#pe-summary').value = p.summary;
  $('#pe-background').value = p.background.join('\n');
  $('#pe-personality').value = p.personality.join('\n');
  $('#pe-speech').value = p.speech.join('\n');
  $('#pe-boundaries').value = p.boundaries.join('\n');
  $('#pe-safety').textContent = pe.safetyBoundaries.join(' ');
  $('#pe-custom').textContent = pe.custom ? t('You have edited this character.') : t('This is the default character.');
  $('#sara-dialog').showModal();
}

$('#sd-reroll').addEventListener('click', async () => {
  await api('/sara/day', { method: 'DELETE' });
  $('#sd-day').textContent = t('She\'ll have a new day within about ten minutes.');
});

onSave($('#sara-dialog'), async () => {
  $('#sd-error').textContent = '';
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        innerLife: $('#sd-inner').checked,
        typing: $('#sd-typing').value,
        proactive: { enabled: $('#sd-pro-enabled').checked, maxPerDay: Number($('#sd-pro-max').value), quietStart: Number($('#sd-pro-qs').value), quietEnd: Number($('#sd-pro-qe').value), minGapHours: Number($('#sd-pro-gap').value) },
      },
    });
    const saved = await api('/persona', {
      method: 'PUT',
      body: {
        name: $('#pe-name').value,
        pronouns: $('#pe-pronouns').value,
        appearance: $('#pe-appearance').value,
        age: Number($('#pe-age').value),
        summary: $('#pe-summary').value,
        background: lines($('#pe-background').value),
        personality: lines($('#pe-personality').value),
        speech: lines($('#pe-speech').value),
        boundaries: lines($('#pe-boundaries').value),
      },
    });
    setIdentity(saved.persona);
    await refreshSaraStatus();
  } catch (err) {
    $('#sd-error').textContent = err.message;
    throw err;
  }
});
autoSave($('#sara-dialog'));

$('#pe-reset').addEventListener('click', async () => {
  if (!confirm(t('Reset her character to the default? Your edits are removed.'))) return;
  const reset = await api('/persona', { method: 'DELETE' });
  setIdentity(reset.persona);
  $('#sara-dialog').close();
  await openSara();
});

// ---------- model routing (Settings) ----------
// Phase 38: which model does what. One row per job (provider, model, Test, Compare, backups).
const jobsUi = { jobs: [], rows: new Map(), companion: null, defaults: [], classifier: null, costs: {} };
function providerSelect(blank, filter = () => true) {
  const sel = document.createElement('select');
  sel.append(new Option(blank, ''), ...state.providers.providers.filter(filter).map((p) => new Option(p.label, p.id)));
  return sel;
}
/** A provider pick-list with its model chooser: {el, sel, chooser, value(), set(pid, model)}. */
function modelPick(blank, cur, filter) {
  const sel = providerSelect(blank, filter);
  sel.value = cur?.providerId ?? '';
  const chooser = modelChooser();
  void chooser.load(sel.value, cur?.model ?? '');
  sel.addEventListener('change', () => chooser.load(sel.value));
  return {
    sel,
    chooser,
    value: () => (sel.value && chooser.value() ? { providerId: sel.value, model: chooser.value() } : null),
    async set(pid, model) {
      sel.value = pid;
      await chooser.load(pid, model);
    },
  };
}
function jobHint(row, text, bad = false) {
  row.hint.replaceChildren();
  if (text) row.hint.append(bad ? el('span', 'bad', text) : document.createTextNode(text));
}
function costFor(pid, model) {
  const p = state.providers.providers.find((x) => x.id === pid);
  if (!p) return '';
  if (/(:|-)cloud\b/i.test(model ?? '')) return t('Ollama cloud: part of your Ollama plan');
  if (p.local) return t('Free: runs on your own hardware');
  if (['chatgpt', 'claude-code', 'grok-cli'].includes(p.kind)) return t('Uses your subscription');
  return t('Paid per use (your API key)');
}
function jobRow(job, cur, opts = {}) {
  const row = el('div', 'job-row');
  const name = el('span', 'job-name', t(job.label));
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t(job.tip);
  name.append(tip);
  const pick = modelPick(opts.blank ?? t('Use default'), cur, opts.filter);
  // L6: screen readers hear which job each pick-list is for.
  pick.sel.setAttribute('aria-label', t('{job}: provider', { job: t(job.label) }));
  pick.chooser.el.querySelector('select')?.setAttribute('aria-label', t('{job}: model', { job: t(job.label) }));
  pick.chooser.el.querySelector('input')?.setAttribute('aria-label', t('{job}: model name', { job: t(job.label) }));
  const actions = el('span', 'job-actions');
  const test = el('button', 'ghost small', t('Test'));
  test.type = 'button';
  test.title = t('Try this model on this job: does it work, how fast is it?');
  actions.append(test);
  if (job.id !== 'embeddings' && !opts.noCompare) {
    const cmp = el('button', 'ghost small', t('Compare…'));
    cmp.type = 'button';
    cmp.title = t('Find the best model for this job: a short side-by-side test where you pick the winner.');
    cmp.addEventListener('click', () => openCompare(job));
    actions.append(cmp);
  }
  const hint = el('div', 'job-hint');
  row.append(name, pick.sel, pick.chooser.el, actions, hint);
  const r = { job, pick, hint, el: row, backups: [] };
  if (!opts.noBackups) {
    const det = document.createElement('details');
    det.append(el('summary', 'muted', t('If it fails or is slow, try…')));
    for (let k = 0; k < 2; k++) {
      const b = modelPick(t('No backup'), cur?.fallbacks?.[k], opts.filter);
      b.sel.setAttribute('aria-label', t('{job}: backup {n}, provider', { job: t(job.label), n: k + 1 }));
      b.chooser.el.querySelector('select')?.setAttribute('aria-label', t('{job}: backup {n}, model', { job: t(job.label), n: k + 1 }));
      const line = el('div', 'route-row');
      line.append(el('span', '', `${k + 1}.`), b.sel, b.chooser.el);
      det.append(line);
      r.backups.push(b);
    }
    row.append(det);
    r.det = det;
  }
  // Backups only once a model is picked here (else the default model's backups apply).
  const showCost = () => {
    if (r.det) r.det.hidden = !pick.sel.value;
    const dflt = state.defaultModel ? `${t('Uses the default')}: ${state.defaultModel}` : '';
    jobHint(r, pick.sel.value ? costFor(pick.sel.value, pick.chooser.value()) : opts.blank ? '' : dflt);
  };
  pick.sel.addEventListener('change', showCost);
  pick.chooser.el.addEventListener('change', showCost);
  r.refresh = showCost;
  showCost();
  test.addEventListener('click', async () => {
    const v = pick.value() ?? (state.defaultModel ? { providerId: state.defaultProviderId, model: state.defaultModel } : null);
    if (!v) return jobHint(r, t('Choose a provider and a model first.'), true);
    jobHint(r, t('Testing…'));
    test.disabled = true;
    try {
      const res = await api('/model-jobs/test', { method: 'POST', body: { job: job.testAs ?? job.id, ...v } });
      if (!res.ok) jobHint(r, `✗ ${res.error}`, true);
      else {
        const speed = { fast: t('Fast'), ok: t('OK speed'), slow: t('Slow') }[res.speed] ?? '';
        const secs = (res.firstMs / 1000).toFixed(1);
        jobHint(r, `✓ ${speed}: ${job.id === 'embeddings' ? `${secs} s` : `${t('first word in')} ${secs} s${res.wps ? `, ${res.wps} ${t('words/s')}` : ''}`} · ${res.cost}${res.sample ? ` · “${res.sample.replace(/\s+/g, ' ').slice(0, 140)}”` : ''}`);
      }
    } catch (err) {
      jobHint(r, `✗ ${err.message}`, true);
    }
    test.disabled = false;
  });
  jobsUi.rows.set(job.id, r);
  return row;
}
async function renderRoutes() {
  const [s, info] = await Promise.all([api('/settings'), api('/model-jobs').catch(() => null)]);
  state.defaultProviderId = s.defaultProviderId;
  state.defaultModel = s.defaultModel;
  jobsUi.jobs = info?.jobs ?? [];
  jobsUi.rows.clear();
  const adultOk = !/\b(SaraPhone|SaraDesktop)\/\d/.test(navigator.userAgent);
  // Her own model (this companion only), for talking.
  const comp = { id: 'companion', label: t('Her own model'), tip: t('The model this companion thinks with when you talk. Each companion can have her own; other jobs follow the rows below. Use default: the Talking row.') };
  $('#jobs-companion').replaceChildren(...jobRow(comp, s.companionModel, { noBackups: true, noCompare: true, blank: t('Same as Talking') }).childNodes);
  $('#jobs-companion').className = 'job-row';
  jobsUi.companion = jobsUi.rows.get('companion');
  jobsUi.rows.delete('companion');
  $('#jobs-list').replaceChildren(...jobsUi.jobs.filter((j) => !j.advanced).map((j) => jobRow(j, s.routes[j.id])));
  $('#jobs-advanced').replaceChildren(
    ...jobsUi.jobs
      .filter((j) => j.advanced && (j.id !== 'adult' || adultOk))
      .map((j) => jobRow(j, s.routes[j.id], { filter: j.id === 'private' ? (p) => p.local : undefined, noBackups: j.id === 'embeddings', noCompare: j.id === 'private' || j.id === 'adult' })),
  );
  const v = info?.vectors;
  const emb = jobsUi.rows.get('embeddings');
  if (emb && v?.model) jobHint(emb, v.error ? `${t('Not reachable')}: ${v.error}` : `${v.indexed} ${t('of')} ${v.total} ${t('notes ready for meaning search')}`, Boolean(v.error));
  // The safety and truth check (its own setting, kept as before).
  const cls = jobRow({ id: 'classifier', testAs: 'background', label: t('Safety and truth check'), tip: t('Optional small local model (for example a small Ollama model). It double-checks messages for crisis or minors in any language, and checks that she really did what she says she did. It can only add protection, never remove it. Off: the built-in checks still run (English, Spanish, French, German, Portuguese and Italian).') }, s.safetyClassifier, { noBackups: true, noCompare: true, blank: t('Off') });
  // Phase 62: the claim judge (off by default; only the model picked here, never filled in for you).
  const cj = jobRow({ id: 'claimjudge', testAs: 'background', label: t('Double-check her claims'), tip: t('Optional small model (best a local one) asked only when the built-in check is unsure whether she claims she did something (saved, sent, ran) that no tool did. It can only add a correction, never remove one. Off: the built-in check still runs.') }, s.claimJudge, { noBackups: true, noCompare: true, blank: t('Off') });
  $('#routes').replaceChildren(cls, cj);
  jobsUi.classifier = jobsUi.rows.get('classifier');
  jobsUi.rows.delete('classifier');
  jobsUi.claimJudge = jobsUi.rows.get('claimjudge');
  jobsUi.rows.delete('claimjudge');
  // Backups for the default model.
  jobsUi.defaults = [0, 1].map((k) => modelPick(t('No backup'), s.defaultFallbacks?.[k]));
  $('#jobs-default-backups').replaceChildren(
    ...jobsUi.defaults.map((b, k) => {
      b.sel.setAttribute('aria-label', t('Default model: backup {n}, provider', { n: k + 1 }));
      b.chooser.el.querySelector('select')?.setAttribute('aria-label', t('Default model: backup {n}, model', { n: k + 1 }));
      const line = el('div', 'route-row');
      line.append(el('span', '', `${k + 1}.`), b.sel, b.chooser.el);
      return line;
    }),
  );
  $('#jobs-after').value = String([30, 60, 120].includes(s.fallbackAfterSec) ? s.fallbackAfterSec : 60);
  $('#jobs-status').textContent = '';
}
async function saveRoutes() {
  const routes = {};
  for (const [key, r] of jobsUi.rows) {
    const v = r.pick.value();
    if (!v) continue;
    const fallbacks = r.backups.map((b) => b.value()).filter(Boolean);
    routes[key] = { ...v, ...(fallbacks.length ? { fallbacks } : {}) };
  }
  const body = {
    routes,
    safetyClassifier: jobsUi.classifier?.pick.value() ?? null,
    claimJudge: jobsUi.claimJudge?.pick.value() ?? null,
    companionModel: jobsUi.companion?.pick.value() ?? null,
    defaultFallbacks: jobsUi.defaults.map((b) => b.value()).filter(Boolean),
    fallbackAfterSec: Number($('#jobs-after').value),
  };
  await api('/settings', { method: 'PUT', body });
}
$('#jobs-recommend').addEventListener('click', async () => {
  const st = $('#jobs-status');
  st.textContent = t('Looking at what is connected…');
  try {
    const { picks } = await api('/model-jobs/recommend');
    const done = [];
    for (const [job, p] of Object.entries(picks)) {
      const r = jobsUi.rows.get(job);
      if (!r || r.pick.value()) continue; // never overwrite your own choice
      await r.pick.set(p.providerId, p.model);
      r.refresh?.();
      jobHint(r, `✨ ${t(p.why)} · ${costFor(p.providerId, p.model)}`);
      r.el.classList.add('picked');
      done.push(t(r.job.label));
    }
    if (done.length) markDirty($('#settings'));
    st.textContent = done.length ? `${t('Filled in')}: ${done.join(', ')}.` : t('Nothing to add: every job already has a model, or nothing better is connected.');
  } catch (err) {
    st.textContent = err.message;
  }
});
for (const a of document.querySelectorAll('[data-page="models-routes"] [data-goto]'))
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showSettingsTab(a.dataset.goto);
  });

// The side-by-side test: same task, answers without names, you pick.
const cmp = { job: null, slots: [] };
function openCompare(job) {
  cmp.job = job;
  $('#cmpx-job').textContent = t(job.label);
  const r = jobsUi.rows.get(job.id);
  const first = r?.pick.value() ?? (state.defaultModel ? { providerId: state.defaultProviderId, model: state.defaultModel } : null);
  cmp.slots = [0, 1, 2].map((k) => modelPick(k === 2 ? t('(optional)') : t('Choose…'), k === 0 ? first : undefined));
  $('#cmpx-slots').replaceChildren(
    ...cmp.slots.map((s, k) => {
      s.sel.setAttribute('aria-label', t('Model {n}: provider', { n: k + 1 }));
      s.chooser.el.querySelector('select')?.setAttribute('aria-label', t('Model {n}: model', { n: k + 1 }));
      const line = el('div', 'route-row');
      line.append(el('span', '', `${t('Model')} ${k + 1}`), s.sel, s.chooser.el);
      return line;
    }),
  );
  $('#cmpx-results').replaceChildren();
  $('#cmpx-prompt').hidden = true;
  $('#cmpx-status').textContent = '';
  $('#compare-dialog').showModal();
}
$('#cmpx-run').addEventListener('click', async () => {
  const cands = cmp.slots.map((s) => s.value()).filter(Boolean);
  if (cands.length < 2) return ($('#cmpx-status').textContent = t('Pick at least two models.'));
  $('#cmpx-status').textContent = t('Running… (up to a couple of minutes for big models)');
  $('#cmpx-run').disabled = true;
  $('#cmpx-results').replaceChildren();
  try {
    const { prompt, results } = await api('/model-jobs/compare', { method: 'POST', body: { job: cmp.job.id, candidates: cands } });
    $('#cmpx-prompt').textContent = `${t('The task')}: ${prompt}`;
    $('#cmpx-prompt').hidden = false;
    // Shuffled and unnamed, so you judge the answers, not the names.
    const order = results.map((x, k) => ({ x, k, r: Math.random() })).sort((p, q) => p.r - q.r);
    const cards = order.map(({ x }, n) => {
      const card = el('div', 'cmp-card');
      const head = el('strong', '', `${t('Answer')} ${'ABC'[n]}`);
      const body = el('div', 'cmp-text', x.ok ? x.sample : `✗ ${x.error}`);
      const meta = el('small', 'muted', '');
      const btn = el('button', '', t('Pick this one'));
      btn.type = 'button';
      btn.disabled = !x.ok;
      btn.addEventListener('click', async () => {
        for (const c of cards) c.card.classList.remove('won');
        card.classList.add('won');
        for (const c of cards) c.meta.textContent = `${c.x.model} · ${c.x.ok ? `${(c.x.totalMs / 1000).toFixed(1)} s · ` : ''}${c.x.cost}`;
        const r = jobsUi.rows.get(cmp.job.id);
        if (r) {
          await r.pick.set(x.providerId, x.model);
          r.refresh?.();
          jobHint(r, `🏆 ${t('Picked in the side-by-side test')} · ${x.cost}`);
          r.el.classList.add('picked');
        }
        $('#cmpx-status').textContent = `${t('Picked')}: ${x.model}.`;
        markDirty($('#settings'));
      });
      card.append(head, body, meta, btn);
      return { card, meta, x };
    });
    $('#cmpx-results').replaceChildren(...cards.map((c) => c.card));
    $('#cmpx-status').textContent = t('Which answer do you like best?');
  } catch (err) {
    $('#cmpx-status').textContent = err.message;
  }
  $('#cmpx-run').disabled = false;
});

// ---------- voice ----------
const voice = { cfg: null, mic: new Mic(), call: null };
const speaker = new Speaker(async (text, who) => {
  // Phase 66: a group chat line goes to its companion's own voice (her settings), by the companion header.
  const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-sara-companion': who } : {}) }, body: JSON.stringify({ text }) });
  return res.ok ? res.blob() : null;
});
const voiceOn = () => localStorage.getItem('sara.speak') === '1' || Boolean(voice.call?.active);

async function initVoice() {
  try {
    voice.cfg = await api('/voice');
  } catch {
    // The demo has no voice settings; live calls there are for app review (reviewer code).
    if (document.body.classList.contains('demo')) await initDemoCalls();
    return;
  }
  const { settings: v, local } = voice.cfg;
  const canHear = v.stt === 'openai' || (v.stt === 'local' && local.stt);
  const canSpeak = v.tts === 'openai' || v.tts === 'elevenlabs' || v.tts === 'xai' || (v.tts === 'local' && local.tts);
  const micOk = Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
  $('#mic').hidden = !(canHear && micOk);
  // Live calls (Grok or OpenAI realtime voice) when available and chosen; otherwise classic calls.
  const live = await api('/live').catch(() => ({ available: false }));
  voice.live = live.available && (v.calls ?? 'live') === 'live';
  const engineName = live.engine === 'openai' ? 'OpenAI' : 'Grok voice';
  voice.callShown = micOk && (voice.live || (canHear && canSpeak));
  syncCallButton();
  $('#call').title = voice.live ? t('Live call: just talk, interrupt any time ({engineName})', { engineName }) : t('Hands-free call: just talk, interrupt her any time');
  $('#v-calls-note').textContent = live.available
    ? t('Live calls talk back instantly and handle interruptions, using {engineName}. Classic calls use the voice and hearing chosen above, and can use her tools.', { engineName })
    : t('{message} Until then calls are classic.', { message: t(live.message ?? 'Live calls need Grok voice or an OpenAI API key.') });
  $('#v-live-note').textContent = live.available ? t('Live calls now use {engineName}, billed to {billedTo}.', { engineName, billedTo: t(live.billedTo ?? '') }) : t(live.message ?? '');
  $('#speak-toggle').hidden = !canSpeak;
  $('#speak-toggle').setAttribute('aria-pressed', String(localStorage.getItem('sara.speak') === '1'));
  setIcon($('#speak-toggle'), localStorage.getItem('sara.speak') === '1' ? 'speaker-on' : 'speaker');
}

/** Demo server: live calls only for app review, after the reviewer code (asked once per demo session). */
async function initDemoCalls() {
  const live = await api('/live').catch(() => ({ available: false }));
  const micOk = Boolean(window.SaraPhone?.startCall) || (Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext);
  voice.demo = live.demo ?? null;
  voice.live = Boolean(live.available && live.demo?.enabled);
  voice.callShown = micOk && voice.live;
  document.body.classList.toggle('demo-calls', voice.callShown);
  syncCallButton();
  if (voice.live) $('#call').title = t('Live call (demo for app review, up to {minutes} minutes)', { minutes: live.demo.perCallMinutes ?? 5 });
}
/** True when a call may start: not the demo, or the reviewer code was already accepted. */
async function demoCallUnlocked() {
  if (!voice.demo || voice.demo.unlocked) return true;
  const code = prompt(t('Live calls in the demo are for app review. Enter the reviewer code:'));
  if (!code?.trim()) return false;
  try {
    const r = await api('/demo/call-code', { method: 'POST', body: { code: code.trim() } });
    voice.demo = r.demo ?? { ...voice.demo, unlocked: true };
    return true;
  } catch (err) {
    append(bubble('error', t(err.message)));
    return false;
  }
}

$('#speak-toggle').addEventListener('click', () => {
  const on = localStorage.getItem('sara.speak') !== '1';
  localStorage.setItem('sara.speak', on ? '1' : '0');
  $('#speak-toggle').setAttribute('aria-pressed', String(on));
  setIcon($('#speak-toggle'), on ? 'speaker-on' : 'speaker');
  if (!on) speaker.stop();
});

async function transcribe(wav) {
  const res = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data.text ?? '';
}

// Push to talk: click to start, click again to send.
$('#mic').addEventListener('click', async () => {
  const btn = $('#mic');
  if (!voice.mic.recording) {
    try {
      speaker.stop();
      await voice.mic.open();
      voice.mic.start();
      btn.classList.add('recording');
      setActivity('listening', t('click the mic again to send'));
    } catch (err) {
      append(bubble('error', t('Microphone: {message}', { message: err.message })));
    }
    return;
  }
  btn.classList.remove('recording');
  const wav = voice.mic.stop();
  voice.mic.close();
  setActivity(null);
  if (!wav) return;
  setActivity('thinking', 'listening back');
  try {
    const text = (await transcribe(wav)).trim();
    setActivity(null);
    if (text) await send(text);
  } catch (err) {
    setActivity(null);
    append(bubble('error', err.message));
  }
});

// Her animated portrait: on her page (breathes, blinks) and big during calls (also talks).
const sdPresence = new Presence($('#sd-presence'));
// Phase 36: tap her picture to see it large (expressions, outfits, the closet).
$('#sd-presence').classList.add('zoomable');
$('#sd-presence').title = t('See her picture large');
$('#sd-presence').addEventListener('click', () => void openHerPictures());
for (const img of document.querySelectorAll('.brand img.avatar')) {
  img.classList.add('zoomable');
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    void openHerPictures();
  });
}
// Phase 36: the light on her picture follows the time of day (warmer evenings, dimmer nights).
function timeOfDayLight() {
  const h = new Date().getHours();
  const tod = h >= 21 || h < 6 ? 'tod-night' : h >= 18 ? 'tod-evening' : '';
  for (const n of [$('#sd-presence'), $('#call-presence'), ...document.querySelectorAll('img.avatar')]) {
    n?.classList.remove('tod-night', 'tod-evening');
    if (tod) n?.classList.add(tod);
  }
}
timeOfDayLight();
setInterval(timeOfDayLight, 5 * 60_000);
const callPresence = new Presence($('#call-presence'));
// Phase 69: video calls: the call's portrait full size, your camera optional (web/video-call.js).
const videoView = new VideoCallView({
  presence: callPresence,
  home: $('#call-panel'),
  onEnd: () => {
    if (voice.liveCall || voice.call?.active) $('#call').click();
    else videoView.hide();
  },
  onMute: (on) => {
    if (voice.liveCall && 'muted' in voice.liveCall) voice.liveCall.muted = on;
    else if (voice.call) voice.call.muted = on;
    else return false;
    return on;
  },
  onSound: (on) => {
    if (voice.liveCall?.setSound) return voice.liveCall.setSound(on);
    if (callPresence.vol) callPresence.vol.gain.value = on ? 1 : 0;
    else speaker.audio.muted = !on;
    return on;
  },
  onMinimize: () => {
    videoView.hide({ keepCall: true });
    $('#call-panel').hidden = false;
  },
  onLook: async () => {
    // Classic calls: the picture goes with a short question from you (live calls answer by themselves).
    videoView.lookAsk = !voice.liveCall;
    const went = await videoView.sendFrame(true);
    if (!went || voice.liveCall || !voice.call?.active) return void (videoView.lookAsk = false);
    if (state.streaming) await fetch(`/api/conversations/${state.currentId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    while (state.streaming) await new Promise((r) => setTimeout(r, 100));
    speaker.stop();
    await send(t('What do you think of this?'));
  },
  onCue: (x) => callPresence.setExpression(x ?? state.expression, state.customAvatar),
});
/** Opens the video call screen for the call going on (or about to). */
function openVideo() {
  if (!state.currentId) return;
  $('#call-panel').hidden = true;
  voice.liveCall?.setVideo?.(true);
  void videoView.show({ conversationId: state.currentId, demo: document.body.classList.contains('demo'), name: currentIdentity().name || t('Sara'), status: $('#call-status').textContent });
}
new MutationObserver(() => ($('#sara-dialog')?.open ? sdPresence.start() : sdPresence.stop())).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
speaker.onState = ((prev) => (on) => {
  prev?.(on);
  if (on) callPresence.ctx?.resume?.();
  if (voice.call?.active && !state.streaming) $('#call-status').textContent = on ? t('Speaking…') : t('Listening…');
  if (voice.call?.active && videoView.active) videoView.status(on ? t('Speaking…') : t('Listening…'));
})(speaker.onState);
function showCallPanel(on, video = false) {
  $('#call-panel').hidden = !on || video;
  // A call the phone app runs natively can't move its voice into the page: no video switch there.
  $('#call-to-video').hidden = Boolean(voice.liveCall?.native);
  if (on) {
    callPresence.attach(speaker.audio);
    callPresence.start();
    if (video) openVideo();
  } else {
    callPresence.stop();
    videoView.hide();
  }
}
$('#call-to-video').addEventListener('click', () => openVideo());
$('#call-end').addEventListener('click', () => $('#call').click());

// Hands-free call.
const CALL_LABEL = { listening: 'Call: listening', hearing: 'Call: hearing you', thinking: 'Call: thinking', off: '' };
const CALL_STATUS = { listening: 'Listening…', hearing: 'Hearing you…', thinking: 'Thinking…', off: '' };
// Live call (Phase 11): Grok realtime voice through the server; transcripts go into the chat.
const LIVE_STATUS = { connecting: 'Connecting…', listening: 'Listening…', hearing: 'Hearing you…', speaking: 'Speaking…' };
async function startLiveCall(ringId, { video = false } = {}) {
  if (!state.currentId) {
    const conv = await api('/conversations', { method: 'POST', body: {} });
    state.conversations.unshift(conv);
    state.currentId = conv.id;
    state.conv = conv;
    renderConvSummary();
    $('#chat-title').textContent = conv.title;
    renderConversations();
  }
  const convId = state.currentId;
  let said = null;
  let heard = null;
  const end = (reason) => {
    if (!voice.liveCall) return;
    voice.liveCall = null;
    videoView.hide();
    callPresence.listen(null);
    $('#call').classList.remove('active');
    showCallPanel(false);
    setActivity(null);
    if (reason && reason !== 'You hung up.') append(bubble('notice', t(reason)));
    if (state.currentId === convId) void openConversation(convId);
  };
  const onEvent = (ev) => {
      // Phase 69: the video call screen shows the same call: status, notices, captions.
      if (videoView.active) {
        if (ev.type === 'status') videoView.status(t(LIVE_STATUS[ev.state] ?? ''));
        else if (ev.type === 'notice') videoView.notice(ev.kind, ev.text);
        else if (ev.type === 'you') videoView.you(ev.text, ev.final);
        else if (ev.type === 'caption') videoView.her(ev.text.replace(/\[(?:laugh|chuckle|sigh|breath|pause|long-pause|giggle|exhale|inhale|cough|gasp)\]|<\/?(?:whisper|soft|laugh-speak|emphasis|sing|slow|fast|loud|quiet)>/gi, ''));
        else if (ev.type === 'said') videoView.herDone(ev.text + (ev.interrupted ? ' …' : ''));
      }
      if (state.currentId !== convId) return;
      if (ev.type === 'status') {
        $('#call-status').textContent = LIVE_STATUS[ev.state] ?? '';
        setActivity(ev.state === 'speaking' ? 'writing' : ev.state === 'hearing' ? 'hearing' : 'listening', t('Live call'));
      } else if (ev.type === 'notice') append(bubble('notice', ev.text, ev.kind));
      else if (ev.type === 'you') {
        // Live caption of what you're saying; the final words replace it.
        if (!heard) append((heard = bubble('user', '', 'typing')));
        heard.textContent = ev.text;
        if (ev.final) {
          heard.classList.remove('typing');
          heard = null;
        }
        $('#messages').scrollTop = $('#messages').scrollHeight;
      }
      else if (ev.type === 'caption') {
        if (!said) append((said = bubble('assistant', '', 'typing')));
        // Speech tags are for her voice only; also hide a tag that is still arriving ("[lau").
        said._tagged = (said._tagged ?? '') + ev.text;
        queueReply(said, said._tagged.replace(/\[(?:laugh|chuckle|sigh|breath|pause|long-pause|giggle|exhale|inhale|cough|gasp)\]|<\/?(?:whisper|soft|laugh-speak|emphasis|sing|slow|fast|loud|quiet)>/gi, '').replace(/[[<][\w-]{0,12}$/, ''));
        $('#messages').scrollTop = $('#messages').scrollHeight;
      } else if (ev.type === 'said') {
        if (!said) append((said = bubble('assistant', '')));
        setReply(said, ev.text + (ev.interrupted ? ' …' : ''));
        said.classList.remove('typing');
        said = null;
      } else if (ev.type === 'interrupt') {
        said?.classList.remove('typing');
      } else if (ev.type === 'error') append(bubble('error', ev.message));
      else if (ev.type === 'ended') end(ev.reason);
  };
  // Phase 18: in the phone apps the call runs natively, so it keeps going with the screen off.
  // Phase 69: a video call runs in the page instead (the screen is on anyway), so her lips follow her voice.
  if (window.SaraPhone?.startCall && !video) {
    window.saraCallEvent = (ev) => onEvent(ev);
    voice.liveCall = { analyser: null, native: true, hangUp: () => window.SaraPhone.hangUp() };
    if (ringId && window.SaraPhone.answerCall) window.SaraPhone.answerCall(convId, ringId);
    else {
      if (ringId) void api(`/calls/${encodeURIComponent(ringId)}/cancel`, { method: 'POST', body: {} }).catch(() => {});
      window.SaraPhone.startCall(convId);
    }
    $('#call').classList.add('active');
    $('#call-status').textContent = t('Connecting…');
    showCallPanel(true);
    return;
  }
  const call = new LiveCall({ conversationId: convId, onEvent, ringId, video });
  voice.liveCall = call;
  try {
    await call.start();
    callPresence.listen(call.analyser);
    $('#call').classList.add('active');
    $('#call-status').textContent = t('Connecting…');
    showCallPanel(true, video);
  } catch (err) {
    call.hangUp();
    voice.liveCall = null;
    append(bubble('error', err.name === 'NotAllowedError' ? t('Microphone: permission denied.') : err.message));
  }
}

$('#call').addEventListener('click', async () => {
  if (voice.liveCall) {
    voice.liveCall.hangUp();
    voice.liveCall = null;
    callPresence.listen(null);
    $('#call').classList.remove('active');
    showCallPanel(false);
    setActivity(null);
    if (state.currentId) void openConversation(state.currentId);
    return;
  }
  if (voice.live && !voice.call?.active) {
    if (!(await demoCallUnlocked())) return;
    return startLiveCall();
  }
  if (voice.call?.active) {
    voice.call.stop();
    voice.call = null;
    speaker.stop();
    $('#call').classList.remove('active');
    showCallPanel(false);
    setActivity(null);
    return;
  }
  await startClassicCall(false);
});

/** A classic (hands-free) call: her voice and hearing from Settings → Voice; Phase 69: optionally as a video call. */
async function startClassicCall(video) {
  voice.call = new Call({
    mic: new Mic(),
    speaker,
    transcribe,
    onUtterance: async (text) => {
      if (state.streaming) await fetch(`/api/conversations/${state.currentId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      while (state.streaming) await new Promise((r) => setTimeout(r, 100));
      await send(text);
    },
    onInterrupt: () => {
      if (state.streaming) void fetch(`/api/conversations/${state.currentId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    },
    onStatus: (s) => {
      if (!state.streaming && s !== 'off') setActivity(s === 'hearing' ? 'hearing' : 'listening', CALL_LABEL[s]);
      if (!speaker.speaking || s === 'hearing') {
        $('#call-status').textContent = t(CALL_STATUS[s] ?? '');
        if (videoView.active) videoView.status(t(CALL_STATUS[s] ?? ''));
      }
    },
  });
  try {
    await voice.call.start();
    $('#call').classList.add('active');
    showCallPanel(true, video);
  } catch (err) {
    voice.call = null;
    append(bubble('error', t('Microphone: {message}', { message: err.message })));
  }
}

// Phase 69: the video call button: a new call shown full size, or the call going on switched to video.
$('#video-call-btn').addEventListener('click', async () => {
  if (voice.liveCall || voice.call?.active) return voice.liveCall?.native ? undefined : openVideo();
  if (voice.live) {
    if (!(await demoCallUnlocked())) return;
    return startLiveCall(undefined, { video: true });
  }
  await startClassicCall(true);
});

async function loadVoice() {
  const d = await api('/voice');
  voice.cfg = d;
  const v = d.settings;
  $('#v-stt').value = v.stt;
  $('#v-tts').value = v.tts;
  $('#v-voice').replaceChildren(...(d.voices.length ? d.voices.map((x) => new Option(x.label, x.id)) : [new Option(t('Not installed on this server'), '')]));
  $('#v-voice').value = v.localVoice;
  $('#v-speed').value = v.speed;
  $('#v-expressive').value = v.expressive ?? 'subtle';
  $('#v-tone').value = v.tone ?? 'natural';
  $('#v-mood').checked = v.followMood !== false;
  voice.sample = d.expressiveSample;
  $('#v-calls').value = v.calls ?? 'live';
  $('#v-look-every').value = String(v.video?.lookEvery ?? 10);
  $('#v-look-cap').value = String(v.video?.perCall ?? 60);
  renderOpenAiLive(d);
  $('#v-notes').value = v.noteReplies ?? 'voice';
  $('#v-notes-note').textContent = [
    d.notes?.hear ? t('She can listen to your voice notes.') : t('To listen to voice notes she needs Grok voice (sign in to Grok) or a speech API.'),
    d.notes?.send ? t('She answers with her voice (the one chosen above).') : t('For voice notes from Sara, choose Grok voice, a speech API or ElevenLabs as her voice above (the on-server voice can only play in the app).'),
  ].join(' ');
  $('#v-oa-url').value = v.openai.baseUrl;
  $('#v-oa-stt').value = v.openai.sttModel;
  $('#v-oa-tts').value = v.openai.ttsModel;
  $('#v-oa-voice').value = v.openai.ttsVoice;
  $('#v-el-voice').value = v.elevenlabs.voiceId;
  $('#v-el-model').value = v.elevenlabs.model;
  $('#v-oa-key').placeholder = d.keys.openai ? t('saved (leave empty to keep)') : t('not set');
  $('#v-el-key').placeholder = d.keys.elevenlabs ? t('saved (leave empty to keep)') : t('not set');
  $('#v-xai-key').placeholder = d.keys.xai ? t('saved (leave empty to keep)') : d.keys.grokSubscription ? t('not needed: uses your Grok subscription') : d.keys.xaiShared ? t('using your xAI key from elsewhere in Sara') : t('sign in to Grok, or paste an xAI API key');
  $('#v-xai-note').textContent = d.keys.xai
    ? t('Uses the xAI API key you saved here (billed per character by xAI). Clear it to use your Grok subscription instead.')
    : d.keys.grokSubscription
      ? t('Uses your Grok subscription (signed in under Models → Subscriptions): it counts toward your weekly Grok usage, no extra charge. You can also clone a voice in the xAI console and pick it here.')
      : t('Sign in to Grok (Models → Subscriptions) to use your subscription, or paste an xAI API key (billed per character).');
  voice.xaiKeySaved = d.keys.xai;
  $('#v-xai-lang').value = v.xai?.language ?? 'en';
  const xv = v.xai?.voiceId ?? 'eve';
  $('#v-xai-voice').replaceChildren(new Option(xv, xv));
  $('#v-xai-voice').value = xv;
  showXaiVoice();
  if (d.keys.xai || d.keys.xaiShared || d.keys.grokSubscription)
    api('/voice/xai-voices')
      .then(({ voices }) => {
        if (!voices.length) return;
        const opts = voices.map((o) => new Option(o.label === o.id ? o.id : `${o.label} (${o.id})`, o.id));
        if (!voices.some((o) => o.id === xv)) opts.unshift(new Option(xv, xv));
        $('#v-xai-voice').replaceChildren(...opts);
        $('#v-xai-voice').value = xv;
      })
      .catch(() => {});
  renderVoicePicker(d);
  $('#v-local').textContent = d.local.stt || d.local.tts
    ? `${d.local.stt ? t('On this server: hearing installed, voices: {n}.', { n: d.voices.length }) : t('On this server: hearing not installed, voices: {n}.', { n: d.voices.length })} ${t('Nothing leaves your server.')}`
    : d.localSupported === false
      ? d.localNote
      : t('Local voice is not installed on this server. Run deploy/install-voice.sh, or use a speech API key.');
}

// Phase 48: live calls with Grok or OpenAI; the OpenAI voice, model and key.
function renderOpenAiLive(d) {
  const v = d.settings;
  const r = v.openaiRealtime ?? {};
  const name = (id) => id.charAt(0).toUpperCase() + id.slice(1);
  $('#v-live').value = v.live ?? 'auto';
  const voices = d.openaiLive?.voices ?? ['marin'];
  $('#v-oalive-voice').replaceChildren(...voices.map((id) => new Option(id === 'marin' || id === 'cedar' ? t('{voice} (most natural)', { voice: name(id) }) : name(id), id)));
  $('#v-oalive-voice').value = voices.includes(r.voiceId) ? r.voiceId : voices[0];
  const models = d.openaiLive?.models ?? ['gpt-realtime-1.5'];
  const label = { 'gpt-realtime-1.5': 'gpt-realtime-1.5 (voice first)', 'gpt-realtime-2.1': 'gpt-realtime-2.1 (thinks first)', 'gpt-realtime-2.1-mini': 'gpt-realtime-2.1 mini (lowest cost)' };
  $('#v-oalive-model').replaceChildren(...models.map((id) => new Option(label[id] ?? id, id)));
  $('#v-oalive-model').value = models.includes(r.model) ? r.model : models[0];
  const k = d.keys.openaiRealtime;
  const oaSpeech = /^https:\/\/api\.openai\.com(\/|$)/.test(v.openai?.baseUrl ?? '');
  // The key box is the speech API key, so it only shows while that speech API is OpenAI's.
  $('#v-oalive-key-row').hidden = !oaSpeech;
  $('#v-oalive-key').placeholder = k?.source === 'voice' ? t('saved (leave empty to keep)') : k?.source === 'provider' ? t('not needed: uses the key of "{provider}" (Models)', { provider: k.provider }) : t('paste an OpenAI API key (sk-…)');
  $('#v-oalive-note').textContent = k
    ? `${k.source === 'voice' ? t('Billed per use to your OpenAI API account (the key saved here).') : t('Billed per use to your OpenAI API account (the key of "{provider}" in Models).', { provider: k.provider })} ${t("The sample is made with OpenAI's text-to-speech in the same voice, so it is close to, not exactly, how she sounds on a call.")}`
    : oaSpeech
      ? t('Needs an OpenAI API key (billed per use by OpenAI). A ChatGPT plan sign-in can\'t be used for live calls under OpenAI\'s terms.')
      : t('Needs an OpenAI API key: add an OpenAI model provider (Models), or set the speech API below to OpenAI. A ChatGPT plan sign-in can\'t be used for live calls.');
  $('#v-oalive-listen').disabled = !k;
}
let oaliveAudio = null;
$('#v-oalive-listen').addEventListener('click', async () => {
  const btn = $('#v-oalive-listen');
  oaliveAudio?.pause();
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/voice/openai-sample?voice=${encodeURIComponent($('#v-oalive-voice').value)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(serverText(await res.json().catch(() => ({})), t('Could not play that voice.')));
    oaliveAudio = new Audio(URL.createObjectURL(await res.blob()));
    await oaliveAudio.play();
    $('#v-oalive-status').textContent = '';
  } catch (err) {
    $('#v-oalive-status').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = t('▶ Hear a sample');
  }
});

// The simple voice picker (Grok voice): listen to any voice, pick one, done.
let vgVoices = null;
function renderVoicePicker(d) {
  const ok = d.keys.grokSubscription || d.keys.xai || d.keys.xaiShared;
  $('#vg').hidden = !ok;
  if (!ok) return;
  const v = d.settings;
  const cur = v.xai?.voiceId ?? 'eve';
  const fill = (list) => {
    const opts = list.map((o) => new Option(o.label === o.id ? o.label : `${o.label}`, o.id));
    if (!list.some((o) => o.id === cur)) opts.unshift(new Option(cur, cur));
    $('#vg-voice').replaceChildren(...opts);
    $('#vg-voice').value = cur;
  };
  fill(vgVoices ?? [{ id: cur, label: cur }]);
  if (!vgVoices)
    api('/voice/xai-voices')
      .then(({ voices }) => {
        if (!voices.length) return;
        vgVoices = voices;
        fill(voices);
      })
      .catch(() => {});
  const usingGrok = v.tts === 'xai';
  $('#vg-use').hidden = usingGrok;
  $('#vg-note').textContent = usingGrok
    ? t('Live calls use this voice too.')
    : t('Her spoken replies use another voice right now (below). Live calls use the Grok voice chosen here. Press "Use Grok voice" to have her replies use it too.');
}
async function vgSave(extra = {}) {
  await api('/voice', { method: 'PUT', body: { xai: { voiceId: $('#vg-voice').value }, ...extra } });
  $('#vg-status').textContent = t('Saved');
  setTimeout(() => ($('#vg-status').textContent = ''), 2000);
  await loadVoice();
  initVoice();
}
$('#vg-voice').addEventListener('change', () => vgSave().catch((err) => ($('#vg-status').textContent = err.message)));
$('#vg-use').addEventListener('click', () => vgSave({ tts: 'xai' }).catch((err) => ($('#vg-status').textContent = err.message)));
let vgAudio = null;
$('#vg-listen').addEventListener('click', async () => {
  const btn = $('#vg-listen');
  vgAudio?.pause();
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/voice/xai-sample?voice=${encodeURIComponent($('#vg-voice').value)}&lang=${encodeURIComponent($('#v-xai-lang').value || 'en')}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(serverText(await res.json().catch(() => ({})), t('Could not play that voice.')));
    vgAudio = new Audio(URL.createObjectURL(await res.blob()));
    await vgAudio.play();
  } catch (err) {
    $('#vg-status').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = t('▶ Listen');
  }
});

// Phase 37: hear the expressive voice and tone before saving.
$('#v-expressive-try').addEventListener('click', async () => {
  const btn = $('#v-expressive-try');
  btn.disabled = true;
  btn.textContent = t('Playing…');
  try {
    const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: voice.sample ?? t('Haha, okay. *sighs* I needed that.'), expressive: $('#v-expressive').value, tone: $('#v-tone').value }) });
    if (!res.ok) throw new Error(serverText(await res.json().catch(() => ({})), t('Could not play the sample.')));
    const audio = new Audio(URL.createObjectURL(await res.blob()));
    await audio.play();
    await new Promise((r) => audio.addEventListener('ended', r, { once: true }));
  } catch (err) {
    $('#v-local').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = t('▶ Hear a sample');
  }
});

async function saveVoice() {
  const body = {
    stt: $('#v-stt').value,
    tts: $('#v-tts').value,
    ...($('#v-voice').value ? { localVoice: $('#v-voice').value } : {}),
    speed: Number($('#v-speed').value) || 1,
    expressive: $('#v-expressive').value,
    tone: $('#v-tone').value,
    followMood: $('#v-mood').checked,
    openai: { baseUrl: $('#v-oa-url').value.trim(), sttModel: $('#v-oa-stt').value.trim(), ttsModel: $('#v-oa-tts').value.trim(), ttsVoice: $('#v-oa-voice').value.trim() },
    elevenlabs: { voiceId: $('#v-el-voice').value.trim(), model: $('#v-el-model').value.trim() },
    xai: { voiceId: $('#v-xai-voice').value || 'eve', language: $('#v-xai-lang').value },
    calls: $('#v-calls').value,
    live: $('#v-live').value,
    video: { lookEvery: Number($('#v-look-every').value), perCall: Number($('#v-look-cap').value) },
    openaiRealtime: { voiceId: $('#v-oalive-voice').value || 'marin', model: $('#v-oalive-model').value || 'gpt-realtime-1.5' },
    noteReplies: $('#v-notes').value,
  };
  // Phase 48: the OpenAI key box on the live-calls card is the speech API key (OpenAI's).
  if (!$('#v-oalive-key-row').hidden && $('#v-oalive-key').value.trim()) body.openaiKey = $('#v-oalive-key').value.trim();
  if ($('#v-xai-key').value.trim()) body.xaiKey = $('#v-xai-key').value.trim();
  if ($('#v-oa-key').value.trim()) body.openaiKey = $('#v-oa-key').value.trim();
  if ($('#v-el-key').value.trim()) body.elevenlabsKey = $('#v-el-key').value.trim();
  await api('/voice', { method: 'PUT', body });
  $('#v-oa-key').value = '';
  $('#v-el-key').value = '';
  $('#v-xai-key').value = '';
  if (body.openaiKey) $('#v-oalive-key').value = '';
  await initVoice();
  // Who pays for live calls may have changed (a key was added): refresh that card only.
  if (voice.cfg?.openaiLive) renderOpenAiLive(voice.cfg);
}

$('#v-preview').addEventListener('click', async () => {
  try {
    await saveVoice();
    speaker.say(t("Hey, it's me. This is what I sound like. Do you like it?"));
  } catch (err) {
    $('#settings-error').textContent = err.message;
  }
});

// ---------- Telegram ----------
function renderTelegram(tg) {
  $('#tg-enabled').checked = tg.enabled;
  $('#tg-mirror').checked = tg.mirror;
  $('#tg-others').checked = tg.allowOthers;
  $('#tg-token').placeholder = tg.hasToken ? t('saved (leave empty to keep)') : t('not set');
  $('#tg-status').textContent = tg.running ? (tg.linked ? t('Connected as {bot}, linked to you.', { bot: `@${tg.bot}` }) : t('Connected as {bot}, not linked yet.', { bot: `@${tg.bot}` })) : tg.error ? t('Not connected: {error}', { error: tg.error }) : tg.hasToken ? t('Not connected.') : '';
  $('#tg-link').hidden = !tg.running;
  $('#tg-unlink').hidden = !tg.linked;
  // Phase 43: more owners, owner work in groups, when she answers, adult groups (web only).
  $('#tg-owners').value = (tg.ownerUserIds ?? []).join(', ');
  $('#tg-work').checked = Boolean(tg.ownerWorkInGroups);
  $('#tg-name').checked = Boolean(tg.answerName);
  $('#tg-everyone').checked = Boolean(tg.answerEveryone);
  $('#tg-nsfw').closest('label').hidden = !tg.nsfwChatIds;
  $('#tg-nsfw').value = (tg.nsfwChatIds ?? []).join(', ');
}
async function loadTelegram() {
  try {
    renderTelegram(await api('/bridges/telegram'));
  } catch {
    /* bridge not available */
  }
}
async function saveTelegram(extra = {}) {
  const body = {
    enabled: $('#tg-enabled').checked,
    mirror: $('#tg-mirror').checked,
    allowOthers: $('#tg-others').checked,
    ownerUserIds: $('#tg-owners').value,
    ownerWorkInGroups: $('#tg-work').checked,
    answerName: $('#tg-name').checked,
    answerEveryone: $('#tg-everyone').checked,
    ...($('#tg-nsfw').closest('label').hidden ? {} : { nsfwChatIds: $('#tg-nsfw').value }),
    ...extra,
  };
  if ($('#tg-token').value.trim()) body.token = $('#tg-token').value.trim();
  renderTelegram(await api('/bridges/telegram', { method: 'PUT', body }));
  $('#tg-token').value = '';
}
$('#tg-link').addEventListener('click', async () => {
  try {
    const { code, bot } = await api('/bridges/telegram/link', { method: 'POST', body: {} });
    $('#tg-code').textContent = t('In Telegram, open @{bot} and send:  /link {code}   (valid for 10 minutes)', { bot, code });
  } catch (err) {
    $('#tg-code').textContent = err.message;
  }
});
$('#tg-unlink').addEventListener('click', async () => {
  if (!confirm(t('Unlink your Telegram? She will stop answering you there until you link again.'))) return;
  await saveTelegram({ unlink: true });
});

// ---------- Discord ----------
function renderDiscord(dc) {
  $('#dc-enabled').checked = dc.enabled;
  $('#dc-mirror').checked = dc.mirror;
  $('#dc-servers').checked = dc.allowServers;
  $('#dc-token').placeholder = dc.hasToken ? t('saved (leave empty to keep)') : t('not set');
  $('#dc-status').textContent = dc.running ? (dc.linked ? t('Connected as {bot}, linked to you.', { bot: dc.bot }) : t('Connected as {bot}, not linked yet.', { bot: dc.bot })) : dc.error ? t('Not connected: {error}', { error: dc.error }) : dc.hasToken ? t('Not connected.') : '';
  $('#dc-link').hidden = !dc.running;
  $('#dc-unlink').hidden = !dc.linked;
  // Phase 43: more owners, owner work in servers, when she answers, adult channels (web only).
  $('#dc-owners').value = (dc.ownerUserIds ?? []).join(', ');
  $('#dc-work').checked = Boolean(dc.ownerWorkInServers);
  $('#dc-name').checked = Boolean(dc.answerName);
  $('#dc-everyone').checked = Boolean(dc.answerEveryone);
  // Phase 47: other bots, with the loop guard.
  $('#dc-bots').checked = Boolean(dc.answerBots);
  $('#dc-bot-list').value = (dc.botAllowList ?? []).join(', ');
  $('#dc-bot-turns').value = String(dc.botTurnLimit ?? 2);
  $('#dc-bot-turns-n').textContent = String(dc.botTurnLimit ?? 2);
  const cap = String(dc.botHourlyCap ?? 20);
  if (![...$('#dc-bot-cap').options].some((o) => o.value === cap)) $('#dc-bot-cap').append(new Option(cap, cap));
  $('#dc-bot-cap').value = cap;
  $('#dc-bots-more').hidden = !dc.answerBots;
  $('#dc-nsfw').closest('label').hidden = !dc.nsfwChannelIds;
  $('#dc-nsfw').value = (dc.nsfwChannelIds ?? []).join(', ');
}
async function loadDiscord() {
  try {
    renderDiscord(await api('/bridges/discord'));
  } catch {
    /* bridge not available */
  }
}
async function saveDiscord(extra = {}) {
  const body = {
    enabled: $('#dc-enabled').checked,
    mirror: $('#dc-mirror').checked,
    allowServers: $('#dc-servers').checked,
    ownerUserIds: $('#dc-owners').value,
    ownerWorkInServers: $('#dc-work').checked,
    answerName: $('#dc-name').checked,
    answerEveryone: $('#dc-everyone').checked,
    answerBots: $('#dc-bots').checked,
    botAllowList: $('#dc-bot-list').value,
    botTurnLimit: Number($('#dc-bot-turns').value),
    botHourlyCap: Number($('#dc-bot-cap').value),
    ...($('#dc-nsfw').closest('label').hidden ? {} : { nsfwChannelIds: $('#dc-nsfw').value }),
    ...extra,
  };
  if ($('#dc-token').value.trim()) body.token = $('#dc-token').value.trim();
  renderDiscord(await api('/bridges/discord', { method: 'PUT', body }));
  $('#dc-token').value = '';
}
$('#dc-bots').addEventListener('change', () => ($('#dc-bots-more').hidden = !$('#dc-bots').checked));
$('#dc-bot-turns').addEventListener('input', () => ($('#dc-bot-turns-n').textContent = $('#dc-bot-turns').value));
$('#dc-link').addEventListener('click', async () => {
  try {
    const { code, bot } = await api('/bridges/discord/link', { method: 'POST', body: {} });
    $('#dc-code').textContent = t('In Discord, send {bot} a direct message:  !link {code}   (valid for 10 minutes)', { bot, code });
  } catch (err) {
    $('#dc-code').textContent = err.message;
  }
});
$('#dc-unlink').addEventListener('click', async () => {
  if (!confirm(t('Unlink your Discord?'))) return;
  await saveDiscord({ unlink: true });
});

// ---------- app install + push notifications ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const row = document.querySelector('#install-row');
  if (row) row.hidden = false;
});
$('#install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install-row').hidden = true;
});

const swReady = 'serviceWorker' in navigator && window.isSecureContext ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null) : Promise.resolve(null);
navigator.serviceWorker?.addEventListener('message', (e) => {
  const id = e.data?.type === 'open' && /#c=([\w-]+)/.exec(e.data.url ?? '')?.[1];
  if (id && state.conversations.some((c) => c.id === id)) void openConversation(id);
  else if (id) void openElsewhere(id);
});

function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}
async function loadPush() {
  const reg = await swReady;
  let info;
  try {
    info = await api('/push');
  } catch {
    return;
  }
  $('#push-preview').checked = info.preview;
  const supported = Boolean(reg?.pushManager) && 'Notification' in window;
  const sub = supported ? await reg.pushManager.getSubscription() : null;
  $('#push-on').hidden = !supported || Boolean(sub);
  $('#push-off').hidden = !sub;
  $('#push-test').hidden = !info.devices.length;
  $('#push-status').textContent = !supported
    ? t('This browser can’t do notifications here (on iPhone: open Sara from the Home Screen).')
    : Notification.permission === 'denied'
      ? t('Notifications are blocked for this site in your browser settings.')
      : `${sub ? 'On for this device. ' : ''}${info.devices.length} device${info.devices.length === 1 ? '' : 's'} signed up.`;
}
async function savePush() {
  await api('/push', { method: 'PUT', body: { preview: $('#push-preview').checked } }).catch(() => undefined);
}
$('#push-on').addEventListener('click', async () => {
  try {
    const reg = await swReady;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('Notifications were not allowed.'));
    const { publicKey } = await api('/push');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceLabel() } });
  } catch (err) {
    $('#push-status').textContent = err.message;
    return;
  }
  await loadPush();
});
$('#push-off').addEventListener('click', async () => {
  const reg = await swReady;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe();
  }
  await loadPush();
});
$('#push-test').addEventListener('click', async () => {
  const r = await api('/push/test', { method: 'POST', body: {} });
  $('#push-status').textContent = `${t('Devices it was sent to: {n}.', { n: r.sent })}${r.failed ? ` ${t('Failed: {n}.', { n: r.failed })}` : ''}${r.removed ? ` ${t('Expired and removed: {n}.', { n: r.removed })}` : ''} ${t('(If Sara is open in front, it shows here instead.)')}`;
});

// ---------- subscriptions ----------
// Phase 46c: admin commands in the words of the system she runs on (from GET /settings → admin).
let adminHelp = null;
// L11: on Windows/Mac the hint is plain words (the server's version names PATH and variables).
const agentsHint = () => {
  const h = adminHelp?.agents ?? t('Run deploy/install-agents.sh.');
  return /PATH/.test(h) ? t('Install it on this computer, then restart Sara.') : t(h);
};
function applyAdminHelp(h) {
  if (!h) return;
  adminHelp = h;
  for (const el of document.querySelectorAll('[data-admin]')) if (h[el.dataset.admin]) el.textContent = h[el.dataset.admin];
  for (const el of document.querySelectorAll('[data-admin-when]')) el.hidden = el.dataset.adminWhen !== 'known';
}

function renderSubs(v) {
  const g = v.chatgpt;
  $('#sub-chatgpt-status').textContent = g.signedIn ? `${g.email ? t('signed in as {email}', { email: g.email }) : t('signed in')}${g.planUsage ? '' : ` ${t('(plan use not enabled)')}`}` : '';
  $('#sub-chatgpt-go').dataset.enable = g.signedIn && !g.planUsage ? '1' : '';
  $('#sub-chatgpt-go').textContent = g.signedIn && !g.planUsage ? t('Enable ChatGPT plan use') : t('Continue with ChatGPT');
  $('#sub-chatgpt-go').hidden = g.signedIn && g.planUsage;
  $('#sub-chatgpt-out').hidden = !g.signedIn;
  const c = v.claude;
  $('#sub-claude-status').textContent = !c.installed ? t('(Claude Code is not installed on this server. {agentsHint})', { agentsHint: agentsHint() }) : c.signedIn ? t('signed in') : '';
  $('#sub-claude-out').hidden = !c.signedIn;
  $('#sub-claude-go').hidden = c.signedIn || !c.installed;
  const k = v.grok;
  $('#sub-grok-status').textContent = !k.installed ? t('(Grok is not installed on this server. {agentsHint})', { agentsHint: agentsHint() }) : k.signedIn ? t('signed in') : '';
  $('#sub-grok-go').hidden = k.signedIn;
  $('#sub-grok-out').hidden = !k.signedIn;
}
async function loadSubs() {
  try {
    renderSubs(await api('/subscriptions'));
  } catch {
    /* not available */
  }
}
const subErr = (err) => {
  $('#sub-error').textContent = err.message;
  $('#sub-error').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};
/** A Finish button says it's working while the server checks the code. */
async function busyButton(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('Checking…');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
$('#sub-chatgpt-go').addEventListener('click', async () => {
  $('#sub-error').textContent = '';
  try {
    const { url } = await api('/subscriptions/chatgpt/start', { method: 'POST', body: { enablePlan: $('#sub-chatgpt-go').dataset.enable === '1' } });
    window.open(url, '_blank', 'noopener');
    $('#sub-chatgpt-finish').hidden = false;
    $('#sub-chatgpt-url').focus();
  } catch (err) {
    subErr(err);
  }
});
$('#sub-chatgpt-done').addEventListener('click', async () => {
  $('#sub-error').textContent = '';
  try {
    const v = await busyButton($('#sub-chatgpt-done'), () => api('/subscriptions/chatgpt/complete', { method: 'POST', body: { url: $('#sub-chatgpt-url').value } }));
    $('#sub-chatgpt-url').value = '';
    $('#sub-chatgpt-finish').hidden = true;
    renderSubs(v);
    await loadProviders();
    if (v.chatgpt.planUsage && !v.chatgpt.welcomed) {
      $('#plan-welcome').showModal();
      await api('/subscriptions/chatgpt/welcomed', { method: 'POST', body: {} });
    }
  } catch (err) {
    subErr(err);
  }
});
$('#sub-chatgpt-out').addEventListener('click', async () => {
  if (!confirm(t('Sign out of ChatGPT in Sara?'))) return;
  const v = await api('/subscriptions/chatgpt/signout', { method: 'POST', body: {} });
  renderSubs(v);
  if (!v.revoked) $('#sub-error').textContent = t('Signed out here, but ChatGPT did not confirm it; you can also disconnect Sara in ChatGPT Settings.');
});
$('#sub-claude-go').addEventListener('click', async () => {
  $('#sub-error').textContent = '';
  $('#sub-claude-go').disabled = true;
  try {
    const v = await api('/subscriptions/claude/login', { method: 'POST', body: {} });
    $('#sub-claude-link').href = v.login.url;
    $('#sub-claude-finish').hidden = false;
    window.open(v.login.url, '_blank', 'noopener');
    $('#sub-claude-code').focus();
  } catch (err) {
    subErr(err);
  } finally {
    $('#sub-claude-go').disabled = false;
  }
});
$('#sub-claude-done').addEventListener('click', async () => {
  $('#sub-error').textContent = '';
  $('#sub-claude-done').disabled = true;
  try {
    renderSubs(await busyButton($('#sub-claude-done'), () => api('/subscriptions/claude/code', { method: 'POST', body: { code: $('#sub-claude-code').value } })));
    $('#sub-claude-code').value = '';
    $('#sub-claude-finish').hidden = true;
    await loadProviders();
  } catch (err) {
    subErr(err);
  } finally {
    $('#sub-claude-done').disabled = false;
  }
});
$('#sub-claude-save').addEventListener('click', async () => {
  $('#sub-error').textContent = '';
  try {
    renderSubs(await api('/subscriptions/claude', { method: 'PUT', body: { token: $('#sub-claude-token').value } }));
    $('#sub-claude-token').value = '';
    await loadProviders();
  } catch (err) {
    subErr(err);
  }
});
$('#sub-claude-out').addEventListener('click', async () => renderSubs(await api('/subscriptions/claude', { method: 'DELETE' })));
$('#sub-grok-go').addEventListener('click', async () => {
  $('#sub-error').textContent = '';
  try {
    const v = await api('/subscriptions/grok/login', { method: 'POST', body: {} });
    const p = $('#sub-grok-code');
    p.hidden = false;
    p.replaceChildren(document.createTextNode(t('Open ')), Object.assign(document.createElement('a'), { href: v.login.url, target: '_blank', rel: 'noopener', textContent: 'accounts.x.ai' }), document.createTextNode(` ${t('and confirm the code')} `), el('strong', '', v.login.code), document.createTextNode(t('. Waiting…')));
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await api('/subscriptions/grok/check', { method: 'POST', body: {} });
      if (st.grok.signedIn || st.grok.login?.state !== 'waiting') {
        renderSubs(st);
        p.textContent = st.grok.signedIn ? t('Signed in to Grok.') : t('Sign-in did not finish: {error}', { error: st.grok.login?.error ?? '' });
        if (st.grok.signedIn) await loadProviders();
        return;
      }
    }
  } catch (err) {
    subErr(err);
  }
});
$('#sub-grok-out').addEventListener('click', async () => renderSubs(await api('/subscriptions/grok/logout', { method: 'POST', body: {} })));

// ---------- health + backups ----------
const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
// Phase 46: how the owner reaches her (set by the installer), with a QR code for the phone.
async function loadAccess() {
  const a = await api('/access').catch(() => null);
  $('#access-box').hidden = !a;
  if (!a) return;
  // Phase 61: the server's labels are fixed English texts, shown in the app language.
  const label = t(a.label);
  $('#access-line').textContent = a.url ? `${label} — ${a.url}` : a.mode ? label : t('{label}. Open the address you use now on your phone.', { label });
  $('#access-warn').hidden = !a.warning;
  $('#access-warn').textContent = a.warning ? t(a.warning) : '';
  $('#access-qr').hidden = $('#access-qr-how').hidden = !a.qr;
  if (a.qr) $('#access-qr').src = a.qr;
}
async function loadHealth() {
  void loadAccess();
  let h;
  try {
    h = await api('/status');
  } catch {
    return;
  }
  $('#health-checks').replaceChildren(
    ...h.checks.map((c) => {
      const li = el('li', c.ok ? 'ok' : 'bad');
      // UX 19: model lists/changes come with their facts (items): worded in the app language.
      // Phase 61: the other details come as a template (detailKey/params) or a fixed English text.
      // A `detail` value (e.g. the sandbox's own description) is fixed English sentences: each is looked up.
      const params = c.params ? Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, k === 'detail' && typeof v === 'string' ? v.split(/(?<=[.!?])\s+/).map((x) => t(x)).join(' ') : typeof v === 'string' && /^\d+\.\d$/.test(v) ? Number(v).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : v])) : undefined;
      const detail = Array.isArray(c.items) && c.items.length ? c.items.map(modelNoticeText).join(' ') : c.detailKey ? t(c.detailKey, params) : t(c.detail);
      const line = document.createTextNode(` ${detail}`);
      const name = el('strong', '', t(c.name));
      name.dataset.raw = '';
      const box = el('span', '');
      box.dataset.raw = '';
      box.append(line);
      li.append(el('span', 'mark', c.ok ? '✓' : '!'), name, box);
      return li;
    }),
  );
  const up = h.uptimeSeconds > 86400 ? `${Math.floor(h.uptimeSeconds / 86400)} d` : h.uptimeSeconds > 3600 ? `${Math.floor(h.uptimeSeconds / 3600)} h` : `${Math.floor(h.uptimeSeconds / 60)} min`;
  void loadHealthHistory();
  void loadProblems();
  void loadRuns();
  $('#health-info').textContent = `Sara ${h.version}${h.revision ? ` (${h.revision})` : ''} · Node ${h.node} · ${t('up {time}', { time: up })} · ${t('database {size}', { size: fmtBytes(h.data.databaseBytes) })} · ${h.pushDevices === 1 ? t('1 notification device') : t('{n} notification devices', { n: h.pushDevices })}`;
}
// ---------- Phase 30: health history and recent problems ----------
/** A small bar chart (inline SVG, theme colours). values: numbers or null (no data). */
function miniChart(title, values, labels, { fmt = (v) => String(v), max, bad } = {}) {
  const box = el('figure', 'hh-chart');
  const W = 300;
  const H = 54;
  const top = Math.max(max ?? 0, ...values.map((v) => v ?? 0)) || 1;
  const bw = W / Math.max(1, values.length);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const known = values.filter((v) => v !== null);
  svg.setAttribute('aria-label', `${title}: ${known.length ? t('latest {value}', { value: fmt(known.at(-1)) }) : t('no data yet')}`);
  values.forEach((v, i) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const h = v === null ? 2 : Math.max(2, (v / top) * (H - 4));
    r.setAttribute('x', String(i * bw + 0.5));
    r.setAttribute('y', String(H - h));
    r.setAttribute('width', String(Math.max(1, bw - 1)));
    r.setAttribute('height', String(h));
    r.setAttribute('class', v === null ? 'none' : bad?.(v) ? 'bad' : 'ok');
    const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tip.textContent = `${labels[i]}: ${v === null ? t('no data') : fmt(v)}`;
    r.append(tip);
    svg.append(r);
  });
  const cap = el('figcaption', '', title);
  const axis = el('div', 'hh-axis');
  axis.append(el('span', '', labels[0] ?? ''), el('span', '', t('now')));
  box.append(cap, svg, axis);
  return box;
}
async function loadHealthHistory() {
  const range = $('#hh-range').value;
  let d;
  try {
    d = await api(range === '24h' ? '/health/history' : `/health/history?days=${range === '7d' ? 7 : 30}`);
  } catch {
    return;
  }
  const hourly = range === '24h';
  const labels = d.buckets.map((b) => (hourly ? new Date(b.t).toLocaleTimeString([], { hour: 'numeric' }) : new Date(b.t).toLocaleDateString([], { month: 'short', day: 'numeric' })));
  const known = d.buckets.filter((b) => b.up !== null);
  $('#hh-up').textContent = known.length ? `${t('Running')} ${(d.up * 100).toFixed(d.up < 1 ? 1 : 0)}% ${t('of the time')}` : t('The history starts now; check back in an hour.');
  $('#hh-charts').replaceChildren(
    miniChart(t('Running'), d.buckets.map((b) => (b.up === null ? null : Math.round(b.up * 100))), labels, { fmt: (v) => `${v}%`, max: 100, bad: (v) => v < 99 }),
    miniChart(t('Time until her reply starts'), d.buckets.map((b) => b.replyMs), labels, { fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`), bad: (v) => v > 15000 }),
    miniChart(t('Problems logged'), d.buckets.map((b) => (b.up === null ? null : b.problems)), labels, { bad: (v) => v > 0 }),
  );
}
$('#hh-range').addEventListener('change', loadHealthHistory);
// ---------- Phase 78: run history (retention, size, delete) ----------
async function loadRuns() {
  let r;
  try {
    r = await api('/runs/settings');
  } catch {
    return;
  }
  $('#runs-keep').value = String(r.keepDays);
  $('#runs-keep').dataset.loaded = '1';
  $('#runs-stats').textContent = t('Runs: {n}, {mb} MB', { n: r.stats.runs.toLocaleString(locale()), mb: r.stats.mb.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: r.stats.mb < 0.1 ? 2 : 1 }) });
}
async function saveRuns() {
  // Only a value read from the server is sent back (never the list's first choice by accident).
  if (!$('#runs-keep').dataset.loaded) return;
  await api('/runs/settings', { method: 'PUT', body: { keepDays: Number($('#runs-keep').value) } });
  void loadRuns();
}
// ---------- Phase 80: "Try commands in a sandbox first" (Settings → Abilities → Coding projects) ----------
async function loadSandboxGate(recheck = false) {
  let r;
  try {
    r = await api(`/sandbox${recheck ? '?recheck=1' : ''}`);
  } catch {
    $('#sbx-form').hidden = true;
    return;
  }
  $('#sbx-form').hidden = false;
  $('#sbx-mode').value = r.mode;
  $('#sbx-network').checked = r.network;
  const fill = (sel, values, cur, word) => {
    sel.replaceChildren(...values.map((v) => new Option(word(v), String(v))));
    sel.value = String(cur);
  };
  fill($('#sbx-size'), r.choices.maxMB, r.maxMB, (v) => (v >= 1000 ? `${v / 1000} GB` : `${v} MB`));
  fill($('#sbx-time'), r.choices.timeLimitS, r.timeLimitS, (v) => (v >= 120 ? t('{n} minutes', { n: v / 60 }) : t('{n} seconds', { n: v })));
  const iso = r.isolation;
  const found = iso.found ? [iso.found.docker ? (iso.found.dockerImage ? t('Docker found') : t('Docker found, but its image isn\'t downloaded')) : t('no Docker'), iso.found.wsl ? (iso.found.wslBwrap ? t('WSL2 found') : t('WSL2 found, without bubblewrap')) : t('no WSL2')].join(' · ') : '';
  const line = $('#sbx-isolation');
  const how = {
    bwrap: () => t('bubblewrap: only the copy is writable; no network unless you allow it.'),
    seatbelt: () => t('the macOS sandbox: only the copy is writable; no network unless you allow it.'),
    docker: () => t('Docker: only the copy is mounted; no network unless you allow it.'),
    wsl: () => t('WSL2 with bubblewrap: only the copy is writable; no network unless you allow it.'),
    copy: () => t('commands run in a copy, but could still reach other files here. Writes outside the copy are watched and flagged, and nothing is applied until you choose.'),
  }[iso.driver] ?? (() => '');
  line.replaceChildren(el('strong', '', iso.isolated ? t('On this computer: isolated') : t('On this computer: not isolated')), document.createTextNode(` — ${how()}${found ? ` (${found})` : ''}`));
  line.classList.toggle('sbx-warn', !iso.isolated);
  $('#sbx-form').dataset.loaded = '1';
}
async function saveSandboxGate() {
  // Only values read from the server go back (never a list's first choice by accident).
  if (!$('#sbx-form').dataset.loaded) return;
  await api('/sandbox', { method: 'PUT', body: { mode: $('#sbx-mode').value, network: $('#sbx-network').checked, maxMB: Number($('#sbx-size').value), timeLimitS: Number($('#sbx-time').value) } });
}
$('#sbx-recheck').addEventListener('click', () => void loadSandboxGate(true));
// ---------- Phase 81: the security pass (Settings → Abilities → Coding projects) ----------
async function loadSecPass() {
  let r;
  try {
    r = await api('/security-pass');
  } catch {
    $('#sec-form').hidden = true;
    return;
  }
  $('#sec-form').hidden = false;
  $('#sec-mode').value = r.mode;
  $('#sec-reviewer').checked = r.reviewer;
  $('#sec-advisories').checked = r.advisories;
  $('#sec-tests').checked = r.runTests;
  $('#sec-budget').replaceChildren(...r.choices.budgetTokens.map((v) => new Option(t('{n} tokens', { n: v.toLocaleString(locale()) }), String(v))));
  $('#sec-budget').value = String(r.budgetTokens);
  const notes = [r.reviewModel ? t('Reviewing model: set in Which model does what.') : t('Reviewing model: not set, so the Coding model does the second look.')];
  if (r.privateLocal) notes.push(t('Private local mode is on: dependencies are not checked online.'));
  $('#sec-status').textContent = notes.join(' ');
  $('#sec-form').dataset.loaded = '1';
}
async function saveSecPass() {
  if (!$('#sec-form').dataset.loaded) return;
  await api('/security-pass', { method: 'PUT', body: { mode: $('#sec-mode').value, reviewer: $('#sec-reviewer').checked, advisories: $('#sec-advisories').checked, budgetTokens: Number($('#sec-budget').value), runTests: $('#sec-tests').checked } });
}
// ---------- Phase 82: the threat model after coding turns (Settings → Abilities → Coding projects) ----------
async function loadThreatModel() {
  let r;
  try {
    r = await api('/threat-model');
  } catch {
    $('#thr-form').hidden = true;
    return;
  }
  $('#thr-form').hidden = false;
  $('#thr-mode').value = r.mode;
  $('#thr-mode').dataset.loaded = '1';
}
async function saveThreatModel() {
  if (!$('#thr-mode').dataset.loaded) return;
  await api('/threat-model', { method: 'PUT', body: { mode: $('#thr-mode').value } });
}
// ---------- Phase 86: red-team mode (Settings → Abilities → Coding projects) ----------
async function loadRedTeam() {
  let r;
  try {
    r = await api('/redteam');
  } catch {
    $('#rt-form').hidden = true;
    return;
  }
  $('#rt-form').hidden = false;
  $('#rt-ship').value = r.ship;
  $('#rt-scripts').replaceChildren(...r.choices.scripts.map((v) => new Option(v ? t('Up to {n}', { n: v }) : t('None'), String(v))));
  $('#rt-scripts').value = String(r.scripts);
  $('#rt-budget').replaceChildren(...r.choices.budgetTokens.map((v) => new Option(t('{n} tokens', { n: v.toLocaleString(locale()) }), String(v))));
  $('#rt-budget').value = String(r.budgetTokens);
  $('#rt-minutes').replaceChildren(...r.choices.minutes.map((v) => new Option(t('{n} minutes', { n: v }), String(v))));
  $('#rt-minutes').value = String(r.minutes);
  const notes = [r.isolation?.isolated ? t('Runs isolated here ({how}).', { how: r.isolation.label }) : t('No OS sandbox here: runs in a copy, and probe scripts wait for your OK.')];
  notes.push(r.reviewModel ? t('Reviewing model: set in Which model does what.') : t('Reviewing model: not set, so the Coding model does the second look.'));
  $('#rt-status').textContent = notes.join(' ');
  $('#rt-form').dataset.loaded = '1';
}
async function saveRedTeam() {
  if (!$('#rt-form').dataset.loaded) return;
  await api('/redteam', { method: 'PUT', body: { ship: $('#rt-ship').value, scripts: Number($('#rt-scripts').value), budgetTokens: Number($('#rt-budget').value), minutes: Number($('#rt-minutes').value) } });
}
/** The packages live advisories would send (shown before they are switched on). */
async function loadSecPassPreview() {
  const r = await api('/security-pass?preview=1');
  const list = r.preview ?? [];
  $('#sec-preview-count').textContent = list.length ? t('Packages that would be sent: {n}', { n: list.length }) : t('No lockfiles in your projects yet: nothing would be sent now.');
  $('#sec-preview-list').replaceChildren(
    ...list.slice(0, 300).map((p) => {
      const li = el('li', 'small');
      li.dataset.raw = '';
      li.textContent = `${p.name} ${p.version} · ${p.ecosystem} · ${p.workspace}/${p.file}`;
      return li;
    }),
  );
  return list;
}
$('#sec-preview').addEventListener('toggle', () => {
  if ($('#sec-preview').open) void loadSecPassPreview().catch(() => {});
});
$('#sec-advisories').addEventListener('change', async (e) => {
  if (!e.isTrusted) return;
  if (e.target.checked) {
    // §7 #2: the package list is shown before anything is sent.
    let list = [];
    try {
      list = await loadSecPassPreview();
    } catch {
      /* shown empty */
    }
    $('#sec-preview').open = true;
    if (!confirm(t('From now on, the package names and versions in your projects\' lockfiles ({n} now) are sent to OSV.dev to look for known vulnerabilities. Never from private conversations or private local mode. Switch it on?', { n: list.length }))) {
      e.target.checked = false;
      return;
    }
  }
  markSettingsArea('ab-projects');
  markDirty($('#settings'));
});
$('#sec-open').addEventListener('click', () => {
  $('#settings').close();
  void openFindings();
});
// ---------- Phase 79: per-reply budgets (Settings → Abilities → Budgets) ----------
const BUDGET_KINDS = ['coding', 'chat'];
const BUDGET_LINES = ['tokens', 'steps', 'usd', 'minutes'];
async function loadBudgets() {
  let r;
  try {
    r = await api('/budgets');
  } catch {
    return;
  }
  for (const k of BUDGET_KINDS) {
    $(`#bud-${k}-on`).checked = r[k].on;
    for (const line of BUDGET_LINES) fillBudgetSelect($(`#bud-${k}-${line}`), line, r.choices[line], r[k][line]);
  }
  $('#bud-quick').checked = r.quick;
  $('#bud-on-limit').value = r.onLimit;
  $('#bud-quick-note').textContent = r.quickSet ? t('Uses your quick model from Which model does what.') : t('No quick model is set (Models → Which model does what), so this step is skipped.');
  $('#ab-budgets-form').dataset.loaded = '1';
  budgetLinesShown();
}
/** A switched-off kind greys out its pick-lists. */
function budgetLinesShown() {
  for (const k of BUDGET_KINDS) for (const line of BUDGET_LINES) $(`#bud-${k}-${line}`).disabled = !$(`#bud-${k}-on`).checked;
}
for (const k of BUDGET_KINDS) $(`#bud-${k}-on`).addEventListener('change', budgetLinesShown);
async function saveBudgets() {
  // Only values read from the server go back (never a list's first choice by accident).
  if (!$('#ab-budgets-form').dataset.loaded) return;
  const kind = (k) => ({ on: $(`#bud-${k}-on`).checked, ...Object.fromEntries(BUDGET_LINES.map((line) => [line, Number($(`#bud-${k}-${line}`).value)])) });
  await api('/budgets', { method: 'PUT', body: { coding: kind('coding'), chat: kind('chat'), quick: $('#bud-quick').checked, onLimit: $('#bud-on-limit').value } });
}
$('#runs-delete').addEventListener('click', async () => {
  if (!confirm(t('Delete the whole run history? Chats, memories and files stay.'))) return;
  try {
    await api('/runs', { method: 'DELETE' });
  } catch (err) {
    $('#runs-stats').textContent = err.message;
    return;
  }
  void loadRuns();
});
$('#export-runs').addEventListener('change', () => ($('#export-link').href = $('#export-runs').checked ? '/api/export?runs=1' : '/api/export'));
/** "Error: X\n    at f (file:///…)" → "X". */
function oneLineProblem(msg) {
  const first = String(msg ?? '').split('\n')[0].replace(/\s+at\s+(?:async\s+)?[\w.$<>]+\s+\((?:file|node):.*$/, '').replace(/^(?:Uncaught\s+)?(?:\w*Error):\s*/, '');
  return first.length > 300 ? `${first.slice(0, 299)}…` : first;
}
async function loadProblems() {
  const d = await api('/logs?problems=1').catch(() => ({ lines: [] }));
  $('#log-problems').replaceChildren(
    ...(d.lines.length
      ? d.lines.slice(0, 12).map((l) => {
          const li = el('li', l.level);
          // M7: one line per problem; the program's stack stays in the log file (Download the log).
          li.append(el('time', 'muted small', new Date(l.t).toLocaleString()), document.createTextNode(` ${oneLineProblem(l.msg)}`));
          return li;
        })
      : [el('li', 'muted small', t('None. All quiet.'))]),
  );
}

function renderBackups(d) {
  $('#bk-auto').checked = d.auto;
  $('#bk-keep').value = d.keep;
  $('#bk-list').replaceChildren(
    ...d.backups.slice(0, 10).map((b) => {
      const li = el('li');
      const a = el('a', '', b.name);
      a.href = `/api/backups/${encodeURIComponent(b.name)}`;
      a.download = b.name;
      li.append(a, document.createTextNode(` · ${fmtBytes(b.size)} `), btn(t('Delete'), async () => {
        if (!confirm(t('Delete {name}?', { name: b.name }))) return;
        renderBackups(await api(`/backups/${encodeURIComponent(b.name)}`, { method: 'DELETE' }));
      }));
      return li;
    }),
  );
  if (!d.backups.length) $('#bk-list').append(el('li', 'muted', t('No backups yet.')));
}
async function loadBackups() {
  try {
    renderBackups(await api('/backups'));
  } catch {
    /* not available */
  }
}
async function saveBackups() {
  renderBackups(await api('/backups', { method: 'PUT', body: { auto: $('#bk-auto').checked, keep: Number($('#bk-keep').value) || 7 } }));
}
$('#bk-now').addEventListener('click', async () => {
  $('#bk-status').textContent = t('Backing up…');
  try {
    const r = await api('/backups', { method: 'POST', body: {} });
    $('#bk-status').textContent = t('Done: {name} ({files} files).', { name: r.name, files: r.files });
    renderBackups({ auto: $('#bk-auto').checked, keep: Number($('#bk-keep').value), backups: r.backups });
    void loadHealth();
  } catch (err) {
    $('#bk-status').textContent = err.message;
  }
});

// ---------- background jobs (Phase 13) ----------
/** A finished job's result in the conversation (first line = what happened; rest = details). */
/** Phase 52: "Continue with more budget" (the same budget again; the server says if it can't). */
function continueButton(path, after) {
  const b = el('button', 'small continue-budget', t('Continue with more budget'));
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(path, { method: 'POST', body: {} });
      b.textContent = t('Continuing ✓');
      after?.();
    } catch (err) {
      b.textContent = err.message;
    }
  });
  return b;
}

function jobCard(text, status, meta) {
  const [first, ...rest] = text.split('\n');
  // Phase 61: the server sends the first line as a template (meta.key/params) for the app language.
  const head = meta?.key ? serverText(meta, first) : first;
  return toolBlock({ name: 'job', summary: head, status: status === 'ok' ? 'ok' : status === 'stopped' || status === 'budget' ? 'denied' : 'error', output: rest.join('\n') });
}

const jobElapsed = (j) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(j.startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function renderJobs() {
  const strip = $('#jobs-strip');
  const mine = [...(state.jobs?.values() ?? [])].filter((j) => j.conversationId === state.currentId);
  strip.hidden = !mine.length;
  strip.replaceChildren(
    ...mine.map((j) => {
      const row = el('div', 'job-row');
      const last = j.tail.trim().split('\n').at(-1) ?? '';
      const label = el('span', 'job-label', `${t('Job #{id}', { id: j.id })} · ${j.label}`);
      const jobIcon = icon('job');
      if (jobIcon) label.prepend(jobIcon);
      label.dataset.raw = '';
      const line = el('span', 'job-last muted small', last.slice(0, 160));
      line.dataset.raw = '';
      const stop = el('button', 'ghost small', t('Stop'));
      stop.type = 'button';
      stop.addEventListener('click', () => api(`/jobs/${j.id}/stop`, { method: 'POST', body: {} }));
      row.append(label, el('span', 'job-time muted small', jobElapsed(j)), line, stop);
      return row;
    }),
  );
  panelJobs([...(state.jobs?.values() ?? [])]);
  clearInterval(state.jobTimer);
  if (mine.length) state.jobTimer = setInterval(() => document.querySelectorAll('#jobs-strip .job-time').forEach((t, i) => (t.textContent = jobElapsed(mine[i]))), 1000);
}

async function loadJobs() {
  const list = await api(`/jobs?conversation=${encodeURIComponent(state.currentId ?? '')}`).catch(() => []);
  state.jobs ??= new Map();
  for (const j of list) if (j.status === 'running') state.jobs.set(j.id, j);
  renderJobs();
}

// ---------- the phone apps (Android: Phase 14, iPhone: Phase 17) ----------
// Store rules (Phase 19): adult mode is a web-browser setting, so the apps don't show it.
if (/\bSaraPhone\/\d/.test(navigator.userAgent)) document.body.classList.add('in-app');
// Inside the phone app, notifications come from the app itself, and it can place the widget.
if (window.SaraPhone) {
  const ios = window.SaraPhone.platform === 'ios';
  $('#phone-app').hidden = false;
  $('#push-web').hidden = true;
  if (ios) $('#phone-app-note').textContent = t('Her messages arrive here as notifications right away (once Apple notifications are set up on the server, below).');
  $('#phone-widget').addEventListener('click', () => {
    if (!window.SaraPhone.addWidget())
      alert(ios ? t('Touch and hold an empty spot on your Home Screen, tap Edit → Add Widget, and choose Sara. For the Lock Screen: touch and hold it, tap Customize → Lock Screen → add a widget.') : t('Long-press an empty spot on your home screen, choose Widgets, and drag hers out.'));
  });
  $('#phone-server').addEventListener('click', () => (nativeServersApi() ? openServers() : window.SaraPhone.changeServer()));
}
// Shared to her from another app (Phase 18): text and photos land in the message box, ready to send.
window.saraShare = async ({ text = '', images = [] } = {}) => {
  if (text) {
    const box = $('#input');
    box.value = box.value ? `${box.value}\n${text}` : text;
    box.dispatchEvent(new Event('input'));
  }
  // Decoded here: the page's security policy doesn't allow fetch() on data: URLs.
  const toBlob = (d) => {
    const [head, b64] = d.split(',');
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return new Blob([bytes], { type: /data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg' });
  };
  if (images.length) await addPhotos(images.map(toBlob));
  $('#input').focus();
};
// Phone app settings kept on the phone (Phase 18): instant notifications (Android), hide text on
// the lock screen, lock the app with Face ID / fingerprint.
if (window.SaraPhone?.getPref) {
  const ios = window.SaraPhone.platform === 'ios';
  $('#phone-prefs').hidden = false;
  $('#phone-instant-row').hidden = ios;
  $('#phone-private-row').hidden = ios;
  $('#phone-private-ios').hidden = !ios;
  $('#phone-lock-label').textContent = ios ? t('Lock the app with Face ID (or your passcode)') : t('Lock the app with your fingerprint, face or screen lock');
  for (const [id, pref] of [['#phone-instant', 'instant'], ['#phone-private', 'lockPrivate'], ['#phone-lock', 'appLock']]) {
    $(id).checked = String(window.SaraPhone.getPref(pref)) === 'true';
    $(id).addEventListener('change', () => {
      const ok = window.SaraPhone.setPref(pref, $(id).checked);
      if (ok === false) $(id).checked = !$(id).checked;
      else saved($('#settings'));
    });
  }
  // Phase 29: place reminders (location stays on the phone; the server only hears "arrived at …").
  if (window.SaraPhone.placesStatus) {
    $('#phone-places-row').hidden = false;
    const showPlaces = () => {
      const st = window.SaraPhone.placesStatus();
      $('#phone-places').checked = st !== 'off';
      const note = $('#phone-places-note');
      note.replaceChildren();
      if (st === 'off') note.textContent = t('Your location stays on this phone. Sara only tells your server "arrived at Store" or "left Work".');
      else if (st === 'on') note.textContent = t('On. Your location stays on this phone.');
      else {
        note.append(`${st === 'need-location' ? t('Sara needs location permission.') : t('For reminders when the app is closed, choose "Allow all the time".')} `, btn(t('Fix'), () => window.SaraPhone.fixPlacePermissions()));
      }
    };
    showPlaces();
    $('#phone-places').addEventListener('change', () => {
      window.SaraPhone.setPref('places', $('#phone-places').checked);
      setTimeout(showPlaces, 300);
    });
    window.saraPlacesChanged = showPlaces;
    document.addEventListener('visibilitychange', () => !document.hidden && showPlaces());
  }
}

// Opening /#c=<id> while Sara is already open (a notification or widget tap in the phone app).
window.addEventListener('hashchange', () => {
  const id = /#c=([\w-]+)/.exec(location.hash)?.[1];
  if (!id) return;
  history.replaceState(null, '', '/');
  if (state.conversations.some((c) => c.id === id)) void openConversation(id);
  else void openElsewhere(id);
});

// ---------- iPhone app notifications through Apple (Phase 17) ----------
async function loadApns() {
  const info = await api('/push').catch(() => null);
  const a = info?.apns;
  if (!a) return void ($('#apns-box').hidden = true);
  $('#apns-state').textContent = a.keySet ? t('Set up (key {keyId}, app {bundleId}).', { keyId: a.keyId, bundleId: a.bundleId }) : t('Not set up: the iPhone app can’t get notifications yet.');
  // iPhones that signed up for notifications, each removable.
  $('#apns-devices').replaceChildren(
    ...a.devices.map((d) => {
      const row = el('div', 'item small', `${d.label}${d.sandbox ? ` ${t('(test build)')}` : ''} · ${t('since {date}', { date: new Date(d.createdAt).toLocaleDateString() })}${d.lastOkAt ? '' : ` · ${t('nothing delivered yet')}`}`);
      const x = el('button', 'ghost small', t('Remove'));
      x.type = 'button';
      x.addEventListener('click', async () => {
        await api('/push/apns/remove', { method: 'POST', body: { id: d.id } });
        await loadApns();
      });
      row.append(x);
      return row;
    }),
  );
  $('#apns-remove').hidden = !a.keySet;
  if (a.bundleId) $('#apns-bundle').value = a.bundleId;
}
$('#apns-save').addEventListener('click', async () => {
  try {
    await api('/push/apns', { method: 'PUT', body: { keyId: $('#apns-keyid').value, teamId: $('#apns-team').value, bundleId: $('#apns-bundle').value, p8: $('#apns-p8').value } });
  } catch (err) {
    return alert(err.message);
  }
  $('#apns-p8').value = '';
  await loadApns();
  saved($('#settings'), t('Apple notifications set up ✓'));
});
$('#apns-p8-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  $('#apns-p8').value = await f.text();
  const kid = /AuthKey_([A-Z0-9]{10})\.p8$/i.exec(f.name)?.[1];
  if (kid && !$('#apns-keyid').value) $('#apns-keyid').value = kid.toUpperCase();
});
$('#apns-remove').addEventListener('click', async () => {
  if (!confirm(t('Remove the Apple notification key? The iPhone app stops getting notifications.'))) return;
  await api('/push/apns', { method: 'PUT', body: {} });
  await loadApns();
});

// ---------- Google: Gmail + Calendar (Phase 14) ----------
const gRedirect = () => `${location.origin}/api/google/callback`;
async function loadGoogle() {
  const g = await api('/google').catch(() => null);
  if (!g) return;
  $('#g-redirect').textContent = gRedirect();
  $('#g-connected').hidden = !g.connected;
  // Signed in before organizing existed: one more permission (gmail.modify) is needed.
  $('#g-organize').hidden = !(g.connected && g.gmail && !g.canOrganize);
  $('#g-connect').disabled = !g.configured;
  $('#g-connect').textContent = g.connected ? t('Sign in again') : t('Sign in with Google');
  $('#g-forget').hidden = !g.configured;
  $('#g-client-id').value = g.clientId ?? '';
  $('#g-client-secret').placeholder = g.configured ? t('saved (leave empty to keep)') : 'GOCSPX-…';
  const parts = g.gmail && g.calendar ? t('Gmail and Calendar') : g.gmail ? 'Gmail' : g.calendar ? t('Calendar') : '';
  $('#g-status').textContent = g.connected
    ? `${g.email ? t('Connected as {email}: {what}.', { email: g.email, what: parts || t('nothing allowed') }) : t('Connected: {what}.', { what: parts || t('nothing allowed') })} ${t('She can read; drafting, sending and adding events ask you first.')}${!g.gmail || !g.calendar ? ` ${t('(Sign in again and leave all boxes ticked to allow both.)')}` : ''}`
    : g.configured
      ? t('Your Google app is saved. Press "Sign in with Google" (step 7).')
      : t('Not set up.');
  if (!g.configured && !g.connected) $('#g-setup').open = false;
}
$('#g-copy').addEventListener('click', () => navigator.clipboard?.writeText(gRedirect()));
$('#g-save').addEventListener('click', async () => {
  const clientId = $('#g-client-id').value.trim();
  const clientSecret = $('#g-client-secret').value.trim();
  try {
    if (!clientSecret) throw new Error(t('Paste the Client secret too.'));
    await api('/google/client', { method: 'PUT', body: { clientId, clientSecret } });
    $('#g-client-secret').value = '';
  } catch (err) {
    $('#g-status').textContent = err.message;
    return;
  }
  loadGoogle();
});
$('#g-connect').addEventListener('click', async () => {
  try {
    const { url } = await api('/google/connect', { method: 'POST', body: {} });
    location.href = url;
  } catch (err) {
    $('#g-status').textContent = err.message;
  }
});
$('#g-reconnect').addEventListener('click', () => $('#g-connect').click());
$('#g-disconnect').addEventListener('click', async () => {
  await api('/google', { method: 'DELETE' });
  loadGoogle();
});
$('#g-forget').addEventListener('click', async () => {
  if (!confirm(t('Remove your Google app details from Sara? (You can add them again.)'))) return;
  await api('/google/client', { method: 'DELETE' });
  loadGoogle();
});
// Coming back from Google's sign-in page.
{
  const m = /^#google=(\w+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    const msg = { connected: t('Google is connected. Try: "what\'s on my calendar tomorrow?"'), refused: t('Google sign-in was cancelled.'), failed: t("Google sign-in didn't work. Check the steps in Settings → Abilities and try again.") }[m[1]];
    if (msg) setTimeout(() => alert(msg), 600);
  }
}

// ---------- Home Assistant (Phase 29) ----------
async function loadHome() {
  const h = await api('/home').catch(() => ({ url: '', hasToken: false }));
  $('#ha-url').value = h.url ?? '';
  $('#ha-token').value = '';
  $('#ha-token').placeholder = h.hasToken ? 'saved (leave empty to keep)' : 'not set';
  $('#ha-clear').hidden = !h.url && !h.hasToken;
  $('#ha-status').textContent = !h.url || !h.hasToken ? t('Not connected.') : h.ok ? `${t('Connected: {what}.', { what: h.name || t('your home') })}${h.version ? ` (Home Assistant ${h.version})` : ''}` : (h.error ?? t('Saved, but it did not answer.'));
  // Phase 72: presence (its pickers come from Home Assistant).
  if (!isMember()) void loadPresence();
}
$('#ha-save').addEventListener('click', async () => {
  $('#ha-status').textContent = t('Checking…');
  try {
    await api('/home', { method: 'PUT', body: { url: $('#ha-url').value.trim(), token: $('#ha-token').value.trim() } });
  } catch (err) {
    $('#ha-status').textContent = err.message;
    return;
  }
  loadHome();
});
$('#ha-clear').addEventListener('click', async () => {
  await api('/home', { method: 'PUT', body: { remove: true } });
  loadHome();
});

// ---------- GitHub token (Phase 13) ----------
async function loadGitHub() {
  const g = await api('/github').catch(() => ({ hasToken: false }));
  $('#gh-token').value = '';
  $('#gh-token').placeholder = g.hasToken ? 'saved (leave empty to keep)' : 'not set';
  $('#gh-clear').hidden = !g.hasToken;
  $('#gh-status').textContent = !g.hasToken ? t('Not set: she can commit, but not push to GitHub.') : g.ok ? t('Works: GitHub account {login}.', { login: g.login }) : t('Saved, but GitHub did not accept it (expired or wrong?).');
  // Phase 40: watched repositories.
  const w = await api('/github-watch').catch(() => null);
  if (w) {
    $('#ghw-repos').value = w.repos.join('\n');
    $('#ghw-label').value = w.label ?? '';
    $('#ghw-every').value = String(w.everyMinutes ?? 0);
    $('#ghw-status').textContent = w.error ? w.error : w.repos.length ? `${w.label ? t('Open issues labeled “{label}”: {n}.', { label: w.label, n: w.issues.length }) : t('Open issues: {n}.', { n: w.issues.length })}${w.lastCheck ? ` ${t('Last look: {date}.', { date: new Date(w.lastCheck).toLocaleString() })}` : ''}` : '';
  }
}
async function saveGitHubWatch() {
  await api('/github-watch', { method: 'PUT', body: { repos: $('#ghw-repos').value.split(/\s+/).filter(Boolean), label: $('#ghw-label').value, everyMinutes: Number($('#ghw-every').value) } });
}
$('#ghw-check').addEventListener('click', async () => {
  try {
    await saveGitHubWatch();
    const r = await api('/github-watch/check', { method: 'POST' });
    $('#ghw-status').textContent = r.found ? t('New issues on your planner: {n}.', { n: r.found }) : t('Nothing new.');
  } catch (err) {
    $('#ghw-status').textContent = err.message;
  }
});
$('#gh-save').addEventListener('click', async () => {
  const token = $('#gh-token').value.trim();
  if (!token) return;
  try {
    await api('/github', { method: 'PUT', body: { token } });
  } catch (err) {
    $('#gh-status').textContent = err.message;
    return;
  }
  loadGitHub();
});
$('#gh-clear').addEventListener('click', async () => {
  await api('/github', { method: 'PUT', body: { token: '' } });
  loadGitHub();
});

// ---------- Phase 26: calls from her ----------
const ringer = { ring: null, ctx: null, timer: null };
/** A soft two-tone ring, made in the page (no sound file). */
function ringTone(on) {
  clearInterval(ringer.timer);
  ringer.timer = null;
  if (!on) return;
  try {
    ringer.ctx ??= new AudioContext();
    const beep = () => {
      const ctx = ringer.ctx;
      for (const [f, at] of [[880, 0], [660, 0.18], [880, 0.9], [660, 1.08]]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.16);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + at);
        o.stop(ctx.currentTime + at + 0.18);
      }
    };
    beep();
    ringer.timer = setInterval(beep, 3000);
  } catch {
    /* no sound: the screen still shows the call */
  }
}
function onRing(ring) {
  if (!ring) return;
  if (ring.state !== 'ringing') {
    window.SaraPhone?.ringEnded?.(ring.id, ring.state);
    if (ringer.ring?.id === ring.id) closeRing();
    return;
  }
  // Phase 33: the desktop app brings its window to the front for a call.
  window.SaraDesktop?.attention?.('ring');
  // Already on a call: the server doesn't ring then; ignore stray events.
  if (voice.liveCall) return;
  ringer.ring = ring;
  // iPhone app: the system's incoming call screen rings too (CallKit), so no second ring tone.
  const secondsLeft = Math.max(5, (Date.parse(ring.expiresAt) - Date.now()) / 1000 || 45);
  const nativeRing = window.SaraPhone?.ring?.(ring.id, ring.conversationId, secondsLeft) === true;
  $('#ring-title').textContent = t('Sara is calling');
  $('#ring-reason').textContent = ring.reason;
  $('#ring-face').src = $('.avatar')?.src || '/sara-avatar.jpg';
  // A modal dialog: shown above any open window (Settings, setup…).
  if (!$('#ring').open) $('#ring').showModal();
  ringTone(!nativeRing);
  if (document.hidden) notify(t('Sara is calling'), ring.reason);
}
function closeRing() {
  ringer.ring = null;
  ringTone(false);
  if ($('#ring').open) $('#ring').close();
}
$('#ring-answer').addEventListener('click', async () => {
  const ring = ringer.ring;
  closeRing();
  if (!ring) return;
  if (state.currentId !== ring.conversationId) await openConversation(ring.conversationId);
  await startLiveCall(ring.id);
});
// Phase 69: answer with video (her picture full size; your camera stays off until you turn it on).
$('#ring-video').addEventListener('click', async () => {
  const ring = ringer.ring;
  closeRing();
  if (!ring) return;
  if (state.currentId !== ring.conversationId) await openConversation(ring.conversationId);
  await startLiveCall(ring.id, { video: true });
});
$('#ring-decline').addEventListener('click', async () => {
  const ring = ringer.ring;
  closeRing();
  if (ring) window.SaraPhone?.ringEnded?.(ring.id, 'declined');
  if (ring) await api(`/calls/${encodeURIComponent(ring.id)}/decline`, { method: 'POST', body: {} }).catch(() => {});
});
// iPhone app: declined on the system call screen (the app told the server).
window.saraRingClosed = (id) => {
  if (ringer.ring?.id === id) closeRing();
};
// The phone apps ring natively; when the call is answered there, they tell the page.
window.saraShowRing = (ring) => onRing(ring);
// "Call Sara" (phone home-screen shortcut): a call in the conversation she's open on, or a new one.
window.saraStartCall = async () => {
  // Opened from the shortcut: the voice settings may still be loading.
  for (let i = 0; i < 40 && voice.live === undefined; i++) await new Promise((r) => setTimeout(r, 250));
  if (voice.liveCall) return;
  if (voice.live) {
    if (await demoCallUnlocked()) await startLiveCall();
  }
  else append(bubble('notice', t('Live calls need Grok voice: Settings → Voice.')));
};
// Phase 72: opened as the phone's digital assistant (Android ASSIST): start listening at once
// (push to talk: tap the mic to send), or put the cursor in the message box when she can't hear.
window.saraAssist = async () => {
  for (let i = 0; i < 40 && $('#mic').hidden && !state.currentId; i++) await new Promise((r) => setTimeout(r, 250));
  if (!$('#mic').hidden && !voice.mic.recording) $('#mic').click();
  else $('#input')?.focus();
};
window.saraAnswerRing = async (ringId, conversationId) => {
  closeRing();
  // Phase 31: another companion's call: switch to her and answer there.
  if (state.companions?.companions.length > 1 && !state.conversations.some((c) => c.id === conversationId)) {
    const owner = await api(`/companions/of/${conversationId}`).catch(() => null);
    const me = state.companions.companions.find((c) => c.current)?.id;
    if (owner && owner.id !== me) {
      sessionStorage.setItem('sara.answer', JSON.stringify({ ringId, conversationId }));
      return switchCompanion(owner.id);
    }
  }
  if (state.currentId !== conversationId) await openConversation(conversationId);
  await startLiveCall(ringId);
};

async function loadCalls() {
  let d;
  try {
    d = await api('/calls');
  } catch {
    return;
  }
  const r = d.rules;
  $('#cl-fullscreen').hidden = !(r.enabled && window.SaraPhone?.fullScreenCalls?.() === 'ask');
  $('#rem-call-row').hidden = !r.enabled;
  $('#cl-on').checked = r.enabled;
  $('#cl-rules').hidden = !r.enabled;
  $('#cl-rem').value = r.reminders;
  $('#cl-jobs').value = r.jobs;
  $('#cl-brief').value = r.briefing;
  $('#cl-qs').value = r.quietStart;
  $('#cl-qe').value = r.quietEnd;
  const max = $('#cl-max');
  if (![...max.options].some((o) => o.value === String(r.maxPerDay))) max.append(new Option(String(r.maxPerDay)));
  max.value = String(r.maxPerDay);
  const ring = $('#cl-ring');
  if (![...ring.options].some((o) => o.value === String(r.ringSeconds))) ring.append(new Option(`${r.ringSeconds} seconds`, String(r.ringSeconds)));
  ring.value = String(r.ringSeconds);
}
async function saveCalls() {
  try {
    await api('/calls', {
      method: 'PUT',
      body: { enabled: $('#cl-on').checked, reminders: $('#cl-rem').value, jobs: $('#cl-jobs').value, briefing: $('#cl-brief').value, quietStart: $('#cl-qs').value, quietEnd: $('#cl-qe').value, maxPerDay: Number($('#cl-max').value), ringSeconds: Number($('#cl-ring').value) },
    });
    $('#cl-status').textContent = t('Saved');
    setTimeout(() => ($('#cl-status').textContent = ''), 2000);
  } catch (err) {
    $('#cl-status').textContent = err.message;
  }
  $('#cl-rules').hidden = !$('#cl-on').checked;
  $('#rem-call-row').hidden = !$('#cl-on').checked;
}
$('#cl-fs-open').addEventListener('click', () => window.SaraPhone?.openFullScreenSettings?.());
// Back from Android's settings: check again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && window.SaraPhone?.fullScreenCalls) $('#cl-fullscreen').hidden = !($('#cl-on').checked && window.SaraPhone.fullScreenCalls() === 'ask');
});
for (const id of ['#cl-on', '#cl-rem', '#cl-jobs', '#cl-brief', '#cl-qs', '#cl-qe', '#cl-max', '#cl-ring']) $(id).addEventListener('change', saveCalls);
$('#cl-test').addEventListener('click', async () => {
  $('#cl-status').textContent = '';
  try {
    await api('/calls/test', { method: 'POST', body: { conversationId: state.currentId ?? undefined } });
    $('#cl-status').textContent = t('Ringing…');
  } catch (err) {
    $('#cl-status').textContent = err.message;
  }
});

// ---------- live events (reminders, proactive messages) ----------
function startEvents() {
  if (state.events) return;
  const es = new EventSource('/api/events');
  state.events = es;
  es.addEventListener('message', async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.conversationId === state.currentId && !state.streaming) {
      const b = bubble('assistant', ev.message.content, undefined, ev.message.id);
      if (ev.reason === 'reminder') b.classList.add('reminder');
      if (ev.reason === 'proactive') b.classList.add('proactive');
      if (ev.message.role === 'assistant' && ev.message.meta?.agenda) b.append(agendaWhy(ev.message.meta.agenda));
      if (ev.message.role === 'notice') {
        b.className = `msg notice ${ev.message.meta?.kind ?? ''}`;
      }
      if (ev.message.meta?.call) b.classList.add('missed-call');
      if (ev.message.role === 'notice' && ev.message.content.startsWith('agenda:')) append(agendaNotice(ev.message));
      else if (ev.message.role === 'notice' && ev.message.content.startsWith('job:')) {
        append(jobCard(ev.message.content.slice(4), ev.message.meta?.status, ev.message.meta));
        const rc = ev.message.meta?.card ? renderCard(ev.message.meta.card) : null;
        if (rc) append(rc);
      }
      else append(b);
    }
    await loadConversations();
    if (ev.message.role !== 'notice' && voiceOn() && ev.conversationId === state.currentId) speaker.say(ev.message.content.replace(/^Reminder: /, t('Reminder: ')));
    if (ev.message.role !== 'notice' && (document.hidden || ev.conversationId !== state.currentId)) notify(ev.reason === 'reminder' ? t('Reminder from Sara') : t('Sara'), ev.message.content.replace(/^Reminder: /, ''), ev.conversationId);
  });
  es.addEventListener('job', (e) => {
    const { job } = JSON.parse(e.data);
    state.jobs ??= new Map();
    if (job.status === 'running') state.jobs.set(job.id, job);
    else state.jobs.delete(job.id);
    renderJobs();
  });
  // Phase 98: a plugin was added, switched, crashed or asks to use a tool: the Plugins page refreshes.
  es.addEventListener('plugins', () => {
    if (document.querySelector('[data-page="ab-plugins"]:not([hidden])')) void loadPlugins();
  });
  // Phase 102: a webhook got a delivery or changed: the Webhooks page refreshes.
  es.addEventListener('hooks', () => {
    if (document.querySelector('[data-page="co-hooks"]:not([hidden])')) void loadHooks();
  });
  es.addEventListener('library', () => window.dispatchEvent(new Event('sara:library')));
  // Phase 53: a look back is ready (or failed).
  // Phase 70: photos added to the album or captions written.
  es.addEventListener('moments', () => {
    if ($('#moments').open) void loadMoments();
  });
  es.addEventListener('story', () => {
    if ($('#story').open) void loadStory();
  });
  // Phase 51: an import or its learning moved on.
  es.addEventListener('history-import', (e) => renderHistStatus(JSON.parse(e.data).status));
  es.addEventListener('planner', () => {
    if ($('#planner').open) loadPlanner();
    window.dispatchEvent(new Event('sara:planner'));
    boardEvent();
  });
  // Phase 99: a board changed (another tab, her work on a card, a shared board): the open board follows.
  let todayBoardTimer = 0;
  es.addEventListener('board', () => {
    boardEvent();
    // Today's "On the board" tile (waiting cards, her work) follows too, at most every 2 s.
    if (todayOpen() && !todayBoardTimer) todayBoardTimer = setTimeout(() => ((todayBoardTimer = 0), void loadToday()), 2000);
  });
  // Phase 103 (ST8): her plans changed (planned, sent, edited, switched): Her plans and Today follow.
  let todayPlansTimer = 0;
  es.addEventListener('agenda', () => {
    agendaEvent();
    if (todayOpen() && !todayPlansTimer) todayPlansTimer = setTimeout(() => ((todayPlansTimer = 0), void loadToday()), 1500);
  });
  // Phase 101 (ST6): people cards changed (her memory worker, another tab): the open People page follows.
  es.addEventListener('people', () => peopleEvent());
  es.addEventListener('ring', (e) => onRing(JSON.parse(e.data).ring));
  // Phase 87: her hands on a computer: live-view frames, Stop pressed there, computers coming and going.
  es.addEventListener('computer', (e) => onComputerEvent(JSON.parse(e.data)));
  // A turn started or ended somewhere else (another device, Telegram, Discord): follow along.
  es.addEventListener('turn', (e) => {
    const { conversationId } = JSON.parse(e.data);
    void loadConversations();
    if (conversationId === state.currentId && !state.streaming && !state.watch) void openConversation(conversationId);
  });
  // Phase 81: findings changed (a security pass ended, a fix moved on): the open window and the chat follow.
  es.addEventListener('findings', (e) => {
    const ev = JSON.parse(e.data);
    void refreshFindings();
    if (ev.summary && ev.conversationId === state.currentId && !state.streaming && !state.watch) void openConversation(ev.conversationId);
  });
  // Phase 84: an eval moved on (a replay finished, the judge, the result).
  es.addEventListener('eval', (e) => onEvalEvent(JSON.parse(e.data)));
  // Phase 39: a team task moved on.
  es.addEventListener('team', (e) => onTeamEvent(JSON.parse(e.data).task));
  // Phase 52: an app (terminal, VS Code) asks to sign in: the Devices page shows it.
  es.addEventListener('device', (e) => {
    const { pending } = JSON.parse(e.data);
    if ($('#settings').open) void loadDevices().catch(() => {});
    if (pending > 0 && !$('#settings').open) notify(t('An app asks to sign in'), t('Approve it in Settings → Devices and sign-in if you just started it.'));
  });
  // Phase 36: she changed outfit (dressing for the scenario, or her own choice).
  es.addEventListener('look', () => {
    lookChanged();
    if (!$('[data-page="her-look"]')?.hidden) refreshLook();
  });
  // Phase 31: another companion sent a message or is calling.
  es.addEventListener('other', (e) => {
    const n = JSON.parse(e.data);
    if (n.kind === 'ring') {
      if (n.ring.state !== 'ringing') return hideOtherNote(n.companion);
      showOtherNote(n.companion, `📞 ${t('{name} is calling', { name: n.name })}`, t('Answer'), true);
      notify(t('{name} is calling', { name: n.name }), n.ring.reason ?? '');
      window.SaraDesktop?.attention?.('ring');
    } else {
      showOtherNote(n.companion, `💬 ${n.name}: ${n.preview || 'a new message'}`, t('Open'), false, n.conversationId);
      notify(n.name, n.preview || '', n.conversationId);
    }
  });
  // 2.18: back after a restart (an update?): a new server version reloads this page or offers to.
  es.addEventListener('open', () => void checkServerVersion());
  es.onerror = () => {
    // EventSource reconnects by itself; if the session expired, stop.
    if (es.readyState === EventSource.CLOSED) state.events = null;
  };
}

// Pick up where you left off: back on this device (phone app resumed, laptop woken), catch up on
// what was said elsewhere, and after a longer break open the conversation used most recently.
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenSince = Date.now();
    return;
  }
  const away = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = 0;
  if (away < 20_000 || $('#main').hidden) return;
  void catchUp(away);
});
async function catchUp(away) {
  if (!state.events || state.events.readyState === EventSource.CLOSED) {
    state.events = null;
    startEvents();
  }
  await loadConversations().catch(() => {});
  if (state.streaming || state.watch) return;
  const latest = state.conversations.find((c) => !c.archivedAt && !c.partner);
  const typing = $('#input').value.trim();
  if (away >= 10 * 60_000 && latest && latest.id !== state.currentId && !typing) return void openConversation(latest.id);
  if (state.currentId) await openConversation(state.currentId).catch(() => {});
}

// ---------- Phase 31: companions ----------
const COMPANION_COOKIE = 'sara_companion';
// Phase 66: group chats (web/group.js).
initGroups({ api, openConversation, loadConversations, switchCompanion: (id, convId) => switchCompanion(id, convId), companions: () => state.companions?.companions ?? [], current: () => state.companions?.companions.find((c) => c.current)?.id ?? null,
  // The open chat follows its room's settings right away (the line under the title).
  onRoom: (room) => {
    if (state.conv?.group?.id !== room.id) return;
    state.conv = { ...state.conv, group: room, title: room.title };
    $('#chat-title').textContent = room.title;
    renderConvSummary();
  },
});
/** Switches the whole app to another companion (the page reloads as her). */
function switchCompanion(id, convId) {
  document.cookie = `${COMPANION_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
  if (convId) {
    location.hash = `c=${convId}`;
    location.reload();
  } else location.href = '/';
}
/** Phase 31: a link to another companion's conversation switches to her and opens it there. */
async function openElsewhere(convId) {
  if (state.conversations.some((c) => c.id === convId)) return false;
  const owner = await api(`/companions/of/${convId}`).catch(() => null);
  const me = state.companions?.companions.find((c) => c.current)?.id ?? (await loadCompanions())?.companions.find((c) => c.current)?.id;
  if (!owner || owner.id === me) return false;
  switchCompanion(owner.id, convId);
  return true;
}
function showOtherNote(id, text, action, ring = false, convId = '') {
  const box = $('#other-note');
  box.dataset.companion = id;
  box.dataset.conv = convId;
  box.classList.toggle('ringing', ring);
  $('#other-note-text').textContent = text;
  $('#other-note-go').textContent = t(action);
  box.hidden = false;
}
function hideOtherNote(id) {
  if (!id || $('#other-note').dataset.companion === id) $('#other-note').hidden = true;
}
$('#other-note-go').addEventListener('click', () => switchCompanion($('#other-note').dataset.companion, $('#other-note').dataset.conv));
$('#other-note-x').addEventListener('click', () => hideOtherNote());
async function loadCompanions() {
  const d = await api('/companions').catch(() => null);
  if (!d) return null;
  state.companions = d;
  const many = d.companions.length > 1;
  $('#companion-switch').hidden = !many;
  showGroupButton(d.companions.length);
  const menu = $('#companion-menu');
  menu.replaceChildren(
    ...d.companions.map((c) => {
      // UI cleanup (wave 2): each companion with her face; a tick marks the one you're talking to.
      const b = el('button', c.current ? 'current cm-item' : 'cm-item');
      const face = el('img', 'cm-face');
      face.src = faceUrl(c.id);
      face.alt = '';
      const who = el('span', 'cm-name', c.name);
      b.append(face, who);
      // Phase 67: her model isn't on this computer while nothing may leave it.
      if (c.pausedLocal) who.append(el('span', 'muted small', ` · ${t('paused in private local mode')}`));
      if (c.current) b.append(el('span', 'cm-tick', '✓'));
      b.setAttribute('aria-current', String(Boolean(c.current)));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (!c.current) b.addEventListener('click', () => switchCompanion(c.id));
      return b;
    }),
    (() => {
      const b = el('button', 'ghost', t('Add or manage companions…'));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        menu.hidden = true;
        openSettings('her-companions');
      });
      return b;
    })(),
  );
  return d;
}
$('#companion-switch').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#companion-menu');
  menu.hidden = !menu.hidden;
  $('#companion-switch').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  if (!$('#companion-menu').hidden && !e.target.closest('#companion-menu')) $('#companion-menu').hidden = true;
});
async function renderCompanionsPage() {
  const d = await loadCompanions();
  if (!d) return;
  $('#cmp-list').replaceChildren(
    ...d.companions.map((c) => {
      const li = el('li');
      const name = el('strong', '', c.name);
      li.append(name);
      if (c.current) li.append(el('span', 'muted small', ` ${t('talking to now')}`));
      else {
        const sw = el('button', 'ghost small', t('Switch'));
        sw.type = 'button';
        sw.addEventListener('click', () => switchCompanion(c.id));
        li.append(' ', sw);
      }
      if (!c.main) {
        const rm = el('button', 'ghost small danger', t('Remove'));
        rm.type = 'button';
        rm.addEventListener('click', async () => {
          if (!confirm(`${t('Remove')} ${c.name}? ${t('She disappears from the app. Her conversations and memories stay in a folder on the server (companions/.removed-…) in case you change your mind.')}`)) return;
          try {
            await api(`/companions/${c.id}`, { method: 'DELETE' });
            if (c.current) return switchCompanion('main');
            renderCompanionsPage();
          } catch (err) {
            $('#cmp-status').textContent = err.message;
          }
        });
        li.append(' ', rm);
      }
      return li;
    }),
  );
  const from = $('#cmp-from');
  from.replaceChildren(new Option(t('A new character (shape them afterwards)'), ''), ...d.companions.map((c) => new Option(`${t('A copy of')} ${c.name}`, c.id)));
  $('#cmp-planner').value = d.planner;
}
$('#cmp-add').addEventListener('click', async () => {
  const name = $('#cmp-name').value.trim();
  if (!name) return ($('#cmp-status').textContent = t('Give them a name first.'));
  $('#cmp-add').disabled = true;
  try {
    const r = await api('/companions', { method: 'POST', body: { name, pronouns: $('#cmp-pronouns').value, from: $('#cmp-from').value || undefined } });
    $('#cmp-name').value = '';
    $('#cmp-status').textContent = '';
    await renderCompanionsPage();
    const go = el('button', 'small', `${t('Switch to')} ${name}`);
    go.type = 'button';
    go.addEventListener('click', () => switchCompanion(r.id));
    const shape = el('button', 'small', `✨ ${t('Switch and shape')} ${name}`);
    shape.type = 'button';
    shape.addEventListener('click', () => {
      sessionStorage.setItem('sara.openWizard', '1');
      switchCompanion(r.id);
    });
    $('#cmp-status').replaceChildren(`${t('Added')} ${name}. `, shape, ' ', go);
  } catch (err) {
    $('#cmp-status').textContent = err.message;
  } finally {
    $('#cmp-add').disabled = false;
  }
});
$('#cmp-planner').addEventListener('change', async () => {
  const r = await api('/companions/planner', { method: 'PUT', body: { planner: $('#cmp-planner').value } }).catch((err) => ({ error: err.message }));
  $('#cmp-planner-note').textContent = r.error ?? (r.restart ? t('Saved. This applies after the next restart or update.') : t('Saved.'));
});

function notify(title, body, conversationId = '') {
  // Phase 33: in the desktop app, the app shows it (only when its window isn't in front).
  if (window.SaraDesktop) return void window.SaraDesktop.notify(title, body, conversationId);
  if (localStorage.getItem('sara.notify') !== '1' || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'sara' });
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

// ---------- planner ----------
const fmtDue = (iso, withTime = true) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, fn, ghost = true) {
  const b = el('button', ghost ? 'ghost' : '', label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
async function plannerCall(fn) {
  $('#planner-error').textContent = '';
  try {
    await fn();
    await loadPlanner();
  } catch (err) {
    $('#planner-error').textContent = err.message;
  }
}

async function openPlanner() {
  $('#rem-notify').checked = localStorage.getItem('sara.notify') === '1';
  await loadPlanner();
  $('#planner').showModal();
  // Phase 99: the list stays the default until the owner picks the Board; then his last choice opens.
  if (plannerView() === 'board') document.querySelector('#planner .tab[data-tab="board"]')?.click();
}
$('#open-planner').addEventListener('click', openPlanner);

for (const t of document.querySelectorAll('#planner .tab')) {
  t.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#planner .tab')) x.classList.toggle('active', x === t);
    for (const p of document.querySelectorAll('#planner .tab-panel')) p.hidden = p.dataset.panel !== t.dataset.tab;
    // Phase 99: the Board tab widens the window; To-do or Board is remembered as the planner's view.
    rememberView(t.dataset.tab);
    if (t.dataset.tab !== 'board') $('#planner').classList.remove('bd-wide');
    // Phase 103: Her plans loads when its tab opens.
    if (t.dataset.tab === 'agenda') void loadAgenda();
  });
}

async function loadPlanner() {
  const [data, notes] = await Promise.all([api('/planner'), api(`/notes${$('#note-q').value.trim() ? `?q=${encodeURIComponent($('#note-q').value.trim())}` : ''}`)]);
  $('#project-names').replaceChildren(...data.projects.filter((p) => p.status === 'active').map((p) => Object.assign(document.createElement('option'), { value: p.name })));
  renderTasks(data.tasks);
  renderPlaces(data.places ?? []);
  renderReminders(data.reminders, data.recentReminders);
  renderNotes(notes);
}

// ---------- Phase 29: places ----------
let placesById = new Map();
function renderPlaces(places) {
  placesById = new Map(places.map((p) => [p.id, p]));
  $('#places-count').textContent = places.length ? `(${places.length})` : '';
  const kind = $('#rem-kind');
  const was = kind.value;
  kind.replaceChildren(new Option(t('At a time'), 'time'), ...places.flatMap((p) => [new Option(`${t('When I get to')} ${p.name}`, `arrive:${p.id}`), new Option(`${t('When I leave')} ${p.name}`, `leave:${p.id}`)]));
  kind.value = [...kind.options].some((o) => o.value === was) ? was : 'time';
  $('#rem-when').hidden = kind.value !== 'time';
  $('#rem-repeat').hidden = kind.value !== 'time';
  $('#places-list').replaceChildren(
    ...(places.length
      ? places.map((p) => {
          const row = el('div', 'item');
          const mid = el('div', 'grow');
          mid.append(el('div', 'title', p.name), el('div', 'sub', `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · ${p.radius} m`));
          row.append(mid, btn(t('Delete'), () => { if (confirm(t('Delete this place and its reminders?'))) plannerCall(() => api(`/places/${p.id}`, { method: 'DELETE' })); }));
          return row;
        })
      : [el('p', 'muted small', t('No places yet.'))]),
  );
  $('#place-here').hidden = !window.SaraPhone?.savePlaceHere;
}
$('#rem-kind').addEventListener('change', () => {
  $('#rem-when').hidden = $('#rem-kind').value !== 'time';
  $('#rem-repeat').hidden = $('#rem-kind').value !== 'time';
});
$('#place-here').addEventListener('click', () => {
  const name = $('#place-name').value.trim();
  if (!name) return $('#place-name').focus();
  $('#place-status').textContent = t('Finding where you are…');
  window.SaraPhone.savePlaceHere(name);
});
// The phone app answers with the result of "Save where I am".
window.saraPlaceSaved = (ok, message) => {
  $('#place-status').textContent = message;
  if (ok) {
    $('#place-name').value = '';
    loadPlanner();
  }
};
$('#place-lookup').addEventListener('click', async () => {
  const address = $('#place-address').value.trim();
  if (!address) return $('#place-address').focus();
  $('#place-status').textContent = t('Looking up…');
  try {
    const { found } = await api('/places/lookup', { method: 'POST', body: { address } });
    $('#place-status').textContent = found.length ? t('Pick the right one:') : t('Nothing found. Try adding the town.');
    $('#place-found').replaceChildren(
      ...found.map((f) =>
        btn(f.label, async () => {
          const name = $('#place-name').value.trim() || f.label.split(',')[0];
          await plannerCall(() => api('/places', { method: 'POST', body: { name, lat: f.lat, lon: f.lon } }));
          $('#place-found').replaceChildren();
          $('#place-address').value = '';
          $('#place-name').value = '';
          $('#place-status').textContent = `${t('Saved')}: ${name}`;
        }),
      ),
    );
  } catch (err) {
    $('#place-status').textContent = err.message;
  }
});

function renderTasks(tasks) {
  const showDone = $('#task-show-done').checked;
  const list = tasks.filter((tk) => showDone || tk.status === 'open');
  if (!list.length) return $('#task-list').replaceChildren(emptyState('✅', showDone ? t('No tasks yet.') : t('Nothing open. Nice.')));
  const groups = new Map();
  for (const tk of list) groups.set(tk.project ?? '', [...(groups.get(tk.project ?? '') ?? []), tk]);
  const out = [];
  for (const [name, ts] of [...groups].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))) {
    // A heading only when there's more than one group (a single list needs none).
    if (groups.size > 1) out.push(el('div', 'proj-name', name || t('No project')));
    for (const tk of ts) {
      const row = el('div', `item${tk.status === 'done' ? ' done' : ''}`);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = tk.status === 'done';
      box.title = tk.status === 'done' ? t('Mark as not done') : t('Mark done');
      box.addEventListener('change', () => plannerCall(() => api(`/tasks/${tk.id}`, { method: 'PATCH', body: { status: box.checked ? 'done' : 'open' } })));
      const mid = el('div', 'grow');
      mid.append(el('div', `title${tk.priority === 'high' ? ' high' : ''}`, tk.title));
      const sub = [];
      if (tk.dueAt) sub.push([t('due {date}', { date: fmtDue(tk.dueAt) }), tk.status === 'open' && Date.parse(tk.dueAt) < Date.now() ? 'overdue' : '']);
      if (tk.priority !== 'normal') sub.push([tk.priority === 'high' ? t('high priority') : t('low priority'), '']);
      if (tk.notes) sub.push([tk.notes, '']);
      if (sub.length) {
        const s = el('div', 'sub');
        sub.forEach(([txt, cls], i) => {
          if (i) s.append(' · ');
          s.append(el('span', cls, txt));
        });
        mid.append(s);
      }
      row.append(box, mid, btn(t('Delete'), () => confirm(`${t('Delete')} "${tk.title}"?`) && plannerCall(() => api(`/tasks/${tk.id}`, { method: 'DELETE' }))));
      out.push(row);
    }
  }
  $('#task-list').replaceChildren(...out);
}
$('#task-show-done').addEventListener('change', loadPlanner);
$('#task-add').addEventListener('click', () => {
  const title = $('#task-title').value.trim();
  if (!title) return $('#task-title').focus();
  plannerCall(async () => {
    await api('/tasks', { method: 'POST', body: { title, project: $('#task-project').value.trim() || null, due: $('#task-due').value || null, priority: $('#task-priority').value } });
    $('#task-title').value = '';
    $('#task-due').value = '';
  });
});
$('#task-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#task-add').click();
  }
});

const REPEAT_LABEL = { none: '', daily: 'every day', weekdays: 'weekdays', weekly: 'every week', monthly: 'every month' };
function renderReminders(pending, recent) {
  $('#rem-list').replaceChildren(
    ...(pending.length
      ? pending.map((r) => {
          const row = el('div', 'item');
          const mid = el('div', 'grow');
          const at = r.placeId ? `📍 ${t(r.placeEvent === 'leave' ? 'when you leave' : 'when you get to')} ${placesById.get(r.placeId)?.name ?? t('a deleted place')}` : fmtDue(r.dueAt);
          mid.append(el('div', 'title', `${r.call ? '📞 ' : ''}${r.text}`), el('div', 'sub', `${at}${r.repeat !== 'none' ? ` · ${t(REPEAT_LABEL[r.repeat])}` : ''}${r.call ? ` · ${t('she calls')}` : ''}`));
          row.append(mid, btn(t('Cancel'), () => plannerCall(() => api(`/reminders/${r.id}`, { method: 'DELETE' }))));
          return row;
        })
      : [emptyState('⏰', t('No upcoming reminders. Ask Sara ("remind me tomorrow at 9 to…") or add one above.'))]),
  );
  $('#rem-recent').replaceChildren(
    ...(recent.length ? recent.slice(0, 8).map((r) => { const row = el('div', 'item'); const mid = el('div', 'grow'); mid.append(el('div', 'title', r.text), el('div', 'sub', t('delivered {date}', { date: fmtDue(r.sentAt) }))); row.append(mid); return row; }) : [el('p', 'muted small', t('None yet.'))]),
  );
}
$('#rem-add').addEventListener('click', () => {
  const text = $('#rem-text').value.trim();
  const when = $('#rem-when').value;
  const [kind, placeId] = $('#rem-kind').value.split(':');
  if (!text) return $('#rem-text').focus();
  if (kind === 'time' && !when) return $('#rem-when').focus();
  plannerCall(async () => {
    await api('/reminders', { method: 'POST', body: kind === 'time' ? { text, when, repeat: $('#rem-repeat').value, conversationId: state.currentId, call: $('#rem-call').checked } : { text, placeId: Number(placeId), placeEvent: kind, conversationId: state.currentId, call: $('#rem-call').checked } });
    $('#rem-text').value = '';
    $('#rem-call').checked = false;
  });
});
$('#rem-notify').addEventListener('change', async () => {
  if ($('#rem-notify').checked && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') {
      $('#rem-notify').checked = false;
      $('#planner-error').textContent = t('Notifications are blocked for this site in your browser settings.');
      return;
    }
  }
  localStorage.setItem('sara.notify', $('#rem-notify').checked ? '1' : '0');
});

let editingNote = null;
function renderNotes(notes) {
  $('#note-list').replaceChildren(
    ...(notes.length
      ? notes.map((n) => {
          const row = el('div', 'item');
          const mid = el('div', 'grow');
          // A note without its own title is titled by its first line: don't show that line twice.
          const rest = n.body.startsWith(n.title) ? n.body.slice(n.title.length).trim() : n.body;
          mid.append(el('div', 'title', n.title), el('div', 'sub', `${n.project ? `${n.project} · ` : ''}${t('updated {date}', { date: fmtDue(n.updatedAt, false) })}`), ...(rest ? [el('div', 'note-body', rest)] : []));
          row.append(
            mid,
            btn(t('Edit'), () => openNoteEditor(n)),
            btn(t('Delete'), () => confirm(t('Delete note "{title}"?', { title: n.title })) && plannerCall(() => api(`/notes/${n.id}`, { method: 'DELETE' }))),
          );
          return row;
        })
      : [emptyState('📝', $('#note-q').value.trim() ? t('No matching notes.') : t('No notes yet.'))]),
  );
}
function openNoteEditor(n) {
  editingNote = n ?? null;
  $('#note-title').value = n?.title ?? '';
  $('#note-body').value = n?.body ?? '';
  $('#note-edit').hidden = false;
  $('#note-body').focus();
}
$('#note-new').addEventListener('click', () => openNoteEditor(null));
$('#note-cancel').addEventListener('click', () => ($('#note-edit').hidden = true));
$('#note-save').addEventListener('click', () =>
  plannerCall(async () => {
    const body = { title: $('#note-title').value.trim(), body: $('#note-body').value };
    await api(editingNote ? `/notes/${editingNote.id}` : '/notes', { method: editingNote ? 'PATCH' : 'POST', body });
    $('#note-edit').hidden = true;
  }),
);
let noteSearchTimer;
$('#note-q').addEventListener('input', () => {
  clearTimeout(noteSearchTimer);
  noteSearchTimer = setTimeout(loadPlanner, 250);
});

// ---------- export / import ----------
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const out = $('#import-status');
  out.textContent = t('Importing…');
  try {
    const data = JSON.parse(await file.text());
    const res = await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
    out.textContent = `${t('Imported. Chats: {chats} (messages: {messages}) · memories: {memories} · to-dos: {tasks} · reminders: {reminders} · notes: {notes}.', { chats: r.conversations, messages: r.messages, memories: r.memories, tasks: r.tasks, reminders: r.reminders, notes: r.notes })}${r.skippedConversations ? ` ${t('Chats already here and skipped: {n}.', { n: r.skippedConversations })}` : ''}`;
    await loadConversations();
  } catch (err) {
    out.textContent = t('Import failed: {message}', { message: err.message });
  }
});

// ---------- memory ----------
async function openMemory(opts = {}) {
  $('#mem-error').textContent = '';
  // Phase 77: "Update the note" / "Open the note" open the list on that note.
  if (opts.focus) {
    $('#mem-q').value = '';
    $('#mem-kind').value = '';
  }
  const s = await api('/memory/settings');
  $('#mem-enabled').checked = s.enabled;
  $('#mem-quiet').value = String([10, 30, 60, 120].reduce((b, v) => (Math.abs(v - s.quietMinutes) < Math.abs(b - s.quietMinutes) ? v : b), 30));
  $('#mem-fade').value = s.fade ?? 'never';
  // Phase 85: Recall on her own.
  $('#mem-recall').value = s.recall ?? 'coding';
  // Phase 76: the decay policy (half-life slider for "Custom", and the rule in words).
  state.memDecay = s.decay ?? { halfLifeDays: 0, reuseWeight: 0.1, minStanding: 0.5 };
  $('#mem-halflife').value = String(Math.min(1095, Math.max(7, state.memDecay.halfLifeDays || 120)));
  showDecay();
  $('#mem-sharing').value = s.sharing ?? 'own';
  $('#mem-sharing-row').hidden = !(state.companions?.companions.length > 1);
  $('#mem-budget').value = String([1000, 2500, 4500].reduce((b, v) => (Math.abs(v - s.injectBudgetChars) < Math.abs(b - s.injectBudgetChars) ? v : b), 2500));
  await loadMemories();
  // Phase 101 (ST6): Memory opens on Notes; the People tab loads when picked (or opts.tab).
  peopleOnOpen(opts.tab === 'people' ? 'people' : 'notes');
  if (!$('#memory').open) $('#memory').showModal();
  if (opts.focus) {
    const card = document.querySelector(`#mem-list .mem[data-mem="${opts.focus}"]`);
    if (card) {
      card.scrollIntoView({ block: 'center' });
      card.classList.add('highlight');
      setTimeout(() => card.classList.remove('highlight'), 2500);
    } else $('#mem-error').textContent = t('That note is gone or was replaced.');
  }
}
$('#open-memory').addEventListener('click', () => openMemory());

let memSearchTimer;
$('#mem-q').addEventListener('input', () => {
  clearTimeout(memSearchTimer);
  memSearchTimer = setTimeout(loadMemories, 250);
});
$('#mem-kind').addEventListener('change', loadMemories);

// Phase 76: how fading works, in words (the same rule as the server's decayText, in the app language).
const FADE_HALF_LIFE = { never: 0, slow: 365, normal: 120 };
function decayHalfLife() {
  const f = $('#mem-fade').value;
  return f === 'custom' ? Number($('#mem-halflife').value) : (FADE_HALF_LIFE[f] ?? 0);
}
function decayWords(halfLifeDays, minStanding = 0.5) {
  if (!halfLifeDays) return t('Nothing fades: every note weighs the same however old it is. Notes that match what you say come first; pinned notes, promises and dates always count.');
  return t("A note's weight halves every {days} days since it happened or was last used. Notes that match what you say always come to mind, just ranked lower when old; others stay out once they are older than about {out} days. Pinned notes, open promises and dates never fade.", { days: halfLifeDays, out: Math.round(halfLifeDays * Math.log2(1 / Math.max(0.001, minStanding))) });
}
function showDecay() {
  const custom = $('#mem-fade').value === 'custom';
  $('#mem-halflife-row').hidden = !custom;
  $('#mem-halflife-n').textContent = t('{n} days', { n: $('#mem-halflife').value });
  $('#mem-decay-text').textContent = decayWords(decayHalfLife(), state.memDecay?.minStanding ?? 0.5);
}
$('#mem-fade').addEventListener('change', showDecay);
$('#mem-halflife').addEventListener('input', showDecay);

const MEM_KIND_LABEL = { fact: 'about you', self: 'about Sara', date: 'date', reflection: 'noticed', summary: 'conversation note', decision: 'decided together', promise: 'promise', milestone: 'your story', lesson: 'lesson from a run' };
const fmtOnDate = (d) => {
  const [y, m, day] = d.length === 5 ? [null, ...d.split('-')] : d.split('-');
  const s = new Date(Date.UTC(2000, Number(m) - 1, Number(day), 12)).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return y ? `${s}, ${y}` : t('every year on {date}', { date: s });
};

/** A memory's day (YYYY-MM-DD) in the app language: "29 Oct 2026". */
const memDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : d ?? '');

async function loadUpcoming() {
  const box = $('#mem-upcoming');
  const kind = $('#mem-kind').value;
  if ((kind && kind !== 'date') || $('#mem-q').value.trim()) return void (box.hidden = true);
  const up = await api('/memories/upcoming').catch(() => []);
  const soon = up.filter((u) => u.inDays <= 30);
  box.hidden = !soon.length;
  box.replaceChildren(
    el('strong', '', t('Coming up: ')),
    document.createTextNode(soon.map((u) => `${u.content} (${inDaysWords(u.inDays)}${u.years ? `, ${t('{n} years', { n: u.years })}` : ''})`).join(' · ')),
  );
}

$('#mem-add').addEventListener('click', async () => {
  $('#mem-error').textContent = '';
  const content = $('#mem-new').value.trim();
  const date = $('#mem-new-date').value; // YYYY-MM-DD
  try {
    await api('/memories', { method: 'POST', body: date ? { kind: 'date', content, onDate: $('#mem-new-yearly').checked ? date.slice(5) : date } : { kind: 'fact', content } });
    $('#mem-new').value = '';
    $('#mem-new-date').value = '';
    await loadMemories();
  } catch (err) {
    $('#mem-error').textContent = err.message;
  }
});

$('#mem-reflect').addEventListener('click', async () => {
  $('#mem-reflect-status').textContent = t('Looking back…');
  try {
    const { result } = await api('/memories/reflect', { method: 'POST', body: {} });
    const m = /noticed (\d+), replaced (\d+)/.exec(result);
    $('#mem-reflect-status').textContent = m ? t('Done. New things noticed: {noticed} · notes replaced: {replaced}.', { noticed: m[1], replaced: m[2] }) : result;
    await loadMemories();
  } catch (err) {
    $('#mem-reflect-status').textContent = err.message;
  }
});

async function loadMemories() {
  void loadUpcoming();
  const params = new URLSearchParams();
  // Phase 76: "Pinned" is a filter, not a kind.
  if ($('#mem-kind').value === 'pinned') params.set('pinned', '1');
  else if ($('#mem-kind').value) params.set('kind', $('#mem-kind').value);
  if ($('#mem-q').value.trim()) params.set('q', $('#mem-q').value.trim());
  const list = await api(`/memories?${params}`);
  const box = $('#mem-list');
  if (!list.length) {
    box.replaceChildren(emptyState('🧠', $('#mem-q').value.trim() ? t('Nothing matches.') : t('Nothing yet. Sara writes notes as you talk.')));
    return;
  }
  box.replaceChildren(...list.map(memoryCard));
}
// Phase 32's timeline grew into its own page (Phase 53): Your story.
$('#mem-timeline').addEventListener('click', () => {
  $('#memory').close();
  void openStory();
});

function memoryCard(m) {
  const card = document.createElement('div');
  card.className = 'mem';
  card.dataset.mem = String(m.id);
  const head = document.createElement('div');
  head.className = 'mem-head';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = t(MEM_KIND_LABEL[m.kind] ?? m.kind);
  const date = document.createElement('span');
  date.textContent = (m.kind === 'date' && m.onDate ? fmtOnDate(m.onDate) : memDay(m.happenedOn)) + (m.kind === 'promise' && m.onDate ? ` · ${t('due {date}', { date: fmtOnDate(m.onDate) })}` : '') + (m.kind === 'promise' && m.resolvedAt ? ` · ${t('kept ✓')}` : '') + (m.edited ? ` · ${t('edited')}` : '');
  if (m.supersededBy || (m.kind === 'promise' && m.resolvedAt)) card.classList.add('replaced');
  head.append(kind, date);
  // Phase 76: pinned notes never fade.
  if (m.pinned) head.append(el('span', 'mem-pinned', t('pinned')));
  if (m.source) {
    const link = document.createElement('a');
    link.href = '#';
    // Phase 51: learned from imported history: says where ("from your ChatGPT history (date)").
    link.textContent = m.importedFrom ? `${t('from your')} ${m.importedFrom} ${t('history')} (${memDay(m.happenedOn)}): “${m.source.title}”` : t('from “{title}”', { title: m.source.title });
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      $('#memory').close();
      await openConversation(m.source.conversationId);
      const target = document.querySelector(`#messages [data-id="${m.source.fromId ?? m.source.messageId}"]`) ?? document.querySelector(`#messages [data-id="${m.source.messageId}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('highlight');
        setTimeout(() => target.classList.remove('highlight'), 2500);
      }
    });
    head.append(link);
  } else if (m.conversationId) {
    const gone = document.createElement('span');
    gone.textContent = t('source conversation deleted');
    head.append(gone);
  }
  const body = document.createElement('div');
  body.className = 'mem-text';
  body.textContent = m.content;
  card.append(head, body);
  if (m.evidence) {
    const ev = document.createElement('div');
    ev.className = 'mem-evidence';
    ev.textContent = m.sourceDocId ? `📄 ${t('From a document in her library')}: “${m.evidence}”` : m.evidence === 'You added this.' ? t('You added this.') : m.kind === 'reflection' || m.kind === 'lesson' ? m.evidence : ['decision', 'promise', 'milestone'].includes(m.kind) ? `“${m.evidence}”` : `${m.kind === 'self' ? t('She said') : t('You said')}: “${m.evidence}”`;
    if (m.sourceDocId) {
      ev.classList.add('linkish');
      ev.addEventListener('click', () => {
        $('#memory').close();
        void openLibrary(m.sourceDocId);
      });
    }
    card.append(ev);
  }
  if (m.supersededBy) {
    const note = el('div', 'mem-evidence', t('Replaced by a newer note, so she no longer uses this one. '));
    card.append(note);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const mk = (label, fn, ghost = true) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (ghost) b.className = 'ghost';
    b.addEventListener('click', fn);
    return b;
  };
  if (m.kind === 'promise') {
    row.append(
      mk(m.resolvedAt ? t('Open again') : t('Kept ✓'), async () => {
        await api(`/memories/${m.id}`, { method: 'PATCH', body: { resolved: !m.resolvedAt } });
        await loadMemories();
      }),
    );
  }
  // Phase 76: pin so it never fades (and is always a candidate, still under the budget).
  const pin = mk(m.pinned ? t('Unpin') : t('Pin'), async () => {
    try {
      await api(`/memories/${m.id}`, { method: 'PATCH', body: { pinned: !m.pinned } });
      await loadMemories();
    } catch (err) {
      $('#mem-error').textContent = err.message;
    }
  });
  pin.setAttribute('aria-pressed', String(Boolean(m.pinned)));
  pin.title = m.pinned ? t('Pinned: this note never fades. Press to let it fade like the others.') : t('Pin this note so it never fades.');
  row.append(pin);
  if (m.supersededBy) {
    row.append(
      mk(t('Use it again'), async () => {
        await api(`/memories/${m.id}`, { method: 'PATCH', body: { supersededBy: null } });
        await loadMemories();
      }),
    );
  }
  row.append(
    mk(t('Correct'), () => {
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.value = m.content;
      body.replaceWith(ta);
      let dateIn = null;
      if (m.kind === 'date') {
        dateIn = document.createElement('input');
        dateIn.type = 'date';
        dateIn.value = m.onDate?.length === 10 ? m.onDate : `2000-${m.onDate}`;
        ta.after(dateIn);
      }
      row.replaceChildren(
        mk(
          t('Save'),
          async () => {
            try {
              const body = { content: ta.value.trim() };
              if (dateIn?.value) body.onDate = m.onDate?.length === 10 ? dateIn.value : dateIn.value.slice(5);
              await api(`/memories/${m.id}`, { method: 'PATCH', body });
              await loadMemories();
            } catch (err) {
              $('#mem-error').textContent = err.message;
            }
          },
          false,
        ),
        mk(t('Cancel'), loadMemories),
      );
      ta.focus();
    }),
    mk(t('Delete'), async () => {
      if (!confirm(t('Delete this memory?'))) return;
      await api(`/memories/${m.id}`, { method: 'DELETE' });
      await loadMemories();
    }),
    mk(t('Forget'), async () => {
      const ask = m.kind === 'summary'
        ? t('Forget this? The note is deleted and the messages this summary covers will be hidden from Sara for good (you can still see them). Summaries and notes that mention it are removed and rewritten.')
        : t('Forget this? The note is deleted and the message it came from, and later messages that mention it, will be hidden from Sara for good (you can still see them). Summaries and notes that mention it are removed and rewritten.');
      if (!confirm(ask)) return;
      const r = await api(`/memories/${m.id}/forget`, { method: 'POST', body: {} });
      $('#mem-reflect-status').textContent = r?.hiddenMessages ? t('Forgotten: {hiddenMessages} message(s) hidden from her.', { hiddenMessages: r.hiddenMessages.length }) : '';
      await loadMemories();
    }),
  );
  card.append(row);
  return card;
}

onSave($('#memory'), async () => {
  $('#mem-error').textContent = '';
  await api('/memory/settings', {
    method: 'PUT',
    body: {
      enabled: $('#mem-enabled').checked,
      quietMinutes: Number($('#mem-quiet').value),
      injectBudgetChars: Number($('#mem-budget').value),
      fade: $('#mem-fade').value,
      recall: $('#mem-recall').value,
      sharing: $('#mem-sharing').value,
      // Phase 76: the half-life only counts for "Custom"; the presets set their own.
      ...($('#mem-fade').value === 'custom' ? { decay: { halfLifeDays: Number($('#mem-halflife').value) } } : {}),
    },
  });
});
autoSave($('#memory'));

// ---------- web search settings ----------
function searchRows() {
  const p = $('#search-provider').value;
  $('#search-key-row').hidden = !p || p === 'searxng';
  $('#search-url-row').hidden = p !== 'searxng';
}
$('#search-provider').addEventListener('change', searchRows);

async function loadSearch() {
  const s = await api('/search');
  $('#search-provider').value = s.provider ?? '';
  $('#search-url').value = s.url;
  $('#search-key').value = '';
  searchRows();
  $('#search-status').textContent = s.provider ? (s.ready ? t('Ready.') : t('Needs a key or URL.')) : t('Off: Sara can still open web pages you or she knows the address of.');
}

async function saveSearch() {
  const provider = $('#search-provider').value;
  const body = { provider: provider || null };
  if (provider === 'searxng') body.url = $('#search-url').value.trim();
  const key = $('#search-key').value.trim();
  if (key) body.apiKey = key;
  await api('/search', { method: 'PUT', body });
}

// ---------- MCP settings ----------
function mcpRows() {
  const http = $('#mcp-transport').value === 'http';
  $('#mcp-command-row').hidden = http;
  $('#mcp-args-row').hidden = http;
  $('#mcp-url-row').hidden = !http;
}
$('#mcp-transport').addEventListener('change', mcpRows);

function renderMcp(list) {
  const box = $('#mcp-list');
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = t('None yet.');
    box.replaceChildren(p);
    return;
  }
  box.replaceChildren(
    ...list.map((m) => {
      const card = document.createElement('div');
      card.className = 'mcp';
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = m.name;
      const st = document.createElement('small');
      st.className = `st-${m.status}`;
      st.textContent = m.status === 'ready' ? t('connected · tools: {n}', { n: m.tools.length }) : m.status;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost';
      edit.textContent = t('Edit');
      edit.addEventListener('click', () => {
        $('#mcp-add').open = true;
        $('#mcp-name').value = m.name;
        $('#mcp-transport').value = m.transport;
        $('#mcp-command').value = m.command ?? '';
        $('#mcp-args').value = (m.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
        $('#mcp-url').value = m.url ?? '';
        $('#mcp-enabled').checked = m.enabled;
        $('#mcp-secrets').value = '';
        $('#mcp-secrets').placeholder = `Saved: ${[...m.envKeys, ...m.headerKeys.map((h) => `header:${h}`)].join(', ') || 'none'}\nNAME=value to add/replace, NAME= to delete.`;
        mcpRows();
      });
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'ghost';
      restart.textContent = t('Reconnect');
      restart.addEventListener('click', async () => {
        st.textContent = t('connecting…');
        renderMcp(await api(`/mcp/${m.name}/restart`, { method: 'POST', body: {} }));
        await loadTools();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost';
      del.textContent = t('Remove');
      del.addEventListener('click', async () => {
        if (!confirm(t('Remove MCP server {name} and its saved secrets?', { name: m.name }))) return;
        renderMcp(await api(`/mcp/${m.name}`, { method: 'DELETE' }));
        await loadTools();
      });
      row.append(name, st, edit, restart, del);
      card.append(row);
      if (m.error) {
        const err = document.createElement('small');
        err.textContent = m.error;
        card.append(err);
      }
      return card;
    }),
  );
}

async function loadMcp() {
  renderMcp(await api('/mcp'));
  mcpRows();
}

function parseSecrets(text) {
  const env = {};
  const headers = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(t('Secret lines look like NAME=value (got "{x}")', { x: line.slice(0, 30) }));
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1);
    if (k.toLowerCase().startsWith('header:')) headers[k.slice(7).trim()] = v.trim();
    else env[k] = v;
  }
  return { env, headers };
}

$('#mcp-save').addEventListener('click', async () => {
  $('#settings-error').textContent = '';
  const name = $('#mcp-name').value.trim();
  try {
    const { env, headers } = parseSecrets($('#mcp-secrets').value);
    $('#mcp-save').disabled = true;
    $('#mcp-save').textContent = t('Connecting…');
    const list = await api(`/mcp/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: {
        transport: $('#mcp-transport').value,
        command: $('#mcp-command').value.trim(),
        args: $('#mcp-args').value,
        url: $('#mcp-url').value.trim(),
        enabled: $('#mcp-enabled').checked,
        env,
        headers,
      },
    });
    $('#mcp-secrets').value = '';
    $('#mcp-add').open = false;
    renderMcp(list);
    await loadTools();
  } catch (err) {
    $('#settings-error').textContent = err.message;
  } finally {
    $('#mcp-save').disabled = false;
    $('#mcp-save').textContent = t('Save and connect');
  }
});

// ---------- settings ----------
async function loadProviders() {
  state.providers = await api('/providers');
}

function renderProviders() {
  const { providers, presets } = state.providers;
  const list = $('#provider-list');
  if (!providers.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('No providers yet. Sign in to a subscription above, or add one below.');
    list.replaceChildren(p);
  } else {
    list.replaceChildren(
      ...providers.map((p) => {
        const row = document.createElement('div');
        row.className = 'provider';
        const name = document.createElement('span');
        name.textContent = p.label;
        const info = document.createElement('small');
        info.textContent = providerWhere(p);
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ghost';
        edit.textContent = t('Edit');
        edit.addEventListener('click', () => fillProviderForm(p));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ghost';
        del.textContent = t('Remove');
        del.addEventListener('click', async () => {
          if (!confirm(t('Remove {label}? Its saved key is deleted too.', { label: p.label }))) return;
          state.providers = await api(`/providers/${p.id}`, { method: 'DELETE' });
          renderProviders();
        });
        row.append(name, info, edit, del);
        return p.modelList ? providerListCard(p, row) : row;
      }),
    );
  }

  // UX 24: subscriptions (Claude, ChatGPT, Grok) sign in under Settings → Models → Subscriptions and
  // add themselves; as a form template they'd make a broken provider.
  $('#preset').replaceChildren(
    new Option(t('Custom…'), ''),
    ...presets.filter((p) => !SUBSCRIPTION_KINDS.has(p.kind)).map((p) => new Option(p.label, p.id)),
  );

  const dp = $('#default-provider');
  dp.replaceChildren(...providers.map((p) => new Option(p.label, p.id)));
  dp.value = state.providers.defaultProviderId ?? providers[0]?.id ?? '';
  $('#default-model').value = state.providers.defaultModel ?? '';
}

/**
 * Phase 56: a provider's model list under its row: when it was checked, ↻ Refresh, keep it up to
 * date, and for an Ollama: offer every Ollama Cloud model, remove retired cloud models.
 */
function providerListCard(p, row) {
  const box = el('div', 'provider-card');
  const line = el('div', 'provider-models muted small');
  line.dataset.noauto = '';
  const status = el('span', '', checkedAgo(p.modelList.checkedAt) || t('not checked yet'));
  const refresh = el('button', 'ghost small', `↻ ${t('Refresh')}`);
  refresh.type = 'button';
  refresh.title = t('Check for new models now');
  refresh.addEventListener('click', async () => {
    status.textContent = t('Checking…');
    try {
      const v = await modelViewFor(p.id, true);
      const n = v.entries.filter((e) => e.new).length;
      status.textContent = [v.models.length === 1 ? t('1 model available') : t('{n} models available', { n: v.models.length }), n ? t('{n} new', { n }) : '', checkedAgo(v.checkedAt), v.error ?? ''].filter(Boolean).join(' · ');
    } catch (err) {
      status.textContent = err.message;
    }
  });
  const opts = p.modelList.options;
  const toggle = (key, label, tip) => {
    const lab = el('label', 'row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(opts[key]);
    cb.addEventListener('change', async () => {
      status.textContent = t('Saving…');
      try {
        const v = await api(`/providers/${p.id}/models/options`, { method: 'PUT', body: { [key]: cb.checked } });
        opts[key] = cb.checked;
        modelCache.set(p.id, Promise.resolve(v));
        status.textContent = `${t('Saved')} · ${checkedAgo(v.checkedAt)}`;
      } catch (err) {
        cb.checked = !cb.checked;
        status.textContent = err.message;
      }
    });
    const q = el('button', 'tip', '?');
    q.type = 'button';
    q.dataset.tip = tip;
    lab.append(cb, document.createTextNode(` ${label} `), q);
    return lab;
  };
  line.append(el('span', '', `${t('Model list')}: `), status, document.createTextNode(' '), refresh);
  const switches = el('div', 'provider-switches small');
  switches.dataset.noauto = '';
  switches.append(toggle('keepCurrent', t('Keep the model list up to date'), t('Sara checks this list once a day: new models show up marked New, retired ones disappear. Off: the list only changes when you press Refresh.')));
  if (opts.daemon) {
    switches.append(
      toggle('ollamaCloud', t('Use Ollama Cloud models'), t('Cloud models run on ollama.com and are billed to the account this Ollama is signed in to. Shows them all (picking one adds it there first). Off by default for extra Saras on a shared server.')),
      toggle('removeRetired', t('Remove retired cloud models from Ollama'), t('When Ollama Cloud retires a model, also remove it from this Ollama (it is hidden either way). Only cloud models are removed, never models downloaded to that computer.')),
    );
  }
  box.append(row, line, switches);
  return box;
}

/** Plain-language "where is this" line for a provider. */
function providerWhere(p) {
  if (p.kind === 'chatgpt') return 'your ChatGPT plan';
  if (p.kind === 'claude-code') return 'your Claude subscription';
  if (p.kind === 'grok-cli') return 'your Grok subscription';
  let host = '';
  try {
    host = new URL(p.baseUrl).host;
  } catch {
    host = p.baseUrl;
  }
  const where = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? t('on the server') : host;
  const key = p.needsKey ? (p.hasKey ? ', key saved' : ', key missing') : '';
  return `${where}${key}`;
}

const SUBSCRIPTION_KINDS = new Set(['chatgpt', 'claude-code', 'grok-cli']);
function fillProviderForm(p) {
  $('#add-provider').open = true;
  $('#p-id').value = p.id ?? '';
  $('#p-label').value = p.label ?? '';
  $('#p-kind').value = p.kind ?? 'openai-compatible';
  $('#p-url').value = p.baseUrl ?? '';
  $('#p-key').value = '';
  $('#p-local').checked = Boolean(p.local);
  $('#p-needs-key').checked = Boolean(p.needsKey);
}

$('#preset').addEventListener('change', () => {
  const preset = state.providers.presets.find((p) => p.id === $('#preset').value);
  fillProviderForm(preset ?? {});
});

$('#p-save').addEventListener('click', async () => {
  $('#settings-error').textContent = '';
  const id = $('#p-id').value.trim();
  const body = {
    label: $('#p-label').value.trim() || id,
    kind: $('#p-kind').value,
    baseUrl: $('#p-url').value.trim(),
    local: $('#p-local').checked,
    needsKey: $('#p-needs-key').checked,
  };
  const key = $('#p-key').value.trim();
  if (key) body.apiKey = key;
  try {
    state.providers = await api(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body });
    $('#p-key').value = '';
    $('#add-provider').open = false;
    renderProviders();
    // UX 16: Which model does what lists providers too: rebuild it so the new one is there.
    void renderRoutes().catch(() => {});
  } catch (err) {
    $('#settings-error').textContent = err.message;
  }
});

// Model lists per provider, fetched once per Settings visit. Phase 56: the server keeps each list
// current (new models marked, retired ones gone, Ollama Cloud models not added yet in their group).
const modelCache = new Map();
function modelViewFor(providerId, fresh = false) {
  if (fresh) modelCache.delete(providerId);
  if (!modelCache.has(providerId)) {
    const req = fresh ? api(`/providers/${providerId}/models/refresh`, { method: 'POST' }) : api(`/providers/${providerId}/models`);
    modelCache.set(providerId, req.then((r) => ({ ...r, entries: r.entries ?? r.models.map((id) => ({ id })) })).catch((err) => { modelCache.delete(providerId); throw err; }));
  }
  return modelCache.get(providerId);
}
async function modelsFor(providerId) {
  return (await modelViewFor(providerId)).models;
}
/** "checked 3 h ago" for a list's last check. */
function checkedAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 90_000) return t('checked just now');
  if (ms < 90 * 60_000) return t('checked {n} min ago', { n: Math.round(ms / 60_000) });
  if (ms < 36 * 3600_000) return t('checked {n} h ago', { n: Math.round(ms / 3600_000) });
  return t('checked {n} days ago', { n: Math.round(ms / 86_400_000) });
}
/**
 * Fills a model <select> from a provider's list: its models (new ones marked), then the Ollama Cloud
 * models not added to that Ollama yet in their own group. `current` stays listed even if retired.
 */
function fillModelOptions(sel, view, current, { blank = '' } = {}) {
  const opt = (e) => new Option(e.new ? `${e.id}  · ${t('New')}` : e.id, e.id);
  const entries = view.entries.filter((e) => !e.unpulled);
  const cloud = view.entries.filter((e) => e.unpulled);
  const known = view.entries.some((e) => e.id === current);
  const items = [...(blank ? [new Option(blank, '')] : []), ...(current && !known ? [new Option(current, current)] : []), ...entries.map(opt)];
  if (cloud.length) {
    const g = document.createElement('optgroup');
    g.label = t('Ollama Cloud (added when you pick one)');
    g.append(...cloud.map(opt));
    items.push(g);
  }
  sel.replaceChildren(...items);
}

/**
 * A model chooser: a list of the provider's models plus "Other (type a name)…".
 * Returns { el, value(), load(providerId, current) }.
 */
function modelChooser() {
  const wrap = el('span', 'model-chooser');
  const sel = document.createElement('select');
  const input = document.createElement('input');
  input.placeholder = t('model name');
  input.hidden = true;
  const note = el('small', 'muted', '');
  // Phase 56: check this provider's list for new models now.
  const refresh = el('button', 'ghost small model-refresh', '↻');
  refresh.type = 'button';
  refresh.title = t('Check for new models now');
  refresh.setAttribute('aria-label', t('Check for new models now'));
  refresh.hidden = true;
  wrap.append(sel, input, refresh, note);
  sel.addEventListener('change', () => {
    input.hidden = sel.value !== '__other';
    if (!input.hidden) input.focus();
  });
  let shown = '';
  const api_ = {
    el: wrap,
    value: () => (sel.value === '__other' ? input.value.trim() : sel.value),
    async load(providerId, current = '', fresh = false) {
      note.textContent = '';
      shown = providerId;
      refresh.hidden = !providerId;
      if (!providerId) {
        sel.replaceChildren();
        sel.hidden = true;
        input.hidden = true;
        return;
      }
      sel.hidden = false;
      sel.replaceChildren(new Option(t('Loading models…'), ''));
      try {
        const view = await modelViewFor(providerId, fresh);
        fillModelOptions(sel, view, current, { blank: current ? '' : t('Choose a model…') });
        sel.append(new Option(t('Other (type a name)…'), '__other'));
        sel.value = current || (view.models.length ? '' : '__other');
        refresh.title = `${t('Check for new models now')}${view.checkedAt ? ` (${checkedAgo(view.checkedAt)})` : ''}`;
        if (fresh) note.textContent = ` ${checkedAgo(view.checkedAt)}${view.error ? ` · ${view.error}` : ''}`;
      } catch (err) {
        sel.replaceChildren(new Option(t('Other (type a name)…'), '__other'));
        sel.value = '__other';
        input.value = current;
        note.textContent = ` ${t("Couldn't load models: {message}", { message: err.message })}`;
      }
      input.hidden = sel.value !== '__other';
    },
  };
  refresh.addEventListener('click', () => {
    if (shown) void api_.load(shown, api_.value(), true);
  });
  return api_;
}

async function loadModels(fresh) {
  const id = $('#default-provider').value;
  const status = $('#models-status');
  const select = $('#model-select');
  if (!id) {
    status.textContent = t('Add a provider first.');
    return;
  }
  status.textContent = t('Loading models…');
  try {
    // Phase 56: the Refresh button checks the provider now; opening the page uses the kept list.
    const view = await modelViewFor(id, fresh === true);
    const models = view.models;
    const current = $('#default-model').value.trim();
    fillModelOptions(select, view, current);
    select.append(new Option(t('Other (type a name)…'), ''));
    select.value = current || models[0] || '';
    $('#default-model').value = select.value;
    $('#default-model').hidden = Boolean(select.value);
    select.hidden = false;
    const fresh_ = view.entries.filter((e) => e.new).length;
    status.textContent = [models.length === 1 ? t('1 model available') : t('{n} models available', { n: models.length }), fresh_ ? t('{n} new', { n: fresh_ }) : '', checkedAgo(view.checkedAt), view.error ?? ''].filter(Boolean).join(' · ');
  } catch (err) {
    select.hidden = true;
    $('#default-model').hidden = false;
    status.textContent = t("Couldn't load models: {message}", { message: err.message });
  }
}
$('#load-models').addEventListener('click', () => loadModels(true));
$('#default-provider').addEventListener('change', () => {
  $('#default-model').value = '';
  loadModels();
});
$('#model-select').addEventListener('change', () => {
  const v = $('#model-select').value;
  $('#default-model').value = v;
  $('#default-model').hidden = Boolean(v);
  if (!v) $('#default-model').focus();
});

// Settings pages (Phase 15): a list of pages grouped by topic, a search box, one page at a time.
// Old tab names still work (links and first-run steps use them).
const OLD_TABS = { yours: 'her-character', models: 'models-default', you: 'you-about', abilities: 'ab-tools', connections: 'co-phone', voice: 'her-voice', data: 'dh-health' };
// In the phone apps the adult-mode page isn't offered (store rules; it's a web-browser setting).
// Adult mode is web-browser only (hidden in the phone and desktop apps); "This computer" only in the desktop app.
// Phase 71: a household member sees only their own pages (data-member-only), never the owner's
// (data-owner-only); the household page isn't on the demo server.
const settingsPages = () =>
  [...document.querySelectorAll('#settings .settings-page')].filter(
    (p) =>
      !(p.dataset.page === 'you-adult' && /\b(SaraPhone|SaraDesktop)\/\d/.test(navigator.userAgent)) &&
      !(p.dataset.page === 'desktop-app' && !window.SaraDesktop) &&
      !(isMember() ? 'ownerOnly' in p.dataset : 'memberOnly' in p.dataset) &&
      !(p.dataset.page === 'household' && document.body.classList.contains('demo')),
  );

// Settings groups (UI cleanup): real headers with an icon, opened and closed by a click; only the
// group of the page on screen is open at first, and the choice is remembered on this device.
const SETTINGS_GROUPS = [
  { name: 'Her', icon: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z' },
  { name: 'You', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7' },
  { name: 'Models', icon: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4' },
  { name: 'Abilities', icon: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z' },
  { name: 'Connections', icon: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
  { name: 'Data & health', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8 12h2l1.5-3 2 6 1.5-3h1' },
  { name: 'Household', icon: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6' },
];
// The order of the pages inside each group. Page ids and group names stay the same: links, tips,
// tours and the guide's "Settings → Abilities → …" paths use them.
const SETTINGS_ORDER = [
  'her-character', 'her-relationship', 'her-look', 'her-pictures', 'her-voice', 'her-calls', 'her-companions', 'her-import',
  'you-about', 'you-briefing', 'you-leave-by', 'you-adult',
  'models-default', 'models-routes', 'models-providers', 'models-subs', 'models-local',
  'ab-tools', 'ab-skills', 'ab-plugins', 'ab-search', 'ab-library', 'ab-google', 'ab-home', 'ab-mcp',
  'ab-projects', 'ab-budgets', 'ab-github', 'ab-ssh', 'ab-recipes',
  'co-phone', 'desktop-app', 'co-computer', 'co-telegram', 'co-discord', 'co-apps', 'co-agents', 'co-hooks',
  'dh-health', 'dh-devices', 'dh-backups', 'dh-data', 'dh-updates', 'dh-usage', 'dh-reports',
  'household', 'account',
];
// A small heading inside a group, before the first of these pages.
const SETTINGS_SUB = { 'ab-projects': 'For coding' };
const NS_SVG = 'http://www.w3.org/2000/svg';
function lineIcon(d, cls = '') {
  const s = document.createElementNS(NS_SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
  if (cls) s.setAttribute('class', cls);
  const path = document.createElementNS(NS_SVG, 'path');
  path.setAttribute('d', d);
  s.append(path);
  return s;
}
const openGroups = () => {
  try {
    const v = JSON.parse(localStorage.getItem('sara.settingsGroups') ?? 'null');
    return Array.isArray(v) ? new Set(v) : null;
  } catch {
    return null;
  }
};
function setGroupOpen(box, open, remember = true) {
  box.classList.toggle('open', open);
  box.querySelector('.settings-nav-head').setAttribute('aria-expanded', String(open));
  box.querySelector('.settings-nav-items').hidden = !open;
  if (!remember) return;
  const set = new Set([...document.querySelectorAll('#settings-nav-list .settings-nav-group.open')].map((g) => g.dataset.group));
  localStorage.setItem('sara.settingsGroups', JSON.stringify([...set]));
}

function buildSettingsNav() {
  const nav = $('#settings-nav-list');
  const groups = new Map();
  const seen = new Set();
  const order = (p) => {
    const i = SETTINGS_ORDER.indexOf(p.dataset.page);
    return i < 0 ? SETTINGS_ORDER.length : i;
  };
  // One entry per page (a page listed twice once showed up twice at the end of the list).
  for (const sec of settingsPages().sort((x, y) => order(x) - order(y))) {
    if (seen.has(sec.dataset.page)) continue;
    seen.add(sec.dataset.page);
    if (!groups.has(sec.dataset.group)) groups.set(sec.dataset.group, []);
    groups.get(sec.dataset.group).push(sec);
  }
  const rank = (g) => {
    const i = SETTINGS_GROUPS.findIndex((x) => x.name === g);
    return i < 0 ? SETTINGS_GROUPS.length : i;
  };
  const remembered = openGroups();
  nav.replaceChildren(
    ...[...groups].sort(([x], [y]) => rank(x) - rank(y)).map(([g, secs], gi) => {
      const box = el('div', 'settings-nav-group');
      box.dataset.group = g;
      const head = el('button', 'settings-nav-head');
      head.type = 'button';
      const listId = `settings-group-${gi}`;
      head.setAttribute('aria-controls', listId);
      const info = SETTINGS_GROUPS.find((x) => x.name === g);
      head.append(lineIcon(info?.icon ?? 'M4 6h16M4 12h16M4 18h16', 'sng-icon'), el('span', 'sng-name', t(g)), el('span', 'sng-count', String(secs.length)), lineIcon('M9 6l6 6-6 6', 'sng-chev'));
      const items = el('div', 'settings-nav-items');
      items.id = listId;
      head.addEventListener('click', () => setGroupOpen(box, !box.classList.contains('open')));
      for (const sec of secs) {
        if (SETTINGS_SUB[sec.dataset.page]) items.append(el('div', 'settings-nav-sub', t(SETTINGS_SUB[sec.dataset.page])));
        const b = el('button', 'settings-nav-item', t(sec.dataset.title));
        b.type = 'button';
        b.dataset.page = sec.dataset.page;
        b.addEventListener('click', () => {
          if ($('#settings-search').value) {
            $('#settings-search').value = '';
            clearSettingsSearch();
          }
          showSettingsTab(sec.dataset.page, { focus: true });
        });
        items.append(b);
      }
      box.append(head, items);
      setGroupOpen(box, remembered ? remembered.has(g) : false, false);
      return box;
    }),
  );
}
/** Opens the group of the page on screen (the others keep their state). */
function openGroupOf(page) {
  const box = document.querySelector(`#settings-nav-list [data-page="${page}"]`)?.closest('.settings-nav-group');
  if (box && !box.classList.contains('open')) setGroupOpen(box, true);
}
function clearSettingsSearch() {
  $('.settings-pages').classList.remove('searching');
  for (const x of document.querySelectorAll('#settings-nav-list .dim, #settings-nav-list .no-match')) x.classList.remove('dim', 'no-match');
  for (const g of document.querySelectorAll('#settings-nav-list .settings-nav-group')) setGroupOpen(g, (openGroups() ?? new Set()).has(g.dataset.group), false);
  $('#settings-nav-list').classList.remove('searching');
}

// Phase 23: a "?" on every Settings page: what it's for, in plain words, and the guide.
// Page help and the ? tips live in tips.json (Phase 41), shared with the server's settings guide.
let HELP = {};
const TIP_GUIDE_FOR = { team: 'team', planner: 'planner', memory: 'memory', 'together-dialog': 'together', studio: 'shaping', 'look-studio': 'look' };
fetch('/tips.json')
  .then((r) => r.json())
  .then((d) => {
    HELP = d.pages ?? {};
    addTips(d.tips ?? {});
  })
  .catch(() => {});
// Every page opens with a line on what it is for (from tips.json) and a link to its guide section.
function showSettingsHelp(page) {
  const [text, guide] = HELP[page] ?? ['', 'start'];
  $('#settings-page-desc').hidden = !text;
  $('#settings-help-text').textContent = t(text);
  $('#settings-help-link').href = `/help#${guide}`;
}

function showSettingsTab(page, opts = {}) {
  page = OLD_TABS[page] ?? page;
  const pages = settingsPages();
  const pick = pages.some((p) => p.dataset.page === page) ? page : pages[0].dataset.page;
  for (const p of pages) p.hidden = p.dataset.page !== pick;
  for (const b of document.querySelectorAll('#settings-nav-list [data-page]')) b.setAttribute('aria-current', String(b.dataset.page === pick));
  const sec = pages.find((p) => p.dataset.page === pick);
  $('#settings-page-title').textContent = t(sec.dataset.title);
  showSettingsHelp(pick);
  openGroupOf(pick);
  if (pick === 'dh-updates') void loadUpdates();
  if (pick === 'ab-skills') {
    void loadSkills();
    void loadLearning();
  }
  if (pick === 'ab-plugins') void loadPlugins();
  if (pick === 'ab-budgets') void loadBudgets();
  if (pick === 'ab-projects') void Promise.all([loadSandboxGate(), loadSecPass(), loadThreatModel(), loadRedTeam()]);
  if (pick === 'ab-ssh') void loadSsh();
  if (pick === 'ab-library') void loadLibrarySettings();
  if (pick === 'co-apps') void Promise.all([loadOtherApps(), loadAlexa()]);
  if (pick === 'co-agents') void loadAgents();
  if (pick === 'co-hooks') void loadHooks();
  if (pick === 'co-computer') void loadComputer();
  if (pick === 'her-import') void loadImport();
  if (pick === 'models-local') void loadLocalModels();
  if (pick === 'household') void loadHousehold();
  if (pick === 'account') void loadAccount();
  $('#settings-empty').hidden = true;
  $('#settings').classList.add('page-open'); // phone: show the page instead of the list
  $('.settings-pages').scrollTop = 0;
  localStorage.setItem('sara.settingsPage', pick);
  if (opts.focus) $('.settings-pages').focus({ preventScroll: true });
}

// Search: every word may match a page's title, group, description, labels, tips or text. Pages with
// all the words come first; when no page has them all, pages with any of them show. The list keeps
// up (only matching pages, their groups opened).
const foldText = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** A page's headline words: title, group, description, headings, labels and tips. */
function settingsHeadText(p) {
  const bits = [t(p.dataset.title), p.dataset.title, t(p.dataset.group), t(HELP[p.dataset.page]?.[0] ?? '')];
  for (const n of p.querySelectorAll('h3, h4, label, legend, summary, [data-tip], [aria-label], [placeholder]')) bits.push(n.matches('h3, h4, label, legend, summary') ? n.textContent : '', n.dataset.tip ?? '', n.getAttribute('aria-label') ?? '', n.getAttribute('placeholder') ?? '');
  return foldText(bits.join(' '));
}
/**
 * The pages that match a search. Each word is looked for on its own. Best first: pages whose
 * headline words have every word; else pages with any of the words in their headline words; else
 * pages with every word anywhere in their text; else any word anywhere.
 */
function matchSettings(q, pages, headOf = settingsHeadText, bodyOf = (p) => foldText(p.textContent)) {
  const words = foldText(q).split(/\s+/).filter((w) => w.length > 1 || /\d/.test(w));
  if (!words.length) return [];
  // "backups" also finds "backup", "emails" finds "email".
  const stems = words.map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
  const texts = pages.map((p) => ({ p, head: headOf(p), body: bodyOf(p) }));
  const tiers = [
    (x) => stems.every((w) => x.head.includes(w)),
    (x) => stems.some((w) => x.head.includes(w)),
    (x) => stems.every((w) => x.body.includes(w)),
    (x) => stems.some((w) => x.body.includes(w)),
  ];
  for (const ok of tiers) {
    const hits = texts.filter(ok).map((x) => x.p);
    if (hits.length) return hits;
  }
  return [];
}
$('#settings-search').addEventListener('input', () => {
  const raw = $('#settings-search').value.trim();
  const pages = settingsPages();
  $('.settings-pages').classList.toggle('searching', Boolean(raw));
  if (!raw) {
    clearSettingsSearch();
    return showSettingsTab(localStorage.getItem('sara.settingsPage') ?? 'her-character');
  }
  const hits = new Set(matchSettings(raw, pages));
  for (const p of pages) p.hidden = !hits.has(p);
  $('#settings-nav-list').classList.add('searching');
  for (const b of document.querySelectorAll('#settings-nav-list [data-page]')) {
    const sec = pages.find((x) => x.dataset.page === b.dataset.page);
    b.classList.toggle('no-match', !sec || sec.hidden);
    b.setAttribute('aria-current', 'false');
  }
  for (const g of document.querySelectorAll('#settings-nav-list .settings-nav-group')) {
    const any = Boolean(g.querySelector('.settings-nav-item:not(.no-match)'));
    g.classList.toggle('no-match', !any);
    setGroupOpen(g, any, false);
  }
  const found = hits.size;
  $('#settings-page-title').textContent = found ? (found === 1 ? t('1 page with “{q}”', { q: raw }) : t('{n} pages with “{q}”', { n: found, q: raw })) : '';
  $('#settings-page-desc').hidden = true;
  $('#settings-empty').hidden = found > 0;
  $('#settings').classList.add('page-open');
});
$('#settings-back').addEventListener('click', () => $('#settings').classList.remove('page-open'));
buildSettingsNav();

async function openSettings(tab) {
  $('#settings-search').value = '';
  clearSettingsSearch();
  showSettingsTab(typeof tab === 'string' ? tab : (localStorage.getItem('sara.settingsPage') ?? 'her-character'));
  // On a phone, opening Settings from the menu starts at the list of pages.
  if (typeof tab !== 'string') $('#settings').classList.remove('page-open');
  modelCache.clear();
  $('#settings-error').textContent = '';
  await loadSettingsPages();
  $('#settings').showModal();
  loadModels();
}
/** Fills every Settings page from the server (on open, and again after the app language changes). */
async function loadSettingsPages() {
  const s = await api('/settings');
  await Promise.all([loadProviders(), loadYours()]);
  $('#owner-name').value = s.ownerName;
  $('#time-zone').value = s.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#ui-language').value = s.language ?? 'auto';
  $('#talk-language').value = s.talkLanguage ?? 'auto';
  $('#story-yearly').checked = Boolean(s.storyYearly);
  $('#model-auto-switch').checked = s.modelAutoSwitch !== false;
  {
    const sel = $('#history-budget');
    const v = String(s.historyBudgetChars ?? 48000);
    if (![...sel.options].some((o) => o.value === v)) sel.append(new Option(t('Custom ({date} characters)', { date: Number(v).toLocaleString() }), v));
    sel.value = v;
  }
  renderProviders();
  // Phase 71: a household member's space answers only their own pages; the owner's are skipped.
  if (isMember()) return void (await Promise.all([loadDevices().catch(() => {}), loadPhotos().catch(() => {}), loadBriefing(), loadVoice().catch(() => {}), loadCalls().catch(() => {}), loadPush(), loadAdult(), loadReports(), loadLeaveBy(), loadReview(), loadSecurity(), renderCompanionsPage(), loadDesktop()]));
  await loadTools();
  await Promise.all([loadDevices().catch(() => {}), loadPhotos(), loadOffsite(), loadBriefing(), loadSearch(), loadMcp(), renderRoutes(), loadVoice(), loadCalls(), loadTelegram(), loadDiscord(), loadPush(), loadHealth(), loadBackups(), loadSubs(), loadGitHub(), loadHome(), loadGoogle(), loadAdult(), loadApns(), loadReports(), loadLeaveBy(), loadReview(), loadSecurity(), renderCompanionsPage(), loadDesktop(), loadDesktopGet(), loadHistory(), loadUsage(), loadMcpPresets()]);
}
/**
 * M9: text drawn from data before a language change stays in the old language, so the open
 * windows are drawn again in the new one.
 */
async function rerenderAfterLanguage() {
  gal.list = null;
  if ($('#settings').open) {
    buildSettingsNav();
    showSettingsTab(localStorage.getItem('sara.settingsPage') ?? 'her-character');
    await loadSettingsPages().catch(() => {});
    if (studio.defs) renderStudio();
    await loadModels().catch(() => {}); // UX 21: the Default model status line
  }
  renderConvSummary(); // UX 21: the chat header chip ("main folder")
  relabelNav();
  if ($('#today').open) await Promise.all([loadToday(), loadChecklist()]).catch(() => {});
  await loadConversations().catch(() => {}); // the list's group headings
  await initVoice().catch(() => {}); // call buttons and the live-call notes
}
$('#open-settings').addEventListener('click', openSettings);

async function saveCoreSettings() {
  const before = currentLang();
  await api('/settings', {
    method: 'PUT',
    body: {
      ownerName: $('#owner-name').value.trim(),
      timeZone: $('#time-zone').value.trim(),
      language: $('#ui-language').value,
      talkLanguage: $('#talk-language').value,
      storyYearly: $('#story-yearly').checked,
      defaultProviderId: $('#default-provider').value || null,
      defaultModel: $('#default-model').value.trim() || null,
      historyBudgetChars: Number($('#history-budget').value),
      modelAutoSwitch: $('#model-auto-switch').checked,
    },
  });
  // Phase 53: a new app language shows at once (this window included).
  await applyLanguage($('#ui-language').value, $('#ui-language').value === 'auto' ? '' : undefined);
  if (currentLang() !== before) await rerenderAfterLanguage();
}

// Each Settings page saves only its own part (H1): a change to the time zone no longer rewrites
// tool permissions or reconnects the Discord/Telegram bots. Pages not listed save themselves.
const SETTINGS_SAVERS = {
  'you-about': [saveCoreSettings],
  'you-briefing': [saveCoreSettings, saveBriefing, saveReview],
  'models-default': [saveCoreSettings],
  'you-leave-by': [saveLeaveBy],
  'dh-backups': [saveOffsite, saveBackups],
  'her-pictures': [savePhotos],
  'ab-search': [saveSearch],
  'ab-library': [saveLibrarySettings],
  'ab-tools': [saveTools],
  'models-routes': [saveRoutes],
  'ab-github': [() => saveGitHubWatch().catch((err) => ($('#ghw-status').textContent = err.message))],
  'her-voice': [saveVoice],
  'co-telegram': [saveTelegram],
  'co-discord': [saveDiscord],
  'co-phone': [savePush],
  'dh-usage': [saveUsage],
  'dh-health': [saveRuns],
  'ab-budgets': [saveBudgets],
  'ab-projects': [saveSandboxGate, saveSecPass, saveThreatModel, saveRedTeam],
};
const settingsChanged = new Set();
/** Notes which Settings page an edit was made on (programmatic fills call this themselves). */
function markSettingsArea(page) {
  if (page) settingsChanged.add(page);
}
for (const type of ['input', 'change', 'click']) $('#settings').addEventListener(type, (e) => markSettingsArea(e.target instanceof Element ? e.target.closest('.settings-page')?.dataset.page : ''), true);

async function saveSettings() {
  $('#settings-error').textContent = '';
  // Nothing recorded (e.g. saved on close): the page on screen.
  const pages = settingsChanged.size ? [...settingsChanged] : settingsPages().filter((p) => !p.hidden).map((p) => p.dataset.page);
  settingsChanged.clear();
  const run = new Set([saveYours]); // her name/character and studio drafts (does nothing when unchanged)
  for (const p of pages) for (const fn of SETTINGS_SAVERS[p] ?? []) run.add(fn);
  try {
    for (const fn of run) await fn();
    if (pages.includes('models-default')) await loadProviders();
  } catch (err) {
    for (const p of pages) settingsChanged.add(p); // try these again next time
    $('#settings-error').textContent = err.message;
    throw err;
  }
}
onSave($('#settings'), saveSettings);
autoSave($('#settings'));

// ---------- Phase 52: usage and costs ----------
/** The server's usage line ("12.3k tokens (12k in, 300 out) · local") in the app's language. */
function usageWords(x) {
  if (!x?.calls) return t('No model usage recorded yet.');
  const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const billing = x.billing ?? [];
  const usd = (v) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
  const cost = billing.includes('api')
    ? x.usd > 0 || !x.unpriced
      ? x.unpriced ? t('about {usd} + calls with no price', { usd: usd(x.usd) }) : t('about {usd}', { usd: usd(x.usd) })
      : t('cost unknown (no price for this model)')
    : billing.includes('subscription') ? t('$0 (subscription)') : t('local');
  return `${t('{tokens} tokens ({input} in, {output} out)', { tokens: k(x.tokens), input: k(x.input), output: k(x.output) })} · ${cost}`;
}
let usageData = null;
const PURPOSE_WORDS = { group: 'Group chats', chat: 'Chat', coding: 'Coding', adult: 'Chat (adult)', private: 'Private chats', vision: 'Photos', research: 'Research', team: 'Team tasks', job: 'Background jobs', memory: 'Memory', library: 'Library reading', 'her-life': 'Her life', background: 'Helpers', quick: 'Quick helpers', writing: 'Writing', planning: 'Planning', other: 'Other' };
const numOrEmpty = (v) => (v ? String(v) : '');
function renderUsage() {
  const d = usageData;
  if (!d) return;
  const r = d[$('#usage-range').value] ?? d.today;
  // L4: one call / 2 calls. M11: the total covers every companion on this server.
  const calls = (n) => (n === 1 ? t('1 call') : t('{n} calls', { n }));
  const several = (r.byCompanion ?? []).length > 1;
  $('#usage-total').textContent = r.total.calls ? `${several ? `${t('All companions')}: ` : ''}${r.total.calls === 1 ? t('1 model call') : t('{n} model calls', { n: r.total.calls })} · ${usageWords(r.total)}` : t('No model usage recorded in this period yet.');
  const row = (name, x) => {
    const li = el('li');
    const who = el('strong', '', name);
    who.dataset.raw = '';
    li.append(who, el('span', 'muted small', ` · ${calls(x.calls)} · ${usageWords(x)}`));
    return li;
  };
  $('#usage-companions-box').hidden = !several;
  if (several) $('#usage-companions').replaceChildren(...r.byCompanion.map((c) => row(c.name, c)));
  $('#usage-models').replaceChildren(...(r.byModel.length ? r.byModel.map((m) => row(`${m.model} (${m.providerLabel || m.providerId})`, m)) : [el('li', 'muted small', '—')]));
  $('#usage-purposes').replaceChildren(...(r.byPurpose.length ? r.byPurpose.map((m) => row(t(PURPOSE_WORDS[m.purpose] ?? m.purpose), m)) : [el('li', 'muted small', '—')]));
}
function priceRow(p = {}) {
  // Not an .add-row: its ✕ button would make the boxes "wait for their own button" instead of saving.
  const row = el('div', 'usage-price');
  const mk = (cls, ph, v, type = 'number') => {
    const i = Object.assign(document.createElement('input'), { type, className: cls, placeholder: ph, value: v ?? '' });
    i.setAttribute('aria-label', ph);
    i.title = ph;
    if (type === 'number') Object.assign(i, { min: '0', step: '0.01' });
    return i;
  };
  const model = mk('up-model', t('model name, e.g. gpt-6.1-sol'), p.model, 'text');
  model.maxLength = 200;
  const prov = document.createElement('select');
  prov.className = 'up-prov';
  prov.setAttribute('aria-label', t('Provider'));
  prov.append(new Option(t('Any provider'), ''), ...(usageData?.providers ?? []).map((x) => new Option(x.label, x.id)));
  prov.value = p.providerId ?? '';
  const del = el('button', 'ghost small', '✕');
  del.type = 'button';
  del.title = t('Remove this price');
  del.addEventListener('click', () => {
    row.remove();
    markDirty($('#settings'));
  });
  row.append(model, prov, mk('up-in', t('$ input / 1M'), p.inPerM), mk('up-out', t('$ output / 1M'), p.outPerM), mk('up-cached', t('$ cached / 1M'), p.cachedInPerM), del);
  return row;
}
async function loadUsage() {
  usageData = await api('/usage').catch(() => null);
  if (!usageData) return;
  renderUsage();
  $('#usage-job-tok').value = numOrEmpty(usageData.jobBudget.tokens);
  $('#usage-job-usd').value = numOrEmpty(usageData.jobBudget.usd);
  $('#usage-team-usd').value = numOrEmpty(usageData.teamLimits.usd);
  $('#usage-prices').replaceChildren(...usageData.prices.map((p) => priceRow(p)));
  $('#usage-defaults').replaceChildren(...usageData.defaults.map((p) => el('li', '', `${p.model}: $${p.inPerM} ${t('in')} · $${p.outPerM} ${t('out')}${p.cachedInPerM !== undefined ? ` · $${p.cachedInPerM} ${t('cached')}` : ''} (${p.source ?? ''})`)));
}
async function saveUsage() {
  if (!usageData) return;
  const prices = [...document.querySelectorAll('#usage-prices .usage-price')]
    .map((r) => ({ model: r.querySelector('.up-model').value.trim(), providerId: r.querySelector('.up-prov').value || undefined, inPerM: r.querySelector('.up-in').value, outPerM: r.querySelector('.up-out').value, cachedInPerM: r.querySelector('.up-cached').value || undefined }))
    .filter((p) => p.model && p.inPerM !== '' && p.outPerM !== '');
  await api('/usage/settings', { method: 'PUT', body: { prices, jobBudget: { tokens: $('#usage-job-tok').value, usd: $('#usage-job-usd').value }, teamUsd: $('#usage-team-usd').value || null } });
}
$('#usage-range').addEventListener('change', renderUsage);
$('#usage-price-add').addEventListener('click', () => {
  const r = priceRow();
  $('#usage-prices').append(r);
  r.querySelector('.up-model').focus();
});

/** The line under the chat: tokens and estimated cost of this conversation so far. */
async function updateConvUsage() {
  const id = state.currentId;
  const box = $('#conv-usage');
  if (!id || state.conv?.offRecord) return void (box.hidden = true);
  const u = await api(`/conversations/${id}/usage`).catch(() => null);
  if (id !== state.currentId) return;
  box.hidden = !u?.calls;
  box.textContent = u?.calls ? `${t('This conversation')}: ${usageWords(u)}` : '';
}

/**
 * Phase 75: the small ring in the chat header. She keeps the last HISTORY_LIMIT (60) messages of
 * a conversation word for word (src/chat.ts); older ones live on as her notes and summaries. The
 * ring shows how much of that this conversation fills; the token numbers sit inside its sheet.
 */
const KEPT_MESSAGES = 60;
function updateContextRing() {
  const msgs = state.messages ?? [];
  const said = msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim() && !m.meta?.forgotten).length;
  const share = msgs.length ? said / msgs.length : 0;
  const total = said + Math.round((state.conv?.earlier ?? 0) * share);
  setContextRing(state.currentId && !state.conv?.offRecord && total ? Math.min(100, Math.round((total / KEPT_MESSAGES) * 100)) : null, KEPT_MESSAGES);
}

// ---------- Report this reply (Phase 19) ----------
let reporting = null;
function openReport(m, button) {
  reporting = { m, button, conversationId: state.currentId };
  $('#report-form').reset();
  $('#report-quote').textContent = (m.content || '').slice(0, 300) + ((m.content || '').length > 300 ? '…' : '');
  $('#report-status').textContent = '';
  $('#report-send').disabled = false;
  $('#report-dialog').showModal();
}
$('#report-send').addEventListener('click', async () => {
  const reason = $('#report-form').elements.reason.value;
  if (!reason) return void ($('#report-status').textContent = t('Choose a reason.'));
  $('#report-send').disabled = true;
  try {
    const r = await api('/reports', { method: 'POST', body: { conversationId: reporting.conversationId, messageId: reporting.m.id, reason, note: $('#report-note').value, toDeveloper: $('#report-dev').checked } });
    reporting.button.textContent = t('⚑ Reported');
    reporting.button.disabled = true;
    $('#report-status').textContent = r.sent || !$('#report-dev').checked ? t('Thank you. Reported ✓') : t('Saved here ✓ (couldn’t reach the developer; it will show in Settings → Reports).');
    setTimeout(() => $('#report-dialog').close(), 1400);
  } catch (err) {
    $('#report-status').textContent = err.message;
    $('#report-send').disabled = false;
  }
});
async function loadReports() {
  const r = await api('/reports').catch(() => null);
  if (!r) return;
  const row = (x, extra) => {
    const div = el('div', 'mem');
    const head = el('div', 'muted small', `${r.reasons[x.reason] ?? x.reason} · ${new Date(x.createdAt ?? x.receivedAt).toLocaleString()}${extra ? ` · ${extra}` : ''}`);
    div.append(head, el('div', 'small', x.text.slice(0, 400)));
    if (x.note) div.append(el('div', 'muted small', t('Note: {note}', { note: x.note })));
    return div;
  };
  $('#reports-list').replaceChildren(...(r.reports.length ? r.reports.map((x) => row(x, x.sentAt ? t('sent to the developer') : x.sendError ? t('not sent ({error})', { error: x.sendError }) : t('kept here only'))) : [el('p', 'muted small', t('Nothing reported.'))]));
  $('#reports-inbox-box').hidden = !r.inbox;
  if (r.inbox) $('#reports-inbox').replaceChildren(...(r.inbox.length ? r.inbox.map((x) => row(x, [x.platform, x.appVersion, x.model].filter(Boolean).join(' · '))) : [el('p', 'muted small', t('No reports received.'))]));
}

// ---------- Pair a phone or computer (Phase 16) ----------
let pairTimer = 0;
function stopPairing() {
  clearInterval(pairTimer);
  $('#pair-show').hidden = true;
}
$('#pair-new').addEventListener('click', async () => {
  $('#pair-done').textContent = '';
  const p = await api('/pair', { method: 'POST', body: {} });
  $('#pair-qr').src = p.qr;
  $('#pair-code-text').textContent = p.code;
  $('#pair-url').textContent = p.url.replace(/#.*/, '');
  $('#pair-show').hidden = false;
  const before = (await api('/devices').catch(() => ({ devices: [] }))).devices.length;
  const ends = Date.parse(p.expiresAt);
  clearInterval(pairTimer);
  pairTimer = setInterval(async () => {
    const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
    $('#pair-exp').textContent = left ? t('Works once, for {time} more.', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : t('This code expired.');
    if (!left || !$('#settings').open) return stopPairing();
    if (left % 3 === 0) {
      const now = (await api('/devices').catch(() => null))?.devices;
      if (now && now.length > before) {
        stopPairing();
        const newest = [...now].sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
        $('#pair-done').textContent = `✓ ${t('Signed in: {device}.', { device: newest?.label ?? t('a new device') })}`;
        loadDevices();
      }
    }
  }, 1000);
});
$('#pair-cancel').addEventListener('click', async () => {
  await api('/pair', { method: 'DELETE' });
  stopPairing();
});

// ---------- Adult mode (Phase 16) ----------
async function loadAdult() {
  const a = await api('/adult').catch(() => null);
  if (!a) return;
  $('#adult-state').textContent = a.on ? t('Adult mode is on (since {date}).', { date: new Date(a.confirmedAt).toLocaleDateString() }) : t('Adult mode is off.');
  $('#adult-on-box').hidden = !a.on;
  $('#adult-off-box').hidden = a.on || !a.canTurnOn;
  $('#adult-app-note').hidden = a.on || a.canTurnOn;
  if (a.reason === 'demo') $('#adult-app-note').textContent = t('Adult mode is not available in the demo.');
  $('#adult-confirm').checked = false;
  $('#adult-on').disabled = true;
}
$('#adult-confirm').addEventListener('change', () => ($('#adult-on').disabled = !$('#adult-confirm').checked));
$('#adult-on').addEventListener('click', async () => {
  try {
    await api('/adult', { method: 'PUT', body: { on: true, confirm18: $('#adult-confirm').checked } });
    saved($('#settings'), t('Adult mode is on ✓'));
  } catch (err) {
    $('#settings-error').textContent = err.message;
  }
  loadAdult();
});
$('#adult-off').addEventListener('click', async () => {
  await api('/adult', { method: 'PUT', body: { on: false } });
  saved($('#settings'), t('Adult mode is off ✓'));
  loadAdult();
});
$('#aa-confirm').addEventListener('change', () => ($('#aa-on').disabled = !$('#aa-confirm').checked));
$('#aa-on').addEventListener('click', async () => {
  await api('/adult', { method: 'PUT', body: { on: true, confirm18: $('#aa-confirm').checked } });
  $('#adult-ask').close();
});
$('#aa-off').addEventListener('click', async () => {
  await api('/adult', { method: 'PUT', body: { on: false } });
  $('#adult-ask').close();
});

// ---------- Today (Phase 15) ----------
const timeOf = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function todayRow(main, side, cls = '') {
  const row = el('div', `today-row ${cls}`);
  const m = el('span', 'today-main', main);
  m.dataset.raw = '';
  m.title = main; // long lines (model changes) can be read in full
  row.append(m);
  if (side) row.append(el('span', 'today-side muted small', side));
  return row;
}
/** "Talking", "A backup for Talking", "Helper Ada", "Mia's own model": where a model was chosen, translated. */
function modelWhereWords(where, mid = false) {
  const w = String(where ?? '');
  // Mid-sentence ("…, but a backup for Talking still uses it"), a lead-in phrase starts lower-case.
  const low = (s) => (mid ? s.charAt(0).toLocaleLowerCase(locale()) + s.slice(1) : s);
  const fixed = { 'Your default model': t('Your default model'), 'A backup for the default model': t('A backup for the default model'), 'The safety check': t('The safety check') };
  if (fixed[w]) return low(fixed[w]);
  let m;
  if ((m = /^A backup for (.+)$/.exec(w))) return low(t('A backup for {job}', { job: t(m[1]) }));
  if ((m = /^Helper (.+)$/.exec(w))) return t('Helper {name}', { name: m[1] });
  if ((m = /^(.+)'s own model$/.exec(w))) return t("{name}'s own model", { name: m[1] });
  return t(w);
}
/**
 * A model-list notice (model-catalog.ts: ModelNotice, RetiredUse, ModelListWarning) in the app
 * language, from its fields; the server's English `text` when a field is missing (older servers).
 */
function modelNoticeText(n) {
  if (!n || typeof n !== 'object') return String(n ?? '');
  const by = n.provider === 'its provider' ? t('its provider') : n.provider;
  if (n.reason === 'retired' && n.from && n.to && n.provider && n.where) return t('{from} was retired by {by}; {where} now uses {to}.', { from: n.from, to: n.to, by, where: modelWhereWords(n.where) });
  if (n.reason === 'retired-no-replacement' && n.from && n.provider && n.where) return t('{from} was retired by {by}, but {where} still uses it. No replacement was found: pick another model in Settings → Models.', { from: n.from, by, where: modelWhereWords(n.where, true) });
  if (n.reason === 'retired-auto-switch-off' && n.from && n.provider && n.where) return t('{from} was retired by {by}, but {where} still uses it. Pick another model in Settings → Models.', { from: n.from, by, where: modelWhereWords(n.where, true) });
  if (n.reason === 'list-shrank' && n.provider && Number.isFinite(n.before) && Number.isFinite(n.now)) return t("{provider}'s model list shrank from {before} to {now} models in one check. That looks like a glitch, so nothing was retired; the earlier list is kept.", { provider: n.provider, before: n.before, now: n.now });
  return String(n.text ?? '');
}
const TODAY_GREETINGS = { late: 'Up late', morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' };
/** "today", "tomorrow", "in 3 days" in the app's language. */
const inDaysWords = (n) => (n === 0 ? t('today') : n === 1 ? t('tomorrow') : t('in {n} days', { n }));
async function loadToday(fresh = false) {
  $('#td-status').textContent = fresh ? t('Refreshing…') : '';
  let d;
  try {
    d = await api(`/today${fresh ? '?fresh=1' : ''}`);
  } catch (err) {
    $('#td-status').textContent = err.message;
    return;
  }
  $('#td-status').textContent = '';
  // H3: greeting and date in the app's language (the server sends a key and the day).
  const hello = d.greetingKey ? t(TODAY_GREETINGS[d.greetingKey]) : d.greeting;
  $('#td-greeting').textContent = d.greetingKey && d.owner ? t('{greeting}, {name}', { greeting: hello, name: d.owner }) : hello;
  $('#td-date').textContent = d.day ? new Date(`${d.day}T12:00:00`).toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' }) : d.date;
  const list = (id) => $(`#${id} .today-list`);
  // Phase 75 (stage 3): your day (reminders + calendar), the Planner and the rest are tiles (web/today.js).
  $('#td-mail').hidden = !d.mail;
  if (d.mail)
    list('td-mail').replaceChildren(
      el('p', 'small', d.mail.error ? d.mail.error : d.mail.important.length ? t('{n} unread in your inbox. Looks important:', { n: d.mail.unread }) : t('{n} unread in your inbox.', { n: d.mail.unread })),
      ...d.mail.important.map((m) => todayRow(m.subject, m.from)),
    );
  // The greeting's mood line under her name (the AI notice sits beside her face).
  $('#td-her').hidden = !d.her;
  if (d.her) {
    $('#td-her-name').textContent = d.her.name;
    $('#td-mood-text').textContent = t('Feeling {mood}, {energy}.', { mood: t(d.her.mood), energy: t(d.her.energy) });
    const box = $('#td-her .today-her');
    box.replaceChildren();
    if (d.her.day) {
      const day = el('p', 'td-her-day muted small', d.her.day);
      day.dataset.raw = '';
      day.title = t('Show all');
      day.tabIndex = 0;
      const toggle = () => day.classList.toggle('open');
      day.addEventListener('click', toggle);
      day.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
      box.append(day);
    }
  }
  renderTodayMoments(d);
  $('#td-dates').hidden = !d.dates.length;
  // Phase 101 (ST6): a date about someone on a people card opens their card.
  list('td-dates').replaceChildren(
    ...d.dates.map((x) => {
      const row = todayRow(x.what, inDaysWords(x.inDays), x.inDays === 0 ? 'overdue' : '');
      if (x.personId) {
        row.classList.add('td-person');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', t('Open {name}', { name: x.person }));
        const open = (e) => {
          e.stopPropagation();
          closeToday({ focus: false });
          void showPerson(x.personId);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(e)));
      }
      return row;
    }),
  );
  // Phase 56: retired models and what now uses their replacement.
  $('#td-models').hidden = !d.models?.length;
  // UX 19: the server sends the facts too (modelItems), so the sentence is in the app language.
  const modelLines = d.modelItems?.length ? d.modelItems.map(modelNoticeText) : (d.models ?? []);
  list('td-models').replaceChildren(...modelLines.map((line) => todayRow(`🔄 ${line}`, '', 'wrap')));
  await renderTodayTiles(d, { fmtDue });
}
/** Today, the home screen: over the chat column (web/today.js); the tiles fill in as they load. */
async function openToday() {
  const first = !todayOpen();
  if (first) showToday();
  await Promise.all([loadToday(), loadChecklist()]);
}
$('#open-today').addEventListener('click', openToday);
// Her face and name at the top of the sidebar go to Today too (on phones, the list closes).
$('#brand-today').addEventListener('click', () => {
  $('#main').classList.remove('show-sidebar');
  void openToday();
});
$('#td-refresh').addEventListener('click', () => loadToday(true));
$('#td-otd-open').addEventListener('click', () => {
  $('#today').close();
  void openMoments();
});
$('#td-ask').addEventListener('click', async () => {
  $('#today').close();
  if (!state.currentId || state.conv?.offRecord) await newConversation();
  $('#input').value = t("Let's plan my day: look at my list, my calendar and anything important in my mail, and help me decide what to do first.");
  $('#input').focus();
});

// ---------- keyboard shortcuts (Phase 15) ----------
const SHORTCUTS = { KeyT: openToday, KeyP: () => $('#open-planner').click(), KeyM: () => $('#open-memory').click(), KeyL: () => $('#open-library').click(), KeyB: () => $('#open-scrapbook').click(), KeyY: () => $('#open-story').click(), KeyH: () => $('#open-sara').click(), KeyN: () => $('#new-chat').click() };
document.addEventListener('keydown', (e) => {
  // Today is a view, not a window: the shortcuts work on it too.
  if (document.querySelector('dialog[open]:not(#today)')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    return void openSettings();
  }
  // Ctrl+K / ⌘K opens the command bar (web/command-bar.js). Ctrl+\ / ⌘\ folds her panel.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'Backslash') {
    e.preventDefault();
    return togglePanel();
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && SHORTCUTS[e.code]) {
    e.preventDefault();
    SHORTCUTS[e.code]();
  }
});

// Links that open a view: /#view=today|planner|memory|scrapbook|her|settings[:page] (Phase 19).
window.saraCompanionCount = () => state.companions?.companions.length ?? 1;
const VIEWS = { today: openToday, planner: () => $('#open-planner').click(), memory: () => $('#open-memory').click(), library: () => $('#open-library').click(), scrapbook: () => $('#open-scrapbook').click(), moments: () => $('#open-moments').click(), story: () => $('#open-story').click(), her: () => $('#open-sara').click(), team: () => $('#open-team').click(), evals: () => $('#open-evals').click(), help: () => $('#open-help').click() };
function openViewFromHash() {
  const v = /#view=([\w:-]+)/.exec(location.hash)?.[1];
  if (!v || !$('#main') || $('#main').hidden) return false;
  history.replaceState(null, '', '/');
  if (v.startsWith('settings')) void openSettings(v.split(':')[1]);
  // Phase 74: her citations open a document at a page (/#view=library:<id>:<page>).
  else if (/^library:\d+/.test(v)) {
    const [, id, page] = v.split(':');
    closeOpenDialogs();
    void openLibrary(Number(id), Number(page) || 0);
  } else VIEWS[v]?.();
  return true;
}
window.addEventListener('hashchange', openViewFromHash);

// ---------- Phase 41: the Help window and short tours ----------
const closeOpenDialogs = () => {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
};
const settingsAt = (page) => async () => {
  if (!$('#settings').open) {
    closeOpenDialogs();
    await openSettings(page);
  } else showSettingsTab(page);
};
// On a phone the sidebar slides over the chat: open it for sidebar steps, close it for chat steps.
const sidebar = (open) => () => {
  closeOpenDialogs();
  $('#main').classList.toggle('show-sidebar', open);
  if (!open) setMore(false);
};
// A step on a sidebar place: the list is open, and More too when the place lives there.
const navStep = (sel) => () => {
  sidebar(true)();
  revealNav(sel);
};
const TOURS = {
  first: [
    { sel: '#new-chat', title: t('New conversation'), text: t('Start a fresh chat any time. Old ones stay in the list below, with search.'), before: sidebar(true) },
    { before: sidebar(false), sel: '#input', title: t('Talk to her'), text: t('Type here, or use the microphone. The + button attaches a photo or a file, or starts something to do together.') },
    { before: sidebar(false), sel: '#her-face', title: t('Her panel'), text: t('Her face opens her panel: her mood, what she is doing right now, approvals waiting, your day and what she remembered for this reply. On a phone it slides up from the bottom.') },
    { before: sidebar(false), sel: '#cmd-open', title: t('Search and go'), text: t('Press Ctrl+K (⌘K on a Mac) or this button to jump to any place, conversation, setting or action.') },
    { before: async () => { sidebar(false)(); await showHeadChips(); }, sel: '#conv-settings-btn', title: t('This conversation'), text: t('The model, workspace and mode (chat or coding) for this conversation only. Private keeps everything on your server.') },
    { when: () => !phoneWidth(), before: navStep('#open-today'), sel: '#open-today', title: t('Today'), text: t('Your home screen: the weather, your day, the Planner, what she remembered, photos, background work and your home, as tiles. Her face at the top of the list opens it too.') },
    { when: () => phoneWidth(), before: sidebar(false), sel: '#bottom-bar', title: t('The bar at the bottom'), text: t('Chat, Today, the Planner, and More for every other place. ☰ at the top still lists your conversations.') },
    { before: async () => { sidebar(false)(); await openToday(); }, sel: '#td-tiles', title: t('Your day as tiles'), text: t('Press a tile to open its place. Tiles with nothing in them stay away; Add to your day sets up the weather, your calendar or your home.') },
    { before: navStep('#open-planner'), sel: '#open-planner', title: t('Planner'), text: t('To-dos, reminders and notes. You can also just ask her: "remind me to call Mom at 5".') },
    { before: navStep('#open-memory'), sel: '#open-memory', title: t('Memory'), text: t('What she remembers about you. Look through it, correct it or make her forget something.') },
    { before: navStep('#open-library'), sel: '#open-library', title: t('Library'), text: t('Give her documents to keep (PDFs, Word, spreadsheets, slides, e-books). She remembers the key points and looks things up in them when you ask.') },
    { before: navStep('#open-sara'), sel: '#open-sara', title: t('Her page'), text: t('Her day, her mood and her character. Shape her personality from here.') },
    { before: navStep('#open-team'), sel: '#open-team', title: t('Team'), text: t('For bigger jobs she leads helpers that plan, build, test and review.') },
    { before: navStep('#open-settings'), sel: '#open-settings', title: t('Settings'), text: t('Everything is in pages: Her, Models, You, Abilities, Connections. Every setting has a ? that explains it.') },
    { before: navStep('#open-help'), sel: '#open-help', title: t('Help'), text: t('Come back here for these tours and the guide. Or just ask her how something works.') },
  ],
  studio: [
    { sel: '#st-wizard', title: t('Create your companion'), text: t('The easiest way: a guided setup with cards, about 5 minutes. Every step can be skipped.'), before: settingsAt('her-character') },
    { sel: '#st-archetypes', title: t('Starting points'), text: t('Or pick a starting point and adjust from there. Changes save by themselves; Undo brings back how she was when you opened this page.') },
    { sel: '#st-dials', title: t('Personality dials'), text: t('Slide each dial toward the words that fit her. The middle is balanced. Each dial has its own ? with examples.') },
    { sel: '#st-life', title: t('Her life'), text: t('Her job, home, family and interests give her things to talk about and a day of her own.') },
    { sel: '#st-try', title: t('Try it'), text: t('Hear how she would answer a few everyday moments, before you save.') },
    { sel: '#settings-hint', title: t('Saves by itself'), text: t('Every change saves by itself and shows Saved. Typed text saves when you leave the box.') },
  ],
  models: [
    { sel: '#jobs-recommend', title: t('Use recommended'), text: t('One press picks a sensible model for every job from the ones you have connected.'), before: settingsAt('models-routes') },
    { sel: '#jobs-list', title: t('A model for each job'), text: t('Chat, coding, looking at photos, planning, writing, research and quick jobs. A job with no model of its own uses its parent, then the default.') },
    { sel: '#jobs-companion', title: t('Her own model'), text: t('Give this companion her own chat model, different from the others.') },
    { sel: '#settings-nav-list [data-page="models-default"]', title: t('The default'), text: t('Anything without its own model uses the default model.') },
    { sel: '#settings-nav-list [data-page="models-subs"]', title: t('Subscriptions and providers'), text: t('Sign in with ChatGPT, Claude or Grok, or add your own Ollama or a service with a key. The ? next to each field says what to paste.') },
  ],
  team: [
    { sel: '#team-goal', title: t('Give the team a job'), text: t('Describe the result you want, like "add a dark mode to my website, with tests, and get it reviewed". Or ask her in any chat.'), before: async () => {
      closeOpenDialogs();
      await openTeam();
    } },
    { sel: '#team-issue', title: t('From a GitHub issue'), text: t('Pick an issue and she clones the repository, builds it with her team and opens a reviewed pull request. She stops for your OK on the plan first.') },
    { sel: '#team-tasks', title: t('Tasks'), text: t('Every job with its status. Open one to follow it live, answer questions, message a helper or stop it.') },
    { sel: '#team-detail', title: t('Progress and receipts'), text: t('Each helper\'s work with what actually ran. Her report at the end only claims what the receipts show.') },
  ],
};
/** The phone layout (the bottom bar shows): some tour steps are for it, some for wider screens. */
const phoneWidth = () => matchMedia('(max-width: 720px)').matches;
function runTour(name) {
  const steps = TOURS[name]?.filter((s) => !s.when || s.when());
  if (!steps) return;
  $('#help-menu').close();
  localStorage.setItem('sara.tour.first', 'seen');
  void startTour(steps, t, () => {
    $('#main').classList.remove('show-sidebar');
    setMore(false);
  });
}
$('#open-help').addEventListener('click', () => $('#help-menu').showModal());
for (const b of document.querySelectorAll('#help-menu [data-tour]')) b.addEventListener('click', () => runTour(b.dataset.tour));
// /#tour=<name> starts a tour (links in her answers, the guide).
function tourFromHash() {
  const m = /#tour=(\w+)/.exec(location.hash);
  if (!m || !$('#main') || $('#main').hidden) return false;
  history.replaceState(null, '', '/');
  runTour(m[1]);
  return true;
}
window.addEventListener('hashchange', tourFromHash);
/** Offered once on each device after setup: a small card, never in the way. */
function offerFirstTour() {
  if (localStorage.getItem('sara.tour.first') || tourRunning() || document.querySelector('dialog[open]:not(#today)')) return;
  localStorage.setItem('sara.tour.first', 'offered');
  const box = el('div', 'tour-offer');
  box.setAttribute('role', 'status');
  const yes = el('button', 'small', t('Show me around'));
  const no = el('button', 'ghost small', t('No thanks'));
  const btns = el('div', 'row-btns');
  btns.append(no, yes);
  box.append(el('p', '', t('New here? A one-minute tour shows where everything is. (Help in the sidebar has it any time.)')), btns);
  yes.addEventListener('click', () => {
    box.remove();
    runTour('first');
  });
  no.addEventListener('click', () => box.remove());
  document.body.append(box);
}

initDialogs();
boot()
  .then(() => {
    setTimeout(openViewFromHash, 300);
    // Phase 34: just added a companion and chose "Switch and shape": the guided setup opens.
    if (sessionStorage.getItem('sara.openWizard') === '1') {
      sessionStorage.removeItem('sara.openWizard');
      setTimeout(() => openWizard().catch(() => {}), 600);
    }
  })
  .catch((err) => {
    document.body.textContent = t('Could not reach Sara: {message}', { message: err.message });
  });

// ---------- search ----------
let searchTimer = null;
async function runSearch() {
  const q = $('#conv-search').value.trim();
  if (!q) return renderConversations();
  let r;
  try {
    // Phase 22: one search across everything.
    r = await api(`/find?all=1&q=${encodeURIComponent(q)}`);
  } catch (err) {
    $('#conversations').replaceChildren(el('p', 'muted small group-empty', err.message));
    return;
  }
  if ($('#conv-search').value.trim() !== q) return;
  const nav = $('#conversations');
  const clean = (x) => x.replace(/[*_`#>~]+/g, '');
  const hit = (title, snippet, open) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'search-hit';
    a.append(el('span', 'hit-title', title));
    if (snippet) a.append(el('span', 'hit-snippet', clean(snippet)));
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      $('#main').classList.remove('show-sidebar');
      await open();
    });
    return a;
  };
  const openIn = async (conversationId, messageId) => {
    await openConversation(conversationId);
    if (messageId) await jumpToMessage(messageId);
  };
  const sections = [
    [t('Conversations'), r.conversations.map((x) => hit(x.title, x.kind === 'message' ? `${x.snippet}` : x.snippet, () => openIn(x.conversationId, x.messageId)))],
    [
      t('Memories'),
      r.memories.map((x) =>
        hit(x.title, x.snippet, async () => {
          $('#open-memory').click();
          $('#mem-q').value = q;
          $('#mem-q').dispatchEvent(new Event('input'));
        }),
      ),
    ],
    [t('Notes'), r.notes.map((x) => hit(`📝 ${x.title}`, x.snippet, async () => openPlannerTab('notes')))],
    [t('To-dos and reminders'), r.tasks.map((x) => hit(`${x.kind === 'reminder' ? '⏰' : '☐'} ${x.title}`, x.snippet, async () => openPlannerTab(x.kind === 'reminder' ? 'reminders' : 'tasks')))],
    [t('Scrapbook'), r.scrapbook.map((x) => hit(`♥ ${x.title}`, x.snippet, async () => (x.conversationId && x.messageId ? openIn(x.conversationId, x.messageId) : $('#open-scrapbook').click())))],
    [t('Files'), r.files.map((x) => hit(`📄 ${x.title}`, x.snippet, () => openFileView(x.workspace, x.path, q)))],
  ].filter(([, items]) => items.length);
  if (!sections.length) return nav.replaceChildren(el('p', 'muted small group-empty', t('Nothing found.')));
  nav.replaceChildren(
    ...sections.flatMap(([label, items]) => {
      const head = el('div', 'group-head');
      head.append(el('span', 'group-toggle', `${label} `), el('small', 'muted', String(items.length)));
      return [head, ...items];
    }),
  );
}

function openPlannerTab(tab) {
  $('#open-planner').click();
  setTimeout(() => document.querySelector(`#planner .tab[data-tab="${tab}"]`)?.click(), 50);
}

async function openFileView(ws, path, q) {
  const d = $('#file-view');
  $('#file-view-title').textContent = path.split('/').pop();
  $('#file-view-where').textContent = `${ws === 'main' ? t('Workspace') : t('Workspace “{name}”', { name: ws })} · ${path}`;
  $('#file-view-text').textContent = t('Loading…');
  d.showModal();
  try {
    const f = await api(`/workspaces/${encodeURIComponent(ws)}/file?path=${encodeURIComponent(path)}`);
    if (f.binary) return void ($('#file-view-text').textContent = t('(not a text file)'));
    const pre = $('#file-view-text');
    pre.textContent = f.text + (f.truncated ? '\n…' : '');
    // Show the first match.
    const word = q.toLowerCase().split(/\s+/)[0];
    const at = f.text.toLowerCase().indexOf(word);
    if (at >= 0) {
      const line = f.text.slice(0, at).split('\n').length;
      pre.scrollTop = Math.max(0, (line - 4) * 18);
    }
  } catch (err) {
    $('#file-view-text').textContent = err.message;
  }
}

$('#conv-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
$('#conv-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#conv-search').value = '';
    renderConversations();
  }
});

// ---------- appearance (per device) ----------
// Phase 21: colour, chat background and layout too.
const AP_DEFAULTS = { accent: 'rose', chatbg: 'none', density: 'comfy' };
// Phase 75: Night is the default for everyone who hasn't picked Day (or "Follow the system") on
// this device; web/theme-boot.js applies the same rule before the first paint.
const themePick = () => {
  const v = localStorage.getItem('sara.theme');
  return v === 'light' || v === 'system' ? v : 'dark';
};
function applyAppearance() {
  const theme = themePick();
  const light = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  const root = document.documentElement;
  root.dataset.theme = light ? 'light' : 'dark';
  root.classList.toggle('theme-day', light);
  root.classList.toggle('theme-night', !light);
  // The Windows/Mac app follows: its title bar, backdrop and first paint (web/theme-boot.js).
  if (root.classList.contains('shell') && !root.classList.contains('shell-test')) window.saraShellSay?.({ type: 'theme', theme: theme === 'light' ? 'day' : theme === 'system' ? 'system' : 'night' });
  for (const k of Object.keys(AP_DEFAULTS)) root.dataset[k] = localStorage.getItem(`sara.${k}`) ?? AP_DEFAULTS[k];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--surface-0').trim() || (light ? '#faf7f5' : '#0f0d17'));
  root.style.setProperty('--chat-size', `${localStorage.getItem('sara.textSize') ?? '15'}px`);
}
applyAppearance();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyAppearance);
$('#ap-theme').value = themePick();
$('#ap-size').value = localStorage.getItem('sara.textSize') ?? '15';
$('#ap-typing').value = localStorage.getItem('sara.typing') ?? 'instant';
$('#ap-typing').addEventListener('change', () => localStorage.setItem('sara.typing', $('#ap-typing').value));
$('#ap-theme').addEventListener('change', () => {
  localStorage.setItem('sara.theme', $('#ap-theme').value);
  applyAppearance();
});
$('#ap-size').addEventListener('change', () => {
  localStorage.setItem('sara.textSize', $('#ap-size').value);
  applyAppearance();
});
for (const k of Object.keys(AP_DEFAULTS)) {
  const sel = $(`#ap-${k}`);
  sel.value = localStorage.getItem(`sara.${k}`) ?? AP_DEFAULTS[k];
  sel.addEventListener('change', () => {
    localStorage.setItem(`sara.${k}`, sel.value);
    applyAppearance();
  });
}
// Colour swatches: tap one instead of using the list.
for (const o of $('#ap-accent').options) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ap-swatch';
  b.dataset.accent = o.value;
  b.title = o.textContent;
  b.addEventListener('click', () => {
    $('#ap-accent').value = o.value;
    $('#ap-accent').dispatchEvent(new Event('change'));
  });
  $('#ap-swatches').append(b);
}
$('#ap-swatches').removeAttribute('aria-hidden');

// ---------- project page ----------
let pageProject = null;
function fmtSize(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
async function loadProjectGit(ws) {
  const g = ws ? await api(`/workspaces/${encodeURIComponent(ws)}/git`).catch(() => ({ repo: false })) : { repo: false };
  $('#pp-git-none').hidden = g.repo || !ws;
  for (const id of ['pp-git-status', 'pp-git-diff-box', 'pp-git-log-box']) $(`#${id}`).hidden = !g.repo;
  if (!g.repo) return void ($('#pp-git-branch').textContent = '');
  const lines = g.status.trim().split('\n');
  $('#pp-git-branch').textContent = lines[0].replace(/^## /, '· ');
  $('#pp-git-status').textContent = lines.slice(1).join('\n') || t('No uncommitted changes.');
  const diff = $('#pp-git-diff');
  diff.replaceChildren(
    ...g.diff.split('\n').map((l) => el('div', l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '', l || ' ')),
  );
  $('#pp-git-diff-box').hidden = !g.diff.trim();
  $('#pp-git-log').textContent = g.log.trim() || t('No commits yet.');
}
$('#pp-git-refresh').addEventListener('click', () => loadProjectGit(pageProject?.workspace));

async function loadProjectPreviews(ws) {
  const box = $('#pp-previews');
  const r = ws ? await api(`/previews?workspace=${encodeURIComponent(ws)}`).catch(() => ({ previews: [] })) : { previews: [] };
  if (!r.previews.length) return box.replaceChildren(el('p', 'muted small', ws ? t('No app is being previewed here right now.') : t('This project has no workspace.')));
  box.replaceChildren(
    ...r.previews.map((p) => {
      const row = el('div', 'pp-item pp-preview');
      row.append(el('span', '', `🖥️ ${t('Port')} ${p.port} · ${t('job')} #${p.jobId}`));
      const open = el('button', 'ghost small', t('Open'));
      open.type = 'button';
      open.addEventListener('click', () => {
        $('#project-page').close();
        openPreview(p.url);
      });
      const stop = el('button', 'ghost small', t('Close link'));
      stop.type = 'button';
      stop.addEventListener('click', async () => {
        await api(`/previews/${p.token}`, { method: 'DELETE' }).catch(() => {});
        if (state.previewUrl?.includes(p.token)) closePreview();
        void loadProjectPreviews(ws);
      });
      row.append(open, stop);
      return row;
    }),
  );
}

async function openProjectPage(id) {
  const d = await api(`/projects/${id}`);
  void loadProjectGit(d.project.workspace);
  void loadProjectPreviews(d.project.workspace);
  pageProject = d.project;
  // Phase 50: Overview first; the Map tab shows her code map of the workspace.
  resetProjectMap(d.project.workspace);
  $('#pp-title').textContent = d.project.name;
  $('#pp-ws').textContent = d.project.workspace ? t('workspace: {name}', { name: d.project.workspace }) : t('no workspace');
  $('#pp-convs').replaceChildren(
    ...(d.conversations.length
      ? d.conversations.map((c) => {
          const a = el('a', 'pp-item', c.title);
          a.href = '#';
          if (c.archivedAt) a.append(el('small', 'muted', ` ${t('(archived)')}`));
          a.addEventListener('click', async (e) => {
            e.preventDefault();
            $('#project-page').close();
            await openConversation(c.id);
          });
          return a;
        })
      : [el('p', 'muted small', t('No conversations yet.'))]),
  );
  const open = d.tasks.filter((t) => t.status !== 'done');
  const done = d.tasks.filter((t) => t.status === 'done');
  $('#pp-tasks').replaceChildren(
    ...open.map((t) => taskRow(t)),
    ...(done.length ? [el('p', 'muted small', `${done.length} done`)] : []),
    ...(!d.tasks.length ? [el('p', 'muted small', t('No to-dos.'))] : []),
  );
  $('#pp-notes').replaceChildren(
    ...(d.notes.length
      ? d.notes.map((n) => {
          const det = document.createElement('details');
          det.className = 'pp-note';
          det.append(el('summary', '', n.title), el('div', 'pp-note-body', n.body));
          return det;
        })
      : [el('p', 'muted small', t('No notes.'))]),
  );
  $('#pp-file-view').hidden = true;
  if (!d.project.workspace) {
    $('#pp-files-count').textContent = '';
    $('#pp-files').replaceChildren(el('p', 'muted small', t('Give this project a workspace (Edit) to keep its files together.')));
  } else {
    $('#pp-files-count').textContent = d.files.length ? t('{n}, newest first', { n: `${d.files.length}${d.filesTruncated ? '+' : ''}` }) : '';
    $('#pp-files').replaceChildren(
      ...(d.files.length
        ? d.files.map((f) => {
            const a = el('a', 'pp-item pp-file', f.path);
            a.href = '#';
            a.append(el('small', 'muted', ` ${fmtSize(f.size)} · ${new Date(f.modifiedAt).toLocaleDateString()}`));
            a.addEventListener('click', async (e) => {
              e.preventDefault();
              const v = $('#pp-file-view');
              try {
                const r = await api(`/workspaces/${encodeURIComponent(d.project.workspace)}/file?path=${encodeURIComponent(f.path)}`);
                v.textContent = r.binary ? t('{path} is not a text file ({size}).', { path: f.path, size: fmtSize(r.size) }) : r.text + (r.truncated ? `\n… ${t('(first 200 KB shown)')}` : '');
              } catch (err) {
                v.textContent = err.message;
              }
              v.hidden = false;
              v.scrollIntoView({ block: 'nearest' });
            });
            return a;
          })
        : [el('p', 'muted small', t('The workspace is empty.'))]),
    );
  }
  if (!$('#project-page').open) $('#project-page').showModal();
}
function taskRow(tk) {
  const row = el('label', 'pp-task');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.addEventListener('change', async () => {
    await api(`/tasks/${tk.id}`, { method: 'PATCH', body: { status: 'done' } });
    await openProjectPage(pageProject.id);
  });
  row.append(cb, el('span', '', tk.title));
  if (tk.dueAt) row.append(el('small', 'muted', ` ${t('due {date}', { date: new Date(tk.dueAt).toLocaleDateString() })}`));
  return row;
}
initProjectMap(() => pageProject?.workspace ?? null);
initSkills();
initPlugins();
initLearning();
initBoard({ fmtDue: (iso) => fmtDue(iso, false), openConversation: (id) => openConversation(id), openPlanner: async (tab) => {
  if (!$('#planner').open) await openPlanner();
  document.querySelector(`#planner .tab[data-tab="${tab}"]`)?.click();
} });
// Phase 96: the old Recipes page points to Skills.
$('#rc-open-skills')?.addEventListener('click', () => showSettingsTab('ab-skills', { focus: true }));
$('#pp-edit').addEventListener('click', () => {
  $('#project-page').close();
  openProjectDialog(pageProject);
});
$('#pp-new-conv').addEventListener('click', async () => {
  $('#project-page').close();
  await newConversation(pageProject.id);
});
// Phase 52: a new project from a tested starter (copied into the project's workspace, tests run as a job).
$('#pp-starter').addEventListener('click', async () => {
  const { starters } = await api('/starters');
  $('#starter-status').textContent = starters.length ? '' : t('The starter templates are not installed on this server.');
  $('#starter-list').replaceChildren(
    ...starters.map((s, i) => {
      const l = el('label', 'starter-choice');
      const r = Object.assign(document.createElement('input'), { type: 'radio', name: 'starter', value: s.name, checked: i === 0 });
      l.append(r, el('strong', '', s.title), el('span', 'muted small', ` · ${s.language} · ${s.description}`));
      return l;
    }),
  );
  $('#starter-name').value = '';
  $('#starter-dialog').showModal();
  $('#starter-name').focus();
});
$('#starter-go').addEventListener('click', async () => {
  const name = $('#starter-list').querySelector('input:checked')?.value;
  const projectName = $('#starter-name').value.trim();
  if (!name || !projectName) return void ($('#starter-status').textContent = t('Pick a starter and name the folder.'));
  $('#starter-go').disabled = true;
  try {
    const r = await api('/starters', { method: 'POST', body: { name, projectName, workspace: pageProject?.workspace || 'main', ...(pageProject ? { projectId: pageProject.id } : {}) } });
    $('#starter-dialog').close();
    $('#project-page').close();
    await loadConversations();
    await openConversation(r.conversationId);
  } catch (err) {
    $('#starter-status').textContent = err.message;
  }
  $('#starter-go').disabled = false;
});
$('#pp-task-add').addEventListener('click', async () => {
  const title = $('#pp-task').value.trim();
  if (!title) return;
  await api('/tasks', { method: 'POST', body: { title, project: pageProject.name } });
  $('#pp-task').value = '';
  await openProjectPage(pageProject.id);
});
$('#pp-note-add').addEventListener('click', async () => {
  const body = $('#pp-note').value.trim();
  if (!body) return;
  await api('/notes', { method: 'POST', body: { body, project: pageProject.name } });
  $('#pp-note').value = '';
  await openProjectPage(pageProject.id);
});
for (const [inp, btn] of [['#pp-task', '#pp-task-add'], ['#pp-note', '#pp-note-add']]) {
  $(inp).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(btn).click();
    }
  });
}

// ---------- morning briefing ----------
async function loadBriefing() {
  try {
    const b = await api('/briefing');
    $('#br-enabled').checked = b.enabled;
    $('#br-time').value = b.time;
    $('#br-place').value = b.place?.name ?? '';
    $('#br-units').value = b.units;
    $('#br-status').textContent = b.place ? t('Weather for {name}.', { name: b.place.name }) : '';
  } catch (err) {
    $('#br-status').textContent = err.message;
  }
}
// Passkeys and two-step sign-in (Phase 24).
/** Changing how you sign in asks for the owner token (or the current code, with two-step on). */
let securityTwoStep = false;
/**
 * UX 32: asks for proof in a small window (not the browser's prompt()): a passkey when this
 * device can use one, else the owner token, or with two-step on the current 6-digit code. Resolves
 * to the body the server expects ({ passkey } / { token } / { code }); Cancel or Esc rejects
 * with "Cancelled".
 */
function askProof({ passkey = false } = {}) {
  const d = $('#proof');
  const code = securityTwoStep;
  $('#proof-why').textContent = code ? t('To confirm it’s you, enter the current 6-digit code from your authenticator app:') : t('To confirm it’s you, enter your owner token:');
  $('#proof-token-row').hidden = code;
  $('#proof-code-row').hidden = !code;
  $('#proof-passkey').hidden = $('#proof-or').hidden = !passkey;
  $('#proof-token').value = $('#proof-code').value = '';
  $('#proof-error').textContent = '';
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (value, err) => {
      if (done) return;
      done = true;
      cleanup();
      if (d.open) d.close();
      if (err) reject(err);
      else resolve(value);
    };
    const cancelled = () => finish(null, Object.assign(new Error(t('Cancelled.')), { name: t('Cancelled') }));
    const submit = (e) => {
      e.preventDefault();
      const v = (code ? $('#proof-code') : $('#proof-token')).value.trim();
      if (!v) return void ($('#proof-error').textContent = code ? t('Type the 6-digit code.') : t('Type your owner token.'));
      finish(code ? { code: v } : { token: v });
    };
    const usePasskey = async () => {
      $('#proof-error').textContent = '';
      try {
        const o = await api('/passkey/confirm-options', { method: 'POST', body: {} });
        const cred = await navigator.credentials.get({ publicKey: { challenge: b64u.dec(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout, allowCredentials: [] } });
        if (cred) finish({ passkey: { id: cred.id, clientDataJSON: b64u.enc(cred.response.clientDataJSON), authenticatorData: b64u.enc(cred.response.authenticatorData), signature: b64u.enc(cred.response.signature) } });
      } catch {
        $('#proof-error').textContent = code ? t('No passkey was used. Type the 6-digit code instead.') : t('No passkey was used. Type your owner token instead.');
      }
    };
    const cleanup = () => {
      $('#proof-form').removeEventListener('submit', submit);
      $('#proof-cancel').removeEventListener('click', cancelled);
      $('#proof-passkey').removeEventListener('click', usePasskey);
      d.removeEventListener('close', cancelled);
    };
    $('#proof-form').addEventListener('submit', submit);
    $('#proof-cancel').addEventListener('click', cancelled);
    $('#proof-passkey').addEventListener('click', usePasskey);
    d.addEventListener('close', cancelled); // Esc
    d.showModal();
    (passkey ? $('#proof-passkey') : code ? $('#proof-code') : $('#proof-token')).focus();
  });
}
/** Changing how you sign in asks for the owner token (or the current code, with two-step on). */
function confirmBody() {
  return askProof();
}
/** Security review: making an API key or approving an app: a passkey when there is one, else the token or code. */
async function confirmProof() {
  const s = await api('/security').catch(() => null);
  if (s) securityTwoStep = s.twoStep;
  return askProof({ passkey: Boolean(s?.passkeys?.length && passkeysWork()) });
}
async function loadSecurity() {
  const s = await api('/security').catch(() => null);
  if (!s) return;
  renderSecurity(s);
}
function renderSecurity(s) {
  securityTwoStep = s.twoStep;
  $('#pk-add-row').hidden = !passkeysWork();
  $('#pk-list').replaceChildren(
    ...(s.passkeys.length
      ? s.passkeys.map((p) => {
          const row = el('div', 'pk-row');
          row.append(el('span', '', `🔑 ${p.label}`), el('span', 'muted small', `${t('added {date}', { date: new Date(p.createdAt).toLocaleDateString() })}${p.lastUsedAt ? ` · ${t('last used {date}', { date: new Date(p.lastUsedAt).toLocaleDateString() })}` : ''}`));
          const rm = el('button', 'ghost small', t('Remove'));
          rm.type = 'button';
          rm.addEventListener('click', async () => {
            if (!confirm(t(`Remove the passkey "${p.label}"? It won't sign in here any more.`))) return;
            try {
              renderSecurity(await api('/passkey/remove', { method: 'POST', body: { id: p.id, ...(await confirmBody()) } }));
            } catch (err) {
              $('#pk-status').textContent = err.message;
            }
          });
          row.append(rm);
          return row;
        })
      : [el('p', 'muted small', passkeysWork() ? t('No passkeys yet.') : t('No passkeys yet. Add one from a web browser (the phone apps sign in with a code instead).'))]),
  );
  $('#ts-state').textContent = s.twoStep ? t('✓ Two-step sign-in is on.') : t('Two-step sign-in is off.');
  $('#ts-start').hidden = s.twoStep;
  $('#ts-off-row').hidden = !s.twoStep;
  if (s.twoStep) $('#ts-setup').hidden = true;
}
$('#pk-add').addEventListener('click', async () => {
  $('#pk-status').textContent = '';
  try {
    const o = await api('/passkey/register-options', { method: 'POST', body: await confirmBody() });
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64u.dec(o.challenge),
        rp: o.rp,
        user: { ...o.user, id: b64u.dec(o.user.id) },
        pubKeyCredParams: o.pubKeyCredParams,
        excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: b64u.dec(c.id) })),
        authenticatorSelection: o.authenticatorSelection,
        attestation: o.attestation,
        timeout: o.timeout,
      },
    });
    if (!cred) return;
    renderSecurity(await api('/passkey/register', { method: 'POST', body: { label: $('#pk-label').value.trim(), clientDataJSON: b64u.enc(cred.response.clientDataJSON), attestationObject: b64u.enc(cred.response.attestationObject) } }));
    $('#pk-label').value = '';
    $('#pk-status').textContent = t('Passkey added. Next time, choose “Sign in with a passkey”.');
  } catch (err) {
    $('#pk-status').textContent = err.name === 'NotAllowedError' ? t('Cancelled.') : err.name === 'InvalidStateError' ? t('This device already has a passkey for Sara.') : err.message;
  }
});
$('#ts-start').addEventListener('click', async () => {
  $('#ts-status').textContent = '';
  try {
    const r = await api('/two-step/start', { method: 'POST', body: await confirmBody() });
    $('#ts-qr').src = r.qr;
    $('#ts-secret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
    $('#ts-setup').hidden = false;
    $('#ts-code').focus();
  } catch (err) {
    $('#ts-status').textContent = err.message;
  }
});
$('#ts-confirm').addEventListener('click', async () => {
  try {
    const r = await api('/two-step/confirm', { method: 'POST', body: { code: $('#ts-code').value.trim() } });
    $('#ts-code').value = '';
    $('#ts-status').textContent = `${t('Two-step sign-in is on. Keep the authenticator app: you need it to sign in with the token.')}${r.signedOut ? ` ${t('Other devices signed out: {n}. Sign in there again.', { n: r.signedOut })}` : ''}`;
    loadSecurity();
  } catch (err) {
    $('#ts-status').textContent = err.message;
  }
});
$('#ts-stop').addEventListener('click', async () => {
  try {
    await api('/two-step/stop', { method: 'POST', body: { code: $('#ts-off-code').value.trim() } });
    $('#ts-off-code').value = '';
    $('#ts-status').textContent = t('Two-step sign-in is off.');
    loadSecurity();
  } catch (err) {
    $('#ts-status').textContent = err.message;
  }
});

// Updates (Phase 23).
let upTimer = null;
// After a click the server's updater picks the request up a moment later. Until its status changes
// (a new time or state) the page keeps showing "Checking…" and keeps looking, so the first click
// visibly works (it used to show the old status and stop, so it seemed to need a second click).
let upWait = null;
async function loadUpdates() {
  clearTimeout(upTimer);
  let u;
  try {
    u = await api('/update');
  } catch {
    // Restarting after an update: try again shortly.
    upTimer = setTimeout(loadUpdates, 3000);
    return;
  }
  $('#up-version').textContent = `${t('Sara')} ${u.version}${u.revision ? ` (${u.revision})` : ''}`;
  // 2.18: the sidebar's "Update available" link follows what this page shows; a new version reloads.
  upx.available = Boolean(u.available);
  upx.status = u.status;
  paintUpdateLink();
  if (versionChanged(upx.version, u.version)) void onNewVersion(u.version);
  $('#up-manual').hidden = u.available;
  $('#up-check').hidden = !u.available;
  const st = u.status;
  if (upWait && (Date.now() > upWait.until || (st.at ?? '') !== upWait.at || st.state !== upWait.state)) upWait = null;
  if (upWait && !st.pending && st.state !== 'checking' && st.state !== 'updating') st.pending = upWait.action;
  const busy = Boolean(st.pending) || st.state === 'checking' || st.state === 'updating';
  $('#up-check').disabled = busy;
  $('#up-go').hidden = !u.available || st.state !== 'available';
  $('#up-go').disabled = busy;
  const msg = st.pending === 'update' ? t('Starting the update…') : st.pending === 'check' ? t('Checking for updates…') : st.message;
  $('#up-message').textContent = msg ? `${msg}${st.at && !busy ? ` (${new Date(st.at).toLocaleString()})` : ''}` : u.available ? t('Press Check for updates to see if there is a new version.') : '';
  // Phase 46: Windows and macOS update with the installer from the download page.
  const release = u.how === 'release';
  if (release) $('#up-go').hidden = true;
  $('#up-download-row').hidden = !release || !['available', 'failed'].includes(st.state) || !st.downloadUrl;
  if (st.downloadUrl) $('#up-download').href = st.downloadUrl;
  $('#up-download').textContent = st.state === 'available' && st.latest ? t('Download Sara {latest}', { latest: st.latest }) : t('Open the download page');
  $('#up-changes').hidden = st.state !== 'available' || !st.changes?.length;
  $('#up-changes').replaceChildren(...(st.changes ?? []).map((c) => el('li', '', c)));
  if (busy && !$('#settings').hidden && $('#settings').open) upTimer = setTimeout(loadUpdates, 2500);
}
async function requestUpdate(action) {
  try {
    const before = await api('/update').catch(() => null);
    const r = await api('/update', { method: 'POST', body: { action } });
    // Windows / macOS answer with the result itself; the server's updater works in the background.
    if (r?.how !== 'release' && before) upWait = { action, at: before.status?.at ?? '', state: before.status?.state ?? '', until: Date.now() + (action === 'update' ? 15 * 60_000 : 90_000) };
  } catch (err) {
    $('#up-message').textContent = err.message;
    return false;
  }
  loadUpdates();
  return true;
}
$('#up-check').addEventListener('click', () => requestUpdate('check'));
$('#up-go').addEventListener('click', () => {
  if (!confirm(t('Update now? Sara makes a backup, installs the new version and restarts (about a minute). If it does not start properly she goes back to this version.'))) return;
  watchForNewVersion(20 * 60_000);
  void requestUpdate('update').then((ok) => {
    if (ok) return;
    clearTimeout(upx.watch);
    upx.startedHere = false;
  });
});
// Windows / macOS: the installer updates Sara and starts her again; this page then reloads by itself.
$('#up-download').addEventListener('click', () => {
  if (upx.status?.state === 'available') watchForNewVersion(3 * 60 * 60_000);
});

// 2.18: the update experience. Rules in web/update-check.js (tested in Node):
// - when the app opens, and every hour while it is open, it looks at the last update check; when
//   that is older than 12 hours it asks the server to check again (never in the demo, for a
//   household member or in private local mode; one check at a time);
// - a newer version shows "Sara X is available" (Update now / Later / Don't remind me about this
//   version, remembered per version on this device) and the sidebar's "Update available" link;
// - after an update the server answers with a new version: the page that started it reloads, others
//   reload when nothing would be lost (or show "Sara was updated. Reload"), and after the reload
//   "Sara was updated to X" shows. The desktop and phone apps show this same page, so it covers them.
const upx = { version: '', demo: false, member: false, privateLocal: false, available: false, how: '', status: null, inFlight: false, tick: null, watch: null, startedHere: false, reloading: false, noteTimer: null };
const LATER_KEY = 'sara.updateLater';
const store = (area, key, value) => {
  try {
    if (value === undefined) return area.getItem(key);
    area.setItem(key, value);
  } catch {
    /* private browsing: nothing is remembered */
  }
  return null;
};
function initUpdates(session) {
  upx.version = session.version ?? '';
  upx.demo = Boolean(session.demo);
  upx.member = session.role === 'member';
  upx.privateLocal = Boolean(session.privateLocal);
  if (!upx.version) return;
  if (updatedNote(store(localStorage, SEEN_KEY), upx.version)) showUpdateNote(t('Sara was updated to {version}.', { version: upx.version }), false);
  store(localStorage, SEEN_KEY, upx.version);
}
function startUpdateChecks() {
  if (!upx.version || upx.demo || upx.member || upx.tick) return;
  upx.tick = setInterval(() => void updateTick(), 60 * 60_000);
  setTimeout(() => void updateTick(), 6000);
}
async function updateTick() {
  let u;
  try {
    u = await api('/update');
  } catch {
    return;
  }
  upx.available = Boolean(u.available);
  upx.how = u.how;
  upx.status = u.status;
  if (versionChanged(upx.version, u.version)) return void onNewVersion(u.version);
  if (shouldCheck({ ...upx, status: u.status })) {
    upx.inFlight = true;
    try {
      const r = await api('/update', { method: 'POST', body: { action: 'check' } });
      // Windows / macOS answer at once; the server's updater (Linux) answers a little later.
      upx.status = r.how === 'release' ? r.status : await waitForCheck(u.status);
    } catch {
      /* private local mode, or a check or update is already running: keep the last answer */
    } finally {
      upx.inFlight = false;
    }
  }
  paintUpdateLink();
  offerUpdate();
}
async function waitForCheck(before) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = (await api('/update').catch(() => null))?.status;
    if (s && !s.pending && s.state !== 'checking' && (s.at ?? '') !== (before?.at ?? '')) return s;
  }
  return before;
}
function paintUpdateLink() {
  const s = upx.status ?? {};
  const on = updatesShown(upx) && s.state === 'available' && Boolean(s.latest);
  $('#side-update').hidden = !on;
  if (on) $('#side-update').title = t('Sara {latest} is available: open Settings → Updates', { latest: s.latest });
}
function offerUpdate() {
  const s = upx.status ?? {};
  if (!updatesShown(upx) || !shouldRemind({ status: s, version: upx.version, dismissed: store(localStorage, DISMISS_KEY), later: store(sessionStorage, LATER_KEY) })) return;
  // Never on top of another window (setup, Settings…): the sidebar link stays, the next look offers it again.
  if (document.querySelector('dialog[open]:not(.today-view)')) return;
  $('#upp-title-text').textContent = t('Sara {latest} is available', { latest: s.latest });
  $('#upp-changes').replaceChildren(...(s.changes ?? []).slice(0, 8).map((c) => el('li', '', c)));
  $('#upp-dismiss').checked = false;
  const release = upx.how === 'release';
  $('#upp-go').hidden = release;
  $('#upp-download').hidden = !release;
  if (release && s.downloadUrl) $('#upp-download').href = s.downloadUrl;
  $('#update-pop').dataset.latest = s.latest;
  $('#update-pop').showModal();
}
// However the window closes (Later, Update now, ×, Esc): this version isn't offered again this
// session, or never on this device with "Don't remind me about this version".
$('#update-pop').addEventListener('close', () => {
  const latest = $('#update-pop').dataset.latest ?? '';
  if (latest) store($('#upp-dismiss').checked ? localStorage : sessionStorage, $('#upp-dismiss').checked ? DISMISS_KEY : LATER_KEY, latest);
});
function closeUpdatePop() {
  if ($('#update-pop').open) $('#update-pop').close();
}
$('#upp-later').addEventListener('click', closeUpdatePop);
$('#upp-go').addEventListener('click', () => {
  closeUpdatePop();
  // The window was the question; Settings → Updates shows the progress, then the page reloads.
  watchForNewVersion(20 * 60_000);
  void openSettings('dh-updates')
    .then(() => requestUpdate('update'))
    .then((ok) => {
      if (ok) return;
      clearTimeout(upx.watch);
      upx.startedHere = false;
    });
});
$('#upp-download').addEventListener('click', () => {
  closeUpdatePop();
  watchForNewVersion(3 * 60 * 60_000);
  void openSettings('dh-updates');
});
$('#side-update').addEventListener('click', () => void openSettings('dh-updates'));
async function serverVersion() {
  try {
    const r = await fetch('/api/session', { cache: 'no-store' });
    return r.ok ? ((await r.json()).version ?? '') : '';
  } catch {
    return '';
  }
}
async function checkServerVersion() {
  if (!upx.version || upx.reloading) return;
  const v = await serverVersion();
  if (versionChanged(upx.version, v)) await onNewVersion(v);
}
// After "Update now" (or the installer download): look until the server answers with a new version.
function watchForNewVersion(ms) {
  if (!upx.version) return;
  upx.startedHere = true;
  clearTimeout(upx.watch);
  const until = Date.now() + ms;
  const look = async () => {
    const v = await serverVersion();
    if (versionChanged(upx.version, v)) return void onNewVersion(v);
    // The server's updater went back to this version, or failed: Settings → Updates says why.
    if (v && !upx.member) {
      const st = (await api('/update').catch(() => null))?.status;
      if (st && !st.pending && ['rolledback', 'failed'].includes(st.state)) return void (upx.startedHere = false);
    }
    if (Date.now() > until) {
      upx.startedHere = false;
      return void showUpdateNote(t("Sara hasn't come back on a new version yet. Reload when the update has finished."), true);
    }
    upx.watch = setTimeout(look, 4000);
  };
  upx.watch = setTimeout(look, 4000);
}
async function onNewVersion(v) {
  clearTimeout(upx.watch);
  if (upx.reloading) return;
  const dialogOpen = Boolean(document.querySelector('dialog[open]:not(.today-view)'));
  if (reloadNow({ composer: $('#input')?.value ?? '', dialogOpen, startedHere: upx.startedHere })) return void reloadOntoNewVersion();
  showUpdateNote(t('Sara was updated to {version}. Reload to use it.', { version: v }), true);
}
async function reloadOntoNewVersion() {
  upx.reloading = true;
  // The service worker's new version (a new shell cache) is fetched before the reload.
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update();
  } catch {
    /* no service worker here (desktop shells may not have one) */
  }
  location.reload();
  // Still here a few seconds later: the button does it by hand.
  setTimeout(() => {
    upx.reloading = false;
    showUpdateNote(t('Sara was updated. Reload to use the new version.'), true);
  }, 6000);
}
function showUpdateNote(text, withReload) {
  clearTimeout(upx.noteTimer);
  $('#update-note-text').textContent = text;
  $('#update-note-reload').hidden = !withReload;
  $('#update-note').hidden = false;
  if (!withReload) upx.noteTimer = setTimeout(() => ($('#update-note').hidden = true), 10_000);
}
$('#update-note-reload').addEventListener('click', () => location.reload());
$('#update-note-close').addEventListener('click', () => ($('#update-note').hidden = true));

// "Getting started" on the Today page (Phase 23).
async function loadChecklist() {
  const c = await api('/checklist').catch(() => null);
  const left = c ? c.items.filter((i) => !i.done) : [];
  $('#td-start').hidden = !c || c.hidden || !left.length;
  if ($('#td-start').hidden) return;
  $('#td-start-count').textContent = t('{done} of {total} done', { done: c.items.length - left.length, total: c.items.length });
  // 2.8: the same count as a small ring before the words (decorative; the words say it).
  document.querySelector('.today-start-head > .pring')?.remove();
  $('#td-start-count').before(progressRing(shareOf(c.items.length - left.length, c.items.length), { size: 26, stroke: 3 }));
  $('#td-start-list').replaceChildren(
    ...c.items.map((i) => {
      const b = el('button', `start-item${i.done ? ' done' : ''}`);
      b.type = 'button';
      b.disabled = i.done;
      b.append(el('span', 'start-tick', i.done ? '✓' : ''), el('span', 'start-label', t(i.label)), el('span', 'start-hint', t(i.hint)));
      b.addEventListener('click', async () => {
        $('#today').close();
        if (i.open === 'chat') return void $('#input').focus();
        if (i.open.startsWith('settings:')) await openSettings(i.open.split(':')[1]);
      });
      return b;
    }),
  );
}
$('#td-start-hide').addEventListener('click', async () => {
  await api('/checklist', { method: 'PUT', body: { hidden: true } }).catch(() => {});
  $('#td-start').hidden = true;
});

// Weekly review (Phase 22).
async function loadReview() {
  const r = await api('/review').catch(() => null);
  if (!r) return;
  $('#rv-enabled').checked = r.enabled;
  $('#rv-day').value = String(r.day);
  $('#rv-time').value = r.time;
}
async function saveReview() {
  await api('/review', { method: 'PUT', body: { enabled: $('#rv-enabled').checked, day: Number($('#rv-day').value), time: $('#rv-time').value || '18:00' } });
}
$('#review-now').addEventListener('click', async () => {
  $('#review-now').disabled = true;
  $('#review-status').textContent = t('Looking back over your week…');
  try {
    const r = await api('/review/now', { method: 'POST', body: {} });
    $('#review-status').textContent = '';
    $('#planner').close();
    await loadConversations();
    await openConversation(r.conversationId);
  } catch (err) {
    $('#review-status').textContent = err.message;
  } finally {
    $('#review-now').disabled = false;
  }
});

// Leave-by reminders (Phase 20).
async function loadLeaveBy() {
  const l = await api('/leave-by').catch(() => null);
  if (!l) return;
  $('#lb-enabled').checked = l.enabled;
  $('#lb-home').value = l.home?.label ?? '';
  $('#lb-found').textContent = l.home ? t('Found: {label}', { label: l.home.label }) : '';
  $('#lb-mode').value = l.mode;
  $('#lb-buffer').value = l.bufferMin;
  $('#lb-cal').hidden = l.calendar;
}
async function saveLeaveBy() {
  const l = await api('/leave-by', { method: 'PUT', body: { enabled: $('#lb-enabled').checked, home: $('#lb-home').value.trim(), mode: $('#lb-mode').value, bufferMin: Number($('#lb-buffer').value) } });
  $('#lb-home').value = l.home?.label ?? '';
  $('#lb-found').textContent = l.home ? t('Found: {label}', { label: l.home.label }) : '';
}

async function saveBriefing() {
  const b = await api('/briefing', { method: 'PUT', body: { enabled: $('#br-enabled').checked, time: $('#br-time').value, place: $('#br-place').value.trim(), units: $('#br-units').value } });
  $('#br-place').value = b.place?.name ?? '';
}
$('#br-send').addEventListener('click', async () => {
  $('#br-status').textContent = t('Sending…');
  $('#br-send').disabled = true;
  try {
    await saveBriefing();
    await api('/briefing/send', { method: 'POST', body: {} });
    $('#br-status').textContent = t('Sent. It is in your latest chat.');
  } catch (err) {
    $('#br-status').textContent = err.message;
  } finally {
    $('#br-send').disabled = false;
  }
});

// ---------- MCP presets (email, calendar) ----------
let mcpPresets = [];
async function loadMcpPresets() {
  try {
    mcpPresets = await api('/mcp/presets');
  } catch {
    mcpPresets = [];
  }
  $('#mcp-preset').replaceChildren(new Option(t('Blank'), ''), ...mcpPresets.map((p) => new Option(p.label, p.id)));
}
$('#mcp-preset').addEventListener('change', () => {
  const p = mcpPresets.find((x) => x.id === $('#mcp-preset').value);
  $('#mcp-preset-help').hidden = !p;
  if (!p) return;
  $('#mcp-preset-help').textContent = p.help;
  $('#mcp-name').value = p.name;
  $('#mcp-transport').value = 'stdio';
  $('#mcp-transport').dispatchEvent(new Event('change'));
  $('#mcp-command').value = p.command;
  $('#mcp-args').value = p.args.join(' ');
  $('#mcp-secrets').value = p.secrets.map((x) => `${x.name}=${x.hint.startsWith('http') || /^(true|\d+|essential|America\/)/.test(x.hint) ? x.hint : ''}`).join('\n');
  $('#mcp-secrets').placeholder = p.secrets.map((x) => `${x.name}=${x.hint}`).join('\n');
  $('#mcp-secrets').rows = p.secrets.length + 1;
});
// MCP presets load when Settings opens (after sign-in; L2).

// ---------- off-server backup copies ----------
function showOffsiteFields() {
  const k = $('#os-kind').value;
  $('#os-folder').hidden = k !== 'folder';
  $('#os-s3').hidden = k !== 's3';
  $('#os-common').hidden = k === 'off';
}
$('#os-kind').addEventListener('change', showOffsiteFields);
function renderOffsite(o) {
  $('#os-kind').value = o.kind;
  $('#os-path').value = o.path ?? '';
  $('#os-endpoint').value = o.endpoint ?? '';
  $('#os-bucket').value = o.bucket ?? '';
  $('#os-region').value = o.region ?? '';
  $('#os-key').value = o.accessKeyId ?? '';
  $('#os-keep').value = o.keep ?? 14;
  $('#os-secret').placeholder = o.hasS3Secret ? t('saved (leave empty to keep)') : t('secret key');
  $('#os-pass').placeholder = o.hasPassphrase ? t('saved (leave empty to keep)') : t('at least 10 characters');
  const last = o.last;
  $('#os-status').textContent = last ? (last.ok ? t('Last copy {date}: {name}', { date: new Date(last.at).toLocaleString(), name: last.name }) : t('Last copy failed {date}: {error}', { date: new Date(last.at).toLocaleString(), error: last.error })) : o.kind === 'off' ? '' : t('No copy yet.');
  const tst = o.lastTest;
  $('#os-test').hidden = o.kind === 'off';
  $('#os-test-status').textContent = o.kind === 'off' ? '' : !tst ? t('Not tested yet.') : tst.ok ? `${t('Test restore worked')} ${new Date(tst.at).toLocaleString()}: ${tst.detail ?? ''}` : `${t('Test restore failed')} ${new Date(tst.at).toLocaleString()}: ${tst.error}`;
  showOffsiteFields();
}
async function loadOffsite() {
  try {
    renderOffsite(await api('/backups/offsite'));
  } catch (err) {
    $('#os-status').textContent = err.message;
  }
}
async function saveOffsite() {
  const body = { kind: $('#os-kind').value, path: $('#os-path').value, endpoint: $('#os-endpoint').value, bucket: $('#os-bucket').value, region: $('#os-region').value, accessKeyId: $('#os-key').value, keep: Number($('#os-keep').value) || 14 };
  if ($('#os-pass').value) body.passphrase = $('#os-pass').value;
  if ($('#os-secret').value) body.s3Secret = $('#os-secret').value;
  renderOffsite(await api('/backups/offsite', { method: 'PUT', body }));
  $('#os-pass').value = '';
  $('#os-secret').value = '';
}
$('#os-now').addEventListener('click', async () => {
  $('#os-status').textContent = t('Copying…');
  $('#os-now').disabled = true;
  try {
    await saveOffsite();
    renderOffsite(await api('/backups/offsite/upload', { method: 'POST', body: {} }));
  } catch (err) {
    $('#os-status').textContent = err.message;
  } finally {
    $('#os-now').disabled = false;
  }
});
$('#os-test').addEventListener('click', async () => {
  $('#os-test-status').textContent = t('Downloading and checking… (this can take a minute)');
  $('#os-test').disabled = true;
  try {
    renderOffsite(await api('/backups/offsite/test', { method: 'POST', body: {} }));
  } catch (err) {
    $('#os-test-status').textContent = err.message;
  } finally {
    $('#os-test').disabled = false;
  }
});

// ---------- full check (doctor) ----------
$('#doctor-run').addEventListener('click', async () => {
  const list = $('#doctor-checks');
  list.hidden = false;
  list.replaceChildren(el('li', 'muted', t('Checking… (providers can take a few seconds)')));
  $('#doctor-run').disabled = true;
  try {
    const checks = await api('/doctor');
    list.replaceChildren(
      ...checks.map((c) => {
        const li = el('li', c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'bad');
        li.append(el('strong', '', `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name}`), el('span', 'muted', ` ${c.detail}`));
        return li;
      }),
    );
  } catch (err) {
    list.replaceChildren(el('li', 'bad', err.message));
  } finally {
    $('#doctor-run').disabled = false;
  }
});

// ---------- pictures from Sara ----------
function renderPhotos(p) {
  $('#ph-mode').value = p.mode;
  $('#ph-model').value = p.model ?? '';
  $('#ph-new').hidden = p.mode !== 'new';
  $('#ph-key').placeholder = p.hasKey ? t('saved (leave empty to keep)') : p.providerKey ? t('leave empty to use the xAI key from Models') : 'xai-…';
  $('#ph-key').placeholder = p.hasKey ? t('saved (leave empty to keep)') : p.grokSubscription ? t('not needed: uses your Grok subscription') : p.providerKey ? t('leave empty to use the xAI key from Models') : 'xai-…';
  $('#ph-status').textContent = p.mode !== 'new' ? '' : p.hasKey ? t('Uses the xAI API key saved here (billed per picture).') : p.grokSubscription ? t('Uses your Grok subscription: counts toward your weekly Grok usage (Imagine).') : p.providerKey ? t("Uses your xAI model provider's API key (billed per picture).") : t('Sign in to Grok (Models → Subscriptions) or add an xAI API key to let her take new pictures.');
  $('#ph-taken').replaceChildren(
    ...p.taken.map((t) => {
      const img = document.createElement('img');
      img.src = `/api/uploads/${t.id}`;
      img.title = t.scene;
      img.alt = t.scene;
      return img;
    }),
  );
}
async function loadPhotos() {
  try {
    renderPhotos(await api('/photos'));
  } catch {
    /* older server */
  }
}
async function savePhotos() {
  const body = { mode: $('#ph-mode').value, model: $('#ph-model').value };
  if ($('#ph-key').value.trim()) body.key = $('#ph-key').value.trim();
  renderPhotos(await api('/photos', { method: 'PUT', body }));
  $('#ph-key').value = '';
}
$('#ph-mode').addEventListener('change', () => ($('#ph-new').hidden = $('#ph-mode').value !== 'new'));

// ---------- scrapbook ----------
function sbTab(which) {
  for (const b of document.querySelectorAll('#scrapbook [data-sb]')) b.classList.toggle('active', b.dataset.sb === which);
  $('#sb-moments').hidden = which !== 'moments';
  $('#sb-photos-tab').hidden = which !== 'photos';
  for (const b of document.querySelectorAll('#scrapbook [data-sb]')) b.setAttribute('aria-selected', String(b.dataset.sb === which));
}
for (const b of document.querySelectorAll('#scrapbook [data-sb]')) b.addEventListener('click', () => sbTab(b.dataset.sb));
async function loadScrapbook() {
  const d = await api('/scrapbook');
  const entries = d.entries.filter((e) => e.kind !== 'photo');
  $('#sb-moments').replaceChildren(
    ...(entries.length
      ? entries.map((e) => {
          const card = el('div', `sb-card ${e.kind}`);
          const head = el('div', 'sb-head', `${e.kind === 'joke' ? `😄 ${t('Inside joke')}` : `✨ ${t('Moment')}`} · ${new Date(e.createdAt).toLocaleDateString(locale())}${e.addedBy === 'sara' ? t(' · added by Sara') : ''}`);
          const body = el('div', 'sb-text', e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text);
          card.append(head, body);
          const foot = el('div', 'sb-foot');
          if (e.conversationId) {
            const go = el('a', 'small', e.conversation ? t('from “{title}”', { title: e.conversation }) : t('open conversation'));
            go.href = '#';
            go.addEventListener('click', async (ev) => {
              ev.preventDefault();
              await openAtMessage(e.conversationId, e.messageId);
            });
            foot.append(go);
          }
          // Removing a moment or joke takes it out of the scrapbook only; the message stays.
          const del = el('button', 'ghost small sb-del', t('Remove'));
          del.type = 'button';
          del.title = e.kind === 'joke' ? t('Remove this inside joke from the scrapbook') : t('Remove this moment from the scrapbook (the message stays in your conversation)');
          del.setAttribute('aria-label', del.title);
          del.addEventListener('click', async () => {
            await api(`/scrapbook/${e.id}`, { method: 'DELETE' });
            card.remove();
            if (!$('#sb-moments .sb-card')) await loadScrapbook();
          });
          foot.append(del);
          card.append(foot);
          return card;
        })
      : [emptyState('📌', t('Nothing yet. Press 📌 under a message to keep a moment.'))]),
  );
  const photos = d.photos ?? [];
  const hidden = d.hiddenPhotos ?? [];
  const items = photos.map((p) => ({ src: `/api/uploads/${p.image}`, label: `${p.from === 'sara' ? t('From Sara') : t('From you')} · ${new Date(p.createdAt).toLocaleDateString(locale())}`, caption: p.text || '' }));
  $('#sb-photos').replaceChildren(
    ...(photos.length ? photos.map((p, i) => sbPhoto(p, () => openLightbox(items, i))) : [emptyState('📷', t('No photos shared yet.'))]),
  );
  // Photos taken out of the scrapbook can come back.
  $('#sb-hidden').hidden = !hidden.length;
  $('#sb-hidden-count').textContent = String(hidden.length);
  $('#sb-hidden-list').replaceChildren(
    ...hidden.map((p) => {
      const fig = el('figure', 'sb-photo sb-photo-hidden');
      const img = document.createElement('img');
      img.src = `/api/uploads/${p.image}`;
      img.alt = p.text || t('Photo');
      img.loading = 'lazy';
      const back = el('button', 'ghost small', t('Put back'));
      back.type = 'button';
      back.addEventListener('click', async () => {
        await api('/scrapbook/photos/unhide', { method: 'POST', body: { image: p.image } });
        await loadScrapbook();
      });
      fig.append(img, back);
      return fig;
    }),
  );
}

/** One photo in the scrapbook: opens large; remove from the scrapbook, or delete it everywhere (asks first). */
function sbPhoto(p, open) {
  const fig = el('figure', `sb-photo ${p.from}`);
  const img = document.createElement('img');
  img.src = `/api/uploads/${p.image}`;
  img.alt = p.text || t('Photo');
  img.loading = 'lazy';
  const view = el('button', 'sb-photo-open');
  view.type = 'button';
  view.setAttribute('aria-label', t('Open this photo large'));
  view.append(img);
  view.addEventListener('click', open);
  const cap = el('figcaption', 'muted small', `${p.from === 'sara' ? t('From Sara') : t('From you')} · ${new Date(p.createdAt).toLocaleDateString(locale())}`);
  const acts = el('div', 'sb-photo-acts');
  const hide = el('button', 'linkish small', t('Remove from scrapbook'));
  hide.type = 'button';
  hide.title = t('Takes it out of the scrapbook only. The photo stays in its message.');
  hide.addEventListener('click', async () => {
    hide.disabled = true;
    await api('/scrapbook/photos/hide', { method: 'POST', body: { image: p.image } }).catch((err) => alert(err.message));
    await loadScrapbook();
  });
  const del = el('button', 'linkish small danger-text', t('Delete photo everywhere…'));
  del.type = 'button';
  del.title = t('Deletes the photo from every message, the scrapbook and your album. Asks first.');
  del.addEventListener('click', () => {
    acts.hidden = true;
    const ask = el('div', 'sb-confirm');
    ask.setAttribute('role', 'alertdialog');
    ask.setAttribute('aria-label', t('Delete photo everywhere?'));
    const msg = el('p', 'small', t('Delete this photo everywhere? It is taken out of every message (the words stay), the scrapbook and your album, and the file is deleted. This can’t be undone.'));
    const yes = el('button', 'small danger', t('Delete it'));
    yes.type = 'button';
    const no = el('button', 'ghost small', t('Keep it'));
    no.type = 'button';
    const err = el('p', 'error small');
    no.addEventListener('click', () => {
      ask.remove();
      fig.classList.remove('confirming');
      acts.hidden = false;
      del.focus();
    });
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      try {
        await api('/scrapbook/photos/delete', { method: 'POST', body: { image: p.image, confirm: true } });
        await loadScrapbook();
      } catch (e) {
        err.textContent = e.message;
        yes.disabled = no.disabled = false;
      }
    });
    const row = el('div', 'sb-confirm-row');
    row.append(no, yes);
    ask.append(msg, row, err);
    fig.classList.add('confirming');
    fig.append(ask);
    fig.scrollIntoView({ block: 'nearest' });
    no.focus();
  });
  acts.append(hide, del);
  fig.append(view, cap, acts);
  return fig;
}
// ---------- Phase 53: your story together ----------
const STORY_LABEL = {
  milestone: 'Milestone',
  decision: 'Decided together',
  promise: 'Promise',
  date: 'Date that matters',
  moment: 'Moment',
};
const STORY_EVENT = { started: 'Project started', finished: 'Project finished', 'first-commit': 'First commit', 'pull-request': 'Pull request opened', 'team-done': 'Team task finished' };
const PROMISE_STATE = { kept: 'kept ✓', open: 'still open', broken: 'not kept yet' };
const storyState = { filter: 'all', polling: null };
const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

async function openAtMessage(conversationId, messageId) {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  await openConversation(conversationId);
  const target = messageId && document.querySelector(`#messages [data-id="${messageId}"]`);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.classList.add('highlight');
    setTimeout(() => target.classList.remove('highlight'), 2500);
  }
}

async function openStoryItem(it) {
  const o = it.open;
  if (!o) return;
  if (o.type === 'conversation') return openAtMessage(o.conversationId, o.messageId);
  if (o.type === 'url') return void window.open(o.url, '_blank', 'noopener');
  $('#story').close();
  if (o.type === 'project') return openProjectPage(o.projectId);
  if (o.type === 'scrapbook') return $('#open-scrapbook').click();
  if (o.type === 'memory') return $('#open-memory').click();
  if (o.type === 'workspace') {
    const projects = (await api('/projects').catch(() => [])) ?? [];
    const p = (Array.isArray(projects) ? projects : projects.projects ?? []).find((x) => x.workspace === o.workspace);
    if (p) return openProjectPage(p.id);
    return openSettings('ab-projects');
  }
}

function storyCard(it) {
  const card = el('button', `story-item story-${it.kind}${it.status ? ` story-${it.status}` : ''}`);
  card.type = 'button';
  const head = el('div', 'story-head');
  const label = it.kind === 'project' ? t(STORY_EVENT[it.event] ?? 'Project') : t(STORY_LABEL[it.kind] ?? it.kind);
  head.append(el('span', 'kind', label), el('span', 'muted small', new Date(`${it.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
  if (it.status) head.append(el('span', `chip story-chip-${it.status}`, t(PROMISE_STATE[it.status])));
  // A date that matters is about its own day (a birthday noted in October falls in November).
  const on = /(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(it.on ?? '');
  if (on) {
    const d = new Date(`${on[1] ?? '2000'}-${on[2]}-${on[3]}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(on[1] && it.kind === 'promise' ? { year: 'numeric' } : {}) });
    head.append(el('span', 'chip', it.kind === 'promise' ? t('due {date}', { date: d }) : t('on {date}', { date: d })));
  }
  if (it.imported) head.append(el('span', 'chip', t('from your {name} history', { name: it.imported })));
  if (it.by === 'sara') head.append(el('span', 'muted small', t('added by Sara')));
  card.append(head, el('div', 'story-title', it.title));
  if (it.detail && it.kind !== 'project') card.append(el('div', 'story-detail muted small', `“${it.detail}”`));
  else if (it.detail && it.event === 'started') card.append(el('div', 'story-detail muted small', it.detail));
  if (!it.open) card.disabled = true;
  card.addEventListener('click', () => void openStoryItem(it));
  return card;
}

function lookbackCard(lb) {
  const card = el('div', 'lookback');
  const head = el('div', 'story-head');
  const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  head.append(el('strong', '', t('Look back')), el('span', 'muted small', `${fmt(lb.from)} – ${fmt(lb.to)}`));
  const del = btn('✕', async () => {
    if (!confirm(t('Delete this look back? It is also removed from her memory.'))) return;
    await api(`/story/lookback/${lb.id}`, { method: 'DELETE' });
    await loadStory();
  });
  del.classList.add('small');
  del.title = t('Delete');
  del.setAttribute('aria-label', t('Delete'));
  head.append(del);
  const body = el('div', 'lookback-text');
  for (const para of lb.text.split(/\n{2,}/)) body.append(el('p', '', para));
  card.append(head, body);
  return card;
}

async function loadStory() {
  const d = await api(`/story?filter=${storyState.filter}`);
  for (const b of document.querySelectorAll('[data-story]')) b.classList.toggle('active', b.dataset.story === storyState.filter);
  if (!$('#story-to').value) $('#story-to').value = d.today;
  if (!$('#story-from').value) {
    const from = new Date(`${d.today}T12:00:00`);
    from.setFullYear(from.getFullYear() - 1);
    $('#story-from').value = d.firstDay && d.firstDay > isoDay(from) ? d.firstDay : isoDay(from);
  }
  $('#story-lookbacks').replaceChildren(...d.lookbacks.slice(0, 3).map(lookbackCard));
  $('#story-write').disabled = d.running;
  $('#story-status').textContent = d.running ? t('She is writing your look back… you can close this window meanwhile.') : d.error ? `${t("Couldn't write the look back:")} ${d.error}` : '';
  if (d.running && !storyState.polling) storyState.polling = setInterval(() => (!$('#story').open ? (clearInterval(storyState.polling), (storyState.polling = null)) : void loadStory()), 4000);
  if (!d.running && storyState.polling) {
    clearInterval(storyState.polling);
    storyState.polling = null;
  }
  const out = [];
  let month = '';
  for (const it of [...d.items].reverse()) {
    const mo = new Date(`${it.date}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (mo !== month) {
      out.push(el('h3', 'story-month', mo));
      month = mo;
    }
    out.push(storyCard(it));
  }
  const empty = storyState.filter === 'all' ? t('Your story fills in as you talk: milestones, promises and projects show up here by themselves, and moments you pin.') : t('Nothing of this kind yet.');
  $('#story-list').replaceChildren(...(out.length ? out : [emptyState('🕰️', empty)]));
}

async function openStory() {
  storyState.filter = 'all';
  await loadStory();
  if (!$('#story').open) $('#story').showModal();
}
$('#open-story').addEventListener('click', () => void openStory());
// Phase 81: findings (every project; filters inside the window).
initFindings();
$('#open-findings').addEventListener('click', () => void openFindings());
// Phase 84: evals (other settings tried on your own past tasks; the winner with evidence).
initEvals();
$('#open-evals').addEventListener('click', () => void openEvals());
initMoments({ openAtMessage });
initHousehold({ show, boot, copyText, showSettingsTab });
for (const b of document.querySelectorAll('[data-story]')) {
  b.addEventListener('click', () => {
    storyState.filter = b.dataset.story;
    void loadStory();
  });
}
$('#story-write').addEventListener('click', async () => {
  const from = $('#story-from').value;
  const to = $('#story-to').value;
  if (!from || !to) return;
  $('#story-write').disabled = true;
  try {
    await api('/story/lookback', { method: 'POST', body: { from, to } });
  } catch (err) {
    $('#story-status').textContent = err.message;
    $('#story-write').disabled = false;
    return;
  }
  await loadStory();
});

$('#open-scrapbook').addEventListener('click', async () => {
  sbTab('moments');
  await loadScrapbook();
  $('#scrapbook').showModal();
});
$('#sb-joke-add').addEventListener('click', async () => {
  const text = $('#sb-joke').value.trim();
  if (!text) return;
  await api('/scrapbook', { method: 'POST', body: { kind: 'joke', text } });
  $('#sb-joke').value = '';
  await loadScrapbook();
});

function showXaiVoice() {
  const on = $('#v-tts').value === 'xai';
  $('#v-xai').hidden = !on;
  $('#v-xai-note').hidden = !on;
}
$('#v-tts').addEventListener('change', showXaiVoice);

// ---------- make it yours (name, personality, look) ----------
const yours = { persona: null, lookTimer: null };
for (const b of document.querySelectorAll('[data-goto-tab]')) b.addEventListener('click', () => showSettingsTab(b.dataset.gotoTab));

async function loadYours() {
  const [pe, defs] = await Promise.all([api('/persona'), studio.defs ? Promise.resolve(studio.defs) : api('/persona/studio')]);
  yours.persona = pe.persona;
  studio.defs = defs;
  $('#my-name').value = pe.persona.name;
  $('#my-pronouns').value = pe.persona.pronouns ?? 'she';
  $('#my-age').value = pe.persona.age;
  $('#look-desc').value ||= pe.persona.appearance ?? '';
  studio.draft = structuredClone(pe.persona);
  // How she was when this page opened: what Undo goes back to and what Try it compares with.
  studio.opened = structuredClone(pe.persona);
  buildStudio();
  renderStudio();
  $('#st-check').value = defs.inCharacter ?? 'off';
  loadDrift();
  $('#my-face').src = `/sara-portrait.jpg?v=${Date.now()}`;
  await refreshLook();
}

/** Her character: the studio's changes (if any) plus name, pronouns and age from the top. */
async function saveYours() {
  const p = yours.persona;
  if (!p) return;
  const name = $('#my-name').value.trim();
  const pronouns = $('#my-pronouns').value;
  const age = Number($('#my-age').value);
  const base = studio.draft && studioDirty() ? studio.draft : p;
  if (base === p && name === p.name && pronouns === (p.pronouns ?? 'she') && age === p.age) return;
  const saved = await api('/persona', { method: 'PUT', body: { ...base, name: name || base.name, pronouns, age: age || base.age } });
  yours.persona = saved.persona;
  studio.draft = structuredClone(saved.persona);
  setIdentity(saved.persona);
  if (studio.defs) renderStudio();
  $('#st-status').textContent = saved.renamedMemories ? t('Updated {renamedMemories} memories to the new name.', { renamedMemories: saved.renamedMemories }) : '';
}

$('#my-advanced').addEventListener('click', () => {
  $('#settings').close();
  openSara();
});

// ---------- Phase 34: personality studio ----------
const studio = { defs: null, draft: null, opened: null };
const TIP_EXAMPLES = (d) => `${d.tip}\n\nLow: ${d.examples[0]}\nMiddle: ${d.examples[1]}\nHigh: ${d.examples[2]}`;
function traitWordJs(d, v) {
  const b = v <= 1 ? 0 : v <= 3 ? 1 : v <= 6 ? 2 : v <= 8 ? 3 : 4;
  if (b === 2) return t('Balanced');
  const end = b < 2 ? d.low : d.high;
  const oneWord = !/\s/.test(end) && !/^very /i.test(end);
  const strong = b === 0 || b === 4;
  // M9: in the app's language (the dial ends come from the server in English).
  const word = t(end).toLocaleLowerCase(locale());
  if (oneWord) return strong ? t('Very {word}', { word }) : t('A bit {word}', { word });
  return strong ? t(end) : t('Leaning: {word}', { word });
}

/** Slider rows for the given dials; changes go to `target()` (a draft persona). */
function dialRows(box, ids, target, onChange, grouped = false) {
  const defs = studio.defs.traits.filter((d) => !ids || ids.includes(d.id));
  const groups = !ids || grouped ? [...new Set(defs.map((d) => d.group))] : [null];
  box.replaceChildren();
  for (const g of groups) {
    const wrap = el('div', 'dial-group');
    if (g) wrap.append(el('p', 'dial-group-name', t(g)));
    for (const d of defs.filter((x) => !g || x.group === g)) {
      const row = el('div', 'dial');
      const head = el('div', 'dial-head');
      const label = el('span', 'dial-label', d.label);
      const tip = el('button', 'tip', '?');
      tip.type = 'button';
      tip.dataset.tip = TIP_EXAMPLES(d);
      const word = el('span', 'dial-word muted small', '');
      head.append(label, tip, word);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '10';
      range.step = '1';
      range.dataset.dial = d.id;
      range.setAttribute('aria-label', d.label);
      const ends = el('div', 'dial-ends muted small');
      ends.append(el('span', '', d.low), el('span', '', d.high));
      const show = () => {
        const v = target().traits?.[d.id] ?? 5;
        range.value = String(v);
        word.textContent = traitWordJs(d, v);
      };
      range.addEventListener('input', () => {
        const p = target();
        p.traits = { ...p.traits, [d.id]: Number(range.value) };
        word.textContent = traitWordJs(d, Number(range.value));
        onChange?.();
      });
      row.show = show;
      row.append(head, range, ends);
      wrap.append(row);
    }
    box.append(wrap);
  }
}
const refreshDials = (box) => box.querySelectorAll('.dial').forEach((r) => r.show());

function pickCards(box, items, selected, onPick) {
  box.replaceChildren(
    ...items.map((it) => {
      const b = el('button', 'pick-card');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.id === selected));
      b.dataset.id = it.id;
      if (it.emoji) b.append(el('span', 'pick-emoji', it.emoji));
      b.append(el('strong', '', it.label));
      if (it.blurb) b.append(el('span', 'muted small', it.blurb));
      b.addEventListener('click', () => onPick(it.id));
      return b;
    }),
  );
}
const markCard = (box, id) => box.querySelectorAll('.pick-card, .chip').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === id)));

function lifeInputs(box, target, onChange) {
  box.replaceChildren(
    ...studio.defs.life.map((f) => {
      const l = el('label', '', f.label);
      const i = document.createElement('input');
      i.maxLength = 300;
      i.placeholder = f.placeholder;
      i.dataset.life = f.id;
      i.addEventListener('input', () => {
        const p = target();
        p.life = { ...p.life, [f.id]: i.value };
        if (!i.value.trim()) delete p.life[f.id];
        onChange?.();
      });
      l.append(i);
      return l;
    }),
  );
}
const refreshLife = (box, p) => box.querySelectorAll('input[data-life]').forEach((i) => (i.value = p.life?.[i.dataset.life] ?? ''));

function buildStudio() {
  buildBond();
  if ($('#st-dials').childElementCount) return;
  const d = studio.defs;
  pickCards($('#st-archetypes'), d.archetypes, studio.draft.archetype, (id) => studioApply({ archetype: id }));
  $('#st-rel').replaceChildren(...d.relationships.map((r) => new Option(r.label, r.id)));
  $('#st-talk').replaceChildren(new Option(t('Keep as it is'), ''), ...d.talk.map((r) => new Option(r.label, r.id)));
  $('#st-humour').replaceChildren(...d.humours.map((r) => new Option(r.label, r.id)));
  dialRows($('#st-dials'), d.traits.filter((t) => t.group !== 'Together' && t.group !== 'Work').map((t) => t.id), () => studio.draft, studioChanged, true);
  // Phase 51: how she is at work (coding conversations only), apart from her chat personality.
  dialRows($('#st-work-dials'), d.traits.filter((t) => t.group === 'Work').map((t) => t.id), () => studio.draft, studioChanged);
  $('#work-quiet').addEventListener('change', () => {
    if ($('#work-quiet').checked) studio.draft.quietFocus = true;
    else delete studio.draft.quietFocus;
    studioChanged();
  });
  renderGallery($('#gallery-cards'), { onUse: galleryUse });
  lifeInputs($('#st-life'), () => studio.draft, studioChanged);
  $('#st-rel').addEventListener('change', () => studioApply({ relationship: $('#st-rel').value }));
  $('#st-talk').addEventListener('change', () => $('#st-talk').value && studioApply({ talk: $('#st-talk').value }));
  $('#st-humour').addEventListener('change', () => {
    studio.draft.humour = $('#st-humour').value;
    studioChanged();
  });
}

function renderStudio() {
  const p = studio.draft;
  markCard($('#st-archetypes'), p.archetype);
  $('#st-rel').value = p.relationship ?? 'friend';
  $('#st-talk').value = p.talk ?? '';
  $('#st-humour').value = p.humour ?? 'own';
  refreshDials($('#st-dials'));
  refreshDials($('#st-work-dials'));
  $('#work-quiet').checked = p.quietFocus === true;
  refreshLife($('#st-life'), p);
  studioChanged();
  renderBond();
}

/** Not saved yet (the window saves it in a moment). */
const studioDirty = () => JSON.stringify(studio.draft) !== JSON.stringify(yours.persona);
/** Changed since this page opened (Undo goes back). */
const studioChangedSinceOpen = () => Boolean(studio.opened) && JSON.stringify(studio.draft) !== JSON.stringify(studio.opened);
function studioChanged() {
  const changed = studioChangedSinceOpen();
  $('#st-changed').textContent = changed ? t('Changed and saved. Undo goes back to how she was.') : t('No changes yet');
  $('#st-undo').disabled = !changed;
  if (studioDirty()) markDirty($('#settings'));
}

async function studioCall(path, body, busyText) {
  $('#st-status').textContent = busyText ?? '';
  try {
    const r = await api(`/persona/studio/${path}`, { method: 'POST', body });
    return r;
  } catch (err) {
    $('#st-status').textContent = err.message;
    return null;
  }
}
async function studioApply(change) {
  const r = await studioCall('apply', { persona: studio.draft, ...change });
  if (!r) return;
  studio.draft = r.persona;
  renderStudio();
  if (change.archetype) $('#st-status').textContent = t('Starting point applied: her dials, humour and way of talking changed. Her name, age and life stay.');
}
$('#st-unique').addEventListener('click', async () => {
  const r = await studioCall('unique', { persona: studio.draft });
  if (!r) return;
  studio.draft = r.persona;
  renderStudio();
  $('#st-status').textContent = t('Added details of her own and nudged a few dials. Try it to hear her; Undo goes back.');
});
$('#st-surprise').addEventListener('click', async () => {
  if (!confirm(t('Replace her with a surprise character? Undo brings her back.'))) return;
  const r = await studioCall('surprise', { pronouns: $('#my-pronouns').value });
  if (!r) return;
  studio.draft = r.persona;
  renderStudio();
  $('#st-status').textContent = `${t('Meet')} ${r.persona.name}, ${r.persona.age}. ${t('Try it, change anything, or Undo to go back.')}`;
});
$('#st-fill').addEventListener('click', async () => {
  $('#st-fill').disabled = true;
  const r = await studioCall('fill', { persona: studio.draft, write: true }, t('Writing the rest of her life… (up to a minute)'));
  $('#st-fill').disabled = false;
  if (!r) return;
  studio.draft = r.persona;
  renderStudio();
  $('#st-status').textContent = r.written ? t('Filled in to fit her. Change anything you like.') : t("Couldn't reach the background model, so these are ready-made details. Change anything you like.");
});
$('#st-undo').addEventListener('click', () => {
  studio.draft = structuredClone(studio.opened ?? yours.persona);
  // Name, pronouns and age come back too (e.g. after starting from a gallery character).
  $('#my-name').value = studio.draft.name;
  $('#my-pronouns').value = studio.draft.pronouns ?? 'she';
  $('#my-age').value = studio.draft.age;
  $('#st-work-samples').hidden = true;
  $('#st-samples').hidden = true;
  $('#bd-samples').hidden = true;
  renderStudio();
  $('#st-status').textContent = '';
});

function renderSamples(box, samples, name) {
  box.replaceChildren(
    ...samples.map((s) => {
      const card = el('div', 'sample');
      card.append(el('p', 'sample-q', `${s.label}: “${s.text}”`));
      const row = el('div', s.before ? 'sample-pair' : 'sample-one');
      if (s.before) {
        const b = el('div', 'sample-reply old');
        b.append(el('span', 'muted small', t('Before')), el('p', '', s.before));
        row.append(b);
      }
      const n = el('div', 'sample-reply new');
      n.append(el('span', 'muted small', s.before ? t('With your changes') : name), el('p', '', s.after));
      row.append(n);
      card.append(row);
      return card;
    }),
  );
  box.hidden = false;
}
$('#st-try').addEventListener('click', async () => {
  $('#st-try').disabled = true;
  const r = await studioCall('try', { persona: studio.draft, before: studio.opened }, t('Asking her… (a few seconds per answer)'));
  $('#st-try').disabled = false;
  if (!r) return;
  renderSamples($('#st-samples'), r.samples, studio.draft.name);
  $('#st-status').textContent = studioChangedSinceOpen() ? t('Not what you wanted? Undo goes back.') : '';
});
$('#st-work-try').addEventListener('click', async () => {
  $('#st-work-try').disabled = true;
  const r = await studioCall('try', { persona: studio.draft, before: studio.opened, set: 'work' }, t('Asking her… (a few seconds per answer)'));
  $('#st-work-try').disabled = false;
  if (!r) return;
  renderSamples($('#st-work-samples'), r.samples, studio.draft.name);
  $('#st-status').textContent = '';
});

// ---------- Phase 51: start from a character (the gallery) ----------
const gal = { list: null };
async function galleryList() {
  if (!gal.list) gal.list = (await api('/gallery')).characters;
  return gal.list;
}
const IMPORTED_NAMES = { chatgpt: 'ChatGPT', claude: 'Claude' };
const PRONOUN_WORDS = { she: 'she/her', he: 'he/him', they: 'they/them' };
/** Cards for the gallery characters. opts.onUse(entry) for "Use this"; opts.pick(id) selects instead (setup). */
async function renderGallery(box, opts) {
  let list;
  try {
    list = await galleryList();
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
    return;
  }
  box.replaceChildren(
    ...list.map((g) => {
      const card = el('div', 'gallery-card');
      card.dataset.id = g.id;
      // H4: the character's own name and pronouns, never rewritten for the current companion.
      const head = el('div', 'gallery-head');
      head.dataset.raw = '';
      head.append(el('strong', '', g.name), el('span', 'muted small', `${translateOnly(PRONOUN_WORDS[g.pronouns] ?? g.pronouns)} · ${g.age}`));
      const tags = el('div', 'gallery-tags');
      tags.dataset.raw = '';
      tags.append(...g.tags.map((x) => el('span', 'gallery-tag', translateOnly(x))));
      const line = el('p', 'gallery-line small');
      line.dataset.raw = '';
      line.hidden = true;
      const tryBtn = el('button', 'ghost small', t('Try a line'));
      tryBtn.type = 'button';
      tryBtn.addEventListener('click', async () => {
        tryBtn.disabled = true;
        line.hidden = false;
        line.textContent = t('Asking… (a few seconds)');
        try {
          const r = await api(`/gallery/${encodeURIComponent(g.id)}/try`, { method: 'POST', body: {} });
          line.textContent = `“${r.line}”`;
        } catch (err) {
          line.textContent = err.message;
        } finally {
          tryBtn.disabled = false;
        }
      });
      const use = el('button', 'small', opts.pick ? t('Pick') : t('Use this'));
      use.type = 'button';
      use.addEventListener('click', () => (opts.pick ? opts.pick(g.id, box) : opts.onUse(g)));
      const actions = el('div', 'gallery-actions');
      actions.append(tryBtn, use);
      const pitch = el('p', 'gallery-pitch', translateOnly(g.pitch));
      pitch.dataset.raw = '';
      card.append(head, pitch, tags, line, actions);
      return card;
    }),
  );
}
async function galleryUse(g) {
  if (!confirm(`${t('Start from')} ${g.name}? ${t('Her name, personality and dials change to theirs; her look, voice and memories stay. Undo changes brings her back.')}`)) return;
  const prev = structuredClone(yours.persona);
  $('#gallery-status').textContent = t('Loading…');
  try {
    const r = await api('/character/import', { method: 'POST', body: { file: g.file, look: false, voice: false } });
    await loadYours();
    // Undo changes goes back to who she was before.
    studio.opened = prev;
    studioChanged();
    setIdentity(r.persona);
    setChatTitle();
    refreshSaraStatus();
    $('#gallery-status').textContent = `${t('Now')} ${r.persona.name}. ${t('Change anything below, or Undo changes to go back.')} ${t('Her picture stays; Make a new look below changes it.')}`;
  } catch (err) {
    $('#gallery-status').textContent = err.message;
  }
}
// UX 6: the one Import button for both kinds of file lives in cards.js (Sara files go to #char-file).
// L12: a ready-made character keeps her current picture; a new look is one click away.
$('#gallery-look').addEventListener('click', () => showSettingsTab('her-look', { focus: true }));
// Phase 57: character cards (import with a preview first, export as a card) and Settings → Other apps.
initCards({
  onImported: async (r) => {
    if (r.companion) return void (await renderCompanionsPage().catch(() => {}));
    await loadYours();
    setIdentity(r.persona);
    setChatTitle();
    refreshSaraStatus();
  },
  picture: () => state.customAvatar ?? '/sara-portrait.jpg',
  name: () => yours.persona?.name ?? 'character',
});
initOtherApps({ copyText, confirmProof });
// Phase 100: Settings → Connections → Other agents (A2A).
initAgents({
  copyText,
  openConversation: (id) => {
    if ($('#settings').open) $('#settings').close();
    void openConversation(id);
  },
});
// Phase 102: Settings → Connections → Webhooks.
initHooks({
  copyText,
  openConversation: (id) => {
    if ($('#settings').open) $('#settings').close();
    void openConversation(id);
  },
  openCard: (ref) => {
    if ($('#settings').open) $('#settings').close();
    void openCardOnBoard(0, ref);
  },
});
initAlexa({ copyText });
initSsh();
initPresence();
initLocalModels({ openSettings: (page) => void openSettings(page) });
initImport();

$('#st-check').addEventListener('change', async () => {
  await api('/persona/studio/check', { method: 'PUT', body: { inCharacter: $('#st-check').value } }).catch((err) => ($('#st-status').textContent = err.message));
  loadDrift();
});
async function loadDrift() {
  const d = await api('/persona/studio/drift').catch(() => null);
  if (!d) return;
  const w = d.week;
  $('#st-drift').textContent = d.mode === 'off' ? t('Off.') : w.checks ? `${t('This week')}: ${w.average}/10 ${t('over')} ${w.checks} ${t('checked replies')}; ${w.drifted} ${t('drifted and got a nudge.')}` : t('No replies checked yet this week.');
}

// ---------- Phase 35: Relationship (you and her) ----------
function buildBond() {
  if ($('#bd-dials').childElementCount) return;
  const d = studio.defs;
  pickCards($('#bd-types'), d.relationshipTypes, studio.draft.relationship ?? 'friend', (id) => bondApply({ relationship: id }));
  dialRows($('#bd-dials'), d.traits.filter((t) => t.group === 'Together').map((t) => t.id), () => studio.draft, bondChanged);
  $('#bd-away').replaceChildren(new Option(t('Her own way'), ''), ...d.away.map((x) => new Option(x.label, x.id)));
  $('#bd-conflict').replaceChildren(new Option(t('Her own way'), ''), ...d.conflict.map((x) => new Option(x.label, x.id)));
  $('#bd-others').replaceChildren(new Option(t('Not mentioned'), ''), ...d.others.map((x) => new Option(x.label, x.id)));
  // Her initiative in intimate moments: one slider like the dials.
  const row = el('div', 'dial');
  const head = el('div', 'dial-head');
  const word = el('span', 'dial-word muted small', '');
  head.append(el('span', 'dial-label', t('Who makes the first move')), word);
  const range = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '10', step: '1' });
  range.setAttribute('aria-label', t('Who makes the first move'));
  const ends = el('div', 'dial-ends muted small');
  ends.append(el('span', '', t('Waits for you')), el('span', '', t('Makes the first move')));
  const initWord = (v) => (v <= 3 ? t('Waits for you') : v >= 7 ? t('Makes the first move') : t('Balanced'));
  row.show = () => {
    const v = studio.draft.intimacy?.initiative ?? 5;
    range.value = String(v);
    word.textContent = initWord(v);
  };
  range.addEventListener('input', () => {
    studio.draft.intimacy = { ...studio.draft.intimacy, initiative: Number(range.value) };
    word.textContent = initWord(Number(range.value));
    bondChanged();
  });
  row.append(head, range, ends);
  const group = el('div', 'dial-group');
  group.append(row);
  $('#bd-init').append(group);
  const field = (id, key, where = 'intimacy') =>
    $(id).addEventListener('input', () => {
      const v = $(id).value;
      if (where === 'intimacy') {
        studio.draft.intimacy = { ...studio.draft.intimacy, [key]: v };
        if (!v.trim()) delete studio.draft.intimacy[key];
      } else if (v.trim()) studio.draft[key] = v;
      else delete studio.draft[key];
      bondChanged();
    });
  field('#bd-likes', 'likes');
  field('#bd-limits', 'limits');
  field('#bd-turnoffs', 'turnoffs');
  field('#bd-yours', 'yourLimits');
  field('#bd-stop', 'stopWord');
  field('#bd-note', 'relationshipNote', 'persona');
  for (const [id, key] of [['#bd-away', 'away'], ['#bd-conflict', 'conflict'], ['#bd-others', 'others']])
    $(id).addEventListener('change', () => {
      if ($(id).value) studio.draft[key] = $(id).value;
      else delete studio.draft[key];
      bondChanged();
    });
  $('#bd-slow').addEventListener('change', () => {
    if ($('#bd-slow').checked) studio.draft.slowBurn = true;
    else delete studio.draft.slowBurn;
    bondChanged();
  });
  $('#bd-level').addEventListener('change', () => {
    const v = $('#bd-level').value;
    studio.draft.intimacy = { ...studio.draft.intimacy, level: v };
    if (!v) delete studio.draft.intimacy.level;
    bondChanged();
    showIntimacyMore();
  });
}
const showIntimacyMore = () => ($('#bd-int-more').hidden = !studio.draft.intimacy?.level || studio.draft.intimacy.level === 'none');

function renderBond() {
  if (!studio.defs || !$('#bd-dials').childElementCount) return;
  const p = studio.draft;
  const d = studio.defs;
  markCard($('#bd-types'), p.relationship ?? 'friend');
  refreshDials($('#bd-dials'));
  $('#bd-init').querySelectorAll('.dial').forEach((r) => r.show());
  $('#bd-note').value = p.relationshipNote ?? '';
  $('#bd-away').value = p.away ?? '';
  $('#bd-conflict').value = p.conflict ?? '';
  $('#bd-others').value = p.others ?? '';
  $('#bd-others-row').hidden = !d.otherCompanions?.length && !p.others;
  $('#bd-slow').checked = Boolean(p.slowBurn);
  // Levels this device may choose; a level chosen elsewhere is shown, not offered.
  const opts = [new Option(t('Her own way'), ''), ...d.intimacy.map((l) => new Option(l.label, l.id))];
  const cur = p.intimacy?.level ?? '';
  if (cur && !d.intimacy.some((l) => l.id === cur)) {
    const o = new Option(t('Set in a web browser'), cur);
    o.disabled = true;
    opts.push(o);
  }
  $('#bd-level').replaceChildren(...opts);
  $('#bd-level').value = cur;
  $('#bd-likes').value = p.intimacy?.likes ?? '';
  $('#bd-limits').value = p.intimacy?.limits ?? '';
  $('#bd-turnoffs').value = p.intimacy?.turnoffs ?? '';
  $('#bd-yours').value = p.intimacy?.yourLimits ?? '';
  $('#bd-stop').value = p.intimacy?.stopWord ?? '';
  showIntimacyMore();
  bondChanged();
}
function bondChanged() {
  studioChanged();
  $('#bd-changed').textContent = $('#st-changed').textContent;
  $('#bd-undo').disabled = !studioChangedSinceOpen();
}
async function bondApply(change) {
  const r = await api('/persona/studio/apply', { method: 'POST', body: { persona: studio.draft, ...change } }).catch((err) => ($('#bd-status').textContent = err.message) && null);
  if (!r) return;
  studio.draft = r.persona;
  renderStudio();
}
$('#bd-undo').addEventListener('click', () => $('#st-undo').click());
$('#bd-try').addEventListener('click', async () => {
  $('#bd-try').disabled = true;
  $('#bd-status').textContent = t('Asking her… (a few seconds per answer)');
  try {
    const r = await api('/persona/studio/try', { method: 'POST', body: { persona: studio.draft, before: studio.opened, set: 'bond' } });
    renderSamples($('#bd-samples'), r.samples, studio.draft.name);
    $('#bd-status').textContent = studioChangedSinceOpen() ? t('Not what you wanted? Undo goes back.') : '';
  } catch (err) {
    $('#bd-status').textContent = err.message;
  } finally {
    $('#bd-try').disabled = false;
  }
});

// ---------- Phase 34: "Create your companion" (guided) ----------
const wz = { step: 1, draft: null, steps: 8, voices: [], voiceKind: '' };
async function openWizard() {
  if (!studio.defs) studio.defs = await api('/persona/studio');
  const pe = await api('/persona');
  wz.draft = structuredClone(studioDirty() ? studio.draft : pe.persona);
  wz.step = 1;
  const d = studio.defs;
  pickCards($('#wz-archetypes'), d.archetypes, wz.draft.archetype, (id) => wzApply({ archetype: id }));
  dialRows($('#wz-dials'), ['warmth', 'playful', 'teasing', 'blunt', 'fiery', 'affection'], () => wz.draft);
  pickCards($('#wz-talk'), d.talk.map((x) => ({ ...x, blurb: { texting: t('Relaxed, like texting someone close'), thoughtful: t('Fuller, warm sentences'), brief: t('A line or two, no filler') }[x.id] })), wz.draft.talk, (id) => wzApply({ talk: id }));
  dialRows($('#wz-talk-dials'), ['casual', 'talkative'], () => wz.draft);
  $('#wz-humour').replaceChildren(
    ...d.humours.map((h) => {
      const b = el('button', 'chip', h.label);
      b.type = 'button';
      b.dataset.id = h.id;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        wz.draft.humour = h.id;
        markCard($('#wz-humour'), h.id);
      });
      return b;
    }),
  );
  lifeInputs($('#wz-life'), () => wz.draft);
  // Only the main details in the guide; the rest are in Settings (or filled in).
  for (const l of $('#wz-life').querySelectorAll('label')) l.hidden = !['job', 'hometown', 'hobbies', 'family', 'likes'].includes(l.querySelector('input').dataset.life);
  pickCards($('#wz-rel'), d.relationshipTypes.filter((x) => x.id !== 'custom'), wz.draft.relationship ?? 'friend', (id) => wzApply({ relationship: id }));
  dialRows($('#wz-bond-dials'), ['romance', 'jealousy', 'independence'], () => wz.draft);
  await wzVoice();
  wzRender();
  $('#wizard').showModal();
}
$('#st-wizard').addEventListener('click', openWizard);

function wzRender() {
  const p = wz.draft;
  $('#wz-name').value = p.name;
  $('#wz-pronouns').value = p.pronouns ?? 'she';
  $('#wz-age').value = p.age;
  markCard($('#wz-archetypes'), p.archetype);
  markCard($('#wz-talk'), p.talk);
  markCard($('#wz-humour'), p.humour ?? 'own');
  markCard($('#wz-rel'), p.relationship ?? 'friend');
  refreshDials($('#wz-dials'));
  refreshDials($('#wz-talk-dials'));
  refreshDials($('#wz-bond-dials'));
  refreshLife($('#wz-life'), p);
  $('#wz-look').value = p.appearance ?? '';
  $('#wz-meet-name').textContent = p.name;
  for (const s of document.querySelectorAll('#wizard [data-wz]')) s.hidden = Number(s.dataset.wz) !== wz.step;
  $('#wz-step').textContent = `${t('Step')} ${wz.step} ${t('of')} ${wz.steps}`;
  $('#wz-back').hidden = wz.step === 1;
  $('#wz-skip').hidden = wz.step === wz.steps;
  $('#wz-next').textContent = wz.step === wz.steps ? `${t('Save')} ${p.name}` : t('Next');
  $('#wz-error').textContent = '';
}
function wzTakeInputs() {
  const p = wz.draft;
  p.name = $('#wz-name').value.trim() || p.name;
  p.pronouns = $('#wz-pronouns').value;
  p.age = Number($('#wz-age').value) || p.age;
  const look = $('#wz-look').value.trim();
  if (look) p.appearance = look;
  else delete p.appearance;
}
async function wzApply(change) {
  wzTakeInputs();
  try {
    wz.draft = (await api('/persona/studio/apply', { method: 'POST', body: { persona: wz.draft, ...change } })).persona;
  } catch (err) {
    $('#wz-error').textContent = err.message;
  }
  wzRender();
}
$('#wz-surprise').addEventListener('click', async () => {
  try {
    wz.draft = (await api('/persona/studio/surprise', { method: 'POST', body: { pronouns: $('#wz-pronouns').value, relationship: wz.draft.relationship } })).persona;
    wz.step = wz.steps;
    wzRender();
    wzMeet();
  } catch (err) {
    $('#wz-error').textContent = err.message;
  }
});
$('#wz-fill').addEventListener('click', async () => {
  wzTakeInputs();
  $('#wz-life-status').textContent = t('Writing the rest of her life… (up to a minute)');
  try {
    const r = await api('/persona/studio/fill', { method: 'POST', body: { persona: wz.draft, write: true } });
    wz.draft = r.persona;
    $('#wz-life-status').textContent = t('Filled in. The rest of her details are in Settings later.');
  } catch (err) {
    $('#wz-life-status').textContent = err.message;
  }
  wzRender();
});
$('#wz-unique').addEventListener('click', async () => {
  wzTakeInputs();
  try {
    wz.draft = (await api('/persona/studio/unique', { method: 'POST', body: { persona: wz.draft } })).persona;
    $('#wz-life-status').textContent = t('Added details of her own and nudged a few dials.');
  } catch (err) {
    $('#wz-life-status').textContent = err.message;
  }
  wzRender();
});

async function wzVoice() {
  const v = await api('/voice').catch(() => null);
  wz.voiceKind = '';
  $('#wz-voice-row').hidden = true;
  if (!v) return;
  const tts = v.settings.tts;
  const names = { off: 'off', local: 'the on-server voice', openai: 'a speech API voice', elevenlabs: 'ElevenLabs', xai: 'Grok voice' };
  $('#wz-voice-now').textContent = tts === 'off' ? t('Her voice is off. You can turn it on in Settings → Voice.') : `${t('She speaks with')} ${t(names[tts] ?? tts)}.`;
  let list = [];
  if (tts === 'local') list = v.voices.map((x) => ({ id: x.id, label: x.label }));
  if (tts === 'xai') list = ((await api('/voice/xai-voices').catch(() => ({ voices: [] }))).voices ?? []).map((x) => ({ id: x.id ?? x.voice_id ?? x, label: x.name ?? x.id ?? String(x) }));
  if (list.length) {
    wz.voiceKind = tts;
    $('#wz-voice').replaceChildren(...list.map((x) => new Option(x.label, x.id)));
    $('#wz-voice').value = tts === 'local' ? v.settings.localVoice : v.settings.xai?.voiceId;
    wz.voiceStart = $('#wz-voice').value;
    $('#wz-voice-row').hidden = false;
  }
  $('#wz-voice-note').textContent = tts === 'off' ? '' : t('Press Listen to hear her. More voice choices are in Settings → Voice.');
}
$('#wz-listen').addEventListener('click', async () => {
  const name = $('#wz-name').value.trim() || wz.draft.name;
  const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t("Hi, I'm {name}. This is how I'd sound.", { name }), voice: $('#wz-voice').value }) });
  if (!res.ok) return void ($('#wz-voice-note').textContent = serverText(await res.json().catch(() => ({})), t("Couldn't play that voice.")));
  const audio = new Audio(URL.createObjectURL(await res.blob()));
  audio.play().catch(() => {});
});

async function wzMeet() {
  $('#wz-samples').replaceChildren();
  $('#wz-status').textContent = t('Asking her… (a few seconds per answer)');
  try {
    const r = await api('/persona/studio/try', { method: 'POST', body: { persona: wz.draft } });
    renderSamples($('#wz-samples'), r.samples.map((s) => ({ ...s, before: undefined })), wz.draft.name);
    $('#wz-status').textContent = '';
  } catch (err) {
    $('#wz-status').textContent = err.message;
  }
}

async function wzSave() {
  wzTakeInputs();
  try {
    const saved = await api('/persona', { method: 'PUT', body: wz.draft });
    if (wz.voiceKind && $('#wz-voice').value && $('#wz-voice').value !== wz.voiceStart) {
      const body = wz.voiceKind === 'local' ? { localVoice: $('#wz-voice').value } : { xai: { voiceId: $('#wz-voice').value } };
      await api('/voice', { method: 'PUT', body }).catch(() => {});
    }
    yours.persona = saved.persona;
    studio.draft = structuredClone(saved.persona);
    studio.opened = structuredClone(saved.persona);
    setIdentity(saved.persona);
    $('#wizard').close();
    if ($('#settings').open) await loadYours();
    $('#st-status').textContent = `${t('Saved')}. ${saved.persona.name} ${t('is ready.')}`;
  } catch (err) {
    $('#wz-error').textContent = err.message;
  }
}
$('#wz-next').addEventListener('click', async () => {
  wzTakeInputs();
  if (wz.step === 1 && (!wz.draft.name || !(wz.draft.age >= 18))) return void ($('#wz-error').textContent = t('She needs a name, and must be 18 or older.'));
  if (wz.step === wz.steps) return wzSave();
  wz.step++;
  wzRender();
  if (wz.step === wz.steps) wzMeet();
});
$('#wz-skip').addEventListener('click', () => {
  wzTakeInputs();
  wz.step++;
  wzRender();
  if (wz.step === wz.steps) wzMeet();
});
$('#wz-back').addEventListener('click', () => {
  wzTakeInputs();
  wz.step = Math.max(1, wz.step - 1);
  wzRender();
});

// Look
async function refreshLook() {
  const l = await api('/look');
  $('#look-reset').hidden = !l.custom;
  // Looks made before newer animation frames existed: offer to add just those.
  $('#look-complete').hidden = !l.custom || !l.missing || l.status.state === 'building';
  $('#look-complete').title = t('New pictures for smoother talking: {n}', { n: l.missing });
  $('#look-upload-row').hidden = !l.uploaded || l.status.state === 'building';
  const st = l.status;
  const busy = st.state === 'drafting' || st.state === 'building';
  $('#look-draft').disabled = busy;
  $('#look-use').disabled = busy;
  $('#look-from-upload').disabled = busy;
  if (st.state === 'drafting') $('#look-status').textContent = t('Painting… (about 10 seconds)');
  else if (st.state === 'building') $('#look-status').textContent = t('Making expressions and animation: {step} of {total} pictures…', { step: st.step, total: st.total });
  else if (st.state === 'failed') $('#look-status').textContent = st.error ?? t('Something went wrong.');
  else if (st.state === 'done') $('#look-status').textContent = t('New look ready.');
  else if (l.hasDraft) $('#look-status').textContent = t('Here is a first picture. Use it, or try again for a different one.');
  else $('#look-status').textContent = l.custom ? t('Using your custom look.') : t('Using the default look.');
  if (l.hasDraft && st.state !== 'building') {
    $('#look-draft-img').src = `/api/look/draft.jpg?v=${Date.now()}`;
    $('#look-draft-box').hidden = false;
  } else if (!l.hasDraft) $('#look-draft-box').hidden = true;
  clearTimeout(yours.lookTimer);
  if (busy) yours.lookTimer = setTimeout(refreshLook, 2000);
  // Also when the page only sees it finished (it was closed or busy while the pictures were made).
  if (st.state === 'done' && yours.lastLookState !== 'done') lookChanged();
  yours.lastLookState = st.state;
  $('#look-fix-row').hidden = $('#look-complete').hidden && $('#look-reset').hidden;
  renderLookExtras(l);
}

// Phase 21: outfits and saved looks. Phase 36: places, one change at a time, face lock, the closet
// with scenarios, and dressing automatically.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function renderLookExtras(l) {
  yours.look = l;
  const sel = $('#look-outfit');
  if (!sel.options.length) {
    for (const o of l.outfits ?? []) sel.append(new Option(o.label, o.id));
    sel.append(new Option(t('Something else…'), 'own'));
    for (const p of l.places ?? []) $('#look-place').append(new Option(p.label, p.id));
    for (const p of l.parts ?? []) $('#look-part').append(new Option(p.label, p.id));
    fillPartValues();
  }
  const busy = l.status.state === 'drafting' || l.status.state === 'building';
  for (const id of ['#look-outfit-go', '#look-tweak-go']) $(id).disabled = busy;
  $('#look-face-lock').checked = l.faceLock;
  $('#look-save-row').hidden = !l.custom || busy;
  const cur = (l.saved ?? []).find((x) => x.id === l.current);
  $('#look-save').textContent = cur ? t('Rename') : t('Save this look');
  if (cur && document.activeElement !== $('#look-save-name')) $('#look-save-name').value = cur.name;
  $('#look-saved-none').hidden = Boolean(l.saved?.length);
  const scen = new Map((l.scenarios ?? []).map((s) => [s.id, s]));
  $('#look-saved').replaceChildren(
    ...(l.saved ?? []).map((x, n) => {
      const card = el('div', `look-card${x.id === l.current ? ' current' : ''}`);
      const img = document.createElement('img');
      img.src = `/api/look/saved/${x.id}.jpg`;
      img.alt = x.name;
      img.loading = 'lazy';
      img.className = 'zoomable';
      img.title = t('See it large');
      img.addEventListener('click', () => openLightbox(closetPictures(l), n));
      const name = el('span', 'look-name', x.name);
      const chips = el('div', 'look-chips');
      for (const id of x.scenarios ?? []) {
        const s = scen.get(id);
        if (s) chips.append(el('span', 'chip', `${s.emoji} ${s.label}`));
      }
      if (x.adult) chips.append(el('span', 'chip adult', '18+'));
      const row = el('div', 'look-card-actions');
      if (x.id === l.current) row.append(el('span', 'muted small', t('Wearing now')));
      else {
        const use = el('button', 'small', t('Wear'));
        use.type = 'button';
        use.disabled = busy;
        use.addEventListener('click', async () => {
          try {
            await api(`/look/saved/${x.id}/use`, { method: 'POST', body: {} });
            lookChanged();
          } catch (err) {
            $('#look-status').textContent = err.message;
          }
          refreshLook();
        });
        row.append(use);
      }
      const tag = el('button', 'ghost small', t('For…'));
      tag.type = 'button';
      tag.title = t('Which scenarios this look is for');
      tag.addEventListener('click', () => editLookScenarios(card, x, l));
      const del = el('button', 'look-del', '✕');
      del.type = 'button';
      del.title = t('Delete this saved look');
      del.setAttribute('aria-label', t(`Delete the saved look "${x.name}"`));
      del.addEventListener('click', async () => {
        if (!confirm(t(`Delete the saved look "${x.name}"?`))) return;
        await api(`/look/saved/${x.id}`, { method: 'DELETE' }).catch((err) => ($('#look-status').textContent = err.message));
        refreshLook();
      });
      row.append(tag);
      card.append(img, del, name, chips, row);
      return card;
    }),
  );
  renderWardrobe(l);
}

/** The pictures for the large view: her current look's expressions, then every closet look. */
function closetPictures(l) {
  return (l.saved ?? []).map((x) => ({ src: `/api/look/saved/${x.id}.jpg`, label: x.name }));
}
const EXPRESSION_LABELS = { default: 'Usual', happy: 'Happy', caring: 'Caring', sleepy: 'Sleepy', hurt: 'Hurt', playful: 'Playful' };
async function herPictures() {
  const v = state.lookVersion ? `?v=${state.lookVersion}` : '';
  const list = state.customAvatar
    ? [{ src: state.customAvatar, label: t('Her picture') }]
    : Object.entries(EXPRESSION_LABELS).map(([x, label]) => ({ src: `${x === 'default' ? '/sara-portrait.jpg' : `/sara/portrait-${x}.jpg`}${v}`, label: t(label) }));
  const l = await api('/look').catch(() => null);
  const cur = l?.saved?.find((x) => x.id === l.current);
  return [...list, ...(l?.saved ?? []).filter((x) => x.id !== cur?.id).map((x) => ({ src: `/api/look/saved/${x.id}.jpg`, label: x.name }))];
}
async function openHerPictures() {
  const list = await herPictures();
  const x = state.expression && state.expression !== 'default' ? Object.keys(EXPRESSION_LABELS).indexOf(state.expression) : 0;
  openLightbox(list, Math.max(0, x));
}

function editLookScenarios(card, x, l) {
  card.querySelector('.look-edit')?.remove();
  const box = el('div', 'look-edit');
  const picks = el('div', 'day-picks');
  for (const s of l.scenarios ?? []) {
    const lab = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value: s.id, checked: (x.scenarios ?? []).includes(s.id) });
    lab.title = s.when;
    lab.append(cb, ` ${s.emoji} ${s.label}`);
    picks.append(lab);
  }
  const wear = Object.assign(document.createElement('input'), { maxLength: 300, value: x.wear ?? '', placeholder: t('What she wears in it (she knows)') });
  const ok = el('button', 'small', t('Done'));
  ok.type = 'button';
  ok.addEventListener('click', async () => {
    const scenarios = [...picks.querySelectorAll('input:checked')].map((c) => c.value);
    try {
      await api(`/look/saved/${x.id}/meta`, { method: 'PUT', body: { scenarios, wear: wear.value } });
      $('#look-status').textContent = t('Saved.');
    } catch (err) {
      $('#look-status').textContent = err.message;
    }
    refreshLook();
  });
  box.append(el('div', 'muted small', t('Wear this look for:')), picks, wear, ok);
  card.append(box);
}

function fillPartValues() {
  const part = (yours.look?.parts ?? []).find((p) => p.id === $('#look-part').value);
  const labels = { illustrated: 'Illustrated', photo: 'Photo-realistic', anime: 'Anime', '3d': '3D animated' };
  $('#look-part-value').replaceChildren(...(part?.options ?? []).map((o) => new Option(part.id === 'style' ? (labels[o] ?? o) : o, o)), new Option(t('Something else…'), 'own'));
  $('#look-part-own-row').hidden = $('#look-part-value').value !== 'own';
}
$('#look-part').addEventListener('change', fillPartValues);
$('#look-part-value').addEventListener('change', () => ($('#look-part-own-row').hidden = $('#look-part-value').value !== 'own'));
$('#look-tweak-go').addEventListener('click', async () => {
  const own = $('#look-part-value').value === 'own';
  const value = own ? $('#look-part-own').value.trim() : $('#look-part-value').value;
  if (!value) return ($('#look-status').textContent = t('Say how to change it first.'));
  try {
    await api('/look/tweak', { method: 'POST', body: { part: $('#look-part').value, value } });
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  refreshLook();
});
$('#look-face-lock').addEventListener('change', async () => {
  await api('/look/face-lock', { method: 'PUT', body: { on: $('#look-face-lock').checked } }).catch((err) => ($('#look-status').textContent = err.message));
  $('#look-status').textContent = t('Saved.');
});

// Dress automatically.
function renderWardrobe(l) {
  const w = l.wardrobe;
  if (!w) return;
  const scen = new Map((l.scenarios ?? []).map((s) => [s.id, s]));
  $('#wd-auto').checked = w.auto;
  if (document.activeElement !== $('#wd-start')) $('#wd-start').value = w.workStart;
  if (document.activeElement !== $('#wd-end')) $('#wd-end').value = w.workEnd;
  if (!$('#wd-days').childElementCount)
    $('#wd-days').append(
      ...DAY_NAMES.map((d, i) => {
        const lab = document.createElement('label');
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value: String(i) });
        cb.addEventListener('change', () => saveWardrobe({ workDays: [...$('#wd-days').querySelectorAll('input:checked')].map((c) => Number(c.value)) }));
        lab.append(cb, ` ${t(d)}`);
        return lab;
      }),
    );
  for (const cb of $('#wd-days').querySelectorAll('input')) cb.checked = w.workDays.includes(Number(cb.value));
  const now = l.active?.[0] ? scen.get(l.active[0]) : null;
  const tagged = (l.saved ?? []).some((x) => x.scenarios?.length);
  $('#wd-now').textContent = !tagged
    ? t('Tag closet looks with scenarios (For…) so she knows what to wear when.')
    : `${t('Right now')}: ${now ? `${now.emoji} ${now.label}` : t('At home')}${w.manual ? ` (${t('picked, until')} ${new Date(w.manual.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}${l.pick ? ` → ${l.pick.name}` : ` → ${t('no look tagged for it; she keeps what she has on')}`}.`;
  const pick = $('#wd-pick');
  const keep = pick.value;
  pick.replaceChildren(...(l.scenarios ?? []).map((s) => new Option(`${s.emoji} ${s.label}`, s.id)));
  if (keep) pick.value = keep;
  $('#wd-pick-clear').hidden = !w.manual;
  $('#wd-own').replaceChildren(
    ...w.custom.map((c, i) => {
      const row = el('div', 'wd-own-row');
      row.append(el('span', '', `⭐ ${c.label}${c.from ? ` (${c.from} – ${c.to})` : ''}`));
      const del = el('button', 'ghost small', '✕');
      del.type = 'button';
      del.title = t('Remove');
      del.addEventListener('click', () => saveWardrobe({ custom: w.custom.filter((_, n) => n !== i) }));
      row.append(del);
      return row;
    }),
  );
}
async function saveWardrobe(patch) {
  try {
    const l = await api('/look/wardrobe', { method: 'PUT', body: patch });
    $('#wd-status').textContent = t('Saved.');
    renderLookExtras(l);
    if (l.current !== yours.look?.current) lookChanged();
  } catch (err) {
    $('#wd-status').textContent = err.message;
  }
}
$('#wd-auto').addEventListener('change', () => saveWardrobe({ auto: $('#wd-auto').checked }));
$('#wd-start').addEventListener('change', () => saveWardrobe({ workStart: $('#wd-start').value }));
$('#wd-end').addEventListener('change', () => saveWardrobe({ workEnd: $('#wd-end').value }));
$('#wd-own-add').addEventListener('click', () => {
  const label = $('#wd-own-name').value.trim();
  if (!label) return ($('#wd-status').textContent = t('Give it a name first.'));
  const from = $('#wd-own-from').value.trim();
  const to = $('#wd-own-to').value.trim();
  saveWardrobe({ custom: [...(yours.look?.wardrobe?.custom ?? []), { label, ...(from || to ? { from, to } : {}) }] }).then(() => {
    for (const id of ['#wd-own-name', '#wd-own-from', '#wd-own-to']) $(id).value = '';
  });
});
$('#wd-pick-go').addEventListener('click', async () => {
  try {
    const l = await api('/look/wardrobe/now', { method: 'POST', body: { scenario: $('#wd-pick').value, hours: Number($('#wd-hours').value) } });
    renderLookExtras(l);
    lookChanged();
    $('#wd-status').textContent = l.pick ? t('Changed.') : t('No look is tagged for that yet: use For… on a closet look.');
  } catch (err) {
    $('#wd-status').textContent = err.message;
  }
});
$('#wd-pick-clear').addEventListener('click', async () => {
  const l = await api('/look/wardrobe/now', { method: 'DELETE' }).catch((err) => ($('#wd-status').textContent = err.message) && null);
  if (l) {
    renderLookExtras(l);
    lookChanged();
  }
});
$('#look-outfit').addEventListener('change', () => ($('#look-outfit-own-row').hidden = $('#look-outfit').value !== 'own'));
$('#look-outfit-go').addEventListener('click', async () => {
  const own = $('#look-outfit').value === 'own';
  const outfit = own ? $('#look-outfit-own').value.trim() : $('#look-outfit').value;
  if (!outfit) return ($('#look-status').textContent = t('Describe the outfit first.'));
  try {
    await api('/look/outfit', { method: 'POST', body: { outfit, place: $('#look-place').value } });
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  refreshLook();
});
$('#look-save').addEventListener('click', async () => {
  try {
    await api('/look/saved', { method: 'POST', body: { name: $('#look-save-name').value } });
    $('#look-status').textContent = t('Saved.');
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  refreshLook();
});

// ---------- Phase 51: bring your history (ChatGPT / Claude export) ----------
const hist = { preview: null };
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '?');
function renderHistStatus(st) {
  if (!st) return;
  const busy = st.state === 'importing' || st.state === 'learning' || st.state === 'paused';
  $('#hist-progress').hidden = !busy;
  if (busy) {
    const importing = st.state === 'importing';
    $('#hist-bar').max = Math.max(1, importing ? st.total : st.learnTotal);
    $('#hist-bar').value = importing ? st.imported + st.skippedExisting : st.learned + st.failed;
    $('#hist-status').textContent = importing
      ? `${t('Bringing in conversations…')} ${st.imported + st.skippedExisting} / ${st.total}`
      : `${st.state === 'paused' ? t('Paused.') : t('Learning from them in the background…')} ${st.learned} / ${st.learnTotal} ${t('conversations')}, ${st.notes} ${t('notes so far.')}${st.message && st.state === 'paused' ? ` ${st.message}` : ''}`;
    $('#hist-pause').hidden = st.state !== 'learning';
    $('#hist-resume').hidden = st.state !== 'paused';
    $('#hist-stop').hidden = importing;
  }
  const on = st.onServer;
  const parts = Object.entries(on.bySource).map(([name, n]) => `${n} ${t('from')} ${name}`);
  $('#hist-onserver').textContent = on.conversations ? `${t('Imported history on this server:')} ${parts.join(', ')} (${on.notes} ${t('notes learned from them')}).` : '';
  $('#hist-remove').hidden = !on.conversations;
  $('#hist-learn-rest').hidden = !on.conversations || busy;
  if (st.message && !busy) $('#hist-msg').textContent = st.message;
}
async function loadHistory() {
  renderHistStatus(await api('/history-import').catch(() => null));
}
$('#hist-file').addEventListener('change', async () => {
  const f = $('#hist-file').files[0];
  $('#hist-file').value = '';
  if (!f) return;
  $('#hist-preview').hidden = true;
  $('#hist-msg').textContent = `${t('Reading')} ${f.name}… ${t('(a big export takes a minute)')}`;
  try {
    const res = await fetch('/api/history-import/preview', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
    hist.preview = data;
    $('#hist-summary').textContent = `${data.name}: ${data.conversations} ${t('conversations')}, ${data.messages} ${t('messages')} (${data.yourMessages} ${t('from you')}), ${fmtDay(data.from)} – ${fmtDay(data.to)}.${data.already ? ` ${data.already} ${t('are already here and will be skipped.')}` : ''}`;
    $('#hist-titles').replaceChildren(...data.sampleTitles.map((x) => el('li', '', x)));
    const k = data.skipped;
    const left = [k.system && `${k.system} ${t('system prompts or custom instructions')}`, k.tool && `${k.tool} ${t('tool, browsing or code-runner steps')}`, k.hidden && `${k.hidden} ${t('hidden or empty messages')}`, k.images && `${k.images} ${t('pictures (noted, not imported)')}`, k.attachments && `${k.attachments} ${t('attached files (noted, not imported)')}`, k.emptyConversations && `${k.emptyConversations} ${t('conversations with nothing from you')}`].filter(Boolean);
    $('#hist-skipped').textContent = left.length ? `${t('Left out:')} ${left.join('; ')}.` : '';
    $('#hist-go').textContent = data.conversations - data.already > 0 ? `${t('Import')} ${data.conversations - data.already} ${t('conversations')}` : t('Nothing new to import');
    $('#hist-go').disabled = data.conversations - data.already <= 0;
    $('#hist-preview').hidden = false;
    $('#hist-msg').textContent = t("Nothing is imported until you press Import. The conversations come in archived, with their dates.");
  } catch (err) {
    $('#hist-msg').textContent = err.message;
  }
});
$('#hist-cancel-preview').addEventListener('click', () => {
  hist.preview = null;
  $('#hist-preview').hidden = true;
  $('#hist-msg').textContent = '';
});
$('#hist-go').addEventListener('click', async () => {
  if (!hist.preview) return;
  $('#hist-go').disabled = true;
  $('#hist-msg').textContent = '';
  try {
    const st = await api('/history-import/run', { method: 'POST', body: { id: hist.preview.id, options: { learn: $('#hist-learn').checked, oldestFirst: $('#hist-oldest').checked } } });
    hist.preview = null;
    $('#hist-preview').hidden = true;
    renderHistStatus(st);
    if (st.message) $('#hist-msg').textContent = st.message;
    void loadConversations();
  } catch (err) {
    $('#hist-msg').textContent = err.message;
  } finally {
    $('#hist-go').disabled = false;
  }
});
for (const [id, path] of [['#hist-pause', 'pause'], ['#hist-resume', 'resume'], ['#hist-stop', 'cancel'], ['#hist-learn-rest', 'learn']])
  $(id).addEventListener('click', async () => {
    try {
      renderHistStatus(await api(`/history-import/${path}`, { method: 'POST', body: {} }));
    } catch (err) {
      $('#hist-msg').textContent = err.message;
    }
  });
$('#hist-remove').addEventListener('click', async () => {
  if (!confirm(t('Remove every imported conversation and everything she learned from them? Your own conversations and notes stay.'))) return;
  try {
    const r = await api('/history-import', { method: 'DELETE' });
    renderHistStatus(r.status);
    $('#hist-msg').textContent = `${t('Removed')} ${r.conversations} ${t('imported conversations and')} ${r.notes} ${t('notes learned from them.')}`;
    void loadConversations();
  } catch (err) {
    $('#hist-msg').textContent = err.message;
  }
});

// Phase 21: character file.
let charFile = null;
$('#char-import').addEventListener('click', () => $('#char-file').click());
$('#char-file').addEventListener('change', async () => {
  const f = $('#char-file').files[0];
  $('#char-file').value = '';
  if (!f) return;
  $('#char-status').textContent = '';
  try {
    charFile = JSON.parse(await f.text());
    if (charFile?.format !== 'sara-character') throw new Error(t("This isn't a Sara character file."));
    const p = charFile.persona ?? {};
    $('#char-import-who').textContent = `${p.name ?? '?'}${p.age ? `, ${p.age}` : ''}: ${p.summary ?? ''}`;
    $('#char-look').parentElement.hidden = !charFile.look;
    $('#char-voice').parentElement.hidden = !charFile.voice;
    $('#char-import-box').hidden = false;
  } catch (err) {
    charFile = null;
    $('#char-status').textContent = err instanceof SyntaxError ? t("This isn't a Sara character file.") : err.message;
  }
});
$('#char-import-cancel').addEventListener('click', () => {
  charFile = null;
  $('#char-import-box').hidden = true;
});
$('#char-import-go').addEventListener('click', async () => {
  if (!charFile) return;
  $('#char-import-go').disabled = true;
  $('#char-status').textContent = t('Loading…');
  try {
    const r = await api('/character/import', { method: 'POST', body: { file: charFile, look: $('#char-look').checked, voice: $('#char-voice').checked } });
    $('#char-status').textContent = `${t('Loaded {name}.', { name: r.persona.name })}${r.look ? ` ${t('New look in place.')}` : ''}${r.voice ? ` ${t('Voice set.')}` : ''}`;
    $('#char-import-box').hidden = true;
    charFile = null;
    if (r.look) lookChanged();
    await loadYours();
    refreshSaraStatus();
  } catch (err) {
    $('#char-status').textContent = err.message;
  } finally {
    $('#char-import-go').disabled = false;
  }
});

function lookChanged() {
  const v = Date.now();
  state.lookVersion = v;
  $('#my-face').src = `/sara-portrait.jpg?v=${v}`;
  for (const img of document.querySelectorAll('img.avatar, img.login-portrait')) img.src = `/sara-avatar.jpg?v=${v}`;
  setLookVersion(v);
  refreshSaraStatus();
}

$('#look-draft').addEventListener('click', async () => {
  const appearance = $('#look-desc').value.trim();
  if (!appearance) return ($('#look-status').textContent = t('Describe the look first.'));
  try {
    await api('/look/draft', { method: 'POST', body: { appearance, style: $('#look-style').value } });
    // Remember the description for pictures she takes later.
    if (yours.persona && appearance !== yours.persona.appearance) {
      const saved = await api('/persona', { method: 'PUT', body: { ...yours.persona, appearance } });
      yours.persona = saved.persona;
    }
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  refreshLook();
});
$('#look-again').addEventListener('click', () => $('#look-draft').click());
$('#look-complete').addEventListener('click', async () => {
  try {
    await api('/look/complete', { method: 'POST', body: {} });
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  refreshLook();
});
$('#look-use').addEventListener('click', async () => {
  try {
    await api('/look/build', { method: 'POST', body: { from: 'draft' } });
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  $('#look-draft-box').hidden = true;
  refreshLook();
});
$('#look-from-upload').addEventListener('click', async () => {
  try {
    await api('/look/build', { method: 'POST', body: { from: 'upload', consent: $('#look-consent').checked } });
  } catch (err) {
    $('#look-status').textContent = err.message;
  }
  refreshLook();
});
$('#look-reset').addEventListener('click', async () => {
  if (!confirm(t('Go back to her default look? Your custom pictures are removed.'))) return;
  await api('/look', { method: 'DELETE' });
  lookChanged();
  refreshLook();
});

// ---------- first-run setup guide ----------
const su = { step: 1, info: null, provider: null, vibe: 'warm', openSubs: false, original: null, changed: false };

function suShow(step) {
  su.step = step;
  for (const sec of document.querySelectorAll('#setup [data-step]')) sec.hidden = Number(sec.dataset.step) !== step;
  $('#setup-step').textContent = t('Step {step} of 4', { step });
  $('#su-back').hidden = step === 1 || step === 4;
  $('#su-skip').hidden = step === 4;
  $('#su-next').textContent = step === 4 ? t('Start talking') : step === 3 && !su.provider ? t('Skip for now') : t('Next');
}

async function openSetup(info) {
  su.info = info;
  $('#su-owner').value = info.ownerName ?? '';
  // M2: who she was before step 2, so Back + Keep can bring her back.
  su.original = (await api('/persona').catch(() => null))?.persona ?? null;
  su.changed = false;
  const ch = await api('/persona/choices');
  $('#su-rel').replaceChildren(...ch.relationships.map((r) => new Option(r.label, r.id)));
  $('#su-talk').replaceChildren(...ch.talk.map((r) => new Option(r.label, r.id)));
  $('#su-vibe').replaceChildren(
    ...ch.vibes.map((v) => {
      const b = el('button', 'chip', v.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v.id === su.vibe));
      b.addEventListener('click', () => {
        su.vibe = v.id;
        for (const c of document.querySelectorAll('#su-vibe .chip')) c.setAttribute('aria-checked', String(c === b));
      });
      return b;
    }),
  );
  const presets = state.providers.presets.filter((p) => p.needsKey);
  $('#su-preset').replaceChildren(...presets.map((p) => new Option(p.label, p.id)));
  suShowLocal(info.ollama?.[0]);
  suShow(1);
  $('#setup').showModal();
}

// Phase 23: "On this computer": Ollama found here, or how to get it (then look again).
function suShowLocal(found) {
  const box = $('#su-found');
  box.hidden = !found;
  $('#su-local-none').hidden = Boolean(found);
  if (!found) return;
  $('#su-local').open = true;
  box.replaceChildren(el('span', 'su-found-text', found.models ? (found.models === 1 ? t('Found Ollama on this computer with 1 model.') : t('Found Ollama on this computer with {n} models.', { n: found.models })) : t('Found Ollama on this computer, but it has no models yet: run ollama pull gemma3 there, then Look again.')));
  if (!found.models) return;
  const go = el('button', '', t('Use it'));
  go.type = 'button';
  go.addEventListener('click', () => suConnect({ id: 'ollama-local', label: t('Ollama on this computer'), kind: 'openai-compatible', baseUrl: found.url, local: true, needsKey: false }));
  box.append(go);
}
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

for (const r of document.querySelectorAll('input[name="su-who"]'))
  r.addEventListener('change', () => {
    const v = $('input[name="su-who"]:checked').value;
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
  });
$('#su-subs').addEventListener('change', () => (su.openSubs = $('#su-subs').checked));

/**
 * A sensible first model for a beginner from a provider's list: a well-known general model of a
 * medium size, not an embedding, vision-only, uncensored or test build. (They can pick any.)
 */
function suggestModel(models) {
  const bad = /embed|bge|nomic|minilm|rerank|whisper|tts|vision-only|uncensor|abliterat|^hf\.co\/|nvfp4|test|preview|-base\b|guard/i;
  const order = [/^gpt-5(\.\d)?$/, /^gpt-5[\w.-]*mini/, /claude-.*sonnet|^sonnet$/, /^grok-4[\w.]*$/, /gemma\d*:(12|27|31)b|gemma\d*:\d+b-cloud/, /gpt-oss/, /qwen\d[\w.]*:(14|30|32)b/, /llama\d[\w.]*:(8|70)b/, /mistral/, /gemma|qwen|llama|glm|deepseek|kimi/];
  const ok = models.filter((m) => !bad.test(m));
  for (const re of order) {
    const hit = ok.find((m) => re.test(m));
    if (hit) return hit;
  }
  return ok[0] ?? models[0];
}

async function suConnect(config, apiKey) {
  $('#su-error').textContent = '';
  $('#su-model-row').hidden = true;
  try {
    await api(`/providers/${config.id}`, { method: 'PUT', body: { ...config, ...(apiKey ? { apiKey } : {}) } });
    $('#su-model-note').textContent = t('Loading models…');
    $('#su-model-row').hidden = false;
    const { models } = await api(`/providers/${config.id}/models`);
    if (!models.length) throw new Error(t('Connected to {label}, but it has no models yet.', { label: config.label }));
    $('#su-model').replaceChildren(...models.map((m) => new Option(m, m)));
    const pick = suggestModel(models);
    $('#su-model').value = pick;
    $('#su-model-note').textContent = `${models.length === 1 ? t('Connected ✓ 1 model on {label}.', { label: config.label }) : t('Connected ✓ {n} models on {label}.', { n: models.length, label: config.label })} ${models.length > 1 ? t('We picked {model}, a good all-rounder; any of them works and you can change it later.', { model: pick }) : t('You can change it later.')}`;
    su.provider = config.id;
    suShow(3);
    $('#su-model-row').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    $('#su-model-row').hidden = true;
    $('#su-error').textContent = err.message;
  }
}
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

async function suFinish() {
  await api('/setup/done', { method: 'POST', body: {} });
  $('#setup').close();
  await loadProviders();
  await loadConversations();
  setChatTitle(); // M3: the header shows the character picked in setup
  if (su.openSubs) openSettings('models');
  else if (!state.providers.providers.length) openSettings('models');
  else setTimeout(offerFirstTour, 1500);
}

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
for (const id of ['#su-owner', '#su-name'])
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    $('#su-next').click();
  });
$('#su-skip').addEventListener('click', () => suFinish());
$('#su-next').addEventListener('click', async () => {
  $('#su-error').textContent = '';
  try {
    if (su.step === 1) {
      const name = $('#su-owner').value.trim();
      if (!name) return ($('#su-error').textContent = t('Type your name so Sara knows what to call you (or press Skip setup).'));
      await api('/settings', { method: 'PUT', body: { ownerName: name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      return suShow(2);
    }
    if (su.step === 2) {
      if ($('input[name="su-who"]:checked').value === 'new') {
        const name = $('#su-name').value.trim();
        if (!name) {
          $('#su-name').focus();
          return;
        }
        const d = await api('/persona/draft', { method: 'POST', body: { name, pronouns: $('#su-pronouns').value, age: Number($('#su-age').value) || 29, relationship: $('#su-rel').value, vibe: su.vibe, talk: $('#su-talk').value, interests: $('#su-interests').value } });
        const saved = await api('/persona', { method: 'PUT', body: d.persona });
        setIdentity(saved.persona);
        su.changed = true;
      }
      if ($('input[name="su-who"]:checked').value === 'gallery') {
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
      $('#su-done-title').textContent = (su.provider ? t('All set. Say hi to Sara!') : t('Almost there'));
      return suShow(4);
    }
    await suFinish();
  } catch (err) {
    $('#su-error').textContent = err.message;
  }
});

// ---------- signed-in devices and owner token ----------
async function loadDevices() {
  const { devices } = await api('/devices');
  // Phase 52: apps (terminal, VS Code) waiting for your OK with a device code.
  const waiting = (await api('/device/pending').catch(() => ({ pending: [] }))).pending ?? [];
  $('#devreq-box').hidden = !waiting.length;
  $('#devreq-list').replaceChildren(
    ...waiting.map((r) => {
      const li = el('li', 'devreq');
      const code = el('code', '', r.code);
      code.dataset.raw = '';
      const where = el('span', 'muted small', ` · ${r.from} · ${t('from {ip}', { ip: r.ip || '?' })} · ${t('asked at')} ${new Date(r.createdAt).toLocaleTimeString()}`);
      where.dataset.raw = '';
      li.append(el('strong', '', r.name), el('span', 'muted small', ` · ${t('code')} `), code, where, ' ');
      if (r.scope === 'hands') li.append(el('p', 'muted small', t('This pairs computer control on that Linux computer. Approve only if you started Sara hands there, the code matches, and the address is yours.')));
      for (const [label, path, cls] of [[t('Approve'), 'approve', 'small'], [t('Deny'), 'deny', 'ghost small']]) {
        const b = el('button', cls, label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            // Security review: letting in an app needs proof it's you (token, code or passkey), not only this browser's sign-in.
            const proof = path === 'approve' ? await confirmProof() : {};
            await api(`/device/${path}`, { method: 'POST', body: { code: r.code, confirmation: proof } });
          } catch (err) {
            if (err.name !== t('Cancelled')) alert(err.message);
          }
          loadDevices();
        });
        li.append(b, ' ');
      }
      return li;
    }),
  );
  $('#dev-list').replaceChildren(
    ...devices.map((d) => {
      const li = el('li', d.current ? 'current' : '');
      // API keys read like on Other apps: "made …", coarse use, and Remove (not "signed in / Sign out").
      const key = d.kind === 'api';
      const when = key
        ? `${t('made {date}', { date: new Date(d.createdAt).toLocaleDateString() })} · ${keyUse(d)}`
        : `${t('signed in {date}', { date: new Date(d.createdAt).toLocaleDateString() })} · ${t('last used {date}', { date: new Date(d.lastSeen).toLocaleString() })}`;
      li.append(el('strong', '', d.label), el('span', 'muted small', `${d.kind === 'app' ? ` · ${t('app (device code)')}` : key ? ` · ${t('API key for another app')}` : ''} · ${when}${d.current ? ` · ${t('this device')}` : ''}`));
      if (!d.current) {
        const out = el('button', 'ghost small', key ? t('Remove') : t('Sign out'));
        out.type = 'button';
        out.addEventListener('click', async () => {
          if (key && !confirm(t('Remove this key? The app using it stops working until you give it a new one.'))) return;
          await api(`/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
          loadDevices();
        });
        li.append(' ', out);
      }
      return li;
    }),
  );
  $('#dev-others').hidden = devices.length < 2;
}
$('#dev-others').addEventListener('click', async () => {
  if (!confirm(t('Sign out every other browser and phone?'))) return;
  await api('/devices/others', { method: 'DELETE' });
  loadDevices();
});
$('#tok-rotate').addEventListener('click', async () => {
  $('#tok-status').textContent = '';
  try {
    const { token } = await api('/owner-token/rotate', { method: 'POST', body: { current: $('#tok-current').value } });
    $('#tok-current').value = '';
    $('#tok-value').textContent = token;
    $('#tok-new').hidden = false;
    $('#tok-status').textContent = t('Done. Every other device is signed out, and saved passkeys were removed (add them again if you still want them).');
    loadDevices();
    loadSecurity();
  } catch (err) {
    $('#tok-status').textContent = err.message;
  }
});
$('#tok-copy').addEventListener('click', () => copyText($('#tok-value').textContent, $('#tok-copy')));

// ---------- Phase 32 / 41: "?" tips (hover on a computer, tap on a phone) ----------
// Hover shows the text; a click or tap opens a card with the text and a link to the guide.
/** Adds a ? to every setting listed in tips.json that has none in the page yet. */
let fieldIds = 0;
function addTips(tips) {
  for (const [id, [text, guide]] of Object.entries(tips)) {
    const c = document.getElementById(id);
    if (!c) continue;
    const label = c.closest('label') ?? document.querySelector(`label[for="${id}"]`);
    if ((label ?? c.parentElement)?.querySelector(':scope > .tip')) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tip';
    b.textContent = '?';
    b.dataset.tip = text;
    b.dataset.guide = guide;
    b.setAttribute('aria-label', t('What is this?'));
    if (label) {
      // After the label's words: before the control when the words come first, else at the end.
      const first = [...label.childNodes].find((n) => n.nodeType === 1 || n.textContent.trim());
      if (first && first !== c && first.nodeType === 3) {
        // Words first (e.g. "Name <input>"): the words and the ? share one line (labels stack
        // their words above the control).
        const words = document.createElement('span');
        words.className = 'label-words';
        first.before(words);
        let n = words.nextSibling;
        while (n && n !== c && (n.nodeType === 3 || (n.nodeType === 1 && /^(STRONG|EM|SPAN|SMALL|B|I|CODE)$/.test(n.tagName) && !n.querySelector('input,select,textarea')))) {
          const next = n.nextSibling;
          words.append(n);
          n = next;
        }
        words.append(b);
      } else label.append(b);
    } else {
      // A box with no label (its placeholder says what it is): the tip shows on hover and to
      // screen readers, without a ? that would break the row.
      c.title = text;
      c.setAttribute('aria-description', text);
    }
  }
  // Tips written into the page right after a label's words get the same one-line treatment.
  for (const tip of document.querySelectorAll('label > .tip')) {
    const label = tip.parentElement;
    if (label.querySelector(':scope > .label-words')) continue;
    const first = [...label.childNodes].find((n) => n.nodeType === 1 || n.textContent.trim());
    if (!first || first.nodeType !== 3 || first.nextSibling !== tip) continue;
    const words = document.createElement('span');
    words.className = 'label-words';
    first.before(words);
    words.append(first, tip);
  }
  // A label points at the first control inside it, and a ? is a button: tie each label to its
  // field by id, or screen readers name the ? instead of the field (and clicking the words would
  // open the tip instead of focusing the field).
  for (const label of document.querySelectorAll('label:not([for])')) {
    if (!label.querySelector('.tip')) continue;
    const field = label.querySelector('input:not([type=hidden]), select, textarea');
    if (!field) continue;
    if (!field.id) field.id = `field-${++fieldIds}`;
    label.htmlFor = field.id;
  }
  // (Their text follows her name and pronouns: naming.js rewrites data-tip like other attributes.)
}
function guideFor(tip) {
  if (tip.dataset.guide) return tip.dataset.guide;
  const page = tip.closest('[data-page]')?.dataset.page;
  if (page && HELP[page]) return HELP[page][1];
  const d = tip.closest('dialog')?.id;
  return TIP_GUIDE_FOR[d] ?? '';
}
function closeTipCard() {
  document.querySelector('.tip-card')?.remove();
  for (const open of document.querySelectorAll('.tip.open')) open.classList.remove('open');
}
function openTipCard(tip) {
  closeTipCard();
  tip.classList.add('open');
  const card = document.createElement('div');
  card.className = 'tip-card';
  card.setAttribute('role', 'tooltip');
  const p = document.createElement('p');
  p.textContent = tip.dataset.tip;
  card.append(p);
  const g = guideFor(tip);
  if (g) {
    const a = document.createElement('a');
    a.href = `/help#${g}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = t('More in the guide →');
    card.append(a);
  }
  // Inside an open dialog the card must live in the dialog (the top layer), else it's hidden.
  (tip.closest('dialog[open]') ?? document.body).append(card);
  const r = tip.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  card.style.setProperty('--tip-w', `${w}px`);
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
  const h = card.offsetHeight;
  const top = r.top > h + 16 ? r.top - h - 8 : r.bottom + 8;
  card.style.setProperty('--tip-x', `${left}px`);
  card.style.setProperty('--tip-y', `${top}px`);
}
document.addEventListener('click', (e) => {
  const tip = e.target.closest?.('.tip');
  if (e.target.closest?.('.tip-card')) return; // the guide link
  if (tip) {
    e.preventDefault();
    e.stopPropagation();
    if (tip.classList.contains('open')) closeTipCard();
    else openTipCard(tip);
  } else closeTipCard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.tip-card')) {
    closeTipCard();
    e.stopPropagation();
  }
});
document.addEventListener('scroll', closeTipCard, true);
// Open below when there isn't room above (near the top of a scrolling page or the screen).
const placeTip = (e) => {
  const tip = e.target.closest?.('.tip');
  if (!tip) return;
  const box = tip.closest('.settings-pages, dialog, main') ?? document.body;
  const r = tip.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  tip.classList.toggle('below', r.top - Math.max(0, b.top) < 150);
  const half = Math.min(150, window.innerWidth * 0.4);
  tip.classList.toggle('edge-right', Math.min(b.right, window.innerWidth) - r.right < half);
  tip.classList.toggle('edge-left', !tip.classList.contains('edge-right') && r.left - Math.max(0, b.left) < half);
};
document.addEventListener('mouseover', placeTip);
document.addEventListener('focusin', placeTip);
document.addEventListener('pointerdown', placeTip, true);

// ---------- Phase 33: the desktop apps (macOS, Windows) ----------
async function loadDesktop() {
  const d = window.SaraDesktop;
  if (!d) return;
  const p = await d.call('getPrefs').catch(() => null);
  if (!p) return;
  $('#dk-login').checked = Boolean(p.startAtLogin);
  $('#dk-keep').checked = p.keepRunning !== false;
  $('#dk-notify').checked = p.notifications !== false;
  $('#dk-version').textContent = `${t('Sara for {platform}', { platform: p.platform === 'mac' ? 'Mac' : 'Windows' })} ${p.version ?? ''} · ${t('connected to {host}', { host: location.host })}`;
  fillQuickAsk(p);
}
/**
 * Phase 75 (stage 3): the quick-ask shortcut, read and set through the app's bridge
 * (docs/desktop.md → Quick ask). Older apps without it don't send the list: the row stays hidden.
 */
function quickAskOptions(p) {
  const list = Array.isArray(p?.quickAskShortcuts) ? p.quickAskShortcuts.filter((x) => x && typeof x.id === 'string') : [];
  return list.map((x) => ({ id: x.id, label: x.id === 'off' ? t('Off') : String(x.label ?? x.id) }));
}
function fillQuickAsk(p) {
  const opts = quickAskOptions(p);
  $('#dk-quick-row').hidden = !opts.length;
  if (!opts.length) return;
  const sel = $('#dk-quick');
  if (document.activeElement !== sel) {
    sel.replaceChildren(...opts.map((o) => new Option(o.label, o.id)));
    sel.value = p.quickAskShortcut ?? opts[0].id;
  }
  const off = p.quickAskShortcut === 'off';
  $('#dk-quick-try').disabled = false;
  $('#dk-quick-note').textContent = !off && p.quickAskShortcutFree === false ? t('(used by another app)') : '';
}
if (window.SaraDesktop) {
  document.documentElement.classList.add('in-desktop');
  for (const [id, key] of [['#dk-login', 'startAtLogin'], ['#dk-keep', 'keepRunning'], ['#dk-notify', 'notifications']]) {
    $(id).addEventListener('change', async () => {
      const r = await window.SaraDesktop.call('setPref', { key, value: $(id).checked }).catch((err) => ({ error: String(err) }));
      $('#dk-status').textContent = r?.error ? r.error : t('Saved');
      await loadDesktop();
    });
  }
  $('#dk-server').addEventListener('click', () => openServers());
  $('#dk-quick').addEventListener('change', async () => {
    const r = await window.SaraDesktop.call('setPref', { key: 'quickAskShortcut', value: $('#dk-quick').value }).catch((err) => ({ error: String(err) }));
    $('#dk-status').textContent = r?.error ? r.error : t('Saved');
    if (r && !r.error && r.quickAskShortcuts) fillQuickAsk(r);
    else await loadDesktop();
  });
  $('#dk-quick-try').addEventListener('click', () => void window.SaraDesktop.call('quickAsk').catch(() => {}));
  $('#dk-test').addEventListener('click', () => window.SaraDesktop.call('testNotification', { title: t('Sara'), body: t('Notifications from Sara will look like this.') }));
}

// ---------- Phase 87: computer use (docs/design/COMPUTER_USE.md §9) ----------
// The Computer use page (the computers that let her use them, the member switch), the opt-in on this
// computer in the desktop apps (the hands token goes straight to the app's native part, never kept
// by this page), and the live view above the composer while she uses a computer for this chat.
const handsBridge = () => (window.SaraDesktop?.call ? window.SaraDesktop : null);
async function handsPrefs() {
  const d = handsBridge();
  if (!d) return null;
  const p = await d.call('getPrefs').catch(() => null);
  return p && p.handsSupported ? p : null;
}
async function loadComputer() {
  const status = $('#cu-status');
  status.textContent = '';
  let h;
  try {
    h = await api('/hands');
  } catch (err) {
    $('#cu-list').replaceChildren();
    $('#cu-none').hidden = true;
    $('#cu-this').hidden = $('#cu-get').hidden = $('#cu-owner').hidden = true;
    $('#cu-dev').hidden = true;
    status.textContent = err.status === 403 ? t('Ask the owner of this server to switch on computer use for household members.') : err.message;
    return;
  }
  $('#cu-owner').hidden = h.role !== 'owner';
  $('#cu-members').checked = h.members === true;
  // Phase 88: her actions (the owner's choices) and this computer's takeover choice and stop keys.
  $('#cu-acts').hidden = h.role !== 'owner';
  $('#cu-level').value = h.level || 'task';
  $('#cu-level').dataset.was = h.level || 'task';
  // Phase 94: browser extensions in check-ups (on unless the owner turned it off).
  $('#cu-checkup-ext').checked = h.checkupExtensions !== false;
  $('#cu-desktop-level').closest('label').hidden = true;
  cuSettings.alwaysWarned = h.alwaysWarned === true;
  renderAlways(h.always ?? []);
  for (const d of h.devices ?? []) cuSettings.names[d.id] = d.computer || d.label;
  const p = await handsPrefs();
  $('#cu-this').hidden = !p;
  $('#cu-get').hidden = Boolean(p);
  if (h.downloadUrl) $('#cu-get-link').href = h.downloadUrl;
  if (p) {
    $('#cu-optin').checked = p.handsOptIn === true;
    $('#cu-localonly').checked = p.handsLocalOnly === true;
    $('#cu-localonly').disabled = p.handsOptIn !== true;
    // Phase 92: the whole screen (look only), the person's own hidden windows, and the Mac's two permissions.
    $('#cu-desktop').checked = p.handsDesktop === true;
    $('#cu-desktop').disabled = p.handsOptIn !== true || p.handsDesktopSupported !== true;
    $('#cu-desktop').closest('label').hidden = p.handsDesktopSupported !== true;
    $('#cu-block-extra').closest('label').hidden = p.handsDesktopSupported !== true;
    if (document.activeElement !== $('#cu-block-extra')) $('#cu-block-extra').value = p.handsBlockExtra || '';
    $('#cu-block-extra').disabled = p.handsOptIn !== true;
    renderCuPerms(p);
    $('#cu-desktop-level').closest('label').hidden = false;
    $('#cu-desktop-level').value = p.handsDesktopLevel || 'task';
    $('#cu-desktop-level').dataset.was = p.handsDesktopLevel || 'task';
    $('#cu-desktop-level').disabled = p.handsOptIn !== true;
    $('#cu-takeover').value = p.handsTakeover === 'keep' ? 'keep' : 'pause';
    $('#cu-takeover').disabled = p.handsOptIn !== true;
    $('#cu-walkaway').checked = p.handsWalkAway === true;
    $('#cu-walkaway').disabled = p.handsOptIn !== true;
    if (p.handsHotkey) $('#cu-hotkey').textContent = p.handsHotkey;
    // Phase 90: Windows Hello / Touch ID before a saved login is used (this computer's own choice).
    $('#cu-verify').checked = p.loginsVerify === true;
    $('#cu-verify').disabled = p.handsOptIn !== true || p.loginsSupported !== true;
    void renderThisLogins();
    void renderThisManagers(p);
    $('#cu-this-status').textContent = p.handsOptIn ? (p.handsConnected ? t('On: connected to Sara.') : t('On: connecting…')) : t('Off.');
  }
  const list = h.devices ?? [];
  $('#cu-none').hidden = list.length > 0;
  $('#cu-list').replaceChildren(
    ...list.map((d) => {
      const li = el('li', 'cu-row');
      const dot = el('span', `cu-dot${d.connected ? ' on' : ''}`);
      dot.setAttribute('aria-hidden', 'true');
      const main = el('div', 'cu-row-main');
      main.append(el('span', 'cu-row-name', d.computer || d.label));
      const bits = [d.connected ? t('Connected') : t('Not connected')];
      if (d.app) bits.push(d.app);
      if (d.browser?.name) bits.push(d.browser.name);
      if (d.connected && d.optIn && !d.optIn.browser) bits.push(t('switched off there'));
      if (d.localOnly) bits.push(t('screenshots stay on local models'));
      // Phase 92: the whole screen there (look only), and a Mac still missing a permission.
      if (d.connected && d.optIn?.desktop) bits.push(d.perms && (d.perms.capture === false || d.perms.ax === false) ? t('whole screen: waiting for macOS permission') : t('whole screen: look only'));
      if (d.busy) bits.push(t('in use now'));
      // Phase 91: the password managers the owner turned on there (locked or unlocked for Sara).
      const pms = (d.managers ?? []).filter((m) => m.on);
      for (const m of pms) bits.push(m.state === 'unlocked' ? t('{manager} unlocked for Sara', { manager: m.name }) : t('{manager} locked', { manager: m.name }));
      main.append(el('span', 'cu-row-meta', bits.join(' · ')));
      li.append(dot, main);
      if (d.connected && pms.some((m) => m.state === 'unlocked')) {
        const lock = el('button', 'ghost', t('Lock now'));
        lock.type = 'button';
        lock.addEventListener('click', async () => {
          const x = await api(`/hands/${encodeURIComponent(d.id)}/relock`, { method: 'POST', body: {} }).catch((err) => ({ ok: false, error: { message: err.message } }));
          status.textContent = x.ok ? t('Locked on {computer}.', { computer: d.computer || d.label }) : x.error?.message || '';
          void loadComputer();
        });
        li.append(lock);
      }
      const out = el('button', 'ghost', t('Sign out'));
      out.type = 'button';
      out.addEventListener('click', async () => {
        if (!confirm(t('Sign {name} out? Sara can no longer use it until it is switched on there again.', { name: d.computer || d.label }))) return;
        try {
          await api(`/hands/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
          await loadComputer();
        } catch (err) {
          status.textContent = err.message;
        }
      });
      li.append(out);
      return li;
    }),
  );
  renderTunnels(h.tunnels ?? [], list);
  void renderLogins(list, p);
}
// Phase 90: logins saved on the computers (names and sites; each computer answers for itself).
const loginDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
function loginRow(l, remove) {
  const li = el('li', 'cu-row');
  const main = el('div', 'cu-row-main');
  const nm = el('span', 'cu-row-name', l.name);
  nm.dataset.raw = '';
  const bits = [(l.sites ?? []).join(', ')];
  if (l.lastUsed) bits.push(t('Last used {date}', { date: loginDate(l.lastUsed) }));
  else if (l.created) bits.push(t('Saved {date}', { date: loginDate(l.created) }));
  const meta = el('span', 'cu-row-meta', bits.filter(Boolean).join(' · '));
  meta.dataset.raw = '';
  main.append(nm, meta);
  const rm = el('button', 'ghost', t('Remove'));
  rm.type = 'button';
  rm.addEventListener('click', () => void remove(l));
  li.append(main, rm);
  return li;
}
async function renderLogins(devices, p) {
  const box = $('#cu-logins-list');
  // In the Sara app, this computer's own logins are listed under This computer.
  const mine = p?.handsDeviceId || '';
  const able = devices.filter((d) => d.connected && (d.ops ?? []).includes('b.logins') && d.id !== mine);
  $('#cu-logins').hidden = !able.length;
  const blocks = await Promise.all(
    able.map(async (d) => {
      const name = d.computer || d.label;
      const wrap = el('div', 'cu-logins-device');
      const head = el('h4', '', name);
      head.dataset.raw = '';
      const ul = el('ul', 'cu-list');
      const note = el('p', 'muted small', '');
      wrap.append(head, ul, note);
      let r;
      try {
        r = await api(`/hands/${encodeURIComponent(d.id)}/logins`);
      } catch (err) {
        note.textContent = err.message;
        return wrap;
      }
      if (!r.supported) {
        ul.hidden = true;
        note.textContent = r.connected ? t('This computer can’t save logins yet: update the Sara app there.') : t('Not connected: its saved logins show when it is.');
        return wrap;
      }
      const logins = r.logins ?? [];
      const removeOne = async (l) => {
        if (!confirm(t('Remove the saved login “{name}” from {computer}?', { name: l.name, computer: name }))) return;
        const x = await api(`/hands/${encodeURIComponent(d.id)}/logins/${encodeURIComponent(l.name)}`, { method: 'DELETE' }).catch((err) => ({ ok: false, error: { message: err.message } }));
        $('#cu-status').textContent = x.ok ? t('Removed on {computer}.', { computer: name }) : x.error?.message || '';
        void loadComputer();
      };
      ul.replaceChildren(...logins.map((l) => loginRow(l, removeOne)));
      note.textContent = logins.length ? '' : t('No saved logins.');
      note.hidden = logins.length > 0;
      ul.hidden = !logins.length;
      if (logins.length > 1) {
        const all = el('button', 'ghost', t('Remove all'));
        all.type = 'button';
        all.addEventListener('click', async () => {
          if (!confirm(t('Remove every saved login from {computer}?', { computer: name }))) return;
          const x = await api(`/hands/${encodeURIComponent(d.id)}/logins`, { method: 'DELETE' }).catch((err) => ({ ok: false, error: { message: err.message } }));
          $('#cu-status').textContent = x.ok ? t('Removed on {computer}.', { computer: name }) : x.error?.message || '';
          void loadComputer();
        });
        wrap.append(all);
      }
      return wrap;
    }),
  );
  box.replaceChildren(...blocks);
}
/** In the Sara app: this computer's saved logins, straight from the app (works while disconnected too). */
async function renderThisLogins() {
  const d = handsBridge();
  const ul = $('#cu-this-logins');
  if (!d) return;
  const r = await d.call('loginsList').catch(() => null);
  const logins = Array.isArray(r?.logins) ? r.logins : [];
  const remove = async (l) => {
    if (!confirm(t('Remove the saved login “{name}” from {computer}?', { name: l.name, computer: t('this computer') }))) return;
    const x = await d.call('loginsRemove', { name: l.name }).catch((err) => ({ error: String(err) }));
    $('#cu-this-status').textContent = x?.error ? x.error : t('Removed on {computer}.', { computer: t('this computer') });
    void renderThisLogins();
  };
  ul.replaceChildren(...logins.map((l) => loginRow(l, remove)));
  $('#cu-this-logins-none').hidden = logins.length > 0;
}
// Phase 91: the password managers on this computer, straight from the app. Turning one on shows the
// app's own warning (a window of the app, not this page); unlocking is never done from here.
const PM_STATE = { missing: () => t('Not installed here'), off: () => t('Off'), locked: () => t('On · locked'), unlocked: () => t('On · unlocked for Sara') };
async function renderThisManagers(p) {
  const d = handsBridge();
  const box = $('#cu-pm');
  if (!d || !p || p.pmSupported !== true) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const r = await d.call('pmList').catch(() => null);
  const list = (Array.isArray(r?.managers) ? r.managers : []).filter((m) => m.installed);
  $('#cu-pm-none').hidden = list.length > 0;
  $('#cu-pm-relock').value = String(r?.relockMinutes ?? 15);
  $('#cu-pm-relock').disabled = p.handsOptIn !== true || !list.length;
  $('#cu-pm-list').replaceChildren(
    ...list.map((m) => {
      const li = el('li', 'cu-row');
      const main = el('div', 'cu-row-main');
      const nm = el('span', 'cu-row-name', m.name);
      nm.dataset.raw = '';
      const bits = [(PM_STATE[m.state] ?? PM_STATE.off)()];
      if (m.id === 'keepassxc' && r?.keepassDb) bits.push(t('Database: {file}', { file: r.keepassDb }));
      const meta = el('span', 'cu-row-meta', bits.join(' · '));
      main.append(nm, meta);
      li.append(main);
      if (m.id === 'keepassxc' && m.on) {
        const pick = el('button', 'ghost', t('Choose database…'));
        pick.type = 'button';
        pick.addEventListener('click', async () => {
          const x = await d.call('pmKeepassDb').catch((err) => ({ error: String(err) }));
          $('#cu-this-status').textContent = x?.error ? x.error : '';
          void renderThisManagers(await handsPrefs());
        });
        li.append(pick);
      }
      const sw = el('button', m.on ? 'ghost' : '', m.on ? t('Turn off') : t('Turn on'));
      sw.type = 'button';
      sw.disabled = p.handsOptIn !== true;
      sw.addEventListener('click', async () => {
        sw.disabled = true;
        const x = await d.call('pmSet', { manager: m.id, on: !m.on }).catch((err) => ({ error: String(err) }));
        $('#cu-this-status').textContent = x?.error ? x.error : x?.cancelled ? t('Not changed.') : m.on ? t('{manager} is off for Sara.', { manager: m.name }) : t('{manager} is on for Sara. You unlock it yourself when she needs it.', { manager: m.name });
        void renderThisManagers(await handsPrefs());
      });
      li.append(sw);
      return li;
    }),
  );
}
$('#cu-pm-relock').addEventListener('change', async () => {
  const d = handsBridge();
  if (!d) return;
  const r = await d.call('setPref', { key: 'pmRelockMinutes', value: $('#cu-pm-relock').value }).catch((err) => ({ error: String(err) }));
  $('#cu-this-status').textContent = r?.error ? r.error : t('Saved');
});
$('#cu-verify').addEventListener('change', async () => {
  const d = handsBridge();
  if (!d) return;
  const r = await d.call('setPref', { key: 'loginsVerify', value: $('#cu-verify').checked }).catch((err) => ({ error: String(err) }));
  $('#cu-this-status').textContent = r?.error ? r.error : t('Saved');
});
// Phase 89: her dev tunnels (an app her job runs here, opened in her browser on your computer).
function renderTunnels(tunnels, devices) {
  const able = devices.filter((d) => d.connected && (d.ops ?? []).includes('c.tunnel'));
  $('#cu-dev').hidden = !able.length && !tunnels.length;
  $('#cu-tunnels-none').hidden = tunnels.length > 0;
  const name = (id) => cuSettings.names[id] || t('this computer');
  $('#cu-tunnels').replaceChildren(
    ...tunnels.map((x) => {
      const li = el('li', 'cu-row');
      const main = el('div', 'cu-row-main');
      const nm = el('span', 'cu-row-name', x.url);
      nm.dataset.raw = '';
      main.append(nm, el('span', 'cu-row-meta', x.kind === 'test' ? t('Test page on {name}', { name: name(x.deviceId) }) : t('Port {port} of job #{job} on {name}', { port: x.port, job: x.jobId, name: name(x.deviceId) })));
      const close = el('button', 'ghost', t('Close'));
      close.type = 'button';
      close.addEventListener('click', async () => {
        try {
          await api(`/hands/${encodeURIComponent(x.deviceId)}/tunnels/${encodeURIComponent(x.id)}`, { method: 'DELETE' });
          await loadComputer();
        } catch (err) {
          $('#cu-status').textContent = err.message;
        }
      });
      li.append(main, close);
      return li;
    }),
  );
  const sel = $('#cu-tunnel-device');
  const was = sel.value;
  sel.replaceChildren(
    ...able.map((d) => {
      const o = el('option', '', d.computer || d.label);
      o.value = d.id;
      return o;
    }),
  );
  if (able.some((d) => d.id === was)) sel.value = was;
  $('#cu-tunnel-try').disabled = !able.length;
}
$('#cu-tunnel-try').addEventListener('click', async () => {
  const id = $('#cu-tunnel-device').value;
  const st = $('#cu-status');
  if (!id) return;
  const btn = $('#cu-tunnel-try');
  btn.disabled = true;
  st.textContent = t('Opening the test page…');
  try {
    const r = await api(`/hands/${encodeURIComponent(id)}/tunnel-test`, { method: 'POST', body: {} });
    if (!r.ok) throw new Error(r.error?.message || t('That didn’t work.'));
    const o = await api(`/hands/${encodeURIComponent(id)}/op`, { method: 'POST', body: { op: 'b.open', args: { url: `${r.tunnel.url}/`, newTab: true } } });
    st.textContent = o.ok ? t('The test page is open in Sara’s browser on {name}. It should say All checks passed.', { name: cuSettings.names[id] || t('this computer') }) : o.error?.message || '';
  } catch (err) {
    st.textContent = err.message;
  } finally {
    btn.disabled = false;
    void loadComputer();
  }
});
$('#cu-checkup-ext').addEventListener('change', async () => {
  try {
    await api('/computer', { method: 'PUT', body: { checkupExtensions: $('#cu-checkup-ext').checked } });
    $('#cu-status').textContent = t('Saved');
  } catch (err) {
    $('#cu-status').textContent = err.message;
    $('#cu-checkup-ext').checked = !$('#cu-checkup-ext').checked;
  }
});
$('#cu-members').addEventListener('change', async () => {
  try {
    await api('/computer', { method: 'PUT', body: { members: $('#cu-members').checked } });
    $('#cu-status').textContent = t('Saved');
  } catch (err) {
    $('#cu-status').textContent = err.message;
    $('#cu-members').checked = !$('#cu-members').checked;
  }
});
/** The first-time explainer: resolves true when the owner chose "Turn it on". */
function computerExplainer() {
  const dlg = $('#cu-explain');
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    $('#cu-explain-yes').focus();
  });
}
$('#cu-optin').addEventListener('change', async () => {
  const box = $('#cu-optin');
  const d = handsBridge();
  const st = $('#cu-this-status');
  if (!d) return;
  const on = box.checked;
  box.disabled = true;
  try {
    if (on) {
      if (!(await computerExplainer())) {
        box.checked = false;
        return;
      }
      // §3.3: a server reached without HTTPS on another machine gets the hands only after a warning.
      if (location.protocol === 'http:' && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname) && !confirm(t('This Sara is reached without HTTPS, so others on your network could see what she sends this computer. Let her use it anyway?'))) {
        box.checked = false;
        return;
      }
      const p = await handsPrefs();
      const proof = await confirmProof();
      const r = await api('/hands/pair', { method: 'POST', body: { ...proof, name: p?.computerName || '' } });
      const done = await d.call('handsPair', { token: r.token, id: r.id, expiresAt: r.expiresAt });
      if (done?.error) throw new Error(done.error);
      st.textContent = t('On: connecting…');
    } else {
      const p = await handsPrefs();
      await d.call('handsOff');
      if (p?.handsDeviceId) await api(`/hands/${encodeURIComponent(p.handsDeviceId)}`, { method: 'DELETE' }).catch(() => {});
      st.textContent = t('Off.');
    }
  } catch (err) {
    box.checked = !on;
    st.textContent = err.name === t('Cancelled') ? '' : err.message;
  } finally {
    box.disabled = false;
    setTimeout(() => void loadComputer(), 1500);
  }
});
// Phase 92 (CU5): "The whole screen" (its own explainer), the person's own hidden windows, the Mac's permissions.
function deskExplainer() {
  const dlg = $('#cu-desk-explain');
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    $('#cu-desk-explain-yes').focus();
  });
}
$('#cu-desktop').addEventListener('change', async () => {
  const box = $('#cu-desktop');
  const d = handsBridge();
  if (!d) return;
  const on = box.checked;
  if (on && !(await deskExplainer())) {
    box.checked = false;
    return;
  }
  const r = await d.call('setPref', { key: 'handsDesktop', value: on }).catch((err) => ({ error: String(err) }));
  if (r?.error) box.checked = !on;
  $('#cu-this-status').textContent = r?.error ? r.error : on ? t('Sara may look at this screen now. Blocked windows stay black.') : t('Sara only uses her own browser here now.');
  if (r && !r.error) renderCuPerms(r);
});
$('#cu-block-extra').addEventListener('change', async () => {
  const d = handsBridge();
  if (!d) return;
  const v = $('#cu-block-extra').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 40).join('\n');
  const r = await d.call('setPref', { key: 'handsBlockExtra', value: v }).catch((err) => ({ error: String(err) }));
  $('#cu-this-status').textContent = r?.error ? r.error : t('Saved');
});
let cuPermTimer = 0;
/** The Mac's guided steps (§9.1): a tick per permission, polled while the page shows them. */
function renderCuPerms(p) {
  const perms = p?.handsPerms;
  const show = Boolean(perms) && p.handsDesktop === true && p.handsOptIn === true;
  $('#cu-perms').hidden = !show;
  clearTimeout(cuPermTimer);
  if (!show) return;
  for (const [k, id] of [['capture', 'cu-perm-capture'], ['ax', 'cu-perm-ax']]) {
    const ok = perms[k] === true;
    const st = $(`#${id}-state`);
    st.textContent = ok ? '✓' : '•';
    st.classList.toggle('ok', ok);
    st.setAttribute('aria-label', ok ? t('Allowed') : t('Not allowed yet'));
    $(`#${id}`).hidden = ok;
  }
  $('#cu-perms-restart').hidden = perms.capture === true && perms.ax === true;
  if (perms.capture !== true || perms.ax !== true) {
    cuPermTimer = setTimeout(async () => {
      if ($('#cu-perms').hidden || !$('#cu-perms').isConnected) return;
      const q = await handsPrefs();
      if (q) renderCuPerms(q);
    }, 2000);
  }
}
for (const [id, which] of [['cu-perm-capture', 'capture'], ['cu-perm-ax', 'ax']]) {
  $(`#${id}`).addEventListener('click', async () => {
    const d = handsBridge();
    if (!d) return;
    const r = await d.call('handsOpenPerm', { which }).catch((err) => ({ error: String(err) }));
    $('#cu-this-status').textContent = r?.error ? r.error : t('Turn on Sara there, then come back here.');
  });
}

$('#cu-localonly').addEventListener('change', async () => {
  const d = handsBridge();
  if (!d) return;
  const r = await d.call('setPref', { key: 'handsLocalOnly', value: $('#cu-localonly').checked }).catch((err) => ({ error: String(err) }));
  $('#cu-this-status').textContent = r?.error ? r.error : t('Saved');
});

// Phase 88: her actions (approval level, sites always allowed) and this computer's takeover choice.
const cuSettings = { alwaysWarned: false, names: {} };
function renderAlways(list) {
  $('#cu-always-none').hidden = list.length > 0;
  $('#cu-always').replaceChildren(
    ...list.map((a) => {
      const li = el('li', 'cu-row cu-always-row');
      const main = el('div', 'cu-row-main');
      const nm = el('span', 'cu-row-name', a.site);
      nm.dataset.raw = '';
      main.append(nm, el('span', 'cu-row-meta', (CU_KIND[a.kind] ?? CU_KIND.click)()));
      const rm = el('button', 'ghost', t('Remove'));
      rm.type = 'button';
      rm.addEventListener('click', async () => {
        try {
          const r = await api('/computer', { method: 'PUT', body: { removeAlways: { site: a.site, kind: a.kind } } });
          renderAlways(r.always ?? []);
        } catch (err) {
          $('#cu-status').textContent = err.message;
        }
      });
      li.append(main, rm);
      return li;
    }),
  );
}
function alwaysWarning() {
  const dlg = $('#cu-always-warn');
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}
$('#cu-level').addEventListener('change', async () => {
  const sel = $('#cu-level');
  const level = sel.value;
  try {
    if (level === 'always' && !cuSettings.alwaysWarned && !(await alwaysWarning())) {
      sel.value = sel.dataset.was || 'task';
      return;
    }
    const r = await api('/computer', { method: 'PUT', body: { level, ...(level === 'always' ? { warned: true } : {}) } });
    cuSettings.alwaysWarned = r.alwaysWarned === true;
    sel.dataset.was = r.level;
    $('#cu-status').textContent = t('Saved');
  } catch (err) {
    sel.value = sel.dataset.was || 'task';
    $('#cu-status').textContent = err.message;
  }
});
$('#cu-desktop-level').addEventListener('change', async () => {
  const sel = $('#cu-desktop-level');
  const bridge = handsBridge();
  if (!bridge) return;
  try {
    const r = await bridge.call('setPref', { key: 'handsDesktopLevel', value: sel.value });
    if (r?.error) throw new Error(r.error);
    sel.dataset.was = sel.value;
    $('#cu-this-status').textContent = t('Saved');
  } catch (err) {
    sel.value = sel.dataset.was || 'task';
    $('#cu-this-status').textContent = err.message;
  }
});
$('#cu-takeover').addEventListener('change', async () => {
  const d = handsBridge();
  if (!d) return;
  const r = await d.call('setPref', { key: 'handsTakeover', value: $('#cu-takeover').value }).catch((err) => ({ error: String(err) }));
  $('#cu-this-status').textContent = r?.error ? r.error : t('Saved');
});
$('#cu-walkaway').addEventListener('change', async () => {
  const d = handsBridge();
  if (!d) return;
  const r = await d.call('setPref', { key: 'handsWalkAway', value: $('#cu-walkaway').checked }).catch((err) => ({ error: String(err) }));
  $('#cu-this-status').textContent = r?.error ? r.error : t('Saved');
});

// Phase 88: the "Sara is working" badge above the composer (with Stop), and "Paused: you took over".
const cuBadge = { deviceId: '', timer: 0, paused: false };
const CU_LOOK = () => t('Looking at the page');
const CU_DOING = { 'b.open': () => t('Opening a page'), 'b.navigate': () => t('Going to a page'), 'b.snapshot': CU_LOOK, 'b.screenshot': CU_LOOK, 'b.find': CU_LOOK, 'b.read': () => t('Reading the page'), 'b.logs': () => t('Reading the logs'), 'b.request': () => t('Reading the logs'), 'b.tabs': () => t('Looking at the tabs'), 'b.click': () => t('Clicking'), 'b.type': () => t('Typing'), 'b.select': () => t('Choosing in a list'), 'b.keys': () => t('Pressing keys'), 'b.scroll': () => t('Scrolling'), 'b.upload': () => t('Uploading a file'), 'b.downloads': () => t('Looking at the downloads'), 'b.login': () => t('Signing in with a saved login'), 'b.saveLogin': () => t('Waiting for you to save a login'), 'b.yourTurn': () => t('Your turn: waiting for you in her browser'), 'b.unlock': () => t('Your turn: unlock your password manager in its own window'), 'b.relock': () => t('Locking your password manager again'), 'b.logins': () => t('Looking at the saved logins'), 'b.forgetLogin': () => t('Removing a saved login'), 'd.click': () => t('Clicking on the desktop'), 'd.type': () => t('Typing on the desktop'), 'd.keys': () => t('Pressing desktop keys'), 'd.scroll': () => t('Scrolling the desktop'), 'd.drag': () => t('Dragging on the desktop'), 'd.launch': () => t('Opening a desktop app') };
function hideBadge() {
  $('#cu-badge').hidden = true;
  cuBadge.deviceId = '';
  cuBadge.paused = false;
  clearTimeout(cuBadge.timer);
}
function showBadge(ev) {
  const b = $('#cu-badge');
  cuBadge.deviceId = ev.deviceId;
  const who = currentIdentity().name || t('Sara');
  const where = cuSettings.names[ev.deviceId] || t('your computer');
  if (ev.paused !== undefined) cuBadge.paused = ev.paused === true;
  b.classList.toggle('paused', cuBadge.paused);
  const tx = $('#cu-badge-text');
  tx.dataset.raw = '';
  tx.textContent = cuBadge.paused
    ? t('Paused: you took over in her browser on {computer}. Press Resume there to let her go on.', { computer: where })
    : t('{name} is working in her browser on {computer}: {doing}', { name: who, computer: where, doing: (CU_DOING[ev.op] ?? (() => t('Working')))() });
  b.hidden = false;
  clearTimeout(cuBadge.timer);
  // No news for 30 seconds (and not paused): she's done there for now.
  if (!cuBadge.paused) cuBadge.timer = setTimeout(hideBadge, 30_000);
}
$('#cu-badge-stop').addEventListener('click', async () => {
  const id = cuBadge.deviceId;
  hideBadge();
  hideLiveView();
  if (state.streaming) $('#stop')?.click();
  if (id) await api(`/hands/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }).catch(() => {});
});

// The live view: the newest frame of the computer she is using for this conversation (memory only on the server).
const liveView = { deviceId: '', n: 0, timer: 0, busy: false };
function hideLiveView() {
  $('#cu-live').hidden = true;
  liveView.deviceId = '';
  liveView.n = 0;
  clearTimeout(liveView.timer);
}
async function onComputerEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const mine = !ev.conversationId || ev.conversationId === state.currentId;
  if (ev.stopped || ev.state === 'offline') {
    if (ev.deviceId === cuBadge.deviceId) hideBadge();
    if (ev.deviceId === liveView.deviceId) hideLiveView();
    if (!document.querySelector('[data-page="co-computer"]').hidden) void loadComputer();
    return;
  }
  if (ev.state === 'online' && !document.querySelector('[data-page="co-computer"]').hidden) void loadComputer();
  if ((ev.working && mine) || (ev.paused !== undefined && (mine || ev.deviceId === cuBadge.deviceId))) showBadge(ev);
  if (!ev.frame || ev.conversationId !== state.currentId || liveView.busy) return;
  liveView.busy = true;
  try {
    const f = await api(`/computer/frame/${encodeURIComponent(ev.deviceId)}?after=${ev.deviceId === liveView.deviceId ? liveView.n : 0}`);
    if (!f.image) return;
    liveView.deviceId = ev.deviceId;
    liveView.n = f.n;
    $('#cu-live-img').src = f.image;
    $('#cu-live-text').textContent = t('Sara is using the Sara browser on your computer.');
    $('#cu-live').hidden = false;
    clearTimeout(liveView.timer);
    // No new picture for two minutes: the view folds away (the last frame is in Runs).
    liveView.timer = setTimeout(hideLiveView, 120_000);
  } catch {
    /* the next frame tries again */
  } finally {
    liveView.busy = false;
  }
}
$('#cu-live-stop').addEventListener('click', async () => {
  const id = liveView.deviceId;
  hideLiveView();
  if (state.streaming) $('#stop')?.click();
  if (id) await api(`/hands/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }).catch(() => {});
});
$('#cu-live-big').addEventListener('click', () => {
  const big = $('#cu-live').classList.toggle('big');
  $('#cu-live-big').textContent = big ? t('Smaller') : t('Bigger');
});

// ---------- Phase 68: several Saras in one app ----------
// The desktop and phone apps keep a list of Sara servers, each with its own sign-in (kept by the
// app, never by this page). The page only shows the list and asks the app to switch, add, rename
// or remove; it never sees another server's sign-in.
// `var` and a function: boot() can ask before this part of the file has run.
var nativeServersMade;
function nativeServersApi() {
  if (nativeServersMade !== undefined) return nativeServersMade;
  nativeServersMade = makeNativeServers();
  return nativeServersMade;
}
function makeNativeServers() {
  const d = window.SaraDesktop;
  const ph = window.SaraPhone;
  const parse = (r) => (typeof r === 'string' ? JSON.parse(r) : r);
  if (d?.call) {
    return {
      kind: 'desktop',
      list: () => d.call('servers'),
      use: (id) => d.call('useServer', { id }),
      add: () => d.call('addServer'),
      remove: (id) => d.call('removeServer', { id }),
      rename: (id, name) => d.call('renameServer', { id, name }),
      report: (name) => d.call('serverName', { name }),
    };
  }
  if (ph?.servers) {
    return {
      kind: 'phone',
      list: async () => parse(ph.servers()),
      use: async (id) => ph.useServer(id),
      add: async () => ph.addServer(),
      remove: async (id) => ph.removeServer(id),
      rename: async (id, name) => ph.renameServer(id, name),
      report: async (name) => ph.serverName?.(name),
    };
  }
  return null;
}
let serversRenaming = '';

/** Shows the header switcher once there's more than one Sara in this app. */
async function renderServers() {
  if (!nativeServersApi()) return;
  const r = await Promise.race([nativeServersApi().list(), new Promise((res) => setTimeout(() => res(null), 3000))]).catch(() => null);
  const list = Array.isArray(r?.servers) ? r.servers : [];
  const cur = list.find((x) => x.active) ?? list[0];
  $('#server-btn').hidden = list.length < 2;
  if (cur) $('#server-btn-name').textContent = `${cur.emoji ? `${cur.emoji} ` : ''}${cur.name}`;
  const ul = $('#servers-list');
  ul.replaceChildren(
    ...list.map((x) => {
      const li = el('li');
      const who = el('span', '', `${x.emoji ? `${x.emoji} ` : ''}${x.name}`);
      const where = el('span', 'muted small', x.host ?? '');
      if (x.host) where.title = x.host; // the whole address when a phone shortens it
      li.append(who, where);
      if (x.active) li.append(el('span', 'badge', t('In use')));
      else li.append(btn(t('Switch'), async () => {
        $('#servers-status').textContent = t('Switching…');
        await nativeServersApi().use(x.id);
      }, false));
      // UI cleanup (wave 2): Rename and Remove wait behind ⋯, so each row has one clear button.
      const box = el('span', 'tidy-overflow');
      box.append(btn(t('Rename'), () => {
        serversRenaming = x.id;
        $('#servers-name').value = x.name;
        $('#servers-rename-row').hidden = false;
        $('#servers-name').focus();
      }));
      const rm = btn(t('Remove'), async () => {
        if (!confirm(t('Remove {name} from this app? It signs out of that server only; its conversations stay on it.', { name: x.name }))) return;
        await nativeServersApi().remove(x.id);
        await renderServers();
      });
      rm.classList.add('danger-text');
      box.append(rm);
      const more = el('button', 'ghost small tidy-more-btn', '⋯');
      more.type = 'button';
      more.title = t('More actions');
      more.setAttribute('aria-label', t('More actions'));
      more.dataset.moreId = `srv-${x.id}`;
      overflowMenu(more, box);
      li.append(more, box);
      return li;
    }),
  );
  if (cur) {
    $('#servers-computer').textContent = nativeServersApi().kind === 'desktop'
      ? t('{name} (the server in use) can use this computer: notifications, the microphone in calls and the files you pick. They follow the server you switch to, one at a time.', { name: cur.name })
      : t('Notifications come from every server here; tapping one opens the right one. The microphone, camera and location go only to the one in use ({name}).', { name: cur.name });
  }
}
function openServers() {
  if (!nativeServersApi()) return;
  $('#servers-rename-row').hidden = true;
  $('#servers-status').textContent = '';
  void renderServers();
  $('#servers-dialog').showModal();
}
async function serversSignedIn(name) {
  if (!nativeServersApi()) return;
  if (name) await Promise.resolve(nativeServersApi().report(name)).catch(() => {});
  await renderServers();
}
if (nativeServersApi()) {
  $('#server-btn').addEventListener('click', openServers);
  $('#servers-add').addEventListener('click', () => {
    $('#servers-dialog').close();
    void nativeServersApi().add();
  });
  $('#servers-rename-save').addEventListener('click', async () => {
    const name = $('#servers-name').value.trim();
    if (!name || !serversRenaming) return;
    await nativeServersApi().rename(serversRenaming, name);
    $('#servers-rename-row').hidden = true;
    saved($('#servers-dialog'));
    await renderServers();
  });
  // The app calls this when its list changed (added from a pairing link, renamed elsewhere).
  window.saraServersChanged = () => void renderServers();
}

// Offer the desktop app (web browser on a Mac or Windows computer, when the server has the file).
async function loadDesktopGet() {
  const box = $('#desktop-get');
  const ua = navigator.userAgent;
  const kind = /Windows/.test(ua) ? 'windows' : /Macintosh|Mac OS X/.test(ua) && navigator.maxTouchPoints < 2 ? 'mac' : '';
  if (!kind || window.SaraDesktop || /\bSaraPhone\/\d/.test(ua)) return void (box.hidden = true);
  const apps = await api('/desktop-apps').catch(() => null);
  const f = apps?.[kind];
  if (!f) return void (box.hidden = true);
  const mb = Math.max(1, Math.round(f.size / 1048576));
  $('#desktop-get-link').href = `/api/desktop-apps/${kind}`;
  $('#desktop-get-link').textContent = kind === 'mac' ? t('Download for Mac') : t('Download for Windows');
  $('#desktop-get-how').textContent = kind === 'mac'
    ? t(`${mb} MB · open it and drag Sara to Applications`)
    : t(`${mb} MB · open it and Sara installs herself (no admin needed)`);
  box.hidden = false;
}

// ---------- Phase 37: things to do together ----------
const together = { data: null, list: 'music', pending: null };
async function openTogether() {
  together.data = await api('/together').catch(() => null);
  if (!together.data) return;
  $('#tog-topic-row').hidden = true;
  pickCards($('#tog-activities'), together.data.activities, null, (id) => pickActivity(id));
  renderTogetherLists();
  $('#tog-status').textContent = '';
  $('#together-dialog').showModal();
}
function renderTogetherLists() {
  const d = together.data;
  $('#tog-tabs').replaceChildren(
    ...d.lists.map((l) => {
      const b = el('button', `tab${l.id === together.list ? ' active' : ''}`, `${l.emoji} ${t(l.label)}`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(l.id === together.list));
      b.addEventListener('click', () => {
        together.list = l.id;
        renderTogetherLists();
      });
      return b;
    }),
  );
  const cur = d.lists.find((l) => l.id === together.list);
  $('#tog-new').placeholder = ({ music: t('e.g. Clair de Lune – Debussy'), reading: t('e.g. The Hobbit – Tolkien'), watch: t('e.g. The Bear') })[together.list] ?? '';
  const items = d.items.filter((x) => x.list === together.list);
  $('#tog-items').replaceChildren(
    ...(items.length
      ? items.map((x) => {
          const li = el('li', x.doneAt ? 'done' : '');
          const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(x.doneAt) });
          cb.title = t('Done');
          cb.addEventListener('change', async () => {
            together.data = await api(`/together/items/${x.id}`, { method: 'PUT', body: { done: cb.checked } });
            renderTogetherLists();
          });
          const who = el('span', 'muted small', x.addedBy === 'her' ? t('her pick') : '');
          const del = el('button', 'ghost small', '✕');
          del.type = 'button';
          del.title = t('Remove');
          del.addEventListener('click', async () => {
            together.data = await api(`/together/items/${x.id}`, { method: 'DELETE' });
            renderTogetherLists();
          });
          li.append(cb, el('span', 'tg-title', x.title), who, del);
          return li;
        })
      : [el('li', 'muted small', t(`Nothing on ${cur?.label ?? 'this list'} yet.`))]),
  );
}
$('#tog-add').addEventListener('click', async () => {
  const title = $('#tog-new').value.trim();
  if (!title) return;
  try {
    together.data = await api('/together/items', { method: 'POST', body: { list: together.list, title } });
    $('#tog-new').value = '';
    renderTogetherLists();
  } catch (err) {
    $('#tog-status').textContent = err.message;
  }
});
$('#tog-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#tog-add').click();
  }
});
function pickActivity(id) {
  const act = together.data.activities.find((x) => x.id === id);
  if (!act) return;
  markCard($('#tog-activities'), id);
  together.pending = act;
  if (act.topic) {
    $('#tog-topic-label').firstChild.textContent = `${t(act.topic)} `;
    $('#tog-topic').value = '';
    $('#tog-topic-row').hidden = false;
    $('#tog-topic').focus();
  } else void startActivity(act, '');
}
$('#tog-topic-go').addEventListener('click', () => together.pending && void startActivity(together.pending, $('#tog-topic').value.trim()));
$('#tog-topic').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#tog-topic-go').click();
  }
});
async function startActivity(act, topic) {
  if (state.streaming) return ($('#tog-status').textContent = t('Wait for her reply first.'));
  if (act.id === 'watch-along' && !topic) return ($('#tog-status').textContent = t("Say what you're watching first."));
  if (!state.currentId) {
    const conv = await api('/conversations', { method: 'POST', body: {} });
    state.conversations.unshift(conv);
    state.currentId = conv.id;
    state.conv = conv;
    renderConvSummary();
    $('#chat-title').textContent = conv.title;
    renderConversations();
  }
  try {
    const r = await api(`/conversations/${state.currentId}/together`, { method: 'POST', body: { kind: act.id, topic } });
    state.conv.together = r.activity;
  } catch (err) {
    return ($('#tog-status').textContent = err.message);
  }
  $('#together-dialog').close();
  renderTogetherBar();
  send(act.id === 'watch-along' ? `I'm watching ${topic}. Watch along with me?` : topic && act.id === 'trivia' ? `Let's do some trivia about ${topic}!` : topic && act.id === 'story' ? `Let's write a story together: ${topic}.` : act.start);
}
function renderTogetherBar() {
  const a = state.conv?.together;
  const act = a && together.data?.activities.find((x) => x.id === a.kind);
  $('#together-bar').hidden = !a;
  if (a) $('#together-now').textContent = `${act?.emoji ?? '🎲'} ${act ? t(act.label) : t('Doing something together')}${a.topic ? `: ${a.topic}` : ''}`;
}
$('#together').addEventListener('click', () => void openTogether());
$('#together-end').addEventListener('click', async () => {
  if (!state.currentId) return;
  await api(`/conversations/${state.currentId}/together`, { method: 'DELETE' }).catch(() => {});
  state.conv.together = null;
  renderTogetherBar();
});

// ---------- Phase 39: the team she leads ----------
const team = { data: null, current: null, timer: null, hModel: null };
const STATUS_WORDS = { planning: 'Planning', running: 'Working', waiting: 'Waiting for you', done: 'Done', failed: 'Problems', stopped: 'Stopped', limit: 'Hit a limit', interrupted: 'Interrupted', waiting: 'Waiting', skipped: 'Skipped' };
const chip = (s) => el('span', `chip ${s}`, t(STATUS_WORDS[s] ?? s));
async function openTeam(taskId) {
  await loadTeam();
  if (taskId) team.current = taskId;
  else team.current ??= team.data?.tasks[0]?.id ?? null;
  await renderTeamDetail();
  if (!$('#team').open) $('#team').showModal();
}
async function loadTeam() {
  team.data = await api('/team').catch(() => null);
  if (!team.data) return;
  const d = team.data;
  $('#team-tasks').replaceChildren(
    ...(d.tasks.length
      ? d.tasks.map((tk) => {
          const li = el('li');
          const b = el('button');
          b.type = 'button';
          b.setAttribute('aria-current', String(tk.id === team.current));
          const top = el('span', 'who');
          top.append(el('strong', '', `#${tk.id}`), chip(tk.status));
          b.append(top, el('span', 'goal', tk.workflow?.issue ? `${tk.workflow.issue.repo}#${tk.workflow.issue.number}: ${tk.workflow.issue.title}` : tk.goal));
          b.addEventListener('click', async () => {
            team.current = tk.id;
            for (const x of $('#team-tasks').querySelectorAll('button')) x.setAttribute('aria-current', 'false');
            b.setAttribute('aria-current', 'true');
            await renderTeamDetail();
          });
          li.append(b);
          return li;
        })
      : [emptyState('👥', t('No team tasks yet.'), 'li')]),
  );
  // With no tasks the list and the detail column are one empty card (UI cleanup, wave 2).
  $('#team-tasks').closest('.team-cols')?.classList.toggle('is-empty', !d.tasks.length);
  // Helpers, the add form and limits.
  $('#team-helpers').replaceChildren(
    ...d.helpers.map((h) => {
      const c = el('div', 'card');
      c.append(el('strong', '', `${h.emoji} ${h.custom ? h.name : t(h.name)}`), el('span', 'muted', t(h.blurb)), el('small', 'muted', `${t('Model')}: ${h.modelLabel ?? t('default')} · ${t('Tools')}: ${h.tools.join(', ')}`));
      if (h.custom) {
        const del = el('button', 'ghost small del', '✕');
        del.type = 'button';
        del.title = t('Remove this helper');
        del.addEventListener('click', async () => {
          await api('/team/settings', { method: 'PUT', body: { helpers: d.custom.filter((x) => x.id !== h.id) } });
          await loadTeam();
        });
        c.append(del);
      }
      return c;
    }),
  );
  const role = $('#team-h-role');
  if (!role.options.length) role.append(...d.roles.map((r) => new Option(`${r.emoji} ${t(r.id[0].toUpperCase() + r.id.slice(1))}`, r.id)));
  const showTools = () => {
    const r = d.roles.find((x) => x.id === role.value);
    $('#team-h-tools').replaceChildren(
      ...d.tools
        .filter((n) => !/^(remind|todo|note|team_|change_outfit|shared_list|send_photo)/.test(n))
        .map((n) => {
          const l = el('label');
          const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value: n, checked: r?.tools.includes(n) });
          l.append(cb, document.createTextNode(n));
          return l;
        }),
    );
  };
  role.onchange = showTools;
  showTools();
  if (!team.hModel) {
    team.hModel = modelPick(t('Same as its job'), null);
    $('#team-h-model').replaceChildren(team.hModel.sel, team.hModel.chooser.el);
  }
  $('#team-l-min').value = String([15, 30, 60, 120].reduce((b, v) => (Math.abs(v - d.limits.minutes) < Math.abs(b - d.limits.minutes) ? v : b), 30));
  $('#team-l-tok').value = String([100000, 400000, 1000000, 3000000].reduce((b, v) => (Math.abs(v - d.limits.tokens) < Math.abs(b - d.limits.tokens) ? v : b), 400000));
  // Team budgets (wave 3): pick-lists; a limit saved earlier that isn't in the list is added to it.
  const usdSel = $('#team-l-usd');
  const usd = d.limits.usd ? String(d.limits.usd) : '';
  if (usd && ![...usdSel.options].some((o) => o.value === usd)) usdSel.append(new Option(`$${usd}`, usd));
  usdSel.value = usd;
  $('#team-dot').hidden = !d.tasks.some((tk) => tk.status === 'running' || tk.status === 'planning');
}
async function renderTeamDetail() {
  const box = $('#team-detail');
  if (!team.current) return box.replaceChildren(...(team.data?.tasks.length ? [el('p', 'muted small', t('Pick a task from the list, or start one above.'))] : []));
  let v;
  try {
    v = await api(`/team/${team.current}`);
  } catch (err) {
    return box.replaceChildren(el('p', 'muted small', err.message));
  }
  const tk = v.task;
  const live = tk.status === 'running' || tk.status === 'planning' || tk.status === 'waiting';
  const names = new Map((team.data?.helpers ?? []).map((h) => [h.id, h]));
  names.set('lead', { name: state.persona?.name || $('.side-her')?.textContent || 'Sara', emoji: '⭐' });
  const head = el('div', 'head');
  head.append(el('strong', '', `#${tk.id}`), chip(tk.status), el('small', 'muted', `${t('Reading and writing used: about {pct}% of its limit', { pct: Math.min(100, Math.round((100 * tk.tokens) / Math.max(1, tk.limits.tokens))) })}${tk.limits.usd ? ` · ${t('spending limit {usd}', { usd: `$${tk.limits.usd.toFixed(2)}` })}` : ''} · ${t('time limit {n} min', { n: tk.limits.minutes })}`));
  // Phase 52: what it used (real counts where the models report them), and carrying on past a limit.
  if (tk.usage?.tokens) head.append(el('small', 'muted team-usage', usageWords(tk.usage)));
  if (tk.status === 'limit') head.append(continueButton(`/team/${tk.id}/continue`, () => void renderTeamDetail()));
  if (live) {
    const stop = el('button', 'ghost small', t('Stop the task'));
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      await api(`/team/${tk.id}/stop`, { method: 'POST' });
      void renderTeamDetail();
    });
    head.append(stop);
  }
  // An issue task shows the issue; the full task text (with its instructions) folds away.
  let goal = el('p', 'small', tk.goal);
  if (tk.workflow?.issue) {
    const i = tk.workflow.issue;
    goal = el('div');
    const head = el('p', 'small');
    head.append(document.createTextNode(`${t('GitHub issue')} `), Object.assign(document.createElement('a'), { href: i.url, target: '_blank', rel: 'noopener', textContent: `${i.repo}#${i.number}` }), document.createTextNode(`: ${i.title}`));
    const full = document.createElement('details');
    full.className = 'goal-full';
    full.append(el('summary', '', t('Full task')), el('p', '', tk.goal));
    goal.append(head, full);
  }
  // Approvals waiting for you.
  const approvals = v.approvals.map((ap) => {
    // Phase 80: a helper's command tried in a sandbox copy: Apply / Discard / Run for real.
    if (ap.sandbox) {
      const row = el('div', 'team-approval');
      row.append(el('span', '', `✋ ${ap.helper}`));
      row.append(
        teamSandboxRow(ap, async (approved, how) => {
          await api(`/approvals/${ap.id}`, { method: 'POST', body: { approved, how } }).catch(() => {});
          void renderTeamDetail();
        }),
      );
      return row;
    }
    const row = el('div', 'team-approval');
    row.append(el('span', '', `✋ ${ap.helper} ${t('wants to')}: ${ap.summary}`));
    for (const [label, yes] of [[t('Allow'), true], [t('Decline'), false]]) {
      const b = el('button', yes ? 'small' : 'ghost small', label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        await api(`/approvals/${ap.id}`, { method: 'POST', body: { approved: yes } }).catch(() => {});
        void renderTeamDetail();
      });
      row.append(b);
    }
    return row;
  });
  // Phase 40: a workflow waiting at a checkpoint (the plan; opening the pull request).
  if (tk.checkpoint && tk.status === 'waiting') {
    const cp = el('div', 'team-checkpoint');
    cp.append(el('strong', '', tk.checkpoint.kind === 'plan' ? `✋ ${t('Her plan: go on?')}` : `✋ ${t('Open the pull request?')}`), el('pre', '', tk.checkpoint.text));
    const acts = el('div', 'acts');
    for (const [label, d, cls] of [[t('Go on'), 'go', 'small'], [t("Go on, don't ask again"), 'skip', 'ghost small'], [t('Stop'), 'stop', 'ghost small']]) {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        await api(`/team/${tk.id}/checkpoint`, { method: 'POST', body: { decision: d } }).catch((err) => alert(err.message));
        void renderTeamDetail();
      });
      acts.append(b);
    }
    cp.append(acts);
    approvals.unshift(cp);
  }
  if (tk.workflow?.prUrl) {
    const link = Object.assign(document.createElement('a'), { href: tk.workflow.prUrl, target: '_blank', rel: 'noopener', textContent: `🔀 ${t('The pull request')}` });
    approvals.unshift(link);
  }
  const steps = el('ol', 'team-steps');
  for (const s of tk.steps) {
    const h = names.get(s.helper);
    const li = el('li', s.status);
    const who = el('div', 'who');
    who.append(el('strong', '', `${h?.emoji ?? '•'} ${h?.name ?? s.helper}`), el('span', '', s.title), chip(s.status));
    li.append(who);
    if (s.because) li.append(el('span', 'because', `↩ ${t(s.because)}`));
    if (s.report) {
      const det = document.createElement('details');
      det.open = s.status === 'failed';
      det.append(el('summary', 'small', t('Report')), el('div', 'report', s.report));
      if (s.unverified.length) det.append(el('small', 'muted', `⚠ ${t('Left out (no receipt)')}: ${s.unverified.join(' ')}`));
      li.append(det);
    }
    if (s.receipts.length) {
      const ul = el('ul', 'rc');
      for (const r of s.receipts.slice(-8)) {
        const code = /^\[(exit code \w+)/.exec(r.output)?.[1];
        const bad = r.status !== 'ok' || (code && code !== 'exit code 0');
        ul.append(el('li', bad ? 'bad' : '', `${r.summary}${code ? ` → ${code}` : r.status !== 'ok' ? ` → ${r.status}` : ''}`));
      }
      li.append(ul);
    }
    if (live && (s.status === 'running' || s.status === 'waiting')) {
      const acts = el('div', 'acts');
      const msg = el('button', 'ghost small', t('Message…'));
      msg.type = 'button';
      msg.title = t('Redirect this helper: your message reaches it before its next move.');
      msg.addEventListener('click', () => {
        const row = el('div', 'add-row');
        const inp = Object.assign(document.createElement('input'), { maxLength: 2000, placeholder: t('e.g. Use the existing CSS variables') });
        const send = el('button', 'small', t('Send'));
        send.type = 'button';
        send.addEventListener('click', async () => {
          if (!inp.value.trim()) return;
          await api(`/team/${tk.id}/steps/${s.id}/message`, { method: 'POST', body: { text: inp.value } }).catch((err) => alert(err.message));
          row.remove();
        });
        row.append(inp, send);
        li.append(row);
        inp.focus();
      });
      acts.append(msg);
      if (s.status === 'running') {
        const stop = el('button', 'ghost small', t('Stop this helper'));
        stop.type = 'button';
        stop.addEventListener('click', () => api(`/team/${tk.id}/steps/${s.id}/stop`, { method: 'POST' }));
        acts.append(stop);
      }
      li.append(acts);
    }
    steps.append(li);
  }
  const log = document.createElement('details');
  log.open = live;
  const ul = el('ul', 'team-log');
  for (const l of v.log.slice(-40)) ul.append(el('li', '', `${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${l.text}`));
  log.append(el('summary', 'small', t('Log')), ul);
  const parts = [head, goal, ...approvals, steps, log];
  if (tk.report && !live) {
    const open = el('button', 'ghost small', t('Open the conversation'));
    open.type = 'button';
    open.addEventListener('click', async () => {
      $('#team').close();
      await openConversation(tk.conversationId);
    });
    parts.splice(2, 0, open);
  }
  box.replaceChildren(...parts);
  if (live) ul.scrollTop = ul.scrollHeight;
}
$('#open-team').addEventListener('click', () => void openTeam());
$('#team-start').addEventListener('click', async () => {
  const goal = $('#team-goal').value.trim();
  if (goal.length < 8) return ($('#team-msg').textContent = t('Describe the task in a sentence or two.'));
  $('#team-start').disabled = true;
  try {
    // Phase 52: an optional budget for this task (tokens and/or dollars), picked from two lists (empty = the usual limits).
    const limits = { ...($('#team-budget-tok').value ? { tokens: Number($('#team-budget-tok').value) } : {}), ...($('#team-budget-usd').value ? { usd: Number($('#team-budget-usd').value) } : {}) };
    const tk = await api('/team', { method: 'POST', body: { goal, ...(Object.keys(limits).length ? { limits } : {}), ...(state.currentId && state.conv?.mode === 'coding' ? { conversationId: state.currentId } : {}) } });
    $('#team-goal').value = '';
    $('#team-budget-tok').value = '';
    $('#team-budget-usd').value = '';
    $('#team-msg').textContent = t('Started. She is making a plan…');
    team.current = tk.id;
    await loadTeam();
    await renderTeamDetail();
  } catch (err) {
    $('#team-msg').textContent = err.message;
  }
  $('#team-start').disabled = false;
});
$('#team-h-add').addEventListener('click', async () => {
  const name = $('#team-h-name').value.trim();
  if (!name) return ($('#team-msg').textContent = t('Give the helper a name.'));
  const tools = [...$('#team-h-tools').querySelectorAll('input:checked')].map((x) => x.value);
  const helper = { name, role: $('#team-h-role').value, instructions: $('#team-h-instr').value.trim(), tools, ...(team.hModel?.value() ? { model: team.hModel.value() } : {}) };
  try {
    await api('/team/settings', { method: 'PUT', body: { helpers: [...(team.data?.custom ?? []), helper] } });
    $('#team-h-name').value = '';
    $('#team-h-instr').value = '';
    $('#team-msg').textContent = `${t('Added')} ${name}.`;
    await loadTeam();
  } catch (err) {
    $('#team-msg').textContent = err.message;
  }
});
$('#team-l-save').addEventListener('click', async () => {
  await api('/team/settings', { method: 'PUT', body: { limits: { minutes: Number($('#team-l-min').value), tokens: Number($('#team-l-tok').value), usd: $('#team-l-usd').value ? Number($('#team-l-usd').value) : null } } });
  $('#team-msg').textContent = t('Saved');
});
// Live: refresh the open window; a dot on the Team button while one runs; ask when a helper waits for an OK.
function onTeamEvent(task) {
  $('#team-dot').hidden = !(task.status === 'running' || task.status === 'planning');
  if (task.approvals && !$('#team').open) notify(t('Your team needs an OK'), t('Open Team to allow or decline the next step.'));
  if (!$('#team').open) return;
  clearTimeout(team.timer);
  team.timer = setTimeout(async () => {
    await loadTeam();
    if (team.current === task.id || !team.current) {
      team.current = task.id;
      await renderTeamDetail();
    }
  }, 400);
}

// ---------- Phase 40: coding projects, issues → workflows, checkpoints ----------
async function loadCodeProjects(fresh = false) {
  const sel = $('#pj-ws');
  if (!sel.options.length) {
    const names = [...new Set(['main', ...(state.conversations ?? []).map((c) => c.workspace).filter(Boolean)])];
    sel.replaceChildren(...names.map((n) => new Option(n, n)));
  }
  const ws = sel.value || 'main';
  const box = $('#pj-list');
  box.replaceChildren(el('p', 'muted small', t('Looking…')));
  let v;
  try {
    v = await api(`/code-projects?workspace=${encodeURIComponent(ws)}${fresh ? '&fresh=1' : ''}`);
  } catch (err) {
    return box.replaceChildren(el('p', 'muted small', err.message));
  }
  if (!v.projects.length) return box.replaceChildren(el('p', 'muted small', t('No code here yet. When a repository is in this workspace (cloned, or made in a coding conversation), she learns it.')));
  box.replaceChildren(
    ...v.projects.map((k) => {
      const f = k.facts;
      const card = el('div', 'pj-card');
      card.append(el('h4', '', `${f.name}${k.path !== '.' ? ` (${k.path})` : ''}`));
      if (f.repo) card.append(el('span', 'muted', `GitHub ${f.repo}${f.defaultBranch ? ` · ${f.defaultBranch}` : ''}`));
      if (f.languages.length) card.append(el('span', '', `${t('Languages')}: ${f.languages.join(', ')}`));
      const cmds = Object.entries(f.commands);
      if (cmds.length) {
        const line = el('span', '', `${t('Commands')}: `);
        cmds.forEach(([n, c], i) => line.append(document.createTextNode(`${i ? ' · ' : ''}${n} `), el('code', '', c)));
        card.append(line);
      }
      if (f.conventions.length) card.append(el('span', 'muted', `${t('Conventions')}: ${f.conventions.join('; ')}`));
      const notes = el('ul', 'pj-notes');
      for (const n of k.notes) {
        const li = el('li');
        const del = el('button', 'ghost small', '✕');
        del.type = 'button';
        del.title = t('Remove this note');
        del.addEventListener('click', async () => {
          await api(`/code-projects/notes/${n.id}`, { method: 'DELETE' });
          void loadCodeProjects();
        });
        li.append(el('span', '', `(${t(n.kind)}) ${n.text}`), del);
        notes.append(li);
      }
      const add = el('div', 'add-row');
      const kind = document.createElement('select');
      kind.append(...['decision', 'convention', 'command', 'note'].map((x) => new Option(t(x[0].toUpperCase() + x.slice(1)), x)));
      const inp = Object.assign(document.createElement('input'), { maxLength: 500, placeholder: t('e.g. Run npm run build before the tests') });
      const go = el('button', 'ghost small', t('Add note'));
      go.type = 'button';
      go.addEventListener('click', async () => {
        if (!inp.value.trim()) return;
        await api('/code-projects/notes', { method: 'POST', body: { workspace: ws, path: k.path, kind: kind.value, text: inp.value } });
        void loadCodeProjects();
      });
      add.append(kind, inp, go);
      card.append(el('strong', 'small', t('Her notes')), notes, add);
      return card;
    }),
  );
}
$('#pj-ws').addEventListener('change', () => loadCodeProjects());
$('#pj-refresh').addEventListener('click', () => loadCodeProjects(true));
// Phase 86: "Before you ship": red-team the chosen project (the plan with its budget comes first).
$('#pj-redteam').addEventListener('click', () => void openRedTeam({ workspace: $('#pj-ws').value || 'main' }));
document.addEventListener('click', (e) => {
  if (e.target.closest?.('#settings-nav-list [data-page="ab-projects"]')) void loadCodeProjects();
});

async function loadTeamIssues() {
  const list = $('#team-issues');
  list.replaceChildren(el('li', 'muted small', t('Looking…')));
  const w = await api('/github-watch').catch((err) => ({ error: err.message, issues: [], repos: [] }));
  if (!w.issues?.length) return list.replaceChildren(el('li', 'muted small', w.error ?? (w.repos?.length ? t('No open issues.') : t('Watch a repository in Settings → GitHub to see its issues here, or type one below.'))));
  list.replaceChildren(
    ...w.issues.slice(0, 30).map((i) => {
      const li = el('li');
      const go = el('button', 'small', t('Start'));
      go.type = 'button';
      go.addEventListener('click', () => startIssue(i.repo, i.number));
      li.append(el('span', '', `${i.repo}#${i.number} ${i.title}`), go);
      return li;
    }),
  );
}
async function startIssue(repo, number) {
  $('#team-msg').textContent = t('Getting the repository ready…');
  try {
    const tk = await api('/team/from-issue', { method: 'POST', body: { repo, number, checkpoints: $('#team-cp').checked, pr: $('#team-pr').checked } });
    $('#team-msg').textContent = t('Started. She is making a plan…');
    team.current = tk.id;
    await loadTeam();
    await renderTeamDetail();
  } catch (err) {
    $('#team-msg').textContent = err.message;
  }
}
$('#team-issue').addEventListener('toggle', () => $('#team-issue').open && loadTeamIssues());
$('#team-i-go').addEventListener('click', () => {
  const repo = $('#team-i-repo').value.trim();
  const n = Number($('#team-i-num').value);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !(n > 0)) return ($('#team-msg').textContent = t('Type the repository as owner/name and the issue number.'));
  void startIssue(repo, n);
});
