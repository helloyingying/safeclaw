import type { ResourceScope } from "../../types.ts";
import type { SafeClawLocale } from "../../i18n/locale.ts";
import { pickLocalized } from "../../i18n/locale.ts";

export class FormattingService {
  static summarizeForLog(value: unknown, maxLength: number): string {
    try {
      const text = JSON.stringify(value);
      if (text === undefined) {
        return String(value);
      }
      if (text.length <= maxLength) {
        return text;
      }
      return `${text.slice(0, maxLength)}...(truncated)`;
    } catch {
      return "[unserializable]";
    }
  }

  static formatToolBlockReason(
    toolName: string,
    scope: string,
    traceId: string,
    decision: "challenge" | "block",
    decisionSource: string,
    resourceScope: ResourceScope,
    reasonCodes: string[],
    rules: string,
    locale: SafeClawLocale = "en",
  ): string {
    const reasons = reasonCodes.join(", ");
    const resourceLabel = FormattingService.formatResourceScopeLabel(resourceScope, locale);
    const lines = [
      pickLocalized(
        locale,
        decision === "challenge" ? "SafeClaw 需要审批" : "SafeClaw 已阻止此操作",
        decision === "challenge" ? "SafeClaw Approval Required" : "SafeClaw Blocked",
      ),
      `${pickLocalized(locale, "工具", "Tool")}: ${toolName}`,
      `${pickLocalized(locale, "范围", "Scope")}: ${scope}`,
      `${pickLocalized(locale, "资源", "Resource")}: ${resourceLabel} (${resourceScope})`,
      `${pickLocalized(locale, "来源", "Source")}: ${decisionSource}`,
      `${pickLocalized(locale, "原因", "Reason")}: ${reasons || pickLocalized(locale, "策略要求复核", "Policy review required")}`,
      ...(rules && rules !== "-" ? [`${pickLocalized(locale, "规则", "Policy")}: ${rules}`] : []),
      `${pickLocalized(
        locale,
        "处理",
        "Action",
      )}: ${pickLocalized(
        locale,
        decision === "challenge" ? "联系管理员审批后重试" : "联系安全管理员调整策略",
        decision === "challenge" ? "Contact an admin to approve and retry" : "Contact a security admin to adjust policy",
      )}`,
      `${pickLocalized(locale, "追踪", "Trace")}: ${traceId}`,
    ];
    return lines.join("\n");
  }

  private static formatResourceScopeLabel(scope: ResourceScope, locale: SafeClawLocale): string {
    if (scope === "workspace_inside") {
      return pickLocalized(locale, "工作区内", "Inside workspace");
    }
    if (scope === "workspace_outside") {
      return pickLocalized(locale, "工作区外", "Outside workspace");
    }
    if (scope === "system") {
      return pickLocalized(locale, "系统目录", "System directory");
    }
    return pickLocalized(locale, "无路径", "No path");
  }

  static normalizeToolName(rawToolName: string): string {
    const tool = rawToolName.trim().toLowerCase();
    if (tool === "exec" || tool === "shell" || tool === "shell_exec") {
      return "shell.exec";
    }
    if (tool === "fs.list" || tool === "file.list") {
      return "filesystem.list";
    }
    return rawToolName;
  }

  static matchedRuleIds(matches: Array<{ rule: { rule_id: string } }>): string {
    if (matches.length === 0) {
      return "-";
    }
    return matches.map((match) => match.rule.rule_id).join(",");
  }

  static findingsToText(findings: Array<{ pattern_name: string; path: string }>): string {
    return findings.map((finding) => `${finding.pattern_name}@${finding.path}`).join(", ");
  }

  static resolveScope(ctx: { workspaceDir?: string; channelId?: string }): string {
    if (ctx.workspaceDir) {
      return ctx.workspaceDir.split("/").pop() || "default";
    }
    return ctx.channelId ?? "default";
  }
}
