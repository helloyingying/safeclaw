import { randomUUID } from "node:crypto";

import type { ApprovalRecord, ApprovalService, DecisionContext, ReasonCode } from "../types.ts";
import { nowIso } from "../utils.ts";

export class ApprovalFsm implements ApprovalService {
  #records = new Map<string, ApprovalRecord>();
  #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  requestApproval(
    context: DecisionContext,
    ttlSeconds = 900,
    reasonCodes: ReasonCode[] = [],
  ): ApprovalRecord {
    const requestedAt = this.#now();
    const requestContext: ApprovalRecord["request_context"] = {
      actor_id: context.actor_id,
      scope: context.scope,
      reason_codes: reasonCodes
    };
    if (context.tool_name !== undefined) {
      requestContext.tool_name = context.tool_name;
    }
    const record: ApprovalRecord = {
      approval_id: randomUUID(),
      status: "pending",
      requested_at: new Date(requestedAt).toISOString(),
      expires_at: new Date(requestedAt + ttlSeconds * 1000).toISOString(),
      request_context: requestContext
    };
    this.#records.set(record.approval_id, record);
    return record;
  }

  resolveApproval(
    approvalId: string,
    approver: string,
    decision: "approved" | "rejected",
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
      decided_at: nowIso(this.#now)
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
