// T51 (C2, one route resolver): which model answers a job was decided twice, by resolveChain (what a
// turn or a job really runs) and by modelAuthorityOf (the witness a waiting reply is checked against).
// These rows pin both across the routing rules. Where the two differ today, the row says FINDING and
// the turn is the truth (see docs/BACKLOG.md, T51).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelAuthorityOf, resolveChain, type Job, type TurnOptions } from '../src/chat.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { turnJob } from '../src/route-resolve.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import type { Settings } from '../src/settings.ts';
import type { Conversation } from '../src/store.ts';
import { makeApp, tempDir } from './helpers.ts';

const NOW = new Date('2026-11-24T12:00:00Z');
const PROVIDERS: ProviderConfig[] = [
  { id: 'loc', label: 'Home', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3:8b', local: true },
  { id: 'loc2', label: 'Home two', kind: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', defaultModel: 'qwen3:4b', local: true },
  { id: 'lan', label: 'Desk PC', kind: 'openai-compatible', baseUrl: 'http://192.168.1.5:11434/v1', defaultModel: 'gemma4:12b', local: true },
  { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', defaultModel: 'big-1', needsKey: true },
  { id: 'nokey', label: 'No key', kind: 'openai-compatible', baseUrl: 'https://api.nokey.example/v1', defaultModel: 'nk-1', needsKey: true },
  { id: 'sub', label: 'Grok (subscription)', kind: 'grok-cli', baseUrl: 'https://cli-chat-proxy.grok.com', defaultModel: 'grok-4.7' },
];
const BASE: Partial<Settings> = { providers: PROVIDERS, defaultProviderId: 'loc', defaultModel: 'llama3:8b', ownerName: 'Alex', disclosureAcceptedAt: NOW.toISOString(), autoJobs: [] };
const ADULT_ON = { adultMode: { on: true, confirmedAt: NOW.toISOString() } } as unknown as Partial<Settings>;

type ConvOpts = Parameters<ReturnType<typeof makeApp>['store']['createConversation']>[0];
interface AuthInput { photos: boolean; explicit: boolean; research: boolean; quick: boolean }

function fresh(t: { after: (fn: () => void) => void }, patch: Partial<Settings> = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.vault.set('provider:cloud', 'sk-test-cloud');
  app.settings.update({ ...BASE, ...patch });
  return app;
}

/** The turn's chain as `provider/model@from`, or `throws: …`. */
function turnOf(app: ReturnType<typeof makeApp>, conv: Conversation, job: Job, adult = false): string[] {
  try {
    return resolveChain(app, conv, job, adult).map((c) => `${c.provider.config.id}/${c.model}@${c.from}`);
  } catch (err) {
    return [`throws: ${(err as Error).message}`];
  }
}

/** The witness: its job and the `provider/model` it says is in charge. */
function authOf(app: ReturnType<typeof makeApp>, conv: Conversation, input: Partial<AuthInput> = {}): { job: string; ids: string[]; auto?: string } {
  const raw = JSON.parse(modelAuthorityOf(app, app.settings.get(), conv, { photos: false, explicit: false, research: false, quick: false, ...input }, {} as TurnOptions));
  return { job: raw.job, ids: raw.selected.map((x: { provider: { id: string }; model: string }) => `${x.provider.id}/${x.model}`), ...(raw.auto ? { auto: raw.auto } : {}) };
}

const idsOf = (turn: string[]) => (turn[0]?.startsWith('throws: ') ? [] : turn.map((x) => x.replace(/@.*$/, '')));

interface Row {
  name: string;
  settings?: Partial<Settings>;
  conv?: ConvOpts;
  job: Job;
  adult?: boolean;
  privateLocal?: boolean;
  /** The turn's chain (or a pattern of its error). */
  turn: string[] | RegExp;
  /** The witness input; with it the witness must name the same models for `authJob` (default: the job). */
  input?: Partial<AuthInput>;
  authJob?: string;
}

const CHAT = { chat: { providerId: 'cloud', model: 'big-1' } };
const ROWS: Row[] = [
  { name: 'nothing set: the default model', job: 'turn', turn: ['loc/llama3:8b@default'], input: {} },
  { name: 'the conversation has its own model', conv: { providerId: 'cloud', model: 'big-2' }, job: 'turn', turn: ['cloud/big-2@conversation'], input: {} },
  { name: 'the conversation has its own provider, no model: its default', conv: { providerId: 'loc2', model: null }, job: 'turn', turn: ['loc2/qwen3:4b@conversation'], input: {} },
  { name: 'the conversation\'s own model wins over every route', settings: { routes: CHAT, companionModel: { providerId: 'loc2', model: 'comp' } }, conv: { providerId: 'loc', model: 'llama3:8b' }, job: 'turn', turn: ['loc/llama3:8b@conversation'], input: {} },
  { name: 'the Talking route', settings: { routes: CHAT }, job: 'turn', turn: ['cloud/big-1@chat'], input: {} },
  { name: 'a coding conversation uses the Coding route', settings: { routes: { ...CHAT, coding: { providerId: 'loc2', model: 'coder' } } }, conv: { mode: 'coding' }, job: 'turn', turn: ['loc2/coder@coding'], input: {} },
  { name: 'a coding conversation without a Coding route: Talking', settings: { routes: CHAT }, conv: { mode: 'coding' }, job: 'turn', turn: ['cloud/big-1@chat'], input: {} },
  { name: 'background in a coding conversation without a Background route: Coding', settings: { routes: { ...CHAT, coding: { providerId: 'loc2', model: 'coder' } } }, conv: { mode: 'coding' }, job: 'background', turn: ['loc2/coder@coding'] },
  { name: 'her own model stands in for Talking, with Talking\'s fallbacks', settings: { routes: { chat: { providerId: 'cloud', model: 'big-1', fallbacks: [{ providerId: 'loc', model: 'llama3:8b' }] } }, companionModel: { providerId: 'loc2', model: 'comp' } }, job: 'turn', turn: ['loc2/comp@companion', 'loc/llama3:8b@companion'], input: {} },
  { name: 'her own model for pictures when no Pictures route', settings: { companionModel: { providerId: 'loc2', model: 'comp' } }, job: 'vision', turn: ['loc2/comp@companion'], input: { photos: true }, authJob: 'turn' },
  { name: 'a Pictures route wins over her own model', settings: { routes: { vision: { providerId: 'loc2', model: 'eyes' } }, companionModel: { providerId: 'loc', model: 'comp' } }, job: 'vision', turn: ['loc2/eyes@vision'], input: { photos: true } },
  { name: 'her own model is not used for coding', settings: { routes: CHAT, companionModel: { providerId: 'loc2', model: 'comp' } }, conv: { mode: 'coding' }, job: 'turn', turn: ['cloud/big-1@chat'], input: {} },
  { name: 'Auto with her own model set: her model, not Auto', settings: { autoJobs: ['chat'], companionModel: { providerId: 'loc2', model: 'comp' } }, job: 'turn', turn: ['loc2/comp@companion'], input: {} },
  { name: 'a private conversation without a Private route: the default (local)', conv: { private: true }, job: 'turn', turn: ['loc/llama3:8b@default'], input: {} },
  { name: 'a private conversation with a Private route', settings: { routes: { ...CHAT, private: { providerId: 'loc2', model: 'priv' } } }, conv: { private: true }, job: 'turn', turn: ['loc2/priv@private'], input: {} },
  { name: 'a private route\'s cloud fallback is skipped, a local one kept', settings: { routes: { private: { providerId: 'loc2', model: 'priv', fallbacks: [{ providerId: 'cloud', model: 'big-1' }, { providerId: 'loc', model: 'llama3:8b' }] } } }, conv: { private: true }, job: 'turn', turn: ['loc2/priv@private', 'loc/llama3:8b@private'], input: {} },
  { name: 'a private conversation whose default is a cloud provider: refused', settings: { defaultProviderId: 'cloud', defaultModel: 'big-1' }, conv: { private: true }, job: 'turn', turn: /private, so it only uses models on your own hardware/, input: {} },
  { name: 'a private conversation on an Ollama cloud model: refused', settings: { routes: { private: { providerId: 'loc', model: 'gpt-oss:120b-cloud' } } }, conv: { private: true }, job: 'turn', turn: /Ollama cloud model/, input: {} },
  { name: 'a private conversation with its own local model', conv: { private: true, providerId: 'loc2', model: 'qwen3:4b' }, job: 'turn', turn: ['loc2/qwen3:4b@conversation'], input: {} },
  { name: 'a Private route wins over Auto', settings: { autoJobs: ['chat'], routes: { private: { providerId: 'loc2', model: 'priv' } } }, conv: { private: true }, job: 'turn', turn: ['loc2/priv@private'], input: {} },
  { name: 'adult on, Adult route set, an adult turn', settings: { ...ADULT_ON, routes: { ...CHAT, adult: { providerId: 'loc2', model: 'spicy' } } }, job: 'turn', adult: true, turn: ['loc2/spicy@adult'], input: { explicit: true } },
  { name: 'adult on, no Adult route: Talking', settings: { ...ADULT_ON, routes: CHAT }, job: 'turn', adult: true, turn: ['cloud/big-1@chat'], input: { explicit: true } },
  { name: 'adult off: Talking even for an explicit message', settings: { routes: { ...CHAT, adult: { providerId: 'loc2', model: 'spicy' } } }, job: 'turn', adult: false, turn: ['cloud/big-1@chat'], input: { explicit: true } },
  { name: 'adult on in a private conversation: Private', settings: { ...ADULT_ON, routes: { adult: { providerId: 'loc2', model: 'spicy' }, private: { providerId: 'loc', model: 'priv' } } }, conv: { private: true }, job: 'turn', adult: true, turn: ['loc/priv@private'], input: { explicit: true } },
  { name: 'private local mode: the cloud model of the chain is paused, the local fallback answers', privateLocal: true, settings: { routes: { chat: { providerId: 'cloud', model: 'big-1', fallbacks: [{ providerId: 'loc', model: 'llama3:8b' }] } } }, job: 'turn', turn: ['loc/llama3:8b@chat'], input: {} },
  { name: 'private local mode: nothing local in the chain, the Private route answers', privateLocal: true, settings: { routes: { ...CHAT, private: { providerId: 'loc2', model: 'priv' } } }, job: 'turn', turn: ['loc2/priv@private'], input: {} },
  { name: 'private local mode: nothing local at all: refused', privateLocal: true, settings: { routes: CHAT }, job: 'turn', turn: /paused in private local mode/, input: {} },
  { name: 'private local mode: a Private route on another computer is no help', privateLocal: true, settings: { routes: { ...CHAT, private: { providerId: 'lan', model: 'gemma4:12b' } } }, job: 'turn', turn: /paused in private local mode/, input: {} },
  { name: 'private local mode: a model on a LAN computer is not on this computer', privateLocal: true, settings: { routes: { chat: { providerId: 'lan', model: 'gemma4:12b', fallbacks: [{ providerId: 'loc', model: 'llama3:8b' }] } } }, job: 'turn', turn: ['loc/llama3:8b@chat'], input: {} },
  { name: 'a group channel routes like a chat', settings: { routes: CHAT }, conv: { channel: 'group' }, job: 'turn', turn: ['cloud/big-1@chat'], input: {} },
  { name: 'fallbacks: a missing key and a missing provider are skipped (only the first two are looked at)', settings: { routes: { chat: { providerId: 'cloud', model: 'big-1', fallbacks: [{ providerId: 'nokey', model: 'nk-1' }, { providerId: 'gone', model: 'x' }, { providerId: 'loc', model: 'llama3:8b' }] } } }, job: 'turn', turn: ['cloud/big-1@chat'], input: {} },
  { name: 'fallbacks: the same model twice is kept once', settings: { routes: { chat: { providerId: 'cloud', model: 'big-1', fallbacks: [{ providerId: 'cloud', model: 'big-1' }, { providerId: 'loc', model: 'llama3:8b' }] } } }, job: 'turn', turn: ['cloud/big-1@chat', 'loc/llama3:8b@chat'], input: {} },
  { name: 'default fallbacks when no route is set', settings: { defaultFallbacks: [{ providerId: 'cloud', model: 'big-1' }, { providerId: 'loc2', model: 'qwen3:4b' }, { providerId: 'loc', model: 'other' }] }, job: 'turn', turn: ['loc/llama3:8b@default', 'cloud/big-1@default', 'loc2/qwen3:4b@default'], input: {} },
  { name: 'the first model has no key: refused', settings: { routes: { chat: { providerId: 'nokey', model: 'nk-1', fallbacks: [{ providerId: 'loc', model: 'llama3:8b' }] } } }, job: 'turn', turn: /needs an API key/, input: {} },
  { name: 'the first model\'s provider is gone: refused', settings: { defaultProviderId: 'gone' }, job: 'turn', turn: /"gone" is not configured/, input: {} },
  { name: 'a blind Pictures model is skipped for its seeing fallback', settings: { routes: { ...CHAT, vision: { providerId: 'sub', model: 'grok-4.7', fallbacks: [{ providerId: 'loc2', model: 'eyes' }] } } }, job: 'vision', turn: ['loc2/eyes@vision'], input: { photos: true } },
  { name: 'a blind Pictures model with no seeing fallback: the talking model takes the picture', settings: { routes: { ...CHAT, vision: { providerId: 'sub', model: 'grok-4.7' } } }, job: 'vision', turn: ['cloud/big-1@chat'], input: { photos: true } },
  { name: 'the screen job falls back to Pictures', settings: { routes: { ...CHAT, vision: { providerId: 'loc2', model: 'eyes' } } }, job: 'screen', turn: ['loc2/eyes@vision'] },
  { name: 'a quick turn uses the Quick route', settings: { routes: { ...CHAT, quick: { providerId: 'loc2', model: 'small' } } }, job: 'quick', turn: ['loc2/small@quick'], input: { quick: true } },
  { name: 'a research ask uses the Research route', settings: { routes: { ...CHAT, research: { providerId: 'loc2', model: 'digger' } } }, job: 'research', turn: ['loc2/digger@research'], input: { research: true } },
  { name: 'a research ask in a coding conversation stays on Coding', settings: { routes: { ...CHAT, research: { providerId: 'loc2', model: 'digger' } } }, conv: { mode: 'coding' }, job: 'turn', turn: ['cloud/big-1@chat'], input: { research: true } },
];

// Each job with its own route set, and unset (then it takes the job it inherits from, in the end Talking or the default).
const INHERITS: [Job, string][] = [
  ['background', 'cloud/big-1@chat'], ['planning', 'cloud/big-1@chat'], ['quick', 'cloud/big-1@chat'], ['writing', 'cloud/big-1@chat'],
  ['research', 'cloud/big-1@chat'], ['vision', 'cloud/big-1@chat'], ['coding', 'cloud/big-1@chat'], ['review', 'cloud/big-1@chat'],
  ['screen', 'cloud/big-1@chat'], ['adult', 'cloud/big-1@chat'], ['private', 'loc/llama3:8b@default'],
];
for (const [job, unset] of INHERITS) {
  ROWS.push({ name: `job ${job}: route unset`, settings: { routes: CHAT }, job, turn: [unset] });
  ROWS.push({ name: `job ${job}: route set`, settings: { routes: { ...CHAT, [job]: { providerId: 'loc2', model: `m-${job}` } } }, job, turn: [`loc2/m-${job}@${job}`] });
}
ROWS.push({ name: 'job planning inherits Background before Talking', settings: { routes: { ...CHAT, background: { providerId: 'loc2', model: 'bg' } } }, job: 'planning', turn: ['loc2/bg@background'] });
ROWS.push({ name: 'job review inherits Coding before Talking', settings: { routes: { ...CHAT, coding: { providerId: 'loc2', model: 'coder' } } }, job: 'review', turn: ['loc2/coder@coding'] });

for (const row of ROWS) {
  test(`route parity: ${row.name}`, (t) => {
    const app = fresh(t, row.settings);
    const conv = app.store.createConversation(row.conv);
    setPrivateLocal(Boolean(row.privateLocal));
    try {
      const turn = turnOf(app, conv, row.job, row.adult);
      if (row.turn instanceof RegExp) {
        assert.equal(turn.length, 1);
        assert.match(turn[0], /^throws: /);
        assert.match(turn[0], row.turn);
      } else assert.deepEqual(turn, row.turn);
      if (row.input) {
        const auth = authOf(app, conv, row.input);
        assert.equal(auth.job, row.authJob ?? (row.adult ? 'turn' : row.job));
        // The witness names the models the turn runs (none when the turn is refused).
        const turnForAuth = row.authJob && row.authJob !== row.job ? turnOf(app, conv, row.authJob as Job, row.adult) : turn;
        assert.deepEqual(auth.ids, idsOf(turnForAuth));
        assert.equal(auth.auto, undefined);
      }
    } finally {
      setPrivateLocal(false);
    }
  });
}

test('turnJob: the job of a chat turn (photos, research, quick, adult)', (t) => {
  const app = fresh(t);
  const s = (patch: Partial<Settings>) => ({ ...app.settings.get(), ...patch });
  const none = { photos: false, adult: false, research: false, quick: false };
  const chat = { mode: 'chat' as const, private: false };
  const vision = { routes: { vision: { providerId: 'loc2', model: 'eyes' } } };
  assert.equal(turnJob(s({}), chat, none).job, 'turn');
  assert.equal(turnJob(s({}), chat, { ...none, photos: true }).job, 'turn');
  assert.equal(turnJob(s(vision), chat, { ...none, photos: true }).job, 'vision');
  assert.equal(turnJob(s({ autoJobs: ['vision'] }), chat, { ...none, photos: true }).job, 'vision');
  assert.equal(turnJob(s({}), chat, { ...none, research: true }).job, 'turn');
  assert.equal(turnJob(s({ autoJobs: ['research'] }), chat, { ...none, research: true }).job, 'research');
  assert.equal(turnJob(s({ routes: { research: { providerId: 'loc2', model: 'r' } } }), { mode: 'coding', private: false }, { ...none, research: true }).job, 'turn');
  assert.equal(turnJob(s({}), chat, { ...none, quick: true }).job, 'quick');
  // An adult turn with an Adult route stays a turn, even with a photo.
  assert.equal(turnJob(s({ routes: { ...vision.routes, adult: { providerId: 'loc2', model: 'spicy' } } }), chat, { ...none, adult: true, photos: true }).job, 'turn');
  // A private conversation: a Pictures route marked local (even on another computer of the LAN) takes the photo; a cloud one does not.
  const lan = turnJob(s({ routes: { vision: { providerId: 'lan', model: 'gemma4:12b' } } }), { mode: 'chat', private: true }, { ...none, photos: true });
  assert.deepEqual([lan.job, lan.privateVisionOff], ['vision', false]);
  const cloud = turnJob(s({ routes: { vision: { providerId: 'cloud', model: 'big-1' } } }), { mode: 'chat', private: true }, { ...none, photos: true });
  assert.deepEqual([cloud.job, cloud.privateVisionOff], ['turn', true]);
});

// FINDINGS (docs/BACKLOG.md, T51): where the witness and the turn disagreed before T51. Before, the
// witness named the route chain with Auto on, named a private chat's own cloud model, and said job
// "turn" in rows 3 to 5. It now follows the turn; Auto itself is recorded, not asked.
test('FINDING 1: Auto on: the turn runs Auto\'s picks; the witness records that Auto decides (and the chain under it)', (t) => {
  const app = fresh(t, { autoJobs: ['chat'] });
  const conv = app.store.createConversation();
  const turn = resolveChain(app, conv, 'turn');
  assert.ok(turn.length >= 1 && turn.every((c) => c.from === 'auto'));
  const auth = authOf(app, conv);
  assert.equal(auth.auto, 'chat');
  assert.deepEqual(auth.ids, ['loc/llama3:8b']);
  // Turning Auto off changes the witness (a waiting reply sees the change).
  app.settings.update({ autoJobs: [] });
  assert.equal(authOf(app, conv).auto, undefined);
});

test('FINDING 1b: Auto in a private conversation without a Private route: Auto among local models; the witness records Auto', (t) => {
  const app = fresh(t, { autoJobs: ['chat'], defaultProviderId: 'loc2', defaultModel: 'qwen3:4b' });
  const conv = app.store.createConversation({ private: true });
  const turn = resolveChain(app, conv, 'turn');
  assert.ok(turn.every((c) => c.from === 'auto' && c.provider.config.local));
  assert.equal(authOf(app, conv).auto, 'chat');
});

test('FINDING 2: a private conversation with its own cloud model: the turn refuses, the witness is empty', (t) => {
  const app = fresh(t);
  const conv = app.store.createConversation({ private: true, providerId: 'cloud', model: 'big-2' });
  assert.match(turnOf(app, conv, 'turn')[0], /^throws: This conversation is private/);
  assert.deepEqual(authOf(app, conv).ids, []);
});

test('FINDING 3: a photo with Auto for pictures and no Pictures route: both pick the picture job', (t) => {
  const app = fresh(t, { autoJobs: ['vision'] });
  const auth = authOf(app, app.store.createConversation(), { photos: true });
  assert.deepEqual([auth.job, auth.auto], ['vision', 'vision']);
});

test('FINDING 4: a research ask with Auto for research and no Research route: both pick research', (t) => {
  const app = fresh(t, { autoJobs: ['research'] });
  assert.equal(authOf(app, app.store.createConversation(), { research: true }).job, 'research');
});

test('FINDING 5: a private conversation, a photo, a Pictures route on a LAN computer marked local: both pick the picture job', (t) => {
  const app = fresh(t, { routes: { vision: { providerId: 'lan', model: 'gemma4:12b' } } });
  const conv = app.store.createConversation({ private: true });
  const auth = authOf(app, conv, { photos: true });
  assert.equal(auth.job, 'vision');
  assert.deepEqual(auth.ids, idsOf(turnOf(app, conv, 'vision')));
});
