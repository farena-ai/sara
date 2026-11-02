// diagnose() (docs/design/BRIDGES4.md §7.4, the WHATSAPP W6 pattern): every BlueBubbles answer and
// every setup state as one code. The setup card (web/imessage.js) shows each code's title, fix and
// buttons in the app's language; the plugin's log, status line and failed-send notices use the
// English title here. The server password never appears in a detail: query strings are cut.

export const DIAGNOSES = {
  BB_UNREACHABLE: "Sara can't reach BlueBubbles.",
  BB_PASSWORD: "BlueBubbles didn't accept the password.",
  MESSAGES_SIGNED_OUT: "Messages on the Mac isn't signed in to iMessage.",
  OWN_APPLE_ID: 'This Mac is signed in with your own Apple ID.',
  NETWORK_SWITCH: 'That address is on your network.',
  TAILNET_OFF: "That's a Tailscale address, but this computer isn't on Tailscale.",
  NO_DOORBELL: "BlueBubbles can't reach Sara, so she checks every few seconds instead.",
  MAC_ASLEEP: 'The Mac seems asleep or BlueBubbles closed.',
  SEND_FAILED: "iMessage didn't send this.",
  NOT_IMESSAGE: "That number isn't on iMessage, and Sara can only send blue messages.",
  HEIC: "She can't see HEIC photos yet.",
  PRIVATE_LOCAL: 'Paused: "Nothing leaves this computer" is on.',
  NOT_SET: 'Tell Sara where BlueBubbles is and its password first.',
  UNKNOWN: 'BlueBubbles said something Sara does not know.',
};

/** A BlueBubbles error (an HTTP status) or a connection error → a code. */
export function codeOf(err) {
  const status = Number(err?.status ?? 0);
  const msg = String(err?.message ?? '');
  if (status === 401 || status === 403) return 'BB_PASSWORD';
  if (/TAILNET_OFF/.test(msg)) return 'TAILNET_OFF';
  if (/on your home network|on your Tailscale network/i.test(msg)) return 'NETWORK_SWITCH';
  if (/private local mode/i.test(msg)) return 'PRIVATE_LOCAL';
  if (/no BlueBubbles (address|password)/.test(msg)) return 'NOT_SET';
  if (/not (registered|reachable) (with|on) iMessage|isn't on iMessage|not an iMessage/i.test(msg)) return 'NOT_IMESSAGE';
  if (status === 0 || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection closed|no answer in|couldn't be found|ENOTFOUND|refused|socket/i.test(msg)) return 'BB_UNREACHABLE';
  return 'UNKNOWN';
}

/** `{ code, title, detail?, params? }` for the card's *Details* (BlueBubbles' own words, query strings cut). */
export function diagnose(code, detail = '', params = {}) {
  const c = DIAGNOSES[code] ? code : 'UNKNOWN';
  const clean = String(detail ?? '').replace(/([?&](?:guid|password|token)=)[^&\s"']+/gi, '$1[hidden]').slice(0, 300);
  return { code: c, title: DIAGNOSES[c], ...(clean ? { detail: clean } : {}), ...(Object.keys(params).length ? { params } : {}) };
}
