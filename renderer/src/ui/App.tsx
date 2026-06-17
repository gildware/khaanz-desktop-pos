import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BanknoteIcon,
  CheckCircle2Icon,
  Loader2Icon,
  LogOutIcon,
  PercentIcon,
  PlusIcon,
  PrinterIcon,
  SearchIcon,
  RefreshCwIcon,
  UserRoundIcon,
  UtensilsCrossedIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import { buildComboLineId, buildLineId, computeUnitPrice, rupeesToCents } from "../lib/cart-line";
import { formatComboComponentSummary, isComboAvailable } from "../lib/menu-combos";
import { resolveMenuMediaUrl } from "../lib/menu-media";
import { computePosBillTotals, parseRupeeInputToCents } from "../lib/billing-utils";
import {
  buildDeliveryFooterNote,
  isIndianMobile10,
  normalizeIndianMobileDigits,
  POS_ANONYMOUS_PHONE_DIGITS,
} from "../lib/phone-digits";
import { CategoryIcon } from "../lib/category-icons";
import {
  mergeBillPrintLayout,
  normalizeBillPreviewSettings,
  type BillPreviewSettings,
} from "../lib/bill-preview-settings";
import {
  cartLinesToReceiptRows,
  fulfillmentLabelFromKey,
  kotLinesFromCart,
  printPosBillThermal,
  printPosKotThermal,
} from "../lib/pos-print";
import { formatLastSyncAt } from "../lib/ist-dates";
import {
  type EditingOrder,
  fulfillmentModeFromOrder,
  minorToRupeeInput,
  orderLinesToCart,
} from "../lib/order-edit";
import type {
  CartAddonWithQty,
  CartItemLine,
  CartLine,
  CartOpenLine,
  FulfillmentMode,
  CartComboLine,
  MenuCategory,
  MenuCombo,
  MenuItem,
  MenuPayload,
  PosSettings,
  RecentOrderRow,
  Session,
} from "../types";
import { BackendConnectionPanel } from "./BackendConnectionPanel";
import { ItemConfigureDialog } from "./ItemConfigureDialog";
import { OpenItemDialog } from "./OpenItemDialog";
import { PrinterDialog } from "./PrinterDialog";
import { RecentOrdersPanel } from "./RecentOrdersPanel";
import { ReportsPanel } from "./ReportsPanel";
import { SettingsPanel } from "./SettingsPanel";

function money(cents: number) {
  return `₹${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatFromPrice(item: MenuItem) {
  if (!item.variations.length) return money(0);
  const min = Math.min(...item.variations.map((v) => v.price));
  return `from ${money(rupeesToCents(min))}`;
}

function normalizeMenuFromPayload(
  menu: MenuPayload,
  apiOrigin: string | null,
): { items: MenuItem[]; combos: MenuCombo[] } {
  const resolve = (url: string) => resolveMenuMediaUrl(url, apiOrigin);
  const items = (menu.items ?? [])
    .filter((item) => item.available !== false)
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category || "Menu",
      description: item.description || "",
      image: resolve(item.image || ""),
      isVeg: item.isVeg,
      available: item.available,
      variations: item.variations ?? [],
      addons: (item.addons ?? []).map((a) => ({
        ...a,
        image: a.image ? resolve(a.image) : a.image,
      })),
    }));
  const combos = (menu.combos ?? []).map((combo) => ({
    id: combo.id,
    name: combo.name,
    description: combo.description || "",
    image: resolve(combo.image || ""),
    price: combo.price,
    components: combo.components ?? [],
    isVeg: combo.isVeg,
    available: combo.available,
  }));
  return { items, combos };
}

function fulfillmentLabel(mode: FulfillmentMode) {
  if (mode === "dine_in") return "Dine In";
  if (mode === "delivery") return "Delivery";
  return "Pick Up";
}

function fulfillmentBadgeClass(mode: FulfillmentMode) {
  if (mode === "dine_in") return "bg-orange-400 text-orange-950";
  if (mode === "delivery") return "bg-sky-400 text-sky-950";
  return "bg-amber-400 text-amber-950";
}

const CAT_OPEN = "__pos_open__";
const CAT_COMBOS = "__pos_combos__";

function isCartOpenLine(line: CartLine): line is CartOpenLine {
  return line.kind === "open";
}

function isCartComboLine(line: CartLine): line is CartComboLine {
  return line.kind === "combo";
}

function cartLineTitle(line: CartLine) {
  if (isCartOpenLine(line)) return `${line.name} (Open)`;
  if (isCartComboLine(line)) return `${line.name} (Combo)`;
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
    if (isCartComboLine(l)) {
      return {
        kind: "combo" as const,
        lineId: l.lineId,
        comboId: l.comboId,
        name: l.name,
        image: l.image,
        isVeg: l.isVeg,
        quantity: l.qty,
        unitPrice: l.unitPriceCents / 100,
        componentSummary: l.componentSummary,
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

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuCombos, setMenuCombos] = useState<MenuCombo[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState(CAT_OPEN);
  const [menuQuery, setMenuQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [mainTab, setMainTab] = useState<
    "pos" | "recent-orders" | "online-orders" | "reports" | "settings"
  >("pos");
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
  const [billPreviewSettings, setBillPreviewSettings] = useState<BillPreviewSettings | null>(
    null,
  );
  const [paymentStatus, setPaymentStatus] = useState<"paid" | "unpaid">("unpaid");
  const [paymentMethodKey, setPaymentMethodKey] = useState("");
  const [billAdjustmentsOpen, setBillAdjustmentsOpen] = useState(false);
  type SubmitMode = "save" | "kot" | "bill" | "both";
  const [submittingMode, setSubmittingMode] = useState<SubmitMode | null>(null);
  const [lastBill, setLastBill] = useState<{ orderRef: string } | null>(null);
  const [editingOrder, setEditingOrder] = useState<EditingOrder | null>(null);
  const [printerDialogOpen, setPrinterDialogOpen] = useState(false);
  const [printerSaved, setPrinterSaved] = useState(false);
  const [printerConnected, setPrinterConnected] = useState(false);
  /** Saved queue exists and OS reports online — can attempt print. */
  const [printerReady, setPrinterReady] = useState(false);
  const [printerStatusDetail, setPrinterStatusDetail] = useState("");

  const [dialogItem, setDialogItem] = useState<MenuItem | null>(null);
  const [variationId, setVariationId] = useState("");
  const [addonQty, setAddonQty] = useState<Record<string, number>>({});
  const [openItemName, setOpenItemName] = useState("");
  const [openItemPrice, setOpenItemPrice] = useState("");
  const [openItemModalOpen, setOpenItemModalOpen] = useState(false);

  const loadMenu = useCallback(async () => {
    const apiOrigin = boot?.apiOrigin ?? null;
    const payload = await api.getMenuPayload();
    if (payload.ok) {
      const { items, combos } = normalizeMenuFromPayload(payload.menu, apiOrigin);
      setMenuItems(items);
      setMenuCombos(combos);
      const cats = payload.menu.categories
        .filter((c) => c.name)
        .map((c) => ({
          name: c.name,
          image: resolveMenuMediaUrl(c.image || "", apiOrigin),
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
      setMenuCombos([]);
      setCategories([{ name: "Menu", image: "", icon: "utensils-crossed" }]);
      setActiveCategory(CAT_OPEN);
    }
  }, [api, session?.id, boot?.apiOrigin]);

  const loadPosSettings = useCallback(async () => {
    const r = await api.getPosSettings();
    if (r.ok) setPosSettings(r.settings);
  }, [api]);

  const loadBillPreviewSettings = useCallback(async () => {
    if (!desktop?.getBillPreviewSettings) return;
    const r = await desktop.getBillPreviewSettings();
    if (r.ok) setBillPreviewSettings(normalizeBillPreviewSettings(r.settings));
  }, [desktop]);

  const billPrintLayout = useMemo(
    () =>
      mergeBillPrintLayout({
        preview: billPreviewSettings ?? undefined,
        posSettings,
        apiOrigin: boot?.apiOrigin ?? null,
      }),
    [billPreviewSettings, posSettings, boot?.apiOrigin],
  );

  const applyPrinterStatus = useCallback((status: {
    saved?: boolean;
    connected?: boolean;
    ready?: boolean;
    statusDetail?: string;
  }) => {
    if (status.saved !== undefined) setPrinterSaved(Boolean(status.saved));
    if (status.connected !== undefined) setPrinterConnected(Boolean(status.connected));
    if (status.ready !== undefined || status.connected !== undefined) {
      setPrinterReady(Boolean(status.ready ?? status.connected));
    }
    if (status.statusDetail !== undefined) setPrinterStatusDetail(status.statusDetail);
  }, []);

  const refreshPrinterStatus = useCallback(async () => {
    if (!desktop?.getPrinterStatus) {
      setPrinterSaved(false);
      setPrinterConnected(false);
      setPrinterReady(false);
      setPrinterStatusDetail("");
      return;
    }
    try {
      const status = await withIpcTimeout(
        desktop.getPrinterStatus({ includeDiagnostics: false }),
        12_000,
        "Printer status",
      );
      if (status.ok) {
        applyPrinterStatus(status);
      }
      /* Keep last known printer state on failed IPC — avoids disabling Save & Print after a slow status poll. */
    } catch {
      /* timeout or IPC error — keep last known state */
    }
  }, [desktop, applyPrinterStatus]);

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

  useEffect(() => {
    setActiveCategory((prev) => {
      const valid = new Set<string>([
        CAT_OPEN,
        CAT_COMBOS,
        ...categories.map((c) => c.name),
      ]);
      return prev && valid.has(prev) ? prev : CAT_OPEN;
    });
  }, [categories, menuCombos.length]);

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
      if (
        activeCategory !== CAT_OPEN &&
        activeCategory !== CAT_COMBOS
      ) {
        items = items.filter((item) => item.category === activeCategory);
      }
      return items;
    }
    if (activeCategory === CAT_OPEN || activeCategory === CAT_COMBOS) return [];
    return items.filter((m) => m.category === activeCategory);
  }, [menuItems, menuSearchNorm, activeCategory]);

  const filteredCombos = useMemo(() => {
    return menuCombos.filter((c) => {
      if (c.available === false) return false;
      if (!isComboAvailable(c, menuItems)) return false;
      if (menuSearchNorm && !c.name.toLowerCase().includes(menuSearchNorm)) return false;
      return true;
    });
  }, [menuCombos, menuItems, menuSearchNorm]);

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
          kind: "item",
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

  const addComboLine = useCallback(
    (combo: MenuCombo) => {
      if (!isComboAvailable(combo, menuItems)) {
        setError("This combo is unavailable.");
        return;
      }
      const lineId = buildComboLineId(combo.id);
      const componentSummary = formatComboComponentSummary(combo, menuItems);
      const unitPriceCents = rupeesToCents(combo.price);
      setCart((prev) => {
        const existing = prev.find((l) => l.lineId === lineId);
        if (existing && isCartComboLine(existing)) {
          return prev.map((l) =>
            l.lineId === lineId ? { ...l, qty: l.qty + 1 } : l,
          );
        }
        const line: CartComboLine = {
          kind: "combo",
          lineId,
          comboId: combo.id,
          name: combo.name,
          image: combo.image,
          isVeg: combo.isVeg,
          qty: 1,
          unitPriceCents,
          taxRateBps: 0,
          componentSummary,
        };
        return [...prev, line];
      });
      setError("");
    },
    [menuItems],
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
      await loadBillPreviewSettings();
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
    loadBillPreviewSettings,
    refreshPrinterStatus,
    refreshConnectivity,
    refreshSyncStatus,
  ]);

  useEffect(() => {
    if (!session || !desktop?.getPrinterStatus) return;
    const id = setInterval(() => {
      void refreshPrinterStatus();
    }, 3000);
    return () => clearInterval(id);
  }, [session, desktop, refreshPrinterStatus]);

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
      await loadBillPreviewSettings();
      setOrdersRefreshKey((k) => k + 1);
      await refreshConnectivity();
      await refreshSyncStatus();
      if (r.ok && "lastMenuPullAt" in r && r.lastMenuPullAt) {
        setBoot((prev) => (prev ? { ...prev, lastMenuPullAt: r.lastMenuPullAt ?? null } : prev));
      }
      setNotice("Data synced.");
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
        await loadBillPreviewSettings();
        setOrdersRefreshKey((k) => k + 1);
      }
    },
    [
      session,
      refreshConnectivity,
      refreshSyncStatus,
      loadMenu,
      loadPosSettings,
      loadBillPreviewSettings,
    ],
  );

  const startEditOrder = useCallback((order: RecentOrderRow) => {
    const cartLines = orderLinesToCart(order.lines ?? []);
    if (cartLines.length === 0) {
      setError("This order has no editable items.");
      return;
    }
    setCart(cartLines);
    setFulfillment(fulfillmentModeFromOrder(order));
    setCustomerName(order.customerName?.trim() || "");
    setPhone(order.customerPhone?.trim() || "");
    setAddress(order.address?.trim() || "");
    setLandmark(order.landmark?.trim() || "");
    setNotes(order.notes?.trim() || "");
    setDiscountInput(minorToRupeeInput(order.discountMinor));
    setDeliveryChargeInput(minorToRupeeInput(order.deliveryChargeMinor));
    setPaymentStatus("unpaid");
    setPaymentMethodKey("");
    setEditingOrder({
      id: order.id,
      orderRef: order.orderRef ?? order.id.slice(0, 8).toUpperCase(),
      source: order.source,
      dineInTable: order.dineInTable?.trim() || undefined,
    });
    setMainTab("pos");
    setError("");
    setNotice(`Editing order ${order.orderRef ?? order.id.slice(0, 8)}`);
  }, []);

  const cancelEditOrder = useCallback(() => {
    setEditingOrder(null);
    setCart([]);
    setNotes("");
    setAddress("");
    setLandmark("");
    setDiscountInput("");
    setDeliveryChargeInput("");
    setCustomerName("");
    setPhone("");
    setNotice("");
    setError("");
  }, []);

  const submitPosOrder = useCallback(
    async (printMode: "none" | "kot" | "bill" | "both") => {
      const isEditing = editingOrder !== null;
      if (
        !session ||
        (!isEditing && !desktop?.placePosOrder) ||
        (isEditing && !desktop?.placePosOrder)
      ) {
        setError(isEditing ? "Order update is not available." : "Order save is not available.");
        return;
      }
      if (cart.length === 0) {
        setError("Add at least one item.");
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
      const payKey = paymentStatus === "paid" ? paymentMethodKey : "";
      const billPaymentLabel = paymentStatus === "paid" ? "Paid" : "";
      const fulfillLabel = fulfillmentLabelFromKey(fulfillment);
      const header = posSettings?.billHeader ?? "";
      const footer = posSettings?.billFooter ?? "";
      const restaurantName = posSettings?.displayName || "Khaanz";
      const clientOrderId = isEditing ? editingOrder.id : crypto.randomUUID();
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
        tableId: editingOrder?.dineInTable?.trim() || "",
        deliveryChargeMinor: totals.deliveryChargeCents,
        discountMinor: totals.discountCents,
      };

      const submitMode: SubmitMode =
        printMode === "none" ? "save" : printMode === "both" ? "both" : printMode;
      setSubmittingMode(submitMode);
      setError("");
      setNotice("");
      try {
        const placed = isEditing
          ? await desktop.placePosOrder(editingOrder.id, orderPayload, true)
          : await desktop.placePosOrder(clientOrderId, orderPayload);
        if (!placed.ok) {
          setError(placed.error);
          return;
        }
        const orderRef = placed.orderRef;
        setLastBill({ orderRef });
        setOrdersRefreshKey((k) => k + 1);
        void refreshSyncStatus();

        const clearOrderForm = () => {
          setCart([]);
          setNotes("");
          setAddress("");
          setLandmark("");
          setDiscountInput("");
          setDeliveryChargeInput("");
          setEditingOrder(null);
        };

        const actionWord = isEditing ? "updated" : "saved";

        if (printMode === "none") {
          clearOrderForm();
          setNotice(`Order ${orderRef} ${actionWord}`);
          return;
        }

        setNotice(`Order ${orderRef} ${actionWord} — printing…`);
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
                layout: billPrintLayout,
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
                customerAddress:
                  fulfillment === "delivery" ? address.trim() || undefined : undefined,
                notes: notesSnap,
                footerNote: footerNote || undefined,
                paymentLabel: billPaymentLabel,
                lines: snapshotLines,
                total: snapTotal,
                itemsSubtotal: itemsSubtotalPrint,
                deliveryCharge: deliveryPrint > 0 ? deliveryPrint : undefined,
                discount: discountPrint > 0 ? discountPrint : undefined,
                layout: billPrintLayout,
              },
              desktop,
            );
          }
          clearOrderForm();
          setNotice(`Order ${orderRef} ${actionWord} and sent to printer`);
          setPrinterConnected(true);
          setPrinterReady(true);
          setPrinterSaved(true);
          void refreshPrinterStatus();
        } catch (printErr) {
          clearOrderForm();
          const msg = printErr instanceof Error ? printErr.message : String(printErr);
          setError(`Order ${orderRef} ${actionWord}, but print failed: ${msg}`);
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
      editingOrder,
      totals.total,
      paymentStatus,
      paymentMethodKey,
      fulfillment,
      posSettings,
      billPrintLayout,
      refreshSyncStatus,
      printerReady,
      customerName,
      address,
      phone,
      address,
      landmark,
      notes,
      totals,
    ],
  );

  const isSubmitting = submittingMode !== null;
  const saveActionLabel = editingOrder ? "Update" : "Save";
  const saveKotLabel = editingOrder ? "Update & KOT" : "Save & KOT";
  const saveBillLabel = editingOrder ? "Update & Bill" : "Save & Bill";
  const savePrintLabel = editingOrder ? "Update & Print" : "Save & Print";

  const printerHeaderLabel = printerConnected
    ? "Printer connected"
    : printerSaved
      ? "Printer disconnected"
      : "No printer";

  const lastSyncLabel = formatLastSyncAt(boot?.lastMenuPullAt);

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
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3">
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
            className={`hidden items-center gap-1 rounded-full px-2.5 py-1 text-xs whitespace-nowrap sm:inline-flex ${
              pendingSyncCount > 0
                ? "bg-amber-500/10 text-amber-800"
                : "bg-emerald-500/10 text-emerald-700"
            }`}
          >
            {pendingSyncCount > 0 ? (
              <>
                <RefreshCwIcon className="size-3.5 shrink-0" />
                Pending sync
              </>
            ) : (
              <>
                <CheckCircle2Icon className="size-3.5 shrink-0" />
                {lastSyncLabel ?? "Synced"}
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
              Sync data
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPrinterDialogOpen(true)}
            title={printerStatusDetail || undefined}
            className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm ${
              printerConnected
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : printerSaved
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : ""
            }`}
          >
            <PrinterIcon className="size-4" />
            {printerHeaderLabel}
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
          <strong>Sync data</strong> or <strong>Settings</strong> to refresh from the server.
        </div>
      ) : null}

      {notice ? (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-50 px-4 py-2 text-emerald-900 text-sm shadow-lg dark:bg-emerald-950 dark:text-emerald-100">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice("")}
              aria-label="Dismiss"
              className="text-emerald-700/70 hover:text-emerald-900 dark:text-emerald-300/70 dark:hover:text-emerald-100"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      {mainTab !== "pos" ? (
        <nav className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-4 py-2">
          <button
            type="button"
            onClick={() => setMainTab("pos")}
            className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-4 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
          >
            POS
          </button>
          <button
            type="button"
            onClick={() => setMainTab("recent-orders")}
            className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-4 font-medium text-sm transition-colors ${
              mainTab === "recent-orders"
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Recent orders
          </button>
          <button
            type="button"
            onClick={() => setMainTab("online-orders")}
            className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-4 font-medium text-sm transition-colors ${
              mainTab === "online-orders"
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Online orders
          </button>
          <button
            type="button"
            onClick={() => setMainTab("reports")}
            className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-4 font-medium text-sm transition-colors ${
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
            className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-4 font-medium text-sm transition-colors ${
              mainTab === "settings"
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/80"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Settings
          </button>
        </nav>
      ) : null}

      {mainTab === "settings" ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4">
          <SettingsPanel
            api={api}
            desktop={desktop}
            posSettings={posSettings}
            apiOrigin={boot?.apiOrigin ?? null}
            onBackendSaved={(info) => void handleBackendSaved(info)}
            onBillPreviewSaved={(s) => setBillPreviewSettings(normalizeBillPreviewSettings(s))}
          />
        </div>
      ) : null}

      {mainTab === "recent-orders" ? (
        <RecentOrdersPanel
          orderView="recent"
          sessionId={session.id}
          refreshKey={ordersRefreshKey}
          posSettings={posSettings}
          billPrintLayout={billPrintLayout}
          printerConnected={printerConnected}
          onEditOrder={startEditOrder}
        />
      ) : mainTab === "online-orders" ? (
        <RecentOrdersPanel
          orderView="online"
          sessionId={session.id}
          refreshKey={ordersRefreshKey}
          posSettings={posSettings}
          billPrintLayout={billPrintLayout}
          printerConnected={printerConnected}
          apiOrigin={boot?.apiOrigin ?? null}
          onEditOrder={startEditOrder}
        />
      ) : mainTab === "reports" ? (
        <ReportsPanel refreshKey={ordersRefreshKey} />
      ) : mainTab === "pos" ? (
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden max-lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[1fr_520px]">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r">
          <nav className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-3 py-1">
            <button
              type="button"
              onClick={() => setMainTab("pos")}
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md bg-background px-3 font-medium text-foreground text-xs shadow-sm ring-1 ring-border/80"
            >
              POS
            </button>
            <button
              type="button"
              onClick={() => setMainTab("recent-orders")}
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-3 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
            >
              Recent orders
            </button>
            <button
              type="button"
              onClick={() => setMainTab("online-orders")}
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-3 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
            >
              Online orders
            </button>
            <button
              type="button"
              onClick={() => setMainTab("reports")}
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-3 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
            >
              Report
            </button>
            <button
              type="button"
              onClick={() => setMainTab("settings")}
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-3 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
            >
              Settings
            </button>
          </nav>

          {editingOrder ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <p className="text-amber-950 text-xs dark:text-amber-50">
                Editing order{" "}
                <strong className="font-mono">{editingOrder.orderRef}</strong>
              </p>
              <button
                type="button"
                onClick={cancelEditOrder}
                className="shrink-0 rounded-md border border-amber-600/40 px-2 py-1 text-[11px] font-medium text-amber-950 hover:bg-amber-500/15 dark:text-amber-50"
              >
                Cancel edit
              </button>
            </div>
          ) : null}

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

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
              <button
                type="button"
                onClick={() => setActiveCategory(CAT_COMBOS)}
                className={`rounded-md px-2.5 py-2 text-left text-sm leading-snug transition-colors ${
                  activeCategory === CAT_COMBOS
                    ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/80"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                }`}
              >
                Combos
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
              ) : activeCategory === CAT_COMBOS ? (
                <div className="p-3">
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {filteredCombos.map((combo) => (
                      <button
                        key={combo.id}
                        type="button"
                        onClick={() => addComboLine(combo)}
                        disabled={busy}
                        className="flex flex-col rounded-lg border bg-background p-3 text-left text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
                      >
                        <div className="flex gap-2">
                          <div className="relative size-14 shrink-0 overflow-hidden rounded-md bg-muted">
                            {combo.image ? (
                              <img
                                src={combo.image}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="absolute inset-0 size-full object-cover"
                              />
                            ) : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 font-medium leading-tight">{combo.name}</p>
                            <p className="mt-1 text-muted-foreground text-xs">
                              {money(rupeesToCents(combo.price))}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  {filteredCombos.length === 0 ? (
                    <p className="mt-4 text-center text-muted-foreground text-sm">
                      {menuCombos.length === 0
                        ? "No combos in cache. Use Sync data when online."
                        : isMenuSearching
                          ? "No combos match your search."
                          : "No combos available right now."}
                    </p>
                  ) : null}
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
                      ? "No menu items in cache. Use Sync data when online, or seed data locally."
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
        </div>

        <aside className="flex min-h-0 min-w-0 w-full shrink-0 flex-col overflow-hidden border-l bg-white lg:w-[520px]">
          <div className="grid min-h-8 shrink-0 grid-cols-3 border-b bg-zinc-700">
            {(
              [
                { id: "dine_in" as const, label: "Dine In" },
                { id: "delivery" as const, label: "Delivery" },
                { id: "pickup" as const, label: "Pick Up" },
              ] as const
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setFulfillment(id)}
                className={`h-full text-xs font-semibold transition-colors ${
                  fulfillment === id
                    ? "bg-red-600 text-white"
                    : "text-zinc-200 hover:bg-zinc-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-white px-2.5 py-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCustomerDetailsOpen((o) => !o)}
                className={`flex size-8 items-center justify-center rounded-md border transition-colors ${
                  customerDetailsOpen
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
                aria-label="Customer details"
                title="Customer details"
              >
                <UserRoundIcon className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setBillAdjustmentsOpen((o) => !o)}
                className={`flex size-8 items-center justify-center rounded-md border transition-colors ${
                  billAdjustmentsOpen
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
                aria-label="Discount and delivery"
                title="Discount & delivery"
              >
                <PercentIcon className="size-4" />
              </button>
            </div>
            <span
              className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wide ${fulfillmentBadgeClass(fulfillment)}`}
            >
              {fulfillmentLabel(fulfillment)}
            </span>
          </div>

          {/* Customer / adjustments (collapsible) */}
          {customerDetailsOpen ? (
            <div className="shrink-0 space-y-2.5 border-b bg-zinc-50 px-3 py-2.5">
              <div className="grid grid-cols-2 gap-2">
                <input
                  id="pos-name"
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Name (Guest)"
                  autoComplete="name"
                  className="h-8 rounded border bg-white px-2 text-sm"
                />
                <input
                  id="pos-phone"
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  placeholder="Phone"
                  autoComplete="tel"
                  className="h-8 rounded border bg-white px-2 text-sm"
                />
              </div>
              {fulfillment === "delivery" ? (
                <>
                  <textarea
                    id="pos-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    rows={2}
                    placeholder="Delivery address (required)"
                    className="w-full resize-none rounded border bg-white px-2 py-1.5 text-sm"
                  />
                  <input
                    id="pos-landmark"
                    type="text"
                    value={landmark}
                    onChange={(e) => setLandmark(e.target.value)}
                    placeholder="Landmark (optional)"
                    className="h-8 w-full rounded border bg-white px-2 text-sm"
                  />
                </>
              ) : null}
              <textarea
                id="pos-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Notes — table, packing, instructions…"
                className="w-full resize-none rounded border bg-white px-2 py-1.5 text-sm"
              />
            </div>
          ) : null}

          {billAdjustmentsOpen ? (
            <div className="shrink-0 space-y-2 border-b bg-zinc-50 px-3 py-2.5">
              {fulfillment === "delivery" ? (
                <div className="flex items-center gap-2">
                  <label htmlFor="pos-delivery-charge" className="shrink-0 text-xs text-zinc-600">
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
                    className="h-8 min-w-0 flex-1 rounded border bg-white px-2 text-sm tabular-nums"
                  />
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <label htmlFor="pos-discount" className="shrink-0 text-xs text-zinc-600">
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
                  className="h-8 min-w-0 flex-1 rounded border bg-white px-2 text-sm tabular-nums"
                />
              </div>
              <div className="flex justify-between text-xs text-zinc-600">
                <span>Subtotal {money(totals.itemsTotal)}</span>
                {totals.deliveryChargeCents > 0 ? (
                  <span>+{money(totals.deliveryChargeCents)} delivery</span>
                ) : null}
                {totals.discountCents > 0 ? (
                  <span className="text-emerald-700">−{money(totals.discountCents)} discount</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Bill preview table */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="grid shrink-0 grid-cols-[1fr_5.5rem_4.5rem] gap-1 bg-zinc-200 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-zinc-700">
              <span>Items</span>
              <span className="text-center">Qty</span>
              <span className="text-right">Price</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-white">
              {cart.length === 0 ? (
                <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 px-6 text-center">
                  <UtensilsCrossedIcon className="size-14 text-zinc-300" strokeWidth={1.25} />
                  <div>
                    <p className="font-semibold text-zinc-700">No Item Selected</p>
                    <p className="mt-1 text-sm text-zinc-500">
                      Please select items from the left menu
                    </p>
                  </div>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {cart.map((l) => {
                      const lineTotal = l.qty * l.unitPriceCents;
                      return (
                        <tr key={l.lineId} className="border-b border-zinc-100 align-top">
                          <td className="px-3 py-2.5">
                            <div className="font-medium leading-snug text-zinc-900">
                              {cartLineTitle(l)}
                            </div>
                            {isCartComboLine(l) && l.componentSummary ? (
                              <div className="mt-0.5 truncate text-xs text-zinc-500">
                                {l.componentSummary}
                              </div>
                            ) : null}
                            {!isCartOpenLine(l) && !isCartComboLine(l) && l.addons.length > 0 ? (
                              <div className="mt-0.5 truncate text-xs text-zinc-500">
                                {l.addons.map((a) => `${a.quantity}× ${a.name}`).join(", ")}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-1 py-2.5">
                            <div className="flex items-center justify-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => bumpLineQty(l.lineId, -1)}
                                disabled={busy}
                                className="flex size-6 items-center justify-center rounded border border-zinc-200 text-xs hover:bg-zinc-50 disabled:opacity-50"
                              >
                                −
                              </button>
                              <span className="min-w-[1.25rem] text-center font-semibold tabular-nums">
                                {l.qty}
                              </span>
                              <button
                                type="button"
                                onClick={() => bumpLineQty(l.lineId, 1)}
                                disabled={busy}
                                className="flex size-6 items-center justify-center rounded border border-zinc-200 text-xs hover:bg-zinc-50 disabled:opacity-50"
                              >
                                +
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-medium text-zinc-900">
                            {money(lineTotal)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {lastBill ? (
              <p className="shrink-0 border-t bg-zinc-50 px-3 py-1.5 text-xs text-zinc-500">
                Last order: <strong className="text-zinc-800">{lastBill.orderRef}</strong>
              </p>
            ) : null}
          </div>

          {/* Footer: total + payment + actions */}
          <footer className="shrink-0 border-t-2 border-zinc-300 bg-zinc-100">
            {/* Total row */}
            <div className="flex items-center justify-between gap-3 border-b border-zinc-300 bg-white px-2.5 py-1.5">
              <div className="flex flex-wrap gap-2">
                {!printerReady ? (
                  <button
                    type="button"
                    onClick={() => setPrinterDialogOpen(true)}
                    className="flex items-center gap-1 rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50"
                  >
                    <PrinterIcon className="size-3" />
                    {printerSaved ? "Reconnect printer" : "Setup printer"}
                  </button>
                ) : null}
              </div>
              <p className="text-right">
                <span className="text-xs font-medium text-zinc-600">Total </span>
                <span className="text-xl font-bold tabular-nums text-zinc-900">
                  {money(totals.total)}
                </span>
              </p>
            </div>

            {/* Payment row */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-300 px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => setPaymentStatus("unpaid")}
                className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-semibold transition-colors ${
                  paymentStatus === "unpaid"
                    ? "bg-emerald-500 text-white shadow-sm"
                    : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                <CheckCircle2Icon className="size-3.5" />
                {billPrintLayout.unpaidLabel || "Not Paid"}
              </button>
              <button
                type="button"
                onClick={() => setPaymentStatus("paid")}
                className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-semibold transition-colors ${
                  paymentStatus === "paid"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                <CheckCircle2Icon className="size-3.5" />
                Paid
              </button>
              {paymentStatus === "paid" ? (
                (posSettings?.paymentMethods ?? []).length === 0 ? (
                  <span className="text-[11px] text-zinc-500">Add payment methods in Settings</span>
                ) : (
                  (posSettings?.paymentMethods ?? []).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPaymentMethodKey(p.id)}
                      className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition-colors ${
                        paymentMethodKey === p.id
                          ? "border-red-400 bg-white text-red-700 shadow-sm ring-1 ring-red-200"
                          : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                      }`}
                    >
                      <BanknoteIcon className="size-3 opacity-70" />
                      {p.name}
                    </button>
                  ))
                )
              ) : null}
            </div>

            {/* Action buttons row */}
            <div className="grid grid-cols-2 gap-1.5 p-2 sm:grid-cols-4">
              <button
                type="button"
                disabled={isSubmitting || cart.length === 0}
                onClick={() => void submitPosOrder("none")}
                className="flex h-9 items-center justify-center rounded bg-red-600 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {submittingMode === "save" ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  saveActionLabel
                )}
              </button>
              <button
                type="button"
                disabled={isSubmitting || cart.length === 0}
                onClick={() => void submitPosOrder("kot")}
                className="flex h-9 items-center justify-center rounded bg-red-600 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {submittingMode === "kot" ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  saveKotLabel
                )}
              </button>
              <button
                type="button"
                disabled={isSubmitting || cart.length === 0}
                onClick={() => void submitPosOrder("bill")}
                className="flex h-9 items-center justify-center rounded bg-red-600 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {submittingMode === "bill" ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  saveBillLabel
                )}
              </button>
              <button
                type="button"
                disabled={isSubmitting || cart.length === 0}
                onClick={() => void submitPosOrder("both")}
                className="flex h-9 items-center justify-center rounded bg-red-600 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {submittingMode === "both" ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  savePrintLabel
                )}
              </button>
            </div>

            {(notice || error) ? (
              <div className="space-y-1 border-t border-zinc-300 bg-white px-3 py-2">
                {notice ? (
                  <p className="break-words text-sm text-emerald-700">{notice}</p>
                ) : null}
                {error ? (
                  <p className="break-words text-sm text-red-600">{error}</p>
                ) : null}
              </div>
            ) : null}
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
        onTestPrintOk={(status) => {
          if (status) applyPrinterStatus(status);
          else {
            setPrinterConnected(true);
            setPrinterReady(true);
            setPrinterSaved(true);
          }
          void refreshPrinterStatus();
        }}
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
