import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type {
  OpenClawPluginApi
} from "openclaw/plugin-sdk";
import * as OpenClawCompat from "openclaw/plugin-sdk/compat";

import { LiveConfigResolver, type LiveConfigSnapshot } from "./src/config/live_config.ts";
import {
  ChatApprovalStore,
  type ApprovalChannel,
  type ChatApprovalApprover,
  type ChatApprovalTarget,
  type StoredApprovalNotification,
  type StoredApprovalRecord,
  createApprovalRequestKey,
} from "./src/approvals/chat_approval_store.ts";
import { DlpEngine } from "./src/engine/dlp_engine.ts";
import { PolicyPipeline, matchedPolicyRuleIds } from "./src/engine/policy_pipeline.ts";
import { EventEmitter, HttpEventSink } from "./src/events/emitter.ts";
import {
  PluginConfigParser,
  type ResolvedPluginRuntime,
  type SecurityClawPluginConfig,
} from "./src/infrastructure/config/plugin_config_parser.ts";
import { RuntimeStatusStore } from "./src/monitoring/status_store.ts";
import { startAdminServer } from "./admin/server.ts";
import { announceAdminConsole, shouldAnnounceAdminConsoleForArgv } from "./src/admin/console_notice.ts";
import { shouldAutoStartAdminServer } from "./src/admin/runtime_guard.ts";
import { readProcessEnvValue, resolveSecurityClawAdminPort } from "./src/runtime/process_env.ts";
import { AccountPolicyEngine } from "./src/domain/services/account_policy_engine.ts";
import { ApprovalSubjectResolver } from "./src/domain/services/approval_subject_resolver.ts";
import { ContextInferenceService } from "./src/domain/services/context_inference_service.ts";
import { resolveConfiguredOpenClawWorkspace } from "./src/domain/services/openclaw_workspace_resolver.ts";
import { hydrateSensitivePathConfig } from "./src/domain/services/sensitive_path_registry.ts";
import type { SecurityClawLocale } from "./src/i18n/locale.ts";
import { localeForIntl, pickLocalized, resolveSecurityClawLocale } from "./src/i18n/locale.ts";
import type {
  AccountPolicyRecord,
  Decision,
  DecisionContext,
  DecisionSource,
  DlpFinding,
  ResourceScope,
  SecurityClawConfig,
  SecurityDecisionEvent
} from "./src/types.ts";

type RuntimeDependencies = {
  config: SecurityClawConfig;
  policyPipeline: PolicyPipeline;
  accountPolicyEngine: AccountPolicyEngine;
  dlpEngine: DlpEngine;
  emitter: EventEmitter;
  overrideLoaded: boolean;
};

type SecurityClawHookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  cwd?: string;
  sessionCwd?: string;
  channelId?: string;
};

type SecurityClawApprovalCommandContext = {
  channel?: string;
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  args?: string;
  isAuthorizedSender: boolean;
};

type ApprovalNotificationResult = {
  sent: boolean;
  notifications: StoredApprovalNotification[];
};

type ChatNotificationOptions = {
  buttons?: Array<Array<{
    text: string;
    callback_data: string;
    style?: string;
  }>>;
};

type ApprovalGrantMode = "temporary" | "longterm";

type ResolvedApprovalBridge = {
  enabled: boolean;
  targets: ChatApprovalTarget[];
  approvers: ChatApprovalApprover[];
  locale: SecurityClawLocale;
};

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = os.homedir();
const APPROVAL_APPROVE_COMMAND = "securityclaw-approve";
const APPROVAL_REJECT_COMMAND = "securityclaw-reject";
const APPROVAL_PENDING_COMMAND = "securityclaw-pending";
const APPROVAL_LONG_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_DISPLAY_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const APPROVAL_NOTIFICATION_MAX_ATTEMPTS = 3;
const APPROVAL_NOTIFICATION_RETRY_DELAYS_MS = [250, 750];
const APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS = 60_000;
const APPROVAL_NOTIFICATION_HISTORY_LIMIT = 12;
const SECURITYCLAW_PROTECTED_STORAGE_RULE_ID = "internal:securityclaw-protected-storage";
const SECURITYCLAW_PROTECTED_STORAGE_REASON = "SECURITYCLAW_STATE_STORAGE_PROTECTED";
const CHANNEL_METHOD_SUFFIX_OVERRIDES: Record<string, string> = {
  imessage: "IMessage",
  whatsapp: "WhatsApp",
  lark: "Feishu",
};
const FEISHU_DEFAULT_API_BASE = "https://open.feishu.cn";
const LARK_DEFAULT_API_BASE = "https://open.larksuite.com";
const FEISHU_HTTP_TIMEOUT_MS = 10_000;
const CHANNEL_LOOKUP_ALIASES: Record<string, string[]> = {
  feishu: ["lark"],
  lark: ["feishu"],
};
const getChannelPluginCompat = (OpenClawCompat as Record<string, unknown>).getChannelPlugin as
  | ((id: string) => unknown)
  | undefined;
const contextInference = new ContextInferenceService();

function resolveRuntimeLocale(): SecurityClawLocale {
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  return resolveSecurityClawLocale(systemLocale, "en");
}

let runtimeLocale: SecurityClawLocale = resolveRuntimeLocale();

function text(zhText: string, enText: string): string {
  return pickLocalized(runtimeLocale, zhText, enText);
}

function textForLocale(locale: SecurityClawLocale, zhText: string, enText: string): string {
  return pickLocalized(locale, zhText, enText);
}

function resolvePluginStateDir(api: OpenClawPluginApi): string {
  try {
    return api.runtime.state.resolveStateDir();
  } catch {
    return path.join(HOME_DIR, ".openclaw");
  }
}

function resolveAdminConsoleUrl(pluginConfig: SecurityClawPluginConfig): string {
  const port = pluginConfig.adminPort ?? resolveSecurityClawAdminPort();
  return `http://127.0.0.1:${port}`;
}

function plural(value: number, unit: "day" | "hour" | "minute"): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function resolveScope(ctx: { workspaceDir?: string | undefined; channelId?: string | undefined }): string {
  if (ctx.workspaceDir) {
    return path.basename(ctx.workspaceDir);
  }
  return ctx.channelId ?? "default";
}

function normalizeWorkspaceCandidate(candidate: unknown, fallbackBaseDir?: string): string | undefined {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (path.isAbsolute(trimmed)) {
    return path.normalize(path.resolve(trimmed));
  }
  if (!fallbackBaseDir) {
    return undefined;
  }
  return path.normalize(path.resolve(fallbackBaseDir, trimmed));
}

function resolveWorkspaceFromArgs(args: unknown, fallbackBaseDir?: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }

  const record = args as Record<string, unknown>;
  for (const key of ["workspaceDir", "workdir", "cwd"]) {
    const resolved = normalizeWorkspaceCandidate(record[key], fallbackBaseDir);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extractResourceContext(args: unknown, workspaceDir?: string): { resourceScope: ResourceScope; resourcePaths: string[] } {
  return contextInference.inferResourceContext(args, workspaceDir);
}

function resolveEffectiveWorkspaceDir(
  ctx: SecurityClawHookContext,
  args: unknown,
  defaultWorkspaceDir?: string,
): string | undefined {
  return normalizeWorkspaceCandidate(ctx.workspaceDir)
    ?? normalizeWorkspaceCandidate(ctx.sessionCwd)
    ?? normalizeWorkspaceCandidate(ctx.cwd)
    ?? resolveWorkspaceFromArgs(args, defaultWorkspaceDir)
    ?? defaultWorkspaceDir;
}

function inferFileType(resourcePaths: string[]): string | undefined {
  return contextInference.inferFileType(resourcePaths);
}

function deriveToolContext(
  normalizedToolName: string | undefined,
  args: unknown,
  resourceScope: ResourceScope,
  resourcePaths: string[],
  workspaceDir?: string,
): {
  inferredToolName?: string;
  toolGroup?: string;
  operation?: string;
  resourceScope: ResourceScope;
  resourcePaths: string[];
  tags: string[];
} {
  return contextInference.inferToolContext(
    normalizedToolName,
    args,
    resourceScope,
    resourcePaths,
    workspaceDir,
  );
}

function inferLabels(
  config: SecurityClawConfig,
  toolGroup: string | undefined,
  resourcePaths: string[],
  toolArgsSummary: string | undefined,
): Pick<DecisionContext, "asset_labels" | "data_labels"> {
  const inferred = contextInference.inferLabels(
    toolGroup,
    resourcePaths,
    toolArgsSummary,
    config.sensitivity.path_rules,
  );
  return {
    asset_labels: inferred.assetLabels,
    data_labels: inferred.dataLabels,
  };
}

function inferVolume(args: unknown, resourcePaths: string[]): DecisionContext["volume"] {
  const inferred = contextInference.inferVolume(args, resourcePaths);
  return {
    ...(inferred.fileCount !== undefined ? { file_count: inferred.fileCount } : {}),
    ...(inferred.bytes !== undefined ? { bytes: inferred.bytes } : {}),
    ...(inferred.recordCount !== undefined ? { record_count: inferred.recordCount } : {}),
  };
}

function trimText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeApprovalChannel(value: string | undefined): ApprovalChannel | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? (normalized as ApprovalChannel) : undefined;
}

function normalizeThreadId(threadId: string | number | undefined): number | undefined {
  if (typeof threadId === "number" && Number.isInteger(threadId)) {
    return threadId;
  }
  if (typeof threadId === "string" && /^\d+$/.test(threadId.trim())) {
    return Number(threadId.trim());
  }
  return undefined;
}

function resolveApprovalSubject(ctx: SecurityClawHookContext): string {
  return ApprovalSubjectResolver.resolve(ctx);
}

function splitApprovalSubject(value: string | undefined): { channel?: ApprovalChannel; identifier?: string } {
  const subject = value?.trim();
  if (!subject) {
    return {};
  }
  const separator = subject.indexOf(":");
  if (separator <= 0) {
    return {};
  }
  const channel = normalizeApprovalChannel(subject.slice(0, separator));
  if (!channel) {
    return {};
  }
  const identifier = subject.slice(separator + 1).trim();
  if (!identifier) {
    return {};
  }
  return { channel, identifier };
}

function normalizeApprovalIdentity(value: string | undefined, channel: ApprovalChannel): string | undefined {
  const candidate = value?.trim();
  if (!candidate) {
    return undefined;
  }
  const channelPrefix = `${channel}:`;
  if (candidate.toLowerCase().startsWith(channelPrefix)) {
    const unscoped = candidate.slice(channelPrefix.length).trim();
    return unscoped || undefined;
  }
  return candidate;
}

function collectAdminApprovalIdentities(policy: AccountPolicyRecord, channel: ApprovalChannel): string[] {
  const candidates = new Set<string>();
  const subject = splitApprovalSubject(policy.subject);
  const subjectIdentity = normalizeApprovalIdentity(subject.identifier, channel);
  if (subjectIdentity) {
    candidates.add(subjectIdentity);
  } else {
    const sessionIdentity = normalizeApprovalIdentity(policy.session_id, channel);
    if (sessionIdentity) {
      candidates.add(sessionIdentity);
    }
  }
  return Array.from(candidates);
}

function deriveApprovalBridgeFromAdminPolicies(
  accountPolicyEngine: AccountPolicyEngine,
): Pick<ResolvedApprovalBridge, "targets" | "approvers" | "locale"> {
  const targets: ChatApprovalTarget[] = [];
  const approvers: ChatApprovalApprover[] = [];
  let locale: SecurityClawLocale = runtimeLocale;
  for (const policy of accountPolicyEngine.listPolicies()) {
    if (!policy.is_admin) {
      continue;
    }
    locale = policy.approval_locale ?? runtimeLocale;
    const subject = splitApprovalSubject(policy.subject);
    const channel = normalizeApprovalChannel(policy.channel) ?? subject.channel;
    if (!channel) {
      continue;
    }
    const identities = collectAdminApprovalIdentities(policy, channel);
    for (const identity of identities) {
      targets.push({
        channel,
        to: channel === "discord" ? normalizeDiscordApprovalTarget(identity) : identity,
      });
      approvers.push({
        channel,
        from: identity,
      });
    }
  }
  return { targets, approvers, locale };
}

function dedupeApprovalTargets(targets: ChatApprovalTarget[]): ChatApprovalTarget[] {
  const deduped: ChatApprovalTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = [
      target.channel,
      target.to,
      target.account_id ?? "",
      target.thread_id !== undefined ? String(target.thread_id) : "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

function dedupeApprovalApprovers(approvers: ChatApprovalApprover[]): ChatApprovalApprover[] {
  const deduped: ChatApprovalApprover[] = [];
  const seen = new Set<string>();
  for (const approver of approvers) {
    const key = [approver.channel, approver.from, approver.account_id ?? ""].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(approver);
  }
  return deduped;
}

function mergeApprovalBridgeConfig(
  derived: Pick<ResolvedApprovalBridge, "targets" | "approvers" | "locale">,
): ResolvedApprovalBridge {
  const targets = dedupeApprovalTargets(derived.targets);
  const approvers = dedupeApprovalApprovers(derived.approvers);
  return {
    enabled: approvers.length > 0,
    targets,
    approvers,
    locale: derived.locale,
  };
}

function matchesApprover(approvers: ChatApprovalApprover[], ctx: SecurityClawApprovalCommandContext): boolean {
  const channel = normalizeApprovalChannel(ctx.channel);
  if (!channel) {
    return false;
  }
  const senderIds = new Set<string>();
  const collectSenderId = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    senderIds.add(trimmed);
    const lower = trimmed.toLowerCase();
    const channelPrefix = `${channel}:`;
    if (lower.startsWith(channelPrefix)) {
      const unscoped = trimmed.slice(channelPrefix.length).trim();
      if (unscoped) {
        senderIds.add(unscoped);
      }
      return;
    }
    senderIds.add(`${channel}:${trimmed}`);
  };

  collectSenderId(ctx.from);
  collectSenderId(ctx.senderId);
  if (senderIds.size === 0) {
    return false;
  }

  return approvers.some((approver) => {
    if (approver.channel !== channel || !senderIds.has(approver.from)) {
      return false;
    }
    if (approver.account_id && approver.account_id !== ctx.accountId) {
      return false;
    }
    return true;
  });
}

function formatResourceScopeLabel(scope: ResourceScope, locale = runtimeLocale): string {
  if (scope === "workspace_inside") {
    return textForLocale(locale, "工作区内", "Inside workspace");
  }
  if (scope === "workspace_outside") {
    return textForLocale(locale, "工作区外", "Outside workspace");
  }
  if (scope === "system") {
    return textForLocale(locale, "系统目录", "System directory");
  }
  return textForLocale(locale, "无路径", "No path");
}

function formatResourceScopeDetail(scope: ResourceScope, locale = runtimeLocale): string {
  return `${formatResourceScopeLabel(scope, locale)} (${scope})`;
}

function resolveApprovalChannelLabel(record: StoredApprovalRecord, locale = runtimeLocale): string {
  const channel =
    splitApprovalSubject(record.actor_id).channel ??
    splitApprovalSubject(record.session_scope).channel;
  return channel ?? textForLocale(locale, "未知", "Unknown");
}

function formatApprovalPermission(record: StoredApprovalRecord, locale = runtimeLocale): string {
  return `${record.tool_name} · ${formatResourceScopeLabel(record.resource_scope, locale)} · ${record.scope}`;
}

function formatApprovalPrompt(record: StoredApprovalRecord, locale = runtimeLocale): string {
  return [
    textForLocale(locale, "SecurityClaw 审批请求", "SecurityClaw Approval"),
    `${textForLocale(locale, "谁", "Who")}: ${record.actor_id}`,
    `${textForLocale(locale, "时间", "When")}: ${formatTimestampForApproval(record.requested_at, APPROVAL_DISPLAY_TIMEZONE, locale)}`,
    `${textForLocale(locale, "通道", "Channel")}: ${resolveApprovalChannelLabel(record, locale)}`,
    `${textForLocale(locale, "权限", "Permission")}: ${formatApprovalPermission(record, locale)}`,
    `${textForLocale(locale, "请求截止", "Request expires")}: ${formatTimestampForApproval(record.expires_at, APPROVAL_DISPLAY_TIMEZONE, locale)}`,
    `${textForLocale(locale, "审批单", "Request ID")}: ${record.approval_id}`,
    "",
    textForLocale(locale, "选项", "Options"),
    `1. ${textForLocale(locale, "批准", "Approve")} ${formatApprovalGrantDuration(record, "temporary", locale)}`,
    `2. ${textForLocale(locale, "批准", "Approve")} ${formatApprovalGrantDuration(record, "longterm", locale)}`,
    `3. ${textForLocale(locale, "拒绝", "Reject")}`,
    textForLocale(
      locale,
      "按这条消息里的操作审批；不要单独发送 1、2、3。",
      "Use the approval actions in this message; do not send 1, 2, or 3 by itself.",
    ),
  ].join("\n");
}

function formatPendingApprovals(records: StoredApprovalRecord[], locale = runtimeLocale): string {
  if (records.length === 0) {
    return textForLocale(locale, "当前没有待审批请求。", "No pending approval requests.");
  }
  return [
    textForLocale(locale, `待审批请求 ${records.length} 条:`, `Pending approval requests (${records.length}):`),
    ...records.map((record, index) =>
      `${index + 1}. ${record.approval_id} | ${record.actor_id} | ${resolveApprovalChannelLabel(record, locale)} | ${formatApprovalPermission(record, locale)} | ${formatTimestampForApproval(record.requested_at, APPROVAL_DISPLAY_TIMEZONE, locale)}`,
    ),
  ].join("\n");
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDurationMs(durationMs: number, locale = runtimeLocale): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const totalHours = totalMinutes / 60;
  const totalDays = totalHours / 24;
  if (Number.isInteger(totalDays) && totalDays >= 1) {
    return textForLocale(locale, `${totalDays}天`, plural(totalDays, "day"));
  }
  if (Number.isInteger(totalHours) && totalHours >= 1) {
    return textForLocale(locale, `${totalHours}小时`, plural(totalHours, "hour"));
  }
  return textForLocale(locale, `${totalMinutes}分钟`, plural(totalMinutes, "minute"));
}

function formatTimestampForApproval(
  value: string | undefined,
  timeZone = APPROVAL_DISPLAY_TIMEZONE,
  locale = runtimeLocale,
): string {
  const timestamp = parseTimestampMs(value);
  if (timestamp === undefined) {
    return value ?? textForLocale(locale, "未知", "Unknown");
  }

  try {
    const parts = new Intl.DateTimeFormat(localeForIntl(locale), {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(timestamp));
    const values = parts.reduce<Record<string, string>>((output, part) => {
      if (part.type !== "literal") {
        output[part.type] = part.value;
      }
      return output;
    }, {});
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} (${timeZone})`;
  } catch {
    return `${new Date(timestamp).toISOString()} (${timeZone})`;
  }
}

function resolveTemporaryGrantDurationMs(record: StoredApprovalRecord): number {
  const requestedAt = parseTimestampMs(record.requested_at) ?? Date.now();
  const expiresAt = parseTimestampMs(record.expires_at) ?? (requestedAt + (15 * 60 * 1000));
  return Math.max(60_000, expiresAt - requestedAt);
}

function formatApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode, locale = runtimeLocale): string {
  return mode === "longterm"
    ? formatDurationMs(APPROVAL_LONG_GRANT_TTL_MS, locale)
    : formatDurationMs(resolveTemporaryGrantDurationMs(record), locale);
}

function formatCompactApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode, locale = runtimeLocale): string {
  const durationMs = mode === "longterm"
    ? APPROVAL_LONG_GRANT_TTL_MS
    : resolveTemporaryGrantDurationMs(record);
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const totalHours = totalMinutes / 60;
  const totalDays = totalHours / 24;
  if (Number.isInteger(totalDays) && totalDays >= 1) {
    return textForLocale(locale, `${totalDays}天`, `${totalDays}d`);
  }
  if (Number.isInteger(totalHours) && totalHours >= 1) {
    return textForLocale(locale, `${totalHours}小时`, `${totalHours}h`);
  }
  return textForLocale(locale, `${totalMinutes}分钟`, `${totalMinutes}m`);
}

function formatApprovalButtonLabel(
  record: StoredApprovalRecord,
  mode: ApprovalGrantMode,
  locale = runtimeLocale,
): string {
  const optionIndex = mode === "temporary" ? "1" : "2";
  return `${optionIndex}. ${textForLocale(locale, "批准", "Approve")} ${formatCompactApprovalGrantDuration(record, mode, locale)}`;
}

function buildApprovalNotificationButtons(
  record: StoredApprovalRecord,
  locale = runtimeLocale,
): NonNullable<ChatNotificationOptions["buttons"]> {
  return [
    [
      {
        text: formatApprovalButtonLabel(record, "temporary", locale),
        callback_data: `/${APPROVAL_APPROVE_COMMAND} ${record.approval_id}`,
        style: "success",
      },
      {
        text: formatApprovalButtonLabel(record, "longterm", locale),
        callback_data: `/${APPROVAL_APPROVE_COMMAND} ${record.approval_id} long`,
        style: "primary",
      },
    ],
    [
      {
        text: `3. ${textForLocale(locale, "拒绝", "Reject")}`,
        callback_data: `/${APPROVAL_REJECT_COMMAND} ${record.approval_id}`,
        style: "danger",
      },
    ],
  ];
}

function formatWarnNotificationPrompt(params: {
  actorId: string;
  toolName: string;
  scope: string;
  traceId: string;
  resourceScope: ResourceScope;
  reasonCodes: string[];
  rules: string;
  resourcePaths: string[];
  argsSummary: string;
  occurredAt?: string;
}, locale = runtimeLocale): string {
  return [
    textForLocale(locale, "SecurityClaw 风险提醒", "SecurityClaw Warning"),
    `${textForLocale(locale, "谁", "Who")}: ${params.actorId}`,
    `${textForLocale(locale, "时间", "When")}: ${formatTimestampForApproval(params.occurredAt ?? nowIsoString(), APPROVAL_DISPLAY_TIMEZONE, locale)}`,
    `${textForLocale(locale, "通道", "Channel")}: ${splitApprovalSubject(params.actorId).channel ?? textForLocale(locale, "未知", "Unknown")}`,
    `${textForLocale(locale, "权限", "Permission")}: ${params.toolName} · ${formatResourceScopeLabel(params.resourceScope, locale)} · ${params.scope}`,
    `${textForLocale(locale, "处理", "Action")}: ${textForLocale(locale, "本次已按提醒继续执行，请管理员关注。", "Execution continued with a warning. Admin attention recommended.")}`,
  ].join("\n");
}

function shouldSendNotificationAfterCooldown(lastSentAtMs: number | undefined, nowMs = Date.now()): boolean {
  return lastSentAtMs === undefined || nowMs - lastSentAtMs >= APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS;
}

function shouldResendPendingApproval(record: StoredApprovalRecord, nowMs = Date.now()): boolean {
  if (record.notifications.length === 0) {
    return true;
  }
  const latestSentAt = record.notifications
    .map((notification) => parseTimestampMs(notification.sent_at))
    .reduce<number | undefined>((latest, current) => {
      if (current === undefined) {
        return latest;
      }
      if (latest === undefined || current > latest) {
        return current;
      }
      return latest;
    }, undefined);
  const baseline = latestSentAt ?? parseTimestampMs(record.requested_at);
  if (baseline === undefined) {
    return true;
  }
  return nowMs - baseline >= APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS;
}

function mergeApprovalNotifications(
  existing: StoredApprovalNotification[],
  incoming: StoredApprovalNotification[],
): StoredApprovalNotification[] {
  if (incoming.length === 0) {
    return existing;
  }
  return [...existing, ...incoming].slice(-APPROVAL_NOTIFICATION_HISTORY_LIMIT);
}

function nowIsoString(): string {
  return new Date(Date.now()).toISOString();
}

function parseApprovalGrantMode(args: string | undefined): ApprovalGrantMode {
  const value = args?.trim();
  const mode = value ? value.split(/\s+/)[1]?.toLowerCase() : undefined;
  if (mode === "2" || mode === "long" || mode === "longterm" || mode === "permanent" || mode === "长期") {
    return "longterm";
  }
  return "temporary";
}

function formatGrantModeLabel(mode: ApprovalGrantMode, locale = runtimeLocale): string {
  return textForLocale(
    locale,
    mode === "longterm" ? "长期授权" : "临时授权",
    mode === "longterm" ? "Long-lived grant" : "Temporary grant",
  );
}

function parseApprovalReplyChoice(value: string | undefined): ApprovalGrantMode | "reject" | undefined {
  const normalized = value?.trim();
  if (normalized === "1") {
    return "temporary";
  }
  if (normalized === "2") {
    return "longterm";
  }
  if (normalized === "3") {
    return "reject";
  }
  return undefined;
}

function readMetadataString(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function extractApprovalReplyMessageId(metadata: Record<string, unknown>): string | undefined {
  return readMetadataString(
    metadata,
    "replyToMessageId",
    "replyToId",
    "reply_to_message_id",
    "reply_to_id",
    "quotedMessageId",
    "quoted_message_id",
  );
}

function normalizeApprovalAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "default") {
    return undefined;
  }
  return trimmed;
}

function normalizeDiscordApprovalTarget(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("discord:")) {
    const unscoped = trimmed.slice("discord:".length).trim();
    return unscoped ? normalizeDiscordApprovalTarget(unscoped) : trimmed;
  }
  if (lower.startsWith("user:") || lower.startsWith("channel:")) {
    return trimmed;
  }
  if (/^<@!?\d+>$/.test(trimmed)) {
    return `user:${trimmed.slice(2, -1).replace(/^!/, "")}`;
  }
  return /^\d+$/.test(trimmed) ? `user:${trimmed}` : trimmed;
}

function resolveApprovalGrantExpiry(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
  if (mode === "longterm") {
    return new Date(Date.now() + APPROVAL_LONG_GRANT_TTL_MS).toISOString();
  }
  return new Date(Date.now() + resolveTemporaryGrantDurationMs(record)).toISOString();
}

type ChannelSendMessageFn = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<{ messageId?: string }>;

function resolveChannelLookupCandidates(channel: string): string[] {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const candidates = new Set<string>([normalized]);
  for (const alias of CHANNEL_LOOKUP_ALIASES[normalized] ?? []) {
    candidates.add(alias);
  }
  return Array.from(candidates);
}

function resolveChannelMethodSuffix(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  const override = CHANNEL_METHOD_SUFFIX_OVERRIDES[normalized];
  if (override) {
    return override;
  }
  return normalized
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function buildChannelMethodCandidates(channel: string): string[] {
  const suffix = resolveChannelMethodSuffix(channel);
  return [
    `sendMessage${suffix}`,
    `pushMessage${suffix}`,
    `postMessage${suffix}`,
    `send${suffix}`,
    `push${suffix}`,
    "sendMessage",
    "pushMessage",
  ];
}

function resolveDynamicChannelSender(
  api: OpenClawPluginApi,
  channel: string,
): ChannelSendMessageFn | undefined {
  const runtimeChannels = api.runtime.channel as unknown as Record<string, unknown>;
  for (const channelCandidate of resolveChannelLookupCandidates(channel)) {
    const channelClient = runtimeChannels[channelCandidate];
    if (!channelClient || typeof channelClient !== "object") {
      continue;
    }
    const methodNames = Array.from(new Set<string>([
      ...buildChannelMethodCandidates(channel),
      ...buildChannelMethodCandidates(channelCandidate),
    ]));
    for (const methodName of methodNames) {
      const candidate = (channelClient as Record<string, unknown>)[methodName];
      if (typeof candidate === "function") {
        return (to: string, text: string, opts?: Record<string, unknown>) =>
          (candidate as (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }>)
            .call(channelClient, to, text, opts);
      }
    }
  }
  return undefined;
}

type ChannelPluginSendTextFn = (ctx: {
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string | null;
  threadId?: string | number | null;
}) => Promise<Record<string, unknown>>;

function resolveChannelPluginSendText(channel: string): ChannelPluginSendTextFn | undefined {
  if (typeof getChannelPluginCompat !== "function") {
    return undefined;
  }
  for (const channelCandidate of resolveChannelLookupCandidates(channel)) {
    const plugin = getChannelPluginCompat(channelCandidate) as {
      outbound?: {
        sendText?: ChannelPluginSendTextFn;
      };
    } | undefined;
    const sendText = plugin?.outbound?.sendText;
    if (typeof sendText === "function") {
      return sendText;
    }
  }
  return undefined;
}

type FeishuReceiveIdType = "chat_id" | "open_id" | "user_id";

type FeishuRuntimeConfig = {
  appId: string;
  appSecret: string;
  apiBase: string;
};

function feishuAsRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function feishuTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveFeishuSecretValue(value: unknown): string | undefined {
  const direct = feishuTrimmedString(value);
  if (direct) {
    return direct;
  }
  const record = feishuAsRecord(value);
  if (!record) {
    return undefined;
  }
  const source = feishuTrimmedString(record.source)?.toLowerCase();
  const id = feishuTrimmedString(record.id);
  if (source === "env" && id) {
    const envValue = feishuTrimmedString(readProcessEnvValue(id));
    if (envValue) {
      return envValue;
    }
  }
  for (const key of ["value", "secret", "token", "text"]) {
    const candidate = feishuTrimmedString(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function resolveFeishuApiBase(domain: unknown): string {
  const domainValue = feishuTrimmedString(domain)?.replace(/\/+$/, "");
  if (!domainValue || domainValue.toLowerCase() === "feishu") {
    return FEISHU_DEFAULT_API_BASE;
  }
  if (domainValue.toLowerCase() === "lark") {
    return LARK_DEFAULT_API_BASE;
  }
  if (/^https?:\/\//i.test(domainValue)) {
    return domainValue;
  }
  return `https://${domainValue}`;
}

function resolveFeishuRuntimeConfig(
  api: OpenClawPluginApi,
  target: ChatApprovalTarget,
): FeishuRuntimeConfig | undefined {
  const configRoot = feishuAsRecord(api.config);
  const channels = feishuAsRecord(configRoot?.channels);
  const feishu = feishuAsRecord(channels?.feishu) ?? feishuAsRecord(channels?.lark);
  if (!feishu) {
    return undefined;
  }
  const accounts = feishuAsRecord(feishu.accounts);
  const pickAccount = (accountId: string | undefined): Record<string, unknown> | undefined => {
    if (!accounts || !accountId) {
      return undefined;
    }
    return feishuAsRecord(accounts[accountId]);
  };
  const explicitAccount = pickAccount(feishuTrimmedString(target.account_id));
  const defaultAccount = pickAccount(feishuTrimmedString(feishu.defaultAccount));
  const firstAccount = accounts
    ? feishuAsRecord(accounts[Object.keys(accounts).sort((left, right) => left.localeCompare(right))[0]])
    : undefined;
  const merged = {
    ...feishu,
    ...(explicitAccount ?? defaultAccount ?? firstAccount ?? {}),
  };

  const appId = resolveFeishuSecretValue(merged.appId);
  const appSecret = resolveFeishuSecretValue(merged.appSecret);
  if (!appId || !appSecret) {
    return undefined;
  }
  return {
    appId,
    appSecret,
    apiBase: resolveFeishuApiBase(merged.domain),
  };
}

function resolveFeishuReceiveTarget(rawTarget: string): { receiveId: string; receiveIdType: FeishuReceiveIdType } | undefined {
  const scoped = rawTarget.trim().replace(/^(feishu|lark):/i, "").trim();
  if (!scoped) {
    return undefined;
  }
  const lowered = scoped.toLowerCase();
  const stripPrefix = (prefix: string): string => scoped.slice(prefix.length).trim();
  if (lowered.startsWith("chat:")) {
    const receiveId = stripPrefix("chat:");
    return receiveId ? { receiveId, receiveIdType: "chat_id" } : undefined;
  }
  if (lowered.startsWith("group:")) {
    const receiveId = stripPrefix("group:");
    return receiveId ? { receiveId, receiveIdType: "chat_id" } : undefined;
  }
  if (lowered.startsWith("channel:")) {
    const receiveId = stripPrefix("channel:");
    return receiveId ? { receiveId, receiveIdType: "chat_id" } : undefined;
  }
  if (lowered.startsWith("open_id:")) {
    const receiveId = stripPrefix("open_id:");
    return receiveId ? { receiveId, receiveIdType: "open_id" } : undefined;
  }
  if (lowered.startsWith("user:")) {
    const receiveId = stripPrefix("user:");
    if (!receiveId) {
      return undefined;
    }
    return {
      receiveId,
      receiveIdType: receiveId.startsWith("ou_") ? "open_id" : "user_id",
    };
  }
  if (lowered.startsWith("dm:")) {
    const receiveId = stripPrefix("dm:");
    if (!receiveId) {
      return undefined;
    }
    return {
      receiveId,
      receiveIdType: receiveId.startsWith("ou_") ? "open_id" : "user_id",
    };
  }
  if (scoped.startsWith("oc_")) {
    return {
      receiveId: scoped,
      receiveIdType: "chat_id",
    };
  }
  if (scoped.startsWith("ou_")) {
    return {
      receiveId: scoped,
      receiveIdType: "open_id",
    };
  }
  return {
    receiveId: scoped,
    receiveIdType: "user_id",
  };
}

type FeishuApiResponse = {
  code?: number;
  msg?: string;
  message?: string;
  tenant_access_token?: string;
  data?: Record<string, unknown>;
};

async function parseFeishuJsonResponse(response: Response): Promise<FeishuApiResponse> {
  const payload = await response.json() as unknown;
  const record = feishuAsRecord(payload);
  if (!record) {
    throw new Error("feishu api returned non-object response");
  }
  return record as FeishuApiResponse;
}

function buildFeishuApiError(prefix: string, payload: FeishuApiResponse): Error {
  const code = payload.code ?? "unknown";
  const message = payload.msg ?? payload.message ?? "unknown";
  return new Error(`${prefix}: code=${code} msg=${message}`);
}

async function sendFeishuApprovalNotificationDirect(
  api: OpenClawPluginApi,
  target: ChatApprovalTarget,
  message: string,
): Promise<{ messageId?: string }> {
  const feishuConfig = resolveFeishuRuntimeConfig(api, target);
  if (!feishuConfig) {
    throw new Error("feishu credentials not configured for approval notification");
  }
  const receiveTarget = resolveFeishuReceiveTarget(target.to);
  if (!receiveTarget) {
    throw new Error(`invalid feishu approval target: ${target.to}`);
  }

  const authResponse = await fetch(`${feishuConfig.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      app_id: feishuConfig.appId,
      app_secret: feishuConfig.appSecret,
    }),
    signal: AbortSignal.timeout(FEISHU_HTTP_TIMEOUT_MS),
  });
  const authPayload = await parseFeishuJsonResponse(authResponse);
  if (!authResponse.ok) {
    throw buildFeishuApiError(`feishu auth http_${authResponse.status}`, authPayload);
  }
  if (authPayload.code !== 0) {
    throw buildFeishuApiError("feishu auth failed", authPayload);
  }
  const token = feishuTrimmedString(authPayload.tenant_access_token);
  if (!token) {
    throw new Error("feishu auth failed: missing tenant_access_token");
  }

  const sendResponse = await fetch(
    `${feishuConfig.apiBase}/open-apis/im/v1/messages?receive_id_type=${receiveTarget.receiveIdType}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveTarget.receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: message }),
      }),
      signal: AbortSignal.timeout(FEISHU_HTTP_TIMEOUT_MS),
    },
  );
  const sendPayload = await parseFeishuJsonResponse(sendResponse);
  if (!sendResponse.ok) {
    throw buildFeishuApiError(`feishu send http_${sendResponse.status}`, sendPayload);
  }
  if (sendPayload.code !== 0) {
    throw buildFeishuApiError("feishu send failed", sendPayload);
  }
  const messageId = feishuTrimmedString(sendPayload.data?.message_id);
  return messageId ? { messageId } : {};
}

async function sendChatNotification(
  api: OpenClawPluginApi,
  target: ChatApprovalTarget,
  message: string,
  options: ChatNotificationOptions = {},
): Promise<StoredApprovalNotification> {
  const notification: StoredApprovalNotification = {
    channel: target.channel,
    to: target.to,
    ...(target.account_id ? { account_id: target.account_id } : {}),
    ...(target.thread_id !== undefined ? { thread_id: target.thread_id } : {}),
  };

  if (target.channel === "telegram") {
    const sendTelegram = api.runtime.channel.telegram.sendMessageTelegram as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;

    const result = await sendTelegram(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      ...(normalizeThreadId(target.thread_id) !== undefined ? { messageThreadId: normalizeThreadId(target.thread_id) } : {}),
      ...(options.buttons ? { buttons: options.buttons } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "discord") {
    const sendDiscord = api.runtime.channel.discord.sendMessageDiscord as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendDiscord(normalizeDiscordApprovalTarget(target.to), message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "slack") {
    const sendSlack = api.runtime.channel.slack.sendMessageSlack as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendSlack(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "signal") {
    const sendSignal = api.runtime.channel.signal.sendMessageSignal as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendSignal(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "imessage") {
    const sendIMessage = api.runtime.channel.imessage.sendMessageIMessage as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendIMessage(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "whatsapp") {
    const sendWhatsApp = api.runtime.channel.whatsapp.sendMessageWhatsApp as unknown as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendWhatsApp(target.to, message, {
      cfg: api.config,
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "line") {
    const pushLine = api.runtime.channel.line.pushMessageLine as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await pushLine(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  const sendDynamic = resolveDynamicChannelSender(api, target.channel);
  if (sendDynamic) {
    const threadId = normalizeThreadId(target.thread_id);
    const result = await sendDynamic(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  const sendPluginText = resolveChannelPluginSendText(target.channel);
  if (sendPluginText) {
    const result = await sendPluginText({
      cfg: api.config,
      to: target.to,
      text: message,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      ...(target.thread_id !== undefined ? { threadId: target.thread_id } : {}),
    });
    const messageId = typeof result.messageId === "string" ? result.messageId : undefined;
    if (messageId) {
      notification.message_id = messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "feishu" || target.channel === "lark") {
    const result = await sendFeishuApprovalNotificationDirect(api, target, message);
    if (result.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  const runtimeChannels = Object.keys((api.runtime.channel as unknown as Record<string, unknown>) ?? {});
  throw new Error(
    `unsupported approval notification channel: ${target.channel} (runtime channels: ${
      runtimeChannels.length > 0 ? runtimeChannels.join(", ") : "none"
    })`,
  );
}

async function notifyChatTargets(
  api: OpenClawPluginApi,
  targets: ChatApprovalTarget[],
  message: string,
  params: {
    label: string;
    options?: ChatNotificationOptions;
  },
): Promise<ApprovalNotificationResult> {
  if (targets.length === 0) {
    return {
      sent: false,
      notifications: [],
    };
  }

  const notifications: StoredApprovalNotification[] = [];
  let sent = false;
  for (const target of targets) {
    let delivered = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= APPROVAL_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        const notification = await sendChatNotification(api, target, message, params.options);
        notifications.push(notification);
        sent = true;
        delivered = true;
        api.logger.info?.(
          `securityclaw: sent ${params.label} channel=${target.channel} to=${target.to} attempt=${attempt}${notification.message_id ? ` message_id=${notification.message_id}` : ""}`,
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt < APPROVAL_NOTIFICATION_MAX_ATTEMPTS) {
          api.logger.warn?.(
            `securityclaw: retrying ${params.label} channel=${target.channel} to=${target.to} attempt=${attempt} (${String(error)})`,
          );
          await sleep(APPROVAL_NOTIFICATION_RETRY_DELAYS_MS[attempt - 1] ?? APPROVAL_NOTIFICATION_RETRY_DELAYS_MS.at(-1) ?? 250);
        }
      }
    }
    if (!delivered) {
      api.logger.warn?.(
        `securityclaw: failed to send ${params.label} channel=${target.channel} to=${target.to} (${String(lastError)})`,
      );
    }
  }

  return { sent, notifications };
}

async function notifyApprovalTargets(
  api: OpenClawPluginApi,
  targets: ChatApprovalTarget[],
  record: StoredApprovalRecord,
  locale: SecurityClawLocale,
): Promise<ApprovalNotificationResult> {
  return notifyChatTargets(api, targets, formatApprovalPrompt(record, locale), {
    label: `approval prompt approval_id=${record.approval_id}`,
    options: {
      buttons: buildApprovalNotificationButtons(record, locale),
    },
  });
}

async function notifyApprovalTargetsOnce(
  api: OpenClawPluginApi,
  targets: ChatApprovalTarget[],
  record: StoredApprovalRecord,
  inflight: Map<string, Promise<ApprovalNotificationResult>>,
  locale: SecurityClawLocale,
): Promise<ApprovalNotificationResult> {
  const pending = inflight.get(record.approval_id);
  if (pending) {
    return pending;
  }

  const current = (async () => {
    try {
      return await notifyApprovalTargets(api, targets, record, locale);
    } finally {
      inflight.delete(record.approval_id);
    }
  })();

  inflight.set(record.approval_id, current);
  return current;
}

async function notifyWarnTargets(
  api: OpenClawPluginApi,
  targets: ChatApprovalTarget[],
  message: string,
  traceId: string,
): Promise<boolean> {
  const result = await notifyChatTargets(api, targets, message, {
    label: `warning notification trace_id=${traceId}`,
  });
  return result.sent;
}

function formatApprovalBlockReason(params: {
  toolName: string;
  scope: string;
  traceId: string;
  resourceScope: ResourceScope;
  reasonCodes: string[];
  rules: string;
  approvalId: string;
  notificationSent: boolean;
}): string {
  const reasons = params.reasonCodes.join(", ");
  const notifyHint = params.notificationSent
    ? text(
      "已通知管理员，批准后可重试。",
      "Sent to admin. Retry after approval.",
    )
    : text(
      "通知失败，请将审批单交给管理员处理。",
      "Admin notification failed. Share the request ID with an approver.",
    );
  const lines = [
    text("SecurityClaw 需要审批", "SecurityClaw Approval Required"),
    `${text("工具", "Tool")}: ${params.toolName}`,
    `${text("范围", "Scope")}: ${params.scope}`,
    `${text("资源", "Resource")}: ${formatResourceScopeDetail(params.resourceScope)}`,
    `${text("原因", "Reason")}: ${reasons || text("策略要求复核", "Policy review required")}`,
    ...(params.rules && params.rules !== "-" ? [`${text("规则", "Policy")}: ${params.rules}`] : []),
    `${text("审批单", "Request ID")}: ${params.approvalId}`,
    `${text("状态", "Status")}: ${notifyHint}`,
    `${text("追踪", "Trace")}: ${params.traceId}`,
  ];
  return lines.join("\n");
}

function hasExplicitReadOnlyAccess(
  rawToolName: string | undefined,
  decisionContext: DecisionContext,
): boolean {
  if (rawToolName === "shell.exec") {
    return false;
  }
  if (decisionContext.tool_group !== "filesystem") {
    return false;
  }
  return decisionContext.operation === "read" ||
    decisionContext.operation === "list" ||
    decisionContext.operation === "search";
}

function matchesProtectedStoragePath(candidate: string, resolved: ResolvedPluginRuntime): boolean {
  if (resolved.protectedDataDir) {
    const normalizedProtectedDataDir = path.normalize(resolved.protectedDataDir);
    if (candidate === normalizedProtectedDataDir || isPathInside(normalizedProtectedDataDir, candidate)) {
      return true;
    }
  }
  return resolved.protectedDbPaths.some((protectedPath) => candidate === path.normalize(protectedPath));
}

function evaluateProtectedStorageAccess(
  rawToolName: string | undefined,
  decisionContext: DecisionContext,
  resolved: ResolvedPluginRuntime,
): {
  decision: Decision;
  decisionSource: DecisionSource;
  reasonCodes: string[];
  rules: string;
} | undefined {
  if (decisionContext.resource_paths.length === 0) {
    return undefined;
  }

  const matchedPath = decisionContext.resource_paths.some((candidate) =>
    matchesProtectedStoragePath(path.normalize(candidate), resolved)
  );
  if (!matchedPath || hasExplicitReadOnlyAccess(rawToolName, decisionContext)) {
    return undefined;
  }

  return {
    decision: "block",
    decisionSource: "default",
    reasonCodes: [SECURITYCLAW_PROTECTED_STORAGE_REASON],
    rules: SECURITYCLAW_PROTECTED_STORAGE_RULE_ID,
  };
}

function parseApprovalId(args: string | undefined): string | undefined {
  const value = args?.trim();
  return value ? value.split(/\s+/)[0] : undefined;
}

function resolvePluginRuntime(api: OpenClawPluginApi): ResolvedPluginRuntime {
  const pluginConfig = (api.pluginConfig ?? {}) as SecurityClawPluginConfig;
  return PluginConfigParser.resolve(PLUGIN_ROOT, pluginConfig, resolvePluginStateDir(api));
}

function createEventEmitter(config: SecurityClawConfig): EventEmitter {
  const sink = config.event_sink.webhook_url
    ? new HttpEventSink(config.event_sink.webhook_url, config.event_sink.timeout_ms)
    : undefined;
  return new EventEmitter(sink, config.event_sink.max_buffer, config.event_sink.retry_limit);
}

function applyPluginConfigOverrides(config: SecurityClawConfig, pluginConfig: SecurityClawPluginConfig): SecurityClawConfig {
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
    },
    sensitivity: hydrateSensitivePathConfig(config.sensitivity)
  };
}

function buildRuntime(snapshot: LiveConfigSnapshot): RuntimeDependencies {
  return {
    config: snapshot.config,
    policyPipeline: new PolicyPipeline(snapshot.config),
    accountPolicyEngine: new AccountPolicyEngine(snapshot.override?.account_policies),
    dlpEngine: new DlpEngine(snapshot.config.dlp),
    emitter: createEventEmitter(snapshot.config),
    overrideLoaded: snapshot.overrideLoaded
  };
}

function toStatusConfig(config: SecurityClawConfig, overrideLoaded: boolean, resolved: ResolvedPluginRuntime) {
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
  config: SecurityClawConfig,
  ctx: SecurityClawHookContext,
  toolName?: string,
  tags: string[] = [],
  resourceScope: ResourceScope = "none",
  resourcePaths: string[] = [],
  args?: unknown,
  toolArgsSummary?: string,
  workspaceDir?: string,
): DecisionContext {
  const workspace = workspaceDir ?? ("workspaceDir" in ctx ? ctx.workspaceDir : undefined);
  const runtimeScope = resolveScope({ workspaceDir: workspace, channelId: "channelId" in ctx ? ctx.channelId : undefined });
  const scope = config.environment || runtimeScope;
  const normalizedToolName = toolName ? normalizeToolName(toolName) : undefined;
  const derivedToolContext = deriveToolContext(normalizedToolName, args, resourceScope, resourcePaths, workspace);
  const effectiveToolName = derivedToolContext.inferredToolName ?? normalizedToolName;
  const mergedTags = [...new Set([...tags, ...derivedToolContext.tags, `resource_scope:${derivedToolContext.resourceScope}`])];
  const toolGroup = derivedToolContext.toolGroup;
  const operation = derivedToolContext.operation;
  const destination = args !== undefined ? contextInference.inferDestinationContext(args) : {};
  const fileType = inferFileType(derivedToolContext.resourcePaths);
  const summary = toolArgsSummary ?? (args !== undefined ? summarizeForLog(args, 240) : undefined);
  const labels = inferLabels(config, toolGroup, derivedToolContext.resourcePaths, summary);
  const volume = inferVolume(args, derivedToolContext.resourcePaths);

  return {
    actor_id: ctx.agentId ?? "unknown-agent",
    scope,
    ...(effectiveToolName !== undefined ? { tool_name: effectiveToolName } : {}),
    ...(toolGroup !== undefined ? { tool_group: toolGroup } : {}),
    ...(operation !== undefined ? { operation } : {}),
    tags: mergedTags,
    resource_scope: derivedToolContext.resourceScope,
    resource_paths: derivedToolContext.resourcePaths,
    ...(fileType !== undefined ? { file_type: fileType } : {}),
    asset_labels: labels.asset_labels,
    data_labels: labels.data_labels,
    trust_level: mergedTags.includes("untrusted") ? "untrusted" : "unknown",
    ...(destination.destinationType !== undefined ? { destination_type: destination.destinationType } : {}),
    ...(destination.destDomain !== undefined ? { dest_domain: destination.destDomain } : {}),
    ...(destination.destIpClass !== undefined ? { dest_ip_class: destination.destIpClass } : {}),
    ...(summary !== undefined ? { tool_args_summary: summary } : {}),
    volume,
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
    logger.warn?.(`securityclaw: failed to emit event (${String(error)})`);
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
  const lines = [
    text(
      decision === "challenge" ? "SecurityClaw 需要审批" : "SecurityClaw 已阻止此操作",
      decision === "challenge" ? "SecurityClaw Approval Required" : "SecurityClaw Blocked",
    ),
    `${text("工具", "Tool")}: ${toolName}`,
    `${text("范围", "Scope")}: ${scope}`,
    `${text("资源", "Resource")}: ${formatResourceScopeDetail(resourceScope)}`,
    `${text("来源", "Source")}: ${decisionSource}`,
    `${text("原因", "Reason")}: ${reasons || text("策略要求复核", "Policy review required")}`,
    ...(rules && rules !== "-" ? [`${text("规则", "Policy")}: ${rules}`] : []),
    `${text("处理", "Action")}: ${text(
      decision === "challenge" ? "联系管理员审批后重试" : "联系安全管理员调整策略",
      decision === "challenge" ? "Contact an admin to approve and retry" : "Contact a security admin to adjust policy",
    )}`,
    `${text("追踪", "Trace")}: ${traceId}`,
  ];
  return lines.join("\n");
}

const plugin = {
  id: "securityclaw",
  name: "SecurityClaw Security",
  description: "Runtime policy enforcement, transcript sanitization, and audit events for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const resolved = resolvePluginRuntime(api);
    const pluginConfig = (api.pluginConfig ?? {}) as SecurityClawPluginConfig;
    const adminConsoleUrl = resolveAdminConsoleUrl(pluginConfig);
    const stateDir = resolvePluginStateDir(api);
    const defaultWorkspaceDir = resolveConfiguredOpenClawWorkspace(stateDir);
    runtimeLocale = resolveRuntimeLocale();
    const adminAutoStart = pluginConfig.adminAutoStart ?? true;
    const decisionLogMaxLength = pluginConfig.decisionLogMaxLength ?? 240;
    const statusPath = resolved.statusPath;
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
      transform: (config: SecurityClawConfig) => applyPluginConfigOverrides(config, pluginConfig),
      onReload: (snapshot: LiveConfigSnapshot) => {
        statusStore.updateConfig(toStatusConfig(snapshot.config, snapshot.overrideLoaded, resolved));
        api.logger.info?.(
          `securityclaw: policy refresh env=${snapshot.config.environment} policy_version=${snapshot.config.policy_version} rules=${snapshot.config.policies.length}`,
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

    function startManagedAdminConsole(): void {
      if (!adminAutoStart) {
        api.logger.info?.("securityclaw: admin auto-start disabled by config");
        return;
      }

      const autoStartDecision = shouldAutoStartAdminServer();
      if (!autoStartDecision.enabled) {
        if (shouldAnnounceAdminConsoleForArgv(process.argv)) {
          announceAdminConsole({
            locale: runtimeLocale,
            logger: {
              info: (message: string) => api.logger.info?.(`securityclaw: ${message}`),
              warn: (message: string) => api.logger.warn?.(`securityclaw: ${message}`),
            },
            stateDir,
            state: "service-command",
            url: adminConsoleUrl,
          });
          api.logger.info?.("securityclaw: admin dashboard is hosted by the background OpenClaw gateway service");
        } else {
          api.logger.info?.(
            `securityclaw: admin auto-start skipped in ${autoStartDecision.reason}; use npm run admin for standalone dashboard`,
          );
        }
        return;
      }

      const adminServerOptions = {
        configPath: resolved.configPath,
        legacyOverridePath: resolved.legacyOverridePath,
        statusPath,
        dbPath,
        unrefOnStart: true,
        logger: {
          info: (message: string) => api.logger.info?.(`securityclaw: ${message}`),
          warn: (message: string) => api.logger.warn?.(`securityclaw: ${message}`),
        },
        ...(pluginConfig.adminPort !== undefined ? { port: pluginConfig.adminPort } : {}),
      };

      void startAdminServer(adminServerOptions)
        .then((result) => {
          announceAdminConsole({
            locale: runtimeLocale,
            logger: {
              info: (message: string) => api.logger.info?.(`securityclaw: ${message}`),
              warn: (message: string) => api.logger.warn?.(`securityclaw: ${message}`),
            },
            stateDir,
            state: result.state,
            url: `http://127.0.0.1:${result.runtime.port}`,
          });
        })
        .catch((error) => {
          api.logger.warn?.(`securityclaw: failed to auto-start admin dashboard (${String(error)})`);
        });
    }

    statusStore.markBoot(toStatusConfig(runtime.config, runtime.overrideLoaded, resolved));

    api.logger.info?.(
      `securityclaw: boot env=${runtime.config.environment} policy_version=${runtime.config.policy_version} dlp_mode=${runtime.config.dlp.on_dlp_hit} rules=${runtime.config.policies.length}`,
    );
    if (!runtime.config.event_sink.webhook_url) {
      api.logger.info?.("securityclaw: event sink disabled (webhook_url is empty), using logger-only observability");
    }

    function resolveApprovalBridge(current: RuntimeDependencies = getRuntime()): ResolvedApprovalBridge {
      return mergeApprovalBridgeConfig(deriveApprovalBridgeFromAdminPolicies(current.accountPolicyEngine));
    }
    const approvalStore = new ChatApprovalStore(dbPath);
    const inflightApprovalNotifications = new Map<string, Promise<ApprovalNotificationResult>>();
    const warnNotificationSentAt = new Map<string, number>();
    const initialApprovalBridge = resolveApprovalBridge(runtime);
    if (initialApprovalBridge.enabled) {
      api.logger.info?.(
        `securityclaw: approval bridge enabled targets=${initialApprovalBridge.targets.length} approvers=${initialApprovalBridge.approvers.length}`,
      );
      if (initialApprovalBridge.approvers.length === 0) {
        api.logger.warn?.("securityclaw: approval bridge is enabled but no approvers are configured");
      }
      api.logger.info?.("securityclaw: approval bridge source=account_policies_admin");
    }

    api.registerCommand({
      name: APPROVAL_APPROVE_COMMAND,
      description: "Approve a pending SecurityClaw request in the current admin chat.",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const approvalBridge = resolveApprovalBridge();
        const commandContext: SecurityClawApprovalCommandContext = {
          channel: ctx.channel,
          ...(ctx.senderId !== undefined ? { senderId: ctx.senderId } : {}),
          ...(ctx.from !== undefined ? { from: ctx.from } : {}),
          ...(ctx.to !== undefined ? { to: ctx.to } : {}),
          ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
          ...(ctx.args !== undefined ? { args: ctx.args } : {}),
          isAuthorizedSender: ctx.isAuthorizedSender,
        };
        if (!approvalBridge.enabled) {
          return { text: text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
        }
        if (!commandContext.isAuthorizedSender || !matchesApprover(approvalBridge.approvers, commandContext)) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              "你无权审批 SecurityClaw 请求。",
              "You are not allowed to approve SecurityClaw requests.",
            ),
          };
        }
        const approvalId = parseApprovalId(commandContext.args);
        if (!approvalId) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              `用法: /${APPROVAL_APPROVE_COMMAND} <approval_id> [long]`,
              `Usage: /${APPROVAL_APPROVE_COMMAND} <approval_id> [long]`,
            ),
          };
        }
        const existing = approvalStore.getById(approvalId);
        if (!existing) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              `审批请求不存在: ${approvalId}`,
              `Approval request not found: ${approvalId}`,
            ),
          };
        }
        if (existing.status !== "pending") {
          return {
            text: textForLocale(
              approvalBridge.locale,
              `审批请求当前状态为 ${existing.status}，无法重复批准。`,
              `Approval request is ${existing.status}; it cannot be approved again.`,
            ),
          };
        }
        const grantMode = parseApprovalGrantMode(commandContext.args);
        const grantExpiresAt = resolveApprovalGrantExpiry(existing, grantMode);
        approvalStore.resolve(
          approvalId,
          `${commandContext.channel ?? "unknown"}:${commandContext.from ?? "unknown"}`,
          "approved",
          { expires_at: grantExpiresAt },
        );
        return {
          text: textForLocale(
            approvalBridge.locale,
            `已为 ${existing.actor_id} 添加${formatGrantModeLabel(grantMode, approvalBridge.locale)}，范围=${existing.scope}，有效期至 ${formatTimestampForApproval(grantExpiresAt, APPROVAL_DISPLAY_TIMEZONE, approvalBridge.locale)}。`,
            `${formatGrantModeLabel(grantMode, approvalBridge.locale)} granted for ${existing.actor_id}, scope=${existing.scope}, expires at ${formatTimestampForApproval(grantExpiresAt, APPROVAL_DISPLAY_TIMEZONE, approvalBridge.locale)}.`,
          ),
        };
      },
    });

    api.registerCommand({
      name: APPROVAL_REJECT_COMMAND,
      description: "Reject a pending SecurityClaw request in the current admin chat.",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const approvalBridge = resolveApprovalBridge();
        const commandContext: SecurityClawApprovalCommandContext = {
          channel: ctx.channel,
          ...(ctx.senderId !== undefined ? { senderId: ctx.senderId } : {}),
          ...(ctx.from !== undefined ? { from: ctx.from } : {}),
          ...(ctx.to !== undefined ? { to: ctx.to } : {}),
          ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
          ...(ctx.args !== undefined ? { args: ctx.args } : {}),
          isAuthorizedSender: ctx.isAuthorizedSender,
        };
        if (!approvalBridge.enabled) {
          return { text: text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
        }
        if (!commandContext.isAuthorizedSender || !matchesApprover(approvalBridge.approvers, commandContext)) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              "你无权审批 SecurityClaw 请求。",
              "You are not allowed to approve SecurityClaw requests.",
            ),
          };
        }
        const approvalId = parseApprovalId(commandContext.args);
        if (!approvalId) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              `用法: /${APPROVAL_REJECT_COMMAND} <approval_id>`,
              `Usage: /${APPROVAL_REJECT_COMMAND} <approval_id>`,
            ),
          };
        }
        const existing = approvalStore.getById(approvalId);
        if (!existing) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              `审批请求不存在: ${approvalId}`,
              `Approval request not found: ${approvalId}`,
            ),
          };
        }
        if (existing.status !== "pending") {
          return {
            text: textForLocale(
              approvalBridge.locale,
              `审批请求当前状态为 ${existing.status}，无法重复拒绝。`,
              `Approval request is ${existing.status}; it cannot be rejected again.`,
            ),
          };
        }
        approvalStore.resolve(
          approvalId,
          `${commandContext.channel ?? "unknown"}:${commandContext.from ?? "unknown"}`,
          "rejected",
        );
        return {
          text: textForLocale(
            approvalBridge.locale,
            `已拒绝 ${approvalId}，不会为 ${existing.actor_id} 增加授权。`,
            `Rejected ${approvalId}. No grant was added for ${existing.actor_id}.`,
          ),
        };
      },
    });

    api.registerCommand({
      name: APPROVAL_PENDING_COMMAND,
      description: "List recent pending SecurityClaw approval requests.",
      acceptsArgs: false,
      requireAuth: false,
      handler: async (ctx) => {
        const approvalBridge = resolveApprovalBridge();
        const commandContext: SecurityClawApprovalCommandContext = {
          channel: ctx.channel,
          ...(ctx.senderId !== undefined ? { senderId: ctx.senderId } : {}),
          ...(ctx.from !== undefined ? { from: ctx.from } : {}),
          ...(ctx.to !== undefined ? { to: ctx.to } : {}),
          ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
          ...(ctx.args !== undefined ? { args: ctx.args } : {}),
          isAuthorizedSender: ctx.isAuthorizedSender,
        };
        if (!approvalBridge.enabled) {
          return { text: text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
        }
        if (!commandContext.isAuthorizedSender || !matchesApprover(approvalBridge.approvers, commandContext)) {
          return {
            text: textForLocale(
              approvalBridge.locale,
              "你无权查看 SecurityClaw 待审批请求。",
              "You are not allowed to view pending SecurityClaw approvals.",
            ),
          };
        }
        return { text: formatPendingApprovals(approvalStore.listPending(10), approvalBridge.locale) };
      },
    });

    api.on("message_received", async (event, ctx) => {
      const approvalBridge = resolveApprovalBridge();
      const choice = parseApprovalReplyChoice(event.content);
      if (!approvalBridge.enabled || !choice) {
        return;
      }

      const metadata =
        event.metadata && typeof event.metadata === "object"
          ? event.metadata as Record<string, unknown>
          : {};
      const commandContext: SecurityClawApprovalCommandContext = {
        channel: ctx.channelId,
        from: event.from,
        ...(typeof metadata.senderId === "string" ? { senderId: metadata.senderId } : {}),
        ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
        isAuthorizedSender: true,
      };
      if (!matchesApprover(approvalBridge.approvers, commandContext)) {
        return;
      }

      const replyMessageId = extractApprovalReplyMessageId(metadata);
      if (!replyMessageId) {
        api.logger.info?.(
          `securityclaw: ignoring numeric approval reply without reply target channel=${ctx.channelId ?? "unknown"} from=${event.from}`,
        );
        return;
      }
      const pendingRecords = approvalStore
        .listPending(20)
        .filter((record) =>
          record.notifications.some((notification) =>
            notification.channel === ctx.channelId &&
            normalizeApprovalAccountId(notification.account_id) === normalizeApprovalAccountId(ctx.accountId) &&
            notification.message_id?.trim() === replyMessageId
          )
        );

      if (pendingRecords.length === 0) {
        api.logger.info?.(
          `securityclaw: numeric approval reply found no pending request channel=${ctx.channelId} reply_message_id=${replyMessageId}`,
        );
        return;
      }

      if (pendingRecords.length > 1) {
        api.logger.info?.(
          `securityclaw: numeric approval reply matched multiple pending requests channel=${ctx.channelId} reply_message_id=${replyMessageId} count=${pendingRecords.length}`,
        );
        return;
      }

      const existing = pendingRecords[0]!;
      const approverIdentity = `${ctx.channelId}:${commandContext.senderId ?? commandContext.from ?? "unknown"}`;

      if (choice === "reject") {
        approvalStore.resolve(existing.approval_id, approverIdentity, "rejected");
        api.logger.info?.(
          `securityclaw: numeric approval reply rejected approval_id=${existing.approval_id} approver=${approverIdentity} reply_message_id=${replyMessageId}`,
        );
        return;
      }

      const grantExpiresAt = resolveApprovalGrantExpiry(existing, choice);
      approvalStore.resolve(existing.approval_id, approverIdentity, "approved", {
        expires_at: grantExpiresAt,
      });
      api.logger.info?.(
        `securityclaw: numeric approval reply approved approval_id=${existing.approval_id} approver=${approverIdentity} mode=${choice} reply_message_id=${replyMessageId}`,
      );
    });

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const hookContext = ctx as SecurityClawHookContext;
        const current = getRuntime();
        const traceId = hookContext.runId ?? hookContext.sessionId ?? hookContext.sessionKey ?? `trace-${Date.now()}`;
        const scope = resolveScope({ workspaceDir: hookContext.workspaceDir, channelId: hookContext.channelId });
        const prependSystemContext = [
          "[SecurityClaw Security Context]",
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
        const hookContext = ctx as SecurityClawHookContext;
        const current = getRuntime();
        const approvalBridge = resolveApprovalBridge(current);
        const normalizedToolName = normalizeToolName(event.toolName);
        const rawArguments = event.params;
        const effectiveWorkspaceDir = resolveEffectiveWorkspaceDir(
          hookContext,
          rawArguments,
          defaultWorkspaceDir,
        );
        const resource = extractResourceContext(rawArguments, effectiveWorkspaceDir);
        const argsSummary = summarizeForLog(rawArguments, decisionLogMaxLength);
        const decisionContext = buildDecisionContext(
          current.config,
          hookContext,
          normalizedToolName,
          [],
          resource.resourceScope,
          resource.resourcePaths,
          rawArguments,
          argsSummary,
          effectiveWorkspaceDir,
        );
        const traceId = decisionContext.security_context.trace_id;
        const effectiveToolName = decisionContext.tool_name ?? normalizedToolName ?? "unknown-tool";
        const approvalSubject = resolveApprovalSubject(hookContext);
        const accountPolicy = current.accountPolicyEngine.getPolicy(approvalSubject);
        const protectedStorageAccess = evaluateProtectedStorageAccess(normalizedToolName, decisionContext, resolved);
        let rules = protectedStorageAccess?.rules ?? "-";
        let effectiveDecision = protectedStorageAccess?.decision ?? "allow";
        let effectiveDecisionSource = protectedStorageAccess?.decisionSource ?? "default";
        let effectiveReasonCodes = [...(protectedStorageAccess?.reasonCodes ?? ["ALLOW"])];
        let accountOverride: ReturnType<AccountPolicyEngine["evaluate"]> | undefined;
        let approvalBlockReason: string | undefined;
        let approvalRequestKey: string | undefined;

        if (!protectedStorageAccess) {
          const outcome = current.policyPipeline.evaluate(decisionContext, current.config.file_rules);
          const ruleIds = matchedPolicyRuleIds(outcome);
          rules = ruleIds.length > 0 ? ruleIds.join(",") : "-";
          accountOverride = outcome.matched_file_rule ? undefined : current.accountPolicyEngine.evaluate(approvalSubject);
          approvalRequestKey = createApprovalRequestKey({
            policy_version: current.config.policy_version,
            scope: decisionContext.scope,
            tool_name: effectiveToolName,
            resource_scope: decisionContext.resource_scope,
            resource_paths: [],
            params: {
              operation: decisionContext.operation ?? null,
              destination_type: decisionContext.destination_type ?? null,
              dest_domain: decisionContext.dest_domain ?? null,
              rule_ids: ruleIds,
            },
          });
          effectiveDecision = accountOverride?.decision ?? outcome.decision;
          effectiveDecisionSource = accountOverride?.decision_source ?? outcome.decision_source;
          effectiveReasonCodes = [...(accountOverride?.reason_codes ?? outcome.reason_codes)];

          if (effectiveDecision === "challenge" && approvalBridge.enabled) {
            const approvalScope = decisionContext.scope;
            const approved = approvalStore.findApproved(approvalSubject, approvalRequestKey);
            if (approved) {
              effectiveDecision = "allow";
              effectiveDecisionSource = "approval";
              effectiveReasonCodes = ["APPROVAL_GRANTED"];
            } else {
              let pending = approvalStore.findPending(approvalSubject, approvalRequestKey);
              let notificationResult: ApprovalNotificationResult = {
                sent: Boolean(pending?.notifications.length),
                notifications: pending?.notifications ?? [],
              };

              if (!pending) {
                pending = approvalStore.create({
                  request_key: approvalRequestKey,
                  session_scope: approvalSubject,
                  expires_at: new Date(
                    Date.now() +
                      ((outcome.challenge_ttl_seconds ?? current.config.defaults.approval_ttl_seconds) * 1000),
                  ).toISOString(),
                  policy_version: current.config.policy_version,
                  actor_id: approvalSubject,
                  scope: approvalScope,
                  tool_name: effectiveToolName,
                  resource_scope: decisionContext.resource_scope,
                  resource_paths: decisionContext.resource_paths,
                  reason_codes: outcome.reason_codes,
                  rule_ids: ruleIds,
                  args_summary: argsSummary,
                });
              }

              if (approvalBridge.targets.length > 0 && shouldResendPendingApproval(pending)) {
                notificationResult = await notifyApprovalTargetsOnce(
                  api,
                  approvalBridge.targets,
                  pending,
                  inflightApprovalNotifications,
                  approvalBridge.locale,
                );
                if (notificationResult.notifications.length > 0) {
                  pending =
                    approvalStore.updateNotifications(
                      pending.approval_id,
                      mergeApprovalNotifications(pending.notifications, notificationResult.notifications),
                    ) ?? pending;
                }
              }

              approvalBlockReason = formatApprovalBlockReason({
                toolName: event.toolName,
                scope: decisionContext.scope,
                traceId,
                resourceScope: decisionContext.resource_scope,
                reasonCodes: outcome.reason_codes,
                rules,
                approvalId: pending.approval_id,
                notificationSent: notificationResult.sent || pending.notifications.length > 0,
              });
            }
          }

          if (effectiveDecision === "warn" && approvalBridge.enabled && approvalBridge.targets.length > 0 && approvalRequestKey) {
            const nowMs = Date.now();
            const lastSentAtMs = warnNotificationSentAt.get(approvalRequestKey);
            if (shouldSendNotificationAfterCooldown(lastSentAtMs, nowMs)) {
              const warningPrompt = formatWarnNotificationPrompt({
                actorId: approvalSubject,
                toolName: effectiveToolName,
                scope: decisionContext.scope,
                traceId,
                resourceScope: decisionContext.resource_scope,
                reasonCodes: effectiveReasonCodes,
                rules,
                resourcePaths: decisionContext.resource_paths,
                argsSummary,
              }, approvalBridge.locale);
              const warningSent = await notifyWarnTargets(api, approvalBridge.targets, warningPrompt, traceId);
              if (warningSent) {
                warnNotificationSentAt.set(approvalRequestKey, nowMs);
              }
            }
          }
        }

	        const decisionLog = [
	          "securityclaw: before_tool_call",
	          `trace_id=${traceId}`,
	          `actor=${approvalSubject}`,
	          `scope=${decisionContext.scope}`,
	          `resource_scope=${decisionContext.resource_scope}`,
	          `paths=${decisionContext.resource_paths.length > 0 ? trimText(decisionContext.resource_paths.slice(0, 3).join("|"), 200) : "-"}`,
	          `asset_labels=${decisionContext.asset_labels.length > 0 ? decisionContext.asset_labels.join(",") : "-"}`,
	          `data_labels=${decisionContext.data_labels.length > 0 ? decisionContext.data_labels.join(",") : "-"}`,
	          `tool=${effectiveToolName}`,
	          `raw_tool=${event.toolName}`,
	          `decision=${effectiveDecision}`,
          `source=${effectiveDecisionSource}`,
          `account_mode=${accountPolicy?.mode ?? "apply_rules"}`,
          `is_admin=${accountPolicy?.is_admin === true}`,
          `rules=${rules}`,
          `reasons=${effectiveReasonCodes.join(",")}`,
          `args=${argsSummary}`
        ].join(" ");

        if (effectiveDecision === "allow") {
          api.logger.info?.(decisionLog);
        } else {
          api.logger.warn?.(decisionLog);
        }

        emitEvent(
          current.emitter,
          createEvent(
            traceId,
            "before_tool_call",
            effectiveDecision,
            effectiveReasonCodes,
            effectiveDecisionSource,
            decisionContext.resource_scope,
          ),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_tool_call",
          trace_id: traceId,
          actor: approvalSubject,
          scope: decisionContext.scope,
          tool: effectiveToolName,
          decision: effectiveDecision,
          decision_source: effectiveDecisionSource,
          resource_scope: decisionContext.resource_scope,
          reasons: effectiveReasonCodes,
          rules
        });

        if (effectiveDecision === "block") {
          return {
            block: true,
            blockReason: formatToolBlockReason(
              event.toolName,
              decisionContext.scope,
              traceId,
              effectiveDecision,
              effectiveDecisionSource,
              decisionContext.resource_scope,
              effectiveReasonCodes,
              rules,
            )
          };
        }

        if (effectiveDecision === "challenge") {
          return {
            block: true,
            blockReason:
              approvalBlockReason ??
              formatToolBlockReason(
                event.toolName,
                decisionContext.scope,
                traceId,
                effectiveDecision,
                effectiveDecisionSource,
                decisionContext.resource_scope,
                effectiveReasonCodes,
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
          `securityclaw: after_tool_call findings tool=${event.toolName} findings=${findingsToText(findings)}`,
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
          `securityclaw: tool_result_persist trace_id=${traceId} tool=${event.toolName} decision=${current.config.defaults.persist_mode === "strict" ? "block" : "warn"} findings=${findingsToText(sanitized.findings)}`,
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
          `securityclaw: before_message_write blocked findings=${findingsToText(findings)}`,
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
          `securityclaw: message_sending trace_id=${traceId} decision=${decision} findings=${findingsToText(sanitized.findings)}`,
        );
        if (current.config.dlp.on_dlp_hit === "block") {
          return { cancel: true };
        }
        return { content: sanitized.value as string };
      },
      { priority: 100 },
    );

    api.on(
      "gateway_stop",
      async () => {
        approvalStore.close();
        statusStore.close();
        liveConfig.close();
      },
      { priority: 100 },
    );

    startManagedAdminConsole();
    api.logger.info?.(`securityclaw: loaded policy_version=${runtime.config.policy_version}`);
  }
};

export default plugin;
