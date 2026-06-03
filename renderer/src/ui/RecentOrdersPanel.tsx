import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";
import {
  fulfillmentLabelFromKey,
  orderLinePayloadsToReceiptLines,
  printPosBillThermal,
  printPosKotThermal,
  receiptLineToKotLine,
} from "../lib/pos-print";
import { nextOrderStep, orderStatusBadgeClassName, statusLabelFor } from "../lib/order-status";
import type { BillPrintLayout } from "../lib/bill-preview-settings";
import type { PosSettings, RecentOrderRow } from "../types";
import { OrderLineView } from "./OrderLineView";
import {
  OrderStatusConfirmDialog,
  type OrderStatusConfirmPayload,
} from "./OrderStatusConfirmDialog";

const ORDER_STATUS_TABS = [
  { id: "all", label: "All" },
  { id: "PENDING", label: "Pending" },
  { id: "ACCEPTED", label: "Accepted" },
  { id: "PREPARING", label: "Preparing" },
  { id: "OUT_FOR_DELIVERY", label: "Out for delivery" },
  { id: "DELIVERED", label: "Delivered" },
  { id: "CANCELLED", label: "Cancelled" },
] as const;

type StatusFilter = (typeof ORDER_STATUS_TABS)[number]["id"];

const PRINT_COOLDOWN_MS = 5000;

type Props = {
  sessionId: string;
  refreshKey?: number;
  posSettings: PosSettings | null;
  billPrintLayout?: BillPrintLayout;
  printerConnected?: boolean;
};

export function RecentOrdersPanel({
  sessionId,
  refreshKey = 0,
  posSettings,
  billPrintLayout,
  printerConnected = false,
}: Props) {
  const api = window.posDesktop;
  const desktop = window.khaanzDesktop;

  const [initialLoad, setInitialLoad] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<RecentOrderRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [error, setError] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [statusConfirm, setStatusConfirm] = useState<OrderStatusConfirmPayload | null>(
    null,
  );
  /** orderId → cooldown end timestamp (ms) */
  const [printCooldownUntil, setPrintCooldownUntil] = useState<Record<string, number>>({});

  const isOrderPrintOnCooldown = useCallback(
    (orderId: string) => {
      const until = printCooldownUntil[orderId];
      return typeof until === "number" && Date.now() < until;
    },
    [printCooldownUntil],
  );

  const startPrintCooldown = useCallback((orderId: string) => {
    const until = Date.now() + PRINT_COOLDOWN_MS;
    setPrintCooldownUntil((prev) => ({ ...prev, [orderId]: until }));
    window.setTimeout(() => {
      setPrintCooldownUntil((prev) => {
        if (prev[orderId] !== until) return prev;
        const { [orderId]: _removed, ...rest } = prev;
        return rest;
      });
    }, PRINT_COOLDOWN_MS);
  }, []);

  const loadOrders = useCallback(async () => {
    setError("");
    try {
      if (desktop?.listRecentPosOrders) {
        const out = await desktop.listRecentPosOrders();
        if (!out.ok) {
          setError(out.error);
          return;
        }
        setOrders(Array.isArray(out.orders) ? out.orders : []);
        return;
      }
      const local = await api.listRecentOrders(sessionId, 100);
      if (!local.ok) {
        setError(local.error);
        return;
      }
      setOrders(
        local.orders.map((o) => ({
          id: o.id,
          orderRef: o.clientOrderId.slice(0, 8).toUpperCase(),
          status: String(o.status || "created").toUpperCase(),
          statusLabel: o.syncedAt ? "Synced" : "Local",
          fulfillment: o.fulfillment || "pickup",
          totalMinor: o.totalCents,
          currency: "INR",
          createdAt: o.createdAt,
          customerName: null,
          customerPhone: "",
          source: "desktop_local",
          dineInTable: "",
          lines: [],
        })),
      );
    } finally {
      setInitialLoad(false);
      setRefreshing(false);
    }
  }, [api, desktop, sessionId]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders, refreshKey]);

  const refreshOrders = useCallback(async () => {
    setRefreshing(true);
    await loadOrders();
  }, [loadOrders]);

  const statusCounts = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    }
    return { total: orders.length, byStatus };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (statusFilter === "all") return orders;
    return orders.filter((o) => o.status === statusFilter);
  }, [orders, statusFilter]);

  const requestStatusChange = useCallback((payload: OrderStatusConfirmPayload) => {
    setStatusConfirm(payload);
  }, []);

  const confirmStatusChange = useCallback(async () => {
    if (!statusConfirm || !desktop?.updatePosOrderStatus) return;
    const { orderId, nextStatus } = statusConfirm;
    setUpdatingId(orderId);
    setError("");
    try {
      const out = await desktop.updatePosOrderStatus(orderId, nextStatus);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? {
                ...o,
                status: out.status,
                statusLabel: out.statusLabel,
              }
            : o,
        ),
      );
      setStatusConfirm(null);
    } finally {
      setUpdatingId(null);
    }
  }, [statusConfirm, desktop]);

  const printWholeOrder = useCallback(
    async (o: RecentOrderRow, mode: "kot" | "bill" | "both") => {
      if (isOrderPrintOnCooldown(o.id)) return;
      const receiptLines = orderLinePayloadsToReceiptLines(o.lines ?? []);
      if (receiptLines.length === 0) {
        setError("No printable lines on this order.");
        return;
      }
      startPrintCooldown(o.id);
      const kotLines = receiptLines.map((r) => receiptLineToKotLine(r));
      const header = posSettings?.billHeader ?? "";
      const footer = posSettings?.billFooter ?? "";
      const orderRefStr = o.orderRef ?? o.id;
      const fulfill = fulfillmentLabelFromKey(o.fulfillment);
      try {
        if (mode === "kot" || mode === "both") {
          await printPosKotThermal(
            {
              restaurantName: posSettings?.displayName || "Khaanz",
              billHeader: header,
              orderRef: orderRefStr,
              fulfillmentLabel: fulfill,
              dineInTable: o.dineInTable?.trim() || undefined,
              notes: "",
              lines: kotLines,
              layout: billPrintLayout,
            },
            desktop,
          );
        }
        if (mode === "bill" || mode === "both") {
          await printPosBillThermal(
            {
              restaurantName: posSettings?.displayName || "Khaanz",
              billHeader: header,
              billFooter: footer,
              orderRef: orderRefStr,
              proforma: false,
              fulfillmentLabel: fulfill,
              dineInTable: o.dineInTable?.trim() || undefined,
              customerName: o.customerName?.trim() || "Guest",
              phoneDigits: o.customerPhone?.trim() || "0000000000",
              notes: "",
              paymentLabel: "",
              lines: receiptLines,
              total: o.totalMinor / 100,
              layout: billPrintLayout,
            },
            desktop,
          );
        }
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    },
    [desktop, posSettings, billPrintLayout, isOrderPrintOnCooldown, startPrintCooldown],
  );

  if (initialLoad) {
    return (
      <div className="flex flex-1 items-center gap-2 p-4 text-muted-foreground">
        <Loader2Icon className="size-5 animate-spin" />
        Loading orders…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg">Orders</h2>
          <p className="text-muted-foreground text-xs">
            Recent orders from this device and synced from the server.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshOrders()}
          disabled={refreshing}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
        >
          {refreshing ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Refresh now
        </button>
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
        {ORDER_STATUS_TABS.map((tab) => {
          const count =
            tab.id === "all" ? statusCounts.total : (statusCounts.byStatus[tab.id] ?? 0);
          const active = statusFilter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs tabular-nums ${
                  active ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {!printerConnected ? (
        <p className="text-muted-foreground text-sm">Connect printer to enable printing.</p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {orders.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-12 text-center text-muted-foreground text-sm">
            No orders yet.
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-12 text-center text-muted-foreground text-sm">
            No orders in this status.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredOrders.map((o) => {
              const step = nextOrderStep(o.status, o.fulfillment);
              const rupee = (o.totalMinor / 100).toFixed(2);
              const canCancel = o.status !== "CANCELLED" && o.status !== "DELIVERED";
              const isOfflineOnly = o.source === "desktop_offline";
              const canUpdateStatus = !isOfflineOnly && Boolean(desktop?.updatePosOrderStatus);
              const isUpdating = updatingId === o.id;
              const lines = o.lines ?? [];
              const canPrintWhole = orderLinePayloadsToReceiptLines(lines).length > 0;
              const printOnCooldown = isOrderPrintOnCooldown(o.id);
              const printButtonsDisabled =
                !canPrintWhole || !printerConnected || printOnCooldown;
              return (
                <article
                  key={o.id}
                  className="flex h-[min(340px,42dvh)] min-h-[260px] flex-col overflow-hidden rounded-xl border bg-card p-3 shadow-sm"
                >
                  <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/70 pb-2">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold tracking-tight">
                          {o.orderRef ?? "—"}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${orderStatusBadgeClassName(o.status)}`}
                        >
                          {o.statusLabel}
                        </span>
                      </div>
                      <p className="text-muted-foreground text-[10px] tabular-nums leading-tight">
                        {new Date(o.createdAt).toLocaleString()}
                      </p>
                      <p className="truncate text-[11px]">
                        <span className="text-muted-foreground">{o.customerName ?? "Guest"}</span>
                        <span className="text-muted-foreground"> · </span>
                        <span>{fulfillmentLabelFromKey(o.fulfillment)}</span>
                        {o.fulfillment === "dine_in" && o.dineInTable?.trim() ? (
                          <span className="text-muted-foreground"> · T{o.dineInTable.trim()}</span>
                        ) : null}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-semibold text-sm tabular-nums">₹{rupee}</p>
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden py-2">
                    <h3 className="shrink-0 text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
                      Items ({lines.length})
                    </h3>
                    <div className="min-h-0 flex-1 overflow-y-auto pt-1.5">
                      {lines.length === 0 ? (
                        <p className="text-muted-foreground text-[11px]">No line items.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {lines.map((line) => (
                            <li key={line.sortIndex}>
                              <OrderLineView payload={line.payload} compact />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  <footer className="mt-auto shrink-0 space-y-2 border-t border-border/70 pt-2">
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        disabled={printButtonsDisabled}
                        title={printOnCooldown ? "Wait before printing again" : undefined}
                        onClick={() => void printWholeOrder(o, "kot")}
                        className="h-7 rounded-md border px-1 text-[10px] disabled:opacity-50"
                      >
                        KOT
                      </button>
                      <button
                        type="button"
                        disabled={printButtonsDisabled}
                        title={printOnCooldown ? "Wait before printing again" : undefined}
                        onClick={() => void printWholeOrder(o, "bill")}
                        className="h-7 rounded-md border px-1 text-[10px] disabled:opacity-50"
                      >
                        Bill
                      </button>
                      <button
                        type="button"
                        disabled={printButtonsDisabled}
                        title={printOnCooldown ? "Wait before printing again" : undefined}
                        onClick={() => void printWholeOrder(o, "both")}
                        className="h-7 rounded-md border px-1 text-[10px] disabled:opacity-50"
                      >
                        Both
                      </button>
                    </div>
                    {(step || canCancel) ? (
                      <div className="flex flex-wrap justify-center gap-1 border-t border-border/60 pt-2">
                        {step ? (
                          <button
                            type="button"
                            disabled={!canUpdateStatus || isUpdating}
                            title={
                              isOfflineOnly
                                ? "Sync this order before updating status"
                                : undefined
                            }
                            onClick={() =>
                              requestStatusChange({
                                orderId: o.id,
                                orderRef: o.orderRef ?? o.id.slice(0, 8),
                                currentStatusLabel: o.statusLabel || statusLabelFor(o.status),
                                nextStatus: step.nextStatus,
                                nextStatusLabel: statusLabelFor(step.nextStatus),
                                actionLabel: step.label,
                              })
                            }
                            className="h-7 rounded-md bg-primary px-2 text-[10px] text-primary-foreground disabled:opacity-50"
                          >
                            {isUpdating ? (
                              <Loader2Icon className="mx-auto size-3.5 animate-spin" />
                            ) : (
                              step.label
                            )}
                          </button>
                        ) : null}
                        {canCancel ? (
                          <button
                            type="button"
                            disabled={!canUpdateStatus || isUpdating}
                            title={
                              isOfflineOnly
                                ? "Sync this order before cancelling"
                                : undefined
                            }
                            onClick={() =>
                              requestStatusChange({
                                orderId: o.id,
                                orderRef: o.orderRef ?? o.id.slice(0, 8),
                                currentStatusLabel: o.statusLabel || statusLabelFor(o.status),
                                nextStatus: "CANCELLED",
                                nextStatusLabel: statusLabelFor("CANCELLED"),
                                actionLabel: "Cancel order",
                                destructive: true,
                              })
                            }
                            className="h-7 rounded-md border border-destructive/40 px-2 text-[10px] text-destructive disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <OrderStatusConfirmDialog
        open={statusConfirm !== null}
        busy={Boolean(statusConfirm && updatingId === statusConfirm.orderId)}
        payload={statusConfirm}
        onClose={() => setStatusConfirm(null)}
        onConfirm={() => void confirmStatusChange()}
      />
    </div>
  );
}
