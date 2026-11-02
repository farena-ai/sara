// Weather alerts 2 (Sara Store, first-party): the evening before a storm, heavy rain or snow it tells
// you, so plans outside don't catch you out. Real forecasts from Open-Meteo (free for personal use,
// no key): the city is looked up once on geocoding-api.open-meteo.com, the forecast on
// api.open-meteo.com. Nothing else leaves; a planner change only makes it look again that evening.
import { plugin } from './sara-plugin.mjs';

// WMO weather codes (Open-Meteo): which ones are worth a warning, in plain words.
const SEVERE = new Map([
  [65, 'heavy rain'], [67, 'freezing rain'], [75, 'heavy snow'], [77, 'snow grains'], [82, 'violent rain showers'],
  [86, 'heavy snow showers'], [95, 'thunderstorms'], [96, 'thunderstorms with hail'], [99, 'thunderstorms with heavy hail'],
]);
const MILD = new Map([[61, 'light rain'], [63, 'rain'], [71, 'light snow'], [73, 'snow'], [80, 'rain showers'], [81, 'rain showers'], [85, 'snow showers'], [0, 'clear sky'], [1, 'mainly clear'], [2, 'partly cloudy'], [3, 'overcast'], [45, 'fog'], [48, 'fog'], [51, 'drizzle'], [53, 'drizzle'], [55, 'drizzle']]);
export const words = (code) => SEVERE.get(code) ?? MILD.get(code) ?? 'mixed weather';
export const severe = (code, rainMm = 0, windKmh = 0) => SEVERE.has(code) || rainMm >= 20 || windKmh >= 60;

async function place(sara) {
  const city = String(sara.settings.city ?? '').trim();
  if (!city) return null;
  const cached = await sara.kv.get('place');
  if (cached && cached.city === city) return cached;
  const r = await sara.fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
  if (r.status !== 200) throw new Error(`the city lookup answered ${r.status}`);
  const hit = JSON.parse(r.body).results?.[0];
  if (!hit) throw new Error(`no place called ${city}`);
  const p = { city, name: hit.name, lat: hit.latitude, lon: hit.longitude, tz: hit.timezone ?? 'auto' };
  await sara.kv.set('place', p);
  return p;
}

export function readDays(json) {
  const d = json.daily ?? {};
  return (d.time ?? []).map((day, i) => ({ day, code: d.weather_code?.[i] ?? -1, high: d.temperature_2m_max?.[i], low: d.temperature_2m_min?.[i], rain: d.precipitation_sum?.[i] ?? 0, wind: d.wind_speed_10m_max?.[i] ?? 0 }));
}

async function forecast(sara) {
  const p = await place(sara);
  if (!p) return null;
  const r = await sara.fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&forecast_days=3&timezone=${encodeURIComponent(p.tz)}`);
  if (r.status !== 200) throw new Error(`the forecast answered ${r.status}`);
  return { place: p, days: readDays(JSON.parse(r.body)) };
}

const line = (d) => `${d.day}: ${words(d.code)}, ${Math.round(d.high)}° / ${Math.round(d.low)}°${d.rain ? `, ${d.rain} mm` : ''}`;

plugin({
  tools: [
    {
      name: 'check',
      description: "The weather for the next three days in the owner's city (from Open-Meteo), with storm, heavy rain and snow warnings.",
      parameters: { type: 'object', properties: {} },
      permission: 'ask',
      run: async (_args, sara) => {
        const f = await forecast(sara);
        if (!f) return 'No city is set: add one in the plugin\'s settings.';
        const warn = f.days.filter((d) => severe(d.code, d.rain, d.wind));
        return {
          content: `${f.place.name}: ${f.days.map(line).join('; ')}.${warn.length ? ` Warning: ${warn.map((d) => `${words(d.code)} on ${d.day}`).join(', ')}.` : ' No warnings.'}`,
          card: { title: `Weather · ${f.place.name}`, lines: [...f.days.map(line), warn.length ? 'Plan indoor options' : 'No warnings', 'Forecast: Open-Meteo'] },
        };
      },
    },
  ],
  schedules: {
    evening: async (sara) => {
      const f = await forecast(sara).catch((err) => (sara.log(`no forecast: ${err.message}`, 'warn'), null));
      const tomorrow = f?.days[1];
      if (!tomorrow || !severe(tomorrow.code, tomorrow.rain, tomorrow.wind)) return {};
      if ((await sara.kv.get('warned')) === tomorrow.day) return {};
      await sara.kv.set('warned', tomorrow.day);
      await sara.notify(`${words(tomorrow.code)} in ${f.place.name} tomorrow. If you planned something outside, have a plan B.`);
      return {};
    },
  },
  events: {
    planner: async (_data, sara) => {
      // A plan changed: the next evening check looks again even if it already warned for that day.
      await sara.kv.set('warned', null);
      return {};
    },
  },
});
