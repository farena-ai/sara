// Phase 75 (stage 1, "her work on screen"): small structured result cards built from what a tool
// really returned (its arguments and its result text), never from her reply. The chat stream sends
// the card with the tool's result and the tool message keeps it in its meta, so the web app can draw
// a weather card, "Task added", "Files changed" and so on. Tools without a card keep the step line
// only. Everything here is pure (no I/O) and every string is clipped, so a card is always small.

export type WeatherDay = { date: string; max?: string; min?: string; icon?: string };
export type Card =
  | { kind: 'weather'; place: string; temp?: string; feels?: string; condition?: string; icon?: string; wind?: string; humidity?: string; days?: WeatherDay[] }
  | { kind: 'task'; action: 'added' | 'done' | 'reopened' | 'updated' | 'deleted'; id: number; title: string; due?: string; project?: string; priority?: string }
  | { kind: 'reminder'; action: 'set' | 'cancelled'; id: number; text: string; when?: string; repeat?: string; place?: string; call?: boolean }
  | { kind: 'note'; action: 'saved' | 'deleted'; id: number; title: string; project?: string }
  | { kind: 'calendar'; action: 'list' | 'added'; events: { when: string; title: string; location?: string }[] }
  | { kind: 'file'; action: 'wrote' | 'edited'; path: string; bytes?: number; replacements?: number }
  | { kind: 'test'; command: string; ok: boolean; exitCode: number | null; passed?: number; failed?: number; skipped?: number; seconds?: number }
  | { kind: 'job'; id: number; label: string; status: string; exitCode?: number }
  | { kind: 'home'; entity: string; service: string; name?: string; state?: string }
  | { kind: 'photo'; caption: string }
  | { kind: 'search'; query: string; results: { title: string; url: string; host: string }[] }
  | { kind: 'gmail'; id: string; action: string; done: number; failed: number; total: number; query: string; link?: string; label?: string; stopped?: boolean; undoOf?: string }
  /** Phase 87: a page in the Sara browser on the owner's computer (with the step's thumbnail hash). */
  | { kind: 'computer'; action: 'open' | 'navigate' | 'look'; url: string; title: string; computer?: string; problems?: string; thumb?: string }
  /** Phase 87: no computer connected: "Get the app" (COMPUTER_USE.md §9.4). */
  | { kind: 'hands-install'; url: string }
  /** Phase 94: a computer check-up's report card (numbers, statuses, short names, the suggestions by number). */
  | { kind: 'checkup'; computer: string; os: string; at: string; windows: boolean; flagged: number; items: CheckupCardItem[]; suggestions: CheckupCardSuggestion[] }
  /** Phase 94: one check-up change, done or declined on the computer. */
  | { kind: 'checkup-change'; id: string; change: string; outcome: 'done' | 'declined'; windows?: boolean; name?: string; bytes?: number; page?: string; computer?: string };
export type CheckupCardItem = { check: string; status: string; facts: Record<string, string | number | boolean | string[]> };
export type CheckupCardSuggestion = { id: string; kind: string; check: string; how: 'apply' | 'guide'; name?: string; bytes?: number; page?: string };

/** Phase 87: where the desktop apps are downloaded (the install card for web-only users). */
export const APPS_PAGE = 'https://github.com/farena-ai/sara/releases/latest';

/** `thumb`: Phase 87, the hash of the step's thumbnail (her hands' tools). */
export type CardInput = { name: string; args: Record<string, unknown>; status: 'ok' | 'error' | 'denied'; output: string; thumb?: string };

const MAX = 200;
const cut = (s: unknown, n = MAX): string => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const arg = (a: Record<string, unknown>, k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : a[k] === undefined || a[k] === null ? '' : String(a[k]));

/** Runs the card builder for one tool result; never throws (a bad parse just means no card). */
export function cardFor(input: CardInput): Card | undefined {
  if (input.status !== 'ok') return undefined;
  try {
    return build(input);
  } catch {
    return undefined;
  }
}

function build({ name, args, output, thumb }: CardInput): Card | undefined {
  switch (name) {
    case 'pc_devices':
      return output.startsWith('No computer is connected') ? { kind: 'hands-install', url: APPS_PAGE } : undefined;
    case 'pc_browser_open': {
      const m = /^Opened (\S+) in the Sara browser on (.+?)(?: \(HTTP \d+\))?\. Title: (.*?)\. Tab /.exec(output);
      const p = /Problems on the page so far: ([^(]+)/.exec(output);
      return m ? { kind: 'computer', action: 'open', url: cut(m[1], 300), title: cut(m[3], 120), computer: cut(m[2], 60), ...(p ? { problems: cut(p[1], 120) } : {}), ...(thumb ? { thumb } : {}) } : undefined;
    }
    case 'pc_browser_navigate': {
      const m = /now on (\S+) \((.*?)\)\./.exec(output);
      return m ? { kind: 'computer', action: 'navigate', url: cut(m[1], 300), title: cut(m[2], 120), ...(thumb ? { thumb } : {}) } : undefined;
    }
    case 'pc_browser_look': {
      const m = /\n(.*?) — (\S+)\nOn the page/.exec(output);
      return m ? { kind: 'computer', action: 'look', url: cut(m[2], 300), title: cut(m[1], 120), ...(thumb ? { thumb } : {}) } : undefined;
    }
    case 'shell':
      return shellCard(arg(args, 'command'), output);
    case 'web_fetch':
      // web_fetch puts an "[HTTP 200 …]" line and a "text is written by others" notice before the
      // page: drop them so they're never read as the weather (a card once said the condition was
      // "Web Page Text Is Written By Others…").
      return /(^|\/\/|\.)wttr\.in\b/i.test(arg(args, 'url')) ? weatherCard(arg(args, 'url'), output.replace(/^\[HTTP \d{3}[^\n]*\]\n(\(Web page text is written by others[^\n]*\)\n)?/, '')) : undefined;
    case 'todo':
      return taskCard(output);
    case 'remind':
      return reminderCard(args, output);
    case 'note':
      return noteCard(output);
    case 'calendar_events':
      return calendarList(output);
    case 'calendar_add':
      return calendarAdd(output);
    case 'write_file': {
      const m = /^Wrote (\d+) bytes to (.+?)\.$/m.exec(output);
      return m ? { kind: 'file', action: 'wrote', path: cut(m[2], 300), bytes: Number(m[1]) } : undefined;
    }
    case 'edit_file': {
      const m = /^Edited (.+?) \((\d+) replacements?\)\.$/m.exec(output);
      return m ? { kind: 'file', action: 'edited', path: cut(m[1], 300), replacements: Number(m[2]) } : undefined;
    }
    case 'start_job': {
      const m = /^Started background job #(\d+) \((.*?)\)\./.exec(output);
      return m ? { kind: 'job', id: Number(m[1]), label: cut(m[2], 120), status: 'running' } : undefined;
    }
    case 'job_status': {
      const m = /^Job #(\d+) \((.*?)\): (\w+)(?:, exit code (-?\d+))?/.exec(output);
      return m ? { kind: 'job', id: Number(m[1]), label: cut(m[2], 120), status: m[3], ...(m[4] !== undefined ? { exitCode: Number(m[4]) } : {}) } : undefined;
    }
    case 'home_control':
      return homeCard(output);
    case 'take_photo': {
      const m = /^Took a new photo: ([\s\S]*?)\. It appears with your reply\./.exec(output);
      return m ? { kind: 'photo', caption: cut(m[1], 160) } : undefined;
    }
    case 'share_photo':
      return /^Photo sent/.test(output) ? { kind: 'photo', caption: '' } : undefined;
    case 'gmail_organize':
    case 'gmail_undo':
      return gmailCard(output);
    case 'web_search':
      return searchCard(arg(args, 'query'), output);
    case 'pc_checkup':
      return checkupCard(output);
    case 'pc_checkup_apply':
      return checkupChangeCard(output);
    default:
      return undefined;
  }
}

// ---------- shell: weather and test runs ----------

const TEST_CMD = /(^|[;&|(\s])(npm (run )?test\b|npm t\b|yarn test|pnpm (run )?test|bun test|node (--\S+ )*--test\b|npx (jest|vitest|mocha)\b|jest\b|vitest\b|mocha\b|pytest\b|python3? -m (pytest|unittest)\b|cargo test\b|go test\b|deno test\b|make (check|test)\b|dotnet test\b|mvn (-\S+ )*test\b|gradle(w)? test\b|\.\/gradlew test\b|npm run check\b)/;

/** A Gmail change: done / failed, the search, Undo (by id) and an "Open in Gmail" link. A big one started as a background task is a task card. */
function gmailCard(output: string): Card | undefined {
  const started = /^Started background job #(\d+): (.+?)\. Progress/m.exec(output);
  if (started) return { kind: 'job', id: Number(started[1]), label: cut(started[2]), status: 'running' };
  const m = /^\[gmail-result (\{.*\})\]$/m.exec(output);
  if (!m) return undefined;
  const j = JSON.parse(m[1]) as { id?: string; action?: string; done?: number; failed?: number; total?: number; query?: string; label?: string; stopped?: boolean; undoOf?: string };
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const query = cut(j.query ?? '', 300);
  return {
    kind: 'gmail',
    id: /^g_[\w]{4,20}$/.test(j.id ?? '') ? j.id! : '',
    action: cut(j.action ?? '', 20),
    done: count(j.done),
    failed: count(j.failed),
    total: count(j.total),
    query,
    ...(query ? { link: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}` } : {}),
    ...(j.label ? { label: cut(j.label, 80) } : {}),
    ...(j.stopped ? { stopped: true } : {}),
    ...(j.undoOf ? { undoOf: cut(j.undoOf, 20) } : {}),
  };
}

// ---------- Phase 94: check-ups ----------
const CHECK_KEYS = new Set(['startup', 'disk', 'folders', 'updates', 'battery', 'extensions', 'temp']);
const STATUSES = new Set(['good', 'warn', 'bad', 'info', 'unavailable']);
const SUGG_KINDS = new Set(['startup.disable', 'temp.clean', 'trash.empty', 'settings.open', 'restore-point', 'guide']);
const PAGES = new Set(['startup', 'storage', 'updates', 'battery']);
const fact = (v: unknown): string | number | boolean | string[] | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return cut(v, 120);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => cut(x, 120));
  return undefined;
};
function checkupCard(output: string): Card | undefined {
  const m = /^\[checkup-result (\{.*\})\]$/m.exec(output);
  if (!m) return undefined;
  const j = JSON.parse(m[1]) as Record<string, unknown>;
  const items = (Array.isArray(j.items) ? j.items : []).slice(0, 10).flatMap((x: Record<string, unknown>) => {
    if (!CHECK_KEYS.has(String(x?.check)) || !STATUSES.has(String(x?.status))) return [];
    const facts: Record<string, string | number | boolean | string[]> = {};
    for (const [k, v] of Object.entries((x.facts ?? {}) as Record<string, unknown>).slice(0, 12)) {
      const f = fact(v);
      if (f !== undefined && /^[a-z]{1,20}$/i.test(k)) facts[k] = f;
    }
    return [{ check: String(x.check), status: String(x.status), facts }];
  });
  const suggestions = (Array.isArray(j.suggestions) ? j.suggestions : []).slice(0, 16).flatMap((x: Record<string, unknown>) => {
    if (!/^s\d{1,2}$/.test(String(x?.id)) || !SUGG_KINDS.has(String(x?.kind))) return [];
    return [{ id: String(x.id), kind: String(x.kind), check: cut(x.check, 20), how: x.how === 'apply' ? ('apply' as const) : ('guide' as const), ...(x.name ? { name: cut(x.name, 80) } : {}), ...(typeof x.bytes === 'number' && Number.isFinite(x.bytes) ? { bytes: Math.max(0, Math.round(x.bytes)) } : {}), ...(PAGES.has(String(x.page)) ? { page: String(x.page) } : {}) }];
  });
  return { kind: 'checkup', computer: cut(j.computer, 60), os: cut(j.os, 30), at: cut(j.at, 40), windows: j.windows === true, flagged: typeof j.flagged === 'number' ? Math.max(0, Math.round(j.flagged)) : 0, items, suggestions };
}
function checkupChangeCard(output: string): Card | undefined {
  const m = /^\[checkup-change (\{.*\})\]$/m.exec(output);
  if (!m) return undefined;
  const j = JSON.parse(m[1]) as Record<string, unknown>;
  if (!/^s\d{1,2}$/.test(String(j.id)) || !SUGG_KINDS.has(String(j.kind))) return undefined;
  return { kind: 'checkup-change', id: String(j.id), change: String(j.kind), outcome: j.outcome === 'done' ? 'done' : 'declined', ...(typeof j.windows === 'boolean' ? { windows: j.windows } : {}), ...(j.name ? { name: cut(j.name, 80) } : {}), ...(typeof j.bytes === 'number' ? { bytes: Math.max(0, Math.round(j.bytes)) } : {}), ...(PAGES.has(String(j.page)) ? { page: String(j.page) } : {}), ...(j.computer ? { computer: cut(j.computer, 60) } : {}) };
}

function shellCard(command: string, output: string): Card | undefined {
  const head = /^\[(?:exit code (-?\d+|none)|timed out after [\d.]+s), ([\d.]+)s/.exec(output);
  const body = output.replace(/^\[[^\]\n]*\]\n?/, '');
  if (/\bwttr\.in\b/i.test(command)) return weatherCard(command, body);
  if (TEST_CMD.test(command) && head) {
    const exitCode = head[1] === undefined || head[1] === 'none' ? null : Number(head[1]);
    return { kind: 'test', command: cut(command, 160), ok: exitCode === 0, exitCode, ...testCounts(body), seconds: Number(head[2]) };
  }
  return undefined;
}

/** Pass/fail counts from the common test runners' summary lines (the last match wins). */
export function testCounts(text: string): { passed?: number; failed?: number; skipped?: number } {
  const last = (re: RegExp) => {
    let v: number | undefined;
    for (const m of text.matchAll(re)) v = Number(m[1]);
    return v;
  };
  // node --test (ℹ pass 12 / # pass 12), TAP
  let passed = last(/^[ℹ#] pass (\d+)/gmu);
  let failed = last(/^[ℹ#] fail (\d+)/gmu);
  let skipped = last(/^[ℹ#] skipped (\d+)/gmu);
  if (passed === undefined) {
    // jest/vitest ("Tests: 1 failed, 12 passed"), pytest ("12 passed, 1 failed in 0.4s"), cargo ("12 passed; 0 failed")
    passed = last(/\b(\d+) passed\b/g);
    failed = last(/\b(\d+) failed\b/g) ?? (passed !== undefined ? 0 : undefined);
    skipped = last(/\b(\d+) skipped\b/g);
  }
  return { ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}), ...(skipped !== undefined ? { skipped } : {}) };
}

/** The place named in a wttr.in address ("wttr.in/Kansas+City?format=3" → "Kansas City"). */
function wttrPlace(where: string): string {
  const m = /wttr\.in\/([^?\s"'&|;]*)/i.exec(where);
  if (!m?.[1]) return '';
  try {
    return cut(decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/^~/, '').replace(/\.(png|json)$/i, ''), 80);
  } catch {
    return cut(m[1].replace(/\+/g, ' '), 80);
  }
}

const TEMP = /([+-]?\d+)(?:\(([+-]?\d+)\))?\s*°\s*([CF])/;
const fmtTemp = (n: string, u: string) => `${Number(n)}°${u}`;

/** wttr.in in its JSON (format=j1), one-line (format=1..4 or %-formats) or full-report shapes. */
export function weatherCard(where: string, text: string): Card | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (t.startsWith('{')) return weatherJson(where, t);
  const lines = t.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => l.trim());
  const report = /^Weather report: (.+)$/m.exec(lines.join('\n'));
  if (report) {
    // The full report: "Weather report: X", then a picture with the condition and the temperature beside it.
    const block = lines.slice(1, 6);
    const condition = block[0]?.replace(/^[\s\\/_.\-'"`()|*‘’,]+/, '').trim();
    const tm = block.map((l) => TEMP.exec(l)).find(Boolean);
    if (!tm) return undefined;
    const wind = block.map((l) => /(\d+(?:-\d+)?\s*(?:mph|km\/h|m\/s))/.exec(l)?.[1]).find(Boolean);
    return { kind: 'weather', place: cut(report[1], 80) || wttrPlace(where), temp: fmtTemp(tm[1], tm[3]), ...(tm[2] ? { feels: fmtTemp(tm[2], tm[3]) } : {}), ...(condition ? { condition: cut(condition, 60) } : {}), ...(wind ? { wind } : {}) };
  }
  // One-liners: "Kansas City: 🌦 +64°F", "Kansas City: 🌦 🌡️+64°F 🌬️↙7mph", "🌦 +64°F", "Partly cloudy +64°F".
  const line = lines.find((l) => TEMP.test(l));
  if (!line) return undefined;
  const tm = TEMP.exec(line)!;
  const colon = /^([^:]{1,80}):\s+(.*)$/.exec(line);
  const place = colon ? cut(colon[1], 80) : wttrPlace(where);
  const rest = (colon ? colon[2] : line).replace(TEMP, ' ').replace(/🌡️?/gu, ' ');
  const wind = /🌬️?\s*([^\s\d]*\s*\d+\s*(?:mph|km\/h|m\/s))/u.exec(rest)?.[1] ?? /(\d+\s*(?:mph|km\/h|m\/s))/.exec(rest)?.[1];
  const humidity = /(\d{1,3})%/.exec(rest)?.[1];
  const noWind = rest.replace(/🌬️?\s*[^\s\d]*\s*\d+\s*(?:mph|km\/h|m\/s)/u, ' ').replace(/💧?\s*\d{1,3}%/u, ' ');
  const icon = /\p{Extended_Pictographic}/u.exec(noWind)?.[0];
  const words = noWind.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ').replace(/[^\p{L}\s,'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!place && !icon && !words) return undefined;
  return { kind: 'weather', place: place || '', temp: fmtTemp(tm[1], tm[3]), ...(icon ? { icon } : {}), ...(words ? { condition: cut(words, 60) } : {}), ...(wind ? { wind: cut(wind.replace(/\s+/g, ' '), 30) } : {}), ...(humidity ? { humidity: `${humidity}%` } : {}) };
}

type J1 = {
  current_condition?: { temp_C?: string; temp_F?: string; FeelsLikeC?: string; FeelsLikeF?: string; humidity?: string; windspeedKmph?: string; windspeedMiles?: string; weatherDesc?: { value?: string }[] }[];
  nearest_area?: { areaName?: { value?: string }[]; country?: { value?: string }[] }[];
  weather?: { date?: string; maxtempC?: string; maxtempF?: string; mintempC?: string; mintempF?: string }[];
};

/**
 * The shell keeps only the first 30,000 characters of a command's output and wttr.in's JSON is
 * longer: when it doesn't parse, the current conditions (at the top) are read field by field.
 */
function j1FromCut(text: string): J1 | undefined {
  const head = text.slice(0, text.indexOf('"weather"') > 0 ? text.indexOf('"weather"') : undefined);
  const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(head)?.[1];
  const value = (k: string) => new RegExp(`"${k}"\\s*:\\s*\\[\\s*\\{\\s*"value"\\s*:\\s*"([^"]*)"`).exec(head)?.[1];
  if (field('temp_C') === undefined) return undefined;
  const c = { temp_C: field('temp_C'), temp_F: field('temp_F'), FeelsLikeC: field('FeelsLikeC'), FeelsLikeF: field('FeelsLikeF'), humidity: field('humidity'), windspeedKmph: field('windspeedKmph'), windspeedMiles: field('windspeedMiles'), weatherDesc: [{ value: value('weatherDesc') }] };
  return { current_condition: [c], nearest_area: [{ areaName: [{ value: value('areaName') }], country: [{ value: value('country') }] }] };
}

function weatherJson(where: string, text: string): Card | undefined {
  let j: J1 | undefined;
  try {
    j = JSON.parse(text) as J1;
  } catch {
    j = j1FromCut(text);
  }
  if (!j) return undefined;
  const c = j.current_condition?.[0];
  if (!c) return undefined;
  // Fahrenheit when the address asked for it (?u) or the place is in the US; else Celsius.
  const f = /[?&]u\b/.test(where) || /\b(usa|united states)\b/i.test(JSON.stringify(j.nearest_area ?? []));
  const u = f ? 'F' : 'C';
  const pick = (cv?: string, fv?: string) => (f ? fv : cv);
  const temp = pick(c.temp_C, c.temp_F);
  return {
    kind: 'weather',
    // The place she asked for ("Paris"), not wttr.in's nearest weather station ("Saint-Merri").
    place: wttrPlace(where) || cut(j.nearest_area?.[0]?.areaName?.[0]?.value ?? '', 80),
    ...(temp !== undefined ? { temp: `${temp}°${u}` } : {}),
    ...(pick(c.FeelsLikeC, c.FeelsLikeF) !== undefined ? { feels: `${pick(c.FeelsLikeC, c.FeelsLikeF)}°${u}` } : {}),
    ...(c.weatherDesc?.[0]?.value ? { condition: cut(c.weatherDesc[0].value, 60) } : {}),
    ...(c.humidity ? { humidity: `${c.humidity}%` } : {}),
    ...(pick(c.windspeedKmph, c.windspeedMiles) ? { wind: `${pick(c.windspeedKmph, c.windspeedMiles)} ${f ? 'mph' : 'km/h'}` } : {}),
    ...(j.weather?.length ? { days: j.weather.slice(0, 3).map((d) => ({ date: cut(d.date, 10), ...(pick(d.maxtempC, d.maxtempF) ? { max: `${pick(d.maxtempC, d.maxtempF)}°${u}` } : {}), ...(pick(d.mintempC, d.mintempF) ? { min: `${pick(d.mintempC, d.mintempF)}°${u}` } : {}) })) } : {}),
  };
}

// ---------- planner ----------

/** "#12 [ ] Buy milk (high) — due Thu, Oct 30, 5:00 PM — notes" (src/planner.ts taskLine). */
function taskParts(line: string) {
  const m = /^#(\d+) \[[ x]\] (.*?)(?: \((low|high)\))?(?: — due (.*?))?(?: — .*)?$/.exec(line);
  return m ? { id: Number(m[1]), title: cut(m[2]), ...(m[3] ? { priority: m[3] } : {}), ...(m[4] ? { due: cut(m[4], 60) } : {}) } : undefined;
}

function taskCard(output: string): Card | undefined {
  const add = /^Added task (.*?)(?: in project "(.*)")?\.$/.exec(output.trim());
  if (add) {
    const p = taskParts(add[1]);
    return p ? { kind: 'task', action: 'added', ...p, ...(add[2] ? { project: cut(add[2], 80) } : {}) } : undefined;
  }
  const ch = /^(Completed|Reopened|Updated) (.*)\.$/.exec(output.trim());
  if (ch) {
    const p = taskParts(ch[2]);
    return p ? { kind: 'task', action: ch[1] === 'Completed' ? 'done' : ch[1] === 'Reopened' ? 'reopened' : 'updated', ...p } : undefined;
  }
  const del = /^Deleted task #(\d+) "(.*)"\.$/.exec(output.trim());
  return del ? { kind: 'task', action: 'deleted', id: Number(del[1]), title: cut(del[2]) } : undefined;
}

function reminderCard(args: Record<string, unknown>, output: string): Card | undefined {
  const t = output.trim();
  const at = /^Reminder #(\d+) set for (?!when )(.*?)(?:, repeating (\w+))?: "([\s\S]*?)"\./.exec(t);
  if (at) return { kind: 'reminder', action: 'set', id: Number(at[1]), text: cut(at[4]), when: cut(at[2], 60), ...(at[3] ? { repeat: at[3] } : {}), ...(args.call === true ? { call: true } : {}) };
  const pl = /^Reminder #(\d+) set for when the owner (arrives at|leaves) (.*?): "([\s\S]*?)"\./.exec(t);
  if (pl) return { kind: 'reminder', action: 'set', id: Number(pl[1]), text: cut(pl[4]), place: cut(pl[3], 80), when: pl[2] === 'leaves' ? 'leave' : 'arrive' };
  const c = /^Cancelled reminder #(\d+): "([\s\S]*?)"\.$/.exec(t);
  return c ? { kind: 'reminder', action: 'cancelled', id: Number(c[1]), text: cut(c[2]) } : undefined;
}

function noteCard(output: string): Card | undefined {
  const s = /^Saved note #(\d+) "(.*?)"(?: \((.*?)\))?, updated /.exec(output.trim());
  if (s) return { kind: 'note', action: 'saved', id: Number(s[1]), title: cut(s[2]), ...(s[3] ? { project: cut(s[3], 80) } : {}) };
  const d = /^Deleted note #(\d+) "(.*)"\.$/.exec(output.trim());
  return d ? { kind: 'note', action: 'deleted', id: Number(d[1]), title: cut(d[2]) } : undefined;
}

// ---------- calendar ----------

function calendarList(output: string): Card | undefined {
  const events = [...output.matchAll(/^- \[[^\]]*\] (.*?) · (.*?)(?: · (.*?))?(?: · with .*)?$/gm)].slice(0, 8).map((m) => ({ when: cut(m[1], 60), title: cut(m[2], 120), ...(m[3] && !m[3].startsWith('with ') ? { location: cut(m[3], 80) } : {}) }));
  if (!events.length) return /^Nothing on the calendar/.test(output.trim()) ? { kind: 'calendar', action: 'list', events: [] } : undefined;
  return { kind: 'calendar', action: 'list', events };
}

function calendarAdd(output: string): Card | undefined {
  const m = /^Added “(.*?)” (.*?) \(event [^)]*\)\./.exec(output.trim());
  return m ? { kind: 'calendar', action: 'added', events: [{ when: cut(m[2], 60), title: cut(m[1], 120) }] } : undefined;
}

// ---------- smart home ----------

function homeCard(output: string): Card | undefined {
  const m = /Done: ([\w]+\.[\w]+) for ([\w]+\.[\w-]+)\.(?: Now: (.*))?/.exec(output);
  if (!m) return undefined;
  // "light.kitchen · Kitchen · on (brightness 80%)"
  const now = m[3]?.split(' · ') ?? [];
  const name = now.length >= 3 ? now[1] : '';
  const state = now.length >= 2 ? now.at(-1) : '';
  return { kind: 'home', entity: cut(m[2], 80), service: cut(m[1], 60), ...(name ? { name: cut(name, 80) } : {}), ...(state ? { state: cut(state, 80) } : {}) };
}

// ---------- web search ----------

function searchCard(query: string, output: string): Card | undefined {
  const results = [...output.matchAll(/^\d+\. (.+)\n {3}(https?:\/\/\S+)/gm)].slice(0, 6).map((m) => {
    let host = '';
    try {
      host = new URL(m[2]).hostname.replace(/^www\./, '');
    } catch {
      /* not a URL */
    }
    return { title: cut(m[1], 140), url: m[2].slice(0, 500), host };
  });
  // Only web addresses go to the page as links.
  const safe = results.filter((r) => r.host && /^https?:\/\//.test(r.url));
  return safe.length ? { kind: 'search', query: cut(query, 120), results: safe } : undefined;
}
