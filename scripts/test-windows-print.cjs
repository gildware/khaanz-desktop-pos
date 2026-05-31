#!/usr/bin/env node
/**
 * Windows-only print smoke test — same code path as the POS app, no installer rebuild.
 *
 *   cd pos-desktop
 *   node scripts/test-windows-print.cjs "BillQuick Lite"
 *
 * Paper should print. Exit 0 = success (method printed to stdout).
 */
const os = require("os");
const path = require("path");

if (process.platform !== "win32") {
  console.error("This script only runs on Windows.");
  process.exit(2);
}

const printerName = process.argv[2] || process.env.KHAANZ_SILENT_PRINTER || "";
if (!printerName.trim()) {
  console.error('Usage: node scripts/test-windows-print.cjs "BillQuick Lite"');
  console.error("Or set KHAANZ_SILENT_PRINTER.");
  process.exit(2);
}

process.env.KHAANZ_PRINT_TEMP = path.join(os.tmpdir(), "khaanz-print-test");

const { buildTestPrintPlainText } = require("../electron/thermal-print.cjs");
const {
  getWindowsPrinterDiagnostics,
  printPlainTextWindows,
} = require("../electron/windows-printer.cjs");

async function main() {
  console.log("Khaanz Windows print test");
  console.log("Printer:", printerName);
  console.log("");

  const diag = await getWindowsPrinterDiagnostics(printerName);
  if (diag.ok) {
    console.log("Queue:", diag.resolvedName || diag.name);
    console.log("Port:", diag.port);
    console.log("Driver:", diag.driver);
    console.log("Status:", diag.status);
    if (diag.workOffline) {
      console.warn("Warning: printer is WorkOffline in Windows.");
    }
  } else {
    console.warn("Diagnostics:", diag.error);
  }
  console.log("");

  const sample = buildTestPrintPlainText();
  const r = await printPlainTextWindows(printerName, sample, "Test print", {
    skipElectronPrint: true,
  });

  if (!r.ok) {
    console.error("FAILED:", r.error);
    process.exit(1);
  }

  console.log("SUCCESS");
  console.log("Method:", r.method);
  if (r.proof) console.log("Proof:", r.proof);
  console.log("");
  console.log("If paper printed, the installed POS app will use the same path.");
  console.log("After one success in the app, it reuses method:", r.method);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
