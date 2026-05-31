import React, { useCallback, useEffect, useState } from "react";
import { Loader2Icon, XIcon } from "lucide-react";

type Printer = { name: string; isDefault?: boolean };

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function PrinterDialog({ open, onClose, onSaved }: Props) {
  const desktop = window.khaanzDesktop;
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!desktop?.listPrinters || !desktop.getSilentPrinter) return;
    const [list, current] = await Promise.all([
      desktop.listPrinters(),
      desktop.getSilentPrinter(),
    ]);
    setPrinters(Array.isArray(list) ? list : []);
    setDeviceName(typeof current?.deviceName === "string" ? current.deviceName : "");
  }, [desktop]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  async function save() {
    if (!desktop?.setSilentPrinter) return;
    setBusy(true);
    setError("");
    try {
      const out = await desktop.setSilentPrinter(deviceName);
      if (!out.ok) {
        setError(out.error || "Could not set printer.");
        return;
      }
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const connected =
    (deviceName.trim() && printers.some((p) => p.name === deviceName.trim())) ||
    (!deviceName.trim() && printers.some((p) => p.isDefault));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-lg">Connect printer</h2>
            <p className="text-muted-foreground text-sm">
              Select a printer for silent KOT/Bill printing.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border p-2">
            <XIcon className="size-4" />
          </button>
        </div>

        <p className={`mb-3 text-sm ${connected ? "text-emerald-600" : "text-destructive"}`}>
          {connected ? "Connected" : "Not connected"}
        </p>

        {printers.length === 0 ? (
          <p className="mb-4 text-muted-foreground text-sm">
            No printers detected. Connect a printer and click Refresh.
          </p>
        ) : (
          <label className="mb-4 grid gap-2">
            <span className="font-medium text-sm">Printer</span>
            <select
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">System default</option>
              {printers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {error ? <p className="mb-3 text-destructive text-sm">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void refresh()} className="h-9 rounded-md border px-3 text-sm">
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
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
