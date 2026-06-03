const fs = require("fs");
const path = require("path");
const os = require("os");

/** Resolve a stable, user-readable location for the print log. */
function getPrintLogPath() {
  const base =
    process.env.KHAANZ_PRINT_LOG_DIR ||
    (() => {
      try {
        const { app } = require("electron");
        return app.getPath("logs");
      } catch {
        return os.tmpdir();
      }
    })();
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(base, "khaanz-print.log");
}

/**
 * Append one print attempt summary so a shop PC can be diagnosed after the fact.
 * Best-effort only — never throws.
 */
function appendPrintLog(entry) {
  try {
    const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
    fs.appendFileSync(getPrintLogPath(), line, "utf8");
  } catch {
    /* logging must never break printing */
  }
}

module.exports = { appendPrintLog, getPrintLogPath };
