// Portal transport is qualified separately. Raw desktop images/input are deliberately NOT
// exposed as hands ops until compositor-safe redaction and local takeover/Stop are available.
import { randomBytes } from 'node:crypto';
import { DBus, variant, type Variant } from './dbus.ts';

const DEST = 'org.freedesktop.portal.Desktop';
const PATH = '/org/freedesktop/portal/desktop';
export class Portal {
  bus: DBus;
  constructor(bus: DBus) { this.bus = bus; }
  async request(iface: string, method: string, signature: string, args: unknown[], signal?: AbortSignal): Promise<Record<string, Variant>> {
    signal?.throwIfAborted();
    // Resolve the unique owner; another bus client cannot forge the permission response.
    try { await this.bus.owner(DEST); } catch { await this.bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'StartServiceByName', 'su', [DEST, 0]); }
    const owner = await this.bus.owner(DEST);
    const token = `sara_${randomBytes(12).toString('hex')}`;
    let path = `${PATH}/request/${this.bus.name.slice(1).replaceAll('.', '_')}/${token}`;
    await this.bus.match(`type='signal',sender='${owner}',interface='org.freedesktop.portal.Request',member='Response'`);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (err?: Error, result?: Record<string, Variant>) => {
        if (finished) return; finished = true; clearTimeout(timer); off(); signal?.removeEventListener('abort', abort);
        if (err) { void this.bus.call(DEST, path, 'org.freedesktop.portal.Request', 'Close').catch(() => {}); reject(err); }
        else resolve(result ?? {});
      };
      const abort = () => finish(new Error('Portal request cancelled'));
      const timer = setTimeout(() => finish(new Error('Portal request timed out')), 120_000);
      const off = this.bus.onSignal((m) => {
        if (m.sender !== owner || m.path !== path || m.interface !== 'org.freedesktop.portal.Request' || m.member !== 'Response') return;
        if (m.body?.[0] !== 0) finish(new Error('Portal permission denied or cancelled'));
        else finish(undefined, m.body[1] as Record<string, Variant>);
      });
      signal?.addEventListener('abort', abort, { once: true });
      const options = { ...(args.at(-1) as object), handle_token: variant('s', token) };
      void this.bus.call(DEST, PATH, iface, method, signature, [...args.slice(0, -1), options]).then(([returned]) => {
        if (returned !== path) finish(new Error('Unexpected portal request path'));
      }, (err: Error) => finish(err));
    });
  }
  async screenshot(signal?: AbortSignal): Promise<{ uri: string }> {
    const result = await this.request('org.freedesktop.portal.Screenshot', 'Screenshot', 'sa{sv}', ['', { interactive: variant('b', true), modal: variant('b', true) }], signal);
    const uri = String(result.uri?.value ?? '');
    const u = new URL(uri);
    if (u.protocol !== 'file:' || u.hostname || u.username || u.password) throw new Error('Portal did not return a local screenshot');
    return { uri };
  }
}
