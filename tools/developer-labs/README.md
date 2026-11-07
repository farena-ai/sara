# Developer lab previews

`previews.mjs` runs each lab add-on's **real handler** on the checked-in synthetic fixtures in a
fresh owned temporary home and writes the actual cards to `outputs/developer-labs/previews.json`.
`render-previews.py` (Pillow) draws those cards into each package's `shots/1.png`, labelled as a
synthetic preview. They are not screenshots of a live Sara application.

```sh
node tools/developer-labs/previews.mjs && python tools/developer-labs/render-previews.py
```

Test Doctor, Flaky Test Lab, Documentation Doctor, Release Readiness and Repository Onboarding (H_EXEC) are previewed through the host's real plan check and job
runner (`src/plugins/exec-job.ts`, Node fence, a disposable copy): `node tools/developer-labs/previews.mjs test-doctor flaky-test-lab documentation-doctor release-readiness repository-onboarding`.
