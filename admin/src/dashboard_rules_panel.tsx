import type { CapabilityPolicy, StrategyPolicyRule } from "../../src/domain/services/strategy_model.ts";
import type { Decision, PolicyMatch } from "../../src/types.ts";
import { DECISION_OPTIONS, ui } from "./dashboard_core.ts";
import { DecisionTag } from "./dashboard_primitives.tsx";
import { AdminAccessPanel } from "./dashboard_panels.tsx";
import { FilesystemOverridesSection } from "./filesystem_overrides_section.tsx";
import type { FilesystemOverridesSectionProps } from "./filesystem_overrides_section.tsx";
import type { AccountPolicyMode, AccountPolicyRecord } from "../../src/types.ts";

type RuleDisplay = StrategyPolicyRule & {
  match: PolicyMatch;
};

type RulesPanelProps = {
  capabilityPolicies: CapabilityPolicy[];
  additionalRestrictionCount: number;
  directoryOverrideCount: number;
  accountCount: number;
  displayAccounts: AccountPolicyRecord[];
  selectedAdminSubject: string;
  adminConfigured: boolean;
  managementEffective: boolean;
  managementInactiveReason: string;
  hasFilesystemCapability: boolean;
  filesystemOverridesProps: FilesystemOverridesSectionProps;
  capabilityLabel: (capabilityId: string | null | undefined) => string;
  capabilityDescription: (capabilityId: string | null | undefined) => string;
  decisionLabel: (decision: string | null | undefined) => string;
  accountPrimaryLabel: (account: Partial<AccountPolicyRecord> | null | undefined) => string;
  accountModeLabel: (mode: AccountPolicyMode | string | null | undefined) => string;
  accountMetaLabel: (account: Partial<AccountPolicyRecord> | null | undefined) => string;
  controlDomainLabel: (domain: string | null | undefined) => string;
  severityLabel: (severity: string | null | undefined) => string;
  policyTitle: (policy: RuleDisplay, index: number) => string;
  ruleDescription: (policy: RuleDisplay) => string;
  userImpactSummary: (policy: { decision?: Decision | string | null } | unknown) => string;
  capabilityBaselineSummary: (capability: CapabilityPolicy | unknown) => string;
  onSetCapabilityDefaultDecision: (capabilityId: CapabilityPolicy["capability_id"], decision: Decision) => void;
  onSetRuleDecision: (ruleId: string, decision: Decision) => void;
  onUpdateAccountPolicy: (subject: string, patch: Partial<AccountPolicyRecord>) => void;
  onSetAdminAccount: (subject: string) => void;
};

export function RulesPanel({
  capabilityPolicies,
  additionalRestrictionCount,
  directoryOverrideCount,
  accountCount,
  displayAccounts,
  selectedAdminSubject,
  adminConfigured,
  managementEffective,
  managementInactiveReason,
  hasFilesystemCapability,
  filesystemOverridesProps,
  capabilityLabel,
  capabilityDescription,
  decisionLabel,
  accountPrimaryLabel,
  accountModeLabel,
  accountMetaLabel,
  controlDomainLabel,
  severityLabel,
  policyTitle,
  ruleDescription,
  userImpactSummary,
  capabilityBaselineSummary,
  onSetCapabilityDefaultDecision,
  onSetRuleDecision,
  onUpdateAccountPolicy,
  onSetAdminAccount,
}: RulesPanelProps) {
  const toolControlsDisabled = !managementEffective;
  return (
    <section id="panel-rules" className="tab-panel" role="tabpanel" aria-labelledby="tab-rules">
      <div className="panel-card strategy-panel dashboard-panel">
        <div className="card-head">
          <h2>{ui("工具", "Tools")}</h2>
          <div className="rule-meta">
            <span className="meta-pill">{ui("能力", "Capabilities")} {capabilityPolicies.length}</span>
            <span className="meta-pill">{ui("附加限制", "Additional Restrictions")} {additionalRestrictionCount}</span>
            <span className="meta-pill">{ui("设置例外目录", "Exception Directories")} {directoryOverrideCount}</span>
          </div>
        </div>

        <AdminAccessPanel
          accountCount={accountCount}
          displayAccounts={displayAccounts}
          selectedAdminSubject={selectedAdminSubject}
          adminConfigured={adminConfigured}
          managementEffective={managementEffective}
          inactiveReason={managementInactiveReason}
          accountPrimaryLabel={accountPrimaryLabel}
          accountModeLabel={accountModeLabel}
          accountMetaLabel={accountMetaLabel}
          onUpdateAccountPolicy={onUpdateAccountPolicy}
          onSetAdminAccount={onSetAdminAccount}
        />

        <div className={`management-note ${toolControlsDisabled ? "warn" : "good"}`}>
          {toolControlsDisabled
            ? ui(
              "当前没有管理员，所以下面的工具设置会保持在页面里，但不会参与工具决策。",
              "There is no admin right now, so the tool settings below stay on the page but do not participate in tool decisions."
            )
            : ui(
              "下面的工具设置会直接影响工具运行。",
              "The tool settings below directly affect tool behavior."
            )}
        </div>

        <section className="rule-group rule-group-shell" aria-label={ui("访问基线", "Access baseline")}>
          {capabilityPolicies.length === 0 ? (
            <div className="chart-empty">{ui("暂无能力配置。", "No capability policies configured.")}</div>
          ) : (
            <div className="rule-capability-list">
              {capabilityPolicies.map((capability) => (
                <section key={capability.capability_id} className={`rule-group rule-capability-group ${toolControlsDisabled ? "is-disabled" : ""}`}>
                  <div className="rule-head rule-capability-head">
                    <div>
                      <div className="rule-title">{capabilityLabel(capability.capability_id)}</div>
                      <div className="rule-desc">{capabilityDescription(capability.capability_id)}</div>
                    </div>
                    <div className="rule-head-side">
                      <DecisionTag decision={capability.default_decision} />
                      <span className="tag meta-tag">{ui("Baseline", "Baseline")}</span>
                    </div>
                  </div>

                  <div className="rule-actions" role="group" aria-label={ui(`${capabilityLabel(capability.capability_id)} 默认策略`, `${capabilityLabel(capability.capability_id)} baseline policy`)}>
                    {DECISION_OPTIONS.map((decision) => (
                      <button
                        key={`${capability.capability_id}-${decision}`}
                        className={`rule-action-button ${decision} ${capability.default_decision === decision ? "active" : ""}`}
                        type="button"
                        disabled={toolControlsDisabled}
                        aria-pressed={capability.default_decision === decision}
                        onClick={() => onSetCapabilityDefaultDecision(capability.capability_id, decision as Decision)}
                      >
                        {decisionLabel(decision)}
                      </button>
                    ))}
                  </div>

                  <div className={`rule-helper ${capability.default_decision}`}>
                    <span className="rule-helper-label">
                      {ui("默认策略说明", "Baseline effect")} · {decisionLabel(capability.default_decision)}
                    </span>
                    <p>{capabilityBaselineSummary(capability)}</p>
                  </div>

                  {capability.rules.length === 0 ? (
                    <div className="chart-empty">{ui("当前能力下没有额外附加限制。", "No additional restrictions for this capability.")}</div>
                  ) : (
                    <div className="rules">
                      {capability.rules.map((rule, index) => {
                        const policy = { ...rule, match: rule.context };
                        return (
                          <article key={`${capability.capability_id}:${rule.rule_id || index}`} className="rule">
                            <div className="rule-head">
                              <div className="rule-title">{policyTitle(policy, index)}</div>
                              <div className="rule-head-side">
                                <DecisionTag decision={rule.decision} />
                                <div className="rule-tags" aria-label={ui("规则标签", "Rule tags")}>
                                  <span className="tag meta-tag">{controlDomainLabel(rule.control_domain || rule.group)}</span>
                                  {rule.severity ? <span className={`tag meta-tag severity-${rule.severity}`}>{severityLabel(rule.severity)}</span> : null}
                                  {rule.owner ? <span className="tag meta-tag">{rule.owner}</span> : null}
                                </div>
                              </div>
                            </div>
                            <div className="rule-actions" role="group" aria-label={ui(`规则 ${rule.rule_id || index + 1} 的策略动作`, `Policy actions for rule ${rule.rule_id || index + 1}`)}>
                              {DECISION_OPTIONS.map((decision) => (
                                <button
                                  key={`${rule.rule_id}-${decision}`}
                                  className={`rule-action-button ${decision} ${rule.decision === decision ? "active" : ""}`}
                                  type="button"
                                  disabled={toolControlsDisabled}
                                  aria-pressed={rule.decision === decision}
                                  onClick={() => onSetRuleDecision(rule.rule_id, decision as Decision)}
                                >
                                  {decisionLabel(decision)}
                                </button>
                              ))}
                            </div>
                            <div className="rule-desc">{ruleDescription(policy)}</div>
                            <div className={`rule-helper ${rule.decision}`}>
                              <span className="rule-helper-label">
                                {ui("当前处理方式", "Current handling")} · {decisionLabel(rule.decision)}
                              </span>
                              <p>{userImpactSummary(rule)}</p>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}

                  {capability.capability_id === "filesystem" ? (
                    <FilesystemOverridesSection
                      inline
                      disabled={toolControlsDisabled}
                      disabledReason={managementInactiveReason}
                      {...filesystemOverridesProps}
                    />
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </section>

        {!hasFilesystemCapability ? (
          <FilesystemOverridesSection
            disabled={toolControlsDisabled}
            disabledReason={managementInactiveReason}
            {...filesystemOverridesProps}
          />
        ) : null}
      </div>
    </section>
  );
}
