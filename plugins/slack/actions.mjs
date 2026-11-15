// R6 (docs/WORK_APPS.md): Slack actions asked for in a chat with Sara (her slack_* tools). Sara asks
// the person before anything is posted; this file only runs what was approved, through the bot token
// (post, react) or the person's own optional user token (status, reminder, search: Slack lets only a
// user token do those). Each change is read back from Slack before it is called done.

const clipText = (s, n) => String(s ?? '').slice(0, n);
const norm = (e) => String(e ?? '').trim().replace(/^:|:$/g, '');

/** "#general", "C0123", "@U0123", "U0123" or an email address → a channel id she can post to. */
async function target(api, to) {
  const t = String(to ?? '').trim();
  if (/^[CGD][A-Z0-9]{6,20}$/.test(t)) return t;
  let user = '';
  if (/^@?U[A-Z0-9]{6,20}$/.test(t)) user = t.replace(/^@/, '');
  else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
    const r = await api.call('users.lookupByEmail', { email: t });
    user = String(r.user?.id ?? '');
  }
  if (user) {
    const r = await api.call('conversations.open', { users: user });
    return String(r.channel?.id ?? '');
  }
  const name = t.replace(/^#/, '').toLowerCase();
  if (!/^[a-z0-9._-]{1,80}$/.test(name)) return '';
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const r = await api.call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
    const hit = (r.channels ?? []).find((c) => String(c.name ?? '').toLowerCase() === name);
    if (hit) return String(hit.id);
    cursor = String(r.response_metadata?.next_cursor ?? '');
    if (!cursor) break;
  }
  return '';
}

const needUser = () => ({ ok: false, needUserToken: true, error: 'needs_user_token' });
const fail = (error) => ({ ok: false, error: clipText(error, 120) });

/** One approved action. `api` is the plugin's Slack client (call(method, args, { user })). */
export async function runAction(api, m) {
  const op = String(m?.op ?? '');
  try {
    if (op === 'post') {
      const text = clipText(m.text, 4000).trim();
      if (!text) return fail('empty_text');
      const channel = await target(api, m.to);
      if (!channel) return fail('channel_not_found');
      const r = await api.call('chat.postMessage', { channel, text, ...(m.thread ? { thread_ts: String(m.thread) } : {}) });
      const ts = String(r.ts ?? '');
      let verified = '';
      try {
        const p = await api.call('chat.getPermalink', { channel, message_ts: ts });
        if (p.permalink) verified = `read the message back from Slack (permalink ${p.permalink})`;
      } catch {
        /* the post went through; the read-back didn't */
      }
      return { ok: true, channel, ts, ...(verified ? { verified } : {}) };
    }
    if (op === 'react') {
      const channel = String(m.channel ?? '');
      const ts = String(m.ts ?? '');
      const name = norm(m.emoji);
      if (!/^[CGD][A-Z0-9]{6,20}$/.test(channel) || !/^\d+\.\d+$/.test(ts) || !/^[\w+-]{1,60}$/.test(name)) return fail('bad_reaction');
      await api.call('reactions.add', { channel, timestamp: ts, name });
      const g = await api.call('reactions.get', { channel, timestamp: ts }).catch(() => ({}));
      const there = (g.message?.reactions ?? []).some((x) => x.name === name);
      return { ok: true, channel, ts, ...(there ? { verified: `read the reactions back from Slack (:${name}: is there)` } : {}) };
    }
    if (op === 'status') {
      if (!api.user) return needUser();
      const minutes = Math.max(0, Math.min(7 * 24 * 60, Number(m.minutes) || 0));
      const profile = { status_text: clipText(m.text, 100), status_emoji: m.emoji ? `:${norm(m.emoji)}:` : '', status_expiration: minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : 0 };
      await api.call('users.profile.set', { profile }, { user: true });
      const g = await api.call('users.profile.get', {}, { user: true }).catch(() => ({}));
      const there = g.profile?.status_text === profile.status_text;
      return { ok: true, ...(there ? { verified: 'read your Slack status back' } : {}) };
    }
    if (op === 'remind') {
      if (!api.user) return needUser();
      const text = clipText(m.text, 1000).trim();
      const time = clipText(m.time, 200).trim();
      if (!text || !time) return fail('text_and_time_needed');
      const r = await api.call('reminders.add', { text, time }, { user: true });
      const id = String(r.reminder?.id ?? '');
      const g = id ? await api.call('reminders.info', { reminder: id }, { user: true }).catch(() => ({})) : {};
      return { ok: true, id, ...(g.reminder?.id === id && id ? { verified: `read the reminder back from Slack (${id})` } : {}) };
    }
    if (op === 'search') {
      if (!api.user) return needUser();
      const r = await api.call('search.messages', { query: clipText(m.query, 300), count: Math.max(1, Math.min(20, Number(m.count) || 10)) }, { user: true });
      const matches = (r.messages?.matches ?? []).slice(0, 20).map((x) => ({ text: clipText(x.text, 400), user: clipText(x.username ?? x.user, 80), channel: clipText(x.channel?.name, 80), ts: String(x.ts ?? ''), link: clipText(x.permalink, 300) }));
      return { ok: true, matches };
    }
    return fail('unknown_action');
  } catch (err) {
    const code = String(err?.error ?? err?.message ?? 'error');
    if (code === 'missing_scope' || code === 'not_allowed_token_type') return { ok: false, error: code, needed: clipText(err?.needed, 80) };
    return fail(code);
  }
}
