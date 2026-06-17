const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { buildEscPosBuffer, buildPlainTextBuffer, buildCashDrawerKickBuffer } = require("./escpos-buffer.cjs");
const { appendPrintLog } = require("./print-log.cjs");
const { printReceiptElectron } = require("./print-electron-receipt.cjs");
const { reorderAttempts } = require("./print-strategy-windows.cjs");
const {
  isLikelyReceiptPrinterName,
  normalizePrinterKey,
  printerNamesLooselyMatch,
} = require("./printer-resolve.cjs");

const LPR = "/usr/bin/lpr";
const LPSTAT = "/usr/bin/lpstat";
const LPR_TIMEOUT_MS = 10_000;
/** Fail fast when probing raw modes that the driver does not support. */
const LPR_PROBE_TIMEOUT_MS = 2500;

/** @type {Map<string, { cupsName: string; at: number }>} */
const cupsQueueCache = new Map();
const CUPS_CACHE_TTL_MS = 5 * 60_000;

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
  if (partial) return partial;
  const key = normalizePrinterKey(name);
  if (key) {
    const byKey = queues.find((q) => normalizePrinterKey(q) === key);
    if (byKey) return byKey;
    const fuzzy = queues.find((q) => printerNamesLooselyMatch(q, name));
    if (fuzzy) return fuzzy;
  }
  return name;
}

async function resolveCupsQueueNameCached(requested) {
  const name = String(requested || "").trim();
  if (!name) return "";
  const hit = cupsQueueCache.get(name);
  if (hit && Date.now() - hit.at < CUPS_CACHE_TTL_MS) return hit.cupsName;
  const cupsName = await resolveCupsQueueName(name);
  cupsQueueCache.set(name, { cupsName, at: Date.now() });
  return cupsName;
}

function clearCupsQueueCache() {
  cupsQueueCache.clear();
}

/** CUPS queue online check. */
async function checkMacPrinterOnline(printerName) {
  const name = String(printerName || "").trim();
  if (!name) return { online: false, detail: "No printer selected" };

  const queues = await listCupsQueues();
  const cupsName = await resolveCupsQueueName(name);
  if (queues.length && !queues.includes(cupsName)) {
    const fuzzy = queues.find((q) => printerNamesLooselyMatch(q, name));
    if (!fuzzy) {
      return { online: false, detail: "Printer queue not found in CUPS." };
    }
  }
  const lpstatQueue =
    queues.length && queues.includes(cupsName)
      ? cupsName
      : queues.find((q) => printerNamesLooselyMatch(q, name)) || cupsName;

  try {
    const out = await new Promise((resolve, reject) => {
      const proc = spawn(LPSTAT, ["-p", lpstatQueue], { stdio: ["ignore", "pipe", "pipe"] });
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
    const head = (out.split("\n")[0] || "").trim();
    if (/printer\s+.+\s+(disabled|offline|paused)\b/i.test(head)) {
      return { online: false, detail: "Printer is offline or disabled." };
    }
    if (/does not exist|unknown printer/i.test(out)) {
      return { online: false, detail: "Printer queue not found." };
    }
    return { online: true, detail: "", cupsName: lpstatQueue };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/not found|unknown|does not exist/i.test(msg)) {
      return { online: false, detail: "Printer queue not found." };
    }
    return { online: false, detail: msg };
  }
}

async function lprBuffer(cupsName, buffer, title, raw, methodId, timeoutMs = LPR_TIMEOUT_MS) {
  const dir = getPrintTempDir();
  const ext = raw ? "bin" : "txt";
  const filePath = path.join(dir, `job-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  const args = raw
    ? ["-P", cupsName, "-o", "raw", "-J", title || "Receipt", filePath]
    : ["-P", cupsName, "-J", title || "Receipt", filePath];
  try {
    await runCommand(LPR, args, timeoutMs);
    return { ok: true, method: methodId };
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

function buildMacCupsAttempts(cupsName, body, safeTitle, options = {}) {
  const rawFirst = isLikelyReceiptPrinterName(cupsName);
  const base = rawFirst
    ? [
        {
          methodId: "escpos-raw",
          run: (timeoutMs) =>
            lprBuffer(cupsName, buildEscPosBuffer(body), safeTitle, true, "escpos-raw", timeoutMs),
        },
        {
          methodId: "text-raw",
          run: (timeoutMs) =>
            lprBuffer(
              cupsName,
              buildPlainTextBuffer(body),
              safeTitle,
              true,
              "text-raw",
              timeoutMs,
            ),
        },
        {
          methodId: "cups-text",
          run: (timeoutMs) =>
            lprBuffer(
              cupsName,
              buildPlainTextBuffer(body),
              safeTitle,
              false,
              "cups-text",
              timeoutMs,
            ),
        },
      ]
    : [
        {
          methodId: "cups-text",
          run: (timeoutMs) =>
            lprBuffer(
              cupsName,
              buildPlainTextBuffer(body),
              safeTitle,
              false,
              "cups-text",
              timeoutMs,
            ),
        },
        {
          methodId: "escpos-raw",
          run: (timeoutMs) =>
            lprBuffer(cupsName, buildEscPosBuffer(body), safeTitle, true, "escpos-raw", timeoutMs),
        },
        {
          methodId: "text-raw",
          run: (timeoutMs) =>
            lprBuffer(
              cupsName,
              buildPlainTextBuffer(body),
              safeTitle,
              true,
              "text-raw",
              timeoutMs,
            ),
        },
      ];
  return reorderAttempts(base, options.preferredMethod);
}

function lprTimeoutForAttempt(methodId, hasPreferred) {
  if (methodId === "cups-text") return LPR_TIMEOUT_MS;
  if (hasPreferred) return LPR_PROBE_TIMEOUT_MS;
  return LPR_PROBE_TIMEOUT_MS;
}

/**
 * Print receipt on macOS — CUPS (cached preferred method first), then Electron GDI.
 * When options.escPosBytes is set, sends one raw ESC/POS job (logo + text) immediately.
 */
async function printPlainTextMac(printerName, text, title, options = {}) {
  const name = String(printerName || "").trim();
  if (!name) return { ok: false, error: "No printer selected." };
  const body = String(text || "").trim();
  if (!body) return { ok: false, error: "Nothing to print." };

  const cupsName = await resolveCupsQueueNameCached(name);
  const safeTitle = title || "Receipt";

  if (options.escPosBytes && Buffer.isBuffer(options.escPosBytes)) {
    try {
      await lprBuffer(cupsName, options.escPosBytes, safeTitle, true, "escpos-raw", LPR_TIMEOUT_MS);
      appendPrintLog({
        event: "print-ok",
        platform: "darwin",
        method: "escpos-raw-logo",
        printer: cupsName,
        title: safeTitle,
      });
      return { ok: true, method: "escpos-raw-logo", deviceName: cupsName };
    } catch (e) {
      const detail = String(e && e.message ? e.message : e);
      appendPrintLog({
        event: "print-fallback",
        platform: "darwin",
        method: "escpos-raw-logo",
        printer: cupsName,
        error: detail,
      });
      return {
        ok: false,
        error: `Logo print failed (${detail}). Try Test print, then Save & Bill again.`,
      };
    }
  }
  const errors = [];
  const preferred = String(options.preferredMethod || "").trim();
  const cupsAttempts = buildMacCupsAttempts(cupsName, body, safeTitle, options);
  const triedPreferred = new Set();

  async function runAttempt(attempt, timeoutMs) {
    const r = await attempt.run(timeoutMs);
    appendPrintLog({
      event: "print-ok",
      platform: "darwin",
      method: r.method,
      printer: cupsName,
      title: safeTitle,
    });
    return { ok: true, method: r.method, deviceName: cupsName };
  }

  if (preferred && preferred !== "electron") {
    const pref = cupsAttempts.find((a) => a.methodId === preferred);
    if (pref) {
      triedPreferred.add(preferred);
      try {
        return await runAttempt(pref, LPR_TIMEOUT_MS);
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        errors.push(`${preferred}: ${msg}`);
      }
    }
  }

  for (const attempt of cupsAttempts) {
    if (triedPreferred.has(attempt.methodId)) continue;
    const timeoutMs = lprTimeoutForAttempt(attempt.methodId, Boolean(preferred));
    try {
      return await runAttempt(attempt, timeoutMs);
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

/** Pulse the cash drawer on the CUPS receipt queue. */
async function openCashDrawerMac(deviceName) {
  const wanted = String(deviceName || "").trim();
  if (!wanted) {
    return { ok: false, error: "No printer selected." };
  }
  const cupsName = await resolveCupsQueueNameCached(wanted);
  if (!cupsName) {
    return { ok: false, error: "Printer not found." };
  }

  const { buildCashDrawerKickBufferDle } = require("./escpos-buffer.cjs");
  const kicks = [
    buildCashDrawerKickBuffer(0),
    buildCashDrawerKickBuffer(1),
    buildCashDrawerKickBufferDle(),
  ];
  const errors = [];
  for (let i = 0; i < kicks.length; i++) {
    try {
      await lprBuffer(
        cupsName,
        kicks[i],
        "Cash drawer",
        true,
        `cash-drawer-${i}`,
        LPR_TIMEOUT_MS,
      );
      return { ok: true, method: "escpos-cash-drawer", deviceName: cupsName };
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e));
    }
  }
  return { ok: false, error: errors.join(" | ") || "Cash drawer pulse failed." };
}

module.exports = {
  checkMacPrinterOnline,
  resolveCupsQueueName,
  resolveCupsQueueNameCached,
  clearCupsQueueCache,
  printPlainTextMac,
  openCashDrawerMac,
};
