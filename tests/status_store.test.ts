import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { RuntimeStatusStore } from "../src/monitoring/status_store.ts";

type Snapshot = {
  config: {
    policy_version: string;
    strategy_db_path?: string;
  };
  hooks: {
    before_tool_call: {
      total: number;
      allow: number;
      warn: number;
      block: number;
    };
  };
  recent_decisions: Array<{ trace_id: string; decision: string }>;
};

function readSnapshot(snapshotPath: string): Snapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
}

test("status store persists counters and decisions in sqlite across restart", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-status-store-"));
  const snapshotPath = path.join(tempDir, "securityclaw-status.json");
  const dbPath = path.join(tempDir, "securityclaw.db");
  let firstStore: RuntimeStatusStore | undefined;
  let secondStore: RuntimeStatusStore | undefined;

  try {
    firstStore = new RuntimeStatusStore({ snapshotPath, dbPath, maxRecent: 10 });
    firstStore.markBoot({
      environment: "default",
      policy_version: "2026-03-13",
      policy_count: 4,
      config_path: "/tmp/policy.default.yaml",
      strategy_db_path: dbPath,
      strategy_loaded: false
    });
    firstStore.recordDecision({
      ts: "2026-03-14T14:00:00.000Z",
      hook: "before_tool_call",
      trace_id: "trace-1",
      tool: "shell.exec",
      decision: "allow",
      reasons: ["NO_MATCH_DEFAULT_ALLOW"]
    });
    firstStore.recordDecision({
      ts: "2026-03-14T14:00:01.000Z",
      hook: "before_tool_call",
      trace_id: "trace-2",
      tool: "shell.exec",
      decision: "block",
      reasons: ["SHELL_BLOCK"]
    });
    firstStore.close();
    firstStore = undefined;

    const firstSnapshot = readSnapshot(snapshotPath);
    assert.equal(firstSnapshot.hooks.before_tool_call.total, 2);
    assert.equal(firstSnapshot.hooks.before_tool_call.allow, 1);
    assert.equal(firstSnapshot.hooks.before_tool_call.block, 1);
    assert.equal(firstSnapshot.recent_decisions.length, 2);

    secondStore = new RuntimeStatusStore({ snapshotPath, dbPath, maxRecent: 10 });
    secondStore.markBoot({
      environment: "default",
      policy_version: "2026-03-14",
      policy_count: 5,
      config_path: "/tmp/policy.default.yaml",
      strategy_db_path: dbPath,
      strategy_loaded: true
    });

    const afterRestart = readSnapshot(snapshotPath);
    assert.equal(afterRestart.hooks.before_tool_call.total, 2);
    assert.equal(afterRestart.recent_decisions.length, 2);
    assert.equal(afterRestart.config.policy_version, "2026-03-14");

    secondStore.recordDecision({
      ts: "2026-03-14T14:00:02.000Z",
      hook: "before_tool_call",
      trace_id: "trace-3",
      tool: "shell.exec",
      decision: "warn",
      reasons: ["SHELL_AUDIT"]
    });

    const finalSnapshot = readSnapshot(snapshotPath);
    assert.equal(finalSnapshot.hooks.before_tool_call.total, 3);
    assert.equal(finalSnapshot.hooks.before_tool_call.warn, 1);
    assert.equal(finalSnapshot.recent_decisions.length, 3);
    assert.equal(finalSnapshot.recent_decisions[0]?.trace_id, "trace-3");
  } finally {
    firstStore?.close();
    secondStore?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status store bootstraps sqlite from legacy status json once", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-status-bootstrap-"));
  const snapshotPath = path.join(tempDir, "securityclaw-status.json");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const legacySnapshot = {
    updated_at: "2026-03-14T14:10:00.000Z",
    started_at: "2026-03-14T14:00:00.000Z",
    config: {
      environment: "default",
      policy_version: "2026-03-14",
      policy_count: 4,
      config_path: "/tmp/policy.default.yaml",
      override_path: "/tmp/policy.overrides.json",
      override_loaded: true
    },
    hooks: {
      before_tool_call: {
        total: 5,
        allow: 3,
        warn: 1,
        challenge: 0,
        block: 1,
        last_ts: "2026-03-14T14:09:59.000Z",
        last_tool: "shell.exec",
        last_scope: "default"
      }
    },
    recent_decisions: [
      {
        ts: "2026-03-14T14:09:59.000Z",
        hook: "before_tool_call",
        trace_id: "legacy-trace-1",
        tool: "shell.exec",
        decision: "block",
        reasons: ["SHELL_BLOCK"]
      }
    ]
  };
  let store: RuntimeStatusStore | undefined;

  try {
    writeFileSync(snapshotPath, `${JSON.stringify(legacySnapshot, null, 2)}\n`, "utf8");

    store = new RuntimeStatusStore({ snapshotPath, dbPath, maxRecent: 10 });
    store.markBoot({
      environment: "default",
      policy_version: "2026-03-15",
      policy_count: 5,
      config_path: "/tmp/policy.default.yaml",
      strategy_db_path: dbPath,
      strategy_loaded: true
    });
    store.recordDecision({
      ts: "2026-03-14T14:10:01.000Z",
      hook: "before_tool_call",
      trace_id: "trace-new",
      tool: "shell.exec",
      decision: "allow",
      reasons: ["NO_MATCH_DEFAULT_ALLOW"]
    });

    const snapshot = readSnapshot(snapshotPath);
    assert.equal(snapshot.hooks.before_tool_call.total, 6);
    assert.equal(snapshot.hooks.before_tool_call.allow, 4);
    assert.equal(snapshot.hooks.before_tool_call.block, 1);
    assert.equal(snapshot.recent_decisions.length, 2);
    assert.equal(snapshot.recent_decisions[1]?.trace_id, "legacy-trace-1");

    store.close();
    store = undefined;
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status store defaults sqlite into sibling data directory when snapshot lives under runtime", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-status-runtime-fallback-"));
  const snapshotPath = path.join(tempDir, "extensions", "securityclaw", "runtime", "securityclaw-status.json");
  const expectedDbPath = path.join(tempDir, "extensions", "securityclaw", "data", "securityclaw.db");
  let store: RuntimeStatusStore | undefined;

  try {
    store = new RuntimeStatusStore(snapshotPath);
    store.markBoot({
      environment: "default",
      policy_version: "2026-03-17",
      policy_count: 1,
      config_path: "/tmp/policy.default.yaml",
      strategy_db_path: expectedDbPath,
      strategy_loaded: false,
    });

    const snapshot = readSnapshot(snapshotPath);
    assert.equal(snapshot.config.strategy_db_path, expectedDbPath);
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
