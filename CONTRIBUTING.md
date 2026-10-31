# Contributing to Sara

Thank you for helping. Sara is a self-hosted AI companion and coding partner written in plain
TypeScript on Node 24, with no build step and no runtime dependencies. This page covers how to set
up, the rules the code follows, and how to send a change.

New here? [docs/GOOD_FIRST_ISSUES.md](docs/GOOD_FIRST_ISSUES.md) lists small, real tasks with
pointers to the files involved, and [docs/EXTENDING.md](docs/EXTENDING.md) shows how to add tools,
bridges, characters, MCP servers, languages and starter templates.

## Set up

You need **Node 24 or newer** and git. Python 3 is needed for the Python starter tests and the
coding benchmark.

```sh
git clone https://github.com/farena-ai/sara.git
cd sara
npm ci                 # dev tools only (TypeScript, Node types): nothing ships at run time
npm run dev            # http://127.0.0.1:7860, restarts when you save
npm run check          # typecheck + all tests: must pass before every pull request
```

The first start prints a one-time owner token. Development data goes to `./data` (gitignored);
set `SARA_DATA=/some/folder` to keep a separate copy, and `SARA_PORT` for another port. To try her
for real you need a model: [Ollama](https://ollama.com) on your computer is the easiest
(the setup guide finds Ollama on the same computer by itself; or use Settings → Models → Model
providers → Add or update a provider → Template **Ollama on the server**, `http://127.0.0.1:11434/v1`).

**macOS:** the whole suite passes on a normal Mac. `git` and `python3` come with the Xcode Command
Line Tools (`xcode-select --install`); without them `/usr/bin/git` and `/usr/bin/python3` are only
stubs (the git and Python tests then skip). Run the tests in a normal terminal: inside a
coding-agent sandbox (no network or DNS, limited folders, no child processes or ports) the git,
Python, preview and browser tests can fail for reasons outside Sara.

## The rules

These are what keep Sara small, safe and easy to install. Pull requests that break them can't be
merged, however good the feature.

1. **No build step.** Node runs the `.ts` files directly (type stripping). Use only erasable syntax:
   no `enum`, no `namespace`, no constructor parameter properties; write `.ts` in import paths.
   `npm run typecheck` uses `tsc` with `noEmit` only.
2. **No runtime dependencies.** The server uses Node built-ins only (`node:http`, `node:sqlite`,
   `node:crypto`, …). The web app is plain HTML, CSS and JavaScript with no framework and no
   bundler. Dev dependencies need a very good reason.
3. **Written from scratch.** Don't copy code from other projects (including other AI assistants or
   agent frameworks). Using a public specification, a standard algorithm or official API docs is
   fine; note anything Sara downloads or calls in [docs/CREDITS.md](docs/CREDITS.md).
4. **Tests are required.** Every change in behaviour comes with a test in `test/` (Node's built-in
   test runner). Use the scripted fake model in `test/helpers.ts` (`makeApp`, `text`, `call`) so
   tests never need a real model or the network. Never weaken or delete a test to make a change
   pass; fix the code or explain in the pull request why the test was wrong.
5. **The safety layer can never be weakened.** AI disclosure at the start and every 3 hours, an
   honest answer when someone sincerely asks if she's an AI, crisis resources, and the hard block
   on sexual content involving minors live in code around the model call (`src/safety.ts`,
   [docs/COMPLIANCE.md](docs/COMPLIANCE.md)). No setting, flag, character, bridge or plug-in may
   turn them off or route around them. Changes there need a test that shows they still hold.
6. **No credentials, ever.** No API keys, tokens or personal data in code, tests, docs or
   screenshots. Test values must be obviously fake. Run
   `node scripts/public-export.ts --check-only` before you open a pull request.
7. **Every visible word can be translated.** New text in `web/` must be in the translation files:
   run `node scripts/i18n-extract.ts` and add the missing keys (English text as the key) to every
   file in `web/i18n/`. `test/i18n.test.ts` fails on any gap. See [docs/TRANSLATING.md](docs/TRANSLATING.md).
8. **Every setting has a tip.** A new control in Settings gets a **?** tip in `web/tips.json`;
   `node scripts/tip-coverage.ts` lists any without one and a test keeps that list empty.
9. **Plain words.** Settings, messages and docs are written for someone who isn't technical: say
   what a thing does for them, not how it works.

## Code style

- Small modules with a comment at the top saying what they're for. Comments explain *why*.
- Two-space indent, single quotes, semicolons, trailing commas; lines up to about 200 characters.
  Match the code around you.
- Errors the owner or the model will see are full sentences in plain words.
- Static web pages use the shared stylesheets: the Content Security Policy blocks inline `<style>`,
  `style="…"` attributes and inline scripts (a test checks).
- Database changes are additive migrations in the module that owns the table, and new columns
  must round-trip through export/import (`src/export.ts`).

## Send a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Make a branch, keep the change focused, and add or update tests and docs.
3. Run `npm run check` and `node scripts/public-export.ts --check-only`. Both must pass.
   If some tests also fail on an untouched `main` on your computer (a different Node version or
   operating system, a sandbox without network), that's not your change: open the pull request
   anyway, list those tests, and say they fail without your change too. The full suite is run on
   Linux with Node 24 before anything is merged.
4. Open a pull request and fill in the template. Screenshots help for anything visible.

Evals that need a real model (`scripts/eval-*.ts`, `scripts/bench-coding.ts`) are not part of
`npm run check`; run the ones that touch your change if you can, and say so in the pull request.
Results and how to re-run them: [docs/RESULTS.md](docs/RESULTS.md).

## Continuous integration (off)

There is a ready-made workflow in
[`.github/workflows-disabled/check.yml`](.github/workflows-disabled/check.yml) that runs
`npm ci` and `npm run check` on Ubuntu with Node 24. It is **switched off on purpose**: GitHub only
runs workflows from `.github/workflows/`, and the project owner decides when CI runs (Actions can
cost money on private repositories). With the owner's permission, switch it on by moving the file:

```sh
mkdir -p .github/workflows
git mv .github/workflows-disabled/check.yml .github/workflows/check.yml
```

Until then, please run the checks locally and paste the summary lines (`ℹ tests …`, `ℹ pass …`,
`ℹ fail 0`) into your pull request.

## Code of conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Please report security
problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
