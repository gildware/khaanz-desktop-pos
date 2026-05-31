import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, Loader2Icon, ServerIcon } from "lucide-react";

type BackendConfigApi = {
  getBackendConfig: () => Promise<
    | {
        ok: true;
        apiOrigin: string;
        syncKey: string;
        configured: boolean;
        userDataEnvPath: string;
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
        lastMenuPullAt?: string | null;
      }
    | { ok: false; error: string }
  >;
  testBackendConfig: (
    apiOrigin: string,
    syncKey: string,
  ) => Promise<{ ok: true; online: boolean; apiOrigin: string } | { ok: false; error: string }>;
};

type Props = {
  api: BackendConfigApi;
  /** Called after save succeeds (refresh boot state, menu, etc.). */
  onSaved?: (info: {
    apiOrigin: string;
    syncConfigured: boolean;
    lastMenuPullAt?: string | null;
  }) => void;
  /** Shorter copy for the login screen. */
  variant?: "login" | "settings";
};

function domainInputFromOrigin(origin: string) {
  return origin.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function BackendConnectionPanel({ api, onSaved, variant = "settings" }: Props) {
  const [domain, setDomain] = useState("");
  const [syncKey, setSyncKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [connectedOrigin, setConnectedOrigin] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await api.getBackendConfig();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDomain(domainInputFromOrigin(r.apiOrigin));
      setSyncKey(r.syncKey);
      setConnectedOrigin(r.configured ? r.apiOrigin : null);
      setTestOk(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTest() {
    setBusy(true);
    setError("");
    setMessage("");
    setTestOk(null);
    try {
      const r = await api.testBackendConfig(domain, syncKey);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTestOk(true);
      setMessage("Connection successful — your server responded.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await api.saveBackendConfig(domain, syncKey);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConnectedOrigin(r.apiOrigin);
      setTestOk(true);
      setMessage("Saved and connected. Menu will sync from your site.");
      onSaved?.({
        apiOrigin: r.apiOrigin,
        syncConfigured: r.syncConfigured,
        lastMenuPullAt: r.lastMenuPullAt,
      });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />
        Loading connection…
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <ServerIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-sm">
            {variant === "login" ? "Connect to your Khaanz site" : "Backend connection"}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {variant === "login"
              ? "Link this register to your live menu and orders. Use the same domain as your website and the sync key from server env (POS_SYNC_KEY)."
              : "Domain and sync key are stored on this computer. They must match POS_SYNC_KEY on your Khaanz server."}
          </p>
          {connectedOrigin ? (
            <p className="flex items-center gap-1.5 text-emerald-700 text-xs dark:text-emerald-400">
              <CheckCircle2Icon className="size-3.5 shrink-0" />
              Connected to <span className="font-medium">{connectedOrigin}</span>
            </p>
          ) : null}
        </div>
      </div>

      <label className="grid gap-1.5">
        <span className="font-medium text-sm">Site domain</span>
        <div className="flex overflow-hidden rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring/30">
          <span className="flex items-center border-r bg-muted/50 px-3 text-muted-foreground text-sm">
            https://
          </span>
          <input
            type="text"
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value.replace(/^https?:\/\//i, "").trim());
              setTestOk(null);
            }}
            placeholder="your-restaurant.com"
            disabled={busy}
            className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </label>

      <label className="grid gap-1.5">
        <span className="font-medium text-sm">Sync key</span>
        <input
          type="password"
          value={syncKey}
          onChange={(e) => {
            setSyncKey(e.target.value);
            setTestOk(null);
          }}
          placeholder="Same as POS_SYNC_KEY on server"
          disabled={busy}
          className="h-10 rounded-lg border bg-background px-3 text-sm"
          autoComplete="off"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={busy || !domain.trim() || !syncKey.trim()}
          className="inline-flex h-9 items-center justify-center rounded-lg border bg-background px-4 text-sm disabled:opacity-50"
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : "Test connection"}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !domain.trim() || !syncKey.trim()}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-50"
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : "Save & connect"}
        </button>
      </div>

      {message ? <p className="text-emerald-700 text-sm dark:text-emerald-400">{message}</p> : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {testOk && !message ? (
        <p className="text-emerald-700 text-xs dark:text-emerald-400">Server reachable.</p>
      ) : null}
    </div>
  );
}
