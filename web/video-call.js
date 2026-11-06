// Phase 69: the video call screen. A video call is the normal call (live or classic) shown as a
// full-window view of her moving portrait (the same Presence as the small call panel, moved in here,
// so lip-sync, blinking, breathing and sway carry over), with her current look as the backdrop, a
// timer, mute, camera, sound, captions and hang up.
//
// The owner's camera is off until they turn it on. Then a small self-view shows with a clear
// "Camera on" label and, only if the model on this call can look at pictures (the server says so),
// a still picture (at most 512 px, JPEG) goes to the server every few seconds or on "Look at this".
// Nothing is recorded or kept on this device; the server keeps no copy either (src/video.ts).
import { serverText, t } from './naming.js';
import { CaptionLog, expressionFromText, fitWithin, formatCallTime, FramePacer } from './video-logic.js';

const $ = (s) => document.getElementById(s);

export class VideoCallView {
  /**
   * @param {{ presence: object, home: HTMLElement, onEnd: () => void, onMute: (muted: boolean) => boolean,
   *   onSound: (on: boolean) => boolean, onMinimize: () => void, onLook: () => Promise<void>, onCue: (expression: string|null) => void,
   *   onApprovalBack?: (card: HTMLElement) => void }} o
   */
  constructor(o) {
    this.o = o;
    this.root = $('video-call');
    this.captions = new CaptionLog({ maxLines: 2, maxChars: 200 });
    this.active = false;
    this.muted = false;
    this.sound = true;
    this.showCaptions = localStorage.getItem('sara.vc.captions') !== '0';
    this.camera = null;
    this.stream = null;
    this.timer = null;
    this.pacer = null;
    this.sending = false;
    $('vc-end').addEventListener('click', () => this.o.onEnd());
    $('vc-minimize').addEventListener('click', () => this.o.onMinimize());
    $('vc-mute').addEventListener('click', () => this.setMuted(!this.muted));
    $('vc-sound').addEventListener('click', () => this.setSound(!this.sound));
    $('vc-cc').addEventListener('click', () => this.setCaptions(!this.showCaptions));
    $('vc-camera').addEventListener('click', () => void (this.stream ? this.stopCamera() : this.startCamera()));
    $('vc-look').addEventListener('click', () => void this.o.onLook());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.o.onMinimize();
    });
  }

  /** Open the view for a call. `demo`: the demo server (camera off, refused there too). */
  async show({ conversationId, demo = false, name = 'Sara', status = '' }) {
    // Back from "Voice only" in the same call: the timer and the call's picture limits carry on.
    const again = this.startedFor === conversationId;
    this.conversationId = conversationId;
    this.demo = demo;
    this.active = true;
    if (!again) {
      this.startedFor = conversationId;
      this.startedAt = Date.now();
      this.captions.clear();
    }
    this.#renderCaptions();
    $('vc-name').textContent = name;
    $('vc-status').textContent = status || t('Connecting…');
    $('vc-notice').hidden = true;
    this.root.hidden = false;
    document.body.classList.add('in-video-call');
    $('vc-stage').append(this.o.presence.root);
    this.o.presence.root.classList.add('vc-presence');
    this.backdrop();
    this.setMuted(false, true);
    this.setSound(true, true);
    this.setCaptions(this.showCaptions);
    this.#tick();
    this.timer = setInterval(() => this.#tick(), 1000);
    this.wake = await navigator.wakeLock?.request?.('screen').catch(() => null);
    await this.refreshCamera(!again);
    $('vc-end').focus({ preventScroll: true });
  }

  /** Close it (the call ended or became voice-only). The camera stops; the server forgets the call's pictures. */
  hide({ keepCall = false } = {}) {
    if (!this.active) return;
    this.active = keepCall;
    this.stopCamera();
    clearInterval(this.timer);
    this.timer = null;
    this.root.hidden = true;
    document.body.classList.remove('in-video-call');
    this.o.presence.root.classList.remove('vc-presence');
    this.o.home.prepend(this.o.presence.root);
    // R2b: a card still waiting for an OK goes back into the chat.
    for (const card of [...$('vc-approvals').children]) this.o.onApprovalBack?.(card);
    this.wake?.release?.().catch(() => {});
    this.wake = null;
    this.o.onCue(null);
    if (!keepCall) {
      this.active = false;
      this.startedFor = null;
      if (this.conversationId && !this.demo) void fetch(`/api/video/${encodeURIComponent(this.conversationId)}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    }
  }

  get open() {
    return !this.root.hidden;
  }

  /** Her current look fills the background (the same picture as her portrait, blurred). */
  backdrop() {
    const src = this.o.presence.base?.src;
    if (src && $('vc-backdrop').src !== src) $('vc-backdrop').src = src;
  }

  /** R2b: an approval card on the call screen (the same card as in the chat; a tap answers it). */
  approval(card) {
    $('vc-approvals').append(card);
  }

  status(text) {
    $('vc-status').textContent = text ?? '';
  }

  /** The AI notice (at the start and every 3 hours) and crisis resources: shown on the call screen too. */
  notice(kind, text) {
    const el = $('vc-notice');
    el.textContent = text;
    el.dataset.kind = kind ?? '';
    el.hidden = false;
    clearTimeout(this.noticeTimer);
    // The AI notice stays a while; crisis help stays until the call ends.
    if (kind !== 'crisis') this.noticeTimer = setTimeout(() => (el.hidden = true), 12_000);
  }

  you(text, final) {
    this.captions.you(text, final);
    this.#renderCaptions();
  }

  her(piece) {
    this.captions.her(piece);
    this.#renderCaptions();
    // Her face follows what she is saying, for a moment.
    const cue = expressionFromText(this.captions.items.at(-1)?.text.slice(-120));
    if (cue && cue !== this.cue) {
      this.cue = cue;
      this.o.onCue(cue);
      this.backdrop();
      clearTimeout(this.cueTimer);
      this.cueTimer = setTimeout(() => {
        this.cue = null;
        this.o.onCue(null);
        this.backdrop();
      }, 6000);
    }
  }

  herDone(text) {
    this.captions.herDone(text);
    this.#renderCaptions();
  }

  setMuted(on, quiet = false) {
    const ok = quiet ? on : this.o.onMute(on);
    this.muted = Boolean(ok);
    const b = $('vc-mute');
    b.setAttribute('aria-pressed', String(this.muted));
    b.querySelector('small').textContent = this.muted ? t('Unmute') : t('Mute');
    b.querySelector('span').textContent = this.muted ? '🔇' : '🎙️';
    b.title = this.muted ? t('Your microphone is off. Press to talk again.') : t('Turn your microphone off');
  }

  setSound(on, quiet = false) {
    const ok = quiet ? on : this.o.onSound(on);
    this.sound = Boolean(ok);
    const b = $('vc-sound');
    b.setAttribute('aria-pressed', String(!this.sound));
    b.querySelector('span').textContent = this.sound ? '🔊' : '🔈';
    b.querySelector('small').textContent = this.sound ? t('Sound') : t('Sound off');
  }

  setCaptions(on) {
    this.showCaptions = Boolean(on);
    localStorage.setItem('sara.vc.captions', on ? '1' : '0');
    $('vc-cc').setAttribute('aria-pressed', String(this.showCaptions));
    $('vc-captions').hidden = !this.showCaptions;
  }

  /** Asks the server whether camera pictures can reach her on this call (and starts its limits). */
  async refreshCamera(start = false) {
    const id = encodeURIComponent(this.conversationId);
    try {
      const res = await fetch(`/api/video/${id}${start && !this.demo ? '/start' : ''}`, start && !this.demo ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
      this.camera = data.camera ?? { allowed: false, sees: false };
      this.settings = data.settings ?? { lookEvery: 10, perCall: 60 };
    } catch (err) {
      this.camera = { allowed: false, sees: false, message: err.message };
      this.settings = { lookEvery: 10, perCall: 60 };
    }
    if (start || !this.pacer) this.pacer = new FramePacer({ everySec: this.settings.lookEvery, perCall: this.settings.perCall });
    this.#renderCamera();
  }

  /** True while camera pictures go to the server (a classic call then sends the newest with what you say). */
  get sendsFrames() {
    return Boolean(this.stream && this.camera?.allowed && !this.demo);
  }

  async startCamera() {
    if (this.stream || this.demo) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (err) {
      this.stream = null;
      this.#camNote(err?.name === 'NotAllowedError' ? t('Camera: permission denied.') : t('Camera: {message}', { message: err?.message ?? '' }));
      return;
    }
    const v = $('vc-self-video');
    v.srcObject = this.stream;
    await v.play().catch(() => {});
    // The server may have changed its mind (another model, a setting): ask again when turned on.
    await this.refreshCamera(false);
    this.#renderCamera();
  }

  stopCamera() {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    const v = $('vc-self-video');
    if (v) v.srcObject = null;
    this.#renderCamera();
  }

  /** One picture to her (ask = "Look at this"). Returns true if it went. */
  async sendFrame(ask) {
    if (!this.sendsFrames || this.sending || !this.pacer) return false;
    const now = Date.now();
    if (ask ? !this.pacer.canAsk(now) : !this.pacer.due(now)) return false;
    const v = $('vc-self-video');
    if (!v.videoWidth) return false;
    this.sending = true;
    this.pacer.mark(now);
    try {
      const { width, height } = fitWithin(v.videoWidth, v.videoHeight, 512);
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d').drawImage(v, 0, 0, width, height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.72));
      if (!blob) return false;
      const res = await fetch(`/api/video/${encodeURIComponent(this.conversationId)}/frame${ask ? '?ask=1' : ''}`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Refused for good (a safety pause, private mode, the cap): stop sending and say why.
        if (res.status === 403 || res.status === 409) this.camera = { ...this.camera, allowed: false, message: data.errorKey ?? data.error, params: data.params };
        else if (res.status === 429 && /already looked/.test(String(data.errorKey ?? ''))) this.pacer.sent = this.pacer.perCall;
        this.#camNote(serverText(data, `HTTP ${res.status}`));
        this.#renderCamera(false);
        return false;
      }
      this.lastSentAt = now;
      this.#renderCamera();
      return true;
    } finally {
      this.sending = false;
    }
  }

  #tick() {
    $('vc-time').textContent = formatCallTime(Date.now() - this.startedAt);
    if (this.stream && this.camera?.allowed && this.pacer?.due(Date.now())) void this.sendFrame(false);
  }

  #camNote(text) {
    const el = $('vc-cam-note');
    el.textContent = text;
    el.hidden = !text;
  }

  #renderCamera(note = true) {
    const on = Boolean(this.stream);
    const b = $('vc-camera');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('small').textContent = on ? t('Camera off') : t('Camera');
    b.hidden = this.demo;
    $('vc-self').hidden = !on;
    this.root.classList.toggle('camera-on', on);
    const sees = on && this.camera?.allowed;
    $('vc-cam-state').textContent = !on ? '' : sees ? t('● Camera on · she can see it') : t('● Camera on · only you see it');
    $('vc-look').hidden = !sees || !this.pacer?.left;
    if (!note) return;
    if (this.demo) return this.#camNote(t('The camera is off on the demo server.'));
    if (!on) return this.#camNote('');
    if (!this.camera?.allowed) return this.#camNote(this.camera?.message ? serverText({ errorKey: this.camera.message, params: this.camera.params }) : t('Only you see your camera.'));
    const every = this.settings?.lookEvery ? t('every {n} seconds', { n: this.settings.lookEvery }) : t('only when you press Look at this');
    this.#camNote(t('She sees a still picture {every} (up to {cap} this call). Nothing is recorded.', { every, cap: this.settings?.perCall ?? 60 }));
  }

  #renderCaptions() {
    const box = $('vc-captions');
    box.replaceChildren(
      ...this.captions.lines().map((l) => {
        const p = document.createElement('p');
        p.className = `vc-line ${l.who}`;
        p.textContent = l.text;
        return p;
      }),
    );
  }
}
