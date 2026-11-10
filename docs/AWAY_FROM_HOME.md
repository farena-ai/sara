# Use Sara away from home

Sara runs on your own computer. At home, your phone can reach her over the same Wi-Fi only when
she listens on your home network. When you are out, the phone needs a private way back to that
computer. Sara uses **Tailscale** for that: a free app from another company (Tailscale Inc.) that
links your own devices privately. Nothing on your computer is opened to the internet, and nobody
outside your own Tailscale account can reach her. Sara has no paid relay or service of its own.

## The three steps

Open **Settings → Connections → Devices and sign-in → Use Sara away from home** (or Ctrl K →
*Use Sara away from home*, *tailscale* or *use on my phone outside*). Each step checks itself.

1. **Install Tailscale on this computer and sign in.** The page links Tailscale's download page
   for your system and shows whether Tailscale is installed, signed in and switched on.
2. **Install Tailscale on your phone and sign in with the same account.** Scan the QR code for
   Android (Google Play) or iPhone (App Store), sign in with the same account, and switch it on.
3. **Let your phone reach Sara.** Press **Turn on secure access with Tailscale** and confirm.
   Sara runs `tailscale serve --bg --https=<port> http://127.0.0.1:<her port>` once: your
   Tailscale devices get a private `https://<computer>.<your-tailnet>.ts.net` address (HTTPS, so
   the microphone and voice work on the phone). If HTTPS port 443 is already used by something
   else on this computer, Sara takes the next free one and leaves yours alone. Then press
   **Test it**: Sara calls her own new address and says **"Your phone can reach Sara anywhere ✓"**.

Then connect the phone app ([PHONE.md](PHONE.md), step 2): the pairing QR now holds the new address.

## Good to know

- **Owner only, with a confirmation.** Household members don't see this page; apps signed in with a
  device code can't change it. **Turn off secure access** undoes it; Sara only turns off the
  serve she turned on herself (recorded in `<data>/reach.json`), and only while it still points
  at her. Nothing else in your Tailscale setup is touched. It never uses Tailscale Funnel (the
  public internet).
- **If Tailscale asks for an OK first** ("Serve is not enabled on your tailnet"), the page shows
  Tailscale's link: open it, allow it, and press the button again. If HTTPS certificates are off
  for your Tailscale account, open the Tailscale admin page → DNS → **Enable HTTPS**.
- **No restart is needed.** Sara keeps listening on this computer only; Tailscale passes the
  requests from your devices to her. Those requests count as coming from another device, so
  new-device approval and sign-in work as usual.
- **Installed with the Windows or Mac installer and chose Tailscale there?** Then it is already
  set up and the page shows the address; the installer's `sara access` command manages it.
- **Home network only (no Tailscale):** start Sara with `SARA_HOST=0.0.0.0` (or `sara access lan`
  on Windows) and the pairing QR uses this computer's home-network address. That address works
  only on the same Wi-Fi and has no HTTPS, so the microphone may not work in the phone browser.
- **Your own domain** (`SARA_PUBLIC_URL=https://…`, see [INSTALL.md](INSTALL.md)) is used too.
- **Health** (Settings → Data & health → Health) shows the same answer: *Your other devices: …*,
  with a link here when your phone can't reach her yet.
- **Private local mode** ("Nothing leaves this computer") pauses turning it on.

How the address is picked: `src/reach.ts` (tests: `test/reach.test.ts`).
