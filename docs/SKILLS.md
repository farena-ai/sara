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
