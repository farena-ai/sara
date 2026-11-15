// R7 (docs/ADMIN.md → Tools for household members): what the owner lets household members' companions
// do with tools. Per tool family (computer use, sending mail, web, errands, automations): allowed as
// usual, always ask first, or off; "every tool asks first"; and a hard daily cap for paid tools.
// Rules for "Everyone", and per member (a member's own choice beats Everyone's). Purchases, commands
// and coding are never available to members. Enforced on the server: ToolRegistry.permission() for a
// member's registry runs clamp() (so the eligible list, the run gate and the re-check after an approval
// all see it), chat.ts passes spendCap() to the spend check, computer use refuses payment clicks.
// One file, `<data>/member-tools.json`; every change is one audit row (EC4).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit-trail.ts';
import { writeFileAtomic } from './fs-util.ts';
import { HttpError } from './http.ts';
import type { Permission } from './tools/types.ts';

export const MEMBER_TOOLS_FILE = 'member-tools.json';
/** Families the owner chooses for. */
export const MEMBER_FAMILIES = ['computer', 'mail-send', 'web', 'errands', 'automations'] as const;
export type MemberFamily = (typeof MEMBER_FAMILIES)[number];
/** Never available to household members, whatever the rules say. */
export const NEVER_FAMILIES = ['purchases', 'shell', 'coding'] as const;
export type FamilyChoice = 'allow' | 'ask' | 'off';
export const FAMILY_CHOICES: readonly FamilyChoice[] = ['allow', 'ask', 'off'];
/** Paid tools, US dollars a day (0 = no extra cap). */
export const TOOL_SPEND_CHOICES = [0, 0.1, 0.25, 0.5, 1, 2, 5] as const;

export interface ToolRules {
  families: Partial<Record<MemberFamily, FamilyChoice>>;
  /** Every tool asks first (except find_tools, which only loads tool descriptions). */
  alwaysAsk?: boolean;
  /** Hard daily cap for paid tools in dollars (0 = none beyond the admin pin). */
  spendPerDay?: number;
}
export interface MemberToolsFile {
  version: 1;
  everyone: ToolRules;
  members: Record<string, ToolRules>;
  updatedAt: string | null;
}
export interface Effective {
  families: Record<MemberFamily, FamilyChoice>;
  alwaysAsk: boolean;
  spendPerDay: number;
}

const MEMBER_ID = /^[a-f0-9]{10}$/;
const FAMILY_RE: [RegExp, MemberFamily | (typeof NEVER_FAMILIES)[number]][] = [
  [/^pc_(run|open|shell)\w*$/, 'shell'],
  [/^pc_/, 'computer'],
  [/^(mail_send|mail_reply|gmail_send|send_email)$/, 'mail-send'],
  [/^(web_fetch|web_search|research_\w+)$/, 'web'],
  [/^errand_\w+$/, 'errands'],
  [/^automation_\w+$/, 'automations'],
  [/^(shell|run_code|terminal\w*)$/, 'shell'],
  [/^(code_\w+|git(_\w+)?|github_\w+|worktree_\w+|lsp_\w+|preview_\w+|browser_\w+|start_job|stop_job|job_status|delegate_task|review_code|redteam_\w+|work_on_issue)$/, 'coding'],
];

/** The family a tool belongs to for these rules (undefined: no family rule, only "every tool asks"). */
export function memberFamilyOf(name: string): MemberFamily | (typeof NEVER_FAMILIES)[number] | undefined {
  for (const [re, fam] of FAMILY_RE) if (re.test(name)) return fam;
  return undefined;
}

function cleanRules(v: unknown, partial: boolean): ToolRules {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Rules must be an object.');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['families', 'alwaysAsk', 'spendPerDay'].includes(k)) throw new HttpError(400, 'Unknown field {key}.', { params: { key: k } });
  const families: ToolRules['families'] = {};
  if (o.families !== undefined) {
    if (o.families === null || typeof o.families !== 'object' || Array.isArray(o.families)) throw new HttpError(400, 'Rules must be an object.');
    for (const [k, c] of Object.entries(o.families as Record<string, unknown>)) {
      if (!(MEMBER_FAMILIES as readonly string[]).includes(k)) throw new HttpError(400, 'Unknown field {key}.', { params: { key: k } });
      if (c === null && partial) continue;
      if (!FAMILY_CHOICES.includes(c as FamilyChoice)) throw new HttpError(400, 'Pick allow, ask or off.');
      families[k as MemberFamily] = c as FamilyChoice;
    }
  }
  const out: ToolRules = { families };
  if (o.alwaysAsk !== undefined && o.alwaysAsk !== null) {
    if (typeof o.alwaysAsk !== 'boolean') throw new HttpError(400, 'alwaysAsk must be true or false.');
    out.alwaysAsk = o.alwaysAsk;
  }
  if (o.spendPerDay !== undefined && o.spendPerDay !== null) {
    if (!(TOOL_SPEND_CHOICES as readonly unknown[]).includes(o.spendPerDay)) throw new HttpError(400, 'Pick one of the offered limits.');
    out.spendPerDay = Number(o.spendPerDay);
  }
  return out;
}

export class MemberTools {
  readonly #file: string;
  readonly #now: () => Date;
  #cur: MemberToolsFile;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#file = join(dataDir, MEMBER_TOOLS_FILE);
    this.#now = now;
    this.#cur = { version: 1, everyone: { families: {} }, members: {}, updatedAt: null };
    if (existsSync(this.#file)) {
      try {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<MemberToolsFile>;
        const members: Record<string, ToolRules> = {};
        for (const [id, r] of Object.entries(raw.members ?? {})) if (MEMBER_ID.test(id)) members[id] = cleanRules(r, true);
        this.#cur = { version: 1, everyone: cleanRules(raw.everyone ?? { families: {} }, true), members, updatedAt: raw.updatedAt ?? null };
      } catch {
        // A damaged file must not quietly open tools up: members get every family off until it is saved again.
        console.warn('member tools: the settings file is damaged; household members have no tool families until it is saved again.');
        this.#cur.everyone = { families: Object.fromEntries(MEMBER_FAMILIES.map((f) => [f, 'off'])) as ToolRules['families'], alwaysAsk: true };
      }
    }
  }

  get(): MemberToolsFile {
    return structuredClone(this.#cur);
  }

  /** What applies to one member: their own choice, else Everyone's, else allowed as usual. */
  effective(memberId: string): Effective {
    const e = this.#cur.everyone;
    const m = this.#cur.members[memberId] ?? { families: {} };
    const families = Object.fromEntries(MEMBER_FAMILIES.map((f) => [f, m.families[f] ?? e.families[f] ?? 'allow'])) as Record<MemberFamily, FamilyChoice>;
    return { families, alwaysAsk: m.alwaysAsk ?? e.alwaysAsk ?? false, spendPerDay: m.spendPerDay ?? e.spendPerDay ?? 0 };
  }

  /** A member's permission for one tool: never tighter-than-asked is loosened, only tightened. */
  clamp(memberId: string, name: string, p: Permission): Permission {
    if (p === 'never') return p;
    const fam = memberFamilyOf(name);
    if (fam && (NEVER_FAMILIES as readonly string[]).includes(fam)) return 'never';
    const e = this.effective(memberId);
    const choice = fam ? e.families[fam as MemberFamily] : 'allow';
    if (choice === 'off') return 'never';
    if (p === 'auto' && (choice === 'ask' || (e.alwaysAsk && name !== 'find_tools'))) return 'ask';
    return p;
  }

  /** The member's hard daily cap for paid tools (undefined: none). */
  spendCap(memberId: string): number | undefined {
    const n = this.effective(memberId).spendPerDay;
    return n > 0 ? n : undefined;
  }

  /** PUT body: { everyone?: rules, members?: { <id>: rules | null } } (null = same as Everyone). */
  set(input: unknown, known: (id: string) => boolean): MemberToolsFile {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Rules must be an object.');
    const o = input as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'everyone' && k !== 'members') throw new HttpError(400, 'Unknown field {key}.', { params: { key: k } });
    const next = structuredClone(this.#cur);
    const keys: string[] = [];
    if (o.everyone !== undefined) {
      next.everyone = cleanRules(o.everyone, false);
      keys.push('everyone');
    }
    if (o.members !== undefined) {
      if (o.members === null || typeof o.members !== 'object' || Array.isArray(o.members)) throw new HttpError(400, 'Rules must be an object.');
      for (const [id, r] of Object.entries(o.members as Record<string, unknown>)) {
        if (!MEMBER_ID.test(id) || !known(id)) throw new HttpError(404, 'No such person.');
        if (r === null) delete next.members[id];
        else next.members[id] = cleanRules(r, true);
        keys.push(`member_${id}`);
      }
    }
    next.updatedAt = this.#now().toISOString();
    this.#cur = next;
    writeFileAtomic(this.#file, JSON.stringify(next, null, 2) + '\n');
    audit({ action: 'member-tools.change', target: 'household', keys });
    return this.get();
  }
}

// ---- the server's one store (set by main.ts; tests set their own). Unset = no member rules. ----
let current: MemberTools | undefined;
export function setMemberTools(m: MemberTools | undefined): void {
  current = m;
}
export function memberTools(): MemberTools | undefined {
  return current;
}
/** For a member's ToolRegistry.memberClamp. */
export function memberClampFor(memberId: () => string | undefined): (name: string, p: Permission) => Permission {
  return (name, p) => {
    const id = memberId();
    const m = current;
    return id && m ? m.clamp(id, name, p) : p;
  };
}
/** The cap chat.ts passes to spendCheck: the tighter of the admin pin and the member's own cap. */
export function toolSpendCap(pin: number | undefined, memberId: string | undefined): number | undefined {
  const own = memberId ? current?.spendCap(memberId) : undefined;
  if (pin && own) return Math.min(pin, own);
  return pin || own || undefined;
}
/** What a member's companion says when a payment step is refused in computer use. */
export const PURCHASE_REFUSAL = 'Purchases and payments are never made for household members. Tell them the page is ready for them to finish it themselves.';
