import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, MapPinIcon, MessageCircleIcon, NavigationIcon } from "lucide-react";
import {
  fulfillmentLabelFromKey,
  orderLinePayloadsToReceiptLines,
  printPosBillThermal,
  printPosKotThermal,
  receiptLineToKotLine,
} from "../lib/pos-print";
import { formatIstDateInput, isOrderOnIstDate, parseIstDateInput } from "../lib/ist-dates";
import {
  countOrdersByStatus,
  filterOrdersByStatusTab,
  nextOrderStep,
  normalizeOrderStatus,
  ORDER_STATUS_LABEL,
  orderStatusBadgeClassName,
  RESTAURANT_ORDER_STATUS_TAB_LABEL,
  restaurantOrderStatusLabel,
  statusLabelFor,
} from "../lib/order-status";
import type { BillPrintLayout } from "../lib/bill-preview-settings";
import {
  enrichOrderLocation,
  formatTravelDistanceLabel,
  hydrateOrdersWithDistance,
  parseOrderCoords,
  resolveCustomerMapUrl,
} from "../lib/order-location";
import { openWhatsAppOrder } from "../lib/whatsapp";
import type { PosSettings, RecentOrderRow } from "../types";
import { OrderLineView } from "./OrderLineView";
import {
  OrderStatusConfirmDialog,
  type OrderStatusConfirmPayload,
} from "./OrderStatusConfirmDialog";

const AUTO_REFRESH_MS = 15_000;
const PRINT_COOLDOWN_MS = 5000;

type OrderView = "recent" | "online";

type StatusFilter = "all" | string;

const RECENT_STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "PENDING", label: RESTAURANT_ORDER_STATUS_TAB_LABEL.PENDING },
  { id: "ACCEPTED", label: RESTAURANT_ORDER_STATUS_TAB_LABEL.ACCEPTED },
  { id: "PREPARING", label: RESTAURANT_ORDER_STATUS_TAB_LABEL.PREPARING },
  { id: "OUT_FOR_DELIVERY", label: RESTAURANT_ORDER_STATUS_TAB_LABEL.OUT_FOR_DELIVERY },
  { id: "DELIVERED", label: RESTAURANT_ORDER_STATUS_TAB_LABEL.DELIVERED },
  { id: "CANCELLED", label: RESTAURANT_ORDER_STATUS_TAB_LABEL.CANCELLED },
];

const ONLINE_STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "PENDING", label: ORDER_STATUS_LABEL.PENDING },
  { id: "ACCEPTED", label: ORDER_STATUS_LABEL.ACCEPTED },
  { id: "PREPARING", label: ORDER_STATUS_LABEL.PREPARING },
  { id: "OUT_FOR_DELIVERY", label: ORDER_STATUS_LABEL.OUT_FOR_DELIVERY },
  { id: "DELIVERED", label: ORDER_STATUS_LABEL.DELIVERED },
  { id: "CANCELLED", label: ORDER_STATUS_LABEL.CANCELLED },
];

function normalizeOrderRows(rows: RecentOrderRow[]): RecentOrderRow[] {
  return rows.map((o) =>
    enrichOrderLocation({
      ...o,
      status: normalizeOrderStatus(o.status),
    }),
  );
}

function defaultStatusFilter(_view: OrderView): StatusFilter {
  return "all";
}

function displayStatusLabel(o: RecentOrderRow, view: OrderView): string {
  if (o.source === "desktop_offline") return "Offline";
  if (o.source === "desktop_local") return o.statusLabel || "Local";
  if (view === "online") {
    return o.status === "PENDING"
      ? `New · ${o.statusLabel || statusLabelFor(o.status)}`
      : o.statusLabel || statusLabelFor(o.status);
  }
  return restaurantOrderStatusLabel(o.status, o.fulfillment);
}

type Props = {
  orderView: OrderView;
  sessionId: string;
  refreshKey?: number;
  posSettings: PosSettings | null;
  billPrintLayout?: BillPrintLayout;
  printerConnected?: boolean;
  apiOrigin?: string | null;
};

export function RecentOrdersPanel({
  orderView,
  sessionId,
  refreshKey = 0,
  posSettings,
  billPrintLayout,
  printerConnected = false,
  apiOrigin = null,
}: Props) {
  const api = window.posDesktop;
  const desktop = window.khaanzDesktop;

  const [orderDate, setOrderDate] = useState(() => formatIstDateInput(new Date()));
  const todayIst = formatIstDateInput(new Date());
  const viewingToday = orderDate === todayIst;

  const [initialLoad, setInitialLoad] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<RecentOrderRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() =>
    defaultStatusFilter(orderView),
  );
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [statusConfirm, setStatusConfirm] = useState<OrderStatusConfirmPayload | null>(
    null,
  );
  const [printCooldownUntil, setPrintCooldownUntil] = useState<Record<string, number>>({});
  const [travelConfigured, setTravelConfigured] = useState(true);

  const statusTabs = orderView === "online" ? ONLINE_STATUS_TABS : RECENT_STATUS_TABS;

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
    const dayStart = parseIstDateInput(orderDate);
    try {
      if (desktop?.listPosOrders) {
        const out = await desktop.listPosOrders({ view: orderView, date: orderDate });
        if (!out.ok) {
          setError(out.error);
          return;
        }
        let rows = normalizeOrderRows(Array.isArray(out.orders) ? out.orders : []);
        let travelReady = out.travelDistanceConfigured !== false;
        if (orderView === "online") {
          const hydrated = await hydrateOrdersWithDistance(rows, apiOrigin, desktop);
          rows = hydrated.rows;
          if (hydrated.travelDistanceConfigured !== undefined) {
            travelReady = hydrated.travelDistanceConfigured;
          }
        }
        setOrders(rows);
        if (orderView === "online") {
          setTravelConfigured(travelReady);
        }
        if (orderView === "online" && out.stale && rows.length === 0) {
          setError(
            "No online orders loaded. Tap Sync data, or update the server app if this persists.",
          );
        }
        return;
      }
      if (desktop?.listRecentPosOrders) {
        const out = await desktop.listRecentPosOrders();
        if (!out.ok) {
          setError(out.error);
          return;
        }
        let rows = normalizeOrderRows(Array.isArray(out.orders) ? out.orders : []);
        if (orderView === "online") {
          rows = rows.filter((o) => o.source === "website");
        } else {
          rows = rows.filter((o) => o.source !== "website");
        }
        if (dayStart) {
          rows = rows.filter((o) => isOrderOnIstDate(o.createdAt, dayStart));
        }
        if (orderView === "online") {
          const hydrated = await hydrateOrdersWithDistance(rows, apiOrigin, desktop);
          rows = hydrated.rows;
          if (hydrated.travelDistanceConfigured !== undefined) {
            setTravelConfigured(hydrated.travelDistanceConfigured);
          }
        }
        setOrders(rows);
        return;
      }
      const local = await api.listRecentOrders(sessionId, 100);
      if (!local.ok) {
        setError(local.error);
        return;
      }
      let rows = normalizeOrderRows(
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
      if (dayStart) {
        rows = rows.filter((o) => isOrderOnIstDate(o.createdAt, dayStart));
      }
      setOrders(orderView === "online" ? [] : rows);
    } finally {
      setInitialLoad(false);
      setRefreshing(false);
    }
  }, [api, apiOrigin, desktop, orderDate, orderView, sessionId]);

  useEffect(() => {
    setStatusFilter(defaultStatusFilter(orderView));
  }, [orderView]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders, refreshKey]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void loadOrders();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadOrders]);

  const refreshOrders = useCallback(async () => {
    setRefreshing(true);
    if (desktop?.syncNow) {
      await desktop.syncNow().catch(() => {});
    }
    await loadOrders();
  }, [desktop, loadOrders]);

  const statusCounts = useMemo(
    () => countOrdersByStatus(orders),
    [orders],
  );

  const filteredOrders = useMemo(
    () => filterOrdersByStatusTab(orders, statusFilter),
    [orders, statusFilter],
  );

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
          const deliveryCharge =
            o.deliveryChargeMinor && o.deliveryChargeMinor > 0
              ? o.deliveryChargeMinor / 100
              : undefined;
          const discount =
            o.discountMinor && o.discountMinor > 0 ? o.discountMinor / 100 : undefined;
          const itemsSubtotal = receiptLines.reduce((sum, line) => sum + line.subtotal, 0);
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
              customerAddress: o.address?.trim() || undefined,
              notes: o.notes?.trim() || "",
              footerNote: footer || undefined,
              paymentLabel: "",
              lines: receiptLines,
              total: o.totalMinor / 100,
              itemsSubtotal,
              deliveryCharge,
              discount,
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

  const openExternalUrl = useCallback(
    async (url: string) => {
      if (!url.trim()) return;
      if (desktop?.openExternalUrl) {
        const out = await desktop.openExternalUrl(url);
        if (!out.ok) {
          setError(out.error || "Could not open link in browser.");
        }
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [desktop],
  );

  const sendOrderToRestaurantWhatsApp = useCallback(
    (o: RecentOrderRow) => {
      const phone = posSettings?.whatsappPhoneE164?.replace(/\D/g, "") ?? "";
      if (!phone) {
        setError("Restaurant WhatsApp number is not set. Add it under Settings.");
        return;
      }
      if (orderLinePayloadsToReceiptLines(o.lines ?? []).length === 0) {
        setError("No items on this order to send.");
        return;
      }
      openWhatsAppOrder(
        {
          orderRef: o.orderRef,
          customerName: o.customerName,
          phone: o.customerPhone,
          fulfillment: o.fulfillment,
          scheduleMode: o.scheduleMode,
          scheduledAt: o.scheduledAt ?? null,
          address: o.address?.trim() ?? "",
          landmark: o.landmark?.trim() ?? "",
          notes: o.notes?.trim() ?? "",
          latitude: o.latitude ?? null,
          longitude: o.longitude ?? null,
          deliveryChargeMinor: o.deliveryChargeMinor ?? 0,
          lines: o.lines ?? [],
        },
        phone,
        openExternalUrl,
      );
    },
    [openExternalUrl, posSettings],
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
          <h2 className="font-semibold text-lg">
            {orderView === "online" ? "Online orders" : "Recent orders"}
          </h2>
          <p className="text-muted-foreground text-xs">
            {orderView === "online"
              ? "Website orders for the selected date."
              : "POS and dine-in orders from this device and server."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="size-3.5 rounded border"
            />
            Auto (15s)
          </label>
          <input
            type="date"
            value={orderDate}
            onChange={(e) => setOrderDate(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            aria-label="Order date"
          />
          {!viewingToday ? (
            <button
              type="button"
              onClick={() => setOrderDate(todayIst)}
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm"
            >
              Today
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void refreshOrders()}
            disabled={refreshing}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
          >
            {refreshing ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Refresh
          </button>
        </div>
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
        {statusTabs.map((tab) => {
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
      {orderView === "online" && !travelConfigured ? (
        <p className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-amber-950 text-xs dark:text-amber-100">
          Driving distance is off on the server. Set GOOGLE_MAPS_API_KEY and restaurant
          coordinates in server settings.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {orders.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-12 text-center text-muted-foreground text-sm">
            {viewingToday
              ? `No ${orderView === "online" ? "online" : ""} orders today.`
              : `No orders on ${orderDate}.`}
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-12 text-center text-muted-foreground text-sm">
            No orders in this status
            {viewingToday ? " today" : ` on ${orderDate}`}.
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
              const isPendingOnline = orderView === "online" && o.status === "PENDING";
              const lines = o.lines ?? [];
              const canPrintWhole = orderLinePayloadsToReceiptLines(lines).length > 0;
              const printOnCooldown = isOrderPrintOnCooldown(o.id);
              const printButtonsDisabled = !canPrintWhole || printOnCooldown;
              const badgeLabel = displayStatusLabel(o, orderView);
              const canSendWhatsApp =
                orderView === "online" &&
                (o.status === "PENDING" ||
                  o.status === "ACCEPTED" ||
                  o.status === "OUT_FOR_DELIVERY");
              const coords = parseOrderCoords(o);
              const showLocation =
                orderView === "online" && Boolean(o.address?.trim() || coords);
              const showDistanceRow =
                orderView === "online" &&
                o.fulfillment === "delivery" &&
                Boolean(coords || o.address?.trim());

              return (
                <article
                  key={o.id}
                  className={`flex ${
                    orderView === "online"
                      ? "h-[min(480px,52dvh)] min-h-[360px]"
                      : "h-[min(340px,42dvh)] min-h-[260px]"
                  } flex-col overflow-hidden rounded-xl border bg-card p-3 shadow-sm ${
                    isPendingOnline ? "ring-1 ring-amber-500/30" : ""
                  }`}
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
                          {badgeLabel}
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
                      {orderView === "online" && (o.deliveryChargeMinor ?? 0) > 0 ? (
                        <p className="text-muted-foreground text-[10px] tabular-nums">
                          incl. ₹{((o.deliveryChargeMinor ?? 0) / 100).toFixed(0)} delivery
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {showLocation ? (
                    <div className="shrink-0 space-y-1.5 border-b border-border/70 py-2">
                      <div className="flex items-start gap-1.5">
                        <MapPinIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        <div className="min-w-0 flex-1 text-[11px]">
                          <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
                            Customer location
                          </p>
                          {o.address?.trim() ? (
                            <p className="mt-0.5 leading-snug">{o.address.trim()}</p>
                          ) : coords ? (
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                            </p>
                          ) : null}
                          {o.landmark?.trim() ? (
                            <p className="text-muted-foreground text-[10px]">
                              Landmark: {o.landmark.trim()}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {showDistanceRow ? (
                        <div className="flex flex-wrap items-center gap-1.5 pl-5">
                          {o.distance ? (
                            <span className="inline-flex items-center gap-1 rounded border border-sky-600/40 bg-sky-500/12 px-1.5 py-0.5 text-[10px] font-medium text-sky-950 dark:border-sky-400/35 dark:bg-sky-400/12 dark:text-sky-50">
                              <NavigationIcon className="size-2.5" />
                              {formatTravelDistanceLabel(o.distance)}
                            </span>
                          ) : coords && travelConfigured ? (
                            <span className="text-muted-foreground text-[10px]">
                              Distance unavailable
                            </span>
                          ) : null}
                          {resolveCustomerMapUrl(o) ? (
                            <button
                              type="button"
                              onClick={() => void openExternalUrl(resolveCustomerMapUrl(o)!)}
                              className="inline-flex items-center gap-1 text-[10px] font-medium text-primary underline-offset-2 hover:underline"
                            >
                              <NavigationIcon className="size-2.5" />
                              Open in Google Maps
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

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
                    {step || canCancel ? (
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
                                currentStatusLabel: badgeLabel,
                                nextStatus: step.nextStatus,
                                nextStatusLabel:
                                  orderView === "online"
                                    ? statusLabelFor(step.nextStatus)
                                    : restaurantOrderStatusLabel(
                                        step.nextStatus,
                                        o.fulfillment,
                                      ),
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
                                currentStatusLabel: badgeLabel,
                                nextStatus: "CANCELLED",
                                nextStatusLabel:
                                  orderView === "online"
                                    ? statusLabelFor("CANCELLED")
                                    : RESTAURANT_ORDER_STATUS_TAB_LABEL.CANCELLED,
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
                    {canSendWhatsApp ? (
                      <button
                        type="button"
                        disabled={
                          !posSettings?.whatsappPhoneE164?.trim() || !canPrintWhole
                        }
                        onClick={() => sendOrderToRestaurantWhatsApp(o)}
                        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-[#25D366] text-[10px] text-white hover:bg-[#20bd5a] disabled:opacity-50"
                      >
                        <MessageCircleIcon className="size-3.5" />
                        Send order to Restaurant WhatsApp
                      </button>
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
