// Phase 104 (MI1, docs/design/MOVE_IN.md §2.2, §6): the exact reader for a Hermes Agent home.
// SOUL.md (+ agent.personalities, + dated copies) → persona drafts; memories/MEMORY.md and USER.md
// (§-separated) → notes and owner facts; state.db sessions (active rows, message_uid, compression
// chains) → past conversations; skills/ → skills; cron/jobs.json → scheduled tasks; kanban.db boards →
// the board. Hooks, plugins, plugin stores and config.yaml are listed for the later updates.
import type { Bundle } from '../bundle.ts';
import { mapJob, normalizeJob, validZone, boardRole } from '../schedules.ts';
import { classifyNote, draftPersona, isoDay, personaRefusal, splitHermesEntries, workingRules, type PersonaFile } from '../text.ts';
import type { BoardData, ConversationData, Finding, MoveInReader, PersonaDraft, ReaderContext, ReadSummary } from '../types.ts';
import { cols, note, readLater, readSkills, rows, schemaOf, storesOf, str, when } from './common.ts';

const HOME = 'files/home/';
const CHANNEL: Record<string, string> = { cli: 'Terminal', telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp', imessage: 'iMessage', slack: 'Slack', signal: 'Signal', email: 'Email', web: 'Web', api: 'API', cron: 'Scheduled job' };

export const hermesReader: MoveInReader = {
  id: 'hermes',
  detect(b) {
    const facts = b.manifest.source.detected?.layout ?? [];
    return { ok: b.manifest.source.kind === 'hermes' || b.has(`${HOME}SOUL.md`) || b.has(`${HOME}memories/MEMORY.md`), facts };
  },
  async read(b, emit, signal, ctx) {
    const skipped: Record<string, number> = {};
    const facts: string[] = [];
    const items = b.manifest.items;
    const mtimeOf = (p: string) => items.find((it) => it.path === p)?.mtime;
    const today = ctx.now.toISOString().slice(0, 10);

    // ---------------- personality (§6.3) ----------------
    const soulPath = `${HOME}SOUL.md`;
    let config: Record<string, unknown> | undefined;
    if (b.has(`${HOME}config.yaml.json`)) {
      try {
        const c = JSON.parse(await b.text(`${HOME}config.yaml.json`)) as { tree?: Record<string, unknown> };
        config = c.tree && typeof c.tree === 'object' ? c.tree : undefined;
      } catch {
        /* listed as config later */
      }
    }
    if (b.has(soulPath)) {
      const soul: PersonaFile = { path: soulPath, name: 'SOUL.md', text: await b.text(soulPath, 1024 * 1024) };
      const name = b.manifest.source.displayName;
      const opts = { name: name && name !== 'default' ? name : undefined, adultOn: ctx.adultOn, ownerName: ctx.ownerName, scrub: ctx.scrub };
      const refusal = personaRefusal([soul]);
      const drafts: PersonaDraft[] = [];
      const history = (items.find((it) => it.path === soulPath)?.history ?? []).map((p) => ({ path: p, mtime: mtimeOf(p) })).sort((x, y) => String(y.mtime).localeCompare(String(x.mtime)));
      if (!refusal) {
        drafts.push(draftPersona('SOUL.md', [soul], ctx.current, opts));
        // agent.personalities wins over top-level personalities ([H4]); each is a variant, never merged.
        const agent = (config?.agent ?? {}) as Record<string, unknown>;
        const pers = { ...((config?.personalities ?? {}) as Record<string, unknown>), ...((agent.personalities ?? {}) as Record<string, unknown>) };
        for (const [k, v] of Object.entries(pers).slice(0, 8)) {
          const text = typeof v === 'string' ? v : typeof (v as Record<string, unknown>)?.prompt === 'string' ? String((v as Record<string, unknown>).prompt) : '';
          if (text && !personaRefusal([{ path: '', name: '', text }])) drafts.push(draftPersona(`Personality "${k}"`, [soul], ctx.current, { ...opts, summaryOverride: ctx.scrub(text).slice(0, 1500) }));
        }
        for (const h of history) {
          const text = await b.text(h.path, 1024 * 1024).catch(() => '');
          if (text && !personaRefusal([{ path: h.path, name: 'SOUL.md', text }])) drafts.push(draftPersona(`Earlier version (${h.path.split('/').at(-1)})`, [{ path: h.path, name: 'SOUL.md', text }], ctx.current, opts));
        }
      }
      emit({ section: 'persona', kind: 'persona', ref: soulPath, title: drafts[0]?.sheet.name ?? name ?? 'SOUL.md', data: { drafts, history, ...(refusal ? { refused: refusal } : {}) } });
      facts.push('SOUL.md');
    }
    // Context files in the home (AGENTS.md and the like): her working rules.
    for (const it of items.filter((x) => x.kind === 'persona-extra' && x.path.startsWith(HOME))) {
      const f: PersonaFile = { path: it.path, name: it.path.split('/').at(-1)!, text: await b.text(it.path, 1024 * 1024) };
      const r = workingRules(f, ctx.scrub);
      for (const rule of r.rules) note(emit, skipped, ctx, { section: 'memories', ref: rule.from, text: rule.text, kind: 'lesson', happenedOn: isoDay(it.mtime, today), pinned: true, tag: 'working rule' });
      skipped['safety-layer'] = (skipped['safety-layer'] ?? 0) + r.leftOut.length;
    }

    // ---------------- memories and the profile (§6.4) ----------------
    for (const [file, section] of [['memories/MEMORY.md', 'memories'], ['memories/USER.md', 'profile']] as const) {
      const p = `${HOME}${file}`;
      if (!b.has(p)) continue;
      const day = isoDay(mtimeOf(p), today);
      for (const e of splitHermesEntries(await b.text(p, 1024 * 1024))) {
        note(emit, skipped, ctx, { section, ref: `${p}#L${e.line}`, text: e.text, kind: section === 'profile' ? 'fact' : classifyNote(e.text, { agentNotes: true }), happenedOn: day });
      }
      facts.push(file);
    }

    // ---------------- sessions → past conversations (§6.6) ----------------
    for (const store of storesOf(b, 'hermes-state')) {
      if (signal.aborted) break;
      const schema = await schemaOf(b, store);
      const mcols = cols(schema, 'messages');
      const sessions = new Map<string, { source: string; parent: string | null; title: string; started: string; ended: string; users: Set<string> }>();
      for await (const r of rows(b, store, 'sessions', signal)) {
        sessions.set(str(r.id), { source: str(r.source), parent: str(r.parent_session_id) || null, title: str(r.title), started: when(r.started_at, ctx.now.toISOString()), ended: when(r.ended_at ?? r.started_at, ctx.now.toISOString()), users: new Set(str(r.user_id) ? [str(r.user_id)] : []) });
      }
      const db = ctx.scratch;
      db.exec('DROP TABLE IF EXISTS h_msgs; CREATE TABLE h_msgs (root TEXT, session TEXT, ts TEXT, seq INTEGER, role TEXT, content TEXT, uid TEXT); CREATE INDEX h_msgs_root ON h_msgs(root, ts, seq);');
      const rootOf = (id: string): string => {
        let cur = id;
        for (let k = 0; k < 200; k++) {
          const p = sessions.get(cur)?.parent;
          if (!p || !sessions.has(p) || p === cur) return cur;
          cur = p;
        }
        return cur;
      };
      const ins = db.prepare('INSERT INTO h_msgs VALUES (?, ?, ?, ?, ?, ?, ?)');
      const seenUid = new Set<string>();
      let seq = 0;
      db.exec('BEGIN');
      for await (const r of rows(b, store, 'messages', signal)) {
        seq++;
        if (mcols.has('active') && Number(r.active) === 0) {
          skipped.compacted = (skipped.compacted ?? 0) + 1;
          continue;
        }
        const uid = str(r.message_uid);
        if (uid) {
          if (seenUid.has(uid)) {
            skipped.duplicates = (skipped.duplicates ?? 0) + 1;
            continue;
          }
          seenUid.add(uid);
        }
        const role = str(r.role);
        const content = str(r.content);
        if (role === 'tool' || role === 'function' || ((role === 'assistant') && !content.trim() && str(r.tool_calls))) {
          skipped.tool = (skipped.tool ?? 0) + 1;
          continue;
        }
        if (role === 'system') {
          skipped.system = (skipped.system ?? 0) + 1;
          continue;
        }
        if (role !== 'user' && role !== 'assistant') continue;
        if (!content.trim()) {
          skipped.hidden = (skipped.hidden ?? 0) + 1;
          continue;
        }
        if (str(r.reasoning)) skipped.reasoning = (skipped.reasoning ?? 0) + 1;
        const sid = str(r.session_id);
        ins.run(rootOf(sid), sid, when(r.timestamp, ctx.now.toISOString()), seq, role, content, uid || null);
        if (seq % 5000 === 0) {
          db.exec('COMMIT');
          db.exec('BEGIN');
        }
      }
      db.exec('COMMIT');
      const roots = db.prepare('SELECT root, MIN(ts) AS a, MAX(ts) AS z, COUNT(*) AS n FROM h_msgs GROUP BY root ORDER BY a').all() as { root: string; a: string; z: string; n: number }[];
      const msgsOf = db.prepare('SELECT role, content, ts FROM h_msgs WHERE root = ? ORDER BY ts, seq');
      for (const r of roots) {
        if (signal.aborted) break;
        const s = sessions.get(r.root);
        const msgs = (msgsOf.all(r.root) as { role: 'user' | 'assistant'; content: string; ts: string }[]).map((m) => ({ role: m.role, text: ctx.scrub(m.content), at: m.ts }));
        const firstUser = msgs.find((m) => m.role === 'user')?.text ?? msgs[0]?.text ?? '';
        const channel = s ? (CHANNEL[s.source] ?? (s.source || undefined)) : undefined;
        const data: ConversationData = { sourceId: r.root, title: (s?.title || firstUser.slice(0, 60) || 'Conversation').slice(0, 120), createdAt: r.a, updatedAt: r.z, ...(channel ? { channel } : {}), messages: msgs };
        emit({ section: 'conversations', kind: 'conversation', ref: `${store}sessions#${r.root}`, title: data.title, data });
      }
      db.exec('DROP TABLE IF EXISTS h_msgs');
      facts.push('state.db');
    }

    // ---------------- skills (§6.7) ----------------
    await readSkills(b, [`${HOME}skills/`], emit, ctx, 'Hermes Agent');

    // ---------------- schedules (§6.8) ----------------
    const cronPath = `${HOME}cron/jobs.json`;
    if (b.has(cronPath)) {
      try {
        const raw = JSON.parse(await b.text(cronPath)) as unknown;
        const list = (Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.jobs as unknown[]) ?? []) as Record<string, unknown>[];
        const tz = typeof (raw as Record<string, unknown>)?.timezone === 'string' ? String((raw as Record<string, unknown>).timezone) : b.manifest.timeZone;
        for (const j of list) {
          const job = normalizeJob(j, tz);
          if (!job) continue;
          const data = mapJob(job, ctx.now, validZone(tz) ?? ctx.timeZone, 'Hermes Agent');
          emit({ section: 'schedules', kind: 'schedule', ref: `${cronPath}#${job.id}`, title: data.title, data });
        }
        facts.push('cron/jobs.json');
      } catch {
        skipped['cron-unreadable'] = 1;
      }
    }

    // ---------------- the board (§6.9) ----------------
    for (const store of storesOf(b, 'hermes-kanban')) {
      const src = b.manifest.items.find((it) => it.path === store)?.source ?? '';
      const slug = /kanban\/boards\/([^/]+)\//.exec(src)?.[1];
      const board: BoardData = { name: slug ? `Hermes board: ${slug}` : 'Hermes board', cards: [], skipped: 0 };
      const deps = new Map<string, string[]>();
      for await (const r of rows(b, store, 'task_links', signal)) {
        const child = str(r.child_id ?? r.child);
        if (child) deps.set(child, [...(deps.get(child) ?? []), str(r.parent_id ?? r.parent)]);
      }
      const comments = new Map<string, string[]>();
      for (const t of ['comments', 'task_comments']) {
        for await (const r of rows(b, store, t, signal)) comments.set(str(r.task_id), [...(comments.get(str(r.task_id)) ?? []), `${str(r.author) || 'someone'}: ${ctx.scrub(str(r.body ?? r.text))}`]);
      }
      for await (const r of rows(b, store, 'tasks', signal)) {
        const role = boardRole(str(r.status) || 'todo');
        if (!role) {
          board.skipped++;
          continue;
        }
        const id = str(r.id);
        const assignee = str(r.assignee);
        const labels = assignee && !['default', b.manifest.source.agentId].includes(assignee) ? [`helper: ${assignee}`.slice(0, 40)] : [];
        const running = str(r.status).toLowerCase() === 'running';
        const notes = [ctx.scrub(str(r.body ?? r.description)), ...(running ? ['(This was running on the old agent; it is not resumed.)'] : []), ...(comments.get(id) ?? []).map((c) => `Comment from ${c}`)].filter(Boolean).join('\n\n');
        board.cards.push({ ref: id, title: ctx.scrub(str(r.title) || 'Card').slice(0, 300), notes: notes.slice(0, 8000), role, labels, ...(running ? { wasRunning: true } : {}), ...(deps.get(id)?.length ? { dependsOn: deps.get(id) } : {}) });
      }
      emit({ section: 'board', kind: 'board', ref: store, title: board.name, data: board });
      facts.push('kanban.db');
    }

    readLater(b, emit, { hooks: [`${HOME}hooks/`], plugins: [`${HOME}plugins/`] });
    return { facts, skipped } satisfies ReadSummary;
  },
};

export type { Finding, ReaderContext };
export const hermesBundle = (b: Bundle) => hermesReader.detect(b).ok;
