import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookToolContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult
} from "openclaw/plugin-sdk";

import { ConfigManager } from "./src/config/loader.ts";
import { applyRuntimeOverride, readRuntimeOverride } from "./src/config/runtime_override.ts";
import { DecisionEngine } from "./src/engine/decision_engine.ts";
import { DlpEngine } from "./src/engine/dlp_engine.ts";
import { RiskScorer } from "./src/engine/risk_scorer.ts";
import { RuleEngine } from "./src/engine/rule_engine.ts";
import { EventEmitter, HttpEventSink } from "./src/events/emitter.ts";
import { RuntimeStatusStore } from "./src/monitoring/status_store.ts";
import { startAdminServer } from "./admin/server.ts";
import type {
  DecisionContext,
  DlpFinding,
  RuleMatch,
  SafeClawConfig,
  SecurityDecisionEvent
} from "./src/types.ts";
import { deepClone } from "./src/utils.ts";

type SafeClawPluginConfig = {
  configPath?: string;
  overridePath?: string;
  webhookUrl?: string;
  policyVersion?: string;
  environment?: string;
  approvalTtlSeconds?: number;
  persistMode?: "strict" | "compat";
  decisionLogMaxLength?: number;
  statusPath?: string;
  adminAutoStart?: boolean;
  adminPort?: number;
};

type ResolvedSecurityConfig = {
  config: SafeClawConfig;
  configPath: string;
  overridePath: string;
  overrideLoaded: boolean;
};

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

function resolveScope(ctx: { workspaceDir?: string; channelId?: string }): string {
  if (ctx.workspaceDir) {
    return path.basename(ctx.workspaceDir);
  }
  return ctx.channelId ?? "default";
}

function toSecurityConfig(api: OpenClawPluginApi): ResolvedSecurityConfig {
  const pluginConfig = (api.pluginConfig ?? {}) as SafeClawPluginConfig;
  const configPath = pluginConfig.configPath
    ? path.isAbsolute(pluginConfig.configPath)
      ? pluginConfig.configPath
      : path.resolve(PLUGIN_ROOT, pluginConfig.configPath)
    : path.resolve(PLUGIN_ROOT, "./config/policy.default.yaml");
  const overridePath = pluginConfig.overridePath
    ? path.isAbsolute(pluginConfig.overridePath)
      ? pluginConfig.overridePath
      : path.resolve(PLUGIN_ROOT, pluginConfig.overridePath)
    : path.resolve(PLUGIN_ROOT, "./config/policy.overrides.json");
  const base = ConfigManager.fromFile(configPath).getConfig();
  let overrideLoaded = false;
  let effective = base;
  try {
    const override = readRuntimeOverride(overridePath);
    if (override) {
      overrideLoaded = true;
      effective = applyRuntimeOverride(base, override);
    }
  } catch (error) {
    api.logger.warn?.(`safeclaw: failed to load override file (${String(error)})`);
  }
  return {
    config: {
    ...effective,
    policy_version: pluginConfig.policyVersion ?? effective.policy_version,
    environment: pluginConfig.environment ?? effective.environment,
    defaults: {
      ...effective.defaults,
      approval_ttl_seconds: pluginConfig.approvalTtlSeconds ?? effective.defaults.approval_ttl_seconds,
      persist_mode: pluginConfig.persistMode ?? effective.defaults.persist_mode
    },
    event_sink: {
      ...effective.event_sink,
      webhook_url: pluginConfig.webhookUrl ?? effective.event_sink.webhook_url
    }
    },
    configPath,
    overridePath,
    overrideLoaded
  };
}

function createEventEmitter(config: SafeClawConfig): EventEmitter {
  const sink = config.event_sink.webhook_url
    ? new HttpEventSink(config.event_sink.webhook_url, config.event_sink.timeout_ms)
    : undefined;
  return new EventEmitter(sink, config.event_sink.max_buffer, config.event_sink.retry_limit);
}

function buildDecisionContext(
  config: SafeClawConfig,
  ctx: PluginHookToolContext | PluginHookAgentContext,
  toolName?: string,
  tags: string[] = [],
): DecisionContext {
  const workspace = "workspaceDir" in ctx ? ctx.workspaceDir : undefined;
  const runtimeScope = resolveScope({ workspaceDir: workspace, channelId: "channelId" in ctx ? ctx.channelId : undefined });
  const scope = config.environment || runtimeScope;
  return {
    actor_id: ctx.agentId ?? "unknown-agent",
    scope,
    tool_name: toolName,
    tags,
    security_context: {
      trace_id: ctx.runId ?? ctx.sessionId ?? ctx.sessionKey ?? `trace-${Date.now()}`,
      actor_id: ctx.agentId ?? "unknown-agent",
      workspace: workspace ?? "unknown-workspace",
      policy_version: config.policy_version,
      untrusted: false,
      tags,
      created_at: new Date().toISOString()
    }
  };
}

function findingsToText(findings: DlpFinding[]): string {
  return findings.map((finding) => `${finding.pattern_name}@${finding.path}`).join(", ");
}

function emitEvent(
  emitter: EventEmitter,
  event: SecurityDecisionEvent,
  logger: OpenClawPluginApi["logger"],
): void {
  void emitter.emitSecurityEvent(event).catch((error) => {
    logger.warn?.(`safeclaw: failed to emit event (${String(error)})`);
  });
}

function createEvent(
  traceId: string,
  hook:
    | "before_prompt_build"
    | "before_tool_call"
    | "after_tool_call"
    | "tool_result_persist"
    | "message_sending",
  decision: "allow" | "warn" | "challenge" | "block",
  reasonCodes: string[],
  riskScore: number,
): SecurityDecisionEvent {
  return {
    schema_version: "1.0",
    event_type: "SecurityDecisionEvent",
    trace_id: traceId,
    hook,
    decision,
    reason_codes: reasonCodes,
    risk_score: riskScore,
    latency_ms: 0,
    ts: new Date().toISOString()
  };
}

function sanitizeUnknown<T>(dlpEngine: DlpEngine, value: T): { value: T; findings: DlpFinding[] } {
  const findings = dlpEngine.scan(value);
  if (findings.length === 0) {
    return { value, findings };
  }
  return {
    value: dlpEngine.sanitize(value, findings, "sanitize"),
    findings
  };
}

function summarizeForLog(value: unknown, maxLength: number): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return String(value);
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}...(truncated)`;
  } catch {
    return "[unserializable]";
  }
}

function matchedRuleIds(matches: RuleMatch[]): string {
  if (matches.length === 0) {
    return "-";
  }
  return matches.map((match) => match.rule.rule_id).join(",");
}

function normalizeToolName(rawToolName: string): string {
  const tool = rawToolName.trim().toLowerCase();
  if (tool === "exec" || tool === "shell" || tool === "shell_exec") {
    return "shell.exec";
  }
  if (tool === "fs.list" || tool === "file.list") {
    return "filesystem.list";
  }
  return rawToolName;
}

function formatToolBlockReason(
  toolName: string,
  scope: string,
  traceId: string,
  decision: "challenge" | "block",
  reasonCodes: string[],
  riskScore: number,
  rules: string,
): string {
  const reasons = reasonCodes.join(", ");
  if (decision === "challenge") {
    return `SafeClaw 已拦截敏感调用: ${toolName} (scope=${scope})。原因: ${reasons}。risk=${riskScore} rules=${rules}。请联系管理员审批后重试。trace_id=${traceId}`;
  }
  return `SafeClaw 已阻断敏感调用: ${toolName} (scope=${scope})。原因: ${reasons}。risk=${riskScore} rules=${rules}。如需放行，请联系安全管理员调整策略。trace_id=${traceId}`;
}

const plugin = {
  id: "safeclaw",
  name: "SafeClaw Security",
  description: "Runtime policy enforcement, transcript sanitization, and audit events for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const resolved = toSecurityConfig(api);
    const config = resolved.config;
    const pluginConfig = (api.pluginConfig ?? {}) as SafeClawPluginConfig;
    const adminAutoStart = pluginConfig.adminAutoStart ?? true;
    const decisionLogMaxLength = pluginConfig.decisionLogMaxLength ?? 240;
    const statusPath = pluginConfig.statusPath
      ? path.isAbsolute(pluginConfig.statusPath)
        ? pluginConfig.statusPath
        : path.resolve(PLUGIN_ROOT, pluginConfig.statusPath)
      : path.resolve(PLUGIN_ROOT, "./runtime/safeclaw-status.json");
    const emitter = createEventEmitter(config);
    const ruleEngine = new RuleEngine(config.policies);
    const riskScorer = new RiskScorer(config.risk);
    const decisionEngine = new DecisionEngine(config);
    const dlpEngine = new DlpEngine(config.dlp);
    const statusStore = new RuntimeStatusStore(statusPath);
    statusStore.markBoot({
      environment: config.environment,
      policy_version: config.policy_version,
      policy_count: config.policies.length,
      config_path: resolved.configPath,
      override_path: resolved.overridePath,
      override_loaded: resolved.overrideLoaded
    });
    if (adminAutoStart) {
      void startAdminServer({
        port: pluginConfig.adminPort,
        configPath: resolved.configPath,
        overridePath: resolved.overridePath,
        statusPath,
        logger: {
          info: (message: string) => api.logger.info?.(`safeclaw: ${message}`),
          warn: (message: string) => api.logger.warn?.(`safeclaw: ${message}`)
        }
      }).catch((error) => {
        api.logger.warn?.(`safeclaw: failed to auto-start admin dashboard (${String(error)})`);
      });
    } else {
      api.logger.info?.("safeclaw: admin auto-start disabled by config");
    }

    api.logger.info?.(
      `safeclaw: boot env=${config.environment} policy_version=${config.policy_version} dlp_mode=${config.dlp.on_dlp_hit} rules=${config.policies.length}`,
    );
    if (!config.event_sink.webhook_url) {
      api.logger.info?.("safeclaw: event sink disabled (webhook_url is empty), using logger-only observability");
    }

    api.on(
      "before_prompt_build",
      async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult> => {
        const traceId = ctx.runId ?? ctx.sessionId ?? ctx.sessionKey ?? `trace-${Date.now()}`;
        const scope = resolveScope({ workspaceDir: ctx.workspaceDir, channelId: ctx.channelId });
        const prependSystemContext = [
          "[SafeClaw Security Context]",
          `trace_id=${traceId}`,
          `agent_id=${ctx.agentId ?? "unknown-agent"}`,
          `scope=${scope}`,
          `policy_version=${config.policy_version}`
        ].join("\n");
        emitEvent(
          emitter,
          createEvent(traceId, "before_prompt_build", "allow", ["SECURITY_CONTEXT_INJECTED"], 0),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_prompt_build",
          trace_id: traceId,
          actor: ctx.agentId ?? "unknown-agent",
          scope,
          decision: "allow",
          risk: 0,
          reasons: ["SECURITY_CONTEXT_INJECTED"]
        });
        return { prependSystemContext };
      },
      { priority: 100 },
    );

    api.on(
      "before_tool_call",
      async (
        event: PluginHookBeforeToolCallEvent,
        ctx: PluginHookToolContext,
      ): Promise<PluginHookBeforeToolCallResult | void> => {
        const normalizedToolName = normalizeToolName(event.toolName);
        const decisionContext = buildDecisionContext(config, ctx, normalizedToolName);
        const matches = ruleEngine.match(decisionContext);
        const rules = matchedRuleIds(matches);
        const riskScore = riskScorer.score(decisionContext);
        const outcome = decisionEngine.evaluate(decisionContext, riskScore, matches);
        const traceId = decisionContext.security_context.trace_id;
        const argsSummary = summarizeForLog((event as { arguments?: unknown }).arguments, decisionLogMaxLength);

        const decisionLog = [
          "safeclaw: before_tool_call",
          `trace_id=${traceId}`,
          `actor=${decisionContext.actor_id}`,
          `scope=${decisionContext.scope}`,
          `tool=${normalizedToolName}`,
          `raw_tool=${event.toolName}`,
          `risk=${riskScore}`,
          `decision=${outcome.decision}`,
          `rules=${rules}`,
          `reasons=${outcome.reason_codes.join(",")}`,
          `args=${argsSummary}`
        ].join(" ");

        if (outcome.decision === "allow") {
          api.logger.info?.(decisionLog);
        } else {
          api.logger.warn?.(decisionLog);
        }

        emitEvent(
          emitter,
          createEvent(traceId, "before_tool_call", outcome.decision, outcome.reason_codes, outcome.risk_score),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_tool_call",
          trace_id: traceId,
          actor: decisionContext.actor_id,
          scope: decisionContext.scope,
          tool: normalizedToolName,
          decision: outcome.decision,
          risk: outcome.risk_score,
          reasons: outcome.reason_codes,
          rules
        });

        if (outcome.decision === "block" || outcome.decision === "challenge") {
          return {
            block: true,
            blockReason: formatToolBlockReason(
              event.toolName,
              decisionContext.scope,
              traceId,
              outcome.decision,
              outcome.reason_codes,
              outcome.risk_score,
              rules,
            )
          };
        }

        return undefined;
      },
      { priority: 100 },
    );

    api.on("after_tool_call", async (event, ctx) => {
      const decisionContext = buildDecisionContext(config, ctx, event.toolName);
      const traceId = decisionContext.security_context.trace_id;
      const findings = dlpEngine.scan(event.result);
      const decision =
        findings.length === 0 ? "allow" : config.dlp.on_dlp_hit === "block" ? "block" : "warn";
      if (findings.length > 0) {
        api.logger.warn?.(
          `safeclaw: after_tool_call findings tool=${event.toolName} findings=${findingsToText(findings)}`,
        );
      }
      emitEvent(
        emitter,
        createEvent(
          traceId,
          "after_tool_call",
          decision,
          findings.length > 0 ? ["DLP_HIT"] : ["RESULT_OK"],
          findings.length * 20,
        ),
        api.logger,
      );
      statusStore.recordDecision({
        ts: new Date().toISOString(),
        hook: "after_tool_call",
        trace_id: traceId,
        actor: decisionContext.actor_id,
        scope: decisionContext.scope,
        tool: event.toolName,
        decision,
        risk: findings.length * 20,
        reasons: findings.length > 0 ? ["DLP_HIT"] : ["RESULT_OK"]
      });
    });

    api.on(
      "tool_result_persist",
      (event: PluginHookToolResultPersistEvent): PluginHookToolResultPersistResult | void => {
        const traceId = event.toolCallId ?? event.toolName ?? `trace-${Date.now()}`;
        const sanitized = sanitizeUnknown(dlpEngine, event.message);
        if (sanitized.findings.length === 0) {
          emitEvent(
            emitter,
            createEvent(traceId, "tool_result_persist", "allow", ["PERSIST_OK"], 0),
            api.logger,
          );
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "tool_result_persist",
            trace_id: traceId,
            tool: event.toolName,
            decision: "allow",
            risk: 0,
            reasons: ["PERSIST_OK"]
          });
          return undefined;
        }
        emitEvent(
          emitter,
          createEvent(
            traceId,
            "tool_result_persist",
            config.defaults.persist_mode === "strict" ? "block" : "warn",
            ["PERSIST_SANITIZED"],
            sanitized.findings.length * 25,
          ),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "tool_result_persist",
          trace_id: traceId,
          tool: event.toolName,
          decision: config.defaults.persist_mode === "strict" ? "block" : "warn",
          risk: sanitized.findings.length * 25,
          reasons: ["PERSIST_SANITIZED"]
        });
        api.logger.warn?.(
          `safeclaw: tool_result_persist trace_id=${traceId} tool=${event.toolName} decision=${config.defaults.persist_mode === "strict" ? "block" : "warn"} findings=${findingsToText(sanitized.findings)}`,
        );
        return { message: sanitized.value };
      },
      { priority: 100 },
    );

    api.on(
      "before_message_write",
      (event: PluginHookBeforeMessageWriteEvent) => {
        if (config.defaults.persist_mode !== "strict") {
          return undefined;
        }
        const findings = dlpEngine.scan(event.message);
        if (findings.length === 0) {
          return undefined;
        }
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_message_write",
          trace_id: `before-write-${Date.now()}`,
          decision: "block",
          risk: findings.length * 25,
          reasons: ["PERSIST_BLOCKED_DLP"]
        });
        api.logger.warn?.(
          `safeclaw: before_message_write blocked findings=${findingsToText(findings)}`,
        );
        return { block: true };
      },
      { priority: 100 },
    );

    api.on(
      "message_sending",
      async (event: PluginHookMessageSendingEvent, ctx): Promise<PluginHookMessageSendingResult | void> => {
        const traceId = ctx.conversationId ?? ctx.accountId ?? `trace-${Date.now()}`;
        const sanitized = sanitizeUnknown(dlpEngine, event.content);
        if (sanitized.findings.length === 0) {
          emitEvent(
            emitter,
            createEvent(traceId, "message_sending", "allow", ["MESSAGE_OK"], 0),
            api.logger,
          );
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "message_sending",
            trace_id: traceId,
            decision: "allow",
            risk: 0,
            reasons: ["MESSAGE_OK"]
          });
          return undefined;
        }
        const decision = config.dlp.on_dlp_hit === "block" ? "block" : "warn";
        emitEvent(
          emitter,
          createEvent(traceId, "message_sending", decision, ["MESSAGE_SANITIZED"], sanitized.findings.length * 20),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "message_sending",
          trace_id: traceId,
          decision,
          risk: sanitized.findings.length * 20,
          reasons: ["MESSAGE_SANITIZED"]
        });
        api.logger.warn?.(
          `safeclaw: message_sending trace_id=${traceId} decision=${decision} findings=${findingsToText(sanitized.findings)}`,
        );
        if (config.dlp.on_dlp_hit === "block") {
          return { cancel: true };
        }
        return { content: sanitized.value as string };
      },
      { priority: 100 },
    );

    api.logger.info?.(`safeclaw: loaded policy_version=${config.policy_version}`);
  }
};

export default plugin;
