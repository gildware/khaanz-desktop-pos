import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Loader2Icon,
  LogOutIcon,
  PlusIcon,
  PrinterIcon,
  SearchIcon,
  RefreshCwIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import { buildLineId, computeUnitPrice, rupeesToCents } from "../lib/cart-line";
import { computePosBillTotals, parseRupeeInputToCents } from "../lib/billing-utils";
import {
  buildDeliveryFooterNote,
  isIndianMobile10,
  normalizeIndianMobileDigits,
  POS_ANONYMOUS_PHONE_DIGITS,
} from "../lib/phone-digits";
import { CategoryIcon } from "../lib/category-icons";
import {
  cartLinesToReceiptRows,
  fulfillmentLabelFromKey,
  kotLinesFromCart,
  printPosBillThermal,
  printPosKotThermal,
} from "../lib/pos-print";
import type {
  CartAddonWithQty,
  CartItemLine,
  CartLine,
  CartOpenLine,
  FulfillmentMode,
  MenuCategory,
  MenuItem,
  MenuPayload,
  PosSettings,
  Session,
} from "../types";
import { ItemConfigureDialog } from "./ItemConfigureDialog";
import { OpenItemDialog } from "./OpenItemDialog";
import { PrinterDialog } from "./PrinterDialog";
import { RecentOrdersPanel } from "./RecentOrdersPanel";
import { ReportsPanel } from "./ReportsPanel";
import { BackendConnectionPanel } from "./BackendConnectionPanel";

function money(cents: number) {
  return `₹${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatFromPrice(item: MenuItem) {
  if (!item.variations.length) return money(0);
  const min = Math.min(...item.variations.map((v) => v.price));
  return `from ${money(rupeesToCents(min))}`;
}

function normalizePayloadItems(menu: MenuPayload): MenuItem[] {
  return menu.items
    .filter((item) => item.available !== false)
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category || "Menu",
      description: item.description || "",
      image: item.image || "",
      isVeg: item.isVeg,
      available: item.available,
      variations: item.variations ?? [],
      addons: item.addons ?? [],
    }));
}

function fulfillmentLabel(mode: FulfillmentMode) {
  if (mode === "dine_in") return "Dine-in";
  if (mode === "delivery") return "Delivery";
  return "Pickup";
}

const CAT_OPEN = "__pos_open__";

function isCartOpenLine(line: CartLine): line is CartOpenLine {
  return line.kind === "open";
}

function cartLineTitle(line: CartLine) {
  if (isCartOpenLine(line)) return `${line.name} (Open)`;
  return `${line.name} (${line.variation.name})`;
}

function cartToOrderLines(cart: CartLine[]) {
  return cart.map((l) => {
    if (isCartOpenLine(l)) {
      return {
        kind: "open" as const,
        lineId: l.lineId,
        name: l.name,
        quantity: l.qty,
        unitPrice: l.unitPriceCents / 100,
      };
    }
    return {
      kind: "item" as const,
      lineId: l.lineId,
      itemId: l.itemId,
      name: l.name,
      image: l.image,
      isVeg: true,
      variation: l.variation,
      addons: l.addons,
      quantity: l.qty,
      unitPrice: l.unitPriceCents / 100,
    };
  });
}

export function App() {
  const api = window.posDesktop;
  const desktop = window.khaanzDesktop;

  const [boot, setBoot] = useState<{
    deviceId: string;
    syncConfigured: boolean;
    apiOrigin: string | null;
    userDataEnvPath: string;
    lastMenuPullAt: string | null;
  } | null>(null);
  const [pin, setPin] = useState("");
  const [showServerSetup, setShowServerSetup] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState(CAT_OPEN);
  const [menuQuery, setMenuQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [mainTab, setMainTab] = useState<"pos" | "orders" | "reports" | "settings">("pos");
  const [fulfillment, setFulfillment] = useState<FulfillmentMode>("pickup");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [notes, setNotes] = useState("");
  const [customerDetailsOpen, setCustomerDetailsOpen] = useState(false);
  const [discountInput, setDiscountInput] = useState("");
  const [deliveryChargeInput, setDeliveryChargeInput] = useState("");
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0);
  const [posSettings, setPosSettings] = useState<PosSettings | null>(null);
  const [paymentMethodKey, setPaymentMethodKey] = useState("");
  type SubmitMode = "save" | "kot" | "bill" | "both";
  const [submittingMode, setSubmittingMode] = useState<SubmitMode | null>(null);
  const [lastBill, setLastBill] = useState<{ orderRef: string } | null>(null);
  const [printerDialogOpen, setPrinterDialogOpen] = useState(false);
  const [printerConnected, setPrinterConnected] = useState(false);

  const [dialogItem, setDialogItem] = useState<MenuItem | null>(null);
  const [variationId, setVariationId] = useState("");
  const [addonQty, setAddonQty] = useState<Record<string, number>>({});
  const [openItemName, setOpenItemName] = useState("");
  const [openItemPrice, setOpenItemPrice] = useState("");
  const [openItemModalOpen, setOpenItemModalOpen] = useState(false);

  const loadMenu = useCallback(async () => {
    const payload = await api.getMenuPayload();
    if (payload.ok) {
      setMenuItems(normalizePayloadItems(payload.menu));
      const cats = payload.menu.categories
        .filter((c) => c.name)
        .map((c) => ({
          name: c.name,
          image: c.image || "",
          icon: c.icon || "utensils-crossed",
        }));
      setCategories(cats);
      return;
    }
    const fallback = await api.listMenuItems(session?.id ?? "");
    if (fallback.ok) {
      setMenuItems(
        fallback.items.map((i) => ({
          id: i.id,
          name: i.name,
          category: "Menu",
          description: "",
          image: "",
          variations: [
            {
              id: `${i.id}::default`,
              name: "Regular",
              price: i.priceCents / 100,
            },
          ],
          addons: [],
        })),
      );
      setCategories([{ name: "Menu", image: "", icon: "utensils-crossed" }]);
      setActiveCategory(CAT_OPEN);
    }
  }, [api, session?.id]);

  const loadPosSettings = useCallback(async () => {
    const r = await api.getPosSettings();
    if (r.ok) setPosSettings(r.settings);
  }, [api]);

  const refreshPrinterStatus = useCallback(async () => {
    if (!desktop?.getPrinterStatus) {
      setPrinterConnected(false);
      return;
    }
    try {
      const status = await desktop.getPrinterStatus();
      setPrinterConnected(Boolean(status.ok && status.connected));
    } catch {
      setPrinterConnected(false);
    }
  }, [desktop]);

  const refreshConnectivity = useCallback(async () => {
    if (!desktop?.checkConnectivity) {
      setIsOnline(false);
      return;
    }
    try {
      const r = await desktop.checkConnectivity();
      setIsOnline(r.ok ? r.online : false);
    } catch {
      setIsOnline(false);
    }
  }, [desktop]);

  const refreshSyncStatus = useCallback(async () => {
    if (!desktop?.getSyncStatus) {
      setPendingSyncCount(0);
      return;
    }
    try {
      const r = await desktop.getSyncStatus();
      if (r.ok) {
        setPendingSyncCount(r.pendingCount);
        if (r.configured !== undefined || r.lastMenuPullAt !== undefined) {
          setBoot((prev) =>
            prev
              ? {
                  ...prev,
                  syncConfigured: r.configured ?? prev.syncConfigured,
                  apiOrigin: r.apiOrigin ?? prev.apiOrigin,
                  lastMenuPullAt: r.lastMenuPullAt ?? prev.lastMenuPullAt,
                  userDataEnvPath: r.userDataEnvPath ?? prev.userDataEnvPath,
                }
              : prev,
          );
        }
      }
    } catch {
      setPendingSyncCount(0);
    }
  }, [desktop]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const b = await api.bootstrap();
      if (!alive) return;
      if (b.ok) {
        setBoot({
          deviceId: b.deviceId,
          syncConfigured: Boolean(b.syncConfigured),
          apiOrigin: b.apiOrigin ?? null,
          userDataEnvPath: b.userDataEnvPath ?? "",
          lastMenuPullAt: b.lastMenuPullAt ?? null,
        });
      }
    })().catch((e) => setError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    void refreshConnectivity();
    void refreshSyncStatus();
    const id = window.setInterval(() => {
      void refreshConnectivity();
      void refreshSyncStatus();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [refreshConnectivity, refreshSyncStatus]);

  useEffect(() => {
    if (!session) return;
    void refreshConnectivity();
    void refreshSyncStatus();
  }, [session, refreshConnectivity, refreshSyncStatus]);

  const menuSearchNorm = menuQuery.trim().toLowerCase();
  const isMenuSearching = menuSearchNorm.length > 0;

  const filteredCategories = useMemo(() => {
    if (!menuSearchNorm) return categories;
    return categories.filter((cat) => {
      if (cat.name.toLowerCase().includes(menuSearchNorm)) return true;
      return menuItems.some(
        (item) =>
          item.available !== false &&
          item.category === cat.name &&
          item.name.toLowerCase().includes(menuSearchNorm),
      );
    });
  }, [categories, menuItems, menuSearchNorm]);

  const filteredMenu = useMemo(() => {
    let items = menuItems.filter((m) => m.available !== false);
    if (menuSearchNorm) {
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(menuSearchNorm) ||
          item.category.toLowerCase().includes(menuSearchNorm),
      );
      if (activeCategory !== CAT_OPEN) {
        items = items.filter((item) => item.category === activeCategory);
      }
      return items;
    }
    if (activeCategory === CAT_OPEN) return [];
    return items.filter((m) => m.category === activeCategory);
  }, [menuItems, menuSearchNorm, activeCategory]);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((a, l) => a + l.qty * l.unitPriceCents, 0);
    const tax = cart.reduce(
      (a, l) => a + Math.round(((l.qty * l.unitPriceCents) * l.taxRateBps) / 10000),
      0,
    );
    const deliveryChargeCents =
      fulfillment === "delivery" ? parseRupeeInputToCents(deliveryChargeInput) : 0;
    const discountCents = parseRupeeInputToCents(discountInput);
    const bill = computePosBillTotals({
      subtotalCents: subtotal,
      taxCents: tax,
      deliveryChargeCents,
      discountCents,
    });
    return {
      subtotal,
      tax,
      itemsTotal: bill.itemsTotal,
      deliveryChargeCents: bill.deliveryChargeCents,
      discountCents: bill.discountCents,
      total: bill.total,
    };
  }, [cart, fulfillment, deliveryChargeInput, discountInput]);

  const addItemLine = useCallback(
    (item: MenuItem, variation: MenuItem["variations"][number], addons: CartAddonWithQty[]) => {
      if (item.available === false) {
        setError("This item is unavailable.");
        return;
      }
      const unitPriceCents = rupeesToCents(computeUnitPrice(variation, addons));
      const lineId = buildLineId(item.id, variation, addons);
      setCart((prev) => {
        const existing = prev.find((l) => l.lineId === lineId);
        if (existing) {
          return prev.map((l) =>
            l.lineId === lineId ? { ...l, qty: l.qty + 1 } : l,
          );
        }
        const line: CartItemLine = {
          lineId,
          itemId: item.id,
          name: item.name,
          image: item.image,
          variation,
          addons: addons.filter((a) => a.quantity > 0),
          qty: 1,
          unitPriceCents,
          taxRateBps: 0,
        };
        return [...prev, line];
      });
      setError("");
    },
    [],
  );

  const openConfigure = useCallback(
    (item: MenuItem) => {
      if (item.available === false) {
        setError("This item is unavailable.");
        return;
      }
      const v0 = item.variations[0];
      if (!v0) {
        setError("This item has no variations.");
        return;
      }
      if (item.variations.length === 1 && item.addons.length === 0) {
        addItemLine(item, v0, []);
        return;
      }
      setDialogItem(item);
      setVariationId(v0.id);
      setAddonQty(Object.fromEntries(item.addons.map((a) => [a.id, 0])));
      setError("");
    },
    [addItemLine],
  );

  const confirmConfigure = useCallback(() => {
    if (!dialogItem) return;
    const variation = dialogItem.variations.find((v) => v.id === variationId);
    if (!variation) {
      setError("Choose a variation.");
      return;
    }
    const addons: CartAddonWithQty[] = dialogItem.addons
      .map((a) => ({ ...a, quantity: addonQty[a.id] ?? 0 }))
      .filter((a) => a.quantity > 0);
    addItemLine(dialogItem, variation, addons);
    setDialogItem(null);
  }, [dialogItem, variationId, addonQty, addItemLine]);

  const bumpLineQty = useCallback((lineId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => {
          if (l.lineId !== lineId) return l;
          return { ...l, qty: Math.max(0, l.qty + delta) };
        })
        .filter((l) => l.qty > 0),
    );
  }, []);

  const closeOpenItemModal = useCallback(() => {
    setOpenItemName("");
    setOpenItemPrice("");
    setOpenItemModalOpen(false);
  }, []);

  const addOpenLine = useCallback(() => {
    const name = openItemName.trim();
    const raw = openItemPrice.trim().replace(/,/g, "");
    const price = Number.parseFloat(raw);
    if (!name) {
      setError("Enter an item name.");
      return;
    }
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
      setError("Enter a valid price (0 – 10,00,000).");
      return;
    }
    const unitPriceCents = rupeesToCents(Math.round(price * 100) / 100);
    const line: CartOpenLine = {
      kind: "open",
      lineId: `open::${crypto.randomUUID()}`,
      name,
      qty: 1,
      unitPriceCents,
      taxRateBps: 0,
    };
    setCart((prev) => [...prev, line]);
    setError("");
    closeOpenItemModal();
  }, [openItemName, openItemPrice, closeOpenItemModal]);

  async function doLogin() {
    setError("");
    setBusy(true);
    try {
      const r = await api.loginWithPinOnly(pin);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSession(r.session);
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!session) return;
    void (async () => {
      if (boot?.syncConfigured && desktop?.syncNow) {
        setSyncing(true);
        try {
          const r = await desktop.syncNow();
          if (r.ok) {
            setBoot((prev) =>
              prev
                ? { ...prev, lastMenuPullAt: r.lastMenuPullAt ?? prev.lastMenuPullAt }
                : prev,
            );
          }
        } catch {
          /* menu load below still runs */
        } finally {
          setSyncing(false);
        }
      }
      await loadMenu();
      await loadPosSettings();
      await refreshPrinterStatus();
      await refreshConnectivity();
      await refreshSyncStatus();
    })();
  }, [
    session,
    boot?.syncConfigured,
    desktop,
    loadMenu,
    loadPosSettings,
    refreshPrinterStatus,
    refreshConnectivity,
    refreshSyncStatus,
  ]);

  useEffect(() => {
    if (!posSettings?.paymentMethods.length) return;
    setPaymentMethodKey((k) =>
      k && posSettings.paymentMethods.some((p) => p.id === k)
        ? k
        : posSettings.paymentMethods[0]!.id,
    );
  }, [posSettings]);

  useEffect(() => {
    if (cart.length > 0) setLastBill(null);
  }, [cart.length]);

  useEffect(() => {
    setCustomerDetailsOpen(fulfillment === "delivery");
  }, [fulfillment]);

  useEffect(() => {
    if (fulfillment !== "delivery") setDeliveryChargeInput("");
  }, [fulfillment]);

  async function doLogout() {
    if (session) await api.logout(session.id);
    setSession(null);
    setCart([]);
    setPin("");
    setNotice("");
    setError("");
    setDialogItem(null);
    setMainTab("pos");
    setFulfillment("pickup");
  }

  async function doSync() {
    if (!desktop?.syncNow) {
      setError("Sync is not available.");
      return;
    }
    setSyncing(true);
    setError("");
    setNotice("");
    try {
      const r = await desktop.syncNow();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      await loadMenu();
      await loadPosSettings();
      setOrdersRefreshKey((k) => k + 1);
      await refreshConnectivity();
      await refreshSyncStatus();
      if (r.ok && "lastMenuPullAt" in r && r.lastMenuPullAt) {
        setBoot((prev) => (prev ? { ...prev, lastMenuPullAt: r.lastMenuPullAt ?? null } : prev));
      }
      setNotice("Menu and orders synced.");
    } finally {
      setSyncing(false);
    }
  }

  const handleBackendSaved = useCallback(
    async (info: {
      apiOrigin: string;
      syncConfigured: boolean;
      lastMenuPullAt?: string | null;
    }) => {
      setShowServerSetup(false);
      setBoot((prev) =>
        prev
          ? {
              ...prev,
              syncConfigured: info.syncConfigured,
              apiOrigin: info.apiOrigin,
              lastMenuPullAt: info.lastMenuPullAt ?? prev.lastMenuPullAt,
            }
          : prev,
      );
      await refreshConnectivity();
      await refreshSyncStatus();
      if (session) {
        await loadMenu();
        await loadPosSettings();
        setOrdersRefreshKey((k) => k + 1);
      }
    },
    [session, refreshConnectivity, refreshSyncStatus, loadMenu, loadPosSettings],
  );

  const paymentDisplayName = useCallback(
    (key: string) => posSettings?.paymentMethods.find((p) => p.id === key)?.name ?? key,
    [posSettings],
  );

  const submitPosOrder = useCallback(
    async (printMode: "none" | "kot" | "bill" | "both") => {
      if (!session || !desktop?.placePosOrder) {
        setError("Order save is not available.");
        return;
      }
      if (cart.length === 0) {
        setError("Add at least one item.");
        return;
      }
      if (printMode !== "none" && !printerConnected) {
        setError("Connect printer to enable printing.");
        return;
      }
      if (fulfillment === "delivery" && !address.trim()) {
        setError("Address is required for delivery.");
        setCustomerDetailsOpen(true);
        return;
      }
      const phoneTrim = phone.trim();
      if (phoneTrim && !isIndianMobile10(normalizeIndianMobileDigits(phoneTrim))) {
        setError("Enter a valid 10-digit phone or leave it blank.");
        setCustomerDetailsOpen(true);
        return;
      }

      const snapshot = cart.slice();
      const snapTotal = totals.total / 100;
      const itemsSubtotalPrint = totals.itemsTotal / 100;
      const deliveryPrint = totals.deliveryChargeCents / 100;
      const discountPrint = totals.discountCents / 100;
      const snapshotLines = cartLinesToReceiptRows(snapshot);
      const snapshotKot = kotLinesFromCart(snapshot);
      const payKey = paymentMethodKey;
      const fulfillLabel = fulfillmentLabelFromKey(fulfillment);
      const header = posSettings?.billHeader ?? "";
      const footer = posSettings?.billFooter ?? "";
      const restaurantName = posSettings?.displayName || "Khaanz";
      const clientOrderId = crypto.randomUUID();
      const nameSnap = customerName.trim() || "Guest";
      const notesSnap = notes.trim();
      const phonePayload = phoneTrim ? normalizeIndianMobileDigits(phoneTrim) : "";
      const phonePrint = phonePayload || POS_ANONYMOUS_PHONE_DIGITS;
      const footerNote =
        fulfillment === "delivery" ? buildDeliveryFooterNote(address, landmark) : "";

      const orderPayload = {
        clientOrderId,
        customerName: nameSnap,
        phone: phonePayload,
        fulfillment,
        scheduleMode: "asap" as const,
        scheduledAt: null,
        address: fulfillment === "delivery" ? address.trim() : "",
        landmark: fulfillment === "delivery" ? landmark.trim() : "",
        notes: notesSnap,
        lines: cartToOrderLines(snapshot),
        latitude: null,
        longitude: null,
        paymentMethodKey: payKey,
        tableId: "",
        deliveryChargeMinor: totals.deliveryChargeCents,
        discountMinor: totals.discountCents,
      };

      const submitMode: SubmitMode =
        printMode === "none" ? "save" : printMode === "both" ? "both" : printMode;
      setSubmittingMode(submitMode);
      setError("");
      setNotice("");
      try {
        const placed = await desktop.placePosOrder(clientOrderId, orderPayload);
        if (!placed.ok) {
          setError(placed.error);
          return;
        }
        const orderRef = placed.orderRef;
        setLastBill({ orderRef });
        setCart([]);
        setNotes("");
        setAddress("");
        setLandmark("");
        setDiscountInput("");
        setDeliveryChargeInput("");
        setOrdersRefreshKey((k) => k + 1);
        void refreshSyncStatus();

        if (printMode === "none") {
          setNotice(`Order ${orderRef} saved`);
          return;
        }

        setNotice(`Order ${orderRef} saved — printing…`);
        try {
          if (printMode === "kot" || printMode === "both") {
            await printPosKotThermal(
              {
                restaurantName,
                billHeader: header,
                orderRef,
                fulfillmentLabel: fulfillLabel,
                notes: notesSnap,
                lines: snapshotKot,
              },
              desktop,
            );
          }
          if (printMode === "bill" || printMode === "both") {
            await printPosBillThermal(
              {
                restaurantName,
                billHeader: header,
                billFooter: footer,
                orderRef,
                proforma: false,
                fulfillmentLabel: fulfillLabel,
                customerName: nameSnap,
                phoneDigits: phonePrint,
                notes: notesSnap,
                footerNote: footerNote || undefined,
                paymentLabel: paymentDisplayName(payKey),
                lines: snapshotLines,
                total: snapTotal,
                itemsSubtotal: itemsSubtotalPrint,
                deliveryCharge: deliveryPrint > 0 ? deliveryPrint : undefined,
                discount: discountPrint > 0 ? discountPrint : undefined,
              },
              desktop,
            );
          }
          setNotice(`Order ${orderRef} saved and sent to printer`);
        } catch (printErr) {
          const msg = printErr instanceof Error ? printErr.message : String(printErr);
          setError(`Order ${orderRef} saved, but print failed: ${msg}`);
          void refreshPrinterStatus();
        }
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setSubmittingMode(null);
      }
    },
    [
      session,
      desktop,
      cart,
      totals.total,
      paymentMethodKey,
      fulfillment,
      posSettings,
      paymentDisplayName,
      refreshSyncStatus,
      printerConnected,
      customerName,
      phone,
      address,
      landmark,
      notes,
      totals,
    ],
  );

  const isSubmitting = submittingMode !== null;

  if (!session) {
    const needsServer = !boot?.syncConfigured || showServerSetup;
    const loginOnline = isOnline === true;
    const loginOffline = isOnline === false;

    if (needsServer) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
          <div className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-8 shadow-lg">
            <div>
              <h1 className="font-semibold text-2xl">Khaanz POS</h1>
              <p className="mt-2 text-muted-foreground text-sm">
                Connect this register to your Khaanz website before signing in.
              </p>
            </div>
            <BackendConnectionPanel
              api={api}
              variant="login"
              onSaved={(info) => void handleBackendSaved(info)}
            />
            {boot?.syncConfigured && showServerSetup ? (
              <button
                type="button"
                className="w-full text-center text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
                onClick={() => {
                  setShowServerSetup(false);
                  setError("");
                }}
              >
                Back to sign in
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
        <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 shadow-lg">
          <div>
            <h1 className="font-semibold text-2xl">Khaanz POS</h1>
            <p
              className={`mt-1 flex items-center gap-2 text-sm ${
                loginOnline ? "text-emerald-700" : "text-muted-foreground"
              }`}
            >
              {loginOnline ? (
                <WifiIcon className="size-4" />
              ) : (
                <WifiOffIcon className="size-4" />
              )}
              {isOnline === null
                ? "Checking connection…"
                : loginOnline
                  ? "Connected"
                  : "Offline"}
            </p>
            {boot?.apiOrigin ? (
              <p className="mt-1 text-muted-foreground text-xs">
                Server: <span className="font-medium text-foreground">{boot.apiOrigin}</span>
              </p>
            ) : null}
          </div>

          <div className="space-y-4">
            <label className="grid gap-2">
              <span className="font-medium text-sm">PIN</span>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                type="password"
                inputMode="numeric"
                disabled={busy}
                autoFocus
                className="h-11 rounded-lg border bg-background px-3 text-center font-mono text-lg tracking-[0.3em]"
                placeholder="••••"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doLogin();
                }}
              />
            </label>

            <button
              type="button"
              onClick={() => void doLogin()}
              disabled={busy || pin.length < 2}
              className="flex h-11 w-full items-center justify-center rounded-lg bg-primary font-medium text-primary-foreground text-sm disabled:opacity-50"
            >
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : "Sign in"}
            </button>

            <button
              type="button"
              className="w-full text-center text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
              onClick={() => {
                setShowServerSetup(true);
                setError("");
              }}
            >
              Change server
            </button>

            <p className="text-muted-foreground text-center text-xs">
              First-time PIN is often <code className="rounded bg-muted px-1">1234</code> until
              staff are synced from the server.
            </p>

            {error ? <p className="text-destructive text-center text-sm">{error}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-screen grid-rows-[auto_auto_1fr] overflow-hidden bg-background">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div>
          <div className="font-semibold">Khaanz POS</div>
          <div className="text-muted-foreground text-sm">
            {session.user.displayName} · {session.user.role}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`hidden items-center gap-1 rounded-full px-2.5 py-1 text-xs sm:inline-flex ${
              isOnline
                ? "bg-emerald-500/10 text-emerald-700"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {isOnline ? <WifiIcon className="size-3.5" /> : <WifiOffIcon className="size-3.5" />}
            {isOnline === null ? "Checking…" : isOnline ? "Online" : "Offline"}
          </span>
          <span
            className={`hidden items-center gap-1 rounded-full px-2.5 py-1 text-xs sm:inline-flex ${
              pendingSyncCount > 0
                ? "bg-amber-500/10 text-amber-800"
                : "bg-emerald-500/10 text-emerald-700"
            }`}
          >
            {pendingSyncCount > 0 ? (
              <>
                <RefreshCwIcon className="size-3.5" />
                Pending sync
              </>
            ) : (
              <>
                <CheckCircle2Icon className="size-3.5" />
                Synced
              </>
            )}
          </span>
          {boot?.syncConfigured ? (
            <button
              type="button"
              onClick={() => void doSync()}
              disabled={syncing || busy}
              className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm disabled:opacity-50"
              title="Pull menu, settings, and orders from your Khaanz site"
            >
              {syncing ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              Sync menu
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPrinterDialogOpen(true)}
            className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm ${
              printerConnected
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : ""
            }`}
          >
            <PrinterIcon className="size-4" />
            {printerConnected ? "Printer ready" : "Connect printer"}
          </button>
          <button
            type="button"
            onClick={() => void doLogout()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm"
          >
            <LogOutIcon className="size-4" />
            Sign out
          </button>
        </div>
      </header>

      {!boot?.syncConfigured ? (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-amber-950 text-sm dark:text-amber-100">
          <strong className="font-medium">Demo menu only.</strong> Open the{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => setMainTab("settings")}
          >
            Settings
          </button>{" "}
          tab to connect your site domain and sync key.
        </div>
      ) : !boot?.lastMenuPullAt ? (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-amber-950 text-sm dark:text-amber-100">
          Connected to <span className="font-medium">{boot.apiOrigin}</span> — tap{" "}
          <strong>Sync menu</strong> or <strong>Settings</strong> to refresh from the server.
        </div>
      ) : null}

      {notice ? (
        <div className="border-b bg-emerald-500/10 px-4 py-2 text-emerald-900 text-sm">{notice}</div>
      ) : null}

      <nav className="flex shrink-0 gap-1 border-b bg-muted/30 px-4 py-2">
        <button
          type="button"
          onClick={() => setMainTab("pos")}
          className={`rounded-md px-4 py-2 font-medium text-sm transition-colors ${
            mainTab === "pos"
              ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          POS
        </button>
        <button
          type="button"
          onClick={() => setMainTab("orders")}
          className={`rounded-md px-4 py-2 font-medium text-sm transition-colors ${
            mainTab === "orders"
              ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Recent orders
        </button>
        <button
          type="button"
          onClick={() => setMainTab("reports")}
          className={`rounded-md px-4 py-2 font-medium text-sm transition-colors ${
            mainTab === "reports"
              ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Report
        </button>
        <button
          type="button"
          onClick={() => setMainTab("settings")}
          className={`rounded-md px-4 py-2 font-medium text-sm transition-colors ${
            mainTab === "settings"
              ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Settings
        </button>
      </nav>

      {mainTab === "settings" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-lg space-y-6">
            <BackendConnectionPanel
              api={api}
              variant="settings"
              onSaved={(info) => void handleBackendSaved(info)}
            />
            <div className="rounded-xl border p-4 text-muted-foreground text-sm">
              <p className="font-medium text-foreground">Printer</p>
              <p className="mt-1 text-xs">
                Use <strong>Connect printer</strong> in the header to choose a receipt printer for
                silent KOT/Bill printing.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {mainTab === "orders" ? (
        <RecentOrdersPanel
          sessionId={session.id}
          refreshKey={ordersRefreshKey}
          posSettings={posSettings}
          printerConnected={printerConnected}
        />
      ) : mainTab === "reports" ? (
        <ReportsPanel refreshKey={ordersRefreshKey} />
      ) : mainTab === "pos" ? (
      <div className="grid min-h-0 min-w-0 grid-cols-1 overflow-hidden max-lg:grid-rows-[minmax(0,1fr)_minmax(min(34rem,58dvh),auto)] lg:grid-cols-[1fr_520px]">
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r">
          <div className="shrink-0 border-b bg-muted/30 p-3">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={menuQuery}
                onChange={(e) => setMenuQuery(e.target.value)}
                placeholder="Search menu & categories…"
                className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm"
                aria-label="Search menu and categories"
              />
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <aside
              className="flex w-[min(11rem,30vw)] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/50 bg-muted/25 py-2 pl-2 pr-1"
              aria-label="Categories"
            >
              <button
                type="button"
                onClick={() => setActiveCategory(CAT_OPEN)}
                className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm leading-snug transition-colors ${
                  activeCategory === CAT_OPEN
                    ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/80"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                }`}
              >
                <PlusIcon className="size-4 shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">Open item</span>
              </button>
              {filteredCategories.map((cat) => (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => setActiveCategory(cat.name)}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm leading-snug transition-colors ${
                    activeCategory === cat.name
                      ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/80"
                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                  }`}
                >
                  <CategoryIcon
                    iconKey={cat.icon}
                    className={`size-4 shrink-0 ${
                      activeCategory === cat.name ? "text-primary" : "opacity-80"
                    }`}
                  />
                  <span className="min-w-0 flex-1">{cat.name}</span>
                </button>
              ))}
              {isMenuSearching && filteredCategories.length === 0 ? (
                <p className="px-2.5 py-2 text-muted-foreground text-xs">
                  No matching categories.
                </p>
              ) : null}
            </aside>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              {activeCategory === CAT_OPEN && !isMenuSearching ? (
                <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="max-w-sm text-muted-foreground text-sm">
                    Add a one-off line not listed on the menu (extras, corkage, service
                    charges, etc.). Tap below to enter name and price.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setOpenItemModalOpen(true)}
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-8 font-medium text-primary-foreground text-sm disabled:opacity-50"
                  >
                    <PlusIcon className="size-4" />
                    Add open item
                  </button>
                </div>
              ) : (
              <div className="p-3">
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {filteredMenu.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openConfigure(item)}
                      disabled={busy || item.available === false}
                      className="flex flex-col rounded-lg border bg-background p-3 text-left text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
                    >
                      <div className="flex gap-2">
                        <div className="relative size-14 shrink-0 overflow-hidden rounded-md bg-muted">
                          {item.image ? (
                            <img
                              src={item.image}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="absolute inset-0 size-full object-cover"
                            />
                          ) : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          {isMenuSearching ? (
                            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
                              {item.category}
                            </p>
                          ) : null}
                          <p className="line-clamp-2 font-medium leading-tight">{item.name}</p>
                          <p className="mt-1 text-muted-foreground text-xs">{formatFromPrice(item)}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                {filteredMenu.length === 0 ? (
                  <p className="mt-4 text-center text-muted-foreground text-sm">
                    {menuItems.length === 0
                      ? "No menu items in cache. Use Sync when online, or seed data locally."
                      : isMenuSearching
                        ? "No items match your search."
                        : "No items in this category."}
                  </p>
                ) : null}
              </div>
              )}
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 min-w-0 w-full shrink-0 flex-col overflow-hidden border-l bg-muted/20 max-lg:min-h-[min(34rem,58dvh)] lg:w-[520px]">
          <div className="shrink-0 border-b p-3">
            <p className="mb-2 font-medium text-sm">Order type</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: "dine_in" as const, label: "Dine-in" },
                  { id: "pickup" as const, label: "Pickup" },
                  { id: "delivery" as const, label: "Delivery" },
                ] as const
              ).map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFulfillment(id)}
                  className={`h-8 rounded-md px-3 text-sm transition-colors ${
                    fulfillment === id
                      ? "bg-primary text-primary-foreground"
                      : "border bg-background hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <details
            open={customerDetailsOpen}
            onToggle={(e) => setCustomerDetailsOpen(e.currentTarget.open)}
            className="shrink-0 border-b bg-background open:[&>summary_svg]:rotate-180 [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium hover:bg-muted/40">
              <span>
                {fulfillment === "delivery"
                  ? "Customer details"
                  : "Customer & notes (optional)"}
              </span>
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform" />
            </summary>
            <div className="space-y-3 border-t px-4 py-3">
              <div className="space-y-1.5">
                <label htmlFor="pos-name" className="font-medium text-xs">
                  Name
                </label>
                <input
                  id="pos-name"
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Optional — defaults to Guest"
                  autoComplete="name"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pos-phone" className="font-medium text-xs">
                  Phone
                </label>
                <input
                  id="pos-phone"
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  placeholder="Optional — 10-digit mobile"
                  autoComplete="tel"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              {fulfillment === "delivery" ? (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor="pos-address" className="font-medium text-xs">
                      Delivery address
                    </label>
                    <textarea
                      id="pos-address"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      rows={2}
                      placeholder="Full address (required for delivery)"
                      className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="pos-landmark" className="font-medium text-xs">
                      Landmark (optional)
                    </label>
                    <input
                      id="pos-landmark"
                      type="text"
                      value={landmark}
                      onChange={(e) => setLandmark(e.target.value)}
                      placeholder="Near…"
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    />
                  </div>
                </>
              ) : null}
              <div className="space-y-1.5">
                <label htmlFor="pos-notes" className="font-medium text-xs">
                  Notes
                </label>
                <textarea
                  id="pos-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Table, packing, instructions…"
                  className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>
          </details>

          <div className="flex min-h-[29.5rem] flex-1 flex-col overflow-hidden">
            <div className="shrink-0 px-4 pt-4 pb-2">
              <h2 className="font-semibold">Preview</h2>
              <p className="mt-1 text-muted-foreground text-xs">{fulfillmentLabel(fulfillment)}</p>
            </div>

            <div className="min-h-[calc(4.5rem*6+0.5rem*5)] flex-1 overflow-y-auto overflow-x-hidden px-4">
              {cart.length === 0 ? (
                <p className="text-muted-foreground text-sm">Tap items to add them.</p>
              ) : (
                <div className="space-y-2 pb-2">
                  {cart.map((l) => (
                    <div
                      key={l.lineId}
                      className="flex min-h-[4.5rem] items-center justify-between gap-3 rounded-lg border bg-background p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 font-medium leading-snug">{cartLineTitle(l)}</div>
                        {!isCartOpenLine(l) && l.addons.length > 0 ? (
                          <div className="truncate text-muted-foreground text-xs">
                            {l.addons.map((a) => `${a.quantity}× ${a.name}`).join(", ")}
                          </div>
                        ) : null}
                        <div className="text-muted-foreground text-xs">
                          {l.qty} × {money(l.unitPriceCents)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => bumpLineQty(l.lineId, -1)}
                          disabled={busy}
                          className="flex size-8 items-center justify-center rounded-md border"
                        >
                          −
                        </button>
                        <button
                          type="button"
                          onClick={() => bumpLineQty(l.lineId, 1)}
                          disabled={busy}
                          className="flex size-8 items-center justify-center rounded-md border"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t bg-muted/20 px-4 py-3">
              <details className="rounded-lg border border-border/60 bg-background [&>summary_svg]:-rotate-180 open:[&>summary_svg]:rotate-0 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 font-semibold hover:bg-muted/40">
                  <span>Total</span>
                  <span className="flex items-center gap-1.5">
                    <span className="tabular-nums">{money(totals.total)}</span>
                    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform" />
                  </span>
                </summary>
                <div className="space-y-2.5 border-t px-3 py-2.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">{money(totals.itemsTotal)}</span>
                  </div>
                  {fulfillment === "delivery" ? (
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="pos-delivery-charge"
                        className="shrink-0 text-muted-foreground text-xs"
                      >
                        Delivery ₹
                      </label>
                      <input
                        id="pos-delivery-charge"
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        value={deliveryChargeInput}
                        onChange={(e) => setDeliveryChargeInput(e.target.value)}
                        placeholder="0"
                        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm tabular-nums"
                      />
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <label htmlFor="pos-discount" className="shrink-0 text-muted-foreground text-xs">
                      Discount ₹
                    </label>
                    <input
                      id="pos-discount"
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={discountInput}
                      onChange={(e) => setDiscountInput(e.target.value)}
                      placeholder="0"
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm tabular-nums"
                    />
                  </div>
                  {totals.deliveryChargeCents > 0 ? (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Delivery charge</span>
                      <span className="tabular-nums">+{money(totals.deliveryChargeCents)}</span>
                    </div>
                  ) : null}
                  {totals.discountCents > 0 ? (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Discount applied</span>
                      <span className="tabular-nums text-emerald-700">
                        −{money(totals.discountCents)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </details>
              {lastBill ? (
                <p className="mt-2 text-muted-foreground text-xs">
                  Last placed: <strong className="text-foreground">{lastBill.orderRef}</strong>
                </p>
              ) : null}
            </div>
          </div>

          <footer className="shrink-0 w-full border-t bg-background p-4">
            <div className="space-y-3">
              <div className="space-y-2">
                <p className="font-medium text-sm">Payment</p>
                {(posSettings?.paymentMethods ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Add payment methods in Restaurant settings.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment method">
                    {(posSettings?.paymentMethods ?? []).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPaymentMethodKey(p.id)}
                        className={`h-8 rounded-full px-3 text-sm ${
                          paymentMethodKey === p.id
                            ? "bg-primary text-primary-foreground"
                            : "border bg-background hover:bg-muted"
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <button
                  type="button"
                  disabled={isSubmitting || cart.length === 0}
                  onClick={() => void submitPosOrder("none")}
                  className="flex h-11 w-full items-center justify-center rounded-lg bg-primary font-medium text-primary-foreground text-sm disabled:opacity-50"
                >
                  {submittingMode === "save" ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </button>
                {!printerConnected ? (
                  <button
                    type="button"
                    onClick={() => setPrinterDialogOpen(true)}
                    className="text-left text-primary text-xs underline-offset-2 hover:underline"
                  >
                    Connect printer to enable printing.
                  </button>
                ) : null}
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    disabled={isSubmitting || cart.length === 0 || !printerConnected}
                    onClick={() => void submitPosOrder("kot")}
                    className="flex h-10 min-w-0 items-center justify-center rounded-md border px-2 text-sm disabled:opacity-50"
                  >
                    {submittingMode === "kot" ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      "Save & KOT"
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting || cart.length === 0 || !printerConnected}
                    onClick={() => void submitPosOrder("bill")}
                    className="flex h-10 min-w-0 items-center justify-center rounded-md border px-2 text-sm disabled:opacity-50"
                  >
                    {submittingMode === "bill" ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      "Save & Bill"
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting || cart.length === 0 || !printerConnected}
                    onClick={() => void submitPosOrder("both")}
                    className="flex h-10 min-w-0 items-center justify-center rounded-md border px-2 text-sm disabled:opacity-50"
                  >
                    {submittingMode === "both" ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      "Save & Print"
                    )}
                  </button>
                </div>
              </div>

              {notice ? (
                <p className="break-words text-sm text-green-700 dark:text-green-400">{notice}</p>
              ) : null}
              {error ? <p className="break-words text-destructive text-sm">{error}</p> : null}
            </div>
          </footer>
        </aside>
      </div>
      ) : null}

      <PrinterDialog
        open={printerDialogOpen}
        onClose={() => {
          setPrinterDialogOpen(false);
          void refreshPrinterStatus();
        }}
        onSaved={() => void refreshPrinterStatus()}
      />

      <OpenItemDialog
        open={openItemModalOpen}
        name={openItemName}
        price={openItemPrice}
        onNameChange={setOpenItemName}
        onPriceChange={setOpenItemPrice}
        onConfirm={() => addOpenLine()}
        onClose={closeOpenItemModal}
      />

      <ItemConfigureDialog
        item={dialogItem}
        variationId={variationId}
        addonQty={addonQty}
        onVariationChange={setVariationId}
        onAddonQtyChange={(addonId, qty) =>
          setAddonQty((prev) => ({ ...prev, [addonId]: qty }))
        }
        onConfirm={confirmConfigure}
        onClose={() => setDialogItem(null)}
      />
    </div>
  );
}
