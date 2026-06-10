import { orderLinePayloadsToReceiptLines } from "./pos-print";

export type WhatsAppOrderInput = {
  orderRef?: string | null;
  customerName: string | null;
  phone: string;
  fulfillment: string;
  scheduleMode?: string;
  scheduledAt?: string | null;
  address?: string;
  landmark?: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  deliveryChargeMinor?: number;
  lines: Array<{ sortIndex: number; payload: unknown }>;
};

const WA_ME_MAX_URL_CHARS = 6800;
const WA_TRUNCATION_SUFFIX =
  "\n\n_(Shortened for WhatsApp — your full order was already submitted.)_";

function formatCurrency(n: number): string {
  return n.toFixed(0);
}

function formatScheduleHuman(mode: string, scheduledAt: string | null | undefined): string {
  if (mode === "asap") return "As soon as possible";
  if (!scheduledAt) return "Scheduled";
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return "Scheduled";
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

export function buildWhatsAppOrderMessage(input: WhatsAppOrderInput): string {
  const {
    orderRef,
    customerName,
    phone,
    fulfillment,
    scheduleMode = "asap",
    scheduledAt = null,
    address = "",
    landmark = "",
    notes = "",
    latitude = null,
    longitude = null,
    deliveryChargeMinor = 0,
    lines,
  } = input;

  const receiptLines = orderLinePayloadsToReceiptLines(lines);
  const itemsTotal = receiptLines.reduce((sum, line) => sum + line.subtotal, 0);
  const deliveryFee =
    fulfillment === "delivery" ? Math.max(0, deliveryChargeMinor / 100) : 0;
  const grand = itemsTotal + deliveryFee;

  const whenLine =
    scheduleMode === "asap"
      ? fulfillment === "pickup"
        ? "ASAP (pick up when ready)"
        : fulfillment === "dine_in"
          ? "ASAP (dine-in)"
          : "ASAP (deliver when ready)"
      : formatScheduleHuman(scheduleMode, scheduledAt);

  const orderType =
    fulfillment === "dine_in"
      ? "Dine-in (at restaurant)"
      : fulfillment === "pickup"
        ? "Pickup (customer collects)"
        : "Delivery";

  const itemsBlock = receiptLines
    .map((line) => {
      const addonBlock =
        line.addonRows && line.addonRows.length > 0
          ? line.addonRows
              .map((a) => `  _+ ${a.name} ×${a.qty} @ ₹${formatCurrency(a.unit)}_`)
              .join("\n")
          : "";
      return `• *${line.label}*${addonBlock ? `\n${addonBlock}` : ""}\n  ${line.qty} × ₹${formatCurrency(line.unit)} = *₹${formatCurrency(line.subtotal)}*`;
    })
    .join("\n\n");

  let locationBlock = "";
  if (fulfillment === "delivery" && latitude != null && longitude != null) {
    locationBlock = `\n\n*Map*\nhttps://www.google.com/maps?q=${latitude},${longitude}`;
  }

  const addressBlock =
    fulfillment === "pickup" || fulfillment === "dine_in"
      ? ""
      : `\n\n*Address*\n${address}${landmark ? `\nLandmark: ${landmark}` : ""}`;

  const notesBlock = notes.trim().length > 0 ? `\n\n*Notes*\n${notes.trim()}` : "";

  const orderIdBlock =
    orderRef && orderRef.trim().length > 0 ? `*Order ID:* ${orderRef.trim()}\n\n` : "";

  return `*🍽 NEW ORDER*

${orderIdBlock}*Order type*
${orderType}

*When*
${whenLine}

*Customer*
Name: ${customerName?.trim() || "Guest"}
Phone: +91 ${phone}${addressBlock}${notesBlock}${locationBlock}

*Items*
${itemsBlock}
${
  deliveryFee > 0 ? `\n*Delivery fee*\n₹${formatCurrency(deliveryFee)}\n` : ""
}
*Total*
*₹${formatCurrency(grand)}*`;
}

export function buildWaMeUrl(
  message: string,
  restaurantPhoneDigits: string,
): string {
  const phone = restaurantPhoneDigits.replace(/\D/g, "");
  const base = `https://wa.me/${phone}?text=`;

  const fits = (body: string) =>
    base.length + encodeURIComponent(body).length <= WA_ME_MAX_URL_CHARS;

  if (fits(message)) {
    return base + encodeURIComponent(message);
  }

  let body = message;
  for (let i = 0; i < 48; i++) {
    const candidate =
      body.length > WA_TRUNCATION_SUFFIX.length + 40
        ? body.slice(
            0,
            Math.max(40, Math.floor(body.length * 0.82) - WA_TRUNCATION_SUFFIX.length),
          ) + WA_TRUNCATION_SUFFIX
        : body.slice(0, Math.max(0, body.length - 120)) + WA_TRUNCATION_SUFFIX;

    if (fits(candidate)) {
      return base + encodeURIComponent(candidate);
    }
    body = body.slice(0, Math.floor(body.length * 0.75));
  }

  const minimal =
    "New order — full details were received on the website. Please check your orders or contact the customer.";
  return base + encodeURIComponent(minimal);
}

export function openWhatsAppOrder(
  input: WhatsAppOrderInput,
  restaurantPhoneE164: string,
  openUrl: (url: string) => void,
): void {
  const phone = restaurantPhoneE164.replace(/\D/g, "");
  if (!phone) return;
  const message = buildWhatsAppOrderMessage(input);
  openUrl(buildWaMeUrl(message, phone));
}
