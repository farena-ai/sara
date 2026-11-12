// The Sara apps (Windows, Mac) signed in to this space and their versions (docs/desktop.md → How the
// app updates). The app's page checks in every few minutes with the app's version and how it updates;
// Settings → Devices lists them, and "Update it" leaves a request the app picks up at its next check-in
// (it then installs only what the signed update notice vouches for, never anything from this server).
// Each space (the owner, each household member) keeps its own file next to its data: a member only
// ever sees and asks their own apps; the owner may also ask a member's app.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from './updates.ts';

export const APP_INSTALLS_FILE = 'app-installs.json';
/** How often the app's page checks in (the web page uses the same number). */
export const CHECKIN_SECONDS = 300;
/** An app not seen this long is forgotten. */
const FORGET_DAYS = 60;

export type AppPlatform = 'windows' | 'mac';
/** remote: app only, updates itself · server: Sara's server on that computer brings it · manual: not installed by Setup. */
export type AppHow = 'remote' | 'server' | 'manual';

export interface AppInstall {
  platform: AppPlatform;
  version: string;
  computer: string;
  /** 3.5.2: the computer's system, as the app says it ("Windows 11 Home (26100.4061)"). */
  os?: string;
  /** Fred fix A: how the app draws its window's top ("strip page, #0b0c0e page, shown night, …"). */
  frame?: string;
  how: AppHow;
  /** "Update the app by itself" is on there. */
  auto: boolean;
  /** The app can update itself when asked (apps before this feature never check in at all). */
  selfUpdate: boolean;
  /** The app's own update state ("ready", "downloading", "failed"…) and the newest version it knows. */
  state?: string;
  latest?: string;
  message?: string;
  /** The sign-in's label when it checked in ("Sara app on Windows"). */
  label?: string;
  seenAt: string;
  /** Update it was asked (not yet picked up by the app). */
  askedAt?: string;
  askedBy?: string;
  /** The app picked the request up. */
  takenAt?: string;
}

interface InstallsFile {
  v: 1;
  apps: Record<string, AppInstall>;
}

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/;
const STATES = new Set(['idle', 'checking', 'current', 'available', 'downloading', 'ready', 'installing', 'failed']);
const plain = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/** What an app may say about itself (anything else is dropped). Throws on what isn't an app check-in. */
export function cleanCheckin(body: Record<string, unknown>): Omit<AppInstall, 'seenAt' | 'askedAt' | 'askedBy' | 'takenAt' | 'label'> {
  const platform = body.platform === 'mac' ? 'mac' : body.platform === 'windows' ? 'windows' : undefined;
  if (!platform) throw new TypeError('platform must be windows or mac');
  const version = plain(body.version, 40);
  if (!VERSION.test(version)) throw new TypeError('version must look like 3.4.5');
  const how: AppHow = body.how === 'server' ? 'server' : body.how === 'manual' ? 'manual' : 'remote';
  const state = plain(body.state, 20);
  const latest = plain(body.latest, 40);
  return {
    platform,
    version,
    computer: plain(body.computer, 80),
    ...(plain(body.os, 60) ? { os: plain(body.os, 60) } : {}),
    ...(plain(body.frame, 200) ? { frame: plain(body.frame, 200) } : {}),
    how,
    auto: body.auto !== false,
    selfUpdate: body.selfUpdate === true,
    ...(STATES.has(state) ? { state } : {}),
    ...(VERSION.test(latest) ? { latest } : {}),
    ...(plain(body.message, 300) ? { message: plain(body.message, 300) } : {}),
  };
}

export class AppInstalls {
  readonly #file: string;
  readonly #now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.#file = join(dir, APP_INSTALLS_FILE);
    this.#now = now;
  }

  read(): InstallsFile {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<InstallsFile>;
      if (raw && raw.v === 1 && raw.apps && typeof raw.apps === 'object') return { v: 1, apps: raw.apps };
    } catch {
      /* none yet, or unreadable: start again (it only lists apps) */
    }
    return { v: 1, apps: {} };
  }

  #write(f: InstallsFile): void {
    const dir = join(this.#file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(f, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  /** The app behind sign-in `id` checked in. `ask`: an Update it request it should act on now (handed over once). */
  checkin(id: string, info: ReturnType<typeof cleanCheckin>, label: string): { ask: boolean; askedBy?: string } {
    const f = this.read();
    const old = f.apps[id];
    const now = this.#now().toISOString();
    const ask = Boolean(old?.askedAt);
    // A request is handed over once; the app's state then shows how it goes.
    f.apps[id] = { ...info, label: plain(label, 80), seenAt: now, ...(ask ? { takenAt: now } : old?.takenAt ? { takenAt: old.takenAt } : {}) };
    // Reaching the version asked for (or newer) ends the story.
    if (!ask && old?.takenAt && old.version !== info.version) delete f.apps[id].takenAt;
    this.#write(f);
    return { ask, ...(ask && old?.askedBy ? { askedBy: old.askedBy } : {}) };
  }

  /** Update it: the app updates at its next check-in. False when there is no such app. */
  ask(id: string, by: string): boolean {
    const f = this.read();
    const a = f.apps[id];
    if (!a) return false;
    a.askedAt = this.#now().toISOString();
    a.askedBy = plain(by, 40);
    this.#write(f);
    return true;
  }

  /** The apps here, newest first; apps whose sign-in is gone (when `alive` is given) or unseen for 60 days are forgotten. */
  list(alive?: (id: string) => boolean): [string, AppInstall][] {
    const f = this.read();
    const cutoff = this.#now().getTime() - FORGET_DAYS * 86_400_000;
    let changed = false;
    for (const [id, a] of Object.entries(f.apps)) {
      if ((alive && !alive(id)) || !(Date.parse(a.seenAt) > cutoff)) {
        delete f.apps[id];
        changed = true;
      }
    }
    if (changed) this.#write(f);
    return Object.entries(f.apps).sort((x, y) => Date.parse(y[1].seenAt) - Date.parse(x[1].seenAt));
  }

  /** The app behind sign-in `id` (if it checked in). */
  get(id: string): AppInstall | undefined {
    return this.read().apps[id];
  }
}

/** Why Update it can't help for this app ('' = it can). */
export function cannotAsk(a: AppInstall): string {
  if (a.how === 'server') return 'This app is on the computer Sara runs on: it updates together with her server (Settings → Updates there).';
  if (a.how === 'manual' || !a.selfUpdate) return 'This app can’t update itself: download Sara-Setup from the download page and run it on that computer.';
  return '';
}

export interface AppInstallView {
  id: string;
  platform: AppPlatform;
  version: string;
  computer: string;
  os?: string;
  frame?: string;
  label: string;
  how: AppHow;
  auto: boolean;
  seenAt: string;
  state?: string;
  latest?: string;
  message?: string;
  /** Older than this server. */
  behind: boolean;
  /** Update it may be pressed (it is behind, or something newer is ready there). */
  canAsk: boolean;
  why?: string;
  asked: boolean;
  current?: boolean;
}

export function appInstallView(id: string, a: AppInstall, serverVersion: string, currentId?: string): AppInstallView {
  const behind = VERSION.test(serverVersion) && compareVersions(serverVersion, a.version) > 0;
  const newer = Boolean(a.latest && compareVersions(a.latest, a.version) > 0);
  const why = cannotAsk(a);
  return {
    id,
    platform: a.platform,
    version: a.version,
    computer: a.computer,
    ...(a.os ? { os: a.os } : {}),
    ...(a.frame ? { frame: a.frame } : {}),
    label: a.label ?? '',
    how: a.how,
    auto: a.auto,
    seenAt: a.seenAt,
    ...(a.state ? { state: a.state } : {}),
    ...(a.latest ? { latest: a.latest } : {}),
    ...(a.message ? { message: a.message } : {}),
    behind,
    canAsk: !why && (behind || newer),
    ...(why && (behind || newer) ? { why } : {}),
    asked: Boolean(a.askedAt || a.takenAt),
    ...(currentId === id ? { current: true } : {}),
  };
}
