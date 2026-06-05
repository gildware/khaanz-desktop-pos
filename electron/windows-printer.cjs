const fs = require("fs");
const path = require("path");
const { buildEscPosBuffer, buildPlainTextBuffer, toAsciiSafe } = require("./escpos-buffer.cjs");
const { runPowerShellScript, psQuote } = require("./print-ps.cjs");
const { getPrintTempDir } = require("./print-temp.cjs");
const { printViaNotepadPtWindows, powershellSucceeded } = require("./print-notepad.cjs");
const { printViaShellPrinttoWindows } = require("./print-shell-printto.cjs");
const { printGdiDotNetWindows } = require("./print-gdi-dotnet.cjs");
const { printEscPosToPortWindows } = require("./print-port-raw.cjs");
const {
  resolveWindowsPrinterName,
  resolveWindowsPrinterNameCached,
  getWindowsPrinterContext,
  getWindowsPrinterDiagnostics,
} = require("./print-diagnostics-windows.cjs");
const { verifyWindowsSpoolerActivity } = require("./print-spooler-windows.cjs");
const { reorderAttempts } = require("./print-strategy-windows.cjs");
const { appendPrintLog } = require("./print-log.cjs");
const { withTimeout } = require("./print-timeout.cjs");

const PRINT_OVERALL_TIMEOUT_MS = 90_000;
const PREFERRED_METHOD_TIMEOUT_MS = 40_000;
const FALLBACK_METHOD_TIMEOUT_MS = 12_000;

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

async function checkWindowsPrinterOnline(printerName) {
  const resolved = await resolveWindowsPrinterNameCached(printerName);
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
    "if ($st -eq 'Offline' -or $st -eq 'Error' -or $st -eq 'NotAvailable') { Write-Output $st; exit 4 }",
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
  const dir = getPrintTempDir();
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

  if (powershellSucceeded(r)) {
    return { ok: true, method: "text-raw" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

/** ESC/POS RAW bytes via WinSpool (Generic/Text Only queues). */
async function printEscPosRawBytesWindows(resolvedName, bytes) {
  const dir = getPrintTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, `receipt-${Date.now()}.bin`);
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

  if (powershellSucceeded(r)) {
    return { ok: true, method: "escpos-raw" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

async function printEscPosRawWindows(resolvedName, text) {
  return printEscPosRawBytesWindows(resolvedName, buildEscPosBuffer(text));
}

/** Fallback: plain text via Out-Printer. */
async function printPlainTextOutPrinter(resolvedName, text) {
  const dir = getPrintTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${Date.now()}.txt`);
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

  if (powershellSucceeded(r)) {
    return { ok: true, method: "out-printer" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

/** Classic Windows `print` command — used by many legacy POS apps. */
async function printViaCmdPrint(resolvedName, text) {
  const dir = getPrintTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `receipt-${Date.now()}.txt`);
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

  if (powershellSucceeded(r)) {
    return { ok: true, method: "cmd-print" };
  }
  return {
    ok: false,
    error: friendlyWindowsPrintError(r.stderr || r.stdout || (r.err && r.err.message)),
  };
}

function buildWindowsPrintAttempts(name, body, title, options = {}) {
  const safeTitle = title || "Receipt";
  const useElectronPrint = Boolean(process.versions.electron) && !options.skipElectronPrint;
  const gdiReceipt = options.gdiReceipt !== false;

  // GDI driver print — the same silent path Petpooja-style POS apps use, in order of
  // reliability:
  //  1. pdf       — render → content-height PDF → SumatraPDF silent print (most reliable
  //                 across GDI thermal drivers; throws on failure so success is honest).
  //  2. dotnet-gdi— System.Drawing.Printing.PrintDocument; renders text, real spool job.
  //  3. gdi       — Electron webContents.print (silent) through the driver.
  //  4. cmd-print — legacy `print /D:` of a text file.
  //  5/6 shell-printto / notepad-pt — last resort. On Windows 11 `notepad /pt` no longer
  //                 prints, so these are never trusted on exit code (see confirmPrintSucceeded).
  const gdiAttempts = [];
  if (useElectronPrint) {
    gdiAttempts.push({
      methodId: "pdf",
      run: () => require("./print-pdf-windows.cjs").printReceiptPdfWindows(name, body, safeTitle),
    });
  }
  gdiAttempts.push({ methodId: "dotnet-gdi", run: () => printGdiDotNetWindows(name, body) });
  if (useElectronPrint) {
    gdiAttempts.push({
      methodId: "gdi",
      run: () => require("./print-gdi-windows.cjs").printReceiptGdiWindows(name, body, safeTitle),
    });
  }
  gdiAttempts.push(
    { methodId: "cmd-print", run: () => printViaCmdPrint(name, body) },
    { methodId: "shell-printto", run: () => printViaShellPrinttoWindows(name, body) },
    { methodId: "notepad-pt", run: () => printViaNotepadPtWindows(name, body) },
  );

  // RAW ESC/POS — for Generic/Text Only queues and true thermal hardware. Kept as a
  // fallback for every printer (not only "raw" queues) so the bill still prints when
  // the GDI driver path fails on the shop PC.
  const rawAttempts = [
    { methodId: "escpos-raw", run: () => printEscPosRawWindows(name, body) },
    { methodId: "text-raw", run: () => printTextRawWindows(name, body) },
    { methodId: "port-raw", run: () => printEscPosToPortWindows(name, body) },
    { methodId: "out-printer", run: () => printPlainTextOutPrinter(name, body) },
  ];

  // Generic/Text-Only thermal queues print best with RAW first; everything else
  // (real GDI drivers like BillQuick Lite) prints best with GDI first.
  const attempts = gdiReceipt
    ? [...gdiAttempts, ...rawAttempts]
    : [...rawAttempts, ...gdiAttempts];

  return reorderAttempts(attempts, options.preferredMethod);
}

/**
 * Legacy verbs that can return exit code 0 WITHOUT actually printing
 * (notably `notepad /pt` on Windows 11, and ShellExecute "printto").
 * Only these are gated behind a real spooler-job check.
 */
const SPOOLER_VERIFY_METHODS = new Set(["notepad-pt", "shell-printto"]);

async function confirmPrintSucceeded(printerName, methodId, attemptResult) {
  if (!attemptResult.ok) {
    return { ok: false, error: attemptResult.error || "Print failed" };
  }

  // Reliable submit APIs (GDI PrintDocument, WinSpool RAW/TEXT, direct port write,
  // Out-Printer, Electron print, classic `print` command) throw when the spooler or
  // driver rejects the job, so a non-error result is itself proof the job was sent.
  // Polling the spooler afterwards is racy for these — thermal jobs often clear in
  // under a second, which would cause a false "no job" and a duplicate reprint.
  if (!SPOOLER_VERIFY_METHODS.has(methodId)) {
    return { ok: true, proof: `${methodId}-submitted` };
  }

  const spooler = await verifyWindowsSpoolerActivity(printerName, 8);
  if (spooler.ok) {
    return { ok: true, proof: spooler.detail || "spooler" };
  }
  return {
    ok: false,
    error: `Spooler saw no job (${methodId}). ${spooler.error || ""}`.trim(),
  };
}

async function tryWindowsPrintAttempt(name, attempt, timeoutMs, tried, errors) {
  let r;
  try {
    r = await withTimeout(attempt.run(), timeoutMs, `${attempt.methodId} print`);
  } catch (e) {
    r = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  if (!r.ok) {
    tried.push({ method: attempt.methodId, ok: false, error: r.error || "failed" });
    if (r.error) errors.push(`${attempt.methodId}: ${r.error}`);
    return null;
  }

  const confirmed = await confirmPrintSucceeded(name, attempt.methodId, r);
  if (confirmed.ok) {
    const method = r.method || attempt.methodId;
    tried.push({ method, ok: true, proof: confirmed.proof });
    return { ok: true, deviceName: name, method, proof: confirmed.proof };
  }
  tried.push({ method: attempt.methodId, ok: false, error: confirmed.error || "not confirmed" });
  errors.push(`${attempt.methodId}: ${confirmed.error || "not confirmed"}`);
  return null;
}

/**
 * Print on Windows — GDI methods for BillQuick/Petpooja drivers; spooler-checked success.
 */
async function printPlainTextWindows(deviceName, text, title, options = {}) {
  const wanted = String(deviceName || "").trim();
  if (!wanted) {
    return { ok: false, error: "No printer selected." };
  }
  const body = String(text || "").trim();
  if (!body) {
    return { ok: false, error: "Nothing to print." };
  }

  const preferred = String(options.preferredMethod || "").trim();
  const fastPath = Boolean(options.fastPath && preferred);

  if (options.escPosBytes && Buffer.isBuffer(options.escPosBytes)) {
    let name = wanted;
    if (!fastPath) {
      const ctx = await getWindowsPrinterContext(wanted);
      if (!ctx.ok) {
        return { ok: false, error: ctx.detail || ctx.error || friendlyWindowsPrintError("") };
      }
      name = ctx.resolvedName || ctx.name;
    }
    try {
      const raw = await printEscPosRawBytesWindows(name, options.escPosBytes);
      if (raw.ok) {
        return { ok: true, method: "escpos-raw-logo", deviceName: name };
      }
    } catch {
      /* fall through to plain text without logo */
    }
  }

  let name = wanted;
  let gdiReceipt = options.gdiReceipt !== false;

  if (!fastPath) {
    const ctx = await getWindowsPrinterContext(wanted);
    if (!ctx.ok) {
      return { ok: false, error: ctx.detail || ctx.error || friendlyWindowsPrintError("") };
    }
    name = ctx.resolvedName || ctx.name;
    if (ctx.virtualPort) {
      return {
        ok: false,
        error:
          "That queue is a PDF/virtual printer, not your thermal receipt printer. Pick the same name as Petpooja (e.g. BillQuick Lite).",
      };
    }
    gdiReceipt = ctx.gdiReceipt !== false;
  }

  const attempts = buildWindowsPrintAttempts(name, body, title, {
    ...options,
    gdiReceipt,
  });

  const errors = [];
  const tried = [];
  const triedPreferred = new Set();
  const deadline = Date.now() + PRINT_OVERALL_TIMEOUT_MS;

  if (preferred) {
    const pref = attempts.find((a) => a.methodId === preferred);
    if (pref) {
      triedPreferred.add(preferred);
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        const hit = await tryWindowsPrintAttempt(
          name,
          pref,
          Math.min(remaining, PREFERRED_METHOD_TIMEOUT_MS),
          tried,
          errors,
        );
        if (hit) {
          appendPrintLog({
            event: "print-ok",
            printer: name,
            title: title || "Receipt",
            gdiReceipt,
            method: hit.method,
            proof: hit.proof,
            tried,
            fastPath,
          });
          return { ...hit, gdiReceipt };
        }
      }
    }
  }

  for (const attempt of attempts) {
    if (triedPreferred.has(attempt.methodId)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      errors.push("overall timeout");
      break;
    }
    const timeoutMs = preferred
      ? Math.min(remaining, FALLBACK_METHOD_TIMEOUT_MS)
      : Math.min(remaining, 35_000);
    const hit = await tryWindowsPrintAttempt(name, attempt, timeoutMs, tried, errors);
    if (hit) {
      appendPrintLog({
        event: "print-ok",
        printer: name,
        title: title || "Receipt",
        gdiReceipt,
        method: hit.method,
        proof: hit.proof,
        tried,
      });
      return { ...hit, gdiReceipt };
    }
  }

  const detail = errors.filter(Boolean).join(" | ");
  appendPrintLog({
    event: "print-failed",
    printer: name,
    title: title || "Receipt",
    gdiReceipt,
    tried,
  });
  return {
    ok: false,
    error: detail
      ? `Print failed (${errors.length} tries): ${detail}`
      : "Print failed. Use the exact printer name from Petpooja, then Save and Test print.",
  };
}

module.exports = {
  resolveWindowsPrinterName,
  checkWindowsPrinterOnline,
  getWindowsPrinterDiagnostics,
  printPlainTextWindows,
  buildWindowsPrintAttempts,
  friendlyWindowsPrintError,
};
