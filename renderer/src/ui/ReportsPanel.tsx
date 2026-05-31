import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3Icon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { TodaySalesReport } from "../types";
import {
  groupTopItems,
  HourlyBarChart,
  ItemsBarChart,
  ItemsPieChart,
  money,
} from "./report-charts";

type Props = {
  refreshKey?: number;
};

function ReportSection({
  title,
  subtitle,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border bg-background p-4 shadow-sm ${className}`}>
      <div className="mb-4">
        <h3 className="font-semibold text-sm">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-muted-foreground text-xs">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function ReportsPanel({ refreshKey = 0 }: Props) {
  const desktop = window.khaanzDesktop;
  const [initialLoad, setInitialLoad] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<TodaySalesReport | null>(null);

  const loadReport = useCallback(async () => {
    setError("");
    if (!desktop?.getTodaySalesReport) {
      setError("Reports are only available in the desktop app.");
      setInitialLoad(false);
      setRefreshing(false);
      return;
    }
    try {
      const out = await desktop.getTodaySalesReport();
      if (!out.ok) {
        setError(out.error);
        setReport(null);
        return;
      }
      setReport(out.report);
    } finally {
      setInitialLoad(false);
      setRefreshing(false);
    }
  }, [desktop]);

  useEffect(() => {
    void loadReport();
  }, [loadReport, refreshKey]);

  const refreshReport = useCallback(async () => {
    setRefreshing(true);
    await loadReport();
  }, [loadReport]);

  const itemsPieData = useMemo(() => {
    if (!report) return [];
    return groupTopItems(report.items, 6);
  }, [report]);

  const itemsBarData = useMemo(() => {
    if (!report) return [];
    return [...report.items]
      .sort((a, b) => b.revenueMinor - a.revenueMinor)
      .slice(0, 6)
      .map((row) => ({
        name: row.label.length > 16 ? `${row.label.slice(0, 14)}…` : row.label,
        revenue: row.revenueMinor / 100,
        quantity: row.quantity,
      }));
  }, [report]);

  const hourlyChartData = useMemo(() => {
    if (!report) return [];
    return report.hourly.map((row) => ({
      label: row.label,
      sales: row.totalMinor / 100,
      orders: row.orderCount,
    }));
  }, [report]);

  if (initialLoad) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3Icon className="size-5 text-primary" />
            <h2 className="font-semibold text-lg">Today&apos;s report</h2>
          </div>
          {report ? (
            <p className="mt-1 text-muted-foreground text-sm">
              {report.dateLabel}
              <span className="mx-2">·</span>
              <span
                className={
                  report.source === "server"
                    ? "text-emerald-700"
                    : "text-amber-700"
                }
              >
                {report.source === "server" ? "Live from server" : "Local cache"}
              </span>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void refreshReport()}
          disabled={refreshing}
          className="inline-flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-sm disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : !report ? (
          <p className="text-muted-foreground text-sm">No report data available.</p>
        ) : (
          <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border bg-gradient-to-br from-blue-500/15 via-background to-background p-4 shadow-sm">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">
                  Total sales
                </p>
                <p className="mt-2 font-semibold text-2xl tabular-nums">
                  {money(report.summary.totalSalesMinor)}
                </p>
              </div>
              <div className="rounded-xl border bg-gradient-to-br from-emerald-500/15 via-background to-background p-4 shadow-sm">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">
                  Orders
                </p>
                <p className="mt-2 font-semibold text-2xl tabular-nums">
                  {report.summary.orderCount}
                </p>
              </div>
              <div className="rounded-xl border bg-gradient-to-br from-violet-500/15 via-background to-background p-4 shadow-sm">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">
                  Avg ticket
                </p>
                <p className="mt-2 font-semibold text-2xl tabular-nums">
                  {money(report.summary.averageTicketMinor)}
                </p>
              </div>
              <div className="rounded-xl border bg-gradient-to-br from-rose-500/10 via-background to-background p-4 shadow-sm">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">
                  Cancelled
                </p>
                <p className="mt-2 font-semibold text-2xl tabular-nums">
                  {report.summary.cancelledCount}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <ReportSection
                title="Item revenue share"
                subtitle="Top items by revenue"
                className="min-w-0"
              >
                {itemsPieData.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No item sales recorded today.</p>
                ) : (
                  <ItemsPieChart data={itemsPieData} height={240} compact />
                )}
              </ReportSection>

              <ReportSection
                title="Hourly sales"
                subtitle="Sales & orders by hour (IST)"
                className="min-w-0"
              >
                {hourlyChartData.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No hourly sales yet today.</p>
                ) : (
                  <HourlyBarChart data={hourlyChartData} height={240} compact />
                )}
              </ReportSection>

              <ReportSection
                title="Top items"
                subtitle="Revenue & quantity (top 6)"
                className="min-w-0"
              >
                {itemsBarData.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No item sales recorded today.</p>
                ) : (
                  <ItemsBarChart data={itemsBarData} height={240} compact />
                )}
              </ReportSection>
            </div>

            {report.items.length > 0 ? (
              <ReportSection title="All items sold" subtitle="Full breakdown for today">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[24rem] text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground text-xs">
                        <th className="pb-2 font-medium">Item</th>
                        <th className="pb-2 text-right font-medium">Qty</th>
                        <th className="pb-2 text-right font-medium">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.items.map((row) => (
                        <tr key={row.key} className="border-b border-border/50 last:border-0">
                          <td className="py-2.5">{row.label}</td>
                          <td className="py-2.5 text-right tabular-nums">{row.quantity}</td>
                          <td className="py-2.5 text-right tabular-nums">
                            {money(row.revenueMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ReportSection>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
