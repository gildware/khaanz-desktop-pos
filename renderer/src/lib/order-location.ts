import type { RecentOrderRow, TravelDistance } from "../types";

export function formatTravelDistanceLabel(distance: TravelDistance): string {
  if (distance.durationText) {
    return `${distance.text} · ${distance.durationText} drive`;
  }
  if (distance.estimated) {
    return `${distance.text} (straight line)`;
  }
  return distance.text;
}

export function parseOrderCoords(
  row: Pick<RecentOrderRow, "latitude" | "longitude">,
): { lat: number; lng: number } | null {
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function buildCustomerMapUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function buildMapSearchUrlFromAddress(address: string): string {
  const params = new URLSearchParams({
    api: "1",
    query: address.trim(),
  });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

/** Pin on the customer's delivery location (not driving directions). */
export function resolveCustomerMapUrl(row: RecentOrderRow): string | null {
  const fromLocation =
    typeof row.locationUrl === "string" && row.locationUrl.trim()
      ? row.locationUrl.trim()
      : null;
  if (fromLocation) return fromLocation;

  const coords = parseOrderCoords(row);
  if (coords) return buildCustomerMapUrl(coords.lat, coords.lng);

  const address = row.address?.trim() ?? "";
  if (address) return buildMapSearchUrlFromAddress(address);

  return null;
}

/** Fill map links and numeric coords when the server/cache omitted them. */
export function enrichOrderLocation(row: RecentOrderRow): RecentOrderRow {
  const coords = parseOrderCoords(row);
  const customerMapUrl = resolveCustomerMapUrl({
    ...row,
    latitude: coords?.lat ?? row.latitude ?? null,
    longitude: coords?.lng ?? row.longitude ?? null,
  });

  return {
    ...row,
    latitude: coords?.lat ?? row.latitude ?? null,
    longitude: coords?.lng ?? row.longitude ?? null,
    locationUrl: customerMapUrl,
    mapUrl: customerMapUrl,
  };
}

export async function hydrateOrderDistance(
  row: RecentOrderRow,
  apiOrigin: string | null,
): Promise<RecentOrderRow> {
  if (row.distance || row.fulfillment !== "delivery") return row;
  const coords = parseOrderCoords(row);
  if (!coords || !apiOrigin?.trim()) return row;

  try {
    const base = apiOrigin.replace(/\/$/, "");
    const res = await fetch(
      `${base}/api/distance?lat=${coords.lat}&lng=${coords.lng}`,
    );
    if (!res.ok) return row;
    const data = (await res.json()) as { distance?: TravelDistance | null };
    if (!data.distance) return row;
    return { ...row, distance: data.distance };
  } catch {
    return row;
  }
}

export async function hydrateOrdersWithDistance(
  rows: RecentOrderRow[],
  apiOrigin: string | null,
  desktop?: { hydrateOrderDistances?: (orders: RecentOrderRow[]) => Promise<{
    ok: boolean;
    orders?: RecentOrderRow[];
    travelDistanceConfigured?: boolean;
    error?: string;
  }> },
): Promise<{ rows: RecentOrderRow[]; travelDistanceConfigured?: boolean }> {
  if (desktop?.hydrateOrderDistances) {
    const out = await desktop.hydrateOrderDistances(rows);
    if (out.ok && Array.isArray(out.orders)) {
      return {
        rows: out.orders.map((o) => enrichOrderLocation(o)),
        travelDistanceConfigured: out.travelDistanceConfigured,
      };
    }
  }
  if (!apiOrigin?.trim()) return { rows };
  const hydrated = await Promise.all(rows.map((row) => hydrateOrderDistance(row, apiOrigin)));
  return { rows: hydrated };
}
