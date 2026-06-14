const { BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { wrapThermalPrintDocument } = require("./thermal-print.cjs");
const { resolveSumatraPdfPath } = require("./print-sumatra-path.cjs");
const { appendPrintLog } = require("./print-log.cjs");

const MM_PER_INCH = 25.4;
const MICRONS_PER_INCH = 25400;
const CSS_DPI = 96;

/**
 * Petpooja-style: render the receipt HTML → a single content-height PDF page →
 * silent print to the named queue via SumatraPDF (pdf-to-printer). This is the most
 * reliable silent path on Windows GDI drivers (BillQuick Lite, POS 203DPI, Epson TM…).
 *
 * Two things make-or-break this on a real shop PC:
 *  - `sumatraPdfPath` MUST be explicit, or the packaged app fails with ENOENT.
 *  - the PDF page height MUST match the receipt content, or a fixed-height page
 *    either feeds a long blank strip or shrinks the text to nothing.
 */
async function printReceiptPdfWindows(deviceName, plainText, title) {
  const name = String(deviceName || "").trim();
  if (!name) return { ok: false, error: "No printer name" };
  const body = String(plainText || "").trim();
  if (!body) return { ok: false, error: "Nothing to print" };

  const sumatraPdfPath = resolveSumatraPdfPath();
  if (!sumatraPdfPath) {
    return {
      ok: false,
      error:
        "SumatraPDF.exe not found (pdf-to-printer not unpacked). Check asarUnpack for pdf-to-printer.",
    };
  }

  const safe = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const doc = wrapThermalPrintDocument(`<pre>${safe}</pre>`, title || "Receipt");

  const printDir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(printDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const htmlPath = path.join(printDir, `r-${stamp}.html`);
  const pdfPath = path.join(printDir, `r-${stamp}.pdf`);
  fs.writeFileSync(htmlPath, doc, "utf8");

  // 80mm roll — content and page share the same width so SumatraPDF does not
  // shrink the receipt and leave empty margins on the right.
  const pageWidthMm = 80;
  const pageWidthMicrons = Math.round((pageWidthMm / MM_PER_INCH) * MICRONS_PER_INCH);

  const win = new BrowserWindow({
    show: false,
    width: 380,
    height: 1200,
    webPreferences: { sandbox: false },
  });

  try {
    await win.loadFile(htmlPath);
    // Let fonts/layout settle so measurement and rendering are stable.
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(done).catch(done);
        else done();
      })
    `);
    await new Promise((r) => setTimeout(r, 80));

    const contentPx = await win.webContents.executeJavaScript(`
      Math.ceil(Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      ))
    `);
    const heightPx = Math.max(120, Number(contentPx) || 0) + 24;
    const heightMicrons = Math.round((heightPx / CSS_DPI) * MICRONS_PER_INCH);

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: false,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: { width: pageWidthMicrons, height: heightMicrons },
    });
    fs.writeFileSync(pdfPath, pdfBuffer);

    const { print } = require("pdf-to-printer");
    await print(pdfPath, {
      printer: name,
      sumatraPdfPath,
      scale: "fit",
      orientation: "portrait",
      silent: true,
    });

    appendPrintLog({
      event: "pdf-print-ok",
      printer: name,
      sumatraPdfPath,
      heightPx,
    });
    return { ok: true, method: "pdf" };
  } catch (e) {
    const error = String(e && e.message ? e.message : e);
    appendPrintLog({ event: "pdf-print-error", printer: name, sumatraPdfPath, error });
    return { ok: false, error };
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
