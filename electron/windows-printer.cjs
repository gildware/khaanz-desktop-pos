const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { buildEscPosBuffer, buildPlainTextBuffer } = require("./escpos-buffer.cjs");
const { printReceiptGdiWindows } = require("./print-gdi-windows.cjs");
const { printReceiptPdfWindows } = require("./print-pdf-windows.cjs");

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShellScript(script, timeoutMs = 60_000) {
  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, script, "utf8");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
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
        });
      },
    );
  });
}

const RAW_PRINTER_HELPER_CS = `
using System;
using System.Runtime.InteropServices;
public class KhaanzRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static string SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
      return "OpenPrinter failed: " + Marshal.GetLastWin32Error();
    }
    try {
      var di = new DOCINFO();
      di.pDocName = "Khaanz Receipt";
      di.pDatatype = "RAW";
      if (!StartDocPrinter(hPrinter, 1, di)) {
        return "StartDocPrinter failed: " + Marshal.GetLastWin32Error();
      }
      try {
        if (!StartPagePrinter(hPrinter)) {
          return "StartPagePrinter failed: " + Marshal.GetLastWin32Error();
        }
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(hPrinter, p, bytes.Length, out written)) {
            return "WritePrinter failed: " + Marshal.GetLastWin32Error();
          }
        } finally {
          Marshal.FreeCoTaskMem(p);
        }
        EndPagePrinter(hPrinter);
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
    return "ok";
  }
}
`;

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
  if (/has been deleted|printer.*not found|unable to initialize|invalid printer|OpenPrinter failed/i.test(msg)) {
    return "That printer queue was removed or renamed in Windows. Open Connect printer, Refresh, select BillQuick Lite, and Save again.";
  }
  if (/offline|not available|paused/i.test(msg)) {
    return "Printer is offline or paused in Windows. Turn it on, then Refresh and Test print.";
  }
  return msg;
}

/** WinSpool RAW with TEXT datatype (plain ASCII, no ESC) — some vendor drivers. */
async function printTextRawWindows(resolvedName, text) {
  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, `text-${Date.now()}.bin`);
  fs.writeFileSync(binPath, buildPlainTextBuffer(text));

  const helperCs = RAW_PRINTER_HELPER_CS.replace(/KhaanzRawPrinter/g, "KhaanzTextPrinter").replace(
    'di.pDatatype = "RAW"',
    'di.pDatatype = "TEXT"',
  );

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Add-Type -TypeDefinition @'",
    helperCs,
    "'@ -ErrorAction Stop",
    "} catch {",
    "  if ($_.Exception.Message -notmatch 'already exists') { throw }",
    "}",
    `$printer = ${psQuote(resolvedName)}`,
    `$binPath = ${psQuote(binPath)}`,
    "$data = [System.IO.File]::ReadAllBytes($binPath)",
    "$result = [KhaanzTextPrinter]::SendBytes($printer, $data)",
    "if ($result -ne 'ok') { throw $result }",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 60_000);
  try {
    fs.unlinkSync(binPath);
  } catch {
    /* ignore */
  }

  if (!r.err && r.stdout.toLowerCase() === "ok") {
    return { ok: true, method: "text-raw" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

/** ESC/POS RAW bytes via WinSpool (Generic/Text Only queues). */
async function printEscPosRawWindows(resolvedName, text) {
  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, `receipt-${Date.now()}.bin`);
  const bytes = buildEscPosBuffer(text);
  fs.writeFileSync(binPath, bytes);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Add-Type -TypeDefinition @'",
    RAW_PRINTER_HELPER_CS,
    "'@ -ErrorAction Stop",
    "} catch {",
    "  if ($_.Exception.Message -notmatch 'already exists') { throw }",
    "}",
    `$printer = ${psQuote(resolvedName)}`,
    `$binPath = ${psQuote(binPath)}`,
    "$data = [System.IO.File]::ReadAllBytes($binPath)",
    "$result = [KhaanzRawPrinter]::SendBytes($printer, $data)",
    "if ($result -ne 'ok') { throw $result }",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 60_000);
  try {
    fs.unlinkSync(binPath);
  } catch {
    /* ignore */
  }

  if (!r.err && r.stdout.toLowerCase() === "ok") {
    return { ok: true, method: "escpos-raw" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

/** Fallback: plain text via Out-Printer. */
async function printPlainTextOutPrinter(resolvedName, text) {
  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${Date.now()}.txt`);
  const { toAsciiSafe } = require("./escpos-buffer.cjs");
  fs.writeFileSync(filePath, `${toAsciiSafe(text)}\n`, "ascii");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(resolvedName)}`,
    `$file = ${psQuote(filePath)}`,
    "$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::ASCII)",
    "Out-Printer -Name $printer -InputObject $content",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 45_000);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }

  if (!r.err && r.stdout.toLowerCase() === "ok") {
    return { ok: true, method: "out-printer" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

/** Classic Windows `print` command — used by many legacy POS apps. */
async function printViaCmdPrint(resolvedName, text) {
  const dir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${Date.now()}.txt`);
  const { toAsciiSafe } = require("./escpos-buffer.cjs");
  fs.writeFileSync(filePath, `${toAsciiSafe(text)}\n`, "ascii");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$printer = ${psQuote(resolvedName)}`,
    `$file = ${psQuote(filePath)}`,
    "$psi = New-Object System.Diagnostics.ProcessStartInfo",
    "$psi.FileName = 'cmd.exe'",
    "$psi.Arguments = '/c print /D:\"' + $printer + '\" \"' + $file + '\"'",
    "$psi.CreateNoWindow = $true",
    "$psi.UseShellExecute = $false",
    "$proc = [System.Diagnostics.Process]::Start($psi)",
    "if (-not $proc.WaitForExit(45000)) { throw 'print command timed out' }",
    "if ($proc.ExitCode -ne 0) { throw ('print command failed code ' + $proc.ExitCode) }",
    "Write-Output 'ok'",
  ].join("\n");

  const r = await runPowerShellScript(script, 50_000);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }

  if (!r.err && r.stdout.toLowerCase() === "ok") {
    return { ok: true, method: "cmd-print" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

/**
 * Print on Windows — same strategy order as Petpooja-style POS apps:
 * 1) GDI (Chromium)  2) cmd print  3) TEXT raw  4) ESC/POS raw  5) Out-Printer
 */
async function printPlainTextWindows(deviceName, text, title) {
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

  const name = resolved.name;
  const attempts = [
    () => printReceiptPdfWindows(name, body, title || "Receipt"),
    () => printReceiptGdiWindows(name, body, title || "Receipt"),
    () => printViaCmdPrint(name, body),
    () => printTextRawWindows(name, body),
    () => printEscPosRawWindows(name, body),
    () => printPlainTextOutPrinter(name, body),
  ];

  const errors = [];
  for (const attempt of attempts) {
    const r = await attempt();
    if (r.ok) {
      return { ok: true, deviceName: name, method: r.method || "unknown" };
    }
    if (r.error) errors.push(r.error);
  }

  return {
    ok: false,
    error:
      errors.filter(Boolean).join(" · ") ||
      "All print methods failed. Use the same printer name as Petpooja, Save, then Test print.",
  };
}

module.exports = {
  resolveWindowsPrinterName,
  checkWindowsPrinterOnline,
  printPlainTextWindows,
  friendlyWindowsPrintError,
};
