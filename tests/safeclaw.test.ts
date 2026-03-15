import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldAutoStartAdminServer } from "../src/admin/runtime_guard.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { ApprovalFsm } from "../src/engine/approval_fsm.ts";
import { DecisionEngine } from "../src/engine/decision_engine.ts";
import { DlpEngine } from "../src/engine/dlp_engine.ts";
import { EventEmitter } from "../src/events/emitter.ts";
import { createSafeClawPlugin } from "../src/index.ts";
import type { EventSink, SafeClawConfig, SecurityDecisionEvent } from "../src/types.ts";

function createConfig(): SafeClawConfig {
  return ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
}

test("config loader reads default YAML and keeps policies", () => {
  const config = createConfig();
  assert.equal(config.version, "1.0");
  assert.equal(config.policies.length, 4);
  assert.equal(config.hooks.before_tool_call.fail_mode, "close");
  assert.equal(config.dlp.patterns[0].name, "email");
});

test("decision engine uses matched rule decision", () => {
  const config = createConfig();
  const engine = new DecisionEngine(config);
  const outcome = engine.evaluate(
    {
      actor_id: "contractor",
      scope: "default",
      tool_name: "network.http",
      tags: [],
      resource_scope: "none",
      resource_paths: [],
      security_context: {
        trace_id: "trace-1",
        actor_id: "contractor",
        workspace: "payments",
        policy_version: "2026-03-13",
        untrusted: false,
        tags: [],
        created_at: "2026-03-13T00:00:00.000Z"
      }
    },
    [
      {
        precedence: 3,
        rule: config.policies[1]
      },
      {
        precedence: 2,
        rule: config.policies[0]
      }
    ],
  );
  assert.equal(outcome.decision, "challenge");
  assert.equal(outcome.challenge_ttl_seconds, 600);
  assert.deepEqual(outcome.reason_codes, ["IDENTITY_REQUIRES_APPROVAL"]);
  assert.equal(outcome.decision_source, "rule");
});

test("approval FSM expires pending approvals after TTL", () => {
  let now = 0;
  const approvals = new ApprovalFsm(() => now);
  const record = approvals.requestApproval(
    {
      actor_id: "contractor",
      scope: "default",
      tool_name: "network.http",
      tags: [],
      resource_scope: "none",
      resource_paths: [],
      security_context: {
        trace_id: "trace-1",
        actor_id: "contractor",
        workspace: "payments",
        policy_version: "2026-03-13",
        untrusted: false,
        tags: [],
        created_at: "2026-03-13T00:00:00.000Z"
      }
    },
    1,
    ["IDENTITY_REQUIRES_APPROVAL"],
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

test("plugin blocks shell calls by rule", async () => {
  const plugin = createSafeClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-1" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "shell.exec"
  });
  assert.equal(result.decision, "block");
  assert.deepEqual(result.reason_codes, ["SHELL_BLOCK"]);
});

test("plugin creates challenge and approved replay allows execution", async () => {
  const plugin = createSafeClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-2" });
  const first = await plugin.hooks.before_tool_call({
    actor_id: "contractor",
    workspace: "payments",
    scope: "default",
    tool_name: "network.http"
  });
  assert.equal(first.decision, "challenge");
  assert.ok(first.approval?.approval_id);

  plugin.approvals.resolveApproval(first.approval!.approval_id, "secops", "approved");
  const replay = await plugin.hooks.before_tool_call({
    actor_id: "contractor",
    workspace: "payments",
    scope: "default",
    tool_name: "network.http",
    approval_id: first.approval!.approval_id
  });
  assert.equal(replay.decision, "allow");
  assert.deepEqual(replay.reason_codes, ["APPROVAL_GRANTED"]);
});

test("plugin challenges filesystem listing", async () => {
  const plugin = createSafeClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-list" });
  const result = await plugin.hooks.before_tool_call({
    actor_id: "employee",
    workspace: "payments",
    scope: "default",
    tool_name: "filesystem.list"
  });
  assert.equal(result.decision, "challenge");
  assert.deepEqual(result.reason_codes, ["FILE_ENUMERATION_REQUIRES_APPROVAL"]);
});

test("persist strict blocks sensitive transcript writes", async () => {
  const plugin = createSafeClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-3" });
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
  const plugin = createSafeClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-4" });
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
  const plugin = createSafeClawPlugin({ config, generate_trace_id: () => "trace-5" });
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
  const plugin = createSafeClawPlugin({ config: createConfig(), generate_trace_id: () => "trace-reload" });
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
    group: "email"
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
    rule.rule_id === "shell-block" ? { ...rule, enabled: false } : rule
  );

  const plugin = createSafeClawPlugin({ config, generate_trace_id: () => "trace-default-allow" });
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
    rule.rule_id === "shell-block" ? { ...rule, enabled: false } : rule
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

  const plugin = createSafeClawPlugin({ config, generate_trace_id: () => "trace-path-rule" });
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
      SAFECLAW_ADMIN_AUTOSTART_FORCE: "1"
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
