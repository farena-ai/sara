// diagnose() (docs/design/BRIDGES4.md §7.4, the WHATSAPP W6 pattern): every homeserver answer and
// every setup state as one code. The setup card (web/matrix.js) shows each code's title, fix and
// buttons in the app's language; the plugin's log, its status line and failed-send notices use the
// English title here. The access token never appears in a detail.

export const DIAGNOSES = {
  HS_NOT_FOUND: "Couldn't find a Matrix server for her account.",
  NO_PASSWORD_LOGIN: "Her server doesn't take passwords from apps.",
  LOGIN_WRONG: 'Wrong Matrix ID or password for her account.',
  TOKEN_GONE: 'Her login ended (someone logged that session out).',
  ENCRYPTED_ROOM: "That room is encrypted, so she can't read it.",
  NOT_INVITED: "She hasn't been invited yet.",
  RATE_LIMITED: 'Her server asked her to slow down.',
  MEDIA_TOO_BIG: 'That file is bigger than her server allows.',
  TAILNET_OFF: "That's a Tailscale address, but this computer isn't on Tailscale.",
  PRIVATE_LOCAL: 'Paused: "Nothing leaves this computer" is on.',
  NOT_SET: 'Log her in first.',
  UNKNOWN: 'Her Matrix server said something Sara does not know.',
};

/** A Matrix error (`{ errcode, error }` with an HTTP status) or a connection error → a code. */
export function codeOf(err) {
  const code = String(err?.errcode ?? '');
  const status = Number(err?.status ?? 0);
  const msg = String(err?.message ?? '');
  if (code === 'M_UNKNOWN_TOKEN' || code === 'M_MISSING_TOKEN') return 'TOKEN_GONE';
  if (code === 'M_LIMIT_EXCEEDED' || status === 429) return 'RATE_LIMITED';
  if (code === 'M_FORBIDDEN' && err?.login) return 'LOGIN_WRONG';
  if (code === 'M_TOO_LARGE' || status === 413) return 'MEDIA_TOO_BIG';
  if (/TAILNET_OFF/.test(msg)) return 'TAILNET_OFF';
  if (/private local mode/i.test(msg)) return 'PRIVATE_LOCAL';
  if (/couldn't be found|ENOTFOUND|getaddrinfo/i.test(msg)) return 'HS_NOT_FOUND';
  return 'UNKNOWN';
}

/** `{ code, title, detail?, params? }` for the card's *Details* (the server's own words, scrubbed). */
export function diagnose(code, detail = '', params = {}) {
  const c = DIAGNOSES[code] ? code : 'UNKNOWN';
  const clean = String(detail ?? '').replace(/(syt|syr|mat|mct)_[A-Za-z0-9_\-]{8,}/g, '[token]').replace(/Bearer\s+\S+/gi, 'Bearer [token]').slice(0, 300);
  return { code: c, title: DIAGNOSES[c], ...(clean ? { detail: clean } : {}), ...(Object.keys(params).length ? { params } : {}) };
}
