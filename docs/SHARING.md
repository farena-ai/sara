# Sharing a conversation

Share one chat as a **read-only link** that expires by itself and can be revoked at any time
(design: `ops/EC1115_DESIGN.md`). The person with the link sees a copy of the chat on a plain page;
they can't reply, sign in or see anything else.

## Make a link

1. Open the chat → its settings (the title menu) → **Share…**
2. Choose what goes in. By default only your messages and her replies:
   - **Include tool results**: what her tools returned (searches, files, commands), scrubbed and cut
     to 2,000 characters each. Tool-call arguments are never shared.
   - **Include pictures**: up to 12 pictures from the chat are copied into the link.
3. Pick how long it works: **1 hour, 1 day, 7 days** (default) or **30 days**. There is no "forever".
4. Check the **preview**: it is exactly what the link will show. Keys, passwords, your vault's
   secrets, e-mail addresses and phone numbers are replaced with `[REDACTED]`, `[email]`, `[phone]`.
5. **Make link** and copy it. The link is shown once (Sara keeps only a fingerprint of it).

The link uses the address you are on, so it works behind your public address, reverse proxy or
tunnel. The shared page tells the reader that the replies were written by an AI.

## What can't be shared

- Off-the-record chats, chats with someone else (partner chats), adult chats, group chats and
  imported chats: never.
- Private chats, and every chat while *Nothing leaves this computer* (private local mode) is on:
  only after you tick **Allow sharing private chats** in Settings → Household → Shared links.
- The demo has no links.

## Household members

Members share **their own** chats the same way (Share… in a chat's settings), with the same
hiding, expiry and refusals; private chats follow your *Allow sharing private chats* setting. Each
member sees and revokes only their own links in Settings → Household → Shared links; you see only
how many links members have open, never their titles. Turn **Household members can share their
own chats** off and they can't make new links, and their existing links stop opening (they come
back, unless expired, when you turn it on again). Removing a member revokes all of their links.
Audit rows name the member (`member:<id>`).

## Manage links

**Settings → Household → Shared links** lists every live link: when it was made, when it
expires and how many times it was opened. **Revoke** ends it at once (the copy is deleted).
Deleting the chat revokes its links too. Expired links are cleaned up by themselves.

## For admins

- Policy pin **Turn off shared links** (Settings → Household → Policy, `"sharing": false`): no new
  links, and existing links stop opening while the pin is on.
- Audit trail rows: `share.create` (the choices, never the token), `share.view` (first open),
  `share.revoke` (with the number of opens), `share.settings` (which switch changed).
- The page is sent with `X-Robots-Tag: noindex, nofollow, noarchive`, `no-store` and
  `no-referrer`, has no script, and is rate-limited per address (60 opens a minute; 20 wrong links
  in 15 minutes blocks that address for a while).
- Storage: `<data>/shares.db` (snapshots and the token fingerprints).
