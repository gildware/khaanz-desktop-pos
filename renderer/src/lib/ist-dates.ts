/** IST (Asia/Kolkata) date helpers for the desktop renderer. */

export function istDateParts(now: Date): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d2 = parts.find((p) => p.type === "day")?.value ?? "01";
  return { y, m, d: d2 };
}

export function istStartOfDay(now: Date): Date {
  const { y, m, d: day } = istDateParts(now);
  return new Date(`${y}-${m}-${day}T00:00:00+05:30`);
}

/** Parse YYYY-MM-DD as IST midnight start. */
export function parseIstDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date to YYYY-MM-DD in IST. */
export function formatIstDateInput(d: Date): string {
  const { y, m, d: day } = istDateParts(d);
  return `${y}-${m}-${day}`;
}

export function isOrderOnIstDate(isoString: string, dayStart: Date): boolean {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  const end = dayStart.getTime() + 24 * 60 * 60 * 1000;
  return d.getTime() >= dayStart.getTime() && d.getTime() < end;
}

function ordinalSuffix(day: number): string {
  const v = day % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** Format like "5th June 2026 07:48 pm" in IST. */
export function formatIstDateTimeLong(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const day = Number(get("day"));
  const dayLabel = Number.isFinite(day) ? `${day}${ordinalSuffix(day)}` : get("day");
  const hour = get("hour").padStart(2, "0");
  const minute = get("minute").padStart(2, "0");
  const dayPeriod = get("dayPeriod").toLowerCase();
  return `${dayLabel} ${get("month")} ${get("year")} ${hour}:${minute} ${dayPeriod}`;
}

export function formatLastSyncAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatIstDateTimeLong(d);
}
