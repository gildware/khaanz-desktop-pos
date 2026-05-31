const { execFile } = require("child_process");

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Uses Get-Printer (more reliable than Electron status on Windows).
 * @returns {Promise<{ ok: boolean, online: boolean, detail?: string }>}
 */
function checkWindowsPrinterOnline(printerName) {
  const name = String(printerName || "").trim();
  if (!name) {
    return Promise.resolve({ ok: false, online: false, detail: "No printer name" });
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${psQuote(name)}`,
    "$p = Get-Printer -Name $name -ErrorAction SilentlyContinue",
    "if (-not $p) { Write-Output 'missing'; exit 2 }",
    "if ($p.WorkOffline) { Write-Output 'work-offline'; exit 3 }",
    "$port = [string]$p.PortName",
    "if ($port -match 'PORTPROMPT|PDF|OneNote|Fax|XPS|File:') { Write-Output 'virtual'; exit 5 }",
    "$st = [string]$p.PrinterStatus",
    "if ($st -match 'Offline|Error|NotAvailable|Stopped|Unknown') { Write-Output $st; exit 4 }",
    "Write-Output 'ok'",
    "exit 0",
  ].join("\n");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || "").trim().toLowerCase();
        if (!err && out === "ok") {
          return resolve({ ok: true, online: true });
        }
        if (out === "missing" || (err && String(err.message || "").includes("exit code 2"))) {
          return resolve({ ok: true, online: false, detail: "Printer not found on this PC" });
        }
        if (out === "virtual") {
          return resolve({
            ok: true,
            online: false,
            detail: "That queue is not a physical receipt printer (PDF/Fax/virtual).",
          });
        }
        if (out === "work-offline" || out.includes("offline")) {
          return resolve({ ok: true, online: false, detail: "Printer is offline in Windows" });
        }
        return resolve({
          ok: true,
          online: false,
          detail: out || (err ? String(err.message) : "Printer not ready"),
        });
      },
    );
  });
}

module.exports = { checkWindowsPrinterOnline };
