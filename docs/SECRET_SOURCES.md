# Secret sources: keys from outside Sara

Settings → Data & health → **Operations** → *Secret sources*. Owner only. Design:
[ops/EC10_DESIGN.md](ops/EC10_DESIGN.md).

Sara keeps keys in her own encrypted vault by default. A server key (a model provider key, a chat app
token, a voice or picture key, the Home Assistant token, the business sign-in client secret) can
instead live in a secret store you already run. You type a **reference** in the usual key field
instead of the key itself; Sara reads the key when she needs it.

## How to write a reference

| Where the key lives | Reference | What the server needs |
| --- | --- | --- |
| An environment variable | `env:OPENAI_KEY` | the variable set for Sara's process |
| A file (Docker or Kubernetes secret) | `file:/run/secrets/openai` | an absolute path; one trailing newline is ignored |
| HashiCorp Vault or OpenBao (KV version 2) | `vault:secret/sara#openai` (mount `secret`, path `sara`, key `openai`) | `VAULT_ADDR`, and `VAULT_TOKEN` or `VAULT_TOKEN_FILE`; `VAULT_NAMESPACE` for Enterprise namespaces |
| 1Password Connect | `op://Servers/OpenAI/credential` or `op://Servers/OpenAI/section/field` | `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` (vault, item and field by name or id) |
| This computer's keychain | `keychain:sara/openai` (service `sara`, account `openai`) | macOS Keychain (`security`), Linux Secret Service (`secret-tool`), Windows Credential Manager (a generic credential whose target is `sara/openai`) |
| A command that prints the key | `cmd:op read op://Servers/OpenAI/credential`, `cmd:bws secret get 3f5e… #value` | `SARA_SECRET_COMMANDS=1` on the server (off by default: it runs a program) |

- **Several keys:** `env:OPENAI_KEY | env:OPENAI_KEY_2 | vault:secret/sara#openai_backup` (up to 8).
  The first that can be read is used. When the provider refuses the key in use (401, 403 or 429)
  before answering, Sara moves to the next one and tries again, once per key.
- A command runs without a shell, for at most 10 seconds; its output (trimmed) is the key. `#name`
  at the end picks a field from JSON output (Bitwarden Secrets Manager's `bws` prints JSON).
- Windows: add a key with `cmdkey /generic:sara/openai /user:openai /pass:<key>`.
- The business server's operator keys (`sara business configure-models`, `keys` in the file) and its
  sign-in client secret accept the same references.

## What Sara does with them

- **Read at use time, kept in memory only.** Environment variables are read every time. Everything
  else is read again after `SARA_SECRET_TTL` seconds (default 300); until then the last value is
  used, and a failed refresh keeps the last good value. *Check now* reads every reference at once.
  At start-up Sara reads them all before she answers.
- **Never written back.** The vault stores the reference, not the key. A backup (local or off-site)
  copies the encrypted vault, so it holds references only. Restoring on another server needs the
  same sources there.
- **Never shown or logged.** Settings shows each key's name, its source and whether it can be read,
  never the value. Keys read from a source, `VAULT_TOKEN` and `OP_CONNECT_TOKEN` are hidden in logs,
  run records and model output like any other key.
- **Plain errors.** For example "The environment variable OPENAI_KEY is not set.", "Vault refused
  secret/sara (403: permission denied). Check the token and its policy.", "1Password Connect has no
  field "credential" in item "OpenAI"."

## Audit trail and policy

- Audit rows (Settings → Household → Audit trail): `secret.source` when a key's source changes (for
  example `from.vault`, `to.env`), `secret.rotate` when a refused key is replaced by the next one,
  and `secret.resolve` when a reference that worked starts failing (*Failed*) or works again
  (*Done*). Rows hold names and source kinds, never values.
- Policy pin **Server keys only from secret sources** (`"externalSecrets": true`, see
  [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)): model, chat app, voice, picture, Home Assistant, GitHub,
  off-site backup and business keys can only be saved as references; a pasted key is refused with
  *Set by your admin*. Keys pasted before the pin keep working until they are replaced. Sara's own
  generated secrets (sign-in, the audit key, push keys) are not affected.

## Not covered

- Sara never writes, creates or rotates keys in the external store; rotate them there.
- OAuth tokens Sara receives herself (Google, ChatGPT and Claude subscriptions) stay in her vault.
- Vault auth methods other than a token (AppRole, Kubernetes) are left to Vault Agent, which writes a
  token file for `VAULT_TOKEN_FILE`.
