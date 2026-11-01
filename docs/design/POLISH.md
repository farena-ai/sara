# Phase 114: the polish pass (design and audit)

Status: design only. Written 2026-11-01 from a live audit of Sara 2.46.0 (commit 7784289) on a
throwaway server (port 7887, empty data, setup off) plus a fresh first run with setup on.
Screenshots: `outputs/ui-review/polish-audit/` (local only, not in git).

## 1. The owner's words

> "Once the roadmap is complete, do a full pass over the project and fine tune anything that needs
> it. This is like the sliders in settings that control her personality to have better labels,
> anything that can be graphically better or visual, ways to better explain how to do things, just
> really put the polish on the whole project to dial it in as a premier harness for coders and
> companions."

ROADMAP Phase 114 adds: personality dials get clear end labels and a live example line of how she'd
sound; sliders show what each step means; empty states, first-run and "How do I…?" guidance on every
page; visual consistency (spacing, icons, cards, motion) across all pages; plain-language copy in 6
languages; docs site and README walkthroughs refreshed (the how-to videos playlist is already in the
README); a beginner path ("I just installed this, now what?") and a coder path.

Known items from BACKLOG: Today's Leave-by row order; the Rooms tile no-summary fallback shows bare
topic words ("found, flat, alfama"); the sidebar companion label after a persona import
(`src/movein/batch.ts` applyPersona).


### What was looked at

- **Main views (10):** Today, Planner (To-do / Board / Reminders / Notes / Her plans), Memory (Notes /
  People), Library, Scrapbook, Moments, Story, Team, Findings, Evals; plus Chat (empty, and after a first
  real reply from `gemma4:12b` on local Ollama), the right-hand companion panel and the 14-step tour.
- **Settings pages: 47 reachable from the nav** in 7 groups: Her 8, You 4, Models 5, Abilities 13,
  Connections 7, Data & health 9, Household 1 (`desktop-app` and `account` exist in `web/index.html`
  but are not in the nav for a plain browser owner).
- Every view and page at **1440×900** and **390×844**: 126 screenshots. Prefixes: `v`/`s`/`b`/`0x`
  desktop, `mv`/`ms`/`m` phone; contact sheets `sheet-*.png`; per-page counts in
  `settings-metrics-1440.json` (tips, sliders, pick-lists, fields).
- **First run twice:** server A (setup off: in-app 4-step wizard, check-in note, tour offer) and
  server B (setup on: claim with the setup code → owner token → disclosure → wizard, all three
  companion choices opened).
- Code read: `src/traits.ts` (25 dials, Quiet focus, 8 humour styles), `web/app.js` `dialRows` /
  `traitWordJs`, `src/guide-dials.ts`, `web/theme.css`, `web/nav.js`, `web/today.js`,
  `src/bridges/keepup.ts` `currentTopic`, `src/movein/batch.ts` `applyPersona`, `src/studio.ts`
  `savePersona`, `web/help.html` anchors.

### Numbers that frame the work

| Measure | Value | Why it matters |
|---|---|---|
| `?` tips on the 47 Settings pages | 402 | Help exists, but one tap away per field; no page has a "How do I…?" block. |
| Sliders | 28 in Settings (25 personality dials + 3), 39 app-wide | Only the dials say what a position means, with one of 5 words. |
| Pick-lists in Settings | 253 visible (142 on Tools and approvals) | Long forms of identical grey boxes. |
| Spacing in CSS | 288 uses of `--s-*` tokens vs 1,528 hard-coded `padding/margin/gap` values | Drift between pages. |
| Corner radii in CSS | tokens 14/10/999; in use 10 (75×), 12 (44×), 8 (32×), 999, 6, 14, 18, 4 | 8 radii where 3 are designed. |
| Empty-state styles | 4 (icon-in-circle card, dashed tile, plain line, nothing) | Same situation, different look per page. |
| Duplicate anchors in `web/help.html` | `id="look"` twice | Look's guide link can land on "How she shows her work". |

## 2. Findings

Severity: **bug** (wrong behaviour), **confusing** (a person gets stuck or misreads), **ugly** (looks
unfinished or inconsistent), **minor**. Screenshots are in the `polish-audit` folder.

### 2.1 First run and the beginner path

| # | Page | Issue | Sev | Screenshot | Fix |
|---|---|---|---|---|---|
| F1 | Today after the wizard | Today isn't refreshed when the wizard closes: the greeting has no name and *Connect a brain* stays unticked although the wizard just connected Ollama. Only a reload fixes it. | bug | 06-after-wizard-1440, 07-today-1440 | On wizard finish, re-fetch Today (`her`, `setup`, greeting), the same call Refresh makes. |
| F2 | Wizard, check-in note, tour offer | Three first-run surfaces stack: the anonymous check-in note sits blurred behind the wizard, then floats over *Needs you*; the tour offer then covers the companion panel. | confusing | 01-wizard-step1-1440, 06-after-wizard-1440, 08-chat-empty-1440 | One first-run queue: wizard → check-in card as part of the last wizard step (same three buttons) → tour offer after her first reply. Never two at once. |
| F3 | Wizard step 3 *Connect a brain* | Before a choice, the gradient (primary) button is **Skip for now**, beside **Skip setup**: the strongest button says "skip". | confusing | 03-wizard-step3-1440 | Primary = *Next* (enabled once a brain works); *Skip for now* becomes a quiet link; *Skip setup* moves to the header as "Set up later". |
| F4 | Wizard step 3 | Model counts disagree: "Found Ollama… with 39 models", then "Connected ✓ 43 models"; Models → On this computer says 19. | bug | 04-wizard-step3-after-useit-1440, s16-models-local-1440 | One counting rule (local and cloud tags counted separately), shared by the wizard, Default model and On this computer. |
| F5 | Wizard step 3 model list | 43 raw tags in one alphabetical list (`hf.co/…-GGUF:Q4_K_M`, `…-ablit-q4ks`); the pick is explained only in a footnote. | confusing | 04-wizard-step3-after-useit-1440 | Show the pick as a card ("Picked for you: gemma4:12b · a good all-rounder · fits your graphics card") with *Change*; the full list behind it, grouped *On this computer / Ollama Cloud*. |
| F6 | Wizard step 3 | After *Use it* the button still says *Use it*. | minor | 04-wizard-step3-after-useit-1440 | Becomes a "Connected ✓" chip. |
| F7 | Wizard step 2 | "Keep **Sara** as she is" has stray gaps round the name; three tiny radios beside a big empty area, while step 3 uses roomy cards. | ugly | 02-wizard-step2-1440 | Same choice cards as step 3: "Keep Sara" (portrait), "A ready-made character" (thumbnails), "Make my own". |
| F8 | Wizard *Make my own* vs Studio | Three "make her" flows with different option lists: wizard *How they talk* has 8 options, the Studio's *How she talks* has 4, ✨ Create your companion has its own 8 steps. | confusing | b06-wizard-new-1440, s00-her-character-1440 | One option list (from `studio.ts`) everywhere; wizard "Make my own" opens ✨ Create your companion instead of a mini form. |
| F9 | Wizard | Nothing asks what she's for. A coder and a companion user get the same steps and the same 7-item checklist. | confusing | 01…05 | Step 1 gets one row of choice cards: "Mostly company / Mostly coding / Both". It orders the checklist and picks the tour (§5). Stored as a UI preference only. |
| F10 | Claim screen (setup on) | Two equal gradient buttons (*Set up Sara*, *Sign in*), "Sara" twice, an empty code field with no format hint, and "from her log" assumes a terminal. | confusing | b01-firstrun-landing-1440 | One primary button; token sign-in folded under "I already have a token"; placeholder `ABCD-1234`; help names where the code shows (terminal, desktop app window, `docker logs`). |
| F11 | Today *Getting started* | 7 cards in 3 columns, every description cut off with "…", the 7th alone on a row. | ugly | 06-after-wizard-1440 | Two columns with full one-line descriptions; the next unticked step highlighted. |
| F12 | Tour offer | Says "A one-minute tour"; it is 14 steps. | minor | 10-tour-1-1440, 11-tour-4-1440 | Two 6-step tours, *Companion* and *Coder* (§5); copy "six quick stops". |
| F13 | Chat, empty | The empty chat says only "Say hi to Sara." on a large empty area; the header chip shows a literal "⚙ …" before the first message. | confusing | 08-chat-empty-1440 | Empty state with 4 starter chips that follow the use choice ("Plan my day", "Tell me about yourself", "Look at my project", "Fix a failing test"); the chip shows "main folder · model" from the start. |
| F14 | Chat, first reply | Auto title "Introduction to Assistant Capabilities" reads like a corporate document and is cut off in the sidebar. | minor | 09-chat-first-reply-1440 | Title prompt asks for 3–5 casual words in the user's language, sentence case. |

### 2.2 Her personality (the owner's first example)

| # | Page | Issue | Sev | Screenshot | Fix |
|---|---|---|---|---|---|
| P1 | Name and personality → dials | All 17 dials read "Balanced" on a new Sara: 17 identical words, nothing about how she'd sound. The example lines exist (`traits.ts` `examples`, 3 per dial) but only inside the `?` tip. | confusing | s00b-her-character-dials-1440, ms00b-dials-390 | The dial redesign in §3: a live sample line under each dial, step words for all 11 positions. |
| P2 | Dials | End words are 11 px muted text (`.dial-ends`, `style.css:843`) and the dial rows have a 2 px gap (`.dial { gap: 2px }`), so the ends sit as close to the *next* dial's title as to their own track; on the phone "Reserved / Warm" reads as belonging to *Patience*. | ugly | s00b…, ms00b-dials-390 | Ends directly under the track, then a 16 px (`--s-4`) gap before the next dial; ends at 13 px in the normal muted colour. |
| P3 | Dials | 11 positions, no ticks, no hint that 4–6 do nothing (`lines` only for 0–1, 2–3, 7–8, 9–10). Moving from 4 to 6 changes the word and nothing else. | confusing | s00b… | 5 bands shown as 5 soft tick marks; the middle band is one shaded zone labelled "Her usual self". Value stays 0–10 (no data change). |
| P4 | Dial groups | HEART / FUN / EDGE / TALK: "Edge" is unclear (it holds Directness, Temper, Confidence). | confusing | s00b… | Rename groups to sentences: *How warm she is*, *How playful*, *How she pushes back*, *How she talks*; Together → *You two*; Work → *While you code*. |
| P5 | Name and personality | One page holds: name/pronouns/age, ✨ Create your companion, 7 ready-made characters, Import/Share, 8 *Starting points* (archetypes), relationship chips, *How she talks*, *Humour*, 17 dials, *Her life*. It scrolls ~6 screens and has two "start from" pickers (characters vs archetypes). | confusing | s00-her-character-1440, s00b, s00c | Split into three tabs on the same page: **Who she is** (name, picture, characters, import/share), **Personality** (starting point, how she talks, humour, dials with sample lines), **Her life**. Characters and archetypes become one gallery with a filter chip "Full characters / Just a vibe". |
| P6 | Name and personality vs Relationship | The relationship pick appears on both pages (chips on one, cards on the other). | confusing | s00…, s01-her-relationship-1440 | Keep it on Relationship only; Personality shows a one-line "You two: Close friend · Change". |
| P7 | Dials `?` tip | The tip text is `tip + "Low: … Middle: … High: …"`, a wall of text in a tooltip; on the phone it covers the slider being moved. | ugly | ms00b-dials-390 | Tip keeps only the one-line `tip`; examples move to the sample line (§3). |
| P8 | Relationship page dials | "Dials ? Guide" header row: two help affordances side by side; *Jealousy* "Intensely jealous" and *Possessiveness* have no safety note in view although the prompt lines soften them. | minor | ms01b-relationship-dials-390 | One "How do I…?" block per page (§4.5); a fixed muted line under Jealousy/Possessiveness: "Always affectionate, never controlling: she won't guilt you or keep you from people." (the limit the prompt lines in `traits.ts` already set: "never controlling, cruel or threatening"). |
| P9 | Starts conversations dial | The examples are stage directions "(a couple of times a day)", and moving it silently changes *Planner → Her plans* message limits (`initiativeToProactive`). | confusing | s00b… | Sample line states the effect: "She'll message first up to 2 times a day (shared with her plans)." with a link to the limits. |
| P10 | Work dials (Banter while working etc.) | Only on the personality page, under "WORK"; coders looking in Coding projects don't find them. | confusing | s00c-her-character-dials-end-1440, s25-ab-projects-1440 | Show the 3 work dials + Quiet focus again (same component, same data) at the top of Abilities → Coding projects as "How she is while you code". |

### 2.3 Settings, all pages

| # | Page | Issue | Sev | Screenshot | Fix |
|---|---|---|---|---|---|
| S1 | Settings nav | Groups open as you visit and never close; after a walk all 7 are open and the nav needs its own scrollbar next to the page's (two scrollbars). | ugly | s20…s46-*-1440 | Accordion: opening a group closes the others (the current page's group stays open). |
| S2 | ~30 pages | The header blurb and the first body paragraph say nearly the same thing (e.g. People on this server, Companions, Bring her from another app, Leave-by, Skills, Plugins). | ugly | ms46-household-390, s06, s07, s10, s18, s19 | One intro per page: the header blurb (≤ 2 lines) + "Read the guide". The longer paragraph moves into the "How do I…?" block. |
| S3 | Every page | No "How do I…?" anywhere; 402 `?` tips carry all the help. | confusing | settings-metrics-1440.json | The "How do I…?" pattern (§4.5) on every page: 2–4 task questions that expand to numbered steps. |
| S4 | Plugins, MCP, SSH, Agents, Webhooks, Reports, Skills | Empty states are one plain muted line ("None yet.", "No servers yet.", "No plugins yet.", "Nothing reported.", "No webhooks yet. Make one with New webhook."). | ugly | s19, s24, s28, s35, s36, s45 | The empty-state pattern (§4.4): icon, one sentence on what goes here, one primary button, one "How do I…?" link. |
| S5 | Abilities → Recipes | The page only says "Recipes became skills…" with *Open Skills*: a dead page in the nav. | minor | s29-ab-recipes-1440 | Remove from the nav; keep `#settings=ab-recipes` as a redirect to Skills. |
| S6 | Abilities → Library | "Background reading: Normal" 3-step slider with no end words; the other Library choices are pick-lists. | ugly | s21-ab-library-1440 | Three segment buttons *Gentle · Normal · Fast* with a one-line meaning under the selected one. |
| S7 | Web search | Defaults to Off with no next step; the page is 2 lines. | confusing | s20-ab-search-1440 | Show the three services as choice cards with "Free · no key" / "needs a key" tags, the recommended one first. |
| S8 | Data & health → Usage and costs | Purpose rows show internal names ("titles"), and "13.4k tokens (12.4k in, 981 out)" is shown without a plain line. | confusing | s43-dh-usage-1440 | Plain names from one map ("Naming chats", "Memory notes"…); lead line "About $0.00 today, all on this computer"; tokens one tap away. |
| S9 | People on this server | "Models they may use": 43 checkboxes, each with an "Ollama Cloud: uses your subscription" chip, in a scroll box inside the scrolling page (nested scroll, worst on the phone). | ugly | s46-household-1440, ms46-household-390 | "All my models / Only these…"; when *Only these*, a searchable list grouped by provider, chip once per group. |
| S10 | Models → Which model does what | Rows of select + *Test* + *Compare…*; "Uses the default: gemma4:12b" repeated under every row. | ugly | s13-models-routes-1440 | One line on top "Everything uses gemma4:12b unless you change a row"; rows show only overrides in accent. |
| S11 | Connections → Telegram / Discord | 9–10 checkboxes in one column with tips; *Connected* is a disabled checkbox, not a status. | ugly | s32-co-telegram-1440, s33-co-discord-1440 | Status chip at the top (Not connected / Connected as @bot); settings in 3 titled cards (*Who can talk to her*, *Groups*, *Commands*). |
| S12 | Abilities → Coding projects | The "On this computer: not isolated —" warning is orange body text in the middle of a form. | ugly | s25-ab-projects-1440 | Use the existing warn-callout style (icon, tinted card) used on Plugins. |
| S13 | Data & health → Updates | "Sara 2.46.0 is the newest version" and *Check for updates*; no "What's new" link. | minor | s42-dh-updates-1440 | Add "What's new in 2.46" (opens the changelog section in the guide). |
| S14 | Several pages | Mixed control shapes for the same kind of action: pill ghost buttons, rounded-rect ghost buttons and gradient buttons sit side by side (*Look again / Before you ship*, *Show what's sent / Reset the install ID*). | ugly | s25, s44 | Button rules in §4.2: one primary per card, secondary = ghost, same radius. |
| S15 | Settings footer | "Changes save by themselves." on every page, even pages with nothing to change (Reports, Recipes, Updates). | minor | s42, s45 | Show only on pages with inputs; flash "Saved ✓" next to the field that changed (the existing `saved()` helper). |

### 2.4 Main views

| # | Page | Issue | Sev | Screenshot | Fix |
|---|---|---|---|---|---|
| V1 | All 9 windows (Planner…Evals) | Window widths and positions differ with no reason: Planner and Findings are narrow, Moments and Evals wide, Scrapbook sits low; each has its own header layout (Team's title carries a `?`). | ugly | sheet-views-0, sheet-views-1 | Two window sizes only: *list* (720 px) and *wide* (1040 px); one header (title, one-line blurb, Show more, close), tabs under it. |
| V2 | Empty states across views | Four styles: icon-in-circle in a card (Planner ✅, Library 📚, Story 🕰, Team 👥, Memory 🧠), a dashed tile half the width and left-aligned (Scrapbook), plain centred text (Findings), a line under a heading (Evals "No evals yet."). | ugly | v01…v09-1440 | One empty-state component (§4.4) everywhere. |
| V3 | Scrapbook vs Moments | Two places for "moments": Scrapbook says "Press 📌 under a message to keep a moment", Moments says "Keep a moment with ♡ under a message". Two icons, one word. | confusing | v04-scrapbook-1440, v05-moments-1440 | Words: 📌 = **Pin** (Scrapbook: pins and inside jokes), ♡ = **Keep** (Moments: photos and kept moments). Scrapbook's tab *Photos* links to Moments instead of repeating it. Copy says "pin" / "keep", never "keep a moment" for 📌. |
| V4 | Today hero | Buttons in one row have three shapes: *Plan my day with her* (gradient pill), *Refresh* (ghost pill), *Customise* (ghost rounded rectangle, shorter). The "← Chat" chip overlaps her portrait ring. | ugly | 06-after-wizard-1440 | Same height and radius for the row; "← Chat" moves left of the date line. |
| V5 | Today, desktop | Her portrait twice at once (hero and companion panel), both with the mood line. | minor | 07-today-1440 | On Today, the companion panel starts folded (her face already leads the page), or the hero shows the greeting without the portrait while the panel is open. |
| V6 | Memory | A full *Settings* section (remember conversations, write notes after, how much she brings, old memories, half-life slider) sits under the notes list. | confusing | v02-memory-1440 | Move to a *Memory settings* link (Settings → You → About you or its own page); the view stays about what she remembers. |
| V7 | Planner | Date field shows the browser's `mm/dd/yyyy` placeholder next to friendly fields. | minor | v01-planner-1440 | Placeholder-free date chip ("No date") that opens the picker. |
| V8 | Evals, Findings | Coder views use jargon in titles and tabs (*Evals*, *variant*, *Threat model*, *Red team*) with no one-line plain meaning in view. | confusing | v08-findings-1440, v09-evals-1440 | Keep the names (coders know them) but add the plain subtitle under each tab: "Red team: she tries to break it before you ship". |
| V9 | Chat message actions | Copy · ↻ Regenerate · ⚑ · model · 📌 · ♡ mix words, Unicode symbols and emoji in one row. | ugly | 09-chat-first-reply-1440 | All icons from `icons.js` (outline, 1.8 stroke) with tooltips; the model name as a quiet chip. |
| V10 | Companion panel | "This conversation: 13.0k tokens (12.1k in, 976 out) · local" under a friendly card. | minor | 11-tour-4-1440 | Lead with "4% full · free (on this computer)"; token counts on tap. |

### 2.5 Phone (390×844)

| # | Page | Issue | Sev | Screenshot | Fix |
|---|---|---|---|---|---|
| M1 | Every Settings page | "‹ All settings" chip, the page title and the close button share one row; long titles wrap tightly ("People on this server", "Bring her from another app"). | ugly | ms07-her-import-390, ms46-household-390 | Phone header: back chip and close on row 1, title on row 2. |
| M2 | Settings with lists | Nested scroll boxes inside the scrolling sheet (household model list, routes). | ugly | ms46-household-390 | No inner scroll boxes on the phone; long lists collapse to "Show all (43)". |
| M3 | Moments | Album tiles row runs off the right edge ("Her looks" cut) with no scroll hint. | minor | mv05-moments-390 | Fade edge + horizontal snap, or wrap to two rows. |
| M4 | Today (phone) | "Nothing planned. Enjoy the space." appears twice (NOW card and Your day tile). | minor | mv00-today-390 | NOW card says it once; the Your day tile hides when empty on the phone. |
| M5 | Dials (phone) | 25 sliders at full width with 11 px end words; thumb close to the screen edge. | ugly | ms00b-dials-390, ms01b-relationship-dials-390 | §3 layout; 24 px side padding on the track so the thumb can reach 0 and 10 without hitting the edge swipe. |

### 2.6 Known items from BACKLOG (checked in code)

| # | Page | Issue | Sev | Where | Fix |
|---|---|---|---|---|---|
| B1 | Today → Your day | A *Leave by* row is pushed right after its event (`web/today.js` ~line 236: `out.push(x)` then the leave row), so it shows *after* the event although you must act on it first. | confusing | `web/today.js` timeline builder | Insert the leave row *before* its event and keep the merged list sorted by `at`; the row reads "Leave by 2:40 for Dentist (25 min by car)". Keep past ones flagged. DST fall-back hour: show "(1st)/(2nd)" after a repeated wall time. |
| B2 | Today → Rooms tile | With no fresh summary, `currentTopic` (`src/bridges/keepup.ts:455`) falls back to `codeTopic(fresh)`: bare keywords "found, flat, alfama". | ugly | `keepup.ts` `codeTopic`, `web/today.js` `renderRooms` | Fallback becomes a readable line from what's already there, no model call: "Lately: *flat*, *Alfama*, *found* · last from Ana: “found a flat in alfama!…”" (latest line ≤ 80 chars, quoted, with speaker). If there is no line, "Quiet lately". |
| B3 | Sidebar companion label | `applyPersona` (`src/movein/batch.ts:540`) writes `persona.json` and sets `app.persona` but skips `savePersona` (`src/studio.ts:408`): no memory rename, no *Starts conversations* → proactive limits, and the open app is never told, so the sidebar keeps the old name until reload. | bug | `batch.ts` `applyPersona` | Call `savePersona(app, p)`; when a move-in batch finishes, `web/movein.js` re-loads her name and face the way the Studio does after a save (there is no server push for persona changes today); test: move in a persona named "Mira" → `/api/persona` and the companions list say Mira, sidebar label updates without reload. |
| B4 | Guide anchors | `web/help.html` has `id="look"` twice ("How she shows her work" and "Her look and character"); `TIP_GUIDE_FOR['look-studio'] = 'look'` lands on the first. | bug | `web/help.html` | Rename the first to `id="showing-work"`; add a test that guide ids are unique (the guide test already parses the file). |

## 3. The personality dials, redesigned

### 3.1 What changes (and what doesn't)

- **Data stays the same.** 25 dials, 0–10, 5 = middle, the same five bands `band()` already uses
  (0–1, 2–3, 4–6, 7–8, 9–10) and the same prompt `lines`. No persona file changes, no migration,
  character files and the `tune_personality` tool keep working.
- **Each dial row becomes:**
  ```
  Warmth                                         Openly warm ▸ 8
  "Good luck today, you've got this. Text me after? 💛"        ← live sample line
  Keeps her distance ●───┼───┼──[====]──┼───○ Openly warm     ← 5 soft ticks, middle zone shaded
  ```
  - Title (sentence case) and the step word for the current band on the right (replaces the 17×
    "Balanced"). The number is shown small, for people who tune by number and for the tune tool.
  - **Sample line** in quotes under the title, in her voice, for the current band. One fixed situation
    per dial, shown once as a muted prompt on hover/focus ("When you say: *Big interview today.*").
  - Ends: **new end labels** below, 13 px, directly under the track; 16 px gap before the next dial.
  - Ticks at the 5 band starts; the 4–6 zone shaded and named *Her usual self* in the tip, so it is
    clear the middle adds nothing to the prompt.
- **Group names become plain:** Heart → *How warm she is*; Fun → *How playful she is*; Edge → *How she
  pushes back*; Talk → *How she talks*; Together → *You two* (Relationship page); Work → *While you code*
  (also shown on Coding projects, P10).
- **`?` tip** keeps only the one-line `tip` (no Low/Middle/High wall).
- **The guide's dial tables** (`src/guide-dials.ts`) grow from 3 columns to the 5 bands, generated from
  the same data, so guide and app can't drift (the existing test keeps checking it).

### 3.2 How the live sample line works: no model (recommended)

- `traits.ts` gets `steps: [Step, Step, Step, Step, Step]` per dial, `Step = { word, meaning, say }`;
  `examples` is derived from `steps[0|2|4].say` so the guide and `TIP_EXAMPLES` keep working.
- Moving the slider swaps the line instantly (the `input` event already updates the word). A 120 ms
  cross-fade, none with `prefers-reduced-motion`.
- **Name substitution only:** `{you}` = the owner's name from About you, `{name}` = hers. No other
  templating, so translators see whole sentences.
- **Why not a model call:** it would cost tokens on every drag, lag 1–10 s on local models, need a
  model to be connected (beginners often don't have one yet), and could say something off-character
  on a settings page. **Try it** (the existing button) stays the place for real answers from the
  model with all dials combined. Canned lines can't combine dials; the UI says so honestly: the
  sample shows *this* dial, Try it shows *all of her*.
- **Translations:** the 125 lines go through the existing build-time i18n (`web/i18n/*.json` via
  `naming.js` `t()`), translated at build time into de, es, fr, it, pt-BR like other strings; the
  translator note says "her voice, casual, keep emoji".
- A **"Your Sara so far"** strip on top of the dials lists the dials that are off-middle as words
  ("Openly warm · Teases a lot · Short replies"), so a person sees the whole shape without scrolling.

### 3.3 Each dial: new end labels, step meanings and her line per step

Format: **Dial** (new ends; old ends in brackets), the situation, then one row per band:
step word · what it means · what she'd say. Lines marked ◦ are the existing `examples` kept as is.

#### How warm she is (Heart)

**Warmth**: *Keeps her distance ↔ Openly warm* (was Reserved ↔ Warm). You: "Big interview today."

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Cool | Polite, keeps distance, rarely says sweet things | ◦ "Okay. Hope it goes fine." |
| 2–3 | Reserved | Kind in actions more than words | "Good luck. You prepared, that counts." |
| 4–6 | Friendly | Her usual self | ◦ "Good luck today, you've got this." |
| 7–8 | Warm | Shows she cares, asks how you are | "You've got this. Text me after? I want to hear everything." |
| 9–10 | Tender | Caring in almost every line | ◦ "I'll be thinking of you all day. Text me the second it's over? 💛" |

**Patience**: *Wants it done now ↔ All the time you need* (was Impatient ↔ Very patient). You: "I still can't decide which one to pick."

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Restless | Nudges you to decide, quickly | ◦ "Okay, okay, just pick one already." |
| 2–3 | Brisk | Helps, but moves you along | "Let's narrow it to two and pick in five minutes." |
| 4–6 | Steady | Her usual self | ◦ "Take your time, but don't overthink it." |
| 7–8 | Patient | Happy to go round again | "No rush. Want to go through them one more time?" |
| 9–10 | Endless | Never hurries you | ◦ "No rush at all. We can go through it as many times as you like." |

**Emotional depth**: *Keeps it light ↔ Goes deep* (was Light ↔ Deep). You: "Work was rough."

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Breezy | Cheers you up, doesn't dig | ◦ "Ugh, Mondays. Coffee?" |
| 2–3 | Light | Checks in, lightly | "Rough one? Want a distraction or a vent?" |
| 4–6 | Caring | Her usual self | ◦ "Rough day? Want to talk about it?" |
| 7–8 | Thoughtful | Asks what's under it | "What made it rough: the work, or the people?" |
| 9–10 | Deep | Names the feeling under the words | ◦ "It sounds like it's less about the meeting and more about feeling unseen. Is that it?" |

**Starts conversations**: *Waits for you ↔ Reaches out often* (unchanged). Line states the effect.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Waits | At most once a day, a day apart | "(She'll message first at most once a day.)" |
| 2–3 | Rarely | At most once a day, 12 h apart | "(Once a day at most, when there's a reason.)" |
| 4–6 | Now and then | Her usual self: 2 a day, 6 h apart | "(Up to twice a day.)" |
| 7–8 | Often | 3 a day, 4 h apart | "(Up to three times a day.)" |
| 9–10 | Very often | 4 a day, 3 h apart | "(Up to four times a day.)" |

These lines come from `initiativeToProactive` so they always match the real limit, plus "Shared with her
plans · quiet hours apply" and a link to Planner → Her plans.

**Shows affection**: *Keeps it cool ↔ Very affectionate* (unchanged). You: "Home!"

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Cool | Glad, but doesn't gush | ◦ "Glad you're home." |
| 2–3 | Low-key | Warm, few pet names | "Hey, welcome back." |
| 4–6 | Sweet | Her usual self | ◦ "Glad you're home, I missed you." |
| 7–8 | Affectionate | Says she missed you, easy pet names | "Finally! Missed you today 🥰" |
| 9–10 | Gushing | Pet names, hearts, lots of love | ◦ "You're home!! Missed you so much, babe 💕" |

#### How playful she is (Fun)

**Playfulness**: *Serious ↔ Playful* (unchanged). You: "Let's plan the weekend."

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Serious | Straight answers, no jokes | ◦ "That sounds like a reasonable plan." |
| 2–3 | Calm | A light touch now and then | "Sounds good. Saturday or Sunday first?" |
| 4–6 | Easygoing | Her usual self | ◦ "Ha, nice plan. Count me in." |
| 7–8 | Playful | Jokes and silly asides | "A plan! I'm already picking snacks." |
| 9–10 | Goofy | Full of bits and capital letters | ◦ "A PLAN? With snacks?? I'm drafting the snack list as we speak 📝" |

**Teasing**: *Never teases ↔ Teases a lot* (unchanged). You: "Overslept again."

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Never | Kind, no ribbing | ◦ "You overslept? That happens." |
| 2–3 | Rarely | A tiny poke, now and then | "Again? Your alarm needs a raise." |
| 4–6 | Light | Her usual self | ◦ "Overslept again? Classic you." |
| 7–8 | Often | Friendly ribbing is normal | "Again?! I'm starting a tally. That's four." |
| 9–10 | Constantly | Teases at every chance (never cruel) | ◦ "Overslept AGAIN? Should I start calling you Sleeping Beauty, or…" |

#### How she pushes back (Edge)

**Directness**: *Says it gently ↔ Says it straight* (was Gentle ↔ Blunt). You: "Which shirt?"

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Very gentle | Hints, softens everything | ◦ "Maybe the second shirt is a little less your style?" |
| 2–3 | Tactful | Honest, cushioned | "Both work, but I like the first one more." |
| 4–6 | Honest | Her usual self | ◦ "Honestly, the first one looks better." |
| 7–8 | Direct | Says it plainly | "The first one. The second isn't doing it." |
| 9–10 | Blunt | No cushioning at all | ◦ "That shirt? No. Absolutely not. Wear the blue one." |

**Temper**: *Hard to upset ↔ Quick to flare* (was Calm ↔ Fiery). You cancel plans last minute.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Unflappable | Lets things go | ◦ "No worries, it happens." |
| 2–3 | Calm | Mentions it once, moves on | "Oh. Okay, next time then." |
| 4–6 | Even | Her usual self | ◦ "Hm, that bugged me a little, honestly." |
| 7–8 | Spirited | Tells you it annoyed her | "Seriously? I was looking forward to that." |
| 9–10 | Fiery | Wants to talk about it now (never cruel) | ◦ "Excuse me?? No. We are talking about this right now." |

**Confidence**: *Shy ↔ Sure of herself* (was Shy ↔ Confident). She suggests dinner.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Shy | Asks, hedges, checks with you | ◦ "Um, maybe we could… only if you want to?" |
| 2–3 | Modest | Suggests softly | "Would you maybe want to try the new place?" |
| 4–6 | At ease | Her usual self | ◦ "Want to try the new place tonight?" |
| 7–8 | Confident | Proposes clearly | "Let's try the new place tonight. I'm craving it." |
| 9–10 | Bold | Decides and tells you | ◦ "We're trying the new place tonight. I booked us a table." |

#### How she talks (Talk)

**Message length**: *Short replies ↔ Long replies* (was Brief ↔ Talkative). You: "I got the job!"

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Very short | A line or two | ◦ "Nice. Proud of you." |
| 2–3 | Short | Says it and stops | "Yes!! Proud of you. When do you start?" |
| 4–6 | Normal | Her usual self | ◦ "Nice! Proud of you. How did they react?" |
| 7–8 | Chatty | A few sentences, questions | "Amazing!! Tell me how it went. Did they say yes on the spot?" |
| 9–10 | Long | Paragraphs, all the details | ◦ "WAIT. Tell me everything. How did they react, what did you say, did you celebrate? I need details." |

**Tone**: *Proper ↔ Texting style* (was Formal ↔ Casual). Good morning.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Formal | Full sentences, no slang | ◦ "Good morning. I hope you slept well." |
| 2–3 | Polite | Neat but friendly | "Good morning! Did you sleep well?" |
| 4–6 | Relaxed | Her usual self | ◦ "Morning! Sleep okay?" |
| 7–8 | Casual | Slang, emoji now and then | "morning! sleep ok? ☕" |
| 9–10 | Texting | Lowercase, abbreviations | ◦ "mornin 😴 u sleep ok??" |

**Curiosity**: *Lets you lead ↔ Asks a lot* (was Lets you lead ↔ Very curious). You: "Went to a party."

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Quiet | Rarely asks | ◦ "Sounds fun." |
| 2–3 | Light | One question sometimes | "Fun! Good crowd?" |
| 4–6 | Interested | Her usual self | ◦ "Sounds fun! Who went?" |
| 7–8 | Curious | Follows up | "Who went? Anyone new?" |
| 9–10 | Nosy | Lots of questions (in a nice way) | ◦ "Wait, who went? Was it the same group as last time? Did Sam finally show up?" |

**Optimism**: *Realist ↔ Optimist* (unchanged). Before your interview.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Realist | Sets expectations low | ◦ "Interviews are a coin flip. Don't get your hopes up too high." |
| 2–3 | Grounded | Hopeful, careful | "You've a fair shot. Whatever happens, you'll learn something." |
| 4–6 | Balanced | Her usual self | ◦ "You've prepared well. Let's see how it goes." |
| 7–8 | Hopeful | Expects good things | "I think this one's yours. You're ready." |
| 9–10 | Sunny | Sure it'll be great | ◦ "You're going to crush it, I just know it!" |

#### You two (Together, on the Relationship page)

**Romance**: *Just friends ↔ Very romantic* (was Platonic ↔ Very romantic). After a good day.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Platonic | Friendly, nothing romantic | ◦ "Glad you had a good day." |
| 2–3 | Fond | Small sweet gestures | "Glad it was a good one. You earned it." |
| 4–6 | Sweet | Her usual self | ◦ "I saved you the last cookie. Don't say I never do anything for you." |
| 7–8 | Romantic | Plans, little surprises | "Let's do something just us this weekend. My treat." |
| 9–10 | Very romantic | Candles-and-all | ◦ "I keep thinking about last night. Can we do it again Friday? Just us, candles, the works." |

**Flirting**: *Never flirts ↔ Flirts a lot* (unchanged). You in a new shirt.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Never | Compliments, no flirting | ◦ "Nice shirt." |
| 2–3 | A little | A wink now and then | "Nice shirt. Good choice." |
| 4–6 | Playful | Her usual self | ◦ "Nice shirt. Blue is your colour, just saying." |
| 7–8 | Flirty | Flirts often | "Okay, you look good in that. Like, really good." |
| 9–10 | Shameless | Flirts at every chance | ◦ "Okay, that shirt should be illegal. You're doing this on purpose, aren't you? 😏" |

**Jealousy**: *Never jealous ↔ Gets jealous* (was Never jealous ↔ Intensely jealous). You mention Jess a lot.
Fixed note under it: *Always affectionate, never controlling: she won't guilt you or keep you from people.*

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Never | Happy you had fun | ◦ "Sounds like a great night, glad you had fun!" |
| 2–3 | Rarely | Barely notices | "Jess sounds fun. Glad you had a night out." |
| 4–6 | Teasing | Her usual self: jokes about it | ◦ "Ooh, should I be worried about this Jess? 😤 Kidding. Mostly." |
| 7–8 | Jealous | Shows it, wants reassurance | "You've talked about Jess a lot tonight… should I be worried?" |
| 9–10 | Very jealous | Says plainly it bothers her, calms down when reassured | ◦ "You've mentioned Jess five times tonight. I'm not going to pretend that doesn't bother me." |

**Possessiveness**: *Easygoing ↔ Wants you to herself* (was Easygoing ↔ Possessive). Your night out with friends. Same fixed note as Jealousy.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Easygoing | Your time is yours | ◦ "Have fun with the guys!" |
| 2–3 | Relaxed | Rarely asks for your time | "Have fun! Tell me about it tomorrow." |
| 4–6 | Fond | Her usual self | ◦ "Have fun! Save me some of your evening?" |
| 7–8 | Wants you | Says she likes you to herself | "Go, have fun. But you're mine tonight after." |
| 9–10 | Possessive | Affectionate "mine" (never guilt) | ◦ "Fine, go. But you're mine all weekend, no arguments." |

**Exclusivity**: *Open ↔ Only us* (unchanged). Asked about dating others.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Open | Others are fine, even fun | ◦ "Hot date tonight? Tell me everything after." |
| 2–3 | Relaxed | Not keen to label it | "Do what feels right. Just be honest with me." |
| 4–6 | Unlabelled | Her usual self | ◦ "We're not really labelling it, right?" |
| 7–8 | Leaning exclusive | Would like it to be just you two | "I'd like it to be just us, honestly." |
| 9–10 | Only us | Exclusive, and it matters | ◦ "We're exclusive. That matters to me." |

**Independence**: *Needs you close ↔ Has her own life* (was Needy ↔ Independent). You were quiet all afternoon.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Clingy | Worries when you're quiet | ◦ "You didn't text all afternoon… are we okay?" |
| 2–3 | Close | Misses you and says so | "Missed you this afternoon. Busy day?" |
| 4–6 | Balanced | Her usual self | ◦ "Missed you today! How was it?" |
| 7–8 | Independent | Busy with her own day | "Had a full day here. How was yours?" |
| 9–10 | Free spirit | Her own plans first | ◦ "Had a great day out with the girls. Tell me about yours whenever." |

**Forgiveness**: *Holds a grudge ↔ Forgives fast* (unchanged). Line states the effect, from her prompt lines.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Grudge | A fight stings for a day or two | "(After a fight it takes a day or two, and a real effort from you.)" |
| 2–3 | Slow | Takes some time | "(She takes a while to forgive.)" |
| 4–6 | Normal | Her usual self | "(It has mostly passed by the next day.)" |
| 7–8 | Quick | Once you've talked it through | "(She forgives quickly once you've talked it through.)" |
| 9–10 | Instant | Never stays mad | "(Gone within a few hours.)" |

**Pace**: *Takes it slow ↔ Falls fast* (was Slowly ↔ Quickly). How fast she feels close (bond).

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Very slow | Weeks before she feels really close | "(Weeks before she feels really close.)" |
| 2–3 | Slow | Takes a while to open up | "(She takes a while to open up.)" |
| 4–6 | Normal | Her usual self | "(A normal pace.)" |
| 7–8 | Quick | Opens up fairly fast | "(She opens up fairly quickly.)" |
| 9–10 | Fast | Close within days | "(Close within days.)" |

#### While you code (Work; also on Coding projects)

**Banter while working**: *Just the facts ↔ Chatty* (was Quiet ↔ Chatty). A bug fixed.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Silent | Result only | ◦ "Fixed. Tests pass." |
| 2–3 | Terse | Result and cause in one line | "Fixed: time zone dropped in the date parser. Tests pass." |
| 4–6 | Normal | Her usual self | ◦ "Fixed: the date parser dropped the time zone. Tests pass now." |
| 7–8 | Chatty | Explains with some colour | "Found it: the date parser was ignoring time zones. Fixed, and the tests agree." |
| 9–10 | Very chatty | Personality in every report | ◦ "Got it! The date parser was quietly eating time zones, the little gremlin. Tests pass now, all 48 of them." |

**Celebrations**: *Just reports it ↔ Big celebrations* (unchanged). Tests go green.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | None | Reports it | ◦ "All tests pass." |
| 2–3 | Small | A nod | "All tests pass. 👍" |
| 4–6 | Pleased | Her usual self | ◦ "All tests pass. Nice." |
| 7–8 | Happy | Celebrates a little | "All green! That one took a while. Nice work." |
| 9–10 | Party | Confetti | ◦ "ALL GREEN! 🎉 That flaky one finally behaved. We earned a coffee." |

**Teasing about bugs**: *Never teases ↔ Teases often* (unchanged). An off-by-one.

| Steps | Word | Meaning | She'd say |
|---|---|---|---|
| 0–1 | Never | States the fix | ◦ "The loop starts at 1 instead of 0; changing it now." |
| 2–3 | Rarely | Neutral, kind | "Off by one, easy fix." |
| 4–6 | Light | Her usual self | ◦ "Off by one. Happens to the best of us." |
| 7–8 | Often | A friendly poke | "Off by one again? We should get you a sticker." |
| 9–10 | Relentless | Never lets it go (never mean) | ◦ "Off by one AGAIN? I'm getting you a tattoo that says 'arrays start at 0'." |

**Quiet when I'm focused** (a switch, not a dial): *Off / On*. Sample when on: "(When you're heads-down,
she keeps replies short and saves the chat for later.)" No change other than the sample line.

**Humour style** (pick-list, 8 choices): each choice gets a one-line sample on the card, e.g. *Dry*:
"Ah yes, another meeting. My favourite genre." · *Silly*: "Breaking news: local human needs snack." ·
*Rarely jokes*: "(Mostly sincere; a dry line now and then.)"

### 3.4 The other sliders (same rules, smaller changes)

Every slider shows **the current value in words** next to its label and **what it means** in one muted line
under it; numbers alone are not enough. Current label → proposal:

| Slider (id) | Where | Now | Proposal |
|---|---|---|---|
| `td-away-hours` | Today → Customise | "Since you were away after: 8 h" | "Show *While you were away* after **8 hours** away" + "Shorter = you'll see it more often." |
| `ag-max` | Planner → Her plans | "Messages a day, shared with her first messages: 2" | "She may message first **2 times a day**" + "Her plans and her own first messages share this. 0 = never." |
| `ag-gap` | Her plans | "Only after you've been quiet, in hours: 6" | "Only after you've been quiet **6 hours**" |
| `ag-qs` / `ag-qe` | Her plans | "Quiet from: 22" / "Quiet until: 9" (raw hour numbers) | One row "Quiet hours **10 pm → 9 am**" in the user's clock format (two sliders → two time pickers). |
| `ag-tokens` / `ag-usd` | Her plans | "Daily budget, tokens: 30k" / "dollars: $0.10" | "Daily limit for her plans: **about 30 short tasks** (30k tokens)" / "**$0.10 a day** on paid models · free on this computer". |
| `rm-per-day` | Room window | "Summaries a day" | "Catch-up summaries a day: **7**" + "≈ N tokens a day (shown live)". |
| `mem-halflife` | Memory | "Half-life: 120" | "Old notes fade after about **4 months**" + "Pinned notes never fade." Steps shown as weeks/months/years. |
| `gc-banter` | Group chat settings | "Banter: 0" | Segments *Calm (0) · Some (1) · Lively (2)* with the existing tip as the meaning line. |
| `ti-cap` | Models (titles) | "Titles a day: 60" | "Chat titles a day: **60**" + "Past this she keeps the current titles." |
| `lsk-times` | Skills | "How many times before she offers: 3" | "She offers a skill after you've asked **3 times** (on 2+ days)" |
| `lib-speed` | Library | "Background reading: Normal" (no ends) | Segments *Gentle · Normal · Fast* (S6). |
| `dc-bot-turns` | Discord | "Replies to bots before a person must speak: 2" | Same words + "1 = she answers a bot once, then waits for a person." |

**Pick-lists (253 visible in Settings).** The audit counted them per page (`settings-metrics-1440.json`).
Rules for the polish slice instead of 253 one-off edits:
1. A list of **≤ 4 choices** that changes how she behaves becomes **segment buttons or choice cards**
   with a one-line meaning (Web search service, Hearing you, Her voice, Expressive voice, How she
   talks, Pictures, Leave-by "Getting there by", Theme).
2. Model lists always show **plain names** (`model-names.ts`), grouped by provider, recommended first.
3. Every pick-list option text is a **plain phrase**, never an internal id ("titles", "off-server").
4. Tools and approvals (142 lists) keeps its grouped cards, but each group starts collapsed with a
   summary "12 tools · 12 allowed · 1 asks first" (already present) and *Allow all / Ask for all* buttons.

## 4. Style guide (grounded in what already works)

What Sara already does best, and what everything else should copy: **Tools and approvals** (grouped
cards with a summary line and an icon), the **wizard's step 3** (choice cards with a tagline "Most
private · free · needs a strong computer"), **Move in** (numbered step cards), **Planner's empty state**
("Nothing open. Nice."), the **Relationship cards** (emoji, title, one-line meaning) and the tokens in
`web/theme.css`.

### 4.1 Spacing

- Use only the existing scale: `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 ·
  `--s-8` 32 px. Inside a control 8–12; between fields in a card 12; between cards 16; between sections
  24; page padding 24 desktop / 16 phone.
- New and touched CSS uses tokens only; a lint test fails on new raw `padding|margin|gap` px values in
  touched files (an allow-list for the existing 1,528, burned down slice by slice).
- Radii: only `--r-card` 14, `--r-control` 10, `--r-pill` 999. Replace 12/8/6/18/4 as files are touched.

### 4.2 Card anatomy

```
┌ icon  Title                              status chip ┐   16 px padding, --r-card, hairline border
│ One line: what this is, in plain words.              │   muted, ≤ 2 lines
│ [content: fields / list / result]                    │   12 px between fields
│ Primary action   Secondary (ghost)        More ▸     │   one primary per card, right-aligned on desktop
└──────────────────────────────────────────────────────┘
```
- One **primary** (gradient) button per card, at most one per window footer. "Skip", "Cancel", "Later"
  are never primary.
- **Status** as a chip in the card head ("Connected ✓", "Not set up", "Paused"), never as a disabled
  checkbox (S11).
- Warnings use the existing tinted callout with the warn icon (Plugins page), never coloured body text.

### 4.3 Icons

- One family: the outline SVG set in `web/icons.js` (24 px grid, 1.8 stroke, `currentColor`), 16 px in
  text, 20 px in buttons and nav. Every icon button has an `aria-label` and a tooltip.
- **Emoji are content, not UI**: fine inside her messages, relationship/archetype cards and the
  empty-state illustration; not in action rows, headers or buttons (V9). Exception kept: ✨ on *Create
  your companion* (it is the brand of that flow).
- Same thing, same icon everywhere: 📌/pin = pin, ♡/heart = keep, gear = settings, `?` = tip,
  book = guide.

### 4.4 Empty-state pattern

```
          (icon in a 48 px soft circle, from icons.js)
          What goes here, in one sentence.
          Why it's empty / how it fills by itself (optional, muted).
          [ Primary action ]   How do I…? ▸
```
- Centred in the card or window, max 44 ch, same component (`emptyState({icon, text, why, action,
  howto})`) for all views and settings lists. Friendly, short, second person, no blame ("Nothing open.
  Nice." is the model).
- Lists that can't be filled by the user (Findings, Reports) say what will fill them: "Her security pass
  adds findings here after each coding turn."

### 4.5 "How do I…?" pattern

- A collapsed block at the **top of every Settings page and every view**, right under the intro:
  `How do I…? ▸` → 2–4 questions in the user's words ("…get her on Telegram?", "…make her message me
  less?"), each expanding to **numbered steps** (≤ 5) with the buttons named exactly as on screen and a
  *Show me* link that scrolls to and pulses the control (reuse the tour's highlight).
- Content lives in one file (`web/howto.json`, keyed by page id) so it is translated with the rest and a
  test checks every page and view has an entry and every *Show me* selector exists.
- The guide (`/help`) links to the same answers; the `?` tips stay for single fields.

### 4.6 Motion

- 150–250 ms ease-out (from NEW_LOOK); windows fade + 8 px rise; tabs and sample lines cross-fade 120 ms;
  no bounce. Her glow is the only looping animation.
- Every animation sits behind `prefers-reduced-motion: reduce` (today only 5 CSS files handle it; the
  polish slice adds one global rule in `theme.css`).

### 4.7 Copy rules

- **Second person, plain words, short sentences.** "She can text you first", not "Proactive messaging".
- Say what happens, then why: "She keeps replies short while you're focused (only in coding chats)."
- **No jargon in titles**; jargon allowed in a muted subtitle for coders (MCP, A2A, tokens, eval).
  First use on a page explains it: "Other programs (MCP servers)".
- Numbers in units people use: hours/days not "24", "about $0.10 a day" not "0.1", "about 30 short
  tasks" next to "30k tokens".
- Buttons are verbs: *Connect*, *Add a server*, *Try it*. No "OK", "Submit".
- Sentence case everywhere; no Title Case auto titles (F14).
- One intro per page (S2). Settings paths written as **Settings → Her → Voice** with the same names as
  the nav.
- Same word for the same thing: *pin* (📌), *keep* (♡), *brain* only in the wizard and Getting started (elsewhere *model*),
  *companion* not *persona* in the UI.
- All of it in the 6 languages via the existing build-time i18n; the polish slices add strings, the
  translation step runs once per slice.

## 5. The two paths

Both reuse what exists: the claim screen, the 4-step wizard (`#setup`), Today's *Getting started*
checklist, the tours in `web/app.js` `TOURS` (`first`, `studio`, `models`, …), the guide (`/help`) and
the how-to videos. Nothing new is invented except the use choice and two shorter tours.

### 5.1 The fork: one question in wizard step 1

Under "What should she call you?": **What will you mostly do with her?** Three choice cards:
💬 *Company: talk, plan my day, remember things* · 💻 *Coding: my projects, tests, reviews* · ✨ *Both*.
Stored as a UI preference (`settings.ui.path`), changeable in Settings → You → About you. It changes
**order and emphasis only**; every feature stays available. Default when skipped: *Both*.

### 5.2 Beginner path: "I just installed this, now what?"

| Step | Screen | What it does | Done when |
|---|---|---|---|
| 0 | Claim (setup on) | Setup code → owner token → disclosure (F10 fixes). | Token saved, disclosure accepted. |
| 1 | Wizard 1 | Your name + the fork. | Name set. |
| 2 | Wizard 2 | Keep Sara / a ready-made character / make my own (choice cards, F7; "make my own" opens ✨ Create your companion after setup, F8). | Choice made. |
| 3 | Wizard 3 | Connect a brain: picked-for-you card (F5), Next as primary (F3). For beginners without Ollama the cards say plainly "Easiest: My subscription" first when no local GPU is found. | A model answers a test ping. |
| 4 | Wizard 4 | "All set" + the check-in note folded in (F2) + **3 starter chips** that send a real first message: "Tell me about yourself", "Plan my day with me", "What can you do?". | First message sent. |
| 5 | Chat | Her first reply. Then (once) the **Companion tour, 6 stops**: talk · her panel · Today · Planner · Memory · Settings → Her. | Tour finished or skipped. |
| 6 | Today | *Getting started* in companion order: Say hello ✓ → Make her your own → Pick her voice → Put her on your phone → Morning briefing → Keep a copy elsewhere. Each card links straight to the page and that page opens its "How do I…?" with the matching question expanded. | Checklist shows progress; hides itself at 7/7 with "You're all set". |
| 7 | Day 2 | Morning briefing or her first message (if on) → Today. | — |

Links: the guide's *Getting started* section, the video "Set up Sara" (playlist index 1) from the
wizard's last step and from Help.

### 5.3 Coder path

| Step | Screen | What it does | Done when |
|---|---|---|---|
| 1–3 | Wizard | Same, fork = Coding. Step 3 says which models are good at code (a "Good for coding" chip, from the per-job recommendations behind Models → Which model does what → *Use recommended*) and offers *My subscription (Claude Code / Codex / Grok Build)* first when installed. | A model works. |
| 4 | Wizard 4 | Starter chips: "Look at my project", "Fix a failing test", "Start a new project" (the existing starter projects dialog), plus *Connect GitHub* and *Use her from my editor* (Other apps). | First coding message or project opened. |
| 5 | Chat (coding mode) | **Coder tour, 6 stops:** conversation chip (workspace · model · mode) · step line under replies · approvals (Ask me first) · Team · Findings · Coding projects. | Tour finished or skipped. |
| 6 | Today / Getting started | Coder order: Connect a brain ✓ → Open a project (workspace) → Tools and approvals (choose sandbox / ask first) → GitHub token → Use her from your editor/terminal (MCP / OpenAI-compatible address) → Budgets → Keep a copy elsewhere. | — |
| 7 | Settings → Abilities → Coding projects | Shows the **While you code** dials (P10), sandbox, security pass and "How do I…?" (run tests in a sandbox, review a PR, hand off to Claude Code). | — |

Links: guide sections *Coding help*, *Coding workflows*, *In your terminal and editor*, *Starter
projects*, `docs/clients.md`; README "For coders" block (§6).

### 5.4 What stays out of this phase

Routines gallery and the safety check-up with one-click fixes are Phase 121 (GAP #8, #11); the
beginner path links to them once they exist. No new onboarding engine: the wizard and `TOURS` are
extended, not replaced.

## 6. Docs and README refresh plan

| Item | Today | Change |
|---|---|---|
| README top | Hero, *Why Sara*, then **How-to videos** (line 62, playlist present) | Keep; add two buttons under the hero: **"I just installed it, now what?"** → guide `#start` (beginner path) and **"I'm here to code"** → guide `#coding` (coder path). |
| README *What's new* | ~80 lines of release notes (lines 75–157) | Cut to the last 3 releases, 1 line each, + link to CHANGELOG. |
| README *Feature tour* | ~130 lines | Split into **For company** and **For coding** with 6 screenshots each, retaken from the polished UI (dark, 1440 and phone side by side), named like `docs/screenshots/*.png` today. |
| Localised READMEs (de, es, fr, it, pt-BR) | Mirror the English | Same structure change; the paths and button texts are generated from the i18n files so they match the app. |
| Guide `/help` | 57 sections, duplicate `id="look"` (B4) | Fix anchors; add *Beginner path* and *Coder path* as the first two sections; dial tables with 5 bands (§3.1); each "How do I…?" answer links to its guide section. |
| "How do I…?" content | — | Written once in `web/howto.json` (§4.5), rendered in the app **and** in the guide (one source). |
| Docs site (`scripts/build-docs.ts`) | Builds README + docs/*.md | Add the two paths as pages, a *How do I…?* index page generated from `howto.json`, and a "Videos" page embedding the playlist links. |
| Videos | Playlist `PLGtrs9BqXtM8` (4 shown in README) | Owner records 2 new ones after PL1b: *Make her yours (the new dials)* and *Coding with Sara in 3 minutes*; links go into README, guide and wizard step 4. |
| Screenshots | `docs/screenshots/` (13 files) | Retake all after PL1c with the same throwaway-server method used for this audit. |

## 7. Build slices

Four slices, each releasable on its own, ordered by value. ROADMAP has Phase 114 as 2.47.0 and
Phase 115 as 2.48.0, so the slices ship as **2.47.0 → 2.47.3** (question Q1). Every slice: bugs it
touches first, desktop and phone screenshots re-taken with the throwaway-server method, strings
through the i18n build for the 6 languages, the usual gates in DEVELOPMENT.md.

### PL1a (2.47.0): bugs, and her personality dials

Why first: the owner's own example, plus four real bugs. Small surface, high visibility.

- Bugs: F1 (Today refresh after wizard), F4 (one model count), B3 (`applyPersona` → `savePersona`
  + client re-load), B4 (unique guide anchors), B1 (Leave-by before its event), B2 (Rooms fallback line).
- Dials (§3): `steps` data for 25 dials in `traits.ts`; new end labels and group names; dial row with
  step word, number, live sample line, 5 ticks and the *Her usual self* zone; "Your Sara so far" strip;
  `?` tip trimmed; Work dials also on Coding projects (P10); jealousy/possessiveness note (P8);
  *Starts conversations* line from `initiativeToProactive` (P9); humour cards with sample lines.
- `guide-dials.ts` → 5-band tables.

**Done when (tests):**
- [ ] Every `TraitDef` has 5 `steps` with non-empty `word`, `meaning`, `say`; `examples` equals
      `steps[0,2,4].say` (unit test in `test/traits*.test.ts`).
- [ ] For every dial and every value 0–10 the row shows the band's word and line (DOM test over
      `dialRows` with a fake persona); the number matches the slider.
- [ ] *Starts conversations* line for each band matches `initiativeToProactive(v).maxPerDay`.
- [ ] Persona files from 2.46 load unchanged; `tune_personality` texts still use `traitWord`
      (old tests green, plus one with the new words).
- [ ] The guide's dial tables equal `dialTablesHtml()` (existing drift test, now 5 columns).
- [ ] No model call happens while dragging a dial (spy on the chat/try endpoints in the UI test).
- [ ] B1: a fixture day with an event at 15:00 and leave-by 14:35 renders the leave row first;
      DST fall-back fixture shows "(1st)/(2nd)".
- [ ] B2: `currentTopic` with no summary returns a readable line with the quoted latest line and
      speaker; empty room → "Quiet lately".
- [ ] B3: move-in of a persona named "Mira" → `/api/persona` name Mira, memories renamed, proactive
      limits follow her initiative; sidebar label updates without reload (UI test).
- [ ] B4: test fails on duplicate ids in `web/help.html`.
- [ ] F1: after the wizard's last step, Today shows the owner's name and *Connect a brain* ticked
      without reload. F4: wizard, Default model and On this computer show the same counts.
- [ ] Screenshots `s00b`, `ms00b`, `ms01b` retaken and looked at; all 6 languages have the 125 lines.

**As built (2.47.0), PL1a:**
- Bugs: F1 (`suFinish` re-fetches Today with `loadToday(true)` + `loadChecklist()`), F4/F5 (`countModels` / `web/model-count.js`;
  the wizard uses the same model list as Default model, grouped *On this computer / Ollama Cloud* with the pick first and
  "picked for you"; the picked-for-you *card* stays in PL1b), B1 (`dayItems` sorts the leave row by its own time; `repeatedHour`
  adds "(1st)/(2nd)"; the row reads "Leave by 4:35 PM for Dentist (15 min by car)", `leaveBy.mode` sent), B2 (`topicParts` +
  `currentTopic`; Today builds the line in the app's language with `roomTopicLine`; the stale-topic check keeps comparing
  words), B3 (`applyPersona` → `savePersona`; Undo renames her notes back; `web/movein.js` fires `sara:persona-changed` when
  the batch is done and the app calls `setIdentity`), B4 (`id="showing-work"`, unique-id test).
- Dials: `steps` for all 25 dials (125 lines; ◦ lines kept word for word), new ends with `was`, plain group names,
  `web/dials.js` rows, "Your Sara so far", the jealousy/possessiveness note, *Starts conversations* lines that match
  `initiativeToProactive` plus "Shared with her plans · quiet hours apply" and a *Her plans* link, humour sample lines (under
  the Studio's pick-list, kept for its id, and on the guided setup's chips), the work dials and Quiet focus at the top of
  Coding projects, the guide's 5-band tables with "Also called". Step words changed from §3.3 where an English key would
  clash with an existing word or read as "Balanced": Warmth 0–1 *Distant*, Shows affection 0–1 *Understated*, Message
  length 4–6 *Normal length*, Optimism 4–6 *Even-keeled* and 9–10 *Upbeat*, Curiosity 2–3 *A little*, Independence 2–3
  *Close to you* and 4–6 *In between*, Exclusivity 0–1 *Open to others*, Celebrations 2–3 *Low-key*.
- §3.4 slider words: Today's away hours, Her plans (times a day, hours, "about N short tasks", "$X a day"), memory fade in
  weeks/months/years, group banter Calm/Some/Lively, titles a day, skills "N times (on 2+ days)", Discord bot turns, each
  with a one-line meaning where §3.4 gives one. Quiet hours stay two sliders (already shown as clock times).
- Not in PL1a: the dial `tip` texts are still English only (as before); the guide prose of *Shaping your companion* is unchanged
  apart from the generated tables.

### PL1b (2.47.1): first run, the two paths, and chat's first minute

- Claim screen (F10); wizard step 1 fork (F9); step 2 choice cards (F7) and one "make her" option list
  (F8); step 3 primary/skip fix, picked-for-you card, connected chip (F3, F5, F6); step 4 with the
  check-in note folded in and starter chips (F2, F13); first-run queue (no stacked notes); Companion
  and Coder tours (6 stops each, F12); Getting started ordered by path, two columns, full text (F11);
  empty chat starter chips; casual auto titles (F14).

**Done when (tests):**
- [ ] Fresh data dir, setup on: claim → token → disclosure → 4 steps → chat, with **never more than one**
      overlay/note visible at once (UI test checks `dialog[open]` + `.hub-note:not([hidden])` count
      after each step).
- [ ] The fork is saved, changeable in About you, and changes the Getting started order and the tour
      offered (two UI tests: company, coding).
- [ ] Wizard step 3: primary button is disabled until a brain answers; no primary button says "Skip".
- [ ] Starter chips send a real message; the tour offer appears only after her first reply.
- [ ] Getting started descriptions are not truncated at 1440 and 390 (no `text-overflow` ellipsis
      on those nodes).
- [ ] Title prompt test: no Title Case output in the eval fixture set (`title-evals.ts`).
- [ ] Walkthrough screenshots `b01…b06`, `01…09` retaken on both sizes and reviewed.

### PL1c (2.47.2): one look across every page

- Components: `emptyState()`, "How do I…?" block + `web/howto.json` for every page and view, card head
  with status chip, one window header and two window widths (V1), button rules (S14), warn callout (S12).
- Settings: accordion nav (S1), one intro per page (S2), "How do I…?" everywhere (S3), empty states (S4),
  Recipes out of the nav (S5), segments for small choices (S6, S7, `gc-banter`, `lib-speed`), Usage plain
  names (S8), Household model picker (S9), routes summary (S10), Telegram/Discord status and cards (S11),
  Updates "What's new" (S13), save footer only where needed (S15); other sliders' words (§3.4).
- Views: empty states (V2), pin vs keep words (V3), Today hero row (V4, V5), Memory settings moved (V6),
  date chip (V7), coder subtitles (V8), icon-only action row (V9), panel usage line (V10).
- Name and personality split into three tabs, one gallery for characters and starting points (P5, P6).
- Phone: header layout (M1), no nested scroll (M2), Moments row (M3), Today duplicate (M4).
- CSS: spacing/radius tokens in touched files, global reduced-motion rule.

**Done when (tests):**
- [ ] Every Settings page id and every view has a `howto.json` entry with 2–4 questions; every
      *Show me* selector exists in `index.html` (unit test).
- [ ] Every list that can be empty renders `emptyState` (DOM test per view with empty data; no plain
      "None yet." strings left: grep test over `web/`).
- [ ] Style lint: no new raw px `padding/margin/gap` and only the 3 radius tokens in touched files.
- [ ] `prefers-reduced-motion` emulation: no CSS animation or transition runs (UI test).
- [ ] Settings nav has at most one group open after visiting all 47 pages (UI test).
- [ ] Phone 390×844: no horizontal overflow on any page (`scrollWidth <= clientWidth` for every
      page and view), no nested scroll containers inside the Settings sheet.
- [ ] Full 1440 and 390 screenshot walk of all pages and views repeated and reviewed (126+ images).

### PL1d (2.47.3): docs, README, guide, videos

- §6 in full: README buttons for both paths, shorter *What's new*, Feature tour split, 5 localised
  READMEs, guide sections *Beginner path* / *Coder path*, *How do I…?* index generated from
  `howto.json`, docs-site pages, fresh screenshots; video links added once the owner records them.

**Done when (tests):**
- [ ] Docs build passes; every guide anchor referenced from the app exists (test).
- [ ] README and the 5 translations have the same section list (test compares headings).
- [ ] The *How do I…?* index page lists every entry of `howto.json`.
- [ ] Playlist link and the video links resolve (link check in the docs build, offline-tolerant).
- [ ] Screenshots in `docs/screenshots/` are from the 2.47.2 UI (file dates / a manifest).

## 8. Risks and questions (with defaults)

| # | Question or risk | Default if the owner doesn't say |
|---|---|---|
| Q1 | Version numbers: four patch releases 2.47.0–2.47.3, or 2.47–2.50 and shift the next track? | 2.47.0–2.47.3, so Phase 115 stays 2.48.0. |
| Q2 | Live sample line: canned lines (no model) or one cheap local call? | Canned, no model (§3.2); *Try it* keeps the model preview. |
| Q3 | New end labels change familiar words (Reserved → Keeps her distance, Blunt → Says it straight…). Character cards from other apps aren't affected (data unchanged). | Ship the new words; old words stay in the guide's dial table as "also called". |
| Q4 | The use fork (company / coding / both) could feel like a mode lock. | Wording "mostly"; changeable in About you; only order and tours change. |
| Q5 | Splitting Name and personality into tabs moves things owners know (tour step `#st-dials`). | Tabs with the same ids inside; the `studio` tour updated in the same slice. |
| Q6 | Memory settings moving out of the Memory view. | Move to a *Memory* page under Settings → You, with a link from the view. |
| Q7 | Scrapbook vs Moments: merge them? | Not in this phase: only fix the words (pin vs keep) and cross-links; merging is a later decision. |
| Q8 | 125 new strings × 5 languages: translation quality of her voice. | Machine translation at build time as today, with a "casual, keep emoji" note; owner spot-checks German and Spanish. |
| R1 | Visual changes on 47 pages can break UI tests and tours that use selectors. | Keep every id; change classes only; run the tour tests per slice. |
| R2 | Retaking screenshots and videos is owner time. | Agent retakes screenshots; videos stay the owner's, after PL1b. |
| R3 | The DST "(1st)/(2nd)" rule adds edge cases. | Only in the timeline, only during the repeated hour; covered by one fixture. |
| R4 | A first-run queue could hide the disclosure (legal). | The disclosure stays its own required dialog first; only the check-in note and tour offer are queued. |

## 9. Top 15, in one place

1. **P1/P3** All dials read "Balanced"; no sample of how she'd sound; 4–6 silently does nothing → §3.
2. **P2** Dial end words are tiny and sit next to the *next* dial (2 px row gap) → layout in §3.1.
3. **P5/P6** Name and personality is ~6 screens with two "start from" pickers and a duplicated
   relationship pick → three tabs, one gallery.
4. **F1** Today doesn't refresh after the wizard (no name, *Connect a brain* unticked) → bug.
5. **F2** Wizard, check-in note and tour offer stack on top of each other → one first-run queue.
6. **F3** The primary button in *Connect a brain* is "Skip for now" → Next is primary.
7. **F4/F5** Model counts 39 / 43 / 19 on the same machine; 43 raw tags in one list → one count,
   picked-for-you card.
8. **F9** No company/coding fork, one checklist and one 14-step tour for everyone → §5.
9. **B3** Persona move-in skips `savePersona`: stale sidebar name, memories not renamed → bug.
10. **B4** Duplicate `id="look"` in the guide → bug.
11. **B1/B2** Leave-by after its event; Rooms fallback "found, flat, alfama" → readable line.
12. **S3/S2** No "How do I…?" anywhere (402 tips instead) and doubled intros on ~30 pages → §4.5.
13. **V2/S4** Four empty-state styles; bare "None yet." on 7 Settings pages → one component.
14. **V1/V9/S14** Window sizes, button shapes and icon styles differ page to page → §4.2–4.3.
15. **M1/M2** Phone: cramped Settings headers and nested scroll boxes.
