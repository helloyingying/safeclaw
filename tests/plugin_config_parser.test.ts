import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, rmSync } from "node:fs";

import {
  PluginConfigParser,
  resolveDefaultSecurityClawDbPath,
  resolveDefaultSecurityClawStatusPath,
  resolveSecurityClawStateDir,
} from "../src/infrastructure/config/plugin_config_parser.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";

test("plugin config parser defaults sqlite and status paths into the OpenClaw state directory", () => {
  const pluginRoot = "/tmp/securityclaw-plugin";
  const stateDir = "/tmp/openclaw-state";
  const resolved = PluginConfigParser.resolve(pluginRoot, {}, stateDir);

  assert.equal(resolved.dbPath, path.join(stateDir, "extensions", "securityclaw", "data", "securityclaw.db"));
  assert.equal(
    resolved.statusPath,
    path.join(stateDir, "extensions", "securityclaw", "runtime", "securityclaw-status.json"),
  );
  assert.equal(resolved.protectedDataDir, path.join(stateDir, "extensions", "securityclaw", "data"));
  assert.deepEqual(resolved.protectedDbPaths, [
    resolved.dbPath,
    `${resolved.dbPath}-shm`,
    `${resolved.dbPath}-wal`,
  ]);
});

test("plugin config parser avoids double-nesting when the state directory is already extension-scoped", () => {
  const scopedStateDir = path.join("/tmp", "openclaw-state", "extensions", "securityclaw");

  assert.equal(resolveSecurityClawStateDir(scopedStateDir), scopedStateDir);
  assert.equal(
    resolveDefaultSecurityClawDbPath(scopedStateDir),
    path.join(scopedStateDir, "data", "securityclaw.db"),
  );
  assert.equal(
    resolveDefaultSecurityClawStatusPath(scopedStateDir),
    path.join(scopedStateDir, "runtime", "securityclaw-status.json"),
  );
});

test("plugin config parser ignores relative db/status overrides and keeps storage under extensions/securityclaw", () => {
  const pluginRoot = "/tmp/securityclaw-plugin";
  const stateDir = "/tmp/openclaw-state";
  const resolved = PluginConfigParser.resolve(
    pluginRoot,
    {
      dbPath: "./runtime/securityclaw.db",
      statusPath: "./runtime/securityclaw-status.json",
    },
    stateDir,
  );

  assert.equal(resolved.dbPath, path.join(stateDir, "extensions", "securityclaw", "data", "securityclaw.db"));
  assert.equal(
    resolved.statusPath,
    path.join(stateDir, "extensions", "securityclaw", "runtime", "securityclaw-status.json"),
  );
});

test("default sqlite path works even when extensions/securityclaw/data does not exist yet", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-plugin-config-parser-"));
  const pluginRoot = path.join(tempDir, "plugin");
  const stateDir = path.join(tempDir, "openclaw-state");
  let store: StrategyStore | undefined;

  try {
    const resolved = PluginConfigParser.resolve(pluginRoot, {}, stateDir);
    assert.equal(existsSync(path.dirname(resolved.dbPath)), false);

    store = new StrategyStore(resolved.dbPath);
    store.writeOverride({ environment: "created-on-demand" });

    assert.equal(existsSync(path.dirname(resolved.dbPath)), true);
    assert.equal(store.readOverride()?.environment, "created-on-demand");
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
