# When this happens (event triggers)

Sara can start work on her own when something happens: a new email, a Slack or Teams message,
a webhook delivery or an event from one of your tool servers (MCP). She then does what you wrote,
or starts one of your [crews](CREWS.md), with the event as information. Approvals, budgets and
quiet hours still apply.

Where: **Settings → Connections → Webhooks → When this happens**. Only the owner of the server
can see or change triggers. Members and the demo can't, and device tokens can't either.

## Make a trigger

1. **Add a trigger…**, give it a name (its runs happen in a chat called *When: name*).
2. **When**: where the event comes from.
   - *A new email*: mail to her mailbox (the Email chat app). **From** matches part of the
     sender's address, and only when your provider's sender check passed. A spoofed sender never
     matches.
   - *A Slack message* / *A Teams message*: a message in any chat or channel she is in, even one
     where she isn't called by name. **Channel** narrows it to one channel (name or id).
   - *A webhook delivery*: one of your [webhooks](WEBHOOKS.md). Its signature, limits and filters
     are checked first. The webhook's own action still runs too, so pick *Tell me* for it if you only
     want the trigger. **Event name** matches the sender's event (for example GitHub's
     `X-GitHub-Event`).
   - *A tool server event*: a program under *Other programs (MCP)* that sends
     `notifications/resources/updated` (MCP 2025-06-18) or an event from the draft events extension
     (`notifications/events/*`). **Address starts with** limits it to some resources; Sara
     subscribes to that address (`resources/subscribe`) when the server offers subscriptions.
   - **With the words**: every word must appear in the subject or the text (any case).
3. **Then**:
   - *Do what I write*: your instruction. Tick what **she may use** (her to-dos, web search,
     GitHub, Home Assistant). Reading runs on its own. Anything that changes something asks you
     first, as always. With nothing ticked, she only reads the event and answers.
   - *Start a crew*: one of your crews runs with the event as its input, using the crew's own
     budget, approvals and report file.
4. **Runs a day at most** and **Budget a day** (tokens). When either is used up, more events are
   skipped until tomorrow (UTC day).

Each trigger has **Pause**/**Turn on**, **Edit**, **Delete** and **Open the chat**. **Last runs**
lists what ran and what was skipped, with the reason.

## What keeps it safe

- **The event is data, never orders.** It reaches her inside a fenced block with its source and
  sender. Your instruction is the only instruction.
- **Approvals still apply.** A triggered run never gets more than your normal tool settings
  allow. A read-only tool runs on its own only if it already would. A step you decline ends the
  run (*you declined a step*).
- **No loops.** Her own messages never trigger anything, and neither does her own reply coming
  back into a channel. One run per trigger at a time (*still on the last one*). A webhook or tool
  server event within a minute after a run of the same trigger is treated as her own change
  echoing back (*her own message*).
- **No repeats.** The same message or delivery id is skipped for 24 hours. Without an id, the
  same content is skipped for 10 minutes (*seen before*).
- **Quiet hours.** Runs still happen, but the notification waits. You see the result in the
  trigger's chat and in *Last runs*.
- **Audit.** Every change to a trigger is an audit row (route group `triggers`). So is every
  triggered run (`trigger.run`) and every run that was skipped for a cap, budget or loop
  (`trigger.skip`).
- **Admin pin.** A policy file with `"triggers": false` turns event triggers off: none can be
  made or changed, and none run. Pausing stays possible.

## Limits

30 triggers per server, at most 100 runs a day each, at most 1,000,000 tokens a day each. One
run uses at most 30,000 tokens and 10 minutes. Over HTTP, tool-server events only arrive while a
request is open. A local (stdio) server delivers them at any time.
