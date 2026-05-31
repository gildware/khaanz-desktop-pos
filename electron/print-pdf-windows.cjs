const { BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { wrapThermalPrintDocument } = require("./thermal-print.cjs");

/**
 * Petpooja-style: render receipt HTML → PDF → silent print to named queue.
 * Most reliable on Windows GDI drivers (BillQuick Lite, POS 203DPI).
 */
async function printReceiptPdfWindows(deviceName, plainText, title) {
  const name = String(deviceName || "").trim();
  if (!name) return { ok: false, error: "No printer name" };
  const body = String(plainText || "").trim();
  if (!body) return { ok: false, error: "Nothing to print" };

  const safe = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const doc = wrapThermalPrintDocument(`<pre>${safe}</pre>`, title || "Receipt");

  const printDir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(printDir, { recursive: true });
  const htmlPath = path.join(printDir, `r-${Date.now()}.html`);
  const pdfPath = path.join(printDir, `r-${Date.now()}.pdf`);
  fs.writeFileSync(htmlPath, doc, "utf8");

  const win = new BrowserWindow({
    show: false,
    width: 380,
    height: 2000,
    webPreferences: { sandbox: false },
  });

  try {
    await win.loadFile(htmlPath);
    await new Promise((r) => setTimeout(r, 800));
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: false,
      marginsType: 0,
      pageSize: { width: 80000, height: 280000 },
    });
    fs.writeFileSync(pdfPath, pdfBuffer);

    const { print } = require("pdf-to-printer");
    await print(pdfPath, { printer: name, silent: true });

    return { ok: true, method: "pdf" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      /* ignore */
    }
    for (const p of [htmlPath, pdfPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { printReceiptPdfWindows };
