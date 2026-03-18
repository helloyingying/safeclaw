import type { CapabilityPolicy, StrategyPolicyRule } from "../../src/domain/services/strategy_model.ts";
import type { Decision, PolicyMatch } from "../../src/types.ts";
import { DECISION_OPTIONS, ui } from "./dashboard_core.ts";
import { DecisionTag } from "./dashboard_primitives.tsx";
import { FilesystemOverridesSection } from "./filesystem_overrides_section.tsx";
import type { FilesystemOverridesSectionProps } from "./filesystem_overrides_section.tsx";

type RuleDisplay = StrategyPolicyRule & {
  match: PolicyMatch;
};

type RulesPanelProps = {
  capabilityPolicies: CapabilityPolicy[];
  additionalRestrictionCount: number;
  directoryOverrideCount: number;
  hasFilesystemCapability: boolean;
  filesystemOverridesProps: FilesystemOverridesSectionProps;
  capabilityLabel: (capabilityId: string | null | undefined) => string;
  capabilityDescription: (capabilityId: string | null | undefined) => string;
  decisionLabel: (decision: string | null | undefined) => string;
  controlDomainLabel: (domain: string | null | undefined) => string;
  severityLabel: (severity: string | null | undefined) => string;
  policyTitle: (policy: RuleDisplay, index: number) => string;
  ruleDescription: (policy: RuleDisplay) => string;
  userImpactSummary: (policy: { decision?: Decision | string | null } | unknown) => string;
  capabilityBaselineSummary: (capability: CapabilityPolicy | unknown) => string;
  onSetCapabilityDefaultDecision: (capabilityId: CapabilityPolicy["capability_id"], decision: Decision) => void;
  onSetRuleDecision: (ruleId: string, decision: Decision) => void;
};

export function RulesPanel({
  capabilityPolicies,
  additionalRestrictionCount,
  directoryOverrideCount,
  hasFilesystemCapability,
  filesystemOverridesProps,
  capabilityLabel,
  capabilityDescription,
  decisionLabel,
  controlDomainLabel,
  severityLabel,
  policyTitle,
  ruleDescription,
  userImpactSummary,
  capabilityBaselineSummary,
  onSetCapabilityDefaultDecision,
  onSetRuleDecision,
}: RulesPanelProps) {
  return (
    <section id="panel-rules" className="tab-panel" role="tabpanel" aria-labelledby="tab-rules">
      <div className="panel-card strategy-panel dashboard-panel">
        <div className="card-head">
          <h2>{ui("策略", "Strategy")}</h2>
          <div className="rule-meta">
            <span className="meta-pill">{ui("能力", "Capabilities")} {capabilityPolicies.length}</span>
            <span className="meta-pill">{ui("附加限制", "Additional Restrictions")} {additionalRestrictionCount}</span>
            <span className="meta-pill">{ui("目录例外", "Directory Overrides")} {directoryOverrideCount}</span>
          </div>
        </div>

        <section className="rule-group rule-group-shell" aria-label={ui("访问基线", "Access baseline")}>
          <div className="card-head">
            <div>
              <span className="eyebrow">{ui("Access", "Access")}</span>
              <h3>{ui("先看能力默认策略，再看附加限制", "Capability baseline first, then additional restrictions")}</h3>
              <p className="sensitive-path-intro">
                {ui(
                  "先定义每类能力的默认处理方式，再看哪些风险条件会升级成提醒、确认或拦截。需要管理员确认的规则会在执行时生成审批单。",
                  "Define the default posture for each capability first, then inspect which risk conditions escalate to warn, challenge, or block. Rules that need admin approval will still generate approval requests at runtime."
                )}
              </p>
            </div>
          </div>

          {capabilityPolicies.length === 0 ? (
            <div className="chart-empty">{ui("暂无能力配置。", "No capability policies configured.")}</div>
          ) : (
            <div className="rule-capability-list">
              {capabilityPolicies.map((capability) => (
                <section key={capability.capability_id} className="rule-group rule-capability-group">
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
                    <FilesystemOverridesSection inline {...filesystemOverridesProps} />
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </section>

        {!hasFilesystemCapability ? <FilesystemOverridesSection {...filesystemOverridesProps} /> : null}
      </div>
    </section>
  );
}
