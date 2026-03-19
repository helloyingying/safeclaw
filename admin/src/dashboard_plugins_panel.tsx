import type {
  PluginDetailPayload,
  PluginInstallSource,
  PluginRiskTier,
  PluginState,
  PluginStatusPayload,
  PluginSummary,
  PluginListPayload,
} from "../../src/admin/plugin_security_store.ts";
import {
  PLUGIN_RISK_FILTER_OPTIONS,
  PLUGIN_STATE_FILTER_OPTIONS,
  ui,
} from "./dashboard_core.ts";
import { OverviewStatCard } from "./dashboard_primitives.tsx";

type PluginRiskFilterValue = "all" | PluginRiskTier;
type PluginStateFilterValue = "all" | PluginState;
type PluginSourceFilterValue = "all" | PluginInstallSource;

type PluginsPanelProps = {
  pluginOverviewStats: PluginStatusPayload["stats"];
  pluginItems: PluginSummary[];
  pluginSummaryCounts: PluginListPayload["counts"];
  pluginSourceOptions: string[];
  pluginRiskFilter: PluginRiskFilterValue;
  pluginStateFilter: PluginStateFilterValue;
  pluginSourceFilter: PluginSourceFilterValue;
  selectedPluginId: string;
  pluginListLoading: boolean;
  pluginDetailLoading: boolean;
  selectedPlugin: PluginSummary | null;
  selectedPluginDetail: PluginDetailPayload | null;
  onRefresh: () => void | Promise<void>;
  onSelectPlugin: (pluginId: string) => void;
  onClosePluginDetail: () => void;
  onSetPluginRiskFilter: (value: PluginRiskFilterValue) => void;
  onSetPluginStateFilter: (value: PluginStateFilterValue) => void;
  onSetPluginSourceFilter: (value: PluginSourceFilterValue) => void;
  pluginRiskLabel: (value: string | null | undefined) => string;
  pluginStateLabel: (value: string | null | undefined) => string;
  pluginSourceLabel: (value: string | null | undefined) => string;
  pluginReasonLabel: (value: string | null | undefined) => string;
  pluginScopeLabel: (value: string | null | undefined) => string;
  formatTime: (value: string | null | undefined) => string;
};

export function PluginsPanel({
  pluginOverviewStats,
  pluginItems,
  pluginSummaryCounts,
  pluginSourceOptions,
  pluginRiskFilter,
  pluginStateFilter,
  pluginSourceFilter,
  selectedPluginId,
  pluginListLoading,
  pluginDetailLoading,
  selectedPlugin,
  selectedPluginDetail,
  onRefresh,
  onSelectPlugin,
  onClosePluginDetail,
  onSetPluginRiskFilter,
  onSetPluginStateFilter,
  onSetPluginSourceFilter,
  pluginRiskLabel,
  pluginStateLabel,
  pluginSourceLabel,
  pluginReasonLabel,
  pluginScopeLabel,
  formatTime,
}: PluginsPanelProps) {
  const displayFindings = selectedPluginDetail?.findings || selectedPlugin?.findings || [];
  const scannedFiles = selectedPluginDetail?.scanned_files || [];
  const manifest = selectedPluginDetail?.manifest;
  const packageInfo = selectedPluginDetail?.package;

  return (
    <section id="panel-plugins" className="tab-panel" role="tabpanel" aria-labelledby="tab-plugins">
      <div className="panel-card skills-panel plugins-panel dashboard-panel">
        <div className="card-head">
          <div>
            <h2>{ui("插件", "Plugins")}</h2>
            <p className="skills-intro">
              {ui(
                "这里扫描当前已安装的 OpenClaw 插件，排除 SecurityClaw 自己，重点看来源、安装位置、源码信号和依赖面，方便快速判断哪些插件需要先复核。",
                "This panel scans installed OpenClaw plugins except SecurityClaw itself. It focuses on source, install location, code signals, and dependency surface so you can review risky plugins first."
              )}
            </p>
          </div>
          <div className="header-actions">
            <span className="meta-pill">{ui("已发现插件", "Plugins")} {pluginOverviewStats.total}</span>
            <button className="ghost small" type="button" onClick={() => void onRefresh()}>
              {ui("刷新", "Refresh")}
            </button>
          </div>
        </div>

        <div className="skills-metrics">
          <OverviewStatCard label={ui("已启用", "Enabled")} value={pluginOverviewStats.enabled} />
          <OverviewStatCard label={ui("高风险 / 严重", "High / Critical")} value={pluginOverviewStats.high_critical} tone="bad" />
          <OverviewStatCard label={ui("本地路径来源", "Local Path Sources")} value={pluginOverviewStats.path_sources} tone="warn" />
          <OverviewStatCard label={ui("检测到执行能力", "Execution Signals")} value={pluginOverviewStats.exec_capable} tone="warn" />
          <OverviewStatCard label={ui("检测到网络能力", "Network Signals")} value={pluginOverviewStats.network_capable} tone="warn" />
          <OverviewStatCard label={ui("当前列表", "Listed")} value={pluginItems.length} />
        </div>

        <div className="skills-layout">
          <div className="panel-card skill-list-panel">
            <div className="skill-list-head">
              <div>
                <span className="eyebrow">{ui("筛选与列表", "Filters and List")}</span>
                <h3>{ui("先看高风险、路径来源和已启用对象", "Start with high-risk, path-based, and enabled plugins")}</h3>
              </div>
              <div className="rule-meta">
                <span className="meta-pill">{ui("总数", "Total")} {pluginSummaryCounts.total}</span>
                <span className="meta-pill">{ui("高风险 / 严重", "High / Critical")} {pluginSummaryCounts.high_critical}</span>
              </div>
            </div>

            <div className="skills-toolbar">
              <label className="skill-filter-field">
                <span>{ui("风险", "Risk")}</span>
                <select value={pluginRiskFilter} onChange={(event) => onSetPluginRiskFilter(event.target.value as PluginRiskFilterValue)}>
                  {PLUGIN_RISK_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{pluginRiskLabel(option)}</option>
                  ))}
                </select>
              </label>

              <label className="skill-filter-field">
                <span>{ui("状态", "State")}</span>
                <select value={pluginStateFilter} onChange={(event) => onSetPluginStateFilter(event.target.value as PluginStateFilterValue)}>
                  {PLUGIN_STATE_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{pluginStateLabel(option)}</option>
                  ))}
                </select>
              </label>

              <label className="skill-filter-field">
                <span>{ui("来源", "Source")}</span>
                <select value={pluginSourceFilter} onChange={(event) => onSetPluginSourceFilter(event.target.value as PluginSourceFilterValue)}>
                  <option value="all">{ui("全部来源", "All Sources")}</option>
                  {pluginSourceOptions.map((option) => (
                    <option key={option} value={option}>{pluginSourceLabel(option)}</option>
                  ))}
                </select>
              </label>
            </div>

            {pluginListLoading ? (
              <div className="chart-empty">{ui("插件列表加载中...", "Loading plugins...")}</div>
            ) : pluginItems.length === 0 ? (
              <div className="chart-empty">{ui("当前筛选下没有匹配的插件。", "No plugins match the current filters.")}</div>
            ) : (
              <div className="skill-list">
                {pluginItems.map((plugin) => (
                  <button
                    key={plugin.plugin_id}
                    className={`skill-row ${selectedPluginId === plugin.plugin_id ? "active" : ""}`}
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => onSelectPlugin(plugin.plugin_id)}
                  >
                    <div className="skill-row-main">
                      <div className="skill-row-head">
                        <div>
                          <div className="skill-row-title">{plugin.name}</div>
                          <div className="skill-row-meta">
                            {plugin.version || ui("未声明版本", "No version declared")}
                            {" · "}
                            {pluginSourceLabel(plugin.source)}
                          </div>
                        </div>
                        <div className="skill-row-tags">
                          <span className={`tag meta-tag severity-${plugin.risk_tier}`}>{pluginRiskLabel(plugin.risk_tier)}</span>
                          <span className={`tag ${plugin.enabled ? "allow" : "warn"}`}>{pluginStateLabel(plugin.state)}</span>
                        </div>
                      </div>

                      <div className="skill-row-subline">
                        {pluginScopeLabel(plugin.install_scope)} · {ui("发现项", "Findings")} {plugin.finding_count}
                      </div>

                      <div className="skill-row-foot">
                        <span>{ui("最近扫描", "Last scan")} {formatTime(plugin.last_scan_at)}</span>
                        <span>{ui("频道", "Channels")} {plugin.channels.length}</span>
                        <span>{ui("技能", "Skills")} {plugin.skills.length}</span>
                      </div>
                    </div>

                    <div className="skill-row-side">
                      <strong>{plugin.risk_score}</strong>
                      <span>{ui("风险分", "Risk Score")}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {selectedPlugin ? (
          <div
            className="skill-detail-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={ui("插件详情", "Plugin details")}
            onClick={onClosePluginDetail}
          >
            <div className="hardening-drawer skill-detail-modal" onClick={(event) => event.stopPropagation()} aria-busy={pluginDetailLoading}>
              <div className="hardening-modal-sticky">
                <div className="skill-detail-head">
                  <div>
                    <span className="eyebrow">{ui("插件画像", "Plugin Profile")}</span>
                    <h3>{selectedPlugin.name}</h3>
                    <p className="skill-detail-intro">
                      {selectedPlugin.description || ui("当前插件没有额外描述。", "No additional description is available for this plugin.")}
                    </p>
                  </div>
                  <div className="skill-detail-actions">
                    <button className="ghost small" type="button" onClick={onClosePluginDetail}>
                      {ui("关闭", "Close")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="hardening-drawer-content">
                {pluginDetailLoading ? (
                  <div className="hardening-inline-note" role="status" aria-live="polite">
                    {ui("详情加载中，下面先显示当前已拿到的结果。", "Loading details. Showing the data already available.")}
                  </div>
                ) : null}

                <div className="skill-detail-panel">
                  <div className="skill-score-card">
                    <div className="skill-score-top">
                      <div>
                        <div className="skill-score-label">{ui("综合风险", "Composite Risk")}</div>
                        <div className="skill-score-value">{selectedPlugin.risk_score}</div>
                      </div>
                      <div className="skill-score-side">
                        <span className={`tag meta-tag severity-${selectedPlugin.risk_tier}`}>{pluginRiskLabel(selectedPlugin.risk_tier)}</span>
                        <span className={`tag ${selectedPlugin.enabled ? "allow" : "warn"}`}>{pluginStateLabel(selectedPlugin.state)}</span>
                      </div>
                    </div>
                    <div className="skill-score-track" aria-hidden="true">
                      <span style={{ width: `${Math.max(6, selectedPlugin.risk_score)}%` }} />
                    </div>
                    <div className="skill-score-meta">
                      <span>{ui("来源", "Source")} {pluginSourceLabel(selectedPlugin.source)}</span>
                      <span>{ui("安装位置", "Install Scope")} {pluginScopeLabel(selectedPlugin.install_scope)}</span>
                      <span>{ui("发现项", "Findings")} {selectedPlugin.finding_count}</span>
                    </div>
                  </div>

                  <div className="skill-meta-grid">
                    <div className="skill-meta-item">
                      <span>{ui("版本", "Version")}</span>
                      <strong>{selectedPlugin.version || ui("未声明", "Undeclared")}</strong>
                    </div>
                    <div className="skill-meta-item">
                      <span>{ui("状态", "State")}</span>
                      <strong>{pluginStateLabel(selectedPlugin.state)}</strong>
                    </div>
                    <div className="skill-meta-item">
                      <span>{ui("来源", "Source")}</span>
                      <strong>{pluginSourceLabel(selectedPlugin.source)}</strong>
                    </div>
                    <div className="skill-meta-item">
                      <span>{ui("最近扫描", "Last Scan")}</span>
                      <strong>{formatTime(selectedPlugin.last_scan_at)}</strong>
                    </div>
                    <div className="skill-meta-item skill-meta-item-wide">
                      <span>{ui("安装路径", "Install Path")}</span>
                      <strong>{selectedPlugin.install_path || ui("当前没有安装路径", "No install path is currently available")}</strong>
                    </div>
                    <div className="skill-meta-item skill-meta-item-wide">
                      <span>{ui("安装引用", "Install Reference")}</span>
                      <strong>{selectedPlugin.install_reference || ui("当前没有安装引用", "No install reference is currently available")}</strong>
                    </div>
                  </div>

                  <section className="skill-section">
                    <div className="skill-section-head">
                      <h4>{ui("当前发现的风险信号", "Current Risk Signals")}</h4>
                      <span className="meta-pill">{displayFindings.length}</span>
                    </div>
                    {displayFindings.length === 0 ? (
                      <div className="chart-empty">{ui("最近一次扫描没有发现新的高风险信号。", "No new high-risk signals were found in the latest scan.")}</div>
                    ) : (
                      <div className="skill-finding-list">
                        {displayFindings.map((finding, index) => (
                          <article key={`${finding.code}-${index}`} className="skill-finding-card">
                            <div className="skill-finding-head">
                              <strong>{pluginReasonLabel(finding.code)}</strong>
                              <span className="meta-pill">{finding.weight}</span>
                            </div>
                            <p>{finding.detail}</p>
                            {finding.evidence.length > 0 ? (
                              <code>{finding.evidence.join(" · ")}</code>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="skill-section">
                    <div className="skill-section-head">
                      <h4>{ui("清单与依赖", "Manifest and Dependencies")}</h4>
                    </div>
                    <div className="skill-meta-grid">
                      <div className="skill-meta-item">
                        <span>{ui("Manifest ID", "Manifest ID")}</span>
                        <strong>{manifest?.id || ui("未声明", "Undeclared")}</strong>
                      </div>
                      <div className="skill-meta-item">
                        <span>{ui("包名", "Package Name")}</span>
                        <strong>{packageInfo?.name || ui("未声明", "Undeclared")}</strong>
                      </div>
                      <div className="skill-meta-item">
                        <span>{ui("频道", "Channels")}</span>
                        <strong>{manifest?.channels.length || 0}</strong>
                      </div>
                      <div className="skill-meta-item">
                        <span>{ui("依赖", "Dependencies")}</span>
                        <strong>{packageInfo?.dependency_names.length || 0}</strong>
                      </div>
                      <div className="skill-meta-item skill-meta-item-wide">
                        <span>{ui("配置键", "Config Keys")}</span>
                        <strong>
                          {manifest?.config_keys.length
                            ? manifest.config_keys.join(" · ")
                            : ui("当前没有声明配置键", "No config keys are declared")}
                        </strong>
                      </div>
                    </div>
                  </section>

                  <section className="skill-section">
                    <div className="skill-section-head">
                      <h4>{ui("扫描过的文件", "Scanned Files")}</h4>
                      <span className="meta-pill">{scannedFiles.length}</span>
                    </div>
                    {scannedFiles.length === 0 ? (
                      <div className="chart-empty">{ui("当前没有可展示的源码文件。", "No source files are available to show right now.")}</div>
                    ) : (
                      <div className="hardening-paths">
                        {scannedFiles.map((filePath) => (
                          <code key={filePath}>{filePath}</code>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
