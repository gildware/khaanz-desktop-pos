/** Reserved walk-in / POS orders when no phone is provided (valid Indian mobile pattern). */
export const POS_ANONYMOUS_PHONE_DIGITS = "6000000000";

/** Normalize Indian checkout mobile to 10 digits (no country code). */
export function normalizeIndianMobileDigits(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d;
}

export function isIndianMobile10(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits);
}

export function buildDeliveryFooterNote(address: string, landmark: string): string {
  const parts: string[] = [];
  const a = address.trim();
  const l = landmark.trim();
  if (a) parts.push(`Address: ${a}`);
  if (l) parts.push(`Landmark: ${l}`);
  return parts.join("\n");
}
