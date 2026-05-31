import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const CHART_COLORS = [
  "#2563eb",
  "#16a34a",
  "#f97316",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#64748b",
  "#ec4899",
  "#0ea5e9",
];

export function money(minor: number) {
  return `₹${(Number(minor || 0) / 100).toFixed(2)}`;
}

export function moneyFromRupees(rupees: number) {
  return `₹${Number(rupees || 0).toFixed(2)}`;
}

type TooltipPayload = {
  name?: string;
  value?: number;
  payload?: Record<string, unknown>;
};

function ChartTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  valueFormatter: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-background px-3 py-2 text-xs shadow-md">
      {label ? <p className="mb-1 font-medium text-foreground">{label}</p> : null}
      <ul className="space-y-0.5">
        {payload.map((entry, i) => (
          <li key={i} className="flex justify-between gap-4 tabular-nums">
            <span className="text-muted-foreground">{entry.name}</span>
            <span className="font-medium">
              {valueFormatter(Number(entry.value ?? 0), String(entry.name ?? ""))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function groupTopItems<T extends { label: string; revenueMinor: number; quantity: number }>(
  items: T[],
  topN: number,
): Array<{ name: string; value: number; quantity: number; fill?: string }> {
  const sorted = [...items].sort((a, b) => b.revenueMinor - a.revenueMinor);
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const rows = top.map((row, i) => ({
    name: row.label.length > 28 ? `${row.label.slice(0, 26)}…` : row.label,
    value: row.revenueMinor / 100,
    quantity: row.quantity,
    fill: CHART_COLORS[i % CHART_COLORS.length],
  }));
  if (rest.length > 0) {
    const otherRevenue = rest.reduce((s, r) => s + r.revenueMinor, 0);
    const otherQty = rest.reduce((s, r) => s + r.quantity, 0);
    rows.push({
      name: "Other",
      value: otherRevenue / 100,
      quantity: otherQty,
      fill: CHART_COLORS[topN % CHART_COLORS.length],
    });
  }
  return rows;
}

export function ItemsPieChart({
  data,
  height = 280,
  compact = false,
}: {
  data: Array<{ name: string; value: number; quantity: number }>;
  height?: number;
  compact?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Tooltip
          content={(props) => (
            <ChartTooltip
              {...props}
              valueFormatter={(v, name) => {
                const row = data.find((d) => d.name === name);
                const qty = row?.quantity ?? 0;
                return `${moneyFromRupees(v)} · ${qty} sold`;
              }}
            />
          )}
        />
        <Legend
          verticalAlign="bottom"
          height={compact ? 40 : 56}
          formatter={(value) => (
            <span className="text-foreground text-xs">{String(value)}</span>
          )}
        />
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy={compact ? "40%" : "42%"}
          outerRadius={compact ? "68%" : "76%"}
          paddingAngle={1}
          stroke="var(--background)"
          strokeWidth={2}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.fill ?? CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

export function HourlyBarChart({
  data,
  height = 300,
  compact = false,
}: {
  data: Array<{ label: string; sales: number; orders: number }>;
  height?: number;
  compact?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        margin={
          compact
            ? { top: 8, right: 4, left: 0, bottom: 4 }
            : { top: 12, right: 12, left: 4, bottom: 8 }
        }
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: compact ? 9 : 11 }}
          tickLine={false}
          axisLine={false}
          interval={compact ? "preserveStartEnd" : 0}
        />
        <YAxis
          yAxisId="sales"
          tick={{ fontSize: compact ? 9 : 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => (compact && v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`)}
          width={compact ? 40 : 52}
        />
        <YAxis
          yAxisId="orders"
          orientation="right"
          tick={{ fontSize: compact ? 9 : 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          width={compact ? 24 : 36}
        />
        <Tooltip
          content={(props) => (
            <ChartTooltip
              {...props}
              valueFormatter={(v, name) =>
                name === "Orders" ? String(Math.round(v)) : moneyFromRupees(v)
              }
            />
          )}
        />
        {!compact ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
        <Bar
          yAxisId="sales"
          dataKey="sales"
          name="Sales"
          fill="#2563eb"
          radius={[4, 4, 0, 0]}
          maxBarSize={compact ? 28 : 48}
        />
        <Bar
          yAxisId="orders"
          dataKey="orders"
          name="Orders"
          fill="#16a34a"
          radius={[4, 4, 0, 0]}
          maxBarSize={compact ? 18 : 32}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ItemsBarChart({
  data,
  height = 320,
  compact = false,
}: {
  data: Array<{ name: string; revenue: number; quantity: number }>;
  height?: number;
  compact?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={
          compact
            ? { top: 4, right: 8, left: 0, bottom: 4 }
            : { top: 8, right: 16, left: 8, bottom: 8 }
        }
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: compact ? 9 : 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => (compact && v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`)}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={compact ? 72 : 120}
          tick={{ fontSize: compact ? 9 : 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          content={(props) => (
            <ChartTooltip
              {...props}
              valueFormatter={(v, name) =>
                name === "Qty" ? String(Math.round(v)) : moneyFromRupees(v)
              }
            />
          )}
        />
        {!compact ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
        <Bar
          dataKey="revenue"
          name="Revenue"
          fill="#2563eb"
          radius={[0, 4, 4, 0]}
          maxBarSize={compact ? 14 : 22}
        />
        <Bar
          dataKey="quantity"
          name="Qty"
          fill="#94a3b8"
          radius={[0, 4, 4, 0]}
          maxBarSize={compact ? 10 : 16}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
