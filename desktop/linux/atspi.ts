import { blockedKind, maskDesktopText } from '../../src/hands-desktop.ts';
import { DBus, type Variant } from './dbus.ts';

const ACCESS = 'org.a11y.atspi.Accessible';
const ROOT = '/org/a11y/atspi/accessible/root';
export class AtSpi {
  bus: DBus;
  constructor(bus: DBus) { this.bus = bus; }
  static async connect(session: DBus): Promise<AtSpi> {
    const [address] = await session.call('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress');
    const bus = new DBus(); await bus.connect(String(address)); return new AtSpi(bus);
  }
  async elements(extra: string[] = []): Promise<{ items: { ref: string; role: string; name: string; secret?: boolean }[]; partial: boolean }> {
    const items: { ref: string; role: string; name: string; secret?: boolean }[] = [];
    const visited = new Set<string>(); const end = Date.now() + 4000; let partial = false;
    const visit = async (dest: string, path: string, depth: number): Promise<void> => {
      if (items.length >= 300 || visited.size >= 600 || depth > 8 || Date.now() >= end) { partial = true; return; }
      const key = `${dest}:${path}`; if (visited.has(key)) return; visited.add(key);
      const call = (iface: string, member: string, sig = '', body: unknown[] = []) => this.bus.call(dest, path, iface, member, sig, body, Math.max(1, Math.min(500, end - Date.now())));
      try {
        const [role] = await call(ACCESS, 'GetRoleName');
        // Do not even request the name, text, value or children of secure objects.
        if (/password|secure|terminal/i.test(String(role))) { items.push({ ref: `e${items.length + 1}`, role: 'password', name: '(hidden)', secret: true }); return; }
        const [v] = await call('org.freedesktop.DBus.Properties', 'Get', 'ss', [ACCESS, 'Name']);
        const name = String((v as Variant).value ?? '');
        if (blockedKind(name, '', extra) || /\bsara\b|security|authentication|sudo|polkit/i.test(name)) return;
        items.push({ ref: `e${items.length + 1}`, role: maskDesktopText(String(role)).slice(0, 60), name: maskDesktopText(name).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) });
        const [children] = await call(ACCESS, 'GetChildren');
        for (const [childDest, childPath] of (children as [string, string][]).slice(0, 300)) {
          if (childPath === '/org/a11y/atspi/null') continue;
          await visit(childDest || dest, childPath, depth + 1);
        }
      } catch { partial = true; }
    };
    await visit('org.a11y.atspi.Registry', ROOT, 0);
    return { items, partial };
  }
}
