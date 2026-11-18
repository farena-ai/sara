// U1.4 (docs/CHECKS.md): the two-server pair check. Starts TWO throwaway Sara servers in this process
// (each its own temp data folder and loopback port, a scripted fake model, a fake T1 repair world) and
// runs everything that crosses between linked servers through their real HTTP APIs: link code → link,
// one-to-one messages both ways (+ the T4 notice state), a community (create, invite, post, @mention,
// kick, ban), retention, a help pass (S9b: grant, look, propose, approve, revoke), a fix pass (T5:
// request, accept, look, plan, step OKs, undo, plan OK, stop) and unlink. Asserts at every step;
// writes outputs/checks/pair-<date>.md. Never the owner's Sara, data or servers.
//
//   node scripts/check-pair.ts            (exit code 1 when a step failed)
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CheckRun, check, throwawayEnv, until } from './checks-lib.ts';

throwawayEnv();
// The servers' one-line request log (console.info) would drown the steps.
console.info = () => {};
const { makeApp, tempDir, ROOT } = await import('../test/helpers.ts');
const { OwnerAuth } = await import('../src/auth.ts');
const { createSaraServer } = await import('../src/server.ts');
const { Messenger } = await import('../src/messages.ts');
const { Repair } = await import('../src/repair.ts');
const { setSelfCode } = await import('../src/self-code.ts');
const { supportOf } = await import('../src/support.ts');
const { remoteRepairOf } = await import('../src/remote-repair.ts');

const run = new CheckRun('Sara pair check (two linked servers)');
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type J = Record<string, any>;

interface Node {
  name: string;
  app: any;
  m: any;
  srv: any;
  base: string;
  tmp: { dir: string; cleanup(): void };
  notices: { title: string; body: string; chat: string; kind?: string; mention?: boolean }[];
  st: { addons: { id: string; name: string; version: string; status: string; enabled: boolean }[]; skills: Map<string, string>; gate: Promise<void> | null };
  req(method: string, path: string, body?: unknown): Promise<J>;
  raw(method: string, path: string, body?: unknown): Promise<Response>;
}
const nodes: Node[] = [];

async function start(name: string): Promise<Node> {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, { get now() { return new Date(); } } as never);
  app.settings.update({ ownerName: name, providers: [{ id: 'p', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9' }], defaultProviderId: 'p', defaultModel: 'fake', fallbackAfterSec: 60, disclosureAcceptedAt: new Date().toISOString(), setupDone: true } as never);
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, name: () => name, fetch: (u: string, i: RequestInit) => fetch(u, i) });
  app.messages = m;
  const notices: Node['notices'] = [];
  // Wired like main.ts: changes and notices reach the open pages (the T4 popup card listens for `notice`).
  m.onChange = (chat: string) => app.events?.publish({ type: 'pm', chat } as never);
  m.onNotify = (title: string, body: string, chat: string, info?: { kind: string; mention: boolean }) => {
    notices.push({ title, body, chat, ...(info ?? {}) });
    app.events?.publish({ type: 'pm', chat, notice: true } as never);
  };
  supportOf(app)!.onChange = (chat: string) => app.events?.publish({ type: 'pm', chat } as never);
  // The helped side's own T1 engine over a small fake world: a crashed add-on and a tool failing 3 times.
  const st: Node['st'] = { addons: [{ id: 'weather', name: 'Weather', version: '1.0.0', status: 'crashed', enabled: true }], skills: new Map(), gate: null };
  app.repair = new Repair(
    {
      now: () => new Date(),
      settings: { get: () => app.settings.get(), update: (p: never) => app.settings.update(p) },
      audit: () => {},
      health: () => [{ name: 'Memory', ok: true, detail: 'ok' }],
      history: () => ({ turns: 10, failed: 0 }),
      turnErrors: () => [],
      toolErrors: () => [1, 2, 3].map((i) => ({ at: new Date(Date.now() - i * 60_000).toISOString(), tool: 'web_fetch' })),
      trouble: () => [],
      addons: {
        list: () => st.addons,
        restart: async () => {
          if (st.gate) await st.gate;
        },
        setEnabled: async (id: string, on: boolean) => {
          const a = st.addons.find((x) => x.id === id)!;
          a.enabled = on;
          a.status = on ? 'crashed' : 'stopped';
        },
      },
      grow: { skill: (d: { name: string; body: string }) => (st.skills.set(d.name, d.body), { name: d.name, scope: 'companion' }), removeSkill: (_s: string, n: string) => void st.skills.delete(n) },
    } as never,
    new DatabaseSync(':memory:'),
  );
  setSelfCode(app, { status: () => ({ available: true }), start: (request: string) => ({ id: 1, status: 'working', request }) } as never);
  const auth = new OwnerAuth(tmp.dir, () => new Date());
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const raw = (method: string, path: string, body?: unknown) => fetch(base + '/api' + path, { method, headers: { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const j = (await r.json().catch(() => ({}))) as J;
    if (!r.ok) throw new Error(`${name}: ${method} ${path} → ${r.status} ${String(j.error ?? '')}`);
    return j;
  };
  const n: Node = { name, app, m, srv, base, tmp, notices, st, req, raw };
  nodes.push(n);
  return n;
}

const chatsOf = async (n: Node) => (await n.req('GET', '/messages')).chats as J[];
const direct = async (n: Node) => (await chatsOf(n)).find((c) => c.kind === 'direct' && c.status === 'active');
const msgs = async (n: Node, chat: string) => (await n.req('GET', `/messages/chats/${chat}`)).messages as J[];
const has = async (n: Node, chat: string, text: string) => (await msgs(n, chat)).some((x) => String(x.text ?? '').includes(text));
const helpedPlan = async (n: Node) => ((await n.req('GET', '/remote-repair')).plans as J[]).find((p) => p.side === 'in' && !['done', 'stopped', 'failed'].includes(p.status)) ?? ((await n.req('GET', '/remote-repair')).plans as J[]).filter((p) => p.side === 'in').at(-1);
const settled = (p: J | undefined) => Boolean(p && ['done', 'stopped', 'failed'].includes(p.status));

let hank!: Node;
let sam!: Node;
const ids: J = {};
try {
  run.group('Two throwaway servers');
  await run.step('start Hank (helped) and Sam (helper)', async () => {
    hank = await start('Hank');
    sam = await start('Sam');
    for (const n of [hank, sam]) await n.req('PUT', '/messages/settings', { url: n.base });
    return `${hank.base} and ${sam.base}, separate data folders`;
  });

  run.group('Link');
  await run.step('link code → link (Hank invites, Sam joins)', async () => {
    const { code, expiresAt } = await hank.req('POST', '/messages/invite', {});
    check(typeof code === 'string' && code.length > 20, 'no link code');
    ids.code = code;
    const joined = await sam.req('POST', '/messages/join', { code });
    ids.samChat = joined.chat.id;
    ids.samLink = joined.chat.linkId;
    const h = await until(() => direct(hank), 'Hank to see the link');
    ids.hankChat = h.id;
    ids.hankLink = h.linkId;
    check(h.title === 'Sam' && joined.chat.title === 'Hank', `names: ${h.title} / ${joined.chat.title}`);
    return `code expires ${expiresAt}; both sides show the other by name`;
  });
  await run.step('a used link code does not work twice', async () => {
    const again = await sam.raw('POST', '/messages/join', { code: ids.code });
    check(again.status >= 400, `second join answered ${again.status}`);
    const n = (await chatsOf(sam)).filter((c) => c.kind === 'direct').length;
    check(n === 1, `${n} one-to-one chats after a second try`);
    return `second use → ${again.status}; still one chat`;
  });

  run.group('One-to-one messages');
  await run.step('Hank → Sam arrives, with a notice on Sam\'s side', async () => {
    sam.notices.length = 0;
    await hank.req('POST', `/messages/chats/${ids.hankChat}/send`, { text: 'Are we still on for Sunday?' });
    const chat = (await until(async () => (await chatsOf(sam)).find((c) => c.kind === 'direct' && c.status === 'active' && c.unread > 0), 'Sam to get it'));
    ids.samChat = chat.id;
    check(await has(sam, chat.id, 'Sunday'), 'text missing on Sam');
    const nt = await until(() => sam.notices.find((x) => x.body.includes('Sunday')), 'the notice');
    check(nt.kind === 'direct', `notice kind ${nt.kind}`);
    return `notice "${nt.title}: ${nt.body}" (kind ${nt.kind})`;
  });
  await run.step('notice state: unread count, then read clears it', async () => {
    const before = (await sam.req('GET', '/messages')).unread;
    check(before >= 1, `unread ${before}`);
    await sam.req('POST', `/messages/chats/${ids.samChat}/read`, {});
    const after = (await sam.req('GET', '/messages')).unread;
    check(after === 0, `unread after read ${after}`);
    return `unread ${before} → ${after}`;
  });
  await run.step('Sam → Hank arrives, with a notice on Hank\'s side', async () => {
    hank.notices.length = 0;
    await sam.req('POST', `/messages/chats/${ids.samChat}/send`, { text: 'Yes, 7 am at the trail.' });
    await until(() => has(hank, ids.hankChat, '7 am'), 'Hank to get it');
    const nt = await until(() => hank.notices.find((x) => x.body.includes('7 am')), 'the notice');
    return `notice "${nt.title}: ${nt.body}"`;
  });
  await run.step('popups off: the message still arrives (unread), the setting is kept', async () => {
    await hank.req('PUT', '/messages/settings', { popup: false });
    await sam.req('POST', `/messages/chats/${ids.samChat}/send`, { text: 'Bring water.' });
    await until(() => has(hank, ids.hankChat, 'Bring water'), 'the message');
    const s = (await hank.req('GET', '/messages')).settings;
    check(s.popup === false, 'popup setting not saved');
    await hank.req('PUT', '/messages/settings', { popup: true });
    return `unread ${(await hank.req('GET', '/messages')).unread}, popup setting ${s.popup}`;
  });

  run.group('Community');
  await run.step('Hank creates "Trail runners" and invites Sam', async () => {
    const club = (await hank.req('POST', '/messages/communities', { name: 'Trail runners' })).chat;
    ids.club = club.id;
    const code = (await hank.req('GET', `/messages/chats/${club.id}`)).code;
    check(code, 'the host has no invite code');
    ids.samClub = (await sam.req('POST', '/messages/join', { code })).chat.id;
    const members = await until(async () => {
      const ms = (await hank.req('GET', `/messages/chats/${club.id}`)).members as J[];
      return ms.length >= 2 && ms;
    }, 'Sam in the member list');
    return `members: ${members.map((x) => `${x.name} (${x.role})`).join(', ')}`;
  });
  await run.step('a plain post reaches Sam quietly (no popup notice)', async () => {
    sam.notices.length = 0;
    await hank.req('POST', `/messages/chats/${ids.club}/send`, { text: 'Trail is muddy, wear the good shoes.' });
    await until(() => has(sam, ids.samClub, 'muddy'), 'the post on Sam');
    await sleep(300);
    check(!sam.notices.some((x) => x.body.includes('muddy')), 'a plain community post made a notice');
    return 'arrived; no notice (community default: mentions only)';
  });
  await run.step('an @mention notifies Sam', async () => {
    await hank.req('POST', `/messages/chats/${ids.club}/send`, { text: '@Sam can you lead the 10k?' });
    const nt = await until(() => sam.notices.find((x) => x.body.includes('10k')), 'the mention notice');
    check(nt.mention === true, 'not marked as a mention');
    return `notice "${nt.title}: ${nt.body}" (mention)`;
  });
  await run.step('Sam posts back; the host relays it', async () => {
    await sam.req('POST', `/messages/chats/${ids.samClub}/send`, { text: 'Sure, see you there.' });
    await until(() => has(hank, ids.club, 'see you there'), 'the post on Hank');
    return 'Hank sees Sam\'s post';
  });
  await run.step('kick: Sam is removed, then can rejoin with a new code', async () => {
    const member = ((await hank.req('GET', `/messages/chats/${ids.club}`)).members as J[]).find((x) => x.name === 'Sam');
    check(member, 'Sam not in the member list');
    await hank.req('POST', `/messages/communities/${ids.club}/members/${member.id}`, { action: 'kick' });
    const gone = await until(async () => (await chatsOf(sam)).find((c) => c.id === ids.samClub && c.status !== 'active'), 'Sam to be told');
    const code = (await hank.req('POST', `/messages/communities/${ids.club}/code`, {})).code;
    ids.samClub = (await sam.req('POST', '/messages/join', { code })).chat.id;
    await until(async () => ((await hank.req('GET', `/messages/chats/${ids.club}`)).members as J[]).some((x) => x.name === 'Sam'), 'Sam back');
    return `Sam's copy went "${gone.status}"; rejoined`;
  });
  await run.step('ban: Sam is removed and a new code no longer lets him in', async () => {
    const member = ((await hank.req('GET', `/messages/chats/${ids.club}`)).members as J[]).find((x) => x.name === 'Sam');
    check(member, 'Sam not in the member list');
    await hank.req('POST', `/messages/communities/${ids.club}/members/${member.id}`, { action: 'ban' });
    await until(async () => (await chatsOf(sam)).find((c) => c.id === ids.samClub && c.status !== 'active'), 'Sam to be told');
    const code = (await hank.req('POST', `/messages/communities/${ids.club}/code`, {})).code;
    const r = await sam.raw('POST', '/messages/join', { code });
    const j = (await r.json().catch(() => ({}))) as J;
    check(r.status >= 400, `a banned member joined again (${r.status})`);
    return `rejoin → ${r.status} "${String(j.error ?? '').slice(0, 80)}"`;
  });

  run.group('Retention');
  await run.step('a chat kept 1 day loses old messages; the one-to-one chat (30 days) keeps them', async () => {
    await hank.req('PATCH', `/messages/chats/${ids.club}`, { retentionDays: 1 });
    const n0 = (await msgs(hank, ids.club)).length;
    const d0 = (await msgs(hank, ids.hankChat)).length;
    await hank.m.due(new Date(Date.now() + 2 * 86_400_000));
    const n1 = (await msgs(hank, ids.club)).length;
    const d1 = (await msgs(hank, ids.hankChat)).length;
    check(n0 > 0 && n1 === 0, `community ${n0} → ${n1}`);
    check(d1 === d0 && d0 > 0, `one-to-one ${d0} → ${d1}`);
    return `community ${n0} → ${n1}; one-to-one ${d0} → ${d1}`;
  });

  run.group('Help pass (S9b)');
  await run.step('Hank grants Sam a 1-hour help pass', async () => {
    const pass = (await hank.req('POST', '/support/passes', { link: ids.hankLink, hours: 1, note: 'my model keeps timing out' })).pass;
    ids.helpPass = pass.id;
    const held = await until(async () => ((await sam.req('GET', '/support')).held as J[]).find((p) => p.active !== false), 'the pass on Sam');
    return `given ${pass.id.slice(0, 6)}…, Sam holds it until ${held.expiresAt ?? '?'}`;
  });
  await run.step('Sam looks (redacted report)', async () => {
    const look = await sam.req('POST', '/support/look', { link: ids.samLink });
    check(look.peer === 'Hank' && look.report, 'no report');
    const text = JSON.stringify(look.report);
    check(!text.includes(hank.tmp.dir), 'the report shows a data folder path');
    return `${Object.keys(look.report).length} report parts, ${(look.findings ?? []).length} findings`;
  });
  await run.step('Sam proposes a change; nothing changes before Hank\'s OK', async () => {
    const p = (await sam.req('POST', '/support/propose', { link: ids.samLink, changes: [{ path: 'fallbackAfterSec', value: 30 }], note: 'switch sooner' })).proposal;
    const mine = await until(async () => ((await hank.req('GET', '/support')).proposals as J[]).find((x) => x.status === 'waiting' || x.status === 'pending' || !x.status), 'the proposal on Hank');
    ids.proposal = mine.id;
    check(hank.app.settings.get().fallbackAfterSec === 60, 'changed before the OK');
    return `proposal ${String(p.id).slice(0, 6)}… waiting`;
  });
  await run.step('Hank approves: the setting changes', async () => {
    await hank.req('POST', `/support/proposals/${ids.proposal}`, { approve: true });
    check(hank.app.settings.get().fallbackAfterSec === 30, `fallbackAfterSec ${hank.app.settings.get().fallbackAfterSec}`);
    return 'fallbackAfterSec 60 → 30';
  });
  await run.step('Hank revokes: Sam can no longer look', async () => {
    await hank.req('DELETE', `/support/passes/${ids.helpPass}`);
    const r = await until(async () => {
      const x = await sam.raw('POST', '/support/look', { link: ids.samLink });
      return x.status === 403 && x;
    }, 'the look to be refused');
    return `look → ${r.status}`;
  });

  run.group('Fix pass (T5)');
  await run.step('Hank asks Sam for a fix pass ("each step"); Sam accepts', async () => {
    const r = await hank.req('POST', '/remote-repair/requests', { link: ids.hankLink, problem: "I can't get the weather add-on working", hours: 24, scope: 'each' });
    const held = await until(async () => ((await sam.req('GET', '/remote-repair')).held as J[]).find((p) => p.status === 'asked'), 'the request on Sam');
    await sam.req('POST', `/remote-repair/passes/${held.id}/accept`, { accept: true });
    ids.fixGiven = r.pass.id;
    return `pass ${String(r.pass.id).slice(0, 6)}… accepted`;
  });
  await run.step('Sam looks and finds the crashed add-on', async () => {
    const look = await sam.req('POST', '/remote-repair/look', { link: ids.samLink });
    const ps = (look.problems as J[]).map((p) => p.id ?? p.problem ?? p.key);
    check(JSON.stringify(look.problems).includes('weather'), `problems: ${JSON.stringify(ps)}`);
    return `scope ${look.scope}; problems ${ps.join(', ')}`;
  });
  await run.step('Sam sends a plan; Hank OKs step 1 only', async () => {
    const sent = await sam.req('POST', '/remote-repair/plans', { link: ids.samLink, note: 'restart, then wait longer', steps: [{ kind: 'fix', problem: 'addon:weather' }, { kind: 'setting', path: 'fallbackAfterSec', value: 120 }] });
    ids.samPlan = sent.plan.id;
    let p = await until(() => helpedPlan(hank), 'the plan on Hank');
    check(p.status === 'waiting', `plan ${p.status}`);
    const plOk = await hank.raw('POST', `/remote-repair/plans/${p.id}/approve`, { approve: true });
    check(plOk.status === 409, `plan-level OK on an "each" pass → ${plOk.status}`);
    await hank.req('POST', `/remote-repair/plans/${p.id}/steps/0`, { approve: true });
    p = await until(async () => {
      const x = await helpedPlan(hank);
      return x?.steps[0].status === 'done' && x;
    }, 'step 1 done');
    check(p.steps[1].status === 'waiting', `step 2 ${p.steps[1].status}`);
    check(hank.app.settings.get().fallbackAfterSec === 30, 'step 2 ran without its own OK');
    ids.hankPlan = p.id;
    return `steps ${p.steps.map((s: J) => s.status).join(', ')}`;
  });
  await run.step('Hank OKs step 2; the plan ends; Sam sees the report', async () => {
    await hank.req('POST', `/remote-repair/plans/${ids.hankPlan}/steps/1`, { approve: true });
    const p = await until(async () => {
      const x = ((await hank.req('GET', '/remote-repair')).plans as J[]).find((q) => q.id === ids.hankPlan);
      return settled(x) && x;
    }, 'the plan end');
    check(hank.app.settings.get().fallbackAfterSec === 120, `fallbackAfterSec ${hank.app.settings.get().fallbackAfterSec}`);
    const out = await until(async () => {
      const x = ((await sam.req('GET', '/remote-repair')).plans as J[]).find((q) => q.id === ids.samPlan);
      return settled(x) && x?.report && x;
    }, 'the report on Sam');
    return `${p.status}; Sam's copy: ${out.steps.map((s: J) => s.status).join(', ')}`;
  });
  await run.step('undo step 1 puts the add-on back as it was', async () => {
    const before = hank.st.addons[0].enabled;
    await hank.req('POST', `/remote-repair/plans/${ids.hankPlan}/steps/0/undo`);
    check(hank.st.addons[0].enabled === true, 'add-on not back on');
    const runRow = hank.app.repair.runs().find((r: J) => r.problem === 'addon:weather');
    check(runRow?.by === 'link:Sam', `T1 row by ${runRow?.by}`);
    return `enabled ${before} → ${hank.st.addons[0].enabled}; T1 row marked ${runRow.by}`;
  });
  await run.step('"within this pass": one plan OK, then Stop ends after the current step', async () => {
    await hank.req('DELETE', `/remote-repair/passes/${ids.fixGiven}`);
    const r = await hank.req('POST', '/remote-repair/requests', { link: ids.hankLink, problem: 'the weather add-on again', hours: 1, scope: 'pass' });
    const held = await until(async () => ((await sam.req('GET', '/remote-repair')).held as J[]).find((p) => p.status === 'asked'), 'the request');
    await sam.req('POST', `/remote-repair/passes/${held.id}/accept`, { accept: true });
    hank.st.addons[0].status = 'crashed';
    let release!: () => void;
    hank.st.gate = new Promise<void>((ok) => (release = ok));
    const sent = await sam.req('POST', '/remote-repair/plans', { link: ids.samLink, steps: [{ kind: 'fix', problem: 'addon:weather' }, { kind: 'setting', path: 'fallbackAfterSec', value: 300 }] });
    const p0 = await until(async () => {
      const x = await helpedPlan(hank);
      return x && x.status === 'waiting' && x.id !== ids.hankPlan && x;
    }, 'the second plan');
    await hank.req('POST', `/remote-repair/plans/${p0.id}/approve`, { approve: true });
    await until(async () => ((await hank.req('GET', '/remote-repair')).plans as J[]).find((q) => q.id === p0.id)?.steps[0].status === 'running', 'step 1 running');
    await sam.req('POST', `/remote-repair/plans/${sent.plan.id}/stop`);
    release();
    hank.st.gate = null;
    const p = await until(async () => {
      const x = ((await hank.req('GET', '/remote-repair')).plans as J[]).find((q) => q.id === p0.id);
      return settled(x) && x;
    }, 'stopped');
    check(p.status === 'stopped' && p.steps[1].status === 'skipped', `${p.status}: ${p.steps.map((s: J) => s.status)}`);
    check(hank.app.settings.get().fallbackAfterSec === 120, 'the skipped step ran');
    await hank.req('DELETE', `/remote-repair/passes/${r.pass.id}`);
    return `${p.status}: ${p.steps.map((s: J) => s.status).join(', ')}; pass revoked`;
  });

  run.group('Unlink');
  await run.step('Hank unlinks; Sam\'s chat ends and sending is refused', async () => {
    await hank.req('DELETE', `/messages/links/${ids.hankLink}`);
    const s = await until(async () => (await chatsOf(sam)).find((c) => c.id === ids.samChat && c.status !== 'active'), 'Sam to be told');
    const r = await sam.raw('POST', `/messages/chats/${ids.samChat}/send`, { text: 'still there?' });
    check(r.status >= 400, `send after unlink → ${r.status}`);
    const h = await hank.raw('POST', '/remote-repair/requests', { link: ids.hankLink, problem: 'x', hours: 1, scope: 'each' });
    check(h.status >= 400, `a fix pass request after unlink → ${h.status}`);
    return `Sam's chat "${s.status}"; send → ${r.status}; fix pass → ${h.status}`;
  });
} catch (err) {
  run.skip('stopped early', (err as Error).message);
} finally {
  for (const n of nodes) {
    await remoteRepairOf(n.app)?.idle?.().catch(() => undefined);
    await new Promise<void>((ok) => {
      n.srv.closeAllConnections?.();
      n.srv.close(() => ok());
    });
    n.m.close();
    n.app.store.close();
  }
  for (const n of nodes) n.tmp.cleanup();
}
const file = run.report(ROOT, 'pair', ['Two throwaway in-process Sara servers on loopback ports with their own temp data folders and a fake model; every step goes through the real HTTP API of each server and the signed calls between them.']);
console.log(`\n${run.steps.length - run.failed} of ${run.steps.length} steps passed. Report: ${file}`);
process.exit(run.failed ? 1 : 0);
