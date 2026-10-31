# Webhooks and event triggers

Since 2.35.0 (Phase 102). A webhook is a secret address that GitHub, Stripe, Home Assistant or any
script can send to when something happens. Sara checks each delivery, matches it against your
conditions and then does one thing with it: **tells you**, **adds a task**, **runs a skill** or
**sends it to a plugin**. Design: [design/STAPLES.md §10](design/STAPLES.md).

What a sender sends is **information, never orders**. An issue titled "ignore your instructions" is
just an issue title: she can't be talked into using tools the webhook doesn't have, and anything
that changes something waits for your OK.

## Make one

*Settings → Connections → Webhooks → New webhook*. Three steps:

1. **Where it comes from**: GitHub, Stripe, Home Assistant or Something else. This picks how
   deliveries are checked and offers ready-made conditions.
2. **When**: a ready-made event, or your own conditions (all must match).
3. **What she does**: Tell me, Add a task, Run a skill or Send to a plugin.

Then you see the webhook's **address** (`https://<her address>/hook/<id>.<secret>`) and, for GitHub,
Standard Webhooks and header tokens, the **secret** to paste into the sender. Both are shown
**once**; copy them then. Only a hash of the address secret is kept; the sender's secret lives in
the encrypted vault. *⋯ → New address (rotate)* makes a new address (the old one stops at once).

## How deliveries are checked

| Kind | What the sender sends | Replays and doubles |
|---|---|---|
| GitHub | `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the raw body | `X-GitHub-Delivery` kept 24 h |
| Stripe | `Stripe-Signature: t=…,v1=…` over `t.body`; at most 5 minutes old; any `v1` may match (rotation) | the event `id` kept 24 h |
| Standard Webhooks | `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` over `id.timestamp.body` with a `whsec_` secret; at most 5 minutes old | `webhook-id` kept 24 h |
| Header token (weaker) | `X-Sara-Token: <token>` | optional `X-Request-Id` kept 24 h |
| Address only (weaker) | nothing: the address is the only key | none |

The signature is checked on the raw bytes before anything reads them, with constant-time
comparisons. Every webhook also has the secret in its address, so none is ever open. The two weaker
kinds can only **tell you** or **add a task**, unless you tick *Let it start her work anyway*.

Answers are short on purpose: `202` when accepted (also when your conditions filtered it out, so
senders don't retry), `401` for a bad signature, `404` for an unknown, switched-off or wrong-secret
address (all the same), `405` for anything but POST, `413` over 256 KB, `415` for a body that isn't
JSON, a form or plain text, `429` with `Retry-After` when over a limit. No cookie, session or app
key ever counts on `/hook/…`.

## Conditions

Conditions look at a header, a field of the body (dots and `[n]`: `data.object.amount`,
`commits[0].id`) or the whole text. Checks: equals, is not, is one of (comma list), contains, starts
with, >, <, exists, changed to (the value is new: Home Assistant's `old_state` → `new_state`, or the
value this webhook saw last time).

Ready-made: GitHub *An issue was opened*, *A pull request was opened*, *CI failed* (`workflow_run`
completed with `conclusion = failure`), *A release was published*; Stripe *A payment failed*
(`invoice.payment_failed`), *A dispute was opened*, *A payout was paid*; Home Assistant *A state
changed to a value*.

## What she does

- **Tell me**: a notice in the webhook's own conversation (in the **Hooks** project) and a
  notification. *Also on Today* puts important ones under *From your webhooks*. The summary is
  your template (`{{repository.full_name}}: {{issue.title}}`, `{{event}}`, `{{header.X-Name}}`) or,
  when it's empty, one line from her quick model.
- **Add a task**: a card in the board and column you pick, titled from the template and marked as
  outside text. *Assign it to her* starts the card's work under the board's rules (it counts
  against the webhook's runs a day; weaker webhooks need the extra tick).
- **Run a skill**: she follows one of her skills in the background with the delivery as input, in
  the webhook's conversation. She gets **only the tools you tick** (to-dos, web search, GitHub, Home
  Assistant); anything that changes something asks you on a card (even tools that usually run on
  their own; *Always allowed* never applies). She knows nothing about you unless you tick *Share
  notes that aren't private*, and never sees people cards. The result arrives as a notification.
- **Send to a plugin**: the `event:webhook` hook of one plugin that is switched on and asked for
  webhook events (example: `examples/plugins/webhook-notes`). It gets the webhook's id and name, the
  event name and the body (secrets hidden, at most 16 KB).

**Also send a signed copy to** (under *Limits and a signed copy*): after each delivery she POSTs a
short JSON note (`type: "sara.hook.delivery"`: the webhook, the event, the summary, what she did)
to an `https` address, signed the Standard Webhooks way with its own `whsec_` secret (shown once).
Only public addresses: not this computer, the home network, Tailscale or link-local addresses
(checked again for every name it resolves to); no redirects are followed; one try. For local
testing only, start Sara with `SARA_HOOKS_LOCAL_TARGETS=1` to allow `http://127.0.0.1:<port>`.

## Limits and the log

- Per webhook: 30 deliveries a minute (over → `429` and the webhook pauses for 10 minutes, with one
  note an hour on Today), 500 a day, 20 runs a day (skill runs and cards assigned to her; one at a
  time, up to 5 wait, the rest are dropped with a log line) and 50,000 tokens a day. Across all
  webhooks: 120 a minute. Five bad signatures in a minute from one address pause that address for
  10 minutes.
- **Log**: every delivery with its time, verdict (accepted, filtered out, bad signature, duplicate,
  rate limited, too big, error), sender address, event, size and what she did (the card, the
  conversation, the problem). Bodies are stored with secrets hidden and cut to 16 KB; bad-signature
  bodies keep only their size. Kept 14 days (*Keep the delivery log* changes it).
- **Test**: try a ready-made sample, the last delivery or a pasted body (with headers, to check a
  signature). It shows the signature verdict, each condition, the summary and what she would do,
  and changes nothing. *Run it for real* does it once (logged and counted).
- **Send a test** shows the exact `curl` with a signature made now (run it within 5 minutes). The
  address is filled in while the page still has it; otherwise replace `$HOOK_URL`.

## Can the sender reach her?

The sender must reach your server. With **Tailscale** (`sara access`), devices on your tailnet can
(Home Assistant with Tailscale); GitHub and Stripe need **Tailscale Funnel** or **your own web
address**. On **your home network** only local senders can; **just this computer** only local
programs. The page says which applies.

## Setting up senders

**GitHub** (repository → Settings → Webhooks → Add webhook): Payload URL = the address, Content
type = `application/json`, Secret = the secret Sara made, pick the events. GitHub sends a `ping`
first (logged as filtered out unless your conditions allow it).

**Stripe** (Dashboard → Developers → Webhooks → Add endpoint): the address and the events, then
reveal the endpoint's *Signing secret* (`whsec_…`) and paste it under *⋯ → Change it*.

**Home Assistant** (`configuration.yaml`), with the token Sara made:

```yaml
rest_command:
  tell_sara:
    url: "https://<her address>/hook/<id>.<secret>"
    method: POST
    content_type: "application/json"
    headers:
      X-Sara-Token: !secret sara_hook_token
    payload: >-
      {"event_type":"state_changed","data":{"entity_id":"{{ entity_id }}",
       "old_state":{"state":"{{ old }}"},"new_state":{"state":"{{ new }}"}}}
```

and call it from an automation: `action: rest_command.tell_sara` with `data: { entity_id: …, old:
"{{ trigger.from_state.state }}", new: "{{ trigger.to_state.state }}" }`.

**Anything else**: sign deliveries the Standard Webhooks way (most webhook libraries can) with the
`whsec_` secret, or use *Send a test* to see a working request.

## Privacy and households

Webhooks are the owner's only: household members get `403` on every webhook route and no `/hook/`
address in their space; the demo never accepts webhooks. Private local mode: deliveries still
arrive (nothing leaves), runs use local models, notifications stay in the app and signed copies to
other addresses are paused.

## For developers

| Piece | File |
|---|---|
| Signatures, bodies, filters, templates, presets, curl | `src/webhook-verify.ts` |
| Store (`hooks`, `hook_deliveries`, `hook_today`, `budget_ledger`), receiving, limits, actions, test button | `src/webhooks.ts` |
| SSRF rules for outgoing copies | `checkPublicTarget`, `isPrivateAddress` in `src/net-guard.ts` |
| `event:webhook` for plugins | `PluginManager.sendWebhook` in `src/plugins/manager.ts` |
| Routes `/api/hooks…`; `/hook/:token` | `src/routes/hooks.ts`; `src/server.ts` |
| Page and chat cards | `web/hooks.js`, `web/hooks.css`; Today in `web/today.js` |
| Tests | `test/phase102.test.ts`, the webhooks case in `test/household-isolation.test.ts` |

## Owner to-dos
- Decide how GitHub and Stripe reach the home server: your own HTTPS address or Tailscale Funnel
  (`sara access`). Without one, only senders on your network or tailnet (Home Assistant) work.
- Set up one GitHub hook (*CI failed → Tell me*) and one Home Assistant hook (*a sensor → Add a
  task*), and press **Test** on each.
- Optional: point *Also send a signed copy to* at a public https receiver you control and check its
  `webhook-signature` with your Standard Webhooks library.
