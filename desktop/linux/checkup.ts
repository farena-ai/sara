// Read-only Linux checks. All locations and subprocess arguments are chosen here, never by a server.
import { lstatSync, readdirSync, readFileSync, statfsSync, existsSync, openSync, closeSync, fstatSync, constants, opendirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHECKS, checkupData, type CheckData, type FolderSize, type StartupItem, type BrowserExtensions } from '../../src/hands-checkup.ts';
import { findCli, runCli } from '../../src/hands-managers.ts';

function smallFile(path: string, max = 128 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const st = fstatSync(fd); if (!st.isFile() || st.size > max) throw new Error('File is not a small regular file'); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function dirs(path: string): string[] { try { return readdirSync(path).slice(0, 1000); } catch { return []; } }
export function walkSize(root: string, limits: { entries?: number; ms?: number } = {}): Omit<FolderSize, 'id' | 'name'> {
  let bytes = 0, files = 0, count = 0, partial = false;
  const end = Date.now() + Math.min(4000, limits.ms ?? 1000); const max = Math.min(200_000, limits.entries ?? 20_000);
  const stack = [root];
  let device: number | undefined;
  while (stack.length) {
    if (count++ >= max || Date.now() >= end) { partial = true; break; }
    const path = stack.pop()!;
    try {
      const st = lstatSync(path); if (st.isSymbolicLink()) continue;
      device ??= st.dev; if (st.dev !== device) { partial = true; continue; }
      if (st.isFile()) { files++; bytes += st.size; }
      else if (st.isDirectory()) {
        // Never enqueue an unbounded directory or recurse through mounted filesystems.
        const directory = opendirSync(path);
        try {
          let c;
          while ((c = directory.readSync())) {
            if (stack.length + count >= max || Date.now() >= end) { partial = true; break; }
            if (!c.isSymbolicLink()) stack.push(join(path, c.name));
          }
        } finally { directory.closeSync(); }
      }
    } catch { partial = true; }
  }
  return { bytes, files, ...(partial ? { partial } : {}) };
}
export class LinuxSystem {
  #home: string; #config: string; #machine: string[]; #cache: string;
  constructor(opts: { home?: string; config?: string; machineConfig?: string[]; cache?: string } = {}) {
    this.#home = opts.home ?? homedir(); this.#config = opts.config ?? process.env.XDG_CONFIG_HOME ?? join(this.#home, '.config');
    this.#cache = opts.cache ?? process.env.XDG_CACHE_HOME ?? join(this.#home, '.cache');
    this.#machine = opts.machineConfig ?? (process.env.XDG_CONFIG_DIRS ?? '/etc/xdg').split(':').filter((p) => p.startsWith('/'));
  }
  async check(args: Record<string, unknown> = {}): Promise<CheckData> {
    const out: CheckData = { os: 'linux', at: new Date().toISOString(), checks: {} };
    const chosen = new Set(Array.isArray(args.checks) ? args.checks.filter((c): c is string => typeof c === 'string') : CHECKS);
    for (const check of CHECKS) {
      if (!chosen.has(check)) continue;
      try {
        if (check === 'startup') {
          const seen = new Set<string>(); const items: StartupItem[] = [];
          for (const [index, config] of [this.#config, ...this.#machine].entries()) {
            for (const file of dirs(join(config, 'autostart')).filter((x) => x.endsWith('.desktop'))) {
              if (seen.has(file)) continue; seen.add(file);
              const text = smallFile(join(config, 'autostart', file));
              const group = text.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
              const get = (key: string) => group.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim();
              const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '').split(':');
              const only = get('OnlyShowIn')?.split(';').filter(Boolean); const not = get('NotShowIn')?.split(';').filter(Boolean);
              items.push({ id: `desktop:${items.length + 1}`, name: get('Name') || file, where: index === 0 ? 'user' : 'machine', enabled: get('Hidden') !== 'true' && get('X-GNOME-Autostart-enabled') !== 'false' && (!only || only.some((d) => desktops.includes(d))) && !not?.some((d) => desktops.includes(d)) });
              if (items.length >= 100) break;
            }
          }
          out.checks.startup = { ok: true, items: items.slice(0, 100), total: seen.size };
        } else if (check === 'disk') {
          const st = statfsSync(this.#home, { bigint: true });
          out.checks.disk = { ok: true, volumes: [{ name: 'Home', total: Number(st.blocks * st.bsize), free: Number(st.bavail * st.bsize) }] };
        } else if (check === 'folders') {
          out.checks.folders = { ok: true, folders: ['Downloads', 'Documents', 'Desktop', 'Pictures', 'Videos', 'Music'].map((name) => ({ id: name.toLowerCase(), name, ...walkSize(join(this.#home, name)) })) };
        } else if (check === 'temp') {
          out.checks.temp = { ok: true, places: [{ id: 'cache', name: 'User caches', ...walkSize(this.#cache) }, { id: 'trash', name: 'Trash', ...walkSize(join(this.#home, '.local', 'share', 'Trash', 'files')) }] };
        } else if (check === 'battery') {
          const root = '/sys/class/power_supply'; const battery = dirs(root).find((n) => { try { return smallFile(join(root, n, 'type')).trim() === 'Battery'; } catch { return false; } });
          if (!battery) out.checks.battery = { ok: true, present: false };
          else {
            const get = (name: string): number | undefined => { try { const n = Number(smallFile(join(root, battery, name)).trim()); return Number.isFinite(n) ? n : undefined; } catch { return undefined; } };
            const full = get('energy_full') ?? get('charge_full'); const design = get('energy_full_design') ?? get('charge_full_design');
            out.checks.battery = { ok: true, present: true, percent: get('capacity'), charging: smallFile(join(root, battery, 'status')).trim() === 'Charging', cycles: get('cycle_count'), ...(full && design ? { health: Math.round(full * 100 / design) } : {}) };
          }
        } else if (check === 'extensions') {
          const browsers: BrowserExtensions[] = [];
          for (const [name, folder] of [['Chrome', 'google-chrome'], ['Chromium', 'chromium'], ['Brave', 'BraveSoftware/Brave-Browser'], ['Edge', 'microsoft-edge']]) {
            for (const profile of dirs(join(this.#config, folder)).filter((p) => p === 'Default' || /^Profile \d+$/.test(p)).slice(0, 8)) {
              const extensions: BrowserExtensions['extensions'] = [];
              const root = join(this.#config, folder, profile, 'Extensions');
              for (const id of dirs(root).filter((x) => /^[a-p]{32}$/.test(x)).slice(0, 200)) {
                const versions = dirs(join(root, id)).filter((x) => /^[\d._]+$/.test(x)).sort().reverse();
                try { const manifest = JSON.parse(smallFile(join(root, id, versions[0], 'manifest.json'))) as { name?: string }; extensions.push({ id, name: manifest.name ?? id, enabled: true }); } catch { /* unreadable extension */ }
              }
              browsers.push({ browser: name, profile, extensions });
            }
          }
          out.checks.extensions = { ok: true, browsers: browsers.slice(0, 8) };
        } else if (check === 'updates') {
          const apt = findCli('apt', ['/usr/bin', '/bin']);
          if (!apt) { out.checks.updates = { ok: false, why: 'No supported read-only update cache query (apt list --upgradable); no refresh or installation was attempted.' }; continue; }
          const query = await runCli(apt, ['list', '--upgradable'], { ...process.env, LC_ALL: 'C' }, 10_000);
          if (query.code !== 0) throw new Error('Cached update list unavailable');
          const names = query.stdout.split('\n').filter((l) => l.includes('[upgradable from:')).map((l) => l.split('/')[0]);
          out.checks.updates = { ok: true, pending: names.length, reboot: existsSync('/run/reboot-required'), names: names.slice(0, 20), source: 'apt list --upgradable (local cache, no refresh)' };
        }
      } catch { Object.assign(out.checks, { [check]: { ok: false, why: 'Not available or permission denied; nothing was changed.' } }); }
    }
    return checkupData(out);
  }
}
