const fs = require("fs");
const path = require("path");
const { buildEscPosBuffer } = require("./escpos-buffer.cjs");
const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { powershellSucceeded } = require("./print-notepad.cjs");
const { getPrintTempDir } = require("./print-temp.cjs");

/** Write raw bytes directly to USB/COM printer port (bypasses GDI drivers). */
async function writeRawBytesToPrinterPortWindows(resolvedName, bytes) {
  const dir = getPrintTempDir();
  const binPath = path.join(dir, `raw-${Date.now()}.bin`);
  fs.writeFileSync(binPath, bytes);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(resolvedName)}`,
    `$binPath = ${psQuote(binPath)}`,
    "$p = Get-Printer -Name $printer -ErrorAction Stop",
    "$port = [string]$p.PortName",
    "if ([string]::IsNullOrWhiteSpace($port)) { throw 'No printer port' }",
    "if ($port -match 'PORTPROMPT|PDF|OneNote|Fax|XPS|File:|nul:') { throw 'virtual-port' }",
    "$dest = if ($port -match '^COM\\d+$') { '\\\\.\\' + $port } else { '\\\\.\\' + $port }",
    "$bytes = [System.IO.File]::ReadAllBytes($binPath)",
    "$fs = New-Object System.IO.FileStream($dest, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)",
    "try {",
    "  $fs.Write($bytes, 0, $bytes.Length)",
    "} finally {",
    "  $fs.Close()",
    "}",
    "Start-Sleep -Milliseconds 300",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 30_000);
  try {
    fs.unlinkSync(binPath);
  } catch {
    /* ignore */
  }

  if (powershellSucceeded(r)) {
    return { ok: true, method: "port-raw" };
  }
  const msg = r.stderr || r.stdout || (r.err && r.err.message) || "";
  if (/virtual-port/i.test(msg)) {
    return { ok: false, error: "virtual-port" };
  }
  return { ok: false, error: msg || "Port write failed" };
}

/** Write ESC/POS bytes directly to USB/COM printer port (true thermal hardware). */
async function printEscPosToPortWindows(resolvedName, text, options = {}) {
  return writeRawBytesToPrinterPortWindows(resolvedName, buildEscPosBuffer(text, options));
}

module.exports = { printEscPosToPortWindows, writeRawBytesToPrinterPortWindows };
