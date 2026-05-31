import React, { useMemo } from "react";
import { ImageIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { computeUnitPrice } from "../lib/cart-line";
import type { MenuItem, MenuVariation } from "../types";

function formatMoney(rupees: number) {
  return `₹${Number(rupees || 0).toFixed(2)}`;
}

type Props = {
  item: MenuItem | null;
  variationId: string;
  addonQty: Record<string, number>;
  onVariationChange: (id: string) => void;
  onAddonQtyChange: (addonId: string, qty: number) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function ItemConfigureDialog({
  item,
  variationId,
  addonQty,
  onVariationChange,
  onAddonQtyChange,
  onConfirm,
  onClose,
}: Props) {
  const configureUnit = useMemo(() => {
    if (!item) return 0;
    const v = item.variations.find((x) => x.id === variationId);
    if (!v) return 0;
    const withQ = item.addons
      .map((a) => ({ ...a, quantity: addonQty[a.id] ?? 0 }))
      .filter((a) => a.quantity > 0);
    return computeUnitPrice(v, withQ);
  }, [item, variationId, addonQty]);

  const hasAddonQty = useMemo(
    () => (item ? item.addons.some((a) => (addonQty[a.id] ?? 0) > 0) : false),
    [item, addonQty],
  );

  if (!item) return null;

  const bumpAddon = (addonId: string, delta: number) => {
    const n = Math.max(0, Math.min(99, (addonQty[addonId] ?? 0) + delta));
    onAddonQtyChange(addonId, n);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-configure-title"
        className="flex max-h-[min(90dvh,calc(100dvh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <h2 id="item-configure-title" className="font-semibold text-lg leading-tight">
            {item.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="font-medium text-sm" id="pos-variation-label">
                Variation
              </p>
              <div
                className="flex max-w-full flex-nowrap gap-2 overflow-x-auto pb-1"
                role="radiogroup"
                aria-labelledby="pos-variation-label"
              >
                {item.variations.map((v: MenuVariation) => {
                  const selected = variationId === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex min-h-10 shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background hover:bg-muted/60"
                      }`}
                      onClick={() => onVariationChange(v.id)}
                    >
                      <span
                        className={`max-w-[min(12rem,calc(100vw-8rem))] truncate font-medium ${
                          selected ? "text-primary-foreground" : ""
                        }`}
                      >
                        {v.name}
                      </span>
                      <span
                        className={`shrink-0 tabular-nums text-xs ${
                          selected ? "text-primary-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {formatMoney(v.price)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {item.addons.length > 0 ? (
              <div className="space-y-2">
                <p className="font-medium text-sm" id="pos-addons-label">
                  Add-ons
                </p>
                <div
                  className="flex max-w-full flex-wrap content-start gap-2"
                  role="group"
                  aria-labelledby="pos-addons-label"
                >
                  {item.addons.map((a) => {
                    const q = addonQty[a.id] ?? 0;
                    const selected = q > 0;
                    const addonBody = (
                      <>
                        <div className="relative h-8 w-full shrink-0 overflow-hidden bg-muted">
                          {a.image ? (
                            <img src={a.image} alt="" className="size-full object-cover" />
                          ) : (
                            <div className="flex size-full items-center justify-center text-muted-foreground">
                              <ImageIcon className="size-3.5 opacity-60" />
                            </div>
                          )}
                        </div>
                        <div className="flex min-h-0 items-center gap-0.5 px-1 py-0.5 leading-none">
                          <span className="line-clamp-1 min-w-0 flex-1 text-[10px] font-medium">
                            {a.name}
                          </span>
                          <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
                            {formatMoney(a.price)}
                          </span>
                        </div>
                      </>
                    );
                    return (
                      <div
                        key={a.id}
                        className={`flex w-[6.25rem] shrink-0 flex-col overflow-hidden rounded-lg border bg-background text-left ${
                          selected ? "border-primary ring-1 ring-primary" : "border-border"
                        }`}
                      >
                        {q === 0 ? (
                          <button
                            type="button"
                            className="flex w-full flex-col overflow-hidden text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => bumpAddon(a.id, 1)}
                            aria-label={`Add ${a.name}`}
                          >
                            {addonBody}
                          </button>
                        ) : (
                          <div className="flex flex-col">{addonBody}</div>
                        )}
                        {q > 0 ? (
                          <div className="flex items-center justify-center gap-0.5 border-t p-0.5">
                            <button
                              type="button"
                              className="flex size-6 items-center justify-center rounded-md border"
                              onClick={() => bumpAddon(a.id, -1)}
                              aria-label="Decrease add-on"
                            >
                              <MinusIcon className="size-3" />
                            </button>
                            <span className="w-5 text-center text-[10px] tabular-nums">{q}</span>
                            <button
                              type="button"
                              className="flex size-6 items-center justify-center rounded-md border"
                              onClick={() => bumpAddon(a.id, 1)}
                              aria-label="Increase add-on"
                            >
                              <PlusIcon className="size-3" />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-muted-foreground text-sm">
            {hasAddonQty ? (
              <span>
                Final price:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {formatMoney(configureUnit)}
                </span>
              </span>
            ) : null}
          </div>
          <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border px-4 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="h-9 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm"
            >
              Add to order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
