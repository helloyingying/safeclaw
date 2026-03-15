import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  OpenClawPluginApi
} from "openclaw/plugin-sdk";

import { LiveConfigResolver, type LiveConfigSnapshot } from "./src/config/live_config.ts";
import { DecisionEngine } from "./src/engine/decision_engine.ts";
import { DlpEngine } from "./src/engine/dlp_engine.ts";
import { RuleEngine } from "./src/engine/rule_engine.ts";
import { EventEmitter, HttpEventSink } from "./src/events/emitter.ts";
import { RuntimeStatusStore } from "./src/monitoring/status_store.ts";
import { startAdminServer } from "./admin/server.ts";
import { ensureAdminAssetsBuilt } from "./src/admin/build.ts";
import { shouldAutoStartAdminServer } from "./src/admin/runtime_guard.ts";
import type {
  DecisionContext,
  DecisionSource,
  DlpFinding,
  ResourceScope,
  RuleMatch,
  SafeClawConfig,
  SecurityDecisionEvent
} from "./src/types.ts";

type SafeClawPluginConfig = {
  configPath?: string;
  overridePath?: string;
  dbPath?: string;
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

type ResolvedPluginRuntime = {
  configPath: string;
  dbPath: string;
  legacyOverridePath: string;
};

type RuntimeDependencies = {
  config: SafeClawConfig;
  ruleEngine: RuleEngine;
  decisionEngine: DecisionEngine;
  dlpEngine: DlpEngine;
  emitter: EventEmitter;
  overrideLoaded: boolean;
};

type SafeClawHookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  channelId?: string;
};

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = os.homedir();
const PATH_KEY_PATTERN = /(path|paths|file|files|dir|cwd|target|output|input|source|destination|dest|root)/i;
const SYSTEM_PATH_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/var", "/private/etc", "/System", "/Library"];

function resolveScope(ctx: { workspaceDir?: string | undefined; channelId?: string | undefined }): string {
  if (ctx.workspaceDir) {
    return path.basename(ctx.workspaceDir);
  }
  return ctx.channelId ?? "default";
}

function isPathLike(value: string, keyHint: string): boolean {
  if (PATH_KEY_PATTERN.test(keyHint)) {
    return true;
  }
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  );
}

function collectPathCandidates(value: unknown, keyHint = "", depth = 0, output: string[] = []): string[] {
  if (depth > 4 || output.length >= 24) {
    return output;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && isPathLike(trimmed, keyHint)) {
      output.push(trimmed);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, keyHint, depth + 1, output);
      if (output.length >= 24) {
        break;
      }
    }
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    collectPathCandidates(item, key, depth + 1, output);
    if (output.length >= 24) {
      break;
    }
  }
  return output;
}

function resolvePathCandidate(candidate: string, workspaceDir?: string): string | undefined {
  if (!candidate) {
    return undefined;
  }

  let normalized = candidate;
  if (normalized.startsWith("~/")) {
    normalized = path.join(HOME_DIR, normalized.slice(2));
  } else if (normalized === "~") {
    normalized = HOME_DIR;
  }

  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }
  if (!workspaceDir) {
    return undefined;
  }
  return path.normalize(path.resolve(workspaceDir, normalized));
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSystemPath(candidate: string): boolean {
  return SYSTEM_PATH_PREFIXES.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
}

function extractResourceContext(args: unknown, workspaceDir?: string): { resourceScope: ResourceScope; resourcePaths: string[] } {
  const candidates = collectPathCandidates(args);
  const resolved = Array.from(
    new Set(
      candidates
        .map((candidate) => resolvePathCandidate(candidate, workspaceDir))
        .filter((value): value is string => Boolean(value)),
    ),
  ).slice(0, 12);

  if (resolved.length === 0) {
    return { resourceScope: "none", resourcePaths: [] };
  }

  let hasInside = false;
  let hasOutside = false;
  let hasSystem = false;
  const normalizedWorkspace = workspaceDir ? path.normalize(workspaceDir) : undefined;

  for (const candidate of resolved) {
    if (isSystemPath(candidate)) {
      hasSystem = true;
    }
    if (normalizedWorkspace && isPathInside(normalizedWorkspace, candidate)) {
      hasInside = true;
    } else {
      hasOutside = true;
    }
  }

  if (hasSystem) {
    return { resourceScope: "system", resourcePaths: resolved };
  }
  if (hasOutside) {
    return { resourceScope: "workspace_outside", resourcePaths: resolved };
  }
  if (hasInside) {
    return { resourceScope: "workspace_inside", resourcePaths: resolved };
  }
  return { resourceScope: "none", resourcePaths: resolved };
}

function resolvePluginRuntime(api: OpenClawPluginApi): ResolvedPluginRuntime {
  const pluginConfig = (api.pluginConfig ?? {}) as SafeClawPluginConfig;
  const configPath = pluginConfig.configPath
    ? path.isAbsolute(pluginConfig.configPath)
      ? pluginConfig.configPath
      : path.resolve(PLUGIN_ROOT, pluginConfig.configPath)
    : path.resolve(PLUGIN_ROOT, "./config/policy.default.yaml");
  const dbPath = pluginConfig.dbPath
    ? path.isAbsolute(pluginConfig.dbPath)
      ? pluginConfig.dbPath
      : path.resolve(PLUGIN_ROOT, pluginConfig.dbPath)
    : path.resolve(PLUGIN_ROOT, "./runtime/safeclaw.db");
  const legacyOverridePath = pluginConfig.overridePath
    ? path.isAbsolute(pluginConfig.overridePath)
      ? pluginConfig.overridePath
      : path.resolve(PLUGIN_ROOT, pluginConfig.overridePath)
    : path.resolve(PLUGIN_ROOT, "./config/policy.overrides.json");
  return {
    configPath,
    dbPath,
    legacyOverridePath
  };
}

function createEventEmitter(config: SafeClawConfig): EventEmitter {
  const sink = config.event_sink.webhook_url
    ? new HttpEventSink(config.event_sink.webhook_url, config.event_sink.timeout_ms)
    : undefined;
  return new EventEmitter(sink, config.event_sink.max_buffer, config.event_sink.retry_limit);
}

function applyPluginConfigOverrides(config: SafeClawConfig, pluginConfig: SafeClawPluginConfig): SafeClawConfig {
  const webhookUrl = pluginConfig.webhookUrl ?? config.event_sink.webhook_url;
  return {
    ...config,
    policy_version: pluginConfig.policyVersion ?? config.policy_version,
    environment: pluginConfig.environment ?? config.environment,
    defaults: {
      ...config.defaults,
      approval_ttl_seconds: pluginConfig.approvalTtlSeconds ?? config.defaults.approval_ttl_seconds,
      persist_mode: pluginConfig.persistMode ?? config.defaults.persist_mode
    },
    event_sink: {
      ...config.event_sink,
      ...(webhookUrl !== undefined ? { webhook_url: webhookUrl } : {})
    }
  };
}

function buildRuntime(snapshot: LiveConfigSnapshot): RuntimeDependencies {
  return {
    config: snapshot.config,
    ruleEngine: new RuleEngine(snapshot.config.policies),
    decisionEngine: new DecisionEngine(snapshot.config),
    dlpEngine: new DlpEngine(snapshot.config.dlp),
    emitter: createEventEmitter(snapshot.config),
    overrideLoaded: snapshot.overrideLoaded
  };
}

function toStatusConfig(config: SafeClawConfig, overrideLoaded: boolean, resolved: ResolvedPluginRuntime) {
  return {
    environment: config.environment,
    policy_version: config.policy_version,
    policy_count: config.policies.length,
    config_path: resolved.configPath,
    strategy_db_path: resolved.dbPath,
    strategy_loaded: overrideLoaded,
    legacy_override_path: resolved.legacyOverridePath
  };
}

function buildDecisionContext(
  config: SafeClawConfig,
  ctx: SafeClawHookContext,
  toolName?: string,
  tags: string[] = [],
  resourceScope: ResourceScope = "none",
  resourcePaths: string[] = [],
): DecisionContext {
  const workspace = "workspaceDir" in ctx ? ctx.workspaceDir : undefined;
  const runtimeScope = resolveScope({ workspaceDir: workspace, channelId: "channelId" in ctx ? ctx.channelId : undefined });
  const scope = config.environment || runtimeScope;
  const mergedTags = [...new Set([...tags, `resource_scope:${resourceScope}`])];
  return {
    actor_id: ctx.agentId ?? "unknown-agent",
    scope,
    tags: mergedTags,
    resource_scope: resourceScope,
    resource_paths: resourcePaths,
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    security_context: {
      trace_id: ctx.runId ?? ctx.sessionId ?? ctx.sessionKey ?? `trace-${Date.now()}`,
      actor_id: ctx.agentId ?? "unknown-agent",
      workspace: workspace ?? "unknown-workspace",
      policy_version: config.policy_version,
      untrusted: false,
      tags: mergedTags,
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
  decisionSource?: DecisionSource,
  resourceScope?: ResourceScope,
): SecurityDecisionEvent {
  return {
    schema_version: "1.0",
    event_type: "SecurityDecisionEvent",
    trace_id: traceId,
    hook,
    decision,
    reason_codes: reasonCodes,
    latency_ms: 0,
    ts: new Date().toISOString(),
    ...(decisionSource !== undefined ? { decision_source: decisionSource } : {}),
    ...(resourceScope !== undefined ? { resource_scope: resourceScope } : {})
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
  decisionSource: DecisionSource,
  resourceScope: ResourceScope,
  reasonCodes: string[],
  rules: string,
): string {
  const reasons = reasonCodes.join(", ");
  if (decision === "challenge") {
    return `SafeClaw 已拦截敏感调用: ${toolName} (scope=${scope}, resource_scope=${resourceScope})。来源: ${decisionSource}。原因: ${reasons}。rules=${rules}。请联系管理员审批后重试。trace_id=${traceId}`;
  }
  return `SafeClaw 已阻断敏感调用: ${toolName} (scope=${scope}, resource_scope=${resourceScope})。来源: ${decisionSource}。原因: ${reasons}。rules=${rules}。如需放行，请联系安全管理员调整策略。trace_id=${traceId}`;
}

const plugin = {
  id: "safeclaw",
  name: "SafeClaw Security",
  description: "Runtime policy enforcement, transcript sanitization, and audit events for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const resolved = resolvePluginRuntime(api);
    const pluginConfig = (api.pluginConfig ?? {}) as SafeClawPluginConfig;
    const adminAutoStart = pluginConfig.adminAutoStart ?? true;
    const decisionLogMaxLength = pluginConfig.decisionLogMaxLength ?? 240;
    const statusPath = pluginConfig.statusPath
      ? path.isAbsolute(pluginConfig.statusPath)
        ? pluginConfig.statusPath
        : path.resolve(PLUGIN_ROOT, pluginConfig.statusPath)
      : path.resolve(PLUGIN_ROOT, "./runtime/safeclaw-status.json");
    const dbPath = resolved.dbPath;
    const statusStore = new RuntimeStatusStore({ snapshotPath: statusPath, dbPath });
    const liveConfig = new LiveConfigResolver({
      configPath: resolved.configPath,
      dbPath,
      legacyOverridePath: resolved.legacyOverridePath,
      logger: {
        info: (message: string) => api.logger.info?.(message),
        warn: (message: string) => api.logger.warn?.(message)
      },
      transform: (config: SafeClawConfig) => applyPluginConfigOverrides(config, pluginConfig),
      onReload: (snapshot: LiveConfigSnapshot) => {
        statusStore.updateConfig(toStatusConfig(snapshot.config, snapshot.overrideLoaded, resolved));
        api.logger.info?.(
          `safeclaw: policy refresh env=${snapshot.config.environment} policy_version=${snapshot.config.policy_version} rules=${snapshot.config.policies.length}`,
        );
      }
    });
    let runtime = buildRuntime(liveConfig.getSnapshot());
    function getRuntime(): RuntimeDependencies {
      const snapshot = liveConfig.getSnapshot();
      if (snapshot.config !== runtime.config || snapshot.overrideLoaded !== runtime.overrideLoaded) {
        runtime = buildRuntime(snapshot);
      }
      return runtime;
    }

    statusStore.markBoot(toStatusConfig(runtime.config, runtime.overrideLoaded, resolved));
    const adminBuildPromise = ensureAdminAssetsBuilt({
      logger: {
        info: (message: string) => api.logger.info?.(`safeclaw: ${message}`)
      }
    }).catch((error) => {
      api.logger.warn?.(`safeclaw: failed to refresh admin bundle (${String(error)})`);
    });
    if (adminAutoStart) {
      const autoStartDecision = shouldAutoStartAdminServer(process.env);
      if (autoStartDecision.enabled) {
        const adminServerOptions = {
          configPath: resolved.configPath,
          legacyOverridePath: resolved.legacyOverridePath,
          statusPath,
          dbPath,
          unrefOnStart: true,
          logger: {
            info: (message: string) => api.logger.info?.(`safeclaw: ${message}`),
            warn: (message: string) => api.logger.warn?.(`safeclaw: ${message}`)
          },
          ...(pluginConfig.adminPort !== undefined ? { port: pluginConfig.adminPort } : {})
        };
        void adminBuildPromise.then(() =>
          startAdminServer(adminServerOptions).catch((error) => {
            api.logger.warn?.(`safeclaw: failed to auto-start admin dashboard (${String(error)})`);
          }),
        );
      } else {
        api.logger.info?.(
          `safeclaw: admin auto-start skipped in ${autoStartDecision.reason}; use npm run admin for standalone dashboard`,
        );
      }
    } else {
      api.logger.info?.("safeclaw: admin auto-start disabled by config");
    }

    api.logger.info?.(
      `safeclaw: boot env=${runtime.config.environment} policy_version=${runtime.config.policy_version} dlp_mode=${runtime.config.dlp.on_dlp_hit} rules=${runtime.config.policies.length}`,
    );
    if (!runtime.config.event_sink.webhook_url) {
      api.logger.info?.("safeclaw: event sink disabled (webhook_url is empty), using logger-only observability");
    }

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const hookContext = ctx as SafeClawHookContext;
        const current = getRuntime();
        const traceId = hookContext.runId ?? hookContext.sessionId ?? hookContext.sessionKey ?? `trace-${Date.now()}`;
        const scope = resolveScope({ workspaceDir: hookContext.workspaceDir, channelId: hookContext.channelId });
        const prependSystemContext = [
          "[SafeClaw Security Context]",
          `trace_id=${traceId}`,
          `agent_id=${hookContext.agentId ?? "unknown-agent"}`,
          `scope=${scope}`,
          `policy_version=${current.config.policy_version}`
        ].join("\n");
        emitEvent(
          current.emitter,
          createEvent(traceId, "before_prompt_build", "allow", ["SECURITY_CONTEXT_INJECTED"]),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_prompt_build",
          trace_id: traceId,
          actor: hookContext.agentId ?? "unknown-agent",
          scope,
          decision: "allow",
          reasons: ["SECURITY_CONTEXT_INJECTED"]
        });
        return { prependSystemContext };
      },
      { priority: 100 },
    );

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const hookContext = ctx as SafeClawHookContext;
        const current = getRuntime();
        const normalizedToolName = normalizeToolName(event.toolName);
        const rawArguments = event.params;
        const resource = extractResourceContext(rawArguments, hookContext.workspaceDir);
        const decisionContext = buildDecisionContext(
          current.config,
          hookContext,
          normalizedToolName,
          [],
          resource.resourceScope,
          resource.resourcePaths,
        );
        const matches = current.ruleEngine.match(decisionContext);
        const rules = matchedRuleIds(matches);
        const outcome = current.decisionEngine.evaluate(decisionContext, matches);
        const traceId = decisionContext.security_context.trace_id;
        const argsSummary = summarizeForLog(rawArguments, decisionLogMaxLength);

        const decisionLog = [
          "safeclaw: before_tool_call",
          `trace_id=${traceId}`,
          `actor=${decisionContext.actor_id}`,
          `scope=${decisionContext.scope}`,
          `resource_scope=${decisionContext.resource_scope}`,
          `tool=${normalizedToolName}`,
          `raw_tool=${event.toolName}`,
          `decision=${outcome.decision}`,
          `source=${outcome.decision_source}`,
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
          current.emitter,
          createEvent(
            traceId,
            "before_tool_call",
            outcome.decision,
            outcome.reason_codes,
            outcome.decision_source,
            decisionContext.resource_scope,
          ),
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
          decision_source: outcome.decision_source,
          resource_scope: decisionContext.resource_scope,
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
              outcome.decision_source,
              decisionContext.resource_scope,
              outcome.reason_codes,
              rules,
            )
          };
        }

        return undefined;
      },
      { priority: 100 },
    );

    api.on("after_tool_call", async (event, ctx) => {
      const current = getRuntime();
      const decisionContext = buildDecisionContext(current.config, ctx, event.toolName);
      const traceId = decisionContext.security_context.trace_id;
      const findings = current.dlpEngine.scan(event.result);
      const decision =
        findings.length === 0 ? "allow" : current.config.dlp.on_dlp_hit === "block" ? "block" : "warn";
      if (findings.length > 0) {
        api.logger.warn?.(
          `safeclaw: after_tool_call findings tool=${event.toolName} findings=${findingsToText(findings)}`,
        );
      }
      emitEvent(
        current.emitter,
        createEvent(
          traceId,
          "after_tool_call",
          decision,
          findings.length > 0 ? ["DLP_HIT"] : ["RESULT_OK"],
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
        reasons: findings.length > 0 ? ["DLP_HIT"] : ["RESULT_OK"]
      });
    });

    api.on(
      "tool_result_persist",
      (event) => {
        const current = getRuntime();
        const traceId = event.toolCallId ?? event.toolName ?? `trace-${Date.now()}`;
        const sanitized = sanitizeUnknown(current.dlpEngine, event.message);
        if (sanitized.findings.length === 0) {
          emitEvent(
            current.emitter,
            createEvent(traceId, "tool_result_persist", "allow", ["PERSIST_OK"]),
            api.logger,
          );
          if (event.toolName !== undefined) {
            statusStore.recordDecision({
              ts: new Date().toISOString(),
              hook: "tool_result_persist",
              trace_id: traceId,
              tool: event.toolName,
              decision: "allow",
              reasons: ["PERSIST_OK"]
            });
          } else {
            statusStore.recordDecision({
              ts: new Date().toISOString(),
              hook: "tool_result_persist",
              trace_id: traceId,
              decision: "allow",
              reasons: ["PERSIST_OK"]
            });
          }
          return undefined;
        }
        emitEvent(
          current.emitter,
          createEvent(
            traceId,
            "tool_result_persist",
            current.config.defaults.persist_mode === "strict" ? "block" : "warn",
            ["PERSIST_SANITIZED"],
          ),
          api.logger,
        );
        if (event.toolName !== undefined) {
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "tool_result_persist",
            trace_id: traceId,
            tool: event.toolName,
            decision: current.config.defaults.persist_mode === "strict" ? "block" : "warn",
            reasons: ["PERSIST_SANITIZED"]
          });
        } else {
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "tool_result_persist",
            trace_id: traceId,
            decision: current.config.defaults.persist_mode === "strict" ? "block" : "warn",
            reasons: ["PERSIST_SANITIZED"]
          });
        }
        api.logger.warn?.(
          `safeclaw: tool_result_persist trace_id=${traceId} tool=${event.toolName} decision=${current.config.defaults.persist_mode === "strict" ? "block" : "warn"} findings=${findingsToText(sanitized.findings)}`,
        );
        return { message: sanitized.value };
      },
      { priority: 100 },
    );

    api.on(
      "before_message_write",
      (event) => {
        const current = getRuntime();
        if (current.config.defaults.persist_mode !== "strict") {
          return undefined;
        }
        const findings = current.dlpEngine.scan(event.message);
        if (findings.length === 0) {
          return undefined;
        }
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_message_write",
          trace_id: `before-write-${Date.now()}`,
          decision: "block",
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
      async (event, ctx) => {
        const current = getRuntime();
        const traceId = ctx.conversationId ?? ctx.accountId ?? `trace-${Date.now()}`;
        const sanitized = sanitizeUnknown(current.dlpEngine, event.content);
        if (sanitized.findings.length === 0) {
          emitEvent(
            current.emitter,
            createEvent(traceId, "message_sending", "allow", ["MESSAGE_OK"]),
            api.logger,
          );
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "message_sending",
            trace_id: traceId,
            decision: "allow",
            reasons: ["MESSAGE_OK"]
          });
          return undefined;
        }
        const decision = current.config.dlp.on_dlp_hit === "block" ? "block" : "warn";
        emitEvent(
          current.emitter,
          createEvent(traceId, "message_sending", decision, ["MESSAGE_SANITIZED"]),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "message_sending",
          trace_id: traceId,
          decision,
          reasons: ["MESSAGE_SANITIZED"]
        });
        api.logger.warn?.(
          `safeclaw: message_sending trace_id=${traceId} decision=${decision} findings=${findingsToText(sanitized.findings)}`,
        );
        if (current.config.dlp.on_dlp_hit === "block") {
          return { cancel: true };
        }
        return { content: sanitized.value as string };
      },
      { priority: 100 },
    );

    api.logger.info?.(`safeclaw: loaded policy_version=${runtime.config.policy_version}`);
  }
};

export default plugin;
