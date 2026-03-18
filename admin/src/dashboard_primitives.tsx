import {
  ResponsiveContainer,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis
} from "recharts";

import {
  CHART_THEME,
  DECISION_OPTIONS,
  FILE_RULE_OPERATION_OPTIONS,
  OPERATION_TEXT,
  decisionLabel,
  ui,
  withLabel
} from "./dashboard_core.ts";

type DecisionTagProps = {
  decision?: string | null;
};

type FileRuleOperationSelectorProps = {
  operations?: unknown;
  onToggle: (operation: string) => void;
};

type OverviewStatCardProps = {
  label: string;
  value: string | number;
  tone?: string;
  onClick?: () => void;
};

type ChartTooltipEntry = {
  dataKey?: string;
  name?: string;
  value?: string | number;
};

type ChartTooltipProps = {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string;
};

type DistributionChartItem = {
  label: string;
  count: number;
  color?: string;
};

type DistributionChartProps = {
  title: string;
  subtitle: string;
  items: DistributionChartItem[];
  total: number;
  emptyText: string;
  theme: string;
};

function trimLabel(value: string | undefined | null, max = 10): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function normalizeFileRuleOperations(operations: unknown): string[] {
  if (!Array.isArray(operations)) {
    return [];
  }
  return Array.from(
    new Set(
      operations
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => FILE_RULE_OPERATION_OPTIONS.includes(entry))
    )
  ).sort(
    (left, right) => FILE_RULE_OPERATION_OPTIONS.indexOf(left) - FILE_RULE_OPERATION_OPTIONS.indexOf(right)
  );
}

export function ToolbarIconSystem() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="11" rx="2.5" />
      <path d="M9 19h6" />
      <path d="M12 16v3" />
    </svg>
  );
}

export function ToolbarIconSun() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5" />
      <path d="M12 19v2.5" />
      <path d="M4.5 12H2" />
      <path d="M22 12h-2.5" />
      <path d="M5.8 5.8 4 4" />
      <path d="M20 20l-1.8-1.8" />
      <path d="M18.2 5.8 20 4" />
      <path d="M4 20l1.8-1.8" />
    </svg>
  );
}

export function ToolbarIconMoon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 14.5A6.5 6.5 0 0 1 9.5 7a7.5 7.5 0 1 0 7.5 7.5Z" />
    </svg>
  );
}

export function ToolbarMonogram({ text }: { text: string }) {
  return (
    <span className="toolbar-monogram" aria-hidden="true">
      {text}
    </span>
  );
}

export function DecisionTag({ decision }: DecisionTagProps) {
  return <span className={`tag ${decision || "allow"}`}>{decisionLabel(decision)}</span>;
}

export function FileRuleOperationSelector({ operations, onToggle }: FileRuleOperationSelectorProps) {
  const normalizedOperations = normalizeFileRuleOperations(operations);
  const appliesToAll = normalizedOperations.length === 0;
  return (
    <div className="file-rule-operation-group" role="group" aria-label={ui("适用操作", "Applies to operations")}>
      <button
        className={`file-rule-operation-chip ${appliesToAll ? "active" : ""}`}
        type="button"
        onClick={() => onToggle("__all__")}
        aria-pressed={appliesToAll}
      >
        {ui("全部", "All")}
      </button>
      {FILE_RULE_OPERATION_OPTIONS.map((operation) => (
        <button
          key={operation}
          className={`file-rule-operation-chip ${normalizedOperations.includes(operation) ? "active" : ""}`}
          type="button"
          onClick={() => onToggle(operation)}
          aria-pressed={normalizedOperations.includes(operation)}
        >
          {withLabel(operation, OPERATION_TEXT)}
        </button>
      ))}
    </div>
  );
}

export function OverviewStatCard({ label, value, tone, onClick }: OverviewStatCardProps) {
  return (
    <div className={`stat ${tone || ""}`}>
      <div className="stat-head">
        <b>{label}</b>
      </div>
      {typeof onClick === "function" ? (
        <button
          className="stat-value-button"
          type="button"
          onClick={onClick}
          aria-label={`${label}: ${value}`}
          title={label}
        >
          {value}
        </button>
      ) : (
        <span className="stat-value">{value}</span>
      )}
    </div>
  );
}

export function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{label || payload[0]?.name || ui("明细", "Details")}</div>
      {payload.map((entry, index) => (
        <div key={`${entry.dataKey || entry.name || "value"}-${index}`} className="chart-tooltip-row">
          <span className="chart-tooltip-key">{entry.name || entry.dataKey}</span>
          <span className="chart-tooltip-value">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export function DistributionChart({ title, subtitle, items, total, emptyText, theme }: DistributionChartProps) {
  const chartTheme = CHART_THEME[theme as keyof typeof CHART_THEME] || CHART_THEME.light;
  const data = items.map((item) => ({
    name: item.label,
    value: item.count,
    color: item.color,
    percent: total > 0 ? Math.round((item.count / total) * 100) : 0
  }));
  const height = 270;

  return (
    <article className="panel-card chart-card">
      <div className="chart-head">
        <h3>{title}</h3>
        <span className="chart-subtitle">{subtitle}</span>
      </div>
      {data.length === 0 ? (
        <div className="chart-empty">{emptyText}</div>
      ) : (
        <div className="chart-surface">
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 4, right: 8, left: 6, bottom: 34 }}>
              <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
              <YAxis
                allowDecimals={false}
                tick={{ fill: chartTheme.tick, fontSize: 12 }}
                axisLine={{ stroke: chartTheme.axis }}
                tickLine={false}
              />
              <XAxis
                dataKey="name"
                tick={{ fill: chartTheme.tick, fontSize: 12 }}
                tickFormatter={(value) => trimLabel(value, 8)}
                interval={0}
                axisLine={{ stroke: chartTheme.axis }}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="value" name={ui("次数", "Count")} radius={[6, 6, 0, 0]} maxBarSize={54}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color ?? chartTheme.total} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </article>
  );
}
