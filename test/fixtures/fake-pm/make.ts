// Phase 91: writes the password-manager test doubles (fake-pm.mjs) into a scratch folder: launchers
// `bw` / `op` (Windows: bw.cmd / op.cmd) in <dir>/bin, and each double's config folder with the test's
// fixture (obviously fake entries and master passwords). Test processes put <dir>/bin on their search path
// and point BITWARDENCLI_APPDATA_DIR / OP_CONFIG_DIR at the folders this returns; nothing else on the
// computer is touched.
//   node test/fixtures/fake-pm/make.ts <dir> <fixture.json>   (prints {bin, env} as JSON)
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakeBwItem {
  name: string;
  uri: string;
  username: string;
  password: string;
}
export interface FakeOpItem {
  id: string;
  title: string;
  url: string;
  username: string;
  password: string;
}
export interface FakeKpxEntry {
  title: string;
  url: string;
  username: string;
  password: string;
}
export interface FakeFixture {
  bitwarden?: { master: string; items: FakeBwItem[] };
  '1password'?: { master: string; items: FakeOpItem[] };
  /** The keepassxc-cli double: its "database" is this JSON (the real KeePassXC is tested with a real one). */
  keepassxc?: { master: string; entries: FakeKpxEntry[] };
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function writeFakeManagers(dir: string, fx: FakeFixture, node = process.execPath): { bin: string; env: Record<string, string>; keepassDb?: string } {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(dir, 'fake-pm.mjs');
  copyFileSync(join(HERE, 'fake-pm.mjs'), script);
  const env: Record<string, string> = {};
  for (const [kind, key, cfg] of [['bw', 'bitwarden', 'BITWARDENCLI_APPDATA_DIR'], ['op', '1password', 'OP_CONFIG_DIR']] as const) {
    const f = fx[key];
    if (!f) continue;
    const conf = join(dir, `${kind}-config`);
    mkdirSync(conf, { recursive: true });
    writeFileSync(join(conf, 'fixture.json'), JSON.stringify(f));
    writeFileSync(join(conf, 'state.json'), JSON.stringify({ sessions: [] }));
    env[cfg] = conf;
    if (process.platform === 'win32') writeFileSync(join(bin, `${kind}.cmd`), `@"${node}" "${script}" ${kind} %*\r\n`);
    else {
      writeFileSync(join(bin, kind), `#!/bin/sh\nexec "${node}" "${script}" ${kind} "$@"\n`);
      chmodSync(join(bin, kind), 0o755);
    }
  }
  let keepassDb: string | undefined;
  if (fx.keepassxc) {
    keepassDb = join(dir, 'kpx-test.kdbx');
    writeFileSync(keepassDb, JSON.stringify(fx.keepassxc));
    if (process.platform === 'win32') writeFileSync(join(bin, 'keepassxc-cli.cmd'), `@"${node}" "${script}" kpx %*\r\n`);
    else {
      writeFileSync(join(bin, 'keepassxc-cli'), `#!/bin/sh\nexec "${node}" "${script}" kpx "$@"\n`);
      chmodSync(join(bin, 'keepassxc-cli'), 0o755);
    }
  }
  return { bin, env, ...(keepassDb ? { keepassDb } : {}) };
}

if (process.argv[1] && /make\.ts$/.test(process.argv[1])) {
  const [dir, file] = process.argv.slice(2);
  if (!dir || !file) {
    console.error('Usage: node test/fixtures/fake-pm/make.ts <dir> <fixture.json>');
    process.exit(2);
  }
  console.log(JSON.stringify(writeFakeManagers(dir, JSON.parse(readFileSync(file, 'utf8')) as FakeFixture)));
}
