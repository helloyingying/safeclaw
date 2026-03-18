import type {
  SkillActivity,
  SkillFinding,
  SkillLifecycleState,
  SkillListPayload,
  SkillOperationSeverity,
  SkillPolicyConfig,
  SkillRiskTier,
  SkillSource,
  SkillStatusPayload,
  SkillSummary,
} from "../../src/admin/skill_interception_store.ts";
import type { Decision } from "../../src/types.ts";
import {
  DECISION_OPTIONS,
  SKILL_DRIFT_FILTER_OPTIONS,
  SKILL_INTERCEPT_FILTER_OPTIONS,
  SKILL_POLICY_TIERS,
  SKILL_RISK_FILTER_OPTIONS,
  SKILL_SEVERITY_LEVELS,
  SKILL_STATE_FILTER_OPTIONS,
  ui,
} from "./dashboard_core.ts";
import { DecisionTag, OverviewStatCard } from "./dashboard_primitives.tsx";

type SkillRiskFilterValue = "all" | SkillRiskTier;
type SkillStateFilterValue = "all" | SkillLifecycleState;
type SkillSourceFilterValue = "all" | SkillSource;
type SkillDriftFilterValue = "all" | "drifted" | "steady";
type SkillInterceptFilterValue = "all" | "recent";
type SkillPolicyTierKey = keyof SkillPolicyConfig["matrix"];
type SkillDefaultActionKey = "drifted_action" | "trust_override_hours" | "unscanned_S2" | "unscanned_S3";
type SkillConfirmAction = {
  kind: "quarantine" | "trust";
  skillId: string;
  enable: boolean;
  skillName?: string;
};

type SkillsPanelProps = {
  rootCount: number;
  skillOverviewStats: SkillStatusPayload["stats"];
  skillItems: SkillSummary[];
  skillSummaryCounts: SkillListPayload["counts"];
  skillSourceOptions: string[];
  skillRiskFilter: SkillRiskFilterValue;
  skillStateFilter: SkillStateFilterValue;
  skillSourceFilter: SkillSourceFilterValue;
  skillDriftFilter: SkillDriftFilterValue;
  skillInterceptFilter: SkillInterceptFilterValue;
  selectedSkillId: string;
  skillListLoading: boolean;
  skillDetailLoading: boolean;
  skillActionLoading: string;
  selectedSkill: SkillSummary | null;
  selectedSkillFindings: SkillFinding[];
  selectedSkillActivity: SkillActivity[];
  skillPolicy: SkillPolicyConfig | null;
  hasPendingSkillPolicyChanges: boolean;
  skillPolicySaving: boolean;
  skillConfirmAction: SkillConfirmAction | null;
  onRefresh: () => void | Promise<void>;
  onSelectSkill: (skillId: string) => void;
  onSetSkillRiskFilter: (value: SkillRiskFilterValue) => void;
  onSetSkillStateFilter: (value: SkillStateFilterValue) => void;
  onSetSkillSourceFilter: (value: SkillSourceFilterValue) => void;
  onSetSkillDriftFilter: (value: SkillDriftFilterValue) => void;
  onSetSkillInterceptFilter: (value: SkillInterceptFilterValue) => void;
  onTriggerSkillRescan: (skillId: string) => void;
  onRequestSkillConfirm: (kind: SkillConfirmAction["kind"], skill: SkillSummary | null | undefined, enable: boolean) => void;
  onResetSkillPolicyDraft: () => void;
  onSaveSkillPolicyChanges: () => void | Promise<void>;
  onUpdateSkillThreshold: (field: "medium" | "high" | "critical", value: string) => void;
  onUpdateSkillMatrixDecision: (tier: SkillPolicyTierKey, severity: SkillOperationSeverity, decision: Decision) => void;
  onUpdateSkillDefaultAction: (key: SkillDefaultActionKey, value: string) => void;
  onCancelSkillConfirmAction: () => void;
  onConfirmSkillAction: () => void;
  skillRiskLabel: (value: string | null | undefined) => string;
  skillStateLabel: (value: string | null | undefined) => string;
  skillScanStatusLabel: (value: string | null | undefined) => string;
  skillSourceLabel: (value: string | null | undefined, detail?: string | null) => string;
  skillSeverityLabel: (value: string | null | undefined) => string;
  skillReasonLabel: (value: string | null | undefined) => string;
  skillActivityLabel: (value: string | null | undefined) => string;
  skillRiskFilterLabel: (value: SkillRiskFilterValue) => string;
  skillStateFilterLabel: (value: SkillStateFilterValue) => string;
  skillDriftFilterLabel: (value: SkillDriftFilterValue) => string;
  skillInterceptFilterLabel: (value: SkillInterceptFilterValue) => string;
  decisionLabel: (decision: string | null | undefined) => string;
  skillDefaultActionSummary: (kind: "unscanned_S2" | "unscanned_S3" | "drifted_action", decision: Decision) => string;
  formatTime: (value: string | null | undefined) => string;
  formatHash: (value: string | null | undefined, length?: number) => string;
  formatConfidence: (value: unknown) => string;
};

export function SkillsPanel({
  rootCount,
  skillOverviewStats,
  skillItems,
  skillSummaryCounts,
  skillSourceOptions,
  skillRiskFilter,
  skillStateFilter,
  skillSourceFilter,
  skillDriftFilter,
  skillInterceptFilter,
  selectedSkillId,
  skillListLoading,
  skillDetailLoading,
  skillActionLoading,
  selectedSkill,
  selectedSkillFindings,
  selectedSkillActivity,
  skillPolicy,
  hasPendingSkillPolicyChanges,
  skillPolicySaving,
  skillConfirmAction,
  onRefresh,
  onSelectSkill,
  onSetSkillRiskFilter,
  onSetSkillStateFilter,
  onSetSkillSourceFilter,
  onSetSkillDriftFilter,
  onSetSkillInterceptFilter,
  onTriggerSkillRescan,
  onRequestSkillConfirm,
  onResetSkillPolicyDraft,
  onSaveSkillPolicyChanges,
  onUpdateSkillThreshold,
  onUpdateSkillMatrixDecision,
  onUpdateSkillDefaultAction,
  onCancelSkillConfirmAction,
  onConfirmSkillAction,
  skillRiskLabel,
  skillStateLabel,
  skillScanStatusLabel,
  skillSourceLabel,
  skillSeverityLabel,
  skillReasonLabel,
  skillActivityLabel,
  skillRiskFilterLabel,
  skillStateFilterLabel,
  skillDriftFilterLabel,
  skillInterceptFilterLabel,
  decisionLabel,
  skillDefaultActionSummary,
  formatTime,
  formatHash,
  formatConfidence,
}: SkillsPanelProps) {
  return (
    <section id="panel-skills" className="tab-panel" role="tabpanel" aria-labelledby="tab-skills">
      <div className="panel-card skills-panel dashboard-panel">
        <div className="card-head">
          <div>
            <h2>{ui("Skill", "Skill")}</h2>
            <p className="skills-intro">
              {ui(
                "后台会自动发现本地已安装 skills，给出风险等级、内容是否发生未声明变更，以及人工处置入口。低风险默认无感，高风险行为集中在详情和策略区处理。",
                "The dashboard discovers locally installed skills, scores their risk, highlights content changes without version updates, and exposes admin actions. Low-risk skills stay quiet while high-risk handling is concentrated in the detail and policy areas."
              )}
            </p>
          </div>
          <div className="header-actions">
            <span className="meta-pill">{ui("扫描目录", "Roots")} {rootCount}</span>
            <button className="ghost small" type="button" onClick={() => void onRefresh()}>
              {ui("刷新", "Refresh")}
            </button>
          </div>
        </div>

        <div className="skills-metrics">
          <OverviewStatCard label={ui("已发现 Skill", "Discovered Skills")} value={skillOverviewStats.total} />
          <OverviewStatCard label={ui("高风险 / 严重", "High / Critical")} value={skillOverviewStats.high_critical} tone="bad" />
          <OverviewStatCard label={ui("24 小时需确认 / 拦截", "24h Challenge / Block")} value={skillOverviewStats.challenge_block_24h} tone="warn" />
          <OverviewStatCard label={ui("未声明变更告警", "Undeclared Change Alerts")} value={skillOverviewStats.drift_alerts} tone="warn" />
          <OverviewStatCard label={ui("已隔离", "Quarantined")} value={skillOverviewStats.quarantined} tone="bad" />
          <OverviewStatCard label={ui("受信覆盖", "Trust Overrides")} value={skillOverviewStats.trusted_overrides} />
        </div>

        <div className="skills-layout">
          <div className="panel-card skill-list-panel">
            <div className="skill-list-head">
              <div>
                <span className="eyebrow">{ui("筛选与列表", "Filters and List")}</span>
                <h3>{ui("优先按风险和处置状态收敛视图", "Narrow the list by risk and disposition")}</h3>
              </div>
              <div className="rule-meta">
                <span className="meta-pill">{ui("列表总数", "Listed")} {skillItems.length}</span>
                <span className="meta-pill">{ui("最近有拦截", "Recent Intercepts")} {skillSummaryCounts.recent_intercepts}</span>
              </div>
            </div>

            <div className="skills-toolbar">
              <label className="skill-filter-field">
                <span>{ui("风险", "Risk")}</span>
                <select value={skillRiskFilter} onChange={(event) => onSetSkillRiskFilter(event.target.value as SkillRiskFilterValue)}>
                  {SKILL_RISK_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{skillRiskFilterLabel(option as SkillRiskFilterValue)}</option>
                  ))}
                </select>
              </label>

              <label className="skill-filter-field">
                <span>{ui("状态", "State")}</span>
                <select value={skillStateFilter} onChange={(event) => onSetSkillStateFilter(event.target.value as SkillStateFilterValue)}>
                  {SKILL_STATE_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{skillStateFilterLabel(option as SkillStateFilterValue)}</option>
                  ))}
                </select>
              </label>

              <label className="skill-filter-field">
                <span>{ui("来源", "Source")}</span>
                <select value={skillSourceFilter} onChange={(event) => onSetSkillSourceFilter(event.target.value as SkillSourceFilterValue)}>
                  <option value="all">{ui("全部来源", "All Sources")}</option>
                  {skillSourceOptions.map((option) => (
                    <option key={option} value={option}>{skillSourceLabel(option)}</option>
                  ))}
                </select>
              </label>

              <label className="skill-filter-field">
                <span>{ui("内容变更", "Change Status")}</span>
                <select value={skillDriftFilter} onChange={(event) => onSetSkillDriftFilter(event.target.value as SkillDriftFilterValue)}>
                  {SKILL_DRIFT_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{skillDriftFilterLabel(option as SkillDriftFilterValue)}</option>
                  ))}
                </select>
              </label>

              <label className="skill-filter-field">
                <span>{ui("拦截", "Interception")}</span>
                <select value={skillInterceptFilter} onChange={(event) => onSetSkillInterceptFilter(event.target.value as SkillInterceptFilterValue)}>
                  {SKILL_INTERCEPT_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{skillInterceptFilterLabel(option as SkillInterceptFilterValue)}</option>
                  ))}
                </select>
              </label>
            </div>

            {skillListLoading ? (
              <div className="chart-empty">{ui("Skill 列表加载中...", "Loading skills...")}</div>
            ) : skillItems.length === 0 ? (
              <div className="chart-empty">{ui("当前筛选下没有匹配的 Skill。", "No skills match the current filters.")}</div>
            ) : (
              <div className="skill-list">
                {skillItems.map((skill) => (
                  <button
                    key={skill.skill_id}
                    className={`skill-row ${selectedSkillId === skill.skill_id ? "active" : ""}`}
                    type="button"
                    onClick={() => onSelectSkill(skill.skill_id)}
                  >
                    <div className="skill-row-main">
                      <div className="skill-row-head">
                        <div>
                          <div className="skill-row-title">{skill.name}</div>
                          <div className="skill-row-meta">
                            {skill.version || ui("未声明版本", "No version declared")}
                            {" · "}
                            {skill.author || ui("未声明作者", "No author declared")}
                          </div>
                        </div>
                        <div className="skill-row-tags">
                          <span className={`tag meta-tag severity-${skill.risk_tier}`}>{skillRiskLabel(skill.risk_tier)}</span>
                          <span className={`tag ${skill.state === "quarantined" ? "block" : skill.state === "trusted" ? "warn" : "allow"}`}>
                            {skillStateLabel(skill.state)}
                          </span>
                        </div>
                      </div>

                      <div className="skill-row-subline">{skillSourceLabel(skill.source, skill.source_detail)}</div>

                      <div className="skill-row-foot">
                        <span>{ui("最近扫描", "Last scan")} {formatTime(skill.last_scan_at || skill.last_seen_at)}</span>
                        <span>{ui("近 24h 拦截", "24h intercepts")} {skill.intercept_count_24h}</span>
                        <span>{ui("哈希", "Hash")} {formatHash(skill.current_hash, 12)}</span>
                      </div>
                    </div>

                    <div className="skill-row-side">
                      <strong>{skill.risk_score}</strong>
                      <span>{ui("风险分", "Risk Score")}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <aside className="panel-card skill-detail-panel">
            {!selectedSkill ? (
              <div className="chart-empty">{ui("选择一个 Skill 查看详情。", "Select a skill to inspect details.")}</div>
            ) : (
              <>
                <div className="skill-detail-head">
                  <div>
                    <span className="eyebrow">{ui("实时画像", "Live Profile")}</span>
                    <h3>{selectedSkill.name}</h3>
                    <p className="skill-detail-intro">
                      {selectedSkill.headline || ui("当前 Skill 没有额外摘要。", "No additional summary is available for this skill.")}
                    </p>
                  </div>
                  <div className="skill-detail-actions">
                    <button
                      className="ghost small"
                      type="button"
                      onClick={() => onTriggerSkillRescan(selectedSkill.skill_id)}
                      disabled={skillActionLoading === `rescan:${selectedSkill.skill_id}`}
                    >
                      {skillActionLoading === `rescan:${selectedSkill.skill_id}`
                        ? ui("重扫中...", "Rescanning...")
                        : ui("重扫", "Rescan")}
                    </button>
                    <button
                      className="ghost small"
                      type="button"
                      onClick={() => onRequestSkillConfirm("quarantine", selectedSkill, !selectedSkill.quarantined)}
                      disabled={Boolean(skillActionLoading)}
                    >
                      {selectedSkill.quarantined ? ui("解除隔离", "Remove Quarantine") : ui("隔离", "Quarantine")}
                    </button>
                    <button
                      className="primary small"
                      type="button"
                      onClick={() => onRequestSkillConfirm("trust", selectedSkill, !selectedSkill.trust_override)}
                      disabled={Boolean(skillActionLoading)}
                    >
                      {selectedSkill.trust_override ? ui("撤销受信", "Remove Override") : ui("设为受信", "Trust Override")}
                    </button>
                  </div>
                </div>

                <div className="skill-score-card">
                  <div className="skill-score-top">
                    <div>
                      <div className="skill-score-label">{ui("综合风险", "Composite Risk")}</div>
                      <div className="skill-score-value">{selectedSkill.risk_score}</div>
                    </div>
                    <div className="skill-score-side">
                      <span className={`tag meta-tag severity-${selectedSkill.risk_tier}`}>{skillRiskLabel(selectedSkill.risk_tier)}</span>
                      <span className={`tag ${selectedSkill.scan_status === "ready" ? "allow" : selectedSkill.scan_status === "stale" ? "warn" : "challenge"}`}>
                        {skillScanStatusLabel(selectedSkill.scan_status)}
                      </span>
                    </div>
                  </div>
                  <div className="skill-score-track" aria-hidden="true">
                    <span style={{ width: `${Math.max(6, selectedSkill.risk_score)}%` }} />
                  </div>
                  <div className="skill-score-meta">
                    <span>{ui("置信度", "Confidence")} {formatConfidence(selectedSkill.confidence)}</span>
                    <span>{ui("近 24h challenge / block", "24h challenge / block")} {selectedSkill.intercept_count_24h}</span>
                    {selectedSkill.is_drifted ? <span>{ui("内容变了但版本没变", "Changed without version update")}</span> : null}
                  </div>
                </div>

                <div className="skill-meta-grid">
                  <div className="skill-meta-item">
                    <span>{ui("版本", "Version")}</span>
                    <strong>{selectedSkill.version || ui("未声明", "Undeclared")}</strong>
                  </div>
                  <div className="skill-meta-item">
                    <span>{ui("作者", "Author")}</span>
                    <strong>{selectedSkill.author || ui("未声明", "Undeclared")}</strong>
                  </div>
                  <div className="skill-meta-item">
                    <span>{ui("来源", "Source")}</span>
                    <strong>{skillSourceLabel(selectedSkill.source, selectedSkill.source_detail)}</strong>
                  </div>
                  <div className="skill-meta-item">
                    <span>{ui("状态", "State")}</span>
                    <strong>{skillStateLabel(selectedSkill.state)}</strong>
                  </div>
                  <div className="skill-meta-item skill-meta-item-wide">
                    <span>{ui("安装路径", "Install Path")}</span>
                    <strong>{selectedSkill.install_path}</strong>
                  </div>
                  <div className="skill-meta-item skill-meta-item-wide">
                    <span>{ui("当前哈希", "Current Hash")}</span>
                    <strong>{selectedSkill.current_hash}</strong>
                  </div>
                </div>

                <section className="skill-section">
                  <div className="skill-section-head">
                    <h4>{ui("当前发现的风险信号", "Current Risk Signals")}</h4>
                    <span className="meta-pill">{selectedSkillFindings.length}</span>
                  </div>
                  {selectedSkillFindings.length === 0 ? (
                    <div className="chart-empty">{ui("最近一次扫描没有发现新的高风险信号。", "No new high-risk signals were found in the latest scan.")}</div>
                  ) : (
                    <div className="skill-finding-list">
                      {selectedSkillFindings.map((finding, index) => (
                        <article key={`${finding.code}-${index}`} className="skill-finding-card">
                          <div className="skill-finding-head">
                            <strong>{skillReasonLabel(finding.code)}</strong>
                            <div className="skill-row-tags">
                              <span className="tag meta-tag">{skillSeverityLabel(finding.severity)}</span>
                              <DecisionTag decision={finding.decision} />
                            </div>
                          </div>
                          <p>{finding.detail}</p>
                          {finding.excerpt ? <code>{finding.excerpt}</code> : null}
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="skill-section">
                  <div className="skill-section-head">
                    <h4>{ui("最近活动", "Recent Activity")}</h4>
                    <span className="meta-pill">{selectedSkillActivity.length}</span>
                  </div>
                  {skillDetailLoading && selectedSkillActivity.length === 0 ? (
                    <div className="chart-empty">{ui("活动加载中...", "Loading activity...")}</div>
                  ) : selectedSkillActivity.length === 0 ? (
                    <div className="chart-empty">{ui("当前没有额外活动记录。", "No extra activity records yet.")}</div>
                  ) : (
                    <div className="skill-activity-list">
                      {selectedSkillActivity.map((activity, index) => (
                        <article key={`${activity.kind}-${activity.ts}-${index}`} className="skill-activity-item">
                          <div className="skill-activity-top">
                            <strong>{skillActivityLabel(activity.kind)}</strong>
                            <span>{formatTime(activity.ts)}</span>
                          </div>
                          <div className="skill-activity-title">{activity.title === activity.kind ? skillActivityLabel(activity.kind) : activity.title}</div>
                          <p>{activity.detail}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </aside>
        </div>

        <section className="panel-card skill-policy-panel">
          <div className="card-head">
            <div>
              <h3>{ui("拦截策略设置", "Interception Policy")}</h3>
              <p className="skills-intro">
                {ui(
                  "这里控制分数阈值、风险 × 严重度矩阵，以及未扫描 / 内容变了但版本没变时的默认动作。策略区使用显式保存，避免误触即时生效。",
                  "This section controls score thresholds, the risk-by-severity matrix, and default actions for unscanned skills or ones whose content changed without a version update. Saving is explicit to avoid accidental live changes."
                )}
              </p>
            </div>
            <div className="header-actions">
              <span className={`meta-pill ${hasPendingSkillPolicyChanges ? "meta-pill-highlight" : ""}`}>
                {hasPendingSkillPolicyChanges ? ui("有未保存修改", "Unsaved Changes") : ui("已同步", "In Sync")}
              </span>
              <button className="ghost small" type="button" disabled={!hasPendingSkillPolicyChanges || skillPolicySaving} onClick={onResetSkillPolicyDraft}>
                {ui("重置", "Reset")}
              </button>
              <button className="primary small" type="button" disabled={!hasPendingSkillPolicyChanges || skillPolicySaving} onClick={() => void onSaveSkillPolicyChanges()}>
                {skillPolicySaving ? ui("保存中...", "Saving...") : ui("保存策略", "Save Policy")}
              </button>
            </div>
          </div>

          {skillPolicy ? (
            <div className="skill-policy-sections">
              <section className="skill-policy-section">
                <div className="skill-policy-section-head">
                  <h4>{ui("分数阈值", "Score Thresholds")}</h4>
                  <p>
                    {ui(
                      "用分数把 Skill 风险归到 low / medium / high / critical，便于矩阵规则继续决定动作。",
                      "Use score cutoffs to place skills into low / medium / high / critical before the policy matrix decides the final action."
                    )}
                  </p>
                </div>

                <div className="skill-policy-grid">
                  <label className="skill-policy-field">
                    <span>{ui("Medium 阈值", "Medium Threshold")}</span>
                    <input type="number" min="0" max="100" value={skillPolicy.thresholds.medium} onChange={(event) => onUpdateSkillThreshold("medium", event.target.value)} />
                  </label>
                  <label className="skill-policy-field">
                    <span>{ui("High 阈值", "High Threshold")}</span>
                    <input type="number" min="0" max="100" value={skillPolicy.thresholds.high} onChange={(event) => onUpdateSkillThreshold("high", event.target.value)} />
                  </label>
                  <label className="skill-policy-field">
                    <span>{ui("Critical 阈值", "Critical Threshold")}</span>
                    <input type="number" min="0" max="100" value={skillPolicy.thresholds.critical} onChange={(event) => onUpdateSkillThreshold("critical", event.target.value)} />
                  </label>
                  <label className="skill-policy-field">
                    <span>{ui("临时受信时长（小时）", "Trust Override Duration (h)")}</span>
                    <input type="number" min="1" max="168" value={skillPolicy.defaults.trust_override_hours} onChange={(event) => onUpdateSkillDefaultAction("trust_override_hours", event.target.value)} />
                  </label>
                </div>
              </section>

              <section className="skill-policy-section">
                <div className="skill-policy-section-head">
                  <h4>{ui("风险 × 严重度矩阵", "Risk-by-Severity Matrix")}</h4>
                  <p>
                    {ui(
                      "先按综合风险分层，再结合调用严重度决定最终动作。矩阵越往右下越应该更严格。",
                      "The final action comes from the combination of composite risk tier and call severity. Cells toward the bottom-right should usually be stricter."
                    )}
                  </p>
                </div>

                <div className="skill-policy-table-wrap">
                  <table className="skill-policy-table">
                    <thead>
                      <tr>
                        <th>{ui("风险 \\ 严重度", "Risk \\ Severity")}</th>
                        {SKILL_SEVERITY_LEVELS.map((severity) => (
                          <th key={severity}>{skillSeverityLabel(severity)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SKILL_POLICY_TIERS.map((tier) => (
                        <tr key={tier}>
                          <th scope="row">
                            {tier === "unknown" ? ui("未扫描 / 过期", "Unscanned / Stale") : skillRiskLabel(tier as SkillRiskTier)}
                          </th>
                          {SKILL_SEVERITY_LEVELS.map((severity) => (
                            <td key={`${tier}-${severity}`}>
                              <select
                                value={skillPolicy.matrix[tier as SkillPolicyTierKey][severity as SkillOperationSeverity]}
                                onChange={(event) =>
                                  onUpdateSkillMatrixDecision(
                                    tier as SkillPolicyTierKey,
                                    severity as SkillOperationSeverity,
                                    event.target.value as Decision
                                  )
                                }
                              >
                                {DECISION_OPTIONS.map((decision) => (
                                  <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                                ))}
                              </select>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="skill-policy-section">
                <div className="skill-policy-section-head">
                  <h4>{ui("兜底动作", "Fallback Actions")}</h4>
                  <p>
                    {ui(
                      "这些规则处理两类容易被忽略的情况：还没扫描完成，以及内容变了但版本没跟着变。",
                      "These defaults cover two easy-to-miss cases: a skill has not been scanned yet, or its content changed without a version update."
                    )}
                  </p>
                </div>

                <div className="skill-policy-grid skill-policy-grid-secondary">
                  <label className="skill-policy-field">
                    <span>{ui("未扫描 S2 默认动作", "Unscanned S2 Default")}</span>
                    <select value={skillPolicy.defaults.unscanned.S2} onChange={(event) => onUpdateSkillDefaultAction("unscanned_S2", event.target.value)}>
                      {DECISION_OPTIONS.map((decision) => (
                        <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                      ))}
                    </select>
                    <div className={`rule-helper skill-policy-field-note ${skillPolicy.defaults.unscanned.S2}`}>
                      <span className="rule-helper-label">
                        {ui("当前处理方式", "Current handling")} · {decisionLabel(skillPolicy.defaults.unscanned.S2)}
                      </span>
                      <p>{skillDefaultActionSummary("unscanned_S2", skillPolicy.defaults.unscanned.S2)}</p>
                    </div>
                  </label>
                  <label className="skill-policy-field">
                    <span>{ui("未扫描 S3 默认动作", "Unscanned S3 Default")}</span>
                    <select value={skillPolicy.defaults.unscanned.S3} onChange={(event) => onUpdateSkillDefaultAction("unscanned_S3", event.target.value)}>
                      {DECISION_OPTIONS.map((decision) => (
                        <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                      ))}
                    </select>
                    <div className={`rule-helper skill-policy-field-note ${skillPolicy.defaults.unscanned.S3}`}>
                      <span className="rule-helper-label">
                        {ui("当前处理方式", "Current handling")} · {decisionLabel(skillPolicy.defaults.unscanned.S3)}
                      </span>
                      <p>{skillDefaultActionSummary("unscanned_S3", skillPolicy.defaults.unscanned.S3)}</p>
                    </div>
                  </label>
                  <label className="skill-policy-field">
                    <span>{ui("内容变了但版本没变时的默认动作", "Default Action for Undeclared Change")}</span>
                    <select value={skillPolicy.defaults.drifted_action} onChange={(event) => onUpdateSkillDefaultAction("drifted_action", event.target.value)}>
                      {DECISION_OPTIONS.map((decision) => (
                        <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                      ))}
                    </select>
                    <div className={`rule-helper skill-policy-field-note ${skillPolicy.defaults.drifted_action}`}>
                      <span className="rule-helper-label">
                        {ui("当前处理方式", "Current handling")} · {decisionLabel(skillPolicy.defaults.drifted_action)}
                      </span>
                      <p>{skillDefaultActionSummary("drifted_action", skillPolicy.defaults.drifted_action)}</p>
                    </div>
                  </label>
                </div>
              </section>
            </div>
          ) : (
            <div className="chart-empty">{ui("策略加载中...", "Loading policy...")}</div>
          )}
        </section>

        {skillConfirmAction ? (
          <div
            className="confirm-dialog-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={ui("Skill 操作确认", "Skill action confirmation")}
            onClick={onCancelSkillConfirmAction}
          >
            <div className="confirm-dialog-card" onClick={(event) => event.stopPropagation()}>
              <h4>
                {skillConfirmAction.kind === "quarantine"
                  ? skillConfirmAction.enable
                    ? ui("确认隔离这个 Skill？", "Quarantine this skill?")
                    : ui("确认解除隔离？", "Remove quarantine?")
                  : skillConfirmAction.enable
                    ? ui("确认设置临时受信？", "Apply trust override?")
                    : ui("确认撤销受信覆盖？", "Remove trust override?")}
              </h4>
              <p className="confirm-dialog-text">
                {skillConfirmAction.kind === "quarantine"
                  ? skillConfirmAction.enable
                    ? ui("隔离后，这个 Skill 的高危调用会以更严格策略处理，适合先止血再排查。", "Once quarantined, this skill's high-risk calls will be handled with stricter blocking. Use this to contain risk first.")
                    : ui("解除隔离后，Skill 会重新按风险矩阵参与评估。", "Removing quarantine puts the skill back on the normal risk matrix.")
                  : skillConfirmAction.enable
                    ? ui(`受信覆盖会保留审计，并按当前默认时长 ${skillPolicy?.defaults?.trust_override_hours || 6} 小时自动过期。`, `The trust override remains audited and will expire after ${skillPolicy?.defaults?.trust_override_hours || 6} hours by default.`)
                    : ui("撤销后，Skill 会重新使用正常风险等级和决策矩阵。", "Removing the override restores the normal risk tier and decision matrix.")}
              </p>
              <div className="confirm-dialog-path">{skillConfirmAction.skillName || skillConfirmAction.skillId}</div>
              <div className="confirm-dialog-actions">
                <button className="ghost small" type="button" onClick={onCancelSkillConfirmAction}>
                  {ui("取消", "Cancel")}
                </button>
                <button className="primary small" type="button" onClick={onConfirmSkillAction}>
                  {ui("确认", "Confirm")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
