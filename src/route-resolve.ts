/**
 * T51 (C2): the one place that decides which models answer a job, and why (`from`, and `why` for
 * Auto). Two callers, both thin, in src/chat.ts:
 *
 * - `resolveChain` / `resolveFor`: what a turn or a job really runs. Its `pick` makes the provider
 *   (`resolveProvider`: policy, a member's limits, the key, the meter) and throws when it can't.
 * - `modelAuthorityOf`: the witness a reply that waited (session continuity) is checked against.
 *   Its `pick` reads only settings and the vault (no provider is made, no model list, no call), and
 *   Auto is not asked (its picks read the model list and stats, which move on their own); the
 *   witness records that Auto decides instead (`routePlan(...).auto`). A refused turn is an empty
 *   witness.
 *
 * The rules, in order:
 * 1. The conversation's own model, alone. A private conversation refuses it unless it is local
 *    and not an Ollama cloud model.
 * 2. Else the job's purpose: a turn is Adult (adult on and an Adult route), Coding (a coding
 *    conversation) or Talking; Background in a coding conversation without a Background route is
 *    Coding; a private conversation is always Private.
 * 3. Her own model stands in for Talking, and for Pictures and Research when those have no route.
 * 4. Auto, when it is on for the job and her own model is not set: its picks, in order (a private
 *    conversation without a Private route: Auto for Talking or Coding among local models). No
 *    usable pick: on to 5.
 * 5. Her own model (with Talking's fallbacks), else the job's route, else the route of the job it
 *    inherits from (INHERIT; Private inherits nothing), else the default model.
 * 6. The first two fallbacks of that route (or the default fallbacks), skipping a missing provider,
 *    a missing key, a repeat, and in a private conversation anything not local.
 * 7. A picture job (Pictures, Screen) keeps only models that see; none: the talking chain's models
 *    that see; none either: the chain as it was.
 * 8. Private local mode ("Nothing leaves this computer"): only models on this computer; none: the
 *    Private route if it is on this computer; else refused.
 *
 * Which job a chat turn is (photos, research, quick) is `turnJob`, used by the turn and the witness.
 */
import { autoOn, isAutoJob, type AutoJob } from './auto-route.ts';
import { isCloudModelName } from './model-names.ts';
import { privateLocalOn } from './net-guard.ts';
import { modelSees } from './picture-reader.ts';
import { onThisComputer } from './private-local.ts';
import { seesPictures, type ProviderConfig } from './providers/types.ts';
import type { ModelRoute, RoutePurpose, Settings } from './settings.ts';
import type { Conversation } from './store.ts';

/** Phase 38: a job a model can be asked to do ('turn' and 'background' are the older names). */
export type Job = RoutePurpose | 'turn';
/** Where a chosen model came from: the job whose route it is, or one of these. */
export type RouteFrom = RoutePurpose | 'default' | 'conversation' | 'companion' | 'auto';
/** Where a job without its own model goes (in the end: the default model). */
// Phase 81: Reviewing (the security pass's second look) falls back to the Coding model (§7 #5).
// Phase 92: "Seeing your screen" (pictures of the owner's desktop) falls back to Looking at pictures, then the talking model.
export const INHERIT: Partial<Record<RoutePurpose, RoutePurpose>> = { background: 'chat', planning: 'background', quick: 'background', writing: 'background', research: 'chat', vision: 'chat', adult: 'chat', coding: 'chat', review: 'coding', screen: 'vision' };

type RouteConv = Pick<Conversation, 'providerId' | 'model' | 'mode' | 'private'>;
export type Routed<T> = T & { from: RouteFrom; why?: string };

export interface RouteDeps<T extends { model: string }> {
  /** Makes one model usable; throws when it can't be used. `plain`: the meter's job name as given (no group tag). */
  pick(providerId: string | null, model: string | null, purpose: string, plain?: boolean): T;
  /** The talking chain a picture job falls back to (default: `pick`). */
  pickTalking?(providerId: string | null, model: string | null, purpose: string): T;
  configOf(choice: T): ProviderConfig;
  /** Auto's picks for a job; absent: Auto is not asked. */
  auto?(job: AutoJob, privateChat: boolean): { providerId: string; model: string; why?: string }[];
  /** What modelSees reads (the model list's picture support). */
  seeCtx: Parameters<typeof modelSees>[0];
}

export interface RoutePlan {
  /** The job name the meter records for these models. */
  purpose: RoutePurpose;
  /** Auto is asked first, for this job. */
  auto?: AutoJob;
  /** The route that answers (her own model with Talking's fallbacks, or a job's route); none: the default model. */
  primary?: ModelRoute;
  from: RouteFrom;
}

/** Rules 2 to 5 from settings alone (no provider is made). Not for a conversation with its own model. */
export function routePlan(s: Settings, conv: Pick<Conversation, 'mode' | 'private'>, job: Job, adult: boolean): RoutePlan {
  const routes = s.routes ?? {};
  const has = (r?: { providerId: string }) => Boolean(r && s.providers.some((p) => p.id === r.providerId));
  let purpose: RoutePurpose = job === 'turn' ? (adult && has(routes.adult) ? 'adult' : conv.mode === 'coding' ? 'coding' : 'chat') : job;
  if (purpose === 'background' && !has(routes.background) && conv.mode === 'coding' && has(routes.coding)) purpose = 'coding';
  if (conv.private) purpose = 'private';
  // The companion's own model stands in for the talking jobs (not coding, private or adult).
  const companion = purpose === 'chat' || purpose === 'vision' && !has(routes.vision) || purpose === 'research' && !has(routes.research) ? s.companionModel : undefined;
  // N1: Auto picks the job's models from what is connected (src/auto-route.ts); a private chat
  // without its own Private model picks only among models on this computer.
  const autoJob = purpose === 'private' ? (has(routes.private) ? undefined : conv.mode === 'coding' ? 'coding' : 'chat') : purpose;
  const auto = autoJob && !(companion && has(companion)) && autoOn(s, autoJob) && isAutoJob(autoJob) ? autoJob : undefined;
  if (companion && has(companion)) return { purpose, primary: { ...companion, fallbacks: routes.chat?.fallbacks }, from: 'companion' };
  for (let p: RoutePurpose | undefined = purpose; p; p = INHERIT[p]) {
    if (has(routes[p])) return { purpose, ...(auto ? { auto } : {}), primary: routes[p], from: p };
    if (p === 'private') break;
  }
  return { purpose, ...(auto ? { auto } : {}), from: 'default' };
}

const notLocal = (label: string) => `This conversation is private, so it only uses models on your own hardware. ${label} isn't marked local: pick a local model for this conversation, or set a Private route in Settings.`;

/** Rules 1 to 6. */
function chainAll<T extends { model: string }>(s: Settings, conv: RouteConv, job: Job, adult: boolean, d: RouteDeps<T>, pick = d.pick): Routed<T>[] {
  if (conv.providerId) {
    const r = pick(conv.providerId, conv.model, job === 'turn' ? (conv.mode === 'coding' ? 'coding' : 'chat') : job);
    if (conv.private && (!d.configOf(r).local || isCloudModelName(r.model))) throw new Error(notLocal(d.configOf(r).label));
    return [{ ...r, from: 'conversation' }];
  }
  const plan = routePlan(s, conv, job, adult);
  if (plan.auto && d.auto) {
    const out: Routed<T>[] = [];
    for (const p of d.auto(plan.auto, conv.private)) {
      try {
        out.push({ ...pick(p.providerId, p.model, plan.purpose), from: 'auto', why: p.why });
      } catch {
        /* not usable now (a member's limit, a policy): the next */
      }
    }
    if (out.length) return out;
  }
  const { primary, from } = plan;
  const first = primary ? pick(primary.providerId, primary.model, plan.purpose) : pick(null, null, plan.purpose);
  if (conv.private && isCloudModelName(first.model)) throw new Error(`This conversation is private, but ${first.model} is an Ollama cloud model (it runs on Ollama's servers). Pick a model that runs on your own hardware for Private conversations in Settings → Which model does what.`);
  if (conv.private && !d.configOf(first).local) throw new Error(notLocal(d.configOf(first).label));
  const chain: Routed<T>[] = [{ ...first, from }];
  for (const f of (primary ? (primary.fallbacks ?? []) : (s.defaultFallbacks ?? [])).slice(0, 2)) {
    if (!s.providers.some((p) => p.id === f.providerId)) continue;
    try {
      const r = pick(f.providerId, f.model, plan.purpose);
      if (conv.private && (!d.configOf(r).local || isCloudModelName(r.model))) continue;
      if (chain.some((c) => d.configOf(c).id === d.configOf(r).id && c.model === r.model)) continue;
      chain.push({ ...r, from });
    } catch {
      /* a fallback without its key is skipped */
    }
  }
  return chain;
}

/**
 * 2.52.1 fix (owner report: "I sent Sara a picture and she told me she could not see it"): a picture
 * job (vision, screen) never goes to a model that can't see. Subscription command-line agents get text
 * only, so they're skipped for the job's next model; with none left, the talking model takes the
 * picture if it can see. Only if nothing in reach can see does the blind model answer (and it says so).
 */
function pictureChain<T extends { model: string }>(s: Settings, conv: RouteConv, job: Job, chain: Routed<T>[], adult: boolean, d: RouteDeps<T>): Routed<T>[] {
  if ((job !== 'vision' && job !== 'screen') || conv.providerId) return chain;
  // Leftover 6: a model its provider's list says takes no pictures (an API Grok text model) is skipped too.
  const sees = (c: T) => seesPictures(d.configOf(c)) && modelSees(d.seeCtx, d.configOf(c), c.model) !== false;
  const seeing = chain.filter(sees);
  if (seeing.length) return seeing;
  try {
    const talking = chainAll(s, conv, 'turn', adult, d, d.pickTalking ?? d.pick).filter(sees);
    if (talking.length) return talking;
  } catch {
    /* no talking model either: keep the picture chain */
  }
  return chain;
}

/** The models to try for a job, in order, each with where it came from (rules 1 to 8). Throws when none may answer. */
export function resolveRoute<T extends { model: string }>(s: Settings, conv: RouteConv, job: Job, adult: boolean, d: RouteDeps<T>): Routed<T>[] {
  const chain = pictureChain(s, conv, job, chainAll(s, conv, job, adult, d), adult, d);
  if (!privateLocalOn()) return chain;
  // Phase 67: "Nothing leaves this computer": only models on this computer (loopback, not Ollama
  // Cloud, not a subscription program). The network guard would block the rest anyway; this keeps
  // the turn on a model that works and says plainly why the others are paused.
  const here = chain.filter((c) => onThisComputer(d.configOf(c), c.model));
  if (here.length) return here;
  const priv = s.routes?.private;
  const privConfig = priv && s.providers.find((p) => p.id === priv.providerId);
  if (priv && privConfig && onThisComputer(privConfig, priv.model)) return [{ ...d.pick(priv.providerId, priv.model, 'private', true), from: 'private' }];
  throw new Error(`${chain[0] ? d.configOf(chain[0]).label : 'This model'} is paused in private local mode: it isn't on this computer. Pick a model on this computer in Settings → Models & usage → On this computer, or turn "Nothing leaves this computer" off.`);
}

/** Phase 115: a route whose provider is marked local and whose model is not an Ollama cloud model. */
export function routeIsLocal(s: Settings, route: { providerId: string; model: string }): boolean {
  const config = s.providers.find((p) => p.id === route.providerId);
  return Boolean(config?.local) && !isCloudModelName(route.model);
}

export interface TurnJobInput {
  photos: boolean;
  /** An adult turn: adult on, allowed here, and an explicit message. */
  adult: boolean;
  /** The message asks for research (its words, or what it means). */
  research: boolean;
  /** The quick model was asked for (the person, or Token Saver). */
  quick: boolean;
}

/**
 * Phase 38: which job a chat turn is. Photos go to the vision model (a Pictures route, or Auto for
 * pictures), research asks to the research model; an adult turn with an Adult route stays a turn.
 */
export function turnJob(s: Settings, conv: Pick<Conversation, 'mode' | 'private'>, input: TurnJobInput): { job: Job; privateVisionOff: boolean; toVision: boolean; researchSet: boolean } {
  const routes = s.routes ?? {};
  const visionSet = Boolean(routes.vision && s.providers.some((p) => p.id === routes.vision!.providerId));
  // Phase 115 (BR1, §4.5): a private conversation with a picture model that isn't on this computer
  // stays on its local chain; the talking model gets a note instead of the picture (no throw).
  const privateVisionOff = Boolean(conv.private && input.photos && visionSet && !routeIsLocal(s, routes.vision!));
  const toVision = input.photos && (visionSet || autoOn(s, 'vision')) && !privateVisionOff;
  const researchSet = conv.mode !== 'coding' && Boolean(routes.research || autoOn(s, 'research'));
  const job: Job = input.adult && routes.adult ? 'turn' : toVision ? 'vision' : researchSet && input.research ? 'research' : input.quick ? 'quick' : 'turn';
  return { job, privateVisionOff, toVision, researchSet };
}
