import React from "react";
import { Loader2Icon, XIcon } from "lucide-react";

export type OrderStatusConfirmPayload = {
  orderId: string;
  orderRef: string;
  currentStatusLabel: string;
  nextStatus: string;
  nextStatusLabel: string;
  actionLabel: string;
  destructive?: boolean;
};

type Props = {
  open: boolean;
  busy?: boolean;
  payload: OrderStatusConfirmPayload | null;
  onClose: () => void;
  onConfirm: () => void;
};

export function OrderStatusConfirmDialog({
  open,
  busy = false,
  payload,
  onClose,
  onConfirm,
}: Props) {
  if (!open || !payload) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-status-confirm-title"
        className="w-full max-w-md rounded-xl border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="order-status-confirm-title" className="font-semibold text-lg">
              {payload.actionLabel}?
            </h2>
            <p className="mt-2 text-muted-foreground text-sm">
              Order{" "}
              <span className="font-medium text-foreground">{payload.orderRef}</span> will
              change from{" "}
              <span className="font-medium text-foreground">{payload.currentStatusLabel}</span>{" "}
              to{" "}
              <span className="font-medium text-foreground">{payload.nextStatusLabel}</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border p-2 disabled:opacity-50"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-md border px-3 text-sm disabled:opacity-50"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm disabled:opacity-50 ${
              payload.destructive
                ? "border border-destructive/40 bg-destructive/10 text-destructive"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
