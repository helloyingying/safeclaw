export type HookName =
  | "before_prompt_build"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "message_sending";

export type Decision = "allow" | "warn" | "challenge" | "block";
export type DecisionSource = "rule" | "default" | "approval";
export type FailMode = "open" | "close";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type PersistMode = "strict" | "compat";
export type DlpAction = "mask" | "remove";
export type DlpMode = "warn" | "block" | "sanitize";
export type PatternType = "pii" | "secret" | "token" | "credential";
export type ReasonCode = string;
export type ResourceScope = "none" | "workspace_inside" | "workspace_outside" | "system";

export interface SecurityContext {
  trace_id: string;
  actor_id: string;
  workspace: string;
  policy_version: string;
  untrusted: boolean;
  tags: string[];
  created_at: string;
}

export interface HookControls {
  enabled: boolean;
  timeout_ms: number;
  fail_mode: FailMode;
}

export interface PolicyMatch {
  identity?: string[];
  scope?: string[];
  tool?: string[];
  tags?: string[];
  resource_scope?: ResourceScope[];
  path_prefix?: string[];
}

export interface ChallengeConfig {
  ttl_seconds: number;
}

export interface PolicyRule {
  rule_id: string;
  group: string;
  enabled: boolean;
  priority: number;
  decision?: Decision;
  reason_codes: ReasonCode[];
  match: PolicyMatch;
  challenge?: ChallengeConfig;
}

export interface ApprovalRecord {
  approval_id: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
  request_context: {
    actor_id: string;
    scope: string;
    tool_name?: string;
    reason_codes: ReasonCode[];
  };
  approver?: string;
  decision?: "approved" | "rejected";
  decided_at?: string;
}

export interface DlpPatternConfig {
  name: string;
  type: PatternType;
  action: DlpAction;
  regex: string;
  flags?: string;
}

export interface DlpFinding {
  pattern_name: string;
  type: PatternType;
  action: DlpAction;
  path: string;
  match: string;
}

export interface SanitizationAction {
  path: string;
  action: DlpAction | "truncate";
  detail: string;
}

export interface SecurityDecisionEvent {
  schema_version: string;
  event_type: "SecurityDecisionEvent";
  trace_id: string;
  hook: HookName;
  decision: Decision;
  decision_source?: DecisionSource;
  resource_scope?: ResourceScope;
  reason_codes: ReasonCode[];
  latency_ms: number;
  ts: string;
}

export interface DlpConfig {
  on_dlp_hit: DlpMode;
  patterns: DlpPatternConfig[];
}

export interface EventSinkConfig {
  webhook_url?: string;
  timeout_ms: number;
  max_buffer: number;
  retry_limit: number;
}

export interface SafeClawConfig {
  version: string;
  policy_version: string;
  environment: string;
  defaults: {
    approval_ttl_seconds: number;
    persist_mode: PersistMode;
  };
  hooks: Record<HookName, HookControls>;
  policies: PolicyRule[];
  dlp: DlpConfig;
  event_sink: EventSinkConfig;
}

export interface HookResult<T = unknown> {
  mutated_payload: T;
  decision: Decision;
  decision_source?: DecisionSource;
  reason_codes: ReasonCode[];
  sanitization_actions: SanitizationAction[];
  latency_ms: number;
  security_context?: SecurityContext;
  approval?: ApprovalRecord;
}

export interface BeforePromptBuildInput {
  prompt: unknown;
  actor_id: string;
  workspace: string;
  source?: "external" | "internal";
  trace_id?: string;
  tags?: string[];
}

export interface BeforeToolCallInput {
  actor_id: string;
  workspace: string;
  scope: string;
  tool_name: string;
  tool_group?: string;
  tags?: string[];
  resource_scope?: ResourceScope;
  resource_paths?: string[];
  security_context?: Partial<SecurityContext>;
  approval_id?: string;
}

export interface SchemaExpectation {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: Record<string, SchemaExpectation>;
}

export interface AfterToolCallInput {
  actor_id: string;
  workspace: string;
  scope: string;
  tool_name: string;
  result: unknown;
  security_context?: Partial<SecurityContext>;
  expected_schema?: SchemaExpectation;
}

export interface ToolResultPersistInput {
  actor_id: string;
  workspace: string;
  scope: string;
  tool_name: string;
  result: unknown;
  mode?: PersistMode;
  security_context?: Partial<SecurityContext>;
}

export interface MessageSendingInput {
  actor_id: string;
  workspace: string;
  scope: string;
  message: unknown;
  restricted_terms?: string[];
  security_context?: Partial<SecurityContext>;
}

export interface RuleMatch {
  rule: PolicyRule;
  precedence: number;
}

export interface DecisionContext {
  actor_id: string;
  scope: string;
  tool_name?: string;
  tags: string[];
  resource_scope: ResourceScope;
  resource_paths: string[];
  security_context: SecurityContext;
}

export interface DecisionOutcome {
  decision: Decision;
  decision_source: DecisionSource;
  reason_codes: ReasonCode[];
  matched_rules: PolicyRule[];
  challenge_ttl_seconds?: number;
}

export interface GuardComputation<T = unknown> {
  mutated_payload: T;
  decision: Decision;
  decision_source?: DecisionSource;
  reason_codes: ReasonCode[];
  sanitization_actions: SanitizationAction[];
  security_context?: SecurityContext;
  approval?: ApprovalRecord;
}

export interface EventSink {
  send(event: SecurityDecisionEvent): Promise<void>;
}

export interface SafeClawPluginOptions {
  config?: SafeClawConfig;
  config_path?: string;
  event_sink?: EventSink;
  now?: () => number;
  generate_trace_id?: () => string;
}

export interface PluginHooks {
  before_prompt_build(input: BeforePromptBuildInput): Promise<HookResult<BeforePromptBuildInput>>;
  before_tool_call(input: BeforeToolCallInput): Promise<HookResult<BeforeToolCallInput>>;
  after_tool_call(input: AfterToolCallInput): Promise<HookResult<AfterToolCallInput>>;
  tool_result_persist(input: ToolResultPersistInput): Promise<HookResult<ToolResultPersistInput>>;
  message_sending(input: MessageSendingInput): Promise<HookResult<MessageSendingInput>>;
}

export interface ApprovalService {
  requestApproval(context: DecisionContext, ttlSeconds?: number, reasonCodes?: ReasonCode[]): ApprovalRecord;
  resolveApproval(
    approvalId: string,
    approver: string,
    decision: "approved" | "rejected",
  ): ApprovalRecord | undefined;
  getApprovalStatus(approvalId: string): ApprovalRecord | undefined;
}
