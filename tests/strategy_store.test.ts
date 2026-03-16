import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { StrategyStore } from "../src/config/strategy_store.ts";

test("strategy store persists override in sqlite", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-strategy-store-"));
  const dbPath = path.join(tempDir, "safeclaw.db");
  let store: StrategyStore | undefined;

  try {
    store = new StrategyStore(dbPath);
    assert.equal(store.readOverride(), undefined);

    store.writeOverride({
      environment: "prod",
      policy_version: "2026-03-14",
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

    store.close();
    store = new StrategyStore(dbPath);
    assert.equal(store.readOverride()?.environment, "prod");
    assert.equal(store.readOverride()?.policy_version, "2026-03-14");
    assert.equal(store.readOverride()?.account_policies?.[0]?.mode, "default_allow");
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("strategy store migrates legacy override file once", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-strategy-legacy-"));
  const dbPath = path.join(tempDir, "safeclaw.db");
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
