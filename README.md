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

Test the **packaged UI** locally (loads `renderer/dist`, same as the installed app):

```bash
npm run build:renderer && npm run start:dist
```

`npm start` alone expects the Vite dev server (`npm run dev`). Use `start:dist` after a renderer build.

If the window looks unstyled, rebuild the renderer — production builds must not use `crossorigin` on assets (fixed in `renderer/vite.config.ts`).

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

For a **packaged** desktop build (installed `.dmg` / `.exe`), connect from the app:

1. On first launch — **Connect to your Khaanz site** (domain + sync key), then **Save & connect**
2. **PIN only** to sign in (no staff picker); use **Change server** on the login screen to reconnect
3. After sign-in — **Settings** tab to change domain or sync key anytime

The sync key must match `POS_SYNC_KEY` on your Khaanz server. Domain is stored as `https://your-domain.com` (no trailing slash).

Advanced: the same values are saved to the app user-data `.env` file automatically (`~/Library/Application Support/khaanz-pos-desktop-offline/.env` on macOS).

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

### macOS: “Khaanz POS is damaged and can’t be opened”

This is **Gatekeeper** blocking an app downloaded from GitHub (not a corrupt file). The app is unsigned until you add an Apple Developer certificate.

**Fix after install (one time per download):**

```bash
xattr -cr "/Applications/Khaanz POS.app"
```

Then open **Khaanz POS** from Applications again.

**Alternative:** Finder → Applications → right‑click **Khaanz POS** → **Open** → confirm **Open** (bypasses quarantine for that app).

If you installed from the `.dmg` before copying to Applications, run the same command on the `.app` inside the DMG, or only on the copy in `/Applications`.

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

### Developing on Mac

You can build and run almost everything on macOS (`npm run dev`). **BillQuick / Petpooja-style thermal printing only exists on Windows** — the Mac app uses a different HTML print path and cannot exercise `notepad /pt` or the Windows spooler.

| What | On Mac | On Windows PC at the shop |
|------|--------|---------------------------|
| UI, cart, orders, sync, PIN | Yes | Yes |
| Thermal receipt (BillQuick Lite) | No (different code path) | Yes — this is the real test |
| Full print validation | Use mock (below) or any Mac printer | Test print + standalone script |

**Mac: test the rest of the app without a receipt printer**

```bash
# pos-desktop/.env
KHAANZ_DEV_MOCK_PRINT=1
npm run dev
```

Connect printer → pick any queue → Save → Test print will succeed as **dev-mock** (no paper). Use that for Save & Bill flow while you work on UI/sync.

**Before each Windows release** (once, on the shop PC — not on your Mac):

```powershell
node scripts/test-windows-print.cjs "BillQuick Lite"
```

If that prints paper, ship the release. GitHub Actions builds the `.exe` on Windows in CI, but it cannot attach to your USB printer — a human check on the shop machine is still required.

Options if you want Windows without sitting at the shop every time: a cheap Windows mini PC on the network (Remote Desktop), Parallels/VM on Mac (USB passthrough is fiddly), or ask staff to run the one-line test after install.

### Windows thermal printers (BillQuick Lite, POS 203DPI, etc.)

The app uses the **same GDI print path as Petpooja**. The primary method is `System.Drawing.Printing.PrintDocument` (a real GDI spooler job through the printer driver); if that driver path fails it falls back to RAW ESC/POS (Generic/Text Only queues and direct USB/COM port writes), and only as a last resort to the legacy `notepad /pt` / ShellExecute `printto` verbs. Those legacy verbs are **never trusted on exit code alone** — on Windows 11 `notepad /pt` opens the file without printing — so they only count as success when the **Windows print spooler** shows a real job. After the first successful print, the app **reuses that method** for bills and KOTs.

Every attempt is recorded to a log (`khaanz-print.log` in the app's logs folder, e.g. `%APPDATA%\khaanz-pos-desktop-offline\logs\` on Windows). If a print "succeeds" but no paper comes out, check that log to see which method was used.

**Test printing before you build/install a release** (on the Windows PC with the printer USB-connected):

```powershell
cd pos-desktop
npm install
# Fastest — pure PowerShell (no Electron):
.\scripts\Test-KhaanzPrinter.ps1 -PrinterName "BillQuick Lite"

# Full app logic — same code as Test print in the POS:
node scripts/test-windows-print.cjs "BillQuick Lite"
```

If paper prints from either command, the installed app will work the same way. If both fail, fix the queue in Windows (same name as Petpooja) before deploying again.

**In the POS app:**

1. **Connect printer** → select **BillQuick Lite** (not HP / PDF / Microsoft Print to PDF).
2. **Save** → **Test print** → paper must print; header shows **Printer ready**.
3. Use **Save & Bill** / **Save & Print**.

macOS uses HTML silent print. Optional: `KHAANZ_SILENT_PRINTER` = exact queue name.

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
