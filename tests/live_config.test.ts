import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";

import { LiveConfigResolver } from "../src/config/live_config.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";
import { DecisionEngine } from "../src/engine/decision_engine.ts";
import { RuleEngine } from "../src/engine/rule_engine.ts";
import { buildStrategyV2FromConfig } from "../src/domain/services/strategy_model.ts";
import type { DecisionContext, PolicyRule, SecurityClawConfig } from "../src/types.ts";

function createDecisionContext(policyVersion: string): DecisionContext {
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
      trace_id: "trace-live-config",
      actor_id: "employee",
      workspace: "payments",
      policy_version: policyVersion,
      untrusted: false,
      tags: [],
      created_at: "2026-03-14T00:00:00.000Z"
    }
  };
}

function evaluateDecision(config: SecurityClawConfig) {
  const context = createDecisionContext(config.policy_version);
  const matches = new RuleEngine(config.policies).match(context);
  return new DecisionEngine(config).evaluate(context, matches);
}

test("live config resolver applies sqlite strategy changes on next read", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-live-config-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const blockRule: PolicyRule = {
    rule_id: "runtime-network-block",
    group: "network",
    enabled: true,
    priority: 200,
    decision: "block",
    reason_codes: ["RUNTIME_NETWORK_BLOCK"],
    match: {
      scope: ["default"],
      tool: ["network.http"]
    }
  };
  let resolver: LiveConfigResolver | undefined;

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    resolver = new LiveConfigResolver({ configPath, dbPath });

    const initial = resolver.getSnapshot();
    assert.equal(initial.overrideLoaded, false);
    assert.equal(evaluateDecision(initial.config).decision, "allow");

    const writer = new StrategyStore(dbPath);
    try {
      const strategy = buildStrategyV2FromConfig({
        ...initial.config,
        policies: [blockRule],
        file_rules: [],
      });
      writer.writeOverride({
        policy_version: "2026-03-14-hot",
        strategy,
        account_policies: [
          {
            subject: "telegram:ops",
            mode: "apply_rules",
            is_admin: true,
          },
        ],
      });
    } finally {
      writer.close();
    }

    const updated = resolver.getSnapshot();
    assert.equal(updated.overrideLoaded, true);
    const outcome = evaluateDecision(updated.config);
    assert.equal(outcome.decision, "block");
    assert.deepEqual(outcome.reason_codes, ["RUNTIME_NETWORK_BLOCK"]);
    assert.equal(updated.config.policy_version, "2026-03-14-hot");
  } finally {
    resolver?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("live config resolver applies sensitive path strategy overrides on next read", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-live-config-sensitive-paths-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  let resolver: LiveConfigResolver | undefined;

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    resolver = new LiveConfigResolver({ configPath, dbPath });

    const initial = resolver.getSnapshot();
    assert.equal(
      initial.config.sensitivity.path_rules.some((rule) => rule.id === "download-staging-downloads-directory"),
      true,
    );

    const writer = new StrategyStore(dbPath);
    try {
      const strategy = buildStrategyV2FromConfig(initial.config);
      strategy.exceptions.directory_overrides = [
        {
          id: "user-downloads-allow",
          directory: "/Users/liuzhuangm4/Downloads",
          decision: "allow",
          operations: ["read"],
          reason_codes: ["USER_FILE_RULE_ALLOW"]
        }
      ];
      strategy.classifiers.disabled_builtin_ids = ["download-staging-downloads-directory"];
      strategy.classifiers.custom_sensitive_paths = [
        {
          id: "custom-sensitive-staging",
          asset_label: "download_staging",
          match_type: "prefix",
          pattern: "/srv/staging",
          source: "custom"
        }
      ];
      writer.writeOverride({
        strategy,
        account_policies: [
          {
            subject: "telegram:ops",
            mode: "apply_rules",
            is_admin: true,
          },
        ],
      });
    } finally {
      writer.close();
    }

    const updated = resolver.getSnapshot();
    assert.equal(
      updated.config.sensitivity.path_rules.some((rule) => rule.id === "download-staging-downloads-directory"),
      false,
    );
    assert.equal(
      updated.config.sensitivity.path_rules.some((rule) => rule.id === "custom-sensitive-staging"),
      true,
    );
    assert.equal(updated.config.file_rules.some((rule) => rule.id === "user-downloads-allow"), true);
    assert.deepEqual(
      updated.config.file_rules.find((rule) => rule.id === "user-downloads-allow")?.operations,
      ["read"],
    );
  } finally {
    resolver?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
