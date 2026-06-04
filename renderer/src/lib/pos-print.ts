import type { BillPrintLayout } from "./bill-preview-settings";
import type { CartComboLine, CartItemLine, CartLine } from "../types";

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

function isCartComboLine(line: CartLine): line is CartComboLine {
  return line.kind === "combo";
}

export function cartLinesToReceiptRows(lines: CartLine[]): PosReceiptLine[] {
  return lines.map((line) => {
    if (isCartComboLine(line)) {
      const unit = line.unitPriceCents / 100;
      const subtotal = unit * line.qty;
      const detail = line.componentSummary.trim()
        ? ` — ${line.componentSummary}`
        : "";
      return {
        label: `${line.name} (Combo)${detail}`,
        qty: line.qty,
        unit,
        subtotal,
      };
    }
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

/** Scoped to `.thermal-receipt-root` so receipt CSS never affects the POS app shell. */
function buildThermalStyle(layout?: BillPrintLayout): string {
  const family = layout?.fontFamilyCss ?? 'Arial, Helvetica, "Liberation Sans", sans-serif';
  const weight = layout?.fontWeightCss ?? "700";
  const weightNum = layout?.fontWeightNum ?? 700;
  const logoW = layout?.logoMaxWidthMm ?? 72;
  const logoH = layout?.logoMaxHeightMm ?? 45;
  const shopSize = layout?.shopNameSizePx ?? 15;
  const grandSize = layout?.grandTotalSizePx ?? 18;
  const bodySize = layout?.bodySizePx ?? 12;
  const lineHeight = layout?.lineHeight ?? 1.4;
  const pad = layout?.receiptPaddingPx ?? 8;
  const align = layout?.headerAlign ?? "center";
  const r = ".thermal-receipt-root";
  return `
  @page { size: 80mm auto; margin: 3mm; }
  html { color-scheme: light only; }
  body.thermal-print-body { margin: 0; padding: 0; background: #fff; }
  ${r} {
    box-sizing: border-box;
    font-family: ${family};
    font-size: ${bodySize}px;
    font-weight: ${weight};
    line-height: ${lineHeight};
    margin: 0;
    padding: ${pad}px;
    max-width: 72mm;
    background: #fff;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  ${r} * {
    box-sizing: border-box;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  ${r} .bill-receipt { width: 100%; }
  ${r} .logo-wrap { text-align: center; margin: 0 auto 4px; width: 100%; }
  ${r} .logo-wrap img.logo {
    display: block;
    margin-left: auto;
    margin-right: auto;
    max-width: ${logoW}mm;
    max-height: ${logoH}mm;
    width: auto;
    height: auto;
    object-fit: contain;
    object-position: center center;
    filter: grayscale(100%) contrast(1.12);
  }
  ${r} img { filter: grayscale(100%) contrast(1.08); }
  ${r} h1.shop-name { font-size: ${shopSize}px; margin: 0 0 4px; font-weight: ${weightNum + 100}; text-align: ${align}; }
  ${r} .rest-address { text-align: ${align}; font-size: 10px; margin: 0 0 4px; line-height: 1.35; white-space: pre-wrap; }
  ${r} .contact { text-align: ${align}; font-size: 11px; margin: 0 0 6px; line-height: 1.35; }
  ${r} .rule { border: none; border-top: 1px solid #000; margin: 6px 0; }
  ${r} .rule.rule-double { border-top: 3px double #000; }
  ${r} .rule.rule-dashed { border-top: 1px dashed #000; }
  ${r} .cust { font-size: 11px; margin: 2px 0; }
  ${r} .meta-row { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-size: 11px; margin: 2px 0; }
  ${r} .meta-row .fulfill { font-weight: ${weightNum + 100}; font-size: 12px; }
  ${r} .time-line { font-size: 11px; margin: 0 0 4px; }
  ${r} .pre { white-space: pre-wrap; font-size: 11px; margin: 4px 0; text-align: center; }
  ${r} .muted { font-size: 11px; margin: 3px 0; }
  ${r} table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  ${r} th, ${r} td { padding: 2px 0; text-align: left; vertical-align: top; font-size: 11px; }
  ${r} th { border-bottom: 1px solid #000; font-weight: ${weightNum}; }
  ${r} .right { text-align: right; white-space: nowrap; }
  ${r} .totals-row { display: flex; justify-content: space-between; font-size: 11px; margin: 4px 0; }
  ${r} .grand-total { display: flex; justify-content: space-between; align-items: baseline; font-size: ${grandSize}px; font-weight: ${weightNum + 100}; margin: 8px 0 4px; }
  ${r} .payment-status { font-size: 11px; margin: 4px 0; }
  ${r} tr.addon-line td { font-size: 10px; line-height: 1.3; }
  ${r} tr.addon-line .iname { padding-left: 8px; }
  ${r} h1 { font-size: 16px; margin: 0 0 8px; text-align: center; }
  ${r} .sep { border-top: 2px solid #000; margin: 8px 0; padding-top: 6px; }
  ${r} .total { font-size: 14px; font-weight: ${weightNum + 100}; }
`;
}

function ordinalDay(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** e.g. 3rd June 2026 11:20 pm */
export function formatBillDateTime(d: Date): string {
  const day = ordinalDay(d.getDate());
  const month = d.toLocaleString("en-GB", { month: "long" });
  const year = d.getFullYear();
  const time = d
    .toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true })
    .toLowerCase()
    .replace(/\s/g, " ");
  return `${day} ${month} ${year} ${time}`;
}

/** Fixed sample timestamp for Settings bill previews. */
export const BILL_PREVIEW_SAMPLE_AT = new Date(2026, 5, 3, 23, 20);

function extractBillNumber(orderRef: string | null): string {
  if (!orderRef) return "—";
  const m = orderRef.match(/(\d+)\s*$/);
  return m ? m[1]! : orderRef;
}

function formatOrderIdForBill(orderRef: string | null, layout?: BillPrintLayout): string {
  if (!orderRef) return "—";
  if (layout?.orderIdFormat === "full") return orderRef;
  return extractBillNumber(orderRef);
}

function thermalRuleClass(layout?: BillPrintLayout): string {
  const style = layout?.ruleStyle ?? "single";
  if (style === "double") return "rule rule-double";
  if (style === "dashed") return "rule rule-dashed";
  return "rule";
}

function parseCustomerAddress(footerNote?: string, notes?: string): string {
  const fromFooter = (footerNote ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^address:\s*/i.test(l));
  if (fromFooter) return fromFooter.replace(/^address:\s*/i, "").trim();
  return "";
}

function customerMobileForBill(phoneDigits: string): string {
  if (!phoneDigits || phoneDigits === "0000000000" || phoneDigits === "6000000000") return "";
  const d = phoneDigits.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

export function wrapThermalPrintDocument(
  bodyHtml: string,
  title: string,
  layout?: BillPrintLayout,
): string {
  const safeTitle = escapeHtml(title || "Receipt");
  const inner = bodyHtml.replace(/<style>[\s\S]*?<\/style>/gi, "").trim();
  const body = inner.includes("thermal-receipt-root")
    ? inner
    : `<div class="thermal-receipt-root">${inner}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="color-scheme" content="light only"/><title>${safeTitle}</title><style>${buildThermalStyle(layout)}</style></head><body class="thermal-print-body">${body}</body></html>`;
}

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
  customerAddress?: string;
  paymentLabel: string;
  lines: PosReceiptLine[];
  total: number;
  /** Item subtotal before delivery/discount (rupees). */
  itemsSubtotal?: number;
  /** Delivery charge in rupees. */
  deliveryCharge?: number;
  /** Discount in rupees. */
  discount?: number;
  /** Override print timestamp (Settings preview). */
  printedAt?: Date;
  layout?: BillPrintLayout;
};

export type PosKotPrintOptions = {
  restaurantName: string;
  billHeader: string;
  orderRef: string;
  fulfillmentLabel: string;
  dineInTable?: string;
  notes: string;
  lines: { label: string; qty: number; addonRows?: PosReceiptAddonRow[] }[];
  layout?: BillPrintLayout;
};

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
}

/** 80mm thermal — ~42 chars (BillQuick Lite / POS 203DPI on Windows). */
const PLAIN_WIDTH = 42;

function centerPlain(text: string, width = PLAIN_WIDTH): string {
  const t = text.trim();
  if (t.length >= width) return t.slice(0, width);
  const pad = Math.floor((width - t.length) / 2);
  return `${" ".repeat(pad)}${t}`;
}

function padPlain(left: string, right: string, width = PLAIN_WIDTH): string {
  const r = right.trim();
  const maxLeft = Math.max(1, width - r.length - 1);
  const l = left.trim().slice(0, maxLeft);
  return `${l}${" ".repeat(Math.max(1, width - l.length - r.length))}${r}`;
}

function plainRule(width = PLAIN_WIDTH): string {
  return "-".repeat(width);
}

function plainRuleForLayout(layout?: BillPrintLayout, width = PLAIN_WIDTH): string {
  const style = layout?.ruleStyle ?? "single";
  if (style === "double") return "=".repeat(width);
  if (style === "dashed") return "- - ".repeat(Math.ceil(width / 3)).slice(0, width);
  return plainRule(width);
}

export function usePlainTextReceipt(platform?: string): boolean {
  return platform === "win32";
}

/** Bills with a logo must use HTML print so the slip matches Settings preview. */
export function billReceiptNeedsHtmlPrint(layout?: BillPrintLayout): boolean {
  if (layout?.showLogo === false) return false;
  return Boolean(layout?.logoSrc?.trim());
}

export function wrapPlainTextPrintDocument(text: string, title: string): string {
  const safeTitle = escapeHtml(title || "Receipt");
  const body = escapeHtml(text);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="color-scheme" content="light only"/><title>${safeTitle}</title><style>
  html, body { margin: 0; padding: 2mm; background: #fff !important; color: #000 !important; color-scheme: light only; }
  pre { margin: 0; font-family: "Courier New", Courier, monospace; font-size: 12px; font-weight: 700; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
</style></head><body><pre>${body}</pre></body></html>`;
}

function billDisplayName(o: PosBillPrintOptions): string {
  return o.layout?.restaurantDisplayName?.trim() || o.restaurantName.trim() || "Khaanz";
}

export function buildBillPlainText(o: PosBillPrintOptions): string {
  const lines: string[] = [];
  const now = o.printedAt ?? new Date();
  const layout = o.layout;
  const restPhone = layout?.restaurantPhone?.trim() ?? "";
  const rule = () => plainRuleForLayout(layout);

  if (layout?.showRestaurantName !== false) {
    lines.push(centerPlain(billDisplayName(o)));
  }
  const restAddr = layout?.restaurantAddress?.trim() ?? "";
  if (layout?.showAddress !== false && restAddr) {
    for (const line of splitLines(restAddr)) {
      lines.push(
        (layout?.headerAlign === "left" ? line : centerPlain(line)).slice(0, PLAIN_WIDTH),
      );
    }
  }
  if (layout?.showPhone !== false && restPhone) {
    lines.push(
      (layout?.headerAlign === "left"
        ? `${layout?.contactLabel ?? "Tel:"} ${restPhone}`
        : centerPlain(`${layout?.contactLabel ?? "Tel:"} ${restPhone}`)
      ).slice(0, PLAIN_WIDTH),
    );
  }
  for (const h of splitLines(o.billHeader)) lines.push(centerPlain(h));
  lines.push(rule());

  const mobile = customerMobileForBill(o.phoneDigits);
  const nameLine = mobile
    ? `Name: (M: ${mobile})`
    : `Name: ${o.customerName}`;
  lines.push(nameLine.slice(0, PLAIN_WIDTH));
  const addr =
    (o.customerAddress ?? "").trim() || parseCustomerAddress(o.footerNote, o.notes);
  if (addr) lines.push(`Adr: ${addr}`.slice(0, PLAIN_WIDTH));
  if (o.dineInTable?.trim()) lines.push(`Table: ${o.dineInTable.trim()}`.slice(0, PLAIN_WIDTH));
  lines.push(rule());

  const orderId = formatOrderIdForBill(o.orderRef, layout);
  if (layout?.showOrderId !== false) {
    lines.push(
      padPlain(
        o.fulfillmentLabel,
        `${layout?.orderIdLabel ?? "Bill No."}: ${orderId}`,
      ),
    );
  } else {
    lines.push(o.fulfillmentLabel.slice(0, PLAIN_WIDTH));
  }
  lines.push(formatBillDateTime(now).slice(0, PLAIN_WIDTH));
  if (o.proforma) lines.push("PROFORMA".slice(0, PLAIN_WIDTH));
  lines.push(rule());

  lines.push(padPlain("Item", "Qty. Price Amt"));
  for (const r of o.lines) {
    lines.push(r.label.slice(0, PLAIN_WIDTH));
    lines.push(
      padPlain(
        "",
        `${r.qty}  ${r.unit.toFixed(2)}  ${r.subtotal.toFixed(2)}`,
      ),
    );
    for (const a of r.addonRows ?? []) {
      lines.push(`+ ${a.name}`.slice(0, PLAIN_WIDTH));
      lines.push(
        padPlain("", `${a.qty}  ${a.unit.toFixed(2)}  ${a.subtotal.toFixed(2)}`),
      );
    }
  }
  lines.push(rule());

  const totalQty = o.lines.reduce((s, r) => s + r.qty, 0);
  const itemsSub = o.itemsSubtotal ?? o.lines.reduce((s, r) => s + r.subtotal, 0);
  lines.push(padPlain(`Total Qty: ${totalQty}`, `Sub Total ${itemsSub.toFixed(2)}`));
  if (o.deliveryCharge && o.deliveryCharge > 0) {
    lines.push(padPlain("Delivery", o.deliveryCharge.toFixed(2)));
  }
  if (o.discount && o.discount > 0) {
    lines.push(padPlain("Discount", `-${o.discount.toFixed(2)}`));
  }
  lines.push(rule());
  lines.push(padPlain("Grand Total", `₹${o.total.toFixed(2)}`));
  const payStatus = o.paymentLabel?.trim()
    ? o.paymentLabel.trim()
    : (layout?.unpaidLabel ?? "Not Paid");
  lines.push(payStatus.slice(0, PLAIN_WIDTH));
  if (layout?.showFooterNotes !== false) {
    for (const f of splitLines(layout?.footerNotes ?? "")) lines.push(f.slice(0, PLAIN_WIDTH));
  }
  if (o.notes.trim()) lines.push(`Note: ${o.notes.trim()}`.slice(0, PLAIN_WIDTH));
  lines.push("");
  return lines.join("\n");
}

export function buildKotPlainText(o: PosKotPrintOptions): string {
  const lines: string[] = [];
  lines.push(centerPlain("KITCHEN ORDER"));
  lines.push(centerPlain(o.restaurantName));
  for (const h of splitLines(o.billHeader)) lines.push(centerPlain(h));
  lines.push(plainRule());
  lines.push(o.orderRef.slice(0, PLAIN_WIDTH));
  lines.push(o.fulfillmentLabel.slice(0, PLAIN_WIDTH));
  if (o.dineInTable?.trim()) lines.push(`Table: ${o.dineInTable.trim()}`.slice(0, PLAIN_WIDTH));
  lines.push(formatBillDateTime(new Date()).slice(0, PLAIN_WIDTH));
  if (o.notes.trim()) lines.push(`Note: ${o.notes.trim()}`.slice(0, PLAIN_WIDTH));
  lines.push(plainRule());
  lines.push(padPlain("Item", "Qty"));
  for (const r of o.lines) {
    lines.push(padPlain(r.label, String(r.qty)));
    for (const a of r.addonRows ?? []) {
      lines.push(padPlain(`+ ${a.name}`, String(a.qty)));
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function buildBillHtmlBody(o: PosBillPrintOptions): string {
  const layout = o.layout;
  const style = buildThermalStyle(layout);
  const headerLines = splitLines(o.billHeader);
  const now = o.printedAt ?? new Date();
  const rows = o.lines
    .flatMap((r) => {
      const main = `<tr><td>${escapeHtml(r.label)}</td><td class="right">${r.qty}</td><td class="right">${r.unit.toFixed(
        2,
      )}</td><td class="right">${r.subtotal.toFixed(2)}</td></tr>`;
      const subs = (r.addonRows ?? []).map(
        (a) =>
          `<tr class="addon-line"><td class="iname">+ ${escapeHtml(a.name)}</td><td class="right">${a.qty}</td><td class="right">${a.unit.toFixed(
            2,
          )}</td><td class="right">${a.subtotal.toFixed(2)}</td></tr>`,
      );
      return [main, ...subs];
    })
    .join("");

  const mobile = customerMobileForBill(o.phoneDigits);
  const nameLine = mobile
    ? `Name: (M: ${mobile})`
    : `Name: ${o.customerName}`;
  const addr =
    (o.customerAddress ?? "").trim() || parseCustomerAddress(o.footerNote, o.notes);
  const addrLine = addr ? `<div class="cust">Adr: ${escapeHtml(addr)}</div>` : "";
  const tableLine = o.dineInTable?.trim()
    ? `<div class="cust">Table: ${escapeHtml(o.dineInTable.trim())}</div>`
    : "";

  const headerHtml = headerLines.map((l) => `<div class="pre">${escapeHtml(l)}</div>`).join("");
  const customFooterHtml =
    layout?.showFooterNotes !== false
      ? splitLines(layout?.footerNotes ?? "")
          .map((l) => `<div class="pre">${escapeHtml(l)}</div>`)
          .join("")
      : "";

  const logoSrc = layout?.logoSrc?.trim() ?? "";
  const logoHtml =
    layout?.showLogo !== false && logoSrc
      ? `<div class="logo-wrap"><img class="logo" src="${escapeHtml(logoSrc)}" alt="" /></div>`
      : "";

  const restPhone = layout?.restaurantPhone?.trim() ?? "";
  const restAddr = layout?.restaurantAddress?.trim() ?? "";
  const addressHtml =
    layout?.showAddress !== false && restAddr
      ? `<div class="rest-address">${escapeHtml(restAddr)}</div>`
      : "";
  const contactHtml =
    layout?.showPhone !== false && restPhone
      ? `<div class="contact">${escapeHtml(layout?.contactLabel ?? "Tel:")} ${escapeHtml(restPhone)}</div>`
      : "";
  const nameHtml =
    layout?.showRestaurantName !== false
      ? `<h1 class="shop-name">${escapeHtml(billDisplayName(o))}</h1>`
      : "";

  const itemsSub = o.itemsSubtotal ?? o.lines.reduce((s, r) => s + r.subtotal, 0);
  const totalQty = o.lines.reduce((s, r) => s + r.qty, 0);
  const extraTotals: string[] = [];
  if (o.deliveryCharge && o.deliveryCharge > 0) {
    extraTotals.push(
      `<div class="totals-row"><span>Delivery</span><span>${o.deliveryCharge.toFixed(2)}</span></div>`,
    );
  }
  if (o.discount && o.discount > 0) {
    extraTotals.push(
      `<div class="totals-row"><span>Discount</span><span>-${o.discount.toFixed(2)}</span></div>`,
    );
  }

  const payStatus = o.paymentLabel?.trim()
    ? o.paymentLabel.trim()
    : (layout?.unpaidLabel ?? "Not Paid");
  const orderId = formatOrderIdForBill(o.orderRef, layout);
  const proformaLine = o.proforma ? `<div class="cust">PROFORMA</div>` : "";
  const rule = thermalRuleClass(layout);
  const themeClass = layout?.themeClass ?? "bill-theme-classic";
  const metaOrderHtml =
    layout?.showOrderId !== false
      ? `<div class="meta-row"><span class="fulfill">${escapeHtml(o.fulfillmentLabel)}</span><span>${escapeHtml(layout?.orderIdLabel ?? "Bill No.")}: ${escapeHtml(orderId)}</span></div>`
      : `<div class="meta-row"><span class="fulfill">${escapeHtml(o.fulfillmentLabel)}</span></div>`;

  return `
<style>${style}</style>
<div class="bill-receipt ${themeClass}">
${logoHtml}
${nameHtml}
${addressHtml}
${contactHtml}
${headerHtml}
<hr class="${rule}"/>
<div class="cust">${escapeHtml(nameLine)}</div>
${addrLine}
${tableLine}
<hr class="${rule}"/>
${metaOrderHtml}
<div class="time-line">${escapeHtml(formatBillDateTime(now))}</div>
${proformaLine}
<hr class="${rule}"/>
<table>
<thead><tr><th>Item</th><th class="right">Qty.</th><th class="right">Price</th><th class="right">Amount</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<hr class="${rule}"/>
<div class="totals-row"><span>Total Qty: ${totalQty}</span><span>Sub Total ${itemsSub.toFixed(2)}</span></div>
${extraTotals.join("")}
<hr class="${rule}"/>
<div class="grand-total"><span>Grand Total</span><span>₹${o.total.toFixed(2)}</span></div>
<div class="payment-status">${escapeHtml(payStatus)}</div>
${customFooterHtml}
${o.notes.trim() ? `<div class="muted">Note: ${escapeHtml(o.notes.trim())}</div>` : ""}
</div>
`;
}

export function buildKotHtmlBody(o: PosKotPrintOptions): string {
  const style = buildThermalStyle(o.layout);
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
<style>${style}</style>
<h1>KITCHEN ORDER</h1>
<div class="muted">${escapeHtml(o.restaurantName)}</div>
${headerHtml}
<div class="sep"></div>
<div class="total">${escapeHtml(o.orderRef)}</div>
<div class="muted">${escapeHtml(o.fulfillmentLabel)}</div>
${o.dineInTable?.trim() ? `<div class="muted">Table: ${escapeHtml(o.dineInTable.trim())}</div>` : ""}
<div class="muted">${escapeHtml(formatBillDateTime(new Date()))}</div>
${o.notes.trim() ? `<div class="muted">Note: ${escapeHtml(o.notes.trim())}</div>` : ""}
<table>
<thead><tr><th>Item</th><th class="right">Qty</th></tr></thead>
<tbody>${rows}</tbody>
</table>
`;
}

type DesktopPrintBridge = {
  printSilentHtml: (html: string, title?: string) => Promise<{ ok: boolean; error?: string }>;
  printReceiptText?: (text: string, title?: string) => Promise<{ ok: boolean; error?: string }>;
  getPlatform?: () => Promise<string>;
};

async function sendReceiptToDesktop(
  desktop: DesktopPrintBridge,
  preferPlainText: boolean,
  plainText: string,
  htmlDoc: string,
  title: string,
): Promise<void> {
  if (preferPlainText && desktop.printReceiptText) {
    const r = await desktop.printReceiptText(plainText, title);
    if (r.ok) return;
    throw new Error(r.error || "Print failed");
  }
  if (!desktop.printSilentHtml) {
    throw new Error("Print failed");
  }
  const r = await desktop.printSilentHtml(htmlDoc, title);
  if (r.ok) return;
  throw new Error(r.error || "Print failed");
}

/** Full HTML document for Settings preview (iframe — styles must not leak into the app). */
export function buildBillPreviewDocument(options: PosBillPrintOptions): string {
  const body = buildBillHtmlBody(options).replace(/<style>[\s\S]*?<\/style>/gi, "");
  return wrapThermalPrintDocument(body, "Bill preview", options.layout);
}

export function buildKotPreviewDocument(options: PosKotPrintOptions): string {
  const body = buildKotHtmlBody(options).replace(/<style>[\s\S]*?<\/style>/gi, "");
  return wrapThermalPrintDocument(body, "KOT preview", options.layout);
}

/** Sample bill used in Settings → Bill preview. */
export type BillPreviewFulfillment = "dine_in" | "pickup" | "delivery";

const BILL_PREVIEW_SAMPLE_LINES: PosReceiptLine[] = [
  {
    label: "Veg. Chowmein (Half)",
    qty: 1,
    unit: 90,
    subtotal: 90,
  },
  {
    label: "Chicken Feast Pizza (Regular)",
    qty: 1,
    unit: 280,
    subtotal: 280,
  },
];

export function buildBillPreviewSampleOptions(
  restaurantName: string,
  layout: BillPrintLayout,
  fulfillment: BillPreviewFulfillment = "delivery",
): PosBillPrintOptions {
  const base = {
    restaurantName: layout.restaurantDisplayName.trim() || restaurantName.trim() || "Khaanz",
    billHeader: "",
    billFooter: "",
    orderRef: "ORD-3516",
    proforma: false,
    notes: "",
    paymentLabel: "",
    lines: BILL_PREVIEW_SAMPLE_LINES,
    total: 370,
    printedAt: BILL_PREVIEW_SAMPLE_AT,
    layout,
  };

  if (fulfillment === "dine_in") {
    return {
      ...base,
      fulfillmentLabel: "Dine-in",
      dineInTable: "T-5",
      customerName: "Guest",
      phoneDigits: "",
    };
  }

  if (fulfillment === "pickup") {
    return {
      ...base,
      fulfillmentLabel: "Pickup",
      customerName: "Guest",
      phoneDigits: "7889762589",
    };
  }

  return {
    ...base,
    fulfillmentLabel: "Delivery",
    customerName: "Guest",
    phoneDigits: "7889762589",
    customerAddress: "Near Mufti House",
  };
}

/** Sample KOT used in Settings → Bill preview. */
export function buildKotPreviewSampleOptions(
  restaurantName: string,
  layout: BillPrintLayout,
  fulfillment: BillPreviewFulfillment = "delivery",
): PosKotPrintOptions {
  const bill = buildBillPreviewSampleOptions(restaurantName, layout, fulfillment);
  return {
    restaurantName: bill.restaurantName,
    billHeader: bill.billHeader,
    orderRef: bill.orderRef ?? "3516",
    fulfillmentLabel: bill.fulfillmentLabel,
    dineInTable: bill.dineInTable,
    notes: "Sample kitchen note",
    lines: bill.lines.map((r) => ({
      label: r.label,
      qty: r.qty,
      addonRows: r.addonRows,
    })),
    layout,
  };
}

export async function printPosBillThermal(
  options: PosBillPrintOptions,
  desktop?: DesktopPrintBridge,
): Promise<void> {
  if (!options.lines.length) {
    throw new Error("Nothing to print — cart is empty.");
  }
  if (!desktop?.printSilentHtml && !desktop?.printReceiptText) return;

  const platform = desktop.getPlatform ? await desktop.getPlatform() : "";
  const plainText = buildBillPlainText(options);
  const htmlDoc = wrapThermalPrintDocument(buildBillHtmlBody(options), "Bill", options.layout);
  const preferPlainText =
    usePlainTextReceipt(platform) && !billReceiptNeedsHtmlPrint(options.layout);
  await sendReceiptToDesktop(
    desktop,
    preferPlainText,
    plainText,
    htmlDoc,
    "Bill",
  );
}

export async function printPosKotThermal(
  options: PosKotPrintOptions,
  desktop?: DesktopPrintBridge,
): Promise<void> {
  if (!options.lines.length) {
    throw new Error("Nothing to print — no KOT lines.");
  }
  if (!desktop?.printSilentHtml && !desktop?.printReceiptText) return;

  const platform = desktop.getPlatform ? await desktop.getPlatform() : "";
  const plainText = buildKotPlainText(options);
  const htmlDoc = wrapThermalPrintDocument(buildKotHtmlBody(options), "KOT", options.layout);
  const preferPlainText = usePlainTextReceipt(platform);
  await sendReceiptToDesktop(desktop, preferPlainText, plainText, htmlDoc, "KOT");
}
