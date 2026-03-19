import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { StrategyStore } from "../src/config/strategy_store.ts";
import type { RuntimeOverride } from "../src/config/runtime_override.ts";
import { readManagementStatus } from "../src/admin/server_policy.ts";

test("readManagementStatus reports whether admin configuration is active", () => {
  const noAdminOverride: RuntimeOverride = {
    account_policies: [
      {
        subject: "telegram:chat-42",
        mode: "apply_rules",
        is_admin: false,
      },
    ],
    strategy: {
      tool_policy: {
        capabilities: [],
      },
    } as never,
  };
  const noAdmin = readManagementStatus(noAdminOverride);

  assert.equal(noAdmin.admin_configured, false);
  assert.equal(noAdmin.management_effective, false);
  assert.equal(noAdmin.strategy_configured, true);

  const withAdminOverride: RuntimeOverride = {
    account_policies: [
      {
        subject: "telegram:ops",
        mode: "apply_rules",
        is_admin: true,
      },
    ],
    strategy: {
      tool_policy: {
        capabilities: [],
      },
    } as never,
  };
  const withAdmin = readManagementStatus(withAdminOverride);

  assert.equal(withAdmin.admin_configured, true);
  assert.equal(withAdmin.admin_subject, "telegram:ops");
  assert.equal(withAdmin.management_effective, true);
});

test("strategy store keeps saved strategy even when admin management is inactive", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-management-"));
  const dbPath = path.join(tempDir, "securityclaw.db");
  let store: StrategyStore | undefined;

  try {
    store = new StrategyStore(dbPath);
    const savedOverride: RuntimeOverride = {
      strategy: {
        tool_policy: {
          capabilities: [],
        },
      } as never,
      account_policies: [
        {
          subject: "telegram:chat-42",
          mode: "apply_rules",
          is_admin: false,
        },
      ],
    };
    store.writeOverride(savedOverride);

    const loadedOverride = store.readOverride();
    assert.equal(loadedOverride?.strategy !== undefined, true);
    const management = readManagementStatus(loadedOverride);
    assert.equal(management.management_effective, false);
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
