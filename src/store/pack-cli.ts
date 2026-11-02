// Phase 125 (2.58.0, SARA_STORE.md §9.2, §9.4): `sara pack <folder>` and `sara submit <folder>`.
//   node src/store/pack-cli.ts pack <folder|.zip> [--json] [--out <base>] [--no-smoke]
//     Checks it (manifest, permissions, secrets, scan, the fenced smoke test, screenshots, listing),
//     prints the report and writes <folder>.sarapack.zip and <folder>.sarapack.json. Sends nothing.
//   sara submit <folder> [--name "Shown name"] [--contact you@example.com] [--yes]
//     (node src/main.ts submit …, as the sara user: it needs the vault for the author key) packs it,
//     shows the report, the permission lines and exactly what is sent, asks "Send? (y/N)" and
//     uploads it to the Sara team's desk. `--github` only prints the optional GitHub steps.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSandbox } from '../tools/sandbox.ts';
import { fenceFor } from '../plugins/runtime.ts';
import { packPath, reportText, type Pack } from './pack.ts';

const opt = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export function smokeFence(): ReturnType<typeof fenceFor> {
  try {
    return fenceFor(detectSandbox('auto', false));
  } catch {
    return 'node-only';
  }
}

export async function runPack(args: string[], o: { saraVersion: string; log?: (l: string) => void }): Promise<{ code: number; pack?: Pack; base?: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!target) {
    log('Usage: sara pack <folder>');
    return { code: 2 };
  }
  const path = resolve(target);
  const pack = await packPath(path, { saraVersion: o.saraVersion, smoke: args.includes('--no-smoke') ? false : smokeFence() });
  const base = resolve(opt(args, '--out') ?? path.replace(/[\\/]+$/, '').replace(/\.zip$/i, ''));
  if (pack.size) {
    writeFileSync(`${base}.sarapack.zip`, pack.zip);
    writeFileSync(`${base}.sarapack.json`, `${JSON.stringify(pack.report, null, 1)}\n`);
  }
  if (args.includes('--json')) log(JSON.stringify({ ready: pack.report.ready, sha256: pack.sha256, size: pack.size, report: pack.report }));
  else {
    log(reportText(pack.report));
    if (pack.size) log(`Wrote ${base}.sarapack.zip (${pack.size} bytes, sha256 ${pack.sha256}) and ${base}.sarapack.json.`);
  }
  return { code: pack.report.ready ? 0 : 1, pack, base };
}

/** `sara submit`: the CLI form of *Submit yours* (main.ts gives it the vault, the database and the hub). */
export async function runSubmit(args: string[], c: { saraVersion: string; dataDir: string; vault: import('../vault.ts').Vault; hubBase: string; installId: string; db: import('node:sqlite').DatabaseSync; os: string; log?: (l: string) => void; ask?: (q: string) => Promise<string> }): Promise<number> {
  const log = c.log ?? ((l: string) => console.log(l));
  if (args.includes('--github')) {
    log('The Sara team reviews submissions sent from Sara itself: no account is needed. A GitHub pull request is not used for now.');
    return 0;
  }
  const r = await runPack(args.filter((a) => a !== '--yes'), { saraVersion: c.saraVersion, log });
  if (!r.pack || r.code !== 0) return r.code || 1;
  const { authorKey, shortFingerprint, submit, deskDown } = await import('./submit.ts');
  const key = authorKey(c.vault, { create: false });
  const name = opt(args, '--name') ?? '';
  const contact = opt(args, '--contact');
  if (!name.trim()) {
    log('Add --name "the name shown on the store" (an email for replies is optional: --contact).');
    return 2;
  }
  log('\nWhat is sent to the Sara team:');
  log(`  · the package (${r.pack.size} bytes) and this report`);
  log(`  · the name shown on the store: ${name}${contact ? `\n  · your email for replies: ${contact}` : ''}`);
  log(`  · your author key's public half (${key ? shortFingerprint(key.fingerprint) : 'made now, kept in the vault'})`);
  log(`  · this Sara's install id (for the limits and My submissions), Sara ${c.saraVersion}, ${c.os}`);
  const answer = args.includes('--yes') ? 'y' : await (c.ask ?? (async (q: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  }))('Send? (y/N) ');
  if (!/^y(es)?$/i.test(answer.trim())) {
    log('Nothing was sent.');
    return 1;
  }
  try {
    const out = await submit({ base: c.hubBase, installId: c.installId, vault: c.vault, db: c.db, pack: r.pack, name, ...(contact ? { contact } : {}), saraVersion: c.saraVersion, os: c.os, progress: (d, n) => log(`  sent ${d} of ${n}`) });
    log(`Sent. Submission ${out.submission}. You'll see our reply in Get more → My submissions.`);
    return 0;
  } catch (err) {
    const e = err as { status?: number; message: string };
    log(deskDown(e.status ?? 0) ? "Our desk isn't answering right now. Try again later: the package is kept next to your folder." : e.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { SARA_VERSION } = await import('../plugins/manager.ts');
  if (cmd !== 'pack') {
    console.log('Usage: node src/store/pack-cli.ts pack <folder> [--json] [--no-smoke]   (submitting: sara submit <folder>)');
    process.exit(2);
  }
  const r = await runPack(rest, { saraVersion: process.env.SARA_PACK_VERSION ?? SARA_VERSION });
  process.exit(r.code);
}
