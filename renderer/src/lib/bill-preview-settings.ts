import { resolveMenuMediaUrl } from "./menu-media";
import {
  BILL_LOGO_BASE_HEIGHT_MM,
  BILL_LOGO_BASE_WIDTH_MM,
  BILL_LOGO_SIZE_PERCENT,
  getBillTheme,
  inferThemeFromLegacySettings,
  normalizeBillThemeId,
  type BillThemeDefinition,
  type BillThemeId,
} from "./bill-themes";

export const BILL_LOGO_SIZE_MIN = 20;
export const BILL_LOGO_SIZE_MAX = 100;
export const BILL_LOGO_SIZE_DEFAULT = BILL_LOGO_SIZE_PERCENT;

export type { BillThemeId } from "./bill-themes";
export { BILL_THEMES, getBillTheme } from "./bill-themes";

/** Subset of synced POS settings used for bill layout (avoids circular import with types.ts). */
export type BillPrintPosContext = {
  displayName?: string;
  logoUrl?: string;
  whatsappPhoneE164?: string;
};

export type BillPreviewSettings = {
  themeId: BillThemeId;
  /** Local logo override (data URL). Falls back to synced admin logo. */
  logoDataUrl: string;
  /** Logo scale on receipt (20–100). */
  logoSizePercent: number;
  /** Empty = use name synced from admin / POS settings. */
  restaurantName: string;
  restaurantPhone: string;
  restaurantAddress: string;
  footerNotes: string;
  showLogo: boolean;
  showRestaurantName: boolean;
  showPhone: boolean;
  showAddress: boolean;
  showOrderId: boolean;
  showFooterNotes: boolean;
};

export const DEFAULT_BILL_PREVIEW_SETTINGS: BillPreviewSettings = {
  themeId: "classic",
  logoDataUrl: "",
  logoSizePercent: BILL_LOGO_SIZE_DEFAULT,
  restaurantName: "",
  restaurantPhone: "",
  restaurantAddress: "",
  footerNotes: "",
  showLogo: true,
  showRestaurantName: true,
  showPhone: true,
  showAddress: true,
  showOrderId: true,
  showFooterNotes: true,
};

export type BillPrintLayout = BillThemeDefinition & {
  themeClass: string;
  logoSrc: string;
  logoMaxWidthMm: number;
  logoMaxHeightMm: number;
  restaurantDisplayName: string;
  restaurantPhone: string;
  restaurantAddress: string;
  footerNotes: string;
  showLogo: boolean;
  showRestaurantName: boolean;
  showPhone: boolean;
  showAddress: boolean;
  showOrderId: boolean;
  showFooterNotes: boolean;
  fontFamilyCss: string;
  fontWeightCss: string;
  fontWeightNum: number;
};

const FONT_FAMILY_MAP = {
  sans: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, Georgia, serif',
  mono: '"Courier New", Courier, monospace',
} as const;

const FONT_WEIGHT_MAP = {
  normal: { css: "400", num: 400 },
  semibold: { css: "600", num: 600 },
  bold: { css: "700", num: 700 },
} as const;

function logoDimensionsMm(logoSizePercent: number): {
  logoMaxWidthMm: number;
  logoMaxHeightMm: number;
} {
  const scale = logoSizePercent / 100;
  return {
    logoMaxWidthMm: Math.round(BILL_LOGO_BASE_WIDTH_MM * scale * 10) / 10,
    logoMaxHeightMm: Math.round(BILL_LOGO_BASE_HEIGHT_MM * scale * 10) / 10,
  };
}

function readBool(raw: Record<string, unknown>, key: keyof BillPreviewSettings, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

export function normalizeLogoSizePercent(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return BILL_LOGO_SIZE_DEFAULT;
  return Math.min(BILL_LOGO_SIZE_MAX, Math.max(BILL_LOGO_SIZE_MIN, Math.round(n)));
}

export function normalizeBillPreviewSettings(
  raw: Partial<BillPreviewSettings> & Record<string, unknown> | null | undefined,
): BillPreviewSettings {
  const d = DEFAULT_BILL_PREVIEW_SETTINGS;
  if (!raw || typeof raw !== "object") return { ...d };

  const themeId =
    raw.themeId !== undefined
      ? normalizeBillThemeId(raw.themeId)
      : inferThemeFromLegacySettings(raw);

  const footerNotes =
    typeof raw.footerNotes === "string"
      ? raw.footerNotes
      : typeof raw.thankYouMessage === "string" && raw.thankYouMessage.trim()
        ? raw.thankYouMessage
        : d.footerNotes;

  return {
    themeId,
    logoDataUrl: typeof raw.logoDataUrl === "string" ? raw.logoDataUrl : d.logoDataUrl,
    logoSizePercent: normalizeLogoSizePercent(raw.logoSizePercent),
    restaurantName: typeof raw.restaurantName === "string" ? raw.restaurantName : d.restaurantName,
    restaurantPhone:
      typeof raw.restaurantPhone === "string" ? raw.restaurantPhone : d.restaurantPhone,
    restaurantAddress:
      typeof raw.restaurantAddress === "string" ? raw.restaurantAddress : d.restaurantAddress,
    footerNotes,
    showLogo: readBool(raw, "showLogo", d.showLogo),
    showRestaurantName: readBool(raw, "showRestaurantName", d.showRestaurantName),
    showPhone: readBool(raw, "showPhone", d.showPhone),
    showAddress: readBool(raw, "showAddress", d.showAddress),
    showOrderId: readBool(raw, "showOrderId", d.showOrderId),
    showFooterNotes: readBool(raw, "showFooterNotes", d.showFooterNotes),
  };
}

export function formatRestaurantPhoneDisplay(
  localPhone: string,
  syncedWhatsappE164?: string,
): string {
  const local = localPhone.replace(/\D/g, "");
  if (local.length >= 10) {
    return local.length > 10 ? local.slice(-10) : local;
  }
  const synced = String(syncedWhatsappE164 || "").replace(/\D/g, "");
  if (synced.length >= 10) return synced.slice(-10);
  return localPhone.trim() || synced.trim();
}

export function resolveBillLogoSrc(
  preview: BillPreviewSettings,
  posSettings: BillPrintPosContext | null,
  apiOrigin: string | null | undefined,
): string {
  const local = preview.logoDataUrl.trim();
  if (local.startsWith("data:")) return local;
  const synced = (posSettings?.logoUrl ?? "").trim();
  if (!synced) return "";
  return resolveMenuMediaUrl(synced, apiOrigin);
}

export function mergeBillPrintLayout(args: {
  preview: BillPreviewSettings | null | undefined;
  posSettings: BillPrintPosContext | null;
  apiOrigin?: string | null;
}): BillPrintLayout {
  const preview = normalizeBillPreviewSettings(args.preview ?? undefined);
  const theme = getBillTheme(preview.themeId);
  const w = FONT_WEIGHT_MAP[theme.fontWeight];
  const logoSizePercent = normalizeLogoSizePercent(preview.logoSizePercent);
  const logoDims = logoDimensionsMm(logoSizePercent);
  const syncedLogo = resolveBillLogoSrc(preview, args.posSettings, args.apiOrigin);

  return {
    ...theme,
    logoSizePercent,
    themeClass: `bill-theme-${theme.id}`,
    logoSrc: preview.showLogo && syncedLogo ? syncedLogo : "",
    ...logoDims,
    restaurantDisplayName:
      preview.restaurantName.trim() ||
      args.posSettings?.displayName?.trim() ||
      "Khaanz",
    restaurantPhone: formatRestaurantPhoneDisplay(
      preview.restaurantPhone,
      args.posSettings?.whatsappPhoneE164,
    ),
    restaurantAddress: preview.restaurantAddress.trim(),
    footerNotes: preview.footerNotes.trim(),
    showLogo: preview.showLogo,
    showRestaurantName: preview.showRestaurantName,
    showPhone: preview.showPhone,
    showAddress: preview.showAddress,
    showOrderId: preview.showOrderId,
    showFooterNotes: preview.showFooterNotes,
    fontFamilyCss: FONT_FAMILY_MAP[theme.fontFamily],
    fontWeightCss: w.css,
    fontWeightNum: w.num,
  };
}
