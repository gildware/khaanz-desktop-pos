const { BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const { wrapThermalPrintDocument } = require("./thermal-print.cjs");
const { getThermalPrintOptions } = require("./thermal-print-windows.cjs");
const { appendPrintLog } = require("./print-log.cjs");

/**
 * Silent receipt print through Chromium → OS print queue.
 * Works for GDI-style drivers (HP, Canon, many macOS thermal drivers).
 */
async function printReceiptElectron(deviceName, plainText, title) {
  const name = String(deviceName || "").trim();
  if (!name) return { ok: false, error: "No printer name." };
  const body = String(plainText || "").trim();
  if (!body) return { ok: false, error: "Nothing to print." };

  const safe = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const doc = wrapThermalPrintDocument(`<pre>${safe}</pre>`, title || "Receipt");

  const printDir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(printDir, { recursive: true });
  const tempFile = path.join(printDir, `electron-${Date.now()}.html`);
  fs.writeFileSync(tempFile, doc, "utf8");

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: process.platform === "win32",
      x: process.platform === "win32" ? -32000 : undefined,
      y: process.platform === "win32" ? -32000 : undefined,
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
      if (result.ok) {
        appendPrintLog({
          event: "print-ok",
          method: "electron",
          printer: name,
          platform: process.platform,
        });
      } else {
        appendPrintLog({
          event: "print-failed",
          method: "electron",
          printer: name,
          platform: process.platform,
          error: result.error,
        });
      }
      resolve(result);
    };

    const outerTimer = setTimeout(
      () => settle({ ok: false, error: "Electron print timed out." }),
      40_000,
    );

    win.webContents.once("did-fail-load", (_e, _c, desc) =>
      settle({ ok: false, error: desc || "Failed to load receipt." }),
    );

    win.webContents.once("did-finish-load", () => {
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, 800));
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
            settle({ ok: false, error: "Receipt empty." });
            return;
          }

          const options = getThermalPrintOptions(name);
          await new Promise((resolvePrint) => {
            let done = false;
            const finish = (success, failureReason) => {
              if (done) return;
              done = true;
              clearTimeout(t);
              if (success) {
                resolvePrint({ ok: true, method: "electron", deviceName: name });
              } else {
                resolvePrint({
                  ok: false,
                  error: failureReason || "Electron print failed.",
                });
              }
            };
            const t = setTimeout(() => finish(false, "Print callback timed out."), 30_000);
            try {
              win.webContents.print(options, finish);
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

module.exports = { printReceiptElectron };
