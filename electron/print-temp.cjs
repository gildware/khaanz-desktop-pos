const path = require("path");
const os = require("os");

/** Temp dir for print scripts — works in Electron and standalone `node scripts/test-windows-print.cjs`. */
function getPrintTempDir() {
  const base =
    process.env.KHAANZ_PRINT_TEMP ||
    (() => {
      try {
        const { app } = require("electron");
        return app.getPath("temp");
      } catch {
        return os.tmpdir();
      }
    })();
  const dir = path.join(base, "khaanz-print");
  const fs = require("fs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { getPrintTempDir };
