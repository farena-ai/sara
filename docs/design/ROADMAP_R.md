# Roadmap R1-R9 (owner request, 2026-11-14: "Do all of these. Roll it all out.")

Follows NEXT.md (N1-N7, shipped in 3.8.0-3.10.0). Same standing rules: free first, approvals for changes
and anything that costs money, never fake data, lean, every string translated, tests first.

Owner decisions (2026-11-14):
- Phone number (R5): build it ready and switched off; no number is bought until the owner tests it later.
- iPhone (R4): no TestFlight; the native app was denied before. Ship what works without the App Store
  (installed web app + Apple Shortcuts for share sheet and Siri), and keep a thin native shell ready only
  as source.
- Build and release everything, in waves.

## R1 Real-use proof
Large Outlook attachments (upload session), Windows signing wired to Azure Artifact Signing (switched on
when the owner's account values arrive), a "first real use" checklist with self-tests the owner or Hank
can run from Settings (mail, calendar, phone push, desktop app, Mac tabs), and fixes from live logs.

## R2 Easy for anyone to start
Guided 5-minute setup (mail, calendar, phone, computer), a sample-data tour, starter packs (household,
small business, sales, student), a download page that picks the right installer, Android release ready.

## R3 Errands, start to finish
"Get this refunded / book an oil change / find a plumber": a plan, steps through mail, forms, browser and
follow-ups, an Errands page with progress, approval at every step that commits or costs money.

## R4 iPhone without the App Store
Installed web app polish (web push, badges), an Apple Shortcut "Share to Sara" in the share sheet and
"Ask Sara" for Siri, signed per-device tokens, a lock-screen/home widget through Shortcuts; native shell
source kept ready, not submitted.

## R5 Voice that does things (ready, off)
Phone calls in and out through a provider adapter (no number bought), Discord voice, hands-free errands
from car mode.

## R6 Deeper work apps
Edit Google Docs/Sheets and Microsoft 365 files, Slack/Teams actions, booking links, QuickBooks/Xero
export files.

## R7 Business-grade trust
SSO (Entra/Okta via OIDC), admin tool policies for members, audit export, retention settings, restore
checks, a security overview.

## R8 Family
Chores and allowance, school calendar from emails, kid-safe member mode, shared grocery list with stores.

## R9 Polish for everyone
Document facts in six languages, screen-reader and large-text pass, offline improvements, shareable
automation templates.

Waves: A = R1, R2, R3, R4; B = R5, R6, R7, R8, R9. Each wave merges, passes the full suite and releases.
