/** Build print payloads for 80mm thermal printers. */

function toAsciiSafe(text) {
  return String(text)
    .replace(/\u20b9/g, "Rs.")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n\t\x20-\x7e]/g, "?");
}

/** Plain TEXT for WinSpool TEXT datatype (no ESC bytes). */
function buildPlainTextBuffer(text) {
  return Buffer.from(`${toAsciiSafe(text).trim()}\n\n\n\n\n`, "ascii");
}

/** Trailing line feeds before cut — extra space after footer for easy tearing. */
const ESCPOS_TAIL_FEED = Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a]);
const ESCPOS_BOLD_ON = Buffer.from([0x1b, 0x45, 0x01]);
const ESCPOS_BOLD_OFF = Buffer.from([0x1b, 0x45, 0x00]);

function isGrandTotalLine(line) {
  return /^Grand Total\b/.test(String(line || "").trim());
}

function isBillColumnHeaderLine(line) {
  const t = String(line || "").trim();
  return /^Item\b/.test(t) && /\bQty\b/.test(t) && /\bPrice\b/.test(t);
}

function isKotColumnHeaderLine(line) {
  const t = String(line || "").trim();
  return /^Item\b/.test(t) && /\bQty\b/.test(t) && !/\bPrice\b/.test(t);
}

function lineNeedsEscPosBold(line) {
  const text = String(line ?? "");
  return isGrandTotalLine(text) || isBillColumnHeaderLine(text) || isKotColumnHeaderLine(text);
}

function pushEscPosTextLine(chunks, line) {
  const text = String(line ?? "");
  if (lineNeedsEscPosBold(text)) {
    chunks.push(ESCPOS_BOLD_ON);
    chunks.push(Buffer.from(text, "ascii"));
    chunks.push(ESCPOS_BOLD_OFF);
  } else {
    chunks.push(Buffer.from(text, "ascii"));
  }
  chunks.push(Buffer.from([0x0a]));
}

/** ESC/POS cash-drawer kick — pin 0 is the usual RJ11 drawer connector. */
function buildCashDrawerKickBuffer(pin = 0) {
  const m = pin === 1 ? 1 : 0;
  return Buffer.from([0x1b, 0x40, 0x1b, 0x70, m, 0x19, 0xfa]);
}

/** Alternate drawer pulse used by some Epson-compatible firmware. */
function buildCashDrawerKickBufferDle() {
  return Buffer.from([0x1b, 0x40, 0x10, 0x14, 0x01, 0x00, 0x01]);
}

/** ESC/POS for Generic/Text Only raw queues. */
function buildEscPosBuffer(text, options = {}) {
  const safe = toAsciiSafe(text).trim();
  const lines = safe.length ? safe.split("\n") : ["(empty)"];
  const chunks = [Buffer.from([0x1b, 0x40])];

  for (const line of lines) {
    pushEscPosTextLine(chunks, line);
  }

  chunks.push(ESCPOS_TAIL_FEED);
  if (options.kickDrawer) {
    chunks.push(buildCashDrawerKickBuffer(0));
  }
  chunks.push(Buffer.from([0x1d, 0x56, 0x00]));
  return Buffer.concat(chunks);
}

module.exports = {
  buildEscPosBuffer,
  buildPlainTextBuffer,
  buildCashDrawerKickBuffer,
  buildCashDrawerKickBufferDle,
  toAsciiSafe,
  ESCPOS_TAIL_FEED,
  pushEscPosTextLine,
  isGrandTotalLine,
  isBillColumnHeaderLine,
  isKotColumnHeaderLine,
  lineNeedsEscPosBold,
};
