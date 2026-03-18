import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import plugin from "../index.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";
import { buildStrategyV2FromConfig } from "../src/domain/services/strategy_model.ts";

type RegisteredCommand = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type HookHandler = (...args: unknown[]) => unknown;
type BeforeToolCallHook = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: Record<string, unknown>,
) => Promise<{ block?: boolean; blockReason?: string } | undefined>;
type GatewayStopHook = (event?: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown;

function extractApprovalId(value: unknown): string | undefined {
  return String(value).match(/(?:approval_id=|(?:Request ID|审批单): )([a-f0-9-]+)/i)?.[1];
}

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

function seedWarnDecision(dbPath: string, configPath: string, ruleId = "sensitive-directory-enumeration-challenge"): void {
  const writer = new StrategyStore(dbPath);
  try {
    const current = writer.readOverride() ?? {};
    const base = ConfigManager.fromFile(configPath).getConfig();
    const strategy = buildStrategyV2FromConfig(base);
    for (const capability of strategy.tool_policy.capabilities) {
      for (const rule of capability.rules) {
        if (rule.rule_id === ruleId) {
          rule.decision = "warn";
        }
      }
    }
    writer.writeOverride({
      ...current,
      strategy,
    });
  } finally {
    writer.close();
  }
}

test("chat approval bridge auto-enables from admin account policies without plugin approval config", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-admin-sync-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

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
    const approvalId = extractApprovalId(first?.blockReason);
    assert.ok(approvalId);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].to, "secops-admin");

    const pendingCommand = harness.commands.get("securityclaw-pending");
    assert.ok(pendingCommand);
    const pendingReply = await pendingCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      commandBody: "/securityclaw-pending",
      config: harness.api.config,
    });
    assert.match(String(pendingReply.text), /filesystem\.list/);

    const approveCommand = harness.commands.get("securityclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      args: approvalId,
      commandBody: `/securityclaw-approve ${approvalId}`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /(Temporary grant|临时授权)/);

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

test("concurrent identical approval challenges send one approval notification", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-dedupe-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const event = {
      toolName: "filesystem.list",
      params: { path: "/Users/demo/.ssh" },
    };
    const ctx = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "telegram:chat-42",
      workspaceDir: "/tmp/workspace",
      channelId: "telegram",
    };

    const results = await Promise.all([
      beforeToolCall(event, { ...ctx, runId: "run-1" }),
      beforeToolCall(event, { ...ctx, runId: "run-2" }),
      beforeToolCall(event, { ...ctx, runId: "run-3" }),
      beforeToolCall(event, { ...ctx, runId: "run-4" }),
    ]);

    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.getTelegramSendAttempts(), 1);

    const approvalIds = new Set(results.map((result) => extractApprovalId(result?.blockReason)));
    assert.equal(approvalIds.size, 1);
    assert.ok(approvalIds.has(extractApprovalId(harness.sentMessages[0]?.text)));

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("platform context reads stay local while user-triggered external access still sends one approval", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-context-read-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");
  const workspaceDir = path.join(os.homedir(), ".openclaw", "workspace");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const contextRead = await beforeToolCall(
      {
        toolName: "read",
        params: {
          file_path: path.join(
            os.homedir(),
            ".openclaw",
            "extensions",
            "openclaw-lark",
            "skills",
            "feishu-channel-rules",
            "SKILL.md",
          ),
        },
      },
      {
        agentId: "main",
        sessionId: "session-context-read",
        sessionKey: "telegram:chat-42",
        runId: "run-context-read",
        workspaceDir,
        channelId: "telegram",
      },
    );

    assert.equal(contextRead, undefined);
    assert.equal(harness.sentMessages.length, 0);

    const externalAccess = await beforeToolCall(
      {
        toolName: "exec",
        params: {
          command: "find ~/.ssh -maxdepth 1 -type f -exec basename {} \\; | sort",
          workdir: workspaceDir,
          yieldMs: 1000,
          timeout: 10,
        },
      },
      {
        agentId: "main",
        sessionId: "session-context-read",
        sessionKey: "telegram:chat-42",
        runId: "run-user-request",
        workspaceDir,
        channelId: "telegram",
      },
    );

    assert.deepEqual(externalAccess?.block, true);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.getTelegramSendAttempts(), 1);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge supports command-only approvals on non-button channels", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-command-only-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

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
    assert.match(String(blocked?.blockReason), /(Admin notification failed|通知失败)/);
    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);

    const pendingCommand = harness.commands.get("securityclaw-pending");
    assert.ok(pendingCommand);
    const pendingReply = await pendingCommand!.handler({
      channel: "feishu",
      senderId: "secops-admin",
      from: "feishu:secops-admin",
      isAuthorizedSender: true,
      commandBody: "/securityclaw-pending",
      config: harness.api.config,
    });
    assert.match(String(pendingReply.text), /filesystem\.list/);

    const approveCommand = harness.commands.get("securityclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "feishu",
      senderId: "secops-admin",
      from: "feishu:secops-admin",
      isAuthorizedSender: true,
      args: approvalId,
      commandBody: `/securityclaw-approve ${approvalId}`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /(Temporary grant|临时授权)/);

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

test("warn decisions notify the admin without creating approval buttons", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-warn-notify-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);
    seedWarnDecision(dbPath, configPath);

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const warned = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-warn-1",
        sessionKey: "telegram:chat-42",
        runId: "run-warn-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.equal(warned, undefined);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.to, "secops-admin");
    assert.match(String(harness.sentMessages[0]?.text), /(SecurityClaw Warning|SecurityClaw 风险提醒)/);
    assert.equal(harness.sentMessages[0]?.opts?.buttons, undefined);

    await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-warn-2",
        sessionKey: "telegram:chat-42",
        runId: "run-warn-2",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.equal(harness.sentMessages.length, 1);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge reuses pending authorization and allows the same subject after approval", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-bridge-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

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
    assert.match(String(first?.blockReason), /(Request ID|审批单): [a-f0-9-]+/);
    assert.match(String(first?.blockReason), /(Status|状态): /);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].text, /(SecurityClaw Approval|SecurityClaw 审批请求)/);
    assert.match(harness.sentMessages[0].text, /(Request expires|请求截止): .+\(.+\)/);
    assert.match(harness.sentMessages[0].text, /(Actions|操作)/);
    assert.match(harness.sentMessages[0].text, /\/securityclaw-approve .* long/);
    const buttons = harness.sentMessages[0].opts?.buttons as Array<Array<{ text: string }>> | undefined;
    assert.match(String(buttons?.[0]?.[0]?.text), /(Approve 10m|批准 10分钟)/);
    assert.match(String(buttons?.[0]?.[1]?.text), /(Approve 30d|批准 30天)/);

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

    const approvalId = extractApprovalId(first?.blockReason);
    assert.ok(approvalId);

    const pendingCommand = harness.commands.get("securityclaw-pending");
    assert.ok(pendingCommand);
    const pendingReply = await pendingCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      commandBody: "/securityclaw-pending",
      config: harness.api.config,
    });
    assert.match(String(pendingReply.text), /filesystem\.list/);
    assert.match(String(pendingReply.text), /\(.+\)/);

    const approveCommand = harness.commands.get("securityclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      args: approvalId,
      commandBody: `/securityclaw-approve ${approvalId}`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /(Temporary grant|临时授权)/);
    assert.match(String(approveReply.text), /(expires at|有效期至) .+\(.+\)/);

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
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-long-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");
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
    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);

    const approveCommand = harness.commands.get("securityclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "telegram",
      senderId: "secops-admin",
      from: "telegram:secops-admin",
      isAuthorizedSender: true,
      args: `${approvalId} long`,
      commandBody: `/securityclaw-approve ${approvalId} long`,
      config: harness.api.config,
    });
    assert.match(String(approveReply.text), /(Long-lived grant|长期授权)/);

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
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-retry-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

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
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-resend-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");
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
