// Phase 111 (TD1): the parts of Today's batched answer that read the app's other stores
// (docs/design/TODAY.md §4, §6, §8.1, §11): She remembered, Moments, Running now, Usage today,
// Home (with who's home and the scenes he picked), Coding projects, Needs you, Since you were away,
// and the owner's opt-in Rooms tile (owner decision 2026-11-01). Nothing is copied: each part reads
// the store that owns the data. Owner-only parts are left out on the server for household members
// and on the demo. Partner conversations, group chats and room logs are not sources of any part;
// the one exception is the Rooms tile, which reads CH4's own rolling summary (no model call) only
// for the owner's main companion and only when he switched it on.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AppContext } from './chat.ts';
import { currentTopic, keepDb, listRooms, recentLines, roomName, topicParts } from './bridges/keepup.ts';
import { cheapCall } from './cheap.ts';
import type { Conversation } from './store.ts';
import { haCall, switchPlan } from './home-switch.ts';
import { localDate } from './memory-worker.ts';
import { netFetch } from './net-guard.ts';
import { dayStartUtc } from './planner.ts';
import { dayBounds, todayChanged, todayState, type PartCtx, type TodayPartName } from './today.ts';
import { HOME_VAULT, type HaState } from './tools/home.ts';
import { GITHUB_VAULT } from './tools/coding.ts';
import { repoFromRemote } from './tools/github.ts';
import { workspaceDir } from './tools/workspace.ts';
import { adultModeOn } from './settings.ts';
import { gatherTrouble } from './trouble.ts';
import { mergeSummaries, type UsageTotals } from './usage.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Loader = (c: PartCtx) => Promise<unknown> | unknown;

/** A pending approval as the turn holds it (src/server.ts `active`). */
export interface PendingApproval {
  approvalId: string;
  conversationId: string;
  name: string;
  summary: string;
  since: string;
}

export interface PartDeps {
  /** Approvals waiting in this companion's turns (§4.4; there is no list route: see TODAY.md "As built"). */
  approvals?: () => PendingApproval[];
  /** Every companion's app, for Usage today (the same merge GET /api/usage makes). */
  companions?: () => AppContext[];
  fetch?: FetchLike;
  /** `git log -1` in a folder (tests stand in). */
  gitLast?: (dir: string) => Promise<{ at: string; subject: string } | undefined>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const owner = (c: PartCtx) => !c.member && !c.demo;

// ---------- She remembered (§4.7) ----------

function memories(c: PartCtx) {
  const { app } = c;
  if (!app.memory || app.settings.get().memory?.enabled === false) return undefined;
  const convs = new Map(app.store.listConversations().map((x) => [x.id, x]));
  // Private / off-record and partner conversations never feed She remembered.
  const ok = (cid: string | null) => {
    if (!cid) return true;
    const cv = convs.get(cid) ?? app.store.getConversation(cid);
    return !cv || (!cv.private && !cv.partner && !cv.channelKey);
  };
  const items = app.memory
    .list({ kind: 'fact' })
    .filter((m) => !m.supersededBy && ok(m.conversationId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id - a.id)
    .slice(0, 3)
    .map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt, source: m.conversationId && convs.get(m.conversationId) ? { title: convs.get(m.conversationId)!.title } : null }));
  return items.length ? { items } : undefined;
}

// ---------- Moments (§4.7) ----------

function moments(c: PartCtx) {
  const book = c.app.moments;
  if (!book || c.demo) return undefined;
  // Adults-only photos keep today's rule: Adult mode on, never in the phone apps.
  const adultOk = adultModeOn(c.app.settings.get()) && !c.phoneApp;
  const items = book
    .list({ adultOk })
    .filter((m) => m.image)
    .slice(0, 4)
    .map((m) => ({ id: m.id, image: m.image, caption: m.caption, text: m.text.slice(0, 200), takenAt: m.takenAt, from: m.from }));
  return items.length ? { items } : undefined;
}

// ---------- Running now (§4.8) ----------

const FAILED = new Set(['error', 'blocked', 'budget', 'limit', 'interrupted']);

function work(c: PartCtx) {
  const { app } = c;
  const now = c.now.getTime();
  const jobs = (app.jobs?.list({ limit: 20 }) ?? []).map((j) => ({ id: j.id, label: j.label, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt ?? null, conversationId: j.conversationId, tail: String((j as { tail?: string }).tail ?? '').slice(-400) }));
  const team = c.member ? [] : (app.team?.list(20) ?? []).filter((t) => t.status === 'running' || t.status === 'waiting').slice(0, 2).map((t) => ({ id: t.id, goal: t.goal, status: t.status, steps: t.steps.map((s) => ({ endedAt: s.endedAt ?? null })) }));
  const start = dayStartUtc(c.day, c.tz).toISOString();
  const runs = app.runs ? app.runs.list({ limit: 200 }).filter((r) => r.startedAt >= start) : [];
  const failedRuns = runs.filter((r) => FAILED.has(r.status)).length;
  const any = jobs.some((j) => j.status === 'running' || (j.endedAt && now - Date.parse(j.endedAt) < 12 * 3600_000)) || team.length || runs.length;
  return any ? { jobs, team, runs: { total: runs.length, failed: failedRuns } } : undefined;
}

// ---------- Usage today (§6.3) ----------

function usage(deps: PartDeps): Loader {
  return (c) => {
    if (!owner(c) || !c.app.usage) return undefined;
    const apps = (deps.companions?.() ?? []).filter((a) => a.usage);
    const meters = apps.length ? apps : [c.app];
    const sum = (since: Date, until?: Date) => {
      const parts = meters.map((a) => ({ id: a.companionId ?? 'main', name: a.persona.name, summary: a.usage!.summary(since.toISOString()) }));
      const s = mergeSummaries(parts);
      if (!until) return s;
      const later = mergeSummaries(meters.map((a) => ({ id: a.companionId ?? 'main', name: a.persona.name, summary: a.usage!.summary(until.toISOString()) })));
      return { ...s, total: minus(s.total, later.total) };
    };
    const start = dayStartUtc(c.day, c.tz);
    const today = sum(start);
    // The last 7 days as a line (each local day's tokens), for when no budget is set.
    const days: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = localDate(new Date(start.getTime() - i * 86_400_000 + 12 * 3600_000).toISOString(), c.tz);
      const from = dayStartUtc(d, c.tz);
      const to = i === 0 ? undefined : dayStartUtc(localDate(new Date(from.getTime() + 36 * 3600_000).toISOString(), c.tz), c.tz);
      days.push(sum(from, to).total.tokens);
    }
    const budget = Number((c.app.settings.get() as { jobBudget?: { usd?: number } }).jobBudget?.usd ?? 0) || 0;
    if (!today.total.calls && !days.some(Boolean)) return undefined;
    return {
      tokens: today.total.tokens,
      usd: Math.round(today.total.usd * 10000) / 10000,
      calls: today.total.calls,
      unpriced: today.total.unpriced,
      billing: today.total.billing,
      byPurpose: today.byPurpose.slice(0, 3).map((p) => ({ purpose: p.purpose, tokens: p.tokens })),
      days,
      ...(budget > 0 ? { budget } : {}),
      showCost: c.prefs.usageCost,
    };
  };
}
function minus(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { calls: a.calls - b.calls, input: a.input - b.input, output: a.output - b.output, cached: a.cached - b.cached, tokens: a.tokens - b.tokens, usd: a.usd - b.usd, unpriced: a.unpriced - b.unpriced, billing: a.billing };
}

// ---------- Home (§4.10) ----------

const HOME_MS = 30_000;
const HOME_DOMAINS = ['light', 'switch', 'climate', 'lock', 'cover', 'fan'];

function home(deps: PartDeps): Loader {
  return async (c) => {
    if (!owner(c)) return undefined;
    const base = c.app.settings.get().home?.url;
    const token = c.app.vault.get(HOME_VAULT);
    if (!base || !token) return { connected: false };
    const st = todayState(c.app);
    const hit = st.cache.get('home');
    if (!c.fresh && hit && c.now.getTime() - hit.at < HOME_MS) return { ...(hit.value as object), cached: true, at: iso(hit.at) };
    st.calls.set('home', (st.calls.get('home') ?? 0) + 1);
    const r = await haCall<HaState[]>(base, token, '/api/states', {}, deps.fetch ?? netFetch);
    if (!r.data || !Array.isArray(r.data)) return { connected: true, error: 'unreachable' };
    const all = r.data.filter((x) => typeof x.entity_id === 'string');
    const name = (x: HaState) => (typeof x.attributes?.friendly_name === 'string' ? x.attributes.friendly_name.slice(0, 80) : x.entity_id);
    const picked = new Set(c.prefs.home.scenes);
    const value = {
      connected: true,
      entities: all.filter((x) => HOME_DOMAINS.includes(x.entity_id.split('.')[0])).slice(0, 500).map((x) => {
        const plan = switchPlan(x);
        return { id: x.entity_id, name: name(x), state: String(x.state ?? '').slice(0, 40), canSwitch: plan.ok || plan.why === 'unreachable' };
      }),
      people: all.filter((x) => x.entity_id.startsWith('person.')).slice(0, 8).map((x) => ({ id: x.entity_id, name: name(x), home: x.state === 'home' })),
      // Every scene for the picker; only the picked ones are buttons (a scene can unlock or open).
      scenes: all.filter((x) => x.entity_id.startsWith('scene.')).slice(0, 40).map((x) => ({ id: x.entity_id, name: name(x), picked: picked.has(x.entity_id) })),
    };
    const at = c.now.getTime();
    st.cache.set('home', { key: 'home', at, started: at, value });
    return { ...value, at: iso(at) };
  };
}

// ---------- Coding projects (§4.9) ----------

const PROJECTS_MS = 10 * 60_000;
const gitLastDefault = (dir: string) =>
  new Promise<{ at: string; subject: string } | undefined>((resolve) => {
    if (!existsSync(dir)) return resolve(undefined);
    execFile('git', ['-C', dir, 'log', '-1', '--format=%cI%x09%s'], { timeout: 3000, windowsHide: true }, (err, out) => {
      if (err) return resolve(undefined);
      const [at, ...rest] = String(out).trim().split('\t');
      resolve(at ? { at: new Date(at).toISOString(), subject: rest.join('\t').slice(0, 120) } : undefined);
    });
  });
const remoteOf = (dir: string) =>
  new Promise<string | undefined>((resolve) => {
    if (!existsSync(dir)) return resolve(undefined);
    execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? undefined : repoFromRemote(String(out))));
  });

function projects(deps: PartDeps): Loader {
  return async (c) => {
    if (!owner(c)) return undefined;
    const { app } = c;
    const since = c.now.getTime() - 7 * 86_400_000;
    const latest = new Map<string, { conversationId: string; at: string }>();
    for (const cv of app.store.listConversations()) {
      if (cv.mode !== 'coding' || !cv.workspace || cv.private || Date.parse(cv.updatedAt) < since) continue;
      const cur = latest.get(cv.workspace);
      if (!cur || cv.updatedAt > cur.at) latest.set(cv.workspace, { conversationId: cv.id, at: cv.updatedAt });
    }
    if (!latest.size) return undefined;
    const st = todayState(app);
    const token = app.vault.get(GITHUB_VAULT);
    const list = [...latest.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 3);
    const out = [];
    for (const [ws, info] of list) {
      let dir: string | undefined;
      try {
        dir = workspaceDir(app.rootDir ?? app.dataDir, ws);
      } catch {
        dir = undefined;
      }
      const last = dir ? await (deps.gitLast ?? gitLastDefault)(dir) : undefined;
      const tests = testsFor(app, ws);
      let prs: number | undefined;
      if (token && dir) {
        const key = `prs:${ws}`;
        const hit = st.cache.get(key);
        if (hit && c.now.getTime() - hit.at < PROJECTS_MS && !c.fresh) prs = hit.value as number;
        else {
          const repo = await remoteOf(dir);
          if (repo) {
            st.calls.set('github', (st.calls.get('github') ?? 0) + 1);
            const r = await (deps.fetch ?? netFetch)(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=30`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
            if (r?.ok) {
              const arr = (await r.json().catch(() => [])) as unknown[];
              prs = Array.isArray(arr) ? arr.length : undefined;
              const at = c.now.getTime();
              st.cache.set(key, { key, at, started: at, value: prs });
            }
          }
        }
      }
      out.push({ workspace: ws, conversationId: info.conversationId, ...(last ? { last } : {}), ...(tests ? { tests } : {}), ...(prs !== undefined ? { prs } : {}) });
    }
    return { items: out, github: Boolean(token) };
  };
}
/** The last run in this workspace's coding chats whose steps ran a test command: passed or failed. */
function testsFor(app: AppContext, ws: string): 'ok' | 'failed' | undefined {
  if (!app.runs) return undefined;
  const convs = new Set(app.store.listConversations().filter((cv) => cv.workspace === ws && cv.mode === 'coding').map((cv) => cv.id));
  for (const r of app.runs.list({ limit: 60 })) {
    if (!r.conversationId || !convs.has(r.conversationId) || r.status === 'running') continue;
    const steps = app.runs.steps(r.id);
    const test = steps.flatMap((s) => s.tools ?? []).filter((t) => /\b(test|check|pytest|vitest|jest)\b/i.test(JSON.stringify((t as { args?: unknown }).args ?? '')) && /run|command|shell|exec/i.test(String((t as { name?: string }).name ?? '')));
    if (!test.length) continue;
    return test.some((t) => (t as { status?: string }).status === 'error') ? 'failed' : 'ok';
  }
  return undefined;
}

// ---------- Needs you (§4.4): the sources; web/today.js ranks them (needsItems) ----------

function needs(deps: PartDeps): Loader {
  return (c) => {
    const { app } = c;
    const own = owner(c);
    const day24 = c.now.getTime() - 86_400_000;
    const approvals = own ? (deps.approvals?.() ?? []).slice(0, 10).map((a) => ({ ...a, title: a.summary || a.name, conversation: app.store.getConversation(a.conversationId)?.title ?? '' })) : [];
    const failedJobs = own ? (app.jobs?.list({ limit: 20 }) ?? []).filter((j) => j.endedAt && Date.parse(j.endedAt) >= day24 && j.status !== 'ok' && j.status !== 'running' && j.status !== 'stopped').map((j) => ({ id: j.id, label: j.label, status: j.status, at: j.endedAt!, conversationId: j.conversationId })) : [];
    const failedRuns = own && app.runs ? app.runs.list({ limit: 100 }).filter((r) => r.kind === 'turn' && r.status === 'error' && r.endedAt && Date.parse(r.endedAt) >= day24).slice(0, 5).map((r) => ({ id: r.id, title: r.title, at: r.endedAt!, conversationId: r.conversationId })) : [];
    const models = own ? ((c.out.modelItems ?? []) as { reason?: string; from?: string; text?: string }[]).filter((m) => m.reason === 'retired-no-replacement' || m.reason === 'retired-auto-switch-off').map((m, i) => ({ key: `model:${m.from ?? i}`, from: m.from ?? '', text: m.text ?? '' })) : [];
    // 3.3.0: her own trouble (model down, key rejected, a mailbox signed out, an add-on stopped).
    const trouble = own ? gatherTrouble(app).map((x) => ({ id: x.id, kind: x.kind, key: x.key, params: x.params, text: x.text, fix: x.fix })) : [];
    return {
      approvals,
      failedJobs,
      failedRuns,
      models,
      trouble,
      notToday: c.prefs.notToday.keys,
      includeMail: c.prefs.needsMail,
    };
  };
}

// ---------- Since you were away (§6.5): built from the stores, no model call ----------

type AwayLine = { kind: string; n: number; failed?: number; titles?: string[] };

/**
 * Phase 112 (TD2, §15 Q5): the rooms she answered in since `seen`, as a count and the room titles
 * only (never lines, names or summaries). Only for the owner's main companion and only when he
 * turned on Include rooms.
 */
export function roomsAnswered(app: AppContext, seen: string): { n: number; titles: string[] } {
  if (!app.roomKeeper || (app.companionId ?? 'main') !== 'main') return { n: 0, titles: [] };
  const ids = (keepDb(app).prepare("SELECT DISTINCT room_id AS id FROM room_lines WHERE who = 'her' AND at >= ?").all(seen) as { id: number }[]).map((r) => Number(r.id));
  if (!ids.length) return { n: 0, titles: [] };
  const rooms = listRooms(app).filter((r) => ids.includes(r.id));
  return { n: rooms.length, titles: rooms.slice(0, 3).map((r) => roomName(r).slice(0, 60)) };
}

/** Phase 112 (TD2, §15 Q4): her one sentence about the absence, made once per absence (key: companion and since). */
const voices = new Map<string, { text: string } | 'pending' | 'none'>();
const voiceKey = (app: AppContext, since: string) => `${app.dataDir ?? ''}|${app.companionId ?? 'main'}|${since}`;
const AWAY_CAP = { runs: 6, tokens: 6000 };
const SENTENCE_SYSTEM = (name: string, owner: string) =>
  `You are ${name}, ${owner}'s AI companion. Write ONE short, warm sentence (at most 30 words) in your own voice that tells ${owner} what happened while they were away. Use only the facts given; never add any. No lists, no quotes, no emoji, no names other than ${owner}'s.`;

/** The facts the sentence may use: counts only (the same allow-list as the lines). */
function awayFacts(lines: AwayLine[], hours: number): string {
  const words: Record<string, (l: AwayLine) => string> = {
    messages: (l) => `you sent ${l.n} message(s) on your own`,
    jobs: (l) => `${l.n} background job(s) finished${l.failed ? `, ${l.failed} failed` : ''}`,
    memories: (l) => `you learned ${l.n} new thing(s) about them`,
    moments: (l) => `${l.n} new moment(s) were added`,
    mail: (l) => `you organised ${l.n} email(s)`,
    rooms: (l) => `you answered in ${l.n} chat room(s)`,
  };
  return `Away for ${hours} hours. ${lines.map((l) => words[l.kind]?.(l) ?? '').filter(Boolean).join('; ')}.`;
}

/**
 * Starts her sentence in the background (a small call: local model first, then the quick route,
 * capped by the daily ledger under `today-away`); the page hears SSE `today {part:'away'}` when it
 * is there. Never writes memory; never blocks the answer.
 */
export function startAwaySentence(app: AppContext, since: string, lines: AwayLine[], hours: number): Promise<void> | undefined {
  const k = voiceKey(app, since);
  if (voices.has(k)) return undefined;
  voices.set(k, 'pending');
  const owner = app.settings.get().ownerName?.trim() || 'them';
  const conv = { id: '', title: 'Today', providerId: null, model: null, workspace: '', mode: 'chat', private: false, channel: null, channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [] } as unknown as Conversation;
  const messages = [{ role: 'system' as const, content: SENTENCE_SYSTEM(app.persona.name, owner) }, { role: 'user' as const, content: awayFacts(lines, hours) }];
  const ask = (model: 'local' | 'quick') => cheapCall(app, { source: 'today-away', purpose: 'today-away', conv, model, messages, maxTokens: 80, temperature: 0.6, cap: AWAY_CAP, estTokens: 400, timeoutMs: 60_000 });
  return (async () => {
    let r = await ask('local');
    if (!r.ok && r.skipped === 'no-model') r = await ask('quick');
    const text = r.ok ? r.text.replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim().slice(0, 240) : '';
    voices.set(k, text ? { text } : 'none');
    if (text) todayChanged(app, 'away');
  })().catch(() => void voices.set(k, 'none'));
}

function away(): Loader {
  return (c) => {
    const { app } = c;
    const hours = c.prefs.awayHours;
    const seen = c.out.layout?.seenAt;
    if (!hours || !seen) return undefined;
    const gone = c.now.getTime() - Date.parse(seen);
    if (!(gone >= hours * 3600_000)) return undefined;
    const lines: AwayLine[] = [];
    // Her messages that came on their own (reach-outs and reminders), only in his own 1:1 chats.
    let msgs = 0;
    for (const cv of app.store.listConversations()) {
      if (cv.private || cv.partner || cv.channelKey || Date.parse(cv.updatedAt) < Date.parse(seen)) continue;
      msgs += app.store.messagesPage(cv.id, { limit: 50 }).messages.filter((m) => m.role === 'assistant' && m.createdAt >= seen && Boolean(m.meta && (m.meta.proactive || m.meta.reminder || m.meta.job))).length;
    }
    if (msgs) lines.push({ kind: 'messages', n: msgs });
    if (owner(c)) {
      const ended = (app.jobs?.list({ limit: 50 }) ?? []).filter((j) => j.endedAt && j.endedAt >= seen);
      if (ended.length) lines.push({ kind: 'jobs', n: ended.length, failed: ended.filter((j) => j.status !== 'ok' && j.status !== 'stopped').length });
    }
    const learned = app.memory ? app.memory.list({ kind: 'fact' }).filter((m) => m.createdAt >= seen).length : 0;
    if (learned) lines.push({ kind: 'memories', n: learned });
    const added = app.moments ? app.moments.list({ adultOk: false }).filter((m) => m.addedAt >= seen).length : 0;
    if (added) lines.push({ kind: 'moments', n: added });
    if (owner(c) && app.gmail) {
      const n = app.gmail.organisedSince(seen).reduce((a, g) => a + g.count, 0);
      if (n) lines.push({ kind: 'mail', n });
    }
    // Include rooms (off by default): a count and the room titles, nothing else from the rooms.
    if (owner(c) && c.prefs.awayRooms) {
      const r = roomsAnswered(app, seen);
      if (r.n) lines.push({ kind: 'rooms', n: r.n, titles: r.titles });
    }
    if (!lines.length) return undefined;
    const kept = lines.slice(0, 5);
    const h = Math.round(gone / 3600_000);
    const out: { hours: number; since: string; lines: AwayLine[]; voice?: string } = { hours: h, since: seen, lines: kept };
    // Her sentence (off by default): there when it was made, else started now for the next answer.
    if (c.prefs.awayVoice && !c.demo) {
      const v = voices.get(voiceKey(app, seen));
      if (v && typeof v === 'object') out.voice = v.text;
      else if (!v) void startAwaySentence(app, seen, kept, h);
    }
    return out;
  };
}

/** Tests: her sentence for this absence, once made (or undefined). */
export const awayVoiceFor = (app: AppContext, since: string): string | undefined => {
  const v = voices.get(voiceKey(app, since));
  return v && typeof v === 'object' ? v.text : undefined;
};

// ---------- Rooms (owner decision 2026-11-01) ----------

/**
 * A short summary of the keep-up rooms (Discord channels, Telegram groups): the topic from CH4's
 * rolling summary (or the code fallback's topic words when it is older than the latest lines),
 * who spoke lately and when. Owner and main companion only (app.roomKeeper exists only there),
 * never members or the demo, only when switched on; rooms with keep-up off never appear, and a
 * forgotten room (keep-up off, lines gone) disappears. Nothing from it goes into memory or other parts.
 */
function rooms(): Loader {
  return (c) => {
    const { app } = c;
    // Owner decision 2026-11-01: the owner's main companion only (never members, the demo or another companion).
    if (!owner(c) || !app.roomKeeper || (app.companionId ?? 'main') !== 'main') return undefined;
    // The keep-up rooms he can pick from (Customise); the tile itself stays empty until he switches it on.
    const available = listRooms(app).filter((r) => r.keepUp).map((r) => ({ id: r.id, name: roomName(r) }));
    if (!c.prefs.rooms.on) return { on: false, items: [], available };
    const pick = new Set(c.prefs.rooms.ids);
    const list = listRooms(app)
      .filter((r) => r.keepUp && (!pick.size || pick.has(r.id)))
      .slice(0, 6)
      .map((r) => {
        const lines = recentLines(app, r.id, 30).filter((l) => !l.flags.removed);
        const last = lines.at(-1);
        const recent = lines.filter((l) => l.who === 'person' || l.who === 'owner').filter((l) => c.now.getTime() - Date.parse(l.at) < 3 * 3600_000);
        const who = [...new Set(recent.map((l) => l.author))].slice(-4);
        // Phase 114 (B2): `topic` is a readable English line; `topicParts` lets Today write it in the app's language.
        return { id: r.id, bridge: r.bridge, name: roomName(r), topic: currentTopic(app, r.id).slice(0, 140), topicParts: topicParts(app, r.id), who, last: last?.at ?? null, paused: Boolean(r.pausedReason) };
      });
    return { on: true, items: list, available };
  };
}

/** Every loader this module adds to buildToday (src/routes/planner.ts passes the route's own). */
export function todayLoaders(deps: PartDeps = {}): Partial<Record<TodayPartName, Loader>> {
  return { memories, moments, work, usage: usage(deps), home: home(deps), projects: projects(deps), needs: needs(deps), away: away(), rooms: rooms() };
}

export { dayBounds };
