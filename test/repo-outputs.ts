// Some add-on/export tests need fixtures inside this checkout's own outputs/ folder (the export and
// bundle guards only accept strict descendants of it). A read-only checkout, such as the server's
// root-owned /opt/sara-src run as the sara user, cannot host them: those tests skip with this
// reason instead of failing at mkdir, and evidence writers stay best-effort.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO_OUTPUTS = resolve(import.meta.dirname, '..', 'outputs');

export const REPO_OUTPUTS_READONLY: string | false = (() => {
  try {
    const dir = resolve(REPO_OUTPUTS, 'addons');
    mkdirSync(dir, { recursive: true });
    const probe = resolve(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return false;
  } catch {
    return "this checkout's outputs/ folder is not writable (read-only checkout); the test needs fixtures inside it";
  }
})();
