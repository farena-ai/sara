// Sara service worker: makes the app installable, shows push notifications, and gives a friendly
// page when the server can't be reached. It never caches API data or conversations.
const OFFLINE = '/offline.html';
// v6 (Phase 75, stage 3): the offline page uses the app's theme files too.
// v7 (2.7.1): new app files (viewport.js, start-view.js); a fresh cache after the iPhone fix.
// v8 (2.8 polish): new tokens in theme.css (the aurora, glass, the display serif) and new app files.
// v9 (Phase 76): a fresh cache with the memory panel's sureness and pin changes.
// v10 (Phase 77): the approval card's "goes against something you decided" section and plan flags.
// v11 (Phase 78): the Run view (run-view.js) and "Show the run" on the step line.
// v12 (Phase 79): budgets (budget-view.js: the step line meter, "Budget reached", Settings → Budgets).
// v13 (Phase 80): the sandbox gate (sandbox-view.js: "Ran in a sandbox", Settings → Coding projects).
// v14 (Phase 81): findings (findings-view.js: the Findings window, the security pass card, "Known vulnerability").
//   Phase 80 had caches.open('sara-shell-v13'); every older cache is deleted below.
// v15 (Phase 82): the threat model (findings-view.js: the Threat model tab and card, "Fix these").
//   Phase 81 had caches.open('sara-shell-v14'); every older cache is deleted below.
// v16 (Phase 83): time-travel (branch-view.js: Branch from here, the branch sheet, original vs branch).
//   Phase 82 had caches.open('sara-shell-v15'); every older cache is deleted below.
// v17 (Phase 84): evals (evals-view.js: the Evals window, variant cards, the result card).
//   Phase 83 had caches.open('sara-shell-v16'); every older cache is deleted below.
// v18 (Phase 85): recall on her own (recall-view.js: "Remembered on her own" chips, Settings → Memory).
//   Phase 84 had caches.open('sara-shell-v17'); every older cache is deleted below.
// v19 (2.18): the update experience (update-check.js: "Sara X is available", the sidebar's "Update
//   available" link, the reload onto a new version). A new version's worker takes over at once
//   (skipWaiting + clients.claim below) and the page reloads onto the new shell.
//   Phase 85 had caches.open('sara-shell-v18'); every older cache is deleted below.
// v20 (Phase 86): red-team mode (findings-view.js: the Red team tab, the report, "Red-team this",
//   the ship card; the target icon). 2.18 had caches.open('sara-shell-v19') and kept only
//   k !== 'sara-shell-v19'; every older cache is deleted below.
// v21 (Phase 87): computer use (the Computer use page, the live view, the computer cards).
//   Phase 86 had caches.open('sara-shell-v20'); every older cache is deleted below.
// v22 (Phase 88): computer use step 2 (her actions in the Sara browser: the card's answers, the badge,
//   Settings → Computer use: approvals, always-allowed sites, takeover; Re-plan from here).
//   Phase 87 had caches.open('sara-shell-v21'); every older cache is deleted below.
// v23 (Phase 89): computer use step 3 (Settings → Computer use: dev tunnels, Try the dev tunnel).
//   Phase 88 had caches.open('sara-shell-v22'); every older cache is deleted below.
// v24 (Phase 90): computer use step 4 (saved logins on your computers: the sign-in card, Settings →
//   Computer use → Saved logins, Windows Hello / Touch ID first).
//   Phase 89 had caches.open('sara-shell-v23'); every older cache is deleted below.
// v25 (Phase 91): computer use step 4b (your own password managers: Settings → Computer use →
//   Password managers on this computer, Lock now, the sign-in card for a password manager).
//   Phase 90 had caches.open('sara-shell-v24'); every older cache is deleted below.
// v26 (Phase 92): computer use step 5 (desktop look: Settings → Computer use → The whole screen, the Mac's
//   permission steps, Also hide these windows; the composer's Show Sara my screen).
//   Phase 91 had caches.open('sara-shell-v25'); every older cache is deleted below.
// v27 (Phase 93): local desktop approvals, takeover and keep-awake choices.
//   Phase 92 had caches.open('sara-shell-v26'); every older cache is deleted below.
// v28 (Phase 94): computer check-ups (checkup-view.js: the report card and the one-change card).
//   Phase 93 had caches.open('sara-shell-v29'); every older cache is deleted below.
const SHELL = [OFFLINE, '/offline.css', '/offline.js', '/theme.css', '/theme-boot.js', '/icon-192.png', '/project-checkpoints.js'];

// v29 (CU8 draft): Linux hands installation and explicit device-code computer-control warning.
// v30 (Phase 96): skills (skills.js: Settings → Abilities → Skills, the editor, Add a skill and its
//   review card, the skill cards in the chat, "Used skill" on the step line).
//   Phase 95 had caches.open('sara-shell-v29'); every older cache is deleted below.
// v31 (Phase 97): skills she learns (learned-skills.js, '/learned-skills.js': the "make this a skill?"
//   and "a fix for …?" cards after her reply, Skills she learns on the Skills page, the check chips).
//   Phase 96 had caches.open('sara-shell-v30'); every older cache is deleted below.
// v32 (Phase 98): plugins (plugins.js and proposal-card.js: Settings → Abilities → Plugins, Add a
//   plugin and its review card, plugin settings and log, plugin notes and cards in the chat).
//   Phase 97 had caches.open('sara-shell-v32'); every older cache is deleted below.
// v33 (Phase 99): the board (board.js and board.css: Planner → Board, drag with mouse, touch and the
//   keyboard, the card's detail, Today's "On the board"). Phase 98 kept 'sara-shell-v32' and opened
//   caches.open('sara-shell-v31'); every older cache is deleted below.
// v34 (Phase 100): other agents (agents.js, '/agents.js': Settings → Connections → Other agents, a
//   key for an agent, the review card of an agent she can ask, the "Asked …" step lines). Phase 99 had
//   caches.open('sara-shell-v33'); every older cache is deleted below.
// v35 (Phase 101): people cards (people.js and people.css: Memory → People, the review of people she
//   proposes, a person's card, Today's dates opening the card). Phase 100 had
//   caches.open('sara-shell-v34'); every older cache is deleted below.
// v36 (Phase 102): webhooks (hooks.js and hooks.css: Settings → Connections → Webhooks, the three-step
//   form, the address and secret shown once, the test button, the log; the delivery cards in the chat;
//   Today's "From your webhooks"). Phase 101 had caches.open('sara-shell-v36'); every older cache is deleted below.
// v37 (Phase 103): her own plans (agenda.js and agenda.css: Planner → Her plans with the big switch,
//   Today's "Her plans" tile, the "Why I'm writing" line, "Added to her plans" in the chat).
//   Phase 102 had caches.open('sara-shell-v36'); every older cache is deleted below.
// v38 (Phase 104): move in from another agent (movein.js and movein.css: Settings → Data & health →
//   Move in from another agent: the three steps, the collector's plan, the preview with the persona
//   card, one batch, the report and Undo). Phase 103 had caches.open('sara-shell-v38').
// v39 (Phase 105): custom stores on the Move in page (movein.js and movein.css: the mapping cards,
//   their samples and hand edit, progress, saved mappings). Phase 104 had caches.open('sara-shell-v38').
// v40 (Phase 106, MI3): settings and channel cards, the hook and plugin explainer, the full move-in report
//   (download, where things live now, Rebuild as a Sara plugin). Phase 105 had caches.open('sara-shell-v39').
// v41 (Phase 107, CH1): chat commands (the Commands cards for Telegram and Discord, typed /new and
//   /status in the composer, Context used and earlier sessions). Phase 106 had caches.open('sara-shell-v40').
// v42 (Phase 108, CH2): a tidy session list (session-list.js: channel projects with their icons,
//   See more in pages, ended sessions under their chat, Hidden projects, the channel project card).
//   Phase 107 had caches.open('sara-shell-v41').
// v43 (Phase 109, CH3, 2.42.0): titles that grow (the Session titles card, the Title part of the
//   conversation's info with its earlier titles, rows renamed in place). Phase 108 had caches.open('sara-shell-v42').
self.addEventListener('install', (event) => {
  //   Phase 110 (CH4): keeping up with a room (web/rooms.js, the room window, the plan card, Forget this
  //   room, the Library's room archives). Phase 109 had caches.open('sara-shell-v43').
  //   Phase 111 (TD1, 2.44.0): Today on big screens (sections, S/M/L tiles, today-layout.js: Customise, the
  //   ⋯ menus, the Mail tile 2.0). Phase 110 had caches.open('sara-shell-v44').
  //   Phase 112 (TD2, 2.45.0): Today on phones and tablets (the Now card, collapsible groups, swipe rows,
  //   pull to refresh). Phase 111 had caches.open('sara-shell-v45').
  //   Phase 113 (2.46.0): Report a problem, My reports, the daily check-in's notice and Settings → Privacy
  //   (hub.js, hub.css). Phase 112 had caches.open('sara-shell-v46').
  //   Phase 114 (PL1a, 2.47.0): the personality dials redesign (dials.js: a word and a sample line per
  //   band) and one model count (model-count.js). Phase 113 had caches.open('sara-shell-v47').
  //   Phase 114 (PL1b, 2.47.1): the first run in one queue, the use choice, two short tours, starter
  //   chips (first-run.js, first-run.css). PL1a had caches.open('sara-shell-v48').
  //   Phase 114 (PL1c, 2.47.2): one look across every page: the "How do I…?" blocks (howto.js,
  //   howto.json), the one empty state, segment buttons and choice cards (kit.js, kit.css). PL1b had
  //   caches.open('sara-shell-v49') (and its activate step kept v48 by mistake; both go now).
  //   Phase 115 (BR1, 2.48.0): chat apps catch up (web/step-words.js shared with the progress message,
  //   the Pictures and files and Progress cards, file chips, Files in this chat). PL1c had caches.open('sara-shell-v50').
  //   Phase 116 (BR2, 2.49.0): talk while she works (the split Send button, waiting chips, the side
  //   question card, busy.js and busy.css). Phase 115 had caches.open('sara-shell-v51').
  //   Phase 117 (part A, 2.50.0): Signal (the Signal page, Comes with Sara, linking, Test and groups
  //   on a chat plugin's settings). Phase 116 had caches.open('sara-shell-v52').
  //   Phase 117 (part B, 2.50.0): Email (the Email page, who may email her, Check my sender, the
  //   forwarded-mail line on approval cards). Part A had caches.open('sara-shell-v53').
  // v55 (Phase 118): keep going until it's done and repeats (persist.js and persist.css: the goal
  //   and repeat chips, their cards, Planner → Repeats). Phase 117 part B had caches.open('sara-shell-v54').
  // v56 (Phase 119): when it comes up and picking a chat up in another app (recall-when.js, pickup.js
  //   and recall.css: the ⏰ chip, the card, the pickup banner and chip). Phase 118 had caches.open('sara-shell-v55').
  //   2.52.1 (SSH easy): Settings → Servers over SSH rebuilt around Connect a server (ssh.js, style.css).
  //   Phase 119 had caches.open('sara-shell-v56').
  // v58 (Phase 120): checks after her edits and @-references (refs.js and refs.css: the @ menu, the
  //   reference chips, the checks card and chip, Settings → Abilities → Check her edits). 2.52.1 had
  //   caches.open('sara-shell-v57').
  // v59 (Phase 121): routines and the safety check-up (routines.js, safety-check.js and begin.css:
  //   Planner → Routines, Today's routine cards, Settings → Data & health → Safety check-up).
  //   Phase 120 had caches.open('sara-shell-v58').
  // v60 (Phase 122): WhatsApp (whatsapp.js and screens.css: Settings → Connections → WhatsApp, the
  //   guided setup card and its diagnoses). Phase 121 had caches.open('sara-shell-v59').
  //   Phase 122 2.55.0 had caches.open('sara-shell-v60') (the steps became a numbered list and the diagnosis wraps).
  // v62 (Phase 122 part 2, 2.55.1): Matrix (matrix.js: Settings → Connections → Matrix, the guided setup
  //   card, her rooms and the diagnoses). 2.55.0 had caches.open('sara-shell-v61').
  // v63 (Phase 122 part 3, 2.55.2): iMessage through BlueBubbles (imessage.js: Settings → Connections →
  //   iMessage, the guided setup card and its diagnoses). 2.55.1 had caches.open('sara-shell-v62').
  // v64 (Phase 123, 2.56.0): the short tool list and Tidy this chat (lean.js and lean.css: the ring's
  //   tools line, What she has, the tidy divider, the two settings cards). 2.55.2 had caches.open('sara-shell-v63').
  // v65 (Phase 124, 2.57.0): the Sara Store, part 1 (store.js and store.css: Settings → Privacy → Sara
  //   Store, More in the Sara Store, the store strip on a plugin's card; skills.js: Archived and the
  //   monthly tidy-up card). 2.56.0 had caches.open('sara-shell-v64').
  // v66 (Phase 125, 2.58.0): the Sara Store, part 2 (store.js and store.css: Settings → Abilities → Get
  //   more, the item page, the tool-server card, My add-ons, Submit yours, My submissions, Report this;
  //   skills.js: the store's skill import). 2.57.0 had caches.open('sara-shell-v65').
  // v67 (Phase 126, 2.59.0): Hey Sara (wake.js and wake.css: Settings → Her → Hey Sara, this device's
  //   switch and the words that wake her, your devices; Settings → Voice → Install hearing and voices
  //   on this computer). 2.58.0 had caches.open('sara-shell-v66').
  // v68 (Phase 127, 2.60.0): companion packs (packs.js and packs.css: Share her, the pack card, the
  //   update card, From a file on Settings → Her → Companions, the Companions shelf on Get more).
  //   2.59.0 had caches.open('sara-shell-v67').
  // v69 (PL2a, 2.61.0): no more brick walls (setup-card.js, signal.js, email.js, telegram-setup.js and
  //   screens.css: one setup card for every chat app, the short consent step for Sara's own plugins,
  //   guided Signal, Email and Telegram; hub.css: the check-in note in the page flow, never over the
  //   message box). 2.60.0 had caches.open('sara-shell-v68').
  // v70 (PL2b, 2.61.1): find it (Settings in 8 groups, settings-search.js: keywords, ranking and
  //   Elsewhere; slash.js and refs.css: the / menu; next-steps.js and today.css: Next steps on Today;
  //   Share her on the Companions row; Tidy this chat on her panel). 2.61.0 had caches.open('sara-shell-v69').
  // v71 (PL2c, 2.61.2): forms into choices (persist-presets.js: Careful, Normal, Long jobs; the numbers
  //   under Fine-tune), the Store (Browse · My add-ons · Submit, items once, kind icons, a grid of 3,
  //   the key under Details; plugin-notice.js: one calm line for Sara's own plugins), Share her chips,
  //   Set up first, the Planner how-tos and the Repeats empty state, disabled buttons in Day.
  //   2.61.1 had caches.open('sara-shell-v70').
  // v72 (PL2d, 2.61.3): app.js split into settings-nav.js (the Settings list, groups and search),
  //   tours.js (the tours and the tour offer) and setup-wizard.js (the first-run setup guide), code
  //   moved only; the guide's Settings paths in the 8 groups; How do I…? for / and routines.
  //   2.61.2 had caches.open('sara-shell-v71').
  // v77: explicit project checkpoints beside coding project notes.
  // v78 (EC1): Slack (slack.js: Settings → Chat apps → Slack, the guided setup card). v77 had caches.open('sara-shell-v77').
  // v79 (EC7): Microsoft Teams (teams.js: Settings → Chat apps → Microsoft Teams). EC1 had caches.open('sara-shell-v78').
  event.waitUntil(caches.open('sara-shell-v79').then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Every older cache goes (sara-shell-v78 from EC1, sara-shell-v77 before EC1, sara-shell-v71 from 2.61.2, sara-shell-v70 from 2.61.1, sara-shell-v69 from 2.61.0, sara-shell-v68 from 2.60.0, sara-shell-v67 from 2.59.0, sara-shell-v66 from 2.58.0, sara-shell-v65 from 2.57.0, sara-shell-v64 from 2.56.0, sara-shell-v63 from 2.55.2, sara-shell-v62 from 2.55.1, sara-shell-v61 and sara-shell-v60 from Phase 122, sara-shell-v59 from Phase 121, sara-shell-v58 from Phase 120, sara-shell-v57 from 2.52.1, sara-shell-v56 from Phase 119, sara-shell-v55 from Phase 118, sara-shell-v54 from Phase 117 part B, sara-shell-v53 from Phase 117 part A, sara-shell-v52 from Phase 116, sara-shell-v51 from Phase 115, sara-shell-v50 from PL1c, sara-shell-v49 from PL1b, sara-shell-v48 from PL1a, sara-shell-v47 from Phase 113, sara-shell-v46 from Phase 112, sara-shell-v45 from Phase 111, sara-shell-v44 from Phase 110, sara-shell-v43 from Phase 109, sara-shell-v42 from Phase 108, sara-shell-v41 from Phase 107, sara-shell-v40 from Phase 106, sara-shell-v39 from Phase 105, sara-shell-v38 from Phase 104, sara-shell-v37 from Phase 103, sara-shell-v36 from Phase 102, sara-shell-v35 from Phase 101, sara-shell-v34 from Phase 100, sara-shell-v33 from Phase 99, sara-shell-v32 from Phase 98, sara-shell-v31 from Phase 97, sara-shell-v30 from Phase 96, sara-shell-v29 from Phase 95, sara-shell-v28 from Phase 94, sara-shell-v27 from Phase 93, sara-shell-v26 from Phase 92, sara-shell-v25 from Phase 91, sara-shell-v24 from Phase 90, sara-shell-v23 from Phase 89, sara-shell-v22 from Phase 88, sara-shell-v21 from Phase 87, sara-shell-v20 from Phase 86, sara-shell-v19 from 2.18, sara-shell-v18 from Phase 85, sara-shell-v17 from Phase 84, sara-shell-v16 from Phase 83, sara-shell-v15 from Phase 82, sara-shell-v14 from Phase 81, sara-shell-v13 from Phase 80, sara-shell-v12 from Phase 79, sara-shell-v11 from Phase 78, sara-shell-v10 from Phase 77 and before).
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== 'sara-shell-v79').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

// The offline page's own files come from the cache when the server is down.
self.addEventListener('fetch', (event) => {
  const path = new URL(event.request.url).pathname;
  if (event.request.mode === 'navigate' || !SHELL.includes(path) || path === OFFLINE) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(path)));
});

self.addEventListener('push', (event) => {
  let data = { title: 'Sara', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* empty or non-JSON push */
  }
  event.waitUntil(
    (async () => {
      // If Sara is open and in front, the page shows the message itself.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
      await self.registration.showNotification(data.title, { body: data.body, icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag, data: { url: data.url } });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins[0];
      if (win) {
        await win.focus();
        win.postMessage({ type: 'open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
