const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { powershellSucceeded } = require("./print-notepad.cjs");

/**
 * Confirm Windows spooler saw activity on this queue (job queued or WMI job record).
 * Thermal jobs often finish in under a second — we poll briefly after each attempt.
 */
async function verifyWindowsSpoolerActivity(printerName, windowSec = 8) {
  const name = String(printerName || "").trim();
  if (!name) return { ok: false, error: "No printer name" };

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$printer = ${psQuote(name)}`,
    `$window = ${Math.max(3, Math.min(20, Number(windowSec) || 8))}`,
    "$end = (Get-Date).AddSeconds($window)",
    "while ((Get-Date) -lt $end) {",
    "  $jobs = @(Get-PrintJob -PrinterName $printer -ErrorAction SilentlyContinue)",
    "  if ($jobs.Count -gt 0) { Write-Output 'queued'; exit 0 }",
    "  $wmi = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($printer + ',*') })",
    "  if ($wmi.Count -gt 0) { Write-Output 'wmi'; exit 0 }",
    "  Start-Sleep -Milliseconds 120",
    "}",
    "Write-Output 'none'",
    "exit 2",
  ].join("\n");

  const r = await runPowerShellScript(script, (windowSec + 4) * 1000);
  if (powershellSucceeded(r) || /\b(queued|wmi)\b/i.test(r.stdout)) {
    return { ok: true, detail: r.stdout.trim() };
  }
  return { ok: false, error: "Spooler did not show a print job for this queue" };
}

module.exports = { verifyWindowsSpoolerActivity };
