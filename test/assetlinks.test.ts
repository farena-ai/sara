// Play Console "deep link domain" notice: the Android app claims only links it can verify. The web
// pairing link https://backstagecoding.com/sara/pair is an App Link (autoVerify) and the website
// serves the Digital Asset Links file for it (docs/store/website/.well-known/assetlinks.json, deployed
// by the root: docs/ops/C18_PLAY_RELEASE.md → Deep links). The file names the app's package and the
// SHA-256 of the upload key and of Google Play's app-signing key (a placeholder until the owner pastes
// it from Play Console → Setup → App signing; the deploy step refuses while it is there).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const PACKAGE = 'com.backstagecoding.sara';
/** The upload key (.secrets/sara-android-upload.jks, alias sara-upload): keytool -list -v. */
const UPLOAD_SHA256 = '9C:B4:57:45:57:EC:68:C9:3B:2F:F8:69:5D:D6:73:20:C1:86:B5:D4:47:D1:8D:12:B7:DB:A7:56:F0:02:72:7F';
const PLAY_PLACEHOLDER = 'REPLACE_WITH_PLAY_APP_SIGNING_SHA256';
/** Google Play's app-signing key (Play Console → App signing, copied 2026-11-09). */
const PLAY_SHA256 = '2C:2B:F6:35:69:CD:06:FF:02:ED:BD:5E:8A:9B:37:FD:B8:73:51:3F:39:4E:38:9E:33:EE:56:07:AA:48:49:73';
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const file = join(ROOT, 'docs', 'store', 'website', '.well-known', 'assetlinks.json');
const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

test('assetlinks.json: valid JSON, the app package, handle_all_urls, fingerprints in the right form', () => {
  const raw = readFileSync(file, 'utf8');
  const list = JSON.parse(raw) as { relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } }[];
  assert.ok(Array.isArray(list) && list.length === 1, 'one statement');
  const [st] = list;
  assert.deepEqual(st.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(st.target.namespace, 'android_app');
  assert.equal(st.target.package_name, PACKAGE);
  const fps = st.target.sha256_cert_fingerprints;
  assert.ok(fps.includes(UPLOAD_SHA256), 'the upload key (side-loaded and internal builds)');
  // Google Play's app-signing key: the owner pastes it (or the placeholder still marks the spot).
  const play = fps.filter((f) => f !== UPLOAD_SHA256);
  assert.equal(play.length, 1, "exactly one more: Google Play's app-signing key");
  assert.equal(play[0], PLAY_SHA256, "Google Play's app-signing key, not the placeholder");
  assert.notEqual(play[0], PLAY_PLACEHOLDER);
  for (const f of fps.filter((x) => x !== PLAY_PLACEHOLDER)) assert.match(f, FINGERPRINT);
  assert.equal(new Set(fps).size, fps.length, 'no duplicates');
  assert.ok(raw.endsWith('\n') && !raw.includes('\r'), 'LF line ends');
});

test('the manifest claims only verifiable web links: https on backstagecoding.com, /sara/pair, autoVerify in its own filter', () => {
  const filters = [...manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
  const web = filters.filter((f) => /android:scheme="https?"/.test(f.body));
  assert.equal(web.length, 1, 'one web link filter');
  const [f] = web;
  assert.match(f.attrs, /android:autoVerify="true"/);
  assert.match(f.body, /android:name="android\.intent\.action\.VIEW"/);
  assert.match(f.body, /android\.intent\.category\.BROWSABLE/);
  assert.deepEqual([...f.body.matchAll(/android:scheme="([^"]+)"/g)].map((m) => m[1]), ['https'], 'no http, no custom scheme mixed in');
  assert.deepEqual([...f.body.matchAll(/android:host="([^"]+)"/g)].map((m) => m[1]), ['backstagecoding.com'], 'only the host that serves assetlinks.json');
  assert.deepEqual([...f.body.matchAll(/android:path(?:Prefix|Pattern)?="([^"]+)"/g)].map((m) => m[1]), ['/sara/pair']);
  // No other filter asks for verification (a custom scheme can't be verified).
  for (const other of filters.filter((x) => x !== f)) assert.doesNotMatch(other.attrs, /autoVerify/);
  // The app handles that link the same way as sara://pair (server and code after #).
  const main = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'backstagecoding', 'sara', 'MainActivity.java'), 'utf8');
  assert.match(main, /static boolean isPairLink\(Uri u\)/);
  assert.match(main, /"backstagecoding\.com"\.equalsIgnoreCase\(host\)/);
  assert.match(main, /getEncodedFragment\(\)/);
});

test('the website has a page for the link when the app is not installed, and the build writes it', () => {
  const page = readFileSync(join(ROOT, 'docs', 'store', 'website', 'sara', 'pair', 'index.html'), 'utf8');
  assert.match(page, /<link rel="canonical" href="https:\/\/backstagecoding\.com\/sara\/pair\/"/);
  assert.match(page, /play\.google\.com\/store\/apps\/details\?id=com\.backstagecoding\.sara/);
  const build = readFileSync(join(ROOT, 'docs', 'store', 'website', 'build.py'), 'utf8');
  assert.match(build, /'sara', 'pair', 'index\.html'/);
  const doc = readFileSync(join(ROOT, 'docs', 'ops', 'C18_PLAY_RELEASE.md'), 'utf8');
  assert.match(doc, /\.well-known\/assetlinks\.json/);
  assert.ok(doc.includes(PLAY_PLACEHOLDER), 'the deploy step names the placeholder it refuses');
});
