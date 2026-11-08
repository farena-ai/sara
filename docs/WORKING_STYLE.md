# How she works with you

Sara notices how you like to work and keeps it in mind: short or long answers, one recommendation
or a few options, whether to ask before acting in a project, a casual or formal tone, what you are
new to or know well, when you usually write, and how you like feedback.

## What she learns from

Only your own messages in your own chats. Never her replies, private conversations, chats with other
people, imported history, adult chats, group chats, other apps or agents. She never learns anything
about your health, religion, politics or sexuality, no personality types, no passwords or codes, and
no generalisations about other people: a message touching any of those is not used at all. She keeps
which messages she saw it in (by number), never a copy of what you wrote.

## How sure she is

Each item has a confidence. Something seen once is only noticed; seen in two chats she goes by it.
If she does not see it again, it fades and she stops using it. What you say outright ("I prefer short
answers", "I'm new to Rust") or confirm never fades. If you start doing the opposite, she is no longer
sure and asks you once.

When something she noticed starts changing how she answers, she tells you once, briefly: "I've noticed
you prefer short answers; I'll keep them short. Say if not."

## Memory → How she works with you

Each item shows how sure she is, how often she saw it and in how many chats, and where it holds (one
project, one chat app, at work). **Confirm** keeps it for good, **Not true** stops it (she won't pick
it up again unless you say it), **Forget** deletes it and what it was based on. Untick *Learn how I
like to work* to stop it entirely. Turning Memory off turns this off too.

Work and personal are separate: what she learns at work (work profile) is used only at work.
Household members each have their own list.

## For admins

Policy pin **Turn off How she works with you** (`workingStyle: false`): nothing is learned or used on
the server. Changes are audit rows of the `working-style` route group.
