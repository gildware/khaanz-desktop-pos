import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

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

type DropdownRect = {
  top: number;
  left: number;
  width: number;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<DeliveryCustomerSuggestion[]>(
    [],
  );
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null);

  const updateDropdownRect = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      setDropdownRect(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setDropdownRect({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, []);

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

  useLayoutEffect(() => {
    if (!open) {
      setDropdownRect(null);
      return;
    }
    updateDropdownRect();
    const onLayout = () => updateDropdownRect();
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  }, [open, phone, suggestions.length, loading, updateDropdownRect]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const showDropdown = enabled && open;
  const showEmptyState = !loading && suggestions.length === 0;

  const dropdown =
    showDropdown && dropdownRect
      ? createPortal(
          <ul
            ref={dropdownRef}
            role="listbox"
            className="fixed z-[300] max-h-52 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg"
            style={{
              top: dropdownRect.top,
              left: dropdownRect.left,
              width: dropdownRect.width,
            }}
          >
            {loading ? (
              <li className="px-3 py-2 text-zinc-500">Searching…</li>
            ) : null}
            {!loading
              ? suggestions.map((c) => (
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
                      <span className="font-medium text-zinc-900">
                        {c.displayName}
                      </span>
                      <span className="tabular-nums text-zinc-500">
                        {c.phoneDigits}
                      </span>
                    </button>
                  </li>
                ))
              : null}
            {showEmptyState ? (
              <li className="px-3 py-2 text-zinc-500">
                No past delivery customers found
              </li>
            ) : null}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <input
        ref={inputRef}
        id={id}
        type="tel"
        inputMode="numeric"
        value={phone}
        onChange={(e) => {
          onPhoneChange(e.target.value.replace(/\D/g, "").slice(0, 10));
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Phone — search past customers"
        autoComplete="off"
        className="h-8 w-full rounded border bg-white px-2 text-sm"
      />
      {dropdown}
    </div>
  );
}
