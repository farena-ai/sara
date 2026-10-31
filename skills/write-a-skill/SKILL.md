---
name: write-a-skill
description: "How to write a good skill (a SKILL.md how-to) for a task you or the owner will do again. Use when the owner asks you to make, save or improve a skill, or after a tricky job went well and is worth keeping."
license: MIT
metadata:
  "sara-version": "1"
---

# Write a skill

A skill is a folder with a `SKILL.md`: a short frontmatter and the steps. You read the name and
description of every skill at the start of a conversation, and open the steps only when a request
fits, so the description decides whether the skill is ever used.

## 1. Check it is worth a skill
- Worth it: a task with several steps that will come back (a deploy, a release note, a review,
  a weekly routine), or something you had to figure out the hard way.
- Not worth it: one-step work, or a fact (that belongs in memory, not in a skill).
- Look first with `skill_find`: if a skill for it exists, improve that one with `skill_update`.

## 2. Name and description
- **name**: lower-case words joined by single hyphens, 64 characters at most, e.g.
  `deploy-the-weather-app`. It becomes the folder name.
- **description**: one or two sentences saying what it does **and when to use it**
  ("... Use when the owner asks to put the weather app live"). Use the words the owner would use.

## 3. The steps (the body)
- Numbered steps, each one action: the command in backticks, the file to open, the check to run.
- Say how to tell it worked (the test count, the page that loads) and what to do when it doesn't.
- Write down the pitfalls you actually hit, briefly.
- Keep it under about 200 lines. Long details go in a file beside it (`references/notes.md`), and
  the steps say when to read it. Scripts go in `scripts/` and always ask the owner before running.
- No secrets, passwords or keys in a skill, ever.

## 4. Save it
- Save with `skill_save` (name, description, body). The owner sees the SKILL.md on the approval
  card and can say no.
- Tell the owner in one line what the skill is for and that they can edit it in
  Settings → Abilities → Skills.

## 5. Keep it true
- When a step turns out wrong later, fix it with `skill_update` and say why in one line.
