// Focus (Sara Store, first-party): a Pomodoro timer. `start` begins a focus block (25 minutes by
// default), then a break (5), and repeats until `stop`. It says nothing during a block and tells him
// when to take a break and when to start again. Pairs with *Quiet when I'm focused* (Phase 114).
import { plugin } from './sara-plugin.mjs';

let timer = null;
let state = null;
export const minutesOf = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
function clear() {
  if (timer) clearTimeout(timer);
  timer = null;
}
function schedule(sara, phase, rounds) {
  clear();
  const work = minutesOf(sara.settings.work, 25, 5, 120);
  const rest = minutesOf(sara.settings.rest, 5, 1, 30);
  const mins = phase === 'work' ? work : rest;
  state = { phase, rounds, until: Date.now() + mins * 60_000 };
  timer = setTimeout(async () => {
    if (phase === 'work') {
      await sara.notify(`Focus block ${rounds} done. Take ${rest} minutes: stand up and stretch.`);
      schedule(sara, 'rest', rounds);
    } else {
      await sara.notify(`Break's over. Focus block ${rounds + 1}: ${work} minutes.`);
      schedule(sara, 'work', rounds + 1);
    }
  }, mins * 60_000);
  timer.unref?.();
}

plugin({
  tools: [
    {
      name: 'start',
      description: 'Start a focus timer (Pomodoro): a focus block, then a break, repeating until stop.',
      parameters: { type: 'object', properties: {} },
      permission: 'auto',
      run: async (_args, sara) => {
        schedule(sara, 'work', 1);
        const work = minutesOf(sara.settings.work, 25, 5, 120);
        return { content: `Focus started: ${work} minutes. I'll tell you when to take a break.`, card: { title: 'Focus', lines: [`${work} minutes on`, `${minutesOf(sara.settings.rest, 5, 1, 30)} minutes off`, 'Say stop focus to end'] } };
      },
    },
    {
      name: 'stop',
      description: 'Stop the focus timer.',
      parameters: { type: 'object', properties: {} },
      permission: 'auto',
      run: async () => {
        const had = state;
        clear();
        state = null;
        return had ? `Focus stopped after ${had.rounds} block${had.rounds === 1 ? '' : 's'}.` : 'No focus timer is running.';
      },
    },
  ],
});
