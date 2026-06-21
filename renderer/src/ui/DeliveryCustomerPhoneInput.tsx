import React, { useCallback, useEffect, useRef, useState } from "react";

export type DeliveryCustomerSuggestion = {
  phoneDigits: string;
  displayName: string;
  address: string;
  landmark: string;
};

type Props = {
  id?: string;
  phone: string;
  enabled: boolean;
  onPhoneChange: (phone: string) => void;
  onSelectCustomer: (customer: DeliveryCustomerSuggestion) => void;
  fetchSuggestions: (query: string) => Promise<DeliveryCustomerSuggestion[]>;
  className?: string;
};

export function DeliveryCustomerPhoneInput({
  id,
  phone,
  enabled,
  onPhoneChange,
  onSelectCustomer,
  fetchSuggestions,
  className,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<DeliveryCustomerSuggestion[]>(
    [],
  );

  const loadSuggestions = useCallback(
    async (query: string) => {
      if (!enabled) {
        setSuggestions([]);
        return;
      }
      setLoading(true);
      try {
        const rows = await fetchSuggestions(query);
        setSuggestions(Array.isArray(rows) ? rows : []);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    },
    [enabled, fetchSuggestions],
  );

  useEffect(() => {
    if (!enabled || !open) return;
    const t = window.setTimeout(() => {
      void loadSuggestions(phone);
    }, phone.length > 0 ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [enabled, open, phone, loadSuggestions]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const showDropdown = enabled && open && (loading || suggestions.length > 0);

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        value={phone}
        onChange={(e) => {
          onPhoneChange(e.target.value.replace(/\D/g, "").slice(0, 10));
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Phone"
        autoComplete="off"
        className="h-8 w-full rounded border bg-white px-2 text-sm"
      />
      {showDropdown ? (
        <ul className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg">
          {loading && suggestions.length === 0 ? (
            <li className="px-3 py-2 text-zinc-500">Searching…</li>
          ) : null}
          {suggestions.map((c) => (
            <li key={c.phoneDigits}>
              <button
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-zinc-100"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelectCustomer(c);
                  setOpen(false);
                }}
              >
                <span className="font-medium text-zinc-900">{c.displayName}</span>
                <span className="tabular-nums text-zinc-500">{c.phoneDigits}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
