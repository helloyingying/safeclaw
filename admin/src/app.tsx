import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  AdminDashboardUrlState,
  AdminDecisionFilterId,
  AdminTabId
} from "../../src/admin/dashboard_url_state.ts";
import type { OpenClawChatSession } from "../../src/admin/openclaw_session_catalog.ts";
import type {
  SkillDetailPayload,
  SkillLifecycleState,
  SkillListFilters,
  SkillListPayload,
  SkillOperationSeverity,
  SkillPolicyConfig,
  SkillRiskTier,
  SkillSource,
  SkillStatusPayload,
  SkillSummary
} from "../../src/admin/skill_interception_store.ts";
import type { DecisionHistoryCounts, DecisionHistoryPage } from "../../src/admin/server_types.ts";
import type { CapabilityPolicy, StrategyPolicyRule, StrategyV2 } from "../../src/domain/services/strategy_model.ts";
import type { SecurityClawLocale } from "../../src/i18n/locale.ts";
import type {
  AccountPolicyMode,
  AccountPolicyRecord,
  Decision,
  FileRule,
  FileRuleOperation,
  PolicyMatch,
  ResourceScope
} from "../../src/types.ts";
import {
  buildAdminDashboardSearch,
  readAdminDashboardUrlState
} from "../../src/admin/dashboard_url_state.ts";
import {
  createAccountPolicyDraftFromSession,
  DEFAULT_MAIN_ADMIN_SESSION_KEY,
  ensureDefaultAdminAccount,
  mergeAccountPoliciesWithSessions,
  pruneAccountPolicyOverrides,
} from "../../src/admin/account_catalog.ts";
import { canonicalizeAccountPolicies } from "../../src/domain/services/account_policy_engine.ts";
import { resolveSecurityClawLocale } from "../../src/i18n/locale.ts";
import {
  ACCOUNT_MODE_TEXT,
  ADMIN_BRAND_TEXT,
  ADMIN_DEFAULT_LOCALE,
  ADMIN_DEFAULT_THEME_PREFERENCE,
  ADMIN_LOCALE_STORAGE_KEY,
  ADMIN_THEME_STORAGE_KEY,
  CHART_PALETTES,
  CHART_THEME,
  CONTROL_DOMAIN_TEXT,
  DARK_COLOR_SCHEME_QUERY,
  DECISION_IMPACT_TEXT,
  DECISION_OPTIONS,
  DECISION_SOURCE_TEXT,
  DECISION_TEXT,
  DECISIONS_PER_PAGE,
  FILE_RULE_OPERATION_OPTIONS,
  OPERATION_TEXT,
  REFRESH_INTERVAL_MS,
  RULE_TEXT_OVERRIDES,
  SCOPE_TEXT,
  SEVERITY_TEXT,
  SKILL_ACTIVITY_TEXT,
  SKILL_RISK_TIER_TEXT,
  SKILL_REASON_TEXT,
  SKILL_SCAN_STATUS_TEXT,
  SKILL_SEVERITY_TEXT,
  SKILL_SOURCE_TEXT,
  SKILL_STATE_TEXT,
  TAB_ITEMS,
  CAPABILITY_DESCRIPTION_TEXT,
  CAPABILITY_TEXT,
  decisionFilterLabel,
  getActiveAdminLocale,
  normalizeAdminThemePreference,
  readLocalized,
  readSystemTheme,
  resolveAdminTheme,
  setActiveAdminLocale,
  tabLabel,
  ui
} from "./dashboard_core.ts";
import type {
  DashboardTheme,
  DashboardThemePreference,
  LocalizedMap,
  RuleTextField
} from "./dashboard_core.ts";
import {
  ToolbarIconMoon,
  ToolbarIconSun,
  ToolbarIconSystem,
  ToolbarMonogram
} from "./dashboard_primitives.tsx";
import {
  AccountsPanel,
  DashboardShell,
  EventsPanel,
  OverviewPanel,
} from "./dashboard_panels.tsx";
import { RulesPanel } from "./dashboard_rules_panel.tsx";
import { SkillsPanel } from "./dashboard_skills_panel.tsx";
import type { FilesystemOverridesSectionProps } from "./filesystem_overrides_section.tsx";

type DashboardDecisionRecord = {
  ts: string;
  hook: string;
  trace_id: string;
  actor?: string;
  scope?: string;
  tool?: string;
  decision: Decision;
  decision_source?: string;
  resource_scope?: string;
  reasons: string[];
  rules?: string;
};

type StatusApiPayload = {
  status?: {
    recent_decisions?: DashboardDecisionRecord[];
  };
};

type StrategyApiPayload = {
  strategy?: {
    model?: unknown;
  };
};

type AccountsApiPayload = {
  account_policies?: unknown;
  sessions?: OpenClawChatSession[];
};

type DirectoryPickerEntry = {
  path: string;
  name: string;
};

type DirectoryPickerPayload = {
  current_path?: string;
  parent_path?: string;
  roots?: unknown;
  directories?: unknown;
};

type StrategyRuleDisplay = StrategyPolicyRule & {
  capability_id: CapabilityPolicy["capability_id"];
  enabled: boolean;
  match: PolicyMatch;
};

type LoadDataOptions = {
  syncRules?: boolean;
  syncAccounts?: boolean;
  silent?: boolean;
};

type LoadDecisionOptions = {
  silent?: boolean;
};

type LoadSkillDataOptions = {
  silent?: boolean;
  syncPolicy?: boolean;
};

type NavigateDashboardInput = Partial<AdminDashboardUrlState>;

type SkillRiskFilterValue = "all" | SkillRiskTier;
type SkillStateFilterValue = "all" | SkillLifecycleState;
type SkillSourceFilterValue = "all" | SkillSource;
type SkillDriftFilterValue = "all" | "drifted" | "steady";
type SkillInterceptFilterValue = "all" | "recent";

type SkillConfirmAction = {
  kind: "quarantine" | "trust";
  skillId: string;
  enable: boolean;
  skillName?: string;
};

type DistributionItem = {
  label: string;
  count: number;
  color?: string;
};

type BuildDistributionOptions = {
  fallbackLabel?: string;
  limit?: number;
};

type TrendBucket = {
  startTs: number;
  total: number;
  risk: number;
};

type TrendSeries = {
  start: number;
  end: number;
  bucketHours: number;
  buckets: TrendBucket[];
};

type SkillThresholdField = keyof SkillPolicyConfig["thresholds"];
type SkillPolicyTierKey = keyof SkillPolicyConfig["matrix"];
type SkillDefaultActionKey = "drifted_action" | "trust_override_hours" | "unscanned_S2" | "unscanned_S3";
type ThemeControl = {
  value: DashboardThemePreference;
  label: string;
  icon: React.ReactNode;
};
type LocaleControl = {
  value: SecurityClawLocale;
  label: string;
  icon: React.ReactNode;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function toArray<T>(value: readonly T[] | T[] | null | undefined): T[];
function toArray<T>(value: unknown): T[];
function toArray<T>(value: readonly T[] | T[] | unknown): T[] {
  return Array.isArray(value) ? Array.from(value) : [];
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(getActiveAdminLocale() === "zh-CN" ? "zh-CN" : "en-US", { hour12: false });
}

function decisionLabel(decision: string | null | undefined): string {
  return readLocalized(DECISION_TEXT, decision, String(decision || "-"));
}

function decisionSourceLabel(source: string | null | undefined): string {
  return readLocalized(DECISION_SOURCE_TEXT, source, "-");
}

function accountModeLabel(mode: AccountPolicyMode | string | null | undefined): string {
  return readLocalized(ACCOUNT_MODE_TEXT, mode, mode || "-");
}

function scopeLabel(scope: string | null | undefined): string {
  if (!scope) return ui("未知作用域", "Unknown scope");
  return readLocalized(SCOPE_TEXT, scope, scope);
}

function resourceScopeLabel(scope: ResourceScope | string | null | undefined): string {
  if (!scope) return "-";
  if (scope === "workspace_inside") return ui("工作区内", "Inside workspace");
  if (scope === "workspace_outside") return ui("工作区外", "Outside workspace");
  if (scope === "system") return ui("系统目录", "System directory");
  if (scope === "none") return ui("无路径", "No path");
  return scope;
}

function accountPrimaryLabel(account: Partial<AccountPolicyRecord> | null | undefined): string {
  if (!account) return ui("未命名账号", "Unnamed account");
  return account.label || account.subject || ui("未命名账号", "Unnamed account");
}

function accountMetaLabel(account: Partial<AccountPolicyRecord> | null | undefined): string {
  const parts: string[] = [];
  if (account?.channel) parts.push(account.channel);
  if (account?.chat_type) parts.push(account.chat_type);
  if (account?.agent_id) parts.push(`agent:${account.agent_id}`);
  return parts.join(" · ") || "OpenClaw chat session";
}

function getJsonError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && payload.error) {
    return String(payload.error);
  }
  return fallback;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-securityclaw-locale": getActiveAdminLocale()
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(getJsonError(payload, ui(`请求失败: ${response.status}`, `Request failed: ${response.status}`)));
  }
  return payload as T;
}

function extractPolicies(strategyPayload: StrategyApiPayload | unknown): StrategyRuleDisplay[] {
  return flattenStrategyRules(extractStrategyModel(strategyPayload));
}

function normalizeDirectoryPathKey(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.toLowerCase();
}

function normalizeFileRuleOperations(operations: unknown): FileRuleOperation[] {
  if (!Array.isArray(operations)) {
    return [];
  }
  return Array.from(
    new Set(
      operations
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry): entry is FileRuleOperation => FILE_RULE_OPERATION_OPTIONS.includes(entry))
    )
  ).sort(
    (left, right) => FILE_RULE_OPERATION_OPTIONS.indexOf(left) - FILE_RULE_OPERATION_OPTIONS.indexOf(right)
  );
}

function serializeFileRuleOperations(operations: unknown): string {
  const normalized = normalizeFileRuleOperations(operations);
  return normalized.length ? normalized.join("|") : "*";
}

function fileRuleIdentityKey(rule: Partial<FileRule> | null | undefined): string {
  return `${normalizeDirectoryPathKey(rule?.directory)}::${serializeFileRuleOperations(rule?.operations)}`;
}

function compareFileRules(left: Partial<FileRule> | null | undefined, right: Partial<FileRule> | null | undefined): number {
  const byDirectory = String(left?.directory || "").localeCompare(String(right?.directory || ""));
  if (byDirectory !== 0) return byDirectory;
  const byOperations = serializeFileRuleOperations(left?.operations).localeCompare(serializeFileRuleOperations(right?.operations));
  if (byOperations !== 0) return byOperations;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeFileRule(rule: any): FileRule | null {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  const directory = typeof rule.directory === "string" ? rule.directory.trim() : "";
  const decision = typeof rule.decision === "string" ? rule.decision.trim() : "";
  if (!id || !directory || !DECISION_OPTIONS.includes(decision)) {
    return null;
  }
  return {
    id,
    directory,
    decision,
    ...(normalizeFileRuleOperations(rule.operations).length
      ? { operations: normalizeFileRuleOperations(rule.operations) }
      : {}),
    reason_codes: Array.isArray(rule.reason_codes)
      ? rule.reason_codes.map((entry: unknown) => String(entry)).filter(Boolean)
      : undefined
  };
}

function normalizeFileRules(rules: unknown): FileRule[] {
  if (!Array.isArray(rules)) {
    return [];
  }
  const deduped = new Map<string, FileRule>();
  rules.forEach((rule) => {
    const normalized = normalizeFileRule(rule);
    if (normalized) {
      deduped.set(fileRuleIdentityKey(normalized), normalized);
    }
  });
  return Array.from(deduped.values()).sort(compareFileRules);
}

function extractFileRules(strategyPayload: StrategyApiPayload | unknown): FileRule[] {
  return normalizeFileRules(extractStrategyModel(strategyPayload)?.exceptions?.directory_overrides);
}

function serializeFileRules(rules: unknown): string {
  return JSON.stringify(normalizeFileRules(rules));
}

function normalizeStrategyModel(strategyModel: any): StrategyV2 {
  if (!strategyModel || typeof strategyModel !== "object") {
    return {
      version: "v2",
      tool_policy: {
        capabilities: []
      },
      classifiers: {
        disabled_builtin_ids: [],
        custom_sensitive_paths: [],
        volume_thresholds: {
          bulk_file_count: 20,
          bulk_bytes: 1000000,
          bulk_record_count: 100
        }
      },
      exceptions: {
        directory_overrides: []
      }
    };
  }
  const capabilities = Array.isArray(strategyModel?.tool_policy?.capabilities)
    ? clone(strategyModel.tool_policy.capabilities)
    : [];
  const directoryOverrides = normalizeFileRules(strategyModel?.exceptions?.directory_overrides);
  return {
    version: "v2",
    tool_policy: {
      capabilities
    },
    classifiers: {
      disabled_builtin_ids: Array.isArray(strategyModel?.classifiers?.disabled_builtin_ids)
        ? clone(strategyModel.classifiers.disabled_builtin_ids)
        : [],
      custom_sensitive_paths: Array.isArray(strategyModel?.classifiers?.custom_sensitive_paths)
        ? clone(strategyModel.classifiers.custom_sensitive_paths)
        : [],
      volume_thresholds: strategyModel?.classifiers?.volume_thresholds
        ? clone(strategyModel.classifiers.volume_thresholds)
        : {
            bulk_file_count: 20,
            bulk_bytes: 1000000,
            bulk_record_count: 100
          }
    },
    exceptions: {
      directory_overrides: directoryOverrides
    }
  };
}

function extractStrategyModel(strategyPayload: StrategyApiPayload | any): StrategyV2 {
  return normalizeStrategyModel(strategyPayload?.strategy?.model);
}

function flattenStrategyRules(strategyModel: StrategyV2 | any): StrategyRuleDisplay[] {
  const capabilities = toArray<CapabilityPolicy>(strategyModel?.tool_policy?.capabilities);
  return capabilities.flatMap((capability) =>
    toArray<StrategyPolicyRule>(capability?.rules).map((rule) => ({
      ...clone(rule),
      capability_id: capability?.capability_id,
      enabled: rule?.enabled !== false,
      match: clone(rule?.context || {})
    }))
  );
}

function updateStrategyRuleDecision(strategyModel: StrategyV2 | any, ruleId: string, decision: Decision): StrategyV2 {
  const nextStrategy = normalizeStrategyModel(strategyModel);
  nextStrategy.tool_policy.capabilities = nextStrategy.tool_policy.capabilities.map((capability) => ({
    ...capability,
    rules: toArray(capability?.rules).map((rule) =>
      rule?.rule_id === ruleId
        ? {
            ...rule,
            decision,
            enabled: true
          }
        : rule
    )
  }));
  return nextStrategy;
}

function updateStrategyCapabilityDefaultDecision(
  strategyModel: StrategyV2 | any,
  capabilityId: string,
  decision: Decision
): StrategyV2 {
  const nextStrategy = normalizeStrategyModel(strategyModel);
  nextStrategy.tool_policy.capabilities = nextStrategy.tool_policy.capabilities.map((capability) =>
    capability?.capability_id === capabilityId
      ? {
          ...capability,
          default_decision: decision
        }
      : capability
  );
  return nextStrategy;
}

function strategyDirectoryOverrides(strategyModel: StrategyV2 | any): FileRule[] {
  return normalizeFileRules(strategyModel?.exceptions?.directory_overrides);
}

function withStrategyDirectoryOverrides(strategyModel: StrategyV2 | any, directoryOverrides: unknown): StrategyV2 {
  const nextStrategy = normalizeStrategyModel(strategyModel);
  nextStrategy.exceptions = {
    ...(nextStrategy.exceptions || {}),
    directory_overrides: normalizeFileRules(directoryOverrides)
  };
  return nextStrategy;
}

function normalizeDirectoryPickerEntries(entries: unknown): DirectoryPickerEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const pathValue = typeof entry.path === "string" ? entry.path.trim() : "";
      const nameValue = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!pathValue) {
        return null;
      }
      return {
        path: pathValue,
        name: nameValue || pathValue,
      };
    })
    .filter((entry): entry is DirectoryPickerEntry => Boolean(entry));
}

function normalizeDirectoryPickerRoots(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function defaultFileRuleReasonCode(decision: Decision): string {
  if (decision === "allow") {
    return "USER_FILE_RULE_ALLOW";
  }
  if (decision === "warn") {
    return "USER_FILE_RULE_WARN";
  }
  if (decision === "challenge") {
    return "USER_FILE_RULE_CHALLENGE";
  }
  return "USER_FILE_RULE_BLOCK";
}

function extractAccountPolicies(accountPayload: AccountsApiPayload | any): AccountPolicyRecord[] {
  const list = accountPayload?.account_policies;
  return canonicalizeAccountPolicies(Array.isArray(list) ? clone(list) : []);
}

function extractChatSessions(accountPayload: AccountsApiPayload | any): OpenClawChatSession[] {
  const list = accountPayload?.sessions;
  return Array.isArray(list) ? clone(list) : [];
}

function formatList(values: string[]): string {
  return values.join(" | ");
}

function summarizeMatch(match: PolicyMatch | any): string {
  const scopes = toArray<string>(match?.scope);
  const tools = toArray<string>(match?.tool);
  const toolGroups = toArray<string>(match?.tool_group);
  const operations = toArray<string>(match?.operation);
  const identities = toArray<string>(match?.identity);
  const resourceScopes = toArray<string>(match?.resource_scope);
  const fileTypes = toArray<string>(match?.file_type);
  const assetLabels = toArray<string>(match?.asset_labels);
  const dataLabels = toArray<string>(match?.data_labels);
  const trustLevels = toArray<string>(match?.trust_level);
  const destinationTypes = toArray<string>(match?.destination_type);
  const destinationDomains = toArray<string>(match?.dest_domain);
  const destinationIpClasses = toArray<string>(match?.dest_ip_class);
  const pathMatchers = [
    ...toArray<string>(match?.path_prefix),
    ...toArray<string>(match?.path_glob),
    ...toArray<string>(match?.path_regex)
  ];
  const argMatchers = [...toArray<string>(match?.tool_args_summary), ...toArray<string>(match?.tool_args_regex)];

  const parts = [];
  if (scopes.length) parts.push(ui(`范围: ${formatList(scopes)}`, `Scope: ${formatList(scopes)}`));
  if (tools.length) parts.push(ui(`工具: ${formatList(tools)}`, `Tools: ${formatList(tools)}`));
  if (toolGroups.length) parts.push(ui(`工具组: ${formatList(toolGroups)}`, `Tool groups: ${formatList(toolGroups)}`));
  if (operations.length) parts.push(ui(`动作: ${formatList(operations)}`, `Operations: ${formatList(operations)}`));
  if (identities.length) parts.push(ui(`身份: ${formatList(identities)}`, `Identity: ${formatList(identities)}`));
  if (resourceScopes.length) parts.push(ui(`资源范围: ${formatList(resourceScopes.map(resourceScopeLabel))}`, `Resource scopes: ${formatList(resourceScopes.map(resourceScopeLabel))}`));
  if (fileTypes.length) parts.push(ui(`文件类型: ${formatList(fileTypes)}`, `File types: ${formatList(fileTypes)}`));
  if (assetLabels.length) parts.push(ui(`资产标签: ${formatList(assetLabels)}`, `Asset labels: ${formatList(assetLabels)}`));
  if (dataLabels.length) parts.push(ui(`数据标签: ${formatList(dataLabels)}`, `Data labels: ${formatList(dataLabels)}`));
  if (trustLevels.length) parts.push(ui(`信任级别: ${formatList(trustLevels)}`, `Trust levels: ${formatList(trustLevels)}`));
  if (destinationTypes.length) parts.push(ui(`目的地类型: ${formatList(destinationTypes)}`, `Destination types: ${formatList(destinationTypes)}`));
  if (destinationDomains.length) parts.push(ui(`目的地域名: ${formatList(destinationDomains)}`, `Destination domains: ${formatList(destinationDomains)}`));
  if (destinationIpClasses.length) parts.push(ui(`目标 IP: ${formatList(destinationIpClasses)}`, `Destination IP classes: ${formatList(destinationIpClasses)}`));
  if (pathMatchers.length) parts.push(ui(`路径条件: ${pathMatchers.length} 条`, `Path conditions: ${pathMatchers.length}`));
  if (argMatchers.length) parts.push(ui(`参数特征: ${argMatchers.length} 条`, `Argument patterns: ${argMatchers.length}`));
  if (typeof match?.min_file_count === "number") parts.push(ui(`文件数 >= ${match.min_file_count}`, `File count >= ${match.min_file_count}`));
  if (typeof match?.min_bytes === "number") parts.push(ui(`字节数 >= ${match.min_bytes}`, `Bytes >= ${match.min_bytes}`));
  if (typeof match?.min_record_count === "number") parts.push(ui(`记录数 >= ${match.min_record_count}`, `Records >= ${match.min_record_count}`));
  return parts.join(" · ") || ui("无附加匹配条件", "No extra match conditions");
}

function ruleDescription(policy: StrategyRuleDisplay | any): string {
  const overrideDescription = localizedRuleField(policy?.rule_id, "description");
  if (overrideDescription) {
    return overrideDescription;
  }
  if (policy?.description && getActiveAdminLocale() === "zh-CN") {
    return policy.description;
  }
  const action = decisionLabel(policy?.decision);
  const match = summarizeMatch(policy?.match);
  return ui(`命中条件时执行“${action}”。${match}。`, `When matched, action is "${action}". ${match}.`);
}

function controlDomainLabel(domain: string | null | undefined): string {
  if (!domain) return ui("未分类", "Uncategorized");
  return readLocalized(CONTROL_DOMAIN_TEXT, domain, domain);
}

function capabilityLabel(capabilityId: string | null | undefined): string {
  if (!capabilityId) return ui("未分类能力", "Uncategorized Capability");
  return readLocalized(CAPABILITY_TEXT, capabilityId, capabilityId);
}

function capabilityDescription(capabilityId: string | null | undefined): string {
  if (!capabilityId) {
    return ui("用于承载一组相近能力的默认策略和附加限制。", "Holds the default posture and additional restrictions for a related set of capabilities.");
  }
  return readLocalized(
    CAPABILITY_DESCRIPTION_TEXT,
    capabilityId,
    ui("用于承载这组能力的默认策略和附加限制。", "Holds the default posture and additional restrictions for this capability group.")
  );
}

function severityLabel(severity: string | null | undefined): string {
  return readLocalized(SEVERITY_TEXT, severity, severity || ui("未分级", "Unrated"));
}

function policyTitle(policy: StrategyRuleDisplay | any, index: number): string {
  const overrideTitle = localizedRuleField(policy?.rule_id, "title");
  if (overrideTitle) {
    return overrideTitle;
  }
  if (policy?.title && getActiveAdminLocale() === "zh-CN") {
    return policy.title;
  }
  return policy?.rule_id || ui(`规则 ${index + 1}`, `Rule ${index + 1}`);
}

function formatSimpleList(values: unknown): string {
  return toArray(values).filter(Boolean).join(ui("、", ", "));
}

function withLabel(value: string | null | undefined, labels: LocalizedMap): string {
  return readLocalized(labels, value, value || "-");
}

function fileRuleOperationsSummary(rule: Partial<FileRule> | null | undefined): string {
  const operations = normalizeFileRuleOperations(rule?.operations);
  if (!operations.length) {
    return ui("全部文件类操作", "All filesystem operations");
  }
  return ui(
    `仅限 ${formatSimpleList(operations.map((value) => withLabel(value, OPERATION_TEXT)))}`,
    `Only ${formatSimpleList(operations.map((value) => withLabel(value, OPERATION_TEXT)))}`
  );
}

function localizedRuleField(ruleId: string | null | undefined, field: RuleTextField): string | undefined {
  if (!ruleId) return undefined;
  const item = RULE_TEXT_OVERRIDES[ruleId];
  const fieldValue = item?.[field];
  if (!fieldValue) return undefined;
  const locale = getActiveAdminLocale();
  return fieldValue[locale] || fieldValue.en || fieldValue["zh-CN"];
}

function userImpactSummary(policy: { decision?: Decision | string | null } | any): string {
  const decisionKey = (policy?.decision || "allow") as keyof typeof DECISION_IMPACT_TEXT;
  const base = DECISION_IMPACT_TEXT[decisionKey] || DECISION_IMPACT_TEXT.allow;
  const localizedBase = ui(
    base,
    {
      [DECISION_IMPACT_TEXT.allow]: "Execution continues with minimal friction and audit logging remains enabled.",
      [DECISION_IMPACT_TEXT.warn]: "Execution continues with a risk warning so users can correct behavior in time.",
      [DECISION_IMPACT_TEXT.challenge]: "Execution pauses until approval is granted, so the workflow becomes slower but safer.",
      [DECISION_IMPACT_TEXT.block]: "Execution is stopped immediately and must be replaced with a safer approach.",
    }[base] || "This decision path affects execution behavior and audit posture.",
  );
  return localizedBase;
}

function capabilityBaselineSummary(capability: CapabilityPolicy | any): string {
  const restrictionCount = toArray(capability?.rules).length;
  const followup = restrictionCount > 0
    ? ui(
      `这只是这组能力的起始动作，后续 ${restrictionCount} 条附加限制仍可能把它升级成提醒、确认或拦截。`,
      `This is only the baseline for the capability. The ${restrictionCount} additional restrictions can still escalate it to warn, approval, or block.`
    )
    : ui(
      "当前没有额外附加限制，所以这组能力会直接按这个默认策略处理。",
      "There are no additional restrictions right now, so this capability follows the baseline action directly."
    );
  return `${userImpactSummary({ decision: capability?.default_decision })} ${followup}`;
}

function skillDefaultActionSummary(kind: "unscanned_S2" | "unscanned_S3" | "drifted_action", decision: Decision): string {
  const action = decisionLabel(decision);
  const impact = userImpactSummary({ decision });
  if (kind === "unscanned_S2") {
    return ui(
      `当 Skill 还没完成扫描、但调用已经达到 S2 时，会先按“${action}”兜底，避免敏感读写在未看清前被放宽。${impact}`,
      `When a skill has not been scanned yet and the call already reaches S2, it falls back to "${action}" so sensitive reads/writes are not relaxed before inspection. ${impact}`
    );
  }
  if (kind === "unscanned_S3") {
    return ui(
      `当 Skill 还没完成扫描、且调用达到 S3 时，会先按“${action}”处理，优先收紧执行和敏感外发。${impact}`,
      `When a skill has not been scanned yet and the call reaches S3, it falls back to "${action}" to tighten execution and sensitive egress first. ${impact}`
    );
  }
  return ui(
    `当 Skill 内容变了但版本没变时，会先按“${action}”处理，避免未声明变更直接继承旧信任。${impact}`,
    `When a skill changes without a version bump, it falls back to "${action}" so undeclared changes do not inherit previous trust by default. ${impact}`
  );
}

function formatPercent(value: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function normalizeLabel(value: unknown, fallback = ui("未标记", "Unlabeled")): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  return text || fallback;
}

function buildDistribution<T>(
  items: T[],
  getLabel: (item: T) => string | null | undefined,
  options: BuildDistributionOptions = {}
): DistributionItem[] {
  const fallbackLabel = options.fallbackLabel || ui("未标记", "Unlabeled");
  const limit = typeof options.limit === "number" ? options.limit : 0;
  const counts = new Map<string, number>();

  items.forEach((item) => {
    const label = normalizeLabel(getLabel(item), fallbackLabel);
    counts.set(label, (counts.get(label) || 0) + 1);
  });

  const sorted = Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, getActiveAdminLocale() === "zh-CN" ? "zh-CN" : "en-US"));

  if (limit > 0 && sorted.length > limit) {
    const top = sorted.slice(0, limit);
    const rest = sorted.slice(limit).reduce((sum, item) => sum + item.count, 0);
    if (rest > 0) {
      top.push({ label: ui("其他", "Others"), count: rest });
    }
    return top;
  }

  return sorted;
}

function withChartColors(items: DistributionItem[], theme: DashboardTheme = "light"): DistributionItem[] {
  const palette = CHART_PALETTES[theme] || CHART_PALETTES.light;
  return items.map((item, index) => ({
    ...item,
    color: item.color || palette[index % palette.length]
  }));
}

function parseRuleIds(rawRules: string | null | undefined): string[] {
  if (typeof rawRules !== "string" || !rawRules.trim() || rawRules.trim() === "-") {
    return [];
  }
  return rawRules
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "-");
}

function buildTrendSeries(records: DashboardDecisionRecord[], bucketCount = 12, bucketHours = 2): TrendSeries {
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const alignedEnd = Math.floor(Date.now() / bucketMs) * bucketMs + bucketMs;
  const start = alignedEnd - bucketCount * bucketMs;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    startTs: start + index * bucketMs,
    total: 0,
    risk: 0
  }));

  records.forEach((item) => {
    const ts = Date.parse(item?.ts || "");
    if (!Number.isFinite(ts) || ts < start || ts >= alignedEnd) {
      return;
    }
    const bucketIndex = Math.floor((ts - start) / bucketMs);
    if (bucketIndex < 0 || bucketIndex >= buckets.length) {
      return;
    }
    buckets[bucketIndex].total += 1;
    if (item?.decision !== "allow") {
      buckets[bucketIndex].risk += 1;
    }
  });

  return {
    start,
    end: alignedEnd,
    bucketHours,
    buckets
  };
}

function formatClock(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return date.toLocaleTimeString(getActiveAdminLocale() === "zh-CN" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function buildPageItems(currentPage: number, totalPages: number): number[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + 4);
  const adjustedStart = Math.max(1, end - 4);
  return Array.from({ length: end - adjustedStart + 1 }, (_, index) => adjustedStart + index);
}

function buildDecisionApiPath(decisionFilter: AdminDecisionFilterId, decisionPage: number): string {
  const searchParams = new URLSearchParams({
    page: String(decisionPage),
    page_size: String(DECISIONS_PER_PAGE)
  });
  if (decisionFilter !== "all") {
    searchParams.set("decision", decisionFilter);
  }
  return `/api/decisions?${searchParams.toString()}`;
}

function skillRiskLabel(value: string | null | undefined): string {
  return readLocalized(SKILL_RISK_TIER_TEXT, value, value || "-");
}

function skillStateLabel(value: string | null | undefined): string {
  return readLocalized(SKILL_STATE_TEXT, value, value || "-");
}

function skillScanStatusLabel(value: string | null | undefined): string {
  return readLocalized(SKILL_SCAN_STATUS_TEXT, value, value || "-");
}

function skillSourceLabel(value: string | null | undefined, detail?: string | null): string {
  const source = readLocalized(SKILL_SOURCE_TEXT, value, value || ui("未知来源", "Unknown Source"));
  return detail ? `${source} · ${detail}` : source;
}

function skillSeverityLabel(value: string | null | undefined): string {
  return readLocalized(SKILL_SEVERITY_TEXT, value, value || "-");
}

function skillReasonLabel(value: string | null | undefined): string {
  return readLocalized(SKILL_REASON_TEXT, value, value || "-");
}

function skillActivityLabel(value: string | null | undefined): string {
  return readLocalized(SKILL_ACTIVITY_TEXT, value, value || "-");
}

function skillRiskFilterLabel(value: SkillRiskFilterValue): string {
  if (value === "all") return ui("全部风险", "All Risk Tiers");
  return skillRiskLabel(value);
}

function skillStateFilterLabel(value: SkillStateFilterValue): string {
  if (value === "all") return ui("全部状态", "All States");
  return skillStateLabel(value);
}

function skillDriftFilterLabel(value: SkillDriftFilterValue): string {
  if (value === "all") return ui("全部变更状态", "All Change States");
  if (value === "drifted") return ui("仅看未声明变更", "Changed Without Version Update");
  return ui("无未声明变更", "No Undeclared Change");
}

function skillInterceptFilterLabel(value: SkillInterceptFilterValue): string {
  if (value === "all") return ui("全部拦截状态", "All Interception States");
  return ui("24 小时内有需确认 / 拦截", "Challenge / Block in Last 24h");
}

function normalizeSkillPolicyDraft(policy: unknown): SkillPolicyConfig | null {
  if (!policy || typeof policy !== "object") {
    return null;
  }
  return clone(policy as SkillPolicyConfig);
}

function buildSkillListApiPath(filters: SkillListFilters): string {
  const searchParams = new URLSearchParams();
  if (filters?.risk && filters.risk !== "all") {
    searchParams.set("risk", filters.risk);
  }
  if (filters?.state && filters.state !== "all") {
    searchParams.set("state", filters.state);
  }
  if (filters?.source && filters.source !== "all") {
    searchParams.set("source", filters.source);
  }
  if (filters?.drift && filters.drift !== "all") {
    searchParams.set("drift", filters.drift);
  }
  if (filters?.intercepted && filters.intercepted !== "all") {
    searchParams.set("intercepted", filters.intercepted);
  }
  const query = searchParams.toString();
  return query ? `/api/skills?${query}` : "/api/skills";
}

function formatHash(value: string | null | undefined, length = 10): string {
  if (typeof value !== "string" || !value.trim()) {
    return "-";
  }
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function formatConfidence(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0%";
  }
  return `${Math.round(numeric * 100)}%`;
}

function readInitialAdminLocale(): SecurityClawLocale {
  if (typeof window === "undefined") {
    return ADMIN_DEFAULT_LOCALE;
  }
  const queryLocale = new URLSearchParams(window.location.search).get("locale");
  const storedLocale = window.localStorage.getItem(ADMIN_LOCALE_STORAGE_KEY) || undefined;
  return resolveSecurityClawLocale(queryLocale || storedLocale || navigator.language, ADMIN_DEFAULT_LOCALE);
}

function readInitialAdminThemePreference(): DashboardThemePreference {
  if (typeof window === "undefined") {
    return ADMIN_DEFAULT_THEME_PREFERENCE;
  }
  const queryTheme = new URLSearchParams(window.location.search).get("theme");
  const storedTheme = window.localStorage.getItem(ADMIN_THEME_STORAGE_KEY) || undefined;
  return normalizeAdminThemePreference(queryTheme || storedTheme);
}

function readInitialAdminDashboardViewState(): AdminDashboardUrlState {
  if (typeof window === "undefined") {
    return {
      tab: "overview",
      decisionFilter: "all",
      decisionPage: 1
    };
  }
  return readAdminDashboardUrlState({
    search: window.location.search,
    hash: window.location.hash
  });
}

function App() {
  const [locale, setLocale] = useState<SecurityClawLocale>(readInitialAdminLocale);
  setActiveAdminLocale(locale);
  const [themePreference, setThemePreference] = useState<DashboardThemePreference>(readInitialAdminThemePreference);
  const [systemTheme, setSystemTheme] = useState<DashboardTheme>(readSystemTheme);
  const theme = useMemo(() => resolveAdminTheme(themePreference, systemTheme), [themePreference, systemTheme]);
  const [statusPayload, setStatusPayload] = useState<StatusApiPayload | null>(null);
  const [strategyModel, setStrategyModel] = useState<StrategyV2>(() => normalizeStrategyModel(null));
  const [publishedStrategyModel, setPublishedStrategyModel] = useState<StrategyV2>(() => normalizeStrategyModel(null));
  const [selectedFileDirectory, setSelectedFileDirectory] = useState("");
  const [newFileRuleDecision, setNewFileRuleDecision] = useState<Decision>("challenge");
  const [newFileRuleOperations, setNewFileRuleOperations] = useState<FileRuleOperation[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerLoading, setFilePickerLoading] = useState(false);
  const [filePickerError, setFilePickerError] = useState("");
  const [filePickerCurrentPath, setFilePickerCurrentPath] = useState("");
  const [filePickerParentPath, setFilePickerParentPath] = useState("");
  const [filePickerRoots, setFilePickerRoots] = useState<string[]>([]);
  const [filePickerDirectories, setFilePickerDirectories] = useState<DirectoryPickerEntry[]>([]);
  const [fileRuleDeleteTarget, setFileRuleDeleteTarget] = useState<FileRule | null>(null);
  const [accountPolicies, setAccountPolicies] = useState<AccountPolicyRecord[]>([]);
  const [publishedAccountPolicies, setPublishedAccountPolicies] = useState<AccountPolicyRecord[]>([]);
  const [availableSessions, setAvailableSessions] = useState<OpenClawChatSession[]>([]);
  const [skillStatusPayload, setSkillStatusPayload] = useState<SkillStatusPayload | null>(null);
  const [skillListPayload, setSkillListPayload] = useState<SkillListPayload | null>(null);
  const [skillDetailPayload, setSkillDetailPayload] = useState<SkillDetailPayload | null>(null);
  const [skillPolicy, setSkillPolicy] = useState<SkillPolicyConfig | null>(null);
  const [publishedSkillPolicy, setPublishedSkillPolicy] = useState<SkillPolicyConfig | null>(null);
  const [skillRiskFilter, setSkillRiskFilter] = useState<SkillRiskFilterValue>("all");
  const [skillStateFilter, setSkillStateFilter] = useState<SkillStateFilterValue>("all");
  const [skillSourceFilter, setSkillSourceFilter] = useState<SkillSourceFilterValue>("all");
  const [skillDriftFilter, setSkillDriftFilter] = useState<SkillDriftFilterValue>("all");
  const [skillInterceptFilter, setSkillInterceptFilter] = useState<SkillInterceptFilterValue>("all");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillListLoading, setSkillListLoading] = useState(true);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillPolicySaving, setSkillPolicySaving] = useState(false);
  const [skillActionLoading, setSkillActionLoading] = useState("");
  const [skillConfirmAction, setSkillConfirmAction] = useState<SkillConfirmAction | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [decisionLoading, setDecisionLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTabId>(() => readInitialAdminDashboardViewState().tab);
  const [decisionFilter, setDecisionFilter] = useState<AdminDecisionFilterId>(() => readInitialAdminDashboardViewState().decisionFilter);
  const [decisionPage, setDecisionPage] = useState(() => readInitialAdminDashboardViewState().decisionPage);
  const [decisionPayload, setDecisionPayload] = useState<DecisionHistoryPage | null>(null);
  const policies = useMemo(() => flattenStrategyRules(strategyModel), [strategyModel]);
  const publishedPolicies = useMemo(() => flattenStrategyRules(publishedStrategyModel), [publishedStrategyModel]);
  const fileRules = useMemo(() => strategyDirectoryOverrides(strategyModel), [strategyModel]);
  const publishedFileRules = useMemo(() => strategyDirectoryOverrides(publishedStrategyModel), [publishedStrategyModel]);
  const capabilityPolicies = useMemo<CapabilityPolicy[]>(
    () => toArray(strategyModel?.tool_policy?.capabilities),
    [strategyModel]
  );
  const hasFilesystemCapability = useMemo(
    () => capabilityPolicies.some((capability) => capability?.capability_id === "filesystem"),
    [capabilityPolicies]
  );

  const hasPendingRuleChanges = useMemo(
    () => JSON.stringify(policies) !== JSON.stringify(publishedPolicies),
    [policies, publishedPolicies]
  );
  const hasPendingFileRuleChanges = useMemo(
    () => serializeFileRules(fileRules) !== serializeFileRules(publishedFileRules),
    [fileRules, publishedFileRules]
  );
  const hasPendingAccountChanges = useMemo(
    () =>
      JSON.stringify(canonicalizeAccountPolicies(accountPolicies)) !==
      JSON.stringify(canonicalizeAccountPolicies(publishedAccountPolicies)),
    [accountPolicies, publishedAccountPolicies]
  );
  const hasPendingSkillPolicyChanges = useMemo(
    () => JSON.stringify(skillPolicy || null) !== JSON.stringify(publishedSkillPolicy || null),
    [publishedSkillPolicy, skillPolicy]
  );
  const hasPendingChanges = hasPendingRuleChanges || hasPendingFileRuleChanges || hasPendingAccountChanges;
  const hasPendingDashboardChanges = hasPendingChanges || hasPendingSkillPolicyChanges;
  const groupedPolicies = useMemo(
    () =>
      capabilityPolicies.map((capability, index) => [
        capability?.capability_id || `capability-${index}`,
        toArray(capability?.rules).map((rule, ruleIndex) => ({
          capability,
          policy: {
            ...clone(rule),
            match: clone(rule?.context || {}),
            enabled: rule?.enabled !== false
          },
          index: ruleIndex
        }))
      ]),
    [capabilityPolicies]
  );
  const displayAccounts = useMemo(
    () => mergeAccountPoliciesWithSessions(ensureDefaultAdminAccount(accountPolicies, availableSessions), availableSessions),
    [accountPolicies, availableSessions]
  );
  const selectedAdminSubject = useMemo(
    () => displayAccounts.find((account) => account.is_admin)?.subject || "",
    [displayAccounts]
  );
  const normalizedFileRules = useMemo(() => normalizeFileRules(fileRules), [fileRules]);
  const normalizedNewFileRuleOperations = useMemo(
    () => normalizeFileRuleOperations(newFileRuleOperations),
    [newFileRuleOperations]
  );
  const selectedDirectoryRuleExists = useMemo(() => {
    if (!selectedFileDirectory) {
      return false;
    }
    const selectedKey = fileRuleIdentityKey({
      directory: selectedFileDirectory,
      operations: normalizedNewFileRuleOperations
    });
    return normalizedFileRules.some((rule) => fileRuleIdentityKey(rule) === selectedKey);
  }, [normalizedFileRules, normalizedNewFileRuleOperations, selectedFileDirectory]);
  const skillItems = useMemo(() => toArray(skillListPayload?.items), [skillListPayload]);
  const skillSourceOptions = useMemo(() => toArray(skillListPayload?.source_options), [skillListPayload]);
  const skillOverviewHighlights = useMemo(() => toArray(skillStatusPayload?.highlights), [skillStatusPayload]);
  const skillSummaryCounts = skillListPayload?.counts || {
    total: 0,
    high_critical: 0,
    quarantined: 0,
    trusted: 0,
    drifted: 0,
    recent_intercepts: 0
  };
  const skillOverviewStats = skillStatusPayload?.stats || {
    total: 0,
    high_critical: 0,
    challenge_block_24h: 0,
    drift_alerts: 0,
    quarantined: 0,
    trusted_overrides: 0
  };
  useEffect(() => {
    setActiveAdminLocale(locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, locale);
    }
  }, [locale]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = `${ADMIN_BRAND_TEXT} · ${tabLabel(activeTab)}`;
    }
  }, [activeTab, locale]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mediaQuery = window.matchMedia(DARK_COLOR_SCHEME_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    setSystemTheme(mediaQuery.matches ? "dark" : "light");
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ADMIN_THEME_STORAGE_KEY, themePreference);
    }
  }, [theme, themePreference]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const syncFromLocation = () => {
      const next = readAdminDashboardUrlState({
        search: window.location.search,
        hash: window.location.hash
      });
      setActiveTab(next.tab);
      setDecisionFilter(next.decisionFilter);
      setDecisionPage(next.decisionPage);
    };

    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener("hashchange", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener("hashchange", syncFromLocation);
    };
  }, []);

  const navigateDashboard = useCallback((nextViewState: NavigateDashboardInput) => {
    const resolvedTab = nextViewState.tab ?? activeTab;
    const resolvedDecisionFilter = nextViewState.decisionFilter ?? decisionFilter;
    const resolvedDecisionPage = nextViewState.decisionPage ?? decisionPage;

    setActiveTab(resolvedTab);
    setDecisionFilter(resolvedDecisionFilter);
    setDecisionPage(resolvedDecisionPage);

    if (typeof window === "undefined") {
      return;
    }

    const nextSearch = buildAdminDashboardSearch({
      currentSearch: window.location.search,
      tab: resolvedTab,
      decisionFilter: resolvedDecisionFilter,
      decisionPage: resolvedDecisionPage
    });
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl || window.location.hash) {
      window.history.pushState({}, "", nextUrl);
    }
  }, [activeTab, decisionFilter, decisionPage]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const nextSearch = buildAdminDashboardSearch({
      currentSearch: window.location.search,
      tab: activeTab,
      decisionFilter,
      decisionPage
    });
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl || window.location.hash) {
      window.history.replaceState({}, "", nextUrl);
    }
  }, [activeTab, decisionFilter, decisionPage]);

  const loadData = useCallback(async (options: LoadDataOptions = {}) => {
    const {
      syncRules = true,
      syncAccounts = true,
      silent = false
    } = options;
    if (!silent) {
      setLoading(true);
    }
    setError("");
    try {
      const [status, strategy, accounts] = await Promise.all([
        getJson<StatusApiPayload>("/api/status"),
        getJson<StrategyApiPayload>("/api/strategy"),
        getJson<AccountsApiPayload>("/api/accounts")
      ]);
      setStatusPayload(status);
      const nextStrategyModel = extractStrategyModel(strategy);
      const nextFileRules = extractFileRules(strategy);
      const nextAccountPolicies = extractAccountPolicies(accounts);
      const nextSessions = extractChatSessions(accounts);
      setPublishedStrategyModel(nextStrategyModel);
      setPublishedAccountPolicies(nextAccountPolicies);
      setAvailableSessions(nextSessions);
      if (syncRules === true) {
        setStrategyModel(clone(nextStrategyModel));
        setSelectedFileDirectory((current) => current || nextFileRules[0]?.directory || "");
      }
      if (syncAccounts === true) {
        setAccountPolicies(clone(nextAccountPolicies));
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDecisionPage = useCallback(async (options: LoadDecisionOptions = {}) => {
    const { silent = false } = options;
    if (!silent) {
      setDecisionLoading(true);
    }
    try {
      const payload = await getJson<DecisionHistoryPage>(buildDecisionApiPath(decisionFilter, decisionPage));
      setDecisionPayload(payload);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setDecisionLoading(false);
    }
  }, [decisionFilter, decisionPage]);

  const loadSkillData = useCallback(async (options: LoadSkillDataOptions = {}) => {
    const {
      silent = false,
      syncPolicy = true
    } = options;
    if (!silent) {
      setSkillListLoading(true);
    }
    try {
      const [status, list] = await Promise.all([
        getJson<SkillStatusPayload>("/api/skills/status"),
        getJson<SkillListPayload>(
          buildSkillListApiPath({
            risk: skillRiskFilter,
            state: skillStateFilter,
            source: skillSourceFilter,
            drift: skillDriftFilter,
            intercepted: skillInterceptFilter
          })
        )
      ]);
      const nextPolicy = normalizeSkillPolicyDraft(status?.policy || list?.policy);
      setSkillStatusPayload(status);
      setSkillListPayload(list);
      if (nextPolicy) {
        setPublishedSkillPolicy(nextPolicy);
        if (syncPolicy) {
          setSkillPolicy(clone(nextPolicy));
        } else {
          setSkillPolicy((current) => current || clone(nextPolicy));
        }
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setSkillListLoading(false);
    }
  }, [skillDriftFilter, skillInterceptFilter, skillRiskFilter, skillSourceFilter, skillStateFilter]);

  const loadSkillDetail = useCallback(async (skillId: string, options: LoadDecisionOptions = {}) => {
    const { silent = false } = options;
    if (!skillId) {
      setSkillDetailPayload(null);
      return;
    }
    if (!silent) {
      setSkillDetailLoading(true);
    }
    try {
      const payload = await getJson<SkillDetailPayload>(`/api/skills/${encodeURIComponent(skillId)}`);
      setSkillDetailPayload(payload);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setSkillDetailLoading(false);
    }
  }, []);

  const loadDirectoryPicker = useCallback(async (targetPath = "") => {
    setFilePickerLoading(true);
    setFilePickerError("");
    try {
      const trimmedPath = typeof targetPath === "string" ? targetPath.trim() : "";
      const query = trimmedPath ? `?path=${encodeURIComponent(trimmedPath)}` : "";
      const payload = await getJson<DirectoryPickerPayload>(`/api/file-rule/directories${query}`);
      const currentPath = typeof payload?.current_path === "string" ? payload.current_path.trim() : "";
      const parentPath = typeof payload?.parent_path === "string" ? payload.parent_path.trim() : "";
      setFilePickerCurrentPath(currentPath);
      setFilePickerParentPath(parentPath);
      setFilePickerRoots(normalizeDirectoryPickerRoots(payload?.roots));
      setFilePickerDirectories(normalizeDirectoryPickerEntries(payload?.directories));
    } catch (loadError) {
      setFilePickerError(String(loadError));
    } finally {
      setFilePickerLoading(false);
    }
  }, []);

  const openDirectoryPicker = useCallback(() => {
    setFilePickerOpen(true);
    void loadDirectoryPicker(selectedFileDirectory || normalizedFileRules[0]?.directory || "");
  }, [loadDirectoryPicker, normalizedFileRules, selectedFileDirectory]);

  useEffect(() => {
    void loadData({ syncRules: true, syncAccounts: true, silent: false });
  }, [loadData]);

  useEffect(() => {
    void loadDecisionPage({ silent: false });
  }, [loadDecisionPage]);

  useEffect(() => {
    void loadSkillData({
      silent: false,
      syncPolicy: !hasPendingSkillPolicyChanges
    });
  }, [hasPendingSkillPolicyChanges, loadSkillData]);

  useEffect(() => {
    if (skillItems.length === 0) {
      setSelectedSkillId("");
      setSkillDetailPayload(null);
      return;
    }
    const selectedStillExists = skillItems.some((item) => item.skill_id === selectedSkillId);
    if (!selectedStillExists) {
      setSelectedSkillId(skillItems[0].skill_id);
    }
  }, [selectedSkillId, skillItems]);

  useEffect(() => {
    if (!selectedSkillId) {
      setSkillDetailPayload(null);
      return;
    }
    void loadSkillDetail(selectedSkillId, { silent: activeTab !== "skills" });
  }, [activeTab, loadSkillDetail, selectedSkillId]);

  useEffect(() => {
    if (!filePickerOpen && !fileRuleDeleteTarget && !skillConfirmAction) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (skillConfirmAction) {
          setSkillConfirmAction(null);
          return;
        }
        if (fileRuleDeleteTarget) {
          setFileRuleDeleteTarget(null);
          return;
        }
        setFilePickerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filePickerOpen, fileRuleDeleteTarget, skillConfirmAction]);

  useEffect(() => {
    if (hasPendingDashboardChanges || saving || skillPolicySaving || skillActionLoading) {
      return undefined;
    }
    const timer = setInterval(() => {
      void loadData({ syncRules: true, syncAccounts: true, silent: true });
      void loadDecisionPage({ silent: true });
      void loadSkillData({ silent: true, syncPolicy: true });
      if (selectedSkillId) {
        void loadSkillDetail(selectedSkillId, { silent: true });
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    hasPendingDashboardChanges,
    loadData,
    loadDecisionPage,
    loadSkillData,
    loadSkillDetail,
    saving,
    selectedSkillId,
    skillActionLoading,
    skillPolicySaving
  ]);

  const decisions = toArray<DashboardDecisionRecord>(statusPayload?.status?.recent_decisions);
  const decisionCounts: DecisionHistoryCounts = decisionPayload?.counts || {
    all: 0,
    allow: 0,
    warn: 0,
    challenge: 0,
    block: 0
  };
  const filteredDecisionTotal = Number(decisionPayload?.total || 0);
  const latestDecision = decisions[0] || null;
  const totalDecisionPages = Math.max(1, Math.ceil(filteredDecisionTotal / DECISIONS_PER_PAGE));
  const pagedDecisions = toArray(decisionPayload?.items);
  const pageItems = buildPageItems(decisionPage, totalDecisionPages);
  const firstDecisionIndex = filteredDecisionTotal === 0 ? 0 : (decisionPage - 1) * DECISIONS_PER_PAGE + 1;
  const lastDecisionIndex = Math.min(decisionPage * DECISIONS_PER_PAGE, filteredDecisionTotal);
  const decisionFilterOptions: Array<{ value: AdminDecisionFilterId; count: number }> = [
    { value: "all", count: decisionCounts.all },
    { value: "allow", count: decisionCounts.allow },
    { value: "warn", count: decisionCounts.warn },
    { value: "challenge", count: decisionCounts.challenge },
    { value: "block", count: decisionCounts.block }
  ];

  const stats = {
    total: decisionCounts.all,
    allow: decisionCounts.allow,
    warn: decisionCounts.warn,
    challenge: decisionCounts.challenge,
    block: decisionCounts.block
  };
  const beforeToolDecisions = useMemo(
    () => decisions.filter((item) => item.hook === "before_tool_call"),
    [decisions]
  );
  const analyticsSamples = beforeToolDecisions.length > 0 ? beforeToolDecisions : decisions;
  const policyTitleById = useMemo(() => {
    const table = new Map();
    policies.forEach((policy, index) => {
      if (policy?.rule_id) {
        table.set(policy.rule_id, policyTitle(policy, index));
      }
    });
    return table;
  }, [policies]);
  const messageSourceDistribution = useMemo(
    () => withChartColors(
      buildDistribution(
        analyticsSamples,
        (item) => `${normalizeLabel(item.actor, ui("匿名会话", "Anonymous Session"))} · ${scopeLabel(item.scope)}`,
        { limit: 6, fallbackLabel: ui("未标记", "Unlabeled") }
      ),
      theme
    ),
    [analyticsSamples, theme]
  );
  const decisionSourceDistribution = useMemo(
    () => withChartColors(
      buildDistribution(
        analyticsSamples,
        (item) => (item.decision_source ? decisionSourceLabel(item.decision_source) : ui("未标记", "Unlabeled")),
        { limit: 5, fallbackLabel: ui("未标记", "Unlabeled") }
      ),
      theme
    ),
    [analyticsSamples, theme]
  );
  const strategySource = useMemo(() => {
    const riskSamples = analyticsSamples.filter((item) => item.decision !== "allow");
    return riskSamples.length > 0 ? riskSamples : analyticsSamples;
  }, [analyticsSamples]);
  const strategyHitDistribution = useMemo(() => {
    const counts = new Map();
    strategySource.forEach((item) => {
      parseRuleIds(item.rules).forEach((ruleId) => {
        const label = policyTitleById.get(ruleId) || ruleId;
        counts.set(label, (counts.get(label) || 0) + 1);
      });
    });
    const distribution = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, getActiveAdminLocale() === "zh-CN" ? "zh-CN" : "en-US"));
    const top = distribution.slice(0, 8);
    const rest = distribution.slice(8).reduce((sum, item) => sum + item.count, 0);
    if (rest > 0) {
      top.push({ label: ui("其他", "Others"), count: rest });
    }
    return withChartColors(top, theme);
  }, [policyTitleById, strategySource, theme]);
  const strategyHitTotal = strategyHitDistribution.reduce((sum, item) => sum + item.count, 0);
  const toolDistribution = useMemo(
    () => withChartColors(
      buildDistribution(
        analyticsSamples,
        (item) => normalizeLabel(item.tool, ui("未知工具", "Unknown Tool")),
        { limit: 6, fallbackLabel: ui("未知工具", "Unknown Tool") }
      ),
      theme
    ),
    [analyticsSamples, theme]
  );
  const chartTheme = CHART_THEME[theme] || CHART_THEME.light;
  const trendSeries = useMemo(() => buildTrendSeries(analyticsSamples), [analyticsSamples]);
  const trendTotals = useMemo(() => trendSeries.buckets.map((bucket) => bucket.total), [trendSeries]);
  const trendRisks = useMemo(() => trendSeries.buckets.map((bucket) => bucket.risk), [trendSeries]);
  const trendData = useMemo(
    () => trendSeries.buckets.map((bucket) => ({
      time: formatClock(bucket.startTs),
      total: bucket.total,
      risk: bucket.risk
    })),
    [trendSeries]
  );
  const trendTickStep = Math.max(1, Math.floor(trendData.length / 6));
  const trendPeak = useMemo(() => Math.max(...trendTotals, 1), [trendTotals]);
  const trendRangeLabel = `${formatClock(trendSeries.start)} - ${formatClock(trendSeries.end)}`;
  const trendTotalCount = trendTotals.reduce((sum, value) => sum + value, 0);
  const trendRiskCount = trendRisks.reduce((sum, value) => sum + value, 0);

  const saveStrategy = useCallback(async (nextStrategyModel: StrategyV2 | unknown) => {
    const normalizedStrategy = normalizeStrategyModel(nextStrategyModel);
    normalizedStrategy.exceptions.directory_overrides = normalizeFileRules(
      normalizedStrategy.exceptions.directory_overrides
    ).map((rule) => ({
      ...rule,
      reason_codes: rule.reason_codes?.length ? rule.reason_codes : [defaultFileRuleReasonCode(rule.decision)],
    }));
    setSaving(true);
    setError("");
    setMessage(ui("策略模型自动保存中...", "Saving strategy model changes..."));
    try {
      const response = await fetch("/api/strategy", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": getActiveAdminLocale()
        },
        body: JSON.stringify({
          strategy: normalizedStrategy
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const suffix = payload.restart_required ? ui(" 需要重启 gateway 后完整生效。", " A gateway restart is required for full effect.") : "";
      const details = `${payload.message || ""}${suffix}`.trim();
      setMessage(
        details
          ? `${ui("策略已自动保存。", "Strategy saved automatically.")} ${details}`
          : ui("策略已自动保存。", "Strategy saved automatically.")
      );
      setPublishedStrategyModel(clone(normalizedStrategy));
      await loadData({ syncRules: false, syncAccounts: false, silent: true });
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  const saveAccounts = useCallback(async (nextAccounts: AccountPolicyRecord[]) => {
    const normalizedAccounts = canonicalizeAccountPolicies(pruneAccountPolicyOverrides(nextAccounts));
    setSaving(true);
    setError("");
    setMessage(ui("账号策略自动保存中...", "Saving account policy changes..."));
    try {
      const response = await fetch("/api/accounts", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": getActiveAdminLocale()
        },
        body: JSON.stringify({
          account_policies: normalizedAccounts
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const suffix = payload.restart_required ? ui(" 需要重启 gateway 后完整生效。", " A gateway restart is required for full effect.") : "";
      const details = `${payload.message || ""}${suffix}`.trim();
      setMessage(details ? `${ui("账号策略已自动保存。", "Account policies saved automatically.")} ${details}` : ui("账号策略已自动保存。", "Account policies saved automatically."));
      setPublishedAccountPolicies(clone(normalizedAccounts));
      setAccountPolicies(clone(normalizedAccounts));
      await loadData({ syncRules: false, syncAccounts: false, silent: true });
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  const saveSkillPolicyChanges = useCallback(async () => {
    if (!skillPolicy) {
      return;
    }
    setSkillPolicySaving(true);
    setError("");
    setMessage(ui("Skill 拦截策略保存中...", "Saving skill interception policy..."));
    try {
      const response = await fetch("/api/skills/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": getActiveAdminLocale()
        },
        body: JSON.stringify(skillPolicy)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const nextPolicy = normalizeSkillPolicyDraft(payload?.policy);
      if (nextPolicy) {
        setPublishedSkillPolicy(clone(nextPolicy));
        setSkillPolicy(clone(nextPolicy));
      }
      setMessage(payload?.message || ui("Skill 拦截策略已保存。", "Skill interception policy saved."));
      await loadSkillData({ silent: true, syncPolicy: true });
      if (selectedSkillId) {
        await loadSkillDetail(selectedSkillId, { silent: true });
      }
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSkillPolicySaving(false);
    }
  }, [loadSkillData, loadSkillDetail, selectedSkillId, skillPolicy]);

  const runSkillAction = useCallback(
    async (skillId: string, action: "rescan" | "quarantine" | "trust-override", body: Record<string, unknown> = {}) => {
    setSkillActionLoading(`${action}:${skillId}`);
    setError("");
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillId)}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": getActiveAdminLocale()
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as { message?: string; detail?: SkillDetailPayload };
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("操作失败", "Action failed")));
      }
      setMessage(payload?.message || ui("Skill 状态已更新。", "Skill status updated."));
      if (payload?.detail) {
        setSkillDetailPayload(payload.detail);
      } else if (selectedSkillId === skillId) {
        await loadSkillDetail(skillId, { silent: true });
      }
      await loadSkillData({ silent: true, syncPolicy: false });
    } catch (actionError) {
      setError(String(actionError));
      setMessage("");
    } finally {
      setSkillActionLoading("");
    }
    },
    [loadSkillData, loadSkillDetail, selectedSkillId]
  );

  useEffect(() => {
    if (loading || saving || (!hasPendingRuleChanges && !hasPendingFileRuleChanges)) {
      return undefined;
    }
    setMessage(
      ui(
        "检测到策略模型变更，正在自动保存...",
        "Strategy model changes detected. Saving automatically..."
      )
    );
    const timer = setTimeout(() => {
      void saveStrategy(strategyModel);
    }, 500);
    return () => clearTimeout(timer);
  }, [hasPendingFileRuleChanges, hasPendingRuleChanges, loading, saveStrategy, saving, strategyModel]);

  useEffect(() => {
    if (loading || saving || !hasPendingAccountChanges) {
      return undefined;
    }
    setMessage(ui("检测到账号策略变更，正在自动保存...", "Account policy changes detected. Saving automatically..."));
    const timer = setTimeout(() => {
      void saveAccounts(accountPolicies);
    }, 500);
    return () => clearTimeout(timer);
  }, [accountPolicies, hasPendingAccountChanges, loading, saveAccounts, saving]);

  useEffect(() => {
    if (decisionLoading) {
      return;
    }
    setDecisionPage((current) => Math.min(current, totalDecisionPages));
  }, [decisionLoading, totalDecisionPages]);

  function switchTab(tabId: AdminTabId) {
    navigateDashboard({
      tab: tabId,
      decisionFilter,
      decisionPage
    });
  }

  function openSkillWorkspace(skillId = "") {
    if (skillId) {
      setSelectedSkillId(skillId);
    }
    switchTab("skills");
  }

  function openDecisionRecords(filterId: AdminDecisionFilterId) {
    navigateDashboard({
      tab: "events",
      decisionFilter: filterId,
      decisionPage: 1
    });
  }

  function selectDecisionFilter(filterId: AdminDecisionFilterId) {
    navigateDashboard({
      tab: "events",
      decisionFilter: filterId,
      decisionPage: 1
    });
  }

  function updateSkillPolicyDraft(mutator: (next: SkillPolicyConfig) => void) {
    setSkillPolicy((current) => {
      const next = normalizeSkillPolicyDraft(current);
      if (!next) {
        return current;
      }
      mutator(next);
      return next;
    });
  }

  function updateSkillThreshold(field: SkillThresholdField, value: string) {
    updateSkillPolicyDraft((next) => {
      next.thresholds[field] = Number(value);
    });
  }

  function updateSkillMatrixDecision(tier: SkillPolicyTierKey, severity: SkillOperationSeverity, decision: Decision) {
    updateSkillPolicyDraft((next) => {
      next.matrix[tier][severity] = decision;
    });
  }

  function updateSkillDefaultAction(key: SkillDefaultActionKey, value: string) {
    updateSkillPolicyDraft((next) => {
      if (key === "drifted_action") {
        next.defaults.drifted_action = value as Decision;
        return;
      }
      if (key === "trust_override_hours") {
        next.defaults.trust_override_hours = Number(value);
        return;
      }
      if (key === "unscanned_S2") {
        next.defaults.unscanned.S2 = value as Decision;
        return;
      }
      if (key === "unscanned_S3") {
        next.defaults.unscanned.S3 = value as Decision;
      }
    });
  }

  function resetSkillPolicyDraft() {
    setSkillPolicy(normalizeSkillPolicyDraft(publishedSkillPolicy));
  }

  function triggerSkillRescan(skillId: string) {
    void runSkillAction(skillId, "rescan");
  }

  function requestSkillConfirm(kind: SkillConfirmAction["kind"], skill: SkillSummary | null | undefined, enable: boolean) {
    if (!skill?.skill_id) {
      return;
    }
    setSkillConfirmAction({
      kind,
      skillId: skill.skill_id,
      enable,
      skillName: skill.name
    });
  }

  function cancelSkillConfirmAction() {
    setSkillConfirmAction(null);
  }

  function confirmSkillAction() {
    if (!skillConfirmAction?.skillId) {
      return;
    }
    const targetSkillId = skillConfirmAction.skillId;
    if (skillConfirmAction.kind === "quarantine") {
      void runSkillAction(targetSkillId, "quarantine", {
        quarantined: Boolean(skillConfirmAction.enable),
        updated_by: "admin-ui"
      });
      setSkillConfirmAction(null);
      return;
    }
    if (skillConfirmAction.kind === "trust") {
      void runSkillAction(targetSkillId, "trust-override", {
        enabled: Boolean(skillConfirmAction.enable),
        updated_by: "admin-ui",
        hours: Number(skillPolicy?.defaults?.trust_override_hours || 6)
      });
      setSkillConfirmAction(null);
    }
  }

  function onDecisionChange(ruleId: string, decision: Decision) {
    setStrategyModel((current) => updateStrategyRuleDecision(current, ruleId, decision));
  }

  function updateAccountPolicy(subject: string, patch: Partial<AccountPolicyRecord>) {
    const nowIso = new Date().toISOString();
    const session = availableSessions.find((item) => item.subject === subject);
    setAccountPolicies((current) => {
      const currentIndex = current.findIndex((account) => account.subject === subject);
      const base =
        currentIndex >= 0
          ? current[currentIndex]
          : createAccountPolicyDraftFromSession(session, subject);
      const nextAccount = {
        ...base,
        ...patch,
        updated_at: nowIso
      };
      if (currentIndex >= 0) {
        return pruneAccountPolicyOverrides(
          current.map((account, index) => (index === currentIndex ? nextAccount : account))
        );
      }
      return pruneAccountPolicyOverrides([...current, nextAccount]);
    });
  }

  function setAdminAccount(subject: string) {
    const nowIso = new Date().toISOString();
    const session = availableSessions.find((item) => item.subject === subject);
    setAccountPolicies((current) => {
      let next = current.map((account) =>
        account.subject === subject
          ? {
              ...account,
              is_admin: true,
              updated_at: nowIso
            }
          : account.is_admin
            ? {
                ...account,
                is_admin: false,
                updated_at: nowIso
              }
            : account
      );
      if (!next.some((account) => account.subject === subject) && subject !== DEFAULT_MAIN_ADMIN_SESSION_KEY) {
        next = [
          ...next,
          {
            ...createAccountPolicyDraftFromSession(session, subject),
            is_admin: true,
            updated_at: nowIso
          }
        ];
      }
      if (subject === DEFAULT_MAIN_ADMIN_SESSION_KEY) {
        next = next.map((account) =>
          account.subject === subject
            ? {
                ...account,
                is_admin: false,
                updated_at: nowIso
              }
            : account
        );
      }
      return pruneAccountPolicyOverrides(next);
    });
  }

  function toggleDraftFileRuleOperation(operation: string) {
    setNewFileRuleOperations((current) => {
      if (operation === "__all__") {
        return [];
      }
      if (!FILE_RULE_OPERATION_OPTIONS.includes(operation)) {
        return current;
      }
      const normalizedCurrent = normalizeFileRuleOperations(current);
      return normalizedCurrent.includes(operation)
        ? normalizedCurrent.filter((entry) => entry !== operation)
        : normalizeFileRuleOperations([...normalizedCurrent, operation]);
    });
  }

  function updateDirectoryFileRule(ruleId: string, updater: (rule: FileRule) => FileRule | null) {
    setStrategyModel((currentStrategy) => {
      const normalizedCurrent = strategyDirectoryOverrides(currentStrategy);
      let changed = false;
      const nextRules = normalizedCurrent.map((rule) => {
        if (rule.id !== ruleId) {
          return rule;
        }
        const nextRule = normalizeFileRule(updater(rule));
        if (!nextRule) {
          return rule;
        }
        changed = true;
        return nextRule;
      });
      if (!changed) {
        return currentStrategy;
      }
      const nextTarget = nextRules.find((rule) => rule.id === ruleId);
      if (nextTarget) {
        const duplicate = nextRules.find(
          (rule) => rule.id !== ruleId && fileRuleIdentityKey(rule) === fileRuleIdentityKey(nextTarget)
        );
        if (duplicate) {
          setMessage(
            ui(
              "同一目录和操作范围已经存在另一条例外，请直接修改那条规则。",
              "Another override already covers the same directory and operation scope. Edit that one directly."
            )
          );
          return currentStrategy;
        }
      }
      return withStrategyDirectoryOverrides(currentStrategy, nextRules);
    });
  }

  function setDirectoryFileRuleDecision(ruleId: string, decision: string) {
    const normalizedDecision = typeof decision === "string" ? decision.trim() : "";
    if (!ruleId || !normalizedDecision || !DECISION_OPTIONS.includes(normalizedDecision)) {
      return;
    }
    updateDirectoryFileRule(ruleId, (rule) => ({
      ...rule,
      decision: normalizedDecision as Decision,
      reason_codes: [defaultFileRuleReasonCode(normalizedDecision as Decision)]
    }));
  }

  function setDirectoryFileRuleOperations(ruleId: string, operations: unknown) {
    if (!ruleId) {
      return;
    }
    updateDirectoryFileRule(ruleId, (rule) => {
      const normalizedOperations = normalizeFileRuleOperations(operations);
      if (normalizedOperations.length) {
        return {
          ...rule,
          operations: normalizedOperations
        };
      }
      const { operations: _operations, ...rest } = rule;
      return rest;
    });
  }

  function toggleDirectoryFileRuleOperation(ruleId: string, operation: string) {
    const currentRule = normalizedFileRules.find((rule) => rule.id === ruleId);
    if (!currentRule) {
      return;
    }
    const currentOperations = normalizeFileRuleOperations(currentRule.operations);
    if (operation === "__all__") {
      setDirectoryFileRuleOperations(ruleId, []);
      return;
    }
    if (!FILE_RULE_OPERATION_OPTIONS.includes(operation)) {
      return;
    }
    const nextOperations = currentOperations.includes(operation)
      ? currentOperations.filter((entry) => entry !== operation)
      : [...currentOperations, operation];
    setDirectoryFileRuleOperations(ruleId, nextOperations);
  }

  function applySelectedFileRule() {
    if (!selectedFileDirectory) {
      return;
    }
    if (selectedDirectoryRuleExists) {
      setMessage(
        ui(
          "该目录已存在规则，请在下方规则列表里调整处理方式。",
          "A rule already exists for this directory. Edit the action in the rule list below."
        )
      );
      return;
    }
    setStrategyModel((currentStrategy) =>
      withStrategyDirectoryOverrides(currentStrategy, [
        ...strategyDirectoryOverrides(currentStrategy),
        {
          id: `file-rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          directory: selectedFileDirectory,
          decision: newFileRuleDecision,
          ...(normalizedNewFileRuleOperations.length ? { operations: normalizedNewFileRuleOperations } : {}),
          reason_codes: [defaultFileRuleReasonCode(newFileRuleDecision)]
        }
      ])
    );
  }

  function removeFileRule(ruleId: string) {
    if (!ruleId) {
      return;
    }
    setStrategyModel((currentStrategy) =>
      withStrategyDirectoryOverrides(
        currentStrategy,
        strategyDirectoryOverrides(currentStrategy).filter((rule) => rule.id !== ruleId)
      )
    );
  }

  function requestRemoveFileRule(rule: unknown) {
    const normalizedRule = normalizeFileRule(rule);
    if (!normalizedRule) {
      return;
    }
    setFileRuleDeleteTarget(normalizedRule);
  }

  function cancelRemoveFileRule() {
    setFileRuleDeleteTarget(null);
  }

  function confirmRemoveFileRule() {
    if (!fileRuleDeleteTarget?.id) {
      return;
    }
    removeFileRule(fileRuleDeleteTarget.id);
    setFileRuleDeleteTarget(null);
  }

  function closeDirectoryPicker() {
    setFilePickerOpen(false);
    setFilePickerError("");
  }

  function chooseCurrentDirectory() {
    if (!filePickerCurrentPath) {
      return;
    }
    setSelectedFileDirectory(filePickerCurrentPath);
    setFilePickerOpen(false);
    setFilePickerError("");
  }

  const selectedSkill = skillDetailPayload?.skill || skillItems.find((item) => item.skill_id === selectedSkillId) || null;
  const selectedSkillFindings = toArray(skillDetailPayload?.findings || selectedSkill?.findings);
  const selectedSkillActivity = toArray(skillDetailPayload?.activity);
  const accountCount = displayAccounts.length;
  const tabCounts: Record<AdminTabId, number> = {
    overview: stats.total,
    events: stats.total,
    rules: policies.length,
    skills: skillOverviewStats.total,
    accounts: accountCount
  };
  const recentBlockCount = decisions.filter((item) => item.decision === "block").length;
  const recentChallengeCount = decisions.filter((item) => item.decision === "challenge").length;
  const recentWarnCount = decisions.filter((item) => item.decision === "warn").length;
  const postureTitle = recentBlockCount > 0
    ? ui("防护规则正在主动拦截风险操作", "Protection rules are actively blocking risky operations")
    : recentChallengeCount > 0
      ? ui("当前以需确认为主的审慎策略", "Current posture emphasizes approval-required decisions")
      : recentWarnCount > 0
        ? ui("当前以提醒为主，规则正在提示潜在风险", "Current posture is warning-first and highlighting potential risk")
      : ui("当前以放行为主，运行相对平稳", "Current posture is mostly allow and relatively stable");
  const postureDescription = latestDecision
    ? `${decisionLabel(latestDecision.decision)} · ${latestDecision.tool || ui("未知操作", "Unknown operation")} · ${resourceScopeLabel(latestDecision.resource_scope)}`
    : ui("等待新的运行数据进入控制台。", "Waiting for new runtime data.");
  const skillPostureTitle = skillOverviewStats.high_critical > 0
    ? ui("Skill 风险面正在重点关注高风险对象", "Skill posture is focused on high-risk items")
    : skillOverviewStats.challenge_block_24h > 0
      ? ui("Skill 扫描整体平稳，但仍有近期拦截活动", "Skill posture is stable overall with recent interceptions")
      : ui("Skill 库整体稳定，当前没有明显高风险对象", "Skill library is stable with no obvious high-risk items");
  const skillPostureDescription = skillOverviewHighlights[0]
    ? `${skillOverviewHighlights[0].name} · ${skillRiskLabel(skillOverviewHighlights[0].risk_tier)} · ${ui("风险分", "Risk")} ${skillOverviewHighlights[0].risk_score}`
    : ui("等待扫描目录中的 Skill 清单同步到概览。", "Waiting for installed skills to sync into overview.");
  const statusTone = error
    ? "error"
    : hasPendingDashboardChanges || saving || skillPolicySaving
      ? "warn"
      : "good";
  const statusMessage = error || message || (hasPendingChanges
    ? ui("检测到策略变更，正在自动保存...", "Strategy changes detected. Saving automatically...")
    : hasPendingSkillPolicyChanges
      ? ui("Skill 拦截策略有未保存修改。", "Skill interception policy has unsaved changes.")
      : "");
  const shouldShowStatus = Boolean(statusMessage);
  const hasActiveDecisionFilter = decisionFilter !== "all";
  const decisionFilterSummary = hasActiveDecisionFilter
    ? ui(`当前筛选：${decisionFilterLabel(decisionFilter)}，共 ${filteredDecisionTotal} 条记录。`, `Filter: ${decisionFilterLabel(decisionFilter)}. ${filteredDecisionTotal} records in total.`)
    : ui(`当前展示全部决策记录，共 ${filteredDecisionTotal} 条。`, `Showing all decision records. ${filteredDecisionTotal} records in total.`);
  const themeControls: ThemeControl[] = [
    {
      value: "system",
      label: ui("跟随系统外观", "Follow system appearance"),
      icon: <ToolbarIconSystem />
    },
    {
      value: "light",
      label: ui("切换到浅色模式", "Switch to light mode"),
      icon: <ToolbarIconSun />
    },
    {
      value: "dark",
      label: ui("切换到暗色模式", "Switch to dark mode"),
      icon: <ToolbarIconMoon />
    }
  ];
  const localeControls: LocaleControl[] = [
    {
      value: "zh-CN",
      label: ui("切换到简体中文", "Switch to Simplified Chinese"),
      icon: <ToolbarMonogram text="文" />
    },
    {
      value: "en",
      label: ui("切换到英文", "Switch to English"),
      icon: <ToolbarMonogram text="A" />
    }
  ];
  const tabItems = TAB_ITEMS as Array<{ id: AdminTabId }>;
  const filesystemOverridesProps: FilesystemOverridesSectionProps = {
    normalizedFileRules,
    selectedFileDirectory,
    newFileRuleDecision,
    newFileRuleOperations,
    selectedDirectoryRuleExists,
    openDirectoryPicker,
    setNewFileRuleDecision: (value: string) => setNewFileRuleDecision(value as Decision),
    toggleDraftFileRuleOperation,
    applySelectedFileRule,
    setDirectoryFileRuleDecision,
    toggleDirectoryFileRuleOperation,
    requestRemoveFileRule,
    fileRuleOperationsSummary,
    filePickerOpen,
    closeDirectoryPicker,
    filePickerParentPath,
    filePickerLoading,
    loadDirectoryPicker,
    filePickerCurrentPath,
    chooseCurrentDirectory,
    filePickerRoots,
    filePickerError,
    filePickerDirectories,
    fileRuleDeleteTarget,
    cancelRemoveFileRule,
    confirmRemoveFileRule
  };

  return (
    <DashboardShell
      brandText={ADMIN_BRAND_TEXT}
      locale={locale}
      activeTab={activeTab}
      tabItems={tabItems}
      tabCounts={tabCounts}
      tabLabel={tabLabel}
      onTabSelect={switchTab}
      themePreference={themePreference}
      themeControls={themeControls}
      onThemeSelect={setThemePreference}
      localeControls={localeControls}
      onLocaleSelect={setLocale}
      shouldShowStatus={shouldShowStatus}
      statusTone={statusTone}
      statusMessage={statusMessage}
    >
      {activeTab === "overview" ? (
        <OverviewPanel
          stats={stats}
          postureTitle={postureTitle}
          postureDescription={postureDescription}
          groupedPolicyCount={groupedPolicies.length}
          policyCount={policies.length}
          skillPostureTitle={skillPostureTitle}
          skillPostureDescription={skillPostureDescription}
          skillOverviewStats={skillOverviewStats}
          skillOverviewHighlights={skillOverviewHighlights}
          messageSourceDistribution={messageSourceDistribution}
          decisionSourceDistribution={decisionSourceDistribution}
          strategyHitDistribution={strategyHitDistribution}
          strategySourceCount={strategySource.length}
          strategyHitTotal={strategyHitTotal}
          toolDistribution={toolDistribution}
          analyticsSampleCount={analyticsSamples.length}
          theme={theme}
          chartTheme={chartTheme}
          trendRangeLabel={trendRangeLabel}
          trendBucketHours={trendSeries.bucketHours}
          trendData={trendData}
          trendTickStep={trendTickStep}
          trendTotalCount={trendTotalCount}
          trendRiskCount={trendRiskCount}
          trendPeak={trendPeak}
          formatPercent={formatPercent}
          formatTime={formatTime}
          skillRiskLabel={skillRiskLabel}
          skillSourceLabel={skillSourceLabel}
          onOpenDecisionRecords={openDecisionRecords}
          onOpenSkillWorkspace={openSkillWorkspace}
        />
      ) : null}

      {activeTab === "events" ? (
        <EventsPanel
          hasActiveDecisionFilter={hasActiveDecisionFilter}
          decisionFilter={decisionFilter}
          decisionFilterLabel={decisionFilterLabel}
          decisionFilterOptions={decisionFilterOptions}
          decisionFilterSummary={decisionFilterSummary}
          filteredDecisionTotal={filteredDecisionTotal}
          loading={loading}
          decisionLoading={decisionLoading}
          pagedDecisions={pagedDecisions}
          firstDecisionIndex={firstDecisionIndex}
          lastDecisionIndex={lastDecisionIndex}
          decisionPage={decisionPage}
          totalDecisionPages={totalDecisionPages}
          pageItems={pageItems}
          formatTime={formatTime}
          decisionSourceLabel={decisionSourceLabel}
          resourceScopeLabel={resourceScopeLabel}
          onRefresh={async () => {
            await Promise.all([
              loadData({
                syncRules: !hasPendingChanges && !saving,
                syncAccounts: !hasPendingChanges && !saving,
                silent: false
              }),
              loadDecisionPage({ silent: false })
            ]);
          }}
          onSelectDecisionFilter={selectDecisionFilter}
          onNavigatePage={(page) =>
            navigateDashboard({
              tab: "events",
              decisionFilter,
              decisionPage: page
            })
          }
        />
      ) : null}

      {activeTab === "rules" ? (
        <RulesPanel
          capabilityPolicies={capabilityPolicies}
          additionalRestrictionCount={policies.length}
          directoryOverrideCount={normalizedFileRules.length}
          hasFilesystemCapability={hasFilesystemCapability}
          filesystemOverridesProps={filesystemOverridesProps}
          capabilityLabel={capabilityLabel}
          capabilityDescription={capabilityDescription}
          decisionLabel={decisionLabel}
          controlDomainLabel={controlDomainLabel}
          severityLabel={severityLabel}
          policyTitle={policyTitle}
          ruleDescription={ruleDescription}
          userImpactSummary={userImpactSummary}
          capabilityBaselineSummary={capabilityBaselineSummary}
          onSetCapabilityDefaultDecision={(capabilityId, decision) =>
            setStrategyModel((current) => updateStrategyCapabilityDefaultDecision(current, capabilityId, decision))
          }
          onSetRuleDecision={onDecisionChange}
        />
      ) : null}

      {activeTab === "skills" ? (
        <SkillsPanel
          rootCount={toArray(skillStatusPayload?.roots).length}
          skillOverviewStats={skillOverviewStats}
          skillItems={skillItems}
          skillSummaryCounts={skillSummaryCounts}
          skillSourceOptions={skillSourceOptions}
          skillRiskFilter={skillRiskFilter}
          skillStateFilter={skillStateFilter}
          skillSourceFilter={skillSourceFilter}
          skillDriftFilter={skillDriftFilter}
          skillInterceptFilter={skillInterceptFilter}
          selectedSkillId={selectedSkillId}
          skillListLoading={skillListLoading}
          skillDetailLoading={skillDetailLoading}
          skillActionLoading={skillActionLoading}
          selectedSkill={selectedSkill}
          selectedSkillFindings={selectedSkillFindings}
          selectedSkillActivity={selectedSkillActivity}
          skillPolicy={skillPolicy}
          hasPendingSkillPolicyChanges={hasPendingSkillPolicyChanges}
          skillPolicySaving={skillPolicySaving}
          skillConfirmAction={skillConfirmAction}
          onRefresh={() => void loadSkillData({ silent: false, syncPolicy: !hasPendingSkillPolicyChanges })}
          onSelectSkill={setSelectedSkillId}
          onSetSkillRiskFilter={setSkillRiskFilter}
          onSetSkillStateFilter={setSkillStateFilter}
          onSetSkillSourceFilter={setSkillSourceFilter}
          onSetSkillDriftFilter={setSkillDriftFilter}
          onSetSkillInterceptFilter={setSkillInterceptFilter}
          onTriggerSkillRescan={triggerSkillRescan}
          onRequestSkillConfirm={requestSkillConfirm}
          onResetSkillPolicyDraft={resetSkillPolicyDraft}
          onSaveSkillPolicyChanges={saveSkillPolicyChanges}
          onUpdateSkillThreshold={updateSkillThreshold}
          onUpdateSkillMatrixDecision={updateSkillMatrixDecision}
          onUpdateSkillDefaultAction={updateSkillDefaultAction}
          onCancelSkillConfirmAction={cancelSkillConfirmAction}
          onConfirmSkillAction={confirmSkillAction}
          skillRiskLabel={skillRiskLabel}
          skillStateLabel={skillStateLabel}
          skillScanStatusLabel={skillScanStatusLabel}
          skillSourceLabel={skillSourceLabel}
          skillSeverityLabel={skillSeverityLabel}
          skillReasonLabel={skillReasonLabel}
          skillActivityLabel={skillActivityLabel}
          skillRiskFilterLabel={skillRiskFilterLabel}
          skillStateFilterLabel={skillStateFilterLabel}
          skillDriftFilterLabel={skillDriftFilterLabel}
          skillInterceptFilterLabel={skillInterceptFilterLabel}
          decisionLabel={decisionLabel}
          skillDefaultActionSummary={skillDefaultActionSummary}
          formatTime={formatTime}
          formatHash={formatHash}
          formatConfidence={formatConfidence}
        />
      ) : null}

      {activeTab === "accounts" ? (
        <AccountsPanel
          accountCount={accountCount}
          displayAccounts={displayAccounts}
          selectedAdminSubject={selectedAdminSubject}
          accountPrimaryLabel={accountPrimaryLabel}
          accountModeLabel={accountModeLabel}
          accountMetaLabel={accountMetaLabel}
          onUpdateAccountPolicy={updateAccountPolicy}
          onSetAdminAccount={setAdminAccount}
        />
      ) : null}
    </DashboardShell>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Admin root element not found");
}

createRoot(rootElement).render(<App />);
