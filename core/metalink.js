/**
 * metaDelivery — the bookkeeping of "what the wall has been told".
 *
 * The meta record (frame.js) carries the global brightness the ESP32 applies
 * at the sink. The app loop sends it on change, and the device REMEMBERS it
 * for the rest of its uptime. Two field facts break the naive "send on
 * change" rule, and this state machine is the fix for both:
 *
 *   - The serial sink reconnects ITSELF: a bright frame sags USB, the port
 *     re-enumerates, the watcher reopens it without the app loop noticing
 *     (sinks.js). The ESP32 power-cycled on the way out, and its firmware
 *     boots at the DEFAULT brightness - the meta record it was told is gone.
 *     The app still believes the wall knows the number, so the wall runs
 *     full-bright and the slider looks dead. Link coming back must mean
 *     "the wall has never heard our brightness".
 *
 *   - A meta record sent while the cable is out is REFUSED (send() returns
 *     false). Latching it as "told" would drop the number on the floor and
 *     never retry, so a slider moved during a dark window would be lost
 *     even if the link never power-cycled the device.
 *
 * `owed` is the whole contract: while a number is owed, the loop sends.
 */
export function metaDelivery() {
  /** The brightness the wall currently believes; -1 = nothing. */
  let lastBr = -1;
  /** Whether the sink link was up on the last note. */
  let linkUp = true;
  return {
    /**
     * Feed the sink's connected state every frame. Returns true when the
     * link came BACK (went down, now up): the device has rebooted and
     * forgotten the meta record, so everything is owed again.
     */
    noteLink(connected) {
      if (!connected) {
        linkUp = false;
        return false;
      }
      if (linkUp) return false;
      linkUp = true;
      lastBr = -1;
      return true;
    },
    /** Must a meta record with this brightness go out now? */
    owed(br) {
      return br !== lastBr;
    },
    /**
     * Record the send outcome. `accepted` false (a refused write, a sink
     * not open) keeps the number owed so the next frame retries; anything
     * else (true, or a non-transport sink returning undefined) counts as
     * told.
     */
    told(br, accepted) {
      lastBr = accepted ? br : -1;
    },
    /** The brightness last latched, for readouts and tests. */
    get last() {
      return lastBr;
    },
  };
}
