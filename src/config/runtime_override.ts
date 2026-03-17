import { existsSync, readFileSync } from "node:fs";

import {
  applySensitivePathStrategyOverride,
  hydrateSensitivePathConfig,
  normalizeSensitivePathStrategyOverride,
} from "../domain/services/sensitive_path_registry.ts";
import type {
  AccountPolicyRecord,
  DlpConfig,
  PolicyRule,
  SafeClawConfig,
  SensitivePathStrategyOverride,
} from "../types.ts";
import { validateConfig } from "./validator.ts";

export type RuntimeOverride = {
  updated_at?: string | undefined;
  environment?: string | undefined;
  policy_version?: string | undefined;
  defaults?: Partial<SafeClawConfig["defaults"]> | undefined;
  policies?: PolicyRule[] | undefined;
  account_policies?: AccountPolicyRecord[] | undefined;
  sensitivity?: SensitivePathStrategyOverride | undefined;
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

export function applyRuntimeOverride(base: SafeClawConfig, override: RuntimeOverride): SafeClawConfig {
  const baseSensitivity = hydrateSensitivePathConfig(base.sensitivity);
  const merged: SafeClawConfig = {
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
    sensitivity: applySensitivePathStrategyOverride(baseSensitivity, normalizeSensitivePathStrategyOverride(override.sensitivity))
  };
  return validateConfig(merged as unknown as Record<string, unknown>);
}
