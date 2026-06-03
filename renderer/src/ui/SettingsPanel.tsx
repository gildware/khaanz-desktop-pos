import { useState } from "react";
import { normalizeBillPreviewSettings, type BillPreviewSettings } from "../lib/bill-preview-settings";
import type { KhaanzDesktopApi, PosDesktopApi, PosSettings } from "../types";
import { BackendConnectionPanel } from "./BackendConnectionPanel";
import { BillPreviewSettingsPanel } from "./BillPreviewSettingsPanel";

type SettingsTab = "backend" | "bill-preview";

type Props = {
  api: PosDesktopApi;
  desktop: KhaanzDesktopApi | undefined;
  posSettings: PosSettings | null;
  apiOrigin: string | null;
  onBackendSaved: (info: {
    apiOrigin: string;
    syncConfigured: boolean;
    lastMenuPullAt?: string | null;
  }) => void;
  onBillPreviewSaved: (settings: BillPreviewSettings) => void;
};

export function SettingsPanel({
  api,
  desktop,
  posSettings,
  apiOrigin,
  onBackendSaved,
  onBillPreviewSaved,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>("backend");

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
        <button
          type="button"
          onClick={() => setTab("backend")}
          className={`rounded-md px-4 py-2 text-sm transition-colors ${
            tab === "backend"
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Backend connection
        </button>
        <button
          type="button"
          onClick={() => setTab("bill-preview")}
          className={`rounded-md px-4 py-2 text-sm transition-colors ${
            tab === "bill-preview"
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Bill preview
        </button>
      </div>

      {tab === "backend" ? (
        <div className="min-w-0 space-y-6">
          <BackendConnectionPanel
            api={api}
            variant="settings"
            onSaved={onBackendSaved}
          />
          <div className="rounded-xl border p-4 text-muted-foreground text-sm">
            <p className="font-medium text-foreground">Printer</p>
            <p className="mt-1 text-xs">
              Use <strong>Printer</strong> in the header — any connected printer works for KOT and
              bills.
            </p>
          </div>
        </div>
      ) : null}

      {tab === "bill-preview" ? (
        desktop ? (
          <BillPreviewSettingsPanel
            desktop={desktop}
            posSettings={posSettings}
            apiOrigin={apiOrigin}
            onSaved={(s) => onBillPreviewSaved(normalizeBillPreviewSettings(s))}
          />
        ) : (
          <div className="rounded-xl border p-4 text-muted-foreground text-sm">
            Bill preview settings are only available in the desktop app.
          </div>
        )
      ) : null}
    </div>
  );
}
