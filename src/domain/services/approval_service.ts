import { setTimeout as sleep } from "node:timers/promises";

import type { ApprovalRepository, StoredApprovalRecord, StoredApprovalNotification } from "../ports/approval_repository.ts";
import type { NotificationPort, NotificationTarget } from "../ports/notification_port.ts";
import type { OpenClawLogger } from "../ports/openclaw_adapter.ts";

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
        this.logger.warn?.(`safeclaw: no adapter for channel ${target.channel}`);
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
                  text: `临时批准(${this.formatApprovalGrantDuration(record, "temporary")})`,
                  callback_data: `/safeclaw-approve ${record.approval_id}`,
                  style: "success",
                },
                {
                  text: `长期授权(${this.formatApprovalGrantDuration(record, "longterm")})`,
                  callback_data: `/safeclaw-approve ${record.approval_id} long`,
                  style: "primary",
                },
              ],
              [
                {
                  text: "拒绝",
                  callback_data: `/safeclaw-reject ${record.approval_id}`,
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
            `safeclaw: sent approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} attempt=${attempt}${notification.messageId ? ` message_id=${notification.messageId}` : ""}`,
          );
          break;
        } catch (error) {
          lastError = error;
          if (attempt < APPROVAL_NOTIFICATION_MAX_ATTEMPTS) {
            this.logger.warn?.(
              `safeclaw: retrying approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} attempt=${attempt} (${String(error)})`,
            );
            await sleep(APPROVAL_NOTIFICATION_RETRY_DELAYS_MS[attempt - 1] ?? APPROVAL_NOTIFICATION_RETRY_DELAYS_MS.at(-1) ?? 250);
          }
        }
      }

      if (!delivered) {
        this.logger.warn?.(
          `safeclaw: failed to send approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} (${String(lastError)})`,
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
      ? "已向管理员发送授权请求。管理员批准后，该用户在当前范围内会自动放行直到授权过期。"
      : "未配置或未成功发送授权通知，请由管理员使用 SafeClaw 审批命令处理。";
    return `SafeClaw 已拦截敏感调用: ${params.toolName} (scope=${params.scope}, resource_scope=${params.resourceScope})。原因: ${reasons}。rules=${params.rules}。approval_id=${params.approvalId}。${notifyHint} trace_id=${params.traceId}`;
  }

  formatPendingApprovals(records: StoredApprovalRecord[]): string {
    if (records.length === 0) {
      return "当前没有待审批请求。";
    }
    return [
      `待审批请求 ${records.length} 条:`,
      ...records.map((record) =>
        `- ${record.approval_id} | ${record.actor_id} | ${record.scope} | ${record.tool_name} | ${this.formatTimestampForApproval(record.requested_at)}`,
      ),
    ].join("\n");
  }

  private formatApprovalPrompt(record: StoredApprovalRecord): string {
    const paths = record.resource_paths.length > 0
      ? this.trimText(record.resource_paths.slice(0, 3).join(" | "), 180)
      : "未提供";
    const rules = record.rule_ids.length > 0 ? record.rule_ids.join(", ") : "未命中具体规则";
    const reasons = record.reason_codes.length > 0 ? record.reason_codes.join(", ") : "无附加原因";
    const summary = record.args_summary ? this.trimText(record.args_summary, 220) : "无参数摘要";
    const temporaryExpiresAt = this.resolveApprovalGrantExpiry(record, "temporary");
    const longtermExpiresAt = this.resolveApprovalGrantExpiry(record, "longterm");

    return [
      "SafeClaw 授权请求",
      `ID: ${record.approval_id}`,
      `授权对象: ${record.actor_id}`,
      `授权范围: ${record.scope}`,
      `最近触发工具: ${record.tool_name}`,
      `资源范围: ${this.formatResourceScopeLabel(record.resource_scope)}`,
      `路径: ${paths}`,
      `规则: ${rules}`,
      `原因: ${reasons}`,
      `参数摘要: ${summary}`,
      `待审批截至: ${this.formatTimestampForApproval(record.expires_at)}`,
      `临时授权: /safeclaw-approve ${record.approval_id} (${this.formatApprovalGrantDuration(record, "temporary")}，有效至 ${this.formatTimestampForApproval(temporaryExpiresAt)})`,
      `长期授权: /safeclaw-approve ${record.approval_id} long (${this.formatApprovalGrantDuration(record, "longterm")}，有效至 ${this.formatTimestampForApproval(longtermExpiresAt)})`,
      `拒绝: /safeclaw-reject ${record.approval_id}`,
    ].join("\n");
  }

  private formatResourceScopeLabel(scope: string): string {
    if (scope === "workspace_inside") {
      return "工作区内";
    }
    if (scope === "workspace_outside") {
      return "工作区外";
    }
    if (scope === "system") {
      return "系统目录";
    }
    return "无路径";
  }

  private formatApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
    return mode === "longterm"
      ? this.formatDurationMs(APPROVAL_LONG_GRANT_TTL_MS)
      : this.formatDurationMs(this.resolveTemporaryGrantDurationMs(record));
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
      return `${totalDays}天`;
    }
    if (Number.isInteger(totalHours) && totalHours >= 1) {
      return `${totalHours}小时`;
    }
    return `${totalMinutes}分钟`;
  }

  private formatTimestampForApproval(value: string | undefined, timeZone = APPROVAL_DISPLAY_TIMEZONE): string {
    const timestamp = this.parseTimestampMs(value);
    if (timestamp === undefined) {
      return value ?? "未知";
    }

    try {
      const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(new Date(timestamp));
      const values = parts.reduce<Record<string, string>>((output, part) => {
        if (part.type !== "literal") {
          output[part.type] = part.value;
        }
        return output;
      }, {});
      return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} (${timeZone})`;
    } catch {
      return `${new Date(timestamp).toISOString()} (${timeZone})`;
    }
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
}
