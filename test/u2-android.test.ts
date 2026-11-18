// U2.9 (docs/ANDROID.md): the new Android build. The phone app shows the server's web page; these are
// the native pieces the screens since 3.1 need: Messages notices from the app's own check (one-to-one
// and mentions on a "Messages from people" channel, communities on their own quieter channel, plain
// community posts stay inside Messages), the app badge number, saving files from the page (downloads
// and blob exports) and the Open in browser bridge (ADULTAPPS, only this server's pages).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { OwnerAuth } from '../src/auth.ts';
import { Messenger } from '../src/messages.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const JAVA = 'android/app/src/main/java/com/backstagecoding/sara/';
const clock = { now: new Date('2026-11-17T12:00:00Z') };

async function node(t: TestContext, name: string) {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  app.messages = m;
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()));
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { m, base, req };
}

test('U2.9: /api/phone/inbox carries Messages notices for the Android app (one-to-one, mentions; plain community posts stay quiet) and the badge', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  // Without pmAfter (an older app): no people list, nothing changes for her own messages.
  const old = await b.req('GET', '/api/phone/inbox?after=0');
  assert.equal(old.people, undefined);
  assert.equal(typeof old.pmLatest, 'number', 'the cursor is always there');
  assert.equal(typeof old.badge, 'number');
  const start = old.pmLatest;

  const made = await a.req('POST', '/api/messages/communities', { name: 'Book club' });
  const cid = made.chat.id;
  const { code } = await a.req('POST', `/api/messages/communities/${cid}/code`, { url: a.base });
  const bj = await b.req('POST', '/api/messages/join', { code, url: b.base });
  await a.m.flush();
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: 'chapter 3 tonight' });
  await a.m.flush();
  let inbox = await b.req('GET', `/api/phone/inbox?after=0&pmAfter=${start}`);
  assert.deepEqual(inbox.people, [], 'a plain community post: no phone notification');
  assert.ok(inbox.pmLatest > start, 'but the cursor moves past it');

  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: '@Bo can you bring the book?' });
  const inv = await a.req('POST', '/api/messages/invite', { url: a.base });
  await b.req('POST', '/api/messages/join', { code: inv.code, url: b.base });
  const aDirect = (await a.req('GET', '/api/messages')).chats.find((c: any) => c.kind === 'direct').id;
  await a.req('POST', `/api/messages/chats/${aDirect}/send`, { text: 'hi Bo' });
  await a.m.flush();
  inbox = await b.req('GET', `/api/phone/inbox?after=0&pmAfter=${start}`);
  assert.deepEqual(
    inbox.people.map((p: any) => [p.kind, p.mention, p.from, p.text]),
    [
      ['community', true, 'Alex', '@Bo can you bring the book?'],
      ['direct', false, 'Alex', 'hi Bo'],
    ],
    'oldest first',
  );
  const dm = inbox.people[1];
  assert.equal(typeof dm.chat, 'string');
  assert.equal(inbox.people[0].title, 'Book club');
  assert.equal(inbox.badge, 2, 'badge = one-to-one 1 + mention 1');
  // Next check from the new cursor: nothing again.
  assert.deepEqual((await b.req('GET', `/api/phone/inbox?after=0&pmAfter=${inbox.pmLatest}`)).people, []);
  // Read on another device: no late notification for it.
  await b.req('POST', `/api/messages/chats/${dm.chat}/read`, {});
  inbox = await b.req('GET', `/api/phone/inbox?after=0&pmAfter=${start}`);
  assert.deepEqual(inbox.people.map((p: any) => p.kind), ['community']);
  // A muted chat never notifies; "Everything" for the community makes a plain post notify.
  await b.req('PATCH', `/api/messages/chats/${bj.chat.id}`, { notify: 'all' });
  const before = inbox.pmLatest;
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: 'pages 40-60' });
  await a.m.flush();
  inbox = await b.req('GET', `/api/phone/inbox?after=0&pmAfter=${before}`);
  assert.deepEqual(inbox.people.map((p: any) => [p.kind, p.mention]), [['community', false]]);
  await b.req('PATCH', `/api/messages/chats/${bj.chat.id}`, { muted: true });
  assert.deepEqual((await b.req('GET', `/api/phone/inbox?after=0&pmAfter=${before}`)).people, []);
});

test('U2.9: saving from the page in the Android app: what goes to which bridge', async () => {
  const S = await import(pathToFileURL(join(ROOT, 'web/phone-save.js')).href);
  const o = 'https://sara.example.test';
  assert.deepEqual(S.saveTarget({ href: `${o}/api/messages/chats/c1/files/m1`, download: 'notes.pdf' }, o), { kind: 'url', url: `${o}/api/messages/chats/c1/files/m1`, name: 'notes.pdf' });
  assert.deepEqual(S.saveTarget({ href: 'blob:https://sara.example.test/1234', download: 'policy.json' }, o), { kind: 'blob', url: 'blob:https://sara.example.test/1234', name: 'policy.json' });
  assert.equal(S.saveTarget({ href: 'data:text/plain;base64,aGk=', download: '' }, o).kind, 'blob');
  assert.equal(S.saveTarget({ href: 'https://elsewhere.example.test/x.pdf', download: 'x.pdf' }, o), null, 'other sites: left alone');
  assert.equal(S.saveTarget({ href: `${o}/x`, download: null }, o), null, 'no download attribute: a normal link');
  assert.equal(S.saveTarget({ href: 'javascript:void 0', download: 'x' }, o), null);
  // A name from the URL when the attribute is empty; never a path.
  assert.equal(S.saveTarget({ href: `${o}/api/export/sara-backup.zip?x=1`, download: '' }, o).name, 'sara-backup.zip');
  assert.equal(S.fileName('../../etc/passwd'), 'passwd');
  assert.equal(S.fileName(''), 'Sara file');
  assert.equal(S.BLOB_MAX, 25 * 1024 * 1024);
  // Wiring: only inside the Android app (the bridge exists); one line in app.js.
  const js = read('web/phone-save.js');
  assert.match(js, /window\.SaraPhone\?\.saveFile/);
  assert.match(js, /HTMLAnchorElement\.prototype/, 'covers detached a.click() exports too');
  assert.match(read('web/app.js'), /import \{ installPhoneSave \} from '\.\/phone-save\.js';/);
});

test('U2.9: Android native side: notification channels, Messages check, badge number, file save, Open in browser', () => {
  const notify = read(`${JAVA}Notify.java`);
  assert.match(notify, /PEOPLE_CHANNEL = "people"/);
  assert.match(notify, /COMMUNITY_CHANNEL = "community"/);
  assert.match(notify, /new NotificationChannel\(PEOPLE_CHANNEL, [^;]*IMPORTANCE_HIGH\)/);
  assert.match(notify, /new NotificationChannel\(COMMUNITY_CHANNEL, [^;]*IMPORTANCE_DEFAULT\)/, 'communities: no heads-up');
  assert.match(notify, /static void person\(/);
  assert.match(notify, /setNumber\(/, 'launcher badge number');
  assert.match(notify, /"\/#view=messages"/);
  const job = read(`${JAVA}InboxJob.java`);
  assert.match(job, /&pmAfter=/);
  assert.match(job, /optJSONArray\("people"\)/);
  assert.match(job, /pmLatest/);
  const live = read(`${JAVA}LiveInbox.java`);
  assert.match(live, /"pm"\.equals\(event\)/, 'the live connection checks on a Messages notice');
  const main = read(`${JAVA}MainActivity.java`);
  const bridge = main.slice(main.indexOf('class Bridge'));
  assert.match(bridge, /@JavascriptInterface\s+public void saveFile\(String url, String name\)/);
  assert.match(bridge, /@JavascriptInterface\s+public void saveData\(String base64, String name, String type\)/);
  assert.match(bridge.slice(bridge.indexOf('public void saveFile')), /Net\.sameOrigin\(server, url\)/, 'this server only');
  assert.match(main, /MediaStore\.Downloads/);
  assert.match(main, /setDownloadListener/);
  assert.match(main, /getStringExtra\("path"\)/, 'a Messages notification opens Messages');
  // ADULTAPPS: Open in browser stays limited to this server's pages.
  assert.match(bridge, /@JavascriptInterface\s+public void openInBrowser\(String url\)/);
  // Every new Android string is in all six languages (android-strings.test.ts checks parity).
  for (const lang of ['', '-de', '-es', '-fr', '-it', '-pt-rBR']) {
    const xml = read(`android/app/src/main/res/values${lang}/strings.xml`);
    for (const k of ['channel_people', 'channel_community', 'notify_mentioned', 'file_saved', 'file_failed']) assert.match(xml, new RegExp(`name="${k}"`), `${lang || 'en'}: ${k}`);
  }
});
