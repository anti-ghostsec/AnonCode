/**
 * Dependency-free image inspection.
 *
 * Reads just enough of a file's header to determine format and pixel
 * dimensions, without decoding the image or pulling in a native library.
 * This lets AnonCode check an image against a provider's size limits BEFORE
 * sending it — which is how we stop the "image too small -> model refuses ->
 * agent retries forever" loop at its source.
 *
 * Supported: PNG, JPEG, GIF, BMP, WebP (VP8/VP8L/VP8X).
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "bmp" | "webp";

export type ImageInfo = {
  format: ImageFormat;
  width: number;
  height: number;
};

export function inspectImage(buf: Buffer): ImageInfo | null {
  return (
    png(buf) ?? gif(buf) ?? bmp(buf) ?? webp(buf) ?? jpeg(buf) ?? null
  );
}

function png(b: Buffer): ImageInfo | null {
  // 8-byte signature, then IHDR: width/height are big-endian at offsets 16/20.
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): ImageInfo | null {
  if (b.length < 10) return null;
  if (b.toString("ascii", 0, 3) !== "GIF") return null;
  return { format: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function bmp(b: Buffer): ImageInfo | null {
  if (b.length < 26) return null;
  if (b.toString("ascii", 0, 2) !== "BM") return null;
  // BITMAPINFOHEADER: signed width/height (LE) at offsets 18/22.
  return { format: "bmp", width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30) return null;
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const fmt = b.toString("ascii", 12, 16);
  if (fmt === "VP8 ") {
    // Lossy: dimensions are 14-bit LE at offset 26/28 (after a 3-byte start code).
    const w = b.readUInt16LE(26) & 0x3fff;
    const h = b.readUInt16LE(28) & 0x3fff;
    return { format: "webp", width: w, height: h };
  }
  if (fmt === "VP8L") {
    // Lossless: 14-bit dimensions packed after the 0x2f signature byte.
    const bits = b.readUInt32LE(21);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return { format: "webp", width: w, height: h };
  }
  if (fmt === "VP8X") {
    // Extended: 24-bit (minus one) canvas dimensions at offset 24/27.
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return { format: "webp", width: w, height: h };
  }
  return null;
}

function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1]!;
    // SOF0..SOF15 carry frame dimensions (skip DHT/DAC/RST/SOS 0xC4,0xC8,0xCC).
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      // segment: FF marker, 2-byte length, 1-byte precision, 2-byte height, 2-byte width
      const height = b.readUInt16BE(off + 5);
      const width = b.readUInt16BE(off + 7);
      return { format: "jpeg", width, height };
    }
    const segLen = b.readUInt16BE(off + 2);
    off += 2 + segLen;
  }
  return null;
}
