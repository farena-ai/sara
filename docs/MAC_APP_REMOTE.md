# Install Sara on a Mac for a Sara that runs somewhere else

This guide is for someone setting up the **Sara app on a Mac** when Sara herself already runs on another
computer or a server (for example `sara.example.com`). The Mac only gets the app; her memories, chats and
settings stay on the server. Takes about five minutes.

## What you need

- A Mac with **macOS 13 (Ventura) or newer**, Apple silicon or Intel.
- The **address of the Sara server**: the same address you open in a web browser to reach her (for example
  `sara.example.com`, or `http://100.x.y.z:7860` on a Tailscale or home network).
- **Someone already signed in to that Sara** (in a browser, on a phone or another computer): they make a
  one-time sign-in code for the Mac. If that's you, have that device at hand.

## 1. Download

1. Open the latest release: <https://github.com/farena-ai/sara/releases/latest>.
2. Under **Assets**, download **`Sara-<version>.dmg`** (about 110 MB).
   - Or, if the server's owner put the app on the server: in a browser on the Mac, signed in to Sara,
     Settings → Connections → Devices and sign-in → **Download for Mac**.
   - Or with Homebrew: `brew install --cask farena-ai/tap/sara`.

## 2. Install

1. Open the downloaded `.dmg` (double-click it in Downloads).
2. Drag **Sara** onto the **Applications** folder in the window that opens.
3. Eject the disk image (the ⏏ next to "Sara" in the Finder sidebar) and delete the `.dmg` if you like.

The app is signed with a Developer ID and notarized by Apple, so it opens like any downloaded app. If macOS
still asks *"Sara is an app downloaded from the Internet. Are you sure you want to open it?"*, choose
**Open**.

## 3. First start: choose "somewhere else"

1. Open **Sara** from Applications (or Launchpad, or Spotlight: ⌘Space, type *Sara*).
2. The first screen asks how to use it. Choose **Connect to a Sara somewhere else**.
   - Don't choose *Run Sara on this Mac*: that installs a new, empty Sara on this Mac.
3. On **Connect to your Sara**, type the server's address in **Address** and press **Continue**.
   - Plain names like `sara.example.com` use HTTPS automatically. Home-network and Tailscale addresses
     (`192.168.…`, `100.…`, `something.local`) use HTTP. You can also type the full address with `https://`.
   - *"That doesn't look like a web address"* means a typo; *Can't reach your Sara* means the Mac can't
     get to the server (check the address in Safari first; for a Tailscale address, Tailscale must be
     running on this Mac too).

## 4. Sign in with a code

The app now opens that Sara's **sign in with a code** page (a *Code* box).

1. On the device that is already signed in, open **Settings → Connections → Devices and sign-in** and
   press **Add a phone or computer**. It shows a QR code and a short code like `ABCD-EFGH-JKLM`.
   The code works once and for 10 minutes.
2. On the Mac, type the code in the **Code** box and confirm.
3. If this is the first time on this device, Sara shows her short notice that she is an AI. Read it and
   continue. You're in: every conversation, her look and her settings are the ones on the server.

The Mac keeps only the address and its own sign-in. To sign the Mac out later: Settings → Devices and
sign-in on any signed-in device, or remove the server in the app (below).

## 5. Allow what it asks for (once)

macOS asks the first time each is needed. Allow them for the best experience; you can change them later in
**System Settings → Privacy & Security** and **Notifications**.

- **Notifications:** messages, reminders and approvals while the window isn't in front. Approvals have
  **Allow / Deny** buttons; reminders have **Done / Snooze**.
- **Microphone:** for calls and voice messages. **Camera:** only for video calls, if you turn it on.

## 6. Everyday use

- **The menu bar icon** (top right, her picture) keeps Sara running when you close the window: *Open Sara*,
  *Ask Sara…*, what she's doing now, *Settings…*, *Your Saras ▸*, *Open at login*, *Help*, *Quit Sara*.
  Quitting the app doesn't stop the server; she keeps running there.
- **Quick ask:** press **⌥⇧S** (Option-Shift-S) anywhere to ask her something in a small window. Change
  the shortcut in the menu bar icon → *Quick ask shortcut*, or in Sara's Settings → This computer.
- **Files:** drop files on the Sara icon in the Dock, or into the chat window; they wait in the message box
  until you press Send.
- **Open at login:** tick it in the menu bar icon's menu so Sara is there after a restart.
- **Zoom:** ⌘+ / ⌘- / ⌘0. **Settings:** ⌘,.

## 7. More than one Sara, or moving to a different one

Menu bar icon → **Your Saras ▸ → Add a Sara…** adds another server (each keeps its own sign-in; ✓ marks the
one in use). *Your Saras ▸ → Remove …* signs out of one and removes it from the list.

## 8. Updating and removing

- **Update:** download the new `.dmg` and drag Sara to Applications again (replace). Homebrew:
  `brew upgrade --cask sara`. Your sign-in stays.
- **Remove:** quit Sara (menu bar icon → *Quit Sara*) and drag **Sara** from Applications to the Trash.
  Nothing on the server changes. Also sign the Mac out on the server: Settings → Devices and sign-in →
  remove it, so its old sign-in can't be used again.

## If something goes wrong

| What you see | What to do |
|---|---|
| *Can't reach your Sara* | Open the same address in Safari on the Mac. If Safari can't either, it's the network or the server; the app tries again every 30 seconds. |
| The code is refused | Codes work once and for 10 minutes: make a new one. Type it with or without the dashes. |
| No notifications | System Settings → Notifications → Sara → Allow notifications. Also check Focus / Do Not Disturb. |
| The shortcut does nothing | Another app may use ⌥⇧S: pick another in the menu bar icon → *Quick ask shortcut*. |
| Microphone or camera don't work | System Settings → Privacy & Security → Microphone / Camera → turn Sara on, then restart Sara. |

More: [desktop.md](desktop.md) (how the apps work), [SERVERS.md](SERVERS.md) (several servers),
[INSTALL.md](INSTALL.md) (setting up a server).
