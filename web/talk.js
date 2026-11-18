// U4.24 (docs/VOICE_FIRST.md): Talk with Sara, the voice-first mode. One button starts a hands-free
// turn loop on top of the classic call (web/voice.js: energy VAD + SpeechGate, talking over her stops
// her, her reply spoken sentence by sentence while it streams). On top: a live transcript, a short
// filler line while she is still quiet, a spoken yes/no for a waiting card (the card stays on screen;
// money and passwords always need a tap, the server checks too), and "goodbye" or End to stop.
// Hearing and voice are the ones from Settings → Sara → Voice (on this server or a speech service);
// with Nothing leaves this computer on, only the on-server engines are used.
// TalkSession has no DOM use (unit-tested in Node with fakes); initTalk wires the page.
import { approvalCommand } from './car-mode.js';
import { t } from './naming.js';
import { Call, Mic, SpeechGate } from './voice.js';

/** No word from her this long after you spoke: a filler line plays. */
export const FILLER_AFTER_MS = 700;
export const TALK_DEFAULTS = { fillers: true, approveByVoice: true, goodbye: true };

// "goodbye" said on its own (with a thanks or her name around it) ends the talk; inside a longer
// request ("say goodbye to my sister") it is just words to her.
const BYE = "(?:good ?bye|bye(?: bye)?|that(?:'|’)?s all(?: for now)?|we(?:'|’)?re done|talk (?:to you )?later|adi[oó]s|hasta luego|chao|au revoir|tsch[üu]ss|auf wiedersehen|bis später|tchau|até logo|até mais|ciao|arrivederci|a dopo)";
const THANKS = '(?:ok(?:ay)?|thanks?|thank you|gracias|merci|danke|obrigad[oa]|grazie)';
const BYE_RE = new RegExp(`^\\s*(?:${THANKS}[,!.]?\\s*)?${BYE}(?:[,!.]?\\s*(?:for now|then|\\p{L}{2,20}))?\\s*[.!]*\\s*$`, 'iu');
export function goodbyeCommand(text) {
  return BYE_RE.test(String(text ?? ''));
}

// The server's rule (src/phone-actions.ts voiceMayApprove: the phone rule plus VOICE_NEVER_TOOL),
// mirrored for what she says; the server decides (test/u4-voice-first.test.ts keeps them equal).
const PC_ONLY = /^(pc_|browser_|computer_|hands_|desktop_)/;
const NEVER = /(?:^|_)(?:pay|payment|purchase|buy|checkout|wallet|transfer|password|passkey|vault|secret|credential|login|signin|otp|two_step)(?:_|$)|password/;
export function voiceMayAnswer(ev) {
  if (!ev?.name || PC_ONLY.test(ev.name) || NEVER.test(ev.name)) return false;
  return !(ev.computer || ev.contradiction || ev.sandbox || ev.sandboxFirst || ev.advisory || ev.redteam || ev.spend || ev.price || ev.untrusted);
}

/** Short lines she says while she thinks (prefetched at the start, so they play at once). */
export function fillerLines() {
  return [t('Mm-hm.'), t('One moment.'), t('Let me think.'), t('Okay, let me see.')];
}

/**
 * One talk's turn loop, without the page. o: { now, setTimer, clearTimer, prefs() → {fillers,
 * approveByVoice, goodbye}, say(line), filler(i), stopFiller(), send(text), answer(approved) →
 * {line}, end(why), onLines(lines) }.
 */
export class TalkSession {
  constructor(o) {
    this.o = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), onLines: () => {}, ...o };
    /** The live transcript: { who: 'you' | 'her' | 'note', text }. */
    this.lines = [];
    /** Waiting cards by tool call id (the card event). */
    this.cards = new Map();
    /** First audio of her reply, ms after your words were sent, per turn. */
    this.latency = [];
    this.fillerN = 0;
    this.timer = null;
    this.sentAt = 0;
    this.her = null;
  }

  #line(who, text) {
    const l = { who, text };
    this.lines.push(l);
    if (this.lines.length > 200) this.lines.shift();
    this.o.onLines(this.lines);
    return l;
  }

  #cancelFiller() {
    if (this.timer) this.o.clearTimer(this.timer);
    this.timer = null;
    this.o.stopFiller?.();
  }

  #schedule() {
    if (this.timer || !this.o.prefs().fillers) return;
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      if (this.her || this.fillerPlayed) return;
      this.fillerPlayed = true;
      this.o.filler(this.fillerN++ % fillerLines().length);
    }, FILLER_AFTER_MS);
  }

  /**
   * You stopped talking (hearing starts now). The clock for this turn starts here, and so does the
   * filler's: on-server hearing takes about a second, so the filler comes before her words.
   */
  ended() {
    this.#cancelFiller();
    this.her = null;
    this.fillerPlayed = false;
    this.measured = false;
    this.replied = false;
    this.sentAt = this.o.now();
    this.#schedule();
  }

  /** A card waits for an OK in this talk. */
  get waiting() {
    return this.cards.size > 0;
  }

  /** Words that answer a waiting card or end the talk: the turn going on must not be stopped for them. */
  keepsTurn(text) {
    const said = String(text ?? '').trim();
    return (this.o.prefs().goodbye && goodbyeCommand(said)) || (this.waiting && Boolean(approvalCommand(said)));
  }

  /** Hearing found no words (a cough, a door): no filler for that. */
  nothing() {
    if (this.timer) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  /** Your words came back from hearing. Returns 'end' | 'answer' | 'tap' | 'sent'. */
  async heard(text) {
    const said = String(text ?? '').trim();
    if (!said) return 'sent';
    const prefs = this.o.prefs();
    this.#line('you', said);
    if (prefs.goodbye && goodbyeCommand(said)) {
      this.#cancelFiller();
      this.o.end('goodbye');
      return 'end';
    }
    const card = [...this.cards.values()].at(-1);
    const word = card ? approvalCommand(said) : null;
    if (card && word) {
      if (!prefs.approveByVoice || !voiceMayAnswer(card)) {
        this.o.say(t('This one needs a tap: the card is on your screen.'));
        return 'tap';
      }
      const r = await this.o.answer(word === 'approve').catch((err) => ({ line: err.message }));
      if (r?.line) {
        this.#line('note', r.line);
        this.o.say(r.line);
      }
      return 'answer';
    }
    this.her = null;
    // Not started by ended() (typed or a test): the clock starts now.
    if (!this.sentAt || this.measured) {
      this.fillerPlayed = false;
      this.measured = false;
      this.replied = false;
      this.sentAt = this.o.now();
    }
    this.#schedule();
    await this.o.send(said);
    return 'sent';
  }

  /** Her reply's text as it streams (also cancels a filler that hasn't played yet). */
  herText(text) {
    if (!this.her) {
      this.#cancelFiller();
      this.her = this.#line('her', '');
      this.replied = true;
    }
    this.her.text += text;
    this.o.onLines(this.lines);
  }

  /** Her reply's first sound started playing: the turn's latency (from the end of your words). */
  herAudio() {
    if (!this.sentAt || this.measured || !this.replied) return;
    this.measured = true;
    this.latency.push(this.o.now() - this.sentAt);
  }

  herDone() {
    this.#cancelFiller();
    if (this.her) this.her.text = this.her.text.trim();
    this.her = null;
    this.o.onLines(this.lines);
  }

  /** You talked over her: what she was saying stops (the call stops her voice and the turn). */
  interrupted() {
    this.#cancelFiller();
    if (this.her) this.her.text = `${this.her.text.trim()} …`;
    this.her = null;
  }

  /** A card waits for an OK: she says how to answer it; the card is shown by the page. */
  approval(ev) {
    this.#cancelFiller();
    this.cards.set(ev.id, ev);
    const voiceOk = this.o.prefs().approveByVoice && voiceMayAnswer(ev);
    const line = voiceOk ? t('Say yes to go ahead, or no to cancel. The card is on your screen.') : t('This one needs a tap: the card is on your screen.');
    this.#line('note', line);
    this.o.say(line);
  }

  approvalDone(id) {
    this.cards.delete(id);
  }
}

// ---------------------------------------------------------------------------------------------
// The page: the button, the dialog, the call underneath.
// ---------------------------------------------------------------------------------------------

let ctx = null;
let session = null;
let call = null;
let fillers = [];
let fillerAudio = null;
const $ = (s) => globalThis.document?.querySelector(s);

/** Talk with Sara is running (send() adds `talk: true`, her voice is on). */
export const talkOn = () => Boolean(session);

/**
 * ctx: { api, speaker, transcribe, send(text), stopTurn(), conversation(), voiceCfg(), ready() →
 * '' or why not, cardFor(id) → the approval card element, putBack(card) }.
 */
export function initTalk(c) {
  ctx = c;
  const btn = $('#talk-btn');
  const dlg = $('#talk-mode');
  if (!btn || !dlg) return;
  btn.addEventListener('click', () => void (session ? stopTalk('button') : startTalk()));
  $('#tm-end')?.addEventListener('click', () => stopTalk('button'));
  $('#tm-mute')?.addEventListener('click', () => {
    if (!call) return;
    call.muted = !call.muted;
    $('#tm-mute').setAttribute('aria-pressed', String(call.muted));
    $('#tm-mute').textContent = call.muted ? t('Unmute') : t('Mute');
    status(call.muted ? t('Muted') : t('Listening…'));
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    stopTalk('button');
  });
  // Her voice started a reply sentence: the first one is this turn's first audio.
  ctx.speaker.audio.addEventListener('playing', () => {
    if (!session) return;
    stopFiller();
    session.herAudio();
    const ms = session.latency.at(-1);
    if (ms !== undefined) dlg.dataset.firstAudioMs = String(ms);
  });
}

/** Shows or hides the button (voice set up, a microphone in this page). */
export function syncTalkButton(show) {
  const b = $('#talk-btn');
  if (b) b.hidden = !show;
}

function status(text) {
  const s = $('#tm-status');
  if (s) s.textContent = text;
}

function renderLines(lines) {
  const ol = $('#tm-lines');
  if (!ol) return;
  const label = { you: t('You'), her: ctx?.name?.() || t('Sara'), note: '' };
  ol.replaceChildren(
    ...lines.slice(-40).map((l) => {
      const li = globalThis.document.createElement('li');
      li.className = `tm-line tm-${l.who}`;
      if (label[l.who]) {
        const b = globalThis.document.createElement('strong');
        b.textContent = label[l.who];
        li.append(b, ' ');
      }
      li.append(l.text || '…');
      return li;
    }),
  );
  ol.scrollTop = ol.scrollHeight;
}

function stopFiller() {
  if (fillerAudio) {
    fillerAudio.pause();
    fillerAudio = null;
  }
}

async function prefetchFillers() {
  fillers = await Promise.all(
    fillerLines().map((line) =>
      ctx
        .speak(line)
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null),
    ),
  );
}

export async function startTalk() {
  if (session || !ctx) return;
  const why = ctx.ready();
  if (why) return void ctx.notice(why);
  const prefs = () => ({ ...TALK_DEFAULTS, ...(ctx.voiceCfg()?.settings?.talk ?? {}) });
  const dlg = $('#talk-mode');
  session = new TalkSession({
    prefs,
    say: (line) => ctx.speaker.say(line),
    filler: (i) => {
      const url = fillers[i];
      if (!url || ctx.speaker.speaking) return;
      fillerAudio = new Audio(url);
      fillerAudio.play().catch(() => {});
    },
    stopFiller,
    send: (text) => ctx.send(text),
    answer: (approved) => ctx.api('/talk/answer', { method: 'POST', body: { conversationId: ctx.conversation(), approved } }),
    end: () => stopTalk('goodbye'),
    onLines: renderLines,
  });
  renderLines([]);
  status(t('Starting…'));
  dlg.showModal();
  $('#tm-mute').setAttribute('aria-pressed', 'false');
  $('#tm-mute').textContent = t('Mute');
  const mic = new Mic();
  let gate = null;
  let lastStatus = '';
  call = new Call({
    mic,
    speaker: ctx.speaker,
    transcribe: ctx.transcribe,
    isSpeech: (f) => (gate ??= new SpeechGate(mic.ctx?.sampleRate ?? 48000)).push(f),
    onUtterance: async (text) => {
      if (!session) return;
      // A yes/no for the waiting card (or goodbye) answers without stopping the turn that waits.
      if (!session.keepsTurn(text)) {
        ctx.stopTurn();
        await ctx.idle();
      }
      await session?.heard(text);
    },
    onInterrupt: () => {
      session?.interrupted();
      stopFiller();
      // Talking over her line about a card stops her voice only: the card keeps waiting.
      if (!session?.waiting) ctx.stopTurn();
    },
    onStatus: (s) => {
      const was = lastStatus;
      lastStatus = s;
      if (was === 'thinking' && s === 'listening') session?.nothing();
      if (call?.muted) return;
      if (s === 'hearing') status(t('Hearing you…'));
      else if (s === 'thinking') {
        session?.ended();
        status(t('Thinking…'));
      }
      else if (s === 'listening' && !ctx.speaker.speaking) status(t('Listening…'));
    },
  });
  try {
    await call.start();
    $('#talk-btn')?.classList.add('active');
    status(t('Listening…'));
    void prefetchFillers();
  } catch (err) {
    stopTalk('error');
    ctx.notice(err?.name === 'NotAllowedError' ? t('Microphone: permission denied.') : t('Microphone: {message}', { message: err?.message ?? '' }));
  }
}

export function stopTalk(why = 'button') {
  if (!session) return;
  const s = session;
  session = null;
  call?.stop();
  call = null;
  stopFiller();
  ctx.speaker.stop();
  ctx.stopTurn();
  for (const u of fillers) if (u) URL.revokeObjectURL(u);
  fillers = [];
  // Cards still waiting go back into the chat (a tap there still answers them).
  for (const card of [...($('#tm-approvals')?.children ?? [])]) ctx.putBack(card);
  $('#talk-btn')?.classList.remove('active');
  const dlg = $('#talk-mode');
  if (dlg?.open) dlg.close();
  if (why === 'goodbye') ctx.speaker.say(t('Bye for now.'));
  return s;
}

/** The chat stream's events while talking (web/app.js runStream calls this for every event). */
export function talkEvent(ev) {
  if (!session) return;
  if (ev.type === 'token') {
    session.herText(ev.text);
    status(t('Speaking…'));
  } else if (ev.type === 'approval') {
    session.approval(ev);
    status(t('Waiting for your OK'));
    // The card itself (built by the chat) moves onto the talk screen; End puts it back.
    setTimeout(() => {
      const card = ctx.cardFor(ev.id);
      if (card && session) $('#tm-approvals')?.append(card);
    }, 0);
  } else if (ev.type === 'end') {
    session.herDone();
    for (const card of [...($('#tm-approvals')?.children ?? [])]) {
      if (card.querySelector('button:not(:disabled)')) continue;
      session.approvalDone(card.dataset.call);
      card.remove();
    }
    for (const id of [...session.cards.keys()]) if (!$(`#tm-approvals [data-call="${globalThis.CSS?.escape?.(id) ?? id}"]`)) session.approvalDone(id);
  }
}

/** Hey Sara set to start a talk (src/routes/wake.ts): the app window that answered opens it. */
export function talkWake(ev) {
  if (!ev?.talk || session || !ctx) return;
  if (!(globalThis.SaraDesktop || globalThis.SaraPhone)) return;
  setTimeout(() => {
    if (globalThis.document?.visibilityState !== 'visible') return;
    if (ctx.conversation() !== ev.talk) ctx.open(ev.talk);
    void startTalk();
  }, 600);
}
