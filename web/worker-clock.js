/**
 * createClock — a frame clock that keeps its tempo off the main thread.
 *
 * Chromium throttles timers in a hidden tab to ~1 Hz (and rAF stops
 * entirely), which starves the wall the moment the app tab stops being the
 * front tab: the stream crawls, the firmware watchdog fades the panel, and a
 * content page's animation freezes. Moving the tempo into a worker keeps it
 * jitter-free, but be honest about the limit: Chrome 88+ throttles the
 * WORKERS of a hidden page to ~1 Hz as well. The in-page escape from that is
 * the audio exemption (see keep-alive.js); the out-of-browser escape is
 * tools/bridge.js, which streams from Node where no browser policy applies.
 *
 * The worker is a Blob: no extra file to serve, no path to get wrong.
 */
export function createClock(periodMs) {
  if (!(periodMs > 0)) throw new RangeError(`createClock: periodMs must be > 0, got ${periodMs}`);
  const source =
    'let id=null;self.onmessage=(e)=>{' +
    "if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage(0)," + periodMs + ');}' +
    "else if(e.data==='stop'){clearInterval(id);id=null;}};";
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);

  const clock = {
    /** Called on every tick; assign before start(). */
    onTick: null,
    start() {
      worker.onmessage = () => clock.onTick?.();
      worker.postMessage('start');
      return clock;
    },
    stop() {
      worker.postMessage('stop');
      return clock;
    },
    terminate() {
      worker.terminate();
    },
  };
  return clock;
}
