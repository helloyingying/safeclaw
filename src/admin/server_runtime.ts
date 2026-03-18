import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PluginConfigParser,
  resolveDefaultOpenClawStateDir,
  type SecurityClawPluginConfig,
} from "../infrastructure/config/plugin_config_parser.ts";
import { readSecurityClawAdminServerEnv, resolveSecurityClawAdminPort } from "../runtime/process_env.ts";
import { runProcessSync } from "../runtime/process_runner.ts";
import type { AdminLogger, AdminRuntime, AdminServerOptions } from "./server_types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ADMIN_ENV = readSecurityClawAdminServerEnv();
const DEFAULT_PORT = resolveSecurityClawAdminPort();
const DEFAULT_OPENCLAW_HOME = resolveDefaultOpenClawStateDir();

export const PUBLIC_DIR = path.resolve(ROOT, "admin/public");

export function resolveAdminPluginConfig(options: AdminServerOptions): SecurityClawPluginConfig {
  return {
    ...(DEFAULT_ADMIN_ENV.configPath ? { configPath: DEFAULT_ADMIN_ENV.configPath } : {}),
    ...(DEFAULT_ADMIN_ENV.legacyOverridePath ? { overridePath: DEFAULT_ADMIN_ENV.legacyOverridePath } : {}),
    ...(DEFAULT_ADMIN_ENV.statusPath ? { statusPath: DEFAULT_ADMIN_ENV.statusPath } : {}),
    ...(DEFAULT_ADMIN_ENV.dbPath ? { dbPath: DEFAULT_ADMIN_ENV.dbPath } : {}),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.legacyOverridePath !== undefined ? { overridePath: options.legacyOverridePath } : {}),
    ...(options.statusPath !== undefined ? { statusPath: options.statusPath } : {}),
    ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
  };
}

export function resolveRuntime(options: AdminServerOptions): AdminRuntime {
  const openClawHome = options.openClawHome ?? DEFAULT_OPENCLAW_HOME;
  const resolved = PluginConfigParser.resolve(ROOT, resolveAdminPluginConfig(options), openClawHome);
  return {
    port: options.port ?? DEFAULT_PORT,
    configPath: resolved.configPath,
    legacyOverridePath: resolved.legacyOverridePath,
    statusPath: resolved.statusPath,
    dbPath: resolved.dbPath,
    openClawHome,
  };
}

export function parsePids(output: string): number[] {
  return output
    .split(/\s+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function listListeningPidsByPort(port: number): number[] {
  const result = runProcessSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }
  return parsePids(result.stdout ?? "");
}

export function readProcessCommand(pid: number): string {
  const result = runProcessSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

export function looksLikeOpenClawProcess(command: string): boolean {
  return /(openclaw|securityclaw|admin\/server|gateway)/i.test(command);
}

export function reclaimAdminPort(port: number, logger: AdminLogger): void {
  const pids = listListeningPidsByPort(port);
  for (const pid of pids) {
    if (pid === process.pid) {
      continue;
    }

    const command = readProcessCommand(pid);
    if (!looksLikeOpenClawProcess(command)) {
      logger.warn?.(
        `SecurityClaw admin: port ${port} is in use by pid=${pid}, but command is not OpenClaw/SecurityClaw; skip terminate.`,
      );
      continue;
    }

    try {
      process.kill(pid, "SIGKILL");
      logger.warn?.(`SecurityClaw admin: killed stale admin process pid=${pid} on port ${port}.`);
    } catch (error) {
      logger.warn?.(`SecurityClaw admin: failed to kill pid=${pid} on port ${port} (${String(error)}).`);
    }
  }
}
