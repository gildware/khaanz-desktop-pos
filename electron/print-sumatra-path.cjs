const fs = require("fs");
const path = require("path");

/**
 * pdf-to-printer ships SumatraPDF*.exe in its `dist` folder. In a packaged
 * Electron app that binary lives under `app.asar.unpacked` (it cannot be spawned
 * from inside the compressed `app.asar`), and the library's own resolution points
 * inside `app.asar` → silent `ENOENT`. We must pass an explicit `sumatraPdfPath`,
 * so resolve the real on-disk location here.
 */
function findSumatraExe(distDir) {
  try {
    for (const file of fs.readdirSync(distDir)) {
      if (/^SumatraPDF.*\.exe$/i.test(file)) {
        return path.join(distDir, file);
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

function resolveSumatraPdfPath() {
  const candidates = [];

  // 1) Wherever node resolves the module from (dev + packaged).
  try {
    const pkg = require.resolve("pdf-to-printer/package.json");
    let distDir = path.join(path.dirname(pkg), "dist");
    if (distDir.includes(`app.asar${path.sep}`)) {
      distDir = distDir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    }
    candidates.push(distDir);
  } catch {
    /* ignore */
  }

  // 2) Explicit packaged location next to the app resources.
  try {
    if (process.resourcesPath) {
      candidates.push(
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "pdf-to-printer",
          "dist",
        ),
      );
    }
  } catch {
    /* ignore */
  }

  for (const dir of candidates) {
    const exe = findSumatraExe(dir);
    if (exe && fs.existsSync(exe)) return exe;
  }
  return "";
}

module.exports = { resolveSumatraPdfPath };
