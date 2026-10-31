# Skills

Skills teach Sara how to do a kind of job your way: "review a pull request", "write the weekly
review", "plan a trip". Each skill is a folder with a `SKILL.md` file (the open
[Agent Skills](https://agentskills.io/specification) format), so skills written for other agents
work in Sara too.

## Where to find them

**Settings → Abilities → Skills.** Each companion has her own skills; *All my companions* shares one.
Six starter skills come built in (writing a skill, reviewing a pull request, a changelog entry, a
weekly review, debugging a failing test, planning a trip). Turn any skill off, edit it, or copy it.

## How she uses them

She sees a short list of her skills in every chat and loads one when it fits what you asked (you
can also say "use the weekly review skill"). Which skills a step used is shown in **Runs**.

## Adding skills

- **Write one:** *New skill*, or ask her ("make this a skill").
- **Import:** a zip, a git address or (owner) a folder on the server. A review card shows every file
  and any scripts before anything is added.
- **From a recipe:** your old recipes were turned into skills automatically.
- **Export:** any skill as a zip, to share or keep.

## Scripts

A skill may include scripts. They never run on their own: each run shows a card with the start of the
script and its arguments (*Allow once* / *Allow for this task*). A skill you imported must have one
approved run before you can let it run without asking. A skill's `allowed-tools` list is shown to you
but never trusted.

## What a skill can't do

No skill can change Sara's safety layer (saying she's an AI, crisis resources, the block on anything
sexual involving minors). Household members can have their own text-only skills; scripts are the
owner's. The demo has the built-in skills only.

## Skills she learns (2.30)

She notices when you ask for the same kind of thing again and again, or when she runs the same
chain of steps again and again in coding, and **offers** to keep it as a skill. Never silently:
after her reply (never in the middle of a task, never in a turn that asked you to approve
something or hit a budget) a card asks *make this a skill?* with a draft: a name, what it does and
when to use it, and the steps that worked. **Save it** · **Edit first** · **Not now** (14 days quiet,
then once more on a later repeat) · **Never for this**. Nothing is written to her skills before
*Save it*.

- **When she offers.** The same kind of request 3 times on at least 2 days within 30 days, with
  turns that ended well (not stopped, not corrected). "The same kind" means close in meaning (her
  embeddings job, cosine ≥ 0.82; a word match without it) *and* the same kind of work (coding, mail,
  planner, web, home or writing, from the tools the turn used). Step chains: the same ≥ 3 steps in 3
  finished coding runs on 2 days (one extra step allowed), looked for once a night. A request a skill
  already covers is never a new offer. At most one offer a day, none in quiet hours.
- **What she never learns from.** Private, partner, group, imported, adult-channel and other apps'
  conversations, and the demo. Offers keep ids (conversation, message, run), never copied text;
  deleting a conversation removes its examples. The draft is written by your *Writing* model route
  from scrubbed examples (keys, emails, phone numbers and street addresses taken out); when no model
  can be used it is written plainly from her steps.
- **On trial, then checked.** A saved learned skill starts *on trial*: listed only when it clearly
  fits (meaning ≥ 0.7, "(new)" after its name), never loaded up front. With *Check learned skills
  before using them* on, the **skill check** replays up to 5 past tasks (its own examples and similar
  ones) twice, without and with the skill, on the tight budget (the eval loop, `Evals` in the
  sidebar shows it as *Skill check: …*). *Helps* → a normal skill; *same* → used when it fits, never
  loaded on its own; *hurts* → stays on trial with a note. *Use it anyway* skips the check; *Check
  this skill* (⋯ on any skill) runs it.
- **Fixes after using a skill.** When a skill was used and a step failed while a different one
  worked, or you corrected her right after, a card shows the change as a diff with the evidence:
  **Apply** (the old version is kept; open the skill → *Versions* to go back) · **Edit** · **Dismiss**.
  One a day per skill; three dismissed → none for 30 days. Built-in and project skills are never
  changed.
- **Settings** (*Settings → Abilities → Skills → Skills she learns*, per companion): offer to make
  skills, how many times before she offers (2–6), look back (14–90 days), offers per day, check
  learned skills first, learn from step chains in coding, propose fixes. Household members have
  their own, learning only from their own conversations (their skills aren't checked: the eval loop
  is the owner's).
- A learned skill is text like any other: it can't change her persona, the AI notice, crisis help,
  the minors block, approvals or budgets. Its scripts (if you add any) still ask before each run.
