import React from "react";
import {
  ResponsiveContainer,
  Tooltip,
  Legend,
  CartesianGrid,
  XAxis,
  YAxis,
  LineChart,
  Line
} from "recharts";

import type { AdminDecisionFilterId, AdminTabId } from "../../src/admin/dashboard_url_state.ts";
import type { SkillSummary } from "../../src/admin/skill_interception_store.ts";
import type { DecisionHistoryRecord } from "../../src/admin/server_types.ts";
import type { SecurityClawLocale } from "../../src/i18n/locale.ts";
import type { AccountPolicyMode, AccountPolicyRecord, Decision } from "../../src/types.ts";
import { ui } from "./dashboard_core.ts";
import type { DashboardTheme, DashboardThemePreference } from "./dashboard_core.ts";
import {
  ChartTooltip,
  DecisionTag,
  DistributionChart,
  OverviewStatCard,
} from "./dashboard_primitives.tsx";

type DistributionItem = {
  label: string;
  count: number;
  color?: string;
};

type TrendPoint = {
  time: string;
  total: number;
  risk: number;
};

type ThemeControl = {
  value: DashboardThemePreference;
  label: string;
  icon: React.ReactNode;
};

type LocaleControl = {
  value: SecurityClawLocale;
  label: string;
  icon: React.ReactNode;
};

type ChartTheme = {
  grid: string;
  axis: string;
  tick: string;
  total: string;
  risk: string;
};

type OverviewStats = {
  total: number;
  allow: number;
  warn: number;
  challenge: number;
  block: number;
};

type SkillOverviewStats = {
  total: number;
  high_critical: number;
  challenge_block_24h: number;
  drift_alerts: number;
  quarantined: number;
  trusted_overrides: number;
};

type DashboardShellProps = {
  brandText: string;
  locale: SecurityClawLocale;
  activeTab: AdminTabId;
  tabItems: Array<{ id: AdminTabId }>;
  tabCounts: Record<AdminTabId, number>;
  tabLabel: (tabId: AdminTabId) => string;
  onTabSelect: (tabId: AdminTabId) => void;
  themePreference: DashboardThemePreference;
  themeControls: ThemeControl[];
  onThemeSelect: (value: DashboardThemePreference) => void;
  localeControls: LocaleControl[];
  onLocaleSelect: (value: SecurityClawLocale) => void;
  shouldShowStatus: boolean;
  statusTone: string;
  statusMessage: string;
  children: React.ReactNode;
};

type OverviewPanelProps = {
  stats: OverviewStats;
  postureTitle: string;
  postureDescription: string;
  groupedPolicyCount: number;
  policyCount: number;
  skillPostureTitle: string;
  skillPostureDescription: string;
  skillOverviewStats: SkillOverviewStats;
  skillOverviewHighlights: SkillSummary[];
  messageSourceDistribution: DistributionItem[];
  decisionSourceDistribution: DistributionItem[];
  strategyHitDistribution: DistributionItem[];
  strategySourceCount: number;
  strategyHitTotal: number;
  toolDistribution: DistributionItem[];
  analyticsSampleCount: number;
  theme: DashboardTheme;
  chartTheme: ChartTheme;
  trendRangeLabel: string;
  trendBucketHours: number;
  trendData: TrendPoint[];
  trendTickStep: number;
  trendTotalCount: number;
  trendRiskCount: number;
  trendPeak: number;
  formatPercent: (value: number, total: number) => string;
  formatTime: (value: string | null | undefined) => string;
  skillRiskLabel: (value: string | null | undefined) => string;
  skillSourceLabel: (value: string | null | undefined, detail?: string | null) => string;
  onOpenDecisionRecords: (filter: AdminDecisionFilterId) => void;
  onOpenSkillWorkspace: (skillId?: string) => void;
};

type EventsPanelProps = {
  hasActiveDecisionFilter: boolean;
  decisionFilter: AdminDecisionFilterId;
  decisionFilterLabel: (value: AdminDecisionFilterId) => string;
  decisionFilterOptions: Array<{ value: AdminDecisionFilterId; count: number }>;
  decisionFilterSummary: string;
  filteredDecisionTotal: number;
  loading: boolean;
  decisionLoading: boolean;
  pagedDecisions: DecisionHistoryRecord[];
  firstDecisionIndex: number;
  lastDecisionIndex: number;
  decisionPage: number;
  totalDecisionPages: number;
  pageItems: number[];
  formatTime: (value: string | null | undefined) => string;
  decisionSourceLabel: (value: string | null | undefined) => string;
  resourceScopeLabel: (value: string | null | undefined) => string;
  onRefresh: () => void | Promise<void>;
  onSelectDecisionFilter: (filterId: AdminDecisionFilterId) => void;
  onNavigatePage: (page: number) => void;
};

type AccountsPanelProps = {
  accountCount: number;
  displayAccounts: AccountPolicyRecord[];
  selectedAdminSubject: string;
  accountPrimaryLabel: (account: Partial<AccountPolicyRecord> | null | undefined) => string;
  accountModeLabel: (mode: AccountPolicyMode | string | null | undefined) => string;
  accountMetaLabel: (account: Partial<AccountPolicyRecord> | null | undefined) => string;
  onUpdateAccountPolicy: (subject: string, patch: Partial<AccountPolicyRecord>) => void;
  onSetAdminAccount: (subject: string) => void;
};

export function DashboardShell({
  brandText,
  locale,
  activeTab,
  tabItems,
  tabCounts,
  tabLabel,
  onTabSelect,
  themePreference,
  themeControls,
  onThemeSelect,
  localeControls,
  onLocaleSelect,
  shouldShowStatus,
  statusTone,
  statusMessage,
  children,
}: DashboardShellProps) {
  return (
    <div className="app">
      <section className="workspace card">
        <div className="workspace-top">
          <div className="workspace-title">
            <div className="workspace-kicker">
              <img src="/favicon.svg" alt="" className="workspace-favicon" aria-hidden="true" />
              {brandText}
            </div>
            <h1>{ui("管理后台", "Admin Dashboard")}</h1>
            <div className="tablist" role="tablist" aria-label={ui("后台模块页签", "Dashboard tabs")}>
              {tabItems.map((tab) => (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`panel-${tab.id}`}
                  onClick={() => onTabSelect(tab.id)}
                >
                  <span className="tab-label">{tabLabel(tab.id)}</span>
                  <span className="tab-count">{tabCounts[tab.id]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-controls">
            <div className="control-group" role="group" aria-label={ui("外观设置", "Appearance settings")}>
              {themeControls.map((item) => (
                <button
                  key={item.value}
                  className={`toolbar-icon-button ${themePreference === item.value ? "active" : ""}`}
                  type="button"
                  aria-label={item.label}
                  aria-pressed={themePreference === item.value}
                  title={item.label}
                  onClick={() => onThemeSelect(item.value)}
                >
                  {item.icon}
                </button>
              ))}
            </div>
            <div className="control-group" role="group" aria-label={ui("语言设置", "Language settings")}>
              {localeControls.map((item) => (
                <button
                  key={item.value}
                  className={`toolbar-icon-button toolbar-icon-button-text ${locale === item.value ? "active" : ""}`}
                  type="button"
                  aria-label={item.label}
                  aria-pressed={locale === item.value}
                  title={item.label}
                  onClick={() => onLocaleSelect(item.value)}
                >
                  {item.icon}
                </button>
              ))}
            </div>
          </div>
        </div>

        {shouldShowStatus ? (
          <div className={`status-inline status-banner ${statusTone}`}>
            <span className="status-dot" />
            <span>{statusMessage}</span>
          </div>
        ) : null}

        {children}
      </section>
    </div>
  );
}

export function OverviewPanel({
  stats,
  postureTitle,
  postureDescription,
  groupedPolicyCount,
  policyCount,
  skillPostureTitle,
  skillPostureDescription,
  skillOverviewStats,
  skillOverviewHighlights,
  messageSourceDistribution,
  decisionSourceDistribution,
  strategyHitDistribution,
  strategySourceCount,
  strategyHitTotal,
  toolDistribution,
  analyticsSampleCount,
  theme,
  chartTheme,
  trendRangeLabel,
  trendBucketHours,
  trendData,
  trendTickStep,
  trendTotalCount,
  trendRiskCount,
  trendPeak,
  formatPercent,
  formatTime,
  skillRiskLabel,
  skillSourceLabel,
  onOpenDecisionRecords,
  onOpenSkillWorkspace,
}: OverviewPanelProps) {
  return (
    <section
      id="panel-overview"
      className="tab-panel overview-panel"
      role="tabpanel"
      aria-labelledby="tab-overview"
    >
      <div className="panel-card overview-shell dashboard-panel">
        <div className="card-head">
          <h2>{ui("概览", "Overview")}</h2>
        </div>
        <div className="overview-grid">
          <div className="panel-card">
            <div className="stats">
              <OverviewStatCard label={ui("决策记录", "Decision Records")} value={stats.total} onClick={() => onOpenDecisionRecords("all")} />
              <OverviewStatCard label={ui("放行", "Allow")} value={stats.allow} tone="good" onClick={() => onOpenDecisionRecords("allow")} />
              <OverviewStatCard label={ui("提醒", "Warn")} value={stats.warn} tone="warn" onClick={() => onOpenDecisionRecords("warn")} />
              <OverviewStatCard label={ui("需确认", "Needs Approval")} value={stats.challenge} tone="warn" onClick={() => onOpenDecisionRecords("challenge")} />
              <OverviewStatCard label={ui("拦截", "Block")} value={stats.block} tone="bad" onClick={() => onOpenDecisionRecords("block")} />
            </div>
          </div>

          <aside className="panel-card insight-card">
            <div className="insight-head">
              <span className="eyebrow">{ui("当前态势", "Current Posture")}</span>
              <h3>{postureTitle}</h3>
              <p>{postureDescription}</p>
            </div>
            <div className="insight-list">
              <div className="insight-item">
                <span>{ui("需确认占比", "Approval Ratio")}</span>
                <strong>{formatPercent(stats.challenge, stats.total)}</strong>
              </div>
              <div className="insight-item">
                <span>{ui("拦截占比", "Block Ratio")}</span>
                <strong>{formatPercent(stats.block, stats.total)}</strong>
              </div>
              <div className="insight-item">
                <span>{ui("规则分组", "Rule Groups")}</span>
                <strong>{groupedPolicyCount}</strong>
              </div>
              <div className="insight-item">
                <span>{ui("生效规则", "Active Rules")}</span>
                <strong>{policyCount}</strong>
              </div>
            </div>
          </aside>

          <article className="panel-card overview-skill-card">
            <div className="overview-skill-head">
              <div>
                <span className="eyebrow">{ui("Skill 拦截", "Skill Interception")}</span>
                <h3>{skillPostureTitle}</h3>
                <p>{skillPostureDescription}</p>
              </div>
              <button className="ghost small" type="button" onClick={() => onOpenSkillWorkspace()}>
                {ui("查看 Skill 面板", "Open Skill Panel")}
              </button>
            </div>

            <div className="overview-skill-stats">
              <div className="overview-skill-stat">
                <span>{ui("已发现 Skill", "Discovered Skills")}</span>
                <strong>{skillOverviewStats.total}</strong>
              </div>
              <div className="overview-skill-stat">
                <span>{ui("高风险 / 严重", "High / Critical")}</span>
                <strong>{skillOverviewStats.high_critical}</strong>
              </div>
              <div className="overview-skill-stat">
                <span>{ui("24 小时需确认 / 拦截", "24h Challenge / Block")}</span>
                <strong>{skillOverviewStats.challenge_block_24h}</strong>
              </div>
              <div className="overview-skill-stat">
                <span>{ui("未声明变更告警", "Undeclared Change Alerts")}</span>
                <strong>{skillOverviewStats.drift_alerts}</strong>
              </div>
              <div className="overview-skill-stat">
                <span>{ui("已隔离", "Quarantined")}</span>
                <strong>{skillOverviewStats.quarantined}</strong>
              </div>
            </div>

            {skillOverviewHighlights.length === 0 ? (
              <div className="chart-empty">
                {ui("当前还没有可展示的 Skill 风险快照。", "No skill highlights are available yet.")}
              </div>
            ) : (
              <div className="overview-skill-highlights">
                {skillOverviewHighlights.map((skill) => (
                  <button
                    key={skill.skill_id}
                    className="overview-skill-item"
                    type="button"
                    onClick={() => onOpenSkillWorkspace(skill.skill_id)}
                  >
                    <div className="overview-skill-item-main">
                      <div className="overview-skill-item-head">
                        <strong>{skill.name}</strong>
                        <div className="skill-row-tags">
                          <span className={`tag meta-tag severity-${skill.risk_tier}`}>{skillRiskLabel(skill.risk_tier)}</span>
                          {skill.quarantined ? <span className="tag block">{ui("已隔离", "Quarantined")}</span> : null}
                          {!skill.quarantined && skill.is_drifted ? <span className="tag warn">{ui("内容已变更", "Changed Without Version Update")}</span> : null}
                        </div>
                      </div>
                      <div className="overview-skill-item-meta">
                        {skillSourceLabel(skill.source)} · {ui("风险分", "Risk")} {skill.risk_score} · {ui("24h 拦截", "24h Intercepts")} {skill.intercept_count_24h}
                      </div>
                    </div>
                    <div className="overview-skill-item-side">
                      <span>{ui("最近扫描", "Last Scan")}</span>
                      <strong>{formatTime(skill.last_scan_at || skill.last_seen_at)}</strong>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </article>
        </div>

        <div className="overview-charts">
          <DistributionChart
            title={ui("消息来源分布", "Message Source Distribution")}
            subtitle="actor + scope"
            items={messageSourceDistribution}
            total={analyticsSampleCount}
            emptyText={ui("暂无消息来源数据", "No source data yet")}
            theme={theme}
          />

          <DistributionChart
            title={ui("决策来源分布", "Decision Source Distribution")}
            subtitle="rule / default / approval / account"
            items={decisionSourceDistribution}
            total={analyticsSampleCount}
            emptyText={ui("暂无决策来源数据", "No decision source data yet")}
            theme={theme}
          />

          <DistributionChart
            title={ui("拦截策略命中 Top", "Top Policy Hits")}
            subtitle={strategySourceCount > 0 ? ui("按规则命中次数排序", "Sorted by hit count") : ui("暂无风险样本", "No risk samples")}
            items={strategyHitDistribution}
            total={strategyHitTotal}
            emptyText={ui("暂无策略命中记录", "No policy hit records")}
            theme={theme}
          />

          <DistributionChart
            title={ui("工具调用分布", "Tool Call Distribution")}
            subtitle={ui("按最近样本聚合", "Aggregated from recent samples")}
            items={toolDistribution}
            total={analyticsSampleCount}
            emptyText={ui("暂无工具调用记录", "No tool call records")}
            theme={theme}
          />

          <article className="panel-card chart-card trend-card">
            <div className="chart-head">
              <h3>{ui("24 小时趋势", "24h Trend")}</h3>
              <span className="chart-subtitle">{trendRangeLabel}{ui("（", " (")}{trendBucketHours}h {ui("/ 桶）", "per bucket)")}</span>
            </div>
            <div className="chart-surface">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trendData} margin={{ top: 12, right: 24, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: chartTheme.tick, fontSize: 12 }}
                    tickFormatter={(value, index) => (index % trendTickStep === 0 ? value : "")}
                    axisLine={{ stroke: chartTheme.axis }}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: chartTheme.tick, fontSize: 12 }}
                    axisLine={{ stroke: chartTheme.axis }}
                    tickLine={false}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="total"
                    name={ui("总请求", "Total Requests")}
                    stroke={chartTheme.total}
                    strokeWidth={2.5}
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="risk"
                    name={ui("风险请求", "Risk Requests")}
                    stroke={chartTheme.risk}
                    strokeWidth={2.5}
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="trend-meta">
              <div className="trend-legend">
                <span className="trend-chip total">{ui("总请求", "Total")} {trendTotalCount}</span>
                <span className="trend-chip risk">{ui("风险请求", "Risk")} {trendRiskCount}</span>
              </div>
              <span className="trend-peak">{ui("峰值", "Peak")} {trendPeak}</span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

export function EventsPanel({
  hasActiveDecisionFilter,
  decisionFilter,
  decisionFilterLabel,
  decisionFilterOptions,
  decisionFilterSummary,
  filteredDecisionTotal,
  loading,
  decisionLoading,
  pagedDecisions,
  firstDecisionIndex,
  lastDecisionIndex,
  decisionPage,
  totalDecisionPages,
  pageItems,
  formatTime,
  decisionSourceLabel,
  resourceScopeLabel,
  onRefresh,
  onSelectDecisionFilter,
  onNavigatePage,
}: EventsPanelProps) {
  return (
    <section id="panel-events" className="tab-panel" role="tabpanel" aria-labelledby="tab-events">
      <div className="panel-card dashboard-panel">
        <div className="card-head card-head-compact">
          <h2>{ui("拦截记录", "Interceptions")}</h2>
          <div className="header-actions">
            {hasActiveDecisionFilter ? (
              <span className="meta-pill meta-pill-highlight">
                {ui("筛选", "Filter")} {decisionFilterLabel(decisionFilter)}
              </span>
            ) : null}
            <button className="ghost small" type="button" onClick={() => void onRefresh()}>
              {ui("刷新", "Refresh")}
            </button>
          </div>
        </div>
        <div className="decision-toolbar">
          <div className="decision-filter-group" role="group" aria-label={ui("决策筛选", "Decision filters")}>
            {decisionFilterOptions.map((option) => (
              <button
                key={option.value}
                className={`filter-chip ${decisionFilter === option.value ? "active" : ""}`}
                type="button"
                aria-pressed={decisionFilter === option.value}
                onClick={() => onSelectDecisionFilter(option.value)}
              >
                <span>{decisionFilterLabel(option.value)}</span>
                <span className="filter-chip-count">{option.count}</span>
              </button>
            ))}
          </div>
          <div className="decision-toolbar-note">{decisionFilterSummary}</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{ui("时间", "Time")}</th>
                <th>{ui("决策", "Decision")}</th>
                <th>{ui("来源", "Source")}</th>
                <th>{ui("资源范围", "Resource Scope")}</th>
                <th>{ui("环节", "Hook")}</th>
                <th>{ui("操作", "Tool")}</th>
                <th>{ui("原因", "Reasons")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredDecisionTotal === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {loading || decisionLoading
                      ? ui("加载中...", "Loading...")
                      : hasActiveDecisionFilter
                        ? ui(`暂无“${decisionFilterLabel(decisionFilter)}”记录`, `No "${decisionFilterLabel(decisionFilter)}" records`)
                        : ui("暂无决策记录", "No decision records")}
                  </td>
                </tr>
              ) : (
                pagedDecisions.map((item, index) => (
                  <tr key={`${item.trace_id || "trace"}-${firstDecisionIndex + index}`}>
                    <td>{formatTime(item.ts)}</td>
                    <td>
                      <DecisionTag decision={item.decision} />
                    </td>
                    <td>{decisionSourceLabel(item.decision_source)}</td>
                    <td>{resourceScopeLabel(item.resource_scope)}</td>
                    <td>{item.hook || "-"}</td>
                    <td>{item.tool || "-"}</td>
                    <td>{item.reasons.join(ui("，", ", ")) || "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filteredDecisionTotal > 0 ? (
          <div className="pagination">
            <div className="pagination-summary">
              {ui("显示", "Showing")} {firstDecisionIndex}-{lastDecisionIndex} / {filteredDecisionTotal} · {ui("第", "Page ")}{decisionPage} / {totalDecisionPages}
            </div>
            <div className="pagination-controls">
              <button
                className="ghost small"
                type="button"
                disabled={decisionPage === 1}
                onClick={() => onNavigatePage(Math.max(1, decisionPage - 1))}
              >
                {ui("上一页", "Prev")}
              </button>
              {pageItems.map((page) => (
                <button
                  key={page}
                  className={`page-button ${page === decisionPage ? "active" : ""}`}
                  type="button"
                  aria-current={page === decisionPage ? "page" : undefined}
                  onClick={() => onNavigatePage(page)}
                >
                  {page}
                </button>
              ))}
              <button
                className="ghost small"
                type="button"
                disabled={decisionPage === totalDecisionPages}
                onClick={() => onNavigatePage(Math.min(totalDecisionPages, decisionPage + 1))}
              >
                {ui("下一页", "Next")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AccountsPanel({
  accountCount,
  displayAccounts,
  selectedAdminSubject,
  accountPrimaryLabel,
  accountModeLabel,
  accountMetaLabel,
  onUpdateAccountPolicy,
  onSetAdminAccount,
}: AccountsPanelProps) {
  return (
    <section id="panel-accounts" className="tab-panel" role="tabpanel" aria-labelledby="tab-accounts">
      <div className="panel-card accounts-panel dashboard-panel">
        <div className="card-head">
          <div>
            <h2>{ui("账号", "Accounts")}</h2>
            <p className="accounts-intro">
              {ui("设置账号模式和管理员。默认管理员为 main。", "Set account mode and admin. main is the default admin.")}
            </p>
          </div>
          <div className="rule-meta">
            <span className="meta-pill">{ui("账号", "Accounts")} {accountCount}</span>
          </div>
        </div>

        {accountCount === 0 ? (
          <div className="chart-empty">{ui("还没有账号。", "No accounts yet.")}</div>
        ) : (
          <div className="account-list">
            {displayAccounts.map((account) => (
              <article key={account.subject} className="account-card">
                <div className="account-card-head">
                  <div>
                    <div className="account-title-row">
                      <h3>{accountPrimaryLabel(account)}</h3>
                      {account.is_admin ? <span className="tag meta-tag">{ui("管理员", "Admin")}</span> : null}
                      <span className={`tag ${account.mode === "default_allow" ? "warn" : "allow"}`}>
                        {accountModeLabel(account.mode)}
                      </span>
                    </div>
                    <div className="account-subject">{account.subject}</div>
                    <div className="account-meta">{accountMetaLabel(account)}</div>
                  </div>
                </div>

                <div className="account-controls">
                  <label className="account-field">
                    <span>{ui("规则模式", "Rule Mode")}</span>
                    <select
                      value={account.mode || "apply_rules"}
                      onChange={(event) =>
                        onUpdateAccountPolicy(account.subject, { mode: event.target.value as AccountPolicyMode })
                      }
                    >
                      <option value="apply_rules">{ui("应用规则", "Apply Rules")}</option>
                      <option value="default_allow">{ui("默认放行", "Default Allow")}</option>
                    </select>
                  </label>

                  <label className="account-toggle">
                    <input
                      type="radio"
                      name="admin-account"
                      checked={selectedAdminSubject === account.subject}
                      onChange={(event) => {
                        if (event.target.checked) {
                          onSetAdminAccount(account.subject);
                        }
                      }}
                    />
                    <span>{ui("管理员", "Admin")}</span>
                  </label>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
