const { app, BrowserWindow, ipcMain, net } = require("electron");
const { initAutoUpdater, autoUpdater } = require("./auto-updater.cjs");
const path = require("path");
const os = require("os");
const fs = require("fs");
const Database = require("better-sqlite3");

const isDev = !app.isPackaged;

/** Load KEY=VALUE pairs from a .env file (does not override existing process.env). */
function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// Dev / repo: pos-desktop/.env — packaged app can also use userData/.env (loaded in whenReady).
loadEnvFile(path.join(__dirname, "..", ".env"));

function userDataDir() {
  return app.getPath("userData");
}

function dbPath() {
  return path.join(userDataDir(), "pos.sqlite");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function openDb() {
  ensureDir(userDataDir());
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      client_order_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by_user_id TEXT REFERENCES users(id),
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id TEXT,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      line_subtotal_cents INTEGER NOT NULL,
      line_tax_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT,
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_outbox_unsent ON sync_outbox(sent_at, created_at);

    CREATE TABLE IF NOT EXISTS menu_cache (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS offline_pos_queue (
      client_order_id TEXT PRIMARY KEY,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_orders_cache (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings_cache (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const v = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get();
  if (!v) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1')").run();
  }

  const orderCols = db.prepare("PRAGMA table_info(orders)").all();
  if (!orderCols.some((c) => c.name === "fulfillment")) {
    db.exec("ALTER TABLE orders ADD COLUMN fulfillment TEXT NOT NULL DEFAULT 'pickup'");
  }
}

function enqueueOfflinePosOrder(clientOrderId, body) {
  const id = String(clientOrderId || "").trim();
  if (!id || !body || typeof body !== "object") {
    return { ok: false, error: "Invalid offline row" };
  }
  try {
    const bodyJson = JSON.stringify(body);
    const t0 = nowIso();
    db.prepare(
      "INSERT OR REPLACE INTO offline_pos_queue(client_order_id, body_json, created_at) VALUES(?,?,?)",
    ).run(id, bodyJson, t0);

    db.prepare(
      "INSERT OR REPLACE INTO sync_outbox(id,type,payload_json,created_at,attempt_count,last_error,last_attempt_at,sent_at) VALUES(?,?,?,?,0,NULL,NULL,NULL)",
    ).run(
      `pos_evt_${id}`,
      "pos.orderPayload",
      JSON.stringify({ clientOrderId: id, body }),
      t0,
    );

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function offlineRefForClientOrderId(clientOrderId) {
  return `OFF-${String(clientOrderId).replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

function getSyncPendingCount(db) {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE sent_at IS NULL").get();
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

function readRemoteOrdersJson(db) {
  try {
    const row = db
      .prepare("SELECT payload_json AS payloadJson FROM remote_orders_cache WHERE id='recent'")
      .get();
    return row && typeof row.payloadJson === "string" ? row.payloadJson : "";
  } catch {
    return "";
  }
}

function writeRemoteOrdersJson(db, payloadJson) {
  const s = String(payloadJson || "");
  if (!s) return;
  db.prepare(
    "INSERT INTO remote_orders_cache(id,payload_json,updated_at) VALUES('recent',?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at",
  ).run(s, nowIso());
}

function patchRemoteOrderStatus(db, orderId, status, statusLabel) {
  const raw = readRemoteOrdersJson(db);
  if (!raw) return;
  try {
    const orders = JSON.parse(raw);
    if (!Array.isArray(orders)) return;
    let changed = false;
    const next = orders.map((o) => {
      if (!o || typeof o !== "object") return o;
      const id = o.id || o.clientOrderId;
      if (String(id) !== String(orderId)) return o;
      changed = true;
      return { ...o, status, statusLabel };
    });
    if (changed) writeRemoteOrdersJson(db, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function readSettingsJson(db) {
  try {
    const row = db
      .prepare("SELECT payload_json AS payloadJson FROM settings_cache WHERE id='settings'")
      .get();
    return row && typeof row.payloadJson === "string" ? row.payloadJson : "";
  } catch {
    return "";
  }
}

function istDateParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d2 = parts.find((p) => p.type === "day")?.value ?? "01";
  return { y, m, d: d2 };
}

function istStartOfDay(now) {
  const { y, m, d: day } = istDateParts(now);
  return new Date(`${y}-${m}-${day}T00:00:00+05:30`);
}

function istDateLabel(now) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);
}

function istHourFromIso(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return 0;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return Number.isFinite(hour) ? hour : 0;
}

function isTodayInIst(isoString, now) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  const start = istStartOfDay(now).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return d.getTime() >= start && d.getTime() < end;
}

function formatIstHourLabel(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function lineFromPayloadForReport(payload) {
  if (!payload || typeof payload !== "object") return null;
  const p = payload;
  const quantity =
    typeof p.quantity === "number" && Number.isFinite(p.quantity) && p.quantity > 0
      ? Math.floor(p.quantity)
      : 1;
  const unitPrice =
    typeof p.unitPrice === "number" && Number.isFinite(p.unitPrice) ? p.unitPrice : 0;
  const revenueMinor = Math.round(unitPrice * quantity * 100);

  if (p.kind === "open") {
    const name = String(p.name || "Open item");
    return {
      key: `open:${name.toLowerCase()}`,
      label: `${name} (Open)`,
      quantity,
      revenueMinor,
    };
  }
  if (p.kind === "combo") {
    const name = String(p.name || "Combo");
    const comboId = typeof p.comboId === "string" ? p.comboId : name;
    return {
      key: `combo:${comboId}`,
      label: name,
      quantity,
      revenueMinor,
    };
  }
  const name = String(p.name || "Item");
  const variation = p.variation && typeof p.variation === "object" ? p.variation : null;
  const variationName =
    variation && typeof variation.name === "string" ? variation.name : "";
  const variationId =
    variation && typeof variation.id === "string" ? variation.id : "default";
  const itemId = typeof p.itemId === "string" ? p.itemId : name;
  return {
    key: `item:${itemId}:${variationId}`,
    label: variationName ? `${name} · ${variationName}` : name,
    quantity,
    revenueMinor,
  };
}

function computeOfflineOrderTotalMinor(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.lines)) return 0;
  let totalMinor = body.lines.reduce((s, l) => {
    if (!l || typeof l !== "object") return s;
    const unit = Number(l.unitPrice || 0);
    const qty = Number(l.quantity || 0);
    if (!Number.isFinite(unit) || !Number.isFinite(qty)) return s;
    return s + Math.round(unit * qty * 100);
  }, 0);
  const deliveryMinor =
    typeof body.deliveryChargeMinor === "number" && Number.isFinite(body.deliveryChargeMinor)
      ? Math.max(0, Math.round(body.deliveryChargeMinor))
      : 0;
  const discountMinor =
    typeof body.discountMinor === "number" && Number.isFinite(body.discountMinor)
      ? Math.max(0, Math.round(body.discountMinor))
      : 0;
  totalMinor += deliveryMinor;
  return Math.max(0, totalMinor - Math.min(discountMinor, totalMinor));
}

function collectMergedReportOrders(db) {
  const seen = new Set();
  const rows = [];

  const offline = db
    .prepare(
      "SELECT client_order_id AS clientOrderId, body_json AS bodyJson, created_at AS createdAt FROM offline_pos_queue ORDER BY created_at DESC",
    )
    .all();

  for (const r of offline) {
    let body = null;
    try {
      body = JSON.parse(r.bodyJson);
    } catch {
      body = null;
    }
    seen.add(r.clientOrderId);
    rows.push({
      id: r.clientOrderId,
      status: "PENDING",
      totalMinor: computeOfflineOrderTotalMinor(body),
      createdAt: r.createdAt,
      paymentMethodKey:
        body && typeof body.paymentMethodKey === "string" ? body.paymentMethodKey.trim() : "",
      lines: Array.isArray(body?.lines)
        ? body.lines.map((payload, sortIndex) => ({ sortIndex, payload }))
        : [],
    });
  }

  const local = db
    .prepare(
      "SELECT id, client_order_id AS clientOrderId, status, total_cents AS totalCents, created_at AS createdAt FROM orders ORDER BY created_at DESC",
    )
    .all();

  for (const o of local) {
    if (seen.has(o.clientOrderId) || seen.has(o.id)) continue;
    seen.add(o.clientOrderId);
    seen.add(o.id);
    rows.push({
      id: o.id,
      status: String(o.status || "created").toUpperCase(),
      totalMinor: Number(o.totalCents || 0),
      createdAt: o.createdAt,
      paymentMethodKey: "",
      lines: [],
    });
  }

  const rawRemote = readRemoteOrdersJson(db);
  if (rawRemote) {
    try {
      const remote = JSON.parse(rawRemote);
      if (Array.isArray(remote)) {
        for (const o of remote) {
          if (!o || typeof o !== "object") continue;
          const id = o.id || o.clientOrderId;
          if (id && seen.has(String(id))) continue;
          if (id) seen.add(String(id));
          rows.push({
            id: String(id),
            status: String(o.status || "PENDING").toUpperCase(),
            totalMinor: Number(o.totalMinor || 0),
            createdAt: String(o.createdAt || ""),
            paymentMethodKey:
              typeof o.paymentMethod === "string"
                ? o.paymentMethod.trim()
                : typeof o.paymentMethodKey === "string"
                  ? o.paymentMethodKey.trim()
                  : "",
            lines: Array.isArray(o.lines) ? o.lines : [],
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  return rows;
}

function buildLocalTodayReport(db) {
  const now = new Date();
  const todayStart = istStartOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  let paymentLabels = new Map();
  const rawSettings = readSettingsJson(db);
  if (rawSettings) {
    try {
      const settings = JSON.parse(rawSettings);
      if (settings && Array.isArray(settings.paymentMethods)) {
        paymentLabels = new Map(
          settings.paymentMethods.map((p) => [String(p.id || ""), String(p.name || p.id || "")]),
        );
      }
    } catch {
      /* ignore */
    }
  }

  const orders = collectMergedReportOrders(db).filter((o) => isTodayInIst(o.createdAt, now));

  let totalSalesMinor = 0;
  let orderCount = 0;
  let cancelledCount = 0;
  const paymentMap = new Map();
  const itemMap = new Map();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: formatIstHourLabel(hour),
    orderCount: 0,
    totalMinor: 0,
  }));

  for (const order of orders) {
    const cancelled = String(order.status || "").toUpperCase() === "CANCELLED";
    if (cancelled) {
      cancelledCount += 1;
      continue;
    }

    orderCount += 1;
    const totalMinor = Number(order.totalMinor || 0);
    totalSalesMinor += totalMinor;

    const pmKey = (order.paymentMethodKey || "").trim() || "unknown";
    const pmPrev = paymentMap.get(pmKey) || { orderCount: 0, totalMinor: 0 };
    paymentMap.set(pmKey, {
      orderCount: pmPrev.orderCount + 1,
      totalMinor: pmPrev.totalMinor + totalMinor,
    });

    const hour = istHourFromIso(order.createdAt);
    const hourRow = hourly[hour];
    if (hourRow) {
      hourRow.orderCount += 1;
      hourRow.totalMinor += totalMinor;
    }

    for (const line of order.lines || []) {
      const row = lineFromPayloadForReport(line?.payload);
      if (!row) continue;
      const prev = itemMap.get(row.key) || {
        label: row.label,
        quantity: 0,
        revenueMinor: 0,
      };
      itemMap.set(row.key, {
        label: prev.label || row.label,
        quantity: prev.quantity + row.quantity,
        revenueMinor: prev.revenueMinor + row.revenueMinor,
      });
    }
  }

  return {
    ok: true,
    source: "local",
    dateLabel: istDateLabel(now),
    generatedAt: now.toISOString(),
    ranges: {
      todayStart: todayStart.toISOString(),
      tomorrowStart: tomorrowStart.toISOString(),
    },
    summary: {
      totalSalesMinor,
      orderCount,
      averageTicketMinor: orderCount > 0 ? Math.round(totalSalesMinor / orderCount) : 0,
      cancelledCount,
    },
    paymentMethods: [...paymentMap.entries()]
      .map(([key, v]) => ({
        key,
        label:
          key === "unknown"
            ? "Not recorded"
            : paymentLabels.get(key) || key || "Not recorded",
        orderCount: v.orderCount,
        totalMinor: v.totalMinor,
      }))
      .sort((a, b) => b.totalMinor - a.totalMinor),
    items: [...itemMap.values()]
      .map((v, i) => ({
        key: `item-${i}`,
        label: v.label,
        quantity: v.quantity,
        revenueMinor: v.revenueMinor,
      }))
      .sort((a, b) => b.revenueMinor - a.revenueMinor),
    hourly: hourly.filter((h) => h.orderCount > 0),
  };
}

function writeSettingsJson(db, payloadJson) {
  const s = String(payloadJson || "");
  if (!s) return;
  db.prepare(
    "INSERT INTO settings_cache(id,payload_json,updated_at) VALUES('settings',?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at",
  ).run(s, nowIso());
}

function defaultPosSettings() {
  return {
    displayName: "Khaanz",
    logoUrl: "",
    whatsappPhoneE164: "",
    pickup: { start: "11:00", end: "23:00" },
    delivery: { start: "11:00", end: "23:00" },
    billHeader: "",
    billFooter: "",
    paymentMethods: [
      { id: "cash", name: "Cash" },
      { id: "upi", name: "UPI" },
      { id: "mpay", name: "Mpay" },
    ],
  };
}

function readSilentPrinterNameFromDb(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='silent_printer'").get();
    return row && typeof row.value === "string" ? row.value.trim() : "";
  } catch {
    return "";
  }
}

function writeSilentPrinterNameToDb(db, deviceName) {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('silent_printer',?)").run(
    String(deviceName || "").trim(),
  );
}

async function printSilentHtml({ html, title }) {
  const max = 600_000;
  if (!html || typeof html !== "string" || html.length > max) {
    return { ok: false, error: "Invalid print payload." };
  }
  const safeTitle = typeof title === "string" && title.length < 200 ? title : "Receipt";

  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${safeTitle}</title></head><body>${html}</body></html>`;
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 900,
      webPreferences: { sandbox: false },
    });
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`;

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timeoutMs = 25_000;
    const timeout = setTimeout(() => settle({ ok: false, error: "Print timed out" }), timeoutMs);

    win.webContents.once("did-fail-load", (_e, _code, desc) => settle({ ok: false, error: desc || "Load failed" }));
    win.webContents.once("render-process-gone", (_e, details) =>
      settle({ ok: false, error: details && details.reason ? `Print crashed (${details.reason})` : "Print crashed" }),
    );

    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((r) => setTimeout(r, 150));
        const configured = readSilentPrinterNameFromDb(db);
        const fromEnv = (process.env.KHAANZ_SILENT_PRINTER || "").trim();
        const deviceName = (fromEnv || configured).trim();
        const printers = await win.webContents.getPrintersAsync();
        const chosen =
          deviceName && printers.some((p) => p.name === deviceName)
            ? deviceName
            : (printers.find((p) => p.isDefault)?.name || "").trim();

        if (!chosen) {
          settle({ ok: false, error: "No printer configured. Connect a printer first." });
          return;
        }

        let printSettled = false;
        const printTimeout = setTimeout(() => {
          if (printSettled) return;
          printSettled = true;
          settle({ ok: false, error: "Print timed out" });
        }, 15_000);

        win.webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: chosen,
            pageSize: { width: 80000, height: 300000 },
          },
          (success, failureReason) => {
            if (printSettled) return;
            printSettled = true;
            clearTimeout(printTimeout);
            if (!success) settle({ ok: false, error: failureReason || "Print failed" });
            else settle({ ok: true });
          },
        );
      } catch (e) {
        settle({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    win.loadURL(dataUrl);
  });
}

function readMenuPayloadJson(db) {
  try {
    const row = db
      .prepare("SELECT payload_json AS payloadJson FROM menu_cache WHERE id='menu'")
      .get();
    return row && typeof row.payloadJson === "string" ? row.payloadJson : "";
  } catch {
    return "";
  }
}

function writeMenuPayloadJson(db, payloadJson) {
  const s = String(payloadJson || "");
  if (!s) return;
  db.prepare(
    "INSERT INTO menu_cache(id,payload_json,updated_at) VALUES('menu',?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at",
  ).run(s, nowIso());
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  const s = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}_${s}` : s;
}

function sha256Hex(s) {
  // Use WebCrypto via Electron's global crypto in main? Not always present.
  // Keep a minimal hash using Node crypto.
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function getOrCreateDeviceId(db) {
  const existing = db.prepare("SELECT value FROM meta WHERE key='device_id'").get();
  if (existing && typeof existing.value === "string" && existing.value) return existing.value;
  const id = `dev_${os.hostname()}_${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('device_id',?)").run(id);
  db.prepare("INSERT OR IGNORE INTO devices(id, created_at) VALUES(?, ?)").run(id, nowIso());
  return id;
}

function ensureSeedData(db) {
  // Seed a default manager if no users exist.
  const c = db.prepare("SELECT COUNT(1) AS n FROM users").get();
  if (c && c.n > 0) return;
  const userId = "user_manager";
  db.prepare(
    "INSERT INTO users(id, display_name, pin_hash, role, active, updated_at) VALUES(?,?,?,?,1,?)",
  ).run(userId, "Manager", sha256Hex("1234"), "manager", nowIso());

  // Seed a tiny menu so the app is usable offline immediately.
  const items = [
    { id: "m_tea", name: "Tea", price_cents: 5000, tax_rate_bps: 0 },
    { id: "m_coffee", name: "Coffee", price_cents: 7000, tax_rate_bps: 0 },
    { id: "m_burger", name: "Burger", price_cents: 18000, tax_rate_bps: 500 },
  ];
  const stmt = db.prepare(
    "INSERT INTO menu_items(id,name,price_cents,tax_rate_bps,active,updated_at,deleted_at) VALUES(?,?,?,?,1,?,NULL)",
  );
  const t = db.transaction(() => {
    for (const it of items) stmt.run(it.id, it.name, it.price_cents, it.tax_rate_bps, nowIso());
  });
  t();

  // Seed the full MenuPayload cache too (web POS reads this shape).
  const payload = buildMenuPayloadFromLocalMenuItems(db);
  writeMenuPayloadJson(db, JSON.stringify(payload));
}

function requireActiveSession(db, sessionId) {
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT s.id AS session_id, u.id AS user_id, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.revoked_at IS NULL AND u.active = 1`,
    )
    .get(sessionId);
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").run(nowIso(), sessionId);
  return {
    sessionId: row.session_id,
    user: { id: row.user_id, displayName: row.display_name, role: row.role },
  };
}

function computeLine({ qty, unitPriceCents, taxRateBps }) {
  const lineSubtotal = qty * unitPriceCents;
  const lineTax = Math.round((lineSubtotal * taxRateBps) / 10000);
  const lineTotal = lineSubtotal + lineTax;
  return { lineSubtotal, lineTax, lineTotal };
}

function centsToRupees(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function buildMenuPayloadFromLocalMenuItems(db) {
  const rows = db
    .prepare(
      "SELECT id,name,price_cents AS priceCents FROM menu_items WHERE deleted_at IS NULL AND active=1 ORDER BY name ASC",
    )
    .all();

  const categoryName = "Menu";
  return {
    categories: [
      {
        name: categoryName,
        image: "",
        icon: "utensils-crossed",
      },
    ],
    globalAddons: [],
    combos: [],
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: categoryName,
      description: "",
      image: "",
      isVeg: true,
      recommended: undefined,
      available: true,
      variations: [
        {
          id: `${r.id}::default`,
          name: "Regular",
          price: centsToRupees(r.priceCents),
        },
      ],
      addons: [],
    })),
  };
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Khaanz POS (Offline)",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    }
  });

  hardenWindowNavigation(win);

  if (isDev) {
    const url = process.env.POS_DESKTOP_RENDERER_URL || "http://localhost:5173";
    win.loadURL(url);
    if (process.env.KHAANZ_OPEN_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    const indexHtml = path.join(app.getAppPath(), "renderer", "dist", "index.html");
    win.loadFile(indexHtml);
  }

  return win;
}

function isAllowedRendererUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("about:blank")) return true;
  if (isDev) {
    const devBase = (process.env.POS_DESKTOP_RENDERER_URL || "http://localhost:5173").replace(/\/$/, "");
    return url === devBase || url.startsWith(`${devBase}/`) || url.startsWith("http://127.0.0.1:5173");
  }
  return url.startsWith("file://");
}

function hardenWindowNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault();
  });
}

let db = null;
let mainWindow = null;

async function fetchJson(url, options) {
  return new Promise((resolve) => {
    const req = net.request({ url, method: (options && options.method) || "GET" });
    if (options && options.headers) {
      for (const [k, v] of Object.entries(options.headers)) req.setHeader(k, v);
    }
    const body = options && options.body ? options.body : null;
    if (body) req.write(body);
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(text) });
        } catch {
          resolve({ ok: false, status: res.statusCode, json: { error: "Invalid JSON from server", raw: text } });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, json: { error: String(e && e.message ? e.message : e) } }));
    req.end();
  });
}

async function checkBackendConnectivity() {
  const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
  const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
  if (!apiOrigin || !syncKey) {
    return { online: false, configured: false };
  }

  const deviceId = getOrCreateDeviceId(db);
  const pull = await fetchJson(`${apiOrigin.replace(/\/$/, "")}/api/pos-sync/pull`, {
    method: "GET",
    headers: {
      "x-pos-device-id": deviceId,
      "x-pos-sync-key": syncKey,
    },
  });

  return { online: pull.ok, configured: true };
}

function startSyncLoop() {
  const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
  if (!apiOrigin) return;

  setInterval(async () => {
    try {
      await trySyncOnce();
    } catch (e) {
      void e;
    }
  }, 5_000);
}

async function trySyncOnce() {
  const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
  const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
  if (!apiOrigin || !syncKey) return;

  const deviceId = getOrCreateDeviceId(db);
  const rows = db
    .prepare(
      "SELECT id, type, payload_json, attempt_count FROM sync_outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT 20",
    )
    .all();
  if (!rows.length) return;

  const payload = {
    deviceId,
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload_json),
    })),
  };

  const resp = await fetchJson(`${apiOrigin.replace(/\/$/, "")}/api/pos-sync/push`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pos-device-id": deviceId,
      "x-pos-sync-key": syncKey,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = resp.json && resp.json.error ? resp.json.error : `HTTP ${resp.status}`;
    const t = db.transaction(() => {
      for (const r of rows) {
        db.prepare(
          "UPDATE sync_outbox SET attempt_count=attempt_count+1, last_error=?, last_attempt_at=? WHERE id=?",
        ).run(String(err), nowIso(), r.id);
      }
    });
    t();
    return;
  }

  const acceptedIds = Array.isArray(resp.json && resp.json.acceptedEventIds)
    ? resp.json.acceptedEventIds
    : [];
  if (acceptedIds.length) {
    const stmt = db.prepare("UPDATE sync_outbox SET sent_at=? WHERE id=?");
    const delOffline = db.prepare("DELETE FROM offline_pos_queue WHERE client_order_id=?");
    const t = db.transaction(() => {
      for (const id of acceptedIds) {
        stmt.run(nowIso(), id);
        if (String(id).startsWith("pos_evt_")) {
          delOffline.run(String(id).slice("pos_evt_".length));
        }
      }
    });
    t();
  }

  const pull = await fetchJson(`${apiOrigin.replace(/\/$/, "")}/api/pos-sync/pull`, {
    method: "GET",
    headers: {
      "x-pos-device-id": deviceId,
      "x-pos-sync-key": syncKey,
    },
  });
  if (pull.ok && pull.json) {
    if (pull.json.menu) writeMenuPayloadJson(db, JSON.stringify(pull.json.menu));
    if (pull.json.settings) writeSettingsJson(db, JSON.stringify(pull.json.settings));
    if (Array.isArray(pull.json.recentOrders)) {
      writeRemoteOrdersJson(db, JSON.stringify(pull.json.recentOrders));
    }
  }
}

function registerIpc() {
  ipcMain.handle("pos:bootstrap", async () => {
    const deviceId = getOrCreateDeviceId(db);
    return { ok: true, deviceId };
  });

  ipcMain.handle("pos:loginWithPin", async (_evt, { userId, pin }) => {
    const u = db
      .prepare("SELECT id, display_name, pin_hash, role, active FROM users WHERE id=?")
      .get(String(userId || ""));
    if (!u || !u.active) return { ok: false, error: "Invalid user" };
    const pinHash = sha256Hex(String(pin || ""));
    if (pinHash !== u.pin_hash) return { ok: false, error: "Invalid PIN" };
    const sid = randomId("sess");
    const t = nowIso();
    db.prepare("INSERT INTO sessions(id,user_id,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,NULL)").run(
      sid,
      u.id,
      t,
      t,
    );
    return { ok: true, session: { id: sid, user: { id: u.id, displayName: u.display_name, role: u.role } } };
  });

  ipcMain.handle("pos:logout", async (_evt, { sessionId }) => {
    const sid = String(sessionId || "");
    if (!sid) return { ok: false, error: "Missing session" };
    db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(nowIso(), sid);
    return { ok: true };
  });

  ipcMain.handle("pos:getSession", async (_evt, { sessionId }) => {
    const s = requireActiveSession(db, String(sessionId || ""));
    if (!s) return { ok: false, error: "Unauthorized" };
    return { ok: true, session: s };
  });

  ipcMain.handle("pos:listUsers", async () => {
    const users = db
      .prepare("SELECT id, display_name AS displayName, role FROM users WHERE active=1 ORDER BY display_name ASC")
      .all();
    return { ok: true, users };
  });

  ipcMain.handle("pos:listMenuItems", async (_evt, { sessionId }) => {
    const s = requireActiveSession(db, String(sessionId || ""));
    if (!s) return { ok: false, error: "Unauthorized" };
    const items = db
      .prepare(
        "SELECT id,name,price_cents AS priceCents,tax_rate_bps AS taxRateBps,active,updated_at AS updatedAt FROM menu_items WHERE deleted_at IS NULL AND active=1 ORDER BY name ASC",
      )
      .all();
    return { ok: true, items };
  });

  ipcMain.handle("pos:getPosSettings", async () => {
    const raw = readSettingsJson(db);
    if (!raw) return { ok: true, settings: defaultPosSettings() };
    try {
      return { ok: true, settings: JSON.parse(raw) };
    } catch {
      return { ok: true, settings: defaultPosSettings() };
    }
  });

  ipcMain.handle("pos:getMenuPayload", async () => {
    const raw = readMenuPayloadJson(db);
    if (!raw) {
      const menu = buildMenuPayloadFromLocalMenuItems(db);
      writeMenuPayloadJson(db, JSON.stringify(menu));
      return { ok: true, menu };
    }
    try {
      return { ok: true, menu: JSON.parse(raw) };
    } catch {
      const menu = buildMenuPayloadFromLocalMenuItems(db);
      writeMenuPayloadJson(db, JSON.stringify(menu));
      return { ok: true, menu };
    }
  });

  // --- Web POS compatibility bridge (window.khaanzDesktop) ---
  ipcMain.handle("khaanz:print-silent-html", async (_evt, payload) => {
    const html = payload && typeof payload.html === "string" ? payload.html : "";
    const title = payload && typeof payload.title === "string" ? payload.title : "Receipt";
    return printSilentHtml({ html, title });
  });

  ipcMain.handle("khaanz:list-printers", async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return [];
      return await win.webContents.getPrintersAsync();
    } catch {
      return [];
    }
  });

  ipcMain.handle("khaanz:get-silent-printer", async () => {
    const fromEnv = (process.env.KHAANZ_SILENT_PRINTER || "").trim();
    if (fromEnv) return { deviceName: fromEnv };
    return { deviceName: readSilentPrinterNameFromDb(db) };
  });

  ipcMain.handle("khaanz:set-silent-printer", async (_evt, deviceName) => {
    try {
      writeSilentPrinterNameToDb(db, deviceName);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("khaanz:offline-enqueue", async (_evt, row) => {
    const clientOrderId = row && typeof row.clientOrderId === "string" ? row.clientOrderId.trim() : "";
    const body = row && row.body && typeof row.body === "object" ? row.body : null;
    return enqueueOfflinePosOrder(clientOrderId, body);
  });

  ipcMain.handle("khaanz:offline-get", async () => {
    try {
      const rows = db
        .prepare("SELECT client_order_id AS clientOrderId, body_json AS bodyJson, created_at AS createdAt FROM offline_pos_queue ORDER BY created_at ASC")
        .all();
      return rows.map((r) => ({
        clientOrderId: r.clientOrderId,
        body: JSON.parse(r.bodyJson),
        createdAt: r.createdAt,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle("khaanz:offline-remove", async (_evt, clientOrderId) => {
    try {
      db.prepare("DELETE FROM offline_pos_queue WHERE client_order_id=?").run(String(clientOrderId || ""));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("khaanz:pos-place-order", async (_evt, { clientOrderId, body }) => {
    const id = typeof clientOrderId === "string" ? clientOrderId.trim() : "";
    const out = enqueueOfflinePosOrder(id, body);
    if (!out.ok) return out;
    void trySyncOnce().catch(() => {});
    return { ok: true, orderRef: offlineRefForClientOrderId(id) };
  });

  ipcMain.handle("khaanz:pos-list-recent-orders", async () => {
    try {
      const offline = db
        .prepare(
          "SELECT client_order_id AS clientOrderId, body_json AS bodyJson, created_at AS createdAt FROM offline_pos_queue ORDER BY created_at DESC LIMIT 100",
        )
        .all();

      const local = db
        .prepare(
          "SELECT id, client_order_id AS clientOrderId, status, total_cents AS totalCents, created_at AS createdAt, synced_at AS syncedAt, fulfillment FROM orders ORDER BY created_at DESC LIMIT 100",
        )
        .all();

      let remote = [];
      const rawRemote = readRemoteOrdersJson(db);
      if (rawRemote) {
        try {
          const j = JSON.parse(rawRemote);
          if (Array.isArray(j)) remote = j;
        } catch {
          /* ignore */
        }
      }

      const seen = new Set();
      const rows = [];

      for (const r of offline) {
        let customerPhone = "";
        let customerName = null;
        let fulfillment = "pickup";
        let dineInTable = "";
        let totalMinor = 0;
        let lines = [];
        try {
          const body = JSON.parse(r.bodyJson);
          if (body && typeof body === "object") {
            const b = body;
            if (typeof b.phone === "string") customerPhone = b.phone;
            if (typeof b.customerName === "string") customerName = b.customerName;
            if (typeof b.fulfillment === "string") fulfillment = b.fulfillment;
            if (typeof b.tableId === "string") dineInTable = b.tableId;
            if (Array.isArray(b.lines)) {
              lines = b.lines.map((payload, sortIndex) => ({ sortIndex, payload }));
              totalMinor = b.lines.reduce((s, l) => {
                if (!l || typeof l !== "object") return s;
                const unit = Number(l.unitPrice || 0);
                const qty = Number(l.quantity || 0);
                if (!Number.isFinite(unit) || !Number.isFinite(qty)) return s;
                return s + Math.round(unit * qty * 100);
              }, 0);
              const deliveryMinor =
                typeof b.deliveryChargeMinor === "number" && Number.isFinite(b.deliveryChargeMinor)
                  ? Math.max(0, Math.round(b.deliveryChargeMinor))
                  : 0;
              const discountMinor =
                typeof b.discountMinor === "number" && Number.isFinite(b.discountMinor)
                  ? Math.max(0, Math.round(b.discountMinor))
                  : 0;
              totalMinor += deliveryMinor;
              totalMinor = Math.max(0, totalMinor - Math.min(discountMinor, totalMinor));
            }
          }
        } catch {
          /* ignore */
        }
        seen.add(r.clientOrderId);
        rows.push({
          id: r.clientOrderId,
          orderRef: offlineRefForClientOrderId(r.clientOrderId),
          status: "PENDING",
          statusLabel: "Offline",
          fulfillment,
          totalMinor,
          currency: "INR",
          createdAt: r.createdAt,
          customerName,
          customerPhone,
          source: "desktop_offline",
          dineInTable,
          lines,
        });
      }

      for (const o of local) {
        if (seen.has(o.clientOrderId) || seen.has(o.id)) continue;
        seen.add(o.clientOrderId);
        seen.add(o.id);
        rows.push({
          id: o.id,
          orderRef: String(o.clientOrderId).slice(0, 8).toUpperCase(),
          status: String(o.status || "created").toUpperCase(),
          statusLabel: o.syncedAt ? "Synced" : "Local",
          fulfillment: o.fulfillment || "pickup",
          totalMinor: Number(o.totalCents || 0),
          currency: "INR",
          createdAt: o.createdAt,
          customerName: null,
          customerPhone: "",
          source: "desktop_local",
          dineInTable: "",
          lines: [],
        });
      }

      for (const o of remote) {
        if (!o || typeof o !== "object") continue;
        const id = o.id || o.clientOrderId;
        if (id && seen.has(String(id))) continue;
        if (id) seen.add(String(id));
        rows.push(o);
      }

      rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

      return { ok: true, orders: rows.slice(0, 100) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("khaanz:pos-today-report", async () => {
    const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
    const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
    const deviceId = getOrCreateDeviceId(db);

    if (apiOrigin && syncKey) {
      const resp = await fetchJson(`${apiOrigin.replace(/\/$/, "")}/api/pos-sync/sales-summary`, {
        method: "GET",
        headers: {
          "x-pos-device-id": deviceId,
          "x-pos-sync-key": syncKey,
        },
      });
      if (resp.ok && resp.json && resp.json.ok) {
        return { ok: true, report: resp.json };
      }
    }

    try {
      return { ok: true, report: buildLocalTodayReport(db) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("khaanz:pos-update-order-status", async (_evt, { orderId, status }) => {
    const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
    const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
    const id = String(orderId || "").trim();
    const nextStatus = String(status || "").trim().toUpperCase();

    if (!id) return { ok: false, error: "Missing order id" };
    if (!nextStatus) return { ok: false, error: "Missing status" };

    if (!apiOrigin || !syncKey) {
      return {
        ok: false,
        error: "Cannot update status offline. Configure KHAANZ_API_ORIGIN and KHAANZ_SYNC_KEY.",
      };
    }

    const deviceId = getOrCreateDeviceId(db);
    const resp = await fetchJson(
      `${apiOrigin.replace(/\/$/, "")}/api/pos-sync/orders/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-pos-device-id": deviceId,
          "x-pos-sync-key": syncKey,
        },
        body: JSON.stringify({ status: nextStatus }),
      },
    );

    if (!resp.ok) {
      const err =
        resp.json && resp.json.error
          ? String(resp.json.error)
          : `HTTP ${resp.status || "error"}`;
      return { ok: false, error: err };
    }

    const updatedStatus = resp.json?.status ? String(resp.json.status) : nextStatus;
    const updatedLabel = resp.json?.statusLabel
      ? String(resp.json.statusLabel)
      : updatedStatus;

    patchRemoteOrderStatus(db, id, updatedStatus, updatedLabel);

    return {
      ok: true,
      id: resp.json?.id ? String(resp.json.id) : id,
      status: updatedStatus,
      statusLabel: updatedLabel,
    };
  });

  ipcMain.handle("khaanz:check-connectivity", async () => {
    try {
      const { online, configured } = await checkBackendConnectivity();
      return { ok: true, online, configured };
    } catch (e) {
      return { ok: true, online: false, configured: true, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("khaanz:sync-status", async () => {
    return { ok: true, pendingCount: getSyncPendingCount(db) };
  });

  ipcMain.handle("khaanz:sync-now", async () => {
    const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
    const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
    if (!apiOrigin || !syncKey) {
      return {
        ok: false,
        error: "Sync is not configured (missing KHAANZ_API_ORIGIN or KHAANZ_SYNC_KEY).",
      };
    }
    try {
      await trySyncOnce();
      return { ok: true, serverTime: nowIso() };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("pos:upsertMenuSnapshot", async (_evt, { sessionId, items }) => {
    const s = requireActiveSession(db, String(sessionId || ""));
    if (!s || s.user.role !== "manager") return { ok: false, error: "Unauthorized" };
    if (!Array.isArray(items)) return { ok: false, error: "Invalid items" };
    const stmt = db.prepare(
      `INSERT INTO menu_items(id,name,price_cents,tax_rate_bps,active,updated_at,deleted_at)
       VALUES(?,?,?,?,1,?,NULL)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         price_cents=excluded.price_cents,
         tax_rate_bps=excluded.tax_rate_bps,
         active=1,
         updated_at=excluded.updated_at,
         deleted_at=NULL`,
    );
    const t = db.transaction(() => {
      for (const it of items) {
        if (!it || !it.id || !it.name) continue;
        stmt.run(String(it.id), String(it.name), Number(it.priceCents || 0), Number(it.taxRateBps || 0), nowIso());
      }
    });
    t();
    return { ok: true };
  });

  ipcMain.handle("pos:createOrder", async (_evt, { sessionId, items, fulfillment }) => {
    const s = requireActiveSession(db, String(sessionId || ""));
    if (!s) return { ok: false, error: "Unauthorized" };
    if (!Array.isArray(items) || !items.length) return { ok: false, error: "Empty order" };
    const fulfillMode = ["dine_in", "pickup", "delivery"].includes(String(fulfillment || ""))
      ? String(fulfillment)
      : "pickup";

    const lineRows = [];
    for (const it of items) {
      const qty = Math.max(1, Math.floor(Number(it.qty || 1)));
      const hasExplicitLine =
        typeof it.name === "string" &&
        it.name.trim() &&
        Number.isFinite(Number(it.unitPriceCents));

      if (hasExplicitLine) {
        const unitPriceCents = Math.round(Number(it.unitPriceCents));
        const taxRateBps = Number(it.taxRateBps || 0);
        const { lineSubtotal, lineTax, lineTotal } = computeLine({
          qty,
          unitPriceCents,
          taxRateBps,
        });
        lineRows.push({
          id: randomId("li"),
          menuItemId: it.menuItemId ? String(it.menuItemId) : null,
          name: String(it.name).trim(),
          qty,
          unitPriceCents,
          taxRateBps,
          lineSubtotal,
          lineTax,
          lineTotal,
        });
        continue;
      }

      const menu = db
        .prepare("SELECT id,name,price_cents AS priceCents,tax_rate_bps AS taxRateBps FROM menu_items WHERE id=? AND deleted_at IS NULL AND active=1")
        .get(String(it.menuItemId || ""));
      if (!menu) return { ok: false, error: "Invalid menu item" };
      const unitPriceCents = Number(menu.priceCents);
      const taxRateBps = Number(menu.taxRateBps || 0);
      const { lineSubtotal, lineTax, lineTotal } = computeLine({ qty, unitPriceCents, taxRateBps });
      lineRows.push({
        id: randomId("li"),
        menuItemId: menu.id,
        name: menu.name,
        qty,
        unitPriceCents,
        taxRateBps,
        lineSubtotal,
        lineTax,
        lineTotal,
      });
    }

    const subtotal = lineRows.reduce((a, r) => a + r.lineSubtotal, 0);
    const tax = lineRows.reduce((a, r) => a + r.lineTax, 0);
    const total = subtotal + tax;

    const orderId = randomId("ord");
    const clientOrderId = randomId("co");
    const t0 = nowIso();

    const insertOrder = db.prepare(
      `INSERT INTO orders(id, client_order_id, status, subtotal_cents, tax_cents, total_cents, created_at, updated_at, created_by_user_id, synced_at, fulfillment)
       VALUES(?,?,?,?,?,?,?,?,?,NULL,?)`,
    );
    const insertItem = db.prepare(
      `INSERT INTO order_items(id, order_id, menu_item_id, name, qty, unit_price_cents, tax_rate_bps, line_subtotal_cents, line_tax_cents, line_total_cents)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertOutbox = db.prepare(
      "INSERT INTO sync_outbox(id,type,payload_json,created_at,attempt_count,last_error,last_attempt_at,sent_at) VALUES(?,?,?,?,0,NULL,NULL,NULL)",
    );

    const tx = db.transaction(() => {
      insertOrder.run(
        orderId,
        clientOrderId,
        "created",
        subtotal,
        tax,
        total,
        t0,
        t0,
        s.user.id,
        fulfillMode,
      );
      for (const r of lineRows) {
        insertItem.run(
          r.id,
          orderId,
          r.menuItemId,
          r.name,
          r.qty,
          r.unitPriceCents,
          r.taxRateBps,
          r.lineSubtotal,
          r.lineTax,
          r.lineTotal,
        );
      }
      insertOutbox.run(
        randomId("evt"),
        "order.created",
        JSON.stringify({
          order: {
            id: orderId,
            clientOrderId,
            status: "created",
            subtotalCents: subtotal,
            taxCents: tax,
            totalCents: total,
            createdAt: t0,
            createdByUserId: s.user.id,
            fulfillment: fulfillMode,
          },
          items: lineRows.map((r) => ({
            id: r.id,
            menuItemId: r.menuItemId,
            name: r.name,
            qty: r.qty,
            unitPriceCents: r.unitPriceCents,
            taxRateBps: r.taxRateBps,
            lineSubtotalCents: r.lineSubtotal,
            lineTaxCents: r.lineTax,
            lineTotalCents: r.lineTotal,
          })),
        }),
        t0,
      );
    });
    tx();

    return { ok: true, order: { id: orderId, clientOrderId, subtotalCents: subtotal, taxCents: tax, totalCents: total, createdAt: t0 } };
  });

  ipcMain.handle("pos:listRecentOrders", async (_evt, { sessionId, limit }) => {
    const s = requireActiveSession(db, String(sessionId || ""));
    if (!s) return { ok: false, error: "Unauthorized" };
    const lim = Math.max(1, Math.min(200, Number(limit || 50)));
    const orders = db
      .prepare(
        "SELECT id, client_order_id AS clientOrderId, status, total_cents AS totalCents, created_at AS createdAt, synced_at AS syncedAt, fulfillment FROM orders ORDER BY created_at DESC LIMIT ?",
      )
      .all(lim);
    return { ok: true, orders };
  });
}

app.whenReady().then(() => {
  loadEnvFile(path.join(app.getPath("userData"), ".env"));
  db = openDb();
  migrate(db);
  ensureSeedData(db);
  registerIpc();
  startSyncLoop();
  mainWindow = createMainWindow();
  initAutoUpdater(mainWindow, { isDev });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      initAutoUpdater(mainWindow, { isDev });
    }
  });
});

ipcMain.handle("app:check-for-updates", async () => {
  if (isDev) return { ok: false, error: "Updates are disabled in development" };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version ?? null };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

