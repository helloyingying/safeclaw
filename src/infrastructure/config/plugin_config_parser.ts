import path from "node:path";

export interface SafeClawPluginConfig {
  configPath?: string;
  overridePath?: string;
  dbPath?: string;
  webhookUrl?: string;
  policyVersion?: string;
  environment?: string;
  approvalTtlSeconds?: number;
  persistMode?: "strict" | "compat";
  decisionLogMaxLength?: number;
  statusPath?: string;
  adminAutoStart?: boolean;
  adminPort?: number;
  approvalBridge?: {
    enabled?: boolean;
    targets?: Array<{
      channel: string;
      to: string;
      account_id?: string;
      thread_id?: string | number;
    }>;
    approvers?: Array<{
      channel: string;
      from: string;
      account_id?: string;
    }>;
  };
}

export interface ResolvedPluginRuntime {
  configPath: string;
  dbPath: string;
  legacyOverridePath: string;
  statusPath: string;
}

export class PluginConfigParser {
  static resolve(pluginRoot: string, pluginConfig: SafeClawPluginConfig): ResolvedPluginRuntime {
    const configPath = pluginConfig.configPath
      ? path.isAbsolute(pluginConfig.configPath)
        ? pluginConfig.configPath
        : path.resolve(pluginRoot, pluginConfig.configPath)
      : path.resolve(pluginRoot, "./config/policy.default.yaml");

    const dbPath = pluginConfig.dbPath
      ? path.isAbsolute(pluginConfig.dbPath)
        ? pluginConfig.dbPath
        : path.resolve(pluginRoot, pluginConfig.dbPath)
      : path.resolve(pluginRoot, "./runtime/safeclaw.db");

    const legacyOverridePath = pluginConfig.overridePath
      ? path.isAbsolute(pluginConfig.overridePath)
        ? pluginConfig.overridePath
        : path.resolve(pluginRoot, pluginConfig.overridePath)
      : path.resolve(pluginRoot, "./config/policy.overrides.json");

    const statusPath = pluginConfig.statusPath
      ? path.isAbsolute(pluginConfig.statusPath)
        ? pluginConfig.statusPath
        : path.resolve(pluginRoot, pluginConfig.statusPath)
      : path.resolve(pluginRoot, "./runtime/safeclaw-status.json");

    return {
      configPath,
      dbPath,
      legacyOverridePath,
      statusPath,
    };
  }

  static sanitizeApprovalConfig(config: SafeClawPluginConfig["approvalBridge"]) {
    const targets = Array.isArray(config?.targets)
      ? config.targets
          .map((target) => {
            const channel = this.normalizeApprovalChannel(target.channel);
            const to = typeof target.to === "string" ? target.to.trim() : "";
            if (!channel || !to) {
              return undefined;
            }
            return {
              channel,
              to,
              ...(typeof target.account_id === "string" && target.account_id.trim()
                ? { account_id: target.account_id.trim() }
                : {}),
              ...(typeof target.thread_id === "string" || typeof target.thread_id === "number"
                ? { thread_id: target.thread_id }
                : {}),
            };
          })
          .filter((target): target is NonNullable<typeof target> => Boolean(target))
      : [];

    const approvers = Array.isArray(config?.approvers)
      ? config.approvers
          .map((approver) => {
            const channel = this.normalizeApprovalChannel(approver.channel);
            const from = typeof approver.from === "string" ? approver.from.trim() : "";
            if (!channel || !from) {
              return undefined;
            }
            return {
              channel,
              from,
              ...(typeof approver.account_id === "string" && approver.account_id.trim()
                ? { account_id: approver.account_id.trim() }
                : {}),
            };
          })
          .filter((approver): approver is NonNullable<typeof approver> => Boolean(approver))
      : [];

    return {
      enabled: config?.enabled === true,
      targets,
      approvers,
    };
  }

  private static normalizeApprovalChannel(value: string | undefined): string | undefined {
    switch ((value ?? "").trim().toLowerCase()) {
      case "discord":
      case "imessage":
      case "line":
      case "signal":
      case "slack":
      case "telegram":
      case "whatsapp":
        return value!.trim().toLowerCase();
      default:
        return undefined;
    }
  }
}
