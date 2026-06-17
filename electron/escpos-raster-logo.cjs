const { nativeImage } = require("electron");
const { toAsciiSafe, ESCPOS_TAIL_FEED } = require("./escpos-buffer.cjs");

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

function rowHasInk(raster, y, bytesPerRow) {
  const start = y * bytesPerRow;
  for (let i = 0; i < bytesPerRow; i++) {
    if (raster[start + i]) return true;
  }
  return false;
}

/** Drop blank rows above/below the logo so thermal paper does not feed empty space. */
function trimRasterVertical(raster, width, height, bytesPerRow) {
  let top = 0;
  let bottom = height - 1;
  while (top < height && !rowHasInk(raster, top, bytesPerRow)) top++;
  while (bottom >= top && !rowHasInk(raster, bottom, bytesPerRow)) bottom--;
  if (top > bottom) {
    return { raster: Buffer.alloc(0), width, height: 0, bytesPerRow };
  }
  const trimmedHeight = bottom - top + 1;
  const trimmed = Buffer.alloc(bytesPerRow * trimmedHeight);
  raster.copy(trimmed, 0, top * bytesPerRow, (bottom + 1) * bytesPerRow);
  return { raster: trimmed, width, height: trimmedHeight, bytesPerRow };
}

function cropRgbaToInkBounds(width, height, rgba) {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const gray = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
      const alpha = rgba[i + 3] / 255;
      if (alpha > 0.15 && gray < 235) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < top || right < left) return null;
  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const cropped = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    const srcStart = ((top + y) * width + left) * 4;
    rgba.copy(cropped, y * cropW * 4, srcStart, srcStart + cropW * 4);
  }
  return { width: cropW, height: cropH, rgba: cropped };
}

/**
 * Returns null when the image cannot be decoded.
 */
function buildEscPosRasterFromDataUrl(dataUrl, maxWidthMm = 72, maxHeightMm = 45) {
  const src = String(dataUrl || "").trim();
  if (!src.startsWith("data:")) return null;

  const img = nativeImage.createFromDataURL(src);
  if (!img || img.isEmpty()) return null;

  const size = img.getSize();
  if (!size.width || !size.height) return null;

  let workImg = img;
  const initialRgba = img.getBitmap();
  if (initialRgba && initialRgba.length) {
    const cropped = cropRgbaToInkBounds(size.width, size.height, initialRgba);
    if (cropped) {
      workImg = nativeImage.createFromBitmap(cropped.rgba, {
        width: cropped.width,
        height: cropped.height,
      });
    }
  }

  const workSize = workImg.getSize();
  if (!workSize.width || !workSize.height) return null;

  const maxW = Math.max(8, Math.round(Number(maxWidthMm || 72) * DOTS_PER_MM));
  const maxH = Math.max(8, Math.round(Number(maxHeightMm || 45) * DOTS_PER_MM));
  const scale = Math.min(maxW / workSize.width, maxH / workSize.height, 1);
  const width = Math.max(1, Math.round(workSize.width * scale));
  const height = Math.max(1, Math.round(workSize.height * scale));

  const resized =
    width === workSize.width && height === workSize.height
      ? workImg
      : workImg.resize({ width, height });
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
  const trimmed = trimRasterVertical(
    centered.raster,
    centered.width,
    height,
    centered.bytesPerRow,
  );
  if (!trimmed.height) return null;

  const outWidth = trimmed.width;
  const outBytesPerRow = trimmed.bytesPerRow;
  const outRaster = trimmed.raster;
  const outHeight = trimmed.height;

  const xL = outBytesPerRow & 0xff;
  const xH = (outBytesPerRow >> 8) & 0xff;
  const yL = outHeight & 0xff;
  const yH = (outHeight >> 8) & 0xff;

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
  chunks.push(ESCPOS_TAIL_FEED);
  chunks.push(Buffer.from([0x1d, 0x56, 0x00]));
  return Buffer.concat(chunks);
}

module.exports = {
  buildEscPosRasterFromDataUrl,
  buildEscPosReceiptWithLogo,
};
