# Beginner setup: a routines gallery, and the safety check-up with one-click safe fixes (design, Phase 121, version 2.54.0)

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at
2.53.x (Phases 115–120 released: the live progress message, steer / queue / `/btw`, the loop guard,
Signal and email bridges, `/goal` and `/loop`, `/when` and `/continue`, coding precision), plus the
public feature pages of Hermes Agent and OpenClaw that GAP_REVIEW cites (sources in §13). It is a
ground-up design: no code, schema, prompt or wording is taken from Hermes Agent, OpenClaw or any other
agent; this file names only their **features**. Zero new npm runtime dependencies. No new timer, no new
run engine, no new kind of model call: every routine below is a row or a setting of something Sara
already runs (the briefing, the weekly review, a reminder, the GitHub watcher, a webhook, a loop), and
every safety check reads what `sara doctor`, the settings, the vault and the owner file already know.

**The owner's words (2026-10-31, approving the gap review's suggestions as Phases 115–128):** "I like
the top 10 as well as the lower down ones." The ROADMAP line he approved:

- *Phase 121 (2.54.0):* "Beginner setup: a routines gallery and the safety check-up with one-click safe
  fixes (#8, #11)."

And the gap review's pitches he said yes to (GAP_REVIEW §2):

- **#8 · Ready-made routines** (G13): "a gallery: *Morning brief*, *Watch my GitHub repo*, *Bedtime
  wind-down*, *Weekly review*, *Remind me to stretch*. Pick one, answer two questions, confirm."
  *Fits:* "each routine is a skill (ST1) plus a schedule (planner repeat) or a webhook (ST7) or a
  presence event; plugins can add routines (ST3). No new engine." *Simple UI:* "Today's empty state and
  the Planner offer *Add a routine*; each card says when it runs and roughly what it costs." Risk note
  (G13): "Each routine shows its schedule and cost class before it's created; nothing scheduled silently
  (Rule 7); plugins may add routines only after their review card."
- **#11 · A safety check-up with safe fixes** (G16): "Settings → Data & health → *Check my safety*: a
  plain report card (reachable without HTTPS, Telegram open to strangers, commands on *auto* without a
  sandbox, owner token never rotated, no off-server backup) with a *Fix* button on each." *Fits:*
  "grows `sara doctor` (`doctor.ts`), which already checks some of this, and turns SECURITY_CHECKLIST
  into checks; fixes are approval cards." *Simple UI:* "a green/amber/red list, one sentence each; the
  same report from `sudo sara doctor`." Risk note (G16): "Read-only by default; each fix is a card you
  approve; it can only tighten."

**The brief for this design (from the parent, on the owner's behalf):** "Read the repo before you design
anything. Do not invent a parallel architecture." Sara must be "super simple for beginners: look at it
through their eyes".
1. *The routines gallery.* Ready-made routines (a morning briefing, watching a repo's CI, a weekly
   review, a price watch, an inbox triage, a backup check …), each a **card**: what it does, what it
   needs, what it costs (**model calls and the per-day cap**), and one **Turn on** with a **preview**.
   Built on the existing jobs / loops / reminders, and the design says which. Scheduled things that
   spend model money need **a clear cost line and an off switch**.
2. *The safety check-up.* One page that **scores the setup in plain words** and offers **one-click SAFE
   fixes only**: an exposed port without sign-in, an owner token never rotated, backups off, tools on
   auto-approve, a shell with no sandbox, adult mode with no PIN, a public bind, an out-of-date version, a
   weak hub/bridge setup, secrets in memory. It says **which fixes are reversible** and **never weakens
   anything**.

**Goal:** someone who installed Sara an hour ago opens *Routines*, sees "Morning briefing · every day at
7:30 · about 1 model call a day", taps it, answers "where are you?" and "what time?", reads the preview
("Tomorrow at 7:30 she'll send: the weather in Leeds, your 3 to-dos, your first meeting"), taps **Turn
on**, and it is on, with an **Off** switch in the same place. And the same person opens *Safety
check-up* and reads "Mostly safe · 2 things to tighten": "Commands run without asking and there is no
sandbox on this computer" with **Fix: ask me first** (undo any time), and "There is no copy of her data
off this computer" with **Set it up** (it walks them there). Nothing on that page can make the setup
less safe, and nothing runs, costs or changes until they tap.

**The rule of this phase: build on what is there.** A routine is **a recipe for settings and rows that
already exist**: the morning briefing is `settings.briefing` (`briefing.ts`), the weekly review is
`settings.weeklyReview` (`review.ts`), a reminder is a planner reminder with a `Repeat`
(`planner.ts`, delivered by the 15-second `ReminderScheduler`), *leave by* is `settings.leaveBy`
(`leaveby.ts`), "new issues on my repo" is `settings.githubWatch` (`issues.ts`, the server's own
GitHub poller), "tell me when CI fails" grows that same poller by one option (and offers the existing
`github-ci-failed` webhook preset, `webhook-verify.ts PRESETS`, when GitHub can reach her), and the
paid, model-run routines (*Price watch*, *Inbox triage*) are **Phase 118 loops** (`loops.ts`) grown by
one field: a clock time instead of only "every N minutes". The backup check is the doctor's own backup
checks run by the hourly backup timer that already makes the backups (`main.ts backupTick`). The safety
check-up is `runDoctor` (`doctor.ts`) grown into a report with fixes; each fix is a settings patch, a
vault write or an owner-file call that already exists (`settings.update`, `auth.rotateToken`, the
device sign-out, the hooks' pause), passed through one **tighten-only** gate in code before it is
written, and logged with its *before* so it can be undone. The mandatory safety layer
(`src/safety.ts`: AI disclosure at the start and every 3 hours, honesty when sincerely asked, crisis
resources, the hard block on sexual content involving minors) is untouched; every model-run routine is
an ordinary turn or an ordinary `complete()` call, so it runs inside each one.

Contents: 1 what exists today · 2 how Hermes Agent and OpenClaw do it, and where Sara differs · 3 the
shape and shared building blocks · 4 part A: the routines gallery · 5 part B: the safety check-up · 6
safety and money across the phase · 7 household isolation · 8 reuse vs build · 9 risks · 10 the phase at
a glance · 11 blocking questions with defaults · 12 key choices in short · 13 sources. The
`test/phase121.test.ts` Done-when list is §5.14 (both parts), the owner to-dos §5.15.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| Morning briefing | `src/briefing.ts` (259 lines): `BriefingSettings {enabled, time '07:30', place, units, lastDay}`, `DEFAULT_BRIEFING` off; facts in code (weather, `calendarToday`, `mailToday`, due to-dos, reminders), **one** background `complete()` writes them in her voice (plain facts if the model fails); one a day (`lastDay`), skipped if > 3 h late; `checkClaims` on the text | The richest ready-made routine Sara has, already on a per-day cap of 1. | The *Morning briefing* routine **is** these settings. Its cost line is computed from them (1 call a day, ≈ the background model's usual size). |
| Weekly review | `src/review.ts` (Phase 22): `ReviewSettings {enabled, day 0, time '18:00'}`, facts from the planner, one `complete()` a week; "Review my week" on demand | A weekly routine with its own switch. | *Weekly review* routine = these settings. Also a built-in skill `skills/weekly-review`. |
| Reminders and repeats | `src/planner.ts` `Repeat = none \| daily \| weekdays \| weekly \| monthly`, `Reminder {text, dueAt, repeat, call, placeId …}`, `nextOccurrence`; `src/reminders.ts` `ReminderScheduler` (15 s tick, late = "sorry it's late", skips a chat mid-turn; also calls `loops.due(now)` since 2.51) | Time-driven messages, **no model call**. | *Remind me to stretch* and *Bedtime wind-down* are a repeating reminder: free. |
| Leave by | `src/leaveby.ts`, `settings.leaveBy` (Phase 20): calendar events with an address → a "leave by" reminder | Free, needs Google Calendar and a place. | A gallery card that just switches it on. |
| GitHub watcher | `src/issues.ts` (Phase 40): `GitHubWatch {repos, label?, everyMinutes 0 \| 15 \| 60, seen, lastCheck}`; the **server's own** poller (no paid CI, a GitHub API call), new issues → planner tasks + a message; owner-only setting `githubWatch` | Polls repos with the owner's GitHub token (`GITHUB_VAULT`). | *Watch my repo's CI* grows it with `ci: true` (the Actions runs list, same token, same timer, still no model call), §4.6. *New issues on my repo* is it as is. |
| Webhook presets (ST7) | `src/webhooks.ts` (1,159 lines), `src/webhook-verify.ts` `PRESETS` (`github-issue-opened`, `github-pr-opened`, **`github-ci-failed`**, `github-release`, three Stripe, `ha-state-changed`), action kinds `tell \| task \| skill \| plugin`, `tell` with a template = **no model call**; per hook `limits` (runs per day, tokens); `verify` kinds `github \| stripe \| standard \| header \| url`, `weakKind()` = `url`/`header` | Instant events, if the sender can reach her (docs/WEBHOOKS.md: GitHub needs Tailscale Funnel or her own HTTPS address). | Offered inside *Watch my repo's CI* as "instant, if GitHub can reach this server". `weakKind` is one of the check-up's checks (§5.3 S13). |
| Loops (Phase 118 B) | `src/loops.ts` (790 lines): `chat_loops` (`prompt, every_min, until_text, until_check, ends_at, max_ticks, quiet, tick_budget, day_tokens, state …`), `loop_ticks`; each tick a queued owner input (`pending.ts`) run as an ordinary turn with a tick budget (50,000 tokens / 10 steps); `same` folded and silent, `changed` = message + push, `met` needs a receipt; asks refused → `paused (approval)`; daily caps on the CH3 `DailyLedger` (source `loop:<id>` and the all-loops total, 300,000 tokens / $0.50 a day); quiet hours (`quietNow`); stops after 2 failures or 6 unchanged until-ticks; `persist.loops {minEvery 5, defaultFor 4, maxFor 24, maxTicks 48, maxActive 3}`; **active loops come back paused after a restart** | The only engine that runs a model on a schedule for the owner, with every money guard already built. | *Price watch* and *Inbox triage* are loops. But a loop lasts **24 hours at most**, wakes **every N minutes** and **pauses on every restart**; a price watch runs for weeks and an inbox triage at 08:00 on weekdays. §4.5 grows loops by one field (a clock schedule), with limits; no second scheduler. |
| Her plans (ST8) | `src/agenda.ts` (1,237 lines): her own goals and follow-ups, opt-in, under the proactive cap, quiet hours and a daily token / dollar budget | Things **she** starts. | Not a routine engine (routines are **his** orders). Shown beside routines in Planner, as today. |
| Background jobs | `src/jobs.ts` `JobManager` (commands in the workspace sandbox) | One-off commands with a receipt. | Not used by routines (no routine runs a command). Named so nobody looks for a cron in it: Sara has none. |
| Move-in schedules | `src/movein/schedules.ts` (Phase 104): old Hermes/OpenClaw cron jobs → planner tasks that "never act by themselves", `cronWords()` | Imported jobs land as inert tasks. | A moved-in job that matches a gallery routine gets a *Turn on as a routine* link on its task (§4.10): the bridge from "my old cron job" to a guarded routine. |
| Recipes (Phase 50) | `src/recipes.ts` (361 lines): **her** how-to notes for coding jobs (`recipes` table, FTS) | Not routines. | Name clash: the UI never says "recipe" for a routine; recipes stay Settings → Abilities → Recipes. |
| Starters | `src/starters.ts`, `templates/starters/` (coding starter projects); the wizard's starter **chips** (`web/first-run.js starterChips`) | First-run shortcuts. | The pattern for the routine catalog files (`templates/routines/*.json`, read and checked like starters), and the place for one more chip. |
| Getting started | `src/checklist.ts` (78 lines): 7 steps per use path (`CHECKLIST_ORDER`), owner-only steps hidden for members; `morning` = "Get a morning briefing" (done when `briefing.enabled`) | Today's first list. | The `morning` step becomes *Turn on a routine* (done when **any** routine is on, so a briefing still ticks it, §4.9). |
| First run | `web/first-run.js` (104 lines): wizard step 1 picks `company \| coding \| both`, `starterChips`, the one-at-a-time queue (wizard → check-in notice → tour offer) | The beginner's first ten minutes. | No new popup joins the queue (§4.9): routines are offered on the wizard's last step and in an empty Today, not as a fourth overlay. |
| `sara doctor` | `src/doctor.ts` (143 lines): `DoctorCheck {name, status ok\|warn\|fail, detail}`; Node, browser, data folder mode (POSIX `chmod 700` hint), disk, `PRAGMA quick_check`, every provider answers, backups (< 48 h), off-server copy, **tool sandbox** (lists command tools on `auto` with no sandbox), voice, time zone; `GET /api/admin/doctor`, `--doctor` CLI, Settings → Data & health → Health | Health, with a few safety checks mixed in, and no fixes. | Part B grows **this**: the check-up is the doctor's safety rows plus new ones, with fixes (§5). |
| Security checklist | `docs/SECURITY_CHECKLIST.md`: 10 manual steps (keep the owner token safe / new token, passkey, two-step, HTTPS only, devices, tool approvals on Ask, sandbox, off-server backup, backups are keys, updates) | A page to read. | Each step becomes a check (§5.3), as GAP_REVIEW says. |
| Sign-in | `src/auth.ts` (556 lines): `OwnerFile {tokenHash, sessionSecret, sessions[], passkeys[], totp, setupPending}`; `rotateToken(current)` (signs every other device out), `resetToken({clearSecurity})` (the server-side `sara reset-token`), device sessions with `lastSeen`, `kind` `api \| home-assistant \| hands \| a2a` (A2A keys expire after 180 days), device tokens end after 90 days | Everything the token checks need **except the token's age**: the owner file has no "made at". | One additive field, `tokenAt` (§5.4). |
| How she's reached | `src/platform.ts accessInfo()` (`SARA_ACCESS` = `local \| tailscale \| domain \| lan`, `SARA_PUBLIC_URL`, a plain warning for http off this computer); `main.ts` `SARA_HOST` (default `127.0.0.1`), `SARA_PORT`; `server.ts isHttps` (`trustProxy` + `x-forwarded-proto`); `SARA_DEMO=1` lets anyone in (refuses a data folder with real conversations) | Read-only facts about the way in; changed only by the installer or `sara access`. | Public bind, no HTTPS and "open without sign-in" are **guided** fixes: the web app can't safely rewrite its own listening address (§5.5). |
| Tools and approvals | `src/tools/types.ts` `Permission = auto \| ask \| never`, `Tool.runsCommands`, `asksFirst`, `source` (built-in / MCP / plugin); `settings.toolPermissions`; `src/tools/sandbox.ts` `SandboxInfo.mode` `bwrap \| seatbelt \| none` and `noSandboxNote`; `settings.shellNetwork`; `sandboxGate` (`sandbox-run.ts`) | What may run without asking. | "Tools on auto-approve" and "a shell with no sandbox" (§5.3 S8, S9): the fix moves permissions **toward** ask, never away. |
| Chat bridges | `src/bridges/telegram.ts` `TelegramSettings {allowOthers, ownerUserIds, ownerWorkInGroups, nsfwChatIds …}`, Discord the same plus other bots (Phase 47), Signal / email plugins (Phase 117) | Who can talk to her, and where she works. | "A weak bridge setup" (§5.3 S12): open to strangers, bots allowed, the owner's tools in groups. |
| Hub, A2A | `src/hub.ts` (anonymous check-in and reports, through the network guard; never in private local mode), `src/a2a.ts` (peers, keys with `expiresAt`) | Outbound and agent-to-agent links. | "A weak hub setup" (§5.3 S13, S14): A2A keys unused or near expiry; the hub check-in is a privacy choice, **shown, never switched** (§5.6). |
| Adult mode | `settings.adultMode {on, confirmedAt, confirmedFrom}` (Phase 16; turned on only from a browser with the owner's 18+ confirmation); household members have their own spaces (`household.ts`) | No PIN exists anywhere in Sara; passkeys use the device's own PIN. | "Adult mode, but no PIN" (§5.3 S11) maps onto what exists: a lock on sign-in (passkey or two-step). §11 Q6 asks about a real adult PIN. |
| Secrets | `src/redact.ts` `Redactor`, `KEY_SHAPED`, `vaultSecretValues`; `memory-worker.ts` redacts facts **when it writes them**; the vault (`vault.ts`) | New memories are scrubbed; old rows, hand-written notes, recipes and learned skills were never re-scanned. | "Secrets in memory" (§5.3 S15): a read-only scan and a reversible *hide* (§5.4). |
| Updates | `src/updates.ts` `Updater.check()` against the GitHub release, `UpdateState` incl. `available`, `rolledback`; Settings → Data & health → Updates | Knows when she's out of date. | "An out-of-date version" (§5.3 S16): shown with *Open Updates*; the check-up never updates by itself. |
| Private local mode | `src/net-guard.ts`, `src/private-local.ts` (`whatWouldLeave`) | Nothing leaves the computer. | The check-up runs fully offline in it (the update check is skipped and says so); a price watch can't run in it (§4.8). |
| Settings guide, tips | `src/settingsguide.ts` (she answers from the ? tips, `web/tips.json`, `data-tip`s), Phase 41 | Every setting has a ? tip, which she can read. | Every routine field and every check gets a tip (§4.12, §5.12); she can explain any card. |

What does **not** exist: a list of ready-made routines, any routine view that shows the briefing, the
review, repeating reminders, the GitHub watcher and loops **together** with what they cost, a loop that
runs at a clock time or for more than a day, a CI watch without a public address, a token age, an adult
PIN, a re-scan of stored text for secrets, and any fix button on the doctor's rows.

Six code facts change the design:
1. **Sara has no cron and must not get one.** Every scheduled thing rides a timer that exists: the
   reminder tick (15 s; reminders and loops), the LifeWorker (briefing, review, her plans), the GitHub
   poller (`issues.ts`), the hourly backup timer. A routine picks one of these; the gallery adds none.
2. **Most beginner routines cost nothing.** Reminders, leave-by, the GitHub watcher, a `tell` webhook
   and the backup check make **zero model calls**. Only the briefing and review (one `complete()` per run)
   and loop-based routines (a turn per tick) spend. The card says which, from code (§4.4).
3. **Loops can't carry a weeks-long routine as they are**: a 24-hour maximum, minute intervals, paused
   after every restart. A price watch would die on the first update. §4.5 grows them carefully.
4. **The doctor's sandbox row already does half of check S9** (`doctor.ts` l. 120) but only for command
   tools; the check-up widens it to every tool the owner moved off its default *ask*.
5. **The way she's reached is set outside the app** (`SARA_HOST`, `SARA_ACCESS`, the installer, `sara
   access`). The app can describe it exactly, but changing it from a web page could lock the owner out.
   Those fixes are guided, by design.
6. **The owner file doesn't record when the token was made.** "Never rotated" needs one new field; old
   files say "we don't know how old it is" honestly instead of guessing from a file date.

---

## 2. How Hermes Agent and OpenClaw do it, and where Sara differs

Only features, from their public docs (read 2026-11-02; [H10], [O15], [O16] in §13). No code, prompt or
wording is taken.

- **Hermes Agent, Automation Blueprints [H10].** "Ready-to-run automations. Pick one, fill in a couple of
  fields, and Hermes schedules it as a cron job." The catalog includes a morning briefing, an
  important-mail monitor (every 30 minutes), a weekly review, a workday start, a custom reminder, an
  evening wind-down, a topic news digest, bills and renewals, a price and availability watch (every 6
  hours) and a competitor news watch. Each works from the dashboard (a Blueprints tab), the CLI and chat
  apps (`/blueprint <name>`, questions one at a time, or values inline). "Blueprints never schedule
  anything silently — you always confirm before the job is created"; jobs are managed with `/cron`.
  Plugins can add blueprints, prefixed with the plugin's name so they can't replace a built-in; a
  blueprint is a skill with a metadata block. Disabling a plugin removes its blueprints, but jobs already
  made keep running.
- **OpenClaw, `openclaw security audit` [O15].** "Security tools: audit plus optional safe fixes." A
  cold, read-only audit of config and files (`--deep` adds live checks and plugin collectors; `--json`).
  It checks the DM/trust model (shared sessions, open group policy, cross-agent reach), webhook tokens
  (reuse, short, unrestricted), sandbox and tool settings (exec without a sandbox, open DMs reaching
  runtime tools, small models with web tools and no sandbox), and the Node security patch level. `--fix`
  "applies safe, fixed repairs": open group policies to allowlists, and tighter file permissions
  (`chmod`, `icacls` on Windows). It explicitly does **not** rotate tokens or keys, disable tools, change
  the bind/auth/network exposure, or rewrite plugins or skills. Its security page [O16] is the longer
  guide.

**Where Sara differs, on purpose:**

| Question | Hermes / OpenClaw (docs) | Sara (this design) | Why |
|---|---|---|---|
| What a routine becomes | A cron job [H10] | **The setting or row of the engine that already does that job** (briefing, review, reminder, GitHub watcher, webhook, loop) | No second scheduler; each engine already has its limits and its Off |
| What the card says | The schedule; confirm before creating [H10] | The schedule in words, **what it needs (ticked or not), what it costs in model calls, the per-day cap, the end date**, a code-only preview, then Turn on | The brief: "a clear cost line and an off switch" |
| Paid routines | Any blueprint may run the model on its interval | Paid routines are loops with a **required end date**, a tick budget, a daily cap on the CH3 ledger, quiet hours; read-only tools only, named on the card | Rule 7 and the Phase 118 guards |
| Plugin routines | Listed beside built-ins, prefixed; jobs outlive the plugin [H10] | Prefixed, listed only after the plugin's ST3 review card, limited to free engines + loops; **turning a plugin off turns its routines off** | Nothing keeps running from a plugin the owner switched off |
| What the audit fixes | Allowlists and file permissions; never tokens, tools, binds [O15] | Settings that tighten (approvals back to *ask*, bridges closed, backups on, shell network off), file mode, device sign-outs, hiding secrets, and **a new owner token on a second confirm**; binds and HTTPS are guided | The owner listed token rotation; it only ever tightens, and it says it can't be undone |
| Reversible? | Not stated per fix | **Each fix says "Undo any time", "Undo for 30 days" or "Can't be undone"** on its button, and the log keeps the *before* | The brief |
| Score | Findings by severity [O15] | **Words**: *Looks safe* / *Mostly safe: 2 things to tighten* / *Fix these first: 1*, and "9 of 12 checks fine" | "Through their eyes": no number to decode |

---

## 3. The shape

```
 Routines (Planner tab · Today's empty state · wizard's last step · /routines in chat apps)
   │
   ├─► card: what · needs (✓/✗ + "Set it up") · costs (model calls, per-day cap, ends) · Turn on
   │
   ├─► R2 preview (code only, no model call): "this will be created", next 3 runs, the cost line
   │
   └─► Turn on (the owner's tap = the OK) ─► R3 apply onto ONE engine:
          briefing │ weeklyReview │ reminder(+Repeat) │ leaveBy │ githubWatch(+ci) │ webhook preset │
          loop (+schedule: a clock time, ≤ 30 days, read-only tools) │ safetyCheck.weekly (backup check)
          └─ one `routines` row points at what it made; My routines reads the engine's live state; Off

 Safety check-up (Settings → Data & health → Safety check-up · `sara doctor` · Today when red)
   │
   ├─► S1 run the checks (read-only; no model, no network except the update check)
   │       └─ each: green / amber / red, one sentence, why it matters (?), the fix kind
   │
   └─► Fix (one click on a card that says what changes and whether it can be undone)
          └─ S2 fix ─► the tighten-only gate (code) ─► write ─► `safety_fixes` row (before/after)
                                                   ─► Undo (when reversible) restores *before*
          guided fixes only open the page / show the command; nothing is changed for them
```

### 3.1 Shared building blocks (built once, used by both parts)

1. **R1 · The routine catalog** (`src/routines.ts`, new; part A). Built-in routines are JSON files in
   `templates/routines/<id>.json`, read and checked at start the way `listStarters` reads
   `templates/starters/` and `gallery.ts checkGalleryFile` checks persona files (a bad file is skipped
   with a log line, never half-loaded). A file is `{id, version, title, pitch, category: 'everyday' |
   'work' | 'coding' | 'safety', engine, fields[], needs[], defaults, words}`; `engine` is one of a
   **closed list** (`briefing`, `review`, `reminder`, `leaveBy`, `githubWatch`, `hook`, `loop`,
   `safetyWeekly`); `fields` are at most **three** questions, each `{key, kind: time | day | text | url |
   number | repo | place | pick, default, tip}`. The file never states its own cost: the cost line is
   computed by R4 from the engine and the answers. Plugin routines come from a plugin manifest's
   `routines` array after its ST3 review card, are prefixed `<plugin>:<id>`, and may only use the free
   engines and `loop` (§4.11).
2. **R2 · Preview** (in `routines.ts`). `preview(app, routineId, answers) → {ok, problems[], creates:
   string[], schedule: string, next: string[3], cost: CostLine, needs: Need[], sample?: string, sig}`.
   Code only: it validates the answers with the engine's own cleaner (`cleanWatch`, the planner's
   `parseWhen`/`nextOccurrence`, `persist.ts` loop limits, the webhook preset), lists in words what Turn on
   will create or switch, shows the next three run times in the owner's time zone, and for the briefing a
   **sample built from today's facts with no model** (the plain-facts fallback the briefing already has).
   `sig` is a hash of the answers + the cost line, so Turn on refuses a stale preview (409).
3. **R3 · Apply and Off** (in `routines.ts`). `turnOn(app, routineId, answers, sig, by)` writes through the
   engine's **own** path (`settings.update({briefing})`, `planner.addReminder`, `settings.update({githubWatch})`,
   `hooks.create({preset})`, `loops.create(spec)` + `start`) and records one `routines` row with a
   `target` pointing at what it made. `off(rid)` uses the engine's own off (`enabled: false`, cancel the
   reminder, remove the repo from the watch, pause the hook, stop the loop). **My routines reads the
   engine's live state**, not the row: if the owner switches the briefing off on its own page, the
   routine shows Off; nothing is stored twice.
4. **R4 · The cost line** (in `routines.ts`, code only). `costLine(app, engine, answers) → {calls: {per,
   n}, cap: string, tokensPerDay?: number, usdPerDay?: number, endsAt?: string, local: boolean, free:
   boolean}` from: the engine's calls per run (briefing and review 1, a loop tick 1 turn, everything else
   0), the runs per day from the schedule, the **cap that already exists** (briefing: 1 a day by
   `lastDay`; review: 1 a week; loops: the tick budget and the loop's daily share of the CH3 ledger;
   hooks: `limits.runsPerDay`), the route's model (`settings.routes.background` for the briefing/review,
   `chat` for loops) priced with `findPrice` where `usdMeaningless` is false. Words in §4.4.
5. **S1 · The checks** (`src/safety-check.ts`, new; part B). `runSafetyCheck(deps) → Report {verdict:
   'safe' | 'tighten' | 'fix-first', fine, total, checks: Check[]}`; `Check {id, status: 'green' |
   'amber' | 'red' | 'skip', line, why, detail?, fixes: FixOffer[]}`. `deps` are `DoctorDeps` plus the
   owner file view, the household, the hooks, the A2A peers, the updater, the bridges' settings and the
   stores to scan. It **calls `runDoctor`** for the rows it shares (backups, off-server copy, data
   folder, sandbox) instead of re-implementing them. Read-only, no model, no network (the update check
   uses the updater's cached status; *Check now* is the Updates page's own button).
6. **S2 · Fixes and the tighten-only gate** (in `safety-check.ts`). A `FixOffer {id, label, kind:
   'one-click' | 'guided', undo: 'any-time' | '30-days' | 'none', changes: string, confirm2?: string}`.
   `applyFix(app, checkId, fixId, by)` re-runs **that** check first (the page may be stale), builds the
   change, passes it through `tightensOnly(before, after)` (§5.4) and only then writes it, then logs a
   `safety_fixes` row with `before`/`after`. `undoFix(id)` restores `before` only if the current value
   still equals `after` ("You've changed it since; nothing was undone").
7. **S3 · The weekly quiet check** (part B, used by the *Backup check* routine). The hourly backup timer
   (`main.ts backupTick`) once a week runs S1 with `by: 'weekly'` and, **only if a check turned amber or
   red since the last run**, posts one notice in the owner's main chat (and a push), e.g. "Your newest
   backup is 3 days old. Safety check-up →". No model call; nothing is fixed.

### 3.2 Where data lives

- **Routines** (part A): one table, `routines`, in the `store.db` of the companion space that turned
  them on (the owner's main companion for the owner; each member's own space for theirs, §7). The
  engines keep their own data where it already is: settings in that space's `settings.json`, reminders
  in the planner database, loops in the conversation's `store.db`, hooks in the hooks table.
- **Routine loops' conversations**: each loop-based routine gets its own conversation (e.g. "Price
  watch · Kindle Paperwhite") in the owner's main companion, filed under a channel project `Routines`
  (the CH2 `channel:` project kind, renamable, hideable, never archived), so ticks never clutter his main
  chat and the history of a watch is in one place.
- **Safety** (part B): `safety_runs` and `safety_fixes` in the owner's main companion `store.db`
  (server-wide facts, owner-only, like the doctor). Secrets hidden by a fix are kept in the **vault**
  under `safety-undo:<fixId>:<n>` until Undo or 30 days.
- **Owner file**: one additive field `tokenAt` (§5.4). **Settings**: the additive keys in §3.3.

### 3.3 Settings shape

```ts
// Settings (additive). `routines` is per space; `safetyCheck` is owner-only (added to OWNER_SETTINGS).
routines?: {
  /** Show *Add a routine* on Today's empty state and the wizard's last step. Default true. */
  suggest?: boolean;
};
safetyCheck?: {
  /** S3: the weekly quiet check (the *Backup check* routine turns it on). Default false. */
  weekly?: boolean;
  /** Last weekly run (ISO) and its statuses, so only a change posts. */
  last?: { at: string; statuses: Record<string, 'green' | 'amber' | 'red' | 'skip'> };
  /** Checks the owner marked "I know, don't warn me" (amber only; red can't be hidden), with when. */
  accepted?: Record<string, string>;
};
// githubWatch (grown, §4.6): ci?: boolean; ciSeen?: Record<string, number>; ciBranch?: string;
// persist.loops (grown, §4.5): routineMaxDays (7 | 14 | 30 | 90, default 30), routineMinEvery (hours, default 6).
```

No setting here can switch off the mandatory safety layer, approve a tool, turn adult mode on, change
private local mode or the hub check-in.

---

## 4. Part A · the routines gallery

### 4.1 Scope

In: a gallery of **ten** built-in routines (§4.2), each a card with what it does, what it needs, what
it costs and Turn on with a preview; *My routines* with an Off switch on each; the cost line in code;
loops grown with a clock schedule for routines (§4.5); the GitHub watcher grown with CI (§4.6); the
gallery in the beginner's path (wizard, Today, Getting started, §4.9); `/routines` in chat apps (list and
Off; Turn on through the same card, §4.10); plugin routines after review (§4.11); a `suggest_routine`
tool so she can draw a card when he asks "can you check this every morning?".

Out: a cron, free-form schedules ("every second Tuesday"), routines that run commands or write
anywhere, routines that message other people, member routines that spend tools (§7), a shared routine
store (Phase 124's store may later carry plugin routines), self-paced loops.

### 4.2 The ten routines, and which engine runs each

| Routine (card title) | What it does (the card's line) | Engine (existing) | Asks (≤ 3) | Needs | Costs (card) | Per-day cap | Off |
|---|---|---|---|---|---|---|---|
| **Morning briefing** | "Every morning: the weather, your to-dos and reminders, your first meetings and important mail, in her words." | `settings.briefing` (`briefing.ts`, LifeWorker) | time (07:30), place (for the weather) | a brain; optional Google Calendar/Gmail (shown as "makes it better") | 1 model call a day | 1 a day (built in) | `briefing.enabled = false` |
| **Weekly review** | "Once a week: what got done, what's stuck, what's next, and a short plan." | `settings.weeklyReview` (`review.ts`) | day (Sunday), time (18:00) | a brain | 1 model call a week | 1 a week | `weeklyReview.enabled = false` |
| **Remind me to stretch** | "A nudge in your words at the times you pick." | planner reminder, `repeat: weekdays \| daily` | what (prefilled "Stand up and stretch"), time, which days | nothing | **Free**: no model calls | — | the reminder cancelled |
| **Bedtime wind-down** | "In the evening: a reminder in your words to put the screens away." | planner reminder, `repeat: daily` (plain text; no model, no calendar lookup: "tomorrow's first thing" would be a new reminder feature, §11 Q2) | what (prefilled "Time to wind down"), time (22:00) | nothing | **Free** | — | cancelled |
| **Leave on time** | "When a meeting has an address, she tells you when to leave." | `settings.leaveBy` (`leaveby.ts`) | home place, how you travel | Google Calendar, a home place | **Free** | — | `leaveBy.enabled = false` |
| **Inbox triage** | "Weekday mornings she reads your new mail and tells you what needs you today. She never moves or deletes anything by herself." | **loop** with a clock schedule (§4.5), read-only Gmail tools allowed | time (08:00), days (weekdays), for how long (30 days) | Gmail connected, a brain with tools | about 1 model turn a day (≤ 50,000 tokens each) | the loop's daily share; ends on its date | loop stopped |
| **Price watch** | "Checks a product page and tells you when the price drops below your target." | **loop** with an interval ≥ 6 h (§4.5), `web_fetch` allowed, `until` = "below {target}" (met needs the fetch receipt) | the page (URL), the target price, how often (every 12 h) | a brain with tools, web reading allowed, not in private local mode | about 2 model turns a day | the loop's daily share; ends after 30 days or when met | loop stopped |
| **Watch my repo's CI** | "Tells you when a GitHub Actions run fails on your main branch, and when it's green again." | `settings.githubWatch` grown with `ci` (§4.6); "Instant" option = the `github-ci-failed` webhook preset | the repository, the branch (main) | a GitHub token | **Free**: Sara's own server asks GitHub every 15 min; no model | — | `ci: false` / repo removed |
| **New issues on my repo** | "New issues become to-dos, and she tells you." | `settings.githubWatch` as is (`issues.ts`) | the repository, a label (optional) | a GitHub token | **Free** | — | repo removed |
| **Backup check** | "Once a week she checks that backups are being made and the off-computer copy works, and only speaks up if not." | S3 (`safetyCheck.weekly`, the hourly backup timer) | — | nothing | **Free** | — | `safetyCheck.weekly = false` |

The two names in the owner's examples that are **not** in this list, and why: a news digest and a
competitor watch are loops over web search; they are left to plugins and the store (Phase 124) because
search costs money with some providers. §11 Q1 asks whether to add them.

### 4.3 The card (what a beginner sees)

Every card has the same five parts, top to bottom, and nothing else:

1. **Title and one line** ("Morning briefing · Every morning: the weather, your to-dos …").
2. **When** in words from the answers: "Every day at 7:30" / "Weekdays at 8:00, until 2 December" /
   "Every 12 hours, until the price is under £90 or 2 December".
3. **Needs**: each need ticked ✓ or ✗ with *Set it up* that opens the page (`settings:ab-google`,
   `settings:ab-github`, `settings:models-default` …) and comes back to the card (the wizard's return
   pattern). Turn on is disabled while a hard need is ✗; a "makes it better" need never blocks.
4. **Costs**: the R4 line (§4.4), always present, also for free routines ("Free: no model calls").
5. **Turn on** (primary) and *Preview* (secondary). Turn on **always shows the preview first** in the
   same card (one extra tap), so nothing is ever created without the owner reading what will happen.

### 4.4 The cost line, in words (code only)

One line, always the same shape, built by R4 and translated (six languages):

| Case | The line on the card |
|---|---|
| No model call | **Free** · no model calls. |
| Briefing / review on a priced cloud model | **About 1 model call a day** (≈ 3,000 tokens, about $0.01). At most 1 a day. |
| On a local model | **About 1 model call a day**, on your own computer (no money). At most 1 a day. |
| On a subscription | **About 1 model call a day**, from your Claude subscription. At most 1 a day. |
| A loop routine | **About 2 model turns a day** (each at most 50,000 tokens). At most 100,000 tokens a day for this routine; all routines and repeats together at most 300,000 tokens and $0.50 a day. **Ends 2 December.** |
| Unpriced paid model + dollar cap | **About 2 model turns a day.** Sara has no price for this model, so the dollar limit stops it at the first call: pick a priced or local model (the L4 rule in `budgetCheck`). |

Rules: numbers come from the engine and the answers, never from the routine file; "about" because a
turn's size varies, "at most" only for caps that code enforces; a paid line always has an **end date**
and an **Off** right under it. Estimates use the last 7 days of the same purpose in Settings → Usage
when there are any (purpose `briefing`, `review`, `loop`), else the engine's default size. Settings →
Usage gains the purpose `routine` (loop routines' turns, besides `loop`).

### 4.5 Loops grown for routines: a clock schedule, a longer end, read-only tools

The paid routines are loops, so every Phase 118 guard holds (tick budget, daily caps, quiet hours,
failure and no-progress stops, asks refused, the fingerprints, `met` needs a receipt). Three changes,
**only for loops made by a routine** (`chat_loops.routine_id` not null); a `/loop` typed in a chat is
unchanged:

1. **A clock schedule.** A new nullable column `schedule` (JSON): `{at: 'HH:MM', repeat: 'daily' |
   'weekdays' | 'weekly', day?: 0..6}`. When set, `next_at` is computed with the planner's
   `nextOccurrence` in the owner's time zone instead of `last + every`; `every_min` is then the interval
   floor used for "missed" detection. Interval routines (*Price watch*) keep `every_min` with a floor of
   `routineMinEvery` (6 h).
2. **A longer end.** `ends_at` may be up to `routineMaxDays` (default 30, choices 7 / 14 / 30 / 90) and
   `max_ticks` is computed from the schedule (30 days of weekdays = 22). The end date is on the card and
   in My routines; a week before it, the routine's chat gets one line "This routine ends on 2 December.
   *Keep it for 30 more days*" (a tap = a new Turn on with the same answers; never automatic).
3. **Restarts.** A routine loop that was `active` comes back **active** after a restart, with `next_at`
   recomputed to the **next** slot: missed slots are skipped (one `skipped: restart` tick row), never run
   as a backlog. A chat `/loop` still comes back paused. Reason: the owner's Turn on covered a dated
   window with a visible cost line, and a weeks-long watch that dies at every update is broken for a
   beginner (§11 Q3).
4. **Read-only tools allowed by name.** A routine loop carries `meta.allow` = the tools the card named
   (*Price watch*: `web_fetch`; *Inbox triage*: `gmail_search`, `gmail_read`, `gmail_thread`,
   `gmail_needs_answer`). In a tick, a call to a tool in `meta.allow` runs **even if that tool is set to
   ask** (it is read-only and the owner allowed it on the card); any other call that would ask is refused
   and pauses the loop as today. `meta.allow` may only hold tools on the **read-only list** in code
   (`READ_ONLY_TOOLS`: no `runsCommands`, no send, no write, no organize, no purchase); a plugin routine
   can't add to it. A tool the owner set to **never** stays never.

Tick prompts are the routine file's `words.prompt` with the answers filled in (e.g. "Look at {url}. What
is the price now, in the page's currency? If it is below {target}, say so with the exact price; if not,
say the price."), plus the loop note from Phase 118; *Inbox triage* adds "Don't change anything in the
mailbox; list what needs him today and offer to tidy the rest when he's here." A tidy-up is then an
ordinary turn when he answers ("yes, archive them"), with the usual count-first card.

### 4.6 *Watch my repo's CI*: the GitHub watcher grown

`GitHubWatch` gains `ci?: boolean`, `ciBranch?: string` (default the repo's default branch) and
`ciSeen?: Record<repo, number>` (the newest workflow run id seen). On the same timer and with the same
token, when `ci` is on, the poller also asks the Actions runs list for that branch (completed runs, newest
5) and:
- a run with `conclusion: failure` newer than `ciSeen` → one notice in the owner's main chat and a push:
  "octo-org/hello: *Tests* failed on main (run 562). Open on GitHub · Ask her to look" (the second chip
  starts an ordinary coding turn with the run's link; nothing starts by itself);
- the first `success` after a failure → "…is green again";
- nothing else posts (success after success is silent).
No model call, no CI minutes, no public address needed. If the server has a public HTTPS address
(`accessInfo().url` is https and `SARA_ACCESS` is `domain` or Funnel), the card shows **Instant (needs
GitHub to reach this server)**: Turn on then also creates the `github-ci-failed` hook with `verify:
'github'` and shows the secret and URL to paste into GitHub, exactly as Settings → Connections → Webhooks
does today; the poller stays on as the fallback.

### 4.7 Preview, Turn on, My routines

- **Preview** (R2) shows, in the card: "Turn on will: switch on the morning briefing at 7:30 in Leeds";
  "Next: tomorrow 07:30, Wed 07:30, Thu 07:30"; the cost line; and for the briefing a sample built from
  today's facts with no model ("Sample, without her words: 11 °C and cloudy · 3 to-dos · Dentist at
  10:00"). For loops: "Turn on will: make a conversation *Price watch · Kindle* and check the page every
  12 hours until 2 December or until it's under £90"; "She may read web pages for this (and nothing else
  without asking)". *Try it once now* (loops and briefing only) runs one real tick / one briefing **now**,
  labelled with its cost ("uses 1 model call"); it is optional and never part of Turn on.
- **Turn on** creates exactly what the preview listed, with the preview's `sig`; if the facts changed in
  between (a need went ✗, the model's price changed) the card re-previews instead of turning on.
- **My routines** (top of the gallery): each routine on one row: icon, title, *When* in words, the cost
  line's first clause, *Next: tomorrow 07:30* or *Paused: daily limit (back tomorrow)* or *Ended*, an
  **On/Off switch**, and ⋯ (*Change answers* = the card again with the answers; *Remove* = Off + forget;
  *Open its chat* for loops; *Run now* where the engine has it). Turning Off is one tap and needs no
  confirm (it only stops things); turning a removed paid routine back on shows the preview again.
- **Things already on count.** A briefing switched on before 2.54, a repeating reminder, a watched repo
  and an active loop show in My routines as *Set up elsewhere* rows (read from the engines), with the
  same switch, so the owner has **one** list of everything that runs on a schedule. No `routines` row is
  made for them until he changes one from here.

### 4.8 Who, where, and when it can't

- **Owner** in any of his companions; **members** get only the free and briefing/review routines in
  their own space (§7). Partners, rooms, A2A, `/v1` and MCP can't see or turn on routines.
- **Private local mode**: *Price watch* (the web) is not offered ("Can't run in private local mode: it
  reads a web page"); *Inbox triage* likewise (Gmail is outside); briefing/review use local models as
  they do today; the free ones are unchanged. Turning private local mode on **pauses** routine loops with
  the reason `private-local`.
- **No brain yet**: every model routine shows ✗ *Connect a brain*; the free ones work.
- **A crisis line** in a routine's chat pauses its loop (Phase 118's rule, 48 h); the briefing follows its
  own existing rules.

### 4.9 The beginner's path (looking through their eyes)

- **The wizard's last step** (`starterChips(path, 'wizard')`) keeps its three chips and gains one quiet
  link under them: *Or turn on a routine →* (company and both paths: Morning briefing preselected; coding:
  Watch my repo's CI). It opens the gallery **after** the wizard closes, through the existing first-run
  queue, so nothing stacks.
- **Today's empty state** (no reminders, no tasks, no routines) shows three routine cards inline:
  Morning briefing, Remind me to stretch, Weekly review (coding path: Watch my repo's CI, New issues,
  Weekly review), with *See all routines*.
- **Getting started**: the `morning` step becomes **Turn on a routine** ("A morning briefing, a weekly
  review, a reminder…"), done when **any** routine is on, including a briefing (so nobody's tick moves);
  it opens the gallery. The coding list gets no new step (it is at seven).
- **Planner** gets a **Routines** tab next to *Her plans* and *Repeats*; *Repeats* (Phase 118 loops)
  stays where it is and routine loops show in both, with the routine's name.
- **Ask her**: "can you check the price of this every day?" → she calls `suggest_routine` (a card in the
  chat, the same five parts; her tool never turns anything on). `settings_guide` reads the routine files,
  so "what routines are there?" is answered from them.
- **Words**: the UI never says loop, cron, engine, tick or token on a card (tokens appear only in the
  cost line's brackets and the ? tip); "model call" is explained once in the ? tip.

### 4.10 In Telegram, Discord and plugin bridges

`/routines` (owner only, typed; joins `MENU_COMMANDS` for the owner's private chat) lists My routines,
one line each with an **Off** button (Telegram inline keyboard / Discord component) and *Open in the app*.
`/routines add price watch` (a forgiving name match over titles) answers with the routine's card as a
message (needs, cost line, the questions as a short form: the bot asks one question per message, like the
`/goal` card) and a **Turn on** button that shows the preview text first and a second **Turn on** under
it. Partners and rooms: the command doesn't exist (their line stays a message, the Phase 119 rule). A
moved-in job (§1) whose words match a routine gets *Turn on as a routine* on its planner task.

### 4.11 Plugin routines

A plugin manifest may list `routines` (same JSON shape, engines limited to `reminder`, `hook` with a
`tell` action and `loop`); they appear in the gallery **only after** the plugin's ST3 review card, which
lists them in plain words with their cost lines ("adds 1 routine: *Standup notes*, about 1 model turn on
weekdays"); ids are prefixed `<plugin>:`, so a plugin can't replace a built-in; a plugin loop routine
can't name tools in `meta.allow` beyond the read-only list, and can name its **own** plugin tools only if
the plugin's manifest marks them `readOnly` and the review card showed that. **Turning the plugin off
turns its routines off** (and says so on the plugin's Off confirm), unlike Hermes [H10].

### 4.12 The web app at 1440 and 390

**1440 × 900 (Planner → Routines; the same view opens from Today and the wizard).** Two columns: My
routines on the left (a narrow list), the gallery on the right (cards in a 3-column grid, grouped by
*Everyday*, *Work*, *Coding*, *Safety*). Opening a card expands it in place to the questions and preview;
no dialog on top of a dialog.

```
┌ Planner ─ To-dos · Reminders · Her plans · Repeats · [Routines] ───────────────────────────────────────┐
│ My routines (3)                      │  Add a routine                               🔍 Find a routine   │
│ ☀ Morning briefing          [● On ]  │  EVERYDAY                                                        │
│   Every day 7:30 · 1 call/day        │  ┌ ☀ Morning briefing ┐ ┌ 🗓 Weekly review ─┐ ┌ 🧘 Stretch ──────┐ │
│   Next: tomorrow 07:30          ⋯    │  │ Weather, to-dos,   │ │ What got done,    │ │ A nudge in your  │ │
│ 🏷 Price watch · Kindle      [● On ]  │  │ meetings, mail.    │ │ what's next.      │ │ words.           │ │
│   Every 12 h until 2 Dec · ~2 turns/d│  │ ✓ On               │ │ Sun 18:00         │ │ Free             │ │
│   Paused: daily limit (back tmrw) ⋯  │  │                    │ │ 1 call a week     │ │ [Turn on]        │ │
│ ⏰ Stand up and stretch  [● On ]      │  └────────────────────┘ └ [Turn on] ───────┘ └──────────────────┘ │
│   Weekdays 11:00, 15:00 · Free   ⋯   │  ┌ 📬 Inbox triage ───────────────────────────────────────────┐   │
│ Set up elsewhere                     │  │ Weekday mornings she reads new mail and tells you what     │   │
│ 🐙 New issues: octo/hello [● On ]    │  │ needs you today. She never moves or deletes anything.      │   │
│                                      │  │ When  [08:00 ▾] [Weekdays ▾] for [30 days ▾]          (?)  │   │
│ Everything here runs on a schedule.  │  │ Needs ✓ Gmail  ✓ A brain with tools                        │   │
│ Off stops it at once. (?)            │  │ Costs About 1 model turn a day (≤ 50,000 tokens). At most  │   │
│                                      │  │       100,000 tokens a day. Ends 2 December.           (?)  │   │
│                                      │  │ Turn on will: make a chat "Inbox triage", check weekdays   │   │
│                                      │  │ at 08:00 until 2 Dec. She may read mail (search, read,     │   │
│                                      │  │ threads) and nothing else without asking.                  │   │
│                                      │  │ Next: Tue 08:00 · Wed 08:00 · Thu 08:00                    │   │
│                                      │  │                         [Try it once now · 1 turn] [Turn on]│   │
│                                      │  └─────────────────────────────────────────────────────────────┘   │
│                                      │  CODING  ┌ 🔴 Watch my repo's CI ┐ ┌ 🐙 New issues ┐               │
│                                      │  SAFETY  ┌ 💾 Backup check ┐                                       │
└──────────────────────────────────────┴───────────────────────────────────────────────────────────────────┘
```

**390 × 844 (phone).** One column: a segmented control *My routines (3) | Add*; cards full width, one per
row; an expanded card scrolls as one page with **Turn on** in a sticky bottom bar (above the bottom nav,
the BR2 pattern); the On/Off switch is a 44 px target; the cost line wraps but is never truncated; ⋯ opens
the bottom sheet (*Change answers*, *Open its chat*, *Run now*, *Remove*).

```
┌ Routines ────────────────────┐
│ [My routines (3)] [  Add  ]  │
│ ┌ 🏷 Price watch · Kindle ──┐ │
│ │ Every 12 h until 2 Dec   │ │
│ │ ~2 turns a day · ≤100k/d │ │
│ │ Paused: daily limit      │ │
│ │ (back tomorrow)   [● On] │ │
│ └──────────────────────────┘ │
│ ┌ ☀ Morning briefing ──────┐ │
│ │ Every day 7:30 · 1 call/d│ │
│ │ Next: tomorrow    [● On] │ │
│ └──────────────────────────┘ │
│ …                            │
├──────────────────────────────┤
│  Today  Chats  Planner  More │
└──────────────────────────────┘
```

Empty-state Today at 390: the three suggested cards are a horizontal row of compact cards (title, one
line, *Free* / *1 call a day*), swipeable, with *See all* at the end; never above her greeting.

### 4.13 ? tips (each ≤ 260 characters)

- **Routines**: "Ready-made things she does on a schedule. Each card says when it runs, what it needs and what it
  costs. Nothing starts until you tap Turn on, and Off stops it at once."
- **Costs**: "A model call is one request to the AI model she thinks with. Local models cost nothing but your
  computer's time; cloud models cost a little per call. 'At most' limits are enforced by Sara."
- **Ends**: "Routines that use a model always have an end date, so nothing runs forever. A week before, she
  asks if you want 30 more days."
- **She may read**: "Only the read-only tools named here run without asking during this routine. Anything
  else that needs your OK pauses the routine until you're there."
- **Try it once now**: "Runs it one time now so you can see what you'll get. Uses one model call."
- **Set up elsewhere**: "Things that already run on a schedule (from Settings or a chat), shown here so
  you have one list. Off works the same."
- **Instant (CI)**: "GitHub tells Sara the moment a run fails. Needs GitHub to reach this server
  (your own web address or Tailscale Funnel). Without it, Sara checks every 15 minutes."
- **Backup check**: "Once a week Sara checks that backups are being made and the off-computer copy can
  be restored. You only hear from her if something's wrong. No model calls."
- Each routine field (time, days, place, URL, target price, repository, branch, how long) gets its own tip
  in `web/tips.json` with an example ("A product page, e.g. the shop's page for that exact model").

### 4.14 Tables (additive)

```sql
-- The store.db of the space that turned it on (owner: each of his companions; members: their space).
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL,            -- 'morning-brief', 'price-watch', '<plugin>:standup'
  version INTEGER NOT NULL,            -- the routine file's version when turned on
  source TEXT NOT NULL,                -- 'built-in' | 'plugin:<name>'
  engine TEXT NOT NULL,                -- briefing | review | reminder | leaveBy | githubWatch | hook | loop | safetyWeekly
  answers TEXT NOT NULL DEFAULT '{}',  -- the owner's answers (cleaned)
  target TEXT NOT NULL DEFAULT '{}',   -- {settingsKey} | {reminderId} | {repo} | {hookId} | {loopId, conversationId}
  cost TEXT NOT NULL DEFAULT '{}',     -- the R4 cost line shown at Turn on (for "what you agreed to")
  state TEXT NOT NULL DEFAULT 'on',    -- on | off | removed (live state is read from the engine)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  off_at TEXT,
  reason TEXT                          -- 'owner' | 'plugin-off' | 'ended' | 'private-local' | 'need-lost'
);
CREATE INDEX IF NOT EXISTS routines_state ON routines(state);

-- chat_loops (Phase 118), additive columns:
ALTER TABLE chat_loops ADD COLUMN schedule TEXT;        -- {at, repeat, day?} or NULL (interval)
ALTER TABLE chat_loops ADD COLUMN routine_id INTEGER;   -- routines.id or NULL (a typed /loop)
-- chat_loops.meta gains `allow: string[]` (read-only tool names, §4.5).
```

The GitHub watcher's `ci`, `ciBranch`, `ciSeen` live in its settings object (as `seen` does today). No
table for the catalog: the routine files are read at start and on plugin changes.

### 4.15 Routes (the space's own; owner-only engines refuse members)

| Method and path | Body / answer | Who |
|---|---|---|
| `GET /api/routines` | `{catalog: [{id, title, pitch, category, fields, needs: [{id, ok, open}], cost, source}], mine: [{rid?, routineId?, title, when, cost, next, state, reason, elsewhere?: true}]}` | owner; members get their allowed subset |
| `POST /api/routines/:id/preview` | `{answers}` → R2 `{ok, problems, creates, schedule, next, cost, needs, sample?, sig}`; 400 on a bad answer, with the field | same |
| `POST /api/routines/:id/on` | `{answers, sig}` → `{routine}`; 409 if the preview is stale; 412 if a hard need is ✗; 403 for an engine the space can't use | same |
| `POST /api/routines/mine/:rid/off` · `/on` | → the row; `/on` of a paid routine whose end passed → 409 "needs a new preview" | same |
| `POST /api/routines/mine/:rid/run-now` | briefing / review / loop routines only; answers with the run id | owner (members: briefing/review) |
| `DELETE /api/routines/mine/:rid` | Off + `state = removed`; routine-made reminders/hooks/loops are cancelled/stopped, settings are switched off (never deleted) | same |
| `POST /api/routines/elsewhere/:kind/:key/off` | the *Set up elsewhere* switch (briefing, review, a reminder, a watched repo, a loop) through the engine's own off | owner |

Chat apps call the same functions (no HTTP). `suggest_routine` is a tool that returns a card (no route).

---

## 5. Part B · the safety check-up

### 5.1 Scope

In: Settings → Data & health → **Safety check-up** (a new page `dh-safety`, first in that group); the
checks in §5.3 (the doctor's safety rows plus new ones, covering SECURITY_CHECKLIST and the owner's list);
a verdict in words; one-click fixes that only tighten, each labelled with whether it can be undone, and
Undo; guided fixes that open the right page or show the exact command; "I know, don't warn me" for amber
rows; the same report from `sara doctor` (a *Safety* section) and `sara doctor --safety`; the weekly quiet
check (S3) behind the *Backup check* routine; one line on Today when anything is red.

Out: changing how she's reached from the web page (bind address, HTTPS, Tailscale), installing a sandbox,
updating by itself, turning adult mode **off** (a content choice, not a safety hole), the hub check-in, the
mandatory safety layer, any deep or live probe of other machines, scanning conversations (only stored
notes/memories/recipes/skills, §5.3 S15), any model call.

### 5.2 The verdict, in words

The page's top line is one of three, from code:

| Verdict | When | Words (title · line) |
|---|---|---|
| `safe` | no red, no amber (accepted ambers count as fine) | **Looks safe** · "12 of 12 checks are fine. Sara checks again each week if *Backup check* is on." |
| `tighten` | no red, ≥ 1 amber | **Mostly safe** · "2 things to tighten. None of them is urgent." |
| `fix-first` | ≥ 1 red | **Fix these first** · "1 thing could let someone in or lose your data." |

Under it: "10 of 12 checks fine" and a thin bar in three colours (decorative; the words carry it), and
*Check again* (re-runs S1; no cost). No number score: a beginner can't act on "73".

### 5.3 The checks

Each row: status, one sentence (what's true now, in plain words), a ? with **why it matters**, and its
fix button(s). "Fix" columns: **1** = one-click, **G** = guided (nothing changed by Sara). Undo: **any** =
Undo any time while nothing else changed it; **30 d** = for 30 days; **none** = can't be undone (said on
the button).

| # | Check (id) | Red / amber when (code) | The line (example) | Fix | Undo |
|---|---|---|---|---|---|
| S1 | **Open without sign-in** (`open-door`) | red: `SARA_DEMO=1` and `SARA_HOST` isn't loopback; red: a local model server on this computer answers on a **non-loopback** address with no sign-in (an `ollama` provider whose `baseUrl` host is `0.0.0.0`/a LAN IP, or `OLLAMA_HOST` bound to all, probed with the provider's own `listModels` on the LAN address only) | "Your local model server (Ollama) answers anyone on your network, with no password." | **G**: the exact setting to change (`OLLAMA_HOST=127.0.0.1`), per OS, and *Check again* | — |
| S2 | **Public bind** (`bind`) | red: `SARA_HOST` is `0.0.0.0`/`::` **and** `SARA_ACCESS` is unset or `local` (nobody meant to open it); amber: bound to all with `lan` | "Sara listens on every network this computer is on, but she was set up for this computer only." | **G**: `sudo sara access local` (Linux/mac) / *Sara tray → Access* (Windows), shown with *Copy* | — |
| S3 | **No HTTPS off this computer** (`https`) | amber: `accessInfo().warning` (http and not local); red: http **and** a `domain` access mode | "Phones reach her over plain HTTP: someone on the same Wi-Fi could read your chats." | **G**: Tailscale (link to the Phone page's Tailscale steps) | — |
| S4 | **Owner token age** (`token`) | amber: `tokenAt` older than 365 days, or unknown (no `tokenAt`); red: never (rotation is hygiene, not a hole) | "We don't know when your owner token was made. Making a new one is quick." | **1**: *Make a new owner token* (second confirm with the current token: "Every device signs out, this one too. The new token is shown once: save it in your password manager.") | **none** |
| S5 | **Sign-in lock** (`two-step`) | amber: no passkey and two-step off, and Sara is reached from other devices (any session not from this computer, or access ≠ local) | "Anyone with your owner token can sign in. A passkey or a 6-digit code stops that." | **G**: opens *Devices and sign-in → Passkeys* / *Two-step* | — |
| S6 | **Old devices and keys** (`devices`) | amber: browser/app sessions not seen for 90 days; API keys (`kind: api`) unused 90 days; A2A keys expired or unused 90 days | "3 devices haven't been used for 3 months: Chrome on Windows, Sara app on iPad, an API key 'Open WebUI'." | **1**: *Sign them out* (lists them; the owner can untick) | **none** (they can sign in again) |
| S7 | **Backups** (`backups`) | red: `backup.auto` false; amber: newest backup > 48 h (the doctor's rule) | "Automatic backups are off." | **1**: *Turn automatic backups on* · *Back up now* | **any** |
| S8 | **Off-computer copy** (`offsite`) | amber: off; red: set up but the last copy or the weekly test restore failed, or no passphrase | "If this computer is lost, so are all of her backups." | **G**: *Set it up* (Backups page) | — |
| S9 | **Tools that run without asking** (`approvals`) | red: a `runsCommands` tool on `auto` and sandbox `none`; amber: any tool the owner moved from its default *ask* to *auto* (built-in, MCP or plugin; read from the registry's defaults) that sends to people, spends, deletes, organizes mail or runs commands | "She can run commands without asking, and this computer has no sandbox: shell, background_job." | **1**: *Ask me first again* (sets exactly those tools back to *ask*) | **any** |
| S10 | **Sandbox** (`sandbox`) | amber: `SandboxInfo.mode = none` on Linux (fixable) or `shellNetwork` on with no sandbox; green with a note on Windows ("no sandbox on Windows; commands ask first") when S9 is green | "Her commands could reach the internet and there is no sandbox." | **1**: *Turn command internet off* (`shellNetwork = false`) · **G**: install bubblewrap (INSTALL.md) | **any** |
| S11 | **Adult mode lock** (`adult-lock`) | amber: `adultMode.on` and no passkey/two-step; red: that **and** household members or other people's devices on this server | "Adult mode is on and anyone who gets your token sees it. Add a sign-in lock." | **G**: Passkeys / Two-step (§11 Q6 on a real PIN) | — |
| S12 | **Chat apps open to strangers** (`bridges`) | amber: Telegram `allowOthers` or Discord `allowServers` (strangers can talk to her as a labelled AI, on your money), Discord `answerBots` with an empty `botAllowList` (any bot), `ownerWorkInGroups` / `ownerWorkInServers` on; red: open to others **and** adult chats listed (`nsfwChatIds` / `nsfwChannelIds`) | "Anyone who finds your Telegram bot can talk to her, and you pay for it." | **1**: *Only me* (`allowOthers` / `allowServers = false`) · *No other bots* (`answerBots = false`) · *No tools in groups* | **any** |
| S13 | **Weak webhooks** (`hooks`) | amber: an enabled hook with `weakKind(verify)` from a sender that signs (GitHub, Stripe); red: a weak hook whose action is `skill` or `plugin` | "The GitHub hook 'CI' accepts anything sent to its address; GitHub can sign its messages." | **1**: *Pause this hook* · **G**: *Switch to GitHub's signature* (the hook's page with the steps) | **any** |
| S14 | **Agents and the hub** (`links`) | amber: A2A on with peers whose keys expire within 14 days or were never used; info row (never amber): the anonymous check-in on/off with a link to Privacy | "An agent key 'deploy-bot' was made 5 months ago and never used." | **1**: *Remove unused agent keys* | **none** |
| S15 | **Secrets in her notes** (`secrets`) | red: a stored memory, note, recipe, learned skill or people note contains a value equal to a vault secret (`vaultSecretValues`); amber: a `KEY_SHAPED` match | "2 of her notes contain something that looks like a password or key." (the rows are named, the value never shown) | **1**: *Hide them* (§5.4) | **30 d** |
| S16 | **Up to date** (`version`) | amber: `Updater` status `available`; red: available **and** the release notes' first line is tagged security (the release body's `Security:` line), or the running version is > 180 days old; skip in private local mode ("can't check offline") | "Version 2.55.1 is out (you have 2.54.0). Only the latest gets security fixes." | **G**: *Open Updates* | — |
| S17 | **Data folder** (`folder`) | amber: POSIX mode allows group/other (the doctor's rule); skip on Windows | "Other users on this computer can read her data folder." | **1**: *Make it private* (`chmod 700`) | **any** |

The doctor's own rows (Node version, disk, database, providers, voice, time zone) stay on the Health page;
the check-up links to it ("Health: 1 warning") but doesn't repeat them.

### 5.4 Fixes: the tighten-only gate, Undo, and the three special ones

**The gate (code, `tightensOnly(before, after)`):** every one-click fix is expressed as a small change
set over known keys, and each key has a direction in a fixed table: `toolPermissions[x]`: `auto → ask →
never` only; `telegram.allowOthers`, `discord.allowServers`, `discord.answerBots`, `telegram.ownerWorkInGroups`,
`discord.ownerWorkInServers`, `shellNetwork`: `true → false` only; `backup.auto`: `false → true` only; `hooks[x].enabled`: `true →
false` only; device sessions and agent keys: **removal** only; the data folder mode: bits only removed;
memory text: replaced only by the redacted form; the owner token: replaced only. Any change outside the
table, or in the other direction, throws before anything is written (and the test suite enumerates
every fix through the gate). No fix may touch: `adultMode`, private local mode, `hub`, the safety
classifier / claim judge, `safety.ts` paths, routes, providers or the access settings.

**Undo** writes `before` back for that fix's keys only, after checking each key still equals `after`.
Undo is the owner's own tap (a weakening he chooses, back to his earlier setting), confirmed ("Undo:
shell will run without asking again"), and logged as its own `safety_fixes` row (`undo_of`).

**The owner token (S4).** `auth.rotateToken(current, {clearPasskeys: false})` is the existing call: the
confirm asks for the **current token** (as *Make a new owner token* on the Devices page does today), keeps
passkeys and two-step (this is hygiene, not "someone had it"; that case stays the Devices page's own
button, which clears passkeys), and signs **every** device out, this browser included. The new token is
shown **once** with *Copy* and "Save it in your password manager now", and the page then goes to sign-in
with it. `OwnerFile.tokenAt` is set by `rotateToken` and `resetToken` from 2.54 on; files without it
show "unknown age" (amber) until the first rotation. CLI: `sara reset-token` already exists and now sets
`tokenAt` too.

**Hiding secrets (S15).** The scan reads the memory, notes, recipe and learned-skill tables and the people
notes of every companion in the owner's space, matching `vaultSecretValues` exactly and `KEY_SHAPED`
patterns; it never reads conversations, uploads or the library. *Hide them* replaces each match in place
with the Redactor's mask (`[hidden: looked like a key]`), stores the original row text encrypted in the
vault (`safety-undo:<fixId>:<n>`), and re-indexes the row (FTS and vectors drop the secret). Undo puts the
text back while the vault entry exists; after 30 days the entries are deleted by the hourly sweep and the
row says "can't be undone any more". The row names which note and which companion; the value itself is
never shown on the page, in logs or in the `safety_runs` row. A found secret that is **not** in the vault
gets a second line: "If this was a real password, change it where it's used."

**Signing old devices out (S6)** uses the Devices page's existing removal; agent keys use A2A's existing
revoke. Both are "can't be undone" because a signed-out device must sign in again.

### 5.5 Guided fixes

A guided fix changes nothing. It is a button that opens the exact page (`settings:dh-devices`,
`settings:dh-backups`, `settings:co-phone`, `settings:dh-updates`, a hook's page) or a small sheet with the
**exact command for this computer** (from `platform.ts`/`sara-windows.ts`: `sudo sara access local`, the
tray's Access menu on Windows, `OLLAMA_HOST=127.0.0.1` per OS, the bubblewrap install line from
INSTALL.md) with *Copy* and *Check again*. Guided, not one-click, because a wrong bind or HTTPS change
from the web page can cut the owner off from the page he's on (code fact 5).

### 5.6 What the check-up never does

It never turns adult mode off, never changes private local mode or the hub check-in, never removes a
plugin, skill, MCP server or provider, never rotates a vault key or a provider key (it can't verify the new
one), never updates, never reads a conversation, never sends anything off the computer, never calls a
model, never runs a fix without the owner's tap on that fix, and never fixes in bulk (no *Fix all*: each
fix says what it changes; §11 Q9).

### 5.7 `sara doctor` and the CLI

`sara doctor` (and `node src/main.ts --doctor`) prints its rows as today, then a **Safety** section in the
same `✓ ! ✗` format from S1, then the verdict line ("Mostly safe: 2 things to tighten. Fix them in
Settings → Data & health → Safety check-up, or run: sara doctor --safety"). `sara doctor --safety` prints
only the check-up with, under each non-green row, the fix in words and, for guided ones, the command. The
CLI **never applies fixes** (no `--fix` in 2.54: the web page shows the undo/can't-undo words and asks
for the current token where needed; §11 Q10). Exit code: 0 safe, 1 tighten, 2 fix-first, for scripts.

### 5.8 The weekly quiet check (S3)

When `safetyCheck.weekly` is on (the *Backup check* routine), the hourly backup timer runs S1 once every 7
days (`by: 'weekly'`, after the backup and the existing weekly off-server test restore, so it sees their
results) and compares with `safetyCheck.last.statuses`. Only a check that **got worse** (green → amber,
anything → red) posts, as one notice in the owner's main chat + a push: "Safety check-up: automatic
backups are off. Open →" (several = one notice with a short list). Getting better is silent. Accepted
ambers never post. No model, no fix.

### 5.9 Today, the chat, and the beginner's path

- **Today**: when the last run (on open, or the weekly one) has a **red** row, *Needs you* shows one line
  "1 safety problem · Open check-up". Amber never reaches Today (no nagging); it lives on the page.
- **Getting started**: the `backup` step ("Keep a copy somewhere else") keeps its own rule; its hint gains
  "or run the safety check-up". No new step.
- **The wizard**: nothing new (a beginner shouldn't meet a security page before saying hello). The page is
  first under Data & health, and the Health page's top says "Safety: Mostly safe · Open check-up".
- **Ask her**: "is my setup safe?" → her existing `settings_guide` answer points at the page and she may
  call a new read-only tool `safety_report` (owner only, private chats only, never in rooms or bridges'
  partner chats) that returns the verdict and the rows' lines (no secrets, no paths beyond what the page
  shows). She can't apply a fix: there is no tool for it.
- **Chat apps**: `/status` gains one line for the owner ("Safety: Mostly safe (2)"); no fixing from chat
  apps (the token fix and the confirms belong on the page).

### 5.10 The web app at 1440 and 390

**1440 × 900 (Settings → Data & health → Safety check-up).**

```
┌ Settings ──────────────┬─────────────────────────────────────────────────────────────────────────────┐
│ …                      │ Safety check-up                                              [Check again]   │
│ Data & health          │ ┌─────────────────────────────────────────────────────────────────────────┐  │
│  ▸ Safety check-up     │ │ ◐ Mostly safe · 2 things to tighten. None of them is urgent.            │  │
│    Health              │ │ 10 of 12 checks fine  ████████████████████░░░░  Checked 2 min ago       │  │
│    Backups             │ └─────────────────────────────────────────────────────────────────────────┘  │
│    Devices and sign-in │ NEEDS A LOOK                                                                 │
│    Updates · Usage …   │ ● Tools that run without asking                                         (?)  │
│                        │   She can run commands without asking, and Windows has no sandbox:          │
│                        │   shell, background_job.                                                   │
│                        │   [Ask me first again]  Undo any time                    I know, don't warn │
│                        │ ● No copy off this computer                                             (?)  │
│                        │   If this computer is lost, so are all of her backups.                     │
│                        │   [Set it up →]  Opens Backups                           I know, don't warn │
│                        │ FINE (10)                                                          ▾ show   │
│                        │ ✓ Sign-in lock · passkey on this phone   ✓ Backups · newest 3 h ago         │
│                        │ ✓ Chat apps · only you   ✓ Up to date · 2.54.0   ✓ Her notes · no secrets …  │
│                        │ RECENT FIXES                                                                 │
│                        │ Today 14:02 · Chat apps: Only me (Telegram) · [Undo]                         │
│                        │ Report from the command line: sara doctor --safety                          │
└────────────────────────┴─────────────────────────────────────────────────────────────────────────────┘
```

A red row sits under **FIX THESE FIRST** above *Needs a look*. Pressing a one-click fix turns its button
into a small inline confirm in the row ("This sets shell and background_job back to Ask. Undo any time.
[Do it] [Cancel]"); the token fix opens the one dialog (current token field, the warning, then the new
token with *Copy*). After a fix the row turns green with "Fixed just now · Undo" for 10 seconds, then
moves into *Fine* and *Recent fixes*.

**390 × 844.** The verdict card on top (full width, sticky while scrolling the first screen); rows as
stacked cards; the fix button full width (44 px), its undo words under it in small text; *I know, don't
warn me* in the row's ⋯ sheet (so a thumb doesn't hit it by mistake); *Fine* folded by default; the token
dialog is a full-screen sheet.

```
┌ Safety check-up ─────── ↻ ┐
│ ◐ Mostly safe             │
│ 2 things to tighten       │
│ 10 of 12 fine             │
├───────────────────────────┤
│ ● Tools that run without  │
│   asking              (?) │
│ She can run commands      │
│ without asking, and …     │
│ [   Ask me first again   ]│
│ Undo any time          ⋯  │
├───────────────────────────┤
│ ● No copy off this        │
│   computer            (?) │
│ [      Set it up →       ]│
├───────────────────────────┤
│ Fine (10)               ▾ │
└───────────────────────────┘
```

### 5.11 Who, where, and when it can't

- **Owner only.** The page, the routes, `safety_report` and the CLI section are the owner's; a member's
  Data & health has no check-up (404 on the routes, no menu item). Members' own risks (their devices) are
  covered by the owner's run: S6 lists members' old devices with the member's name, and signing them out
  is the owner's call as it is on the Household page today.
- **Private local mode**: everything runs; S16 is `skip` ("can't check for updates offline"); nothing
  leaves the computer.
- **Demo server**: the page shows "This is the demo" and runs no checks (the demo has no owner).
- **Docker / desktop app / Windows service**: S2 and S1 commands are worded for the install kind (`instanceName`,
  `sara-windows.ts accessLabel`); on Docker the bind is the container's, so S2 checks `SARA_PUBLIC_URL` and
  the access mode only and says "the port mapping is set in your compose file".

### 5.12 ? tips (each ≤ 260 characters)

- **Safety check-up**: "Sara looks at how she's set up and says what could let someone in or lose your data.
  It only reads. Fixes happen when you tap one, and they can only make things safer."
- **Undo any time**: "This fix changes a setting. Undo puts your old setting back, as long as you haven't
  changed it since."
- **Can't be undone**: "This fix signs things out or makes a new token. It's safe, but you'll need to sign
  those devices in again."
- **I know, don't warn me**: "Moves this to Fine with a note that you chose it. Red problems can't be hidden.
  You can undo this on the row."
- **Guided fix**: "Sara can't safely change this from here (it could lock you out), so she shows you
  exactly where or what to type."
- One **why it matters** tip per check (S1–S17), plain words, with the guide link (`/help#safety-<id>`),
  e.g. S9: "Without a sandbox, a command she runs can touch every file you can. Asking first means you see
  each one before it runs."

### 5.13 Tables and routes

```sql
-- The owner's main companion store.db.
CREATE TABLE IF NOT EXISTS safety_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  by TEXT NOT NULL,                  -- 'page' | 'cli' | 'weekly' | 'her'
  verdict TEXT NOT NULL,             -- 'safe' | 'tighten' | 'fix-first'
  checks TEXT NOT NULL               -- [{id, status, line}] (no secrets, no values; ≤ 30 rows kept)
);
CREATE TABLE IF NOT EXISTS safety_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  check_id TEXT NOT NULL,            -- 'approvals', 'bridges', 'secrets' …
  fix_id TEXT NOT NULL,              -- 'ask-again', 'only-me', 'hide' …
  before TEXT NOT NULL,              -- the keys' old values (for secrets: vault keys, never the text)
  after TEXT NOT NULL,
  undo TEXT NOT NULL,                -- 'any' | '30d' | 'none'
  undo_until TEXT,                   -- 30d fixes
  undone_at TEXT,
  undo_of INTEGER                    -- an Undo row points at the fix it undid
);
```

`OwnerFile` gains `tokenAt?: string` (JSON, additive). Vault keys `safety-undo:<fixId>:<n>`.

| Method and path | Body / answer | Who |
|---|---|---|
| `GET /api/admin/safety-check` | runs S1 → `{verdict, fine, total, checks: [{id, status, line, why, fixes: [{id, label, kind, undo, changes}]}], fixes: recent}` | owner |
| `POST /api/admin/safety-check/fix` | `{check, fix, current?}` (`current` = the owner token, S4 only) → `{ok, check (re-run), fixId, undo, token?}`; 409 if the check is already green; 422 if the gate refuses | owner |
| `POST /api/admin/safety-check/undo` | `{fixId}` → `{ok}`; 409 "changed since" / "can't be undone" / "30 days passed" | owner |
| `POST /api/admin/safety-check/accept` | `{check, accept: boolean}` (amber only; 400 for red) | owner |

The existing `GET /api/admin/doctor` is unchanged (the Health page); `/api/admin/safety` (the existing safety
stats) keeps its name, so the new routes are `safety-check`.

### 5.14 Done when (`test/phase121.test.ts`, plus the existing suites green)

With the **scripted fake model** (`test/helpers.ts` `FakeProvider` / `makeApp(dir, clock)`: it plays a
script and records every request), a **fake clock**, a fake GitHub API (a local server answering the
issues and Actions runs lists, through `netFetch` with the test transport), fake Telegram, a fake push
recorder, a temp data folder, and fake tools `web_fetch` / `gmail_search` in a test registry:

*Part A, routines*
- **The catalog loads and checks itself:** the ten files in `templates/routines/` load; a file with an
  unknown `engine`, four fields, or a `cost` key of its own is skipped with a log line and the rest load.
- **Morning briefing, end to end:** `GET /api/routines` lists it with needs `brain ✓` and the cost line "About
  1 model call a day … At most 1 a day"; `preview` with `{time: '07:30', place: Leeds}` makes **zero**
  `providerCalls`, lists "switch on the morning briefing at 7:30", three next times in the owner's time
  zone and a sample from today's facts; `on` with the `sig` sets `settings.briefing.enabled = true` and
  writes one `routines` row whose `target` is `{settingsKey: 'briefing'}`; the clock at 07:30 → one briefing
  (one `complete()`), at 07:31 none more. `off` → `briefing.enabled = false`.
- **Stale preview:** change the model's price after the preview → `on` → 409; a hard need lost (Gmail
  disconnected) between preview and Turn on → 412.
- **Free means free:** *Remind me to stretch* (weekdays 11:00) and *Bedtime wind-down* make a planner
  reminder with `repeat` set; over a fake week they fire on the right days with **zero** `providerCalls`; the
  card says "Free · no model calls".
- **One list, live state:** switch the briefing off on its own settings route → My routines shows it Off
  (the row is not the source of truth); a briefing turned on before the routines existed shows as *Set up
  elsewhere* with a working switch; an active Phase 118 loop shows there too.
- **Price watch, a grown loop:** Turn on with `{url, target: 90, every: 12h}` → a conversation filed under the
  `Routines` channel project, a `chat_loops` row with `routine_id`, `every_min = 720`, `ends_at` = now + 30
  days, `meta.allow = ['web_fetch']`; `every: 1h` → 400 (below `routineMinEvery`); a tick at +12 h: the fake
  model calls `web_fetch` (set to **ask** in settings) → it **runs** (allowed by the card), the reply "£95"
  with `[[loop: same]]` is folded with no push; next tick "£88" `[[loop: met]]` with the fetch receipt →
  the loop `done`, one message + one push, the routine shows *Ended: price reached*. A tick that calls
  `gmail_organize` (not in `meta.allow`) → refused, loop `paused (approval)`, as in Phase 118.
- **`meta.allow` is read-only only:** a plugin routine naming `shell` or `gmail_organize` in its allow list is
  refused at load; a tool set to **never** stays refused even when named.
- **Inbox triage, a clock schedule:** Turn on `{at: '08:00', repeat: 'weekdays', days: 30}` → `schedule` set;
  ticks happen Monday–Friday 08:00 in the owner's zone (and not at 08:00 Saturday); quiet hours 22–9 don't
  block an 08:00 slot when the owner's quiet hours end at 07:00 (and **do** skip it when they end at 09:00:
  one `skipped: quiet` row, no catch-up flood).
- **Restarts:** rebuild the app on the same data folder with an active routine loop and an active typed
  `/loop` → the routine loop stays `active` with `next_at` = its **next** slot (one `skipped: restart` row,
  no tick run, `providerCalls` unchanged); the typed loop comes back `paused (restart)` as in Phase 118.
- **Ends and renewals:** a routine loop 7 days before `ends_at` posts one "ends on …" line with *Keep it for
  30 more days*; at `ends_at` it ends; *Keep it* runs a new preview/Turn on (no silent extension).
- **Caps and cost line agree:** a routine loop's ticks count in `budget_ledger` under `loop:<id>` and the all-
  loops total; with the daily share used up → `paused (cap:day)` and the routine row says "Paused: daily
  limit (back tomorrow)"; Settings → Usage shows purpose `routine`.
- **CI watch, no model:** `githubWatch {repos: ['octo/hello'], ci: true}` with the fake API returning a failed
  run → one notice + one push ("Tests failed on main (run 562)"), `ciSeen` updated; the same run again → no
  notice; a later success → "green again"; success after success → nothing; **zero** `providerCalls`
  throughout. With an https `SARA_PUBLIC_URL` and `SARA_ACCESS=domain`, *Instant* also creates a hook with
  preset `github-ci-failed` and `verify: 'github'`.
- **Private local mode:** *Price watch* and *Inbox triage* are listed as not available with the reason; turning
  the mode on pauses an active routine loop with `private-local`.
- **Who:** a member's `GET /api/routines` lists only briefing, review, reminders and leave-by; `on` for
  `price-watch` from a member → 403; partners and rooms: `/routines` stays a message (fake Telegram), never
  reaches a model; the owner's `/routines` lists with Off buttons, and *Off* stops the routine.
- **Plugins:** a test plugin listing a routine shows it only after its review card is accepted, prefixed;
  turning the plugin off turns its routine off with `reason = 'plugin-off'`.
- **Getting started:** with any routine on, the `morning` step (now *Turn on a routine*; the id is kept) is done; an existing install with
  `briefing.enabled` sees it done without doing anything.
- **She can't turn things on:** `suggest_routine` returns a card; no `routines` row, no setting changed.

*Part B, the safety check-up*
- **The report:** a data folder set up to trip every check (backups off, `toolPermissions.shell = 'auto'` with
  sandbox `none`, Telegram `allowOthers`, a `url`-verified GitHub hook, a memory containing a vault secret,
  no `tokenAt`, adult mode on with no passkey, `SARA_HOST=0.0.0.0` with no `SARA_ACCESS`, the updater
  status `available`) → `GET /api/admin/safety-check` returns `fix-first` with the expected statuses per id,
  every line in plain words with no secret value in the JSON (the test greps the response for the secret),
  and **zero** `providerCalls` and zero network calls (a recording transport stays empty).
- **Each one-click fix tightens and only that:** *Ask me first again* sets exactly the listed tools to `ask`
  and nothing else in settings changes (deep-compare); *Only me*, *No other bots*, *Turn automatic backups
  on*, *Turn command internet off*, *Pause this hook*, *Make it private* (POSIX only) each flip their key
  and re-run their check green.
- **The gate:** every fix in the table is passed through `tightensOnly` with a synthetic reversed change →
  throws; a fix whose change set names `adultMode`, `hub`, a provider or `toolPermissions` to `auto` →
  throws, nothing written (settings file bytes unchanged).
- **Undo:** each `any` fix undone → the old values back; change the key by hand after a fix, then Undo →
  409 "changed since", nothing written; an Undo row is logged with `undo_of`.
- **Secrets:** *Hide them* replaces the memory text with the mask, the FTS search for the secret finds
  nothing, the vault holds `safety-undo:…`; Undo restores the exact text; with the clock at +31 days the
  sweep deletes the vault entry and Undo → 409 "can't be undone any more". The page never contains the
  value; a `KEY_SHAPED` match not in the vault adds the "change it where it's used" line.
- **The token:** S4 amber when `tokenAt` is missing; the fix without `current` → 400; with the wrong token →
  403; with the right one → a new token in the answer once, `tokenAt` set, every session gone (the test's
  cookie now 401), passkeys kept; the check is green on the next run; `sara reset-token` sets `tokenAt`.
- **Sign old devices out:** sessions last seen 120 days ago and an unused API key → listed; the fix removes
  exactly the ticked ones; a member's old device is listed with the member's name.
- **Guided fixes change nothing:** applying `bind`, `https`, `open-door`, `offsite`, `two-step`, `version`
  through the fix route → 400 "guided"; their offers carry the page or the command for the platform under
  test (`linux`, `win32`, `darwin` with the platform injected).
- **Accept:** accepting an amber moves it to fine with the note and the verdict follows; accepting a red →
  400.
- **The weekly quiet check:** with `safetyCheck.weekly` on and the fake clock moved 7 days, backups switched
  off in between → one notice + one push; a second week with nothing worse → nothing; a check getting better
  → nothing; accepted ambers → nothing.
- **CLI:** `--doctor` output contains the Safety section and the verdict line; `--doctor --safety` exits 0 / 1
  / 2 for safe / tighten / fix-first, and never changes anything (settings bytes unchanged).
- **Who:** a member's session → 404 on every `safety-check` route; `safety_report` isn't in a member's
  registry, nor in a partner chat or a room; it returns lines without secrets; no tool can apply a fix.
- **Today:** a red row → one *Needs you* line; amber only → none.
- **Old data:** a 2.53 database and owner file open unchanged; the new tables are created; no `tokenAt` is
  invented.

*Both*
- **Safety unchanged:** routine loop ticks and the briefing run the disclosure rule and the minors check as
  any turn/`complete()`; a fake tick reply that trips `minorSexualMatch` is replaced as today and the
  routine loop **stops** with the safety reason; the check-up has no route or fix touching `safety.ts`.
- **Zero new runtime dependencies** (`package.json` dependencies unchanged), no new `setInterval` in
  `main.ts` (the test counts timers started by `main.ts` against 2.53's list).

### 5.15 Owner to-dos

On the real server from a phone and the desktop: open Planner → Routines and turn on *Morning briefing*
(read the preview's sample and cost line), *Remind me to stretch* and *Watch my repo's CI* on a real repo
(push a failing commit on a branch named in the card; check the notice and the "green again"); turn on *Price
watch* for a real product with a target just under today's price and leave it two days; restart the server
once (it should stay on and skip the missed slot) and look at Settings → Usage. Then open Data & health →
Safety check-up: read every line as a beginner would; set Telegram to *anyone* and a tool to *auto* on
purpose, fix both from the page and Undo one; run *Make a new owner token* with the token in your password
manager ready; run `sudo sara doctor --safety`. Check the 390 layouts on the phone. Decide §11 Q1–Q14.

---

## 6. Safety and money across the phase

### 6.1 The mandatory layer is untouched

Routine loops are Phase 118 loops (each tick an ordinary turn); the briefing and review are the
`complete()` calls they are today, with their own `disclosureDue` and minors checks. No routine and no
fix can switch the disclosure, honesty, crisis resources or the minors block off, and the check-up has no
check or fix on them (they aren't settings).

### 6.2 Nothing starts, spends or changes without a tap

- **Routines:** Turn on always shows the preview; her `suggest_routine` only draws a card; plugin routines
  need the plugin's review card **and** a Turn on; renewals are a new Turn on; *Try it once now* says its
  cost. Off is one tap and needs no confirm.
- **Fixes:** each is its own tap (no *Fix all*), re-checks before writing, passes the tighten-only gate, and
  is logged; the token fix needs the current token; guided fixes change nothing.

### 6.3 Unattended work

Routine loops keep every Phase 118 guard (tick budget, daily caps on the CH3 ledger, quiet hours, two
failures stop, asks refused and pause) plus: a **required end date** ≤ `routineMaxDays`, an interval
floor of 6 hours (or a clock time), and `meta.allow` limited to read-only tools named on the card. The
change that loosens Phase 118 (routine loops stay active across restarts, §4.5) is bounded by that end
date and skips missed slots (§11 Q3). Prompt injection from a fetched page or an email stays tool output
(fenced, no rights); with only read-only tools allowed and asks refused, the worst a hostile page can do
is a wrong or noisy message, and `met` still needs a receipt.

### 6.4 Money

New spend is only ever: the briefing / review the owner turned on (1 call per run, as today), routine
loop ticks inside the caps on the card, and *Try it once now*. Purposes `briefing`, `review`, `routine`
in Settings → Usage. The check-up, the CI watch, reminders, leave-by and the backup check make no model
calls. The cost line never claims a cap code doesn't enforce.

### 6.5 Threat model additions (`docs/THREAT_MODEL.md` in the release)

A routine as a way to act unattended (read-only tools only, asks refused, an end date, caps); a plugin
smuggling a routine (review card, prefix, engine whitelist, read-only allow list, off with the plugin); a
cost line that lies (computed from code, not the routine file; a test compares it with the ledger); a
"fix" that weakens (the gate, the direction table, the test that reverses every fix); Undo as a
weakening path (owner-only, confirmed, only back to his own earlier value, logged); the token fix used
by someone holding a stolen session (needs the current token, as the Devices page does); the secrets scan
leaking the secret (no value in responses, logs, `safety_runs`; originals only in the vault); the check-up
report as reconnaissance for a member or a partner (owner-only routes and tool; members 404).

---

## 7. Household isolation

- **Routines per space.** A member's space has its own `routines` table, settings and planner, as today.
  Members may turn on the **briefing, the weekly review, reminders and leave-by** in their own space (their
  briefing/review model calls count against their `MemberLimits` as any background call does); never
  GitHub, hooks or loop routines (their companions have no tools, `isMember`), and they never see the
  owner's routines.
- **The check-up is the owner's**, covering the whole server (members' devices included, with names, as the
  Household page shows them); members have no page, route or tool for it.
- **Secrets scan** covers every companion in the **owner's** space; members' spaces are not read (their data
  is theirs; §11 Q12 asks about an opt-in for members).
- Chat apps belong to the owner's main companion, as today: `/routines` there is his.

---

## 8. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `briefing.ts`, `review.ts`, `leaveby.ts` settings and workers; `planner.addReminder`, `Repeat`, `nextOccurrence`, `ReminderScheduler` | — | `templates/routines/*.json` (ten files) |
| `loops.ts` (ticks, caps, quiet hours, stops, `met` rule), `DailyLedger`, `persist` settings | `chat_loops.schedule`, `.routine_id`, `meta.allow` (read-only list), routine-loop restart rule, `routineMaxDays`, `routineMinEvery`, the "ends on" line | `src/routines.ts` (R1–R4), `routines` table |
| `issues.ts` GitHub poller and token, `webhooks.ts` + `PRESETS.github-ci-failed`, `weakKind` | `GitHubWatch.ci`, `ciBranch`, `ciSeen` (Actions runs list) | — |
| CH2 channel projects | a `Routines` channel project | — |
| `checklist.ts`, `web/first-run.js` queue and `starterChips`, Today's empty state, Planner tabs | the `morning` step's words and rule; one wizard link; three empty-state cards | `web/routines.js`, `web/routines.css` |
| `runDoctor`, `DoctorCheck`, `formatDoctor`, `accessInfo`, `SandboxInfo`, the tool registry's defaults and `runsCommands`, `Updater` status, `listBackups`, offsite state, `auth` sessions / passkeys / TOTP / `rotateToken`, A2A revoke, hooks' pause, `Redactor` / `KEY_SHAPED` / `vaultSecretValues`, the vault | `OwnerFile.tokenAt`; `--doctor` Safety section, `--safety` flag and exit codes; Health page's top line | `src/safety-check.ts` (S1–S3, `tightensOnly`), `safety_runs`, `safety_fixes`, `web/safety-check.js`, the `dh-safety` page, tool `safety_report` |
| `settingsguide.ts`, `web/tips.json`, i18n (six languages), `commands.ts` (`/status`, owner-only commands) | `/status` lines; `/routines` | tool `suggest_routine` |
| Plugin manifest and ST3 review card | manifest `routines` array; `readOnly` flag on plugin tools (shown on the card) | — |

Nothing needs an npm package. No new timer (the reminder tick, the LifeWorker, the GitHub poller, the
hourly backup timer), no new run kind, no new model job.

---

## 9. Risks

1. **Cost estimates are wrong for big pages or long inboxes.** *Mitigation:* "about" in words, caps are what
   code enforces, the estimate learns from the last 7 days of that purpose, the tick budget ends a heavy turn.
2. **A price page that blocks bots or renders prices with scripts.** `web_fetch` may see no price.
   *Mitigation:* a tick that can't find a price is `changed` once ("I couldn't read a price on that page")
   then `same`; the no-progress stop (6) ends it; the card says "works best with a shop's product page".
3. **Routine loops surviving restarts** weaken Phase 118's "paused after restart". *Mitigation:* only for
   routine loops with an end date and a schedule ≥ 6 h apart; missed slots are skipped; §11 Q3 offers the
   strict alternative.
4. **A read-only tool that isn't.** A future tool mislabeled read-only could act in a tick. *Mitigation:*
   `READ_ONLY_TOOLS` is a fixed list in code (not a flag tools set on themselves) for built-ins, and plugin
   tools need `readOnly` shown on the review card; a test fails if a listed tool has `runsCommands`,
   `asksFirst` or a write path.
5. **Fix that locks the owner out.** *Mitigation:* nothing touching the way in is one-click; the token fix
   shows the new token before signing out and needs the current one; signing out devices lists them first.
6. **False alarms make beginners ignore the page** (e.g. "no HTTPS" at home on purpose). *Mitigation:*
   *I know, don't warn me* for ambers, red reserved for "someone could get in or you could lose data",
   Today shows reds only.
7. **Secrets scan false positives** (a long hash in a coding note). *Mitigation:* vault matches are red,
   pattern matches amber with the note named; Hide is reversible for 30 days.
8. **Two lists of scheduled things** (Routines vs Repeats vs Her plans). *Mitigation:* My routines shows
   everything that runs on a schedule (*Set up elsewhere*), and Repeats/Her plans link to it.
9. **The CI poll hits GitHub's rate limit** with many repos. *Mitigation:* the existing 15/60-minute choice,
   5 runs per call, the same token; a 403/429 is one amber line on the routine ("GitHub asked us to slow
   down") and the poll backs off.
10. **Old clients** (2.53 apps) don't know the Routines tab or the check-up page. *Mitigation:* notices are
    ordinary messages; nothing breaks without the new views.

---

## 10. The phase at a glance

The release ships its docs in the same commit: a user guide page (`docs/ROUTINES.md`: *Routines* and
*Safety check-up*), SECURITY_CHECKLIST pointing at the page ("or let Sara check: Data & health → Safety
check-up"), `web/help.html`, CHANGELOG, ROADMAP / ROADMAP.public, i18n in six languages, ? tips,
THREAT_MODEL, and the README "What's new" row.

| Phase | Version | Slice | Main new code | Test |
|---|---|---|---|---|
| 121 part A | 2.54.0 | the catalog and cards, preview, Turn on / Off, My routines with *Set up elsewhere*, the cost line, routine loops (schedule, end, read-only allow, restart rule), CI watch, the beginner path (wizard link, Today, Getting started, Planner tab), `/routines`, plugin routines, `suggest_routine` | `routines.ts`, `templates/routines/`, `routines`, `chat_loops` columns, `GitHubWatch.ci`, `web/routines.js` | `test/phase121.test.ts` (part A) |
| 121 part B | 2.54.0 | the check-up page, S1–S17, the verdict, one-click fixes through the gate, Undo, accept, the token fix and `tokenAt`, hiding secrets, guided fixes, `sara doctor` Safety section and `--safety`, the weekly quiet check, Today's red line, `safety_report` | `safety-check.ts`, `safety_runs`, `safety_fixes`, `web/safety-check.js` | `test/phase121.test.ts` (part B) |

Part A's *Backup check* routine turns on part B's weekly check, so B's S3 is built first or the routine
ships hidden until B lands; otherwise each part can be built and tested in one helper run. One release,
one test file.

---

## 11. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Which ten routines.** Default: **the ten in §4.2** (briefing, weekly review, stretch, bedtime, leave on
   time, inbox triage, price watch, CI, new issues, backup check). Alternative: add a *news digest* and a
   *competitor watch* (paid search loops) now instead of leaving them to plugins.
2. **Bedtime wind-down with tomorrow's first event.** Default: **plain reminder text** (free, no new
   reminder feature). Alternative: the reminder fills in tomorrow's first calendar event in code (a small
   reminder feature, still no model).
3. **Routine loops after a restart.** Default: **stay active, skip missed slots** (only routine loops with
   an end date and ≥ 6 h apart). Alternative: paused like every loop, with one "Resume your routines" line
   after each restart.
4. **Longest a paid routine may run.** Default: **30 days**, choices 7 / 14 / 30 / 90, renewed only by a
   tap. Alternative: no end for clock-scheduled routines (still capped per day).
5. **Read-only tools in unattended ticks.** Default: **the tools named on the card run without asking even
   if set to ask** (read-only list only; *never* stays never). Alternative: they must already be on *auto*,
   or the card offers to switch them (that would loosen the global setting, which the check-up flags).
6. **Adult mode "PIN".** Default: **the sign-in lock Sara has** (a passkey, which uses the device PIN, or
   two-step) counts as the lock; no new PIN in 2.54. Alternative: a real adult-mode PIN (asked when opening
   adult chats on a device; a new small feature, best as its own phase item).
7. **Token age.** Default: **amber after 365 days or when unknown; never red**. Alternative: 180 days, or
   don't check age at all (only "someone may have seen it").
8. **The token fix keeps passkeys.** Default: **keep passkeys and two-step** (hygiene); the Devices page's
   own button stays the "someone had it" reset. Alternative: clear passkeys as that button does.
9. **Fix all.** Default: **no** *Fix all* button; each fix is its own tap. Alternative: *Fix all safe ones*
   for one-click fixes marked *Undo any time* only.
10. **`sara doctor --fix`.** Default: **not in 2.54** (the page only). Alternative: `--fix <id>` for the
    `any`-undo fixes from the CLI, logged the same way.
11. **Amber on Today.** Default: **reds only** on Today. Alternative: one weekly line when there are ambers.
12. **Secrets scan scope.** Default: **the owner's companions' memories, notes, recipes, learned skills and
    people notes; no conversations; no members' spaces**. Alternative: also conversations (big and slow),
    or members' spaces with their own opt-in on their page.
13. **Out-of-date: red when.** Default: **red when the newer release says `Security:` or the running version
    is over 180 days old**; amber otherwise. Alternative: always amber.
14. **CI watch interval.** Default: **every 15 minutes** while `ci` is on (the watcher's faster choice).
    Alternative: 60 minutes to spare the API, with *Instant* as the fast path.

---

## 12. Key choices in short

- **A routine is a recipe for an engine Sara already runs**: briefing, weekly review, reminders,
  leave-by, the GitHub watcher, a webhook preset, or a Phase 118 loop. No cron, no new timer.
- **Six of ten routines are free**, and the card says so; the paid ones show **calls, a per-day cap
  that code enforces, and an end date**, built from code, with a one-tap Off.
- **Loops grow just enough for routines**: a clock schedule, up to 30 days, read-only tools named on the
  card, active across restarts with missed slots skipped. A typed `/loop` is unchanged.
- **Preview before every Turn on**, code-only, with a stale-preview guard; My routines shows everything on
  a schedule, including what was set up elsewhere.
- **The check-up grows `sara doctor`**: 17 checks in plain words, a verdict in words (no score), one-click
  fixes only where they can only tighten (a gate in code enforces it), each labelled *Undo any time*,
  *Undo for 30 days* or *Can't be undone*; anything touching the way in is guided.
- **Owner only for the check-up**; members get free routines plus briefing/review in their own space;
  the mandatory safety layer is in every tick and untouched by every fix; zero npm runtime dependencies.

---

## 13. Sources

Public feature pages, read 2026-11-02 (features only; no code, prompt or wording taken). Index entries are
GAP_REVIEW's (§Sources there) except [O16]:

- [H10] Hermes Agent, *Automation Blueprints Catalog* ("ready-to-run automations. Pick one, fill in a couple
  of fields, and Hermes schedules it as a cron job"; morning briefing, important-mail monitor, weekly review,
  workday start, custom reminder, evening wind-down, news digest, bills and renewals, price and availability
  watch, competitor news watch; `/blueprint <name>` from every surface; "never schedule anything silently";
  plugin blueprints prefixed; jobs outlive a disabled plugin).
  https://hermes-agent.nousresearch.com/docs/reference/automation-blueprints-catalog
- [O15] OpenClaw, *Security CLI* (`openclaw security audit`, `--deep`, `--json`, `--fix`: "audit plus optional
  safe fixes"; DM/trust model, webhook token, sandbox/tool checks, Node patch level; `--fix` flips open group
  policies to allowlists and tightens file permissions, and does not rotate tokens, disable tools, change the
  bind/auth/exposure or rewrite plugins/skills). https://docs.openclaw.ai/cli/security
- [O16] OpenClaw, *Security* (the gateway security guide linked from [O15]; read for context only).
  https://docs.openclaw.ai/gateway/security

Sara code read for §1: `src/briefing.ts`, `src/review.ts`, `src/leaveby.ts`, `src/planner.ts` (`Repeat`,
`Reminder`, `addReminder`, `parseWhen`), `src/reminders.ts`, `src/loops.ts` (`Loop`, `LoopMeta.allowOnce`,
states, `resume`), `src/persist.ts` (loop settings and choices), `src/goals.ts` (states), `src/agenda.ts`,
`src/issues.ts` (`GitHubWatch`, `cleanWatch`), `src/webhooks.ts` (`ActionKind`, presets), `src/webhook-verify.ts`
(`PRESETS`, `weakKind`), `src/jobs.ts`, `src/movein/schedules.ts`, `src/recipes.ts`, `src/starters.ts`,
`src/gallery.ts`, `src/checklist.ts`, `web/first-run.js`, `src/doctor.ts`, `src/routes/admin.ts` (the admin
route list), `src/auth.ts` (`OwnerFile`, `rotateToken`, `resetToken`, sessions), `src/platform.ts`
(`accessInfo`), `src/main.ts` (`SARA_HOST`, `SARA_DEMO`, the backup timer), `src/server.ts` (`isHttps`),
`src/tools/types.ts` (`Permission`, `runsCommands`, `asksFirst`), `src/tools/sandbox.ts`,
`src/bridges/telegram.ts` and `discord.ts` (settings), `src/hub.ts`, `src/a2a.ts`, `src/redact.ts`,
`src/memory-worker.ts` (redaction on write), `src/updates.ts`, `src/net-guard.ts`, `src/private-local.ts`,
`src/household.ts` (`OWNER_SETTINGS`), `src/settings.ts` (`adultMode`), `src/settingsguide.ts`, `web/tips.json`,
`web/index.html` (settings pages), `test/helpers.ts`; docs `ROADMAP.md` (Phase 121), `design/GAP_REVIEW.md`
(#8, #11, G13, G16), `design/PERSIST.md`, `design/RECALL.md`, `design/POLISH.md`, `SECURITY_CHECKLIST.md`,
`WEBHOOKS.md`.

## As built (2.54.0)

Built as designed above, with these differences:

- **Question 5 is NO** (owner override): tools a routine uses keep the owner's approval settings. A
  routine whose tool is on *Ask* pauses and tells him, the same as a Phase 118 repeat; every card and
  preview says so. Nothing in 2.54 sets a tool to auto on his behalf.
- The other blocking questions use their defaults.
- Code: `src/routines.ts` + `src/routes/routines.ts` + `templates/routines/*.json` (10) +
  `web/routines.js`; `src/safety-check.ts` + `src/routes/safety-check.ts` + `web/safety-check.js`;
  shared styles in `web/begin.css`. Tables: `routines` (per space), `safety_runs`, `safety_fixes`;
  new columns `chat_loops.schedule`, `chat_loops.routine_id`; `owner.json` gains `tokenAt`.
- The CI watch is poll-only (every 15 minutes, `githubWatch.ciRepos`, separate from `repos` so CI
  never makes to-dos); the *Instant* webhook option is not built.
- Not built: `/routines` in Telegram/Discord, plugin routines, *Try it once now* on an unsaved card,
  members' devices in *Old devices* (they are signed out on the Household page), a live network probe of
  local model servers (the open-server check reads settings and `OLLAMA_HOST`).
- `sara doctor --safety` is read-only; it exits 0 / 1 / 2 (safe / tighten / fix first).
- User guides: [ROUTINES.md](../ROUTINES.md), [SAFETY_CHECKUP.md](../SAFETY_CHECKUP.md).
