// C9: writes and signs a release's update-notice.json (docs/ops/ship-release.sh publish runs it).
//   node scripts/update-notice.ts sign <version> --dir outputs/release/<version> \
//     --key .secrets/update-notice/notice-key.pem [--min <oldest supported>] [--security] [--date <ISO>]
//   node scripts/update-notice.ts verify <update-notice.json>
// The notice lists the Windows installer, the Mac disk image and the source tarball with their
// SHA-256, and must verify against the public key built into Sara (src/update-notice.ts), so a
// wrong or missing key stops the release here instead of shipping a notice nobody accepts.
import { createHash, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signNotice, verifyNotice, type NoticeAsset, type NoticePayload } from '../src/update-notice.ts';

const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};

if (cmd === 'verify' && arg) {
  const r = verifyNotice(JSON.parse(readFileSync(arg, 'utf8')));
  if (!r.ok) fail(`Not valid: ${r.reason}`);
  if (r.ok) console.log(`Valid notice for Sara ${r.notice.version} (key ${r.keyId}; ${Object.keys(r.notice.assets).join(', ')})`);
} else if (cmd === 'sign' && arg && /^\d+\.\d+\.\d+$/.test(arg)) {
  const v = arg;
  const dir = opt('dir') ?? fail('--dir is needed');
  const keyFile = opt('key') ?? fail('--key is needed');
  if (!existsSync(keyFile)) fail(`No release-notice key at ${keyFile} (see docs/ops/C9_DESIGN.md).`);
  const asset = (name: string): NoticeAsset | undefined => {
    const f = join(dir, name);
    if (!existsSync(f)) return undefined;
    return { name, url: `https://github.com/farena-ai/sara/releases/download/v${v}/${name}`, sha256: createHash('sha256').update(readFileSync(f)).digest('hex'), size: statSync(f).size };
  };
  const assets: Record<string, NoticeAsset> = {};
  for (const [k, n] of [['win32-x64', `Sara-Setup-${v}.exe`], ['darwin', `Sara-${v}.dmg`], ['linux', `sara-${v}.tar.gz`]] as const) {
    const a = asset(n);
    if (a) assets[k] = a;
    else if (rest.includes('--strict')) fail(`Missing ${n} in ${dir}`);
  }
  const payload: NoticePayload = { version: v, date: opt('date') ?? new Date().toISOString(), minSupported: opt('min') ?? '0.0.0', security: rest.includes('--security'), assets };
  const signed = signNotice(payload, createPrivateKey(readFileSync(keyFile)));
  const check = verifyNotice(signed);
  if (!check.ok) fail(`The notice doesn't verify with the key built into Sara (${check.reason}): wrong key file?`);
  writeFileSync(join(dir, 'update-notice.json'), `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`update-notice.json: Sara ${v}, min ${payload.minSupported}${payload.security ? ', security' : ''}, ${Object.keys(assets).join(', ')}`);
} else {
  fail('Usage: update-notice.ts sign <version> --dir <folder> --key <pem> [--min x.y.z] [--security] [--strict] | verify <file>');
}
