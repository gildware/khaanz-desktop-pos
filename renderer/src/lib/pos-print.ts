import type { CartItemLine, CartLine } from "../types";

export type PosReceiptAddonRow = {
  name: string;
  qty: number;
  unit: number;
  subtotal: number;
};

export type PosReceiptLine = {
  label: string;
  qty: number;
  unit: number;
  subtotal: number;
  addonRows?: PosReceiptAddonRow[];
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fulfillmentLabelFromKey(fulfillment: string): string {
  if (fulfillment === "dine_in") return "Dine-in";
  if (fulfillment === "pickup") return "Pickup";
  if (fulfillment === "delivery") return "Delivery";
  return fulfillment;
}

export function cartLinesToReceiptRows(lines: CartLine[]): PosReceiptLine[] {
  return lines.map((line) => {
    if (line.kind === "open") {
      const unit = line.unitPriceCents / 100;
      const subtotal = unit * line.qty;
      return {
        label: `${line.name} (Open)`,
        qty: line.qty,
        unit,
        subtotal,
      };
    }
    const itemLine = line as CartItemLine;
    const unit = itemLine.unitPriceCents / 100;
    const subtotal = unit * itemLine.qty;
    const addonRows =
      itemLine.addons.length > 0
        ? itemLine.addons
            .filter((a) => a.quantity > 0)
            .map((a) => {
              const totalUnits = a.quantity * itemLine.qty;
              return {
                name: a.name,
                qty: totalUnits,
                unit: a.price,
                subtotal: a.price * a.quantity * itemLine.qty,
              };
            })
        : undefined;
    return {
      label: `${itemLine.name} (${itemLine.variation.name})`,
      qty: itemLine.qty,
      unit,
      subtotal,
      addonRows: addonRows && addonRows.length > 0 ? addonRows : undefined,
    };
  });
}

export function kotLinesFromCart(lines: CartLine[]) {
  return cartLinesToReceiptRows(lines).map((r) => ({
    label: r.label,
    qty: r.qty,
    addonRows: r.addonRows,
  }));
}

export function orderLinePayloadToPosReceiptLine(payload: unknown): PosReceiptLine | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const qty =
    typeof p.quantity === "number" && Number.isFinite(p.quantity) ? p.quantity : 1;
  const unit =
    typeof p.unitPrice === "number" && Number.isFinite(p.unitPrice) ? p.unitPrice : 0;
  const subtotal = unit * qty;

  if (p.kind === "combo") {
    const detail =
      typeof p.componentSummary === "string" && p.componentSummary.trim()
        ? ` — ${p.componentSummary}`
        : "";
    return {
      label: `${String(p.name)} (Combo)${detail}`,
      qty,
      unit,
      subtotal,
    };
  }

  if (p.kind === "open") {
    return { label: `${String(p.name)} (Open)`, qty, unit, subtotal };
  }

  const v = p.variation as Record<string, unknown> | undefined;
  const variationName =
    v && typeof v.name === "string" && v.name.trim() ? v.name : "Default";
  const addons = Array.isArray(p.addons) ? p.addons : [];
  const addonRows =
    addons.length > 0
      ? (addons as Record<string, unknown>[])
          .filter((a) => typeof a.quantity === "number" && (a.quantity as number) > 0)
          .map((a) => {
            const aq = a.quantity as number;
            const price = typeof a.price === "number" ? a.price : 0;
            return {
              name: String(a.name),
              qty: aq * qty,
              unit: price,
              subtotal: price * aq * qty,
            };
          })
      : undefined;

  return {
    label: `${String(p.name)} (${variationName})`,
    qty,
    unit,
    subtotal,
    addonRows: addonRows && addonRows.length > 0 ? addonRows : undefined,
  };
}

export function orderLinePayloadsToReceiptLines(lines: { payload: unknown }[]): PosReceiptLine[] {
  const out: PosReceiptLine[] = [];
  for (const l of lines) {
    const r = orderLinePayloadToPosReceiptLine(l.payload);
    if (r) out.push(r);
  }
  return out;
}

export function receiptLineToKotLine(r: PosReceiptLine) {
  return { label: r.label, qty: r.qty, addonRows: r.addonRows };
}

const THERMAL_STYLE = `
  @page { size: 80mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
    font-size: 11px;
    line-height: 1.35;
    color: #000;
    margin: 0;
    padding: 8px;
    max-width: 80mm;
  }
  h1 { font-size: 14px; margin: 0 0 6px; font-weight: 700; text-align: center; }
  .pre { white-space: pre-wrap; font-size: 10px; margin: 4px 0; color: #222; }
  .muted { color: #333; font-size: 10px; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  th, td { padding: 2px 0; text-align: left; vertical-align: top; font-size: 10px; }
  th { border-bottom: 1px solid #000; }
  .right { text-align: right; white-space: nowrap; }
  .sep { border-top: 1px dashed #000; margin: 8px 0; padding-top: 6px; }
  .total { font-weight: 700; font-size: 12px; }
  tr.addon-line td { font-size: 9px; line-height: 1.2; color: #333; }
  tr.addon-line .iname { padding-left: 6px; }
`;

export type PosBillPrintOptions = {
  restaurantName: string;
  billHeader: string;
  billFooter: string;
  orderRef: string | null;
  proforma: boolean;
  fulfillmentLabel: string;
  dineInTable?: string;
  customerName: string;
  phoneDigits: string;
  notes: string;
  footerNote?: string;
  paymentLabel: string;
  lines: PosReceiptLine[];
  total: number;
  /** Item subtotal before delivery/discount (rupees). */
  itemsSubtotal?: number;
  /** Delivery charge in rupees. */
  deliveryCharge?: number;
  /** Discount in rupees. */
  discount?: number;
};

export type PosKotPrintOptions = {
  restaurantName: string;
  billHeader: string;
  orderRef: string;
  fulfillmentLabel: string;
  dineInTable?: string;
  notes: string;
  lines: { label: string; qty: number; addonRows?: PosReceiptAddonRow[] }[];
};

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
}

export function buildBillHtmlBody(o: PosBillPrintOptions): string {
  const headerLines = splitLines(o.billHeader);
  const footerLines = splitLines(o.billFooter);
  const rows = o.lines
    .flatMap((r) => {
      const main = `<tr><td>${escapeHtml(r.label)}</td><td class="right">${r.qty}</td><td class="right">₹${Math.round(
        r.unit,
      )}</td><td class="right">₹${Math.round(r.subtotal)}</td></tr>`;
      const subs = (r.addonRows ?? []).map(
        (a) =>
          `<tr class="addon-line"><td class="iname">+ ${escapeHtml(a.name)}</td><td class="right">${a.qty}</td><td class="right">₹${Math.round(
            a.unit,
          )}</td><td class="right">₹${Math.round(a.subtotal)}</td></tr>`,
      );
      return [main, ...subs];
    })
    .join("");

  const headerLine = o.proforma
    ? `PROFORMA · ${o.fulfillmentLabel}`
    : `${o.orderRef ?? "Order"} · ${o.fulfillmentLabel}`;

  const tableLine = o.dineInTable?.trim()
    ? `<div class="muted">Table: ${escapeHtml(o.dineInTable.trim())}</div>`
    : "";

  const customerLine =
    !o.phoneDigits || o.phoneDigits === "0000000000"
      ? escapeHtml(o.customerName)
      : `${escapeHtml(o.customerName)} · +91 ${escapeHtml(o.phoneDigits)}`;

  const headerHtml = headerLines.map((l) => `<div class="pre">${escapeHtml(l)}</div>`).join("");
  const footerHtml = footerLines.map((l) => `<div class="pre">${escapeHtml(l)}</div>`).join("");

  return `
<style>${THERMAL_STYLE}</style>
<h1>${escapeHtml(o.restaurantName)}</h1>
${headerHtml}
<div class="muted">${escapeHtml(headerLine)}</div>
<div class="muted">${escapeHtml(new Date().toLocaleString("en-IN"))}</div>
${tableLine}
<div class="muted">${customerLine}</div>
${o.footerNote?.trim() ? `<div class="muted">${escapeHtml(o.footerNote.trim())}</div>` : ""}
${o.notes.trim() ? `<div class="muted">Note: ${escapeHtml(o.notes.trim())}</div>` : ""}
<table>
<thead><tr><th>Item</th><th class="right">Qty</th><th class="right">₹</th><th class="right">₹</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${(() => {
  const itemsSub =
    o.itemsSubtotal ??
    o.lines.reduce((s, r) => s + r.subtotal, 0);
  const parts: string[] = [];
  if (itemsSub > 0 && (o.deliveryCharge || o.discount)) {
    parts.push(`<div class="muted">Subtotal: ₹${Math.round(itemsSub)}</div>`);
  }
  if (o.deliveryCharge && o.deliveryCharge > 0) {
    parts.push(`<div class="muted">Delivery: ₹${Math.round(o.deliveryCharge)}</div>`);
  }
  if (o.discount && o.discount > 0) {
    parts.push(`<div class="muted">Discount: -₹${Math.round(o.discount)}</div>`);
  }
  return parts.join("");
})()}
<div class="sep total">Total: ₹${Math.round(o.total)}</div>
${o.paymentLabel ? `<div class="muted">Payment: ${escapeHtml(o.paymentLabel)}</div>` : ""}
${footerHtml}
<div class="muted" style="margin-top:8px;text-align:center">Thank you</div>
`;
}

export function buildKotHtmlBody(o: PosKotPrintOptions): string {
  const headerLines = splitLines(o.billHeader);
  const headerHtml = headerLines.map((l) => `<div class="pre">${escapeHtml(l)}</div>`).join("");
  const rows = o.lines
    .flatMap((r) => {
      const main = `<tr><td>${escapeHtml(r.label)}</td><td class="right">${r.qty}</td></tr>`;
      const subs = (r.addonRows ?? []).map(
        (a) =>
          `<tr class="addon-line"><td class="iname">+ ${escapeHtml(
            a.name,
          )}</td><td class="right">${a.qty}</td></tr>`,
      );
      return [main, ...subs];
    })
    .join("");
  return `
<style>${THERMAL_STYLE}</style>
<h1>KITCHEN ORDER</h1>
<div class="muted">${escapeHtml(o.restaurantName)}</div>
${headerHtml}
<div class="sep"></div>
<div class="total">${escapeHtml(o.orderRef)}</div>
<div class="muted">${escapeHtml(o.fulfillmentLabel)}</div>
${o.dineInTable?.trim() ? `<div class="muted">Table: ${escapeHtml(o.dineInTable.trim())}</div>` : ""}
<div class="muted">${escapeHtml(new Date().toLocaleString("en-IN"))}</div>
${o.notes.trim() ? `<div class="muted">Note: ${escapeHtml(o.notes.trim())}</div>` : ""}
<table>
<thead><tr><th>Item</th><th class="right">Qty</th></tr></thead>
<tbody>${rows}</tbody>
</table>
`;
}

export async function printPosBillThermal(
  options: PosBillPrintOptions,
  desktop?: { printSilentHtml: (html: string, title?: string) => Promise<{ ok: boolean; error?: string }> },
): Promise<void> {
  const html = buildBillHtmlBody(options);
  if (desktop?.printSilentHtml) {
    const r = await desktop.printSilentHtml(html, "Bill");
    if (r.ok) return;
    throw new Error(r.error || "Print failed");
  }
}

export async function printPosKotThermal(
  options: PosKotPrintOptions,
  desktop?: { printSilentHtml: (html: string, title?: string) => Promise<{ ok: boolean; error?: string }> },
): Promise<void> {
  const html = buildKotHtmlBody(options);
  if (desktop?.printSilentHtml) {
    const r = await desktop.printSilentHtml(html, "KOT");
    if (r.ok) return;
    throw new Error(r.error || "Print failed");
  }
}
