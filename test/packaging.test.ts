// Phase 57: installs where self-hosters look. The Docker image, the GitHub Release scripts, the
// Homebrew cask, the winget manifests and the self-hosting app templates (Unraid, CasaOS, Umbrel,
// TrueNAS, Proxmox) must agree on image, port and version; update-packaging must fill checksums
// correctly; and no release script may publish anything unless asked to (--push).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FILES, fillPackaging, fillTemplates, IMAGE, parseSums, parseYaml, PORT, type Role, WINGET_ID } from '../scripts/update-packaging.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
type Obj = Record<string, any>;
const yaml = (p: string) => parseYaml(read(p)) as Obj;
const texts = () => Object.fromEntries(Object.entries(FILES).map(([r, p]) => [r, read(p)])) as Record<Role, string>;

/** Image reference → [name, tag]. */
const splitImage = (ref: string): [string, string] => {
  const noDigest = ref.split('@')[0];
  const i = noDigest.lastIndexOf(':');
  return [noDigest.slice(0, i), noDigest.slice(i + 1)];
};

/** Minimal XML well-formedness check: every tag closes in order. Returns the element texts. */
function xmlTags(xml: string): Map<string, string[]> {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack: string[] = [];
  const texts = new Map<string, string[]>();
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const between = body.slice(last, m.index);
    assert.ok(!/[<>]/.test(between), `stray markup before <${m[1]}${m[2]}>: ${between.slice(0, 60)}`);
    if (m[1]) {
      assert.equal(stack.pop(), m[2], `</${m[2]}> closes the wrong element`);
      texts.set(m[2], [...(texts.get(m[2]) ?? []), between]);
    } else if (!m[4]) stack.push(m[2]);
    last = re.lastIndex;
  }
  assert.equal(stack.length, 0, `unclosed: ${stack.join(', ')}`);
  return texts;
}

test('Dockerfile: pinned Node as deploy/install.sh, OCI labels, health check, data volume, port', () => {
  const df = read('Dockerfile');
  const pinned = /^NODE_VERSION=v([\d.]+)$/m.exec(read('deploy/install.sh'))?.[1];
  assert.ok(pinned, 'deploy/install.sh pins NODE_VERSION');
  assert.equal(/^ARG NODE_VERSION=([\d.]+)$/m.exec(df)?.[1], pinned, 'the image uses the same Node.js as the native installer');
  // Phase 59: pinned by the tag's multi-arch index digest (one digest for amd64 and arm64).
  assert.match(df, /^ARG NODE_DIGEST=sha256:[0-9a-f]{64}$/m);
  assert.match(df, /^FROM node:\$\{NODE_VERSION\}-slim@\$\{NODE_DIGEST\}$/m);
  const code = df.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(amd64|x86_64|arm64|aarch64|x64)\b/, 'no Dockerfile instruction is tied to one architecture');
  assert.match(df, /org\.opencontainers\.image\.source="https:\/\/github\.com\/farena-ai\/sara"/);
  assert.match(df, /org\.opencontainers\.image\.licenses="MIT"/);
  assert.match(df, /org\.opencontainers\.image\.version="\$\{SARA_VERSION\}"/);
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/health/);
  assert.match(df, /^VOLUME \["\/data"\]$/m);
  assert.match(df, new RegExp(`^EXPOSE ${PORT}$`, 'm'));
  assert.match(df, new RegExp(`SARA_PORT=${PORT}`));
  assert.match(df, /SARA_TOOLS_USER=sara-tools/, 'commands still run as the separate tools user');
  // The build context must not carry private or bulky folders.
  const ignore = read('.dockerignore').split(/\r?\n/);
  for (const p of ['data', '.git', 'outputs', '.secrets', 'node_modules', '.env']) assert.ok(ignore.includes(p), `.dockerignore has ${p}`);
});

test('runtime recipes preserve builtin plugins and never copy broad store authoring trees', () => {
  for (const path of ['deploy/install.sh', 'desktop/windows/build-installer.sh', 'desktop/mac/build.sh']) {
    const recipe = read(path);
    if (path === 'deploy/install.sh') assert.match(recipe, /^for item in [^\n]*\bplugins\b[^\n]*; do$/m, 'Linux installs and updates include existing builtins');
    else assert.match(recipe, /"\$ROOT\/plugins"/, `${path}: existing builtin directory remains packaged`);
    const storeSources = [...recipe.matchAll(/"\$(?:ROOT|SRC_DIR)\/store[^"\r\n]*"/g)].map(match => match[0]);
    assert.equal(storeSources.length, 1, `${path}: one bounded candidate copy source`);
    assert.match(storeSources[0], /^"\$(?:ROOT|SRC_DIR)\/store\/plugins\/\$id"$/, `${path}: no raw catalog, website or whole-store source`);
  }
  const storeCopies = read('Dockerfile').split(/\r?\n/).filter(line => /^COPY\s+store(?:\/|\s)/.test(line));
  assert.equal(storeCopies.length, 39, 'image copies exactly thirty-nine package roots (12 A1 + 27 A2 candidates)');
  for (const line of storeCopies) assert.match(line, /^COPY store\/plugins\/([a-z-]+) \.\/store\/plugins\/\1$/, 'explicit package-directory copy only');
});

test('the templates agree on image, port and version', () => {
  const cask = read(FILES.cask);
  const caskVersion = /^\s*version "([^"]+)"/m.exec(cask)?.[1];
  assert.ok(caskVersion);
  const versions: Record<string, string> = { cask: caskVersion };

  const wv = yaml(FILES.wingetVersion);
  const wi = yaml(FILES.wingetInstaller);
  const wl = yaml(FILES.wingetLocale);
  for (const [name, m] of Object.entries({ wv, wi, wl })) {
    assert.equal(m.PackageIdentifier, WINGET_ID, name);
    const [maj, min] = String(m.ManifestVersion).split('.').map(Number);
    assert.ok(maj > 1 || (maj === 1 && min >= 6), `${name}: manifest schema 1.6 or newer`);
    versions[`winget ${name}`] = String(m.PackageVersion);
  }
  assert.equal(wv.ManifestType, 'version');
  assert.equal(wv.DefaultLocale, 'en-US');
  assert.equal(wi.ManifestType, 'installer');
  assert.equal(wl.ManifestType, 'defaultLocale');
  assert.equal(wl.License, 'MIT');
  assert.equal(wi.InstallerType, 'inno');
  assert.equal(wi.Installers.length, 1);
  assert.equal(wi.Installers[0].InstallerUrl, `https://github.com/farena-ai/sara/releases/download/v${wv.PackageVersion}/Sara-Setup-${wv.PackageVersion}.exe`);
  assert.match(read(FILES.wingetInstaller), /^\s*InstallerSha256: [0-9A-Fa-f]{64}$/m);
  for (const sw of ['/VERYSILENT', '/CURRENTUSER', '/MODE=user']) assert.ok(wi.InstallerSwitches.Silent.split(' ').includes(sw), `silent switch ${sw}`);
  // The silent install matches the Inno Setup script (per-user mode needs /CURRENTUSER).
  const iss = read('desktop/windows/installer/sara.iss');
  assert.ok(iss.includes(String(wi.ProductCode).replace('_is1', '').replace('{', '{{')), 'ProductCode is the installer AppId');

  const images: Record<string, string> = {};
  const ca = yaml(FILES.casaos);
  images.casaos = ca.services[ca['x-casaos'].main].image;
  assert.equal(ca['x-casaos'].port_map, String(PORT));
  assert.equal(typeof ca['x-casaos'].port_map, 'string', 'CasaOS wants port_map quoted');
  assert.equal(ca.services.sara.ports[0].target, PORT);
  assert.ok(ca.services.sara.volumes.some((v: Obj) => v.target === '/data'));
  assert.match(ca['x-casaos'].id, /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
  assert.ok(['Media', 'Productivity', 'Home', 'Networking', 'AI', 'Finance', 'Social', 'Developer', 'Others'].includes(ca['x-casaos'].category));
  assert.equal(ca['x-casaos'].title.en_US, 'Sara');
  versions.casaos = ca['x-casaos'].version;

  const ua = yaml(FILES.umbrelApp);
  const uc = yaml(FILES.umbrelCompose);
  assert.equal(ua.id, 'sara');
  assert.equal(ua.port, PORT);
  assert.equal(uc.services.app_proxy.environment.APP_HOST, `${ua.id}_server_1`, 'APP_HOST is <app id>_<service>_1');
  assert.equal(uc.services.app_proxy.environment.APP_PORT, PORT);
  assert.ok(uc.services.server.volumes.includes('${APP_DATA_DIR}/data:/data'));
  images.umbrel = uc.services.server.image;
  versions.umbrel = ua.version;

  const tn = yaml(FILES.truenas);
  images.truenas = tn.services.sara.image;
  assert.deepEqual(tn.services.sara.ports, [`${PORT}:${PORT}`]);
  assert.ok(tn.services.sara.volumes.some((v: string) => v.endsWith(':/data')));

  for (const [name, ref] of Object.entries(images)) {
    const [img, tag] = splitImage(ref);
    assert.equal(img, IMAGE, `${name} image`);
    versions[`${name} image tag`] = tag;
  }
  // Same hardening as the main docker-compose.yml wherever the platform allows it.
  const main = yaml('docker-compose.yml').services.sara;
  for (const s of [ca.services.sara, uc.services.server, tn.services.sara]) {
    assert.deepEqual(s.cap_drop, main.cap_drop);
    assert.deepEqual(s.cap_add, main.cap_add);
    assert.deepEqual(s.security_opt, main.security_opt);
  }

  const unraid = read('packaging/unraid/sara.xml');
  const tags = xmlTags(unraid);
  const one = (t: string) => tags.get(t)?.[0];
  assert.equal(splitImage(one('Repository')!)[0], IMAGE, 'unraid image');
  assert.equal(one('Name'), 'Sara');
  assert.match(one('WebUI')!, new RegExp(`\\[PORT:${PORT}\\]`));
  assert.match(one('Icon')!, /^https:\/\/raw\.githubusercontent\.com\/farena-ai\/sara\/main\/web\/icon-512\.png$/);
  assert.ok(one('Overview')!.length > 50 && one('Support') && one('Project') && one('TemplateURL'));
  assert.match(unraid, new RegExp(`<Config [^>]*Target="${PORT}"[^>]*Type="Port"`));
  assert.match(unraid, /<Config [^>]*Target="\/data"[^>]*Type="Path"/);
  for (const cap of main.cap_add) assert.ok(one('ExtraParams')!.includes(`--cap-add=${cap}`), `unraid keeps ${cap}`);

  const proxmox = read('packaging/proxmox/sara.sh');
  assert.match(proxmox, new RegExp(`var_port="\\$\\{var_port:-${PORT}\\}"`));
  assert.match(proxmox, /var_version="12"/, 'Debian 12 container');
  assert.match(proxmox, /get-sara\.sh --yes /, 'installs without questions');
  versions.proxmox = /^SARA_VERSION="([^"]+)"$/m.exec(proxmox)?.[1] ?? 'missing';

  assert.equal(new Set(Object.values(versions)).size, 1, `one version everywhere: ${JSON.stringify(versions)}`);
});

test('update-packaging fills versions and checksums from SHA256SUMS', () => {
  const dmg = 'a'.repeat(63) + '1';
  const exe = 'B'.repeat(63) + '2';
  const sums = parseSums(`${dmg}  Sara-1.0.0.dmg\r\n${exe} *Sara-Setup-1.0.0.exe\n${'c'.repeat(64)}  sara-1.0.0.tar.gz\nnot a line\n`);
  assert.equal(sums.size, 3);
  assert.equal(sums.get('Sara-Setup-1.0.0.exe'), exe.toLowerCase());
  const digest = `sha256:${'d'.repeat(64)}`;
  const out = fillPackaging(texts(), { version: '1.0.0', sums, date: '2027-01-15', imageDigest: digest });
  assert.match(out.cask, /^\s*version "1\.0\.0"$/m);
  assert.match(out.cask, new RegExp(`^\\s*sha256 "${dmg}"$`, 'm'));
  const wi = parseYaml(out.wingetInstaller) as Obj;
  assert.equal(wi.PackageVersion, '1.0.0');
  assert.equal(wi.Installers[0].InstallerSha256, exe.toUpperCase());
  assert.equal(wi.Installers[0].InstallerUrl, 'https://github.com/farena-ai/sara/releases/download/v1.0.0/Sara-Setup-1.0.0.exe');
  assert.equal(wi.ReleaseDate, '2027-01-15');
  assert.equal((parseYaml(out.wingetVersion) as Obj).PackageVersion, '1.0.0');
  assert.equal((parseYaml(out.wingetLocale) as Obj).ReleaseNotesUrl, 'https://github.com/farena-ai/sara/releases/tag/v1.0.0');
  const ca = parseYaml(out.casaos) as Obj;
  assert.equal(ca.services.sara.image, `${IMAGE}:1.0.0`);
  assert.equal(ca['x-casaos'].version, '1.0.0');
  assert.equal(ca['x-casaos'].update_at, '2027-01-15');
  assert.equal((parseYaml(out.umbrelApp) as Obj).version, '1.0.0');
  assert.equal((parseYaml(out.umbrelCompose) as Obj).services.server.image, `${IMAGE}:1.0.0@${digest}`);
  assert.equal((parseYaml(out.truenas) as Obj).services.sara.image, `${IMAGE}:1.0.0`);
  // Filling again with a new version drops the old image digest (it belonged to the old image).
  const again = fillPackaging(out, { version: '1.0.1', sums: parseSums(`${dmg}  Sara-1.0.1.dmg\n${exe}  Sara-Setup-1.0.1.exe`), date: '2027-02-01' });
  assert.equal((parseYaml(again.umbrelCompose) as Obj).services.server.image, `${IMAGE}:1.0.1`);
  // Never a placeholder: a missing installer checksum, a bad version or digest is an error.
  assert.throws(() => fillPackaging(texts(), { version: '1.0.0', sums: parseSums(`${dmg}  Sara-1.0.0.dmg`), date: '2027-01-15' }), /Sara-Setup-1\.0\.0\.exe/);
  assert.throws(() => fillPackaging(texts(), { version: 'v1', sums, date: '2027-01-15' }), /Not a version/);
  assert.throws(() => fillPackaging(texts(), { version: '1.0.0', sums, date: '2027-01-15', imageDigest: 'latest' }), /digest/);
  // Proxmox: the release tag, and get-sara.sh's checksum when SHA256SUMS has it (else emptied).
  assert.match(out.proxmox, /^SARA_VERSION="1\.0\.0"$/m);
  assert.match(out.proxmox, /^GET_SARA_SHA256=""$/m);
  const withGet = fillTemplates(texts(), { version: '1.0.2', date: '2027-03-01', sums: parseSums(`${'e'.repeat(64)}  get-sara.sh`) });
  assert.match(withGet.proxmox, new RegExp(`^GET_SARA_SHA256="${'e'.repeat(64)}"$`, 'm'));
  assert.equal(fillTemplates(withGet, { version: '1.0.3', date: '2027-03-02' }).proxmox.match(/^GET_SARA_SHA256="([^"]*)"$/m)?.[1], '', 'an old checksum never checks a new release');
});

test('Phase 59: browser setup without a code only behind Umbrel\'s login; other templates use the setup code', () => {
  const uc = yaml(FILES.umbrelCompose);
  const proxy = uc.services.app_proxy.environment;
  assert.equal(uc.services.server.environment.SARA_SETUP, 'browser');
  assert.notEqual(String(proxy.PROXY_AUTH_ADD ?? 'true'), 'false', "Umbrel's login stays on");
  assert.ok(String(proxy.PROXY_AUTH_BLACKLIST).split(',').includes('/api/claim'), '/api/claim always needs the Umbrel login');
  assert.ok(!String(proxy.PROXY_AUTH_WHITELIST).split(',').some((p) => p === '*' || p === '/*' || p === '/'), 'the web app is not whitelisted');
  const ua = yaml(FILES.umbrelApp);
  assert.deepEqual(ua.gallery, [], 'new Umbrel submissions leave gallery empty (Umbrel hosts the images)');
  assert.equal(ua.releaseNotes, '');
  for (const f of [FILES.casaos, FILES.truenas, 'packaging/unraid/sara.xml', 'docker-compose.yml']) assert.doesNotMatch(read(f), /SARA_SETUP\W+browser/, `${f} has no login proxy: setup code only`);
});

test('hardening L7: Umbrel uses the proxy-secret mode; the Proxmox script checks get-sara.sh, quotes its settings and never prints the token', () => {
  const uc = yaml(FILES.umbrelCompose);
  const env = uc.services.server.environment;
  assert.equal(env.SARA_TRUST_PROXY, '1');
  assert.equal(env.SARA_PROXY_SECRET, '${APP_SEED}', 'a per-install secret: X-Forwarded-For is never believed without it');
  const px = read(FILES.proxmox);
  assert.match(px, /^var_ref="\$\{var_ref:-v\$\{SARA_VERSION\}\}"$/m, 'the release tag by default, not main');
  assert.match(px, /sha256sum -c --status/);
  assert.match(px, /pct push "\$CTID" "\$GET_TMP" \/root\/get-sara\.sh/);
  assert.ok(!/curl -fsSL '\$GET_SARA'/.test(px), 'no download inside the container without the check');
  assert.match(px, /printf -v INSTALL_CMD 'SARA_REF=%q bash \/root\/get-sara\.sh --yes --access %q --port %q'/);
  assert.ok(!/bash -c "[^"]*'\$var_/.test(px), 'no var_* pasted into a shell string');
  assert.ok(!/\$\{?TOKEN\}?/.test(px.replace(/first-token\.txt/g, '')), 'the owner token is not read into the script or printed');
  assert.match(read('scripts/release-assets.sh'), /take "\$ROOT\/deploy\/get-sara\.sh" "get-sara\.sh"/, 'get-sara.sh is in SHA256SUMS');
});

test('the YAML reader handles what the manifests use and rejects what it does not', () => {
  assert.deepEqual(parseYaml('a: 1\nb: "x: y" # note\nc: [A, "b c"]\nd: { e: "1", f: g }\nl:\n  - k: v\n    m: 2\n  - plain\nt: >-\n  one\n  two\n\n  three\n'), {
    a: 1,
    b: 'x: y',
    c: ['A', 'b c'],
    d: { e: '1', f: 'g' },
    l: [{ k: 'v', m: 2 }, 'plain'],
    t: 'one two\nthree',
  });
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate/);
  assert.throws(() => parseYaml('a: 1\n   b: 2\n'), /indentation/);
  assert.throws(() => parseYaml('a: [1, 2\n'), /Unclosed/);
  assert.throws(() => parseYaml('a: &x 1\n'), /Unsupported/);
});

test('release scripts publish nothing unless asked (--push), and never create the release themselves', () => {
  const docker = read('scripts/release-docker.sh');
  assert.match(docker, /^PUSH=0 /m, 'push is off by default');
  assert.match(docker, /--push\) PUSH=1/);
  // The only `--push` given to docker is inside the `if [[ $PUSH == 1 ]]` branch; the default
  // branch loads the image locally.
  const lines = docker.split(/\r?\n/);
  const start = lines.findIndex((l) => /^if \[\[ \$PUSH == 1 \]\]; then$/.test(l));
  const elseAt = lines.findIndex((l, i) => i > start && /^else$/.test(l));
  const end = lines.findIndex((l, i) => i > elseAt && /^fi$/.test(l));
  assert.ok(start > 0 && elseAt > start && end > elseAt);
  lines.forEach((l, i) => {
    if (/^\s*#/.test(l) || /^\s*echo /.test(l)) return;
    if (/\brun docker\b[^\n]*--push\b|docker push\b|podman (manifest )?push\b/.test(l)) assert.ok(i > start && i < elseAt, `line ${i + 1} pushes outside --push: ${l}`);
  });
  assert.match(lines.slice(elseAt, end).join('\n'), /--load "\$ROOT"/);
  assert.match(docker, /linux\/amd64,linux\/arm64/);
  // Phase 59: Podman builds both platforms into one manifest list and pushes all of it; it keeps
  // the HEALTHCHECK only in the docker image format.
  assert.match(lines.slice(start, elseAt).join('\n'), /podman manifest push --all/);
  for (const l of lines.filter((x) => /run podman build /.test(x))) assert.match(l, /--format docker/, l);
  assert.match(docker, /ghcr\.io\/farena-ai\/sara/);
  assert.match(docker, /gh auth token \| docker login ghcr\.io/, 'documents the registry sign-in');

  const assets = read('scripts/release-assets.sh');
  for (const l of assets.split(/\r?\n/)) {
    if (/^\s*#/.test(l) || /^\s*echo /.test(l)) continue;
    assert.doesNotMatch(l, /\bgh\s+release\b|\bgit\s+push\b|\bgit\s+tag\b|\bdocker\s+push\b|\bcurl\b[^\n]*-X\s*POST/, `release-assets.sh must only print, not run: ${l}`);
  }
  assert.match(assets, /echo "\s*gh release create v\$VERSION/);
  for (const f of ['Sara-Setup-$VERSION.exe', 'Sara-$VERSION.dmg', 'sara-$VERSION.tar.gz', 'SHA256SUMS', 'notes.md']) assert.ok(assets.includes(f), `collects ${f}`);
});

test('packaging docs exist and the install guide lists the other ways to install', () => {
  const guide = read('docs/PACKAGING.md');
  const order = ['public-export.ts', 'build-installer.sh', 'release-assets.sh', 'gh release create', 'release-docker.sh --push', 'update-packaging.ts'];
  let at = -1;
  for (const step of order) {
    const i = guide.indexOf(step, at + 1);
    assert.ok(i > at, `docs/PACKAGING.md has "${step}" in order`);
    at = i;
  }
  for (const d of ['homebrew', 'winget', 'unraid', 'casaos', 'umbrel', 'truenas', 'proxmox']) assert.ok(read(`packaging/${d}/README.md`).length > 200, `packaging/${d}/README.md`);
  const install = read('docs/INSTALL.md');
  const i = install.indexOf('## Other ways to install');
  assert.ok(i > 0, 'docs/INSTALL.md has "Other ways to install"');
  const section = install.slice(i);
  for (const w of ['Docker image', 'Homebrew', 'winget', 'Unraid', 'CasaOS', 'Umbrel', 'TrueNAS', 'Proxmox']) assert.ok(section.includes(w), `lists ${w}`);
  assert.match(section, /Available now/);
  assert.match(section, /Waiting for review/);
});
