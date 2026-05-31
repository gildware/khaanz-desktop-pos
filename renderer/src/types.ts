export type Session = {
  id: string;
  user: { id: string; displayName: string; role: string };
};

export type MenuCategory = {
  name: string;
  image: string;
  icon: string;
};

export type MenuVariation = {
  id: string;
  name: string;
  price: number;
};

export type MenuAddon = {
  id: string;
  name: string;
  price: number;
  image?: string;
};

export type CartAddonWithQty = MenuAddon & { quantity: number };

export type MenuItem = {
  id: string;
  name: string;
  category: string;
  description?: string;
  image: string;
  isVeg?: boolean;
  available?: boolean;
  variations: MenuVariation[];
  addons: MenuAddon[];
};

export type CartItemLine = {
  kind?: "item";
  lineId: string;
  itemId: string;
  name: string;
  image: string;
  variation: MenuVariation;
  addons: CartAddonWithQty[];
  qty: number;
  unitPriceCents: number;
  taxRateBps: number;
};

export type CartOpenLine = {
  kind: "open";
  lineId: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  taxRateBps: number;
};

export type CartLine = CartItemLine | CartOpenLine;

export type FulfillmentMode = "dine_in" | "pickup" | "delivery";

export type PaymentMethodConfig = {
  id: string;
  name: string;
};

export type PosSettings = {
  displayName: string;
  billHeader: string;
  billFooter: string;
  paymentMethods: PaymentMethodConfig[];
};

export type RecentOrderRow = {
  id: string;
  orderRef: string | null;
  status: string;
  statusLabel: string;
  fulfillment: string;
  totalMinor: number;
  currency: string;
  createdAt: string;
  customerName: string | null;
  customerPhone: string;
  source: string;
  dineInTable: string;
  lines: Array<{ sortIndex: number; payload: unknown }>;
};

export type TodaySalesReport = {
  ok: true;
  source: "server" | "local";
  dateLabel: string;
  generatedAt: string;
  ranges: {
    todayStart: string;
    tomorrowStart: string;
  };
  summary: {
    totalSalesMinor: number;
    orderCount: number;
    averageTicketMinor: number;
    cancelledCount: number;
  };
  paymentMethods: Array<{
    key: string;
    label: string;
    orderCount: number;
    totalMinor: number;
  }>;
  items: Array<{
    key: string;
    label: string;
    quantity: number;
    revenueMinor: number;
  }>;
  hourly: Array<{
    hour: number;
    label: string;
    orderCount: number;
    totalMinor: number;
  }>;
};

export type OrderSummary = {
  id: string;
  clientOrderId: string;
  status: string;
  totalCents: number;
  createdAt: string;
  syncedAt: string | null;
  fulfillment?: string;
};

export type MenuPayload = {
  categories: MenuCategory[];
  globalAddons?: MenuAddon[];
  items: MenuItem[];
};

export type CreateOrderLine = {
  menuItemId?: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  taxRateBps?: number;
};

export type PosDesktopApi = {
  bootstrap: () => Promise<
    | {
        ok: true;
        deviceId: string;
        syncConfigured?: boolean;
        apiOrigin?: string | null;
        userDataEnvPath?: string;
        lastMenuPullAt?: string | null;
      }
    | { ok: false; error: string }
  >;
  getBackendConfig: () => Promise<
    | {
        ok: true;
        apiOrigin: string;
        syncKey: string;
        configured: boolean;
        userDataEnvPath: string;
        hasStoredFile?: boolean;
      }
    | { ok: false; error: string }
  >;
  saveBackendConfig: (
    apiOrigin: string,
    syncKey: string,
  ) => Promise<
    | {
        ok: true;
        apiOrigin: string;
        syncConfigured: boolean;
        userDataEnvPath?: string;
        lastMenuPullAt?: string | null;
      }
    | { ok: false; error: string }
  >;
  testBackendConfig: (
    apiOrigin: string,
    syncKey: string,
  ) => Promise<{ ok: true; online: boolean; apiOrigin: string } | { ok: false; error: string }>;
  listUsers: () => Promise<{ ok: true; users: Array<{ id: string; displayName: string; role: string }> }>;
  loginWithPin: (
    userId: string,
    pin: string,
  ) => Promise<{ ok: true; session: Session } | { ok: false; error: string }>;
  loginWithPinOnly: (pin: string) => Promise<{ ok: true; session: Session } | { ok: false; error: string }>;
  logout: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  listMenuItems: (
    sessionId: string,
  ) => Promise<
    | {
        ok: true;
        items: Array<{
          id: string;
          name: string;
          priceCents: number;
          taxRateBps: number;
        }>;
      }
    | { ok: false; error: string }
  >;
  getMenuPayload: () => Promise<{ ok: true; menu: MenuPayload } | { ok: false; error: string }>;
  createOrder: (
    sessionId: string,
    items: CreateOrderLine[],
    fulfillment?: FulfillmentMode,
  ) => Promise<
    | {
        ok: true;
        order: {
          id: string;
          clientOrderId: string;
          subtotalCents: number;
          taxCents: number;
          totalCents: number;
          createdAt: string;
        };
      }
    | { ok: false; error: string }
  >;
  listRecentOrders: (
    sessionId: string,
    limit?: number,
  ) => Promise<{ ok: true; orders: OrderSummary[] } | { ok: false; error: string }>;
  getPosSettings: () => Promise<{ ok: true; settings: PosSettings } | { ok: false; error: string }>;
};

export type KhaanzDesktopApi = {
  isDesktop: true;
  syncNow: () => Promise<
    | { ok: true; serverTime?: string; lastMenuPullAt?: string | null }
    | { ok: false; error: string; userDataEnvPath?: string }
  >;
  checkConnectivity: () => Promise<
    { ok: true; online: boolean; configured?: boolean } | { ok: false; error: string }
  >;
  getSyncStatus: () => Promise<
    | {
        ok: true;
        pendingCount: number;
        configured?: boolean;
        apiOrigin?: string | null;
        lastMenuPullAt?: string | null;
        userDataEnvPath?: string;
      }
    | { ok: false; error: string }
  >;
  printSilentHtml: (html: string, title?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  listRecentPosOrders: () => Promise<
    { ok: true; orders: RecentOrderRow[] } | { ok: false; error: string }
  >;
  getTodaySalesReport: () => Promise<
    { ok: true; report: TodaySalesReport } | { ok: false; error: string }
  >;
  updatePosOrderStatus: (
    orderId: string,
    status: string,
  ) => Promise<
    | { ok: true; id: string; status: string; statusLabel: string }
    | { ok: false; error: string }
  >;
  placePosOrder: (
    clientOrderId: string,
    body: Record<string, unknown>,
  ) => Promise<{ ok: true; orderRef: string } | { ok: false; error: string }>;
  listPrinters: () => Promise<Array<{ name: string; isDefault?: boolean }>>;
  getSilentPrinter: () => Promise<{ deviceName: string }>;
  setSilentPrinter: (deviceName: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

declare global {
  interface Window {
    posDesktop: PosDesktopApi;
    khaanzDesktop?: KhaanzDesktopApi;
  }
}
