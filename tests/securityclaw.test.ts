import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldAutoStartAdminServer } from "../src/admin/runtime_guard.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { ApprovalFsm } from "../src/engine/approval_fsm.ts";
import { DecisionEngine } from "../src/engine/decision_engine.ts";
import { DlpEngine } from "../src/engine/dlp_engine.ts";
import { EventEmitter } from "../src/events/emitter.ts";
import { createSecurityClawPlugin } from "../src/index.ts";
import type {
  BeforeToolCallInput,
  DecisionContext,
  EventSink,
  SecurityClawConfig,
  SecurityDecisionEvent,
} from "../src/types.ts";

function createConfig(): SecurityClawConfig {
  return ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
}

function createDecisionContext(
  overrides: Partial<DecisionContext> = {},
  securityOverrides: Partial<DecisionContext["security_context"]> = {},
): DecisionContext {
  return {
    actor_id: "employee",
    scope: "default",
    tool_name: "network.http",
    tool_group: "network",
    operation: "request",
    tags: [],
    resource_scope: "none",
    resource_paths: [],
    asset_labels: [],
    data_labels: [],
    trust_level: "unknown",
    destination_type: "public",
    dest_domain: "api.example.com",
    dest_ip_class: "unknown",
    volume: {},
    security_context: {
      trace_id: "trace-1",
      actor_id: "employee",
      workspace: "payments",
      policy_version: "2026-03-17",
      untrusted: false,
      tags: [],
      created_at: "2026-03-17T00:00:00.000Z",
      ...securityOverrides
    },
    ...overrides
  };
}

function findRule(config: SecurityClawConfig, ruleId: string) {
  const rule = config.policies.find((item) => item.rule_id === ruleId);
  assert.ok(rule, `missing rule ${ruleId}`);
  return rule;
}

test("config loader reads default YAML and keeps policies", () => {
  const config = createConfig();
  assert.equal(config.version, "1.0");
  assert.equal(config.policies.length, 17);
  assert.deepEqual(config.file_rules, []);
  assert.equal(config.hooks.before_tool_call.fail_mode, "close");
  assert.equal(config.dlp.patterns[0].name, "email");
  assert.equal(config.policies[0]?.title, "高危命令模式默认拦截");
});

test("decision engine uses matched rule decision", () => {
  const config = createConfig();
  const engine = new DecisionEngine(config);
  const publicEgressRule = config.policies.find((rule) => rule.rule_id === "public-network-egress-challenge");
  const highRiskRule = config.policies.find((rule) => rule.rule_id === "high-risk-command-block");
  assert.ok(publicEgressRule);
  assert.ok(highRiskRule);
  const outcome = engine.evaluate(
    createDecisionContext({ actor_id: "contractor" }, { actor_id: "contractor" }),
    [
      {
        precedence: 7,
        rule: publicEgressRule
      },
      {
        precedence: 4,
        rule: highRiskRule
      }
    ],
  );
  assert.equal(outcome.decision, "challenge");
  assert.equal(outcome.challenge_ttl_seconds, 600);
  assert.deepEqual(outcome.reason_codes, ["PUBLIC_EGRESS_REQUIRES_APPROVAL"]);
  assert.equal(outcome.decision_source, "rule");
});

test("approval FSM expires pending approvals after TTL", () => {
  let now = 0;
  const approvals = new ApprovalFsm(() => now);
  const record = approvals.requestApproval(
    createDecisionContext({ actor_id: "contractor" }, { actor_id: "contractor" }),
    {
      ttl_seconds: 1,
      reason_codes: ["PUBLIC_EGRESS_REQUIRES_APPROVAL"]
    },
  );
  now = 2_000;
  assert.equal(approvals.getApprovalStatus(record.approval_id)?.status, "expired");
});

test("DLP engine masks and removes configured findings", () => {
  const dlp = new DlpEngine(createConfig().dlp);
  const findings = dlp.scan({
    email: "ops@example.com",
    auth: "Bearer abcdefghijklmnop",
    nested: "sk-1234567890ABCDE"
  });
  const sanitized = dlp.sanitize(
    {
      email: "ops@example.com",
      auth: "Bearer abcdefghijklmnop",
      nested: "sk-1234567890ABCDE"
    },
    findings,
    "sanitize",
  ) as Record<string, string>;
  assert.equal(findings.length, 3);
  assert.equal(sanitized.email, "[REDACTED]");
  assert.equal("auth" in sanitized, false);
  assert.equal(sanitized.nested, "[REDACTED]");
});

test("sensitive directory enumeration rule covers filesystem list and search operations", () => {
  const config = createConfig();
  const rule = findRule(config, "sensitive-directory-enumeration-challenge");

  assert.deepEqual(rule.match.tool_group, ["filesystem"]);
  assert.deepEqual(rule.match.operation, ["list", "search"]);
  assert.deepEqual(rule.match.asset_labels, [
    "credential",
    "personal_content",
    "download_staging",
    "browser_profile",
    "browser_secret_store",
    "communication_store",
  ]);
  assert.equal(rule.match.path_glob, undefined);
});

test("event emitter retries failed webhook sends", async () => {
  const sent: SecurityDecisionEvent[] = [];
  let attempts = 0;
  const sink: EventSink = {
    async send(event: SecurityDecisionEvent): Promise<void> {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary failure");
      }
      sent.push(event);
    }
  };
  const emitter = new EventEmitter(sink, 10, 3);
  const event: SecurityDecisionEvent = {
    schema_version: "1.0",
    event_type: "SecurityDecisionEvent",
    trace_id: "trace-1",
    hook: "before_tool_call",
    decision: "warn",
    reason_codes: ["TEST"],
    latency_ms: 5,
    ts: "2026-03-13T00:00:00.000Z"
  };
  await emitter.emitSecurityEvent(event);
  await emitter.flush();
  assert.equal(sent.length, 1);
  assert.equal(emitter.getStats().queued, 0);
});

test("default policy matrix covers every configured rule", async (t) => {
  const config = createConfig();
  const cases: Record<string, Omit<BeforeToolCallInput, "actor_id" | "workspace" | "scope">> = {
    "high-risk-command-block": {
      tool_name: "shell.exec",
      tool_group: "execution",
      operation: "execute",
      tool_args_summary: "rm -rf /tmp/demo"
    },
    "untrusted-execution-challenge": {
      tool_name: "shell.exec",
      tool_group: "execution",
      operation: "execute",
      tool_args_summary: "echo hello",
      trust_level: "untrusted"
    },
    "workspace-outside-write-block": {
      tool_name: "filesystem.write",
      tool_group: "filesystem",
      operation: "write",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/Desktop/demo.txt"]
    },
    "sensitive-directory-enumeration-challenge": {
      tool_name: "filesystem.search",
      tool_group: "filesystem",
      operation: "search",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/Downloads"]
    },
    "credential-path-access-challenge": {
      tool_name: "filesystem.read",
      tool_group: "filesystem",
      operation: "read",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/.ssh/id_rsa"]
    },
    "communication-store-access-challenge": {
      tool_name: "filesystem.read",
      tool_group: "filesystem",
      operation: "read",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/Library/Messages/chat.db"]
    },
    "public-network-egress-challenge": {
      tool_name: "network.http",
      tool_group: "network",
      operation: "request",
      destination_type: "public",
      dest_domain: "api.example.com"
    },
    "sensitive-public-egress-block": {
      tool_name: "network.http",
      tool_group: "network",
      operation: "request",
      destination_type: "public",
      dest_domain: "api.example.com",
      data_labels: ["secret"]
    },
    "sensitive-archive-challenge": {
      tool_name: "archive.create",
      tool_group: "archive",
      operation: "archive",
      data_labels: ["customer_data"]
    },
    "critical-control-plane-change-challenge": {
      tool_name: "filesystem.write",
      tool_group: "filesystem",
      operation: "write",
      resource_scope: "workspace_inside",
      resource_paths: ["/tmp/workspace/.github/workflows/deploy.yml"]
    },
    "email-content-access-challenge": {
      tool_name: "email.read",
      tool_group: "email",
      operation: "read"
    },
    "sms-content-access-challenge": {
      tool_name: "sms.read",
      tool_group: "sms",
      operation: "read"
    },
    "sms-otp-block": {
      tool_name: "sms.read",
      tool_group: "sms",
      operation: "read",
      data_labels: ["otp"]
    },
    "album-sensitive-read-challenge": {
      tool_name: "album.read",
      tool_group: "album",
      operation: "read",
      tool_args_summary: "screenshot of internal console"
    },
    "browser-credential-block": {
      tool_name: "filesystem.read",
      tool_group: "filesystem",
      operation: "read",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies"]
    },
    "business-system-bulk-read-block": {
      tool_name: "crm.export",
      tool_group: "business",
      operation: "export",
      volume: { record_count: 100 }
    },
    "break-glass-exception-challenge": {
      tool_name: "filesystem.read",
      tool_group: "filesystem",
      operation: "read",
      tags: ["break_glass"]
    }
  };

  assert.deepEqual(
    Object.keys(cases).sort(),
    config.policies.map((rule) => rule.rule_id).sort(),
  );

  for (const [ruleId, input] of Object.entries(cases)) {
    await t.test(ruleId, async () => {
      const plugin = createSecurityClawPlugin({
        config,
        generate_trace_id: () => `trace-${ruleId}`
      });
      const rule = findRule(config, ruleId);
      const result = await plugin.hooks.before_tool_call({
        actor_id: "employee",
        workspace: "payments",
        scope: "default",
        ...input
      });

      assert.equal(result.decision, rule.decision);
      assert.deepEqual(result.reason_codes, rule.reason_codes);
      if (rule.decision === "challenge") {
        assert.ok(result.approval?.approval_id);
        assert.deepEqual(result.approval?.request_context.rule_ids, [ruleId]);
      } else {
        assert.equal(result.approval, undefined);
      }
    });
  }
});

test("plugin blocks shell calls by rule", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-1" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec",
    tool_group: "execution",
    operation: "execute",
    tool_args_summary: "rm -rf /tmp/demo"
  });
  assert.equal(result.decision, "block");
  assert.deepEqual(result.reason_codes, ["HIGH_RISK_COMMAND_BLOCK"]);
});

test("plugin creates challenge and approved replay allows execution", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-2" });
  const first = await plugin.hooks.before_tool_call({
    actor_id: "contractor",
    workspace: "payments",
    scope: "default",
    tool_name: "network.http",
    tool_group: "network",
    operation: "request",
    destination_type: "public",
    dest_domain: "api.example.com"
  });
  assert.equal(first.decision, "challenge");
  assert.ok(first.approval?.approval_id);

  plugin.approvals.resolveApproval(first.approval!.approval_id, "secops", "approved", {
    approver_role: "secops"
  });
  const replay = await plugin.hooks.before_tool_call({
    actor_id: "contractor",
    workspace: "payments",
    scope: "default",
    tool_name: "network.http",
    tool_group: "network",
    operation: "request",
    destination_type: "public",
    dest_domain: "api.example.com",
    approval_id: first.approval!.approval_id
  });
  assert.equal(replay.decision, "allow");
  assert.deepEqual(replay.reason_codes, ["APPROVAL_GRANTED"]);
});

test("plugin challenges filesystem listing", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-list" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.list",
    tool_group: "filesystem",
    operation: "list",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Downloads"]
  });
  assert.equal(result.decision, "challenge");
  assert.deepEqual(result.reason_codes, ["SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL"]);
});

test("plugin challenges filesystem search in sensitive directories", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-search" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.search",
    tool_group: "filesystem",
    operation: "search",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Downloads"],
    tool_args_summary: "rg -n invoice /Users/liuzhuangm4/Downloads"
  });
  assert.equal(result.decision, "challenge");
  assert.deepEqual(result.reason_codes, ["SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL"]);
});

test("plugin allows search when built-in sensitive path mapping is removed", async () => {
  const config = structuredClone(createConfig());
  config.sensitivity.path_rules = config.sensitivity.path_rules.filter(
    (rule) => rule.id !== "download-staging-downloads-directory",
  );
  const plugin = createSecurityClawPlugin({ config, generate_trace_id: () => "trace-search-removed-sensitive-path" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.search",
    tool_group: "filesystem",
    operation: "search",
    resource_scope: "workspace_outside",
    resource_paths: ["/tmp/workspace/Downloads"],
    tool_args_summary: "find /tmp/workspace/Downloads -maxdepth 1 -type f",
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.reason_codes, ["NO_MATCH_DEFAULT_ALLOW"]);
});

test("plugin uses custom sensitive path mappings for credential approval", async () => {
  const config = structuredClone(createConfig());
  config.sensitivity.path_rules = [
    ...config.sensitivity.path_rules,
    {
      id: "custom-credential-share",
      asset_label: "credential",
      match_type: "prefix",
      pattern: "/srv/custom-secrets",
      source: "custom"
    }
  ];
  const plugin = createSecurityClawPlugin({ config, generate_trace_id: () => "trace-search-custom-sensitive-path" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.read",
    tool_group: "filesystem",
    operation: "read",
    resource_scope: "workspace_outside",
    resource_paths: ["/srv/custom-secrets/app.env"],
  });
  assert.equal(result.decision, "challenge");
  assert.deepEqual(result.reason_codes, ["CREDENTIAL_PATH_ACCESS_REQUIRES_APPROVAL"]);
});

test("plugin challenges filesystem search in personal content directories", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-personal-search" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.search",
    tool_group: "filesystem",
    operation: "search",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Documents"],
    tool_args_summary: "find /Users/liuzhuangm4/Documents -maxdepth 1 -type f",
  });
  assert.equal(result.decision, "challenge");
  assert.deepEqual(result.reason_codes, ["SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL"]);
});

test("plugin challenges filesystem reads from communication stores", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-comm" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.read",
    tool_group: "filesystem",
    operation: "read",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Library/Messages/chat.db"],
  });
  assert.equal(result.decision, "challenge");
  assert.deepEqual(result.reason_codes, ["COMMUNICATION_STORE_ACCESS_REQUIRES_APPROVAL"]);
});

test("plugin file rules with allow bypass downstream filesystem blocks", async () => {
  const config = structuredClone(createConfig());
  config.file_rules = [
    {
      id: "user-docs-allow",
      directory: "/Users/liuzhuangm4/Library/Application Support/Google/Chrome",
      decision: "allow",
      reason_codes: ["USER_FILE_RULE_ALLOW"]
    }
  ];
  const plugin = createSecurityClawPlugin({ config, generate_trace_id: () => "trace-file-rule-allow" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.read",
    tool_group: "filesystem",
    operation: "read",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies"],
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.decision_source, "file_rule");
  assert.deepEqual(result.reason_codes, ["USER_FILE_RULE_ALLOW"]);
});

test("plugin blocks filesystem reads of browser secret stores", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-browser" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.read",
    tool_group: "filesystem",
    operation: "read",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies"],
  });
  assert.equal(result.decision, "block");
  assert.deepEqual(result.reason_codes, ["BROWSER_SECRET_ACCESS_BLOCK"]);
});

test("persist strict blocks sensitive transcript writes", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-3" });
  const result = await plugin.hooks.tool_result_persist({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.write",
    mode: "strict",
    result: {
      secret: "sk-1234567890ABCDE"
    }
  });
  assert.equal(result.decision, "block");
  assert.deepEqual(result.reason_codes, ["PERSIST_BLOCKED_DLP"]);
});

test("message sending sanitizes DLP hits and restricted terms", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-4" });
  const result = await plugin.hooks.message_sending({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    message: "Contact ops@example.com with project-apollo status.",
    restricted_terms: ["project-apollo"]
  });
  assert.equal(result.decision, "warn");
  assert.equal(
    result.mutated_payload.message,
    "Contact [REDACTED] with [REDACTED] status.",
  );
  assert.ok(result.sanitization_actions.length >= 2);
});

test("hook timeout respects fail-open behavior", async () => {
  const config = structuredClone(createConfig());
  const plugin = createSecurityClawPlugin({ config, generate_trace_id: () => "trace-5" });
  const result = await plugin.hooks.message_sending({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    message: {
      secret: "sk-1234567890ABCDE",
      render: () => "unsafe"
    }
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.reason_codes, ["HOOK_ERROR"]);
});

test("plugin applies policy changes after config reload", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-reload" });
  const initial = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "dev",
    tool_name: "network.http"
  });
  assert.equal(initial.decision, "allow");
  assert.deepEqual(initial.reason_codes, ["NO_MATCH_DEFAULT_ALLOW"]);

  const updatedSource = readFileSync("./config/policy.default.yaml", "utf8").replace(
    'dlp:\n',
    `  - rule_id: "dev-network-block"
    group: "data_egress"
    enabled: true
    priority: 110
    decision: "block"
    reason_codes:
      - "DEV_NETWORK_BLOCK"
    match:
      scope:
        - "dev"
      tool:
        - "network.http"
dlp:
`,
  );
  plugin.config.reload(updatedSource);

  const updated = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "dev",
    tool_name: "network.http"
  });
  assert.equal(updated.decision, "block");
  assert.deepEqual(updated.reason_codes, ["DEV_NETWORK_BLOCK"]);
});

test("plugin defaults to allow when no rule matches", async () => {
  const config = structuredClone(createConfig());
  config.policies = config.policies.map((rule) =>
    rule.rule_id === "high-risk-command-block" ? { ...rule, enabled: false } : rule
  );

  const plugin = createSecurityClawPlugin({ config, generate_trace_id: () => "trace-default-allow" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec"
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.decision_source, "default");
  assert.deepEqual(result.reason_codes, ["NO_MATCH_DEFAULT_ALLOW"]);
});

test("rule matching supports resource scope and path prefix", async () => {
  const config = structuredClone(createConfig());
  config.policies = config.policies.map((rule) =>
    rule.rule_id === "high-risk-command-block" ? { ...rule, enabled: false } : rule
  );
  config.policies.push({
    rule_id: "workspace-outside-shell-block",
    group: "filesystem",
    enabled: true,
    priority: 200,
    decision: "block",
    reason_codes: ["WORKSPACE_OUTSIDE_BLOCK"],
    match: {
      scope: ["default"],
      tool: ["shell.exec"],
      resource_scope: ["workspace_outside"],
      path_prefix: ["/Users/liuzhuangm4/Downloads"]
    }
  });

  const plugin = createSecurityClawPlugin({ config, generate_trace_id: () => "trace-path-rule" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec",
    resource_scope: "workspace_outside",
    resource_paths: ["/Users/liuzhuangm4/Downloads/demo.txt"]
  });
  assert.equal(result.decision, "block");
  assert.equal(result.decision_source, "rule");
  assert.deepEqual(result.reason_codes, ["WORKSPACE_OUTSIDE_BLOCK"]);
});

test("approved replay enforces trace-bound single-use requirements", async () => {
  const plugin = createSecurityClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-break-glass" });
  const first = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec",
    tool_group: "execution",
    operation: "execute",
    tags: ["break_glass"]
  });
  assert.equal(first.decision, "challenge");
  assert.ok(first.approval?.approval_id);

  plugin.approvals.resolveApproval(first.approval.approval_id, "secops", "approved", {
    approver_role: "secops",
    ticket_id: "INC-123"
  });

  const allowed = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec",
    tool_group: "execution",
    operation: "execute",
    tags: ["break_glass"],
    approval_id: first.approval.approval_id
  });
  assert.equal(allowed.decision, "allow");

  const replay = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec",
    tool_group: "execution",
    operation: "execute",
    tags: ["break_glass"],
    approval_id: first.approval.approval_id
  });
  assert.equal(replay.decision, "block");
  assert.deepEqual(replay.reason_codes, ["APPROVAL_ALREADY_USED"]);
});

test("admin auto-start only enables for persistent gateway runtime", () => {
  assert.deepEqual(
    shouldAutoStartAdminServer({
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway"
    }),
    { enabled: true, reason: "gateway-service" },
  );

  assert.deepEqual(
    shouldAutoStartAdminServer({
      OPENCLAW_SERVICE_KIND: "gateway",
      XPC_SERVICE_NAME: "ai.openclaw.gateway"
    }),
    { enabled: true, reason: "gateway-supervisor" },
  );

  assert.deepEqual(
    shouldAutoStartAdminServer({
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_SERVICE_MARKER: "openclaw-cli"
    }),
    { enabled: true, reason: "gateway-service" },
  );

  assert.deepEqual(
    shouldAutoStartAdminServer({
      OPENCLAW_SERVICE_KIND: "gateway",
      SECURITYCLAW_ADMIN_AUTOSTART_FORCE: "1"
    }),
    { enabled: true, reason: "forced" },
  );

  assert.deepEqual(
    shouldAutoStartAdminServer({
      OPENCLAW_SERVICE_KIND: "gateway-restart"
    }),
    { enabled: false, reason: "non-persistent-runtime" },
  );

  assert.deepEqual(
    shouldAutoStartAdminServer({}),
    { enabled: false, reason: "non-persistent-runtime" },
  );
});
