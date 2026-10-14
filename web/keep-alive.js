/**
 * startKeepAlive — stop Chrome from throttling this tab in the background.
 *
 * Chrome throttles hidden tabs in two tiers, and the wall needs an escape
 * from BOTH:
 *
 * 1. Standard throttling (immediate when hidden): timers align to ~1 Hz,
 *    and it reaches the tab's WORKERS too - a hidden page's worker clock
 *    fires at 1 Hz, which starves the wall stream. Exemption: a tab Chrome
 *    MEASURES as playing audio (amplitude-based, floor around -50 dB). An
 *    oscillator at 0.02 gain (-34 dB) at 19.5 kHz clears the floor and
 *    stays below most adults' hearing. The original 1e-5 gain (-100 dB)
 *    was below the floor: Chrome heard nothing and throttled anyway
 *    (measured: 4.4 fps hidden vs 32 fps visible).
 *
 * 2. Intensive throttling (after ~5 minutes hidden): timers drop to ONE
 *    wake-up per minute. The symptom is exactly that: smooth for a few
 *    minutes, then 1 Hz. The documented escape is active media playback -
 *    a playing <audio>/<video> element is the stronger, explicitly
 *    documented exemption for this tier.
 *
 * So the keep-alive is both: the WebAudio sine for tier 1, and a looping
 * <audio> element playing the same inaudible tone for tier 2. The tone is
 * a 1-second 19.5 kHz WAV generated at runtime (no asset, no network).
 *
 * Autoplay policy: AudioContext and media playback both need a user gesture,
 * so call this from a click the human already performs (Connect, demo, any
 * first interaction). It is idempotent: one keep-alive per page.
 *
 * If the tone is audible to you, lower KEEP_ALIVE_GAIN toward 0.005 - still
 * above Chrome's ~-50 dB audible floor, so the exemption survives.
 */
const KEEP_ALIVE_GAIN = 0.02;
const KEEP_ALIVE_FREQ = 19500;
let ctx = null;
let tone = null;

/**
 * A 1-second sine WAV as a data URI, built at runtime: 44-byte header plus
 * 16-bit PCM samples. 19.5 kHz at 0.02 amplitude - audible to Chrome's
 * volume analysis, inaudible in the room.
 */
function makeToneWav(freq, seconds, amplitude, rate = 44100) {
  const n = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt chunk size
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);    // byte rate
  v.setUint16(32, 2, true);           // block align
  v.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767), true);
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

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
  // Tier 2: a looping media element. A playing <audio> element is the
  // documented exemption from Chrome's INTENSIVE throttling (1 wake-up per
  // minute after ~5 minutes hidden) - the tier the AudioContext sine alone
  // does not reliably escape.
  try {
    tone = new Audio(makeToneWav(KEEP_ALIVE_FREQ, 1, KEEP_ALIVE_GAIN));
    tone.loop = true;
    tone.volume = 1; // the amplitude is baked into the samples
    tone.play().catch(() => {});
  } catch {
    tone = null; // media element unavailable: tier-1 exemption still applies
  }
  return ctx;
}
