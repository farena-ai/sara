// R2: the Android version follows Sara's through scripts/android-version.ts (docs/ops/ANDROID_RELEASE.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GRADLE, versionCode, withVersion } from '../scripts/android-version.ts';
import { ROOT } from './helpers.ts';

test('R2 android: versionCode from the version; the gradle file is changed only on its two lines', () => {
  assert.equal(versionCode('3.10.0'), 31000);
  assert.equal(versionCode('3.1.0'), 30100);
  assert.equal(versionCode('4.0.12'), 40012);
  assert.throws(() => versionCode('3.100.0'));
  assert.throws(() => versionCode('3.10'));
  const gradle = readFileSync(GRADLE, 'utf8');
  const next = withVersion(gradle, '9.98.7');
  assert.match(next, /versionCode 99807\b/);
  assert.match(next, /versionName '9\.98\.7'/);
  const diff = next.split('\n').filter((l, i) => l !== gradle.split('\n')[i]);
  assert.equal(diff.length, 2);
  // The checked-in file is at package.json's version (nothing to write today).
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(withVersion(gradle, version), gradle);
  // Release signing comes from the gitignored keystore properties, never from the repository.
  assert.match(gradle, /\.\.\/\.secrets\/sara-android-upload\.properties/);
  assert.doesNotMatch(gradle, /storePassword ['"]/);
});
