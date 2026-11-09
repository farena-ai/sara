# Moving Sara to a new server or computer

Everything Sara knows lives in one data folder, and one backup file holds all of it: her
conversations, memories, character, look, library, workspaces, settings and her keys. Moving her
is: **back up → install on the new machine → restore → switch off the old one.**

The backup format is the same on Linux, Docker, Windows and macOS, so you can also move between
them (for example from a Windows PC to a Linux server).

## 1. Make a fresh backup on the old machine

| Where she runs now | Command |
|---|---|
| Linux | `sudo sara backup /root/sara-move.tar.gz` |
| Docker | `sudo docker compose exec sara node src/main.ts --backup /data/backups/sara-move.tar.gz`, then `sudo docker compose cp sara:/data/backups/sara-move.tar.gz .` |
| Windows | `sara backup C:\Users\<you>\Desktop\sara-move.tar.gz` (terminal as administrator for a service install) |
| Mac | `sara backup ~/Desktop/sara-move.tar.gz`, or menu bar → *Sara on this Mac → Back up now* |

You can also press *Back up now* in Settings → Data & health → Backups. A backup made a moment ago
is best: anything said after it won't move.

**The backup contains her keys** (the vault and the key that opens it). Copy it to the new machine
privately: a USB stick, `scp`, or your own cloud drive. Don't email it or put it in a shared
folder, and delete the extra copies when you're done.

## 2. Install Sara on the new machine

Follow [INSTALL.md](INSTALL.md) for the new system. Use the same version or a newer one: a backup
from an older version restores into a newer Sara (her data is brought up to date on the first
start), but not the other way round. You'll get a new one-time owner token; you won't need it,
because the restore brings back your old one.

## 3. Restore

| New machine | Command |
|---|---|
| Linux | `sudo sara restore /root/sara-move.tar.gz` |
| Docker | see [INSTALL.md, Docker Compose](INSTALL.md#docker-compose) (Restore) |
| Windows | `sara restore C:\path\to\sara-move.tar.gz` |
| Mac | `sara restore ~/Desktop/sara-move.tar.gz` |

The restore stops her, puts the backup in place (the new install's own data is kept aside, not
deleted) and starts her again.

## 4. Sign in and check

1. Sign in with your **old owner token** (the one from before the move).
2. Open Settings → Data & health → Health, or run `sara doctor`, to check that every model
   provider answers. A provider that pointed at `127.0.0.1` (Ollama on the old machine) needs its
   address changed in Settings → Models → Model providers.
3. **Passkeys belong to a web address.** If Sara's address changed, sign in with the owner token
   (and your two-step code, if on) and add the passkey again.
4. **Phones and apps** remember the old address. If it changed, pair them again (Settings → Connections →
   Devices and sign-in → *Add a phone or computer*) and sign out the old entries.
5. **Subscriptions:** on Linux, run `sudo /opt/sara-src/deploy/install-agents.sh` again on the new
   server. If a subscription shows as signed out, sign in again in Settings → Models →
   Subscriptions.
6. **Coding projects:** folders like `node_modules` aren't in backups. Ask her to reinstall the
   project's packages (or run the install command yourself) before building.
7. **Extras** that belong to a machine, not to her data, need installing again on the new one:
   local voice, the testing browser, bubblewrap, and how you reach her (`sudo sara access`).

## 5. Switch off the old one

Stop or uninstall Sara on the old machine (`sudo sara uninstall`, or the uninstaller on Windows and
Mac). Two copies running at once would both answer on Telegram and Discord, both send reminders,
and both run her background work. Keep the old data until you're happy with the new machine, then
delete it.

## Passphrases and keys, in short

- **The owner token** signs you in. It moves with the backup.
- **Her master key** opens her vault (your API keys and sign-ins). It's inside the backup, so you
  don't have to do anything, unless you set `SARA_MASTER_KEY` yourself on the old machine: then the
  key isn't in her data folder, and you must set the same `SARA_MASTER_KEY` on the new machine
  before restoring.
- **The backup passphrase** is only for **off-server copies** (`.enc` files). To restore one, you
  need that passphrase: Linux and Windows ask for it; on a Mac and in Docker set
  `SARA_BACKUP_PASSPHRASE` first ([INSTALL.md](INSTALL.md#mac)). Without the passphrase an `.enc`
  copy can't be opened.

If the old machine is already gone, restore the newest off-server copy the same way.
