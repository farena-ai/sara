// EC9 (docs/ops/EC89_DESIGN.md): the network guard for plugin jobs on the Node-only fence (Windows
// and other computers without bubblewrap or a container engine). Node 24's permission model has no
// network switch, so this preload (loaded with --import before the job's own code) closes every
// way out except the egress proxy: TCP/TLS connects to anything but SARA_NET_ALLOW, local sockets
// and pipes (the Docker engine pipe among them), UDP, and DNS look-ups. process.binding is already
// refused by the permission model, child processes, workers, addons and WASI are not granted, and
// the patched methods can be neither replaced nor deleted. A Node-level control, not an OS boundary.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

const allow = process.env.SARA_NET_ALLOW ?? '';
delete process.env.SARA_NET_ALLOW;
const cut = allow.lastIndexOf(':');
const allowHost = cut > 0 ? allow.slice(0, cut) : undefined;
const allowPort = cut > 0 ? Number(allow.slice(cut + 1)) : undefined;

function blocked(what) {
  const err = new Error(`Network blocked by Sara for this plugin job: ${what}${allowHost ? ' (only the egress proxy is reachable)' : ''}`);
  err.code = 'ERR_SARA_NET_BLOCKED';
  return err;
}
function lock(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: false, configurable: false, enumerable: false });
}

const connect = net.Socket.prototype.connect;
lock(net.Socket.prototype, 'connect', function guardedConnect(...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  let port;
  let host = 'localhost';
  let path;
  if (o && typeof o === 'object') {
    port = o.port;
    host = o.host ?? 'localhost';
    path = o.path;
  } else if (typeof o === 'string' && !/^\d+$/.test(o)) path = o;
  else {
    port = o;
    if (typeof args[1] === 'string') host = args[1];
  }
  if (path === undefined && allowHost !== undefined && host === allowHost && Number(port) === allowPort) return Reflect.apply(connect, this, args);
  const err = blocked(path !== undefined ? 'a local socket or pipe' : `${host}:${port}`);
  process.nextTick(() => this.destroy(err));
  return this;
});

for (const k of ['send', 'connect']) {
  lock(dgram.Socket.prototype, k, function guardedUdp() {
    throw blocked('UDP');
  });
}

const noDns = () => {
  throw blocked('DNS look-ups');
};
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const k of Object.getOwnPropertyNames(target)) if (/^(lookup|lookupService|resolve|resolve\w+|reverse)$/.test(k) && typeof target[k] === 'function') lock(target, k, noDns);
}
