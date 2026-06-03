const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { buildEscPosBuffer, buildPlainTextBuffer } = require("./escpos-buffer.cjs");
const { appendPrintLog } = require("./print-log.cjs");
const { printReceiptElectron } = require("./print-electron-receipt.cjs");

const LPR = "/usr/bin/lpr";
const LPSTAT = "/usr/bin/lpstat";

function getPrintTempDir() {
  let base;
  try {
    const { app } = require("electron");
    if (app?.getPath) base = app.getPath("temp");
  } catch {
    /* not in Electron */
  }
  const dir = path.join(base || os.tmpdir(), "khaanz-print");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCommand(bin, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: "ignore" });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exited with code ${code}`));
    });
  });
}

async function listCupsQueues() {
  try {
    const out = await new Promise((resolve, reject) => {
      const proc = spawn(LPSTAT, ["-a"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      proc.stdout.on("data", (d) => {
        stdout += d;
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`lpstat -a failed (${code})`));
      });
    });
    return out
      .split("\n")
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Map Electron/Chromium printer name → CUPS queue name. */
async function resolveCupsQueueName(requested) {
  const name = String(requested || "").trim();
  if (!name) return "";
  const queues = await listCupsQueues();
  if (!queues.length) return name;
  if (queues.includes(name)) return name;
  const lower = name.toLowerCase();
  const exact = queues.find((q) => q.toLowerCase() === lower);
  if (exact) return exact;
  const partial = queues.find(
    (q) => q.toLowerCase().includes(lower) || lower.includes(q.toLowerCase()),
  );
  return partial || name;
}

/** CUPS queue online check. */
async function checkMacPrinterOnline(printerName) {
  const name = String(printerName || "").trim();
  if (!name) return { online: false, detail: "No printer selected" };

  const cupsName = await resolveCupsQueueName(name);
  const queues = await listCupsQueues();
  if (queues.length && !queues.includes(cupsName)) {
    return { online: false, detail: "Printer queue not found in CUPS." };
  }

  try {
    const out = await new Promise((resolve, reject) => {
      const proc = spawn(LPSTAT, ["-p", cupsName], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += d;
      });
      proc.stderr.on("data", (d) => {
        stderr += d;
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve(`${stdout}\n${stderr}`);
        else reject(new Error(stderr || stdout || `lpstat failed (${code})`));
      });
    });
    if (/disabled|offline|paused|not found|does not exist|unknown/i.test(out)) {
      return { online: false, detail: "Printer is offline or disabled." };
    }
    return { online: true, detail: "", cupsName };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/not found|unknown|does not exist/i.test(msg)) {
      return { online: false, detail: "Printer queue not found." };
    }
    return { online: false, detail: msg };
  }
}

async function lprBuffer(cupsName, buffer, title, raw, methodId) {
  const dir = getPrintTempDir();
  const ext = raw ? "bin" : "txt";
  const filePath = path.join(dir, `job-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  const args = raw
    ? ["-P", cupsName, "-o", "raw", "-J", title || "Receipt", filePath]
    : ["-P", cupsName, "-J", title || "Receipt", filePath];
  try {
    await runCommand(LPR, args, 10_000);
    return { ok: true, method: methodId };
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Print receipt on macOS — tries ESC/POS raw (thermal), plain CUPS, then Electron GDI.
 */
async function printPlainTextMac(printerName, text, title) {
  const name = String(printerName || "").trim();
  if (!name) return { ok: false, error: "No printer selected." };
  const body = String(text || "").trim();
  if (!body) return { ok: false, error: "Nothing to print." };

  const cupsName = await resolveCupsQueueName(name);
  const safeTitle = title || "Receipt";
  const errors = [];

  const cupsAttempts = [
    {
      methodId: "escpos-raw",
      run: () => lprBuffer(cupsName, buildEscPosBuffer(body), safeTitle, true, "escpos-raw"),
    },
    {
      methodId: "text-raw",
      run: () => lprBuffer(cupsName, buildPlainTextBuffer(body), safeTitle, true, "text-raw"),
    },
    {
      methodId: "cups-text",
      run: () => lprBuffer(cupsName, buildPlainTextBuffer(body), safeTitle, false, "cups-text"),
    },
  ];

  for (const attempt of cupsAttempts) {
    try {
      const r = await attempt.run();
      appendPrintLog({
        event: "print-ok",
        platform: "darwin",
        method: r.method,
        printer: cupsName,
        title: safeTitle,
      });
      return { ok: true, method: r.method, deviceName: cupsName };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      errors.push(`${attempt.methodId}: ${msg}`);
    }
  }

  try {
    const r = await printReceiptElectron(cupsName, body, safeTitle);
    if (r.ok) {
      return { ok: true, method: r.method || "electron", deviceName: cupsName };
    }
    errors.push(`electron: ${r.error || "failed"}`);
  } catch (e) {
    errors.push(`electron: ${String(e && e.message ? e.message : e)}`);
  }

  appendPrintLog({
    event: "print-failed",
    platform: "darwin",
    printer: cupsName,
    title: safeTitle,
    errors,
  });

  return {
    ok: false,
    error: errors.length
      ? `Print failed (${errors.length} tries): ${errors.join(" | ")}`
      : "Print failed. Check the printer is on and selected correctly.",
  };
}

module.exports = {
  checkMacPrinterOnline,
  resolveCupsQueueName,
  printPlainTextMac,
};
