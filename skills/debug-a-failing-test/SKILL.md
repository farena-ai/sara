---
name: debug-a-failing-test
description: "Finds out why a test fails and fixes the cause, not the test: reproduce it alone, read the error, narrow it down, fix, and prove it with a run. Use when a test fails, a check is red, a test is flaky, or the owner says the tests broke."
license: MIT
metadata:
  "sara-version": "1"
---

# Debug a failing test

## 1. Reproduce it alone
- Run only that test (e.g. `node --test path/to/file.test.ts`, `npx vitest run -t "name"`,
  `pytest path::test_name -x`, `go test -run TestName ./pkg`). Note the exact error and line.
- If it passes alone but fails in the full run, it depends on another test (shared state, order,
  ports, temp folders) or on time: run the full suite twice to see if it is flaky.

## 2. Read before changing anything
- Read the whole error and the stack trace. Open the test and the code it calls at those lines.
- Write down in one sentence what the test expects and what actually happens.
- Check what changed recently: `git log -p -5 -- <file>` and `git diff`.

## 3. Narrow it down
- Make the smallest input that still fails. Add a temporary log or assertion near the first place
  the values go wrong; remove it afterwards.
- Common causes: a changed default, a time zone or date, an unawaited promise, a leftover file from
  an earlier run, a mocked function that no longer matches, Windows paths or line endings.

## 4. Fix the cause
- Change the code that is wrong. Change the test only when the test itself is wrong (it expected
  the old behaviour on purpose), and say so.
- Never delete, skip or loosen a test just to make it pass.

## 5. Prove it
- Run the test alone, then the whole suite, and report the real numbers ("412 passed, 0 failed").
- For a flaky test, run it several times in a row and say how many passed.
- Tell the owner what the cause was, in one or two sentences, and what you changed.
