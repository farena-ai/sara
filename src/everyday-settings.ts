// 3.3.0 easy mode (ezplain): settings by asking. "Make the text bigger", "turn off your voice",
// "switch to dark mode", "call me Pat", "change your color to green": she changes a small, safe
// allow-list of everyday settings herself, and the chat shows a card with Undo (web/everyday-card.js).
//
// Every setting here belongs to the person asking: text size, Night/Day, the color and her spoken
// replies are this device's own (the card applies them in the browser that shows it), and the name
// she calls you is saved in that person's own space (a household member's settings file is their
// own). Nothing here touches security, approvals, privacy, sign-in, adult mode or household-wide
// settings: for those she explains where they are (settings_guide) and the person changes them.
import { ToolError, type Tool } from './tools/types.ts';
import type { AppContext } from './chat.ts';

type Device = { label: string; device: true; values: string[]; words: Record<string, string>; say: Record<string, string> };
type Server = { label: string; device: false };

/** The allow-list. `words` maps what people say to the app's own values (folded, lower case). */
export const EVERYDAY_SETTINGS: { text_size: Device; theme: Device; color: Device; voice: Device; my_name: Server } = {
  text_size: {
    label: 'Text size',
    device: true,
    values: ['14', '15', '17', '19'],
    words: { small: '14', smaller: '14', tiny: '14', normal: '15', default: '15', regular: '15', medium: '15', large: '17', big: '17', bigger: '17', larger: '17', 'a bit bigger': '17', largest: '19', biggest: '19', huge: '19', 'very big': '19', 'much bigger': '19', 'extra large': '19', '14': '14', '15': '15', '17': '17', '19': '19' },
    say: { 14: 'Small', 15: 'Normal', 17: 'Large', 19: 'Larger' },
  },
  theme: {
    label: 'Night or Day',
    device: true,
    values: ['dark', 'light', 'system'],
    words: { dark: 'dark', 'dark mode': 'dark', night: 'dark', 'night mode': 'dark', black: 'dark', light: 'light', 'light mode': 'light', day: 'light', 'day mode': 'light', white: 'light', bright: 'light', system: 'system', auto: 'system', automatic: 'system', 'follow the system': 'system' },
    say: { dark: 'Night', light: 'Day', system: 'Follow the system' },
  },
  color: {
    label: 'Color',
    device: true,
    values: ['violet', 'blue', 'pink', 'emerald', 'amber', 'cyan', 'green', 'red', 'grey', 'rose'],
    words: { violet: 'violet', purple: 'violet', lilac: 'violet', default: 'violet', blue: 'blue', navy: 'blue', pink: 'pink', rose: 'pink', emerald: 'emerald', teal: 'emerald', amber: 'amber', orange: 'amber', yellow: 'amber', gold: 'amber', cyan: 'cyan', turquoise: 'cyan', green: 'green', red: 'red', grey: 'grey', gray: 'grey', 'theme color': 'rose' },
    say: { violet: 'Violet', blue: 'Blue', pink: 'Rose', emerald: 'Emerald', amber: 'Amber', cyan: 'Cyan', green: 'Green', red: 'Red', grey: 'Gray', rose: 'Theme color' },
  },
  voice: {
    label: 'Her voice',
    device: true,
    values: ['on', 'off'],
    words: { on: 'on', yes: 'on', speak: 'on', talk: 'on', 'out loud': 'on', off: 'off', no: 'off', mute: 'off', quiet: 'off', silent: 'off', stop: 'off' },
    say: { on: 'On: she reads her replies out loud', off: 'Off: text only' },
  },
  my_name: { label: 'What she calls you', device: false },
};
export type EverydaySetting = keyof typeof EVERYDAY_SETTINGS;
const NAMES = Object.keys(EVERYDAY_SETTINGS) as EverydaySetting[];

const fold = (s: unknown): string => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The app's own value for what they said, or a ToolError listing the choices. */
export function everydayValue(setting: EverydaySetting, value: unknown): string {
  const def = EVERYDAY_SETTINGS[setting];
  if (!def.device) {
    const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || /[<>{}\\]/.test(name)) throw new ToolError('Give the name, like "Pat".');
    return name;
  }
  const v = fold(value);
  const hit = def.words[v] ?? def.words[v.replace(/^(the |a |an )/, '')] ?? (def.values.includes(v) ? v : undefined);
  if (hit) return hit;
  // "make it bigger" / "even bigger" for text: the larger steps.
  if (setting === 'text_size' && /\b(even|more|much|really|extra)\b.*\b(bigger|larger)\b/.test(v)) return '19';
  throw new ToolError(`${def.label} can be: ${def.values.map((x) => def.say[x]).join(', ')}.`);
}

export function createEverydaySettingsTool(app: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'change_setting',
      description:
        "Change one of the person's own everyday settings when they ask you to: text size (\"make the text bigger\"), Night or Day (\"switch to dark mode\"), the app's color (\"change your color to green\"), your spoken replies (\"turn off your voice\") or the name you call them (\"call me Pat\"). The chat shows the change with an Undo button. Only these settings: for anything else (approvals, privacy, sign-in, adult mode, models, other people) explain where it is with settings_guide instead and let them change it. Don't use it on your own initiative.",
      parameters: {
        type: 'object',
        properties: {
          setting: { type: 'string', enum: NAMES },
          value: { type: 'string', description: 'What they asked for in plain words: "bigger", "largest", "dark", "day", "green", "off", "on", or the name ("Pat").' },
        },
        required: ['setting', 'value'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Change a setting: ${String(a.setting ?? '')} → ${String(a.value ?? '').slice(0, 60)}`,
    async run(args) {
      const setting = String(args.setting ?? '') as EverydaySetting;
      if (!NAMES.includes(setting)) throw new ToolError(`That setting can't be changed by asking. You can change: ${NAMES.map((n) => EVERYDAY_SETTINGS[n].label).join(', ')}. For others, use settings_guide to say where it is.`);
      const def = EVERYDAY_SETTINGS[setting];
      const value = everydayValue(setting, args.value);
      if (!def.device) {
        const a = app();
        const from = a.settings.get().ownerName?.trim() ?? '';
        a.settings.update({ ownerName: value });
        return `Changed: ${def.label} is now "${value}"${from ? ` (was "${from}")` : ''}. Saved. From now on call them ${value}. The chat shows the change with Undo; mention it in a few words.`;
      }
      return `Changed: ${def.label} → ${def.say[value]} on the device they are using (the card in the chat applies it and has Undo). Mention it in a few words; they can change it in Settings → Appearance or Voice too.`;
    },
  };
}
