/**
 * frame — the wire protocol. Fixed-size, self-clocking, drop-safe.
 *
 * Frame (1203 bytes):
 *   0xA5 | seq u8 | 1200 bytes RGB in PHYSICAL LED order | 0x5A
 *
 * Meta (5 bytes):
 *   0xA4 | brightness u8 | limitMa u16 LE | 0x5A
 *
 * Note on the size: plan.md says "Total 1204 bytes", but the fields it lists
 * (magic + seq + 1200 RGB + end) sum to 1203. The field list is what the
 * firmware has to count, so 1203 is authoritative here.
 *
 * A partial frame is discarded, so a dropped byte never corrupts the wall.
 * Baud 921600.
 *
 * No DOM, no browser APIs — the same encoder runs in Node tests and in the page.
 */

export const FRAME_MAGIC = 0xa5;
export const META_MAGIC = 0xa4;
export const FRAME_END = 0x5a;

export const LED_COUNT = 400;
export const RGB_BYTES = LED_COUNT * 3; // 1200

/** Bytes after the frame magic: seq + RGB + end. */
export const FRAME_BODY = 1 + RGB_BYTES + 1;
export const FRAME_BYTES = 1 + FRAME_BODY; // 1203

/** Bytes after the meta magic: brightness + limitMa lo + limitMa hi + end. */
export const META_BODY = 4;
export const META_BYTES = 1 + META_BODY; // 5

export const OFFSET_SEQ = 1;
export const OFFSET_RGB = 2;
export const OFFSET_END = FRAME_BYTES - 1; // 1202

export const MAX_SEQ = 255;

/** seq is a uint8 and wraps; 255 -> 0. */
export function nextSeq(seq) {
  return (seq + 1) & MAX_SEQ;
}

/**
 * Encode one frame into a reusable buffer. `physicalBytes` must already be in
 * physical LED order (i.e. the output of buffer.pack()).
 */
export function encodeFrameInto(out, seq, physicalBytes) {
  if (out.length !== FRAME_BYTES) {
    throw new RangeError(`frame buffer must be ${FRAME_BYTES} bytes, got ${out.length}`);
  }
  if (physicalBytes.length !== RGB_BYTES) {
    throw new RangeError(`expected ${RGB_BYTES} RGB bytes, got ${physicalBytes.length}`);
  }
  out[0] = FRAME_MAGIC;
  out[OFFSET_SEQ] = seq & MAX_SEQ;
  out.set(physicalBytes, OFFSET_RGB);
  out[OFFSET_END] = FRAME_END;
  return out;
}

export function frame(seq, physicalBytes) {
  return encodeFrameInto(new Uint8Array(FRAME_BYTES), seq, physicalBytes);
}

/**
 * Meta frame: global brightness + power budget.
 * @param {{brightness?: number, limitMa?: number}} opts
 */
export function meta({ brightness = 255, limitMa = 8000 } = {}) {
  const b = clamp(brightness | 0, 0, 255);
  const limit = clamp(limitMa | 0, 0, 0xffff);
  const out = new Uint8Array(META_BYTES);
  out[0] = META_MAGIC;
  out[1] = b;
  out[2] = limit & 0xff;
  out[3] = (limit >> 8) & 0xff;
  out[4] = FRAME_END;
  return out;
}

/**
 * FrameDecoder — validated decode, shared by the sim's WebSocket sink and any
 * Node-side bridge, so both sides agree on what a "complete frame" means.
 *
 * Chunking-agnostic: a frame may arrive split across any number of chunks.
 * Garbage between frames is skipped. A frame whose end byte is wrong is
 * discarded whole and never rendered.
 *
 * Resync: a discarded frame's payload usually contains the magic byte of the
 * frame that was really coming — that is exactly what a single dropped byte
 * does. The decoder rewinds to that magic and rescans, so one lost byte costs
 * one frame instead of cascading into a run of black frames. Rewinds are
 * budgeted per chunk, so payload full of 0xA5 bytes cannot make this quadratic.
 */
export class FrameDecoder {
  constructor() {
    this.body = new Uint8Array(FRAME_BODY);
    this.state = 'idle';
    this.n = 0;
    /** Rewinds allowed per feed(), so 0xA5-heavy payload can't go quadratic. */
    this.maxRewinds = 8;
    this.stats = { frames: 0, meta: 0, discarded: 0, resyncs: 0, rewinds: 0, gaps: 0 };
    /** Last accepted frame's seq, so a dropped frame is visible to the sink. */
    this.lastSeq = null;
  }

  reset() {
    this.state = 'idle';
    this.n = 0;
    this.lastSeq = null;
  }

  /**
   * @param {Uint8Array} chunk
   * @param {(f: {seq:number, rgb:Uint8Array}) => void} [onFrame]
   * @param {(m: {brightness:number, limitMa:number}) => void} [onMeta]
   * @returns {Array<object>} validated frames/meta, in arrival order
   */
  feed(chunk, onFrame, onMeta) {
    const out = [];
    const body = this.body;
    /**
     * Segments still to consume, in wire order. A rewind inserts the replayed
     * tail of a discarded record ahead of the live bytes that follow it.
     */
    const queue = [chunk];
    let rewinds = this.maxRewinds;

    while (queue.length > 0) {
      const buf = queue.shift();

      for (let i = 0; i < buf.length; i++) {
        const byte = buf[i];

        if (this.state === 'idle') {
          if (byte === FRAME_MAGIC) this.state = 'frame';
          else if (byte === META_MAGIC) this.state = 'meta';
          else this.stats.resyncs++;
          this.n = 0;
          continue;
        }

        const need = this.state === 'frame' ? FRAME_BODY : META_BODY;
        const take = Math.min(need - this.n, buf.length - i);
        body.set(buf.subarray(i, i + take), this.n);
        this.n += take;
        i += take - 1; // the loop's i++ lands on the byte after the run

        if (this.n < need) break; // record spans segments; resume on the next

        if (body[need - 1] === FRAME_END) {
          if (this.state === 'frame') {
            const seq = body[0];
            if (this.lastSeq !== null && seq !== nextSeq(this.lastSeq)) this.stats.gaps++;
            this.lastSeq = seq;
            const f = { seq, rgb: body.subarray(1, 1 + RGB_BYTES).slice() };
            this.stats.frames++;
            out.push(f);
            onFrame?.(f);
          } else {
            const m = { brightness: body[0], limitMa: body[1] | (body[2] << 8) };
            this.stats.meta++;
            out.push(m);
            onMeta?.(m);
          }
          this.state = 'idle';
          this.n = 0;
          continue;
        }

        // Bad end byte: the record is suspect, so throw the whole thing away.
        this.stats.discarded++;
        this.state = 'idle';
        this.n = 0;

        // A discarded record's own bytes usually hold the magic of the frame
        // that was really coming — that is exactly what one dropped byte looks
        // like. Re-scan the record (including the byte that failed the end
        // check) and replay from the next magic onward, ahead of the live tail.
        let found = -1;
        for (let k = 1; k < need; k++) {
          if (body[k] === FRAME_MAGIC || body[k] === META_MAGIC) {
            found = k;
            break;
          }
        }
        if (found >= 0 && rewinds-- > 0) {
          this.stats.rewinds++;
          this.stats.resyncs++;
          queue.unshift(body.slice(found), buf.subarray(i + 1));
          break; // resume from the replayed magic, then the live tail
        }
      }
    }

    return out;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
