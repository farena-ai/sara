# Legacy and emergency access

Name one person you trust and choose what they get if you stop using Sara: a letter, short notes,
documents from your Library, sealed notes (for example a password manager hint), your details card
and, only if you pick them, chats. Nothing is shared while you use Sara.

Where: **Settings → Privacy & system → Privacy → Legacy and emergency access.**
Design notes: [design/LEGACY.md](design/LEGACY.md).

## How it works

1. **Set it up.** Turn on legacy access, type their name, pick what they get, press **Save** and
   confirm it's you (passkey, two-step code or owner token). Sara shows their link **once**: give it
   to them on paper or in a message only they read. Before the page opens, the link shows only
   "closed for now" and nothing about you.
2. **Sara watches for you.** Signing in, chatting with her (a message you typed: not automations,
   other apps or household members) or pressing **I'm here** counts as "you are here". Background
   app checks never count.
3. **Reminders.** After the number of days you chose (default 60, 14-365) without you, Sara reminds
   you every day for 3 days, in the place you chose under *Where alerts go* and on your phone.
4. **Waiting period.** Then she waits (default 14 days, 3-60) and reminds you every 2 days with the
   date the page opens.
5. **The page opens** for the number of days you chose (default 30, 1-90), then closes for good. If
   you ticked it and a mail account is connected, Sara emails them the link once when it opens.

**Any sign-in, chat or I'm here cancels** at every stage and closes an open page again; the same
link works the next time. **Turn off** drops the link at once and never asks for proof.

## Emergency request

If you allow it, their page has an **Ask for access** button. You are told at once, and the page
still waits the full waiting period, so you can cancel by signing in. One request per week.

## What is protected

- Their link is 32 random bytes; Sara keeps only a fingerprint of it (and a vault-sealed copy for the
  opening email). **Make a new link** stops the old one.
- Wrong links are counted: after 20 misses from one address the page answers "too many requests".
- Documents download only while the page is open and only the ones you picked.
- Chats are not included unless you pick them; picked chats are shown with keys, passwords and email
  addresses blanked out.
- Sealed notes are stored encrypted in Sara's vault and appear only on the open page. Adding one
  needs a separate confirm box. Sara never hands out her own keys (model, chat app, backup keys).
- Giving them more (a new person, more documents, a shorter wait) needs your proof; giving them less
  never does. Every change is in the audit trail.
- Only the owner of the server can use this (not household members, the demo or API keys).
