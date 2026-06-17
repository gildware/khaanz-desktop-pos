import { orderLinePayloadsToReceiptLines } from "./pos-print";
import { isOrderEndState, normalizeFulfillment } from "./order-status";
import type {
  CartAddonWithQty,
  CartComboLine,
  CartItemLine,
  CartLine,
  CartOpenLine,
  FulfillmentMode,
  MenuVariation,
  RecentOrderRow,
} from "../types";

export type EditingOrder = {
  id: string;
  orderRef: string;
  source: string;
  dineInTable?: string;
};

export function canEditOrder(order: RecentOrderRow): boolean {
  if (isOrderEndState(order.status)) return false;
  if (order.source === "desktop_local") return false;
  return orderLinePayloadsToReceiptLines(order.lines ?? []).length > 0;
}

function centsFromUnitPrice(unitPrice: unknown): number {
  const unit = typeof unitPrice === "number" && Number.isFinite(unitPrice) ? unitPrice : 0;
  return Math.round(unit * 100);
}

function qtyFromPayload(quantity: unknown): number {
  return typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0
    ? Math.floor(quantity)
    : 1;
}

function lineIdFromPayload(p: Record<string, unknown>, fallback: string): string {
  return typeof p.lineId === "string" && p.lineId.trim() ? p.lineId.trim() : fallback;
}

function orderLinePayloadToCartLine(payload: unknown, index: number): CartLine | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const qty = qtyFromPayload(p.quantity);
  const unitPriceCents = centsFromUnitPrice(p.unitPrice);
  const lineId = lineIdFromPayload(p, `edit-${index}`);

  if (p.kind === "open") {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return null;
    const line: CartOpenLine = {
      kind: "open",
      lineId,
      name,
      qty,
      unitPriceCents,
      taxRateBps: 0,
    };
    return line;
  }

  if (p.kind === "combo") {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return null;
    const line: CartComboLine = {
      kind: "combo",
      lineId,
      comboId: typeof p.comboId === "string" ? p.comboId : lineId,
      name,
      image: typeof p.image === "string" ? p.image : "",
      isVeg: p.isVeg !== false,
      qty,
      unitPriceCents,
      taxRateBps: 0,
      componentSummary:
        typeof p.componentSummary === "string" ? p.componentSummary : "",
    };
    return line;
  }

  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return null;

  const variationRaw = p.variation as Record<string, unknown> | undefined;
  const variation: MenuVariation = {
    id:
      variationRaw && typeof variationRaw.id === "string"
        ? variationRaw.id
        : "default",
    name:
      variationRaw && typeof variationRaw.name === "string"
        ? variationRaw.name
        : "Regular",
    price:
      variationRaw && typeof variationRaw.price === "number"
        ? variationRaw.price
        : unitPriceCents / 100,
  };

  const addons: CartAddonWithQty[] = Array.isArray(p.addons)
    ? (p.addons as Record<string, unknown>[])
        .filter((a) => typeof a.quantity === "number" && (a.quantity as number) > 0)
        .map((a) => ({
          id: typeof a.id === "string" ? a.id : `addon-${String(a.name)}`,
          name: String(a.name || "Addon"),
          price: typeof a.price === "number" ? a.price : 0,
          image: typeof a.image === "string" ? a.image : "",
          quantity: Math.floor(a.quantity as number),
        }))
    : [];

  const line: CartItemLine = {
    kind: "item",
    lineId,
    itemId: typeof p.itemId === "string" ? p.itemId : lineId,
    name,
    image: typeof p.image === "string" ? p.image : "",
    variation,
    addons,
    qty,
    unitPriceCents,
    taxRateBps: 0,
  };
  return line;
}

export function orderLinesToCart(
  lines: Array<{ sortIndex: number; payload: unknown }>,
): CartLine[] {
  const sorted = [...lines].sort((a, b) => a.sortIndex - b.sortIndex);
  const cart: CartLine[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const line = orderLinePayloadToCartLine(sorted[i].payload, i);
    if (line) cart.push(line);
  }
  return cart;
}

export function fulfillmentModeFromOrder(order: RecentOrderRow): FulfillmentMode {
  const key = normalizeFulfillment(order.fulfillment);
  if (key === "dine_in" || key === "delivery") return key;
  return "pickup";
}

export function minorToRupeeInput(minor?: number): string {
  if (typeof minor !== "number" || !Number.isFinite(minor) || minor <= 0) return "";
  return (minor / 100).toFixed(2).replace(/\.?0+$/, "");
}
