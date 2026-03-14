import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DlpConfig, PolicyRule, RiskWeights, SafeClawConfig } from "../types.ts";
import { validateConfig } from "./validator.ts";

export type RuntimeOverride = {
  updated_at?: string | undefined;
  environment?: string | undefined;
  policy_version?: string | undefined;
  defaults?: Partial<SafeClawConfig["defaults"]> | undefined;
  risk?: (Partial<Omit<RiskWeights, "tags" | "tools" | "scopes" | "identities">> & {
    tags?: Record<string, number>;
    tools?: Record<string, number>;
    scopes?: Record<string, number>;
    identities?: Record<string, number>;
  }) | undefined;
  policies?: PolicyRule[] | undefined;
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
  const merged: SafeClawConfig = {
    ...base,
    environment: override.environment ?? base.environment,
    policy_version: override.policy_version ?? base.policy_version,
    defaults: {
      ...base.defaults,
      ...(override.defaults ?? {})
    },
    risk: {
      ...base.risk,
      ...(override.risk ?? {}),
      tags: {
        ...base.risk.tags,
        ...(override.risk?.tags ?? {})
      },
      tools: {
        ...base.risk.tools,
        ...(override.risk?.tools ?? {})
      },
      scopes: {
        ...base.risk.scopes,
        ...(override.risk?.scopes ?? {})
      },
      identities: {
        ...base.risk.identities,
        ...(override.risk?.identities ?? {})
      }
    },
    dlp: {
      ...base.dlp,
      ...(override.dlp ?? {}),
      patterns: override.dlp?.patterns ?? base.dlp.patterns
    },
    policies: override.policies ?? base.policies
  };
  return validateConfig(merged as unknown as Record<string, unknown>);
}

export function writeRuntimeOverride(overridePath: string, override: RuntimeOverride): void {
  mkdirSync(path.dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, `${JSON.stringify(override, null, 2)}\n`, "utf8");
}
