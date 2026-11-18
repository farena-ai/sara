# Sign in with your provider (OpenID Connect)

Let the people on your Sara server sign in with an account you already run or use: **authentik**,
**Keycloak**, **Pocket ID**, **Authelia**, **Google**, **Microsoft Entra ID**, **Okta** or any other
OpenID Connect provider. It works on every server: personal, household and (with its own page)
business. Your owner token, passkeys and pairing codes always keep working, so a broken provider
never locks you out.

Where: **Settings → Connections → Devices and sign-in → Sign in with your provider** (owner only).

## Set it up (about five minutes)

1. **Provider**: pick yours. Sara shows the 3–4 steps for that provider and the issuer pattern.
2. **Redirect URL**: copy the address Sara shows (`https://<your Sara>/api/sso/callback`) and paste it
   at the provider as the redirect / callback URL. Open Settings from the address people will use
   (for example your Tailscale or reverse-proxy name): that address is saved with the settings.
3. **Issuer URL, Client ID, Client secret**: copy them from the provider. The secret is kept in Sara's
   encrypted vault and never shown again.
4. **Who is who**: for each person, type the emails or groups that are them. Nobody signs in as the
   owner unless you add your own email (or an owner group).
5. **Check the provider** reads the discovery document and keys. **Test sign-in** opens the provider
   in a new window and runs the whole sign-in: it signs nobody in and links nothing, and shows who
   that account would be, the email and the groups the provider sent.
6. Tick **Show the button on the sign-in page** and **Save**. The sign-in page now has
   "Sign in with <button text>".

**Preview**: type an email and groups to see who that person would sign in as (uses the saved rules).

## Per provider

| Provider | Issuer URL | Groups |
| --- | --- | --- |
| authentik | `https://<host>/application/o/<slug>/` | `groups` claim; bind the application to groups |
| Keycloak | `https://<host>/realms/<realm>` | add a Group Membership mapper (claim `groups`, full path off) |
| Pocket ID | `https://<pocket-id host>` | user groups allowed for the client (Sara asks for the `groups` scope) |
| Authelia | `https://<authelia host>` | add the `groups` scope to the client |
| Google | `https://accounts.google.com` | none: match people by email; keep the app in Testing with test users |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant id>/v2.0` | optional groups claim (object IDs) |
| Okta | `https://<your-org>.okta.com` | optional groups claim filter |

## Rules in plain words

- A provider account is matched by (1) an earlier link, (2) a verified email you listed, (3) a group
  you listed for a person, (4) an **owner group**. The first sign-in links the account; another
  account with the same email can't take over until you press **Unlink**.
- **Member groups / Kid groups** (optional): once set, members or kids sign in only while they are in
  one of them, so removing someone from the group at the provider stops new sign-ins.
- **New members** (off by default): turn on **Make a new member…**, confirm **Everyone on this list is
  18 or older**, and list allowed emails or groups. The person also ticks "I'm 18 or older" on the
  sign-in page. Kids are never made automatically: invite them from Household.
- **Clock difference allowed**: how far the clocks may differ when checking ID token times (60 s).
- Sign-in from another computer still asks your OK when *Ask me before a new device signs in* is on.
- **Sign out** of a provider session also opens the provider's sign-out page.

## When it does not work

The sign-in page and Test sign-in say what went wrong in plain words, for example *"This account is
not linked to anyone here"*, *"The provider refused the client ID or secret"*, *"The issuer does not
match"* or *"The ID token is expired or from the future: check the clock"*. You can always sign in
with your token or passkey and fix the settings.

Private local mode allows only a provider on this computer or your home network.
