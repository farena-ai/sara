// V2.3 (docs/design/V2HOME.md): Home Assistant scenes and scripts the owner picked start by voice.
// In a spoken turn from the owner (Talk with Sara, car mode, a phone call), the words alone ("Hey
// Sara, movie night") run the picked scene or script at once, without a model call or a card: him
// pressing a button he set up, like Today's picked scenes. Anything named like a lock, door or alarm
// can't be picked, and a home_control card that locks, unlocks or touches an alarm wants a tap.
import type { AppContext, TurnOptions } from './chat.ts';
import { haCall, SENSITIVE } from './home-switch.ts';
import { en, trOwner } from './i18n.ts';
import { HOME_VAULT, type HaState } from './tools/home.ts';

export interface VoiceScene {
  id: string;
  say: string;
}
export const VOICE_MAX = 24;
const ID = /^(scene|script)\.[a-z0-9_]{1,120}$/;

/** Lower case, no accents, no punctuation, single spaces. */
export function foldWords(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** May this scene/script be started by voice? Only scenes and scripts, never one named like a lock, door or alarm. */
export function voicePickable(id: string, name: string): boolean {
  return ID.test(id) && !SENSITIVE.test(name) && !SENSITIVE.test(id.split('.')[1].replace(/_/g, ' '));
}

const WAKE = /^(?:(?:hey|hi|hello|ok|okay|oye|hola|dis|salut|hallo|he|ei|ola|ehi|ciao)\s+)?(?:sara\s+)?/;
const VERB = /^(?:please\s+)?(?:start|run|turn on|switch on|activate|begin|play|set|do|inicia|iniciar|activa|activar|pon|lance|lancer|active|activer|demarre|starte|start|aktiviere|mach|inicie|ativa|ativar|comeca|avvia|attiva|metti)\s+(?:the\s+|la\s+|el\s+|le\s+|die\s+|den\s+|das\s+|a\s+|o\s+|il\s+)?/;
const TAIL = /\s+(?:please|now|por favor|ahora|s il te plait|s il vous plait|maintenant|bitte|jetzt|agora|per favore|ora|thanks|thank you)$/;

/** The picked scene the whole utterance names (an optional "hey Sara", "start", "please"), or none. */
export function matchSpoken(said: string, list: readonly VoiceScene[], herName = 'sara'): VoiceScene | undefined {
  let s = foldWords(said);
  const her = foldWords(herName);
  if (her && her !== 'sara') s = s.replace(new RegExp(`^((?:hey|hi|ok|okay|hola|salut|hallo|ciao)\\s+)?${her.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`), '');
  // Every step's result is a candidate, so a phrase that itself starts with "hello" or "do" still matches.
  const tries = new Set<string>([s]);
  for (const re of [WAKE, TAIL, VERB, TAIL]) {
    s = s.replace(re, '').trim();
    tries.add(s);
  }
  tries.delete('');
  return list.find((x) => tries.has(foldWords(x.say)));
}

/** The owner's voice list, cleaned (ids checked, phrases trimmed, no duplicates). */
export function voiceList(app: AppContext): VoiceScene[] {
  const raw = app.settings.get().home?.voice;
  return Array.isArray(raw) ? raw.filter((x) => x && ID.test(String(x.id)) && foldWords(String(x.say ?? ''))).slice(0, VOICE_MAX) : [];
}

/** A card that must be tapped, never answered by a spoken yes: locks, alarms and anything named like them. */
export function homeTapOnly(ev: { name?: string; args?: Record<string, unknown> }): boolean {
  if (ev?.name !== 'home_control') return false;
  const id = String(ev.args?.entity_id ?? '');
  const action = String(ev.args?.action ?? '');
  const domain = id.split('.')[0];
  if (domain === 'lock' || domain === 'alarm_control_panel' || ['lock', 'unlock'].includes(action)) return true;
  return SENSITIVE.test(id.replace(/[._]/g, ' '));
}

/** The scenes and scripts in Home Assistant, each with its voice state (the Settings list). */
export function voiceItems(states: HaState[], list: readonly VoiceScene[]): { id: string; name: string; say: string; on: boolean; pickable: boolean }[] {
  return states
    .filter((s) => ID.test(String(s.entity_id)))
    .map((s) => {
      const name = typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name.slice(0, 80) : s.entity_id;
      const mine = list.find((x) => x.id === s.entity_id);
      return { id: s.entity_id, name, say: mine?.say ?? name, on: Boolean(mine), pickable: voicePickable(s.entity_id, name) };
    })
    .sort((a, b) => Number(b.on) - Number(a.on) || a.id.split('.')[0].localeCompare(b.id.split('.')[0]) || a.name.localeCompare(b.name))
    .slice(0, 300);
}

/** Check a PUT's items against Home Assistant's names: returns the clean list or the reason it can't be saved. */
export function cleanVoice(items: unknown, states: HaState[]): VoiceScene[] | string {
  if (!Array.isArray(items)) return en('Send the list of scenes and scripts.');
  const out: VoiceScene[] = [];
  for (const it of items.slice(0, VOICE_MAX)) {
    const id = String((it as VoiceScene)?.id ?? '');
    const say = String((it as VoiceScene)?.say ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const s = states.find((x) => x.entity_id === id);
    if (!s) return en('Home Assistant has no such scene or script.');
    const name = typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : id;
    if (!voicePickable(id, name) || SENSITIVE.test(say)) return en('Locks, doors and alarms can’t start by voice: they always ask you first.');
    if (!foldWords(say)) return en('Give each one the words to say.');
    if (out.some((x) => foldWords(x.say) === foldWords(say))) return en('Two of them have the same words.');
    out.push({ id, say });
  }
  return out;
}

/** Test an address and token (nothing saved): name, version and how many scenes/scripts, or a plain reason. */
export async function testHome(base: string, token: string): Promise<{ ok: boolean; name?: string; version?: string; scenes?: number; scripts?: number; error?: string }> {
  const cfg = await haCall<{ location_name?: string; version?: string }>(base, token, '/api/config').catch((err: Error) => err);
  if (cfg instanceof Error || !cfg.status) return { ok: false, error: en('Couldn’t reach it from this server. Is the address right and Home Assistant on?') };
  if (cfg.status === 401 || cfg.status === 403) return { ok: false, error: en('Home Assistant refused the token. Make a new long-lived access token and paste it.') };
  if (cfg.status >= 400 || !cfg.data || typeof cfg.data !== 'object') return { ok: false, error: en('That address answered, but not like Home Assistant.') };
  const st = await haCall<HaState[]>(base, token, '/api/states').catch(() => ({ status: 0, data: [] as HaState[] }));
  const all = Array.isArray(st.data) ? st.data : [];
  return { ok: true, name: String(cfg.data.location_name ?? '').slice(0, 80), version: String(cfg.data.version ?? '').slice(0, 20), scenes: all.filter((s) => String(s.entity_id).startsWith('scene.')).length, scripts: all.filter((s) => String(s.entity_id).startsWith('script.')).length };
}

/**
 * The spoken-turn shortcut (chat.ts, after the safety blocks): the owner's own spoken words naming
 * a picked scene or script start it. Returns her short answer, or undefined (= a normal turn).
 */
export async function homeVoiceTurn(app: AppContext, text: string, opts: TurnOptions): Promise<{ reply: string; id: string } | undefined> {
  if (!(opts.talk || opts.car || opts.phoneCall) || app.member) return undefined;
  const list = voiceList(app);
  if (!list.length || text.length > 120) return undefined;
  const hit = matchSpoken(text, list, app.persona?.name);
  const base = app.settings.get().home?.url;
  const token = app.vault.get(HOME_VAULT);
  if (!hit || !base || !token || !voicePickable(hit.id, hit.say)) return undefined;
  const s = app.settings.get();
  const domain = hit.id.split('.')[0];
  const ran = await haCall(base, token, `/api/services/${domain}/turn_on`, { method: 'POST', body: { entity_id: hit.id } }).catch(() => ({ status: 0 }));
  if (ran.status === 401) return { id: hit.id, reply: trOwner(en('Home Assistant refused the token, so {what} didn’t start. Settings → Connections → Apps and services → Home Assistant.'), s, { what: hit.say }) };
  if (!ran.status || ran.status >= 400) return { id: hit.id, reply: trOwner(en('I couldn’t start {what}: Home Assistant didn’t answer.'), s, { what: hit.say }) };
  return { id: hit.id, reply: trOwner(en('{what} is on.'), s, { what: hit.say }) };
}
