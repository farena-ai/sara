// V2.4 (docs/BRIEFING_AUDIO.md): the morning briefing as audio. After a briefing goes out (or on
// "Make audio now"), its text is spoken with the voice on this computer (Kokoro/Piper through
// src/voice.ts; never a cloud voice unless the person picked "my chosen voice") into one WAV file
// kept in the Library (collection "Briefings", the text as its readable passages), a play button on
// Today, and an optional private podcast feed: /feed/briefing/<token> (RSS 2.0 with enclosures),
// readable only with its token. Only a hash of the token is stored; a new link stops the old one.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { herVoice } from './persona-style.ts';
import { speechOf } from './speech.ts';
import { speechChunks, VoiceError, type Audio } from './voice.ts';

export type BriefingVoice = 'local' | 'chosen';
export const BRIEFING_COLLECTION = 'Briefings';
/** How many briefing recordings the Library keeps (older ones are deleted). */
export const KEEP_AUDIO = 14;
export const BRIEFING_AUDIO_LINES = [en('No briefing yet. Send one first.'), en('The voice on this computer isn’t installed. Install it in Settings → Voice, or pick your chosen voice.'), en('The private podcast link is only for the owner of this server.'), en('The Library isn’t available here.')];

export interface BriefingAudioItem {
  id: number;
  day: string;
  name: string;
  size: number;
  addedAt: string;
  /** Seconds (WAV only). */
  seconds?: number;
}

type Speak = (text: string) => Promise<Audio>;

// ---------------------------------------------------------------- WAV joining

interface Pcm {
  fmt: Buffer;
  data: Buffer;
  rate: number;
  blockAlign: number;
}

/** Reads the "fmt " and "data" chunks of a RIFF/WAVE file. */
export function readWav(b: Buffer): Pcm {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new VoiceError('The voice did not return a WAV file.');
  let fmt: Buffer | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
    if (id === 'fmt ') fmt = Buffer.from(body);
    else if (id === 'data') data = body;
    at += 8 + size + (size % 2);
  }
  if (!fmt || fmt.length < 16 || !data) throw new VoiceError('The voice returned a broken WAV file.');
  return { fmt, data, rate: fmt.readUInt32LE(4), blockAlign: fmt.readUInt16LE(12) || 2 };
}

/** One WAV from several (same format), with a short pause between the parts. */
export function joinWav(parts: Buffer[], pauseMs = 350): Buffer {
  const pcm = parts.map(readWav);
  const first = pcm[0];
  if (!first) throw new VoiceError('Nothing to say');
  for (const p of pcm) if (!p.fmt.subarray(0, 16).equals(first.fmt.subarray(0, 16))) throw new VoiceError('The voice changed format between parts.');
  const gap = Buffer.alloc(Math.round((first.rate * pauseMs) / 1000) * first.blockAlign);
  const body = Buffer.concat(pcm.flatMap((p, i) => (i ? [gap, p.data] : [p.data])));
  const fmt = first.fmt.subarray(0, 16);
  const head = Buffer.alloc(12 + 8 + fmt.length + 8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + 8 + fmt.length + 8 + body.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(fmt.length, 16);
  fmt.copy(head, 20);
  head.write('data', 20 + fmt.length, 'ascii');
  head.writeUInt32LE(body.length, 24 + fmt.length);
  return Buffer.concat([head, body]);
}

function wavSeconds(b: Buffer): number | undefined {
  try {
    const p = readWav(b);
    const bytesPerSec = p.fmt.readUInt32LE(8);
    return bytesPerSec ? Math.round((p.data.length / bytesPerSec) * 10) / 10 : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- the voice

/** The voice the recording uses: the local engine unless the person picked their chosen (maybe cloud) voice. */
export function briefingSpeaker(app: AppContext, choice: BriefingVoice): Speak {
  const v = herVoice(app);
  if (choice === 'chosen') return (text) => speechOf(app).speak(text);
  return async (text) => {
    if (!app.voice || !app.voice.voices().length) throw new VoiceError('The voice on this computer isn’t installed. Install it in Settings → Voice, or pick your chosen voice.');
    return app.voice.speak(text, v.local, v.speed);
  };
}

/** Speaks a text part by part and joins it into one file (WAV, or MP3 from a cloud voice). */
export async function renderSpeech(text: string, speak: Speak): Promise<{ data: Buffer; ext: 'wav' | 'mp3' }> {
  const chunks = speechChunks(text, 400);
  if (!chunks.length) throw new VoiceError('Nothing to say');
  const out: Audio[] = [];
  for (const c of chunks) out.push(await speak(c));
  if (out.every((a) => /wav/.test(a.type))) return { data: joinWav(out.map((a) => a.data)), ext: 'wav' };
  if (out.every((a) => /mpeg|mp3/.test(a.type))) return { data: Buffer.concat(out.map((a) => a.data)), ext: 'mp3' };
  throw new VoiceError('The voice returned mixed formats.');
}

// ---------------------------------------------------------------- the Library

const NAME_RE = /^Morning briefing (\d{4}-\d{2}-\d{2})\.(wav|mp3)$/;

/** The briefing recordings in the Library, newest first. */
export function briefingAudios(app: AppContext): BriefingAudioItem[] {
  const lib = app.library;
  if (!lib) return [];
  return lib
    .list({ collection: BRIEFING_COLLECTION })
    .map((d) => ({ d, m: NAME_RE.exec(d.name) }))
    .filter((x) => x.m)
    .map(({ d, m }) => ({ id: d.id, day: m![1], name: d.name, size: d.size, addedAt: d.addedAt }))
    .sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id);
}

export function briefingAudio(app: AppContext, id: number): { item: BriefingAudioItem; bytes: Buffer; type: string } | undefined {
  const item = briefingAudios(app).find((x) => x.id === id);
  const doc = item && app.library?.get(id);
  const bytes = doc && app.library!.file(doc);
  if (!item || !bytes) return undefined;
  return { item: { ...item, ...(item.name.endsWith('.wav') ? { seconds: wavSeconds(bytes) } : {}) }, bytes, type: item.name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' };
}

/** The newest briefing she sent (text and local day), from the conversations. */
export function lastBriefing(app: AppContext): { text: string; day: string } | undefined {
  const row = app.store.db
    .prepare("SELECT content, meta FROM messages WHERE role = 'assistant' AND meta LIKE '%\"briefing\"%' ORDER BY id DESC LIMIT 1")
    .get() as { content: string; meta: string } | undefined;
  if (!row) return undefined;
  let day: string | undefined;
  try {
    day = (JSON.parse(row.meta) as { briefing?: { day?: string } }).briefing?.day;
  } catch {
    /* old row */
  }
  return { text: row.content, day: day ?? localDate(app.now().toISOString(), app.settings.get().timeZone) };
}

/** One recording per day: a new one for the same day replaces it; only the newest KEEP_AUDIO stay. */
export async function makeBriefingAudio(app: AppContext, text: string, day: string, choice: BriefingVoice = 'local', speak: Speak = briefingSpeaker(app, choice)): Promise<BriefingAudioItem> {
  const lib = app.library;
  if (!lib) throw new VoiceError('The Library isn’t available here.');
  const { data, ext } = await renderSpeech(text, speak);
  for (const old of briefingAudios(app).filter((x) => x.day === day)) lib.delete(old.id);
  const doc = lib.add({ name: `Morning briefing ${day}.${ext}`, bytes: data, keep: true, learn: false });
  lib.setCollection(doc.id, BRIEFING_COLLECTION);
  lib.setRead(doc.id, { title: `Morning briefing ${day}`, kind: 'audio', parts: [{ text, where: 'Briefing' }], warnings: [] });
  for (const old of briefingAudios(app).slice(KEEP_AUDIO)) lib.delete(old.id);
  const item = briefingAudios(app).find((x) => x.id === doc.id)!;
  app.events?.publish({ type: 'library', id: item.id });
  return item;
}

// ---------------------------------------------------------------- private podcast feed

interface FeedState {
  hash: string;
  createdAt: string;
}

const feedFile = (app: AppContext) => join(app.dataDir, 'briefing-feed.json');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function feedState(app: AppContext): FeedState | undefined {
  try {
    const f = feedFile(app);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as FeedState) : undefined;
  } catch {
    return undefined;
  }
}

/** Turns the feed on with a NEW token (any old link stops working). The token is shown once. */
export function newFeedToken(app: AppContext): string {
  const token = randomBytes(24).toString('base64url');
  const f = feedFile(app);
  writeFileSync(`${f}.tmp`, JSON.stringify({ hash: sha(token), createdAt: app.now().toISOString() }), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  return token;
}

export function feedOff(app: AppContext): void {
  try {
    writeFileSync(feedFile(app), '{}', { mode: 0o600 });
  } catch {
    /* nothing to turn off */
  }
}

export function feedTokenOk(app: AppContext, token: string): boolean {
  const st = feedState(app);
  if (!st?.hash || !/^[\w-]{20,64}$/.test(token)) return false;
  const a = Buffer.from(sha(token), 'hex');
  const b = Buffer.from(st.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** The RSS 2.0 podcast feed (enclosure URLs carry the token, since podcast apps send no cookies). */
export function feedXml(app: AppContext, base: string, token: string): string {
  const name = app.persona.name || 'Sara';
  const items = briefingAudios(app).map((a) => {
    const url = `${base}/feed/briefing/${token}/${a.id}.${a.name.endsWith('.mp3') ? 'mp3' : 'wav'}`;
    const text = app.library?.passages(a.id, { limit: 5 }).map((p) => p.text).join('\n') ?? '';
    return `<item><title>${xml(`Morning briefing ${a.day}`)}</title><guid isPermaLink="false">sara-briefing-${a.id}</guid><pubDate>${new Date(a.addedAt).toUTCString()}</pubDate><description>${xml(text.slice(0, 2000))}</description><enclosure url="${xml(url)}" length="${a.size}" type="${a.name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'}"/></item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${xml(`${name}: morning briefings`)}</title><description>${xml('Private feed. Do not share this link.')}</description><link>${xml(base)}</link>${items.join('')}</channel></rss>\n`;
}

/** Public part: /feed/briefing/<token> and /feed/briefing/<token>/<id>.wav. False when not ours. */
export function serveFeed(app: AppContext, pathname: string, base: string, res: import('node:http').ServerResponse): boolean {
  const m = /^\/feed\/briefing\/([^/]+)(?:\/(\d+)\.(?:wav|mp3))?\/?$/.exec(pathname);
  if (!m) return false;
  const nope = () => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end('Not found');
    return true;
  };
  if (!feedTokenOk(app, m[1])) return nope();
  if (!m[2]) {
    const body = feedXml(app, base, m[1]);
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
    res.end(body);
    return true;
  }
  const got = briefingAudio(app, Number(m[2]));
  if (!got) return nope();
  res.writeHead(200, { 'content-type': got.type, 'content-length': String(got.bytes.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' });
  res.end(got.bytes);
  return true;
}
