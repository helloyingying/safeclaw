import type { DecisionContext, DecisionOutcome, RuleMatch, SecurityClawConfig } from "../types.ts";

export class DecisionEngine {
  readonly config: SecurityClawConfig;

  constructor(config: SecurityClawConfig) {
    this.config = config;
  }

  evaluate(_context: DecisionContext, matches: RuleMatch[]): DecisionOutcome {
    const decisiveRule = matches.find((match) => Boolean(match.rule.decision));

    if (decisiveRule?.rule.decision) {
      const outcome: DecisionOutcome = {
        decision: decisiveRule.rule.decision,
        decision_source: "rule",
        reason_codes: decisiveRule.rule.reason_codes,
        matched_rules: matches.map((match) => match.rule)
      };
      if (decisiveRule.rule.decision === "challenge") {
        outcome.challenge_ttl_seconds =
          decisiveRule.rule.approval_requirements?.ttl_seconds ??
          decisiveRule.rule.challenge?.ttl_seconds ??
          this.config.defaults.approval_ttl_seconds;
        if (decisiveRule.rule.approval_requirements) {
          outcome.approval_requirements = decisiveRule.rule.approval_requirements;
        }
      }
      return outcome;
    }

    return {
      decision: "allow",
      decision_source: "default",
      reason_codes: ["NO_MATCH_DEFAULT_ALLOW"],
      matched_rules: matches.map((match) => match.rule)
    };
  }
}
