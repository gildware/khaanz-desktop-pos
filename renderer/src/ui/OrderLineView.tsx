import React from "react";

const orderLineBoxClass =
  "rounded-lg border border-border/70 bg-muted/20 p-2 text-xs shadow-sm";

export function OrderLineView({ payload, compact }: { payload: unknown; compact?: boolean }) {
  const boxClass = compact
    ? "rounded-md border border-border/60 bg-muted/15 p-1.5 text-[11px] leading-snug"
    : orderLineBoxClass;
  if (!payload || typeof payload !== "object") {
    return (
      <div className={boxClass}>
        <pre className="max-h-40 overflow-auto text-xs">{JSON.stringify(payload, null, 2)}</pre>
      </div>
    );
  }
  const p = payload as Record<string, unknown>;
  const qty =
    typeof p.quantity === "number" && Number.isFinite(p.quantity) ? p.quantity : 1;
  const unit =
    typeof p.unitPrice === "number" && Number.isFinite(p.unitPrice) ? p.unitPrice : 0;
  const lineTotal = (unit * qty).toFixed(2);

  if (p.kind === "combo") {
    return (
      <div className={boxClass}>
        <div className="flex justify-between gap-2">
          <span className="font-medium">{String(p.name)}</span>
          <span className="shrink-0 tabular-nums">₹{lineTotal}</span>
        </div>
        <div className="text-muted-foreground text-xs">Combo × {qty}</div>
        {typeof p.componentSummary === "string" && p.componentSummary ? (
          <div className="mt-1.5 text-muted-foreground text-xs leading-snug">
            {p.componentSummary}
          </div>
        ) : null}
      </div>
    );
  }

  if (p.kind === "open") {
    return (
      <div className={boxClass}>
        <div className="flex justify-between gap-2">
          <span className="font-medium">{String(p.name)}</span>
          <span className="shrink-0 tabular-nums">₹{lineTotal}</span>
        </div>
        <div className="text-muted-foreground text-xs">Open item × {qty}</div>
      </div>
    );
  }

  const v = p.variation as Record<string, unknown> | undefined;
  const addons = Array.isArray(p.addons) ? p.addons : [];
  return (
    <div className={boxClass}>
      <div className="flex justify-between gap-2">
        <span className="font-medium">{String(p.name)}</span>
        <span className="shrink-0 tabular-nums">₹{lineTotal}</span>
      </div>
      <div className="text-muted-foreground text-xs">
        × {qty}
        {v && typeof v.name === "string" ? ` · ${v.name}` : ""}
      </div>
      {addons.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted-foreground text-xs">
          {(addons as Record<string, unknown>[]).map((a, i) => (
            <li key={i}>
              {String(a.name)}
              {typeof a.quantity === "number" && a.quantity > 0 ? ` ×${a.quantity}` : ""}
              {typeof a.price === "number" && a.price > 0
                ? ` (+₹${a.price.toFixed(2)} each)`
                : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
