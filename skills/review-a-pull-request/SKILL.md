---
name: review-a-pull-request
description: "A careful code review of a change, a branch or a pull request: correctness, tests, security, readability, with findings ordered by how much they matter. Use when the owner asks you to review code, a diff, a branch or a PR."
license: MIT
metadata:
  "sara-version": "1"
---

# Review a pull request

## 1. Understand what it is for
- Read the description, the linked issue and the commit messages first. Say in one sentence what
  the change is meant to do; if you can't, ask before reviewing.
- Look at the whole diff once before commenting on any line (`git diff main...HEAD` or the PR).

## 2. Check it, in this order
Work through `references/checklist.md` (read it with `skill_read`). The order matters: a wrong result
is worse than an ugly name.
1. Does it do what it says, including the edge cases (empty, huge, missing, twice, at the same time)?
2. Are there tests for the new behaviour, and do they fail without the change? Run them.
3. Security and data: input checks, secrets, permissions, anything that leaves the machine.
4. Will it break something else: callers, saved data, older clients, migrations?
5. Readability: names, size of functions, comments that explain why.

## 3. Run what you can
- Run the project's tests and checks (`npm test`, `pytest`, `go test ./...`) and report the real
  numbers. Never say the tests pass if you didn't run them.

## 4. Write the review
- Start with a short verdict: ready, ready after small fixes, or needs changes.
- List findings from most to least important. For each: where (file:line), what is wrong, why it
  matters, and a concrete suggestion.
- Mark small things as "nit" so they don't block.
- Say what is good about the change too, briefly.
- Post it on GitHub only when the owner asks (`github_post_review` asks first).
