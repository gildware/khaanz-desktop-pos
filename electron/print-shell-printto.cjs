const fs = require("fs");
const path = require("path");
const { toAsciiSafe } = require("./escpos-buffer.cjs");
const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { powershellSucceeded } = require("./print-notepad.cjs");
const { getPrintTempDir } = require("./print-temp.cjs");

/** Shell.Application printto — GDI driver queue without ESC/POS. */
async function printViaShellPrinttoWindows(resolvedName, text) {
  const dir = getPrintTempDir();
  const filePath = path.join(dir, `printto-${Date.now()}.txt`);
  fs.writeFileSync(filePath, `${toAsciiSafe(text)}\r\n`, "ascii");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(resolvedName)}`,
    `$file = ${psQuote(filePath)}`,
    "$shell = New-Object -ComObject Shell.Application",
    "$null = $shell.ShellExecute($file, '', $printer, 'printto', 0)",
    "Start-Sleep -Seconds 5",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 30_000);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }

  if (powershellSucceeded(r)) {
    return { ok: true, method: "shell-printto" };
  }
  return {
    ok: false,
    error: r.stderr || r.stdout || (r.err && r.err.message) || "Shell printto failed",
  };
}

module.exports = { printViaShellPrinttoWindows };
