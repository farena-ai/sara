// Home scenes (Sara Store, first-party): named scenes ("movie night": the living room lights at 20%,
// the lamp off) kept in its own data and set through Sara's own Home Assistant connection
// (callTools: home_control, which asks the owner before every change). No token of its own.
import { plugin } from './sara-plugin.mjs';

const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const ACTIONS = ['turn_on', 'turn_off', 'toggle', 'lock', 'unlock', 'open', 'close', 'set_brightness', 'set_temperature', 'run'];
export const keyOf = (name) => String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
export function cleanSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new Error('A scene has 1 to 20 steps.');
  return steps.map((s) => {
    if (!ENTITY.test(String(s?.entity_id ?? ''))) throw new Error('Each step names an entity like light.kitchen.');
    if (!ACTIONS.includes(s.action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
    return { entity_id: s.entity_id, action: s.action, ...(Number.isFinite(s.brightness) ? { brightness: Math.max(0, Math.min(100, s.brightness)) } : {}), ...(Number.isFinite(s.temperature) ? { temperature: s.temperature } : {}) };
  });
}

plugin({
  tools: [
    {
      name: 'scene',
      description: 'Home scenes: save a named scene (a list of Home Assistant steps), run one by name, list them, or forget one. Running sets each step through home_control (the owner approves each change).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'run', 'list', 'forget'] },
          name: { type: 'string', description: 'The scene\'s name, e.g. movie night' },
          steps: { type: 'array', description: 'For save: [{ entity_id, action, brightness?, temperature? }]', items: { type: 'object' } },
        },
        required: ['action'],
      },
      permission: 'ask',
      run: async (args, sara) => {
        const scenes = (await sara.kv.get('scenes')) ?? {};
        const key = keyOf(args.name);
        if (args.action === 'list') return Object.keys(scenes).length ? `Scenes: ${Object.keys(scenes).join(', ')}.` : 'No scenes saved yet.';
        if (!key) return 'Say which scene.';
        if (args.action === 'save') {
          scenes[key] = cleanSteps(args.steps);
          await sara.kv.set('scenes', scenes);
          return `Saved “${key}” with ${scenes[key].length} step${scenes[key].length === 1 ? '' : 's'}.`;
        }
        if (args.action === 'forget') {
          delete scenes[key];
          await sara.kv.set('scenes', scenes);
          return `Forgot “${key}”.`;
        }
        const steps = scenes[key];
        if (!steps) return `There is no scene called “${key}”.`;
        const done = [];
        for (const s of steps) {
          const r = await sara.tool('home_control', s).catch((err) => ({ ok: false, content: err.message }));
          done.push(`${s.entity_id}: ${r.ok === false ? `not done (${String(r.content ?? '').slice(0, 80)})` : 'done'}`);
        }
        return { content: `Scene “${key}”: ${done.join('; ')}.`, card: { title: `Scene · ${key}`, lines: done } };
      },
    },
  ],
});
