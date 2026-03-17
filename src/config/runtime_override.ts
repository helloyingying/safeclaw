import { existsSync, readFileSync } from "node:fs";

import {
  applySensitivePathStrategyOverride,
  hydrateSensitivePathConfig,
  normalizeSensitivePathStrategyOverride,
} from "../domain/services/sensitive_path_registry.ts";
import { normalizeFileRules } from "../domain/services/file_rule_registry.ts";
import type {
  AccountPolicyRecord,
  DlpConfig,
  FileRule,
  PolicyRule,
  SecurityClawConfig,
  SensitivePathStrategyOverride,
} from "../types.ts";
import { validateConfig } from "./validator.ts";

export type RuntimeOverride = {
  updated_at?: string | undefined;
  environment?: string | undefined;
  policy_version?: string | undefined;
  defaults?: Partial<SecurityClawConfig["defaults"]> | undefined;
  policies?: PolicyRule[] | undefined;
  account_policies?: AccountPolicyRecord[] | undefined;
  sensitivity?: SensitivePathStrategyOverride | undefined;
  file_rules?: FileRule[] | undefined;
  dlp?: (Partial<Omit<DlpConfig, "patterns">> & { patterns?: DlpConfig["patterns"]; }) | undefined;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readRuntimeOverride(overridePath: string): RuntimeOverride | undefined {
  if (!existsSync(overridePath)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(overridePath, "utf8")) as unknown;
  if (!isObject(raw)) {
    throw new Error("runtime override must be an object");
  }
  return raw as RuntimeOverride;
}

export function applyRuntimeOverride(base: SecurityClawConfig, override: RuntimeOverride): SecurityClawConfig {
  const baseSensitivity = hydrateSensitivePathConfig(base.sensitivity);
  const merged: SecurityClawConfig = {
    ...base,
    environment: override.environment ?? base.environment,
    policy_version: override.policy_version ?? base.policy_version,
    defaults: {
      ...base.defaults,
      ...(override.defaults ?? {})
    },
    dlp: {
      ...base.dlp,
      ...(override.dlp ?? {}),
      patterns: override.dlp?.patterns ?? base.dlp.patterns
    },
    policies: override.policies ?? base.policies,
    sensitivity: applySensitivePathStrategyOverride(baseSensitivity, normalizeSensitivePathStrategyOverride(override.sensitivity)),
    file_rules: override.file_rules !== undefined ? normalizeFileRules(override.file_rules) : base.file_rules,
  };
  return validateConfig(merged as unknown as Record<string, unknown>);
}
