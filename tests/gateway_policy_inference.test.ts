import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import plugin from "../index.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";
import { buildStrategyV2FromConfig } from "../src/domain/services/strategy_model.ts";
import { resolveDefaultSecurityClawDbPath } from "../src/infrastructure/config/plugin_config_parser.ts";

type HookHandler = (...args: unknown[]) => unknown;
type BeforeToolCallHook = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: Record<string, unknown>,
) => Promise<{ block?: boolean; blockReason?: string } | undefined>;

const DEFAULT_GATEWAY_CTX = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "telegram:chat-42",
  runId: "run-1",
  workspaceDir: "/tmp/workspace",
  channelId: "telegram",
};

function createPluginApiHarness(paths: {
  configPath: string;
  dbPath?: string;
  statusPath?: string;
  stateDir?: string;
}) {
  const hooks = new Map<string, HookHandler>();
  const pluginConfig = {
    configPath: paths.configPath,
    ...(paths.dbPath !== undefined ? { dbPath: paths.dbPath } : {}),
    ...(paths.statusPath !== undefined ? { statusPath: paths.statusPath } : {}),
    adminAutoStart: false,
  };
  const api = {
    id: "securityclaw",
    name: "SecurityClaw Security",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {
      version: "test",
      config: {
        loadConfig() {
          return {};
        },
        writeConfigFile() {},
      },
      system: {
        enqueueSystemEvent() {},
        requestHeartbeatNow() {},
        runCommandWithTimeout() {
          throw new Error("not implemented");
        },
        formatNativeDependencyHint() {
          return "";
        },
      },
      media: {
        loadWebMedia() {
          throw new Error("not implemented");
        },
        detectMime() {
          return "";
        },
        mediaKindFromMime() {
          return "file";
        },
        isVoiceCompatibleAudio() {
          return false;
        },
        getImageMetadata() {
          throw new Error("not implemented");
        },
        resizeToJpeg() {
          throw new Error("not implemented");
        },
      },
      tts: {
        textToSpeechTelephony() {
          throw new Error("not implemented");
        },
      },
      stt: {
        transcribeAudioFile() {
          throw new Error("not implemented");
        },
      },
      tools: {
        createMemoryGetTool() {
          throw new Error("not implemented");
        },
        createMemorySearchTool() {
          throw new Error("not implemented");
        },
        registerMemoryCli() {},
      },
      events: {
        onAgentEvent() {},
        onSessionTranscriptUpdate() {},
      },
      logging: {
        shouldLogVerbose() {
          return false;
        },
        getChildLogger() {
          return {
            info() {},
            warn() {},
            error() {},
          };
        },
      },
      state: {
        resolveStateDir() {
          return paths.stateDir ?? (paths.dbPath ? path.dirname(paths.dbPath) : os.tmpdir());
        },
      },
      modelAuth: {
        async getApiKeyForModel() {
          return {} as never;
        },
        async resolveApiKeyForProvider() {
          return {} as never;
        },
      },
      subagent: {
        async run() {
          return { runId: "subagent-run" };
        },
        async waitForRun() {
          return { status: "ok" as const };
        },
        async getSessionMessages() {
          return { messages: [] };
        },
        async getSession() {
          return { messages: [] };
        },
        async deleteSession() {},
      },
      channel: {
        telegram: {
          async sendMessageTelegram() {
            return {};
          },
        },
        discord: {
          async sendMessageDiscord() {
            return {};
          },
        },
        slack: {
          async sendMessageSlack() {
            return {};
          },
        },
        signal: {
          async sendMessageSignal() {
            return {};
          },
        },
        imessage: {
          async sendMessageIMessage() {
            return {};
          },
        },
        whatsapp: {
          async sendMessageWhatsApp() {
            return {};
          },
        },
        line: {
          async pushMessageLine() {
            return {};
          },
        },
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on(hookName: string, handler: HookHandler) {
      hooks.set(hookName, handler);
    },
  } as unknown as OpenClawPluginApi;

  return { api, hooks };
}

async function createBeforeToolCallHook(options?: { openClawConfig?: unknown }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-gateway-inference-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  copyFileSync("./config/policy.default.yaml", configPath);
  if (options?.openClawConfig !== undefined) {
    writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify(options.openClawConfig, null, 2),
      "utf8",
    );
  }
  const harness = createPluginApiHarness({ configPath, dbPath, statusPath, stateDir: tempDir });
  await plugin.register(harness.api);

  const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
  assert.ok(beforeToolCall);

  return {
    beforeToolCall,
    dbPath,
    statusPath,
    tempDir,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function writeDirectoryOverride(dbPath: string, directory: string, operations: string[] = ["read"]) {
  const writer = new StrategyStore(dbPath);
  try {
    const strategy = buildStrategyV2FromConfig(ConfigManager.fromFile("./config/policy.default.yaml").getConfig());
    strategy.exceptions.directory_overrides = [
      {
        id: "workspace-bootstrap-review",
        directory,
        decision: "challenge",
        operations,
        reason_codes: ["USER_FILE_RULE_CHALLENGE"],
      },
    ];
    writer.writeOverride({
      strategy,
      account_policies: [
        {
          subject: "telegram:chat-42",
          mode: "apply_rules",
          is_admin: true,
        },
      ],
    });
  } finally {
    writer.close();
  }
}

async function createProtectedStorageHook() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-protected-storage-"));
  const stateDir = path.join(tempDir, "openclaw-state");
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = resolveDefaultSecurityClawDbPath(stateDir);

  copyFileSync("./config/policy.default.yaml", configPath);
  const harness = createPluginApiHarness({ configPath, stateDir });
  await plugin.register(harness.api);

  const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
  assert.ok(beforeToolCall);

  return {
    beforeToolCall,
    dbPath,
    stateDir,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("gateway blocks writes to default SecurityClaw sqlite even inside the current workspace", async () => {
  const harness = await createProtectedStorageHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.write",
        params: {
          path: harness.dbPath,
          content: "tamper",
        },
      },
      {
        ...DEFAULT_GATEWAY_CTX,
        workspaceDir: path.dirname(harness.dbPath),
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SECURITYCLAW_STATE_STORAGE_PROTECTED/);
  } finally {
    harness.cleanup();
  }
});

test("gateway blocks shell access to protected SecurityClaw sqlite paths", async () => {
  const harness = await createProtectedStorageHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: `sqlite3 ${JSON.stringify(harness.dbPath)} "DELETE FROM strategy_override"`,
        },
      },
      {
        ...DEFAULT_GATEWAY_CTX,
        workspaceDir: path.dirname(harness.dbPath),
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SECURITYCLAW_STATE_STORAGE_PROTECTED/);
  } finally {
    harness.cleanup();
  }
});

test("gateway classifies messages.read as sms and challenges generic content access", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "messages.read",
        params: { body: "晚点给我回个电话" },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SMS_CONTENT_ACCESS_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway classifies messages.read as sms and blocks OTP access", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "messages.read",
        params: { body: "您的验证码为 123456" },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SMS_OTP_ACCESS_BLOCK/);
  } finally {
    harness.cleanup();
  }
});

test("gateway classifies imsg history shell access as sms and challenges it", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: { command: "imsg history --chat-id 2771 --limit 1 --json" },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SMS_CONTENT_ACCESS_REQUIRES_APPROVAL/);
    assert.match(String(blocked?.blockReason), /workspace_outside/);
  } finally {
    harness.cleanup();
  }
});

test("gateway classifies sqlite access to Messages chat.db and blocks OTP reads", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command:
            "sqlite3 ~/Library/Messages/chat.db \"SELECT message.text FROM message WHERE message.text LIKE '%验证码%'\"",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SMS_OTP_ACCESS_BLOCK/);
    assert.match(String(blocked?.blockReason), /workspace_outside/);
  } finally {
    harness.cleanup();
  }
});

test("gateway maps shell directory enumeration to filesystem.list rules", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "find ~/Downloads -maxdepth 1 -type f -print",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway challenges direct filesystem search in sensitive directories", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.search",
        params: {
          path: "Downloads",
          query: "invoice",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway maps shell search in sensitive directories to approval rules", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "find ~/Downloads -name '*.pdf' -print",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway expands $HOME paths before evaluating shell search rules", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "find \"$HOME/Downloads\" -maxdepth 1 -type f ! -name '.*' -print | sed 's#^.*/##' | head -n 1",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway challenges shell search in personal content directories", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "find \"$HOME/Documents\" -maxdepth 1 -type f ! -name '.*' -print | sed 's#^.*/##' | sed -n '2p'",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /SENSITIVE_DIRECTORY_ENUMERATION_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway challenges filesystem reads from communication stores", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.read",
        params: {
          path: "/Users/liuzhuangm4/Library/Messages/chat.db",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /COMMUNICATION_STORE_ACCESS_REQUIRES_APPROVAL/);
  } finally {
    harness.cleanup();
  }
});

test("gateway blocks filesystem reads of browser secret stores", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.read",
        params: {
          path: "/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /BROWSER_SECRET_ACCESS_BLOCK/);
  } finally {
    harness.cleanup();
  }
});

test("gateway directory overrides can be scoped to read-only access", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const writer = new StrategyStore(harness.dbPath);
    try {
      const strategy = buildStrategyV2FromConfig(ConfigManager.fromFile("./config/policy.default.yaml").getConfig());
      strategy.exceptions.directory_overrides = [
        {
          id: "user-browser-allow",
          directory: "/Users/liuzhuangm4/Library/Application Support/Google/Chrome",
          decision: "allow",
          operations: ["read"],
          reason_codes: ["USER_FILE_RULE_ALLOW"],
        }
      ];
      writer.writeOverride({
        strategy,
        account_policies: [
          {
            subject: "telegram:chat-42",
            mode: "apply_rules",
            is_admin: true,
          },
        ],
      });
    } finally {
      writer.close();
    }

    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.read",
        params: {
          path: "/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.equal(blocked, undefined);

    const stillBlocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.write",
        params: {
          path: "/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies",
          content: "overwrite",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(stillBlocked?.block, true);
  } finally {
    harness.cleanup();
  }
});

test("gateway applies file rules to workspace bootstrap reads", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    writeDirectoryOverride(harness.dbPath, DEFAULT_GATEWAY_CTX.workspaceDir);

    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.read",
        params: {
          path: "SOUL.md",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /USER_FILE_RULE_CHALLENGE/);
  } finally {
    harness.cleanup();
  }
});

test("gateway resolves relative reads against configured default workspace", async () => {
  const workspaceDir = path.join(os.tmpdir(), `securityclaw-relative-workspace-${Date.now()}`);
  const harness = await createBeforeToolCallHook({
    openClawConfig: {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    },
  });
  try {
    writeDirectoryOverride(harness.dbPath, workspaceDir);

    const blocked = await harness.beforeToolCall(
      {
        toolName: "read",
        params: {
          file_path: "SOUL.md",
        },
      },
      {
        ...DEFAULT_GATEWAY_CTX,
        workspaceDir: undefined,
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /USER_FILE_RULE_CHALLENGE/);
  } finally {
    harness.cleanup();
  }
});

test("gateway maps shell file writes to filesystem.write rules", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "echo secret > ~/Downloads/securityclaw-demo.txt",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /OUTSIDE_WRITE_BLOCK/);
  } finally {
    harness.cleanup();
  }
});

test("gateway allows configured admin account in default allow mode without changing rules", async () => {
  const harness = await createBeforeToolCallHook();
  let writer: StrategyStore | undefined;
  try {
    writer = new StrategyStore(harness.dbPath);
    writer.writeOverride({
      account_policies: [
        {
          subject: "telegram:chat-42",
          mode: "default_allow",
          is_admin: true
        }
      ]
    });
    writer.close();
    writer = undefined;

    const blocked = await harness.beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.equal(blocked, undefined);
    const snapshot = JSON.parse(readFileSync(harness.statusPath, "utf8")) as {
      recent_decisions: Array<{ decision_source?: string; reasons?: string[] }>;
    };
    assert.equal(snapshot.recent_decisions[0]?.decision_source, "account");
    assert.deepEqual(snapshot.recent_decisions[0]?.reasons, ["ACCOUNT_DEFAULT_ALLOW"]);
  } finally {
    writer?.close();
    harness.cleanup();
  }
});

test("gateway ignores default allow when no admin account is configured", async () => {
  const harness = await createBeforeToolCallHook();
  let writer: StrategyStore | undefined;
  try {
    writer = new StrategyStore(harness.dbPath);
    writer.writeOverride({
      account_policies: [
        {
          subject: "telegram:chat-42",
          mode: "default_allow",
          is_admin: false
        }
      ]
    });
    writer.close();
    writer = undefined;

    const challenged = await harness.beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(challenged?.block, true);
    assert.match(String(challenged?.blockReason), /SecurityClaw/);
    const snapshot = JSON.parse(readFileSync(harness.statusPath, "utf8")) as {
      recent_decisions: Array<{ decision_source?: string; reasons?: string[] }>;
    };
    assert.notEqual(snapshot.recent_decisions[0]?.decision_source, "account");
  } finally {
    writer?.close();
    harness.cleanup();
  }
});

test("gateway admin account no longer bypasses rules", async () => {
  const harness = await createBeforeToolCallHook();
  let writer: StrategyStore | undefined;
  try {
    writer = new StrategyStore(harness.dbPath);
    writer.writeOverride({
      account_policies: [
        {
          subject: "telegram:chat-42",
          mode: "apply_rules",
          is_admin: true
        }
      ]
    });
    writer.close();
    writer = undefined;

    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "echo secret > ~/Downloads/securityclaw-demo.txt",
        },
      },
      DEFAULT_GATEWAY_CTX,
    );

    assert.deepEqual(blocked?.block, true);
    assert.match(String(blocked?.blockReason), /OUTSIDE_WRITE_BLOCK/);
  } finally {
    writer?.close();
    harness.cleanup();
  }
});
