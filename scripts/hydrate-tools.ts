// The developer add-on tools (tools/*) keep their own npm packages. A few tests import those packages
// directly, so a fresh clone or worktree without them fails typecheck with "Cannot find module
// '../tools/<tool>/node_modules/…'". This finds which ones are missing and installs them.
//   node scripts/hydrate-tools.ts           npm ci in each tool whose packages a test needs and is missing
//   node scripts/hydrate-tools.ts --all     npm ci in every tool with a package-lock.json
//   node scripts/hydrate-tools.ts --check   only say what is missing (exit 1), install nothing (npm run typecheck)
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT = /from\s+['"]\.\.\/tools\/([\w.-]+)\/node_modules\/([^'"]+)['"]|(?:import|require)\(\s*['"]\.\.\/tools\/([\w.-]+)\/node_modules\/([^'"]+)['"]\s*\)/g;
/** Any file of a tool a test loads (its own modules import the tool's packages in turn). */
const TOOL_FILE = /['"]\.\.\/tools\/([\w.-]+)\/(?!node_modules\/)[^'"]+['"]/g;

/** Each tool a test imports packages from, with the imported files that are not there. */
export function missingToolPackages(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = join(root, 'test');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts')).sort()) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(IMPORT)) {
      const tool = m[1] ?? m[3];
      const file = m[2] ?? m[4];
      if (existsSync(join(root, 'tools', tool, 'node_modules', file))) continue;
      const list = out.get(tool) ?? [];
      if (!list.includes(file)) list.push(file);
      out.set(tool, list);
    }
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(TOOL_FILE)) {
      const tool = m[1];
      const lock = join(root, 'tools', tool, 'package-lock.json');
      if (out.has(tool) || !existsSync(lock) || existsSync(join(root, 'tools', tool, 'node_modules'))) continue;
      const pkgs = Object.keys((JSON.parse(readFileSync(lock, 'utf8')) as { packages?: Record<string, unknown> }).packages ?? {}).filter((k) => k.startsWith('node_modules/'));
      if (pkgs.length) out.set(tool, ['node_modules/']);
    }
  }
  return out;
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  const missing = missingToolPackages(root);
  if (args.includes('--check')) {
    if (!missing.size) return;
    console.error(`Some tests import packages of the developer tools that aren't installed here:`);
    for (const [tool, files] of missing) console.error(`  tools/${tool}: ${files.join(', ')}`);
    console.error('Install them with: npm run hydrate:tools   (npm ci in each of those tools)');
    process.exit(1);
  }
  const tools = args.includes('--all') ? readdirSync(join(root, 'tools')).filter((t) => existsSync(join(root, 'tools', t, 'package-lock.json'))).sort() : [...missing.keys()];
  if (!tools.length) return console.log('The developer tools have the packages the tests need.');
  for (const tool of tools) {
    const cwd = join(root, 'tools', tool);
    if (!existsSync(join(cwd, 'package-lock.json'))) throw new Error(`tools/${tool} has no package-lock.json`);
    console.log(`npm ci in tools/${tool}`);
    execSync('npm ci --no-audit --no-fund', { cwd, stdio: 'inherit' });
  }
  const left = missingToolPackages(root);
  if (left.size) throw new Error(`Still missing after npm ci: ${[...left.keys()].map((t) => `tools/${t}`).join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
