// Store sequence 8 (SARA_STORE.md §4.7.1): turns store/locales-extra.json into the signed sidecar
// v1/locales-extra.json + v1/locales-extra.sig for a list the hub publisher already built and signed.
// Runs on the OWNER'S PC after `store-publish.ts` and before the upload: the signing key never leaves it.
//
//   node scripts/store-locales-extra.ts --out <publisher output dir> [--key <pem>] [--key-name store-2026a]
//   node scripts/store-locales-extra.ts --out <dir> --check-only     builds and checks, writes nothing
//
// It checks the built index's signature with Sara's public keys first (a stale or foreign --out is
// refused), keeps only the items on that list, signs the exact bytes, checks the signature with the
// public key as Sara would and parses the result with Sara's own parser. Nothing is uploaded.
import { createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE_KEYS } from '../src/store/keys.ts';
import { parseLocalesExtra } from '../src/store/locales.ts';
import { signatureOk } from '../src/store/verify.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface ExtraOptions {
  out: string;
  source?: string;
  key?: KeyObject;
  keyName?: string;
  publicKeys?: Readonly<Record<string, string>>;
  checkOnly?: boolean;
}

export function buildLocalesExtra(o: ExtraOptions): { seq: number; items: number; written: string[]; text: string } {
  const v1 = join(o.out, 'v1');
  const keys = o.publicKeys ?? STORE_KEYS;
  const indexBytes = readFileSync(join(v1, 'index.json'));
  signatureOk(indexBytes, readFileSync(join(v1, 'index.sig')), keys, []);
  const index = JSON.parse(indexBytes.toString('utf8')) as { seq: number; items: { id: string }[] };
  const src = JSON.parse(readFileSync(o.source ?? join(ROOT, 'store', 'locales-extra.json'), 'utf8')) as { items?: Record<string, unknown> };
  const listed = new Set(index.items.map((i) => i.id));
  const items = Object.fromEntries(Object.entries(src.items ?? {}).filter(([id]) => listed.has(id)));
  const text = `${JSON.stringify({ format: 'sara-store-locales-extra', v: 1, seq: index.seq, items }, null, 1)}\n`;
  parseLocalesExtra(text, index.seq);
  if (o.checkOnly) return { seq: index.seq, items: Object.keys(items).length, written: [], text };
  if (!o.key) throw new Error('No signing key: pass --key <pem> (or --check-only).');
  const keyName = o.keyName ?? 'store-2026a';
  const bytes = Buffer.from(text, 'utf8');
  const sig = `${JSON.stringify({ v: 1, key: keyName, sig: edSign(null, bytes, o.key).toString('base64') })}\n`;
  signatureOk(bytes, sig, keys, []);
  writeFileSync(join(v1, 'locales-extra.json'), bytes);
  writeFileSync(join(v1, 'locales-extra.sig'), sig);
  return { seq: index.seq, items: Object.keys(items).length, written: ['v1/locales-extra.json', 'v1/locales-extra.sig'], text };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = opt('--out');
  if (!out) {
    console.error('Usage: node scripts/store-locales-extra.ts --out <publisher output dir> [--key <pem>] [--key-name store-2026a] [--check-only]');
    process.exit(2);
  }
  const keyName = opt('--key-name') ?? 'store-2026a';
  const checkOnly = args.includes('--check-only');
  const keyPath = opt('--key') ?? join(ROOT, '.secrets', 'store-signing', `${keyName}.pem`);
  if (!checkOnly && !existsSync(keyPath)) {
    console.error(`No key at ${keyPath}.`);
    process.exit(1);
  }
  const r = buildLocalesExtra({ out: resolve(out), keyName, checkOnly, ...(checkOnly ? {} : { key: createPrivateKey(readFileSync(keyPath)) }) });
  console.log(checkOnly ? `Checked: seq ${r.seq}, ${r.items} items. Nothing written.` : `Signed with ${keyName}: seq ${r.seq}, ${r.items} items -> ${r.written.join(', ')}.`);
}
