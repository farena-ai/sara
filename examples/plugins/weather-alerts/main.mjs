// Weather alerts: an example Sara plugin (docs/PLUGINS.md). It adds a tool (check), a note before
// turns that talk about the weather, a morning schedule and a planner event. Its network host
// (api.weather.example) is a placeholder, so every lookup falls back to a demo forecast made from
// the city and the day: real plugins would call a real weather API through sara.fetch.
import { plugin } from './sara-plugin.mjs';

const CONDITIONS = ['sunny', 'partly cloudy', 'rain showers', 'thunderstorms', 'windy', 'light rain'];
function demo(city, day) {
  let h = 0;
  for (const ch of `${city}|${day}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { condition: CONDITIONS[h % CONDITIONS.length], high: 12 + (h % 17), low: 3 + (h % 9) };
}

async function forecast(sara, day) {
  const city = String(sara.settings.city || 'your city');
  try {
    const r = await sara.fetch(`https://api.weather.example/v1/forecast?city=${encodeURIComponent(city)}&day=${encodeURIComponent(day)}`);
    if (r.status === 200) return { city, ...JSON.parse(r.body), demo: false };
  } catch (err) {
    sara.log(`forecast host unavailable (${err.message}); using a demo forecast`);
  }
  return { city, ...demo(city, day), demo: true };
}

const today = () => new Date().toISOString().slice(0, 10);

plugin({
  tools: [
    {
      name: 'check',
      description: 'Weather alerts for a day (storms, rain) in the owner\'s city. Day as YYYY-MM-DD; today when left out.',
      parameters: { type: 'object', properties: { day: { type: 'string', description: 'YYYY-MM-DD' } } },
      permission: 'ask',
      run: async (args, sara) => {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args.day ?? '')) ? String(args.day) : today();
        const f = await forecast(sara, day);
        const alert = /storm|rain/.test(f.condition);
        return {
          content: `${f.city} on ${day}: ${f.condition}, high ${f.high} °C, low ${f.low} °C.${alert ? ' Alert: plan indoor options.' : ' No alerts.'}${f.demo ? ' (Demo data: the example plugin uses a placeholder weather host.)' : ''}`,
          card: { title: `Weather alerts · ${f.city}`, lines: [`${day}: ${f.condition}`, `High ${f.high} °C · low ${f.low} °C`, alert ? 'Alert: plan indoor options' : 'No alerts', ...(f.demo ? ['Demo data'] : [])] },
        };
      },
    },
  ],
  hooks: {
    'turn.before': async (data, sara) => {
      if (!/\b(weather|rain|storm|umbrella|outside|picnic|hike)\b/i.test(String(data.text ?? ''))) return {};
      const f = await Promise.race([forecast(sara, today()), new Promise((r) => setTimeout(() => r(null), 900))]);
      return f ? { note: `Weather alerts: today in ${f.city}: ${f.condition}, high ${f.high} °C${f.demo ? ' (demo data)' : ''}.` } : {};
    },
  },
  schedules: {
    morning: async (sara) => {
      const f = await forecast(sara, today());
      if (!/storm|rain/.test(f.condition)) return {};
      await sara.notify(`${f.condition} in ${f.city} today: plan indoor options.`);
      if (sara.settings.todo === true) await sara.tool('todo', { action: 'add', title: 'Take an umbrella', priority: 'normal' });
      return {};
    },
  },
  events: {
    planner: async (data, sara) => {
      await sara.kv.set('plannerChanges', ((await sara.kv.get('plannerChanges')) ?? 0) + 1);
      return {};
    },
  },
});
