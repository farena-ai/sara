// V2.3: a fake Home Assistant for tests and live checks: the REST API (bearer token, states, scenes,
// scripts, locks) and an mDNS responder on loopback that answers the real `_home-assistant._tcp`
// question with PTR/SRV/TXT/A records, like python-zeroconf's legacy-unicast reply.
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HaState } from '../../src/tools/home.ts';

export interface FakeHa {
  url: string;
  port: number;
  token: string;
  calls: { path: string; body: unknown }[];
  states: Map<string, HaState>;
  /** The mDNS responder's port (send the question to 127.0.0.1 here). */
  mdnsPort: number;
  /** Questions the responder got (decoded names). */
  questions: string[];
  close(): Promise<void>;
}

// A token built at run time (never a realistic-looking literal in the repo).
const fakeToken = () => ['test', 'ha', 'token', 'x'.repeat(24)].join('-');

export const FAKE_STATES: HaState[] = [
  { entity_id: 'scene.movie_night', state: 'scening', attributes: { friendly_name: 'Movie night' } },
  { entity_id: 'scene.good_morning', state: 'scening', attributes: { friendly_name: 'Good morning' } },
  { entity_id: 'scene.unlock_front_door', state: 'scening', attributes: { friendly_name: 'Unlock front door' } },
  { entity_id: 'script.bedtime', state: 'off', attributes: { friendly_name: 'Bedtime' } },
  { entity_id: 'script.disarm_alarm', state: 'off', attributes: { friendly_name: 'Disarm alarm' } },
  { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living room' } },
  { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } },
];

function name(parts: string[]): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function rr(owner: string[], type: number, data: Buffer, ttl = 120): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(type === 12 ? 1 : 0x8001, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}

/** The reply a Home Assistant at `ip:port` gives (the question's id echoed, as legacy unicast wants). */
export function haAnswer(id: number, o: { instance: string; ip: string; port: number; txt: Record<string, string> }): Buffer {
  const service = ['_home-assistant', '_tcp', 'local'];
  const inst = [o.instance, ...service];
  const host = ['homeassistant', 'local'];
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, o.port >> 8, o.port & 255]), name(host)]);
  const txt = Buffer.concat(Object.entries(o.txt).map(([k, v]) => {
    const b = Buffer.from(`${k}=${v}`, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  }));
  const a = Buffer.from(o.ip.split('.').map(Number));
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(0, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(3, 10);
  return Buffer.concat([head, rr(service, 12, name(inst)), rr(inst, 33, srv), rr(inst, 16, txt), rr(host, 1, a)]);
}

/** Question names in a query packet (no compression in questions we send). */
function questionNames(msg: Buffer): string[] {
  const n = msg.readUInt16BE(4);
  const names: string[] = [];
  let i = 12;
  for (let q = 0; q < n && i < msg.length; q++) {
    const labels: string[] = [];
    while (msg[i]) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('utf8'));
      i += msg[i] + 1;
    }
    i += 5;
    names.push(labels.join('.'));
  }
  return names;
}

export async function startFakeHa(o: { token?: string; locationName?: string; mdns?: boolean } = {}): Promise<FakeHa> {
  const token = o.token ?? fakeToken();
  const states = new Map(FAKE_STATES.map((s) => [s.entity_id, structuredClone(s)]));
  const calls: { path: string; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/manifest.json') return json(200, { name: 'Home Assistant' });
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { message: '401: Unauthorized' });
      if (path === '/api/config') return json(200, { location_name: o.locationName ?? 'Test Home', version: '2026.11.1' });
      if (path === '/api/states') return json(200, [...states.values()]);
      const one = /^\/api\/states\/(.+)$/.exec(path);
      if (one) return states.has(one[1]) ? json(200, states.get(one[1])) : json(404, { message: 'Entity not found.' });
      const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(path);
      if (svc && req.method === 'POST') {
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path, body });
        const s = states.get(String(body.entity_id));
        if (s && svc[1] === 'lock') s.state = svc[2] === 'unlock' ? 'unlocked' : 'locked';
        if (s && svc[1] === 'scene') s.last_changed = new Date().toISOString();
        return json(200, s ? [s] : []);
      }
      return json(404, { message: 'Not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const questions: string[] = [];
  let sock: Socket | undefined;
  let mdnsPort = 0;
  if (o.mdns !== false) {
    sock = createSocket('udp4');
    sock.on('message', (msg, from) => {
      const names = questionNames(msg);
      questions.push(...names);
      if (!names.includes('_home-assistant._tcp.local')) return;
      const reply = haAnswer(msg.readUInt16BE(0), { instance: o.locationName ?? 'Test Home', ip: '127.0.0.1', port, txt: { location_name: o.locationName ?? 'Test Home', version: '2026.11.1', uuid: 'fake', internal_url: `http://homeassistant.local:${port}` } });
      sock!.send(reply, from.port, from.address);
    });
    await new Promise<void>((r) => sock!.bind(0, '127.0.0.1', r));
    mdnsPort = sock.address().port;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    calls,
    states,
    mdnsPort,
    questions,
    async close() {
      sock?.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
