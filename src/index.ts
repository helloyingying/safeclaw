import { ConfigManager } from "./config/loader.ts";
import { ApprovalFsm } from "./engine/approval_fsm.ts";
import { DecisionEngine } from "./engine/decision_engine.ts";
import { DlpEngine } from "./engine/dlp_engine.ts";
import { RuleEngine } from "./engine/rule_engine.ts";
import { EventEmitter, HttpEventSink } from "./events/emitter.ts";
import { runContextGuard } from "./hooks/context_guard.ts";
import { runOutputGuard } from "./hooks/output_guard.ts";
import { runPersistGuard } from "./hooks/persist_guard.ts";
import { runPolicyGuard } from "./hooks/policy_guard.ts";
import { runResultGuard } from "./hooks/result_guard.ts";
import type {
  AfterToolCallInput,
  BeforePromptBuildInput,
  BeforeToolCallInput,
  EventSink,
  GuardComputation,
  HookName,
  HookResult,
  MessageSendingInput,
  PluginHooks,
  SafeClawPluginOptions,
  SecurityDecisionEvent,
  ToolResultPersistInput
} from "./types.ts";
import { generateTraceId, nowIso, withTimeout } from "./utils.ts";

export * from "./types.ts";
export { ConfigManager } from "./config/loader.ts";
export { securityDecisionEventSchema } from "./events/schema.ts";

type PluginResult = {
  hooks: PluginHooks;
  approvals: ApprovalFsm;
  config: ConfigManager;
  events: EventEmitter;
};

type RuntimeDependencies = {
  config: ReturnType<ConfigManager["getConfig"]>;
  ruleEngine: RuleEngine;
  decisionEngine: DecisionEngine;
  dlpEngine: DlpEngine;
};

function buildEvent(
  hook: HookName,
  traceId: string,
  result: GuardComputation,
  latencyMs: number,
  now: () => number,
): SecurityDecisionEvent {
  return {
    schema_version: "1.0",
    event_type: "SecurityDecisionEvent",
    trace_id: traceId,
    hook,
    decision: result.decision,
    reason_codes: result.reason_codes,
    latency_ms: latencyMs,
    ts: nowIso(now),
    ...(result.decision_source !== undefined ? { decision_source: result.decision_source } : {})
  };
}

async function executeGuard<TInput>(
  hook: HookName,
  input: TInput,
  handler: () => Promise<GuardComputation<TInput>> | GuardComputation<TInput>,
  dependencies: {
    eventEmitter: EventEmitter;
    configManager: ConfigManager;
    now: () => number;
  },
): Promise<HookResult<TInput>> {
  const config = dependencies.configManager.getConfig();
  const controls = config.hooks[hook];
  const traceId =
    (input as { security_context?: { trace_id?: string }; trace_id?: string }).security_context?.trace_id ??
    (input as { trace_id?: string }).trace_id ??
    generateTraceId();
  const startedAt = dependencies.now();

  if (!controls.enabled) {
    const latencyMs = dependencies.now() - startedAt;
    return {
      mutated_payload: input,
      decision: "allow",
      reason_codes: ["HOOK_DISABLED"],
      sanitization_actions: [],
      latency_ms: latencyMs
    };
  }

  try {
    const computation = await withTimeout(
      Promise.resolve(handler()),
      controls.timeout_ms,
      `${hook} timed out`,
    );
    const latencyMs = dependencies.now() - startedAt;
    const event = buildEvent(hook, traceId, computation, latencyMs, dependencies.now);
    await dependencies.eventEmitter.emitSecurityEvent(event);
    return {
      ...computation,
      latency_ms: latencyMs
    };
  } catch (error) {
    const latencyMs = dependencies.now() - startedAt;
    const decision = controls.fail_mode === "close" ? "block" : "allow";
    const reason = error instanceof Error && error.message.includes("timed out") ? "HOOK_TIMEOUT" : "HOOK_ERROR";
    const fallback: GuardComputation<TInput> = {
      mutated_payload: input,
      decision,
      reason_codes: [reason],
      sanitization_actions: []
    };
    const event = buildEvent(hook, traceId, fallback, latencyMs, dependencies.now);
    await dependencies.eventEmitter.emitSecurityEvent(event);
    return {
      ...fallback,
      latency_ms: latencyMs
    };
  }
}

export function createSafeClawPlugin(options: SafeClawPluginOptions = {}): PluginResult {
  const now = options.now ?? Date.now;
  const configManager = options.config
    ? new ConfigManager(options.config)
    : ConfigManager.fromFile(options.config_path ?? "./config/policy.default.yaml");
  const initialConfig = configManager.getConfig();
  const sink: EventSink | undefined =
    options.event_sink ??
    (initialConfig.event_sink.webhook_url
      ? new HttpEventSink(initialConfig.event_sink.webhook_url, initialConfig.event_sink.timeout_ms)
      : undefined);
  const eventEmitter = new EventEmitter(
    sink,
    initialConfig.event_sink.max_buffer,
    initialConfig.event_sink.retry_limit,
  );
  const approvals = new ApprovalFsm(now);
  const traceGenerator = options.generate_trace_id ?? generateTraceId;

  function buildRuntime(config: ReturnType<ConfigManager["getConfig"]>): RuntimeDependencies {
    return {
      config,
      ruleEngine: new RuleEngine(config.policies),
      decisionEngine: new DecisionEngine(config),
      dlpEngine: new DlpEngine(config.dlp)
    };
  }

  let runtime = buildRuntime(configManager.getConfig());
  function getRuntime(): RuntimeDependencies {
    const latest = configManager.getConfig();
    if (latest !== runtime.config) {
      runtime = buildRuntime(latest);
    }
    return runtime;
  }

  return {
    hooks: {
      before_prompt_build: (input: BeforePromptBuildInput) =>
        executeGuard(
          "before_prompt_build",
          input,
          () => {
            const current = getRuntime();
            return runContextGuard(
              input,
              current.config.policy_version,
              input.trace_id ?? traceGenerator(),
              nowIso(now),
            );
          },
          { eventEmitter, configManager, now },
        ),
      before_tool_call: (input: BeforeToolCallInput) =>
        executeGuard(
          "before_tool_call",
          input,
          () => {
            const current = getRuntime();
            return runPolicyGuard(
              input,
              current.config.policy_version,
              input.security_context?.trace_id ?? traceGenerator(),
              nowIso(now),
              current.ruleEngine,
              current.decisionEngine,
              approvals,
            );
          },
          { eventEmitter, configManager, now },
        ),
      after_tool_call: (input: AfterToolCallInput) =>
        executeGuard(
          "after_tool_call",
          input,
          () => {
            const current = getRuntime();
            return runResultGuard(
              input,
              input.security_context?.trace_id ?? traceGenerator(),
              current.config.policy_version,
              nowIso(now),
              current.dlpEngine,
            );
          },
          { eventEmitter, configManager, now },
        ),
      tool_result_persist: (input: ToolResultPersistInput) =>
        executeGuard(
          "tool_result_persist",
          input,
          () => {
            const current = getRuntime();
            return runPersistGuard(
              input,
              input.security_context?.trace_id ?? traceGenerator(),
              current.config.policy_version,
              nowIso(now),
              current.dlpEngine,
              current.config.defaults.persist_mode,
            );
          },
          { eventEmitter, configManager, now },
        ),
      message_sending: (input: MessageSendingInput) =>
        executeGuard(
          "message_sending",
          input,
          () => {
            const current = getRuntime();
            return runOutputGuard(
              input,
              input.security_context?.trace_id ?? traceGenerator(),
              current.config.policy_version,
              nowIso(now),
              current.dlpEngine,
            );
          },
          { eventEmitter, configManager, now },
        )
    },
    approvals,
    config: configManager,
    events: eventEmitter
  };
}
