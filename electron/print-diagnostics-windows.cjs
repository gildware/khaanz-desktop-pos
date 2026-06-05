const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { isLikelyGdiReceiptDriver, isVirtualPort } = require("./print-strategy-windows.cjs");
const { printerNamesLooselyMatch } = require("./printer-resolve.cjs");

const CACHE_TTL_MS = 5 * 60_000;
/** @type {Map<string, { name: string; at: number }>} */
const resolveCache = new Map();
/** @type {Map<string, { ctx: object; at: number }>} */
const contextCache = new Map();

function clearWindowsPrintCache() {
  resolveCache.clear();
  contextCache.clear();
}

function pickWindowsPrinterFromNames(wanted, names) {
  const w = String(wanted || "").trim();
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (!w || !list.length) return null;
  const exact = list.find((n) => n === w);
  if (exact) return exact;
  const ieq = list.find((n) => n.toLowerCase() === w.toLowerCase());
  if (ieq) return ieq;
  return list.find((n) => printerNamesLooselyMatch(n, w)) || null;
}

async function listWindowsPrinterNames() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$names = @(Get-Printer | Select-Object -ExpandProperty Name)",
    "if (-not $names -or $names.Count -eq 0) { Write-Output '[]'; exit 0 }",
    "$names | ConvertTo-Json -Compress",
  ].join("\n");
  const r = await runPowerShellScript(script, 15_000);
  if (r.err || !r.stdout) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    if (Array.isArray(parsed)) return parsed;
    return parsed ? [String(parsed)] : [];
  } catch {
    return [];
  }
}

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

  const fuzzy = pickWindowsPrinterFromNames(wanted, await listWindowsPrinterNames());
  if (fuzzy) {
    return { ok: true, name: fuzzy };
  }

  return {
    ok: false,
    detail:
      "Printer queue not found in Windows. Open Connect printer, click Refresh, and select your receipt printer.",
  };
}

async function resolveWindowsPrinterNameCached(printerName) {
  const wanted = String(printerName || "").trim();
  if (!wanted) return { ok: false, detail: "No printer selected" };
  const hit = resolveCache.get(wanted);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ok: true, name: hit.name };
  }
  const resolved = await resolveWindowsPrinterName(wanted);
  if (resolved.ok) {
    resolveCache.set(wanted, { name: resolved.name, at: Date.now() });
  }
  return resolved;
}

/**
 * One PowerShell spawn: resolve queue name + port/driver (avoids double cold-start).
 */
async function getWindowsPrinterContext(printerName) {
  const wanted = String(printerName || "").trim();
  if (!wanted) {
    return { ok: false, detail: "No printer selected" };
  }

  const hit = contextCache.get(wanted);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.ctx;
  }

  const resolved = await resolveWindowsPrinterName(wanted);
  if (!resolved.ok) {
    return { ok: false, detail: resolved.detail };
  }
  const queueName = resolved.name;

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$wanted = ${psQuote(queueName)}`,
    "$p = Get-Printer -Name $wanted -ErrorAction Stop",
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
  const out = r.stdout.trim();
  if (r.err || !out) {
    return {
      ok: false,
      error: r.stderr || (r.err && r.err.message) || "Could not read printer details",
    };
  }
  try {
    const info = JSON.parse(out);
    const ctx = {
      ok: true,
      ...info,
      resolvedName: info.name,
      gdiReceipt: isLikelyGdiReceiptDriver(info.driver, info.port),
      virtualPort: isVirtualPort(info.port, info.driver),
    };
    contextCache.set(wanted, { ctx, at: Date.now() });
    resolveCache.set(wanted, { name: info.name, at: Date.now() });
    return ctx;
  } catch {
    return { ok: false, error: "Invalid printer diagnostic response" };
  }
}

async function getWindowsPrinterDiagnostics(printerName) {
  const ctx = await getWindowsPrinterContext(printerName);
  if (!ctx.ok) {
    return { ok: false, error: ctx.detail || ctx.error || "Printer not found" };
  }
  return {
    ok: true,
    name: ctx.name,
    port: ctx.port,
    driver: ctx.driver,
    shared: ctx.shared,
    workOffline: ctx.workOffline,
    status: ctx.status,
    resolvedName: ctx.resolvedName,
  };
}

module.exports = {
  resolveWindowsPrinterName,
  resolveWindowsPrinterNameCached,
  getWindowsPrinterDiagnostics,
  getWindowsPrinterContext,
  clearWindowsPrintCache,
};
