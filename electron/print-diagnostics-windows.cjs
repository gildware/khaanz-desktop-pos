const { runPowerShellScript, psQuote } = require("./print-ps.cjs");

async function resolveWindowsPrinterName(printerName) {
  const wanted = String(printerName || "").trim();
  if (!wanted) {
    return { ok: false, detail: "No printer selected" };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$wanted = ${psQuote(wanted)}`,
    "$exact = Get-Printer -Name $wanted -ErrorAction SilentlyContinue",
    "if ($exact) { Write-Output $exact.Name; exit 0 }",
    "$match = @(Get-Printer | Where-Object { $_.Name -ieq $wanted }) | Select-Object -First 1",
    "if ($match) { Write-Output $match.Name; exit 0 }",
    "Write-Output 'missing'",
    "exit 2",
  ].join("\n");

  const r = await runPowerShellScript(script, 15_000);
  const out = r.stdout.trim();
  if (!r.err && out && out !== "missing") {
    return { ok: true, name: out };
  }
  return {
    ok: false,
    detail:
      "Printer queue not found in Windows. Open Connect printer, click Refresh, and select your receipt printer.",
  };
}

async function getWindowsPrinterDiagnostics(printerName) {
  const resolved = await resolveWindowsPrinterName(printerName);
  if (!resolved.ok) {
    return { ok: false, error: resolved.detail || "Printer not found" };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${psQuote(resolved.name)}`,
    "$p = Get-Printer -Name $name -ErrorAction Stop",
    "$driver = Get-PrinterDriver -Name $p.DriverName -ErrorAction SilentlyContinue",
    "[PSCustomObject]@{",
    "  name = $p.Name",
    "  port = [string]$p.PortName",
    "  driver = [string]$p.DriverName",
    "  shared = [bool]$p.Shared",
    "  workOffline = [bool]$p.WorkOffline",
    "  status = [string]$p.PrinterStatus",
    "} | ConvertTo-Json -Compress",
  ].join("\n");

  const r = await runPowerShellScript(script, 20_000);
  if (r.err || !r.stdout) {
    return {
      ok: false,
      error: r.stderr || (r.err && r.err.message) || "Could not read printer details",
    };
  }
  try {
    const info = JSON.parse(r.stdout);
    return { ok: true, ...info, resolvedName: resolved.name };
  } catch {
    return { ok: false, error: "Invalid printer diagnostic response" };
  }
}

module.exports = { resolveWindowsPrinterName, getWindowsPrinterDiagnostics };
