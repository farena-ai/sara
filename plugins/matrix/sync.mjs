// Reading a /sync answer (docs/design/BRIDGES4.md §6.3–§6.6): pure functions, no network. The sync
// loop itself lives in main.mjs. What comes out: invites (who invited her, whether the stripped
// state says the room is encrypted), each joined room's state (name, members, encryption) and its
// timeline events, oldest first. Unknown events are dropped; nothing here trusts `formatted_body`.

export const FILTER = {
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    state: { lazy_load_members: true, types: ['m.room.encryption', 'm.room.member', 'm.room.name', 'm.room.create'] },
    timeline: { types: ['m.room.message', 'm.reaction', 'm.room.redaction', 'm.room.encryption', 'm.room.member', 'm.room.name', 'm.room.encrypted'], limit: 50, lazy_load_members: true },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
};

/** The first sync: only the newest event per room, and none of it is answered (§6.3). */
export const FIRST_FILTER = { ...FILTER, room: { ...FILTER.room, timeline: { ...FILTER.room.timeline, limit: 1 } } };

const ID = /^[!$@#][^\s]{1,250}$/;
const str = (v, n = 8000) => String(v ?? '').slice(0, n);

/** `!abc:server` ⇄ the chat id Sara keeps (Sara's ids have no `!`). */
export const chatOf = (roomId) => str(roomId, 200).replace(/^!/, '');
export const roomOf = (chatId) => (String(chatId).startsWith('!') ? String(chatId) : `!${chatId}`);

/** → { nextBatch, invites: [{ roomId, inviter, encrypted, name }], rooms: [{ roomId, state: {name?, encrypted, joined: [], left: []}, events: [] }], left: [roomId] } */
export function readSync(res, me) {
  const out = { nextBatch: str(res?.next_batch, 500), invites: [], rooms: [], left: [] };
  const invite = res?.rooms?.invite ?? {};
  for (const [roomId, r] of Object.entries(invite).slice(0, 50)) {
    if (!ID.test(roomId)) continue;
    const evs = Array.isArray(r?.invite_state?.events) ? r.invite_state.events : [];
    const mine = evs.find((e) => e?.type === 'm.room.member' && e?.state_key === me && e?.content?.membership === 'invite');
    out.invites.push({
      roomId,
      inviter: str(mine?.sender, 255),
      encrypted: evs.some((e) => e?.type === 'm.room.encryption'),
      name: str(evs.find((e) => e?.type === 'm.room.name')?.content?.name, 120),
      direct: mine?.content?.is_direct === true,
    });
  }
  const join = res?.rooms?.join ?? {};
  for (const [roomId, r] of Object.entries(join).slice(0, 200)) {
    if (!ID.test(roomId)) continue;
    const state = { encrypted: false, joined: [], left: [] };
    const take = (e) => {
      if (e?.type === 'm.room.encryption') state.encrypted = true;
      if (e?.type === 'm.room.name') state.name = str(e.content?.name, 120);
      if (e?.type === 'm.room.member' && typeof e.state_key === 'string') {
        if (e.content?.membership === 'join') state.joined.push(e.state_key);
        else if (['leave', 'ban'].includes(e.content?.membership)) state.left.push(e.state_key);
      }
    };
    for (const e of Array.isArray(r?.state?.events) ? r.state.events : []) take(e);
    const events = [];
    for (const e of Array.isArray(r?.timeline?.events) ? r.timeline.events : []) {
      if (!e || typeof e !== 'object' || !ID.test(str(e.event_id, 255))) continue;
      take(e);
      events.push(e);
    }
    const count = Number(r?.summary?.['m.joined_member_count']);
    out.rooms.push({ roomId, state, events, ...(Number.isFinite(count) ? { memberCount: count } : {}), limited: r?.timeline?.limited === true });
  }
  for (const roomId of Object.keys(res?.rooms?.leave ?? {}).slice(0, 200)) if (ID.test(roomId)) out.left.push(roomId);
  return out;
}

/** The text of a message without a reply's quoted fallback (`> <@x> …` lines, then a blank line). */
export function stripFallback(body) {
  const lines = String(body ?? '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i > 0 && lines[i] === '') i++;
  return i > 0 ? lines.slice(i).join('\n') : String(body ?? '');
}

/** What one timeline event is, for main.mjs: text, media, reaction, redaction, edit, encrypted or other. */
export function kindOf(e) {
  const c = e?.content ?? {};
  if (e?.type === 'm.room.encrypted') return { kind: 'encrypted' };
  if (e?.type === 'm.reaction') {
    const rel = c['m.relates_to'] ?? {};
    return rel.rel_type === 'm.annotation' ? { kind: 'reaction', target: str(rel.event_id, 255), key: str(rel.key, 32) } : { kind: 'other' };
  }
  if (e?.type === 'm.room.redaction') return { kind: 'redaction', target: str(e.redacts ?? c.redacts, 255) };
  if (e?.type !== 'm.room.message') return { kind: 'other' };
  const rel = c['m.relates_to'] ?? {};
  if (rel.rel_type === 'm.replace') return { kind: 'edit', target: str(rel.event_id, 255), text: str(c['m.new_content']?.body ?? '') };
  const replyTo = str(rel['m.in_reply_to']?.event_id, 255) || undefined;
  const thread = rel.rel_type === 'm.thread' ? str(rel.event_id, 255) : undefined;
  const mentions = Array.isArray(c['m.mentions']?.user_ids) ? c['m.mentions'].user_ids.map((x) => str(x, 255)) : [];
  const base = { replyTo, thread, mentions, at: Number(e.origin_server_ts) || undefined };
  const type = str(c.msgtype, 40);
  if (['m.text', 'm.notice', 'm.emote'].includes(type)) return { kind: 'text', text: replyTo ? stripFallback(c.body) : str(c.body), ...base };
  if (['m.image', 'm.file', 'm.audio', 'm.video'].includes(type)) {
    const url = str(c.url, 500);
    const m = /^mxc:\/\/([^/\s]{1,255})\/([A-Za-z0-9_-]{1,255})$/.exec(url);
    return {
      kind: 'media',
      media: type.slice(2),
      server: m?.[1],
      mediaId: m?.[2],
      encryptedFile: !url && Boolean(c.file),
      name: str(c.filename ?? c.body, 120) || 'file',
      mime: str(c.info?.mimetype, 100) || 'application/octet-stream',
      size: Number(c.info?.size) || 0,
      voice: type === 'm.audio' && (c['org.matrix.msc3245.voice'] !== undefined || c['m.voice'] !== undefined),
      caption: c.filename && c.body && c.body !== c.filename ? str(c.body) : '',
      ...base,
    };
  }
  return { kind: 'mark', text: `[${type || 'message'}]`, ...base };
}
