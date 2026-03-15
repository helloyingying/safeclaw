import type { Decision, HookControls, HookName, PolicyRule, SafeClawConfig } from "../types.ts";

const DEFAULT_HOOKS: Record<HookName, HookControls> = {
  before_prompt_build: { enabled: true, timeout_ms: 50, fail_mode: "open" },
  before_tool_call: { enabled: true, timeout_ms: 50, fail_mode: "close" },
  after_tool_call: { enabled: true, timeout_ms: 50, fail_mode: "open" },
  tool_result_persist: { enabled: true, timeout_ms: 50, fail_mode: "close" },
  message_sending: { enabled: true, timeout_ms: 50, fail_mode: "open" }
};

const DECISIONS: Decision[] = ["allow", "warn", "challenge", "block"];
const DEFAULT_GROUP = "general";

function sanitizeDecision(value: unknown): Decision | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return DECISIONS.includes(value as Decision) ? (value as Decision) : undefined;
}

function sanitizePolicyRule(rule: PolicyRule): PolicyRule {
  const decision = sanitizeDecision(rule.decision);
  if (!decision) {
    throw new Error(`Policy ${rule.rule_id || "<unknown>"} must define a valid decision.`);
  }
  return {
    ...rule,
    group: typeof rule.group === "string" && rule.group.trim() ? rule.group.trim() : DEFAULT_GROUP,
    enabled: rule.enabled !== false,
    decision,
    reason_codes: Array.isArray(rule.reason_codes) ? rule.reason_codes : [],
    match: rule.match ?? {}
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
