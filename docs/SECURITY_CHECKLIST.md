# After installing: a five-minute security checklist

Sara holds your private conversations and the keys to your other accounts. These steps keep them
safe. Most are in **Settings → Data & health → Devices and sign-in**.

1. **Keep the owner token safe.** Put it in a password manager, not in a note or a chat. If
   someone else may have seen it, make a new one: *Make a new owner token* on the same page (or
   `sudo sara reset-token` on the server), which signs every other device out.
2. **Add a passkey.** *Passkeys → Add a passkey* lets you sign in with your fingerprint, face or
   device PIN instead of the long token. It needs HTTPS (Tailscale or your own web address).
3. **Turn on two-step sign-in.** With it on, the owner token alone isn't enough: signing in also
   asks for a 6-digit code from an authenticator app. Passkeys and new-device codes don't need it.
   Lost your phone? `sudo sara reset-token` on the server turns two-step (and passkeys) off.
4. **Reach her over HTTPS only.** Prefer Tailscale or your own web address. "My home network" is
   plain HTTP: only on a network you trust. Never open port 7860 to the internet. `sudo sara
   access` shows how she's reached now.
5. **Check who's signed in.** The list on Devices and sign-in shows every browser, phone and app.
   Sign out any you don't recognize or no longer use.
6. **Review tool approvals.** *Settings → Coding → Tools and approvals*: anything that runs
   commands, sends things, spends money or reaches other people should stay on **Ask**. On
   Windows, where there's no command sandbox, keep commands on Ask.
7. **Check the sandbox.** *Settings → Data & health → Health* shows the tool sandbox. On Linux it
   should say `bwrap` (bubblewrap); if it says `none`, see
   [INSTALL.md, Troubleshooting](INSTALL.md#troubleshooting).
8. **Set up an off-server backup.** *Settings → Data & health → Backups → Off-server copy* puts an
   encrypted copy of each daily backup on another drive or in S3-compatible storage. Keep the
   passphrase in your password manager: without it the copies can't be opened.
9. **Treat backups like keys.** Backups on the server contain her vault key. Don't copy them to
   shared folders or send them to anyone.
10. **Keep her updated.** Only the latest release gets security fixes: `sudo sara update` (Linux)
    or Settings → Data & health → Updates.

Optional, for more privacy: [PRIVACY.md](PRIVACY.md) lists everything that can leave your server
and how to turn each off (for example `SARA_REPORT_TO=off`, or local models for every job).

How Sara is defended, in detail: [THREAT_MODEL.md](THREAT_MODEL.md). Found a security problem?
[SECURITY.md](../SECURITY.md).
