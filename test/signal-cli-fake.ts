// Tests only: a stand-in for signal-cli's JSON-RPC daemon (`signal-cli -a <number> daemon --tcp`),
// written from its documented framing (one JSON object a line, `id` echoed, `receive` notifications
// without an id). It records every request, answers the methods the Signal plugin uses, and pushes
// envelopes the test builds. Never a real Signal account; listens on 127.0.0.1 only.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

export interface FakeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export class FakeSignalCli {
  readonly requests: FakeRequest[] = [];
  readonly clients = new Set<Socket>();
  /** Safety numbers by ACI (listIdentities). */
  readonly identities = new Map<string, string>();
  readonly groups: { id: string; name: string; members: { uuid: string }[] }[] = [];
  readonly attachments = new Map<string, Buffer>();
  /** Recipients (ACI or group id) whose next `send` fails with a rate limit. */
  readonly rateLimit = new Set<string>();
  #server: Server | undefined;
  #ts = 1_800_000_000_000;
  port = 0;

  async start(port = 0): Promise<this> {
    this.#server = createServer((c) => this.#client(c));
    await new Promise<void>((r) => this.#server!.listen(port, '127.0.0.1', r));
    this.port = (this.#server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  calls(method: string): FakeRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  /** Pushes one envelope to every subscribed client. */
  push(envelope: Record<string, unknown>): void {
    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope, account: '+15550001111' } })}\n`;
    for (const c of this.clients) c.write(line);
  }

  nextTs(): number {
    this.#ts += 1000;
    return this.#ts;
  }

  #client(c: Socket): void {
    this.clients.add(c);
    c.on('close', () => this.clients.delete(c));
    c.on('error', () => undefined);
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: string; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const req: FakeRequest = { id: String(msg.id ?? ''), method: String(msg.method ?? ''), params: msg.params ?? {}, at: Date.now() };
        this.requests.push(req);
        const out = this.#answer(req);
        c.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...out })}\n`);
      }
    });
  }

  #answer(r: FakeRequest): { result?: unknown; error?: { code: number; message: string } } {
    const p = r.params;
    switch (r.method) {
      case 'version':
        return { result: { version: '0.13.22' } };
      case 'subscribeReceive':
        return { result: 0 };
      case 'listGroups':
        return { result: this.groups };
      case 'listIdentities': {
        const n = String(p.number ?? '');
        if (!n) return { result: [...this.identities].map(([uuid, safetyNumber]) => ({ uuid, safetyNumber, trustLevel: 'TRUSTED_UNVERIFIED' })) };
        const fp = this.identities.get(n);
        return { result: fp ? [{ uuid: n, safetyNumber: fp, trustLevel: 'TRUSTED_UNVERIFIED' }] : [] };
      }
      case 'send': {
        const to = String(p.groupId ?? (p.recipient as string[] | undefined)?.[0] ?? '');
        if (this.rateLimit.has(to)) {
          this.rateLimit.delete(to);
          return { error: { code: -5, message: 'Failed to send message due to rate limiting' } };
        }
        return { result: { timestamp: this.nextTs(), results: [{ type: 'SUCCESS' }] } };
      }
      case 'getAttachment': {
        const b = this.attachments.get(String(p.id ?? ''));
        return b ? { result: { data: b.toString('base64') } } : { error: { code: -1, message: 'no such attachment' } };
      }
      case 'sendTyping':
      case 'sendReaction':
      case 'sendReceipt':
      case 'trust':
      case 'quitGroup':
        return { result: { timestamp: this.nextTs() } };
      default:
        return { error: { code: -32601, message: `Method not implemented: ${r.method}` } };
    }
  }
}

/** A 1:1 envelope from someone. */
export function dmEnvelope(from: { uuid: string; name: string }, ts: number, dataMessage: Record<string, unknown>): Record<string, unknown> {
  return { source: from.uuid, sourceUuid: from.uuid, sourceName: from.name, sourceDevice: 1, timestamp: ts, dataMessage: { timestamp: ts, expiresInSeconds: 0, viewOnce: false, ...dataMessage } };
}
