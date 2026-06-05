const { app, BrowserWindow, ipcMain, net, dialog } = require("electron");
const { initAutoUpdater, autoUpdater } = require("./auto-updater.cjs");
const {
  readStoredBackendConfig,
  applyBackendConfig,
  normalizeApiOrigin,
} = require("./backend-config.cjs");
const {
  wrapThermalPrintDocument,
  buildTestPrintPlainText,
} = require("./thermal-print.cjs");
const {
  getThermalPrintOptions,
  getPrintWindowSize,
} = require("./thermal-print-windows.cjs");
const {
  resolveWindowsPrinterName,
  checkWindowsPrinterOnline,
  getWindowsPrinterDiagnostics,
  printPlainTextWindows,
} = require("./windows-printer.cjs");
const { checkMacPrinterOnline, printPlainTextMac } = require("./print-mac.cjs");
const { printReceiptElectron } = require("./print-electron-receipt.cjs");
const { withTimeout } = require("./print-timeout.cjs");
const { pickBestPrinter, isVirtualPrinterName } = require("./printer-resolve.cjs");
const path = require("path");
const os = require("os");
const fs = require("fs");
const Database = require("better-sqlite3");

/** Packaged app always uses renderer/dist. Unpackaged: dev server unless KHAANZ_LOAD_DIST=1. */
const forceDist = ["1", "true", "yes"].includes(
  String(process.env.KHAANZ_LOAD_DIST || "").toLowerCase(),
);
const isDev = !app.isPackaged && !forceDist;

/** Load KEY=VALUE pairs from a .env file. @param {{ override?: boolean }} [opts] */
function loadEnvFile(filePath, opts = {}) {
  const override = Boolean(opts.override);
  if (!filePath || !fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!override && process.env[key] !== undefined) continue;
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

// Dev only: repo .env — packaged app uses userData/.env (loaded in whenReady, overrides).
if (!app.isPackaged) {
  loadEnvFile(path.join(__dirname, "..", ".env"));
}

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

function formatIstDateInput(now) {
  const { y, m, d: day } = istDateParts(now instanceof Date ? now : new Date());
  return `${y}-${m}-${day}`;
}

function parseIstDateInput(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isOrderOnIstDate(isoString, dayStart) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  const end = dayStart.getTime() + 24 * 60 * 60 * 1000;
  return d.getTime() >= dayStart.getTime() && d.getTime() < end;
}

function normalizeOrderStatusValue(status) {
  const upper = String(status || "").trim().toUpperCase();
  return upper === "CREATED" ? "PENDING" : upper;
}

function normalizeOrderRow(row) {
  if (!row || typeof row !== "object") return row;
  return { ...row, status: normalizeOrderStatusValue(row.status) };
}

function normalizeOrderRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeOrderRow) : [];
}

function buildLocalPosOrderRows() {
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

  const rows = [];
  const seen = new Set();

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

  return rows;
}

function readCachedRemoteOrders() {
  const rawRemote = readRemoteOrdersJson(db);
  if (!rawRemote) return [];
  try {
    const j = JSON.parse(rawRemote);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
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

const BILL_PREVIEW_META_KEY = "bill_preview_settings";
/** Max local bill logo file size (5 MB). */
const BILL_LOGO_MAX_BYTES = 5 * 1024 * 1024;

function estimateDataUrlBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return 0;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  return Math.floor((b64.length * 3) / 4);
}

function defaultBillPreviewSettings() {
  return {
    themeId: "classic",
    logoDataUrl: "",
    logoSizePercent: 42,
    restaurantName: "",
    restaurantPhone: "",
    restaurantAddress: "",
    footerNotes: "",
    showLogo: true,
    showRestaurantName: true,
    showPhone: true,
    showAddress: true,
    showOrderId: true,
    showFooterNotes: true,
  };
}

function readBillPreviewSettingsJson(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(BILL_PREVIEW_META_KEY);
    return row && typeof row.value === "string" ? row.value : "";
  } catch {
    return "";
  }
}

function writeBillPreviewSettingsJson(db, payloadJson) {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(
    BILL_PREVIEW_META_KEY,
    payloadJson,
  );
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
  const name = String(deviceName || "").trim();
  const prev = readSilentPrinterNameFromDb(db);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('silent_printer',?)").run(name);
  if (prev === name) return;
  clearPrinterVerified(db);
  try {
    db.prepare("DELETE FROM meta WHERE key='print_method_win'").run();
    db.prepare("DELETE FROM meta WHERE key='print_method_mac'").run();
  } catch {
    /* ignore */
  }
  try {
    const { clearCupsQueueCache } = require("./print-mac.cjs");
    clearCupsQueueCache();
  } catch {
    /* ignore */
  }
  try {
    const { clearWindowsPrintCache } = require("./print-diagnostics-windows.cjs");
    clearWindowsPrintCache();
  } catch {
    /* ignore */
  }
}

function readWindowsGdiReceiptFromDb(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='print_gdi_win'").get();
    if (!row || typeof row.value !== "string") return true;
    return row.value !== "0";
  } catch {
    return true;
  }
}

function writeWindowsGdiReceiptToDb(db, gdiReceipt) {
  const v = gdiReceipt === false ? "0" : "1";
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('print_gdi_win',?)").run(v);
}

function readPreferredPrintMethodFromDb(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='print_method_win'").get();
    return row && typeof row.value === "string" ? row.value.trim() : "";
  } catch {
    return "";
  }
}

function writePreferredPrintMethodToDb(db, method) {
  const m = String(method || "").trim();
  if (!m) return;
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('print_method_win',?)").run(m);
}

function readPreferredPrintMethodMacFromDb(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='print_method_mac'").get();
    return row && typeof row.value === "string" ? row.value.trim() : "";
  } catch {
    return "";
  }
}

function writePreferredPrintMethodMacToDb(db, method) {
  const m = String(method || "").trim();
  if (!m) return;
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('print_method_mac',?)").run(m);
}

function readPrinterVerifiedName(db) {
  try {
    const flag = db.prepare("SELECT value FROM meta WHERE key='printer_verified'").get();
    if (!flag || flag.value !== "1") return "";
    const row = db.prepare("SELECT value FROM meta WHERE key='printer_verified_name'").get();
    return row && typeof row.value === "string" ? row.value.trim() : "";
  } catch {
    return "";
  }
}

function setPrinterVerified(db, deviceName) {
  const name = String(deviceName || "").trim();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('printer_verified','1')").run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('printer_verified_name',?)").run(name);
}

function clearPrinterVerified(db) {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('printer_verified','0')").run();
  db.prepare("DELETE FROM meta WHERE key='printer_verified_name'").run();
}

async function isPrinterOnlineOnOs(printerName) {
  const name = String(printerName || "").trim();
  if (!name) return { online: false, detail: "No printer selected" };
  if (process.platform === "win32") {
    const r = await checkWindowsPrinterOnline(name);
    return { online: r.online, detail: r.detail || "", name: r.name || name };
  }
  if (process.platform === "darwin") {
    const cups = await checkMacPrinterOnline(name);
    if (!cups.online) return cups;
  }
  const printers = await getPrintersFromAnyWindow();
  const hit = (printers || []).find((p) => p.name === name);
  if (!hit) return { online: false, detail: "Printer not found" };
  const reasons = hit.options && hit.options["printer-state-reasons"];
  if (typeof reasons === "string" && /offline/i.test(reasons)) {
    return { online: false, detail: "Printer reports offline" };
  }
  return { online: true, detail: "" };
}

async function waitForPrintDocumentReady(webContents) {
  await webContents.executeJavaScript(`
    new Promise((resolve) => {
      const finish = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
      const imgs = Array.from(document.images || []);
      let pending = imgs.filter((img) => !img.complete);
      const onImgDone = () => {
        pending = pending.filter((img) => !img.complete);
        if (pending.length === 0) finish();
      };
      for (const img of imgs) {
        img.addEventListener("load", onImgDone);
        img.addEventListener("error", onImgDone);
      }
      const afterFonts = () => {
        if (pending.length === 0) finish();
        else setTimeout(finish, 3000);
      };
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(afterFonts).catch(afterFonts);
      } else {
        afterFonts();
      }
    })
  `);
  await new Promise((r) => setTimeout(r, 80));
}

async function receiptDocumentNeedsVisualPrint(webContents) {
  return webContents.executeJavaScript(`
    (() => {
      const imgs = document.querySelectorAll(
        "img.logo, .logo-wrap img, .thermal-receipt-root img",
      );
      if (!imgs.length) return false;
      return Array.from(imgs).some((img) => {
        const src = String(img.getAttribute("src") || img.src || "").trim();
        if (!src) return false;
        if (img.complete) return img.naturalWidth > 0 || src.startsWith("data:");
        return true;
      });
    })()
  `);
}

async function getPrintersFromAnyWindow() {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (!w.isDestroyed()) {
      try {
        return await w.webContents.getPrintersAsync();
      } catch {
        /* try next */
      }
    }
  }
  const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  try {
    await probe.loadURL("about:blank");
    return await probe.webContents.getPrintersAsync();
  } finally {
    if (!probe.isDestroyed()) probe.close();
  }
}

function resolveSavedPrinterName() {
  const fromEnv = (process.env.KHAANZ_SILENT_PRINTER || "").trim();
  if (fromEnv) return fromEnv;
  return readSilentPrinterNameFromDb(db);
}

/**
 * Resolve which printer to use: saved queue if online, else OS default / any connected printer.
 * Auto-saves the picked queue when nothing was saved yet.
 */
async function resolveActivePrinterName() {
  const saved = resolveSavedPrinterName();
  const printers = await getPrintersFromAnyWindow();
  const list = Array.isArray(printers) ? printers : [];
  if (!list.length) {
    return { name: "", deviceName: "", online: false, autoSelected: false, saved: Boolean(saved) };
  }

  async function checkOnline(name) {
    if (!name) return false;
    const r = await isPrinterOnlineOnOs(name);
    return Boolean(r.online);
  }

  let candidate = saved;
  if (candidate) {
    if (process.platform === "win32") {
      const resolved = await resolveWindowsPrinterName(candidate);
      candidate = resolved.ok ? resolved.name : "";
    } else if (!list.some((p) => p.name === candidate)) {
      candidate = "";
    }
    if (candidate && (await checkOnline(candidate))) {
      return {
        name: candidate,
        deviceName: candidate,
        online: true,
        autoSelected: false,
        saved: true,
      };
    }
  }

  const picked = pickBestPrinter(list, "");
  if (!picked) {
    return { name: "", deviceName: "", online: false, autoSelected: false, saved: Boolean(saved) };
  }

  let resolvedName = picked;
  if (process.platform === "win32") {
    const resolved = await resolveWindowsPrinterName(picked);
    resolvedName = resolved.ok ? resolved.name : picked;
  }

  const online = await checkOnline(resolvedName);
  if (!online) {
    for (const p of list) {
      if (isVirtualPrinterName(p.name)) continue;
      let n = p.name;
      if (process.platform === "win32") {
        const r = await resolveWindowsPrinterName(n);
        if (!r.ok) continue;
        n = r.name;
      }
      if (await checkOnline(n)) {
        if (!saved || n !== saved) writeSilentPrinterNameToDb(db, n);
        return {
          name: n,
          deviceName: n,
          online: true,
          autoSelected: !saved || n !== saved,
          saved: true,
        };
      }
    }
    return {
      name: resolvedName,
      deviceName: resolvedName,
      online: false,
      autoSelected: false,
      saved: Boolean(saved),
    };
  }

  if (!saved || resolvedName !== saved) writeSilentPrinterNameToDb(db, resolvedName);
  return {
    name: resolvedName,
    deviceName: resolvedName,
    online: true,
    autoSelected: !saved || resolvedName !== saved,
    saved: true,
  };
}

/** Printer status — works with any connected OS queue, not only a manually saved name. */
async function getPrinterConnectionStatus() {
  const savedInDb = Boolean(resolveSavedPrinterName());
  const printers = await getPrintersFromAnyWindow();
  const list = Array.isArray(printers) ? printers : [];
  const active = await resolveActivePrinterName();
  const deviceName = active.deviceName || active.name || "";
  const inList = Boolean(deviceName && list.some((p) => p.name === deviceName));
  const online = active.online;
  const saved = savedInDb || active.autoSelected;

  const verifiedName = readPrinterVerifiedName(db);
  const verified = Boolean(
    deviceName &&
      verifiedName &&
      (verifiedName === deviceName ||
        verifiedName.toLowerCase() === deviceName.toLowerCase()),
  );

  let diagnostics = null;
  if (process.platform === "win32" && deviceName) {
    const d = await getWindowsPrinterDiagnostics(deviceName);
    if (d.ok) {
      diagnostics = {
        port: d.port,
        driver: d.driver,
        status: d.status,
        workOffline: d.workOffline,
        resolvedName: d.resolvedName,
      };
    }
  }

  let statusDetail = "";
  if (!list.length) {
    statusDetail = "No printers found — connect USB and install the driver.";
  } else if (!deviceName) {
    statusDetail = "No printer available.";
  } else if (!online) {
    statusDetail = "Printer disconnected or offline.";
  } else if (active.autoSelected) {
    statusDetail = `Using ${deviceName} (auto-detected).`;
  } else if (online && !verified) {
    statusDetail = "Connected — run Test print to confirm paper output.";
  }

  return {
    saved,
    available: inList,
    online,
    verified,
    connected: Boolean(deviceName && online),
    ready: Boolean(deviceName && online),
    autoSelected: active.autoSelected,
    deviceName,
    statusDetail,
    printers: list.map((p) => ({
      name: p.name,
      isDefault: Boolean(p.isDefault),
      status: p.status != null ? String(p.status) : undefined,
    })),
    diagnostics,
  };
}

function resolvePrinterForJob(printers, savedName) {
  const list = Array.isArray(printers) ? printers : [];
  const saved = String(savedName || "").trim();
  if (saved && list.some((p) => p.name === saved)) return saved;
  const def = list.find((p) => p.isDefault);
  if (def?.name) return def.name;
  return list[0]?.name?.trim() || "";
}

function printWebContentsAsync(webContents, options, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "Print timed out" }),
      timeoutMs,
    );
    try {
      webContents.print(options, (success, failureReason) => {
        if (!success) finish({ ok: false, error: failureReason || "Print failed" });
        else finish({ ok: true });
      });
    } catch (e) {
      finish({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

async function printPlainTextViaHtmlWindow(plainText, title) {
  const doc = wrapThermalPrintDocument(
    `<pre>${String(plainText)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
    title || "Receipt",
  );
  return printSilentHtml({ html: doc, title: title || "Receipt" });
}

/** Mac/Linux dev: skip real print when KHAANZ_DEV_MOCK_PRINT=1 (Windows always prints for real). */
function isDevMockPrintEnabled() {
  return (
    process.env.KHAANZ_DEV_MOCK_PRINT === "1" && process.platform !== "win32"
  );
}

/** Windows receipt print — cached method + skip PowerShell when already verified. */
async function printReceiptWindows(printerName, body, safeTitle, receiptOpts = {}) {
  const preferred = readPreferredPrintMethodFromDb(db);
  const fastPath = Boolean(receiptOpts.verifiedFastPath && preferred);

  const r = await withTimeout(
    printPlainTextWindows(printerName, body, safeTitle, {
      preferredMethod: preferred,
      fastPath,
      gdiReceipt: readWindowsGdiReceiptFromDb(db),
    }),
    90_000,
    "Windows print",
  );
  if (r.ok) {
    if (r.method) writePreferredPrintMethodToDb(db, r.method);
    if (typeof r.gdiReceipt === "boolean") writeWindowsGdiReceiptToDb(db, r.gdiReceipt);
    const verifiedName = r.deviceName || printerName;
    writeSilentPrinterNameToDb(db, verifiedName);
    setPrinterVerified(db, verifiedName);
    return r;
  }
  const electron = await printReceiptElectron(printerName, body, safeTitle);
  if (electron.ok) {
    writePreferredPrintMethodToDb(db, "gdi");
    writeSilentPrinterNameToDb(db, printerName);
    setPrinterVerified(db, printerName);
    return electron;
  }
  return r;
}

/** macOS receipt print — uses cached CUPS/Electron method after first successful job. */
async function printReceiptDarwin(printerName, body, safeTitle) {
  const preferredMac = readPreferredPrintMethodMacFromDb(db);

  if (preferredMac === "electron") {
    const electronFirst = await printReceiptElectron(printerName, body, safeTitle);
    if (electronFirst.ok) {
      writeSilentPrinterNameToDb(db, printerName);
      writePreferredPrintMethodMacToDb(db, "electron");
      setPrinterVerified(db, printerName);
      return electronFirst;
    }
  }

  const r = await printPlainTextMac(printerName, body, safeTitle, {
    preferredMethod: preferredMac === "electron" ? "" : preferredMac,
  });
  if (r.ok) {
    writeSilentPrinterNameToDb(db, r.deviceName || printerName);
    if (r.method) writePreferredPrintMethodMacToDb(db, r.method);
    setPrinterVerified(db, r.deviceName || printerName);
    return r;
  }

  const electron = await printReceiptElectron(printerName, body, safeTitle);
  if (electron.ok) {
    writeSilentPrinterNameToDb(db, printerName);
    writePreferredPrintMethodMacToDb(db, "electron");
    setPrinterVerified(db, printerName);
    return electron;
  }
  return r;
}

/** Resolve printer for a receipt job; skips slow lpstat when last test print succeeded. */
async function resolvePrinterForReceipt(deviceOverride) {
  const override = String(deviceOverride || "").trim();
  if (override) {
    const printers = await getPrintersFromAnyWindow();
    const list = Array.isArray(printers) ? printers : [];
    if (!list.some((p) => p.name === override)) {
      return {
        ok: false,
        error: `Printer "${override}" is not available. Click Refresh in the printer dialog.`,
      };
    }
    const onlineCheck = await isPrinterOnlineOnOs(override);
    if (!onlineCheck.online) {
      return {
        ok: false,
        error: onlineCheck.detail || "Selected printer is offline. Check USB/power.",
      };
    }
    return { ok: true, name: override };
  }

  const saved = resolveSavedPrinterName();
  const verified = readPrinterVerifiedName(db);
  if (saved && verified && verified === saved) {
    return { ok: true, name: saved, verifiedFastPath: true };
  }

  const active = await resolveActivePrinterName();
  if (!active.name) {
    return {
      ok: false,
      error: "No printer connected. Plug in a printer, install its driver, then Refresh.",
    };
  }
  if (!active.online) {
    return {
      ok: false,
      error: "Printer is offline. Check USB/power, then try again.",
    };
  }
  return { ok: true, name: active.name };
}

/** Direct receipt print — Windows uses driver chain; macOS uses ESC/POS + Electron. */
async function printReceiptText({ text, title, deviceName: deviceOverride }) {
  const body = String(text || "").trim();
  if (!body) {
    return { ok: false, error: "Nothing to print." };
  }

  const resolved = await resolvePrinterForReceipt(deviceOverride);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const printerName = resolved.name;

  if (isDevMockPrintEnabled()) {
    return {
      ok: true,
      method: "dev-mock",
      deviceName: printerName || "dev-mock",
      proof: "mac-dev-mock",
    };
  }

  if (process.platform === "win32") {
    return printReceiptWindows(printerName, body, title || "Receipt", resolved);
  }

  if (process.platform === "darwin") {
    return printReceiptDarwin(printerName, body, title || "Receipt");
  }

  const electron = await printReceiptElectron(printerName, body, title || "Receipt");
  if (electron.ok) {
    writeSilentPrinterNameToDb(db, printerName);
    setPrinterVerified(db, printerName);
    return electron;
  }
  return withTimeout(printPlainTextViaHtmlWindow(body, title || "Receipt"), 45_000, "Print");
}

async function printSilentHtml({ html, title }) {
  const max = 600_000;
  if (!html || typeof html !== "string" || html.length > max) {
    return { ok: false, error: "Invalid print payload." };
  }
  const safeTitle = typeof title === "string" && title.length < 200 ? title : "Receipt";
  const doc = /^\s*<!DOCTYPE/i.test(html)
    ? html
    : wrapThermalPrintDocument(html, safeTitle);

  const printDir = path.join(app.getPath("temp"), "khaanz-print");
  fs.mkdirSync(printDir, { recursive: true });
  const tempFile = path.join(printDir, `receipt-${Date.now()}.html`);
  fs.writeFileSync(tempFile, doc, "utf8");

  return new Promise((resolve) => {
    const winSize = getPrintWindowSize();
    const win = new BrowserWindow({
      show: false,
      width: winSize.width,
      height: winSize.height,
      backgroundColor: "#ffffff",
      webPreferences: { sandbox: false },
    });

    let settled = false;
    const cleanup = () => {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timeoutMs = 45_000;
    const timeout = setTimeout(() => settle({ ok: false, error: "Print timed out" }), timeoutMs);

    win.webContents.once("did-fail-load", (_e, _code, desc) =>
      settle({ ok: false, error: desc || "Load failed" }),
    );
    win.webContents.once("render-process-gone", (_e, details) =>
      settle({
        ok: false,
        error:
          details && details.reason ? `Print crashed (${details.reason})` : "Print crashed",
      }),
    );

    win.webContents.once("did-finish-load", async () => {
      try {
        await waitForPrintDocumentReady(win.webContents);

        const active = await resolveActivePrinterName();
        const chosen = active.name;
        if (!chosen) {
          settle({
            ok: false,
            error: "No printer connected. Plug in a printer and Refresh.",
          });
          return;
        }
        if (!active.online) {
          settle({ ok: false, error: "Printer is offline. Check USB/power." });
          return;
        }

        const needsVisualPrint = await receiptDocumentNeedsVisualPrint(win.webContents);
        if (needsVisualPrint) {
          const r = await printWebContentsAsync(
            win.webContents,
            getThermalPrintOptions(chosen, { withImages: true }),
            30_000,
          );
          if (r.ok) {
            writeSilentPrinterNameToDb(db, chosen);
            setPrinterVerified(db, chosen);
          }
          settle(r);
          return;
        }

        const plainText = await win.webContents.executeJavaScript(
          `(document.body && document.body.innerText) ? document.body.innerText : ""`,
        );
        if (!String(plainText || "").trim()) {
          settle({ ok: false, error: "Receipt is empty — nothing to print." });
          return;
        }

        if (process.platform === "win32") {
          const verified = readPrinterVerifiedName(db);
          const r = await printReceiptWindows(chosen, plainText, safeTitle, {
            verifiedFastPath: Boolean(verified && verified === chosen),
          });
          settle(r);
          return;
        }

        if (process.platform === "darwin") {
          settle(await printReceiptDarwin(chosen, plainText, safeTitle));
          return;
        }

        const electron = await printReceiptElectron(chosen, plainText, safeTitle);
        if (electron.ok) {
          settle(electron);
          return;
        }

        const r = await printWebContentsAsync(
          win.webContents,
          getThermalPrintOptions(chosen),
          30_000,
        );
        settle(r);
      } catch (e) {
        settle({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    win.loadFile(tempFile);
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

function resolveMenuMediaUrl(url, apiOrigin) {
  const s = String(url || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || s.startsWith("data:")) return s;
  const origin = String(apiOrigin || "").trim().replace(/\/$/, "");
  if (!origin) return s;
  if (s.startsWith("/")) return `${origin}${s}`;
  return `${origin}/${s}`;
}

function normalizeMenuPayloadMedia(menu, apiOrigin) {
  if (!menu || typeof menu !== "object") return menu;
  const resolve = (u) => resolveMenuMediaUrl(u, apiOrigin);
  const items = Array.isArray(menu.items)
    ? menu.items.map((it) => ({
        ...it,
        image: resolve(it.image),
        addons: Array.isArray(it.addons)
          ? it.addons.map((a) => ({
              ...a,
              image: a && a.image ? resolve(a.image) : a?.image,
            }))
          : it.addons,
      }))
    : [];
  const categories = Array.isArray(menu.categories)
    ? menu.categories.map((c) => ({ ...c, image: resolve(c.image) }))
    : [];
  const combos = Array.isArray(menu.combos)
    ? menu.combos.map((c) => ({ ...c, image: resolve(c.image) }))
    : [];
  return { ...menu, categories, items, combos };
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
    title: "Khaanz POS",
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

async function checkBackendConnectivityWith(apiOrigin, syncKey) {
  const origin = String(apiOrigin || "").trim();
  const key = String(syncKey || "").trim();
  if (!origin || !key) {
    return { online: false, configured: false };
  }

  const deviceId = getOrCreateDeviceId(db);
  const pull = await fetchJson(`${origin.replace(/\/$/, "")}/api/pos-sync/pull`, {
    method: "GET",
    headers: {
      "x-pos-device-id": deviceId,
      "x-pos-sync-key": key,
    },
  });

  return { online: pull.ok, configured: true };
}

async function checkBackendConnectivity() {
  return checkBackendConnectivityWith(
    process.env.KHAANZ_API_ORIGIN,
    process.env.KHAANZ_SYNC_KEY,
  );
}

function syncEnv() {
  const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
  const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
  return { apiOrigin, syncKey, configured: Boolean(apiOrigin && syncKey) };
}

function applyStoredBackendToProcessEnv() {
  const stored = readStoredBackendConfig(app);
  if (!stored.configured) return stored;
  process.env.KHAANZ_API_ORIGIN = stored.apiOrigin;
  process.env.KHAANZ_SYNC_KEY = stored.syncKey;
  return stored;
}

function markMenuPulledFromServer() {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('last_menu_pull_at',?)").run(nowIso());
}

function readLastMenuPullAt(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='last_menu_pull_at'").get();
  return row && row.value ? String(row.value) : null;
}

async function pullSyncFromServer() {
  const { apiOrigin, syncKey, configured } = syncEnv();
  if (!configured) return { ok: false, error: "Sync not configured" };

  const deviceId = getOrCreateDeviceId(db);
  const pull = await fetchJson(`${apiOrigin.replace(/\/$/, "")}/api/pos-sync/pull`, {
    method: "GET",
    headers: {
      "x-pos-device-id": deviceId,
      "x-pos-sync-key": syncKey,
    },
  });
  if (pull.ok && pull.json) {
    if (pull.json.menu) {
      const menu = normalizeMenuPayloadMedia(pull.json.menu, apiOrigin);
      writeMenuPayloadJson(db, JSON.stringify(menu));
      markMenuPulledFromServer();
    }
    if (pull.json.settings) writeSettingsJson(db, JSON.stringify(pull.json.settings));
    if (Array.isArray(pull.json.recentOrders)) {
      writeRemoteOrdersJson(db, JSON.stringify(pull.json.recentOrders));
    }
  }
  return {
    ok: pull.ok,
    error: pull.ok ? null : pull.json && pull.json.error ? pull.json.error : `HTTP ${pull.status}`,
  };
}

async function pushSyncOutbox() {
  const { apiOrigin, syncKey, configured } = syncEnv();
  if (!configured) return { ok: false, error: "Sync not configured" };

  const deviceId = getOrCreateDeviceId(db);
  const rows = db
    .prepare(
      "SELECT id, type, payload_json, attempt_count FROM sync_outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT 20",
    )
    .all();
  if (!rows.length) return { ok: true, pushed: 0 };

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
    return { ok: false, error: String(err) };
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
  return { ok: true, pushed: acceptedIds.length };
}

async function trySyncOnce() {
  const { configured } = syncEnv();
  if (!configured) return;
  await pushSyncOutbox();
  await pullSyncFromServer();
}

let syncIntervalId = null;

function stopSyncLoop() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

function startSyncLoop() {
  const { configured } = syncEnv();
  if (!configured) {
    stopSyncLoop();
    return;
  }
  if (syncIntervalId) return;

  void trySyncOnce().catch(() => {});
  syncIntervalId = setInterval(() => {
    void trySyncOnce().catch(() => {});
  }, 5_000);
}

function restartSyncLoop() {
  stopSyncLoop();
  startSyncLoop();
}

function registerIpc() {
  ipcMain.handle("pos:platform", () => process.platform);

  ipcMain.handle("pos:bootstrap", async () => {
    const deviceId = getOrCreateDeviceId(db);
    const stored = applyStoredBackendToProcessEnv();
    const { online } = stored.configured
      ? await checkBackendConnectivityWith(stored.apiOrigin, stored.syncKey)
      : { online: false };
    return {
      ok: true,
      deviceId,
      syncConfigured: stored.configured,
      serverOnline: online,
      apiOrigin: stored.configured ? stored.apiOrigin : null,
      userDataEnvPath: stored.userDataEnvPath,
      lastMenuPullAt: readLastMenuPullAt(db),
    };
  });

  ipcMain.handle("pos:get-backend-config", async () => {
    const stored = readStoredBackendConfig(app);
    const { online } = stored.configured
      ? await checkBackendConnectivityWith(stored.apiOrigin, stored.syncKey)
      : { online: false };
    return { ok: true, ...stored, online };
  });

  ipcMain.handle("pos:save-backend-config", async (_evt, { apiOrigin, syncKey }) => {
    const applied = applyBackendConfig(app, { apiOrigin, syncKey });
    if (!applied.ok) return applied;
    restartSyncLoop();
    const { online } = await checkBackendConnectivity();
    try {
      if (online) await trySyncOnce();
    } catch {
      /* pull may fail offline */
    }
    return {
      ok: true,
      apiOrigin: applied.apiOrigin,
      syncConfigured: true,
      online,
      userDataEnvPath: applied.userDataEnvPath,
      lastMenuPullAt: readLastMenuPullAt(db),
    };
  });

  ipcMain.handle("pos:test-backend-config", async (_evt, { apiOrigin, syncKey }) => {
    const origin = normalizeApiOrigin(apiOrigin);
    const key = String(syncKey || "").trim();
    if (!origin || !key) {
      return { ok: false, error: "Enter domain and sync key first." };
    }
    const prevOrigin = process.env.KHAANZ_API_ORIGIN;
    const prevKey = process.env.KHAANZ_SYNC_KEY;
    process.env.KHAANZ_API_ORIGIN = origin;
    process.env.KHAANZ_SYNC_KEY = key;
    try {
      const r = await checkBackendConnectivity();
      if (!r.configured) return { ok: false, error: "Invalid configuration" };
      if (!r.online) {
        return {
          ok: false,
          error:
            "Could not reach the server. Check the domain, POS_SYNC_KEY on the server, and that the site is running.",
        };
      }
      return { ok: true, online: true, apiOrigin: origin };
    } finally {
      process.env.KHAANZ_API_ORIGIN = prevOrigin;
      process.env.KHAANZ_SYNC_KEY = prevKey;
    }
  });

  function createSessionForUser(u) {
    const sid = randomId("sess");
    const t = nowIso();
    db.prepare(
      "INSERT INTO sessions(id,user_id,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,NULL)",
    ).run(sid, u.id, t, t);
    return {
      ok: true,
      session: {
        id: sid,
        user: { id: u.id, displayName: u.display_name, role: u.role },
      },
    };
  }

  ipcMain.handle("pos:loginWithPin", async (_evt, { userId, pin }) => {
    const u = db
      .prepare("SELECT id, display_name, pin_hash, role, active FROM users WHERE id=?")
      .get(String(userId || ""));
    if (!u || !u.active) return { ok: false, error: "Invalid user" };
    const pinHash = sha256Hex(String(pin || ""));
    if (pinHash !== u.pin_hash) return { ok: false, error: "Invalid PIN" };
    return createSessionForUser(u);
  });

  ipcMain.handle("pos:loginWithPinOnly", async (_evt, { pin }) => {
    const pinHash = sha256Hex(String(pin || ""));
    const rows = db
      .prepare("SELECT id, display_name, pin_hash, role, active FROM users WHERE active=1")
      .all();
    const match = rows.find((u) => u.pin_hash === pinHash);
    if (!match) return { ok: false, error: "Invalid PIN" };
    return createSessionForUser(match);
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

  ipcMain.handle("khaanz:get-bill-preview-settings", async () => {
    const raw = readBillPreviewSettingsJson(db);
    if (!raw) return { ok: true, settings: defaultBillPreviewSettings() };
    try {
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        settings: { ...defaultBillPreviewSettings(), ...(parsed && typeof parsed === "object" ? parsed : {}) },
      };
    } catch {
      return { ok: true, settings: defaultBillPreviewSettings() };
    }
  });

  ipcMain.handle("khaanz:set-bill-preview-settings", async (_evt, payload) => {
    const settings =
      payload && typeof payload.settings === "object" && payload.settings
        ? payload.settings
        : payload;
    if (!settings || typeof settings !== "object") {
      return { ok: false, error: "Invalid settings" };
    }
    const merged = { ...defaultBillPreviewSettings(), ...settings };
    if (merged.logoDataUrl) {
      const logoBytes = estimateDataUrlBytes(merged.logoDataUrl);
      if (logoBytes > BILL_LOGO_MAX_BYTES) {
        return { ok: false, error: "Logo image is too large (max 5 MB)." };
      }
    }
    writeBillPreviewSettingsJson(db, JSON.stringify(merged));
    return { ok: true, settings: merged };
  });

  ipcMain.handle("khaanz:pick-bill-logo", async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const opts = {
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths?.[0]) {
      return { ok: true, dataUrl: null };
    }
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".bmp"
              ? "image/bmp"
              : "image/jpeg";
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length > BILL_LOGO_MAX_BYTES) {
        return { ok: false, error: "Image is too large (max 5 MB)." };
      }
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("pos:getMenuPayload", async () => {
    const { apiOrigin } = syncEnv();
    const raw = readMenuPayloadJson(db);
    if (!raw) {
      const menu = buildMenuPayloadFromLocalMenuItems(db);
      writeMenuPayloadJson(db, JSON.stringify(menu));
      return { ok: true, menu };
    }
    try {
      const menu = normalizeMenuPayloadMedia(JSON.parse(raw), apiOrigin);
      return { ok: true, menu };
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
    return withTimeout(printSilentHtml({ html, title }), 60_000, "Print");
  });

  ipcMain.handle("khaanz:print-receipt-text", async (_evt, payload) => {
    const text = payload && typeof payload.text === "string" ? payload.text : "";
    const title = payload && typeof payload.title === "string" ? payload.title : "Receipt";
    const deviceName =
      payload && typeof payload.deviceName === "string" ? payload.deviceName : "";
    return withTimeout(
      printReceiptText({ text, title, deviceName: deviceName || undefined }),
      95_000,
      "Print",
    );
  });

  ipcMain.handle("khaanz:get-printer-status", async () => {
    try {
      return { ok: true, ...(await getPrinterConnectionStatus()) };
    } catch (e) {
      return {
        ok: true,
        saved: false,
        available: false,
        online: false,
        verified: false,
        connected: false,
        ready: false,
        deviceName: "",
        printers: [],
        error: String(e && e.message ? e.message : e),
      };
    }
  });

  ipcMain.handle("khaanz:test-print", async (_evt, deviceNameOverride) => {
    const override = String(deviceNameOverride || "").trim();
    if (override) {
      writeSilentPrinterNameToDb(db, override);
    }
    const active = await resolveActivePrinterName();
    const target = override || active.name;
    if (!target) {
      return { ok: false, error: "No printer connected. Select a printer from the list." };
    }
    const onlineCheck = await isPrinterOnlineOnOs(target);
    if (!onlineCheck.online) {
      return {
        ok: false,
        error: onlineCheck.detail || "Printer is offline. Check USB/power.",
      };
    }
    const sample = buildTestPrintPlainText();
    const r = await withTimeout(
      printReceiptText({ text: sample, title: "Test print", deviceName: override || undefined }),
      95_000,
      "Test print",
    );
    if (r.ok) {
      const verifiedName =
        process.platform === "win32" && r.deviceName ? r.deviceName : target;
      setPrinterVerified(db, verifiedName);
      if (process.platform === "win32" && r.deviceName && r.deviceName !== target) {
        writeSilentPrinterNameToDb(db, r.deviceName);
      }
    } else if (process.platform === "win32") {
      clearPrinterVerified(db);
    }
    return r;
  });

  ipcMain.handle("khaanz:list-printers", async () => {
    try {
      return await getPrintersFromAnyWindow();
    } catch {
      return [];
    }
  });

  ipcMain.handle("khaanz:get-silent-printer", async () => {
    return { deviceName: resolveSavedPrinterName() };
  });

  ipcMain.handle("khaanz:set-silent-printer", async (_evt, deviceName) => {
    try {
      const name = String(deviceName || "").trim();
      if (!name) {
        return { ok: false, error: "Select a printer from the list." };
      }
      const printers = await getPrintersFromAnyWindow();
      if (!printers.some((p) => p.name === name)) {
        return { ok: false, error: "That printer is not available on this PC." };
      }
      let savedName = name;
      if (process.platform === "win32") {
        const resolved = await resolveWindowsPrinterName(name);
        if (!resolved.ok) {
          return {
            ok: false,
            error:
              resolved.detail ||
              "That printer queue is not installed in Windows. Install the driver, then Refresh.",
          };
        }
        savedName = resolved.name;
      }
      writeSilentPrinterNameToDb(db, savedName);
      return { ok: true, deviceName: savedName };
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
      const localRows = buildLocalPosOrderRows();
      const remote = readCachedRemoteOrders();
      const seen = new Set();
      const rows = [];

      for (const o of localRows) {
        seen.add(String(o.id));
        rows.push(o);
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

  ipcMain.handle("khaanz:pos-list-orders", async (_evt, { view, date }) => {
    try {
      const viewKey = view === "online" ? "online" : "exclude_online_pending";
      const dateStr =
        typeof date === "string" && date.trim()
          ? date.trim()
          : formatIstDateInput(new Date());
      const dayStart = parseIstDateInput(dateStr) || istStartOfDay(new Date());

      const apiOrigin = (process.env.KHAANZ_API_ORIGIN || "").trim();
      const syncKey = (process.env.KHAANZ_SYNC_KEY || "").trim();
      const deviceId = getOrCreateDeviceId(db);

      let serverOrders = [];
      let liveApi = false;
      if (apiOrigin && syncKey) {
        const params = new URLSearchParams({
          view: viewKey,
          date: dateStr,
          limit: "100",
        });
        const resp = await fetchJson(
          `${apiOrigin.replace(/\/$/, "")}/api/pos-sync/orders?${params.toString()}`,
          {
            method: "GET",
            headers: {
              "x-pos-device-id": deviceId,
              "x-pos-sync-key": syncKey,
            },
          },
        );
        if (resp.ok && resp.json && Array.isArray(resp.json.orders)) {
          serverOrders = resp.json.orders;
          liveApi = true;
        }
      }

      // When the orders API is unavailable (older server) refresh the pull cache first.
      if (!liveApi && apiOrigin && syncKey) {
        await pullSyncFromServer();
      }

      if (viewKey === "online") {
        if (liveApi) {
          return {
            ok: true,
            orders: normalizeOrderRows(serverOrders),
            date: dateStr,
          };
        }
        const cached = normalizeOrderRows(
          readCachedRemoteOrders().filter(
            (o) =>
              o &&
              typeof o === "object" &&
              o.source === "website" &&
              isOrderOnIstDate(String(o.createdAt || ""), dayStart),
          ),
        );
        cached.sort((a, b) =>
          String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
        );
        return {
          ok: true,
          orders: cached.slice(0, 100),
          date: dateStr,
          stale: cached.length === 0,
        };
      }

      // Recent / POS orders: merge local device rows with server POS orders.
      const localRows = normalizeOrderRows(
        buildLocalPosOrderRows().filter((o) =>
          isOrderOnIstDate(String(o.createdAt || ""), dayStart),
        ),
      );
      const seen = new Set(localRows.map((o) => String(o.id)));
      const merged = [...localRows];

      const remotePos = normalizeOrderRows(
        liveApi && serverOrders.length > 0
          ? serverOrders
          : readCachedRemoteOrders().filter(
              (o) =>
                o &&
                typeof o === "object" &&
                o.source !== "website" &&
                isOrderOnIstDate(String(o.createdAt || ""), dayStart),
            ),
      );

      for (const o of remotePos) {
        const id = o.id || o.clientOrderId;
        if (id && seen.has(String(id))) continue;
        if (id) seen.add(String(id));
        merged.push(o);
      }

      merged.sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      );
      return { ok: true, orders: merged.slice(0, 100), date: dateStr };
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
    const stored = readStoredBackendConfig(app);
    return {
      ok: true,
      pendingCount: getSyncPendingCount(db),
      configured: stored.configured,
      apiOrigin: stored.configured ? stored.apiOrigin : null,
      lastMenuPullAt: readLastMenuPullAt(db),
      userDataEnvPath: stored.userDataEnvPath,
    };
  });

  ipcMain.handle("khaanz:sync-now", async () => {
    const { configured } = syncEnv();
    if (!configured) {
      return {
        ok: false,
        error:
          "Sync is not configured. Create a .env file in the app data folder with KHAANZ_API_ORIGIN and KHAANZ_SYNC_KEY (must match POS_SYNC_KEY on your server).",
        userDataEnvPath: path.join(app.getPath("userData"), ".env"),
      };
    }
    try {
      const push = await pushSyncOutbox();
      if (!push.ok) return { ok: false, error: push.error || "Push failed" };
      const pull = await pullSyncFromServer();
      if (!pull.ok) return { ok: false, error: pull.error || "Pull failed" };
      return { ok: true, serverTime: nowIso(), lastMenuPullAt: readLastMenuPullAt(db) };
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
  loadEnvFile(path.join(app.getPath("userData"), ".env"), { override: true });
  applyStoredBackendToProcessEnv();
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

