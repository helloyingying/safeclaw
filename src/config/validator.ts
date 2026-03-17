import type {
  ApprovalRequirements,
  ChallengeConfig,
  Decision,
  HookControls,
  HookName,
  PolicyMatch,
  PolicyRule,
  SafeClawConfig,
  Severity,
} from "../types.ts";
import { normalizeSensitivePathRules } from "../domain/services/sensitive_path_registry.ts";

const DEFAULT_HOOKS: Record<HookName, HookControls> = {
  before_prompt_build: { enabled: true, timeout_ms: 50, fail_mode: "open" },
  before_tool_call: { enabled: true, timeout_ms: 50, fail_mode: "close" },
  after_tool_call: { enabled: true, timeout_ms: 50, fail_mode: "open" },
  tool_result_persist: { enabled: true, timeout_ms: 50, fail_mode: "close" },
  message_sending: { enabled: true, timeout_ms: 50, fail_mode: "open" }
};

const DECISIONS: Decision[] = ["allow", "warn", "challenge", "block"];
const DEFAULT_GROUP = "general";
const DEFAULT_CONTROL_DOMAIN = "execution_control";
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSeverity(value: unknown): Severity | undefined {
  return typeof value === "string" && SEVERITIES.includes(value as Severity)
    ? (value as Severity)
    : undefined;
}

function sanitizeDecision(value: unknown): Decision | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return DECISIONS.includes(value as Decision) ? (value as Decision) : undefined;
}

function sanitizePolicyMatch(match: PolicyRule["match"]): PolicyMatch {
  const normalized: PolicyMatch = {};
  const identity = normalizeStringArray(match?.identity);
  const scope = normalizeStringArray(match?.scope);
  const tool = normalizeStringArray(match?.tool);
  const toolGroup = normalizeStringArray(match?.tool_group);
  const operation = normalizeStringArray(match?.operation);
  const tags = normalizeStringArray(match?.tags);
  const resourceScope = normalizeStringArray(match?.resource_scope) as PolicyMatch["resource_scope"] | undefined;
  const pathPrefix = normalizeStringArray(match?.path_prefix);
  const pathGlob = normalizeStringArray(match?.path_glob);
  const pathRegex = normalizeStringArray(match?.path_regex);
  const fileType = normalizeStringArray(match?.file_type);
  const assetLabels = normalizeStringArray(match?.asset_labels);
  const dataLabels = normalizeStringArray(match?.data_labels);
  const trustLevel = normalizeStringArray(match?.trust_level) as PolicyMatch["trust_level"] | undefined;
  const destinationType = normalizeStringArray(match?.destination_type) as PolicyMatch["destination_type"] | undefined;
  const destDomain = normalizeStringArray(match?.dest_domain);
  const destIpClass = normalizeStringArray(match?.dest_ip_class) as PolicyMatch["dest_ip_class"] | undefined;
  const toolArgsSummary = normalizeStringArray(match?.tool_args_summary);
  const toolArgsRegex = normalizeStringArray(match?.tool_args_regex);
  const minFileCount = normalizeNumber(match?.min_file_count);
  const minBytes = normalizeNumber(match?.min_bytes);
  const minRecordCount = normalizeNumber(match?.min_record_count);

  if (identity) normalized.identity = identity;
  if (scope) normalized.scope = scope;
  if (tool) normalized.tool = tool;
  if (toolGroup) normalized.tool_group = toolGroup;
  if (operation) normalized.operation = operation;
  if (tags) normalized.tags = tags;
  if (resourceScope) normalized.resource_scope = resourceScope;
  if (pathPrefix) normalized.path_prefix = pathPrefix;
  if (pathGlob) normalized.path_glob = pathGlob;
  if (pathRegex) normalized.path_regex = pathRegex;
  if (fileType) normalized.file_type = fileType;
  if (assetLabels) normalized.asset_labels = assetLabels;
  if (dataLabels) normalized.data_labels = dataLabels;
  if (trustLevel) normalized.trust_level = trustLevel;
  if (destinationType) normalized.destination_type = destinationType;
  if (destDomain) normalized.dest_domain = destDomain;
  if (destIpClass) normalized.dest_ip_class = destIpClass;
  if (toolArgsSummary) normalized.tool_args_summary = toolArgsSummary;
  if (toolArgsRegex) normalized.tool_args_regex = toolArgsRegex;
  if (minFileCount !== undefined) normalized.min_file_count = minFileCount;
  if (minBytes !== undefined) normalized.min_bytes = minBytes;
  if (minRecordCount !== undefined) normalized.min_record_count = minRecordCount;

  return normalized;
}

function sanitizeChallenge(value: PolicyRule["challenge"]): ChallengeConfig | undefined {
  const ttlSeconds = normalizeNumber(value?.ttl_seconds);
  return ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : undefined;
}

function sanitizeApprovalRequirements(value: PolicyRule["approval_requirements"]): ApprovalRequirements | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const approverRoles = normalizeStringArray(value.approver_roles);
  const ttlSeconds = normalizeNumber(value.ttl_seconds);
  const traceBinding = value.trace_binding === "trace" ? "trace" : value.trace_binding === "none" ? "none" : undefined;
  const normalized: ApprovalRequirements = {
    ...(value.ticket_required === true ? { ticket_required: true } : {}),
    ...(approverRoles ? { approver_roles: approverRoles } : {}),
    ...(value.single_use === true ? { single_use: true } : {}),
    ...(traceBinding ? { trace_binding: traceBinding } : {}),
    ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sanitizePolicyRule(rule: PolicyRule): PolicyRule {
  const decision = sanitizeDecision(rule.decision);
  if (!decision) {
    throw new Error(`Policy ${rule.rule_id || "<unknown>"} must define a valid decision.`);
  }
  const controlDomain =
    normalizeString(rule.control_domain) ??
    normalizeString(rule.group) ??
    DEFAULT_CONTROL_DOMAIN;
  const title = normalizeString(rule.title);
  const description = normalizeString(rule.description);
  const severity = normalizeSeverity(rule.severity);
  const owner = normalizeString(rule.owner);
  const playbookUrl = normalizeString(rule.playbook_url);
  const challenge = sanitizeChallenge(rule.challenge);
  const approvalRequirements = sanitizeApprovalRequirements(rule.approval_requirements);
  return {
    ...rule,
    group: normalizeString(rule.group) ?? controlDomain ?? DEFAULT_GROUP,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(severity ? { severity } : {}),
    control_domain: controlDomain,
    ...(owner ? { owner } : {}),
    ...(playbookUrl ? { playbook_url: playbookUrl } : {}),
    enabled: rule.enabled !== false,
    decision,
    reason_codes: Array.isArray(rule.reason_codes) ? rule.reason_codes : [],
    match: sanitizePolicyMatch(rule.match ?? {}),
    ...(challenge ? { challenge } : {}),
    ...(approvalRequirements ? { approval_requirements: approvalRequirements } : {})
  };
}

export function validateConfig(raw: Record<string, unknown>): SafeClawConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be an object.");
  }

  const config = raw as Partial<SafeClawConfig>;
  if (!config.version || !config.policy_version || !config.environment) {
    throw new Error("Config must define version, policy_version, and environment.");
  }

  const hooks = { ...DEFAULT_HOOKS, ...(config.hooks ?? {}) };

  const policies = Array.isArray(config.policies) ? config.policies : [];
  const normalizedPolicies: PolicyRule[] = [];
  for (const rule of policies) {
    if (!rule.rule_id || typeof rule.priority !== "number") {
      throw new Error("Every policy must define rule_id and priority.");
    }
    normalizedPolicies.push(sanitizePolicyRule(rule));
  }

  const dlp = config.dlp;
  if (!dlp || !Array.isArray(dlp.patterns) || !dlp.on_dlp_hit) {
    throw new Error("DLP config must define patterns and on_dlp_hit.");
  }
  const webhookUrl = config.event_sink?.webhook_url;
  const rawSensitivity =
    raw.sensitivity && typeof raw.sensitivity === "object" && !Array.isArray(raw.sensitivity)
      ? (raw.sensitivity as Record<string, unknown>)
      : undefined;

  return {
    version: config.version,
    policy_version: config.policy_version,
    environment: config.environment,
    defaults: {
      approval_ttl_seconds: config.defaults?.approval_ttl_seconds ?? 900,
      persist_mode: config.defaults?.persist_mode ?? "compat"
    },
    hooks,
    policies: normalizedPolicies,
    sensitivity: {
      path_rules: normalizeSensitivePathRules(rawSensitivity?.path_rules, "builtin")
    },
    dlp: {
      on_dlp_hit: dlp.on_dlp_hit,
      patterns: dlp.patterns
    },
    event_sink: {
      timeout_ms: config.event_sink?.timeout_ms ?? 3000,
      max_buffer: config.event_sink?.max_buffer ?? 100,
      retry_limit: config.event_sink?.retry_limit ?? 3,
      ...(webhookUrl !== undefined ? { webhook_url: webhookUrl } : {})
    }
  };
}
