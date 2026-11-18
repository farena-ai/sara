# Publishing the SDK to npm (owner steps)

V0.9. The developer SDK in [`packages/sara-sdk`](../packages/sara-sdk/README.md) is ready to publish as
**`@farena-ai/sara-sdk`**. Agents never publish it and never make accounts: these steps are yours.
Everything here is free (a public package in a free npm organization costs nothing).

What is ready: name, version `0.1.0`, ESM `exports` with types, `files` (only `dist/`, `examples/`,
`README.md`, `LICENSE`, `package.json` ship), MIT license, repository/homepage/bugs links to the public
repo `github.com/farena-ai/sara`, `publishConfig.access: public`, and `prepack`/`prepublishOnly` build
`dist/` with tsc. `test/v0stores.test.ts` and `test/ec22-sdk.test.ts` check all of it, including a clean
`npm pack --dry-run` and the shipped example running against a throwaway Sara.

## 1. Make the npm account (once, ~5 minutes)

1. Open https://www.npmjs.com/signup. Pick a username (for example `farena-ai-owner`), your email and
   a strong password. Confirm the email npm sends you.
2. Turn on two-factor sign-in (2FA): avatar → **Account** → **Two-Factor Authentication** → **Enable 2FA**.
   Choose an authenticator app or a security key / passkey, and choose **Authorization and writes**
   (npm then asks for a code on every publish). Save the recovery codes somewhere safe (your password
   manager), not in the repository.

## 2. Make the free organization `farena-ai` (once)

1. Avatar → **Add Organization** (or https://www.npmjs.com/org/create).
2. Name: `farena-ai`. Plan: **Unlimited public packages — free**. Skip inviting people.
3. The package name `@farena-ai/sara-sdk` now belongs to you. If `farena-ai` is taken, stop and tell
   the agents: the fallback is the unscoped name `sara-sdk` (one line in `package.json`, README and
   examples; the tests pin the name, so they change with it).

## 3. Sign in on this PC

In Git Bash or PowerShell:

    npm login

It opens the browser to sign in (with your 2FA). Check with `npm whoami` (prints your username).

## 4. Look before you publish

    cd packages/sara-sdk        (inside your checkout of the repository)
    npm pack --dry-run

It builds `dist/` and lists the files that would ship: `LICENSE`, `README.md`, `package.json`,
`dist/*.js` + `dist/*.d.ts` and `examples/*.mjs`: 13 files, about 14 kB. Nothing else (no `src/`, no
secrets). The name line must say `@farena-ai/sara-sdk` and the version `0.1.0`.

## 5. Publish

From the same folder (`packages/sara-sdk`, on `main` after this branch is merged):

    npm publish --access public

npm asks for your 2FA code, then prints `+ @farena-ai/sara-sdk@0.1.0`. The page is
https://www.npmjs.com/package/@farena-ai/sara-sdk a minute later. Check it from any folder:

    npm view @farena-ai/sara-sdk version

**Later versions:** raise `version` in `packages/sara-sdk/package.json` (npm never accepts the same
version twice), then run steps 4 and 5 again. A mistaken publish can be removed within 72 hours with
`npm unpublish @farena-ai/sara-sdk@<version>`; after that only `npm deprecate` is possible.

## 6. What to send back

Send the agents (no passwords, codes or tokens, ever):

- the output line of `npm publish` (`+ @farena-ai/sara-sdk@0.1.0`) or of `npm view @farena-ai/sara-sdk version`;
- your npm username (to list as the maintainer), and whether the org name was `farena-ai` or the fallback;
- whether you want a token for automated publishing later (default: no; you publish by hand).

The agents then update the SDK README's install line notes, the CHANGELOG and ROADMAP_V item 9 to "published".
