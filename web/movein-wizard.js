// V4e (docs/ops/V4_DESIGN.md → V4e, docs/MOVE_IN_GUIDE.md): the move-in as a guided, five-step
// wizard (Settings → Data & health → Move in from another agent). This file is the plain data and
// the pure parts (which step a bundle's state belongs to, the exact command for each system and
// source); web/movein.js does the page. No imports and no DOM work at import time, so the tests
// check the commands in Node.

/** 3.1.1: the old agents' names as their makers write them (brand names, never translated). */
export const AGENT_LABEL = { hermes: 'Hermes Agent', openclaw: 'OpenClaw' };

/** "Memories: 10 · Skills: 17 · Past chats: 107" for a found agent (no plural forms to get wrong). */
export function countsLine(c, t) {
  const n = (x) => String(Math.max(0, Math.trunc(Number(x) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return t('Memories: {m} · Skills: {s} · Past chats: {c}', { m: n(c?.memories), s: n(c?.skills), c: n(c?.chats) });
}

/** The five steps, in order (the labels are translated by the page). */
export const STEPS = ['source', 'run', 'file', 'check', 'done'];

/** Where she can come from. `flag` is added to the collector's command (it finds the first two by itself). */
export const SOURCES = {
  hermes: { flag: '' },
  openclaw: { flag: '' },
  custom: { flag: ' --scan FOLDER' },
};

/** The systems the command is written for. */
export const SYSTEMS = ['windows', 'mac', 'linux'];

/** Where the collector can be downloaded when this server can't hand it out. */
export const COLLECTOR_FALLBACK = 'https://raw.githubusercontent.com/farena-ai/sara/main/scripts/sara-movein.py';

/** The system this browser runs on (a good first tab; the old computer may differ). */
export function guessSystem(nav = globalThis.navigator) {
  const p = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'mac';
  return 'linux';
}

/**
 * The command to paste on the old computer: download the collector from this server, check its
 * SHA-256 against the one this page shows, and only then run it. Mac and Linux use the same line as
 * the server's own (curl + sha256sum or shasum); Windows uses PowerShell's own commands and `py`
 * (the Python launcher python.org installs).
 */
export function collectorCommand({ origin, sha, system, source }) {
  const url = `${origin}/movein/sara-movein.py`;
  const flag = SOURCES[source]?.flag ?? '';
  if (system === 'windows') {
    return `Invoke-WebRequest -UseBasicParsing ${url} -OutFile sara-movein.py; if ((Get-FileHash sara-movein.py -Algorithm SHA256).Hash -eq '${sha}') { py sara-movein.py${flag} } else { Write-Host 'The download does not match. Do not run it.' }`;
  }
  return `curl -fsSL ${url} -o sara-movein.py && echo "${sha}  sara-movein.py" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -) && python3 sara-movein.py${flag}`;
}

/** The command when this server has no collector: download it from GitHub, then run it. */
export function fallbackCommand({ system, source }) {
  const flag = SOURCES[source]?.flag ?? '';
  if (system === 'windows') return `Invoke-WebRequest -UseBasicParsing ${COLLECTOR_FALLBACK} -OutFile sara-movein.py; py sara-movein.py${flag}`;
  return `curl -fsSL ${COLLECTOR_FALLBACK} -o sara-movein.py && python3 sara-movein.py${flag}`;
}

/** The step a bundle's state belongs to (null: no bundle yet, the person walks steps 1–3). */
export function stepForState(state) {
  if (!state) return null;
  // 'collecting' (3.1.1, Sara packs an agent on this computer) shows its progress where the check is.
  return state === 'imported' ? 'done' : 'check';
}

/** What the collector prints first (a shortened real run on a made-up Hermes home; English). */
export const EXAMPLE_OUTPUT = `Sara move-in collector 3.0  (read-only: nothing here will be changed)

Found: Hermes Agent home  ~/.hermes  (default)
  Personality     SOUL.md (689 B) + 3 older versions (history)     pack
  Memories        MEMORY.md 6 entries, USER.md 3 entries           pack
  Sessions        state.db: 3 sessions, 10 messages (44.0 KB)      pack
  Skills          4 folders (868 B)                                pack
  Schedules       cron/jobs.json: 6 jobs                           pack
Skipped
  Secrets         .env, auth.json (never opened)                   -
  Logs            3 files, 7.8 KB                                  skip
Sensitive (off until you say yes)
  Health/medical  1 files (190 B)                                  [y/N]
Bundle: ~125.6 KB -> ./robin-2026-11-08.saramove
This file is as private as your diary: delete it after the move-in.
Include Health/medical items? [y/N] n
Continue? [Y/n] y
Written: ./robin-2026-11-08.saramove (118.2 KB)`;
