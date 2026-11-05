// The short tours and the tour offer (moved out of app.js in PL2d, 2.61.3; code moved only,
// docs/design/POLISH2.md C1). The steps are made when the app starts, as before, so their words
// are in the language the app started in; tour.js draws them.
import { t } from './naming.js';
import { startTour, tourRunning } from './tour.js';
import { normPath, offerText, tourFor } from './first-run.js';
import { revealNav, setMore } from './nav.js';
import { showHeadChips } from './look.js';

const $ = (sel) => document.querySelector(sel);
/** What app.js lends this module (el, firstRun, isMember, openSettings, openTeam, openToday, showSettingsTab, state). */
let ctx = null;
const openSettings = (...a) => ctx.openSettings(...a);
const showSettingsTab = (...a) => ctx.showSettingsTab(...a);
const openToday = (...a) => ctx.openToday(...a);
const isMember = (...a) => ctx.isMember(...a);
const openTeam = (...a) => ctx.openTeam(...a);
const el = (...a) => ctx.el(...a);
let state = null;
let firstRun = null;

// ---------- Phase 41: the Help window and short tours ----------
export const closeOpenDialogs = () => {
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
/** The tours by name (made by initTours). */
let TOURS = {};
function makeTours() {
  return {
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
      { before: navStep('#open-settings'), sel: '#open-settings', title: t('Settings'), text: t('Everything is in groups: Her, You, Models, Chat apps, Add-ons, Coding, Connections, Data & health. Every setting has a ? that explains it.') },
      { before: navStep('#open-help'), sel: '#open-help', title: t('Help'), text: t('Come back here for these tours and the guide. Or just ask her how something works.') },
    ],
    // Phase 114 (PL1b, F12, docs/design/POLISH.md §5): the two short tours offered after her first reply.
    company: [
      { before: sidebar(false), sel: '#input', title: t('Talk to her'), text: t('Type here, or use the microphone. The + button attaches a photo or a file, or starts something to do together.') },
      { before: sidebar(false), sel: '#her-face', title: t('Her panel'), text: t('Her face opens her panel: her mood, what she is doing right now, approvals waiting, your day and what she remembered for this reply. On a phone it slides up from the bottom.') },
      { when: () => !phoneWidth(), before: navStep('#open-today'), sel: '#open-today', title: t('Today'), text: t('Your home screen: the weather, your day, the Planner, what she remembered, photos, background work and your home, as tiles. Her face at the top of the list opens it too.') },
      { when: () => phoneWidth(), before: sidebar(false), sel: '#bb-today', title: t('Today'), text: t('Your home screen: the weather, your day, the Planner, what she remembered, photos, background work and your home, as tiles. Her face at the top of the list opens it too.') },
      { before: navStep('#open-planner'), sel: '#open-planner', title: t('Planner'), text: t('To-dos, reminders and notes. You can also just ask her: "remind me to call Mom at 5".') },
      { before: navStep('#open-memory'), sel: '#open-memory', title: t('Memory'), text: t('What she remembers about you. Look through it, correct it or make her forget something.') },
      { before: settingsAt('her-character'), sel: '#settings-nav-list [data-page="her-character"]', title: t('Make her yours'), text: t('Her name, personality, look and voice are under Settings → Her. Every setting has a ? that explains it.') },
    ],
    coding: [
      { before: async () => { sidebar(false)(); await showHeadChips(); }, sel: '#conv-settings-btn', title: t('This conversation'), text: t('The folder, model and mode of this conversation. Switch the mode to Coding for project work: she reads, edits and runs things in that folder.') },
      { before: sidebar(false), sel: '#messages', title: t('Her steps'), text: t('Under each reply a step line says what she did: files read, commands run, tests. Open it for every step, and Show the run for the whole turn.') },
      // Phase 128 (PL2b, N27): one stop for the / menu.
      { before: sidebar(false), sel: '#input', title: t('Type / for commands'), text: t('Type / at the start of the message box: /goal, /loop, /compact, /tools and more, each with one line on what it does.') },
      { when: () => !isMember(), before: settingsAt('ab-tools'), sel: '#tool-list', title: t('Ask me first'), text: t('For each tool: Ask me first, Always allowed or Never. Commands run in a sandbox when one is set up, and her approvals wait in the chat and in her panel.') },
      { before: navStep('#open-team'), sel: '#open-team', title: t('Team'), text: t('For bigger jobs she leads helpers that plan, build, test and review.') },
      { before: navStep('#open-findings'), sel: '#open-findings', title: t('Findings'), text: t('Her security pass adds what it finds here after coding turns, each with a fix she can make on its own branch.') },
      { when: () => !isMember(), before: settingsAt('ab-projects'), sel: '#pj-work-dials', title: t('Coding projects'), text: t('Your project folders, how she is while you code, the sandbox and the security pass, in one page.') },
    ],
    studio: [
      { sel: '#st-wizard', title: t('Create your companion'), text: t('The easiest way: a guided setup with cards, about 5 minutes. Every step can be skipped.'), before: settingsAt('her-character') },
      { sel: '#st-archetypes', title: t('Starting points'), text: t('Or pick a starting point and adjust from there. Changes save by themselves; Undo brings back how she was when you opened this page.') },
      { sel: '#st-dials', title: t('Personality dials'), text: t('Slide each dial toward the words that fit her. The middle is balanced. Each dial has its own ? with examples.') },
      { sel: '#st-life', title: t('Her life'), text: t('Her job, home, family and interests give her things to talk about and a day of her own.') },
      { sel: '#st-try', title: t('Try it'), text: t('Hear how she would answer a few everyday moments, before you save.') },
      { sel: '#settings-hint', title: t('Saving settings'), text: t('Most settings save automatically. For project notes and checkpoints, use the Save or confirmation buttons shown.') },
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
}
/** The phone layout (the bottom bar shows): some tour steps are for it, some for wider screens. */
const phoneWidth = () => matchMedia('(max-width: 720px)').matches;
export function runTour(name) {
  const steps = TOURS[name]?.filter((s) => !s.when || s.when());
  if (!steps) return;
  $('#help-menu').close();
  localStorage.setItem('sara.tour.first', 'seen');
  void startTour(steps, t, () => {
    $('#main').classList.remove('show-sidebar');
    setMore(false);
  });
}
// /#tour=<name> starts a tour (links in her answers, the guide).
export function tourFromHash() {
  const m = /#tour=(\w+)/.exec(location.hash);
  if (!m || !$('#main') || $('#main').hidden) return false;
  history.replaceState(null, '', '/');
  runTour(m[1]);
  return true;
}
/** Offered once on each device after setup: a small card, never in the way. */
export function offerFirstTour() {
  // Phase 113: not over the check-in's first-run notice (it is offered on a later visit instead).
  if (localStorage.getItem('sara.tour.first') || tourRunning() || document.querySelector('dialog[open]:not(#today)') || !$('#hub-first').hidden) return;
  localStorage.setItem('sara.tour.first', 'offered');
  // Phase 114 (F12): the short tour for the use choice (six stops); the demo keeps the full one.
  const demo = document.body.classList.contains('demo');
  const tour = demo ? 'first' : tourFor(state.usePath);
  const box = el('div', 'tour-offer');
  box.setAttribute('role', 'status');
  const yes = el('button', 'small', t('Show me around'));
  const no = el('button', 'ghost small', t('No thanks'));
  const btns = el('div', 'row-btns');
  btns.append(no);
  // Both: the Coder tour one press away too.
  if (!demo && normPath(state.usePath) === 'both') {
    const code = el('button', 'ghost small', t('Coder tour'));
    code.addEventListener('click', () => {
      box.remove();
      runTour('coding');
    });
    btns.append(code);
  }
  btns.append(yes);
  box.append(el('p', '', demo ? t('New here? The tour shows where everything is, in 14 stops. (Help in the sidebar has it any time.)') : offerText(state.usePath, t)), btns);
  yes.addEventListener('click', () => {
    box.remove();
    runTour(tour);
  });
  no.addEventListener('click', () => {
    box.remove();
    firstRun.pump();
  });
  document.body.append(box);
}
/** Phase 114 (F2): the tour offer waits in the first-run queue until her first reply. */
export function queueTourOffer() {
  if (localStorage.getItem('sara.tour.first') || document.body.classList.contains('demo')) return;
  firstRun.add('tour', offerFirstTour, () => Boolean(state.replied) && !tourRunning());
}

/** Called by app.js where this code used to be, so everything runs in the same order as before. */
export function initTours(c) {
  ctx = c;
  ({ state, firstRun } = c);
  TOURS = makeTours();
  $('#open-help').addEventListener('click', () => $('#help-menu').showModal());
  for (const b of document.querySelectorAll('#help-menu [data-tour]')) b.addEventListener('click', () => runTour(b.dataset.tour));
  window.addEventListener('hashchange', tourFromHash);
}
