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
export { metaDelivery } from './metalink.js';
export { downsampleArea, downsampleAreaRGB, blitArea } from './raster.js';
export { Scroller, bitmap, LEFT, RIGHT } from './scroller.js';
export { Panner, fitRect, fillRect, DOWN, UP } from './panner.js';
export { applyBrightness, blend, wipe, gradient } from './effects.js';
export {
  applyColor,
  gammaTable,
  whiteBalanceGains,
  COLOR_DEFAULTS,
  SATURATION_RANGE,
  GAMMA_RANGE,
  TEMPERATURE_RANGE,
  TINT_RANGE,
  BLACK_LEVEL_RANGE,
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
// NOTE: drawing-store.js and guards.js are deliberately NOT re-exported here.
// core/index.js is what the BROWSER imports (web/app.js), and those two modules
// are server-side: node:fs, node:crypto, node:path. Re-exporting them makes the
// browser's module graph reach for Node built-ins and the console stops booting
// — silently, as a missing module in a page nobody is watching. Node code
// imports them directly: `../core/guards.js`, `../core/drawing-store.js`.
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
