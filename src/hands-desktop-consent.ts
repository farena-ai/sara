// Device-local desktop consent. No server/phone approval is accepted here.
import { desktopActionVerdict, type ActLevel, type DesktopTarget } from './computer-policy.ts';

export interface DesktopPrompt {
  op: string;
  task: string;
  target: DesktopTarget;
  text?: string;
  forceOnce?: boolean;
  /** N4: a form fill's review list (every field -> value): this card is always shown. */
  review?: string;
  /** W0.7: the server's Always allow everything key: confirmed once here, then nothing asks until it ends. */
  allowAll?: string;
  allowAllMs?: number;
  choices: ('once' | 'task')[];
}
export class DesktopConsent {
  level: ActLevel = 'task';
  readonly #grants = new Map<string, number>();
  /** W0.7: Always allow everything keys this person confirmed on this computer (key -> until). */
  readonly #all = new Map<string, number>();
  now = () => Date.now();
  #epoch = 0;
  clear(): void { this.#epoch++; this.#grants.clear(); }
  /** W0.7: a confirmed Always allow everything key (not cleared at the end of a task; it ends with its time). */
  allAllowed(key?: string): boolean {
    if (!key) return false;
    const until = this.#all.get(key);
    if (until !== undefined && this.now() >= until) this.#all.delete(key);
    return (this.#all.get(key) ?? 0) > this.now();
  }
  async allow(p: Omit<DesktopPrompt, 'choices'>, prompt?: (p: DesktopPrompt) => Promise<'once' | 'task' | 'deny'>, signal?: AbortSignal): Promise<boolean> {
    const epoch = this.#epoch;
    if (signal?.aborted) return false;
    for (const [t, at] of this.#grants) if (this.now() - at > 15 * 60_000) this.#grants.delete(t);
    const v = desktopActionVerdict({ site: 'desktop', target: p.target, text: p.text, level: this.level, taskGranted: Boolean(p.task && this.#grants.has(p.task)) });
    if (v.act === 'block') throw Object.assign(new Error(v.why), { code: 'denied_local' });
    // W0.7: confirmed here once: every card (payments, account pages, review cards, Ask every time) is skipped.
    if (this.allAllowed(p.allowAll)) return true;
    // N4: a review card is always shown (also with "Always allowed"); its "Allow for this task" covers the fields.
    if (v.act === 'allow' && !p.forceOnce && !p.review) return true;
    if (!prompt) return false;
    // W0.7: with an Always allow key the card's second button confirms it on this computer.
    const choices: ('once' | 'task')[] = p.allowAll || ((v.act === 'ask' ? v.choices.includes('task') : Boolean(p.review)) && p.task && !p.forceOnce) ? ['once', 'task'] : ['once'];
    const answer = await prompt({ ...p, choices });
    if (signal?.aborted || epoch !== this.#epoch || !choices.includes(answer as 'once' | 'task')) return false;
    if (answer === 'task' && p.allowAll) this.#all.set(p.allowAll, this.now() + Math.max(60_000, Math.min(7 * 24 * 3600_000, Number(p.allowAllMs) || 3600_000)));
    else if (answer === 'task') this.#grants.set(p.task, this.now());
    return true;
  }
}
