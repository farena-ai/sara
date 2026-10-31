// Hello hooks: an example Sara plugin (docs/PLUGINS.md). It shows the three turn hooks:
//   turn.before: a short note for her (the day of the week where the owner is);
//   tool.before: a word filter (a step that mentions a blocked word is stopped, with the reason);
//   reply.after: a footer line of its own after her reply (how many words she wrote).
// A plugin can add notes and cards and tighten approvals; it can't change her rules or her replies.
import { plugin } from './sara-plugin.mjs';

const words = (s) => String(s ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

plugin({
  hooks: {
    'turn.before': async (data) => {
      const day = new Date(data.time ?? Date.now()).toLocaleDateString('en-US', { weekday: 'long' });
      return { note: `Hello hooks says: it is ${day} for the owner. Mention it only if it fits.` };
    },
    'tool.before': async (data, sara) => {
      const blocked = words(sara.settings.blocked);
      const seen = JSON.stringify(data.args ?? {}).toLowerCase();
      const hit = blocked.find((w) => seen.includes(w));
      return hit ? { decision: 'deny', reason: `it mentions "${hit}", a blocked word in Hello hooks` } : {};
    },
    'reply.after': async (data, sara) => {
      if (sara.settings.footer === false) return {};
      const n = String(data.reply ?? '').split(/\s+/).filter(Boolean).length;
      await sara.kv.set('replies', ((await sara.kv.get('replies')) ?? 0) + 1);
      return { note: `${n} words in that reply.` };
    },
  },
});
