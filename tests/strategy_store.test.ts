import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { StrategyStore } from "../src/config/strategy_store.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { buildStrategyV2FromConfig } from "../src/domain/services/strategy_model.ts";

test("strategy store persists override in sqlite", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-strategy-store-"));
  const dbPath = path.join(tempDir, "securityclaw.db");
  let store: StrategyStore | undefined;

  try {
    store = new StrategyStore(dbPath);
    assert.equal(store.readOverride(), undefined);
    const strategy = buildStrategyV2FromConfig(ConfigManager.fromFile("./config/policy.default.yaml").getConfig());
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
        id: "custom-sensitive-share",
        asset_label: "credential",
        match_type: "prefix",
        pattern: "/srv/secrets",
        source: "custom"
      }
    ];

    store.writeOverride({
      environment: "prod",
      policy_version: "2026-03-14",
      strategy,
      account_policies: [
        {
          subject: "telegram:chat-42",
          mode: "default_allow",
          is_admin: false
        }
      ]
    });
    assert.equal(store.readOverride()?.environment, "prod");
    assert.equal(store.readOverride()?.policy_version, "2026-03-14");
    assert.equal(store.readOverride()?.account_policies?.[0]?.subject, "telegram:chat-42");
    assert.equal(store.readOverride()?.strategy?.exceptions.directory_overrides?.[0]?.id, "user-downloads-allow");
    assert.deepEqual(store.readOverride()?.strategy?.exceptions.directory_overrides?.[0]?.operations, ["read"]);
    assert.equal(store.readOverride()?.strategy?.classifiers.disabled_builtin_ids?.[0], "download-staging-downloads-directory");
    assert.equal(store.readOverride()?.strategy?.classifiers.custom_sensitive_paths?.[0]?.id, "custom-sensitive-share");

    store.close();
    store = new StrategyStore(dbPath);
    assert.equal(store.readOverride()?.environment, "prod");
    assert.equal(store.readOverride()?.policy_version, "2026-03-14");
    assert.equal(store.readOverride()?.account_policies?.[0]?.mode, "default_allow");
    assert.equal(store.readOverride()?.strategy?.exceptions.directory_overrides?.[0]?.decision, "allow");
    assert.equal(store.readOverride()?.strategy?.classifiers.custom_sensitive_paths?.[0]?.pattern, "/srv/secrets");
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("strategy store migrates legacy override file once", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-strategy-legacy-"));
  const dbPath = path.join(tempDir, "securityclaw.db");
  const legacyPath = path.join(tempDir, "policy.overrides.json");
  let store: StrategyStore | undefined;

  try {
    writeFileSync(
      legacyPath,
      `${JSON.stringify(
        {
          updated_at: "2026-03-14T00:00:00.000Z",
          environment: "legacy"
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    store = new StrategyStore(dbPath, { legacyOverridePath: legacyPath });
    assert.equal(store.readOverride()?.environment, "legacy");
    store.writeOverride({ environment: "database" });
    store.close();

    writeFileSync(
      legacyPath,
      `${JSON.stringify(
        {
          updated_at: "2026-03-14T01:00:00.000Z",
          environment: "legacy-updated"
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    store = new StrategyStore(dbPath, { legacyOverridePath: legacyPath });
    assert.equal(store.readOverride()?.environment, "database");
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
