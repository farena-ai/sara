// Synthetic WebAuthn authenticator with real Ed25519 signatures, no browser/device dependency.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

type Value = number | string | Buffer | Map<Value, Value>;
function cbor(value: Value): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();

export class BusinessAuthenticator {
  readonly id = randomBytes(16);
  readonly key = generateKeyPairSync('ed25519');
  #counter = 0;
  #auth(rpId: string, flags: number, extra = Buffer.alloc(0)) {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.#counter);
    return Buffer.concat([hash(rpId), Buffer.from([flags]), counter, extra]);
  }
  register(challenge: string, origin: string) {
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const cose = new Map<Value, Value>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, 'base64url')]]);
    const length = Buffer.alloc(2); length.writeUInt16BE(this.id.length);
    const data = this.#auth(new URL(origin).hostname, 0x45, Buffer.concat([Buffer.alloc(16), length, this.id, cbor(cose)]));
    return { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'), attestationObject: cbor(new Map<Value, Value>([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]])).toString('base64url') };
  }
  assertion(challenge: string, origin: string) {
    this.#counter++;
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const data = this.#auth(new URL(origin).hostname, 0x05);
    return { id: this.id.toString('base64url'), clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'), signature: sign(null, Buffer.concat([data, hash(client)]), this.key.privateKey).toString('base64url') };
  }
}
