// V1.1 (docs/design/V1MOVEIN.md §5): the "first evening" checklist after a move-in. Three things that
// make her feel at home (a model that answers, her voice, the chat apps you used to text her on), then
// every kind of thing that did not come in, each with the reason, so nothing is left behind silently.
// Read-only: built from the batch report (src/movein/batch.ts), the export run (src/history-import)
// and Sara's own settings at the time you look.
import type { AppContext } from '../chat.ts';
import type { LastRun } from '../history-import/index.ts';
import type { ReportLine } from './batch.ts';

export interface EveningItem {
  key: 'model' | 'voice' | 'bridges';
  done: boolean;
  text: string;
  /** Settings page key (web/movein.js PAGE) that does it. */
  page?: string;
  /** What the page words it with (t() keys there): provider, model, keys, old, apps, missing. */
  params: Record<string, string | number>;
}
export interface EveningSkip {
  /** The report key (left behind / needs you) or `<export>-<skip kind>`. */
  kind: string;
  count: number;
  why: string;
  examples?: string[];
}
export interface Evening {
  items: EveningItem[];
  /** Still to do by hand (keys to paste, cards not decided, channels to reconnect). */
  todo: EveningSkip[];
  /** Left out on purpose, with the reason. */
  skipped: EveningSkip[];
  history: { name: string; conversations: number; notes: number } | null;
}

interface ReportLike {
  imported?: ReportLine[];
  translated?: ReportLine[];
  needsYou?: ReportLine[];
  leftBehind?: ReportLine[];
}

/** Why each kind of export skip stayed out (the history preview's counts). */
export const EXPORT_WHY: Record<string, string> = {
  system: 'System prompts and hidden custom-instruction blocks inside chats: her own instructions replace them.',
  tool: 'Tool, browsing and code-runner steps: what was said is kept, the machinery is not.',
  hidden: 'Hidden, reasoning or empty messages: they were not shown in the old app either.',
  images: 'Pictures in chats: the message says a picture was there; the picture itself stays in the export.',
  attachments: 'Attached files: the message names them; add the ones you need to the Library.',
  emptyConversations: 'Chats with nothing from you in them.',
  clipped: 'Notes longer than 2000 characters: the first part is kept; add the whole file to the Library if you need it.',
};

function group(lines: ReportLine[]): EveningSkip[] {
  const by = new Map<string, EveningSkip>();
  for (const l of lines) {
    const x = by.get(l.key);
    if (x) {
      x.count += l.count || 1;
      if (x.why.length < 400 && !x.why.includes(l.text)) x.why = `${x.why} · ${l.text}`;
      if (l.examples?.length) x.examples = [...(x.examples ?? []), ...l.examples].slice(0, 4);
    } else by.set(l.key, { kind: l.key, count: l.count || 1, why: l.text, ...(l.examples?.length ? { examples: l.examples.slice(0, 4) } : {}) });
  }
  return [...by.values()];
}

/** Old chat-app names in the report (connect / channel lines). */
function oldChannels(r: ReportLike): string[] {
  const names = new Set<string>();
  // Only chat apps that were in use (their connect card); a channel switched off stays on the skipped list.
  for (const l of r.needsYou ?? []) {
    if (l.key !== 'connect-channel') continue;
    const m = /^(?:Reconnect |Connect )?([^:→(]+?)(?::| →| \()/.exec(l.text);
    if (m) names.add(m[1].trim());
  }
  return [...names];
}

export function eveningChecklist(app: AppContext, report: ReportLike | null, last: LastRun | undefined): Evening {
  const s = app.settings.get();
  const r: ReportLike = report ?? {};
  const items: EveningItem[] = [];
  const provider = (s.providers ?? []).find((p) => p.id === s.defaultProviderId);
  const keys = (r.translated ?? []).filter((l) => l.key === 'tr-provider').length;
  const label = provider ? `${provider.label}${s.defaultModel ? ` · ${s.defaultModel}` : ''}` : '';
  items.push(provider ? { key: 'model', done: keys === 0, text: keys ? `She answers with ${label}. ${keys} old model services came across with empty keys: paste yours to use them.` : `She answers with ${label}.`, page: 'models', params: { provider: label, keys } } : { key: 'model', done: false, text: 'Pick the model she answers with (Settings → Models & usage).', page: 'models', params: { keys } });
  const tts = s.voice?.tts;
  const oldVoice = (r.translated ?? []).find((l) => l.key === 'tr-voice');
  items.push(tts && tts !== 'off' ? { key: 'voice', done: true, text: oldVoice ? `Her voice: ${oldVoice.text}` : 'Her voice is on.', page: 'voice', params: { old: oldVoice ? 1 : 0 } } : { key: 'voice', done: false, text: oldVoice ? `Her old voice came across (${oldVoice.text}); switch voice on to hear her.` : 'Give her a voice (Settings → Sara → Voice), or skip it: she can stay text only.', page: 'voice', params: { old: oldVoice ? 1 : 0 } });
  const chans = oldChannels(r);
  const live = [s.telegram && (s.telegram as { token?: string; enabled?: boolean }).enabled !== false && (s.telegram as { token?: string }).token ? 'Telegram' : '', s.discord && (s.discord as { enabled?: boolean; token?: string }).enabled !== false && (s.discord as { token?: string }).token ? 'Discord' : ''].filter(Boolean);
  const missing = chans.filter((c) => !live.includes(c));
  items.push(chans.length ? { key: 'bridges', done: missing.length === 0, text: missing.length ? `You texted the old agent on ${chans.join(', ')}. Reconnect ${missing.join(', ')} so she answers there (stop the old bot first).` : `Connected again on ${chans.join(', ')}.`, page: /discord/i.test(missing[0] ?? '') ? 'discord' : 'telegram', params: { apps: chans.join(', '), missing: missing.join(', ') } } : { key: 'bridges', done: true, text: 'The old agent used no chat apps. Want to text her? Connect one under Settings → Connections.', page: 'telegram', params: { apps: '', missing: '' } });

  const todo = group((r.needsYou ?? []).filter((l) => !/^connect-channel$/.test(l.key)));
  const skipped = group(r.leftBehind ?? []);
  if (last) {
    const src = last.source;
    for (const [k, n] of Object.entries(last.skipped)) if (n) skipped.push({ kind: `${src}-${k}`, count: n, why: EXPORT_WHY[k] ?? 'Left out while reading the export.' });
    if (last.already) skipped.push({ kind: `${src}-already`, count: last.already, why: 'Chats that were already here from an earlier import.' });
  }
  return { items, todo, skipped, history: last ? { name: last.name, conversations: last.conversations, notes: last.notes } : null };
}
