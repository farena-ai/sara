// 3.1.1 move-in fixtures: a Hermes Agent home shaped like a real one (installs, venvs, caches, browser
// data, a junction, helper/subagent sessions, a compression chain), the python to run the collector
// with, and a Sara app ready for a move-in. All data is made up (owner "Alex").
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, makeApp } from './helpers.ts';
import { SkillStore } from '../src/skill-store.ts';
import { boardFor } from '../src/board.ts';

const made: string[] = [];
/** A scratch folder removed by cleanupScratch() (call it from the test file's after()). */
export function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `sara-mi-${name}-`));
  made.push(d);
  return d;
}
export function cleanupScratch(): void {
  for (const r of made.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* a database still open on Windows: the OS temp cleanup takes it */
    }
  }
}

export const PY = (() => {
  for (const cmd of ['python3', 'python', 'py']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && Number(r.stdout.trim()) >= 306) return cmd;
  }
  return undefined;
})();

export const put = (base: string, rel: string, text: string | Buffer) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
export const T0 = Date.parse('2026-10-01T12:00:00Z') / 1000;

/** A Hermes home shaped like a real one: the companion is small, the rest is huge. */
export function realisticHermes(root: string, opts: { bulk?: number } = {}): string {
  const home = join(root, 'hermes');
  put(home, 'SOUL.md', '# Wren\n\nName: Wren\n\nWarm, curious, a little dry.\n');
  put(home, 'memories/MEMORY.md', 'Alex likes tea.\n§\nThe garden project starts in spring.\n');
  put(home, 'memories/USER.md', 'Alex lives in Lyon.\n§\nAlex works as a nurse.\n');
  put(home, 'config.yaml', 'model:\n  default: some-model\n');
  put(home, '.env', 'OPENAI_API_KEY=not-a-real-key\n');
  // A coding skill whose instructions say "diagnose" and "doctor": not a health record.
  put(home, 'skills/software/debugging/SKILL.md', '---\nname: debugging\ndescription: Find the root cause of a bug before fixing it.\n---\n\nDiagnose the failure first. Run `hermes doctor` when the install looks broken.\n');
  put(home, 'skills/health/med-reminders/SKILL.md', '---\nname: med-reminders\ndescription: Keeps track of medication times.\n---\n\nAsk which pills and when.\n');
  put(home, 'skills/.hub/index.json', '{}');
  put(home, 'skills/.curator_ledger.jsonl', '{}\n');
  // The bulk: installs with Python environments, caches, browser data, models, logs.
  const bulk = opts.bulk ?? 1500;
  for (let i = 0; i < bulk; i++) put(home, `installs/abc/environments/e1/venv/Lib/site-packages/pkg${i % 50}/mod${i}.py`, 'x = 1\n');
  for (let i = 0; i < 200; i++) put(home, `cache/web/${i}.json`, '{}');
  for (let i = 0; i < 100; i++) put(home, `browser/Default/Cache/f${i}`, 'b');
  put(home, 'bin/tool.exe', Buffer.alloc(2048, 1));
  put(home, 'logs/agent.log', 'log\n');
  put(home, 'models_dev_cache.json', '{"big": true}');
  put(home, 'projects.db', 'not a companion db');
  // A junction / link pointing outside: never followed.
  const outside = join(root, 'outside');
  put(outside, 'SECRET-OUTSIDE.md', 'must never be packed');
  try {
    symlinkSync(outside, join(home, 'skills', 'linked'), 'junction');
  } catch {
    /* no links here */
  }
  // state.db: the real Hermes columns that matter (end_reason, source=subagent, parent chains).
  const db = new DatabaseSync(join(home, 'state.db'));
  db.exec(`CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (40);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1, message_uid TEXT);`);
  const s = db.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?, ?, ?, ?, ?)');
  const m = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES (?, ?, ?, ?, ?)');
  let uid = 0;
  const talk = (sid: string, at: number, n: number) => {
    for (let k = 0; k < n; k++) m.run(sid, k % 2 ? 'assistant' : 'user', `${sid} line ${k}`, at + k * 10, `u${++uid}`);
  };
  // 1: a desktop chat; 2: a compression continuation of 1; 3: a chat opened from 1 (startup_orphan_reap
  // on the parent, starts before the parent "ended"); 4: a local chat; 5,6: its helpers (subagents).
  s.run('d1', 'desktop', null, T0, T0 + 9000, 'compression', 'Trip planning');
  talk('d1', T0, 4);
  s.run('d1b', 'desktop', 'd1', T0 + 9000, T0 + 9500, 'agent_close', 'Trip planning');
  talk('d1b', T0 + 9001, 2);
  s.run('d2', 'desktop', 'd1', T0 + 3600, T0 + 4000, 'agent_close', 'Garden ideas');
  talk('d2', T0 + 3600, 2);
  s.run('l1', 'local', null, T0 + 86400, T0 + 90000, 'agent_close', 'Code work');
  talk('l1', T0 + 86400, 2);
  s.run('sa1', 'subagent', 'l1', T0 + 86500, T0 + 86600, 'agent_close', 'helper');
  talk('sa1', T0 + 86500, 6);
  s.run('sa2', 'subagent', 'l1', T0 + 86700, T0 + 86800, 'agent_close', 'helper');
  talk('sa2', T0 + 86700, 6);
  db.close();
  return home;
}

export function app(name: string) {
  const dir = scratch(name);
  const a = makeApp(dir, { now: new Date('2026-10-31T15:00:00Z') });
  a.settings.update({ ownerName: 'Alex', timeZone: 'Europe/Paris' });
  a.skills = new SkillStore(a.store.db, { companionDir: join(dir, 'skills'), builtinDir: join(ROOT, 'skills') });
  a.board = boardFor(a.planner!);
  a.defaultPersonaPath = join(ROOT, 'persona', 'sara.json');
  a.skills.list();
  return a;
}


/**
 * An OpenClaw home laid out like a real 2026.11 install (made by `openclaw onboard` + three chats +
 * two `openclaw cron add` jobs, then rebuilt here with made-up content): chats in the agent database
 * (transcript_events + its active branch), automations in state/openclaw.sqlite (cron_jobs.job_json,
 * plus OpenClaw's own declared jobs), and the setup's untouched AGENTS.md/SOUL.md recorded by hash.
 */
export function openclaw2611(root: string): { state: string; ws: string } {
  const state = join(root, '.openclaw');
  const ws = join(state, 'workspace');
  const agentsTemplate = '# AGENTS.md - Your Workspace\n\n- Keep workspace conventions here.\n- Prefer `trash` over `rm`.\n- Ask first before public actions.\n';
  const soulTemplate = '# SOUL.md - Who You Are\n\nBe genuinely helpful, not performatively helpful.\n';
  put(ws, 'AGENTS.md', agentsTemplate);
  put(ws, 'SOUL.md', soulTemplate);
  put(ws, 'IDENTITY.md', '# IDENTITY.md - Who Am I?\n\n- **Name:** Juniper\n- **Vibe:** warm, curious, a little dry\n');
  put(ws, 'USER.md', '# USER.md - User Model\n\n<!-- observed: 2026-11-01 | status: active -->\n- Call them Alex.\n\n<!-- observed: 2026-11-03 | status: active -->\n- Alex lives in Lyon.\n');
  put(ws, 'MEMORY.md', '# MEMORY.md\n\n- Alex hikes most Sundays.\n- Alex grows tomatoes on the balcony.\n');
  put(ws, 'skills/stargazing/SKILL.md', '---\nname: stargazing\ndescription: Plan a night of looking at planets.\n---\n\nCheck the weather first.\n');
  put(state, 'openclaw.json', JSON.stringify({ agents: { defaults: { workspace: ws } } }));
  mkdirSync(join(state, 'agents', 'main', 'agent'), { recursive: true });
  mkdirSync(join(state, 'state'), { recursive: true });
  const st = new DatabaseSync(join(state, 'state', 'openclaw.sqlite'));
  st.exec(`CREATE TABLE workspace_generated_bootstrap_hashes (workspace_key TEXT, filename TEXT, sha256 TEXT);
    CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, declaration_key TEXT, name TEXT, enabled INTEGER, payload_kind TEXT, job_json TEXT);
    CREATE TABLE device_identities (id TEXT, public_key TEXT);`);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const h = st.prepare('INSERT INTO workspace_generated_bootstrap_hashes VALUES (?, ?, ?)');
  h.run('w', 'AGENTS.md', sha(agentsTemplate));
  h.run('w', 'SOUL.md', sha(soulTemplate));
  h.run('w', 'IDENTITY.md', sha('the template, since changed'));
  const cj = st.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?)');
  const job = (id: string, name: string, expr: string, message: string) => JSON.stringify({ id, name, enabled: true, schedule: { kind: 'cron', expr }, sessionTarget: 'isolated', payload: { kind: 'agentTurn', message } });
  cj.run('k', 'j1', 'memory-core:memory-dreaming-promotion', 'Memory Dreaming Promotion', 1, 'agentTurn', job('j1', 'Memory Dreaming Promotion', '0 3 * * *', 'promote'));
  cj.run('k', 'j2', null, 'Morning check-in', 1, 'agentTurn', job('j2', 'Morning check-in', '0 8 * * *', 'Good morning check-in'));
  cj.run('k', 'j3', null, 'Water the tomatoes', 1, 'agentTurn', job('j3', 'Water the tomatoes', '0 19 * * 2,5', 'Remind Alex to water the tomatoes'));
  cj.run('k', 'j4', 'heartbeat:main', 'heartbeat-main', 1, 'heartbeat', JSON.stringify({ id: 'j4', name: 'heartbeat-main', schedule: { kind: 'every', everyMs: 1800000 } }));
  st.close();
  const ag = new DatabaseSync(join(state, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));
  ag.exec(`CREATE TABLE acp_parent_stream_events (session_id TEXT, seq INTEGER, event_json TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER, event_zstd BLOB, message_role TEXT);
    CREATE TABLE session_transcript_active_events (session_id TEXT, active_position INTEGER, event_seq INTEGER, message_position INTEGER, context_eligible INTEGER);
    CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT);`);
  const ev = ag.prepare('INSERT INTO transcript_events (session_id, seq, event_json, message_role) VALUES (?, ?, ?, ?)');
  const act = ag.prepare('INSERT INTO session_transcript_active_events VALUES (?, ?, ?, NULL, 1)');
  const node = ag.prepare('INSERT INTO session_nodes VALUES (?, ?, ?)');
  const chats: [string, string, string, string][] = [
    ['s-main', 'agent:main:main', "Hi, I'm Alex. I like hiking on Sundays.", 'Lovely to meet you, Alex.'],
    ['stars-1', 'agent:main:explicit:stars-1', 'Can we look at Saturn this week?', 'Saturn is up after nine.'],
    ['garden-1', 'agent:main:explicit:garden-1', 'Do tomatoes grow on a balcony?', 'Yes, with six hours of sun.'],
  ];
  chats.forEach(([sid, key, q, a], k) => {
    const t0 = Date.parse(`2026-11-0${k + 2}T10:00:00Z`);
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    const rowsOf = [
      { type: 'session', version: 4, id: sid, timestamp: at(0) },
      { type: 'model_change', id: `${sid}-m`, parentId: null, timestamp: at(1) },
      { type: 'message', id: `${sid}-u`, parentId: `${sid}-m`, timestamp: at(2), message: { role: 'user', content: q } },
      { type: 'custom_message', customType: 'openclaw.runtime-context', id: `${sid}-c`, parentId: `${sid}-u`, timestamp: at(3), content: 'context' },
      { type: 'message', id: `${sid}-a`, parentId: `${sid}-c`, timestamp: at(4), message: { role: 'assistant', content: [{ type: 'text', text: a }] } },
    ];
    rowsOf.forEach((e, seq) => {
      ev.run(sid, seq, JSON.stringify(e), e.type === 'message' ? (e as { message: { role: string } }).message.role : null);
      if (seq > 0) act.run(sid, seq - 1, seq);
    });
    node.run(key, sid, JSON.stringify({ sessionId: sid }));
  });
  ag.close();
  return { state, ws };
}
