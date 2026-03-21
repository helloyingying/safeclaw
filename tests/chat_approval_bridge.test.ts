import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { SecurityClawLocale } from "../src/i18n/locale.ts";

import plugin, { __setOpenClawReplyChunkHelpersForTests } from "../index.ts";
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
) => Promise<{ cancel?: boolean; content?: string } | undefined> | { cancel?: boolean; content?: string } | undefined;
type GatewayStopHook = (event?: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown;
type BeforePromptBuildHook = (
  event: { prompt?: string; messages?: unknown[] },
  ctx: { agentId?: string; sessionKey?: string; sessionId?: string; runId?: string; workspaceDir?: string; channelId?: string },
) => Promise<{ prependSystemContext?: string } | undefined>;

type ReplyChunkTestHelpers = {
  enqueueSystemEvent: (text: string, options?: { sessionKey?: string; contextKey?: string }) => boolean;
};

const require = createRequire(import.meta.url);
let replyChunkTestHelpersPromise: Promise<ReplyChunkTestHelpers> | undefined;

function extractApprovalId(value: unknown): string | undefined {
  return String(value).match(/(?:approval_id=|(?:Request ID|审批单): )([a-f0-9-]+)/i)?.[1];
}

function resolveOpenClawReplyChunkFile(): string {
  const distDir = path.dirname(require.resolve("openclaw"));
  const filename = readdirSync(distDir)
    .filter((entry) => entry.startsWith("reply-") && entry.endsWith(".js"))
    .sort()[0];
  assert.ok(filename, "missing openclaw reply chunk");
  return path.join(distDir, filename);
}

function readOpenClawExportAlias(source: string, symbol: string): string | undefined {
  return source.match(new RegExp(`\\b${escapeRegExp(symbol)}\\s+as\\s+([A-Za-z_$][\\w$]*)\\b`))?.[1];
}

async function loadReplyChunkTestHelpers(): Promise<ReplyChunkTestHelpers> {
  if (!replyChunkTestHelpersPromise) {
    replyChunkTestHelpersPromise = (async () => {
      const replyChunkFile = resolveOpenClawReplyChunkFile();
      const source = readFileSync(replyChunkFile, "utf8");
      const enqueueSystemEventAlias = readOpenClawExportAlias(source, "enqueueSystemEvent");
      assert.ok(enqueueSystemEventAlias, "missing enqueueSystemEvent export alias");
      const replyChunk = await import(pathToFileURL(replyChunkFile).href) as Record<string, unknown>;
      const enqueueSystemEvent = replyChunk[enqueueSystemEventAlias];
      assert.equal(typeof enqueueSystemEvent, "function");
      return {
        enqueueSystemEvent: enqueueSystemEvent as ReplyChunkTestHelpers["enqueueSystemEvent"],
      };
    })();
  }

  return replyChunkTestHelpersPromise;
}

async function enqueueReplySystemEvent(
  text: string,
  options: { sessionKey: string; contextKey?: string },
): Promise<void> {
  const helpers = await loadReplyChunkTestHelpers();
  helpers.enqueueSystemEvent(text, options);
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
          messageActions: {
            async handleAction(ctx: {
              action: string;
              params: Record<string, unknown>;
            }) {
              if (ctx.action !== "send") {
                throw new Error(`unsupported discord action in test harness: ${ctx.action}`);
              }
              const to = String(ctx.params.to ?? "");
              const text = String(ctx.params.message ?? "");
              const opts: Record<string, unknown> = {};
              if (ctx.params.accountId !== undefined) {
                opts.accountId = ctx.params.accountId;
              }
              if (ctx.params.components !== undefined) {
                opts.components = ctx.params.components;
              }
              sentMessages.push({
                to,
                text,
                ...(Object.keys(opts).length > 0 ? { opts } : {}),
              });
              return {
                ok: true,
                result: { messageId: `dc-${sentMessages.length}`, channelId: to },
                components: ctx.params.components !== undefined,
              };
            },
          },
          async sendMessageDiscord(to: string, text: string, opts?: Record<string, unknown>) {
            sentMessages.push({
              to,
              text,
              ...(opts !== undefined ? { opts } : {}),
            });
            return { messageId: `dc-${sentMessages.length}`, channelId: to };
          },
        },
        slack: {
          async sendMessageSlack(to: string, text: string, opts?: Record<string, unknown>) {
            sentMessages.push({
              to,
              text,
              ...(opts !== undefined ? { opts } : {}),
            });
            return { messageId: `sl-${sentMessages.length}`, channelId: to };
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

test("chat approval bridge normalizes discord admin dm targets before sending approval prompts", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-discord-admin-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "discord:1484822413131911189");

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
        sessionId: "session-discord-admin",
        sessionKey: "telegram:chat-discord-admin",
        runId: "run-discord-admin",
        workspaceDir: "/tmp/workspace",
        channelId: "telegram",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.to, "user:1484822413131911189");
    assert.notEqual(harness.sentMessages[0]?.opts?.components, undefined);
    assert.equal((harness.sentMessages[0]?.opts?.components as { reusable?: boolean } | undefined)?.reusable, true);
    assert.equal(harness.sentMessages[0]?.opts?.buttons, undefined);

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

test("chat approval bridge stays disabled on non-button admin channels", async () => {
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
    assert.match(String(blocked?.blockReason), /(No approval-capable admin account is configured yet|还没有可审批的管理员账号)/);
    assert.equal(extractApprovalId(blocked?.blockReason), undefined);

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
    assert.match(String(pendingReply.text), /(approval bridge is not enabled|审批桥接未启用)/);

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

    assert.deepEqual(approved?.block, true);
    assert.equal(harness.sentMessages.length, 0);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge sends Discord DM approvals with user-prefixed targets", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-discord-dm-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "discord:1087701739362328666");

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
        sessionId: "session-discord-1",
        sessionKey: "discord:1087701739362328666",
        runId: "run-discord-1",
        workspaceDir: "/tmp/workspace",
        channelId: "discord",
      },
    );

    assert.deepEqual(blocked?.block, true);
    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].to, "user:1087701739362328666");
    assert.match(String(harness.sentMessages[0].text), /(SecurityClaw Approval|SecurityClaw 审批请求)/);
    assert.notEqual(harness.sentMessages[0].opts?.components, undefined);
    assert.equal((harness.sentMessages[0].opts?.components as { reusable?: boolean } | undefined)?.reusable, true);
    assert.equal(harness.sentMessages[0].opts?.buttons, undefined);

    const approveCommand = harness.commands.get("securityclaw-approve");
    assert.ok(approveCommand);
    const approveReply = await approveCommand!.handler({
      channel: "discord",
      senderId: "1087701739362328666",
      from: "discord:1087701739362328666",
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
        sessionId: "session-discord-2",
        sessionKey: "discord:1087701739362328666",
        runId: "run-discord-2",
        workspaceDir: "/tmp/workspace",
        channelId: "discord",
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

test("chat approval bridge accepts discord button click messages", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-discord-click-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "discord:1087701739362328666");

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    const messageReceived = harness.hooks.get("message_received") as MessageReceivedHook | undefined;
    assert.ok(beforeToolCall);
    assert.ok(messageReceived);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-discord-click-1",
        sessionKey: "discord:1087701739362328666",
        runId: "run-discord-click-1",
        workspaceDir: "/tmp/workspace",
        channelId: "discord",
      },
    );

    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);

    await messageReceived(
      {
        from: "discord:1087701739362328666",
        content: `Clicked "Approve 10m · sc-approve ${approvalId}".`,
        metadata: {
          senderId: "1087701739362328666",
        },
      },
      {
        channelId: "discord",
        conversationId: "discord:1087701739362328666",
      },
    );

    const approved = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/after-click" },
      },
      {
        agentId: "main",
        sessionId: "session-discord-click-2",
        sessionKey: "discord:1087701739362328666",
        runId: "run-discord-click-2",
        workspaceDir: "/tmp/workspace",
        channelId: "discord",
      },
    );

    assert.equal(approved, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge routes workspace discord approval buttons through gateway runMessageAction", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-discord-run-message-action-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");
  const messageActionCalls: Array<{
    cfg: unknown;
    action: string;
    params: Record<string, unknown>;
    defaultAccountId?: string;
  }> = [];

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "discord:1087701739362328666");

    __setOpenClawReplyChunkHelpersForTests({
      runMessageAction: async (input) => {
        messageActionCalls.push(input);
        return { result: { messageId: "discord-run-message-action-approval-message" } };
      },
      peekSystemEventEntries: () => [],
    });

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    harness.api.source = "workspace";
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
        sessionId: "session-discord-run-message-action-1",
        sessionKey: "discord:1087701739362328666",
        runId: "run-discord-run-message-action-1",
        workspaceDir: "/tmp/workspace",
        channelId: "discord",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(messageActionCalls.length, 1);
    assert.equal(messageActionCalls[0]?.action, "send");
    const params = messageActionCalls[0]?.params as Record<string, unknown> | undefined;
    assert.ok(params);
    assert.equal(params.channel, "discord");
    assert.equal(params.to, "user:1087701739362328666");
    assert.match(String(params.message), /(SecurityClaw Approval|SecurityClaw 审批请求)/);
    assert.equal((params.components as { reusable?: boolean } | undefined)?.reusable, true);
    assert.equal(params.accountId, undefined);
  } finally {
    __setOpenClawReplyChunkHelpersForTests(undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge guides bare numeric replies on discord and cancels the downstream agent reply", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-discord-guidance-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "discord:1087701739362328666");

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
        sessionId: "session-discord-guidance-1",
        sessionKey: "discord:1087701739362328666",
        runId: "run-discord-guidance-1",
        workspaceDir: "/tmp/workspace",
        channelId: "discord",
      },
    );

    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);
    assert.equal(harness.sentMessages.length, 1);

    await messageReceived(
      {
        from: "discord:1087701739362328666",
        content: "1",
        metadata: {
          senderId: "1087701739362328666",
        },
      },
      {
        channelId: "discord",
        conversationId: "discord:1087701739362328666",
      },
    );

    assert.equal(harness.sentMessages.length, 2);
    assert.match(
      String(harness.sentMessages[1]?.text),
      /(请点审批消息里的按钮；不要单独发送 1、2、3。|Use the buttons on the approval message; do not send 1, 2, or 3 by itself\.)/,
    );

    const sendingResult = await messageSending(
      {
        content: "还是同一个问题",
      },
      {
        channelId: "discord",
        conversationId: "discord:1087701739362328666",
      },
    );
    assert.deepEqual(sendingResult, { cancel: true });

    const store = new ChatApprovalStore(dbPath);
    try {
      assert.equal(store.getById(approvalId)?.status, "pending");
    } finally {
      store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge sends slack approvals with button blocks", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-slack-send-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "slack:U024BE7LH");

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
        sessionId: "session-slack-send-1",
        sessionKey: "slack:U024BE7LH",
        runId: "run-slack-send-1",
        workspaceDir: "/tmp/workspace",
        channelId: "slack",
      },
    );

    assert.deepEqual(blocked?.block, true);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.to, "U024BE7LH");
    assert.ok(Array.isArray(harness.sentMessages[0]?.opts?.blocks));
    assert.match(JSON.stringify(harness.sentMessages[0]?.opts?.blocks), /(Approve|批准)/);
    assert.match(JSON.stringify(harness.sentMessages[0]?.opts?.blocks), /(Reject|拒绝)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge applies slack button interactions from buffered system events", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-slack-click-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "slack:U024BE7LH");

    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook | undefined;
    assert.ok(beforeToolCall);
    assert.ok(beforePromptBuild);

    const blocked = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "Downloads" },
      },
      {
        agentId: "main",
        sessionId: "session-slack-click-1",
        sessionKey: "slack:U024BE7LH",
        runId: "run-slack-click-1",
        workspaceDir: "/tmp/workspace",
        channelId: "slack",
      },
    );

    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);

    await enqueueReplySystemEvent(
      `Slack interaction: ${JSON.stringify({
        interactionType: "block_action",
        actionId: "openclaw:securityclaw:approval",
        userId: "U024BE7LH",
        value: `sc-approve ${approvalId}`,
      })}`,
      { sessionKey: "slack:U024BE7LH" },
    );

    await beforePromptBuild(
      {
        prompt: "continue",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-slack-click-1",
        sessionKey: "slack:U024BE7LH",
        runId: "run-slack-click-2",
        workspaceDir: "/tmp/workspace",
        channelId: "slack",
      },
    );

    const approved = await beforeToolCall(
      {
        toolName: "filesystem.list",
        params: { path: "/tmp/workspace/Downloads/after-slack-click" },
      },
      {
        agentId: "main",
        sessionId: "session-slack-click-2",
        sessionKey: "slack:U024BE7LH",
        runId: "run-slack-click-3",
        workspaceDir: "/tmp/workspace",
        channelId: "slack",
      },
    );

    assert.equal(approved, undefined);
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
    const buttons = harness.sentMessages[0]?.opts?.buttons as Array<Array<{ text: string }>> | undefined;
    assert.match(String(buttons?.[0]?.[0]?.text), /^批准/);
    assert.match(String(buttons?.[0]?.[1]?.text), /^批准/);
    assert.match(String(buttons?.[1]?.[0]?.text), /^拒绝$/);

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
    assert.doesNotMatch(harness.sentMessages[0].text, /(How to respond|处理方式)/);
    const buttons = harness.sentMessages[0].opts?.buttons as Array<Array<{ text: string }>> | undefined;
    assert.match(String(buttons?.[0]?.[0]?.text), /(Approve 10m|批准 10分钟)/);
    assert.match(String(buttons?.[0]?.[1]?.text), /(Approve 30d|批准 30天)/);
    assert.match(String(buttons?.[1]?.[0]?.text), /^(Reject|拒绝)$/);

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

test("chat approval bridge never auto-approves numeric replies", async () => {
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
    const approvalId = extractApprovalId(blocked?.blockReason);
    assert.ok(approvalId);

    await messageReceived!(
      {
        from: "telegram:secops-admin",
        content: "1",
        metadata: {
          senderId: "secops-admin",
          replyToMessageId: "tg-1",
        },
      },
      {
        channelId: "telegram",
        conversationId: "telegram:secops-admin",
      },
    );

    assert.equal(harness.sentMessages.length, 2);
    assert.match(
      String(harness.sentMessages[1]?.text),
      /(请点审批消息里的按钮；不要单独发送 1、2、3。|Use the buttons on the approval message; do not send 1, 2, or 3 by itself\.)/,
    );

    const sendingResult = await messageSending(
      {
        content: "数字单飞，语义坠毁。",
      },
      {
        channelId: "telegram",
        conversationId: "telegram:secops-admin",
      },
    );
    assert.deepEqual(sendingResult, { cancel: true });
    const store = new ChatApprovalStore(dbPath);
    try {
      assert.equal(store.getById(approvalId)?.status, "pending");
    } finally {
      store.close();
    }

    const stillBlocked = await beforeToolCall(
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

    assert.deepEqual(stillBlocked?.block, true);

    const gatewayStop = harness.hooks.get("gateway_stop") as GatewayStopHook | undefined;
    if (gatewayStop) {
      await gatewayStop({}, {});
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chat approval bridge ignores numeric replies on unsupported channels", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-feishu-reply-"));
  const configPath = path.join(tempDir, "policy.default.yaml");
  const dbPath = path.join(tempDir, "securityclaw.db");
  const statusPath = path.join(tempDir, "securityclaw-status.json");

  try {
    copyFileSync("./config/policy.default.yaml", configPath);
    seedAdminAccountPolicy(dbPath, "feishu:ou_20d3dfae71b68bb041bff70111fd3fb1");
    const harness = createPluginApiHarness({ configPath, dbPath, statusPath });
    await plugin.register(harness.api);

    const beforeToolCall = harness.hooks.get("before_tool_call") as BeforeToolCallHook | undefined;
    const messageReceived = harness.hooks.get("message_received") as MessageReceivedHook | undefined;
    assert.ok(beforeToolCall);
    assert.ok(messageReceived);

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
    assert.equal(extractApprovalId(blocked?.blockReason), undefined);
    assert.equal(harness.sentMessages.length, 0);

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
      assert.deepEqual(store.listPending(10), []);
    } finally {
      store.close();
    }

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

    const approvalStore = new ChatApprovalStore(dbPath, { now: () => nowMs });
    const pendingAfterFirst = approvalStore.listPending(1)[0];
    assert.ok(pendingAfterFirst);
    const firstApprovalId = pendingAfterFirst.approval_id;
    approvalStore.close();

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

    const refreshedStore = new ChatApprovalStore(dbPath, { now: () => nowMs });
    const firstApprovalAfterResend = refreshedStore.getById(firstApprovalId);
    assert.equal(firstApprovalAfterResend?.status, "expired");
    const pendingAfterSecond = refreshedStore.listPending(1)[0];
    assert.ok(pendingAfterSecond);
    assert.equal(pendingAfterSecond?.status, "pending");
    assert.notEqual(pendingAfterSecond.approval_id, firstApprovalId);
    refreshedStore.close();
  } finally {
    Date.now = originalNow;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
