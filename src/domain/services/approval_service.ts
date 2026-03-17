import { setTimeout as sleep } from "node:timers/promises";

import type { ApprovalRepository, StoredApprovalRecord, StoredApprovalNotification } from "../ports/approval_repository.ts";
import type { NotificationPort, NotificationTarget } from "../ports/notification_port.ts";
import type { OpenClawLogger } from "../ports/openclaw_adapter.ts";
import type { SecurityClawLocale } from "../../i18n/locale.ts";
import { localeForIntl, pickLocalized } from "../../i18n/locale.ts";

const APPROVAL_NOTIFICATION_MAX_ATTEMPTS = 3;
const APPROVAL_NOTIFICATION_RETRY_DELAYS_MS = [250, 750];
const APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS = 60_000;
const APPROVAL_NOTIFICATION_HISTORY_LIMIT = 12;
const APPROVAL_LONG_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_DISPLAY_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type ApprovalGrantMode = "temporary" | "longterm";

export interface ApprovalNotificationResult {
  sent: boolean;
  notifications: StoredApprovalNotification[];
}

export class ApprovalService {
  constructor(
    private repository: ApprovalRepository,
    private notificationAdapters: Map<string, NotificationPort>,
    private logger: OpenClawLogger,
    private locale: SecurityClawLocale = "en",
  ) {}

  async sendNotifications(
    targets: NotificationTarget[],
    record: StoredApprovalRecord,
  ): Promise<ApprovalNotificationResult> {
    if (targets.length === 0) {
      return { sent: false, notifications: [] };
    }

    const notifications: StoredApprovalNotification[] = [];
    let sent = false;
    const prompt = this.formatApprovalPrompt(record);

    for (const target of targets) {
      const adapter = this.notificationAdapters.get(target.channel);
      if (!adapter) {
        this.logger.warn?.(`securityclaw: no adapter for channel ${target.channel}`);
        continue;
      }

      let delivered = false;
      let lastError: unknown;

      for (let attempt = 1; attempt <= APPROVAL_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
        try {
          const options = target.channel === "telegram" ? {
            buttons: [
              [
                {
                  text: this.formatApprovalButtonLabel(record, "temporary"),
                  callback_data: `/securityclaw-approve ${record.approval_id}`,
                  style: "success",
                },
                {
                  text: this.formatApprovalButtonLabel(record, "longterm"),
                  callback_data: `/securityclaw-approve ${record.approval_id} long`,
                  style: "primary",
                },
              ],
              [
                {
                  text: this.text("拒绝", "Reject"),
                  callback_data: `/securityclaw-reject ${record.approval_id}`,
                  style: "danger",
                },
              ],
            ],
          } : undefined;

          const notification = await adapter.send(target, prompt, options);
          notifications.push(notification);
          sent = true;
          delivered = true;

          this.logger.info?.(
            `securityclaw: sent approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} attempt=${attempt}${notification.messageId ? ` message_id=${notification.messageId}` : ""}`,
          );
          break;
        } catch (error) {
          lastError = error;
          if (attempt < APPROVAL_NOTIFICATION_MAX_ATTEMPTS) {
            this.logger.warn?.(
              `securityclaw: retrying approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} attempt=${attempt} (${String(error)})`,
            );
            await sleep(APPROVAL_NOTIFICATION_RETRY_DELAYS_MS[attempt - 1] ?? APPROVAL_NOTIFICATION_RETRY_DELAYS_MS.at(-1) ?? 250);
          }
        }
      }

      if (!delivered) {
        this.logger.warn?.(
          `securityclaw: failed to send approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} (${String(lastError)})`,
        );
      }
    }

    return { sent, notifications };
  }

  shouldResendPendingApproval(record: StoredApprovalRecord, nowMs = Date.now()): boolean {
    if (record.notifications.length === 0) {
      return true;
    }
    const latestSentAt = record.notifications
      .map((notification) => this.parseTimestampMs(notification.sent_at))
      .reduce<number | undefined>((latest, current) => {
        if (current === undefined) {
          return latest;
        }
        if (latest === undefined || current > latest) {
          return current;
        }
        return latest;
      }, undefined);
    const baseline = latestSentAt ?? this.parseTimestampMs(record.requested_at);
    if (baseline === undefined) {
      return true;
    }
    return nowMs - baseline >= APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS;
  }

  mergeApprovalNotifications(
    existing: StoredApprovalNotification[],
    incoming: StoredApprovalNotification[],
  ): StoredApprovalNotification[] {
    if (incoming.length === 0) {
      return existing;
    }
    return [...existing, ...incoming].slice(-APPROVAL_NOTIFICATION_HISTORY_LIMIT);
  }

  resolveApprovalGrantExpiry(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
    if (mode === "longterm") {
      return new Date(Date.now() + APPROVAL_LONG_GRANT_TTL_MS).toISOString();
    }
    return new Date(Date.now() + this.resolveTemporaryGrantDurationMs(record)).toISOString();
  }

  formatApprovalBlockReason(params: {
    toolName: string;
    scope: string;
    traceId: string;
    resourceScope: string;
    reasonCodes: string[];
    rules: string;
    approvalId: string;
    notificationSent: boolean;
  }): string {
    const reasons = params.reasonCodes.join(", ");
    const notifyHint = params.notificationSent
      ? this.text(
        "已通知管理员，批准后可重试。",
        "Sent to admin. Retry after approval.",
      )
      : this.text(
        "通知失败，请将审批单交给管理员处理。",
        "Admin notification failed. Share the request ID with an approver.",
      );
    const lines = [
      this.text("SecurityClaw 需要审批", "SecurityClaw Approval Required"),
      `${this.text("工具", "Tool")}: ${params.toolName}`,
      `${this.text("范围", "Scope")}: ${params.scope}`,
      `${this.text("资源", "Resource")}: ${this.formatResourceScopeDetail(params.resourceScope)}`,
      `${this.text("原因", "Reason")}: ${reasons || this.text("策略要求复核", "Policy review required")}`,
      ...(params.rules && params.rules !== "-"
        ? [`${this.text("规则", "Policy")}: ${params.rules}`]
        : []),
      `${this.text("审批单", "Request ID")}: ${params.approvalId}`,
      `${this.text("状态", "Status")}: ${notifyHint}`,
      `${this.text("追踪", "Trace")}: ${params.traceId}`,
    ];
    return lines.join("\n");
  }

  formatPendingApprovals(records: StoredApprovalRecord[]): string {
    if (records.length === 0) {
      return this.text("当前没有待审批请求。", "No pending approval requests.");
    }
    return [
      this.text(`待审批请求 ${records.length} 条:`, `Pending approval requests (${records.length}):`),
      ...records.map((record) =>
        `- ${record.approval_id} | ${record.actor_id} | ${record.scope} | ${record.tool_name} | ${this.formatTimestampForApproval(record.requested_at)}`,
      ),
    ].join("\n");
  }

  private formatApprovalPrompt(record: StoredApprovalRecord): string {
    const paths = record.resource_paths.length > 0
      ? this.trimText(record.resource_paths.slice(0, 3).join(" | "), 160)
      : undefined;
    const rules = record.rule_ids.length > 0 ? record.rule_ids.join(", ") : undefined;
    const reasons = record.reason_codes.length > 0 ? record.reason_codes.join(", ") : this.text("策略要求复核", "Policy review required");
    const summary = record.args_summary ? this.trimText(record.args_summary, 180) : undefined;

    return [
      this.text("SecurityClaw 审批请求", "SecurityClaw Approval"),
      `${this.text("对象", "Subject")}: ${record.actor_id}`,
      `${this.text("工具", "Tool")}: ${record.tool_name}`,
      `${this.text("范围", "Scope")}: ${record.scope}`,
      `${this.text("资源", "Resource")}: ${this.formatResourceScopeDetail(record.resource_scope)}`,
      `${this.text("原因", "Reason")}: ${reasons}`,
      `${this.text("请求截止", "Request expires")}: ${this.formatTimestampForApproval(record.expires_at)}`,
      `${this.text("审批单", "Request ID")}: ${record.approval_id}`,
      ...(paths ? [`${this.text("路径", "Paths")}: ${paths}`] : []),
      ...(summary ? [`${this.text("参数", "Args")}: ${summary}`] : []),
      ...(rules ? [`${this.text("规则", "Policy")}: ${rules}`] : []),
      "",
      this.text("操作", "Actions"),
      `- ${this.text("批准", "Approve")} ${this.formatApprovalGrantDuration(record, "temporary")}: /securityclaw-approve ${record.approval_id}`,
      `- ${this.text("批准", "Approve")} ${this.formatApprovalGrantDuration(record, "longterm")}: /securityclaw-approve ${record.approval_id} long`,
      `- ${this.text("拒绝", "Reject")}: /securityclaw-reject ${record.approval_id}`,
    ].join("\n");
  }

  private formatResourceScopeLabel(scope: string): string {
    if (scope === "workspace_inside") {
      return this.text("工作区内", "Inside workspace");
    }
    if (scope === "workspace_outside") {
      return this.text("工作区外", "Outside workspace");
    }
    if (scope === "system") {
      return this.text("系统目录", "System directory");
    }
    return this.text("无路径", "No path");
  }

  private formatApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
    return mode === "longterm"
      ? this.formatDurationMs(APPROVAL_LONG_GRANT_TTL_MS)
      : this.formatDurationMs(this.resolveTemporaryGrantDurationMs(record));
  }

  private formatCompactApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
    const durationMs = mode === "longterm"
      ? APPROVAL_LONG_GRANT_TTL_MS
      : this.resolveTemporaryGrantDurationMs(record);
    const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
    const totalHours = totalMinutes / 60;
    const totalDays = totalHours / 24;
    if (Number.isInteger(totalDays) && totalDays >= 1) {
      return this.text(`${totalDays}天`, `${totalDays}d`);
    }
    if (Number.isInteger(totalHours) && totalHours >= 1) {
      return this.text(`${totalHours}小时`, `${totalHours}h`);
    }
    return this.text(`${totalMinutes}分钟`, `${totalMinutes}m`);
  }

  private resolveTemporaryGrantDurationMs(record: StoredApprovalRecord): number {
    const requestedAt = this.parseTimestampMs(record.requested_at) ?? Date.now();
    const expiresAt = this.parseTimestampMs(record.expires_at) ?? (requestedAt + (15 * 60 * 1000));
    return Math.max(60_000, expiresAt - requestedAt);
  }

  private formatDurationMs(durationMs: number): string {
    const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
    const totalHours = totalMinutes / 60;
    const totalDays = totalHours / 24;
    if (Number.isInteger(totalDays) && totalDays >= 1) {
      return this.text(`${totalDays}天`, this.plural(totalDays, "day"));
    }
    if (Number.isInteger(totalHours) && totalHours >= 1) {
      return this.text(`${totalHours}小时`, this.plural(totalHours, "hour"));
    }
    return this.text(`${totalMinutes}分钟`, this.plural(totalMinutes, "minute"));
  }

  private formatTimestampForApproval(value: string | undefined, timeZone = APPROVAL_DISPLAY_TIMEZONE): string {
    const timestamp = this.parseTimestampMs(value);
    if (timestamp === undefined) {
      return value ?? this.text("未知", "Unknown");
    }

    try {
      const parts = new Intl.DateTimeFormat(localeForIntl(this.locale), {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date(timestamp));
      const values = parts.reduce<Record<string, string>>((output, part) => {
        if (part.type !== "literal") {
          output[part.type] = part.value;
        }
        return output;
      }, {});
      return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} (${timeZone})`;
    } catch {
      return `${new Date(timestamp).toISOString()} (${timeZone})`;
    }
  }

  private formatApprovalButtonLabel(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
    return `${this.text("批准", "Approve")} ${this.formatCompactApprovalGrantDuration(record, mode)}`;
  }

  private formatResourceScopeDetail(scope: string): string {
    return `${this.formatResourceScopeLabel(scope)} (${scope})`;
  }

  private parseTimestampMs(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private trimText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private text(zhText: string, enText: string): string {
    return pickLocalized(this.locale, zhText, enText);
  }

  private plural(value: number, unit: "day" | "hour" | "minute"): string {
    return `${value} ${unit}${value === 1 ? "" : "s"}`;
  }
}
