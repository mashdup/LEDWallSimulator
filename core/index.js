/**
 * core/ — the DOM-free brain of the LED wall.
 *
 * Every module here runs identically under Node (tests) and in the browser
 * (renderer), because none of them touch DOM, fetch, or serial APIs.
 */

export { Panel, DEFAULT_COLS, DEFAULT_ROWS, BYTES_PER_PIXEL } from './panel.js';
export { Layout, LAYOUT_DEFAULTS, identity, layoutVariants } from './layout.js';
export { pack, packInto, packScaled, unpack } from './buffer.js';
export {
  FRAME_MAGIC,
  META_MAGIC,
  FRAME_END,
  LED_COUNT,
  RGB_BYTES,
  FRAME_BYTES,
  META_BYTES,
  MAX_SEQ,
  frame,
  encodeFrameInto,
  meta,
  nextSeq,
  FrameDecoder,
} from './frame.js';
export {
  WS2812_CHANNEL_MA,
  WS2812_LED_MA,
  estimateCurrentMa,
  currentAtBrightness,
  PowerBudget,
  PeakMeter,
} from './power.js';
export { downsampleArea, downsampleAreaRGB, blitArea } from './raster.js';
export { Scroller, bitmap, LEFT, RIGHT } from './scroller.js';
export { Panner, fitRect, fillRect, DOWN, UP } from './panner.js';
export {
  applyBrightness,
  blend,
  wipe,
  gradient,
  physicalIndexPattern,
} from './effects.js';
