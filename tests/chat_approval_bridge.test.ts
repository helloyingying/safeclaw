import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { SecurityClawLocale } from "../src/i18n/locale.ts";

import plugin from "../index.ts";
import { ChatApprovalStore } from "../src/approvals/chat_approval_store.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";
import { buildStrategyV2FromConfig } from "../src/domain/services/strategy_model.ts";

type RegisteredCommand = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type HookHandler = (...args: unknown[]) => unknown;
type BeforeToolCallHook = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: Record<string, unknown>,
) => Promise<{ block?: boolean; blockReason?: string } | undefined>;
type MessageReceivedHook = (
  event: { from: string; content: string; metadata?: Record<string, unknown> },
  ctx: { channelId: string; conversationId?: string; accountId?: string },
) => Promise<unknown> | unknown;
type MessageSendingHook = (
  event: Record<string, unknown>,
  ctx: { channelId: string; conversationId?: string; accountId?: string },
) => Promise<{ cancel?: boolean } | undefined> | { cancel?: boolean } | undefined;
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

function seedAdminAccountPolicy(
  dbPath: string,
  subject = "telegram:secops-admin",
  approvalLocale?: SecurityClawLocale,
): void {
  const writer = new StrategyStore(dbPath);
  try {
    writer.writeOverride({
      account_policies: [
        {
          subject,
          mode: "apply_rules",
          is_admin: true,
          ...(approvalLocale ? { approval_locale: approvalLocale } : {}),
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

type GatewayHookContextInput = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  workspaceDir: string;
  channelId: string;
};

type ChallengeRuleChainScenario = {
  ruleId: string;
  event: {
    toolName: string;
    params: Record<string, unknown>;
  };
  contextOverrides?: Partial<GatewayHookContextInput>;
};

const CHALLENGE_RULE_CHAIN_SCENARIOS: ChallengeRuleChainScenario[] = [
  {
    ruleId: "sensitive-directory-enumeration-challenge",
    event: {
      toolName: "filesystem.search",
      params: {
        path: "/Users/liuzhuangm4/Downloads",
        query: "invoice",
      },
    },
  },
  {
    ruleId: "credential-path-access-challenge",
    event: {
      toolName: "filesystem.read",
      params: {
        path: "/Users/liuzhuangm4/.ssh/id_rsa",
      },
    },
  },
  {
    ruleId: "communication-store-access-challenge",
    event: {
      toolName: "filesystem.read",
      params: {
        path: "/Users/liuzhuangm4/Library/Messages/chat.db",
      },
    },
  },
  {
    ruleId: "public-network-egress-challenge",
    event: {
      toolName: "network.http",
      params: {
        url: "https://api.example.com/v1/events",
      },
    },
  },
  {
    ruleId: "sensitive-archive-challenge",
    event: {
      toolName: "archive.create",
      params: {
        sourcePath: "/tmp/workspace/reports/customer-list.csv",
        targetPath: "/tmp/workspace/reports/customer-list.zip",
        note: "customer export package",
      },
    },
  },
  {
    ruleId: "critical-control-plane-change-challenge",
    event: {
      toolName: "filesystem.write",
      params: {
        path: "/tmp/workspace/.github/workflows/deploy.yml",
        content: "name: deploy",
      },
    },
    contextOverrides: {
      workspaceDir: "/tmp/workspace",
    },
  },
  {
    ruleId: "email-content-access-challenge",
    event: {
      toolName: "email.read",
      params: {
        folder: "inbox",
        query: "subject:invoice",
      },
    },
  },
  {
    ruleId: "sms-content-access-challenge",
    event: {
      toolName: "messages.read",
      params: {
        body: "帮我看一下昨天的短信记录",
      },
    },
  },
  {
    ruleId: "album-sensitive-read-challenge",
    event: {
      toolName: "album.read",
      params: {
        description: "screenshot of internal console",
      },
    },
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createGatewayHookContext(
  scenarioId: string,
  phase: string,
  overrides: Partial<GatewayHookContextInput> = {},
): GatewayHookContextInput {
  const normalizedId = scenarioId.replace(/[^a-z0-9-]/gi, "-");
  return {
    agentId: "main",
    sessionId: `session-${normalizedId}-${phase}`,
    sessionKey: `telegram:chat-${normalizedId}`,
    runId: `run-${normalizedId}-${phase}`,
    workspaceDir: "/tmp/workspace",
    channelId: "telegram",
    ...overrides,
  };
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

test("chat approval bridge localizes approval prompts with the admin approval language", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-locale-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "telegram:secops-admin", "zh-CN");

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    assert.ok(beforeToolCall);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/Users/demo/.ssh" },
      },
      {
        agentId: "main",
        sessionId: "session-locale-1",
        sessionKey: "telegram:chat-locale",
        runId: "run-locale-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(String(harness.sentMessages[0]?.text), /SecurityClaw 审批请求/);
    assert.match(String(harness.sentMessages[0]?.text), /谁: telegram:chat-locale/);
    assert.match(String(harness.sentMessages[0]?.text), /通道: telegram/);
    assert.match(String(harness.sentMessages[0]?.text), /权限: filesystem\.list · /);
    assert.match(String(harness.sentMessages[0]?.text), /可直接点击下方按钮；也可以在只有一条待审批时回复 1、2 或 3。/);
    const buttons = harness.sentMessages[0]?.opts?.buttons as Array<Array<{ text: string }>> | undefined;
    assert.match(String(buttons?.[0]?.[0]?.text), /1\. 批准/);
    assert.match(String(buttons?.[0]?.[1]?.text), /2\. 批准/);
    assert.match(String(buttons?.[1]?.[0]?.text), /3\. 拒绝/);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("challenge policy matrix runs full approval flow for every challenge rule", async (t) => {
  const config = ConfigManager.fromFile("./config/policy.default.yaml").getConfig();
  const challengePolicies = config.policies
    .filter((policy) => policy.enabled && policy.decision === "challenge");
  const expectedRuleIds = challengePolicies.map((policy) => policy.rule_id).sort();
  const scenarioRuleIds = CHALLENGE_RULE_CHAIN_SCENARIOS.map((scenario) => scenario.ruleId).sort();
  assert.deepEqual(
    scenarioRuleIds,
    expectedRuleIds,
    "Challenge matrix must cover every enabled challenge rule",
  );

  const challengePolicyMap = new Map(challengePolicies.map((policy) => [policy.rule_id, policy]));

  for (const scenario of CHALLENGE_RULE_CHAIN_SCENARIOS) {
    await t.test(scenario.ruleId, async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), `securityclaw-chat-challenge-matrix-${scenario.ruleId}-`));
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

        const blocked = await beforeToolCall(
          scenario.event,
          createGatewayHookContext(scenario.ruleId, "blocked", scenario.contextOverrides),
        );

        assert.deepEqual(blocked?.block, true);
        const policy = challengePolicyMap.get(scenario.ruleId);
        assert.ok(policy);
        for (const reasonCode of policy.reason_codes) {
          assert.match(String(blocked?.blockReason), new RegExp(escapeRegExp(reasonCode)));
        }
        const approvalId = extractApprovalId(blocked?.blockReason);
        assert.ok(approvalId);

        assert.equal(harness.sentMessages.length, 1);
        assert.equal(harness.sentMessages[0]?.to, "secops-admin");
        assert.match(String(harness.sentMessages[0]?.text), /(SecurityClaw Approval|SecurityClaw 审批请求)/);
        assert.match(String(harness.sentMessages[0]?.text), new RegExp(escapeRegExp(scenario.ruleId)));
        const buttons = harness.sentMessages[0]?.opts?.buttons as Array<Array<{ text: string }>> | undefined;
        assert.ok(buttons?.length);

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
          scenario.event,
          createGatewayHookContext(scenario.ruleId, "approved", scenario.contextOverrides),
        );

        assert.equal(approved, undefined);
        assert.equal(harness.sentMessages.length, 1);

        const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
        if (gatewayStop) {
          await gatewayStop({}, {});
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
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
    assert.match(harness.sentMessages[0].text, /(Who|谁): telegram:chat-42/);
    assert.match(harness.sentMessages[0].text, /(Channel|通道): telegram/);
    assert.match(harness.sentMessages[0].text, /(Permission|权限): filesystem\.list · /);
    assert.match(harness.sentMessages[0].text, /(Request expires|请求截止): .+\(.+\)/);
    assert.match(harness.sentMessages[0].text, /(Options|选项)/);
    assert.match(harness.sentMessages[0].text, /(reply with 1, 2, or 3|回复 1、2 或 3)/);
    const buttons = harness.sentMessages[0].opts?.buttons as Array<Array<{ text: string }>> | undefined;
    assert.match(String(buttons?.[0]?.[0]?.text), /(1\. Approve 10m|1\. 批准 10分钟)/);
    assert.match(String(buttons?.[0]?.[1]?.text), /(2\. Approve 30d|2\. 批准 30天)/);
    assert.match(String(buttons?.[1]?.[0]?.text), /(3\. Reject|3\. 拒绝)/);

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
    assert.match(String(pendingReply.text), /1\. [a-f0-9-]+ \| telegram:chat-42 \| telegram \| filesystem\.list/);

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

test("chat approval bridge supports numeric replies for a single pending request", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-numeric-reply-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath);
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    const messageReceived = harness.hooks.get("message_received") as MessageReceivedHook | undefined;
    const messageSending = harness.hooks.get("message_sending") as MessageSendingHook | undefined;
    assert.ok(beforeToolCall);
    assert.ok(messageReceived);
    assert.ok(messageSending);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-numeric-1",
        sessionKey: "telegram:chat-numeric",
        runId: "run-numeric-1",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 1);

    await messageReceived!(
      {
        from: "telegram:secops-admin",
        content: "1",
        metadata: {
          senderId: "secops-admin",
        },
      },
      {
        channelId: "telegram",
        conversationId: "secops-admin",
      },
    );

    assert.equal(harness.sentMessages.length, 2);
    assert.equal(harness.sentMessages[1]?.to, "secops-admin");
    assert.match(String(harness.sentMessages[1]?.text), /(Temporary grant|临时授权)/);

    const sendingDecision = await messageSending!({}, {
      channelId: "telegram",
      conversationId: "secops-admin",
    });
    assert.deepEqual(sendingDecision, { cancel: true });

    const approved = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/after-numeric-reply" },
      },
      {
        agentId: "main",
        sessionId: "session-numeric-2",
        sessionKey: "telegram:chat-numeric",
        runId: "run-numeric-2",
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

test("chat approval bridge accepts numeric replies from feishu direct conversation ids", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-feishu-reply-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/open-apis/im/v1/messages")) {
        return new Response(
          JSON.stringify({ code: 0, data: { message_id: `om_${Date.now()}` } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "feishu:ou_20d3dfae71b68bb041bff70111fd3fb1");
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    harness.api.config = {
      channels: {
        feishu: {
          appId: "cli_test_app",
          appSecret: "test-secret",
          domain: "feishu",
        },
      },
    };
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    const messageReceived = harness.hooks.get("message_received") as MessageReceivedHook | undefined;
    const messageSending = harness.hooks.get("message_sending") as MessageSendingHook | undefined;
    assert.ok(beforeToolCall);
    assert.ok(messageReceived);
    assert.ok(messageSending);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.search",
        params: { path: "/Users/demo/.ssh", query: "id_rsa" },
      },
      {
        agentId: "main",
        sessionId: "session-feishu-reply-1",
        sessionKey: "feishu:ou_20d3dfae71b68bb041bff70111fd3fb1",
        runId: "run-feishu-reply-1",
        workspaceDir: "/tmp/workspace",
        channelId: "feishu",
      },
    );

    assert.deepEqual(blocked?.block, true);
    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);

    await messageReceived!(
      {
        from: "feishu:ou_20d3dfae71b68bb041bff70111fd3fb1",
        content: "1",
        metadata: {
          senderId: "ou_20d3dfae71b68bb041bff70111fd3fb1",
        },
      },
      {
        channelId: "feishu",
        conversationId: "user:ou_20d3dfae71b68bb041bff70111fd3fb1",
      },
    );

    const store = new ChatApprovalStore(dbPath);
    try {
      assert.equal(store.getById(approvalId)?.status, "approved");
    } finally {
      store.close();
    }

    const sendingDecision = await messageSending!(
      {
        to: "user:ou_20d3dfae71b68bb041bff70111fd3fb1",
        content: "This reply should be suppressed.",
      },
      {
        channelId: "feishu",
      },
    );
    assert.deepEqual(sendingDecision, { cancel: true });

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    globalThis.fetch = originalFetch;
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
