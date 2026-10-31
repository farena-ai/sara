// Phase 90 (computer use CU4, docs/design/COMPUTER_USE.md §8.2): the "password never leaves the
// computer" capture for the real apps. A recording relay in front of a Sara server: point a desktop
// test build at it (as its server address) and it passes every byte through unchanged while writing
// down everything that crossed, both ways: the HTTP requests and answers, and every WebSocket frame of
// the hands channel decoded (the app's frames are masked on the wire, so a plain byte capture would
// hide a password; these are unmasked first). Then search the capture for the test password.
//
//   node scripts/hands-capture.ts --listen 7887 --to http://127.0.0.1:7886 --out <capture file>
//   node scripts/hands-capture.ts --grep <capture file> --pieces fake-,pass-,...   (prints the hits; exit 1 when found)
//
// The test password is given in pieces (and joined here) so it never sits whole in a command line or a
// log. Loopback only. A test tool: it never runs inside Sara.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** Decodes WebSocket frames from a byte stream (masked or not), calling back with each payload. */
export class FrameReader {
  #buf = Buffer.alloc(0);
  readonly onFrame: (opcode: number, payload: Buffer) => void;
  constructor(onFrame: (opcode: number, payload: Buffer) => void) {
    this.onFrame = onFrame;
  }
  push(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        at = 10;
      }
      const maskAt = at;
      if (masked) at += 4;
      if (b.length < at + len) return;
      const payload = Buffer.from(b.subarray(at, at + len));
      if (masked) for (let k = 0; k < payload.length; k++) payload[k] ^= b[maskAt + (k % 4)];
      this.#buf = b.subarray(at + len);
      this.onFrame(opcode, payload);
    }
  }
}

/** Joins the pieces and lists where the result appears in a capture (text and latin1 bytes alike). */
export function findIn(capture: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  for (let i = capture.indexOf(needle); i >= 0; i = capture.indexOf(needle, i + 1)) hits.push(i);
  return hits;
}

function relay(listen: number, to: URL, out: string): void {
  writeFileSync(out, '');
  let n = 0;
  const rec = (who: string, what: string, body: Buffer | string) => {
    appendFileSync(out, `\n--- ${new Date().toISOString()} ${who} ${what} (${Buffer.byteLength(body)} bytes)\n`);
    appendFileSync(out, typeof body === 'string' ? body : body.toString('latin1'));
  };
  const server = createServer((client: Socket) => {
    const id = ++n;
    const up = connect({ host: to.hostname, port: Number(to.port || 80) });
    // Until a connection upgrades, record raw bytes (HTTP); after "101", decode frames.
    let ws = false;
    const fromApp = new FrameReader((op, p) => rec(`#${id} app→server`, `ws op ${op}`, p));
    const fromServer = new FrameReader((op, p) => rec(`#${id} server→app`, `ws op ${op}`, p));
    client.on('data', (d: Buffer) => {
      up.write(d);
      if (ws) fromApp.push(d);
      else rec(`#${id} app→server`, 'bytes', d);
    });
    up.on('data', (d: Buffer) => {
      client.write(d);
      if (ws) return fromServer.push(d);
      const head = d.toString('latin1');
      const i = head.indexOf('\r\n\r\n');
      if (/^HTTP\/1\.1 101 /.test(head) && i >= 0) {
        rec(`#${id} server→app`, 'bytes', head.slice(0, i + 4));
        ws = true;
        if (d.length > i + 4) fromServer.push(d.subarray(i + 4));
      } else rec(`#${id} server→app`, 'bytes', d);
    });
    const end = () => {
      client.destroy();
      up.destroy();
    };
    client.on('error', end);
    up.on('error', end);
    client.on('close', end);
    up.on('close', end);
  });
  server.listen(listen, '127.0.0.1', () => console.log(`hands-capture: relaying 127.0.0.1:${listen} → ${to.host}, writing ${out}`));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/hands-capture.ts')) {
  const grep = arg('--grep');
  if (grep) {
    const needle = (arg('--pieces') ?? '').split(',').join('');
    const capture = readFileSync(grep).toString('latin1');
    const hits = findIn(capture, needle);
    const frames = (capture.match(/\n--- /g) ?? []).length;
    console.log(`hands-capture: ${capture.length} bytes, ${frames} records; ${hits.length} hit(s) of the ${needle.length}-character test password`);
    for (const h of hits.slice(0, 5)) console.log(`  at ${h}: …${capture.slice(Math.max(0, h - 80), h).replace(/[^\x20-\x7e]/g, '.')}[HIT]`);
    process.exit(hits.length ? 1 : 0);
  }
  const listen = Number(arg('--listen'));
  const to = arg('--to');
  const out = arg('--out');
  if (!listen || !to || !out) {
    console.error('Usage: node scripts/hands-capture.ts --listen 7887 --to http://127.0.0.1:7886 --out capture.txt | --grep capture.txt --pieces a,b,c');
    process.exit(2);
  }
  relay(listen, new URL(to), out);
}
