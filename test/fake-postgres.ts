// Phase 105 (MI2): a tiny fake Postgres server for the move-in tests (protocol 3.0, written for these
// tests). It signs in with SCRAM-SHA-256 (the real server's default), answers the collector's catalog
// query, row counts and COPY … TO STDOUT (FORMAT csv, HEADER) from made-up tables
// (test/movein-custom-fixtures.ts), and refuses — and records — anything that would write. The
// tests check the collector only ever asked for a read-only session and snapshot.
// Run by hand for a live check: node test/fake-postgres.ts <port> <password>
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { csvOf, type PgTable, pgTables } from './movein-custom-fixtures.ts';

export interface FakePgLog {
  connections: number;
  signedIn: number;
  failedSignIns: number;
  startup: Record<string, string>[];
  queries: string[];
  /** Anything that isn't a read: refused, and listed here. */
  writes: string[];
  ssl: number;
}

const WRITE = /^\s*(insert|update|delete|create|drop|alter|truncate|grant|revoke|vacuum|reindex|cluster|copy\s+\S+\s+from|lock|set\s+(session\s+)?characteristics|comment|refresh|call|do)\b/i;

export async function startFakePostgres(opts: { user?: string; password: string; tables?: PgTable[]; port?: number }): Promise<{ port: number; server: Server; log: FakePgLog; close: () => Promise<void> }> {
  const tables = opts.tables ?? pgTables();
  const user = opts.user ?? 'alex';
  const log: FakePgLog = { connections: 0, signedIn: 0, failedSignIns: 0, startup: [], queries: [], writes: [], ssl: 0 };
  const server = createServer((sock) => serve(sock, { user, password: opts.password, tables, log }));
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, server, log, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function msg(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(5);
  h.write(type, 0, 'latin1');
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
}
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
const ready = (state: 'I' | 'T') => msg('Z', Buffer.from(state));
const complete = (tag: string) => msg('C', cstr(tag));
const error = (code: string, text: string) => msg('E', Buffer.concat([cstr(`SERROR`), cstr(`C${code}`), cstr(`M${text}`), Buffer.from([0])]));

function rowDescription(names: string[]): Buffer {
  const parts = [Buffer.from([names.length >> 8, names.length & 255])];
  for (const n of names) parts.push(cstr(n), int32(0), Buffer.from([0, 0]), int32(25), Buffer.from([255, 255]), int32(-1), Buffer.from([0, 0]));
  return msg('T', Buffer.concat(parts));
}
function dataRow(vals: (string | null)[]): Buffer {
  const parts = [Buffer.from([vals.length >> 8, vals.length & 255])];
  for (const v of vals) {
    if (v === null) parts.push(int32(-1));
    else {
      const b = Buffer.from(v, 'utf8');
      parts.push(int32(b.length), b);
    }
  }
  return msg('D', Buffer.concat(parts));
}

function catalogJson(tables: PgTable[]): string {
  return JSON.stringify(
    tables.map((t, i) => ({
      schema: t.schema,
      name: t.name,
      kind: t.kind ?? 'TABLE',
      // One table was never analysed (reltuples -1): the collector counts it.
      rows: i === 1 ? -1 : t.rows.length,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: true })),
      primaryKey: t.primaryKey ?? null,
      foreignKeys: t.foreignKeys ?? null,
    })),
  );
}

const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);

function serve(sock: Socket, ctx: { user: string; password: string; tables: PgTable[]; log: FakePgLog }): void {
  ctx.log.connections++;
  let buf = Buffer.alloc(0);
  let phase: 'start' | 'sasl-first' | 'sasl-final' | 'ready' = 'start';
  let inTx = false;
  let scram: { clientFirstBare: string; serverFirst: string; salted: Buffer; nonce: string } | undefined;
  const send = (...b: Buffer[]) => sock.write(Buffer.concat(b));
  sock.on('error', () => undefined);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (phase === 'start') {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        const code = buf.readInt32BE(4);
        const body = buf.subarray(8, len);
        buf = buf.subarray(len);
        if (code === 80877103) {
          ctx.log.ssl++;
          sock.write('N');
          continue;
        }
        const parts = body.toString('utf8').split('\0');
        const params: Record<string, string> = {};
        for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) params[parts[i]] = parts[i + 1];
        ctx.log.startup.push(params);
        if (params.user !== ctx.user) {
          send(error('28000', `role "${params.user}" does not exist`));
          sock.end();
          return;
        }
        send(msg('R', Buffer.concat([int32(10), cstr('SCRAM-SHA-256'), Buffer.from([0])])));
        phase = 'sasl-first';
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) return;
      const body = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);
      if (type === 'X') {
        sock.end();
        return;
      }
      if (phase === 'sasl-first' && type === 'p') {
        const z = body.indexOf(0);
        const data = body.subarray(z + 5).toString('ascii');
        const clientFirstBare = data.replace(/^n,,/, '');
        const cnonce = /r=([^,]+)/.exec(clientFirstBare)?.[1] ?? '';
        const salt = randomBytes(16);
        const nonce = cnonce + randomBytes(18).toString('base64');
        const serverFirst = `r=${nonce},s=${salt.toString('base64')},i=4096`;
        scram = { clientFirstBare, serverFirst, salted: pbkdf2Sync(ctx.password.normalize('NFKC'), salt, 4096, 32, 'sha256'), nonce };
        send(msg('R', Buffer.concat([int32(11), Buffer.from(serverFirst, 'ascii')])));
        phase = 'sasl-final';
        continue;
      }
      if (phase === 'sasl-final' && type === 'p' && scram) {
        const final = body.toString('ascii');
        const withoutProof = final.replace(/,p=[^,]*$/, '');
        const proof = Buffer.from(/,p=([^,]*)$/.exec(final)?.[1] ?? '', 'base64');
        const authMsg = `${scram.clientFirstBare},${scram.serverFirst},${withoutProof}`;
        const clientKey = createHmac('sha256', scram.salted).update('Client Key').digest();
        const stored = createHash('sha256').update(clientKey).digest();
        const sig = createHmac('sha256', stored).update(authMsg).digest();
        const recovered = Buffer.from(proof.map((b, i) => b ^ sig[i]));
        const ok = proof.length === 32 && withoutProof.includes(`r=${scram.nonce}`) && timingSafeEqual(createHash('sha256').update(recovered).digest(), stored);
        if (!ok) {
          ctx.log.failedSignIns++;
          send(error('28P01', `password authentication failed for user "${ctx.user}"`));
          sock.end();
          return;
        }
        const serverSig = createHmac('sha256', createHmac('sha256', scram.salted).update('Server Key').digest()).update(authMsg).digest();
        ctx.log.signedIn++;
        send(msg('R', Buffer.concat([int32(12), Buffer.from(`v=${serverSig.toString('base64')}`, 'ascii')])), msg('R', int32(0)), msg('S', Buffer.concat([cstr('server_version'), cstr('16.4')])), msg('S', Buffer.concat([cstr('client_encoding'), cstr('UTF8')])), msg('K', Buffer.concat([int32(4242), int32(7)])), ready('I'));
        phase = 'ready';
        continue;
      }
      if (phase === 'ready' && type === 'Q') {
        const sql = body.toString('utf8').replace(/\0$/, '');
        ctx.log.queries.push(sql);
        answer(sql);
        continue;
      }
      send(error('08P01', 'protocol violation'));
      sock.end();
      return;
    }
  });

  function answer(sql: string): void {
    const state = () => ready(inTx ? 'T' : 'I');
    if (WRITE.test(sql)) {
      ctx.log.writes.push(sql);
      send(error('25006', 'cannot execute in a read-only transaction'), state());
      return;
    }
    if (/^BEGIN\b/i.test(sql)) {
      if (!/READ ONLY/i.test(sql)) ctx.log.writes.push(`not read-only: ${sql}`);
      inTx = true;
      send(complete('BEGIN'), state());
      return;
    }
    if (/^(ROLLBACK|COMMIT)\b/i.test(sql)) {
      inTx = false;
      send(complete('ROLLBACK'), state());
      return;
    }
    if (/FROM pg_class c JOIN pg_namespace n/.test(sql)) {
      send(rowDescription(['json_agg']), dataRow([catalogJson(ctx.tables)]), complete('SELECT 1'), state());
      return;
    }
    const cnt = /^SELECT count\(\*\) FROM ("(?:[^"]|"")+"|\w+)\.("(?:[^"]|"")+"|\w+)$/i.exec(sql.trim());
    if (cnt) {
      const t = ctx.tables.find((x) => x.schema === unquote(cnt[1]) && x.name === unquote(cnt[2]));
      send(rowDescription(['count']), dataRow([String(t?.rows.length ?? 0)]), complete('SELECT 1'), state());
      return;
    }
    const copy = /^COPY \(SELECT \* FROM ("(?:[^"]|"")+"|\w+)\.("(?:[^"]|"")+"|\w+)(?: LIMIT (\d+))?\) TO STDOUT WITH \(FORMAT csv, HEADER\)$/i.exec(sql.trim());
    if (copy) {
      const t = ctx.tables.find((x) => x.schema === unquote(copy[1]) && x.name === unquote(copy[2]));
      if (!t) {
        send(error('42P01', 'relation does not exist'), state());
        return;
      }
      const limit = copy[3] ? Number(copy[3]) : undefined;
      const csv = Buffer.from(csvOf(t, limit), 'utf8');
      const n = t.columns.length;
      const head = Buffer.concat([Buffer.from([0, n >> 8, n & 255]), Buffer.alloc(2 * n)]);
      const out: Buffer[] = [msg('H', head)];
      // In uneven pieces, like a real server's network packets.
      for (let i = 0; i < csv.length; i += 37) out.push(msg('d', csv.subarray(i, i + 37)));
      out.push(msg('c'), complete(`COPY ${Math.min(limit ?? Infinity, t.rows.length)}`), state());
      send(...out);
      return;
    }
    send(error('42601', `the fake server doesn't know this query`), state());
  }
}

// node test/fake-postgres.ts <port> <password>: a live server for the by-hand check.
if (process.argv[1] && /fake-postgres\.ts$/.test(process.argv[1])) {
  const port = Number(process.argv[2] ?? 0);
  const password = process.argv[3] ?? 'fixture-only';
  const s = await startFakePostgres({ port, password });
  process.stdout.write(`fake postgres on 127.0.0.1:${s.port}\n`);
  setInterval(() => process.stdout.write(`${JSON.stringify({ signedIn: s.log.signedIn, queries: s.log.queries.length, writes: s.log.writes })}\n`), 30_000);
}
