// EC7 (docs/ops/EC7_DESIGN.md "Tests"): a stand-in Microsoft, written here from the public Bot
// Framework and Teams docs: no tenant, no real network.
//   BotSigner  the Bot Connector's signing side: an RSA key, OpenID metadata and a JWKS (keys endorsed
//              for msteams) over plain HTTP on loopback, and RS256 tokens as the connector sends them.
//   FakeTeams  one HTTPS server on a test CA valid for login.microsoftonline.com,
//              smba.trafficmanager.net and *.sharepoint.com (reached by the real plugin through Sara's
//              socket broker and its test-only loopback override): the client-credentials token
//              endpoint (AADSTS errors on demand), the Connector (send, reply, update, inline
//              pictures; bearer checked; 429 once on demand) and SharePoint (file downloads, chunked
//              uploads with Content-Range). It also plays Teams: it signs activities and POSTs them
//              to Sara's bridge hook.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { makeCert } from '../../x509-test.ts';

export const APP_ID = '6a0e8c1e-3f4b-4c2d-9e8f-0a1b2c3d4e5f';
export const TENANT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
export const SECRET = ['abc', '8Q~', 'TestOnlySecretValueForTests_12345'].join('');
export const SERVICE = 'https://smba.trafficmanager.net/amer/';
export const BOT = `28:${APP_ID}`;
export const OWNER = { id: '29:1OwnerAlexXyZ', name: 'Alex', aadObjectId: 'aaaaaaaa-0000-4000-8000-00000000a1e5' };
export const COLLEAGUE = { id: '29:1ColleagueMiaQ', name: 'Mia', aadObjectId: 'bbbbbbbb-0000-4000-8000-0000000000b1' };
export const STRANGER = { id: '29:1StrangerSpamW', name: 'Spam', aadObjectId: 'cccccccc-0000-4000-8000-0000000000c1' };
export const DM = 'a:1DmWithAlex';
export const DM_STRANGER = 'a:1DmWithSpam';
export const CHANNEL = '19:generalChannel@thread.tacv2';
export const OTHER_CHANNEL = '19:randomChannel@thread.tacv2';
export const TEAM_ID = '19:teamGeneral@thread.tacv2';
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export class BotSigner {
  constructor() {
    this.#newKey();
    this.jwksFetches = 0;
    this.metadataFetches = 0;
  }

  #newKey() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.priv = privateKey;
    this.kid = `k${randomBytes(4).toString('hex')}`;
    this.keys = [...(this.keys ?? []).slice(-1), { ...publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', endorsements: ['msteams', 'skype'] }];
    this.otherPriv = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }

  /** A new signing key (the old one stays listed a while, as Microsoft does). */
  rotate() {
    this.#newKey();
  }

  token(claims = {}, o = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: o.alg ?? 'RS256', typ: 'JWT', kid: o.kid ?? this.kid, x5t: 'x' };
    const body = { iss: 'https://api.botframework.com', aud: APP_ID, nbf: now - 10, exp: now + 3600, serviceUrl: SERVICE, ...claims };
    const data = `${b64u(header)}.${b64u(body)}`;
    const sig = createSign('RSA-SHA256').update(data).sign(o.forge ? this.otherPriv : this.priv).toString('base64url');
    return `${data}.${sig}`;
  }

  async startOpenId(port = 0) {
    this.openid = httpServer((req, res) => {
      const base = `http://127.0.0.1:${this.openid.address().port}`;
      if (req.url === '/v1/.well-known/openidconfiguration') {
        this.metadataFetches++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ issuer: 'https://api.botframework.com', authorization_endpoint: 'https://invalid.botframework.com', jwks_uri: `${base}/v1/.well-known/keys`, id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['private_key_jwt'] }));
      }
      if (req.url === '/v1/.well-known/keys') {
        this.jwksFetches++;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=86400' });
        return res.end(JSON.stringify({ keys: this.keys }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => this.openid.listen(port, '127.0.0.1', r));
    this.metadataUrl = `http://127.0.0.1:${this.openid.address().port}/v1/.well-known/openidconfiguration`;
    return this;
  }

  async stopOpenId() {
    this.openid?.closeAllConnections?.();
    await new Promise((r) => (this.openid ? this.openid.close(() => r()) : r()));
  }
}

/**
 * Microsoft for the plugin (HTTPS on a test CA, every host on one port) and Teams for Sara's hook.
 * `hookUrl` is set by the test once Sara made the hook; `dm()`, `mention()`, `tap()`, `consentAnswer()`
 * sign an activity with `signer` and POST it there (resolving to the HTTP status Sara answered).
 */
export class FakeTeams {
  constructor(signer) {
    const now = Date.now();
    this.signer = signer;
    this.ca = makeCert({ cn: 'Sara test Microsoft CA', ca: true, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 7 * 86_400_000) });
    this.leaf = makeCert({ cn: 'login.microsoftonline.com', dns: ['login.microsoftonline.com', 'smba.trafficmanager.net', 'sharepoint.com', '*.sharepoint.com', 'localhost'], issuer: this.ca, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 7 * 86_400_000) });
    this.secret = SECRET;
    this.expired = false;
    this.tokens = new Set();
    this.tokenCalls = [];
    this.requests = [];
    this.posts = [];
    this.updates = [];
    this.downloads = [];
    this.uploads = new Map();
    this.files = new Map();
    this.errors = [];
    this.hookUrl = '';
    this.seq = 1000;
    this.port = 0;
  }

  get caPem() {
    return this.ca.pem;
  }

  async start(port = 0) {
    this.server = httpsServer({ key: this.leaf.key.export({ type: 'pkcs8', format: 'pem' }), cert: this.leaf.pem }, (req, res) => void this.#serve(req, res));
    this.sockets = new Set();
    this.server.on('secureConnection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(() => r()));
  }

  /** Every message she posted into a conversation (its id, or the channel's id with any thread). */
  sentTo(conv) {
    return this.posts.filter((p) => p.conv === conv || p.conv.split(';messageid=')[0] === conv);
  }

  #error(kind) {
    const i = this.errors.findIndex((e) => e.kind === kind);
    if (i < 0) return undefined;
    const e = this.errors[i];
    if (e.once) this.errors.splice(i, 1);
    return e;
  }

  async #serve(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const host = String(req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url ?? '/', `https://${host}`);
    const out = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    this.requests.push({ host, method: req.method, path: url.pathname, bearer: /^Bearer /.test(String(req.headers.authorization ?? '')) });
    if (host === 'login.microsoftonline.com') return this.#token(url, raw, out);
    if (host === 'smba.trafficmanager.net') {
      const tok = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.tokens.has(tok)) return out(401, { message: 'Authorization has been denied for this request.' });
      const e = this.#error('connector');
      if (e) return out(e.status, { error: { code: 'Throttled', message: 'slow down' } }, e.retryAfter !== undefined ? { 'retry-after': String(e.retryAfter) } : {});
      const att = /^\/amer\/v3\/attachments\/([^/]+)\/views\/original$/.exec(url.pathname);
      if (att && req.method === 'GET') {
        const f = this.files.get(att[1]);
        this.downloads.push({ host, id: att[1], bearer: true });
        return f ? out(200, f.bytes, { 'content-type': f.mime }) : out(404, {});
      }
      const m = /^\/amer\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/.exec(url.pathname);
      if (!m) return out(404, { error: { code: 'NotFound' } });
      const conv = decodeURIComponent(m[1]);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (req.method === 'PUT' && m[2]) {
        this.updates.push({ conv, id: decodeURIComponent(m[2]), ...body });
        return out(200, { id: decodeURIComponent(m[2]) });
      }
      if (req.method === 'POST') {
        const id = `${++this.seq}`;
        if (body.type === 'typing') return out(200, { id });
        this.posts.push({ conv, id, replyTo: m[2] ? decodeURIComponent(m[2]) : undefined, ...body });
        return out(201, { id });
      }
      return out(405, {});
    }
    if (host === 'sharepoint.com' || host.endsWith('.sharepoint.com')) {
      const dl = /^\/personal\/alex\/files\/([^/]+)$/.exec(url.pathname);
      if (dl && req.method === 'GET') {
        const f = this.files.get(dl[1]);
        this.downloads.push({ host, id: dl[1], bearer: Boolean(req.headers.authorization) });
        return f && url.searchParams.get('tempauth') === 'ok' ? out(200, f.bytes, { 'content-type': 'application/octet-stream' }) : out(403, {});
      }
      const up = /^\/upload\/([^/]+)$/.exec(url.pathname);
      if (up && req.method === 'PUT') {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
        if (!range) return out(400, { error: { message: 'no Content-Range' } });
        const u = this.uploads.get(up[1]) ?? { parts: [], total: Number(range[3]) };
        u.parts.push({ from: Number(range[1]), bytes: raw });
        this.uploads.set(up[1], u);
        const have = u.parts.reduce((n, p) => n + p.bytes.length, 0);
        return have >= u.total ? out(201, { id: up[1], name: 'done' }) : out(202, { nextExpectedRanges: [`${have}-`] });
      }
      return out(404, {});
    }
    return out(404, {});
  }

  #token(url, raw, out) {
    const tenant = url.pathname.split('/')[1];
    const f = new URLSearchParams(raw.toString('utf8'));
    this.tokenCalls.push({ tenant, clientId: f.get('client_id'), scope: f.get('scope'), grant: f.get('grant_type') });
    const aad = (status, error, code, text) => out(status, { error, error_description: `${code}: ${text} Trace ID: x` });
    if (tenant !== TENANT && tenant !== 'botframework.com') return aad(400, 'invalid_request', 'AADSTS90002', `Tenant '${tenant}' not found.`);
    if (f.get('client_id') !== APP_ID) return aad(400, 'unauthorized_client', 'AADSTS700016', `Application with identifier '${f.get('client_id')}' was not found in the directory.`);
    if (f.get('client_secret') !== this.secret) return aad(401, 'invalid_client', 'AADSTS7000215', 'Invalid client secret provided.');
    if (this.expired) return aad(401, 'invalid_client', 'AADSTS7000222', 'The provided client secret keys are expired.');
    const tok = `eyJfake.${randomBytes(12).toString('base64url')}.sig`;
    this.tokens.add(tok);
    return out(200, { token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: tok });
  }

  /** A picture he pastes (inline, on the Connector) or a file he attaches (a OneDrive download link). */
  addFile(name, mime, bytes, o = {}) {
    const id = `f${++this.seq}`;
    this.files.set(id, { name, mime, bytes });
    if (o.inline) return { contentType: mime, contentUrl: `${SERVICE}v3/attachments/${id}/views/original`, name };
    return { contentType: 'application/vnd.microsoft.teams.file.download.info', name, content: { downloadUrl: `https://contoso-my.sharepoint.com/personal/alex/files/${id}?tempauth=ok`, uniqueId: id, fileType: name.split('.').pop() } };
  }

  /** Signs and POSTs one activity to Sara's hook. `o.token` overrides the bearer (forgeries). */
  async deliver(activity, o = {}) {
    const token = o.token ?? this.signer.token({ aud: APP_ID, serviceUrl: activity.serviceUrl ?? SERVICE });
    const res = await fetch(this.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(activity) });
    await res.text();
    return res.status;
  }

  activity(o = {}) {
    const id = o.id ?? `${Date.now()}${++this.seq}`;
    return {
      type: 'message',
      id,
      timestamp: new Date().toISOString(),
      channelId: 'msteams',
      serviceUrl: SERVICE,
      from: o.from ?? OWNER,
      recipient: { id: BOT, name: 'Sara' },
      conversation: o.conversation ?? { id: DM, conversationType: 'personal', tenantId: TENANT },
      channelData: o.channelData ?? { tenant: { id: TENANT } },
      textFormat: 'plain',
      locale: 'en-US',
      ...(o.text !== undefined ? { text: o.text } : {}),
      ...(o.attachments ? { attachments: o.attachments } : {}),
      ...(o.entities ? { entities: o.entities } : {}),
      ...(o.value ? { value: o.value } : {}),
      ...(o.replyToId ? { replyToId: o.replyToId } : {}),
      ...(o.extra ?? {}),
    };
  }

  /** He (or `o.from`) writes in her personal chat. */
  dm(text, o = {}) {
    const a = this.activity({ text, from: o.from, conversation: { id: o.conv ?? DM, conversationType: 'personal', tenantId: TENANT }, attachments: o.attachments });
    return this.deliver(a, o).then((status) => ({ status, id: a.id }));
  }

  /** Someone mentions her in a channel (a new post: its own thread) or in a thread (`o.thread`). */
  mention(text, o = {}) {
    const channel = o.channel ?? CHANNEL;
    const id = o.id ?? `${Date.now()}${++this.seq}`;
    const a = this.activity({
      id,
      text: `<at>Sara</at> ${text}`,
      from: o.from ?? OWNER,
      conversation: { id: `${channel};messageid=${o.thread ?? id}`, conversationType: 'channel', isGroup: true, tenantId: TENANT },
      channelData: { teamsChannelId: channel, teamsTeamId: TEAM_ID, channel: { id: channel, name: o.name ?? 'General' }, team: { id: TEAM_ID }, tenant: { id: TENANT } },
      entities: [{ type: 'mention', text: '<at>Sara</at>', mentioned: { id: BOT, name: 'Sara' } }],
    });
    return this.deliver(a, o).then((status) => ({ status, id, conv: a.conversation.id }));
  }

  /** A tap on one of her card buttons (`Action.Submit` → a message whose value is `{ sara }`). */
  tap(sara, o = {}) {
    const a = this.activity({ from: o.from, conversation: o.conversation, value: { sara }, replyToId: o.replyToId, channelData: o.channelData });
    return this.deliver(a, o);
  }

  /** His answer to a file-consent card. */
  consentAnswer(fileId, action, o = {}) {
    const up = `u${++this.seq}`;
    const a = this.activity({ from: o.from, value: { type: 'fileUpload', action, context: { fileId }, uploadInfo: { contentUrl: `https://contoso-my.sharepoint.com/personal/alex/Documents/${up}`, name: o.name ?? 'out.png', uploadUrl: `https://contoso-my.sharepoint.com/upload/${up}`, uniqueId: up, fileType: 'png' } }, extra: { type: 'invoke', name: 'fileConsent/invoke' } });
    return this.deliver(a, o).then((status) => ({ status, upload: up }));
  }

  uploaded(id) {
    const u = this.uploads.get(id);
    if (!u) return undefined;
    return Buffer.concat([...u.parts].sort((a, b) => a.from - b.from).map((p) => p.bytes));
  }
}
