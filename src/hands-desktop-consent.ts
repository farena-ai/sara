// Device-local desktop consent. No server/phone approval is accepted here.
import { desktopActionVerdict, type ActLevel, type DesktopTarget } from './computer-policy.ts';

export interface DesktopPrompt {
  op: string;
  task: string;
  target: DesktopTarget;
  text?: string;
  forceOnce?: boolean;
  choices: ('once' | 'task')[];
}
export class DesktopConsent {
  level: ActLevel = 'task';
  readonly #grants = new Map<string, number>();
  now = () => Date.now();
  #epoch = 0;
  clear(): void { this.#epoch++; this.#grants.clear(); }
  async allow(p: Omit<DesktopPrompt, 'choices'>, prompt?: (p: DesktopPrompt) => Promise<'once' | 'task' | 'deny'>, signal?: AbortSignal): Promise<boolean> {
    const epoch = this.#epoch;
    if (signal?.aborted) return false;
    for (const [t, at] of this.#grants) if (this.now() - at > 15 * 60_000) this.#grants.delete(t);
    const v = desktopActionVerdict({ site: 'desktop', target: p.target, text: p.text, level: this.level, taskGranted: Boolean(p.task && this.#grants.has(p.task)) });
    if (v.act === 'block') throw Object.assign(new Error(v.why), { code: 'denied_local' });
    if (v.act === 'allow' && !p.forceOnce) return true;
    if (!prompt) return false;
    const choices: ('once' | 'task')[] = v.act === 'ask' && v.choices.includes('task') && p.task && !p.forceOnce ? ['once', 'task'] : ['once'];
    const answer = await prompt({ ...p, choices });
    if (signal?.aborted || epoch !== this.#epoch || !choices.includes(answer as 'once' | 'task')) return false;
    if (answer === 'task') this.#grants.set(p.task, this.now());
    return true;
  }
}
