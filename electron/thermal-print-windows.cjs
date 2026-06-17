/** Windows thermal drivers (BillQuick Lite, POS 203DPI, Generic/Text) — print options. */

/**
 * Chromium GDI options that work with common 80mm ESC/POS Windows queue names.
 * Avoid custom micron pageSize/dpi — many drivers print blank otherwise.
 */
function windowsThermalPrintOptions(deviceName) {
  return {
    silent: true,
    printBackground: false,
    color: false,
    deviceName,
    landscape: false,
    copies: 1,
    margins: { marginType: "none" },
  };
}

function darwinThermalPrintOptions(deviceName) {
  return {
    silent: true,
    printBackground: true,
    color: false,
    deviceName,
    margins: { marginType: "none" },
  };
}

function defaultThermalPrintOptions(deviceName) {
  if (process.platform === "darwin") {
    return darwinThermalPrintOptions(deviceName);
  }
  return {
    silent: true,
    printBackground: false,
    color: false,
    deviceName,
    margins: { marginType: "custom", top: 0, bottom: 0, left: 0, right: 0 },
    pageSize: { width: 80000, height: 300000 },
    dpi: { horizontal: 203, vertical: 203 },
  };
}

/** @param {string} deviceName @param {{ withImages?: boolean }} [opts] */
function getThermalPrintOptions(deviceName, opts = {}) {
  const withImages = Boolean(opts.withImages);
  if (process.platform === "win32") {
    const base = windowsThermalPrintOptions(deviceName);
    if (withImages) return { ...base, printBackground: true };
    return base;
  }
  if (process.platform === "darwin") {
    const base = darwinThermalPrintOptions(deviceName);
    if (withImages) return { ...base, printBackground: true };
    return base;
  }
  const base = defaultThermalPrintOptions(deviceName);
  if (withImages) return { ...base, printBackground: true };
  return base;
}

/** Hidden print window sizing — narrow on Windows for 80mm roll. */
function getPrintWindowSize() {
  if (process.platform === "win32") {
    return { width: 360, height: 1200 };
  }
  return { width: 420, height: 1200 };
}

const MM_PER_INCH = 25.4;
const MICRONS_PER_INCH = 25400;
const CSS_DPI = 96;
const RECEIPT_WIDTH_MM = 80;
/** Extra paper after footer so the slip is easy to tear. */
const RECEIPT_BOTTOM_SLACK_PX = 40;

async function measureReceiptContentHeightPx(webContents) {
  const px = await webContents.executeJavaScript(`
    (() => {
      const root = document.querySelector(".thermal-receipt-root");
      const h = Math.max(
        root ? root.scrollHeight : 0,
        root ? root.offsetHeight : 0,
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
      );
      return Math.ceil(h);
    })()
  `);
  return Math.max(80, Number(px) || 0);
}

/** Page height matches receipt content (macOS/Linux only — Windows GDI drivers print blank with custom pageSize). */
async function getThermalPrintOptionsForContent(webContents, deviceName, opts = {}) {
  const withImages = Boolean(opts.withImages);
  const base = getThermalPrintOptions(deviceName, { withImages });
  if (process.platform === "win32") {
    return base;
  }
  let contentPx = 200;
  try {
    contentPx = await measureReceiptContentHeightPx(webContents);
  } catch {
    /* keep fallback height */
  }
  const heightPx = contentPx + RECEIPT_BOTTOM_SLACK_PX;
  const widthMicrons = Math.round((RECEIPT_WIDTH_MM / MM_PER_INCH) * MICRONS_PER_INCH);
  const heightMicrons = Math.round((heightPx / CSS_DPI) * MICRONS_PER_INCH);
  return {
    ...base,
    margins: { marginType: "custom", top: 0, bottom: 0, left: 0, right: 0 },
    pageSize: { width: widthMicrons, height: heightMicrons },
  };
}

module.exports = {
  getThermalPrintOptions,
  getThermalPrintOptionsForContent,
  getPrintWindowSize,
  measureReceiptContentHeightPx,
  RECEIPT_BOTTOM_SLACK_PX,
};
