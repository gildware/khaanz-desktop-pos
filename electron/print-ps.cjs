const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getPrintTempDir } = require("./print-temp.cjs");

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShellScript(script, timeoutMs = 60_000) {
  const dir = getPrintTempDir();
  const scriptPath = path.join(dir, `ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, script, "utf8");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
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

module.exports = { runPowerShellScript, psQuote };
