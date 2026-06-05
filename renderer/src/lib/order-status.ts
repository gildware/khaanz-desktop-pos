export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  CREATED: "Created",
};

/** Tab labels for in-restaurant (POS) orders. */
export const RESTAURANT_ORDER_STATUS_TAB_LABEL: Record<string, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  OUT_FOR_DELIVERY: "Ready",
  DELIVERED: "Completed",
  CANCELLED: "Cancelled",
};

/** Status badge text for in-restaurant orders (fulfillment-aware). */
export function restaurantOrderStatusLabel(
  status: string,
  fulfillment: string,
): string {
  switch (status) {
    case "OUT_FOR_DELIVERY":
      if (fulfillment === "dine_in") return "Ready to serve";
      if (fulfillment === "pickup") return "Ready for pickup";
      return ORDER_STATUS_LABEL.OUT_FOR_DELIVERY;
    case "DELIVERED":
      if (fulfillment === "dine_in") return "Served";
      if (fulfillment === "pickup") return "Picked up";
      return ORDER_STATUS_LABEL.DELIVERED;
    default:
      return ORDER_STATUS_LABEL[status] ?? status;
  }
}

export function orderStatusBadgeClassName(status: string): string {
  switch (status) {
    case "PENDING":
      return "border-amber-500/40 bg-amber-500/15 text-amber-950 dark:border-amber-400/35 dark:bg-amber-400/12 dark:text-amber-50";
    case "ACCEPTED":
      return "border-sky-600/40 bg-sky-500/14 text-sky-950 dark:border-sky-400/35 dark:bg-sky-400/12 dark:text-sky-50";
    case "PREPARING":
      return "border-violet-600/40 bg-violet-500/14 text-violet-950 dark:border-violet-400/35 dark:bg-violet-400/12 dark:text-violet-50";
    case "OUT_FOR_DELIVERY":
      return "border-cyan-600/40 bg-cyan-500/14 text-cyan-950 dark:border-cyan-400/35 dark:bg-cyan-400/12 dark:text-cyan-50";
    case "DELIVERED":
      return "border-emerald-600/40 bg-emerald-500/14 text-emerald-950 dark:border-emerald-400/35 dark:bg-emerald-400/12 dark:text-emerald-50";
    case "CANCELLED":
      return "border-red-600/45 bg-red-500/12 text-red-950 dark:border-red-400/40 dark:bg-red-500/18 dark:text-red-50";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function statusLabelFor(status: string): string {
  return ORDER_STATUS_LABEL[status] ?? status;
}

/** Map legacy/local statuses onto workflow tabs. */
export function normalizeOrderStatus(status: string): string {
  const upper = String(status || "").trim().toUpperCase();
  if (upper === "CREATED") return "PENDING";
  return upper;
}

export function filterOrdersByStatusTab<T extends { status: string }>(
  orders: T[],
  tab: string,
): T[] {
  if (tab === "all") return orders;
  return orders.filter((o) => normalizeOrderStatus(o.status) === tab);
}

export function countOrdersByStatus(orders: { status: string }[]): {
  total: number;
  byStatus: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};
  for (const o of orders) {
    const key = normalizeOrderStatus(o.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  return { total: orders.length, byStatus };
}

export function nextOrderStep(
  status: string,
  fulfillment: string,
): { nextStatus: string; label: string } | null {
  switch (status) {
    case "PENDING":
      return { nextStatus: "ACCEPTED", label: "Accept order" };
    case "ACCEPTED":
      return { nextStatus: "PREPARING", label: "Mark preparing" };
    case "PREPARING":
      return {
        nextStatus: "OUT_FOR_DELIVERY",
        label:
          fulfillment === "delivery"
            ? "Mark out for delivery"
            : fulfillment === "dine_in"
              ? "Mark ready to serve"
              : "Mark ready for pickup",
      };
    case "OUT_FOR_DELIVERY":
      return {
        nextStatus: "DELIVERED",
        label: fulfillment === "dine_in" ? "Mark served" : "Mark delivered",
      };
    default:
      return null;
  }
}
