/** Turn menu paths from sync into absolute URLs the renderer can load. */
export function resolveMenuMediaUrl(
  url: string | undefined | null,
  apiOrigin: string | null | undefined,
): string {
  const s = String(url || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || s.startsWith("data:")) return s;
  const origin = String(apiOrigin || "").trim().replace(/\/$/, "");
  if (!origin) return s;
  if (s.startsWith("/")) return `${origin}${s}`;
  return `${origin}/${s}`;
}
