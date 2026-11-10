// A1: one Web Audio tap on her voice (the speaker's <audio> element), shared by the call screen
// (web/presence.js) and the living portrait everywhere else (web/avatar.js). An element can be routed
// through Web Audio only once, so everything that wants her loudness asks here. Create it inside a user
// gesture (a click), so the context starts running and her voice is not silenced.
let tap = null;

/** The tap on `audio` ({ ctx, analyser, vol }), made on first use; null without Web Audio. */
export function voiceTap(audio) {
  if (tap) {
    if (tap.ctx.state === 'suspended') tap.ctx.resume?.().catch?.(() => {});
    return tap.audio === audio ? tap : null;
  }
  try {
    const ctx = new AudioContext();
    // Outside a gesture the context starts suspended: routing her voice through it would silence it.
    if (ctx.state !== 'running') {
      void ctx.close?.().catch?.(() => {});
      return null;
    }
    const src = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    // Phase 69: her volume after the analyser (sound off on a video call keeps her lips moving).
    const vol = ctx.createGain();
    analyser.connect(vol);
    vol.connect(ctx.destination);
    tap = { audio, ctx, analyser, vol };
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
    return tap;
  } catch {
    return null;
  }
}

/** The tap if one was made (never makes one). */
export const currentTap = () => tap;
