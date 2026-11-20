// V2.10 (docs/design/V2SCHEDULE.md): "find a time with Sam". Asks a linked friend's Sara to trade
// free/busy (busy blocks only cross, never what the events are) and lists the requests. The times are
// proposed once the friend says yes; both people then pick in Messages (or ask her to pick one).
import type { AppContext } from '../chat.ts';
import { FT_MINUTES, FT_PARTS, friendTimeOf, type FtRequest } from '../friend-time.ts';
import { privateLocalOn } from '../net-guard.ts';
import { matchFriend } from '../friend-match.ts';
import type { Tool } from './types.ts';

const line = (r: FtRequest, tz?: string) => {
  const when = (x: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(x));
  const who = r.side === 'asker' ? `you asked ${r.friend}` : `${r.friend} asked`;
  const times = r.times.length ? ` Times: ${r.times.map((x, i) => `${i + 1}) ${when(x)}${x === r.myPick ? ' (your pick)' : ''}${x === r.theirPick ? ` (${r.friend}'s pick)` : ''}`).join('; ')}.` : '';
  return `- [${r.id}] "${r.title}", ${r.minutes} min, ${who}: ${r.status === 'agreed' && r.agreed ? `agreed for ${when(r.agreed)}` : r.status}.${times}`;
};

export function createFriendTimeTools(appOf: () => AppContext): Tool[] {
  const ft = () => {
    try {
      return friendTimeOf(appOf());
    } catch {
      return undefined;
    }
  };
  const tool: Tool = {
    spec: {
      name: 'friend_time',
      description: "Finds a time to meet with a friend whose Sara is linked to this one (Messages). action 'find' asks the friend's Sara to trade free/busy: only busy blocks cross, never what the events are; once the friend agrees, 3 times are proposed and both people pick one (agreed when both pick the same; it then goes in the planner). action 'pick' picks one of the proposed times for the owner (only when the owner said which); action 'status' lists requests.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['find', 'pick', 'status'] },
          friend: { type: 'string', description: 'The linked friend’s name (as in Messages).' },
          what: { type: 'string', description: 'What it is about, e.g. "Coffee".' },
          minutes: { type: 'number', enum: [...FT_MINUTES] },
          part: { type: 'string', enum: [...FT_PARTS], description: 'day = 9-17, evening = 17-21, any = 9-21, on each person’s own clock.' },
          days: { type: 'number', description: 'How many days ahead to look (1-21, default 7).' },
          request: { type: 'string', description: 'For pick: the request id from status.' },
          time: { type: 'number', description: 'For pick: 1, 2 or 3.' },
        },
        required: ['action'],
      },
    },
    defaultPermission: 'ask',
    isAvailable: () => !privateLocalOn() && Boolean(ft()?.friends().length),
    summarize: (a) => (a.action === 'find' ? `Find a time with ${String(a.friend ?? '?')}: ${String(a.what ?? '')}` : a.action === 'pick' ? `Pick time ${String(a.time ?? '?')}` : 'Friend scheduling requests'),
    async run(args) {
      const f = ft();
      if (!f) return 'Friend scheduling needs Messages with a linked friend (only the owner of this server).';
      const tz = appOf().settings.get().timeZone || undefined;
      const action = String(args.action ?? 'status');
      if (action === 'find') {
        const friends = f.friends();
        const found = matchFriend(friends, args.friend);
        if (found.many) return `Which one: ${found.many.map((x) => x.name).join(', ')}?`;
        const hit = found.hit;
        if (!hit) return `No linked friend called "${String(args.friend ?? '')}". Linked friends: ${friends.map((x) => x.name).join(', ') || 'none'}.`;
        const r = await f.ask(hit.id, args.what, args.minutes, args.part, args.days);
        return `Asked ${hit.name}'s Sara to find a time for "${r.title}" (${r.minutes} min, ${r.part}). ${hit.name} gets a card in Messages; once they share free/busy, 3 times appear there for both of you to pick.`;
      }
      if (action === 'pick') {
        const r = f.get(String(args.request ?? ''));
        const t = r.times[Math.round(Number(args.time)) - 1];
        if (!t) return `Request ${r.id} has ${r.times.length} proposed times; pick 1-${r.times.length}.`;
        return line(await f.pick(r.id, t), tz);
      }
      const all = f.list().slice(0, 20);
      return all.length ? all.map((r) => line(r, tz)).join('\n') : 'No friend scheduling requests yet.';
    },
  };
  return [tool];
}
