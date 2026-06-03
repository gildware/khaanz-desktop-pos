export type BillThemeId = "classic" | "minimal" | "elegant" | "bold" | "compact";

/** Base logo box on 80mm thermal paper at 100% scale (themes use a smaller %). */
export const BILL_LOGO_BASE_WIDTH_MM = 72;
export const BILL_LOGO_BASE_HEIGHT_MM = 45;
/** Small centered logo on all themes (~30×19 mm on 80mm paper). */
export const BILL_LOGO_SIZE_PERCENT = 42;

export type BillFontFamily = "sans" | "serif" | "mono";
export type BillFontWeight = "normal" | "semibold" | "bold";
export type BillRuleStyle = "single" | "double" | "dashed";

export type BillThemeDefinition = {
  id: BillThemeId;
  name: string;
  description: string;
  fontFamily: BillFontFamily;
  fontWeight: BillFontWeight;
  logoSizePercent: number;
  shopNameSizePx: number;
  grandTotalSizePx: number;
  bodySizePx: number;
  ruleStyle: BillRuleStyle;
  headerAlign: "center" | "left";
  contactLabel: string;
  orderIdLabel: string;
  /** Print last numeric segment vs full order ref. */
  orderIdFormat: "short" | "full";
  thankYouMessage: string;
  unpaidLabel: string;
  lineHeight: number;
  receiptPaddingPx: number;
};

export const BILL_THEMES: BillThemeDefinition[] = [
  {
    id: "classic",
    name: "Classic",
    description: "Standard thermal receipt — bold sans, clear totals.",
    fontFamily: "sans",
    fontWeight: "bold",
    logoSizePercent: BILL_LOGO_SIZE_PERCENT,
    shopNameSizePx: 15,
    grandTotalSizePx: 18,
    bodySizePx: 12,
    ruleStyle: "single",
    headerAlign: "center",
    contactLabel: "Tel:",
    orderIdLabel: "Bill No.",
    orderIdFormat: "short",
    thankYouMessage: "Thank you — visit again!",
    unpaidLabel: "Not Paid",
    lineHeight: 1.4,
    receiptPaddingPx: 8,
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Compact monospace — more items per slip, subtle header.",
    fontFamily: "mono",
    fontWeight: "normal",
    logoSizePercent: BILL_LOGO_SIZE_PERCENT,
    shopNameSizePx: 13,
    grandTotalSizePx: 15,
    bodySizePx: 11,
    ruleStyle: "dashed",
    headerAlign: "left",
    contactLabel: "Ph:",
    orderIdLabel: "Order",
    orderIdFormat: "full",
    thankYouMessage: "Thanks!",
    unpaidLabel: "Unpaid",
    lineHeight: 1.3,
    receiptPaddingPx: 6,
  },
  {
    id: "elegant",
    name: "Elegant",
    description: "Serif typography with double rules — suited for dine-in.",
    fontFamily: "serif",
    fontWeight: "semibold",
    logoSizePercent: BILL_LOGO_SIZE_PERCENT,
    shopNameSizePx: 16,
    grandTotalSizePx: 17,
    bodySizePx: 12,
    ruleStyle: "double",
    headerAlign: "center",
    contactLabel: "Contact:",
    orderIdLabel: "Bill No.",
    orderIdFormat: "short",
    thankYouMessage: "We look forward to serving you again.",
    unpaidLabel: "Payment pending",
    lineHeight: 1.45,
    receiptPaddingPx: 10,
  },
  {
    id: "bold",
    name: "Bold Retail",
    description: "Large shop name and total — high visibility on busy counters.",
    fontFamily: "sans",
    fontWeight: "bold",
    logoSizePercent: BILL_LOGO_SIZE_PERCENT,
    shopNameSizePx: 17,
    grandTotalSizePx: 20,
    bodySizePx: 12,
    ruleStyle: "double",
    headerAlign: "center",
    contactLabel: "Call:",
    orderIdLabel: "Order ID",
    orderIdFormat: "full",
    thankYouMessage: "Thank You — Visit Again!",
    unpaidLabel: "NOT PAID",
    lineHeight: 1.35,
    receiptPaddingPx: 8,
  },
  {
    id: "compact",
    name: "Compact",
    description: "Tight layout for high-volume takeaway — dense lines.",
    fontFamily: "sans",
    fontWeight: "semibold",
    logoSizePercent: BILL_LOGO_SIZE_PERCENT,
    shopNameSizePx: 14,
    grandTotalSizePx: 16,
    bodySizePx: 11,
    ruleStyle: "single",
    headerAlign: "left",
    contactLabel: "Mob:",
    orderIdLabel: "#",
    orderIdFormat: "short",
    thankYouMessage: "Thank you!",
    unpaidLabel: "Due",
    lineHeight: 1.28,
    receiptPaddingPx: 5,
  },
];

const THEME_BY_ID = new Map(BILL_THEMES.map((t) => [t.id, t]));

export function normalizeBillThemeId(raw: unknown): BillThemeId {
  if (typeof raw === "string" && THEME_BY_ID.has(raw as BillThemeId)) {
    return raw as BillThemeId;
  }
  return "classic";
}

export function getBillTheme(id: BillThemeId): BillThemeDefinition {
  return THEME_BY_ID.get(id) ?? THEME_BY_ID.get("classic")!;
}

/** Map legacy per-field settings to a sensible default theme. */
export function inferThemeFromLegacySettings(raw: Record<string, unknown>): BillThemeId {
  if (typeof raw.themeId === "string" && THEME_BY_ID.has(raw.themeId as BillThemeId)) {
    return raw.themeId as BillThemeId;
  }
  if (raw.fontFamily === "serif") return "elegant";
  if (raw.fontFamily === "mono") return "minimal";
  if (raw.fontWeight === "normal") return "minimal";
  return "classic";
}
