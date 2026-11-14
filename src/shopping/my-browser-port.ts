// N4: the real BrowserPort for "check in my browser" (src/shopping/my-browser.ts), over the hands channel to
// the person's computer: d.tabs, d.elements, d.click, d.type, d.keys, each with the task key so the computer's
// own approval rules apply (its cards, "Allow for this task", payment/sign-in pages asking every time). One
// task per computer: the computer is claimed for the check and released after.
import { browserTabs, desktopItems } from '../hands-desktop.ts';
import type { HandsDeviceView, HandsHub } from '../hands.ts';
import type { BrowserPort, BrowserView } from './my-browser.ts';

const NEEDS = ['d.tabs', 'd.elements', 'd.click', 'd.type', 'd.keys'];

/** The computer a store check can use now, or why not (said to the person; never a way around it). */
export function myBrowserDevice(hub: HandsHub | undefined, owner?: string): { device?: HandsDeviceView; why?: string } {
  if (!hub || !hub.allowed()) return { why: 'computer use is not on here' };
  const online = hub.devices().filter((d) => d.connected);
  if (!online.length) return { why: 'the Sara app on your computer is not connected' };
  const able = online.filter((d) => d.optIn?.desktop && NEEDS.every((o) => d.ops?.includes(o)));
  if (!able.length) return { why: online.some((d) => !d.optIn?.desktop) ? '\u201cThe whole screen\u201d is off in the Sara app on your computer (Settings \u2192 Computer use)' : 'the Sara app on your computer is too old for this: update it' };
  const ready = able.filter((d) => d.approvalsHere === true);
  if (!ready.length) return { why: 'the Sara app on your computer can\u2019t show approval cards' };
  // Busy = another conversation's task holds it (this one's own task may go on).
  const free = ready.filter((d) => !d.paused && (!d.busy || (owner !== undefined && hub.usedBy(d.id) === owner)));
  if (!free.length) return { why: ready.some((d) => d.paused) ? 'you are using the computer (Sara is paused there until you press Resume)' : 'Sara is busy on your computer with another task' };
  return { device: free[0] };
}

export function handsBrowserPort(hub: HandsHub, device: HandsDeviceView, o: { owner: string; task: string; signal?: AbortSignal; who?: string }): BrowserPort & { release(): void } {
  const call = async (op: string, args: Record<string, unknown>, what: string) => {
    if (!hub.claim(device.id, o.owner)) throw new Error('Sara is using that computer for another task right now.');
    hub.spend(o.task);
    return hub.request(device.id, op, args, { ...(o.signal ? { signal: o.signal } : {}), ...(o.who ? { who: o.who } : {}), what });
  };
  const act = (view: BrowserView, ref: string, extra: Record<string, unknown>) => ({ ref, viewId: view.viewId, window: view.window, task: o.task, forceOnce: false, ...extra });
  return {
    async tabs() {
      return browserTabs((await call('d.tabs', {}, 'reading your browser tabs')).result.browsers);
    },
    async look(window) {
      const r = (await call('d.elements', { window, limit: 300 }, 'reading the store page in your browser')).result;
      const w = (r.window ?? {}) as Record<string, unknown>;
      if (typeof r.viewId !== 'string') throw new Error('The computer gave no view of the browser window.');
      return { viewId: r.viewId, window, ...(w.title ? { title: String(w.title) } : {}), items: desktopItems(r.items) };
    },
    async click(view, ref) {
      await call('d.click', act(view, ref, { button: 'left', double: false }), 'checking a store in your browser');
    },
    async type(view, ref, text) {
      await call('d.type', act(view, ref, { text }), 'opening the store page in your browser');
    },
    async keys(view, ref, combo) {
      await call('d.keys', act(view, ref, { combo }), 'opening the store page in your browser');
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    release() {
      hub.release(device.id, o.owner);
      void hub.request(device.id, 'c.endTask', {}, {}).catch(() => undefined);
    },
  };
}
