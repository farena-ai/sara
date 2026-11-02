// diagnose() (WHATSAPP §3.1 W6, §5.3): every Graph answer and every setup state as one code. The
// setup card (web/whatsapp.js) shows each code's title, fix and buttons in the app's language; the
// plugin's log, its status line and failed-send notices use the English title here.

export const DIAGNOSES = {
  TOKEN_EXPIRED: 'Your WhatsApp key has expired.',
  TOKEN_WRONG_APP: "This key can't see that phone number.",
  PERMISSION: 'The key is missing a permission.',
  IDS_SWAPPED: 'Those two numbers are swapped.',
  NOT_REGISTERED: "This number isn't switched on for the Cloud API yet.",
  NO_DOOR: "Meta can't reach Sara yet.",
  DOOR_CLOSED: "Meta couldn't reach Sara.",
  VERIFY_TOKEN: 'Meta knocked, but with a different verify token.',
  BAD_SIGNATURE: "Messages from Meta aren't signed with the secret Sara has.",
  NOT_SUBSCRIBED: "Meta isn't sending her your messages.",
  DEV_MODE: 'Your Meta app may still be in development mode.',
  NOT_RECIPIENT: 'The test number can only write to numbers on its list.',
  WINDOW_CLOSED: "It's been more than 24 hours since you wrote to her on WhatsApp.",
  PAIR_RATE: 'Too many messages to you too quickly.',
  THROUGHPUT: 'Meta is busy with this number.',
  NOT_DELIVERED: "WhatsApp couldn't deliver this.",
  MEDIA_FAILED: "She couldn't download that file from WhatsApp.",
  IDENTITY_CHANGED: 'Your WhatsApp identity changed.',
  RESTRICTED: 'Meta has restricted this WhatsApp account or number.',
  PRIVATE_LOCAL: 'Paused: "Nothing leaves this computer" is on.',
  MEDIA_HOST: 'Meta now sends files from another host.',
  REGISTER_LIMIT: 'Meta allows 10 registration tries in 3 days.',
  NOT_SET: 'Paste the two IDs and the key first.',
  UNKNOWN: 'WhatsApp said something Sara does not know.',
};

/** A Graph error body (`{ error: { code, message, error_subcode, error_data } }`) or a status error → a code. */
export function codeOf(err) {
  const code = Number(err?.code ?? 0);
  const sub = Number(err?.error_subcode ?? 0);
  if (code === 190) return 'TOKEN_EXPIRED';
  if (code === 10 || code === 200) return 'PERMISSION';
  if (code === 133010) return 'NOT_REGISTERED';
  if (code === 133016) return 'REGISTER_LIMIT';
  if (code === 131047) return 'WINDOW_CLOSED';
  if (code === 131056) return 'PAIR_RATE';
  if (code === 130429 || code === 131057) return 'THROUGHPUT';
  if (code === 131026 || code === 131049) return 'NOT_DELIVERED';
  if (code === 131052) return 'MEDIA_FAILED';
  if (code === 137000) return 'IDENTITY_CHANGED';
  if ([368, 131031, 130497, 131048].includes(code)) return 'RESTRICTED';
  // The test number to a number not on its list (recorded answer: 131030 "Recipient phone number not in allowed list").
  if (code === 131030) return 'NOT_RECIPIENT';
  if (code === 100 && sub === 33) return 'TOKEN_WRONG_APP';
  return 'UNKNOWN';
}

/** `{ code, title, detail }` for the card's *Details* (Meta's own words, the token never in them). */
export function diagnose(code, detail = '', params = {}) {
  const c = DIAGNOSES[code] ? code : 'UNKNOWN';
  return { code: c, title: DIAGNOSES[c], ...(detail ? { detail: String(detail).replace(/EAA[A-Za-z0-9]{10,}/g, '[key]').slice(0, 300) } : {}), ...(Object.keys(params).length ? { params } : {}) };
}
