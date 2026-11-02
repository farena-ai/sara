// PL2a (docs/design/POLISH2.md N3): the guided Signal setup's two server checks, both before or after
// the plugin is added. `probe` asks signal-cli's JSON-RPC daemon for its version (one line out, one
// line back, 3 s at most) so step 3 turns ✓ only when Sara really reached it; `linkQr` draws the
// `sgnl://linkdevice?…` address that `signal-cli link` prints as a QR code for the phone. Only this
// computer (or, with the switch, an address on the home network) is ever tried: signal-cli has no
// password, so it must never be reached over the internet.
import { connect } from 'node:net';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../tools/builtin.ts';
import { outboundAllowed } from '../net-guard.ts';
import { qrSvg } from '../qr.ts';

export const SIGNAL = 'signal';

/** The codes the page turns into one plain sentence each (web/signal.js DIAG). */
export type SignalProbeCode = 'BAD_ADDRESS' | 'NOT_LOCAL' | 'DAEMON_DOWN' | 'DAEMON_SLOW' | 'NOT_SIGNAL';

export interface SignalProbe {
  ok: boolean;
  address: string;
  version?: string;
  code?: SignalProbeCode;
}

/** `127.0.0.1:7583`, `localhost:7583`, `[::1]:7583` or a LAN address with the switch on. */
export function parseDaemon(raw: unknown, onOtherMachine = false): { host: string; port: number } | { code: SignalProbeCode } {
  const s = String(raw ?? '').trim() || '127.0.0.1:7583';
  const m = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(s);
  if (!m) return { code: 'BAD_ADDRESS' };
  const host = (m[1] ?? m[2]).toLowerCase();
  const port = Number(m[3]);
  if (!(port >= 1 && port <= 65535)) return { code: 'BAD_ADDRESS' };
  const loop = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (loop) return { host: host === 'localhost' ? '127.0.0.1' : host, port };
  if (!isIP(host)) return { code: onOtherMachine ? 'BAD_ADDRESS' : 'NOT_LOCAL' };
  if (!onOtherMachine || !isPrivateAddress(host)) return { code: 'NOT_LOCAL' };
  return { host, port };
}

/** One `version` call to the daemon. Never sends anything else; closes at once. */
export function probeDaemon(raw: unknown, o: { onOtherMachine?: boolean; timeoutMs?: number } = {}): Promise<SignalProbe> {
  const address = String(raw ?? '').trim() || '127.0.0.1:7583';
  const at = parseDaemon(address, o.onOtherMachine === true);
  if ('code' in at) return Promise.resolve({ ok: false, address, code: at.code });
  // The network guard has the last word (private local mode keeps loopback; the home network only with the switch).
  if (!outboundAllowed(`http://${at.host.includes(':') ? `[${at.host}]` : at.host}:${at.port}/`, o.onOtherMachine === true)) return Promise.resolve({ ok: false, address, code: 'NOT_LOCAL' });
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const sock = connect({ host: at.host, port: at.port });
    const finish = (r: SignalProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, address, code: 'DAEMON_SLOW' }), o.timeoutMs ?? 3000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'version', id: 'sara-setup' })}\n`));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) return finish({ ok: false, address, code: 'NOT_SIGNAL' });
      for (const line of buf.split('\n').slice(0, -1)) {
        try {
          const msg = JSON.parse(line) as { id?: unknown; result?: { version?: unknown } };
          if (msg.id !== 'sara-setup') continue;
          if (msg.result && typeof msg.result.version === 'string') return finish({ ok: true, address, version: msg.result.version.slice(0, 40) });
          return finish({ ok: false, address, code: 'NOT_SIGNAL' });
        } catch {
          return finish({ ok: false, address, code: 'NOT_SIGNAL' });
        }
      }
    });
    sock.on('error', (err: NodeJS.ErrnoException) => finish({ ok: false, address, code: err.code === 'ETIMEDOUT' ? 'DAEMON_SLOW' : 'DAEMON_DOWN' }));
    sock.on('close', () => finish({ ok: false, address, code: buf ? 'NOT_SIGNAL' : 'DAEMON_DOWN' }));
  });
}

/** The link address `signal-cli link -n Sara` prints, as a QR image (nothing else is drawn). */
export function linkQr(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!/^sgnl:\/\/linkdevice\?[\w%=&.~+/-]{10,600}$/.test(s)) return null;
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(s)).toString('base64')}`;
}
