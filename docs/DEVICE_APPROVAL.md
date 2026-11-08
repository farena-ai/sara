# Approve new devices

Settings → **Devices and sign-in** → **Approve new devices**.

When it is on, a sign-in with the owner token or a passkey from **somewhere other than this computer**
waits for your OK. "Somewhere else" includes another computer or phone, and anything that comes
through a tunnel or a proxy (Cloudflare Tunnel, Tailscale, Caddy, nginx), even though those connect
from 127.0.0.1.

## Approving

1. The new device shows a 5-character code, for example `K7Q2M` (no look-alike letters; any case).
2. You get a prompt on a device you already use (and a push), and a message from her in Telegram or
   Discord if you linked them. The code is **not** in those messages: read it off the new device.
3. Approve: type the code in the prompt, or reply `approve K7Q2M` to her in Telegram or Discord.
   Refuse: **Deny**, `deny K7Q2M`, or just `deny` (refuses every waiting request).
4. No answer in 10 minutes is a no. A device can never approve itself.

Signing in with a **pairing code or QR** (Settings → Devices → Sign in another device), a **device
code** (terminal, VS Code), and **API keys** don't wait: they were made on a trusted device already.
The first device of a brand-new server doesn't wait either (there is nothing to approve it from).

## Sensitive actions from a remote device

From a device signed in from elsewhere, these ask you first in the same way (the device shows a code):
turning on **Always allowed**, a new owner token, installing an add-on from a web address, changing
the Telegram or Discord token, updating (restarting) Sara, and turning this switch off.

## Also on this page

- **Devices at most**: over the limit, the device you used longest ago is signed out. API keys, Home
  Assistant and Sara's hands don't count. Any browser sign-in unused for 30 days is signed out.
- **Allowed addresses**: the names this server answers to besides localhost and IP addresses (for
  example `sara.example.com, .ts.net`). A page on another site that points its own name at your
  computer (DNS rebinding) gets no answer. Leave it empty to accept any name that comes through a
  proxy.
- A sign-in from an address never seen before sends you a notice.
- Signing a device out cuts its open connections at once.

With the switch on, the owner token as an `Authorization: Bearer` header only works on this computer;
from elsewhere use a device code or an API key.

Servers set up before this version keep it **off** and show a one-time notice; new servers start with
it on. An admin can pin it on (Data & health → Policy → *Keep new-device approval on*).
