import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { PluginSecurityStore } from "../src/admin/plugin_security_store.ts";
import type { AdminRuntime } from "../src/admin/server_types.ts";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writePlugin(
  rootPath: string,
  input: {
    id: string;
    sourceCode: string;
    manifest?: Record<string, unknown>;
    packageJson?: Record<string, unknown>;
  },
): void {
  mkdirSync(path.join(rootPath, "src"), { recursive: true });
  writeJson(path.join(rootPath, "openclaw.plugin.json"), {
    id: input.id,
    name: input.id,
    channels: [],
    skills: [],
    configSchema: {
      type: "object",
      properties: {},
    },
    ...(input.manifest || {}),
  });
  writeJson(path.join(rootPath, "package.json"), {
    name: input.id,
    version: "1.0.0",
    main: "src/index.js",
    dependencies: {},
    ...(input.packageJson || {}),
  });
  writeFileSync(path.join(rootPath, "src/index.js"), input.sourceCode, "utf8");
}

function createRuntime(openClawHome: string): AdminRuntime {
  return {
    port: 4780,
    configPath: path.join(openClawHome, "openclaw.json"),
    legacyOverridePath: path.join(openClawHome, "policy.overrides.json"),
    statusPath: path.join(openClawHome, "securityclaw-status.json"),
    dbPath: path.join(openClawHome, "securityclaw.db"),
    openClawHome,
  };
}

test("plugin security store discovers installed plugins, excludes securityclaw, and scores risky path plugins", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-plugin-store-"));
  const openClawHome = path.join(tempDir, ".openclaw");
  const goodPluginDir = path.join(openClawHome, "extensions", "good-plugin");
  const pathPluginDir = path.join(tempDir, "local-plugins", "path-plugin");
  const selfPluginDir = path.join(tempDir, "local-plugins", "securityclaw");

  try {
    writePlugin(goodPluginDir, {
      id: "good-plugin",
      sourceCode: "export function register() { return true; }\n",
      packageJson: {
        dependencies: {
          "tiny-lib": "^1.0.0",
        },
      },
    });
    writePlugin(pathPluginDir, {
      id: "path-plugin",
      sourceCode: [
        "import { execSync } from 'node:child_process';",
        "export async function run() {",
        "  await fetch('https://example.com');",
        "  console.log(process.env.TEST_TOKEN);",
        "  execSync('echo test');",
        "}",
      ].join("\n"),
      packageJson: {
        dependencies: Object.fromEntries(Array.from({ length: 42 }, (_, index) => [`dep-${index}`, "^1.0.0"])),
      },
    });
    writePlugin(selfPluginDir, {
      id: "securityclaw",
      sourceCode: "export default {};\n",
    });

    const store = new PluginSecurityStore(createRuntime(openClawHome), {
      async readConfigSnapshot() {
        return {
          source: "local-file",
          gatewayOnline: false,
          writeSupported: false,
          config: {
            plugins: {
              entries: {
                "good-plugin": { enabled: true },
                "path-plugin": { enabled: true },
                securityclaw: { enabled: true },
              },
              installs: {
                "good-plugin": {
                  source: "npm",
                  installPath: goodPluginDir,
                  version: "1.2.3",
                  integrity: "sha512-good",
                },
                securityclaw: {
                  source: "path",
                  installPath: selfPluginDir,
                },
              },
              load: {
                paths: [pathPluginDir, selfPluginDir],
              },
            },
          },
        };
      },
      now: () => Date.parse("2026-03-19T10:00:00.000Z"),
    });

    const list = await store.listPlugins();
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map((item) => item.plugin_id), ["path-plugin", "good-plugin"]);

    const status = await store.getStatus();
    assert.equal(status.stats.total, 2);
    assert.equal(status.stats.path_sources, 1);
    assert.equal(status.stats.exec_capable, 1);
    assert.equal(status.stats.network_capable, 1);

    const riskyPlugin = list.items[0];
    assert.equal(riskyPlugin.plugin_id, "path-plugin");
    assert.equal(riskyPlugin.source, "path");
    assert.equal(riskyPlugin.risk_tier, "critical");
    assert.ok(riskyPlugin.reason_codes.includes("PLUGIN_PATH_SOURCE"));
    assert.ok(riskyPlugin.reason_codes.includes("PLUGIN_EXECUTION_SIGNAL"));
    assert.ok(riskyPlugin.reason_codes.includes("PLUGIN_NETWORK_SIGNAL"));
    assert.ok(riskyPlugin.reason_codes.includes("PLUGIN_ENV_ACCESS"));

    const detail = await store.getPlugin("path-plugin");
    assert.ok(detail);
    assert.equal(detail?.plugin.plugin_id, "path-plugin");
    assert.ok(detail?.scanned_files.some((item) => item.includes("src/index.js")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plugin security store discovers plugins from load paths and supports filters", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-plugin-store-load-path-"));
  const openClawHome = path.join(tempDir, ".openclaw");
  const disabledPluginDir = path.join(tempDir, "plugins", "disabled-plugin");

  try {
    writePlugin(disabledPluginDir, {
      id: "disabled-plugin",
      sourceCode: "export default { name: 'disabled-plugin' };\n",
    });

    const store = new PluginSecurityStore(createRuntime(openClawHome), {
      async readConfigSnapshot() {
        return {
          source: "gateway-rpc",
          gatewayOnline: true,
          writeSupported: true,
          baseHash: "hash-1",
          config: {
            plugins: {
              entries: {
                "disabled-plugin": { enabled: false },
              },
              load: {
                paths: [disabledPluginDir],
              },
            },
          },
        };
      },
      now: () => Date.parse("2026-03-19T10:05:00.000Z"),
    });

    const allPlugins = await store.listPlugins();
    assert.equal(allPlugins.total, 1);
    assert.equal(allPlugins.items[0]?.plugin_id, "disabled-plugin");
    assert.equal(allPlugins.items[0]?.state, "disabled");

    const filteredByState = await store.listPlugins({ state: "disabled" });
    assert.equal(filteredByState.total, 1);

    const filteredBySource = await store.listPlugins({ source: "path" });
    assert.equal(filteredBySource.total, 1);

    const filteredMiss = await store.listPlugins({ state: "enabled" });
    assert.equal(filteredMiss.total, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
