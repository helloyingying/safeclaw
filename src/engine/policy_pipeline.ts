import type {
  DecisionContext,
  DecisionOutcome,
  FileRule,
  PolicyRule,
  SecurityClawConfig,
} from "../types.ts";
import { DecisionEngine } from "./decision_engine.ts";
import { RuleEngine } from "./rule_engine.ts";
import { defaultFileRuleReasonCode, matchFileRule } from "../domain/services/file_rule_registry.ts";

export type PolicyPipelineOutcome = DecisionOutcome & {
  matched_file_rule?: FileRule;
};

export class PolicyPipeline {
  readonly config: SecurityClawConfig;
  readonly ruleEngine: RuleEngine;
  readonly decisionEngine: DecisionEngine;

  constructor(config: SecurityClawConfig) {
    this.config = config;
    this.ruleEngine = new RuleEngine(config.policies);
    this.decisionEngine = new DecisionEngine(config);
  }

  evaluate(context: DecisionContext, fileRules: FileRule[] = this.config.file_rules): PolicyPipelineOutcome {
    const matchedFileRule = matchFileRule(context.resource_paths, fileRules, context.operation);
    if (matchedFileRule) {
      return {
        decision: matchedFileRule.decision,
        decision_source: "file_rule",
        reason_codes: matchedFileRule.reason_codes?.length
          ? [...matchedFileRule.reason_codes]
          : [defaultFileRuleReasonCode(matchedFileRule.decision)],
        matched_rules: [],
        ...(matchedFileRule.decision === "challenge"
          ? { challenge_ttl_seconds: this.config.defaults.approval_ttl_seconds }
          : {}),
        matched_file_rule: matchedFileRule,
      };
    }

    const matches = this.ruleEngine.match(context);
    return this.decisionEngine.evaluate(context, matches);
  }
}

export function matchedPolicyRuleIds(outcome: Pick<PolicyPipelineOutcome, "matched_rules" | "matched_file_rule">): string[] {
  if (outcome.matched_file_rule) {
    return [`file_rule:${outcome.matched_file_rule.id}`];
  }
  return outcome.matched_rules.map((rule: PolicyRule) => rule.rule_id);
}
