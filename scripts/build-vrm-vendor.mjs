// A1 (docs/ops/A1_AVATAR_DESIGN.md → VRM route): builds web/vendor/three-vrm/sara-vrm.js, one pinned
// ES module with the parts of three.js and @pixiv/three-vrm the 3D picture uses (both MIT; their
// LICENSE files are copied next to it). Not part of the normal build: run it only to update the pins.
//
//   mkdir <scratch>/vrm-build && cd <scratch>/vrm-build
//   npm init -y && npm install three@0.187.0 @pixiv/three-vrm@3.5.5 esbuild@0.25
//   node <repo>/scripts/build-vrm-vendor.mjs <scratch>/vrm-build
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const out = resolve(import.meta.dirname, '..', 'web', 'vendor', 'three-vrm');
mkdirSync(out, { recursive: true });
const pkg = (name) => JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'));
const versions = { three: pkg('three').version, '@pixiv/three-vrm': pkg('@pixiv/three-vrm').version };
const entry = join(dir, 'sara-vrm-entry.js');
writeFileSync(
  entry,
  [
    "export { WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, HemisphereLight, Object3D, Vector3, Box3, SRGBColorSpace, NoToneMapping } from 'three';",
    "export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
    "export { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';",
    '',
  ].join('\n'),
);
const banner = `/* Sara A1 vendor bundle: three.js ${versions.three} and @pixiv/three-vrm ${versions['@pixiv/three-vrm']} (both MIT, see LICENSE-three.txt and LICENSE-three-vrm.txt). Built by scripts/build-vrm-vendor.mjs; do not edit. */`;
execFileSync(process.execPath, [join(dir, 'node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', '--minify', '--legal-comments=none', '--target=es2020', `--banner:js=${banner}`, `--outfile=${join(out, 'sara-vrm.js')}`], { stdio: 'inherit', cwd: dir });
copyFileSync(join(dir, 'node_modules', 'three', 'LICENSE'), join(out, 'LICENSE-three.txt'));
copyFileSync(join(dir, 'node_modules', '@pixiv', 'three-vrm', 'LICENSE'), join(out, 'LICENSE-three-vrm.txt'));
writeFileSync(join(out, 'VERSIONS.json'), `${JSON.stringify(versions, null, 2)}\n`);
console.log('built', join(out, 'sara-vrm.js'), versions);
