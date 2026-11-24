# What needs the owner

Owner, 2026-11-24: "Run all tracks in roadmap, anything that needs human add to the human roadmap
and push those until the end, build out and do anything else that can be done currently."

Everything in docs/ROADMAP_AFTER_3.42.md that code alone cannot do is here, so it stops being
scattered over handoffs. Each item says what it needs from him, about how long it takes, and what it
unblocks. When he has done one, write the result under it and move the unblocked work back to
docs/BACKLOG.md.

In the app, Help → What's new now has **Worked** and **Did not work** on every item (kept on the
server): that is the quick way to answer "did the new thing work for you" after an update.

## A sign-in or a key

1. **Sign in `claude` on the build computer** (`claude` in a terminal, then `/login`), or give an
   Anthropic API key. Two minutes.
   Unblocks: the first real run of the thinking level, of background work on "low", of thinking kept
   between tool steps and of the cache split (A2); structured answers through the Claude program
   (A3); her words between tool calls on the newest Claude models (needs a key, not a subscription).

## Half an hour with devices

2. **Phone**: open Sara on the phone after an update. Is a reload quick? Does the home chat open?
   Do Settings pages fit? Can the model chip, + Project and Off the record be tapped easily? Does
   Send ever miss a tap while the keyboard closes? (A4, E4)
3. **Windows app**: the installer's pictures, quick ask, the app updating itself, how the screens
   look (A4, and the first part of E1).
4. **A connected computer**: ask her for one real desktop action and one command through it, and
   a screenshot question with a model that can see (A5).
5. **Chat on Quick, then on Thorough**, with a Claude model on the subscription (Settings → Models &
   usage → Default model → How hard she thinks). Does it answer? Is Thorough slower and better on
   something hard? (part of A2 that needs no build computer)

## Things only real accounts and hardware can show (A6)

6. A real phone number for phone calls (only a stand-in provider has been used).
7. A real iPhone: Shortcuts, Siri, the share sheet, push and the badge.
8. Two real machines for remote repair and the support link (only one computer talking to itself
   so far).
9. The Kubernetes chart on a real cluster.
10. Outlook.com sign-in for mail; pairing a phone by QR over Tailscale.
11. SmartScreen on a clean Windows PC with the signed installer.

## Decisions

12. **The crisis notice once per conversation?** (B4) Today the app's notice with the crisis lines
    comes on every flagged message of a conversation. Once, then again only after a gap or when a
    message says more, would be calmer. It is the legal layer, so it is his call.
    **Decided 2026-11-24:** "yes once only not multiple times in a session". Built in T49: the app's
    notice on the first flagged message of a conversation or session, not again there (no gap
    rule); every flagged message is still recorded and her care in the reply is unchanged; child
    accounts keep the notice every time. See docs/CRISIS_EVALS.md "Once per conversation (B4)".
13. **App-defined function tools in the Open Responses API?** (C33) Needed for full compatibility;
    it lets another app hand her tools.
14. **`OLLAMA_KEEP_ALIVE` on his PC**: left at five minutes (he said to leave the one-model limit
    because ComfyUI shares the card). Nothing to do unless models reload too often.
15. **The multilingual embedding model as the first suggestion?** Today the small English one is
    suggested first and bge-m3 is listed second; his server already uses bge-m3.

## His list

16. **The screens that look unfinished to him** (E1), the Windows app first. Still the most useful
    polish input there is.

## What was tried without him and where it stopped

- Claude: the installed program lists `--effort` and `--json-schema` on both the build computer
  (2.1.282) and his server (2.1.310); the sign-in on the build computer has expired.
- Phone: looked at in a browser at phone width (375 px): Today, Settings home, Default model,
  Which model does what. Nothing broken. A browser at phone width is not a phone.
