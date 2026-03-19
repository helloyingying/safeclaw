import os from "node:os";
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
  hardeningExemptions?: Array<{
    findingId: string;
    reason?: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface ResolvedPluginRuntime {
  configPath: string;
  dbPath: string;
  legacyOverridePath: string;
  statusPath: string;
  protectedDataDir?: string;
  protectedDbPaths: string[];
}

const SECURITYCLAW_EXTENSION_STATE_SEGMENTS = ["extensions", "securityclaw"] as const;
const DEFAULT_DB_FILE_NAME = "securityclaw.db";
const DEFAULT_STATUS_FILE_NAME = "securityclaw-status.json";
const SQLITE_ARTIFACT_SUFFIXES = ["", "-shm", "-wal"] as const;

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveAbsoluteStoragePath(configuredPath: string | undefined): string | undefined {
  return hasText(configuredPath) && path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : undefined;
}

function sqliteArtifactPaths(dbPath: string): string[] {
  return SQLITE_ARTIFACT_SUFFIXES.map((suffix) => `${dbPath}${suffix}`);
}

export function resolveDefaultOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return hasText(env.OPENCLAW_HOME) ? path.resolve(env.OPENCLAW_HOME) : path.join(os.homedir(), ".openclaw");
}

export function resolveSecurityClawStateDir(stateDir: string): string {
  const normalizedStateDir = path.resolve(stateDir);
  const pluginSuffix = path.join(...SECURITYCLAW_EXTENSION_STATE_SEGMENTS);
  if (
    normalizedStateDir === pluginSuffix ||
    normalizedStateDir.endsWith(`${path.sep}${pluginSuffix}`)
  ) {
    return normalizedStateDir;
  }
  return path.join(normalizedStateDir, ...SECURITYCLAW_EXTENSION_STATE_SEGMENTS);
}

export function resolveDefaultSecurityClawDbPath(stateDir: string): string {
  return path.join(resolveSecurityClawStateDir(stateDir), "data", DEFAULT_DB_FILE_NAME);
}

export function resolveDefaultSecurityClawStatusPath(stateDir: string): string {
  return path.join(resolveSecurityClawStateDir(stateDir), "runtime", DEFAULT_STATUS_FILE_NAME);
}

export class PluginConfigParser {
  static resolve(
    pluginRoot: string,
    pluginConfig: SecurityClawPluginConfig,
    stateDir = resolveDefaultOpenClawStateDir(),
  ): ResolvedPluginRuntime {
    const defaultDbPath = resolveDefaultSecurityClawDbPath(stateDir);
    const defaultStatusPath = resolveDefaultSecurityClawStatusPath(stateDir);
    const configuredDbPath = resolveAbsoluteStoragePath(pluginConfig.dbPath);
    const configuredStatusPath = resolveAbsoluteStoragePath(pluginConfig.statusPath);
    const usingDefaultDbPath = configuredDbPath === undefined;
    const configPath = pluginConfig.configPath
      ? path.isAbsolute(pluginConfig.configPath)
        ? pluginConfig.configPath
        : path.resolve(pluginRoot, pluginConfig.configPath)
      : path.resolve(pluginRoot, "./config/policy.default.yaml");

    const dbPath = configuredDbPath ?? defaultDbPath;

    const legacyOverridePath = pluginConfig.overridePath
      ? path.isAbsolute(pluginConfig.overridePath)
        ? pluginConfig.overridePath
        : path.resolve(pluginRoot, pluginConfig.overridePath)
      : path.resolve(pluginRoot, "./config/policy.overrides.json");

    const statusPath = configuredStatusPath ?? defaultStatusPath;

    return {
      configPath,
      dbPath,
      legacyOverridePath,
      statusPath,
      ...(usingDefaultDbPath ? { protectedDataDir: path.dirname(dbPath) } : {}),
      protectedDbPaths: sqliteArtifactPaths(dbPath),
    };
  }
}
