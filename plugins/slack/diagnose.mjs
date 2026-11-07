// diagnose() (docs/ops/EC1_DESIGN.md "Errors in plain words", the Matrix pattern): every Slack answer
// and every setup state as one code. The setup card (web/slack.js) shows each code's title and fix in
// the app's language; the plugin's log, its status line and failed-send notices use the English title
// here. A token never appears in a detail.

export const DIAGNOSES = {
  NOT_SET: 'Paste both Slack tokens first.',
  BOT_TOKEN_SHAPE: "That isn't a bot token (it starts with xoxb-).",
  APP_TOKEN_SHAPE: "That isn't an app-level token (it starts with xapp-).",
  TOKENS_SWAPPED: "The two tokens are in each other's boxes.",
  TOKEN_WRONG: 'Slack did not accept that token.',
  TOKEN_GONE: 'Slack ended her token (the app was removed or the token revoked).',
  SOCKET_OFF: 'Socket Mode is off for this Slack app.',
  MISSING_SCOPE: 'The Slack app is missing a permission.',
  NOT_IN_CHANNEL: "She isn't in that channel.",
  RATE_LIMITED: 'Slack asked her to slow down.',
  FILE_TOO_BIG: 'That file is too big to send.',
  PRIVATE_LOCAL: 'Paused: "Nothing leaves this computer" is on.',
  CANT_REACH: "Couldn't reach Slack.",
  UNKNOWN: 'Slack said something Sara does not know.',
};

/** Masks Slack tokens (bot, user, app-level, config) in any text. */
export const maskTokens = (s) => String(s ?? '').replace(/\bx(?:ox[abposre]|app)-[A-Za-z0-9-]{6,}/g, '[token]').replace(/Bearer\s+\S+/gi, 'Bearer [token]');

/** A Slack error (`{ ok: false, error }` with an HTTP status) or a connection error → a code. */
export function codeOf(err) {
  const e = String(err?.error ?? '');
  const msg = String(err?.message ?? '');
  if (['invalid_auth', 'not_authed', 'not_allowed_token_type'].includes(e)) return 'TOKEN_WRONG';
  if (['token_revoked', 'account_inactive', 'token_expired', 'team_disabled', 'app_uninstalled'].includes(e)) return 'TOKEN_GONE';
  if (e === 'missing_scope') return 'MISSING_SCOPE';
  if (e === 'ratelimited' || Number(err?.status) === 429) return 'RATE_LIMITED';
  if (e === 'not_in_channel' || e === 'channel_not_found' || e === 'is_archived') return 'NOT_IN_CHANNEL';
  if (e === 'file_too_large' || e === 'too_large') return 'FILE_TOO_BIG';
  if (err?.socket === true && e) return 'SOCKET_OFF';
  if (/private local mode/i.test(msg)) return 'PRIVATE_LOCAL';
  if (/couldn't be found|ENOTFOUND|getaddrinfo|ECONNREFUSED|ETIMEDOUT|no answer in/i.test(msg)) return 'CANT_REACH';
  return 'UNKNOWN';
}

/** `{ code, title, detail?, params? }` for the card's *Details* (Slack's own words, tokens masked). */
export function diagnose(code, detail = '', params = {}) {
  const c = DIAGNOSES[code] ? code : 'UNKNOWN';
  const clean = maskTokens(detail).slice(0, 300);
  return { code: c, title: DIAGNOSES[c], ...(clean ? { detail: clean } : {}), ...(Object.keys(params).length ? { params } : {}) };
}
