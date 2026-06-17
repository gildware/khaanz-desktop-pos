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

/** ESC/POS for Generic/Text Only raw queues. */
function buildEscPosBuffer(text) {
  const safe = toAsciiSafe(text).trim();
  const lines = safe.length ? safe.split("\n") : ["(empty)"];
  const chunks = [Buffer.from([0x1b, 0x40])];

  for (const line of lines) {
    chunks.push(Buffer.from(line, "ascii"));
    chunks.push(Buffer.from([0x0a]));
  }

  chunks.push(ESCPOS_TAIL_FEED);
  chunks.push(Buffer.from([0x1d, 0x56, 0x00]));
  return Buffer.concat(chunks);
}

module.exports = { buildEscPosBuffer, buildPlainTextBuffer, toAsciiSafe, ESCPOS_TAIL_FEED };
