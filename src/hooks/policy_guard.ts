import type {
  ApprovalRecord,
  BeforeToolCallInput,
  DecisionContext,
  GuardComputation,
  SecurityContext,
} from "../types.ts";
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

function invalidApprovalResult(
  input: BeforeToolCallInput,
  securityContext: SecurityContext,
  approval: ApprovalRecord,
  reasonCodes: string[],
): GuardComputation<BeforeToolCallInput> {
  return {
    mutated_payload: { ...input, security_context: securityContext } as BeforeToolCallInput,
    decision: "block",
    decision_source: "approval",
    reason_codes: reasonCodes,
    sanitization_actions: [],
    security_context: securityContext,
    approval,
  };
}

function validateApprovedReplay(approval: ApprovalRecord, context: DecisionContext): string[] {
  const reasons: string[] = [];
  if (approval.request_context.actor_id !== context.actor_id) {
    reasons.push("APPROVAL_ACTOR_MISMATCH");
  }
  if (approval.request_context.scope !== context.scope) {
    reasons.push("APPROVAL_SCOPE_MISMATCH");
  }
  if (
    approval.request_context.tool_name !== undefined &&
    context.tool_name !== undefined &&
    approval.request_context.tool_name !== context.tool_name
  ) {
    reasons.push("APPROVAL_TOOL_MISMATCH");
  }
  if (approval.request_context.resource_scope !== context.resource_scope) {
    reasons.push("APPROVAL_RESOURCE_SCOPE_MISMATCH");
  }

  const requirements = approval.approval_requirements;
  if (requirements?.trace_binding === "trace" && approval.request_context.trace_id !== context.security_context.trace_id) {
    reasons.push("APPROVAL_TRACE_SCOPE_MISMATCH");
  }
  if (requirements?.ticket_required === true && !approval.ticket_id) {
    reasons.push("APPROVAL_TICKET_REQUIRED");
  }
  if (
    requirements?.approver_roles?.length &&
    (!approval.approver_role || !requirements.approver_roles.includes(approval.approver_role))
  ) {
    reasons.push("APPROVAL_ROLE_MISMATCH");
  }
  if (requirements?.single_use === true && approval.used_at) {
    reasons.push("APPROVAL_ALREADY_USED");
  }

  return reasons;
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
    ...(input.tool_group !== undefined ? { tool_group: input.tool_group } : {}),
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    tags: [...new Set([...(input.tags ?? []), ...securityContext.tags])],
    resource_scope: input.resource_scope ?? "none",
    resource_paths: [...(input.resource_paths ?? [])],
    ...(input.file_type !== undefined ? { file_type: input.file_type } : {}),
    asset_labels: [...new Set(input.asset_labels ?? [])],
    data_labels: [...new Set(input.data_labels ?? [])],
    trust_level: input.trust_level ?? (securityContext.untrusted ? "untrusted" : "trusted"),
    ...(input.destination_type !== undefined ? { destination_type: input.destination_type } : {}),
    ...(input.dest_domain !== undefined ? { dest_domain: input.dest_domain } : {}),
    ...(input.dest_ip_class !== undefined ? { dest_ip_class: input.dest_ip_class } : {}),
    ...(input.tool_args_summary !== undefined ? { tool_args_summary: input.tool_args_summary } : {}),
    volume: { ...(input.volume ?? {}) },
    security_context: securityContext
  };

  if (input.approval_id) {
    const approval = approvals.getApprovalStatus(input.approval_id);
    if (approval?.status === "approved") {
      const replayViolations = validateApprovedReplay(approval, context);
      if (replayViolations.length > 0) {
        return invalidApprovalResult(input, securityContext, approval, replayViolations);
      }
      if (approval.approval_requirements?.single_use === true) {
        approvals.markApprovalUsed(approval.approval_id);
      }
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
    const requestOptions = {
      reason_codes: outcome.reason_codes,
      rule_ids: outcome.matched_rules.map((rule) => rule.rule_id),
      ...(outcome.challenge_ttl_seconds !== undefined ? { ttl_seconds: outcome.challenge_ttl_seconds } : {}),
      ...(outcome.approval_requirements ? { approval_requirements: outcome.approval_requirements } : {}),
    };
    approval = approvals.requestApproval(context, requestOptions);
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
