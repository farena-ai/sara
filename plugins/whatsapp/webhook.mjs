// Meta's webhook payload (WHATSAPP §2.2, §2.3): `object: whatsapp_business_account`, entries with
// changes whose value has `metadata.phone_number_id`, `contacts[]` and `messages[]` or `statuses[]`.
// Sara already checked the signature on the raw bytes; this only reads the shape, oldest first.
// Anything it doesn't know becomes a mark (never markup, never a turn of its own).

const ID = /^[\w.:+=/-]{1,120}$/;
const clean = (v, n = 4000) => String(v ?? '').slice(0, n);

/** → { messages: [...], statuses: [...], other: [{ phoneNumberId, reason }] } */
export function parsePayload(body, myPhoneId) {
  const out = { messages: [], statuses: [], other: [] };
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const e of body.entry.slice(0, 100)) {
    for (const c of Array.isArray(e?.changes) ? e.changes.slice(0, 100) : []) {
      const v = c?.value;
      if (!v || typeof v !== 'object') continue;
      const phoneId = clean(v.metadata?.phone_number_id, 40);
      if (myPhoneId && phoneId && phoneId !== String(myPhoneId)) {
        for (const m of Array.isArray(v.messages) ? v.messages : []) out.other.push({ phoneNumberId: phoneId, from: clean(m?.from, 40), reason: 'not-to-her' });
        continue;
      }
      const contacts = Array.isArray(v.contacts) ? v.contacts : [];
      for (const m of Array.isArray(v.messages) ? v.messages.slice(0, 1000) : []) {
        const waId = clean(m?.from, 40).replace(/\D/g, '');
        const userId = clean(m?.from_user_id, 120);
        const contact = contacts.find((x) => (waId && x?.wa_id === waId) || (userId && x?.user_id === userId)) ?? contacts[0] ?? {};
        const bsuid = userId || clean(contact.user_id, 120);
        const id = clean(m?.id, 200);
        if (!id) continue;
        out.messages.push({
          id,
          waId,
          bsuid: ID.test(bsuid) ? bsuid : '',
          name: clean(contact.profile?.name, 60) || 'someone',
          ts: Number(m?.timestamp ?? 0) * 1000 || 0,
          type: clean(m?.type, 30),
          text: m?.type === 'text' ? clean(m.text?.body, 8000) : '',
          media: ['image', 'document', 'audio', 'video', 'sticker'].includes(m?.type) ? { kind: m.type, id: clean(m[m.type]?.id, 120), mime: clean(m[m.type]?.mime_type, 100), sha256: clean(m[m.type]?.sha256, 100), caption: clean(m[m.type]?.caption, 4000), filename: clean(m[m.type]?.filename, 120), voice: m[m.type]?.voice === true, url: clean(m[m.type]?.url, 2000) } : undefined,
          button: m?.type === 'interactive' && m.interactive?.button_reply ? { id: clean(m.interactive.button_reply.id, 120), title: clean(m.interactive.button_reply.title, 40) } : m?.type === 'button' ? { id: clean(m.button?.payload, 120), title: clean(m.button?.text, 40) } : undefined,
          reaction: m?.type === 'reaction' ? { messageId: clean(m.reaction?.message_id, 200), emoji: clean(m.reaction?.emoji, 16) } : undefined,
          replyTo: clean(m?.context?.id, 200) || undefined,
          forwarded: m?.context?.forwarded === true || m?.context?.frequently_forwarded === true,
          identity: clean(m?.identity_key_hash ?? m?.identity?.key_hash, 200) || undefined,
          group: Boolean(m?.group_id || m?.context?.group_id),
        });
      }
      for (const st of Array.isArray(v.statuses) ? v.statuses.slice(0, 1000) : []) {
        const err = Array.isArray(st?.errors) ? st.errors[0] : undefined;
        out.statuses.push({ id: clean(st?.id, 200), status: clean(st?.status, 20), recipient: clean(st?.recipient_id ?? st?.recipient_user_id, 120), ts: Number(st?.timestamp ?? 0) * 1000 || 0, error: err ? { code: Number(err.code) || 0, title: clean(err.title ?? err.message, 200) } : undefined });
      }
    }
  }
  out.messages.sort((a, b) => a.ts - b.ts);
  return out;
}

/** The mark a message we don't carry becomes (location, contacts, unsupported…). */
export function markOf(m) {
  switch (m.type) {
    case 'location':
      return '[location]';
    case 'contacts':
      return '[contact card]';
    case 'video':
      return '[video]';
    case 'sticker':
      return '[sticker]';
    default:
      return `[${m.type || 'message'}]`;
  }
}
