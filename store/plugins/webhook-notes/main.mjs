// Webhook notes 2 (Sara Store, first-party). A webhook set to *Send to a plugin* calls event:webhook
// with the hook's id and name, the event name and the filtered payload (scrubbed, at most 16 KB).
// Events that match the owner's rules are told at once; the rest go in a morning digest card. The
// last 50 are kept in its own data. What a sender sent is outside text: quoted, never obeyed.
import { plugin } from './sara-plugin.mjs';

export const KEEP = 50;
export function rules(text) {
  return String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 30);
}
export function matters(event, list) {
  const e = String(event ?? '').toLowerCase();
  return list.some((r) => (r.startsWith('*') ? e.endsWith(r.slice(1)) : r.endsWith('*') ? e.startsWith(r.slice(0, -1)) : e === r));
}

plugin({
  events: {
    webhook: async (data, sara) => {
      const name = String(data.name ?? 'a webhook').slice(0, 60);
      const event = String(data.event ?? '').slice(0, 80) || 'a delivery';
      const list = ((await sara.kv.get('events')) ?? []).slice(-(KEEP - 1));
      const now = new Date().toISOString();
      const hit = matters(event, rules(sara.settings.matters ?? '*.failed, *.error'));
      list.push({ at: now, hook: name, event, told: hit });
      await sara.kv.set('events', list);
      if (hit) await sara.notify(`${name}: ${event}`);
      return {};
    },
  },
  schedules: {
    digest: async (sara) => {
      const list = (await sara.kv.get('events')) ?? [];
      const since = (await sara.kv.get('digestAt')) ?? '';
      const fresh = list.filter((x) => x.at > since && !x.told);
      await sara.kv.set('digestAt', new Date().toISOString());
      if (!fresh.length) return {};
      const counts = new Map();
      for (const x of fresh) counts.set(`${x.hook}: ${x.event}`, (counts.get(`${x.hook}: ${x.event}`) ?? 0) + 1);
      const lines = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
      await sara.card({ title: `Webhooks since yesterday: ${fresh.length}`, lines });
      return {};
    },
  },
});
