// EC7 (docs/ops/EC7_DESIGN.md "The app package"): the Teams app package he uploads in Teams (Apps →
// Manage your apps → Upload an app). A zip with manifest.json (schema 1.17), color.png (192×192) and
// outline.png (32×32, white on transparent), all made here: the icons are drawn in code and written
// as PNG with zlib, the zip is stored (no compression) with zlib's CRC-32. No dependency.
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

const SITE = 'https://github.com/farena-ai/sara';
export const MANIFEST_SCHEMA = 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stable Teams app id for this bot (the same zip twice is the same app; a new bot a new app). */
export function teamsAppId(botId: string, companion: string): string {
  const h = createHash('sha256').update(`sara-teams:${botId.toLowerCase()}:${companion}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface PackageWords {
  short: string;
  full: string;
  help: string;
  newChat: string;
  stop: string;
}

export function teamsManifest(o: { botId: string; companion: string; name: string; words: PackageWords }): Record<string, unknown> {
  if (!GUID.test(o.botId)) throw new Error('The App ID is not set yet.');
  const name = (o.name.trim() || 'Sara').slice(0, 30);
  return {
    $schema: MANIFEST_SCHEMA,
    manifestVersion: '1.17',
    version: '1.0.0',
    id: teamsAppId(o.botId, o.companion),
    developer: { name: 'Sara (self-hosted)', websiteUrl: SITE, privacyUrl: SITE, termsOfUseUrl: SITE },
    name: { short: name, full: `${name} (Sara)`.slice(0, 100) },
    description: { short: o.words.short.slice(0, 80), full: o.words.full.slice(0, 4000) },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#4B53BC',
    bots: [
      {
        botId: o.botId.toLowerCase(),
        scopes: ['personal', 'team', 'groupChat'],
        supportsFiles: true,
        isNotificationOnly: false,
        commandLists: [{ scopes: ['personal'], commands: [{ title: 'help', description: o.words.help.slice(0, 128) }, { title: 'new', description: o.words.newChat.slice(0, 128) }, { title: 'stop', description: o.words.stop.slice(0, 128) }] }],
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [],
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** An RGBA PNG of `size`² from a pixel function. */
export function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Her icon: a white ring with a dot (a speech mark) on the accent colour; the outline is the ring alone. */
const ring = (x: number, y: number, size: number): number => {
  const c = (size - 1) / 2;
  const d = Math.hypot(x - c, y - c) / size;
  return (d > 0.27 && d < 0.37) || d < 0.1 ? 1 : 0;
};
export const colorIcon = (): Buffer => png(192, (x, y) => (ring(x, y, 192) ? [255, 255, 255, 255] : [0x4b, 0x53, 0xbc, 255]));
export const outlineIcon = (): Buffer => png(32, (x, y) => (ring(x, y, 32) ? [255, 255, 255, 255] : [0, 0, 0, 0]));

/** A stored zip of the given files (names ASCII, no folders). */
export function zip(files: { name: string; data: Buffer }[], when = new Date('2026-01-01T00:00:00Z')): Buffer {
  const dosTime = ((when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate()) & 0xffff;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'latin1');
    const crc = crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, f.data);
    centrals.push(ch, name);
    offset += lh.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The whole package. */
export function teamsPackage(o: { botId: string; companion: string; name: string; words: PackageWords }): Buffer {
  const manifest = teamsManifest(o);
  return zip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: 'color.png', data: colorIcon() },
    { name: 'outline.png', data: outlineIcon() },
  ]);
}
