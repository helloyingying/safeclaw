import test from "node:test";
import assert from "node:assert/strict";

import { ConfigManager } from "../src/config/loader.ts";
import { applyRuntimeOverride } from "../src/config/runtime_override.ts";
import { buildStrategyV2FromConfig } from "../src/domain/services/strategy_model.ts";

test("runtime override ignores strategy when no admin account is configured", () => {
  const base = ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
  const strategy = buildStrategyV2FromConfig(base);
  const overrideDirectory = "/tmp/securityclaw-runtime-override-test";
  strategy.exceptions.directory_overrides = [
    {
      id: "user-downloads-allow",
      directory: overrideDirectory,
      decision: "allow",
      operations: ["read"],
      reason_codes: ["USER_FILE_RULE_ALLOW"],
    },
  ];

  const next = applyRuntimeOverride(base, {
    strategy,
    account_policies: [
      {
        subject: "telegram:chat-42",
        mode: "apply_rules",
        is_admin: false,
      },
    ],
  });

  assert.equal(
    next.file_rules.some((rule) => rule.directory === overrideDirectory),
    false,
  );
});

test("runtime override applies strategy when an admin account is configured", () => {
  const base = ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
  const strategy = buildStrategyV2FromConfig(base);
  const overrideDirectory = "/tmp/securityclaw-runtime-override-test";
  strategy.exceptions.directory_overrides = [
    {
      id: "user-downloads-allow",
      directory: overrideDirectory,
      decision: "allow",
      operations: ["read"],
      reason_codes: ["USER_FILE_RULE_ALLOW"],
    },
  ];

  const next = applyRuntimeOverride(base, {
    strategy,
    account_policies: [
      {
        subject: "telegram:ops",
        mode: "apply_rules",
        is_admin: true,
      },
    ],
  });

  assert.equal(
    next.file_rules.some((rule) => rule.directory === overrideDirectory),
    true,
  );
});
