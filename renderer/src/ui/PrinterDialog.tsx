import React, { useCallback, useEffect, useState } from "react";
import { Loader2Icon, XIcon } from "lucide-react";

type PrinterRow = { name: string; isDefault?: boolean };

type PrinterStatus = {
  ok: true;
  saved: boolean;
  available: boolean;
  online: boolean;
  verified: boolean;
  connected: boolean;
  deviceName: string;
  statusDetail?: string;
  printers: PrinterRow[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

function isLikelyReceiptPrinter(name: string): boolean {
  const n = name.toLowerCase();
  return /billquick|pos\s*80|pos\s*58|pos-?80|pos-?58|203dpi|thermal|receipt|tm-|tsp|star\s|epson\s*tm|xprinter|bixolon|generic\/text|generic.text/i.test(
    n,
  );
}

export function PrinterDialog({ open, onClose, onSaved }: Props) {
  const desktop = window.khaanzDesktop;
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [deviceName, setDeviceName] = useState("");
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!desktop?.getPrinterStatus) return;
    const r = await desktop.getPrinterStatus();
    if (!r.ok) return;
    setStatus(r);
    setPrinters(r.printers ?? []);
    setDeviceName(r.deviceName || "");
  }, [desktop]);

  useEffect(() => {
    if (!open) return;
    setTestMessage("");
    setError("");
    void refresh();
  }, [open, refresh]);

  async function save() {
    if (!desktop?.setSilentPrinter) return;
    const name = deviceName.trim();
    if (!name) {
      setError("Select a printer from the list.");
      return;
    }
    setBusy(true);
    setError("");
    setTestMessage("");
    try {
      const out = await desktop.setSilentPrinter(name);
      if (!out.ok) {
        setError(out.error || "Could not set printer.");
        return;
      }
      await refresh();
      onSaved();
      setTestMessage("Printer saved. Run Test print to confirm it works.");
    } finally {
      setBusy(false);
    }
  }

  async function testPrint() {
    if (!desktop?.testPrint) return;
    setBusy(true);
    setError("");
    setTestMessage("");
    try {
      const out = await desktop.testPrint();
      if (!out.ok) {
        setError(out.error || "Test print failed.");
        await refresh();
        return;
      }
      setTestMessage("Test print sent. If paper came out, you are ready for KOT/Bill.");
      await refresh();
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const selected = deviceName.trim();
  const selectedInList = Boolean(selected && printers.some((p) => p.name === selected));
  const connected = Boolean(status?.connected);
  const saved = Boolean(status?.saved);
  const online = Boolean(status?.online);
  const verified = Boolean(status?.verified);
  const showTestPrint = Boolean(saved && status?.online && selectedInList);

  let statusLine = "Select your receipt printer (e.g. BillQuick Lite), then Save.";
  let statusClass = "text-muted-foreground";
  if (connected) {
    statusLine = `Ready — ${status?.deviceName}`;
    statusClass = "text-emerald-600 dark:text-emerald-400";
  } else if (saved && !online) {
    statusLine =
      status?.statusDetail ||
      `${status?.deviceName} is saved but offline. Plug in the printer or turn it on, then Refresh.`;
    statusClass = "text-destructive";
  } else if (saved && online && !verified) {
    statusLine = `${status?.deviceName} saved — run Test print to mark as connected.`;
    statusClass = "text-amber-700 dark:text-amber-400";
  } else if (saved) {
    statusLine = `${status?.deviceName} saved — not verified yet.`;
    statusClass = "text-muted-foreground";
  }

  const receiptHint =
    selected && !isLikelyReceiptPrinter(selected)
      ? "This looks like an office printer, not a receipt printer. Choose BillQuick Lite or your 80mm thermal queue."
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="font-semibold text-lg leading-tight">Connect printer</h2>
              <p className="text-muted-foreground text-sm leading-snug">
                Select the <strong>same printer name</strong> you use in Petpooja (e.g. BillQuick
                Lite) — not HP/PDF printers.
              </p>
            </div>
            <button type="button" onClick={onClose} className="shrink-0 rounded-md border p-2">
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className={`break-words text-sm leading-relaxed ${statusClass}`}>{statusLine}</p>

          {printers.length === 0 ? (
            <p className="text-muted-foreground text-sm leading-relaxed">
              No printers detected. Install the thermal driver in Windows, connect USB, then Refresh.
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
                    {p.isDefault ? " (Windows default)" : ""}
                  </option>
                ))}
              </select>
              {receiptHint ? (
                <p className="text-amber-800 text-xs leading-relaxed dark:text-amber-300">
                  {receiptHint}
                </p>
              ) : null}
            </div>
          )}

          {error ? (
            <p className="break-words text-destructive text-sm leading-relaxed">{error}</p>
          ) : null}
          {testMessage ? (
            <p className="break-words text-emerald-700 text-sm leading-relaxed dark:text-emerald-400">
              {testMessage}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-muted/20 px-5 py-4">
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
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Test print
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !selectedInList}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-primary-foreground text-sm disabled:opacity-50"
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Save printer
          </button>
        </div>
      </div>
    </div>
  );
}
