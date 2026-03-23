import test from "node:test";
import assert from "node:assert/strict";

import { OpenClawConfigClient } from "../src/admin/openclaw_config_client.ts";
import type { AdminRuntime } from "../src/admin/server_types.ts";

const runtime: AdminRuntime = {
  port: 4780,
  configPath: "/tmp/securityclaw-config.json",
  legacyOverridePath: "/tmp/securityclaw-legacy.json",
  statusPath: "/tmp/securityclaw-status.json",
  dbPath: "/tmp/securityclaw.db",
  openClawHome: "/tmp",
};

test("openclaw config client prefers gateway rpc snapshots when available", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 0,
        stdout: [
          "noise before payload",
          JSON.stringify({
            path: "/tmp/openclaw.json",
            hash: "abc123",
            config: {
              gateway: {
                bind: "loopback",
              },
            },
          }, null, 2),
        ].join("\n"),
      };
    },
    async loadLocalConfig() {
      return {
        gateway: {
          bind: "lan",
        },
      };
    },
  });

  const snapshot = await client.readConfigSnapshot();
  const gateway = snapshot.config.gateway as { bind?: string } | undefined;
  assert.equal(snapshot.source, "gateway-rpc");
  assert.equal(snapshot.gatewayOnline, true);
  assert.equal(snapshot.writeSupported, true);
  assert.equal(snapshot.baseHash, "abc123");
  assert.equal(gateway?.bind, "loopback");
});

test("openclaw config client keeps rpc json when warnings are only on stderr", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 0,
        stdout: JSON.stringify({
          path: "/tmp/openclaw.json",
          hash: "rpc-hash",
          config: {
            gateway: {
              bind: "loopback",
            },
          },
        }, null, 2),
        stderr: [
          "Config warnings:",
          "- plugins.entries.securityclaw: duplicate plugin id detected",
        ].join("\n"),
      };
    },
    async loadLocalConfig() {
      return {
        gateway: {
          bind: "lan",
        },
      };
    },
  });

  const snapshot = await client.readConfigSnapshot({ fast: true });
  const gateway = snapshot.config.gateway as { bind?: string } | undefined;
  assert.equal(snapshot.source, "gateway-rpc");
  assert.equal(snapshot.gatewayOnline, true);
  assert.equal(snapshot.writeSupported, true);
  assert.equal(snapshot.baseHash, "rpc-hash");
  assert.equal(gateway?.bind, "loopback");
});

test("openclaw config client falls back to local config in read-only mode", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 1,
        stdout: "",
        stderr: "gateway unavailable",
      };
    },
    async loadLocalConfig() {
      return {
        gateway: {
          bind: "loopback",
        },
      };
    },
  });

  const snapshot = await client.readConfigSnapshot();
  const gateway = snapshot.config.gateway as { bind?: string } | undefined;
  assert.equal(snapshot.source, "local-file");
  assert.equal(snapshot.gatewayOnline, false);
  assert.equal(snapshot.writeSupported, false);
  assert.match(String(snapshot.writeReason), /read-only fallback/i);
  assert.equal(gateway?.bind, "loopback");
});

test("openclaw config client fast reads keep local findings and trim noisy rpc failures", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 1,
        stdout: [
          "[plugins] securityclaw: loaded policy_version=2026-03-17",
          "[plugins] securityclaw: SecurityClaw admin already running on http://127.0.0.1:4780",
          "Gateway call failed: Error: gateway timeout after 10000ms",
          "Gateway target: ws://127.0.0.1:18789",
          "Source: local loopback",
        ].join("\n"),
        stderr: "",
      };
    },
    async loadLocalConfig() {
      return {
        gateway: {
          bind: "loopback",
        },
      };
    },
  });

  const snapshot = await client.readConfigSnapshot({ fast: true });
  assert.equal(snapshot.source, "local-file");
  assert.equal(snapshot.writeSupported, false);
  assert.match(String(snapshot.writeReason), /gateway timeout/i);
  assert.match(String(snapshot.writeReason), /read-only fallback/i);
});

test("openclaw config client fast reads fall back to local config when rpc reports invalid config", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 0,
        stdout: JSON.stringify({
          path: "/tmp/openclaw.json",
          valid: false,
          hash: "rpc-hash",
          config: {},
          issues: [
            {
              path: "channels.discord.streaming",
              message: "Invalid input",
            },
          ],
        }, null, 2),
      };
    },
    async loadLocalConfig() {
      return {
        channels: {
          discord: {
            enabled: true,
            groupPolicy: "allowlist",
          },
        },
      };
    },
  });

  const snapshot = await client.readConfigSnapshot({ fast: true });
  const channels = snapshot.config.channels as Record<string, unknown> | undefined;
  assert.equal(snapshot.source, "local-file");
  assert.equal(snapshot.gatewayOnline, true);
  assert.equal(snapshot.writeSupported, false);
  assert.match(String(snapshot.writeReason), /gateway config is invalid/i);
  assert.match(String(snapshot.writeReason), /channels\.discord\.streaming/i);
  assert.deepEqual(channels?.discord, {
    enabled: true,
    groupPolicy: "allowlist",
  });
});

test("openclaw config client full reads fall back to local config when rpc reports invalid config", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 0,
        stdout: JSON.stringify({
          path: "/tmp/openclaw.json",
          valid: false,
          hash: "rpc-hash",
          config: {},
          issues: [
            {
              path: "channels.discord.streaming",
              message: "Invalid input",
            },
          ],
        }, null, 2),
      };
    },
    async loadLocalConfig() {
      return {
        gateway: {
          bind: "loopback",
        },
        channels: {
          discord: {
            enabled: true,
          },
        },
      };
    },
  });

  const snapshot = await client.readConfigSnapshot();
  const gateway = snapshot.config.gateway as { bind?: string } | undefined;
  const channels = snapshot.config.channels as Record<string, unknown> | undefined;
  assert.equal(snapshot.source, "local-file");
  assert.equal(snapshot.gatewayOnline, true);
  assert.equal(snapshot.writeSupported, false);
  assert.match(String(snapshot.writeReason), /gateway config is invalid/i);
  assert.equal(gateway?.bind, "loopback");
  assert.deepEqual(channels?.discord, {
    enabled: true,
  });
});

test("openclaw config client requires rpc when writable access is requested", async () => {
  const client = new OpenClawConfigClient(runtime, {
    runCli() {
      return {
        status: 1,
        stdout: "",
        stderr: "gateway unavailable",
      };
    },
    async loadLocalConfig() {
      return {
        gateway: {
          bind: "loopback",
        },
      };
    },
  });

  await assert.rejects(
    client.readConfigSnapshot({ requireWritable: true }),
    /gateway unavailable/i,
  );
});

test("openclaw config client falls back to the resolved cli entry when the openclaw binary is unavailable", async () => {
  const client = new OpenClawConfigClient(runtime, {
    resolveCliEntry() {
      return "/tmp/openclaw.mjs";
    },
  });
  const internalClient = client as unknown as {
    runCli: (args: string[], timeoutMs?: number) => Promise<{
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: unknown;
    }>;
    runCliWithCommand: (command: string, args: string[], timeoutMs: number) => Promise<{
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: unknown;
    }>;
  };
  const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];

  internalClient.runCliWithCommand = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    if (calls.length === 1) {
      const error = Object.assign(new Error("openclaw not found"), { code: "ENOENT" });
      return {
        status: null,
        stdout: "",
        stderr: "",
        error,
      };
    }
    return {
      status: 0,
      stdout: '{"ok":true}',
      stderr: "",
    };
  };

  const result = await internalClient.runCli(["gateway", "status"], 3210);

  assert.deepEqual(calls, [
    {
      command: "openclaw",
      args: ["gateway", "status"],
      timeoutMs: 3210,
    },
    {
      command: process.execPath,
      args: ["/tmp/openclaw.mjs", "gateway", "status"],
      timeoutMs: 3210,
    },
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"ok":true}');
});

test("openclaw config client worker runner captures stdout without child_process in the caller", async () => {
  const client = new OpenClawConfigClient(runtime);
  const internalClient = client as unknown as {
    runCliWithCommand: (command: string, args: string[], timeoutMs: number) => Promise<{
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: unknown;
    }>;
  };

  const result = await internalClient.runCliWithCommand(
    process.execPath,
    ["-e", "process.stdout.write('{\"ok\":true}')"],
    2000,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{\"ok\":true}");
  assert.equal(result.stderr, "");
  assert.equal(result.error, undefined);
});

test("openclaw config client worker runner reports timeouts", async () => {
  const client = new OpenClawConfigClient(runtime);
  const internalClient = client as unknown as {
    runCliWithCommand: (command: string, args: string[], timeoutMs: number) => Promise<{
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: unknown;
    }>;
  };

  const result = await internalClient.runCliWithCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5000)"],
    100,
  );

  assert.equal(result.status, null);
  assert.match(String(result.error), /timed out/i);
});
