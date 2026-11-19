# Install matrix

Last run: 2026-11-19, commit `a2ebe0e2`. Made by `node scripts/install-matrix.ts --write` (Linux and Docker) and
`node scripts/check-windows-install.ts` (Windows, TestInstall build only). "unverified" means the run could not
happen on the test PC (the reason is in the note); it is never counted as a pass.

Each Linux row: a throwaway container with systemd, the real `deploy/get-sara.sh --yes --access local --source <tarball>`
from a tarball of the commit above (no download from GitHub, nothing published), then `/api/health`, an update over
the existing install (data kept), and the preflight port card.

| Target | Result | Steps | Note |
|---|---|---|---|
| ubuntu-22.04 | unverified | - | Docker is not available on the test PC (docker info failed) |
| ubuntu-24.04 | unverified | - | Docker is not available on the test PC (docker info failed) |
| debian-12 | unverified | - | Docker is not available on the test PC (docker info failed) |
| fedora-40 | unverified | - | Docker is not available on the test PC (docker info failed) |
| almalinux-9 | unverified | - | Docker is not available on the test PC (docker info failed) |
| ubuntu-24.04-arm64 | unverified | - | Docker is not available on the test PC (docker info failed) |
| docker-compose | unverified | - | Docker is not available on the test PC (docker info failed) |

## Windows

<!-- windows -->
Windows 11 Pro (build 26300), 2026-11-19: the **TestInstall** build of this commit's `sara.iss` ("Sara update test":
its own AppId, folders and data, never the real Sara), compiled with ISCC over a staged 2.65 package whose server
files were refreshed from this worktree. Silent per-user installs (`/CURRENTUSER /MODE=user /PORT=8795`) driven by
a script; the real Sara's uninstall entries were read before and after and did not change. Windows Sandbox is not
installed on this PC; all-users (service) installs need an administrator and were not run.

| Target | Result | Steps | Note |
|---|---|---|---|
| windows-11 | pass | preflight os card ok (exit 1, nothing installed), ram card ok (exit 1), disk card ok (exit 7, nothing installed), fresh install ok (10s, /api/health), update over the install ok (22s), uninstall ok, real Sara untouched ok | failures simulated with the TestInstall-only `/PFTEST=os,ram,disk` |
| windows-10 | unverified | - | no Windows 10 machine or Sandbox on the test PC; the Windows version check is covered by the simulated card |
| windows-service | unverified | - | all-users install needs an elevated shell (scripts/check-windows-install-admin.ps1) |
| macos-13-15 | unverified | - | the Mac was not used for this task; `node src/main.ts --preflight` runs the same checks there |
<!-- /windows -->

## Checked on every test run (no Docker needed)

test/w2-install.test.ts runs the real `get-sara.sh --preflight` and `install.sh --preflight` under bash with
faked facts (a fake /etc/os-release and /proc/meminfo, CPU, free space, busy ports, network): Ubuntu 24.04
healthy, low disk/memory/port in use/no network/no root, 32-bit Raspberry Pi OS, no systemd, Ubuntu 18.04
(glibc 2.27), Alpine (musl), an existing install on her own port, and `--source` without GitHub. It also checks
that `node src/main.ts --preflight` creates no data folder and that the limits are the same in the shell,
Node and Windows Setup checks.
