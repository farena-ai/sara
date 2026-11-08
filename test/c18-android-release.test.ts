// C18: the Android build for Google Play. Static checks (no Android SDK needed): the version follows
// Sara's, the phone-helper location works through the app's own bridge (http servers at home), and
// the build asks for no permission the Data safety answers in docs/ops/C18_PLAY_RELEASE.md don't cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const gradle = read('android', 'app', 'build.gradle');
const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
const main = read('android', 'app', 'src', 'main', 'java', 'com', 'backstagecoding', 'sara', 'MainActivity.java');
const web = read('web', 'phone-helper.js');

test('C18: versionName is Sara\'s version and versionCode is major*10000 + minor*100 + patch', () => {
  const version = JSON.parse(read('package.json')).version as string;
  const name = /versionName '([^']+)'/.exec(gradle)?.[1];
  const code = Number(/versionCode (\d+)/.exec(gradle)?.[1]);
  assert.equal(name, version);
  const [a, b, c] = version.split('.').map(Number);
  assert.equal(code, a! * 10000 + b! * 100 + c!);
});

test('C18: the phone-helper location has a native one-shot bridge and the page uses it', () => {
  assert.match(main, /@JavascriptInterface\s+public void helperLocate\(boolean precise\)/);
  assert.match(main, /window\.saraHelperLocated&&window\.saraHelperLocated\(/);
  // Approximate requests ask only for coarse location; nothing is stored or repeated.
  assert.match(main, /new String\[\] \{Manifest\.permission\.ACCESS_COARSE_LOCATION\}/);
  assert.doesNotMatch(main.slice(main.indexOf('private void helperFix'), main.indexOf('private void beginCall')), /requestLocationUpdates|SharedPreferences|Net\.post/);
  assert.match(web, /window\.SaraPhone\?\.helperLocate/);
  assert.match(web, /window\.saraHelperLocated = done/);
  // The browser path stays for browsers and older app builds.
  assert.match(web, /navigator\.geolocation\.getCurrentPosition/);
});

test('C18: the manifest asks only for the permissions the Play release notes declare', () => {
  const perms = [...manifest.matchAll(/uses-permission android:name="android\.permission\.(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(perms, [
    'ACCESS_BACKGROUND_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'ACCESS_NETWORK_STATE',
    'CAMERA', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE', 'FOREGROUND_SERVICE_REMOTE_MESSAGING',
    'INTERNET', 'MODIFY_AUDIO_SETTINGS', 'POST_NOTIFICATIONS', 'RECEIVE_BOOT_COMPLETED', 'RECORD_AUDIO',
    'USE_BIOMETRIC', 'USE_FULL_SCREEN_INTENT', 'VIBRATE',
  ]);
  const doc = read('docs', 'ops', 'C18_PLAY_RELEASE.md');
  for (const p of perms) assert.ok(doc.includes(p!), `C18_PLAY_RELEASE.md covers ${p}`);
});
