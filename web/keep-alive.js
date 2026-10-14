/**
 * startKeepAlive — stop Chrome from throttling this tab to ~1 Hz in the
 * background.
 *
 * Chrome 88+ aligns timers in hidden tabs to ~1 Hz, and that throttling
 * reaches the tab's WORKERS too — a hidden page's worker clock fires at 1 Hz,
 * which starves the wall stream and freezes the content canvas. The documented
 * exemption is audio: a page with an active audio stream is not throttled.
 *
 * The escape is a WebAudio stream that is inaudible in practice: an
 * oscillator into a gain of ~0 (10 microwatts of effective amplitude). The
 * audio graph is live, the exemption applies, the room hears nothing.
 *
 * Autoplay policy: an AudioContext starts suspended until a user gesture, so
 * call this from a click the human already performs (Connect, demo, any
 * first interaction). It is idempotent: one stream per page.
 */
let ctx = null;

export function startKeepAlive() {
  if (ctx !== null) return ctx;
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.00001;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  // A gesture-driven call is the moment the context may resume; be explicit
  // so it works even when the gesture arrived via a synthetic click.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
