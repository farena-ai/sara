// R2b (docs/ops/R2_DESIGN.md): an approval card during a call. The card goes on the call screen (a
// video call hides the chat behind it), she says one plain line, and only a tap answers it: nothing
// said on the call ever approves. Hanging up, a dropped call or talking over her cancels what waits;
// after two minutes the wait is cancelled and she says so. Classic and live calls share it.
// No DOM use at load time (unit-tested in Node with fakes).

/** How long a card waits on a call before it is cancelled. */
export const CALL_APPROVAL_WAIT_MS = 120_000;

export class CallApprovals {
  /**
   * @param {{ t: (s: string) => string, say: (text: string) => void, stop: () => void,
   *   show: (card: object) => void, release: (card: object) => void,
   *   setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (h: unknown) => void }} o
   *   say speaks a line in her call voice; stop cancels the waiting turn; show puts the card on the
   *   call screen; release takes it off again (answered, cancelled or the call ended).
   */
  constructor(o) {
    this.o = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), ...o };
    /** Cards waiting on this call, by tool call id. */
    this.cards = new Map();
  }

  get waiting() {
    return this.cards.size;
  }

  /** An approval arrived on the call: show it there and say the one line (once per wait). */
  shown(id, card) {
    if (this.cards.has(id)) return;
    const first = this.cards.size === 0;
    this.cards.set(id, { card, timer: this.o.setTimer(() => this.#expire(), CALL_APPROVAL_WAIT_MS) });
    this.o.show(card);
    const { t } = this.o;
    if (first) this.o.say(t('I need your OK for that. It is on your screen.'));
  }

  /** The card was answered by a tap (or the step moved on): off the call screen. */
  done(id) {
    const c = this.cards.get(id);
    if (!c) return;
    this.o.clearTimer(c.timer);
    this.cards.delete(id);
    this.o.release(c.card);
  }

  /** The call ended (hang-up or a dropped connection): what waits is cancelled. */
  ended() {
    return this.#cancel();
  }

  /** She was talked over while a card waits: that interrupts (cancels); it is never an OK. */
  heard() {
    return this.#cancel();
  }

  /** The turn ended (its reply finished, or it stopped): nothing waits any more. */
  settle() {
    for (const id of [...this.cards.keys()]) this.done(id);
  }

  /** The call screen opened again: the waiting cards go back on it. */
  reshow() {
    for (const c of this.cards.values()) this.o.show(c.card);
  }

  #expire() {
    const { t } = this.o;
    if (this.#cancel()) this.o.say(t('I cancelled that: it waited two minutes for your OK. Ask me again when you like.'));
  }

  #cancel() {
    if (!this.cards.size) return false;
    this.settle();
    this.o.stop();
    return true;
  }
}
