/**
 * startKeepAlive — stop Chrome from throttling this tab to ~1 Hz in the
 * background.
 *
 * Chrome 88+ aligns timers in hidden tabs to ~1 Hz, and that throttling
 * reaches the tab's WORKERS too — a hidden page's worker clock fires at 1 Hz,
 * which starves the wall stream and freezes the content canvas. The documented
 * exemption is audio: a page with an active audio stream is not throttled.
 *
 * The escape is a WebAudio stream Chrome measures as audible: an oscillator
 * at ~0.02 gain (-34 dB) and 19.5 kHz. Chrome's exemption is amplitude-based
 * with a floor around -50 dB, so the original 1e-5 (-100 dB) was heard by
 * nothing - Chrome throttled the hidden tab anyway (measured: 4.4 fps hidden
 * vs 32 fps visible). 19.5 kHz at -34 dB is above Chrome's floor and below
 * most adults' hearing. If it is audible to you, lower the gain toward 0.005
 * (still above the floor) - trade comfort for exemption.
 *
 * Autoplay policy: an AudioContext starts suspended until a user gesture, so
 * call this from a click the human already performs (Connect, demo, any
 * first interaction). It is idempotent: one stream per page.
 */
const KEEP_ALIVE_GAIN = 0.02;
const KEEP_ALIVE_FREQ = 19500;
let ctx = null;

export function startKeepAlive() {
  if (ctx !== null) return ctx;
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  const osc = ctx.createOscillator();
  osc.frequency.value = KEEP_ALIVE_FREQ;
  const gain = ctx.createGain();
  gain.gain.value = KEEP_ALIVE_GAIN;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  // A gesture-driven call is the moment the context may resume; be explicit
  // so it works even when the gesture arrived via a synthetic click.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
