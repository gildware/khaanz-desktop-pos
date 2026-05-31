const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShellScript(script, timeoutMs = 45_000) {
  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, script, "utf8");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
        resolve({
          err,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        });
      },
    );
  });
}

/**
 * Resolve a Windows queue name to the exact spooler name (case-insensitive).
 * Electron/Chromium printer lists can show stale or aliased names.
 */
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
    detail: "Printer queue not found in Windows. Click Refresh and select your receipt printer again.",
  };
}

/**
 * Uses Get-Printer (more reliable than Electron status on Windows).
 * @returns {Promise<{ ok: boolean, online: boolean, name?: string, detail?: string }>}
 */
async function checkWindowsPrinterOnline(printerName) {
  const resolved = await resolveWindowsPrinterName(printerName);
  if (!resolved.ok) {
    return { ok: true, online: false, detail: resolved.detail };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${psQuote(resolved.name)}`,
    "$p = Get-Printer -Name $name -ErrorAction Stop",
    "if ($p.WorkOffline) { Write-Output 'work-offline'; exit 3 }",
    "$port = [string]$p.PortName",
    "if ($port -match 'PORTPROMPT|PDF|OneNote|Fax|XPS|File:') { Write-Output 'virtual'; exit 5 }",
    "$st = [string]$p.PrinterStatus",
    "if ($st -match 'Offline|Error|NotAvailable|Stopped|Unknown') { Write-Output $st; exit 4 }",
    "Write-Output 'ok'",
    "exit 0",
  ].join("\n");

  const r = await runPowerShellScript(script, 15_000);
  const out = r.stdout.toLowerCase();
  if (!r.err && out === "ok") {
    return { ok: true, online: true, name: resolved.name };
  }
  if (out === "virtual") {
    return {
      ok: true,
      online: false,
      name: resolved.name,
      detail: "That queue is not a physical receipt printer (PDF/Fax/virtual).",
    };
  }
  if (out === "work-offline" || out.includes("offline")) {
    return {
      ok: true,
      online: false,
      name: resolved.name,
      detail: "Printer is offline in Windows",
    };
  }
  return {
    ok: true,
    online: false,
    name: resolved.name,
    detail: out || r.stderr || "Printer not ready",
  };
}

function friendlyWindowsPrintError(raw) {
  const msg = String(raw || "").trim();
  if (!msg) {
    return "Windows print failed. Check the printer name and that it is online.";
  }
  if (/has been deleted|printer.*not found|unable to initialize|invalid printer/i.test(msg)) {
    return "That printer queue was removed or renamed in Windows. Open Connect printer, click Refresh, select your receipt printer (e.g. BillQuick Lite), and Save again.";
  }
  if (/offline|not available|paused/i.test(msg)) {
    return "Printer is offline or paused in Windows. Turn it on, then click Refresh and Test print.";
  }
  return msg;
}

/**
 * Send plain text to a Windows queue (BillQuick Lite, POS 203DPI, Generic/Text).
 * Resolves the spooler name, then tries Out-Printer and fallbacks.
 */
async function printPlainTextWindows(deviceName, text) {
  const wanted = String(deviceName || "").trim();
  if (!wanted) {
    return { ok: false, error: "No printer selected." };
  }
  const body = String(text || "").trim();
  if (!body) {
    return { ok: false, error: "Nothing to print." };
  }

  const resolved = await resolveWindowsPrinterName(wanted);
  if (!resolved.ok) {
    return { ok: false, error: resolved.detail || friendlyWindowsPrintError("") };
  }

  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${Date.now()}.txt`);
  fs.writeFileSync(filePath, `${body}\n`, "utf8");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(resolved.name)}`,
    `$file = ${psQuote(filePath)}`,
    "$p = Get-Printer -Name $printer -ErrorAction Stop",
    "if ($p.WorkOffline) { throw 'Printer is offline in Windows.' }",
    "$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)",
    "",
    "function Send-RawToPort([string]$PortName, [string]$Text) {",
    "  if ([string]::IsNullOrWhiteSpace($PortName)) { return $false }",
    "  if ($PortName -match 'PORTPROMPT|PDF|OneNote|Fax|XPS|File:|nul:|WSD-|TS\\d') { return $false }",
    "  $path = if ($PortName -match '^COM\\d+$') { '\\\\.\\' + $PortName } else { '\\\\.\\' + $PortName }",
    "  try {",
    "    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)",
    "    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)",
    "    try {",
    "      $fs.Write($bytes, 0, $bytes.Length)",
    "    } finally {",
    "      $fs.Close()",
    "    }",
    "    return $true",
    "  } catch {",
    "    return $false",
    "  }",
    "}",
    "",
    "$printed = $false",
    "$firstErr = $null",
    "try {",
    "  Out-Printer -Name $printer -InputObject $content",
    "  $printed = $true",
    "} catch {",
    "  $firstErr = $_.Exception.Message",
    "}",
    "",
    "if (-not $printed) {",
    "  try {",
    "    $psi = New-Object System.Diagnostics.ProcessStartInfo",
    "    $psi.FileName = 'cmd.exe'",
    "    $psi.Arguments = '/c print /D:\"' + $printer + '\" \"' + $file + '\"'",
    "    $psi.CreateNoWindow = $true",
    "    $psi.UseShellExecute = $false",
    "    $proc = [System.Diagnostics.Process]::Start($psi)",
    "    if ($proc.WaitForExit(30000) -and $proc.ExitCode -eq 0) {",
    "      $printed = $true",
    "    }",
    "  } catch {",
    "    /* try port next */",
    "  }",
    "}",
    "",
    "if (-not $printed) {",
    "  if (Send-RawToPort ([string]$p.PortName) $content) {",
    "    $printed = $true",
    "  }",
    "}",
    "",
    "if (-not $printed) {",
    "  if ($firstErr) { throw $firstErr }",
    "  throw 'Windows print failed after all methods.'",
    "}",
  ].join("\n");

  const r = await runPowerShellScript(script, 45_000);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }

  if (r.err) {
    const raw = r.stderr || r.stdout || (r.err && r.err.message) || "";
    return { ok: false, error: friendlyWindowsPrintError(raw) };
  }
  return { ok: true, deviceName: resolved.name };
}

module.exports = {
  resolveWindowsPrinterName,
  checkWindowsPrinterOnline,
  printPlainTextWindows,
  friendlyWindowsPrintError,
};
