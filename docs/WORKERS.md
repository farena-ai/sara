# Workers that stay

A **worker** is one of your helpers (Team → Helpers), or a member of one of your crews, that keeps
going on its own. Open **Team → Workers that stay**.

Each worker has:

- **A name and a character**: how it works and sounds ("Calm and thorough; asks before deleting").
- **Its own chat** in your conversation list, called *Worker: name*. Its results land there, not in
  the chat you are in. Open it with **Open its chat**.
- **What it may do**: groups of tools (read files, search the web, change files, run commands, use
  git, hand work to a coding agent). Anything that changes files or runs commands still asks you
  first, exactly like Sara herself.
- **Its own budget**: tokens a day. When they are used up its jobs wait until tomorrow.
- **A job queue**: **Give it a job** and it does the jobs one at a time, in order. The queue is kept on
  disk, so a restart does not lose it (a job that was running starts again, counting one try).
- **A time limit and tries**: a job that runs past *Minutes a job* is stopped. A failing job is tried
  again after 1, 5 and then 30 minutes, up to *Tries* times.

## Failed jobs

A job that kept failing, ran past its time, or that you stopped goes to **Failed jobs** with the
reason. **Replay** puts a copy back in the queue (the failed one stays in the list, marked
*Replayed*); **Drop** removes it from the list.

## When a worker needs you

If a worker is blocked (an approval is waiting, it used up today's budget, a job keeps failing, or it
was stopped without you asking) it sends **one** message: to Telegram or Discord if that is where you
last talked to Sara and it is linked, otherwise to the app. During your quiet hours it waits and goes
out when they end. The same problem is never sent twice. The worker also shows **Needs you** in the
list.

## Leads

Set **Led by** to make a worker report to another one. The lead can hand parts of its job to the
workers under it; their results come back to the lead's chat and onto the lead's job.

## A crew member that stays

When you make a worker, pick **From a crew member**: it keeps that member's helper and part as its
character and gets its own chat and queue.

## Export and import

**Export** saves the worker (and the workers it leads) as a `.sara-worker.json` file: its name,
character, helper, tool groups, budget and the names of skills it uses. Secrets, keys and chat ids
are never in it. Its memories (its last results) go in only if you say so.

**Import a worker** shows each worker, the tools it may use (the ones that can change things are
marked), its lead and any skills you do not have yet. Nothing is made until you press **Import
paused**; imported workers start paused so you can look them over and turn them on.

Only the owner can use workers. If your admin turned **Crews** off (Settings → Policy), workers are
off too and their queues wait.

## Weekly report

Once a week Sara sends a short report of what each worker did: jobs done and failed, jobs still
waiting, tokens and cost (from the usage meter), a few things it made and why jobs failed. It comes on
the day and from the hour you pick (Team → Workers that stay → Weekly report; default Monday 9 AM in
your time zone), only in weeks when a worker did something. It goes where **Workforce report** alerts
go: its own chat by default; change it to a project, one of your chats, Telegram or Discord in
Settings → You → Automations → Where alerts go (or ask her: "put my workforce report on Telegram").
**Show this week** shows the same numbers in place; **Send it now** sends it at once.

## Goals, caps, hand-offs and the weekly plan

Open **Team → Goals and weekly plan** (under Workers that stay).

- **A goal** belongs to a worker and has one simple measure: *finished jobs* or *a number*. A number
  is something the worker reports by ending a reply with `PROGRESS: 37`, or that you type in with
  **Edit**. Give it a target and say whether it counts per week (from Monday) or over the whole goal.
- **A cap** in dollars and/or tokens per goal. When the goal's jobs reach it, they stop and wait, and
  she asks you once. **Raise the cap** (or wait for next week, for a weekly cap) and they go on. A
  running job never gets more tokens than are left under the cap.
- **A chain**: pick up to four workers the work passes to (for example scout → writer → editor). When
  one finishes, its output becomes the next one's job. Any worker can also hand work to another by
  ending with `PASS TO <name>: <what to do>`. The goal shows recent hand-offs as one line per chain.
- **What is blocked** shows why a goal is not moving: at its cap, paused, a paused worker in the
  chain, an approval or the daily budget waiting, or failed jobs.
- **The weekly plan**: on the weekly report's day and hour (default Monday 9 AM) the workers propose
  this week's jobs: each goal's *weekly job*, the `NEXT: <job>` ideas they wrote, or a next step. It is
  posted where Workforce report alerts go. In one card you change titles, untick what you don't want,
  add jobs, then **Approve the plan** (or **Skip this week**). Nothing starts before you approve.
  **Propose a plan now** makes one at once.

## Hire a worker someone shared

A friend or someone in your community can share a worker (and the workers it leads) in Get more →
Shared by friends. **Review and hire** shows each worker, what it may do and its budget preset
(tokens a day, minutes a job); your Sara checks it first (no secrets, no memories of old jobs, never
"Run commands" or "Hand work to a coding agent"). **Hire** adds them paused in Team → Workers that
stay with that budget; turn them on there. A newer version is offered as an update and never applies
itself. **Find workers to hire** in Workers that stay takes you to the shelf.
