import { randomUUID } from "node:crypto";

import type {
  ApprovalRecord,
  ApprovalRequestOptions,
  ApprovalResolutionMetadata,
  ApprovalService,
  DecisionContext,
} from "../types.ts";
import { nowIso } from "../utils.ts";

export class ApprovalFsm implements ApprovalService {
  #records = new Map<string, ApprovalRecord>();
  #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  requestApproval(
    context: DecisionContext,
    options: ApprovalRequestOptions = {},
  ): ApprovalRecord {
    const requestedAt = this.#now();
    const requestContext: ApprovalRecord["request_context"] = {
      trace_id: context.security_context.trace_id,
      actor_id: context.actor_id,
      scope: context.scope,
      resource_scope: context.resource_scope,
      resource_paths: [...context.resource_paths],
      reason_codes: [...(options.reason_codes ?? [])],
      rule_ids: [...(options.rule_ids ?? [])],
    };
    if (context.tool_name !== undefined) {
      requestContext.tool_name = context.tool_name;
    }
    if (context.tool_group !== undefined) {
      requestContext.tool_group = context.tool_group;
    }
    const ttlSeconds = options.ttl_seconds ?? 900;
    const record: ApprovalRecord = {
      approval_id: randomUUID(),
      status: "pending",
      requested_at: new Date(requestedAt).toISOString(),
      expires_at: new Date(requestedAt + ttlSeconds * 1000).toISOString(),
      request_context: requestContext,
      ...(options.approval_requirements ? { approval_requirements: options.approval_requirements } : {}),
    };
    this.#records.set(record.approval_id, record);
    return record;
  }

  resolveApproval(
    approvalId: string,
    approver: string,
    decision: "approved" | "rejected",
    metadata?: ApprovalResolutionMetadata,
  ): ApprovalRecord | undefined {
    const record = this.getApprovalStatus(approvalId);
    if (!record || record.status !== "pending") {
      return record;
    }
    const updated: ApprovalRecord = {
      ...record,
      status: decision,
      decision,
      approver,
      ...(metadata?.approver_role ? { approver_role: metadata.approver_role } : {}),
      ...(metadata?.ticket_id ? { ticket_id: metadata.ticket_id } : {}),
      decided_at: nowIso(this.#now)
    };
    this.#records.set(approvalId, updated);
    return updated;
  }

  markApprovalUsed(approvalId: string): ApprovalRecord | undefined {
    const record = this.getApprovalStatus(approvalId);
    if (!record || record.status !== "approved") {
      return record;
    }
    const updated: ApprovalRecord = {
      ...record,
      used_at: nowIso(this.#now),
    };
    this.#records.set(approvalId, updated);
    return updated;
  }

  getApprovalStatus(approvalId: string): ApprovalRecord | undefined {
    const record = this.#records.get(approvalId);
    if (!record) {
      return undefined;
    }
    if (record.status === "pending" && this.#now() > new Date(record.expires_at).getTime()) {
      const expired: ApprovalRecord = {
        ...record,
        status: "expired"
      };
      this.#records.set(approvalId, expired);
      return expired;
    }
    return record;
  }
}
