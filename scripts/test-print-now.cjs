#!/usr/bin/env node
/** Quick headless print smoke test — run from pos-desktop after npm install. */
const { app } = require("electron");
const { buildTestPrintPlainText } = require("../electron/thermal-print.cjs");

const printerName = process.argv[2] || "";

app.whenReady().then(async () => {
  const { printPlainTextMac } = require("../electron/print-mac.cjs");
  const { printReceiptElectron } = require("../electron/print-electron-receipt.cjs");
  const { printPlainTextWindows } = require("../electron/windows-printer.cjs");

  const sample = buildTestPrintPlainText();
  let r;

  if (process.platform === "win32") {
    if (!printerName) {
      console.error('Usage: node scripts/test-print-now.cjs "Your Printer Name"');
      app.exit(1);
      return;
    }
    r = await printPlainTextWindows(printerName, sample, "Test");
  } else if (process.platform === "darwin") {
    const name = printerName || "default";
    if (printerName) {
      r = await printPlainTextMac(printerName, sample, "Test");
    } else {
      console.log("No printer name — trying electron default path only.");
      r = { ok: false, error: "pass printer name" };
    }
    if (!r.ok && printerName) {
      console.log("CUPS methods failed:", r.error);
      console.log("Trying Electron print…");
      r = await printReceiptElectron(printerName, sample, "Test");
    }
  } else {
    r = { ok: false, error: "Unsupported platform" };
  }

  console.log(JSON.stringify(r, null, 2));
  app.exit(r.ok ? 0 : 1);
});
