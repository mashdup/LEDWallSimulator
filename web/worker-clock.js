/**
 * createClock — a frame clock that survives a hidden tab.
 *
 * Chromium throttles timers in a hidden tab to ~1 Hz (and rAF stops entirely),
 * which starves the wall the moment the app tab stops being the front tab:
 * the stream crawls, the firmware watchdog fades the panel, and a content
 * page's animation freezes. Workers are exempt from background throttling,
 * and their postMessage handlers run at full rate on the main thread — so
 * the tempo lives in a worker and the main thread just draws and sends.
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
