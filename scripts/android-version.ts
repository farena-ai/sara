// R2 (docs/ops/ANDROID_RELEASE.md): the Android app's version follows Sara's. `versionName` is
// package.json's version, `versionCode` is major × 10000 + minor × 100 + patch (3.10.0 → 31000).
// The release bump runs this after it changes package.json, so the gradle file is never edited by
// hand; test/c18-android-release.test.ts fails when the two drift.
//
//   node scripts/android-version.ts           write android/app/build.gradle from package.json
//   node scripts/android-version.ts --check   exit 1 (and say why) when they differ; writes nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const GRADLE = join(ROOT, 'android', 'app', 'build.gradle');

export function versionCode(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Not a release version: ${version}`);
  const [a, b, c] = m.slice(1).map(Number) as [number, number, number];
  if (b > 99 || c > 99) throw new Error(`Minor and patch must be under 100 for the versionCode: ${version}`);
  return a * 10000 + b * 100 + c;
}

/** The gradle text with Sara's version in it (everything else byte for byte the same). */
export function withVersion(gradle: string, version: string): string {
  const code = versionCode(version);
  if (!/versionCode \d+/.test(gradle) || !/versionName '[^']*'/.test(gradle)) throw new Error('build.gradle has no versionCode / versionName line.');
  return gradle.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName '[^']*'/, `versionName '${version}'`);
}

if (import.meta.main) {
  const version = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  const gradle = readFileSync(GRADLE, 'utf8');
  const next = withVersion(gradle, version);
  if (process.argv.includes('--check')) {
    if (next !== gradle) {
      console.error(`android/app/build.gradle is not at ${version} (versionCode ${versionCode(version)}). Run: node scripts/android-version.ts`);
      process.exit(1);
    }
    console.log(`Android build is at ${version} (versionCode ${versionCode(version)}).`);
  } else if (next === gradle) console.log(`Android build already at ${version}.`);
  else {
    writeFileSync(GRADLE, next);
    console.log(`Android build set to ${version} (versionCode ${versionCode(version)}).`);
  }
}
