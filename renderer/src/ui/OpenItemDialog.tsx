import React from "react";
import { XIcon } from "lucide-react";

type Props = {
  open: boolean;
  name: string;
  price: string;
  onNameChange: (value: string) => void;
  onPriceChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function OpenItemDialog({
  open,
  name,
  price,
  onNameChange,
  onPriceChange,
  onConfirm,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background p-5 shadow-lg"
        role="dialog"
        aria-labelledby="open-item-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="open-item-title" className="font-semibold text-lg">
              Open item
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Not on the menu — billed as a custom line on the order.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <XIcon className="size-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="open-item-name" className="font-medium text-xs">
              Item name
            </label>
            <input
              id="open-item-name"
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="e.g. Extra roti, Corkage"
              autoComplete="off"
              autoFocus
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="open-item-price" className="font-medium text-xs">
              Price (₹)
            </label>
            <input
              id="open-item-price"
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => onPriceChange(e.target.value)}
              placeholder="0"
              autoComplete="off"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-10 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm"
          >
            Add to order
          </button>
        </div>
      </div>
    </div>
  );
}
