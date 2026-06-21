const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, args) {
  return ipcRenderer.invoke(channel, args);
}

contextBridge.exposeInMainWorld("posDesktop", {
  bootstrap: () => invoke("pos:bootstrap"),
  getBackendConfig: () => invoke("pos:get-backend-config"),
  saveBackendConfig: (apiOrigin, syncKey) =>
    invoke("pos:save-backend-config", { apiOrigin, syncKey }),
  testBackendConfig: (apiOrigin, syncKey) =>
    invoke("pos:test-backend-config", { apiOrigin, syncKey }),
  listUsers: () => invoke("pos:listUsers"),
  loginWithPin: (userId, pin) => invoke("pos:loginWithPin", { userId, pin }),
  loginWithPinOnly: (pin) => invoke("pos:loginWithPinOnly", { pin }),
  logout: (sessionId) => invoke("pos:logout", { sessionId }),
  getSession: (sessionId) => invoke("pos:getSession", { sessionId }),
  listMenuItems: (sessionId) => invoke("pos:listMenuItems", { sessionId }),
  getMenuPayload: () => invoke("pos:getMenuPayload"),
  getPosSettings: () => invoke("pos:getPosSettings"),
  upsertMenuSnapshot: (sessionId, items) =>
    invoke("pos:upsertMenuSnapshot", { sessionId, items }),
  createOrder: (sessionId, items, fulfillment) =>
    invoke("pos:createOrder", { sessionId, items, fulfillment }),
  listRecentOrders: (sessionId, limit) =>
    invoke("pos:listRecentOrders", { sessionId, limit }),
});

/**
 * Desktop-only bridge: silent print, sync, offline order queue.
 */
contextBridge.exposeInMainWorld("khaanzDesktop", {
  isDesktop: true,
  getPlatform: () => invoke("pos:platform"),
  checkForUpdates: () => invoke("app:check-for-updates"),
  onUpdateStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on("app:update-status", listener);
    return () => ipcRenderer.removeListener("app:update-status", listener);
  },
  printSilentHtml: (html, title) =>
    invoke("khaanz:print-silent-html", { html, title }),
  openCashDrawer: (deviceName) =>
    invoke("khaanz:open-cash-drawer", { deviceName: deviceName || "" }),
  printReceiptText: (text, title, options) =>
    invoke("khaanz:print-receipt-text", {
      text,
      title,
      ...(options && typeof options === "object" ? options : {}),
    }),
  getPrinterStatus: (opts) => invoke("khaanz:get-printer-status", opts || {}),
  testPrint: (deviceName) => invoke("khaanz:test-print", deviceName || ""),
  listPrinters: () => invoke("khaanz:list-printers"),
  getSilentPrinter: () => invoke("khaanz:get-silent-printer"),
  setSilentPrinter: (deviceName) => invoke("khaanz:set-silent-printer", deviceName),
  enqueueOfflineOrder: (row) => invoke("khaanz:offline-enqueue", row),
  getOfflineQueue: () => invoke("khaanz:offline-get"),
  removeOfflineOrder: (clientOrderId) => invoke("khaanz:offline-remove", clientOrderId),
  syncNow: () => invoke("khaanz:sync-now"),
  checkConnectivity: () => invoke("khaanz:check-connectivity"),
  getSyncStatus: () => invoke("khaanz:sync-status"),

  // Desktop-only helpers used by the desktop POS fast-path.
  placePosOrder: (clientOrderId, body, isUpdate) =>
    invoke("khaanz:pos-place-order", { clientOrderId, body, isUpdate: Boolean(isUpdate) }),
  listRecentPosOrders: () => invoke("khaanz:pos-list-recent-orders"),
  listPosOrders: (opts) => invoke("khaanz:pos-list-orders", opts),
  getTodaySalesReport: () => invoke("khaanz:pos-today-report"),
  searchDeliveryCustomers: (query) =>
    invoke("khaanz:pos-search-delivery-customers", { query }),
  updatePosOrderStatus: (orderId, status) =>
    invoke("khaanz:pos-update-order-status", { orderId, status }),
  updatePosOrder: (orderId, body) =>
    invoke("khaanz:pos-place-order", { clientOrderId: orderId, body, isUpdate: true }),
  getBillPreviewSettings: () => invoke("khaanz:get-bill-preview-settings"),
  setBillPreviewSettings: (settings) =>
    invoke("khaanz:set-bill-preview-settings", { settings }),
  pickBillLogo: () => invoke("khaanz:pick-bill-logo"),
  openExternalUrl: (url) => invoke("khaanz:open-external-url", { url }),
  hydrateOrderDistances: (orders) =>
    invoke("khaanz:hydrate-order-distances", { orders }),
});

