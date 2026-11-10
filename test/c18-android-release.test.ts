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

// Play 2.88: background location needs the app's own prominent disclosure BEFORE Android's prompt,
// saying the app collects location data, for which feature, and "even when the app is closed or not
// in use" (Google's wording), in every language the app ships.
test('Play 2.88: place reminders show the prominent disclosure before any location prompt', () => {
  const ask = main.slice(main.indexOf('private void askPlacePermissions()'), main.indexOf('private void placeResult('));
  const disclose = ask.indexOf('showPlacesDisclosure();');
  assert.ok(disclose > 0, 'askPlacePermissions shows the disclosure');
  const firstRequest = ask.indexOf('requestPermissions(');
  assert.ok(firstRequest > disclose, 'the disclosure comes before the first location request');
  assert.match(ask, /if \(!placesDisclosed\) \{\s+showPlacesDisclosure\(\);\s+return;/);
  // The background request is reached only after Continue (placesDisclosed = true in the dialog).
  assert.match(ask, /setPositiveButton\(R\.string\.places_continue, \(d, w\) -> \{\s+placesDisclosed = true;\s+askPlacePermissions\(\);/);
  assert.match(ask, /setCancelable\(false\)/);
  assert.match(ask, /ACCESS_BACKGROUND_LOCATION\}, REQ_PLACES_BG/);
  // The toggle and the Fix button both go through it.
  assert.match(main, /if \(on\) askPlacePermissions\(\);/);
  assert.match(main, /public void fixPlacePermissions\(\) \{\s+runOnUiThread\(MainActivity\.this::askPlacePermissions\)/);
  // Nothing else in the app asks for background location.
  assert.equal(main.split('ACCESS_BACKGROUND_LOCATION}').length - 1, 1);

  const need: Record<string, RegExp[]> = {
    values: [/collects location data/, /place reminders/, /even when the app is closed or not in use/, /Allow all the time/],
    'values-es': [/recopila datos de ubicación/, /recordatorios por lugar/, /incluso cuando la app está cerrada o no se está usando/],
    'values-fr': [/collecte des données de localisation/, /rappels de lieu/, /même lorsque l\\'app est fermée ou n\\'est pas utilisée/],
    'values-de': [/erfasst Standortdaten/, /Ortserinnerungen/, /auch wenn die App geschlossen ist oder nicht verwendet wird/],
    'values-pt-rBR': [/coleta dados de localização/, /lembretes por lugar/, /mesmo quando o app está fechado ou não está em uso/],
    'values-it': [/raccoglie dati sulla posizione/, /promemoria di luogo/, /anche quando l\\'app è chiusa o non in uso/],
  };
  for (const [dir, res] of Object.entries(need)) {
    const xml = read('android', 'app', 'src', 'main', 'res', dir, 'strings.xml');
    const msg = /<string name="places_message">([\s\S]*?)<\/string>/.exec(xml)?.[1] ?? '';
    for (const re of res) assert.match(msg, re, `${dir}: places_message ${re}`);
  }
});

// Play 2.88 (found while recording the microphone video): the first time Hey Sara is switched on, Android's
// microphone prompt came back to nothing and the service never started. The answer now starts it.
test('Play 2.88: allowing the microphone for Hey Sara starts the service (switch, tile, resume)', () => {
  const res = main.slice(main.indexOf('public void onRequestPermissionsResult('));
  assert.match(res, /if \(code == REQ_WAKE_MIC\) \{[\s\S]*?if \(has\(Manifest\.permission\.RECORD_AUDIO\)\) WakeService\.start\(this, action\);/);
  // Denied from the switch: the switch goes back off (nothing listens).
  assert.match(res, /else if \(WakeService\.ACTION_START\.equals\(action\)\) WakeService\.prefs\(this\)\.edit\(\)\.putBoolean\("on", false\)/);
  const asks = [...main.matchAll(/requestPermissions\(new String\[\]\{android\.Manifest\.permission\.RECORD_AUDIO\}, (\w+)\)/g)].map((m) => m[1]);
  assert.ok(asks.length >= 2);
  for (const code of asks) assert.equal(code, 'REQ_WAKE_MIC');
  assert.equal((main.match(/pendingWake = /g) ?? []).length >= 3, true, 'each ask remembers what to start');
});

// Play 2.88 (also found on the emulator): switching Hey Sara off while nothing listened went through
// startForegroundService without startForeground, and Android killed the app.
test('Play 2.88: switching Hey Sara off never uses startForegroundService', () => {
  const wake = read('android', 'app', 'src', 'main', 'java', 'com', 'backstagecoding', 'sara', 'WakeService.java');
  const start = wake.slice(wake.indexOf('static void start(Context c, String action)'), wake.indexOf('static volatile boolean running'));
  const stop = start.indexOf('if (ACTION_STOP.equals(action))');
  const fgs = start.indexOf('c.startForegroundService(i)');
  assert.ok(stop > 0 && fgs > stop, 'Stop is handled before startForegroundService');
  assert.match(start.slice(stop, fgs), /if \(!running\) \{[\s\S]*?return;\s*\}/);
  assert.match(start.slice(stop, fgs), /c\.startService\(i\)/);
  assert.match(wake, /onStartCommand\(Intent intent, int flags, int startId\) \{\s+channels\(\);\s+running = true;/);
  assert.match(wake, /public void onDestroy\(\) \{\s+running = false;/);
});

// Play 2.88 (found recording the Hey Sara video): POST /api/wake/model only unpacked the word list, so the
// four model files phones fetch from GET /api/wake/model/<file> never appeared ("Getting the speech model
// from your server…" forever). The same pinned tarball now gives both, each file checked before it's kept.
test('Play 2.88: the server unpacks the phone keyword model with the word list, each file checked', () => {
  const wake = read('src', 'routes', 'wake.ts');
  const fn = wake.slice(wake.indexOf('async function fetchLexicon('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /runTar\(systemTar\(\)\)\(tarFile, tmp, \[LEXICON\.inTar, \.\.\.MODEL_FILES\.map\(\(f\) => f\.inTar\)\]\)/);
  assert.match(body, /for \(const f of MODEL_FILES\) \{[\s\S]*?buf\.length !== f\.size \|\| createHash\('sha256'\)\.update\(buf\)\.digest\('hex'\) !== f\.sha256\) throw[\s\S]*?renameSync\(part, join\(modelDir, f\.name\)\)/);
  // Where the GET route looks for them: <lexicon dir>/model/<name>.
  assert.match(wake, /const modelFile = \(name: string\) => join\(lexFile\(\), '\.\.', 'model', name\)/);
  assert.match(body, /const modelDir = join\(dir, 'model'\)/);
});

// Play 2.88 (found recording the call video): over plain http (a server at home) the page has no secure
// context, so the call button stayed hidden in the Android app although the app runs calls natively.
test('Play 2.88: the phone app offers live calls on http servers too (native calls), web-only parts stay hidden', () => {
  const app = read('web', 'app.js');
  const init = app.slice(app.indexOf('async function initVoice()'), app.indexOf('syncCallButton();', app.indexOf('async function initVoice()')));
  assert.match(init, /voice\.nativeCalls = Boolean\(window\.SaraPhone\?\.startCall\)/);
  assert.match(init, /voice\.callShown = \(micOk && \(voice\.live \|\| \(canHear && canSpeak\)\)\) \|\| \(voice\.nativeCalls && voice\.live\)/);
  // Voice notes and video calls record in the page: still only with a secure context.
  // 3.3.0: the mic shows before her voice is set up (first tap offers setup), but still never without a
  // secure context, where the page can't record.
  assert.match(init, /\$\('#mic'\)\.hidden = !micOk \|\| /);
  assert.match(app, /\$\('#video-call-btn'\)\.hidden = \$\('#call'\)\.hidden \|\| voice\.webMic === false/);
  // A live call in the app goes to the native call (not getUserMedia).
  assert.match(app, /if \(window\.SaraPhone\?\.startCall && !video\) \{/);
});
