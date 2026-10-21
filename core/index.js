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
  OFFSET_RGB,
  frame,
  encodeFrameInto,
  meta,
  nextSeq,
  sameBytes,
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
export { applyBrightness, blend, wipe, gradient } from './effects.js';
export {
  applyColor,
  gammaTable,
  COLOR_DEFAULTS,
  SATURATION_RANGE,
  GAMMA_RANGE,
  TYPICAL_GAMMA,
} from './color.js';
export {
  GRID,
  PIXEL_BYTES,
  PIXEL_HEX_LEN,
  emptyPixels,
  pixelsFromHex,
  pixelsToHex,
  isPixelHex,
  parseColor,
  floodFill,
  newDrawing,
  validateEntry,
} from './drawings.js';
// The store and the guards are the two servers' shared machinery. Exported
// here for symmetry with the rest of core/, and DOM-free like the rest of it:
// a browser page must not import them, and the guest page's test is what keeps
// that true.
export { DrawingStore } from './drawing-store.js';
export { clientAddr, deviceKey, makeAuth, makeRateGate, resolveToken, safeEqual } from './guards.js';
export {
  CALIBRATION_PATTERNS,
  CALIBRATION_TIMING,
  WALL_TIMING,
  INDEX_MAP_LEGEND,
  INDEX_MAP_GROUP,
  patternColor,
  patternPace,
  calibrationPattern,
  calibrationPhysicalBytes,
} from './calibration.js';
