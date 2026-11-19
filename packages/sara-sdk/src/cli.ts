#!/usr/bin/env node
// W3.1 (docs/ADDON_KIT.md): `sara-addon`, the add-on kit's command line.
//   npx @farena-ai/sara-sdk create my-addon     (once published; until then:)
//   node <sara>/packages/sara-sdk/src/cli.ts create my-addon
// Commands: create, update, build, test, dev, pack. Nothing here publishes or submits anything.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ID_RE } from './addon/kit.ts';
import { readFakes, QuickHost, runTests, type Backend } from './addon/harness.ts';
import { buildAddon, packAddon } from './addon/pack.ts';
import { runtimeFiles, templateFiles } from './addon/template.ts';

const SDK_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '';
  }
})();

export const HELP = `sara-addon: make, test and pack a Sara add-on (docs/ADDON_KIT.md)

  sara-addon create <name> [--dir <parent>] [--author "Your name"]
      A working add-on folder: a tool, a setting with its ? tip, a page (a card), tests.
  sara-addon build [folder] [--check]
      Writes sara-plugin.json from main.mjs (--check: only says whether it is current).
  sara-addon test [folder] [--sara <sara checkout>]
      Starts the add-on in its own permission-limited process and runs tests/*.test.mjs.
      --sara: a throwaway Sara from that checkout, in this process, with the add-on installed
      through Sara's real review/install/switch-on path.
  sara-addon dev [folder] --sara <sara checkout> [--port <n>]
      The same throwaway Sara in your browser (127.0.0.1) until Ctrl+C; type /try <tool> {json}.
  sara-addon pack [folder] [--sara <sara checkout>] [--out <folder>]
      Store checks, then out/<id>-<version>.sarapack.zip and out/<id>-<version>.listing.json.
      Sends nothing: submitting is your own step on your Sara (sara submit <folder>).
  sara-addon update [folder]
      Refreshes the kit's runtime files (sara-addon.mjs, sara-addon.d.mts, sara-plugin.mjs).
`;

const opt = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(['--dir', '--author', '--sara', '--port', '--out']);
const positional = (args: string[]): string[] => args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''));

/** The Sara checkout for --sara (or SARA_SOURCE), checked. */
function saraRoot(args: string[]): string | undefined {
  const s = opt(args, '--sara') ?? process.env.SARA_SOURCE;
  if (!s) return undefined;
  const root = resolve(s);
  if (!existsSync(join(root, 'src', 'addons', 'kit-host.ts'))) throw new Error(`${root} isn't a Sara source folder with the add-on kit host (src/addons/kit-host.ts, Sara 3.32 or later).`);
  return root;
}

async function bootSara(root: string, folder: string, o: { listen?: boolean; port?: number } = {}): Promise<Backend & { url?: string; token?: string }> {
  const mod = (await import(pathToFileURL(join(root, 'src', 'addons', 'kit-host.ts')).href)) as { bootAddonHost: (o: Record<string, unknown>) => Promise<Backend & { url?: string; token?: string }> };
  return mod.bootAddonHost({ folder, fakes: readFakes(folder), ...(o.listen ? { listen: true, port: o.port ?? 0 } : {}) });
}

export async function main(argv: string[], log: (s: string) => void = (s) => console.log(s)): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    log(SDK_VERSION);
    return 0;
  }
  const folder = () => resolve(positional(args)[0] ?? '.');
  try {
    if (cmd === 'create') {
      const id = positional(args)[0] ?? '';
      if (!ID_RE.test(id)) {
        log(`Give it a name of lower-case letters, digits and hyphens (up to 48), e.g. sara-addon create my-addon.`);
        return 2;
      }
      const dest = resolve(opt(args, '--dir') ?? '.', id);
      if (existsSync(dest)) {
        log(`${dest} already exists: nothing was changed. Pick another name or folder.`);
        return 2;
      }
      const author = opt(args, '--author');
      for (const [rel, text] of Object.entries(templateFiles({ id, ...(author ? { author } : {}), sdkVersion: SDK_VERSION }))) {
        const p = join(dest, ...rel.split('/'));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
      mkdirSync(join(dest, 'shots'), { recursive: true });
      const b = buildAddon(dest);
      log([`Made ${dest}`, ...b.lines, '', 'Next:', `  cd ${id}`, '  sara-addon test                  # your add-on in its own process, tests/ against it', '  sara-addon test --sara <sara>    # the same tests in a throwaway Sara with it installed', '  sara-addon pack                  # the store bundle and its listing (nothing is sent)'].join('\n'));
      return b.code;
    }
    if (cmd === 'update') {
      const dir = folder();
      for (const [rel, text] of Object.entries(runtimeFiles(SDK_VERSION))) writeFileSync(join(dir, rel), text);
      log(`Refreshed sara-addon.mjs, sara-addon.d.mts and sara-plugin.mjs (kit ${SDK_VERSION}).`);
      const b = buildAddon(dir);
      log(b.lines.join('\n'));
      return b.code;
    }
    if (cmd === 'build') {
      const b = buildAddon(folder(), { check: args.includes('--check') });
      log(b.lines.join('\n'));
      return b.code;
    }
    if (cmd === 'test') {
      const dir = folder();
      const b = buildAddon(dir);
      log(b.lines.join('\n'));
      if (b.code || !b.manifest) return 1;
      const root = saraRoot(args);
      const backend: Backend = root ? await bootSara(root, dir) : await new QuickHost(dir, b.manifest, readFakes(dir)).start();
      try {
        log(backend.label);
        for (const l of backend.info) log(`  ${l}`);
        return await runTests(dir, backend, { log: (s) => process.stdout.write(s) });
      } finally {
        await backend.stop();
      }
    }
    if (cmd === 'dev') {
      const dir = folder();
      const root = saraRoot(args);
      if (!root) {
        log('dev needs a Sara source folder: sara-addon dev --sara <folder of a Sara checkout>.');
        return 2;
      }
      const b = buildAddon(dir);
      log(b.lines.join('\n'));
      if (b.code) return 1;
      const port = opt(args, '--port') ? Number(opt(args, '--port')) : 0;
      const host = await bootSara(root, dir, { listen: true, port });
      log(`${host.label}\n  ${host.info.join('\n  ')}\n\nOpen ${host.url} and sign in with this throwaway's owner token:\n  ${host.token}\nIn a chat type: /try <tool> {"arg": "value"}. Settings → Skills & tools → Plugins shows it. Ctrl+C stops it and deletes its data.`);
      await new Promise<void>((r) => {
        process.once('SIGINT', () => r());
        process.once('SIGTERM', () => r());
      });
      await host.stop();
      log('Stopped; the throwaway data folder is gone.');
      return 0;
    }
    if (cmd === 'pack') {
      const root = saraRoot(args);
      const out = opt(args, '--out');
      const r = await packAddon(folder(), { sdkVersion: SDK_VERSION, ...(root ? { sara: root } : {}), ...(out ? { out } : {}) });
      log(r.lines.join('\n'));
      return r.code;
    }
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    return 1;
  }
  log(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
