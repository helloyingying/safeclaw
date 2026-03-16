import type { ApprovalRepository } from "../../domain/ports/approval_repository.ts";
import type { ApprovalGrantMode, ApprovalService } from "../../domain/services/approval_service.ts";

export interface ApprovalCommandContext {
  channel?: string;
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  args?: string;
  isAuthorizedSender: boolean;
}

export interface ApprovalCommandConfig {
  enabled: boolean;
  approvers: Array<{
    channel: string;
    from: string;
    accountId?: string;
  }>;
}

export class ApprovalCommands {
  constructor(
    private repository: ApprovalRepository,
    private approvalService: ApprovalService,
    private config: ApprovalCommandConfig,
  ) {}

  async handleApprove(ctx: ApprovalCommandContext): Promise<{ text: string }> {
    if (!this.config.enabled) {
      return { text: "SafeClaw 审批桥接未启用。" };
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return { text: "你无权审批 SafeClaw 请求。" };
    }
    const approvalId = this.parseApprovalId(ctx.args);
    if (!approvalId) {
      return { text: `用法: /safeclaw-approve <approval_id> [long]` };
    }
    const existing = this.repository.getById(approvalId);
    if (!existing) {
      return { text: `审批请求不存在: ${approvalId}` };
    }
    if (existing.status !== "pending") {
      return { text: `审批请求当前状态为 ${existing.status}，无法重复批准。` };
    }
    const grantMode = this.parseApprovalGrantMode(ctx.args);
    const grantExpiresAt = this.approvalService.resolveApprovalGrantExpiry(existing, grantMode);
    this.repository.resolve(
      approvalId,
      `${ctx.channel ?? "unknown"}:${ctx.from ?? "unknown"}`,
      "approved",
      { expires_at: grantExpiresAt },
    );
    return {
      text: `已为 ${existing.actor_id} 添加${this.formatGrantModeLabel(grantMode)}，范围=${existing.scope}，有效期至 ${this.approvalService["formatTimestampForApproval"](grantExpiresAt)}。`,
    };
  }

  async handleReject(ctx: ApprovalCommandContext): Promise<{ text: string }> {
    if (!this.config.enabled) {
      return { text: "SafeClaw 审批桥接未启用。" };
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return { text: "你无权审批 SafeClaw 请求。" };
    }
    const approvalId = this.parseApprovalId(ctx.args);
    if (!approvalId) {
      return { text: `用法: /safeclaw-reject <approval_id>` };
    }
    const existing = this.repository.getById(approvalId);
    if (!existing) {
      return { text: `审批请求不存在: ${approvalId}` };
    }
    if (existing.status !== "pending") {
      return { text: `审批请求当前状态为 ${existing.status}，无法重复拒绝。` };
    }
    this.repository.resolve(
      approvalId,
      `${ctx.channel ?? "unknown"}:${ctx.from ?? "unknown"}`,
      "rejected",
    );
    return { text: `已拒绝 ${approvalId}，不会为 ${existing.actor_id} 增加授权。` };
  }

  async handlePending(ctx: ApprovalCommandContext): Promise<{ text: string }> {
    if (!this.config.enabled) {
      return { text: "SafeClaw 审批桥接未启用。" };
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return { text: "你无权查看 SafeClaw 待审批请求。" };
    }
    return { text: this.approvalService.formatPendingApprovals(this.repository.listPending(10)) };
  }

  private matchesApprover(ctx: ApprovalCommandContext): boolean {
    const channel = this.normalizeApprovalChannel(ctx.channel);
    if (!channel) {
      return false;
    }
    const senderIds = new Set<string>();
    const collectSenderId = (value: string | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return;
      }
      senderIds.add(trimmed);
      const lower = trimmed.toLowerCase();
      const channelPrefix = `${channel}:`;
      if (lower.startsWith(channelPrefix)) {
        const unscoped = trimmed.slice(channelPrefix.length).trim();
        if (unscoped) {
          senderIds.add(unscoped);
        }
        return;
      }
      senderIds.add(`${channel}:${trimmed}`);
    };

    collectSenderId(ctx.from);
    collectSenderId(ctx.senderId);
    if (senderIds.size === 0) {
      return false;
    }

    return this.config.approvers.some((approver) => {
      if (approver.channel !== channel || !senderIds.has(approver.from)) {
        return false;
      }
      if (approver.accountId && approver.accountId !== ctx.accountId) {
        return false;
      }
      return true;
    });
  }

  private normalizeApprovalChannel(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
  }

  private parseApprovalId(args: string | undefined): string | undefined {
    const value = args?.trim();
    return value ? value.split(/\s+/)[0] : undefined;
  }

  private parseApprovalGrantMode(args: string | undefined): ApprovalGrantMode {
    const value = args?.trim();
    const mode = value ? value.split(/\s+/)[1]?.toLowerCase() : undefined;
    if (mode === "long" || mode === "longterm" || mode === "permanent" || mode === "长期") {
      return "longterm";
    }
    return "temporary";
  }

  private formatGrantModeLabel(mode: ApprovalGrantMode): string {
    return mode === "longterm" ? "长期授权" : "临时授权";
  }
}
