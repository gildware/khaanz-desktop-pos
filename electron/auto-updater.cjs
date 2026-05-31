const { autoUpdater } = require("electron-updater");

/** @param {import('electron').BrowserWindow | null} mainWindow */
function initAutoUpdater(mainWindow, { isDev }) {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:update-status", payload);
    }
  };

  autoUpdater.on("checking-for-update", () => {
    send({ phase: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    send({ phase: "available", version: info?.version ?? null });
  });
  autoUpdater.on("update-not-available", () => {
    send({ phase: "not-available" });
  });
  autoUpdater.on("download-progress", (p) => {
    send({
      phase: "downloading",
      percent: p?.percent ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    send({ phase: "downloaded", version: info?.version ?? null });
  });
  autoUpdater.on("error", (err) => {
    send({ phase: "error", message: err?.message ?? String(err) });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 8000);
}

module.exports = { initAutoUpdater, autoUpdater };
