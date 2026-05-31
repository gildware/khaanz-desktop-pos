export function parseRupeeInputToCents(input: string): number {
  const s = input.trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export function computePosBillTotals(args: {
  subtotalCents: number;
  taxCents: number;
  deliveryChargeCents: number;
  discountCents: number;
}) {
  const itemsTotal = args.subtotalCents + args.taxCents;
  const delivery = Math.max(0, args.deliveryChargeCents);
  const beforeDiscount = itemsTotal + delivery;
  const discountApplied = Math.min(Math.max(0, args.discountCents), beforeDiscount);
  const total = beforeDiscount - discountApplied;
  return {
    itemsTotal,
    deliveryChargeCents: delivery,
    discountCents: discountApplied,
    total,
  };
}
