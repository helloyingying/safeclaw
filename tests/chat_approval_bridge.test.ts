import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import plugin from "../index.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";

type RegisteredCommand = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type HookHandler = (...args: unknown[]) => unknown;
type BeforeToolCallHook = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: Record<string, unknown>,
) => Promise<{ block?: boolean; blockReason?: string } | undefined>;
type GatewayStopHook = (event?: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown;

function createPluginApiHarness(paths: {
  configPath: string;
  dbPath: string;
  statusPath: string;
}, options: {
  telegramFailuresBeforeSuccess?: number;
} = {}) {
  const hooks = new Map<string, HookHandler>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: Array<{ to: string; text: string; opts?: Record<string, unknown> }> = [];
  let telegramFailuresRemaining = options.telegramFailuresBeforeSuccess ?? 0;
  let telegramSendAttempts = 0;
  const pluginConfig = {
    configPath: paths.configPath,
    dbPath: paths.dbPath,
    statusPath: paths.statusPath,
    adminAutoStart: false,
  };

  const api = {
    id: "safeclaw",
    name: "SafeClaw Security",
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
          async sendMessageTelegram(to: string, text: string, opts?: Record<string, unknown>) {
            telegramSendAttempts += 1;
            if (telegramFailuresRemaining > 0) {
              telegramFailuresRemaining -= 1;
              throw new Error("simulated telegram send failure");
            }
            sentMessages.push({
              to,
              text,
              ...(opts !== undefined ? { opts } : {}),
            });
            return { messageId: `tg-${sentMessages.length}`, chatId: to };
          },
        },
        discord: {
          async sendMessageDiscord() {
            throw new Error("not implemented");
          },
        },
        slack: {
          async sendMessageSlack() {
            throw new Error("not implemented");
          },
        },
        signal: {
          async sendMessageSignal() {
            throw new Error("not implemented");
          },
        },
        imessage: {
          async sendMessageIMessage() {
            throw new Error("not implemented");
          },
        },
        whatsapp: {
          async sendMessageWhatsApp() {
            throw new Error("not implemented");
          },
        },
        line: {
          async pushMessageLine() {
            throw new Error("not implemented");
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
    registerCommand(command: RegisteredCommand) {
      commands.set(command.name, command);
    },
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on(hookName: string, handler: HookHandler) {
      hooks.set(hookName, handler);
    },
  } as unknown as OpenClawPluginApi;

  return { api, hooks, commands, sentMessages, getTelegramSendAttempts: () => telegramSendAttempts };
}

function seedAdminAccountPolicy(dbPath: string, subject = "telegram:secops-admin"): void {
  const writer = new StrategyStore(dbPath);
  try {
    writer.writeOverride({
      account_policies: [
        {
          subject,
          mode: "apply_rules",
          is_admin: true,
        },
      ],
    });
  } finally {
    writer.close();
  }
}

test("chat approval bridge auto-enables from admin account policies without plugin approval config", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-chat-approval-admin-sync-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const first = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "telegram:chat-42",
        runId: "run-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(first?.block, true);
    const approvalId = String(first?.blockReason).match(/approval_id=([a-f0-9-]+)/i)?.[1];
    assert.ok(approvalId);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].to, "secops-admin");

    const pendingCommand = harness.commands.get("safeclaw-pending");
    assert.ok(pendingCommand);
    const pendingReply = await pendingCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      commandBody: "/safeclaw-pending",
      config: harness.api.config,
    });
    assert.match(String(pendingReply.text), /filesystem\.list/);

    const approveCommand = harness.commands.get("safeclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      args: approvalId,
      commandBody: `/safeclaw-approve ${approvalId}`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /临时授权/);

    const approved = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/after-approve" },
      },
      {
        agentId: "main",
        sessionId: "session-2",
        sessionKey: "telegram:chat-42",
        runId: "run-2",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.equal(approved, undefined);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge supports command-only approvals on non-button channels", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-chat-approval-command-only-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "feishu:secops-admin");

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-feishu-1",
        sessionKey: "feishu:chat-42",
        runId: "run-feishu-1",
        workspaceDir: "/tmp/workspace",
        channelId: "feishu",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(String(blocked?.blockReason), /未配置或未成功发送授权通知/);
    const approvalId = String(blocked?.blockReason).match(/approval_id=([a-f0-9-]+)/i)?.[1];
    assert.ok(approvalId);

    const pendingCommand = harness.commands.get("safeclaw-pending");
    assert.ok(pendingCommand);
    const pendingReply = await pendingCommand!.handler({
      channel: "feishu",
      senderId: "secops-admin",
      from: "feishu:secops-admin",
      isAuthorizedSender: true,
      commandBody: "/safeclaw-pending",
      config: harness.api.config,
    });
    assert.match(String(pendingReply.text), /filesystem\.list/);

    const approveCommand = harness.commands.get("safeclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "feishu",
      senderId: "secops-admin",
      from: "feishu:secops-admin",
      isAuthorizedSender: true,
      args: approvalId,
      commandBody: `/safeclaw-approve ${approvalId}`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /临时授权/);

    const approved = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/after-approve" },
      },
      {
        agentId: "main",
        sessionId: "session-feishu-2",
        sessionKey: "feishu:chat-42",
        runId: "run-feishu-2",
        workspaceDir: "/tmp/workspace",
        channelId: "feishu",
      },
    );

    assert.equal(approved, undefined);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge reuses pending authorization and allows the same subject after approval", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-chat-approval-bridge-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const first = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "telegram:chat-42",
        runId: "run-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(first?.block, true);
    assert.match(String(first?.blockReason), /approval_id=/);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].text, /SafeClaw 授权请求/);
    assert.match(harness.sentMessages[0].text, /待审批截至: .+\(.+\)/);
    assert.match(harness.sentMessages[0].text, /临时授权: .*10分钟/);
    const buttons = harness.sentMessages[0].opts?.buttons as Array<Array<{ text: string }>> | undefined;
    assert.equal(buttons?.[0]?.[0]?.text, "临时批准(10分钟)");
    assert.equal(buttons?.[0]?.[1]?.text, "长期授权(30天)");

    const secondPending = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/another" },
      },
      {
        agentId: "main",
        sessionId: "session-2",
        sessionKey: "telegram:chat-42",
        runId: "run-2",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(secondPending?.block, true);
    assert.equal(harness.sentMessages.length, 1);

    const approvalId = String(first?.blockReason).match(/approval_id=([a-f0-9-]+)/i)?.[1];
    assert.ok(approvalId);

    const pendingCommand = harness.commands.get("safeclaw-pending");
    assert.ok(pendingCommand);
    const pendingReply = await pendingCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      commandBody: "/safeclaw-pending",
      config: harness.api.config,
    });
    assert.match(String(pendingReply.text), /filesystem\.list/);
    assert.match(String(pendingReply.text), /\(.+\)/);

    const approveCommand = harness.commands.get("safeclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      args: approvalId,
      commandBody: `/safeclaw-approve ${approvalId}`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /临时授权/);
    assert.match(String(approveReply.text), /有效期至 .+\(.+\)/);

    const approved = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/third" },
      },
      {
        agentId: "main",
        sessionId: "session-3",
        sessionKey: "telegram:chat-42",
        runId: "run-3",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.equal(approved, undefined);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge supports long-lived subject authorization", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-chat-approval-long-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-03-15T03:00:00.000Z");

  try {
    Date.now = () => nowMs;
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-long-1",
        sessionKey: "telegram:chat-long",
        runId: "run-long-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(blocked?.block, true);
    const approvalId = String(blocked?.blockReason).match(/approval_id=([a-f0-9-]+)/i)?.[1];
    assert.ok(approvalId);

    const approveCommand = harness.commands.get("safeclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      args: `${approvalId} long`,
      commandBody: `/safeclaw-approve ${approvalId} long`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /长期授权/);

    nowMs += 20 * 60 * 1000;

    const allowed = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/future" },
      },
      {
        agentId: "main",
        sessionId: "session-long-2",
        sessionKey: "telegram:chat-long",
        runId: "run-long-2",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.equal(allowed, undefined);
  } finally {
    Date.now = originalNow;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge retries transient telegram send failures", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-chat-approval-retry-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath }, { telegramFailuresBeforeSuccess: 1 });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-retry",
        sessionKey: "telegram:chat-retry",
        runId: "run-retry",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.getTelegramSendAttempts(), 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge re-sends stale pending approvals after cooldown", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-chat-approval-resend-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "safeclaw.db");
  const statusPath = path.join(tempDir, "safeclaw-status.json");
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-03-15T03:00:00.000Z");

  try {
    Date.now = () => nowMs;
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const first = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-resend",
        sessionKey: "telegram:chat-resend",
        runId: "run-resend-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(first?.block, true);
    assert.equal(harness.sentMessages.length, 1);

    nowMs += 61_000;

    const second = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-resend",
        sessionKey: "telegram:chat-resend",
        runId: "run-resend-2",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(second?.block, true);
    assert.equal(harness.sentMessages.length, 2);
  } finally {
    Date.now = originalNow;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
