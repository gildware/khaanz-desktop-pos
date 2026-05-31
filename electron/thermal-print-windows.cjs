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
    margins: { marginType: "printableArea" },
  };
}

function defaultThermalPrintOptions(deviceName) {
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

/** @param {string} deviceName */
function getThermalPrintOptions(deviceName) {
  if (process.platform === "win32") {
    return windowsThermalPrintOptions(deviceName);
  }
  return defaultThermalPrintOptions(deviceName);
}

/** Hidden print window sizing — narrow on Windows for 80mm roll. */
function getPrintWindowSize() {
  if (process.platform === "win32") {
    return { width: 360, height: 2400 };
  }
  return { width: 420, height: 1200 };
}

module.exports = {
  getThermalPrintOptions,
  getPrintWindowSize,
};
