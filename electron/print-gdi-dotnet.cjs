const fs = require("fs");
const path = require("path");
const { toAsciiSafe } = require("./escpos-buffer.cjs");
const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { powershellSucceeded } = require("./print-notepad.cjs");
const { getPrintTempDir } = require("./print-temp.cjs");

/**
 * System.Drawing.Printing — same GDI path Windows POS apps (Petpooja) use.
 */
async function printGdiDotNetWindows(resolvedName, text) {
  const dir = getPrintTempDir();
  const filePath = path.join(dir, `gdi-${Date.now()}.txt`);
  fs.writeFileSync(filePath, toAsciiSafe(text), "ascii");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName System.Drawing.Printing",
    `$printer = ${psQuote(resolvedName)}`,
    `$file = ${psQuote(filePath)}`,
    "$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::ASCII)",
    "$doc = New-Object System.Drawing.Printing.PrintDocument",
    "$doc.PrinterSettings.PrinterName = $printer",
    "$doc.DocumentName = 'Khaanz POS'",
    "$lines = $content -split \"`r?`n\"",
    "$handler = [System.Drawing.Printing.PrintPageEventHandler]{",
    "  param($sender, $e)",
    "  $font = New-Object System.Drawing.Font('Courier New', 10, [System.Drawing.FontStyle]::Bold)",
    "  $brush = [System.Drawing.Brushes]::Black",
    "  $y = 12",
    "  foreach ($line in $lines) {",
    "    if ($line.Length -gt 0) {",
    "      $e.Graphics.DrawString($line, $font, $brush, 8, $y)",
    "    }",
    "    $y += 16",
    "  }",
    "  $e.HasMorePages = $false",
    "}",
    "$doc.add_PrintPage($handler)",
    "$doc.Print()",
    "$doc.Dispose()",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 90_000);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }

  if (powershellSucceeded(r)) {
    return { ok: true, method: "dotnet-gdi" };
  }
  return {
    ok: false,
    error: r.stderr || r.stdout || (r.err && r.err.message) || "GDI print failed",
  };
}

module.exports = { printGdiDotNetWindows };
