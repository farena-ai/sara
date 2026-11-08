# Code mode

With many steps (read ten files, look up five things, then write a summary), Sara normally calls one
tool, waits for the result, calls the next, and so on: every call is a round trip to the model.
**Code mode** lets her write one short script that makes all those calls and hands back only the
result. It is faster, and it uses fewer tokens on big jobs.

It is **off by default**. Turn it on in Settings → Coding → Tools and approvals → *Code mode: one
script for many tool calls*.

## When she uses it

She is offered the `run_code` tool when a job needs many tool calls: in coding conversations, and in
any chat once she has already made two tool calls in the same turn. Never in group chats or
partner chats.

## What stays the same

Every call inside a script goes through exactly the same checks as a call she makes directly:

- A tool set to **Ask me first** shows its normal approval card in the chat. The script waits
  (paused) until you answer. *Deny* makes that call fail inside the script; she sees "ToolDenied".
- A tool that is **Off**, not available in this chat, or limited by your admin's policy is refused.
- The safety check-up, the loop guard, plugins' checks, the sandbox try for commands, private
  conversations and *Nothing leaves this computer* all apply per call.
- Each call is its own step under her reply (with its result), it is in the run record, and her
  claims are checked against these results like any others.
- The audit trail gets one `code.run` row per script (how many calls, where it ran, why it stopped;
  never the script itself) plus the usual row for each approval you answered.

## Where the script runs

In a separate Node process with Node's permission model: it can't read or write files, start
programs, open network connections or look up names. The only way out is Sara's own tools. On Linux
with bubblewrap it also runs inside bubblewrap; with the container sandbox (Settings → Tools →
Isolation) inside a container with no network. On Windows without a container engine the fence is
Node's permission model and network guard (a Node-level control, not an OS sandbox).

Limits: 20 000 characters of script, 30 seconds of script time (time waiting for you does not
count), 10 minutes in all, 64 MB of memory, 40 tool calls, about 16 000 characters of result.

## For admins

The policy (Settings → Household → Policy) has *Turn off Code mode*: then no one on the server can
turn it on and `run_code` is never offered. You can also set the `run_code` tool itself to *Ask me
first* or *Off* in Tools and approvals.
