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
const SHELL = [OFFLINE, '/offline.css', '/offline.js', '/theme.css', '/theme-boot.js', '/icon-192.png'];

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
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('sara-shell-v38').then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Every older cache goes (sara-shell-v37 from Phase 103, sara-shell-v36 from Phase 102, sara-shell-v35 from Phase 101, sara-shell-v34 from Phase 100, sara-shell-v33 from Phase 99, sara-shell-v32 from Phase 98, sara-shell-v31 from Phase 97, sara-shell-v30 from Phase 96, sara-shell-v29 from Phase 95, sara-shell-v28 from Phase 94, sara-shell-v27 from Phase 93, sara-shell-v26 from Phase 92, sara-shell-v25 from Phase 91, sara-shell-v24 from Phase 90, sara-shell-v23 from Phase 89, sara-shell-v22 from Phase 88, sara-shell-v21 from Phase 87, sara-shell-v20 from Phase 86, sara-shell-v19 from 2.18, sara-shell-v18 from Phase 85, sara-shell-v17 from Phase 84, sara-shell-v16 from Phase 83, sara-shell-v15 from Phase 82, sara-shell-v14 from Phase 81, sara-shell-v13 from Phase 80, sara-shell-v12 from Phase 79, sara-shell-v11 from Phase 78, sara-shell-v10 from Phase 77 and before).
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== 'sara-shell-v38').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
