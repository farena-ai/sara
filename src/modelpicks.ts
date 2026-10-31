// Phase 38: "Which model does what", made simple. What each job is, recommended picks from what's
// connected (by model name, nothing sent anywhere), a quick Test of one model on one job (time to
// first word, speed, a sample), and a side-by-side test where the owner picks the winner blind.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AppContext, resolveProvider } from './chat.ts';
import { cosine, embedTexts } from './embeddings.ts';
import type { ChatMessage, ProviderConfig } from './providers/types.ts';
import type { RoutePurpose } from './settings.ts';
import { isCloudModelName } from './model-names.ts';

export interface JobInfo {
  id: RoutePurpose;
  label: string;
  tip: string;
  /** Shown folded under "More jobs" (the owner rarely needs them). */
  advanced?: boolean;
}

export const JOBS: JobInfo[] = [
  { id: 'chat', label: 'Talking', tip: 'Everyday conversation with her. This is the most important one: pick the model whose replies you like best.' },
  { id: 'coding', label: 'Coding', tip: 'Coding-mode conversations: reading and writing files, running commands. A model that is good with code and tools.' },
  { id: 'vision', label: 'Looking at pictures', tip: 'When you send a photo or a screenshot, this model looks at it. The next message goes back to the talking model. It must be a model that can see (gemma4, a "vl" or "vision" model, GPT, Claude, Grok).' },
  { id: 'planning', label: 'Planning', tip: 'Morning briefing, weekly review, and the plans for her team of helpers. A careful, strong model.' },
  { id: 'writing', label: 'Writing', tip: 'Her diary days, filling in her life story and character writing. A model with a nice way with words.' },
  { id: 'research', label: 'Web research', tip: 'When you ask her to research or look something up. A model that is good with tools and sources.' },
  { id: 'review', label: 'Reviewing', tip: 'The second look at her code changes for security problems (after coding turns). A strong model is best; when this is empty, the Coding model does it.' },
  { id: 'quick', label: 'Quick replies', tip: 'Short messages she sends by herself and short notes about finished jobs. A small, fast model is fine.' },
  { id: 'background', label: 'Memory and summaries', tip: 'Noting what matters from your conversations, summaries and other behind-the-scenes work. A fast, cheap model is fine.' },
  { id: 'embeddings', label: 'Meaning search', tip: 'Lets her memory find things said in other words ("the cabin" finds "our Pine Lake trip"). Needs an embedding model, e.g. on Ollama: ollama pull nomic-embed-text. Off: she searches by words.', advanced: true },
  { id: 'private', label: 'Private conversations', tip: 'Private conversations only use models on your own hardware. Pick a local model (not an Ollama cloud model).', advanced: true },
  { id: 'adult', label: 'Adult', tip: 'Used when a conversation turns explicit (only with Adult mode on). Cloud models often refuse; pick one that allows it.', advanced: true },
  { id: 'screen', label: 'Seeing your screen', tip: 'Reads the pictures when Sara looks at your computer screen. Empty: the Looking at pictures model does. A local model keeps screenshots on your own hardware.', advanced: true },
];


/** The one Ollama Cloud name rule (model-names.ts), under the name server.ts imports. */
export const isCloudModel = isCloudModelName;

const EMBED = /embed|bge-|\be5-|gte-|minilm|arctic-embed/i;
const NOT_CHAT = /embed|bge-|\be5-|gte-|minilm|caption|whisper|tts|rerank|guard|image|imagine/i;
const SEES = /gemma-?[34]|gemma4|[-:]vl\b|-vl-|vision|llava|minicpm-v|pixtral|gpt-4o|gpt-4\.1|gpt-5|claude|sonnet|opus|haiku|grok-4|gemini|qwen[23](\.\d)?-?vl|kimi-k2\.[5-9]|kimi-k3|mistral-(small|medium)-3/i;
const CODE = /coder|codestral|devstral|-code\b|code:|kimi-k2|kimi-k3|qwen3.*coder|deepseek|glm-5|gpt-5|claude|sonnet|opus|grok-4|grok-code/i;
const STRONG = /gpt-5|claude|opus|sonnet|kimi-k3|glm-5\.\d(?!-flash)|deepseek-v4-pro|grok-4(?!.*fast)|mistral-large|nemotron-3-ultra|qwen3\.\d+-max/i;
const FAST = /flash|mini\b|-mini|nano|haiku|small|lite|fast|:(\d|1[0-4])b\b|-(\d|1[0-4])b\b|gpt-oss:20b/i;

export interface Candidate {
  providerId: string;
  provider: string;
  model: string;
  local: boolean;
}

/** Every model the connected providers offer (5 seconds each; a provider that doesn't answer is skipped). */
export async function connectedModels(app: AppContext): Promise<Candidate[]> {
  const s = app.settings.get();
  const out: Candidate[] = [];
  await Promise.all(
    s.providers.map(async (p) => {
      let models: string[] = [];
      try {
        // Phase 56: the kept list (with Ollama Cloud models not pulled yet) when there is one.
        if (app.modelCatalog?.known(p.id)) models = app.modelCatalog.view(p.id).models;
        else {
          const { provider } = resolveProvider(app, p.id, p.defaultModel ?? 'x');
          models = await provider.listModels(AbortSignal.timeout(5000));
        }
      } catch {
        models = [];
      }
      if (p.defaultModel && !models.includes(p.defaultModel)) models.unshift(p.defaultModel);
      for (const m of models) out.push({ providerId: p.id, provider: p.label, model: m, local: Boolean(p.local) && !isCloudModelName(m) });
    }),
  );
  return out;
}

export interface Pick {
  providerId: string;
  model: string;
  why: string;
}

/**
 * Recommended model per job from what's connected. Talking, writing and adult stay on the
 * owner's own choice (no recommendation): they're about taste. Returns only jobs with a pick.
 */
export function recommend(cands: Candidate[], current: { providerId?: string; model?: string }): Partial<Record<RoutePurpose, Pick>> {
  const chat = cands.filter((c) => !NOT_CHAT.test(c.model));
  const cur = chat.find((c) => c.providerId === current.providerId && c.model === current.model);
  const first = (list: Candidate[], prefer?: (c: Candidate) => boolean) => (prefer ? (list.find(prefer) ?? list[0]) : list[0]);
  const pick = (c: Candidate | undefined, why: string): Pick | undefined => (c ? { providerId: c.providerId, model: c.model, why } : undefined);
  const out: Partial<Record<RoutePurpose, Pick | undefined>> = {};
  // Looking at pictures: the talking model if it can see (one model), else one that can.
  // Phase 92: Seeing your screen: a local model that can see, when there is one (screenshots stay home).
  out.screen = pick(chat.filter((c) => SEES.test(c.model) && c.local)[0], 'Can see pictures, on your own hardware.');
  out.vision = cur && SEES.test(cur.model) ? pick(cur, 'Your talking model can see pictures too.') : pick(first(chat.filter((c) => SEES.test(c.model)), (c) => c.local), 'Can see pictures.');
  const coder = first(chat.filter((c) => CODE.test(c.model)), (c) => /coder|code/i.test(c.model));
  out.coding = pick(coder, 'Good with code and tools.');
  out.review = pick(first(chat.filter((c) => STRONG.test(c.model) || CODE.test(c.model))), 'A strong model for the security review.');
  const strong = first(chat.filter((c) => STRONG.test(c.model)));
  out.planning = pick(strong ?? cur, strong ? 'A strong, careful model.' : 'Your talking model.');
  out.research = pick(strong ?? cur, strong ? 'Good with tools and sources.' : 'Your talking model.');
  const fast = first(chat.filter((c) => FAST.test(c.model)), (c) => /flash/i.test(c.model));
  out.quick = pick(fast, 'Small and fast.');
  out.background = pick(fast, 'Fast and cheap for behind-the-scenes work.');
  out.embeddings = pick(first(cands.filter((c) => EMBED.test(c.model)), (c) => c.local), 'An embedding model for meaning search.');
  const priv = chat.filter((c) => c.local);
  out.private = pick(first(priv, (c) => !FAST.test(c.model)), 'Runs on your own hardware.');
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Partial<Record<RoutePurpose, Pick>>;
}

/** Plain cost hint for a provider + model. */
export function costHint(config: ProviderConfig, model: string): string {
  if (isCloudModelName(model)) return 'Ollama cloud: part of your Ollama plan';
  if (config.local) return 'Free: runs on your own hardware';
  if (config.kind === 'chatgpt' || config.kind === 'claude-code' || config.kind === 'grok-cli') return 'Uses your subscription';
  return 'Paid per use (your API key)';
}

const PROMPTS: Record<RoutePurpose, { quick: string; compare: string }> = {
  chat: { quick: 'Say hi to Alex in one short, warm sentence.', compare: "I had a rough day at work, my boss took credit for my idea in front of everyone. Reply as a close friend would, in 2 to 4 sentences." },
  coding: { quick: 'Write a JavaScript function isLeapYear(y). Code only.', compare: 'Write a small TypeScript function that groups an array of {date: string, amount: number} by month (YYYY-MM) and returns the totals, with a one-line explanation.' },
  screen: { quick: 'In one sentence: what is in this picture?', compare: 'Describe this picture in 2 to 3 sentences: what is in it, any text you can read, and anything that looks wrong.' },
  vision: { quick: 'In one sentence: what is in this picture?', compare: 'Describe this picture in 2 to 3 sentences: who or what is in it, the setting, and the mood.' },
  planning: { quick: 'Plan a Saturday with 3 errands and dinner at 7, in 4 short bullet points.', compare: "Alex has: dentist Tue 9am, a report due Thu, his sister visiting Fri to Sun, and wants 3 runs this week. Make a short, realistic plan for the week, Monday to Sunday." },
  writing: { quick: 'Write two sentences that open a cozy autumn short story.', compare: 'Write a short diary entry (5 to 7 sentences) for a florist in Chicago on a rainy Tuesday: one small thing went wrong and one small thing went right.' },
  research: { quick: 'In two sentences: what is the difference between a Roth IRA and a traditional IRA?', compare: 'Explain, in 4 to 6 sentences, what to check before buying a used electric car, most important first.' },
  quick: { quick: 'Reply with one word: what color is the sky on a clear day?', compare: "Write a one-line text to Alex asking how his job interview went yesterday. Casual, warm, no emojis." },
  background: { quick: 'Summarize in one sentence: "We talked about his trip to Pine Lake, the cabin, and fishing with Jenna."', compare: 'From this message, list the facts worth remembering as short bullet points: "My sister Lena lands Friday at 6, I need to clean the guest room, and remind me we have the Pine Lake cabin booked for the 14th."' },
  private: { quick: 'Say hi in one short sentence.', compare: "I had a rough day at work, my boss took credit for my idea in front of everyone. Reply as a close friend would, in 2 to 4 sentences." },
  adult: { quick: 'Say hi in one short, flirty sentence.', compare: 'Write a short, flirty good-night text (2 sentences).' },
  embeddings: { quick: '', compare: '' },
  review: { quick: 'In one sentence: what is wrong with building SQL as "SELECT * FROM users WHERE name = \'" + name + "\'"?', compare: 'Review this Node.js line for security problems and say how to fix it, in 3 short bullet points: app.get(\'/file\', (req, res) => res.sendFile(path.join(__dirname, req.query.name)));' },
};

export interface TestResult {
  ok: boolean;
  /** Milliseconds to the first word (or the whole call, for embeddings). */
  firstMs?: number;
  totalMs?: number;
  /** Words per second, roughly. */
  wps?: number;
  sample?: string;
  speed?: 'fast' | 'ok' | 'slow';
  cost: string;
  error?: string;
}

const speedOf = (firstMs: number): TestResult['speed'] => (firstMs < 2000 ? 'fast' : firstMs < 8000 ? 'ok' : 'slow');

function picture(): { mime: string; data: string } {
  return { mime: 'image/jpeg', data: readFileSync(join(import.meta.dirname, '..', 'web', 'sara', 'portrait-happy.jpg')).toString('base64') };
}

/** One model, one job: does it work, how fast, what does it say. */
export async function testModel(app: AppContext, job: RoutePurpose, providerId: string, model: string, mode: 'quick' | 'compare' = 'quick'): Promise<TestResult> {
  const config = app.settings.get().providers.find((p) => p.id === providerId);
  if (!config) return { ok: false, cost: '', error: 'Unknown provider' };
  const cost = costHint(config, model);
  const t0 = Date.now();
  try {
    if (job === 'embeddings') {
      const [a, b, c] = await embedTexts({ config, key: app.vault.get(`provider:${config.id}`) ?? undefined, model }, ['search_query: the lake cabin we booked', 'search_document: Our Pine Lake trip is on the 14th', 'search_document: My tax forms are due in April'], AbortSignal.timeout(30_000));
      const ms = Date.now() - t0;
      const near = cosine(a, b);
      const far = cosine(a, c);
      const ok = near > far;
      return { ok, firstMs: ms, totalMs: ms, speed: speedOf(ms), cost, sample: ok ? `Works: "the lake cabin" is closer to "our Pine Lake trip" (${near.toFixed(2)}) than to "tax forms" (${far.toFixed(2)}). ${a.length} numbers per note.` : `It answered, but the meanings didn't line up (${near.toFixed(2)} vs ${far.toFixed(2)}). Is it an embedding model?`, ...(ok ? {} : { error: 'Not an embedding model?' }) };
    }
    const { provider } = resolveProvider(app, providerId, model);
    const p = PROMPTS[job];
    const messages: ChatMessage[] = [{ role: 'user', content: mode === 'quick' ? p.quick : p.compare, ...(job === 'vision' || job === 'screen' ? { images: [picture()] } : {}) }];
    let out = '';
    let firstMs: number | undefined;
    for await (const ev of provider.stream({ model, messages, temperature: 0.7, maxTokens: mode === 'quick' ? 800 : 2500, reasoning: 'none', signal: AbortSignal.timeout(120_000) })) {
      if (ev.type !== 'text') continue;
      if (firstMs === undefined && ev.text.trim()) firstMs = Date.now() - t0;
      out += ev.text;
    }
    const totalMs = Date.now() - t0;
    if (!out.trim()) return { ok: false, totalMs, cost, error: 'It returned an empty reply (a model that thinks first may have run out of room; try again).' };
    const streamMs = Math.max(1, totalMs - (firstMs ?? totalMs));
    const words = out.trim().split(/\s+/).length;
    return { ok: true, firstMs: firstMs ?? totalMs, totalMs, wps: words > 3 && streamMs > 200 ? Math.round((words / streamMs) * 1000) : undefined, speed: speedOf(firstMs ?? totalMs), cost, sample: out.trim().slice(0, mode === 'quick' ? 300 : 1500) };
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, totalMs: Date.now() - t0, cost, error: job === 'vision' && /image|vision|multimodal|modalit/i.test(msg) ? "This model can't see pictures." : msg.slice(0, 300) };
  }
}

/** The side-by-side test: the same job for up to three models at once. */
export async function compareModels(app: AppContext, job: RoutePurpose, candidates: { providerId: string; model: string }[]): Promise<(TestResult & { providerId: string; model: string })[]> {
  return Promise.all(candidates.slice(0, 3).map(async (c) => ({ ...c, ...(await testModel(app, job, c.providerId, c.model, 'compare')) })));
}

/** The prompt the side-by-side test uses (shown to the owner above the answers). */
export const comparePrompt = (job: RoutePurpose): string => (job === 'vision' ? `${PROMPTS.vision.compare} (her happy portrait)` : PROMPTS[job].compare);
