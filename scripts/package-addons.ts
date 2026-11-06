// Builds reviewed local distribution artifacts; never signs, uploads, enables or calls providers.
import { lstatSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPath } from '../src/store/pack.ts';
import { smokeFence } from '../src/store/pack-cli.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW_IDS = ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'inbox-triage', 'weekly-review', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard'] as const;

export function artifactName(id: string, version: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new Error('Invalid artifact filename identifier.');
  if (typeof version !== 'string' || version !== version.trim() || version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error('Artifact version must be an exact bounded filename-safe version; no normalization.');
  const name = `${id}-${version}.sarapack.zip`;
  if (name.length > 160 || /[\r\n\\/]/.test(name)) throw new Error('Unsafe artifact filename.');
  return name;
}

export function assertBundleOutput(output: string, root = ROOT): string {
  const base = resolve(root, 'outputs');
  const target = resolve(root, output);
  const rel = relative(base, target);
  if (!rel) throw new Error('Use a dedicated directory below outputs, not outputs itself.');
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Bundle output must be below this checkout\'s outputs directory.');
  let cursor = target;
  while (cursor !== resolve(root)) {
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) throw new Error('Bundle output must not traverse a symbolic link.');
      if (!entry.isDirectory()) throw new Error('Bundle output ancestors must be directories.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existsSync(target) && readdirSync(target).length) throw new Error('Bundle output must be a new or empty dedicated directory.');
  return target;
}

interface PluginArtifact {
  id: string;
  version: string;
  file: string;
  sha256: string;
  bytes: number;
  ready: boolean;
  smoke: string;
  fence: string;
}

/** The existing Sara packer performs manifest, scan and real process smoke checks. */
export async function buildAddonBundle(o: { output: string; root?: string; pluginIds?: readonly string[]; recipeIds?: readonly string[]; targetSara?: string }) {
  const root = o.root ?? ROOT;
  const output = assertBundleOutput(o.output, root);
  const ids = o.pluginIds ?? WORKFLOW_IDS;
  if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-z][a-z0-9-]{0,47}$/.test(id))) throw new Error('Plugin identifiers must be one to thirty-two unique reviewed IDs.');
  if (o.recipeIds?.length) throw new Error('MCP recipes are qualified separately; this bundle distributes native workflow packages only.');
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
  const targetSara = o.targetSara ?? version;
  artifactName('sara', version);
  artifactName('target-sara', targetSara);
  // Validate every filename before any smoke process or output staging is started.
  const sources = ids.map((id) => {
    const source = resolve(root, 'store', 'plugins', id);
    const manifest = JSON.parse(readFileSync(resolve(source, 'sara-plugin.json'), 'utf8'));
    if (manifest.id !== id) throw new Error(`Manifest identifier mismatch: ${id}.`);
    return { id, source, manifest, file: artifactName(id, manifest.version) };
  });
  const pending: { artifact: PluginArtifact; zip: Buffer; report: unknown }[] = [];
  let total = 0;
  for (const { id, source, manifest, file } of sources) {
    const pack = await packPath(source, { saraVersion: targetSara, smoke: smokeFence() });
    if (!pack.report.ready || pack.report.smoke !== 'ran') throw new Error(`${id} is not ready: ${JSON.stringify(pack.report.results.filter((r) => !r.ok))}`);
    total += pack.size;
    if (total > 50 * 1024 * 1024) throw new Error('Aggregate bundle exceeds fifty MiB.');
    pending.push({ artifact: { id, version: manifest.version, file, sha256: pack.sha256, bytes: pack.size, ready: true, smoke: pack.report.smoke, fence: pack.report.fence ?? 'unknown' }, zip: pack.zip, report: pack.report });
  }
  const result = { format: 'sara-addons-local-bundle', version: 1, sara: version, targetSara, published: false, generated: new Date().toISOString(), plugins: pending.map((p) => p.artifact), limitations: ['Local package and process checks do not prove live account or model-provider behavior.', 'sara identifies the checkout version; targetSara is a compatibility assessment, not proof a target-version host was executed.', 'Windows Node permission limits are not an OS sandbox.', 'Installation, enablement and model/provider costs remain owner-controlled.'] };
  assertBundleOutput(output, root);
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(resolve(dirname(output), '.addons-stage-'));
  const wasEmptyDirectory = existsSync(output);
  try {
    const checksums: string[] = [];
    for (const item of pending) {
      writeFileSync(resolve(staging, item.artifact.file), item.zip);
      writeFileSync(resolve(staging, `${item.artifact.id}.checks.json`), `${JSON.stringify(item.report, null, 2)}\n`);
      const actual = createHash('sha256').update(readFileSync(resolve(staging, item.artifact.file))).digest('hex');
      if (actual !== item.artifact.sha256) throw new Error(`Written package hash mismatch: ${item.artifact.id}.`);
      checksums.push(`${actual}  ${item.artifact.file}`);
    }
    writeFileSync(resolve(staging, 'bundle.json'), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(resolve(staging, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
    assertBundleOutput(output, root);
    if (wasEmptyDirectory) rmdirSync(output);
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (wasEmptyDirectory && !existsSync(output)) mkdirSync(output);
    throw error;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/package-addons.ts --out outputs/addons/bundle-unique');
  const result = await buildAddonBundle({ output: args[1] });
  console.log(JSON.stringify({ plugins: result.plugins.length, published: result.published, output: resolve(ROOT, args[1]) }, null, 2));
}
