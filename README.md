# Offline POS (Desktop)

Standalone offline-first desktop POS (Electron + Vite + React + SQLite). The app ships its **own UI** — it does not embed or load the Next.js admin site in a browser window.

## Architecture

```
Electron main (SQLite, sync, print)
        ↕ IPC (posDesktop / khaanzDesktop)
Vite renderer (standalone React UI in renderer/src/ui/)
```

- **UI:** Local React bundle only (`renderer/dist` in production, Vite dev server in development).
- **Data:** SQLite in the app user-data folder — users, sessions, menu cache, orders, sync outbox.
- **Sync (optional):** Main process pushes/pulls to your server via `KHAANZ_API_ORIGIN` — no web pages opened in the app window.
- **Print:** Hidden print window for thermal receipts (not user-visible browsing).

External navigation and pop-ups are blocked in the main window.

## What works now

- Runs without the server (local UI bundle)
- PIN login (seeded manager)
- Browse menu from local cache, build cart, place orders offline
- Sync menu/orders when `KHAANZ_API_ORIGIN` + `KHAANZ_SYNC_KEY` are set
- Silent thermal printing via configured OS printer

## Run (dev)

```bash
cd pos-desktop
npm install
npm --prefix renderer install
KHAANZ_OPEN_DEVTOOLS=1 npm run dev
```

If the app fails to start with a native-module error after `npm install`, rebuild SQLite for Electron:

```bash
npm run rebuild:electron
```

Seeded login:

- User: `Manager`
- PIN: `1234`

## Sync (optional)

1. In **`khaanz/.env`**, set `POS_SYNC_KEY` (server validates sync requests).
2. In **`pos-desktop/.env`**, set the same secret as `KHAANZ_SYNC_KEY` and your site as `KHAANZ_API_ORIGIN`:

```bash
cd pos-desktop
cp .env.example .env
# edit .env — KHAANZ_SYNC_KEY must match POS_SYNC_KEY in khaanz/.env
npm run dev
```

Restart both the Next.js app and the desktop app after changing env files.

Server endpoints:

- `POST /api/pos-sync/push`
- `GET /api/pos-sync/pull`

For a **packaged** desktop build, you can also place `.env` in the app user-data folder (loaded on startup).

## Ship installers (`npm run dist`)

Builds the renderer (Vite), then packages macOS (DMG + zip) and Windows (NSIS + zip) with [electron-builder](https://www.electron.build/). Artifacts go to `pos-desktop/release/`.

```bash
cd pos-desktop
npm install
npm --prefix renderer install
npm run dist
```

On macOS you can smoke-test the app bundle:

```bash
open "release/mac-arm64/Khaanz POS.app"
```

### App icon

Icons use `logo/khaanz-logo.pdf.png` (`build.icon` in `package.json`). Rebuild with `npm run dist` after replacing the file.

## GitHub Releases (CI)

Pushing to **`main`** or tagging **`v*`** runs [`.github/workflows/release.yml`](.github/workflows/release.yml) on [gildware/khaanz-desktop-pos](https://github.com/gildware/khaanz-desktop-pos):

- **macOS:** `.dmg` + `.zip` (zip is used for in-app auto-update)
- **Windows:** NSIS `.exe` + `.zip`
- Each `main` push gets version `0.1.<run-number>` and tag `v0.1.<run-number>` on GitHub Releases
- Installed apps auto-update via `electron-updater` (uses the `latest*.yml` files attached to each release)

Packaged apps check GitHub for updates on startup (and via `khaanzDesktop.checkForUpdates()`).

## Admin download links (khaanz)

**Settings → POS app** loads the latest release from GitHub automatically (`DESKTOP_POS_GITHUB_REPO`, default `gildware/khaanz-desktop-pos`). Optional env overrides:

- `NEXT_PUBLIC_DESKTOP_POS_MAC_URL`
- `NEXT_PUBLIC_DESKTOP_POS_WINDOWS_URL`

## Environment variables

| Variable | Purpose |
|----------|---------|
| `KHAANZ_OPEN_DEVTOOLS` | Set to `1` to open DevTools in dev. |
| `KHAANZ_API_ORIGIN` | e.g. `https://your-site.com` — enables sync pull/push. |
| `KHAANZ_SYNC_KEY` | Shared secret header for sync when required by your API. |
| `KHAANZ_SILENT_PRINTER` | Optional exact OS printer name for silent receipts. |

### List printer names (macOS / Windows)

From `pos-desktop` after `npm install`:

```bash
npx electron -e "const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false});await w.loadURL('about:blank');const p=await w.webContents.getPrintersAsync();console.log(p.map(x=>x.name));app.quit();})"
```

## From the Next app (`khaanz/`)

```bash
npm run desktop
```

starts `pos-desktop` in dev (renderer + Electron). This is independent of the web admin UI — the desktop app does not load `/admin/pos` or any other web route.
