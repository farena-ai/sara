# Packaging and releasing Sara (maintainer guide)

How a Sara release gets to the places self-hosters look: GitHub Releases, the GitHub container
registry, Homebrew, winget and the self-hosting app stores (Unraid, CasaOS, Umbrel, TrueNAS,
Proxmox). Everything here is a **manual** step the owner runs at release time: there is no CI and
no automatic publishing (owner rule: no GitHub Actions or paid services without permission). Every
script below only builds or prints until a step is explicitly marked as publishing.

## What lives where

| Path | What |
|---|---|
| `Dockerfile` | the container image: Node.js pinned to the same release as `deploy/install.sh` and by that tag's multi-arch digest (`NODE_DIGEST`), OCI labels, health check on `/api/health`, data volume `/data`, port 7860; nothing in it is tied to one architecture |
| `scripts/release-docker.sh` | builds the image with Docker buildx or Podman (`--engine`); `--all` builds linux/amd64 + linux/arm64 locally; pushes one multi-arch manifest `ghcr.io/farena-ai/sara:<version>` and `:latest` **only with `--push`** |
| `scripts/release-assets.sh` | collects installers, source tarball and VS Code extension into `outputs/release/<version>/`, writes `SHA256SUMS` and `notes.md`, prints the `gh release create` command |
| `scripts/update-packaging.ts` | fills version + checksums into the cask and winget manifests, and the image tag/version into the app templates |
| `packaging/homebrew/` | Homebrew cask for the Mac DMG (tap `farena-ai/homebrew-tap`) |
| `packaging/winget/` | winget manifests in `manifest/` (`BackstageCoding.Sara`, schema 1.10) |
| `packaging/unraid/` | Unraid Community Applications template |
| `packaging/casaos/` | CasaOS / ZimaOS app (compose + `x-casaos`) |
| `packaging/umbrel/` | Umbrel app (`umbrel-app.yml` + compose + `data/.gitkeep`; browser setup behind Umbrel's login) |
| `packaging/truenas/` | TrueNAS SCALE custom app (Install via YAML) |
| `packaging/proxmox/` | Proxmox VE helper script (Debian 12 LXC + `get-sara.sh`) |

Each `packaging/*/README.md` explains how to test and submit that one (exact PR target, fields,
which checks run where). `test/packaging.test.ts` checks they all agree on image name, port and
version, that browser setup without a code is only in the Umbrel template, and that the release
scripts can't push by accident.

## Local workflow package payload

The native Linux installer (including reruns), Windows and Mac bundlers, and Docker recipe
include the five existing builtin plugins and exactly twelve local workflow package trees under
`store/plugins`: daily-briefing, meeting-assistant, document-desk, research-notebook,
project-handoff, weekly-review, inbox-triage, content-studio, image-workshop,
spreadsheet-assistant, travel-planner and home-dashboard. Copy complete package directories,
including their own SDK, imported modules, manifests and assets. Do not copy all of `store/` or
catalog authoring, website or private evidence files into a runtime payload. Linux reruns replace
the distribution-owned `store/plugins` subtree so obsolete package files do not survive updates;
installed owner plugins and state live separately in the data directory.

Bundled local candidates require the ordinary review and explicit enablement flow. Their presence
and content hashes do not establish signed-store availability, author trust or account access.
Keep the existing builtin packages and signed-store flows separate.

Source recipe checks: `node --test test/packaging.test.ts test/addons-runtime-payload.test.ts
test/business-container-payload.test.ts` (one command line). These execute only bounded copy
commands and materialize Docker COPY inputs; they do not build native apps/images or perform an
OS installation. Actual Windows and Mac payloads, both container architectures, and a real isolated
Linux install followed by an installer rerun remain required qualification gates. Verify every
package file against the final source map, five builtin entries and exactly twelve candidate
roots, with no raw catalog files. Import the manager from the actual installed runtime with its
default relative roots and a working directory outside the source/install tree; a `candidateDir`
test override or a checkout-only pass does not prove installed discovery. Exercise missing and
tampered packages separately. These A1 artifact and installed-root checks are pending; existing
2.68 release artifacts and their receipts remain unchanged.

Ready-to-push submission folders (gitignored, made from the files above; copy again after a change):

| Folder | For |
|---|---|
| `outputs/umbrel/sara/` + `outputs/umbrel/pr-assets/` | the `sara/` folder for getumbrel/umbrel-apps; gallery `1.jpg`–`3.jpg` and icon for the PR description |
| `outputs/casaos/Apps/Sara/` | the `Apps/Sara/` folder for IceWhaleTech/CasaOS-AppStore (compose, icon, thumbnail, screenshots) |
| `outputs/unraid-templates/` | the repository farena-ai/unraid-templates (`ca_profile.xml`, `templates/sara.xml`, icon, screenshots) |
| `outputs/sara-home-assistant/` | the repository farena-ai/sara-home-assistant (the Home Assistant integration with its `brand/` icons, `hacs.json`, README, info.md, LICENSE, tests) |
| `outputs/brands/custom_integrations/sara/` | icons for home-assistant/brands (legacy route; HA 2026.3+ and HACS read `custom_components/sara/brand/`) |
| `outputs/homebrew-tap/` | the repository farena-ai/homebrew-tap (`Casks/sara.rb`, README, LICENSE) |
| `outputs/release/<v>/winget/…` and `…/homebrew/sara.rb` | written by `update-packaging.ts` |

The gallery pictures are real screenshots of a throwaway server (example owner "Alex", a stand-in
local model answering with fixed replies, no personal data), 1440×900.

## Release steps, in order

Version `X.Y.Z` = `package.json`'s (`CHANGELOG.md` has its `## X.Y.Z` section). Run from the
repository root on the dev PC (git-bash) unless a step says Mac.

1. **Export the public copy** (no private notes, scanned for secrets):

   ```sh
   node scripts/public-export.ts
   ```

   It must end with "No secrets or private machine details found". The source tarball is made
   from this copy.

2. **Build the installers** (the version comes from `package.json`):

   ```sh
   bash desktop/windows/build-installer.sh        # → outputs/windows/Sara-Setup-X.Y.Z.exe
   node scripts/pack-vscode.ts                    # → outputs/vscode/sara-vscode-<ext version>.vsix
   # on the Mac (signed + notarized):
   bash desktop/mac/build.sh                      # → desktop/mac/build/Sara-X.Y.Z.dmg
   ```

   Copy the DMG to `outputs/mac/Sara-X.Y.Z.dmg` on the dev PC.

3. **Collect the release files** (publishes nothing):

   ```sh
   bash scripts/release-assets.sh X.Y.Z --strict
   ```

   Check `outputs/release/X.Y.Z/notes.md` and `SHA256SUMS`.

4. **Create the GitHub Release** (publishing): tag, push the tag, then run the
   `gh release create …` command that step 3 printed. Use `--draft` first if you want to look at
   it on GitHub before it goes out.

5. **Push the container image** (publishing). Once per machine, sign in to the registry with a
   token that has `write:packages`:

   ```sh
   gh auth refresh -s write:packages
   gh auth token | docker login ghcr.io -u <github user> --password-stdin
   bash scripts/release-docker.sh                 # local build + try it first (port 7860)
   bash scripts/release-docker.sh --all           # both architectures build (nothing pushed)
   bash scripts/release-docker.sh --push          # amd64 + arm64 → ghcr.io/farena-ai/sara:X.Y.Z and :latest
   docker buildx imagetools inspect ghcr.io/farena-ai/sara:X.Y.Z   # shows the digest
   ```

   With Podman (for example on a Linux server without Docker; register QEMU for the other
   architecture first: `podman run --privileged --rm docker.io/tonistiigi/binfmt --install arm64`): the same
   with `--engine podman` and `podman login`; the digest is the top one of
   `podman manifest inspect docker://ghcr.io/farena-ai/sara:X.Y.Z`. Both list linux/amd64 and
   linux/arm64.

   First push only: on GitHub, *Packages → sara → Package settings*: make it **public** and link it
   to the `farena-ai/sara` repository.

6. **Fill the packaging** from the release's checksums:

   ```sh
   node scripts/update-packaging.ts X.Y.Z --image-digest sha256:<digest from step 5>
   winget validate --manifest outputs/release/X.Y.Z/winget/manifests/b/BackstageCoding/Sara/X.Y.Z
   npm run check
   ```

   Commit the updated `packaging/` files.

7. **Submit to the stores** (publishing; each folder's README has the details):
   - **Homebrew:** copy `outputs/release/X.Y.Z/homebrew/sara.rb` to `Casks/sara.rb` in
     `farena-ai/homebrew-tap`, `brew audit --cask --strict --online`, push.
   - **winget:** PR the folder `outputs/release/X.Y.Z/winget/manifests/b/BackstageCoding/Sara/X.Y.Z`
     to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) (or `wingetcreate submit`).
   - **Unraid:** push `outputs/unraid-templates/` to farena-ai/unraid-templates and submit it at
     https://ca.unraid.net/submit/new (first time); later releases need nothing (`:latest`).
   - **CasaOS:** PR `outputs/casaos/Apps/Sara/` as `Apps/Sara/` to IceWhaleTech/CasaOS-AppStore.
   - **Umbrel:** PR `outputs/umbrel/sara/` as `sara/` to getumbrel/umbrel-apps (multi-arch image
     and browser setup needed, so from 1.1).
   - **Home Assistant (HACS):** push `outputs/sara-home-assistant/` to farena-ai/sara-home-assistant and make a GitHub
     Release; later, PR it into hacs/default (see `integrations/home-assistant/README.md`).
   - **TrueNAS:** the custom-app YAML needs no submission; the catalog is optional (see its README).
   - **Proxmox:** the script runs from the public repository; listing it in community-scripts is
     optional (see its README).

## Home Assistant: HACS and brands

`outputs/sara-home-assistant/` is the repository **farena-ai/sara-home-assistant** in the layout HACS requires
(one integration under `custom_components/sara/`, `hacs.json` with `name` and the minimum Home
Assistant version, README, MIT LICENSE). Brand icons now ship inside the integration
(`custom_components/sara/brand/icon.png` 256×256 and `icon@2x.png` 512×512): Home Assistant 2026.3+
shows them from there, and HACS's "brands" check looks there first. The
home-assistant/brands repository calls its `custom_integrations/` folder legacy since then, so
`outputs/brands/custom_integrations/sara/` is kept only in case a reviewer asks for it.

Checked here: **hassfest** (Home Assistant's validator, its official container
`ghcr.io/home-assistant/hassfest`, run with Podman on the Linux server against the folder):
"Invalid integrations: 0" after moving the example URLs in the setup form into description
placeholders (it rejected URLs in `strings.json`). The integration's own tests (pytest with
`pytest-homeassistant-custom-component`) are in `tests/`.

Publish (owner):

1. Create the public repository `farena-ai/sara-home-assistant` (description, topics such as
   (Repository names must not contain "HACS": hacs-bot rejects them. Renamed 2026-10-28.)
   `home-assistant`, `hacs`, `integration`, `ai`; issues on), push `outputs/sara-home-assistant/` to `main`.
2. Make a GitHub Release (tag `v<manifest version>`, now `v0.3.0`). Users can then add it in HACS as a
   custom repository right away.
3. For the HACS default list: add the [HACS action](https://github.com/hacs/action) and
   [hassfest action](https://github.com/home-assistant/actions#hassfest) workflows to *that*
   repository (GitHub Actions: needs the maintainer's yes), let them pass, make a new
   release, then PR the line `farena-ai/sara-home-assistant` (alphabetical) into the `integration` file of
   [hacs/default](https://github.com/hacs/default) from a personal (not organization) fork, filling
   in their PR template. Their bots then check brands, manifest, hacs.json, releases, license,
   repository description/topics/issues.

## MCP directories (Glama)

[Glama](https://glama.ai/mcp/servers) lists MCP servers after building a Dockerfile and checking that
the server starts and answers `tools/list`; awesome-mcp-servers requires that listing. Sara's real MCP
endpoint needs a running Sara and an API key, so the directory gets the bridge's describe mode:
`packaging/glama/Dockerfile` (paste it into Glama's form; it copies `src/mcp-bridge.ts` and runs it
with `--describe`). `glama.json` at the repository root names the maintainer (`farena-ai`) so the
listing can be claimed. The tool list there is kept identical to the server's by
`test/mcp-describe.test.ts`.

## Notes

- **Why the container starts as root:** Sara's server starts as the container's root only to run
  her shell commands and MCP servers as the separate `sara-tools` user, which can't read her data
  (keys, database). Every capability except six is dropped and `no-new-privileges` is set (in
  `docker-compose.yml` and every template). Running the container as a plain user works too, but
  then her commands can read her keys. TrueNAS's catalog and Umbrel reviewers may ask about this.
- **First sign-in in app stores (Phase 59):** a new server can be set up in the browser.
  Umbrel's template uses `SARA_SETUP=browser` (one click, because Umbrel's login guards
  `/api/claim`); every other template uses the default: the short setup code from the container
  log, which CasaOS, TrueNAS and Unraid all show in their dashboard. Never set `SARA_SETUP=browser`
  in a template without a login proxy. Threat analysis: [THREAT_MODEL.md](THREAT_MODEL.md).
- **ARM64 (Phase 59):** the Dockerfile has nothing architecture-specific (Node comes from the
  pinned multi-arch base image; Sara has no native npm packages). Built for real for linux/arm64 on
  an x86_64 server with Podman 4.9 + QEMU (`tonistiigi/binfmt --install arm64`, removed
  afterwards): `SARA_IMAGE=localhost/sara-p59 bash scripts/release-docker.sh --engine podman
  --platform linux/arm64` (2 min 22 s). Run on port 7880 with the usual hardening flags:
  `uname -m` = aarch64, `node -p process.arch` = arm64 (v24.22.1), `podman healthcheck run` healthy,
  `/api/health` ok, the log showed the owner token and the setup code, and `/api/claim` worked
  (wrong code 401, cross-origin 403, right code 200 + new token + signed-in cookie, again 404).
  `--all` built one manifest list with linux/amd64 and linux/arm64/v8. Podman notes now in the
  script: `--format docker` (OCI drops the HEALTHCHECK) and pulling the pinned base per platform
  first (Podman 4.x otherwise fails the second platform with "image not known").
