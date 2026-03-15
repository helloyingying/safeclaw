import type { ApprovalRecord, BeforeToolCallInput, DecisionContext, GuardComputation, SecurityContext } from "../types.ts";
import type { ApprovalFsm } from "../engine/approval_fsm.ts";
import type { DecisionEngine } from "../engine/decision_engine.ts";
import type { RuleEngine } from "../engine/rule_engine.ts";

function buildSecurityContext(
  input: BeforeToolCallInput,
  policyVersion: string,
  traceId: string,
  nowIso: string,
): SecurityContext {
  return {
    trace_id: input.security_context?.trace_id ?? traceId,
    actor_id: input.actor_id,
    workspace: input.workspace,
    policy_version: input.security_context?.policy_version ?? policyVersion,
    untrusted: input.security_context?.untrusted ?? false,
    tags: [...(input.security_context?.tags ?? input.tags ?? [])],
    created_at: input.security_context?.created_at ?? nowIso
  };
}

export function runPolicyGuard(
  input: BeforeToolCallInput,
  policyVersion: string,
  traceId: string,
  nowIso: string,
  ruleEngine: RuleEngine,
  decisionEngine: DecisionEngine,
  approvals: ApprovalFsm,
  ): GuardComputation<BeforeToolCallInput> {
  const securityContext = buildSecurityContext(input, policyVersion, traceId, nowIso);
  const context: DecisionContext = {
    actor_id: input.actor_id,
    scope: input.scope,
    tool_name: input.tool_name,
    tags: [...new Set([...(input.tags ?? []), ...securityContext.tags])],
    resource_scope: input.resource_scope ?? "none",
    resource_paths: [...(input.resource_paths ?? [])],
    security_context: securityContext
  };

  if (input.approval_id) {
    const approval = approvals.getApprovalStatus(input.approval_id);
    if (approval?.status === "approved") {
      const result: GuardComputation<BeforeToolCallInput> = {
        mutated_payload: { ...input, security_context: securityContext } as BeforeToolCallInput,
        decision: "allow",
        decision_source: "approval",
        reason_codes: ["APPROVAL_GRANTED"],
        sanitization_actions: [],
        security_context: securityContext
      };
      result.approval = approval;
      return result;
    }
    if (approval && approval.status !== "pending") {
      const result: GuardComputation<BeforeToolCallInput> = {
        mutated_payload: { ...input, security_context: securityContext } as BeforeToolCallInput,
        decision: "block",
        decision_source: "approval",
        reason_codes: [`APPROVAL_${approval.status.toUpperCase()}`],
        sanitization_actions: [],
        security_context: securityContext
      };
      result.approval = approval;
      return result;
    }
  }

  const matches = ruleEngine.match(context);
  const outcome = decisionEngine.evaluate(context, matches);

  let approval: ApprovalRecord | undefined;
  if (outcome.decision === "challenge") {
    approval = approvals.requestApproval(
      context,
      outcome.challenge_ttl_seconds,
      outcome.reason_codes,
    );
  }

  const result: GuardComputation<BeforeToolCallInput> = {
    mutated_payload: { ...input, security_context: securityContext } as BeforeToolCallInput,
    decision: outcome.decision,
    decision_source: outcome.decision_source,
    reason_codes: outcome.reason_codes,
    sanitization_actions: [],
    security_context: securityContext
  };
  if (approval !== undefined) {
    result.approval = approval;
  }
  return result;
}
