import { StrategyStore } from "../config/strategy_store.ts";
import { ConfigManager } from "../config/loader.ts";
import { AccountPolicyEngine, getConfiguredAdminAccount, hasConfiguredAdminAccount } from "../domain/services/account_policy_engine.ts";
import { buildStrategyV2FromConfig, normalizeStrategyV2 } from "../domain/services/strategy_model.ts";
import { applyRuntimeOverride, type RuntimeOverride } from "../config/runtime_override.ts";
import type { AdminRuntime, JsonRecord, ManagementStatus } from "./server_types.ts";

export function summarizeTotals(status: JsonRecord): JsonRecord {
  const hooks = (status.hooks ?? {}) as Record<string, Record<string, number>>;
  let total = 0;
  let block = 0;
  let challenge = 0;
  let warn = 0;
  let allow = 0;
  for (const value of Object.values(hooks)) {
    total += Number(value.total ?? 0);
    block += Number(value.block ?? 0);
    challenge += Number(value.challenge ?? 0);
    warn += Number(value.warn ?? 0);
    allow += Number(value.allow ?? 0);
  }
  return { total, allow, warn, challenge, block };
}

export function readAccountPolicies(strategyStore: StrategyStore) {
  return AccountPolicyEngine.sanitize(strategyStore.readOverride()?.account_policies);
}

export function readManagementStatus(override: RuntimeOverride | undefined): ManagementStatus {
  const admin = getConfiguredAdminAccount(override?.account_policies);
  const strategyConfigured = Boolean(override?.strategy);
  return {
    admin_configured: hasConfiguredAdminAccount(override?.account_policies),
    ...(admin?.subject ? { admin_subject: admin.subject } : {}),
    strategy_configured: strategyConfigured,
    management_effective: Boolean(admin),
  };
}

export function readStrategyModel(
  effectiveConfig: ReturnType<ConfigManager["getConfig"]>,
  override?: RuntimeOverride,
) {
  return normalizeStrategyV2(override?.strategy) ?? buildStrategyV2FromConfig(effectiveConfig);
}

export function countStrategyRules(strategyModel: ReturnType<typeof readStrategyModel>): number {
  return strategyModel.tool_policy.capabilities.reduce((sum, capability) => sum + capability.rules.length, 0);
}

export function readEffectivePolicy(runtime: AdminRuntime, strategyStore: StrategyStore): {
  base: ReturnType<ConfigManager["getConfig"]>;
  effective: ReturnType<ConfigManager["getConfig"]>;
  override?: RuntimeOverride;
  management: ManagementStatus;
} {
  const base = ConfigManager.fromFile(runtime.configPath).getConfig();
  const override = strategyStore.readOverride();
  const effective = override ? applyRuntimeOverride(base, override) : base;
  return override !== undefined
    ? { base, effective, override, management: readManagementStatus(override) }
    : { base, effective, management: readManagementStatus(undefined) };
}
