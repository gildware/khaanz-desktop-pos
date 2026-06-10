import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2Icon, XIcon } from "lucide-react";
import { withIpcTimeout } from "../lib/ipc-timeout";

type PrinterRow = { name: string; isDefault?: boolean };

type PrinterDiagnostics = {
  port?: string;
  driver?: string;
  status?: string;
  workOffline?: boolean;
  resolvedName?: string;
};

type PrinterStatus = {
  ok: true;
  saved: boolean;
  available: boolean;
  online: boolean;
  verified: boolean;
  connected: boolean;
  ready?: boolean;
  autoSelected?: boolean;
  deviceName: string;
  statusDetail?: string;
  diagnostics?: PrinterDiagnostics | null;
  printers: PrinterRow[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

function pickDefaultFromList(printers: PrinterRow[]): string {
  const def = printers.find((p) => p.isDefault);
  return def?.name || printers[0]?.name || "";
}

function liveStatusLine(status: PrinterStatus | null): { text: string; className: string } {
  if (!status?.printers?.length) {
    return {
      text: "No printers found — connect USB and install the driver, then Refresh.",
      className: "text-muted-foreground",
    };
  }
  if (status.connected && status.deviceName) {
    const auto = status.autoSelected ? " (auto)" : "";
    return {
      text: status.verified
        ? `Connected — ${status.deviceName}${auto}`
        : `Connected — ${status.deviceName}${auto}. Run Test print to confirm.`,
      className: "text-emerald-600 dark:text-emerald-400",
    };
  }
  if (status.statusDetail) {
    return { text: status.statusDetail, className: "text-amber-700 dark:text-amber-400" };
  }
  return {
    text: "Printer disconnected — check USB/power.",
    className: "text-amber-700 dark:text-amber-400",
  };
}

export function PrinterDialog({ open, onClose, onSaved }: Props) {
  const desktop = window.khaanzDesktop;
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [deviceName, setDeviceName] = useState("");
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!desktop?.getPrinterStatus) return;
    try {
      const r = await withIpcTimeout(
        desktop.getPrinterStatus({ includeDiagnostics: true }),
        25_000,
        "Printer status",
      );
      if (!r.ok) return;
      setStatus(r);
      const list = r.printers ?? [];
      setPrinters(list);
      setDeviceName((prev) => {
        if (r.deviceName) return r.deviceName;
        if (prev && list.some((p) => p.name === prev)) return prev;
        return pickDefaultFromList(list);
      });
    } catch {
      /* keep last known status */
    }
  }, [desktop]);

  useEffect(() => {
    if (!open) return;
    setTestMessage("");
    setError("");
    void refresh();
    const pollId = setInterval(() => {
      void refresh();
    }, 2500);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearInterval(pollId);
      document.body.style.overflow = prev;
    };
  }, [open, refresh]);

  async function save() {
    if (!desktop?.setSilentPrinter) return;
    const name = deviceName.trim();
    if (!name) {
      setError("Select a printer from the list.");
      return;
    }
    setSaveBusy(true);
    setError("");
    setTestMessage("");
    try {
      const out = await withIpcTimeout(
        desktop.setSilentPrinter(name),
        15000,
        "Save printer",
      );
      if (!out.ok) {
        setError(out.error || "Could not set printer.");
        return;
      }
      await refresh();
      onSaved();
      setTestMessage("Printer saved. Click Test print to confirm paper output.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function testPrint() {
    if (!desktop?.testPrint) return;
    const name = deviceName.trim();
    if (!name) {
      setError("Select a printer from the list first.");
      return;
    }
    setTestBusy(true);
    setError("");
    setTestMessage("");
    try {
      const out = await withIpcTimeout(desktop.testPrint(name), 100_000, "Test print");
      if (!out.ok) {
        setError(out.error || "Test print failed.");
        await refresh();
        return;
      }
      setTestMessage(
        out.method
          ? `Printed via ${out.method}. Check your printer now.`
          : "Test print sent. Check your printer now.",
      );
      await refresh();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setTestBusy(false);
    }
  }

  if (!open) return null;

  const busy = saveBusy || testBusy;
  const selected = deviceName.trim();
  const selectedInList = Boolean(selected && printers.some((p) => p.name === selected));
  const showTestPrint = Boolean(selectedInList && printers.length > 0);
  const { text: statusLine, className: statusClass } = liveStatusLine(status);

  const diag = status?.diagnostics;
  const diagLine =
    diag?.port || diag?.driver
      ? `Windows: ${diag.resolvedName || status?.deviceName || selected} · port ${diag.port || "?"} · ${diag.driver || "driver?"}`
      : null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="printer-dialog-title"
        className="flex max-h-[min(90vh,640px)] w-full max-w-md flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 space-y-2 border-b px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="printer-dialog-title" className="font-semibold text-lg leading-tight">
                Printer
              </h2>
              <p className="mt-1 text-muted-foreground text-sm leading-normal">
                Any printer connected to this PC works — USB, network, or Bluetooth.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md border p-2"
              aria-label="Close"
            >
              <XIcon className="size-4" />
            </button>
          </div>
          <p className={`break-words text-sm leading-normal ${statusClass}`}>{statusLine}</p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-4">
            {printers.length === 0 ? (
              <p className="text-muted-foreground text-sm leading-normal">
                No printers found. Connect USB, install driver, then Refresh.
              </p>
            ) : (
              <div className="space-y-2">
                <label htmlFor="pos-printer-select" className="block font-medium text-sm">
                  Printer
                </label>
                <select
                  id="pos-printer-select"
                  value={deviceName}
                  onChange={(e) => {
                    setDeviceName(e.target.value);
                    setTestMessage("");
                    setError("");
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Select printer…</option>
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <p className="text-muted-foreground text-xs leading-normal">
                  Leave on the default to auto-use any connected printer. Pick another only if you
                  have multiple.
                </p>
                {diagLine ? (
                  <p className="text-muted-foreground text-xs leading-normal">{diagLine}</p>
                ) : null}
              </div>
            )}

            {error ? (
              <p className="break-words text-destructive text-sm leading-normal">{error}</p>
            ) : null}
            {testMessage ? (
              <p className="break-words text-emerald-700 text-sm leading-normal dark:text-emerald-400">
                {testMessage}
              </p>
            ) : null}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-muted/30 px-5 py-4">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="h-9 rounded-md border bg-background px-3 text-sm disabled:opacity-50"
          >
            Refresh
          </button>
          {showTestPrint ? (
            <button
              type="button"
              onClick={() => void testPrint()}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm disabled:opacity-50"
            >
              {testBusy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Test print
            </button>
          ) : null}
          {selectedInList ? (
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-primary-foreground text-sm disabled:opacity-50"
            >
              {saveBusy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Use this printer
            </button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
