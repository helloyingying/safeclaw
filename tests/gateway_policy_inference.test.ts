import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import plugin from "../index.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";

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
  dbPath: string;
  statusPath: string;
}) {
  const hooks = new Map<string, HookHandler>();
  const api = {
    id: "safeclaw",
    name: "SafeClaw Security",
    source: "test",
    config: {},
    pluginConfig: {
      configPath: paths.configPath,
      dbPath: paths.dbPath,
      statusPath: paths.statusPath,
      adminAutoStart: false,
    },
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
          return path.dirname(paths.dbPath);
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

async function createBeforeToolCallHook() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-gateway-inference-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");

  copyFileSync("./config/policy.default.yaml", configPath);
  const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
  await plugin.register(harness.api);

  const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
  assert.ok(beforeToolCall);

  return {
    beforeToolCall,
    dbPath,
    statusPath,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

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
    assert.match(String(blocked?.blockReason), /resource_scope=workspace_outside/);
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
    assert.match(String(blocked?.blockReason), /resource_scope=workspace_outside/);
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

test("gateway maps shell file writes to filesystem.write rules", async () => {
  const harness = await createBeforeToolCallHook();
  try {
    const blocked = await harness.beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "echo secret > ~/Downloads/safeclaw-demo.txt",
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

test("gateway allows configured account in default allow mode without changing rules", async () => {
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
          command: "echo secret > ~/Downloads/safeclaw-demo.txt",
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
