import type { CartAddonWithQty, MenuVariation } from "../types";

export function buildComboLineId(comboId: string): string {
  return `combo::${comboId}`;
}

export function buildLineId(
  itemId: string,
  variation: MenuVariation,
  addons: CartAddonWithQty[],
): string {
  const addonKey = [...addons]
    .filter((a) => a.quantity > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => `${a.id}:${a.quantity}`)
    .join(",");
  return `${itemId}::${variation.id}::${addonKey}`;
}

export function computeUnitPrice(
  variation: MenuVariation,
  addons: CartAddonWithQty[],
): number {
  return (
    variation.price +
    addons
      .filter((a) => a.quantity > 0)
      .reduce((s, a) => s + a.price * a.quantity, 0)
  );
}

export function rupeesToCents(rupees: number) {
  return Math.round(Number(rupees || 0) * 100);
}
