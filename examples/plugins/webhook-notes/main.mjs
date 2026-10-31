// Webhook notes: an example Sara plugin (docs/PLUGINS.md, docs/WEBHOOKS.md). A webhook whose action is
// *Send to a plugin* calls its `event:webhook` hook with the hook's id and name, the event name and the
// filtered payload (scrubbed, at most 16 KB). This one keeps the last event and posts a short note,
// labelled with the plugin's name. What a sender sent is outside text: it is only quoted, never obeyed.
import { plugin } from './sara-plugin.mjs';

plugin({
  events: {
    webhook: async (data, sara) => {
      const name = String(data.name ?? 'a webhook').slice(0, 60);
      const event = String(data.event ?? '').slice(0, 80) || 'a delivery';
      await sara.kv.set('last', { hook: String(data.hook ?? ''), event });
      await sara.notify(`${name}: ${event}`);
      return {};
    },
  },
});
