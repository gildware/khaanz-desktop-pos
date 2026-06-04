import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, ImageIcon, Loader2Icon } from "lucide-react";
import {
  BILL_LOGO_SIZE_MAX,
  BILL_LOGO_SIZE_MIN,
  BILL_THEMES,
  DEFAULT_BILL_PREVIEW_SETTINGS,
  mergeBillPrintLayout,
  normalizeBillPreviewSettings,
  type BillPreviewSettings,
  type BillThemeId,
} from "../lib/bill-preview-settings";
import {
  buildBillPreviewDocument,
  buildBillPreviewSampleOptions,
  buildKotPreviewDocument,
  buildKotPreviewSampleOptions,
  type BillPreviewFulfillment,
} from "../lib/pos-print";
import type { KhaanzDesktopApi, PosSettings } from "../types";

type Props = {
  desktop: KhaanzDesktopApi;
  posSettings: PosSettings | null;
  apiOrigin?: string | null;
  onSaved?: (settings: BillPreviewSettings) => void;
};

function ToggleSwitch({
  id,
  checked,
  onChange,
  label,
  description,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={id} className="font-medium text-sm">
          {label}
        </label>
        {description ? (
          <p className="text-muted-foreground text-[11px] leading-snug">{description}</p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          aria-hidden
          className={`pointer-events-none block size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

function BillFieldCard({
  id,
  label,
  description,
  enabled,
  onEnabledChange,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-md border px-2.5 py-2 transition-opacity ${
        enabled ? "border-border bg-card" : "border-border/70 bg-muted/20"
      }`}
    >
      <ToggleSwitch
        id={id}
        checked={enabled}
        onChange={onEnabledChange}
        label={label}
        description={description}
      />
      {children ? (
        <div
          className={`mt-2 space-y-1.5 ${enabled ? "" : "pointer-events-none opacity-40"}`}
          aria-hidden={!enabled}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ReceiptPreviewFrame({ title, srcDoc }: { title: string; srcDoc: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-center font-medium text-muted-foreground text-xs">{title}</p>
      <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-md border-2 border-neutral-400 bg-white shadow-sm">
        <iframe
          title={title}
          className="block h-[min(300px,36vh)] w-full border-0 bg-white grayscale contrast-125"
          srcDoc={srcDoc}
        />
      </div>
    </div>
  );
}

const BILL_PREVIEW_MODES: { id: BillPreviewFulfillment; title: string }[] = [
  { id: "dine_in", title: "Bill — Dine-in" },
  { id: "pickup", title: "Bill — Pickup" },
  { id: "delivery", title: "Bill — Delivery" },
];

export function BillPreviewSettingsPanel({
  desktop,
  posSettings,
  apiOrigin,
  onSaved,
}: Props) {
  const [settings, setSettings] = useState<BillPreviewSettings>(DEFAULT_BILL_PREVIEW_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickingLogo, setPickingLogo] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await desktop.getBillPreviewSettings();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSettings(normalizeBillPreviewSettings(r.settings));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [desktop]);

  useEffect(() => {
    void load();
  }, [load]);

  const layout = useMemo(
    () =>
      mergeBillPrintLayout({
        preview: settings,
        posSettings,
        apiOrigin,
      }),
    [settings, posSettings, apiOrigin],
  );

  const syncedRestaurantName = posSettings?.displayName?.trim() || "Khaanz";
  const logoPreviewSrc = settings.showLogo ? layout.logoSrc : "";

  const billPreviewDocs = useMemo(
    () =>
      BILL_PREVIEW_MODES.map((mode) => ({
        ...mode,
        srcDoc: buildBillPreviewDocument(
          buildBillPreviewSampleOptions(syncedRestaurantName, layout, mode.id),
        ),
      })),
    [layout, syncedRestaurantName],
  );

  const kotPreviewDoc = useMemo(
    () =>
      buildKotPreviewDocument(
        buildKotPreviewSampleOptions(syncedRestaurantName, layout, "delivery"),
      ),
    [layout, syncedRestaurantName],
  );

  const persist = useCallback(
    async (next: BillPreviewSettings) => {
      setSaving(true);
      setError("");
      setMessage("");
      try {
        const normalized = normalizeBillPreviewSettings(next);
        const r = await desktop.setBillPreviewSettings(normalized);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        const saved = normalizeBillPreviewSettings(r.settings);
        setSettings(saved);
        onSaved?.(saved);
        setMessage("Saved — bills will print with this layout.");
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setSaving(false);
      }
    },
    [desktop, onSaved],
  );

  const update = (patch: Partial<BillPreviewSettings>) => {
    setSettings((prev) => normalizeBillPreviewSettings({ ...prev, ...patch }));
    setMessage("");
  };

  const pickLogo = useCallback(async () => {
    if (!desktop.pickBillLogo) {
      setError("Logo upload is not available in this build.");
      return;
    }
    setPickingLogo(true);
    setError("");
    try {
      const r = await desktop.pickBillLogo();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.dataUrl) {
        update({ logoDataUrl: r.dataUrl, showLogo: true });
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setPickingLogo(false);
    }
  }, [desktop]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border p-4 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />
        Loading bill themes…
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded-xl border p-4">
      <p className="mb-4 text-muted-foreground text-xs">
        Theme, header fields, and footer notes for 80mm thermal bills. Previews update live.
      </p>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] lg:items-start">
        <section className="min-w-0 space-y-4">
          <div className="space-y-2">
            <h2 className="font-medium text-sm">Bill theme</h2>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {BILL_THEMES.map((theme) => {
                const selected = settings.themeId === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => update({ themeId: theme.id as BillThemeId })}
                    className={`relative rounded-md border px-2 py-1.5 text-left transition-colors ${
                      selected
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border bg-card hover:border-primary/40"
                    }`}
                  >
                    {selected ? (
                      <CheckIcon className="absolute top-1 right-1 size-3.5 text-primary" />
                    ) : null}
                    <p className="pr-5 font-medium text-xs">{theme.name}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="font-medium text-sm">Bill header</h2>
            <div className="grid min-w-0 gap-2">
              <BillFieldCard
                id="bill-show-logo"
                label="Logo"
                description={
                  settings.logoDataUrl.trim()
                    ? "Using uploaded logo."
                    : posSettings?.logoUrl
                      ? "Using admin sync — upload to override."
                      : "Upload a logo or sync from admin."
                }
                enabled={settings.showLogo}
                onEnabledChange={(showLogo) => update({ showLogo })}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded border bg-white">
                    {logoPreviewSrc ? (
                      <img
                        src={logoPreviewSrc}
                        alt=""
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <ImageIcon className="size-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={pickingLogo}
                      onClick={() => void pickLogo()}
                      className="h-7 rounded border bg-background px-2.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {pickingLogo ? "Opening…" : "Upload"}
                    </button>
                    {settings.logoDataUrl.trim() ? (
                      <button
                        type="button"
                        onClick={() => update({ logoDataUrl: "" })}
                        className="h-7 rounded border border-dashed px-2.5 text-muted-foreground text-xs hover:bg-muted"
                      >
                        Clear upload
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-muted-foreground text-xs">Size</span>
                  <input
                    type="range"
                    min={BILL_LOGO_SIZE_MIN}
                    max={BILL_LOGO_SIZE_MAX}
                    value={settings.logoSizePercent}
                    onChange={(e) =>
                      update({ logoSizePercent: Number.parseInt(e.target.value, 10) })
                    }
                    className="min-w-0 flex-1 accent-primary"
                  />
                  <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums">
                    {settings.logoSizePercent}%
                  </span>
                </div>
              </BillFieldCard>

              <BillFieldCard
                id="bill-show-name"
                label="Restaurant name"
                description={
                  settings.restaurantName.trim()
                    ? "Custom name below."
                    : `Sync: ${syncedRestaurantName}`
                }
                enabled={settings.showRestaurantName}
                onEnabledChange={(showRestaurantName) => update({ showRestaurantName })}
              >
                <input
                  id="bill-rest-name"
                  type="text"
                  value={settings.restaurantName}
                  onChange={(e) => update({ restaurantName: e.target.value })}
                  placeholder={syncedRestaurantName}
                  className="h-8 w-full rounded-md border bg-background px-2.5 text-sm"
                />
              </BillFieldCard>

              <BillFieldCard
                id="bill-show-phone"
                label="Phone"
                enabled={settings.showPhone}
                onEnabledChange={(showPhone) => update({ showPhone })}
              >
                <input
                  id="bill-rest-phone"
                  type="tel"
                  value={settings.restaurantPhone}
                  onChange={(e) => update({ restaurantPhone: e.target.value })}
                  placeholder={
                    posSettings?.whatsappPhoneE164
                      ? `Sync: ${posSettings.whatsappPhoneE164}`
                      : "9906615998"
                  }
                  className="h-8 w-full rounded-md border bg-background px-2.5 font-mono text-sm"
                />
              </BillFieldCard>

              <BillFieldCard
                id="bill-show-address"
                label="Address"
                enabled={settings.showAddress}
                onEnabledChange={(showAddress) => update({ showAddress })}
              >
                <textarea
                  id="bill-rest-address"
                  value={settings.restaurantAddress}
                  onChange={(e) => update({ restaurantAddress: e.target.value })}
                  placeholder="123 Main Road, City"
                  rows={2}
                  className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm"
                />
              </BillFieldCard>

              <BillFieldCard
                id="bill-show-order-id"
                label="Order ID"
                description={`${layout.orderIdLabel} · ${layout.orderIdFormat === "short" ? "short" : "full"}`}
                enabled={settings.showOrderId}
                onEnabledChange={(showOrderId) => update({ showOrderId })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="font-medium text-sm">Bill footer</h2>
            <BillFieldCard
              id="bill-show-footer"
              label="Footer notes"
              description="Only these lines print at the bottom of the bill."
              enabled={settings.showFooterNotes}
              onEnabledChange={(showFooterNotes) => update({ showFooterNotes })}
            >
              <textarea
                id="bill-footer-notes"
                value={settings.footerNotes}
                onChange={(e) => update({ footerNotes: e.target.value })}
                placeholder={"GSTIN: 29XXXXX1234X1Z5\nFSSAI: 12345678901234"}
                rows={3}
                className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm"
              />
            </BillFieldCard>
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={() => void persist(settings)}
            className="h-8 rounded-md bg-primary px-3 font-medium text-primary-foreground text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>

          {message ? (
            <p className="text-green-700 text-xs dark:text-green-400">{message}</p>
          ) : null}
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </section>

        <section className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:border-l lg:pl-5">
          <p className="font-medium text-sm">Thermal preview</p>
          <div className="space-y-4">
            {billPreviewDocs.map((preview) => (
              <ReceiptPreviewFrame
                key={preview.id}
                title={preview.title}
                srcDoc={preview.srcDoc}
              />
            ))}
          </div>
          <div className="border-t border-dashed pt-3">
            <ReceiptPreviewFrame title="KOT" srcDoc={kotPreviewDoc} />
          </div>
        </section>
      </div>
    </div>
  );
}
