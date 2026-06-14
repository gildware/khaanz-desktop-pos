const { BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const { wrapThermalPrintDocument } = require("./thermal-print.cjs");

/**
 * Petpooja-style printing: Chromium GDI job through the Windows printer driver.
 * Works with BillQuick Lite / POS 203DPI GDI drivers that ignore RAW ESC/POS.
 */
async function printReceiptGdiWindows(deviceName, plainText, title) {
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
  const tempFile = path.join(printDir, `gdi-${Date.now()}.html`);
  fs.writeFileSync(tempFile, doc, "utf8");

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: true,
      x: -32000,
      y: -32000,
      width: 380,
      height: 2400,
      frame: false,
      skipTaskbar: true,
      backgroundColor: "#ffffff",
      webPreferences: { sandbox: false },
    });

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(outerTimer);
      try {
        fs.unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const outerTimer = setTimeout(
      () => settle({ ok: false, error: "GDI print timed out" }),
      90_000,
    );

    win.webContents.once("did-fail-load", (_e, _c, desc) =>
      settle({ ok: false, error: desc || "Failed to load receipt" }),
    );

    win.webContents.once("did-finish-load", () => {
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, 80));
          await win.webContents.executeJavaScript(`
            new Promise((resolve) => {
              const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
              if (document.fonts && document.fonts.ready) document.fonts.ready.then(done).catch(done);
              else done();
            })
          `);

          const hasText = await win.webContents.executeJavaScript(
            `Boolean((document.body && document.body.innerText || "").trim().length)`,
          );
          if (!hasText) {
            settle({ ok: false, error: "Receipt empty" });
            return;
          }

          await new Promise((resolvePrint) => {
            let done = false;
            const finish = (success, failureReason) => {
              if (done) return;
              done = true;
              clearTimeout(t);
              if (success) resolvePrint({ ok: true, method: "gdi" });
              else resolvePrint({ ok: false, error: failureReason || "GDI print failed" });
            };
            const t = setTimeout(() => finish(false, "GDI print timed out"), 75_000);
            try {
              win.webContents.print(
                {
                  silent: true,
                  printBackground: false,
                  color: false,
                  deviceName: name,
                  margins: { marginType: "custom", top: 0, bottom: 0, left: 0, right: 0 },
                  pageSize: { width: 80000, height: 200000 },
                },
                finish,
              );
            } catch (e) {
              finish(false, String(e && e.message ? e.message : e));
            }
          }).then(settle);
        } catch (e) {
          settle({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      })();
    });

    win.loadFile(tempFile);
  });
}

module.exports = { printReceiptGdiWindows };
