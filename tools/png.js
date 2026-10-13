/**
 * png.js — decode the PNGs this project produces, in Node.
 *
 * tools/capture.js only ever reads a PNG's IHDR: it hands the bytes to the
 * browser, which decodes them itself. So anything that wants to know WHICH
 * pixels a page produced has to decode in Node, and asserting pixels is the
 * only way to prove a capture route carried a real image rather than a
 * plausible-looking one.
 *
 * Lives in tools/ rather than test/ because both sides need it: the suites
 * assert what Chromium returned, and tools/bridge.js turns a captured page into
 * frames for the wall. test/harness.js re-exports these (the same way it
 * re-exports freePort) so existing suites keep importing one plumbing module.
 */

import { inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read the real pixel size out of a PNG's IHDR so reported dims match the bytes. */
export function pngSize(png) {
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/**
 * Decode an 8-bit RGB/RGBA/grey PNG to a flat pixel array.
 *
 * Only what Chromium actually emits is supported: 8-bit, non-interlaced, colour
 * types 0/2/6, and all five scanline filters (None/Sub/Up/Average/Paeth — Chrome's
 * encoder mixes them within one image, so a decoder that assumes filter 0 reads
 * garbage). Anything else throws rather than returning wrong pixels, because a
 * silently wrong decode would make a pixel assertion pass or fail for the wrong
 * reason.
 *
 * @param {Buffer} png
 * @returns {{w: number, h: number, channels: number, pixels: Uint8Array}}
 */
export function decodePng(png) {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }

  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  for (let o = 8; o + 8 <= png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    o += 12 + len;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error(`interlaced PNG not supported (interlace=${interlace})`);
  if (!(w > 0) || !(h > 0)) throw new Error(`bad PNG dimensions ${w}x${h}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) {
    throw new Error(`PNG data too short: got ${raw.length} bytes, need ${h * (stride + 1)}`);
  }

  const pixels = new Uint8Array(w * h * channels);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const byte = raw[src + i];
      // `a`/`b`/`c` are the already-reconstructed left, up and up-left bytes.
      const a = i >= channels ? pixels[dst + i - channels] : 0;
      const b = y > 0 ? pixels[prev + i] : 0;
      const c = y > 0 && i >= channels ? pixels[prev + i - channels] : 0;
      switch (filter) {
        case 0: pixels[dst + i] = byte; break;
        case 1: pixels[dst + i] = (byte + a) & 255; break;
        case 2: pixels[dst + i] = (byte + b) & 255; break;
        case 3: pixels[dst + i] = (byte + ((a + b) >> 1)) & 255; break;
        case 4: pixels[dst + i] = (byte + paeth(a, b, c)) & 255; break;
        default: throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
      }
    }
  }

  return { w, h, channels, pixels };
}

/**
 * Flat RGB from a decoded PNG, so a raster can be handed to core/ without an alpha
 * channel being invented by the caller.
 */
export function rgbOf(decoded) {
  const { w, h, channels, pixels } = decoded;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += channels) {
    rgb[i * 3] = pixels[j];
    rgb[i * 3 + 1] = pixels[j + 1];
    rgb[i * 3 + 2] = pixels[j + 2];
  }
  return rgb;
}

/** RGBA copy of a decoded PNG, alpha forced opaque — what a browser page paints. */
export function rgbaOf(decoded) {
  const { w, h, channels, pixels } = decoded;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += channels) {
    rgba[i * 4] = pixels[j];
    rgba[i * 4 + 1] = pixels[j + 1];
    rgba[i * 4 + 2] = pixels[j + 2];
    rgba[i * 4 + 3] = channels === 4 ? pixels[j + 3] : 255;
  }
  return rgba;
}
