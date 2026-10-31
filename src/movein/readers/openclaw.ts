// Phase 104 (MI1, docs/design/MOVE_IN.md §2.3, §6): the exact reader for an OpenClaw agent.
// Workspace persona files (SOUL, IDENTITY and every other top-level *.md that isn't a known
// non-persona file) → persona drafts; AGENTS.md → working rules; USER.md directives → owner facts
// (superseded ones kept as superseded notes); MEMORY.md and memory/YYYY-MM-DD.md → notes; sessions
// from the per-agent SQLite (current layout) and the legacy JSONL trees (active branch only) → past
// conversations; skills; cron (legacy jobs.json and the automations table) → scheduled tasks.
import { mapJob, normalizeJob, validZone } from '../schedules.ts';
import { classifyNote, draftPersona, isoDay, markdownItems, personaRefusal, userDirectives, workingRules, type PersonaFile } from '../text.ts';
import type { ConversationData, MoveInReader, PersonaDraft } from '../types.ts';
import { cols, note, readLater, readSkills, rows, schemaOf, storesOf, str, when, type Row } from './common.ts';

const WS = 'files/ws/';
const STATE = 'files/state/';
/** Workspace files that are not persona material (§6.3 point 1). */
const NOT_PERSONA = new Set(['AGENTS.md', 'USER.md', 'MEMORY.md', 'memory.md', 'BOOT.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'DREAMS.md', 'TOOLS.md']);
const CHANNEL: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp', imessage: 'iMessage', signal: 'Signal', slack: 'Slack', web: 'Web', a2a: 'A2A' };

/** "agent:main:telegram:group:42" → "Telegram group"; cron:/hook: keys are not conversations. */
export function keyLabel(key: string): { label?: string; automation?: boolean } {
  if (/^(cron|hook):/.test(key)) return { automation: true };
  const p = key.split(':');
  if (p[0] === 'agent' && p.length >= 4) {
    const ch = CHANNEL[p[2]] ?? p[2];
    return { label: p[3] === 'group' ? `${ch} group` : p[3] === 'channel' ? `${ch} channel` : ch };
  }
  return {};
}

const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && (x as Row).type === 'text' ? str((x as Row).text) : '')).filter(Boolean).join('\n');
  return '';
};

export const openclawReader: MoveInReader = {
  id: 'openclaw',
  detect(b) {
    return { ok: b.manifest.source.kind === 'openclaw' || b.has(`${STATE}openclaw.json.json`) || b.has(`${WS}SOUL.md`), facts: b.manifest.source.detected?.layout ?? [] };
  },
  async read(b, emit, signal, ctx) {
    const skipped: Record<string, number> = {};
    const facts: string[] = [];
    const items = b.manifest.items;
    const today = ctx.now.toISOString().slice(0, 10);
    const top = items.filter((it) => it.path.startsWith(WS) && !it.path.slice(WS.length).includes('/') && it.path.endsWith('.md'));
    const fileOf = async (p: string): Promise<PersonaFile> => ({ path: p, name: p.split('/').at(-1)!, text: await b.text(p, 1024 * 1024) });

    // ---------------- personality (§6.3) ----------------
    const soul = top.find((it) => it.path === `${WS}SOUL.md`);
    const identity = top.find((it) => it.path === `${WS}IDENTITY.md`);
    const extra = top.filter((it) => !NOT_PERSONA.has(it.path.slice(WS.length)) && it !== soul && it !== identity && it.kind !== 'history');
    if (soul || identity || extra.length) {
      const files: PersonaFile[] = [];
      for (const it of [identity, soul, ...extra]) if (it) files.push(await fileOf(it.path));
      const refusal = personaRefusal(files);
      const name = b.manifest.source.displayName;
      const opts = { name: name && name !== b.manifest.source.agentId ? name : undefined, adultOn: ctx.adultOn, ownerName: ctx.ownerName, scrub: ctx.scrub };
      const drafts: PersonaDraft[] = [];
      const history = items.filter((it) => it.kind === 'history' && it.path.startsWith(WS)).map((it) => ({ path: it.path, mtime: it.mtime })).sort((x, y) => String(y.mtime).localeCompare(String(x.mtime)));
      if (!refusal) {
        drafts.push(draftPersona(files.map((f) => f.name).join(' + '), files, ctx.current, opts));
        for (const h of history) {
          const text = await b.text(h.path, 1024 * 1024).catch(() => '');
          const of = items.find((it) => it.path === h.path)?.of ?? '';
          const others = files.filter((f) => f.path !== of);
          const hf = [...others, { path: h.path, name: of.split('/').at(-1) ?? 'SOUL.md', text }];
          if (text && !personaRefusal(hf)) drafts.push(draftPersona(`Earlier version (${h.path.split('/').at(-1)})`, hf, ctx.current, opts));
        }
      }
      emit({ section: 'persona', kind: 'persona', ref: soul?.path ?? identity?.path ?? extra[0].path, title: drafts[0]?.sheet.name ?? name ?? 'SOUL.md', data: { drafts, history, ...(refusal ? { refused: refusal } : {}) } });
      facts.push('workspace persona');
    }
    // AGENTS.md: working rules (pinned lessons); its ## Tools section is for MI3.
    if (b.has(`${WS}AGENTS.md`)) {
      const f = await fileOf(`${WS}AGENTS.md`);
      const r = workingRules(f, ctx.scrub);
      for (const rule of r.rules) note(emit, skipped, ctx, { section: 'memories', ref: rule.from, text: rule.text, kind: 'lesson', happenedOn: isoDay(items.find((it) => it.path === f.path)?.mtime, today), pinned: true, tag: 'working rule' });
      skipped['safety-layer'] = (skipped['safety-layer'] ?? 0) + r.leftOut.length;
      if (r.tools.length) emit({ section: 'later', kind: 'later', ref: `${f.path}#tools`, title: 'AGENTS.md tools', data: { code: 'tools', what: `${r.tools.length} tool notes in AGENTS.md`, why: 'Tool habits are matched to Sara\'s own tools in the 2.39 update.' } });
    }

    // ---------------- the profile: USER.md directives (§6.4, [O4]) ----------------
    if (b.has(`${WS}USER.md`)) {
      const day = isoDay(items.find((it) => it.path === `${WS}USER.md`)?.mtime, today);
      for (const d of userDirectives(await b.text(`${WS}USER.md`))) {
        note(emit, skipped, ctx, { section: 'profile', ref: `${WS}USER.md#L${d.line}`, text: d.text, kind: 'fact', happenedOn: d.observed ?? day, ...(d.status === 'superseded' ? { superseded: true } : {}) });
      }
      facts.push('USER.md');
    }
    // ---------------- memories: MEMORY.md and the daily files ----------------
    for (const p of [`${WS}MEMORY.md`, `${WS}memory.md`]) {
      if (!b.has(p)) continue;
      const day = isoDay(items.find((it) => it.path === p)?.mtime, today);
      for (const it of markdownItems(await b.text(p, 1024 * 1024))) {
        const kind = /decision/i.test(it.heading) ? 'decision' : /promise/i.test(it.heading) ? 'promise' : classifyNote(it.text);
        note(emit, skipped, ctx, { section: 'memories', ref: `${p}#L${it.line}`, text: it.text, kind, happenedOn: day });
      }
      facts.push('MEMORY.md');
    }
    for (const it of items.filter((x) => x.kind === 'daily')) {
      const day = /(\d{4}-\d{2}-\d{2})/.exec(it.path)?.[1] ?? today;
      const parts = markdownItems(await b.text(it.path, 1024 * 1024));
      const paras = parts.filter((x) => !x.bullet && !/^\d{4}-\d{2}-\d{2}$/.test(x.text));
      for (const x of parts.filter((y) => y.bullet)) note(emit, skipped, ctx, { section: 'memories', ref: `${it.path}#L${x.line}`, text: x.text, kind: classifyNote(x.text), happenedOn: day });
      // A long day is summarised as one note (the explicit list items above stay facts).
      if (paras.length) note(emit, skipped, ctx, { section: 'memories', ref: `${it.path}#summary`, text: paras.map((x) => x.text).join(' ').slice(0, 1500), kind: 'summary', happenedOn: day });
    }
    // DREAMS.md and dreaming reports: her reflections (needs you: off until switched on).
    for (const it of items.filter((x) => x.kind === 'ws-dreams' || x.kind === 'dreams')) {
      for (const x of markdownItems(await b.text(it.path, 1024 * 1024))) note(emit, skipped, ctx, { section: 'reflections', ref: `${it.path}#L${x.line}`, text: x.text, kind: 'reflection', happenedOn: isoDay(/(\d{4}-\d{2}-\d{2})/.exec(it.path)?.[1] ?? it.mtime, today) });
    }
    if (b.has(`${WS}HEARTBEAT.md`)) emit({ section: 'later', kind: 'later', ref: `${WS}HEARTBEAT.md`, title: 'HEARTBEAT.md', data: { code: 'agenda', what: 'HEARTBEAT.md check-ins', why: 'Her own plans (Settings → Her → Her own plans) are off until you switch them on; add these there if you want them.' } });
    if (b.has(`${WS}BOOT.md`)) emit({ section: 'later', kind: 'later', ref: `${WS}BOOT.md`, title: 'BOOT.md', data: { code: 'boot', what: 'BOOT.md start-up checklist', why: 'Start-up rules are translated in the 2.39 update.' } });

    // ---------------- sessions (§6.6): legacy JSONL trees ----------------
    const agent = b.manifest.source.agentId;
    const sessDir = `${STATE}agents/${agent}/sessions/`;
    const keyOf = new Map<string, string>();
    if (b.has(`${sessDir}sessions.json`)) {
      try {
        const idx = JSON.parse(await b.text(`${sessDir}sessions.json`)) as Record<string, { sessionId?: string; id?: string }>;
        for (const [k, v] of Object.entries(idx)) keyOf.set(String(v?.sessionId ?? v?.id ?? ''), k);
      } catch {
        skipped['sessions-index'] = 1;
      }
    }
    /** One transcript (JSONL entries or event_json rows): the active branch → a past conversation (§6.6). */
    const transcript = (p: string, sid: string, kl: { label?: string; automation?: boolean }, byId: Map<string, Row>, last: string | undefined, header: Row | undefined, active?: string[]) => {
      const branch: Row[] = [];
      const seen = new Set<string>();
      if (active) for (const id of active) if (byId.has(id) && !seen.has(id)) {
        seen.add(id);
        branch.push(byId.get(id)!);
      }
      for (let cur = active ? undefined : last; cur && byId.has(cur) && !seen.has(cur); cur = str(byId.get(cur)!.parentId) || undefined) {
        seen.add(cur);
        branch.unshift(byId.get(cur)!);
      }
      const side = [...byId.values()].filter((e) => e.type === 'message' && !seen.has(str(e.id))).length;
      if (side) skipped['side-branches'] = (skipped['side-branches'] ?? 0) + side;
      const msgs: ConversationData['messages'] = [];
      const fallback = when(header?.timestamp, ctx.now.toISOString());
      for (const e of branch) {
        if (e.type === 'compaction' || e.type === 'branch_summary') {
          const s = str(e.summary);
          if (s) note(emit, skipped, ctx, { section: 'memories', ref: `${p}#${str(e.id)}`, text: s, kind: 'summary', happenedOn: (msgs.at(-1)?.at ?? fallback).slice(0, 10) });
          continue;
        }
        if (e.type !== 'message') {
          skipped.custom = (skipped.custom ?? 0) + 1;
          continue;
        }
        const m = (e.message ?? {}) as Row;
        const role = str(m.role);
        const text = textOf(m.content);
        if (role !== 'user' && role !== 'assistant') {
          skipped.tool = (skipped.tool ?? 0) + 1;
          continue;
        }
        if (!text.trim()) continue;
        msgs.push({ role, text: ctx.scrub(text), at: when(e.timestamp, fallback) });
      }
      if (!msgs.length) return;
      const first = msgs.find((m) => m.role === 'user')?.text ?? msgs[0].text;
      const topic = /-topic-(.+)$/.exec(sid)?.[1];
      emit({ section: 'conversations', kind: 'conversation', ref: p, title: first.slice(0, 60), data: { sourceId: sid, title: (first.slice(0, 60) + (topic ? ` (topic ${topic})` : '')).slice(0, 120), createdAt: msgs[0].at, updatedAt: msgs.at(-1)!.at, ...(kl.label ? { channel: kl.label } : {}), messages: msgs } });
    };
    for (const p of b.list(sessDir).filter((x) => x.endsWith('.jsonl'))) {
      if (signal.aborted) break;
      const sid = p.slice(sessDir.length).replace(/\.jsonl$/, '');
      const baseId = sid.replace(/-topic-.+$/, '');
      const kl = keyLabel(keyOf.get(baseId) ?? '');
      if (kl.automation) {
        skipped['automation-runs'] = (skipped['automation-runs'] ?? 0) + 1;
        continue;
      }
      const byId = new Map<string, Row>();
      let last: string | undefined;
      let header: Row | undefined;
      for await (const line of b.lines(p)) {
        if (!line.trim()) continue;
        let e: Row;
        try {
          e = JSON.parse(line) as Row;
        } catch {
          continue;
        }
        if (e.type === 'session') {
          header = e;
          continue;
        }
        const id = str(e.id);
        if (!id) continue;
        byId.set(id, e);
        last = id;
      }
      transcript(p, sid, kl, byId, last, header);
    }
    // ---------------- sessions: the per-agent SQLite (current layout), read by column names ----------------
    for (const store of storesOf(b, 'openclaw-agent')) {
      const schema = await schemaOf(b, store);
      if (!schema) continue;
      // The live layout (seen on a real OpenClaw, 2026.10): transcript_events(session_id, seq,
      // event_json) holds the same entries as the old JSONL files; session_transcript_active_events
      // lists the active branch; session_windows gives each session its key.
      const ev = schema.tables.find((t) => t.verdict === 'data' && ['session_id', 'event_json'].every((c) => t.columns.some((x) => x.name === c)) && t.columns.some((x) => x.name === 'seq'));
      if (ev) {
        const db = ctx.scratch;
        db.exec('DROP TABLE IF EXISTS o_ev; CREATE TABLE o_ev (session TEXT, seq INTEGER, json TEXT); CREATE INDEX o_ev_s ON o_ev(session, seq); DROP TABLE IF EXISTS o_act; CREATE TABLE o_act (session TEXT, pos INTEGER, seq INTEGER); CREATE INDEX o_act_s ON o_act(session, pos);');
        const insE = db.prepare('INSERT INTO o_ev VALUES (?, ?, ?)');
        db.exec('BEGIN');
        for await (const r of rows(b, store, ev.name, signal)) if (typeof r.event_json === 'string') insE.run(str(r.session_id), Number(r.seq) || 0, r.event_json);
        db.exec('COMMIT');
        const act = schema.tables.find((t) => t.name === 'session_transcript_active_events');
        if (act) {
          const insA = db.prepare('INSERT INTO o_act VALUES (?, ?, ?)');
          db.exec('BEGIN');
          for await (const r of rows(b, store, act.name, signal)) if (r.context_eligible !== 0) insA.run(str(r.session_id), Number(r.active_position) || 0, Number(r.event_seq) || 0);
          db.exec('COMMIT');
        }
        const keys = new Map<string, string>();
        const win = schema.tables.find((t) => t.name === 'session_windows' || t.name === 'session_nodes');
        if (win) for await (const r of rows(b, store, win.name, signal)) keys.set(str(r.session_id ?? r.current_session_id), str(r.session_key));
        const arch = schema.tables.find((t) => t.name === 'session_transcript_archives');
        if (arch) skipped['archived-transcripts'] = arch.rows ?? 0;
        const sessions = (db.prepare('SELECT DISTINCT session FROM o_ev').all() as { session: string }[]).map((x) => x.session);
        const getE = db.prepare('SELECT seq, json FROM o_ev WHERE session = ? ORDER BY seq');
        const getA = db.prepare('SELECT seq FROM o_act WHERE session = ? ORDER BY pos');
        for (const sid of sessions) {
          if (signal.aborted) break;
          const kl = keyLabel(keys.get(sid) ?? '');
          if (kl.automation) {
            skipped['automation-runs'] = (skipped['automation-runs'] ?? 0) + 1;
            continue;
          }
          const byId = new Map<string, Row>();
          const bySeq = new Map<number, string>();
          let last: string | undefined;
          let header: Row | undefined;
          for (const { seq, json } of getE.all(sid) as { seq: number; json: string }[]) {
            let e: Row;
            try {
              e = JSON.parse(json) as Row;
            } catch {
              continue;
            }
            if (e.type === 'session') {
              header = e;
              continue;
            }
            const id = str(e.id) || `seq-${seq}`;
            byId.set(id, e);
            bySeq.set(seq, id);
            last = id;
          }
          const active = act ? (getA.all(sid) as { seq: number }[]).map((x) => bySeq.get(x.seq)).filter((x): x is string => Boolean(x)) : undefined;
          transcript(`${store}${ev.name}#${sid}`, sid, kl, byId, last, header, active?.length ? active : undefined);
        }
        db.exec('DROP TABLE IF EXISTS o_ev; DROP TABLE IF EXISTS o_act');
        facts.push('openclaw-agent.sqlite');
        continue;
      }
      const tx = schema.tables.find((t) => t.verdict === 'data' && ['session_id', 'role'].every((c) => t.columns.some((x) => x.name === c)) && t.columns.some((x) => /^(content|text|body)$/.test(x.name)));
      const st = schema.tables.find((t) => t.verdict === 'data' && t !== tx && t.columns.some((x) => x.name === 'session_id' || x.name === 'id') && t.columns.some((x) => /session_key|key|title/.test(x.name)));
      if (!tx) {
        for (const t of schema.tables.filter((x) => x.verdict === 'data')) emit({ section: 'later', kind: 'later', ref: `${store}${t.name}`, title: t.name, data: { code: 'unknown', what: `table "${t.name}" in openclaw-agent.sqlite`, why: 'Found, but not understood yet; the bundle keeps it.' } });
        continue;
      }
      const meta = new Map<string, { key: string; title: string }>();
      if (st) for await (const r of rows(b, store, st.name, signal)) meta.set(str(r.session_id ?? r.id), { key: str(r.session_key ?? r.key), title: str(r.title) });
      const c = cols(schema, tx.name);
      const textCol = ['content', 'text', 'body'].find((x) => c.has(x))!;
      const timeCol = ['created_at', 'timestamp', 'ts', 'at'].find((x) => c.has(x));
      const db = ctx.scratch;
      db.exec('DROP TABLE IF EXISTS o_msgs; CREATE TABLE o_msgs (session TEXT, ts TEXT, seq INTEGER, role TEXT, content TEXT); CREATE INDEX o_msgs_s ON o_msgs(session, ts, seq);');
      const ins = db.prepare('INSERT INTO o_msgs VALUES (?, ?, ?, ?, ?)');
      let seq = 0;
      db.exec('BEGIN');
      for await (const r of rows(b, store, tx.name, signal)) {
        seq++;
        const kind = str(r.kind ?? r.type);
        if (kind && kind !== 'message') {
          if (/compaction|summary/.test(kind) && str(r[textCol])) note(emit, skipped, ctx, { section: 'memories', ref: `${store}${tx.name}#${str(r.id)}`, text: str(r[textCol]), kind: 'summary', happenedOn: when(timeCol ? r[timeCol] : undefined, ctx.now.toISOString()).slice(0, 10) });
          else skipped.custom = (skipped.custom ?? 0) + 1;
          continue;
        }
        const role = str(r.role);
        if (role !== 'user' && role !== 'assistant') {
          skipped.tool = (skipped.tool ?? 0) + 1;
          continue;
        }
        const text = textOf(typeof r[textCol] === 'string' && /^\s*\[/.test(str(r[textCol])) ? (() => { try { return JSON.parse(str(r[textCol])); } catch { return r[textCol]; } })() : r[textCol]);
        if (!text.trim()) continue;
        ins.run(str(r.session_id), when(timeCol ? r[timeCol] : undefined, ctx.now.toISOString()), seq, role, text);
      }
      db.exec('COMMIT');
      const groups = db.prepare('SELECT session, MIN(ts) AS a, MAX(ts) AS z FROM o_msgs GROUP BY session ORDER BY a').all() as { session: string; a: string; z: string }[];
      const get = db.prepare('SELECT role, content, ts FROM o_msgs WHERE session = ? ORDER BY ts, seq');
      for (const g of groups) {
        const m = meta.get(g.session);
        const kl = keyLabel(m?.key ?? '');
        if (kl.automation) {
          skipped['automation-runs'] = (skipped['automation-runs'] ?? 0) + 1;
          continue;
        }
        const msgs = (get.all(g.session) as { role: 'user' | 'assistant'; content: string; ts: string }[]).map((x) => ({ role: x.role, text: ctx.scrub(x.content), at: x.ts }));
        const first = msgs.find((x) => x.role === 'user')?.text ?? msgs[0]?.text ?? '';
        emit({ section: 'conversations', kind: 'conversation', ref: `${store}${tx.name}#${g.session}`, title: (m?.title || first.slice(0, 60)).slice(0, 120), data: { sourceId: g.session, title: (m?.title || first.slice(0, 60) || 'Conversation').slice(0, 120), createdAt: g.a, updatedAt: g.z, ...(kl.label ? { channel: kl.label } : {}), messages: msgs } });
      }
      db.exec('DROP TABLE IF EXISTS o_msgs');
      facts.push('openclaw-agent.sqlite');
    }

    // ---------------- skills (§6.7: workspace, project, managed, workshop) ----------------
    await readSkills(b, [`${WS}skills/`, `${WS}.agents/skills/`, `${STATE}skills/`, `${STATE}agents/${agent}/agent/workshop-skills/`], emit, ctx, 'OpenClaw');

    // ---------------- schedules (§6.8): legacy jobs.json and the automations table ----------------
    const tz = b.manifest.timeZone;
    for (const p of [`${STATE}cron/jobs.json`, `${STATE}cron/jobs-quarantine.json`]) {
      if (!b.has(p)) continue;
      try {
        const raw = JSON.parse(await b.text(p)) as unknown;
        const list = (Array.isArray(raw) ? raw : ((raw as Row)?.jobs as unknown[]) ?? []) as Row[];
        for (const j of list) {
          const job = normalizeJob(j, tz);
          if (!job) continue;
          if (p.endsWith('quarantine.json')) job.enabled = false;
          const data = mapJob(job, ctx.now, validZone(tz) ?? ctx.timeZone, 'OpenClaw');
          emit({ section: 'schedules', kind: 'schedule', ref: `${p}#${job.id}`, title: data.title, data });
        }
      } catch {
        skipped['cron-unreadable'] = (skipped['cron-unreadable'] ?? 0) + 1;
      }
    }
    for (const store of storesOf(b, 'openclaw-state')) {
      const schema = await schemaOf(b, store);
      for (const t of schema?.tables.filter((x) => x.verdict === 'data') ?? []) {
        for await (const r of rows(b, store, t.name, signal)) {
          const job = normalizeJob(r, tz);
          if (!job || (!job.expr && !job.everyMs && !job.at)) continue;
          const data = mapJob(job, ctx.now, validZone(tz) ?? ctx.timeZone, 'OpenClaw');
          emit({ section: 'schedules', kind: 'schedule', ref: `${store}${t.name}#${job.id}`, title: data.title, data });
        }
      }
    }

    readLater(b, emit, { hooks: [`${WS}hooks/`, `${STATE}hooks/`], plugins: [`${STATE}extensions/`, `${STATE}plugins/`] });
    return { facts, skipped };
  },
};
