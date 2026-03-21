import type { ApprovalRepository } from "../../domain/ports/approval_repository.ts";
import type { ApprovalGrantMode, ApprovalService } from "../../domain/services/approval_service.ts";
import type { SecurityClawLocale } from "../../i18n/locale.ts";
import { pickLocalized } from "../../i18n/locale.ts";
import type { NumericAction } from "../../domain/services/user_approval_context_service.ts";

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
  locale?: SecurityClawLocale;
}

export class ApprovalCommands {
  private locale: SecurityClawLocale;

  constructor(
    private repository: ApprovalRepository,
    private approvalService: ApprovalService,
    private config: ApprovalCommandConfig,
  ) {
    this.locale = config.locale ?? "en";
  }

  async handleApprove(ctx: ApprovalCommandContext): Promise<{ text: string }> {
    if (!this.config.enabled) {
      return { text: this.text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return { text: this.text("你无权审批 SecurityClaw 请求。", "You are not allowed to approve SecurityClaw requests.") };
    }
    const approvalId = this.parseApprovalId(ctx.args);
    if (!approvalId) {
      return { text: this.text("用法: /securityclaw-approve <approval_id> [long]", "Usage: /securityclaw-approve <approval_id> [long]") };
    }
    const grantMode = this.parseApprovalGrantMode(ctx.args);
    return this.executeApprove(approvalId, grantMode, ctx);
  }

  async handleReject(ctx: ApprovalCommandContext): Promise<{ text: string }> {
    if (!this.config.enabled) {
      return { text: this.text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return { text: this.text("你无权审批 SecurityClaw 请求。", "You are not allowed to approve SecurityClaw requests.") };
    }
    const approvalId = this.parseApprovalId(ctx.args);
    if (!approvalId) {
      return { text: this.text("用法: /securityclaw-reject <approval_id>", "Usage: /securityclaw-reject <approval_id>") };
    }
    return this.executeReject(approvalId, ctx);
  }

  async handlePending(ctx: ApprovalCommandContext): Promise<{ text: string }> {
    if (!this.config.enabled) {
      return { text: this.text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return { text: this.text("你无权查看 SecurityClaw 待审批请求。", "You are not allowed to view pending SecurityClaw approvals.") };
    }
    return { text: this.approvalService.formatPendingApprovals(this.repository.listPending(10)) };
  }

  /**
   * Handle numeric shortcut input (1, 2, 3).
   * Returns undefined if input is not a valid numeric shortcut or no context exists.
   */
  async handleNumericShortcut(ctx: ApprovalCommandContext): Promise<{ text: string } | undefined> {
    if (!this.config.enabled) {
      return undefined;
    }
    if (!ctx.isAuthorizedSender || !this.matchesApprover(ctx)) {
      return undefined;
    }

    const input = ctx.args?.trim();
    if (!input || !/^[123]$/.test(input)) {
      return undefined;
    }

    const channel = this.normalizeApprovalChannel(ctx.channel);
    if (!channel) {
      return undefined;
    }

    const userId = this.extractUserId(ctx);
    if (!userId) {
      return undefined;
    }

    const userContextService = this.approvalService.getUserContextService();
    const resolved = userContextService.resolveNumericInput(input, channel, userId, ctx.accountId);

    if (!resolved) {
      return undefined;
    }

    const { approvalId, action } = resolved;

    // Execute the action
    let result: { text: string };
    if (action === "reject") {
      result = await this.executeReject(approvalId, ctx);
    } else {
      const grantMode: ApprovalGrantMode = action === "approve_longterm" ? "longterm" : "temporary";
      result = await this.executeApprove(approvalId, grantMode, ctx);
    }

    // Clear user context after successful action
    userContextService.clearUserContext(channel, userId, ctx.accountId);

    return result;
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
    return this.text(mode === "longterm" ? "长期授权" : "临时授权", mode === "longterm" ? "Long-lived grant" : "Temporary grant");
  }

  private text(zhText: string, enText: string): string {
    return pickLocalized(this.locale, zhText, enText);
  }

  private executeApprove(approvalId: string, grantMode: ApprovalGrantMode, ctx: ApprovalCommandContext): { text: string } {
    const existing = this.repository.getById(approvalId);
    if (!existing) {
      return { text: this.text(`审批请求不存在: ${approvalId}`, `Approval request not found: ${approvalId}`) };
    }
    if (existing.status !== "pending") {
      return {
        text: this.text(
          `审批请求当前状态为 ${existing.status}，无法重复批准。`,
          `Approval request is ${existing.status}; it cannot be approved again.`,
        ),
      };
    }
    const grantExpiresAt = this.approvalService.resolveApprovalGrantExpiry(existing, grantMode);
    this.repository.resolve(
      approvalId,
      `${ctx.channel ?? "unknown"}:${ctx.from ?? "unknown"}`,
      "approved",
      { expires_at: grantExpiresAt },
    );
    return {
      text: this.text(
        `已为 ${existing.actor_id} 添加${this.formatGrantModeLabel(grantMode)}，范围=${existing.scope}，有效期至 ${this.approvalService["formatTimestampForApproval"](grantExpiresAt)}。`,
        `${this.formatGrantModeLabel(grantMode)} granted for ${existing.actor_id}, scope=${existing.scope}, expires at ${this.approvalService["formatTimestampForApproval"](grantExpiresAt)}.`,
      ),
    };
  }

  private executeReject(approvalId: string, ctx: ApprovalCommandContext): { text: string } {
    const existing = this.repository.getById(approvalId);
    if (!existing) {
      return { text: this.text(`审批请求不存在: ${approvalId}`, `Approval request not found: ${approvalId}`) };
    }
    if (existing.status !== "pending") {
      return {
        text: this.text(
          `审批请求当前状态为 ${existing.status}，无法重复拒绝。`,
          `Approval request is ${existing.status}; it cannot be rejected again.`,
        ),
      };
    }
    this.repository.resolve(
      approvalId,
      `${ctx.channel ?? "unknown"}:${ctx.from ?? "unknown"}`,
      "rejected",
    );
    return {
      text: this.text(
        `已拒绝 ${approvalId}，不会为 ${existing.actor_id} 增加授权。`,
        `Rejected ${approvalId}. No grant was added for ${existing.actor_id}.`,
      ),
    };
  }

  private extractUserId(ctx: ApprovalCommandContext): string | undefined {
    return ctx.from?.trim() || ctx.senderId?.trim();
  }
}
