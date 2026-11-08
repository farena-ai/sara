// C16 (docs/ops/C16_DESIGN.md): team pages inside a business workspace. Markdown pages with every
// saved version kept, threaded comments with @mentions, roles (viewers read and comment, contributors
// edit, managers delete), a workspace legal hold that blocks deletes, per-person export/delete,
// Markdown/PDF export, audit rows, and pages as Sara's context.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setNetTransport } from '../src/net-guard.ts';
import { contentFixture } from './helpers/business-content.ts';

type Fixture = Awaited<ReturnType<typeof contentFixture>>;
async function team(f: Fixture) {
  const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Handbook' });
  const editor = f.add('Blake'); const viewer = f.add('Casey Reed'); const outsider = f.add('Drew');
  f.grant(w.id, editor, 'contributor'); f.grant(w.id, viewer, 'viewer');
  return { w, editor, viewer, outsider, base: `/api/business/workspaces/${w.id}/pages` };
}
const json = async (r: Response) => { const text = await r.text(); try { return JSON.parse(text); } catch { return text; } };

test('pages: roles — viewers read and comment, contributors create and edit, managers delete', async () => {
  const f = await contentFixture();
  try {
    const { editor, viewer, outsider, base } = await team(f);
    assert.equal((await f.request(base, viewer, { title: 'Nope', body: 'x' })).status, 404);
    const created = await f.request(base, editor, { title: 'Onboarding', body: '# Welcome\nFirst steps.' });
    assert.equal(created.status, 201);
    const page = await created.json();
    assert.equal(page.authorId, editor.principal.identityId);
    assert.equal(page.revision, 1);
    const read = await json(await f.request(`${base}/${page.id}`, viewer));
    assert.equal(read.body, '# Welcome\nFirst steps.');
    assert.equal(read.author, 'Blake');
    assert.equal((await f.request(`${base}/${page.id}`, viewer, { title: 'x', body: 'y', revision: 1 })).status, 404);
    assert.equal((await f.request(`${base}/${page.id}/comments`, viewer, { body: 'Looks good' })).status, 201);
    assert.equal((await f.request(`${base}/${page.id}`, outsider)).status, 404);
    assert.equal((await f.request(`${base}/${page.id}/comments`, outsider, { body: 'hi' })).status, 404);
    assert.equal((await f.request(`${base}/${page.id}/delete`, editor, {})).status, 404);
    assert.equal((await f.request(`${base}/${page.id}/delete`, f.admin, {})).status, 200);
    assert.equal((await f.request(`${base}/${page.id}`, viewer)).status, 404);
    // Unknown fields carry no authority.
    assert.equal((await f.request(base, editor, { title: 'A', body: 'B', authorId: viewer.principal.identityId })).status, 400);
  } finally { await f.close(); }
});

test('pages: every saved version is kept, stale edits are refused and history is append-only', async () => {
  const f = await contentFixture();
  try {
    const { w, editor, viewer, base } = await team(f);
    const page = await json(await f.request(base, editor, { title: 'Plan', body: 'v1' }));
    const second = await f.request(`${base}/${page.id}`, f.admin, { title: 'Plan', body: 'v2', revision: 1 });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).revision, 2);
    assert.equal((await f.request(`${base}/${page.id}`, editor, { title: 'Plan', body: 'stale', revision: 1 })).status, 409);
    await f.request(`${base}/${page.id}`, editor, { title: 'Plan B', body: 'v3', revision: 2 });
    const history = await json(await f.request(`${base}/${page.id}/history`, viewer));
    assert.deepEqual(history.map((v: { revision: number; body: string }) => [v.revision, v.body]), [[3, 'v3'], [2, 'v2'], [1, 'v1']]);
    assert.equal(history[1].editorId, f.admin.principal.identityId);
    assert.equal(history[1].editor, 'Alex');
    const db = new DatabaseSync(join(f.profile.businessDir, 'workspaces', w.id, 'content.db'));
    try { assert.throws(() => db.prepare("UPDATE page_versions SET body='rewritten'").run(), /SARA_EDIT_HISTORY/); } finally { db.close(); }
  } finally { await f.close(); }
});

test('pages: a workspace legal hold blocks deletes at the route and in the database, release allows them', async () => {
  const f = await contentFixture();
  try {
    const { w, editor, base } = await team(f);
    const page = await json(await f.request(base, editor, { title: 'Contract notes', body: 'keep' }));
    await f.request(`${base}/${page.id}/comments`, editor, { body: 'note' });
    await f.seed(w.id, 'HELD_CONTENT');
    const hold = `/api/business/workspaces/${w.id}/hold`;
    assert.equal((await f.request(hold, editor, { on: true })).status, 403);
    assert.equal((await f.request(hold, f.admin, { on: true })).status, 200);
    assert.deepEqual(await json(await f.request(hold, f.admin)), { held: true });
    const refused = await f.request(`${base}/${page.id}/delete`, f.admin, {});
    assert.equal(refused.status, 409);
    // Edits stay possible while held; every version is still kept.
    assert.equal((await f.request(`${base}/${page.id}`, editor, { title: 'Contract notes', body: 'changed', revision: 1 })).status, 200);
    const db = new DatabaseSync(join(f.profile.businessDir, 'workspaces', w.id, 'content.db'));
    try {
      for (const table of ['pages', 'page_versions', 'page_comments', 'messages', 'documents']) assert.throws(() => db.exec(`DELETE FROM ${table}`), /SARA_LEGAL_HOLD/, table);
    } finally { db.close(); }
    assert.equal((await f.request(hold, f.admin, { on: false })).status, 200);
    assert.equal((await f.request(`${base}/${page.id}/delete`, f.admin, {})).status, 200);
    const audit = await json(await f.request(`/api/business/workspaces/${w.id}/audit`));
    assert.ok(audit.some((r: { action: string }) => r.action === 'content.hold'));
  } finally { await f.close(); }
});

test('pages: threaded comments, @mentions notify only named members, resolve rules', async () => {
  const f = await contentFixture();
  try {
    const { w, editor, viewer, outsider, base } = await team(f);
    const page = await json(await f.request(base, f.admin, { title: 'Launch', body: 'Draft' }));
    const top = await json(await f.request(`${base}/${page.id}/comments`, viewer, { body: '@Blake can you check this? cc @Drew' }));
    const reply = await f.request(`${base}/${page.id}/comments`, editor, { body: 'On it @casey reed', parentId: top.id });
    assert.equal(reply.status, 201);
    assert.equal((await f.request(`${base}/${page.id}/comments`, editor, { body: 'bad parent', parentId: randomUUID() })).status, 404);
    const mentions = `/api/business/workspaces/${w.id}/page-mentions`;
    const blake = await json(await f.request(mentions, editor));
    assert.equal(blake.length, 1);
    assert.deepEqual([blake[0].pageId, blake[0].commentId, blake[0].pageTitle, blake[0].by, blake[0].read], [page.id, top.id, 'Launch', 'Casey Reed', false]);
    assert.equal((await json(await f.request(mentions, viewer))).length, 1);
    assert.equal((await json(await f.request(mentions, f.admin))).length, 0);
    // Drew is not a member of this workspace: no mention, and he can't read the list.
    assert.equal((await f.request(mentions, outsider)).status, 404);
    assert.equal((await f.request(mentions + '/read', editor, {})).status, 200);
    assert.equal((await json(await f.request(mentions, editor)))[0].read, true);
    const thread = await json(await f.request(`${base}/${page.id}/comments`, viewer));
    assert.equal(thread.length, 2);
    assert.equal(thread[1].parentId, top.id);
    // A viewer may resolve only their own comment; a contributor may resolve any.
    const own = await json(await f.request(`${base}/${page.id}/comments`, editor, { body: 'mine' }));
    assert.equal((await f.request(`${base}/${page.id}/comments/${own.id}/resolve`, viewer, { resolved: true })).status, 404);
    assert.equal((await f.request(`${base}/${page.id}/comments/${top.id}/resolve`, viewer, { resolved: true })).status, 200);
    assert.equal((await f.request(`${base}/${page.id}/comments/${own.id}/resolve`, editor, { resolved: true })).status, 200);
    const after = await json(await f.request(`${base}/${page.id}/comments`, viewer));
    assert.ok(after.find((c: { id: string }) => c.id === top.id).resolvedAt);
    const list = await json(await f.request(base, viewer));
    assert.equal(list[0].openComments, 1);
  } finally { await f.close(); }
});

test('pages: search matches title and body, export as Markdown and PDF, audit rows', async () => {
  const f = await contentFixture();
  try {
    const { w, editor, viewer, base } = await team(f);
    const a = await json(await f.request(base, editor, { title: 'Expense policy', body: 'Receipts within 30 days.' }));
    await json(await f.request(base, editor, { title: 'Holidays', body: 'Office closed on **public** holidays.' }));
    assert.deepEqual((await json(await f.request(`${base}?q=receipts`, viewer))).map((p: { id: string }) => p.id), [a.id]);
    assert.equal((await json(await f.request(`${base}?q=HOLIDAYS`, viewer))).length, 1);
    assert.equal((await json(await f.request(`${base}?q=nothing-here`, viewer))).length, 0);
    assert.equal((await json(await f.request(base, viewer))).length, 2);
    assert.equal((await f.request(`${base}?q=${'x'.repeat(300)}`, viewer)).status, 400);
    const md = await f.request(`${base}/${a.id}/export?format=md`, viewer);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(md.headers.get('content-disposition') ?? '', /attachment; filename="Expense policy\.md"/);
    assert.equal(await md.text(), '# Expense policy\n\nReceipts within 30 days.\n');
    const pdf = await f.request(`${base}/${a.id}/export?format=pdf`, viewer);
    assert.match(pdf.headers.get('content-type') ?? '', /application\/pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await f.request(`${base}/${a.id}/export?format=exe`, viewer)).status, 400);
    await f.request(`${base}/${a.id}`, editor, { title: 'Expense policy', body: 'Receipts within 60 days.', revision: 1 });
    await f.request(`${base}/${a.id}/comments`, viewer, { body: 'Why 60?' });
    await f.request(`${base}/${a.id}/delete`, f.admin, {});
    const actions = (await json(await f.request(`/api/business/workspaces/${w.id}/audit`))).map((r: { action: string }) => r.action);
    for (const action of ['page.create', 'page.edit', 'page.comment', 'page.delete']) assert.ok(actions.includes(action), action);
  } finally { await f.close(); }
});

test('pages: per-person export holds only that person, delete removes comments and attribution, refused while held', async () => {
  const f = await contentFixture();
  try {
    const { w, editor, viewer, base } = await team(f);
    const mine = await json(await f.request(base, editor, { title: 'Blake page', body: 'BLAKE_TEXT' }));
    const alexPage = await json(await f.request(base, f.admin, { title: 'Alex page', body: 'ALEX_TEXT' }));
    await f.request(`${base}/${alexPage.id}`, editor, { title: 'Alex page', body: 'ALEX_TEXT edited by Blake', revision: 1 });
    await f.request(`${base}/${alexPage.id}/comments`, editor, { body: 'BLAKE_COMMENT' });
    await f.request(`${base}/${alexPage.id}/comments`, viewer, { body: 'CASEY_COMMENT @Blake' });
    const person = `/api/business/org/users/${editor.principal.identityId}`;
    assert.equal((await f.request(person + '/pages-export', editor)).status, 403);
    const exported = await f.request(person + '/pages-export');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
    const text = await exported.text();
    assert.ok(text.includes('BLAKE_TEXT') && text.includes('BLAKE_COMMENT') && text.includes('edited by Blake'));
    assert.ok(!text.includes('CASEY_COMMENT'));
    const data = JSON.parse(text);
    assert.equal(data.workspaces[0].pages.length, 1);
    await f.request(`/api/business/workspaces/${w.id}/hold`, f.admin, { on: true });
    assert.equal((await f.request(person + '/pages-delete', f.admin, { confirm: true })).status, 409);
    await f.request(`/api/business/workspaces/${w.id}/hold`, f.admin, { on: false });
    assert.equal((await f.request(person + '/pages-delete', f.admin, {})).status, 400);
    const receipt = await json(await f.request(person + '/pages-delete', f.admin, { confirm: true }));
    assert.deepEqual([receipt.comments, receipt.mentions, receipt.attributions > 0], [1, 1, true]);
    const comments = await json(await f.request(`${base}/${alexPage.id}/comments`));
    assert.deepEqual(comments.map((c: { body: string }) => c.body), ['CASEY_COMMENT @Blake']);
    const kept = await json(await f.request(`${base}/${mine.id}`));
    assert.equal(kept.body, 'BLAKE_TEXT');
    assert.equal(kept.authorId, null);
    assert.ok(!(await (await f.request(person + '/pages-export')).text()).includes('BLAKE'));
    const org = await json(await f.request('/api/business/org/audit'));
    assert.ok(org.some((r: { action: string }) => r.action === 'page.person.delete'));
  } finally { await f.close(); }
});

test('pages: Sara reads a selected page and its open comments as untrusted context', async () => {
  const f = await contentFixture(); const seen: string[] = [];
  setNetTransport(async (_url, init) => {
    seen.push(String(init?.body));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Summary.' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const { w, editor, viewer, base } = await team(f);
    f.runtime.configureModels({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 1_000_000, maxConcurrent: 3,
      models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false }, model: 'fixture', cloud: false,
        inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 2000, tone: 'professional' }],
      workspaces: { [w.id]: { modelId: 'local', allowanceNanoUsd: 1_000_000 } } });
    const page = await json(await f.request(base, editor, { title: 'Roadmap', body: 'PAGE_BODY_CANARY' }));
    await f.request(`${base}/${page.id}/comments`, viewer, { body: 'OPEN_COMMENT_CANARY' });
    const done = await json(await f.request(`${base}/${page.id}/comments`, viewer, { body: 'RESOLVED_COMMENT_CANARY' }));
    await f.request(`${base}/${page.id}/comments/${done.id}/resolve`, viewer, { resolved: true });
    const ws = `/api/business/workspaces/${w.id}`;
    const conversation = await json(await f.request(ws + '/conversations', editor, { title: 'Pages' }));
    const policy = await json(await f.request(ws + '/model-policy', editor));
    const send = (pageIds: string[]) => f.request(`${ws}/conversations/${conversation.id}/messages`, editor, { requestId: randomUUID(), text: 'Summarize the comments', documentIds: [], pageIds, modelPolicy: policy.policyHash, acknowledgeDisclosure: true });
    assert.equal((await send([randomUUID()])).status, 404);
    const r = await send([page.id]);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).answer, 'Summary.');
    const wire = seen.at(-1)!;
    assert.ok(wire.includes('PAGE_BODY_CANARY') && wire.includes('OPEN_COMMENT_CANARY'));
    assert.ok(!wire.includes('RESOLVED_COMMENT_CANARY'));
    assert.ok(wire.includes('untrusted'));
    // Nothing was written to pages by the assistant: drafts need the member to save them.
    assert.equal((await json(await f.request(base, editor))).length, 1);
  } finally { setNetTransport(); await f.close(); }
});

test('pages: the business shell serves the Pages module and every page control has a tip', async () => {
  const f = await contentFixture();
  try {
    const script = await fetch(f.runtime.origin + '/business-pages.js');
    assert.equal(script.status, 200);
    const source = await script.text();
    assert.match(await (await fetch(f.runtime.origin + '/')).text(), /id="tab-pages"/);
    for (const id of ['tp-search', 'tp-comment', 'tp-title', 'tp-text', 'tp-person']) assert.match(source, new RegExp(`${id}'; [^\n]*dataset\\.tip = t\\(`), id);
  } finally { await f.close(); }
});
