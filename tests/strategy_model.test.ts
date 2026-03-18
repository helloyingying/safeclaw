import test from "node:test";
import assert from "node:assert/strict";

import { ConfigManager } from "../src/config/loader.ts";
import { PolicyPipeline } from "../src/engine/policy_pipeline.ts";
import { buildStrategyV2FromConfig, compileStrategyV2 } from "../src/domain/services/strategy_model.ts";
import type { DecisionContext } from "../src/types.ts";

function createDecisionContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
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
    volume: {},
    security_context: {
      trace_id: "trace-strategy-model",
      actor_id: "employee",
      workspace: "payments",
      policy_version: "2026-03-18",
      untrusted: false,
      tags: [],
      created_at: "2026-03-18T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("strategy model round-trip preserves directory overrides and custom classifiers", () => {
  const base = ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
  const strategy = buildStrategyV2FromConfig(base);
  strategy.exceptions.directory_overrides = [
    {
      id: "user-downloads-allow",
      directory: "/Users/liuzhuangm4/Downloads",
      decision: "allow",
      operations: ["read", "list"],
      reason_codes: ["USER_FILE_RULE_ALLOW"],
    }
  ];
  strategy.classifiers.disabled_builtin_ids = ["download-staging-downloads-directory"];
  strategy.classifiers.custom_sensitive_paths = [
    {
      id: "custom-sensitive-staging",
      asset_label: "download_staging",
      match_type: "prefix",
      pattern: "/srv/staging",
      source: "custom",
    }
  ];

  const compiled = compileStrategyV2(base, strategy);

  assert.equal(compiled.file_rules[0]?.id, "user-downloads-allow");
  assert.deepEqual(compiled.file_rules[0]?.operations, ["read", "list"]);
  assert.equal(
    compiled.sensitivity.path_rules.some((rule) => rule.id === "download-staging-downloads-directory"),
    false,
  );
  assert.equal(
    compiled.sensitivity.path_rules.some((rule) => rule.id === "custom-sensitive-staging"),
    true,
  );
});

test("policy pipeline respects capability baseline decisions compiled from StrategyV2", () => {
  const base = ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
  const strategy = buildStrategyV2FromConfig(base);
  strategy.tool_policy.capabilities = [
    {
      capability_id: "network",
      default_decision: "challenge",
      rules: [],
    }
  ];
  const compiled = compileStrategyV2(base, strategy);
  const pipeline = new PolicyPipeline({
    ...base,
    policies: compiled.policies,
    sensitivity: compiled.sensitivity,
    file_rules: compiled.file_rules,
  });

  const outcome = pipeline.evaluate(
    createDecisionContext({
      destination_type: "public",
      dest_domain: "api.example.com",
      dest_ip_class: "unknown",
    }),
  );

  assert.equal(outcome.decision, "challenge");
  assert.equal(outcome.decision_source, "rule");
  assert.deepEqual(outcome.reason_codes, ["CAPABILITY_NETWORK_CHALLENGE"]);
});

test("policy pipeline applies directory overrides only to matching operations", () => {
  const base = ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
  const strategy = buildStrategyV2FromConfig(base);
  strategy.exceptions.directory_overrides = [
    {
      id: "browser-secret-read-allow",
      directory: "/Users/liuzhuangm4/Library/Application Support/Google/Chrome",
      decision: "allow",
      operations: ["read"],
      reason_codes: ["USER_FILE_RULE_ALLOW"],
    }
  ];
  const compiled = compileStrategyV2(base, strategy);
  const pipeline = new PolicyPipeline({
    ...base,
    policies: compiled.policies,
    sensitivity: compiled.sensitivity,
    file_rules: compiled.file_rules,
  });

  const readOutcome = pipeline.evaluate(
    createDecisionContext({
      tool_name: "filesystem.read",
      tool_group: "filesystem",
      operation: "read",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies"],
      asset_labels: ["browser_secret"],
    }),
  );
  const writeOutcome = pipeline.evaluate(
    createDecisionContext({
      tool_name: "filesystem.write",
      tool_group: "filesystem",
      operation: "write",
      resource_scope: "workspace_outside",
      resource_paths: ["/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies"],
      asset_labels: ["browser_secret"],
    }),
  );

  assert.equal(readOutcome.decision, "allow");
  assert.equal(readOutcome.decision_source, "file_rule");
  assert.equal(writeOutcome.decision_source, "rule");
  assert.notEqual(writeOutcome.decision, "allow");
});
