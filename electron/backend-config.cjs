const fs = require("fs");
const path = require("path");

/** @param {string} raw */
function normalizeApiOrigin(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

/** @param {string} filePath */
function parseEnvFile(filePath) {
  const out = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** @param {string} userDataDir */
function userDataEnvPath(userDataDir) {
  return path.join(userDataDir, ".env");
}

/**
 * @param {string} userDataDir
 * @param {Record<string, string>} updates
 */
function writeUserDataEnv(userDataDir, updates) {
  const envPath = userDataEnvPath(userDataDir);
  const existing = parseEnvFile(envPath);
  const merged = { ...existing, ...updates };
  const lines = [
    "# Khaanz POS — backend connection (saved from the app)",
    ...Object.entries(merged).map(([key, val]) => {
      const escaped = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}="${escaped}"`;
    }),
    "",
  ];
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(envPath, lines.join("\n"), "utf8");
}

/**
 * @param {import('electron').App} electronApp
 */
function readStoredBackendConfig(electronApp) {
  const userData = electronApp.getPath("userData");
  const fromFile = parseEnvFile(userDataEnvPath(userData));
  const apiOrigin = normalizeApiOrigin(
    fromFile.KHAANZ_API_ORIGIN || process.env.KHAANZ_API_ORIGIN || "",
  );
  const syncKey = (fromFile.KHAANZ_SYNC_KEY || process.env.KHAANZ_SYNC_KEY || "").trim();
  return {
    apiOrigin,
    syncKey,
    configured: Boolean(apiOrigin && syncKey),
    userDataEnvPath: userDataEnvPath(userData),
    hasStoredFile: fs.existsSync(userDataEnvPath(userData)),
  };
}

/**
 * @param {import('electron').App} electronApp
 * @param {{ apiOrigin: string, syncKey: string }} input
 */
function applyBackendConfig(electronApp, input) {
  const apiOrigin = normalizeApiOrigin(input.apiOrigin);
  const syncKey = String(input.syncKey || "").trim();
  if (!apiOrigin) return { ok: false, error: "Enter your site domain (e.g. khaanz.com)" };
  if (!syncKey) return { ok: false, error: "Enter the sync key (POS_SYNC_KEY from your server)" };

  const userData = electronApp.getPath("userData");
  writeUserDataEnv(userData, {
    KHAANZ_API_ORIGIN: apiOrigin,
    KHAANZ_SYNC_KEY: syncKey,
  });
  process.env.KHAANZ_API_ORIGIN = apiOrigin;
  process.env.KHAANZ_SYNC_KEY = syncKey;

  return {
    ok: true,
    apiOrigin,
    syncKeyConfigured: true,
    userDataEnvPath: userDataEnvPath(userData),
  };
}

module.exports = {
  normalizeApiOrigin,
  readStoredBackendConfig,
  applyBackendConfig,
  userDataEnvPath,
};
