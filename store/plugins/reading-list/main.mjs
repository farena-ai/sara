// Reading list (Sara Store, first-party): links and RSS/Atom feeds he sends are kept in its own data;
// once a week a card picks three unread links. Feeds live on any host and a plugin's host list is
// fixed, so it has no network of its own: when he asks for new posts (`list` with `refresh`) it reads
// each feed through Sara's web_fetch (callTools), which asks him before every read.
import { plugin } from './sara-plugin.mjs';

const MAX = 300;
export const cleanUrl = (u) => {
  try {
    const x = new URL(String(u ?? '').trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
};
/** Links from an RSS or Atom feed's text (no XML library: the two shapes feeds use). */
export function feedLinks(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<\/item>/gi)) out.push({ title: m[1].trim(), url: m[2].trim() });
  for (const m of String(xml).matchAll(/<entry\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>[\s\S]*?<link[^>]*href="([^"]+)"[\s\S]*?<\/entry>/gi)) out.push({ title: m[1].trim(), url: m[2].trim() });
  return out.filter((x) => cleanUrl(x.url)).slice(0, 50);
}

plugin({
  tools: [
    {
      name: 'add',
      description: 'Add a link to read later, or an RSS/Atom feed to follow (feed: true).',
      parameters: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, feed: { type: 'boolean' } }, required: ['url'] },
      permission: 'auto',
      run: async (args, sara) => {
        const url = cleanUrl(args.url);
        if (!url) return 'That isn\'t a web address.';
        const key = args.feed ? 'feeds' : 'links';
        const list = (await sara.kv.get(key)) ?? [];
        if (list.some((x) => x.url === url)) return 'Already on the list.';
        list.push({ url, title: String(args.title ?? '').slice(0, 160), at: new Date().toISOString(), read: false });
        await sara.kv.set(key, list.slice(-MAX));
        return args.feed ? `Following ${url}.` : `Added to the reading list (${list.length}).`;
      },
    },
    {
      name: 'list',
      description: 'The reading list (unread first). refresh: true reads each followed feed now through web_fetch (asks the owner each time); done: a URL to mark as read.',
      parameters: { type: 'object', properties: { refresh: { type: 'boolean' }, done: { type: 'string' } } },
      permission: 'auto',
      run: async (args, sara) => {
        const links = (await sara.kv.get('links')) ?? [];
        if (args.done) for (const l of links) if (l.url === cleanUrl(args.done)) l.read = true;
        if (args.refresh) {
          for (const f of ((await sara.kv.get('feeds')) ?? []).slice(0, 10)) {
            const r = await sara.tool('web_fetch', { url: f.url }).catch(() => null);
            if (!r || r.ok === false) continue;
            for (const x of feedLinks(r.content).slice(0, 10)) if (!links.some((l) => l.url === x.url)) links.push({ ...x, at: new Date().toISOString(), read: false, from: f.url });
          }
        }
        await sara.kv.set('links', links.slice(-MAX));
        const unread = links.filter((l) => !l.read);
        return unread.length ? `${unread.length} unread: ${unread.slice(0, 10).map((l) => `${l.title || l.url} (${l.url})`).join('; ')}` : 'Nothing unread.';
      },
    },
  ],
  schedules: {
    weekly: async (sara) => {
      const unread = ((await sara.kv.get('links')) ?? []).filter((l) => !l.read);
      if (!unread.length) return {};
      const pick = unread.sort((a, b) => (a.at < b.at ? -1 : 1)).slice(0, 3);
      await sara.card({ title: 'This week\'s reading pick', lines: pick.map((l) => l.title || l.url) });
      return {};
    },
  },
});
