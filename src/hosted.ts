// W2.3 (docs/HOSTING_FRIENDS.md): a Sara the owner hosts for a friend. Built on the household's
// member spaces (members/<id>/: own sign-in, own databases, own companions, the same front-router)
// with three differences, all here:
//   1. Settings: their own file, including their OWN providers, prices and model lists (a household
//      member borrows the owner's). Server-wide keys (MCP servers, plugins, backups, shell network…)
//      are never theirs: the owner runs the server.
//   2. Keys: their own vault in members/<id>/keys with its own key file (never the server's
//      master.key), so their API keys don't open with the owner's key and aren't in his vault.
//   3. What the owner sees: name, status and usage totals (messages, tokens, dollars over 7 days).
//      Not which models, no titles, no content. src/household.ts keeps them out of members()
//      (boards, Family, sign-in rules, member tools) and memberRouteCheck gives them their own
//      models/spend routes; src/main.ts keeps them out of data rights and usage reports.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_SETTINGS, type MemberRecord, type memberUsage } from './household.ts';
import { SettingsStore, type Settings } from './settings.ts';
import { Vault } from './vault.ts';

/**
 * W5.1: a hosted friend's model address must be public (src/routes/models.ts). SARA_HOSTED_LOCAL_MODELS=1
 * lets them use a model server on this computer itself (127.0.0.1, e.g. the owner's Ollama; never the
 * network or cloud metadata); tests with a fake model on 127.0.0.1 set it too.
 */
export const hostedProviderGuard = { allowLoopback: process.env.SARA_HOSTED_LOCAL_MODELS === '1' };

/** Owner-only settings a hosted friend keeps for themselves (their own models). */
export const HOSTED_SETTINGS_OWN: readonly (keyof Settings)[] = ['providers', 'prices', 'modelLists', 'modelAutoSwitch'];
const BLOCKED = OWNER_SETTINGS.filter((k) => !HOSTED_SETTINGS_OWN.includes(k));

/** A hosted friend's settings: their own file, nothing layered in from the owner. */
export class HostedSettings extends SettingsStore {
  override get(): Settings {
    const own = super.get() as unknown as Record<string, unknown>;
    for (const k of BLOCKED) delete own[k];
    return { ...own, providers: (own.providers as Settings['providers']) ?? [], toolPermissions: {}, otherApps: { ...((own.otherApps as Settings['otherApps']) ?? {}), tools: false, changes: false } } as Settings;
  }

  override update(patch: Partial<Settings>): Settings {
    const mine: Record<string, unknown> = { ...patch };
    for (const k of BLOCKED) delete mine[k];
    if (Object.keys(mine).length) super.update(mine as Partial<Settings>);
    return this.get();
  }
}

/** Their own vault: members/<id>/keys with its own key file (made on first use, mode 0600). */
export function hostedVault(dir: string): Vault {
  mkdirSync(join(dir, 'keys'), { recursive: true, mode: 0o700 });
  return new Vault(join(dir, 'keys'));
}

/** Their own key (base64), for other sealed files in their space (their mailboxes). */
export function hostedKey(dir: string): string {
  hostedVault(dir);
  return readFileSync(join(dir, 'keys', 'master.key'), 'utf8').trim();
}

export interface HostedView {
  id: string;
  name: string;
  status: MemberRecord['status'];
  createdAt: string;
  deleteAfter: string | null;
  usage: { messages7d: number; usd7d: number; tokens7d: number };
}

/** The owner's view of a hosted friend: totals only. */
export function hostedView(m: MemberRecord, usage: ReturnType<typeof memberUsage> | null): HostedView {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    createdAt: m.createdAt,
    deleteAfter: m.deleteAfter ?? null,
    usage: { messages7d: usage ? usage.days.reduce((n, d) => n + d.messages, 0) : 0, usd7d: usage?.usd ?? 0, tokens7d: usage?.tokens ?? 0 },
  };
}
