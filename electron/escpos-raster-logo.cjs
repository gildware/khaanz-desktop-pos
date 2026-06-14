const { nativeImage } = require("electron");
const { toAsciiSafe } = require("./escpos-buffer.cjs");

/** ~203 DPI thermal — 8 dots per mm on 80mm paper. */
const DOTS_PER_MM = 8;
/** Match receipt CSS width (80mm roll, full printable area). */
const PRINTABLE_WIDTH_DOTS = Math.round(80 * DOTS_PER_MM);

function centerRasterHorizontally(raster, imageWidth, imageHeight, bytesPerRow) {
  if (imageWidth >= PRINTABLE_WIDTH_DOTS) {
    return { raster, width: imageWidth, bytesPerRow };
  }
  const leftPad = Math.floor((PRINTABLE_WIDTH_DOTS - imageWidth) / 2);
  const centeredWidth = PRINTABLE_WIDTH_DOTS;
  const centeredBytesPerRow = Math.ceil(centeredWidth / 8);
  const centered = Buffer.alloc(centeredBytesPerRow * imageHeight);

  for (let y = 0; y < imageHeight; y++) {
    for (let x = 0; x < imageWidth; x++) {
      const srcByte = raster[y * bytesPerRow + (x >> 3)];
      if ((srcByte >> (7 - (x & 7))) & 1) {
        const destX = leftPad + x;
        centered[y * centeredBytesPerRow + (destX >> 3)] |= 0x80 >> (destX & 7);
      }
    }
  }

  return {
    raster: centered,
    width: centeredWidth,
    bytesPerRow: centeredBytesPerRow,
  };
}

/**
 * Build ESC/POS GS v 0 raster strip from a data URL (PNG/JPEG/WebP).
 * Returns null when the image cannot be decoded.
 */
function buildEscPosRasterFromDataUrl(dataUrl, maxWidthMm = 72, maxHeightMm = 45) {
  const src = String(dataUrl || "").trim();
  if (!src.startsWith("data:")) return null;

  const img = nativeImage.createFromDataURL(src);
  if (!img || img.isEmpty()) return null;

  const size = img.getSize();
  if (!size.width || !size.height) return null;

  const maxW = Math.max(8, Math.round(Number(maxWidthMm || 72) * DOTS_PER_MM));
  const maxH = Math.max(8, Math.round(Number(maxHeightMm || 45) * DOTS_PER_MM));
  const scale = Math.min(maxW / size.width, maxH / size.height, 1);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));

  const resized = width === size.width && height === size.height ? img : img.resize({ width, height });
  const rgba = resized.getBitmap();
  if (!rgba || !rgba.length) return null;

  const bytesPerRow = Math.ceil(width / 8);
  const raster = Buffer.alloc(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const gray = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
      const alpha = rgba[i + 3] / 255;
      const ink = alpha > 0.15 && gray < 200;
      if (ink) {
        raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  const centered = centerRasterHorizontally(raster, width, height, bytesPerRow);
  const outWidth = centered.width;
  const outBytesPerRow = centered.bytesPerRow;
  const outRaster = centered.raster;

  const xL = outBytesPerRow & 0xff;
  const xH = (outBytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;

  return Buffer.concat([
    Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]),
    outRaster,
    Buffer.from([0x0a]),
  ]);
}

/** One-shot ESC/POS job: init, optional logo raster, plain-text body, feed + cut. */
function buildEscPosReceiptWithLogo(text, logoDataUrl, dims = {}) {
  const chunks = [Buffer.from([0x1b, 0x40])];
  const raster = buildEscPosRasterFromDataUrl(
    logoDataUrl,
    dims.logoMaxWidthMm,
    dims.logoMaxHeightMm,
  );
  if (raster) chunks.push(raster);

  const safe = toAsciiSafe(text).trim();
  const lines = safe.length ? safe.split("\n") : ["(empty)"];
  for (const line of lines) {
    chunks.push(Buffer.from(line, "ascii"));
    chunks.push(Buffer.from([0x0a]));
  }
  chunks.push(Buffer.from([0x0a, 0x0a, 0x0a]));
  chunks.push(Buffer.from([0x1d, 0x56, 0x00]));
  return Buffer.concat(chunks);
}

module.exports = {
  buildEscPosRasterFromDataUrl,
  buildEscPosReceiptWithLogo,
};
