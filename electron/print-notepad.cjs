const fs = require("fs");
const path = require("path");
const { toAsciiSafe } = require("./escpos-buffer.cjs");
const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { getPrintTempDir } = require("./print-temp.cjs");

/** Legacy Windows GDI path — same mechanism many POS apps use with BillQuick Lite. */
async function printViaNotepadPtWindows(resolvedName, text) {
  const dir = getPrintTempDir();
  const filePath = path.join(dir, `np-${Date.now()}.txt`);
  fs.writeFileSync(filePath, `${toAsciiSafe(text)}\r\n`, "ascii");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(resolvedName)}`,
    `$file = ${psQuote(filePath)}`,
    "$args = @('/pt', $file, $printer)",
    "$p = Start-Process -FilePath 'notepad.exe' -ArgumentList $args -PassThru -WindowStyle Minimized -Wait",
    "if ($null -eq $p) { throw 'notepad did not start' }",
    "if ($p.ExitCode -ne 0) { throw ('notepad exit ' + $p.ExitCode) }",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 60_000);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }

  if (powershellSucceeded(r)) {
    return { ok: true, method: "notepad-pt" };
  }
  return {
    ok: false,
    error: r.stderr || r.stdout || (r.err && r.err.message) || "Notepad print failed",
  };
}

function powershellSucceeded(r) {
  if (r.err) return false;
  return /\bok\b/i.test(String(r.stdout || ""));
}

module.exports = { printViaNotepadPtWindows, powershellSucceeded };
