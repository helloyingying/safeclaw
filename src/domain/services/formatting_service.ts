import type { ResourceScope } from "../../types.ts";

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
  ): string {
    const reasons = reasonCodes.join(", ");
    if (decision === "challenge") {
      return `SafeClaw 已拦截敏感调用: ${toolName} (scope=${scope}, resource_scope=${resourceScope})。来源: ${decisionSource}。原因: ${reasons}。rules=${rules}。请联系管理员审批后重试。trace_id=${traceId}`;
    }
    return `SafeClaw 已阻断敏感调用: ${toolName} (scope=${scope}, resource_scope=${resourceScope})。来源: ${decisionSource}。原因: ${reasons}。rules=${rules}。如需放行，请联系安全管理员调整策略。trace_id=${traceId}`;
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
