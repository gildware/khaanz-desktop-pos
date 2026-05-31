import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2Icon, XIcon } from "lucide-react";

type PrinterRow = { name: string; isDefault?: boolean };

type PrinterStatus = {
  ok: true;
  saved: boolean;
  available: boolean;
  online: boolean;
  verified: boolean;
  connected: boolean;
  ready?: boolean;
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
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
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
      setTestMessage("Saved. Click Test print — receipt paper should come out.");
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
      setTestMessage("Test print sent. Check your receipt printer now.");
      await refresh();
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const selected = deviceName.trim();
  const selectedInList = Boolean(selected && printers.some((p) => p.name === selected));
  const saved = Boolean(status?.saved);
  const showTestPrint = Boolean(selectedInList && (saved || selected));

  let statusLine = "Pick the same printer name as Petpooja, then Save.";
  let statusClass = "text-muted-foreground";
  if (status?.connected) {
    statusLine = `Ready — ${status.deviceName}`;
    statusClass = "text-emerald-600 dark:text-emerald-400";
  } else if (saved) {
    statusLine = `${status.deviceName} saved — run Test print.`;
    statusClass = "text-amber-700 dark:text-amber-400";
  }

  const receiptHint =
    selected && !isLikelyReceiptPrinter(selected)
      ? "Warning: this looks like an office/PDF printer. Use BillQuick Lite or your 80mm thermal queue."
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
                Connect printer
              </h2>
              <p className="mt-1 text-muted-foreground text-sm leading-normal">
                Same queue name as Petpooja (e.g. BillQuick Lite).
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
                {receiptHint ? (
                  <p className="text-amber-800 text-xs leading-normal dark:text-amber-300">
                    {receiptHint}
                  </p>
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
        </footer>
      </div>
    </div>,
    document.body,
  );
}
