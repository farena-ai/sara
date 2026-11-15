// R6 (docs/WORK_APPS.md): deeper work apps. Google Docs/Sheets and Microsoft 365 (Excel/Word through
// Graph) against loopback fakes, Slack/Teams actions through the bridges' check channel, the public
// booking page, and the QuickBooks/Xero/generic CSV exports. No real accounts, no real network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { GoogleAccount, GOOGLE_TOKEN_VAULT, GOOGLE_CLIENT_VAULT } from '../src/google.ts';
import { MicrosoftAuth, msTokenVault, MS_CLIENT_VAULT } from '../src/mail/graph.ts';
import { Vault } from '../src/vault.ts';
import { markdownToDocx } from '../src/doc-write.ts';
import { openZip } from '../src/library/zip.ts';
import { readDocx } from '../src/library/ooxml.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createGoogleWorkTools, googleFileId, GOOGLE_DOCS_SCOPES } from '../src/workapps/gdocs.ts';
import { createM365Tools, FILES_SCOPE, shareId } from '../src/workapps/m365.ts';
import { createChatAppTools } from '../src/workapps/chatapps.ts';
import { BookingStore, freeSlots, DEFAULT_BOOKING, bookingFor, type BookingSettings } from '../src/workapps/booking.ts';
import { accountingCsv, createAccountingTool, csvLine } from '../src/workapps/accounting.ts';
import { bizStore } from '../src/biz/store.ts';
import { timeOf } from '../src/tools/work.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { listen, makeApp, readBody, ROOT, tempDir } from './helpers.ts';

const ctx = (): ToolContext => ({ workspaceDir: '.', signal: new AbortController().signal, sandbox: { kind: 'none' } as never });
const byName = (tools: Tool[], n: string) => {
  const t = tools.find((x) => x.spec.name === n);
  assert.ok(t, `tool ${n}`);
  return t;
};
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// ---------------------------------------------------------------- Google Docs and Sheets

function fakeGoogle() {
  const doc = { title: 'Plan', text: 'Hello team.\nBudget: 10\n' };
  const sheet: Record<string, string[][]> = { Sheet1: [['Name', 'Hours'], ['Ana', '3']] };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    const u = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: u.pathname, body });
    const D = '/v1/documents/DOC1234567890abcdefghij';
    if (u.pathname === D && req.method === 'GET') return json(res, 200, { documentId: 'DOC1234567890abcdefghij', title: doc.title, body: { content: [{ endIndex: 1 }, ...doc.text.split(/(?<=\n)/).map((p) => ({ paragraph: { elements: [{ textRun: { content: p } }] } })), { endIndex: doc.text.length + 1 }] } });
    if (u.pathname === `${D}:batchUpdate` && req.method === 'POST') {
      const r: unknown[] = [];
      for (const q of body.requests) {
        if (q.insertText) {
          doc.text += q.insertText.text;
          r.push({});
        }
        if (q.replaceAllText) {
          const f = q.replaceAllText.containsText.text;
          const n = doc.text.split(f).length - 1;
          doc.text = doc.text.split(f).join(q.replaceAllText.replaceText);
          r.push({ replaceAllText: { occurrencesChanged: n } });
        }
      }
      return json(res, 200, { replies: r });
    }
    const S = '/v4/spreadsheets/SHEET1234567890abcdefgh';
    if (u.pathname === S && req.method === 'GET') return json(res, 200, { properties: { title: 'Hours' }, sheets: [{ properties: { title: 'Sheet1' } }] });
    const m = /^\/v4\/spreadsheets\/SHEET1234567890abcdefgh\/values\/(.+?)(:append)?$/.exec(decodeURIComponent(u.pathname));
    if (m) {
      const range = m[1];
      const tab = range.split('!')[0];
      if (req.method === 'GET') {
        const c = /!([A-Z])(\d+)/.exec(range);
        const r0 = c ? Number(c[2]) - 1 : 0;
        const c0 = c ? c[1].charCodeAt(0) - 65 : 0;
        return json(res, 200, { range, values: (sheet[tab] ?? []).slice(r0).map((row) => row.slice(c0)) });
      }
      if (req.method === 'PUT') {
        const cell = /!([A-Z])(\d+)/.exec(range)!;
        const col = cell[1].charCodeAt(0) - 65;
        body.values.forEach((row: string[], i: number) => row.forEach((v, j) => {
          const r = Number(cell[2]) - 1 + i;
          sheet[tab][r] ??= [];
          sheet[tab][r][col + j] = String(v);
        }));
        return json(res, 200, { updatedRange: range, updatedCells: body.values.flat().length });
      }
      if (req.method === 'POST' && m[2]) {
        sheet[tab].push(...body.values.map((r: unknown[]) => r.map(String)));
        return json(res, 200, { updates: { updatedRange: `${tab}!A${sheet[tab].length - body.values.length + 1}:B${sheet[tab].length}`, updatedRows: body.values.length } });
      }
    }
    json(res, 404, { error: { message: 'not found' } });
  };
  return { doc, sheet, calls, handler };
}

function googleWith(dir: string, base: string, scopes: string): GoogleAccount {
  const vault = new Vault(dir);
  vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret12345' }));
  vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify({ access: 'tok', refresh: 'ref', expiresAt: Date.now() + 3600_000, scopes }));
  return new GoogleAccount(vault, { fetch, apiBase: base });
}

test('R6.1 Google: Docs and Sheets are an optional extra permission, asked for only on request', () => {
  const { dir, cleanup } = tempDir();
  try {
    const g = googleWith(dir, 'http://127.0.0.1:1', 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(g.status().docs, false);
    const plain = new URL(g.authUrl('http://localhost/cb'));
    assert.ok(!plain.searchParams.get('scope')!.includes('documents'), 'a normal sign-in never adds Docs silently');
    const more = new URL(g.authUrl('http://localhost/cb', { docs: true }));
    for (const s of GOOGLE_DOCS_SCOPES) assert.ok(more.searchParams.get('scope')!.includes(s));
    assert.equal(more.searchParams.get('include_granted_scopes'), 'true');
    const tools = createGoogleWorkTools(g);
    assert.ok(tools.every((t) => t.isAvailable?.() === false), 'hidden until the person allowed Docs and Sheets');
    const g2 = googleWith(dir, 'http://127.0.0.1:1', `gmail.readonly ${GOOGLE_DOCS_SCOPES.join(' ')}`);
    assert.equal(g2.status().docs, true);
    // Already allowed: a later sign-in keeps asking for it (else Google would drop it).
    assert.ok(new URL(g2.authUrl('http://localhost/cb')).searchParams.get('scope')!.includes('documents'));
    assert.equal(googleFileId('https://docs.google.com/document/d/DOC1234567890abcdefghij/edit#heading=h.1', 'doc'), 'DOC1234567890abcdefghij');
    assert.equal(googleFileId('https://docs.google.com/spreadsheets/d/SHEET1234567890abcdefgh/edit#gid=0', 'sheet'), 'SHEET1234567890abcdefgh');
    assert.equal(googleFileId('SHEET1234567890abcdefgh', 'sheet'), 'SHEET1234567890abcdefgh');
    assert.throws(() => googleFileId('https://docs.google.com/spreadsheets/d/SHEET1234567890abcdefgh', 'doc'), /spreadsheet/i);
    assert.throws(() => googleFileId('../../etc', 'doc'));
  } finally {
    cleanup();
  }
});

test('R6.1 Google Docs: read, append and replace with a diff on the card and a read-back', async () => {
  const { dir, cleanup } = tempDir();
  const fake = fakeGoogle();
  const srv = await listen(fake.handler);
  try {
    const g = googleWith(dir, srv.url, `gmail.readonly ${GOOGLE_DOCS_SCOPES.join(' ')}`);
    const tools = createGoogleWorkTools(g);
    const url = 'https://docs.google.com/document/d/DOC1234567890abcdefghij/edit';
    const read = byName(tools, 'gdoc_read');
    assert.equal(read.defaultPermission, 'auto');
    assert.equal(read.interruptible, true);
    const out = await read.run({ doc: url }, ctx());
    assert.match(out, /Plan/);
    assert.match(out, /Budget: 10/);
    assert.match(out, /information only/i);

    const append = byName(tools, 'gdoc_append');
    assert.equal(append.defaultPermission, 'ask');
    const prep = await append.prepare!({ doc: url, text: 'Next steps: ship it.' }, { signal: new AbortController().signal });
    assert.match(prep.summary!, /“Plan”/);
    assert.match(prep.summary!, /^\+ Next steps: ship it\./m);
    const a = await append.run({ doc: url, text: 'Next steps: ship it.' }, ctx());
    assert.match(a, /^Verified: /m);
    assert.ok(fake.doc.text.includes('Next steps: ship it.'));

    const rep = byName(tools, 'gdoc_replace_text');
    const prep2 = await rep.prepare!({ doc: url, find: 'Budget: 10', replace: 'Budget: 12' }, { signal: new AbortController().signal });
    assert.match(prep2.summary!, /^- Budget: 10$/m);
    assert.match(prep2.summary!, /^\+ Budget: 12$/m);
    assert.match(prep2.summary!, /1 place/);
    const none = await rep.prepare!({ doc: url, find: 'nowhere', replace: 'x' }, { signal: new AbortController().signal });
    assert.match(none.refuse!, /isn't in/);
    const r = await rep.run({ doc: url, find: 'Budget: 10', replace: 'Budget: 12' }, ctx());
    assert.match(r, /Changed 1 place/);
    assert.match(r, /^Verified: /m);
    assert.ok(fake.doc.text.includes('Budget: 12') && !fake.doc.text.includes('Budget: 10'));
  } finally {
    srv.server.close();
    cleanup();
  }
});

test('R6.1 Google Sheets: read, update a range (old → new on the card), append rows, read back', async () => {
  const { dir, cleanup } = tempDir();
  const fake = fakeGoogle();
  const srv = await listen(fake.handler);
  try {
    const g = googleWith(dir, srv.url, GOOGLE_DOCS_SCOPES.join(' '));
    const tools = createGoogleWorkTools(g);
    const id = 'SHEET1234567890abcdefgh';
    const out = await byName(tools, 'gsheet_read').run({ sheet: id }, ctx());
    assert.match(out, /Hours/);
    assert.match(out, /Ana \| 3/);
    const upd = byName(tools, 'gsheet_update_range');
    assert.equal(upd.defaultPermission, 'ask');
    const prep = await upd.prepare!({ sheet: id, range: 'Sheet1!B2', values: [['5']] }, { signal: new AbortController().signal });
    assert.match(prep.summary!, /B2: 3 → 5/);
    const u = await upd.run({ sheet: id, range: 'Sheet1!B2', values: [['5']] }, ctx());
    assert.match(u, /^Verified: /m);
    assert.equal(fake.sheet.Sheet1[1][1], '5');
    const app_ = byName(tools, 'gsheet_append_rows');
    const prep2 = await app_.prepare!({ sheet: id, values: [['Ben', '2']] }, { signal: new AbortController().signal });
    assert.match(prep2.summary!, /^\+ Ben \| 2$/m);
    const ap = await app_.run({ sheet: id, values: [['Ben', '2']] }, ctx());
    assert.match(ap, /Added 1 row/);
    assert.match(ap, /^Verified: /m);
    await assert.rejects(upd.run({ sheet: id, range: 'Sheet1!B2', values: 'nope' }, ctx()), /rows/);
  } finally {
    srv.server.close();
    cleanup();
  }
});

// ---------------------------------------------------------------- Microsoft 365 (Graph)

async function fakeGraph() {
  const docx = markdownToDocx('# Offer\n\nName: \n\nStart date: \n', 'Offer');
  const files = new Map<string, { name: string; bytes: Buffer; versions: number }>([['ITEMW', { name: 'Offer.docx', bytes: docx, versions: 1 }]]);
  const cells: Record<string, string[][]> = { 'A1:B2': [['Month', 'Total'], ['Jan', '100']] };
  const calls: string[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const u = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    calls.push(`${req.method} ${u}`);
    const sh = /^\/shares\/u!([\w-]+)\/driveItem$/.exec(u);
    if (sh) {
      const link = Buffer.from(sh[1], 'base64url').toString();
      const item = link.includes('Offer') ? 'ITEMW' : 'ITEMX';
      return json(res, 200, { id: item, name: item === 'ITEMW' ? 'Offer.docx' : 'Budget.xlsx', parentReference: { driveId: 'DRIVE1' } });
    }
    if (u === '/me/drive/root:/Work/Budget.xlsx') return json(res, 200, { id: 'ITEMX', name: 'Budget.xlsx', parentReference: { driveId: 'DRIVE1' } });
    const rg = /^\/drives\/DRIVE1\/items\/ITEMX\/workbook\/worksheets\/([^/]+)\/range\(address='([^']+)'\)$/.exec(u);
    if (rg) {
      if (req.method === 'PATCH') {
        cells[rg[2]] = JSON.parse(raw.toString()).values.map((r: unknown[]) => r.map(String));
      }
      return json(res, 200, { address: `${rg[1]}!${rg[2]}`, values: cells[rg[2]] ?? [['']] });
    }
    if (u === '/drives/DRIVE1/items/ITEMW' && req.method === 'GET') return json(res, 200, { id: 'ITEMW', name: 'Offer.docx', parentReference: { driveId: 'DRIVE1' } });
    if (u === '/drives/DRIVE1/items/ITEMW/content' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      return res.end(files.get('ITEMW')!.bytes);
    }
    if (u === '/drives/DRIVE1/items/ITEMW/content' && req.method === 'PUT') {
      const f = files.get('ITEMW')!;
      f.bytes = raw;
      f.versions++;
      return json(res, 200, { id: 'ITEMW', name: f.name });
    }
    if (u === '/drives/DRIVE1/items/ITEMW/versions') return json(res, 200, { value: Array.from({ length: files.get('ITEMW')!.versions }, (_, i) => ({ id: `${i + 1}.0` })) });
    json(res, 404, { error: { code: 'itemNotFound', message: 'not found' } });
  };
  const srv = await listen(handler);
  return { srv, files, cells, calls };
}

function msWith(dir: string, graph: string, files: boolean) {
  const vault = new Vault(dir);
  vault.set(MS_CLIENT_VAULT, JSON.stringify({ clientId: '1a2b3c4d-1111-2222-3333-444455556666' }));
  vault.set(msTokenVault('ms_1'), JSON.stringify({ access: 'tok', refresh: 'ref', expiresAt: Date.now() + 3600_000, ...(files ? { files: true } : {}) }));
  const auth = new MicrosoftAuth(vault, { fetch, graphBase: graph, loginBase: 'http://127.0.0.1:1' });
  const accounts = { list: () => [{ id: 'ms_1', kind: 'microsoft', provider: 'microsoft', address: 'alex@contoso.com', calendar: true, files }], ms: auth };
  return { auth, accounts };
}

test('R6.2 Microsoft 365: Files.ReadWrite is optional consent; Excel ranges read and update with a read-back', async () => {
  const { dir, cleanup } = tempDir();
  const g = await fakeGraph();
  try {
    const { auth, accounts } = msWith(dir, g.srv.url, true);
    const plain = new URL(auth.authUrl('http://localhost/cb'));
    assert.ok(!plain.searchParams.get('scope')!.includes(FILES_SCOPE));
    assert.ok(new URL(auth.authUrl('http://localhost/cb', undefined, { files: true })).searchParams.get('scope')!.includes(FILES_SCOPE));
    assert.equal(shareId('https://contoso-my.sharepoint.com/:x:/g/personal/alex/Budget.xlsx'), `u!${Buffer.from('https://contoso-my.sharepoint.com/:x:/g/personal/alex/Budget.xlsx').toString('base64url')}`);
    const tools = createM365Tools(() => accounts as never, { fetch });
    const read = byName(tools, 'excel_read_range');
    assert.equal(read.isAvailable?.(), true);
    const out = await read.run({ file: '/Work/Budget.xlsx', sheet: 'Sheet1', range: 'A1:B2' }, ctx());
    assert.match(out, /Jan \| 100/);
    const upd = byName(tools, 'excel_update_range');
    assert.equal(upd.defaultPermission, 'ask');
    const prep = await upd.prepare!({ file: '/Work/Budget.xlsx', sheet: 'Sheet1', range: 'A1:B2', values: [['Month', 'Total'], ['Jan', '120']] }, { signal: new AbortController().signal });
    assert.match(prep.summary!, /B2: 100 → 120/);
    const u = await upd.run({ file: '/Work/Budget.xlsx', sheet: 'Sheet1', range: 'A1:B2', values: [['Month', 'Total'], ['Jan', '120']] }, ctx());
    assert.match(u, /^Verified: /m);
    assert.equal(g.cells['A1:B2'][1][1], '120');
    const { accounts: noFiles } = msWith(dir, g.srv.url, false);
    assert.equal(createM365Tools(() => noFiles as never, { fetch })[0].isAvailable?.(), false, 'hidden until Files.ReadWrite was allowed');
  } finally {
    g.srv.server.close();
    cleanup();
  }
});

test('R6.2 Word online: download, fill with the OOXML editor, upload a new version (history kept), read back', async () => {
  const { dir, cleanup } = tempDir();
  const g = await fakeGraph();
  try {
    const { accounts } = msWith(dir, g.srv.url, true);
    const tools = createM365Tools(() => accounts as never, { fetch });
    const link = 'https://contoso-my.sharepoint.com/:w:/g/personal/alex/Offer.docx';
    const read = byName(tools, 'word_read');
    assert.match(await read.run({ file: link }, ctx()), /Start date/);
    const fill = byName(tools, 'word_fill');
    assert.equal(fill.defaultPermission, 'ask');
    const prep = await fill.prepare!({ file: link, values: { Name: 'Kim Lee', 'Start date': 'May 4' } }, { signal: new AbortController().signal });
    assert.match(prep.summary!, /Offer\.docx/);
    assert.match(prep.summary!, /\+ Name: Kim Lee/);
    const out = await fill.run({ file: link, values: { Name: 'Kim Lee', 'Start date': 'May 4' } }, ctx());
    assert.match(out, /version 2/);
    assert.match(out, /^Verified: /m);
    const text = readDocx(openZip(g.files.get('ITEMW')!.bytes)).parts.map((p) => p.text).join('\n');
    assert.match(text, /Kim Lee/);
    assert.match(text, /May 4/);
    assert.ok(g.calls.some((c) => c === 'PUT /drives/DRIVE1/items/ITEMW/content'), 'the same item: OneDrive keeps the old version');
  } finally {
    g.srv.server.close();
    cleanup();
  }
});

// ---------------------------------------------------------------- Slack and Teams actions

const loadPlugin = (id: string, f: string) => import(pathToFileURL(join(ROOT, 'plugins', id, f)).href);

test('R6.3 Slack actions (plugin side): post, react, status, reminder, search; user-token ops say what they need', async () => {
  const { runAction } = await loadPlugin('slack', 'actions.mjs');
  const calls: { method: string; args: Record<string, unknown>; user?: boolean }[] = [];
  const api = (user: string) => ({
    bot: 'xoxb-1',
    user,
    async call(method: string, args: Record<string, unknown> = {}, o: { user?: boolean } = {}) {
      calls.push({ method, args, user: o.user });
      if (method === 'users.conversations') return { ok: true, channels: [{ id: 'C0GENERAL1', name: 'general' }] };
      if (method === 'users.lookupByEmail') return { ok: true, user: { id: 'U9' } };
      if (method === 'conversations.open') return { ok: true, channel: { id: 'D0DIRECT9' } };
      if (method === 'chat.postMessage') return { ok: true, channel: args.channel, ts: '111.222' };
      if (method === 'chat.getPermalink') return { ok: true, permalink: 'https://x.slack.com/archives/C0GENERAL1/p111222' };
      if (method === 'reactions.add') return { ok: true };
      if (method === 'reactions.get') return { ok: true, message: { reactions: [{ name: 'tada' }] } };
      if (method === 'users.profile.set') return { ok: true, profile: args.profile };
      if (method === 'users.profile.get') return { ok: true, profile: { status_text: 'Focus time', status_emoji: ':headphones:' } };
      if (method === 'reminders.add') return { ok: true, reminder: { id: 'Rm1' } };
      if (method === 'reminders.info') return { ok: true, reminder: { id: 'Rm1', text: args.reminder } };
      if (method === 'search.messages') return { ok: true, messages: { matches: [{ text: 'launch is friday', username: 'ana', channel: { name: 'general' }, ts: '1', permalink: 'https://x/1' }] } };
      return { ok: false };
    },
  });
  let r = await runAction(api(''), { op: 'post', to: '#general', text: 'Standup in 5' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'C0GENERAL1');
  assert.match(r.verified, /permalink/);
  r = await runAction(api(''), { op: 'post', to: 'ana@example.com', text: 'hi' });
  assert.equal(r.channel, 'D0DIRECT9');
  r = await runAction(api(''), { op: 'react', channel: 'C0GENERAL1', ts: '111.222', emoji: ':tada:' });
  assert.equal(r.ok, true);
  r = await runAction(api(''), { op: 'status', text: 'Focus time', emoji: ':headphones:', minutes: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.needUserToken, true);
  r = await runAction(api('xoxp-1'), { op: 'status', text: 'Focus time', emoji: ':headphones:', minutes: 60 });
  assert.equal(r.ok, true);
  assert.ok(calls.find((c) => c.method === 'users.profile.set')!.user);
  r = await runAction(api('xoxp-1'), { op: 'remind', text: 'send the deck', time: 'tomorrow at 9am' });
  assert.equal(r.id, 'Rm1');
  r = await runAction(api('xoxp-1'), { op: 'search', query: 'launch' });
  assert.match(JSON.stringify(r.matches), /launch is friday/);
  r = await runAction(api(''), { op: 'nope' });
  assert.equal(r.ok, false);
});

test('R6.3 Slack/Teams tools: posting asks first, results go through the bridge check channel, off when not set up', async () => {
  const seen: { plugin: string; body: Record<string, unknown> }[] = [];
  const pm = {
    processOf: (id: string) => ({ state: id === 'slack' || id === 'teams' ? 'ready' : 'stopped' }),
    async bridgeCheck(plugin: string, _c: string, body: Record<string, unknown>) {
      seen.push({ plugin, body });
      if (body.op === 'search') return { ok: true, matches: [{ text: 'Q3 plan', user: 'ana', channel: 'general', link: 'https://x/1' }] };
      if (body.op === 'status') return { ok: false, needUserToken: true };
      return { ok: true, channel: 'C1', ts: '1.2', id: 'act-1', verified: 'read the message back (permalink https://x/1)' };
    },
  };
  const tools = createChatAppTools(() => pm as never, () => 'main');
  const post = byName(tools, 'slack_post');
  assert.equal(post.defaultPermission, 'ask');
  assert.match(post.summarize({ to: '#general', text: 'Ship it' }), /#general[\s\S]*Ship it/);
  assert.match(await post.run({ to: '#general', text: 'Ship it' }, ctx()), /^Verified: /m);
  assert.deepEqual(seen[0], { plugin: 'slack', body: { step: 'action', op: 'post', to: '#general', text: 'Ship it' } });
  const search = byName(tools, 'slack_search');
  assert.equal(search.defaultPermission, 'auto');
  assert.match(await search.run({ query: 'Q3' }, ctx()), /Q3 plan/);
  assert.match(await byName(tools, 'slack_status').run({ text: 'Lunch' }, ctx()), /user token/i);
  const teams = byName(tools, 'teams_post');
  assert.equal(teams.defaultPermission, 'ask');
  assert.match(await teams.run({ to: 'Project Falcon', text: 'Hi all' }, ctx()), /Teams/);
  const off = createChatAppTools(() => ({ processOf: () => undefined }) as never, () => 'main');
  assert.equal(byName(off, 'slack_post').isAvailable?.(), false);
});

test('R6.3 Teams plugin answers the action step for chats it knows', () => {
  const src = readFileSync(join(ROOT, 'plugins', 'teams', 'main.mjs'), 'utf8');
  assert.match(src, /step === 'action'/);
  const slack = readFileSync(join(ROOT, 'plugins', 'slack', 'main.mjs'), 'utf8');
  assert.match(slack, /step === 'action'/);
  const man = JSON.parse(readFileSync(join(ROOT, 'plugins', 'slack', 'sara-plugin.json'), 'utf8'));
  const ut = man.settings.find((s: { key: string }) => s.key === 'userToken');
  assert.equal(ut.type, 'secret');
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.ok(man.i18n[l][ut.label] && man.i18n[l][ut.tip], `slack manifest ${l}`);
});

// ---------------------------------------------------------------- booking links

const settings = (o: Partial<BookingSettings> = {}): BookingSettings => ({ ...DEFAULT_BOOKING, on: true, slug: 'alex', windows: [{ day: 1, start: '09:00', end: '12:00' }], duration: 30, buffer: 15, maxPerDay: 3, minNoticeHours: 0, daysAhead: 7, ...o });

test('R6.4 booking slots: windows, duration, buffer, max per day, busy time and notice', () => {
  const now = new Date('2026-11-15T12:00:00Z'); // a Sunday
  const tz = 'UTC';
  const s = freeSlots(settings(), [], now, tz);
  // Monday 9:00-12:00, 30 min + 15 buffer → 9:00, 9:45, 10:30, 11:15 — capped at 3 per day.
  assert.deepEqual(s.map((d) => d.toISOString()), ['2026-11-16T09:00:00.000Z', '2026-11-16T09:45:00.000Z', '2026-11-16T10:30:00.000Z']);
  const busy = [{ start: new Date('2026-11-16T09:30:00Z'), end: new Date('2026-11-16T10:00:00Z') }];
  const s2 = freeSlots(settings({ maxPerDay: 10 }), busy, now, tz).map((d) => d.toISOString());
  assert.ok(!s2.includes('2026-11-16T09:00:00.000Z'), 'ends inside the buffer before busy time');
  assert.ok(!s2.includes('2026-11-16T09:45:00.000Z'));
  assert.ok(s2.includes('2026-11-16T10:15:00.000Z'));
  // Two already booked that day leave one.
  const booked = [{ start: new Date('2026-11-16T09:00:00Z'), end: new Date('2026-11-16T09:30:00Z'), booking: true }, { start: new Date('2026-11-16T11:00:00Z'), end: new Date('2026-11-16T11:30:00Z'), booking: true }];
  assert.equal(freeSlots(settings(), booked, now, tz).length, 1);
  // A time zone: 9:00 in New York is 14:00 UTC.
  assert.equal(freeSlots(settings(), [], now, 'America/New_York')[0].toISOString(), '2026-11-16T14:00:00.000Z');
  assert.equal(freeSlots(settings({ on: false }), [], now, tz).length, 3, 'slot math alone; the page checks on');
});

test('R6.4 booking page: off by default, honeypot, rate limit, ask-me and auto-confirm create the event and email', async () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date() };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' });
  const events: unknown[] = [];
  const mails: Record<string, unknown>[] = [];
  const b = bookingFor(app);
  b.setDeps({
    busy: async () => [],
    addEvent: async (e) => {
      events.push(e);
      return { id: `ev${events.length}`, readBack: true };
    },
    sendMail: async (m) => {
      mails.push(m);
      return 'sent';
    },
  });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = (path: string, init: RequestInit = {}) => fetch(`${origin}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  try {
    assert.equal(new BookingStore(app.store.db).settings().on, false, 'off by default');
    assert.equal((await fetch(`${origin}/book/alex`)).status, 404);
    let r = await owner('/booking', { method: 'PUT', body: JSON.stringify({ on: true, slug: 'Alex Lee!', windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '23:59' })), duration: 30, buffer: 0, maxPerDay: 8, minNoticeHours: 1, daysAhead: 3, approval: 'ask', title: 'Intro call' }) });
    assert.equal(r.status, 200);
    const saved = (await r.json()) as { settings: BookingSettings; url: string };
    assert.equal(saved.settings.slug, 'alex-lee');
    assert.match(saved.url, /\/book\/alex-lee$/);
    const page = await fetch(`${origin}/book/alex-lee`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Intro call/);
    assert.match(html, /name="website"/, 'the honeypot field');
    assert.doesNotMatch(html, /<script/i, 'no script on the public page');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    const slot = /name="slot" value="([^"]+)"/.exec(html)![1];
    const t = /name="t" value="([^"]+)"/.exec(html)![1];
    const form = (extra: Record<string, string> = {}) => new URLSearchParams({ slot, t, name: 'Kim Visitor', email: 'kim@example.com', note: 'About the project', website: '', ...extra }).toString();
    const post = (body: string, ip = '') => fetch(`${origin}/book/alex-lee`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', ...(ip ? { 'x-forwarded-for': ip } : {}) } });
    // The honeypot: a bot that fills every box gets a polite page and nothing is booked.
    r = await post(form({ website: 'http://spam' }));
    assert.equal(r.status, 200);
    assert.equal(new BookingStore(app.store.db).requests().length, 0);
    // Too fast after the page was shown counts as a bot too (the signed time token).
    r = await post(form());
    assert.equal(new BookingStore(app.store.db).requests().length, 0, 'sent in under 2 s');
    b.setDeps({ minFormMs: 0 });
    r = await post(form());
    assert.equal(r.status, 200);
    assert.match(await r.text(), /request/i);
    let reqs = new BookingStore(app.store.db).requests();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].status, 'pending');
    assert.equal(events.length, 0, 'ask me: nothing on the calendar yet');
    // The owner confirms: event + confirmation email.
    r = await owner(`/booking/requests/${reqs[0].id}/confirm`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(events.length, 1);
    assert.deepEqual((events[0] as { guests: string[] }).guests, ['kim@example.com']);
    assert.equal(mails.length, 1);
    assert.match(String(mails[0].to), /kim@example.com/);
    reqs = new BookingStore(app.store.db).requests();
    assert.equal(reqs[0].status, 'confirmed');
    assert.equal(reqs[0].eventId, 'ev1');
    // The same slot is gone from the page now.
    assert.doesNotMatch(await (await fetch(`${origin}/book/alex-lee`)).text(), new RegExp(`value="${slot}"`));
    // Auto-confirm.
    await owner('/booking', { method: 'PUT', body: JSON.stringify({ approval: 'auto' }) });
    const html2 = await (await fetch(`${origin}/book/alex-lee`)).text();
    const slot2 = /name="slot" value="([^"]+)"/.exec(html2)![1];
    const t2 = /name="t" value="([^"]+)"/.exec(html2)![1];
    r = await post(new URLSearchParams({ slot: slot2, t: t2, name: 'Lee', email: 'lee@example.com', note: '', website: '' }).toString());
    assert.match(await r.text(), /confirmed/i);
    assert.equal(events.length, 2);
    // Bad input and a taken slot.
    r = await post(new URLSearchParams({ slot: slot2, t: t2, name: 'X', email: 'not-an-email', website: '' }).toString());
    assert.equal(r.status, 400);
    r = await post(new URLSearchParams({ slot: slot2, t: t2, name: 'Y', email: 'y@example.com', website: '' }).toString());
    assert.equal(r.status, 409);
    // Rate limit: a flood of requests from one address stops.
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) limited = (await post(form({ email: `n${i}@example.com` }))).status === 429;
    assert.ok(limited, 'rate limited');
    // Off again: the page is gone.
    await owner('/booking', { method: 'PUT', body: JSON.stringify({ on: false }) });
    assert.equal((await fetch(`${origin}/book/alex-lee`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    app.store.close();
    cleanup();
  }
});

// ---------------------------------------------------------------- accounting exports

test('R6.5 accounting exports: QuickBooks Online, Xero and generic CSV for invoices, expenses and time', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-15T12:00:00Z') });
  app.library = new LibraryStore(app.store.db, dir, () => app.now());
  try {
    const biz = bizStore(app);
    biz.createInvoice({ kind: 'invoice', clientName: 'Acme, Inc.', clientEmail: 'ap@acme.test', items: [{ desc: 'Design "v2"', qty: 2, unitCents: 15000 }], taxRatePct: 10, issued: '2026-11-02', dueDays: 30 });
    biz.createInvoice({ kind: 'quote', clientName: 'Not exported', items: [{ desc: 'Quote only', qty: 1, unitCents: 500 }], issued: '2026-11-03' });
    biz.addExpense({ vendor: 'Blue Bottle', date: '2026-11-04', totalCents: 1250, taxCents: 100, category: 'Meals', currency: 'USD', docId: null, docName: '', note: 'client coffee' });
    timeOf(app).add({ day: '2026-11-05', hours: 2.5, client: 'Acme, Inc.', project: 'Site', note: 'wireframes' }, 'UTC');
    assert.equal(csvLine(['a,b', 'say "hi"', '=cmd']), '"a,b","say ""hi""",\'=cmd');
    const qbInv = accountingCsv(app, { from: '2026-11-01', to: '2026-11-30', format: 'quickbooks', what: 'invoices' });
    const lines = qbInv.csv.trim().split('\r\n');
    assert.equal(lines[0], 'InvoiceNo,Customer,InvoiceDate,DueDate,Terms,ItemDescription,ItemQuantity,ItemRate,ItemAmount,ItemTaxCode,ItemTaxAmount,Currency');
    assert.equal(lines.length, 2, 'quotes are not exported');
    assert.match(lines[1], /^INV-2026-\d+,"Acme, Inc\.",11\/02\/2026,12\/02\/2026,Net 30,"Design ""v2""",2,150\.00,300\.00,TAX,30\.00,USD$/);
    const qbExp = accountingCsv(app, { from: '2026-11-01', to: '2026-11-30', format: 'quickbooks', what: 'expenses' });
    assert.match(qbExp.csv, /^Date,Description,Amount\r\n11\/04\/2026,Blue Bottle - Meals - client coffee,-12\.50\r\n$/);
    const xInv = accountingCsv(app, { from: '2026-11-01', to: '2026-11-30', format: 'xero', what: 'invoices' });
    assert.match(xInv.csv.split('\r\n')[0], /^\*ContactName,EmailAddress,.*\*InvoiceNumber,.*\*InvoiceDate,\*DueDate,.*\*Description,\*Quantity,\*UnitAmount,.*\*AccountCode,\*TaxType/);
    assert.match(xInv.csv, /02\/11\/2026/);
    const xExp = accountingCsv(app, { from: '2026-11-01', to: '2026-11-30', format: 'xero', what: 'expenses' });
    assert.match(xExp.csv, /^\*Date,\*Amount,Payee,Description,Reference\r\n04\/11\/2026,-12\.50,Blue Bottle,/);
    const time = accountingCsv(app, { from: '2026-11-01', to: '2026-11-30', format: 'quickbooks', what: 'time' });
    assert.match(time.csv, /Acme, Inc\./);
    assert.match(time.csv, /2:30/);
    const gen = accountingCsv(app, { from: '2026-11-01', to: '2026-11-30', format: 'generic', what: 'all' });
    assert.match(gen.csv.split('\r\n')[0], /^Type,Date,Number,Party,Description,Quantity,Rate,Amount,Tax,Currency,Status$/);
    assert.equal(gen.rows, 3);
    assert.throws(() => accountingCsv(app, { from: '2026-12-01', to: '2026-11-01', format: 'xero', what: 'invoices' }), /before/);
    const tool = createAccountingTool(() => app);
    assert.equal(tool.defaultPermission, 'auto');
    const out = await tool.run({ from: '2026-11-01', to: '2026-11-30', format: 'xero' }, ctx());
    assert.match(out, /Xero/);
    assert.match(out, /Library/);
    assert.match(out, /No data was sent anywhere/);
    assert.ok(app.library.list().some((d) => /xero.*invoices.*\.csv$/i.test(d.name)));
  } finally {
    app.store.close();
    cleanup();
  }
});

test('R6 wiring: tools registered, off in private chats, lean words, persona, routes, strings', () => {
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  for (const f of ['createGoogleWorkTools', 'createM365Tools', 'createChatAppTools', 'createAccountingTool']) assert.match(main, new RegExp(f));
  const chat = readFileSync(join(ROOT, 'src', 'chat.ts'), 'utf8');
  const lean = readFileSync(join(ROOT, 'src', 'lean.ts'), 'utf8');
  // teams_post exactly: teams_followed (sports) is not a Teams tool.
  assert.match(chat, /name === 'teams_post'/);
  assert.match(lean, /n === 'teams_post'/);
  for (const p of ['gdoc_', 'gsheet_', 'excel_', 'word_', 'slack_']) {
    assert.ok(chat.includes(`'${p}'`), `OFFSERVER ${p}`);
    assert.ok(lean.includes(`'${p}'`), `lean OFF ${p}`);
  }
  assert.match(lean, /workapps/);
  assert.match(readFileSync(join(ROOT, 'src', 'persona.ts'), 'utf8'), /gdoc_read/);
  assert.match(readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8'), /\/book\//);
  const hh = readFileSync(join(ROOT, 'src', 'household.ts'), 'utf8');
  assert.match(hh, /'booking'/);
  assert.match(hh, /'accounting'/);
  const doc = readFileSync(join(ROOT, 'docs', 'WORK_APPS.md'), 'utf8');
  for (const w of ['Docs and Sheets', 'Files.ReadWrite', 'Slack', 'booking', 'QuickBooks', 'Xero']) assert.ok(doc.includes(w), w);
});
