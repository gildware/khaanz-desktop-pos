const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/**
 * Send plain text to a Windows queue (BillQuick Lite, POS 203DPI, Generic/Text).
 * HTML GDI print often never calls back on these drivers — Out-Printer is reliable.
 */
function printPlainTextWindows(deviceName, text) {
  const name = String(deviceName || "").trim();
  if (!name) {
    return Promise.resolve({ ok: false, error: "No printer selected." });
  }
  const body = String(text || "").trim();
  if (!body) {
    return Promise.resolve({ ok: false, error: "Nothing to print." });
  }

  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${Date.now()}.txt`);
  fs.writeFileSync(filePath, `${body}\n`, "utf8");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(name)}`,
    `$file = ${psQuote(filePath)}`,
    "Get-Content -LiteralPath $file -Encoding UTF8 | Out-Printer -Name $printer",
  ].join("\n");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 45_000, windowsHide: true },
      (err, _stdout, stderr) => {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
        if (err) {
          const msg = String(stderr || err.message || err).trim();
          resolve({
            ok: false,
            error: msg || "Windows print failed. Check the printer name and that it is online.",
          });
          return;
        }
        resolve({ ok: true });
      },
    );
  });
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

module.exports = { printPlainTextWindows };
