const fs = require("fs");
const path = require("path");
const { net } = require("electron");

const IMG_SRC_RE = /(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/gi;

/** @type {Map<string, { dataUrl: string; at: number }>} */
const dataUrlCache = new Map();
const DATA_URL_CACHE_TTL_MS = 30 * 60_000;

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}

function bufferToDataUrl(buf, mime) {
  const safeMime = mime && mime.includes("/") ? mime.split(";")[0].trim() : "image/png";
  return `data:${safeMime};base64,${buf.toString("base64")}`;
}

async function readFileAsDataUrl(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (!buf.length) return "";
    return bufferToDataUrl(buf, mimeFromPath(filePath));
  } catch {
    return "";
  }
}

async function fetchUrlAsDataUrl(url) {
  const key = String(url || "").trim();
  if (!key) return "";
  const hit = dataUrlCache.get(key);
  if (hit && Date.now() - hit.at < DATA_URL_CACHE_TTL_MS) return hit.dataUrl;

  try {
    const res = await net.fetch(key);
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return "";
    const ct = res.headers.get("content-type") || "";
    const mime = ct.includes("/") ? ct.split(";")[0].trim() : "image/png";
    const dataUrl = bufferToDataUrl(buf, mime);
    if (dataUrl) dataUrlCache.set(key, { dataUrl, at: Date.now() });
    return dataUrl;
  } catch {
    return "";
  }
}

/** Resolve img src to an embeddable data URL for offline/file:// print windows. */
async function srcToDataUrl(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;
  if (raw.startsWith("file://")) {
    let filePath = raw.slice("file://".length);
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      /* keep as-is */
    }
    return readFileAsDataUrl(filePath);
  }
  if (/^https?:\/\//i.test(raw)) {
    return fetchUrlAsDataUrl(raw);
  }
  return "";
}

/**
 * Replace remote/file img src values with data URLs so logos render when the
 * receipt HTML is loaded from a temp file (file://) during silent print.
 */
async function inlineReceiptHtmlImages(html) {
  const input = String(html || "");
  if (!input.includes("<img")) return input;

  const replacements = [];
  let match;
  IMG_SRC_RE.lastIndex = 0;
  while ((match = IMG_SRC_RE.exec(input)) !== null) {
    const full = match[0];
    const prefix = match[1];
    const quote = match[2];
    const src = match[3];
    if (!src || src.startsWith("data:")) continue;
    const dataUrl = await srcToDataUrl(src);
    if (!dataUrl || dataUrl === src) continue;
    replacements.push({
      from: full,
      to: `${prefix}${quote}${dataUrl}${quote}`,
    });
  }

  if (!replacements.length) return input;

  let out = input;
  for (const { from, to } of replacements) {
    out = out.replace(from, to);
  }
  return out;
}

function clearReceiptImageCache() {
  dataUrlCache.clear();
}

module.exports = { inlineReceiptHtmlImages, srcToDataUrl, clearReceiptImageCache };
