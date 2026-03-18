import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenClawDevPluginConfig } from "../scripts/openclaw-dev-link-lib.mjs";

test("buildOpenClawDevPluginConfig preserves existing plugin config while switching install to path", () => {
  const next = buildOpenClawDevPluginConfig(
    {
      plugins: {
        allow: ["telegram"],
        entries: {
          securityclaw: {
            enabled: false,
            config: {
              adminPort: 4780,
            },
          },
        },
        installs: {
          securityclaw: {
            source: "npm",
            spec: "securityclaw@0.0.3",
            installPath: "/Users/test/.openclaw/extensions/securityclaw",
            version: "0.0.3",
          },
        },
      },
    },
    {
      pluginId: "securityclaw",
      pluginPath: "/Users/test/develop/securityclaw",
      version: "0.0.3",
      installedAt: "2026-03-18T00:00:00.000Z",
    },
  );

  assert.deepEqual(next.plugins?.allow, ["telegram", "securityclaw"]);
  assert.deepEqual(next.plugins?.entries?.securityclaw, {
    enabled: true,
    config: {
      adminPort: 4780,
    },
  });
  assert.deepEqual(next.plugins?.load?.paths, ["/Users/test/develop/securityclaw"]);
  assert.deepEqual(next.plugins?.installs?.securityclaw, {
    source: "path",
    sourcePath: "/Users/test/develop/securityclaw",
    installPath: "/Users/test/develop/securityclaw",
    version: "0.0.3",
    installedAt: "2026-03-18T00:00:00.000Z",
  });
});

test("buildOpenClawDevPluginConfig deduplicates existing allow and load path entries", () => {
  const next = buildOpenClawDevPluginConfig(
    {
      plugins: {
        allow: ["securityclaw", "telegram"],
        load: {
          paths: [
            "/Users/test/develop/securityclaw",
            "/Users/test/other-plugin",
          ],
          watch: true,
        },
      },
    },
    {
      pluginId: "securityclaw",
      pluginPath: "/Users/test/develop/securityclaw",
    },
  );

  assert.deepEqual(next.plugins?.allow, ["securityclaw", "telegram"]);
  assert.deepEqual(next.plugins?.load, {
    paths: [
      "/Users/test/develop/securityclaw",
      "/Users/test/other-plugin",
    ],
    watch: true,
  });
});
