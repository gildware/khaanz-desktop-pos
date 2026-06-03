import type { MenuCombo, MenuItem } from "../types";

function componentQty(c: { quantity?: number }): number {
  const q = c.quantity;
  if (typeof q === "number" && Number.isFinite(q) && q >= 1) {
    return Math.min(999, Math.floor(q));
  }
  return 1;
}

export function isComboAvailable(combo: MenuCombo, items: MenuItem[]): boolean {
  if (combo.available === false) return false;
  if (!combo.components.length) return false;
  for (const c of combo.components) {
    const item = items.find((i) => i.id === c.itemId);
    if (!item || item.available === false) return false;
    if (!item.variations.some((v) => v.id === c.variationId)) return false;
  }
  return true;
}

export function formatComboComponentSummary(
  combo: MenuCombo,
  items: MenuItem[],
): string {
  const parts: string[] = [];
  for (const c of combo.components) {
    const item = items.find((i) => i.id === c.itemId);
    const v = item?.variations.find((x) => x.id === c.variationId);
    if (item && v) {
      const q = componentQty(c);
      parts.push(
        q > 1 ? `${q}× ${item.name} (${v.name})` : `${item.name} (${v.name})`,
      );
    }
  }
  return parts.join(" + ");
}
