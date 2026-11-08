// diagnose() (docs/ops/EC7_DESIGN.md "Errors in plain words", the Slack pattern): every Microsoft
// answer and every setup state as one code. The setup card (web/teams.js) shows each code's title and
// fix in the app's language; the plugin's log, its status line and failed-send notices use the English
// title here. A secret or a token never appears in a detail.

export const DIAGNOSES = {
  NOT_SET: 'Paste the App ID, the Directory (tenant) ID and the client secret first.',
  APP_ID_SHAPE: "That isn't an App ID (it looks like 8-4-4-4-12 letters and digits).",
  TENANT_SHAPE: "That isn't a Directory (tenant) ID.",
  SECRET_SHAPE: "That's the secret's ID, not its value.",
  APP_ID_WRONG: 'Microsoft does not know that App ID in this directory.',
  TENANT_WRONG: 'Microsoft does not know that directory (tenant).',
  SECRET_WRONG: 'Microsoft did not accept that client secret.',
  SECRET_EXPIRED: 'The client secret has expired.',
  NO_DOOR: 'Teams has no way to reach Sara yet.',
  NOT_CALLED: 'Teams has not called Sara yet.',
  BAD_SIGNATURE: 'Calls arrive that Microsoft did not sign.',
  FORBIDDEN: "Teams didn't let her post there.",
  RATE_LIMITED: 'Teams asked her to slow down.',
  FILE_TOO_BIG: 'That file is too big to send.',
  FILE_NOT_HERE: 'In channels she can’t send files.',
  PRIVATE_LOCAL: 'Paused: "Nothing leaves this computer" is on.',
  CANT_REACH: "Couldn't reach Microsoft.",
  NOT_RUNNING: "The Teams plugin isn't running.",
  NOT_ON: 'Teams is added but switched off.',
  UNKNOWN: 'Microsoft said something Sara does not know.',
};

/** Masks bearer tokens, JWTs and the secret (when given) in any text. */
export function maskSecrets(s, secret = '') {
  let out = String(s ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [token]').replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[token]');
  if (secret && secret.length >= 8) out = out.split(secret).join('[secret]');
  return out;
}

/** A Microsoft error (an AADSTS code from the token endpoint, an HTTP status) or a connection error → a code. */
export function codeOf(err) {
  const aad = String(err?.aad ?? '');
  const status = Number(err?.status ?? 0);
  const msg = String(err?.message ?? '');
  if (aad === 'AADSTS7000222') return 'SECRET_EXPIRED';
  if (aad === 'AADSTS7000215' || aad === 'AADSTS7000216') return 'SECRET_WRONG';
  if (aad === 'AADSTS700016') return 'APP_ID_WRONG';
  if (aad === 'AADSTS90002' || aad === 'AADSTS900023') return 'TENANT_WRONG';
  if (err?.code && DIAGNOSES[err.code]) return err.code;
  if (status === 429) return 'RATE_LIMITED';
  if (status === 403 || status === 404) return 'FORBIDDEN';
  if (status === 413) return 'FILE_TOO_BIG';
  if (/private local mode/i.test(msg)) return 'PRIVATE_LOCAL';
  if (/couldn't be found|ENOTFOUND|getaddrinfo|ECONNREFUSED|ETIMEDOUT|ECONNRESET|no answer in|closed/i.test(msg)) return 'CANT_REACH';
  return 'UNKNOWN';
}

/** `{ code, title, detail?, params? }` for the card's *Details* (Microsoft's own words, secrets masked). */
export function diagnose(code, detail = '', params = {}, secret = '') {
  const c = DIAGNOSES[code] ? code : 'UNKNOWN';
  const clean = maskSecrets(detail, secret).slice(0, 300);
  return { code: c, title: DIAGNOSES[c], ...(clean ? { detail: clean } : {}), ...(Object.keys(params).length ? { params } : {}) };
}
