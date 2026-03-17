import path from "node:path";

export interface SecurityClawPluginConfig {
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
}

export interface ResolvedPluginRuntime {
  configPath: string;
  dbPath: string;
  legacyOverridePath: string;
  statusPath: string;
}

export class PluginConfigParser {
  static resolve(pluginRoot: string, pluginConfig: SecurityClawPluginConfig): ResolvedPluginRuntime {
    const configPath = pluginConfig.configPath
      ? path.isAbsolute(pluginConfig.configPath)
        ? pluginConfig.configPath
        : path.resolve(pluginRoot, pluginConfig.configPath)
      : path.resolve(pluginRoot, "./config/policy.default.yaml");

    const dbPath = pluginConfig.dbPath
      ? path.isAbsolute(pluginConfig.dbPath)
        ? pluginConfig.dbPath
        : path.resolve(pluginRoot, pluginConfig.dbPath)
      : path.resolve(pluginRoot, "./runtime/securityclaw.db");

    const legacyOverridePath = pluginConfig.overridePath
      ? path.isAbsolute(pluginConfig.overridePath)
        ? pluginConfig.overridePath
        : path.resolve(pluginRoot, pluginConfig.overridePath)
      : path.resolve(pluginRoot, "./config/policy.overrides.json");

    const statusPath = pluginConfig.statusPath
      ? path.isAbsolute(pluginConfig.statusPath)
        ? pluginConfig.statusPath
        : path.resolve(pluginRoot, pluginConfig.statusPath)
      : path.resolve(pluginRoot, "./runtime/securityclaw-status.json");

    return {
      configPath,
      dbPath,
      legacyOverridePath,
      statusPath,
    };
  }
}
